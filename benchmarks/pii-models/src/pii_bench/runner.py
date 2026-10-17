"""Candidate execution, prediction caching, and ensemble composition."""

from __future__ import annotations

import hashlib
import itertools
import json
import os
from pathlib import Path
import platform
import resource
import sys
import time
from typing import Iterable

from .adapters import create_adapter
from .dataset import iter_jsonl, validate_dataset
from .taxonomy import canonical_label


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def system_profile() -> dict:
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "node": _node_version(),
        "logical_cpus": os.cpu_count(),
    }


def _node_version() -> str | None:
    import subprocess

    try:
        return subprocess.run(["node", "--version"], check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _peak_rss_mb() -> float:
    try:
        import psutil

        process = psutil.Process()
        return process.memory_info().rss / (1024 * 1024)
    except ImportError:
        own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
        return own / divisor


def _measured_rss_mb(adapter) -> float:
    return _peak_rss_mb() + float(getattr(adapter, "child_rss_mb", 0.0))


def run_candidate(
    candidate: dict,
    dataset_path: Path,
    output_path: Path,
    benchmark_root: Path,
    *,
    cache_dir: Path | None = None,
    warmup_records: int = 3,
    allow_remote_code: bool = False,
) -> dict:
    validation = validate_dataset(dataset_path)
    warmups = list(itertools.islice(iter_jsonl(dataset_path), warmup_records))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    initialized_started = time.perf_counter()
    adapter = create_adapter(candidate, benchmark_root, cache_dir, allow_remote_code)
    adapter_initialization_ms = (time.perf_counter() - initialized_started) * 1000
    peak_rss = _measured_rss_mb(adapter)
    try:
        warmup_latencies: list[float] = []
        for record in warmups:
            warmup_started = time.perf_counter()
            adapter.predict(record["text"], record["id"])
            warmup_latencies.append((time.perf_counter() - warmup_started) * 1000)
            peak_rss = max(peak_rss, _measured_rss_mb(adapter))
        cold_start_ms = adapter_initialization_ms + (warmup_latencies[0] if warmup_latencies else 0)
        metadata = {
            "schema_version": 1,
            "candidate_id": candidate["id"],
            "candidate_name": candidate["name"],
            "repository": candidate.get("repository"),
            "revision": candidate.get("revision"),
            "adapter": candidate["adapter"],
            "model_file": candidate.get("model_file"),
            "license": candidate["license"],
            "release_eligible": candidate["release_eligible"],
            "artifact_mb": candidate.get("artifact_mb"),
            "dataset_sha256": validation["sha256"],
            "dataset_records": validation["records"],
            "warmup_records": len(warmups),
            "adapter_initialization_ms": adapter_initialization_ms,
            "cold_start_ms": cold_start_ms,
            "warmup_latency_ms": warmup_latencies,
            "system": system_profile(),
        }
        started = time.perf_counter()
        with temporary_path.open("w", encoding="utf-8") as output:
            output.write(json.dumps({"_meta": metadata}, ensure_ascii=False, separators=(",", ":")) + "\n")
            prediction_records = 0
            for record in iter_jsonl(dataset_path):
                prediction_started = time.perf_counter()
                spans = adapter.predict(record["text"], record["id"])
                latency_ms = (time.perf_counter() - prediction_started) * 1000
                sanitized = []
                for span in spans:
                    start, end = int(span["start"]), int(span["end"])
                    if not (0 <= start < end <= len(record["text"])):
                        raise ValueError(f"{record['id']}: adapter produced invalid span {span}")
                    sanitized.append(
                        {
                            "start": start,
                            "end": end,
                            "label": canonical_label(span.get("label", "OTHER_PII")),
                            "score": round(float(span.get("score", 1.0)), 8),
                        }
                    )
                output.write(
                    json.dumps(
                        {"id": record["id"], "spans": sanitized, "latency_ms": latency_ms},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
                prediction_records += 1
                peak_rss = max(peak_rss, _measured_rss_mb(adapter))
            prediction_elapsed_ms = (time.perf_counter() - started) * 1000
            summary = {
                "prediction_elapsed_ms": prediction_elapsed_ms,
                "peak_rss_mb": peak_rss,
                "prediction_records": prediction_records,
            }
            output.write(json.dumps({"_summary": summary}, separators=(",", ":")) + "\n")
        temporary_path.replace(output_path)
        return {**metadata, **summary, "predictions_sha256": _sha256(output_path)}
    finally:
        adapter.close()
        if temporary_path.exists():
            temporary_path.unlink()


def load_predictions(path: Path) -> tuple[dict, dict[str, dict], dict]:
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


def _merge_spans(span_groups: Iterable[list[dict]], strategy: str) -> list[dict]:
    candidates = []
    for source_index, spans in enumerate(span_groups):
        for span in spans:
            candidates.append({**span, "_source": source_index})
    candidates.sort(key=lambda item: (item["start"], item["end"], item["_source"]))
    if strategy == "union":
        return [{key: value for key, value in item.items() if key != "_source"} for item in candidates]
    if strategy != "precedence":
        raise ValueError(f"Unknown ensemble strategy: {strategy}")
    accepted: list[dict] = []
    for candidate in sorted(candidates, key=lambda item: (item["_source"], item["start"], item["end"])):
        if any(candidate["start"] < item["end"] and candidate["end"] > item["start"] for item in accepted):
            continue
        accepted.append(candidate)
    return [
        {key: value for key, value in item.items() if key != "_source"}
        for item in sorted(accepted, key=lambda item: (item["start"], item["end"]))
    ]


def combine_predictions(
    inputs: list[Path],
    output_path: Path,
    strategy: str = "union",
    minimum_scores: list[float] | None = None,
) -> dict:
    if len(inputs) < 2:
        raise ValueError("An ensemble requires at least two prediction files")
    if minimum_scores is None:
        minimum_scores = [0.0] * len(inputs)
    if len(minimum_scores) != len(inputs):
        raise ValueError("Provide exactly one member minimum score per prediction file")
    if any(not 0.0 <= value <= 1.0 for value in minimum_scores):
        raise ValueError("Member minimum scores must be between 0 and 1")
    loaded = [load_predictions(path) for path in inputs]
    id_sets = [set(records) for _, records, _ in loaded]
    if any(ids != id_sets[0] for ids in id_sets[1:]):
        raise ValueError("Ensemble inputs do not cover the same record IDs")
    dataset_hashes = {meta.get("dataset_sha256") for meta, _, _ in loaded}
    if len(dataset_hashes) != 1:
        raise ValueError("Ensemble inputs were produced from different datasets")
    candidate_ids = [meta["candidate_id"] for meta, _, _ in loaded]
    if len(candidate_ids) != len(set(candidate_ids)):
        raise ValueError("Ensemble members must have distinct candidate IDs")
    artifact_sizes = [meta.get("artifact_mb") for meta, _, _ in loaded]
    memory_sizes = [summary.get("peak_rss_mb") for _, _, summary in loaded]
    metadata = {
        "schema_version": 1,
        "candidate_id": f"{strategy}({'+'.join(candidate_ids)})",
        "candidate_name": f"{strategy.title()} ensemble: {', '.join(candidate_ids)}",
        "adapter": "ensemble",
        "members": candidate_ids,
        "member_minimum_scores": dict(zip(candidate_ids, minimum_scores)),
        "strategy": strategy,
        "resource_measurement": "sum-of-cached-member-estimates; not measured as an integrated pipeline",
        "dataset_sha256": dataset_hashes.pop(),
        "release_eligible": all(meta.get("release_eligible") is True for meta, _, _ in loaded),
        "artifact_mb": (
            sum(float(size) for size in artifact_sizes)
            if all(size is not None for size in artifact_sizes)
            else None
        ),
        "peak_rss_mb": (
            sum(float(size) for size in memory_sizes)
            if all(size is not None for size in memory_sizes)
            else None
        ),
    }
    elapsed = sum(float(summary.get("prediction_elapsed_ms") or 0) for _, _, summary in loaded)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output:
        output.write(json.dumps({"_meta": metadata}, separators=(",", ":")) + "\n")
        for record_id in sorted(id_sets[0]):
            member_records = [records[record_id] for _, records, _ in loaded]
            thresholded = [
                [span for span in record["spans"] if float(span.get("score", 1.0)) >= minimum_score]
                for record, minimum_score in zip(member_records, minimum_scores)
            ]
            spans = _merge_spans(thresholded, strategy)
            latency = sum(float(record.get("latency_ms") or 0) for record in member_records)
            output.write(json.dumps({"id": record_id, "spans": spans, "latency_ms": latency}, separators=(",", ":")) + "\n")
        output.write(json.dumps({"_summary": {"prediction_elapsed_ms": elapsed, "peak_rss_mb": metadata["peak_rss_mb"]}}, separators=(",", ":")) + "\n")
    return {**metadata, "prediction_elapsed_ms": elapsed, "predictions_sha256": _sha256(output_path)}
