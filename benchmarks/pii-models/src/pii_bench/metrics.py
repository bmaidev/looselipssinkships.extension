"""Leak-focused scoring, confidence intervals, and Pareto analysis."""

from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import itertools
import json
import math
from pathlib import Path
import random
import statistics
import tempfile
from typing import Iterable

from .dataset import EVALUATION_PARTITIONS, PARTITION_SCHEME, evaluation_partition, iter_jsonl
from .taxonomy import family_for, risk_for


def _mask(length: int, spans: Iterable[dict]) -> bytearray:
    result = bytearray(length)
    for span in spans:
        start = max(0, min(length, int(span.get("start", 0))))
        end = max(start, min(length, int(span.get("end", start))))
        result[start:end] = b"\x01" * (end - start)
    return result


def _prf(tp: int | float, fp: int | float, fn: int | float) -> dict[str, float]:
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1}


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _overlap(a: dict, b: dict) -> int:
    return max(0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


def _entity_matches(gold: list[dict], predicted: list[dict], *, exact: bool, typed: bool) -> int:
    candidates: list[tuple[float, int, int]] = []
    for gi, expected in enumerate(gold):
        for pi, actual in enumerate(predicted):
            if typed and expected["label"] != actual.get("label"):
                continue
            overlap = _overlap(expected, actual)
            if exact:
                if expected["start"] != actual["start"] or expected["end"] != actual["end"]:
                    continue
                score = 1.0
            elif overlap:
                union = max(expected["end"], actual["end"]) - min(expected["start"], actual["start"])
                score = overlap / union
            else:
                continue
            candidates.append((score, gi, pi))
    matched_gold: set[int] = set()
    matched_predicted: set[int] = set()
    matches = 0
    for _, gi, pi in sorted(candidates, reverse=True):
        if gi not in matched_gold and pi not in matched_predicted:
            matched_gold.add(gi)
            matched_predicted.add(pi)
            matches += 1
    return matches


def _prediction_records(path: Path) -> tuple[dict, dict[str, dict], dict]:
    metadata: dict = {}
    summary: dict = {}
    records: dict[str, dict] = {}
    for item in iter_jsonl(path):
        if "_meta" in item:
            metadata.update(item["_meta"])
        elif "_summary" in item:
            summary.update(item["_summary"])
        else:
            record_id = item.get("id")
            if not record_id or record_id in records:
                raise ValueError(f"Missing or duplicate prediction ID in {path}: {record_id!r}")
            records[record_id] = item
    return metadata, records, summary


def _bootstrap(per_doc: list[dict], rounds: int, seed: int) -> dict:
    if rounds <= 0 or not per_doc:
        return {}
    rng = random.Random(seed)
    names = ("character_recall", "weighted_recall", "document_full_protection_rate", "over_redaction_rate")
    samples: dict[str, list[float]] = {name: [] for name in names}
    count = len(per_doc)
    for _ in range(rounds):
        totals = Counter()
        for _ in range(count):
            totals.update(per_doc[rng.randrange(count)])
        samples["character_recall"].append(totals["tp_chars"] / totals["gold_chars"] if totals["gold_chars"] else 1.0)
        samples["weighted_recall"].append(totals["captured_weight"] / totals["gold_weight"] if totals["gold_weight"] else 1.0)
        samples["document_full_protection_rate"].append(
            totals["fully_protected_docs"] / totals["positive_docs"] if totals["positive_docs"] else 1.0
        )
        samples["over_redaction_rate"].append(
            totals["fp_chars"] / totals["non_pii_chars"] if totals["non_pii_chars"] else 0.0
        )
    return {
        name: {
            "low_95": _percentile(values, 0.025),
            "high_95": _percentile(values, 0.975),
            "rounds": rounds,
        }
        for name, values in samples.items()
    }


def score_predictions(
    dataset_path: Path,
    predictions_path: Path,
    *,
    bootstrap_rounds: int = 500,
    bootstrap_seed: int = 20261017,
    partition: str = "all",
    minimum_score: float = 0.0,
    partition_scheme: str = PARTITION_SCHEME,
    _collect_document_statistics: bool = False,
) -> dict:
    if partition not in EVALUATION_PARTITIONS:
        raise ValueError(f"Unknown evaluation partition: {partition}")
    if not 0.0 <= minimum_score <= 1.0:
        raise ValueError("minimum_score must be between 0 and 1")
    run_meta, predictions, run_summary = _prediction_records(predictions_path)
    expected_hash = run_meta.get("dataset_sha256")
    if expected_hash:
        digest = hashlib.sha256()
        with dataset_path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_hash:
            raise ValueError("Prediction dataset SHA-256 does not match the evaluation dataset")
    totals = Counter()
    latency_ms: list[float] = []
    normalized_latencies: list[float] = []
    latencies_by_length: dict[str, list[float]] = defaultdict(list)
    per_doc: list[dict] = []
    bootstrap_clusters: dict[str, Counter] = defaultdict(Counter)
    document_statistics: list[dict] = []
    by_label: dict[str, Counter] = defaultdict(Counter)
    by_slice: dict[str, Counter] = defaultdict(Counter)
    by_family: dict[str, Counter] = defaultdict(Counter)
    seen_predictions: set[str] = set()
    total_characters = 0

    for record in iter_jsonl(dataset_path):
        record_id = record["id"]
        if partition != "all" and evaluation_partition(record_id, record["text"], partition_scheme) != partition:
            continue
        prediction = predictions.get(record_id)
        if prediction is None:
            raise ValueError(f"No prediction for dataset record {record_id}")
        seen_predictions.add(record_id)
        predicted = [
            span for span in prediction.get("spans", [])
            if float(span.get("score", 1.0)) >= minimum_score
        ]
        text_length = len(record["text"])
        total_characters += text_length
        for span in predicted:
            if not (0 <= int(span.get("start", -1)) < int(span.get("end", -1)) <= text_length):
                raise ValueError(f"{record_id}: invalid predicted span {span}")
        gold = record["entities"]
        gold_mask = _mask(text_length, gold)
        predicted_mask = _mask(text_length, predicted)
        tp_chars = sum(1 for g, p in zip(gold_mask, predicted_mask) if g and p)
        fp_chars = sum(1 for g, p in zip(gold_mask, predicted_mask) if not g and p)
        gold_chars = sum(gold_mask)
        pred_chars = sum(predicted_mask)
        fn_chars = gold_chars - tp_chars
        non_pii_chars = text_length - gold_chars
        gold_weight = captured_weight = 0
        fully_protected = True
        for entity in gold:
            entity_length = entity["end"] - entity["start"]
            captured = sum(predicted_mask[entity["start"] : entity["end"]])
            weight = risk_for(entity["label"])
            gold_weight += entity_length * weight
            captured_weight += captured * weight
            fully_protected &= captured == entity_length
            label_stats = by_label[entity["label"]]
            label_stats["gold_entities"] += 1
            label_stats["gold_chars"] += entity_length
            label_stats["captured_chars"] += captured
            label_stats["fully_protected_entities"] += captured == entity_length
        for span in predicted:
            by_label[span.get("label", "OTHER_PII")]["predicted_entities"] += 1
        exact = _entity_matches(gold, predicted, exact=True, typed=False)
        typed_exact = _entity_matches(gold, predicted, exact=True, typed=True)
        overlap = _entity_matches(gold, predicted, exact=False, typed=False)
        typed_overlap = _entity_matches(gold, predicted, exact=False, typed=True)
        doc_stats = Counter(
            tp_chars=tp_chars,
            fp_chars=fp_chars,
            fn_chars=fn_chars,
            gold_chars=gold_chars,
            pred_chars=pred_chars,
            non_pii_chars=non_pii_chars,
            gold_weight=gold_weight,
            captured_weight=captured_weight,
            positive_docs=bool(gold),
            fully_protected_docs=bool(gold) and fully_protected,
            negative_docs=not gold,
            clean_negative_docs=(not gold and pred_chars == 0),
            gold_entities=len(gold),
            predicted_entities=len(predicted),
            exact_matches=exact,
            typed_exact_matches=typed_exact,
            overlap_matches=overlap,
            typed_overlap_matches=typed_overlap,
        )
        totals.update(doc_stats)
        per_doc.append(dict(doc_stats))
        source_uid = record.get("metadata", {}).get("source_uid")
        cluster_key = (
            f"source:{record.get('metadata', {}).get('source', '')}:{source_uid}"
            if source_uid else "text:" + " ".join(record["text"].casefold().split())
        )
        bootstrap_clusters[cluster_key].update(doc_stats)
        if _collect_document_statistics:
            document_statistics.append({"id": record_id,
                                        "cluster": hashlib.sha256(cluster_key.encode()).hexdigest(),
                                        "statistics": dict(doc_stats)})
        for slice_name in set(record.get("slices", [])) | {f"domain:{record['domain']}"}:
            by_slice[slice_name].update(doc_stats)
        for family in {entity["family"] for entity in gold}:
            family_gold = [entity for entity in gold if entity["family"] == family]
            family_chars = sum(entity["end"] - entity["start"] for entity in family_gold)
            captured_chars = sum(
                sum(predicted_mask[entity["start"] : entity["end"]]) for entity in family_gold
            )
            by_family[family].update(gold_chars=family_chars, captured_chars=captured_chars, entities=len(family_gold))
        if "latency_ms" in prediction:
            elapsed = float(prediction["latency_ms"])
            latency_ms.append(elapsed)
            normalized_latencies.append(elapsed * 1000 / max(1, text_length))
            bucket = "1-256" if text_length <= 256 else "257-1000" if text_length <= 1000 else "1001-4000" if text_length <= 4000 else "4001+"
            latencies_by_length[bucket].append(elapsed)

    extras = sorted(set(predictions) - seen_predictions)
    if not per_doc:
        raise ValueError("Evaluation partition contains no records")
    if partition == "all" and extras:
        raise ValueError(f"Predictions contain {len(extras)} IDs absent from the dataset; first: {extras[0]}")

    character = _prf(totals["tp_chars"], totals["fp_chars"], totals["fn_chars"])
    exact_metrics = _prf(
        totals["exact_matches"],
        totals["predicted_entities"] - totals["exact_matches"],
        totals["gold_entities"] - totals["exact_matches"],
    )
    typed_exact_metrics = _prf(
        totals["typed_exact_matches"],
        totals["predicted_entities"] - totals["typed_exact_matches"],
        totals["gold_entities"] - totals["typed_exact_matches"],
    )
    overlap_metrics = _prf(
        totals["overlap_matches"],
        totals["predicted_entities"] - totals["overlap_matches"],
        totals["gold_entities"] - totals["overlap_matches"],
    )
    typed_overlap_metrics = _prf(
        totals["typed_overlap_matches"],
        totals["predicted_entities"] - totals["typed_overlap_matches"],
        totals["gold_entities"] - totals["typed_overlap_matches"],
    )

    def slice_result(stats: Counter) -> dict:
        return {
            "character_recall": stats["tp_chars"] / stats["gold_chars"] if stats["gold_chars"] else 1.0,
            "over_redaction_rate": stats["fp_chars"] / stats["non_pii_chars"] if stats["non_pii_chars"] else 0.0,
            "full_protection_rate": stats["fully_protected_docs"] / stats["positive_docs"] if stats["positive_docs"] else 1.0,
            "records": stats["positive_docs"] + stats["negative_docs"],
            "gold_entities": stats["gold_entities"],
        }

    result = {
        "schema_version": 1,
        "run": {**run_meta, **run_summary},
        "evaluation": {
            "partition": partition,
            "partition_scheme": partition_scheme,
            "minimum_score": minimum_score,
            "records": len(per_doc),
            "independent_bootstrap_clusters": len(bootstrap_clusters),
            "bootstrap_sampling_unit": "source-document-or-normalized-text-cluster",
        },
        "counts": dict(totals),
        "safety": {
            "character": character,
            "weighted_recall": totals["captured_weight"] / totals["gold_weight"] if totals["gold_weight"] else 1.0,
            "weighted_leak_rate": 1 - (totals["captured_weight"] / totals["gold_weight"]) if totals["gold_weight"] else 0.0,
            "document_full_protection_rate": totals["fully_protected_docs"] / totals["positive_docs"] if totals["positive_docs"] else 1.0,
            "document_escape_rate": 1 - (totals["fully_protected_docs"] / totals["positive_docs"]) if totals["positive_docs"] else 0.0,
        },
        "utility": {
            "over_redaction_rate": totals["fp_chars"] / totals["non_pii_chars"] if totals["non_pii_chars"] else 0.0,
            "clean_negative_document_rate": totals["clean_negative_docs"] / totals["negative_docs"] if totals["negative_docs"] else 1.0,
        },
        "entities": {
            "exact": exact_metrics,
            "typed_exact": typed_exact_metrics,
            "overlap": overlap_metrics,
            "typed_overlap": typed_overlap_metrics,
        },
        "performance": {
            "records": len(latency_ms),
            "latency_ms_p50": _percentile(latency_ms, 0.50),
            "latency_ms_p95": _percentile(latency_ms, 0.95),
            "latency_ms_p99": _percentile(latency_ms, 0.99),
            "latency_ms_max": max(latency_ms, default=0.0),
            "latency_ms_mean": statistics.fmean(latency_ms) if latency_ms else 0.0,
            "latency_ms_per_1000_characters_p95": _percentile(normalized_latencies, 0.95),
            "latency_by_character_length": {
                key: {"records": len(values), "p50_ms": _percentile(values, 0.5),
                      "p95_ms": _percentile(values, 0.95), "p99_ms": _percentile(values, 0.99)}
                for key, values in sorted(latencies_by_length.items())
            },
            "characters_per_second": totals["gold_chars"] * 0.0,
        },
        "by_label": {},
        "by_family": {},
        "by_slice": {name: slice_result(stats) for name, stats in sorted(by_slice.items())},
        "confidence_intervals": _bootstrap(list(bootstrap_clusters.values()), bootstrap_rounds, bootstrap_seed),
    }
    elapsed_ms = sum(latency_ms)
    result["performance"]["characters_per_second"] = total_characters / (elapsed_ms / 1000) if elapsed_ms else 0.0
    for label, stats in sorted(by_label.items()):
        result["by_label"][label] = {
            "family": family_for(label),
            "gold_entities": stats["gold_entities"],
            "predicted_entities": stats["predicted_entities"],
            "character_recall": stats["captured_chars"] / stats["gold_chars"] if stats["gold_chars"] else None,
            "full_entity_protection_rate": (
                stats["fully_protected_entities"] / stats["gold_entities"] if stats["gold_entities"] else None
            ),
        }
    for family, stats in sorted(by_family.items()):
        result["by_family"][family] = {
            "entities": stats["entities"],
            "character_recall": stats["captured_chars"] / stats["gold_chars"] if stats["gold_chars"] else 1.0,
        }
    if _collect_document_statistics:
        result["_document_statistics"] = document_statistics
    return result


def compare_predictions(dataset_path: Path, first_path: Path, second_path: Path, *,
                        first_minimum_score: float = 0.0, second_minimum_score: float = 0.0,
                        partition: str = "all", rounds: int = 1000, seed: int = 20261017) -> dict:
    """Paired cluster bootstrap of second-minus-first safety/utility differences."""
    if rounds < 1:
        raise ValueError("Paired comparison requires at least one bootstrap round")
    first = score_predictions(dataset_path, first_path, bootstrap_rounds=0, partition=partition,
                              minimum_score=first_minimum_score, _collect_document_statistics=True)
    second = score_predictions(dataset_path, second_path, bootstrap_rounds=0, partition=partition,
                               minimum_score=second_minimum_score, _collect_document_statistics=True)
    first_documents = {item["id"]: item for item in first.pop("_document_statistics")}
    second_documents = {item["id"]: item for item in second.pop("_document_statistics")}
    if set(first_documents) != set(second_documents):
        raise ValueError("Paired predictions do not cover the same evaluation records")
    clusters = defaultdict(lambda: [Counter(), Counter()])
    for record_id, item in first_documents.items():
        clusters[item["cluster"]][0].update(item["statistics"])
        clusters[item["cluster"]][1].update(second_documents[record_id]["statistics"])
    values = list(clusters.values())
    samples = {"weighted_recall": [], "document_full_protection_rate": [], "over_redaction_rate": []}
    rng = random.Random(seed)
    for _ in range(rounds):
        totals = [Counter(), Counter()]
        for _ in range(len(values)):
            pair = values[rng.randrange(len(values))]
            totals[0].update(pair[0])
            totals[1].update(pair[1])
        before, after = totals
        samples["weighted_recall"].append((after["captured_weight"] - before["captured_weight"]) / before["gold_weight"] if before["gold_weight"] else 0)
        samples["document_full_protection_rate"].append((after["fully_protected_docs"] - before["fully_protected_docs"]) / before["positive_docs"] if before["positive_docs"] else 0)
        samples["over_redaction_rate"].append((after["fp_chars"] - before["fp_chars"]) / before["non_pii_chars"] if before["non_pii_chars"] else 0)
    point_differences = {
        "weighted_recall": second["safety"]["weighted_recall"] - first["safety"]["weighted_recall"],
        "document_full_protection_rate": second["safety"]["document_full_protection_rate"] - first["safety"]["document_full_protection_rate"],
        "over_redaction_rate": second["utility"]["over_redaction_rate"] - first["utility"]["over_redaction_rate"],
    }
    return {"first": first["run"]["candidate_id"], "second": second["run"]["candidate_id"],
            "evaluation": first["evaluation"], "bootstrap_clusters": len(values), "rounds": rounds,
            "direction": "second-minus-first", "paired_differences": {
                name: {"difference": point_differences[name], "low_95": _percentile(sample, 0.025),
                       "high_95": _percentile(sample, 0.975)}
                for name, sample in samples.items()}}


def calibrate_threshold(
    dataset_path: Path,
    predictions_path: Path,
    *,
    thresholds: Iterable[float],
    max_over_redaction: float = 0.02,
    bootstrap_seed: int = 20261017,
    calibration_partition: str = "calibration",
    partition_scheme: str = PARTITION_SCHEME,
) -> dict:
    """Select a threshold on calibration records only, under an over-redaction constraint."""
    if calibration_partition not in {"all", "calibration"}:
        raise ValueError("Threshold tuning is restricted to calibration or a separately supplied calibration file")
    unique_thresholds = sorted({float(value) for value in thresholds})
    if not unique_thresholds:
        raise ValueError("At least one threshold is required")
    if not 0.0 <= max_over_redaction <= 1.0:
        raise ValueError("max_over_redaction must be between 0 and 1")
    scored: list[dict] = []
    for threshold in unique_thresholds:
        result = score_predictions(
            dataset_path,
            predictions_path,
            bootstrap_rounds=0,
            bootstrap_seed=bootstrap_seed,
            partition=calibration_partition,
            minimum_score=threshold,
            partition_scheme=partition_scheme,
        )
        scored.append(
            {
                "threshold": threshold,
                "weighted_recall": result["safety"]["weighted_recall"],
                "document_full_protection_rate": result["safety"]["document_full_protection_rate"],
                "character_precision": result["safety"]["character"]["precision"],
                "over_redaction_rate": result["utility"]["over_redaction_rate"],
                "clean_negative_document_rate": result["utility"]["clean_negative_document_rate"],
            }
        )
    feasible = [item for item in scored if item["over_redaction_rate"] <= max_over_redaction]
    if feasible:
        selected = max(
            feasible,
            key=lambda item: (
                item["weighted_recall"],
                item["document_full_protection_rate"],
                item["character_precision"],
                item["threshold"],
            ),
        )
        selection_reason = "maximum weighted recall subject to the over-redaction constraint"
    else:
        selected = min(
            scored,
            key=lambda item: (
                item["over_redaction_rate"],
                -item["weighted_recall"],
                -item["character_precision"],
                -item["threshold"],
            ),
        )
        selection_reason = "no threshold met the over-redaction constraint; selected minimum over-redaction"
    return {
        "schema_version": 1,
        "partition": calibration_partition,
        "partition_scheme": partition_scheme,
        "objective": {
            "primary": "weighted_recall",
            "constraint": {"over_redaction_rate_max": max_over_redaction},
        },
        "selected": selected,
        "selection_reason": selection_reason,
        "thresholds": scored,
    }


def calibrate_ensemble(
    dataset_path: Path,
    prediction_paths: list[Path],
    *,
    threshold_grids: list[list[float]],
    max_over_redaction: float = 0.02,
    strategy: str = "union",
    partition_scheme: str = PARTITION_SCHEME,
    calibration_partition: str = "calibration",
) -> dict:
    """Grid-search member thresholds on calibration records only."""
    from .runner import combine_predictions

    if calibration_partition not in {"all", "calibration"}:
        raise ValueError("Ensemble tuning is restricted to calibration data")

    if len(prediction_paths) < 2:
        raise ValueError("Ensemble calibration requires at least two prediction files")
    if len(prediction_paths) != len(threshold_grids):
        raise ValueError("Provide exactly one threshold grid per prediction file")
    grids = [sorted({float(value) for value in values}) for values in threshold_grids]
    if any(not grid for grid in grids):
        raise ValueError("Every ensemble member needs at least one threshold")
    combinations = math.prod(len(grid) for grid in grids)
    if combinations > 10_000:
        raise ValueError(f"Refusing an ensemble grid with {combinations} combinations (maximum 10000)")
    scored: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="llss-ensemble-calibration-") as directory:
        predictions_path = Path(directory) / "predictions.jsonl"
        for thresholds in itertools.product(*grids):
            metadata = combine_predictions(
                prediction_paths,
                predictions_path,
                strategy,
                minimum_scores=list(thresholds),
            )
            result = score_predictions(
                dataset_path,
                predictions_path,
                bootstrap_rounds=0,
                partition=calibration_partition,
                partition_scheme=partition_scheme,
            )
            scored.append(
                {
                    "thresholds": dict(zip(metadata["members"], thresholds)),
                    "weighted_recall": result["safety"]["weighted_recall"],
                    "document_full_protection_rate": result["safety"]["document_full_protection_rate"],
                    "character_precision": result["safety"]["character"]["precision"],
                    "over_redaction_rate": result["utility"]["over_redaction_rate"],
                    "clean_negative_document_rate": result["utility"]["clean_negative_document_rate"],
                }
            )
    feasible = [item for item in scored if item["over_redaction_rate"] <= max_over_redaction]
    if feasible:
        selected = max(
            feasible,
            key=lambda item: (
                item["weighted_recall"],
                item["document_full_protection_rate"],
                item["character_precision"],
                tuple(item["thresholds"].values()),
            ),
        )
        selection_reason = "maximum weighted recall subject to the over-redaction constraint"
    else:
        selected = min(
            scored,
            key=lambda item: (
                item["over_redaction_rate"],
                -item["weighted_recall"],
                -item["character_precision"],
            ),
        )
        selection_reason = "no combination met the over-redaction constraint; selected minimum over-redaction"
    return {
        "schema_version": 1,
        "partition": calibration_partition,
        "partition_scheme": partition_scheme,
        "strategy": strategy,
        "objective": {
            "primary": "weighted_recall",
            "constraint": {"over_redaction_rate_max": max_over_redaction},
        },
        "selected": selected,
        "selection_reason": selection_reason,
        "combinations_evaluated": combinations,
        "grid_results": sorted(scored, key=lambda item: item["weighted_recall"], reverse=True),
    }


def pareto_frontier(results: list[dict]) -> list[str]:
    """Return undominated run IDs over safety, utility, latency, size, and memory."""
    def vector(item: dict) -> tuple[float, ...]:
        run = item.get("run", {})
        artifact = run.get("artifact_mb")
        memory = run.get("peak_rss_mb")
        return (
            item["safety"]["weighted_recall"],
            item["safety"]["document_full_protection_rate"],
            -item["utility"]["over_redaction_rate"],
            -item["performance"]["latency_ms_p95"],
            -(float(artifact) if artifact is not None else math.inf),
            -(float(memory) if memory is not None else math.inf),
        )

    frontier: list[str] = []
    for index, item in enumerate(results):
        candidate = vector(item)
        dominated = False
        for other_index, other in enumerate(results):
            if index == other_index:
                continue
            challenger = vector(other)
            if all(a >= b for a, b in zip(challenger, candidate)) and any(a > b for a, b in zip(challenger, candidate)):
                dominated = True
                break
        if not dominated:
            frontier.append(str(item.get("run", {}).get("candidate_id", f"run-{index}")))
    return frontier


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
