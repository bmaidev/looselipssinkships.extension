from __future__ import annotations

import json
from pathlib import Path

from .metrics import pareto_frontier


def load_results(paths: list[Path]) -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in paths]


def _pct(value: float) -> str:
    return f"{100 * value:.3f}%"


def render_markdown(results: list[dict]) -> str:
    if not results:
        raise ValueError("At least one metrics file is required")
    dataset_hashes = {item.get("run", {}).get("dataset_sha256") for item in results}
    partitions = {item.get("evaluation", {}).get("partition", "all") for item in results}
    schemes = {item.get("evaluation", {}).get("partition_scheme") for item in results}
    if len(dataset_hashes) != 1:
        raise ValueError("Cannot compare results from different dataset hashes")
    if len(partitions) != 1:
        raise ValueError("Cannot compare different evaluation partitions in one report")
    if len(schemes) != 1:
        raise ValueError("Cannot compare different partition schemes in one report")
    dataset_hash = next(iter(dataset_hashes))
    partition = next(iter(partitions))
    ordered = sorted(results, key=lambda item: item["safety"]["weighted_recall"], reverse=True)
    frontier = set(pareto_frontier(ordered))
    lines = [
        "# Local PII/PSI model benchmark",
        "",
        "> Synthetic benchmark results are comparative engineering evidence, not a guarantee that all real-world personal information will be detected.",
        "",
        f"Dataset SHA-256: `{dataset_hash or 'not recorded'}`  ",
        f"Evaluation partition: `{partition}`",
        "",
        "## Summary",
        "",
        "| Candidate | Threshold | Weighted recall (95% CI) | Full-document protection | Over-redaction | p95 latency | Peak RSS | Artifact | Pareto |",
        "|---|---:|---:|---:|---:|---:|---:|---:|:---:|",
    ]
    for result in ordered:
        run = result.get("run", {})
        evaluation = result.get("evaluation", {})
        candidate_id = str(run.get("candidate_id", "unknown"))
        interval = result.get("confidence_intervals", {}).get("weighted_recall", {})
        weighted = _pct(result["safety"]["weighted_recall"])
        if interval:
            weighted += f" ({_pct(interval['low_95'])}–{_pct(interval['high_95'])})"
        member_thresholds = run.get("member_minimum_scores")
        threshold = (
            ", ".join(f"{key}={float(value):.2f}" for key, value in member_thresholds.items())
            if member_thresholds
            else f"{float(evaluation.get('minimum_score', 0)):.2f}"
        )
        lines.append(
            "| {id} | {threshold} | {weighted} | {document} | {over} | {latency:.2f} ms | {rss} | {artifact} | {pareto} |".format(
                id=candidate_id,
                threshold=threshold,
                weighted=weighted,
                document=_pct(result["safety"]["document_full_protection_rate"]),
                over=_pct(result["utility"]["over_redaction_rate"]),
                latency=result["performance"]["latency_ms_p95"],
                rss=(f"{float(run['peak_rss_mb']):.1f} MB" if run.get("peak_rss_mb") is not None else "unknown"),
                artifact=(f"{float(run['artifact_mb']):.1f} MB" if run.get("artifact_mb") is not None else "unknown"),
                pareto="yes" if candidate_id in frontier else "",
            )
        )
    lines.extend(["", "## Minimum per-family character recall", ""])
    families = sorted({family for result in ordered for family in result.get("by_family", {})})
    lines.append("| Candidate | Worst family | Recall |")
    lines.append("|---|---|---:|")
    for result in ordered:
        family_results = result.get("by_family", {})
        if family_results:
            family, stats = min(family_results.items(), key=lambda item: item[1]["character_recall"])
            lines.append(f"| {result['run']['candidate_id']} | {family} | {_pct(stats['character_recall'])} |")
    lines.extend(
        [
            "",
            "## Interpretation rules",
            "",
            "- Treat a missed high-risk character and a document with any residual sensitive span as safety failures; do not select on F1 alone.",
            "- Compare confidence intervals and slice results before interpreting small score differences.",
            "- A model must remain behind the deterministic rules layer unless the combined run is demonstrably safer.",
            "- Licence, immutable revision, browser artifact, memory, and offline execution are release gates, not tie-breakers.",
            "",
        ]
    )
    return "\n".join(lines)
