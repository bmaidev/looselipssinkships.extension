"""Fail-closed evidence review for the local architecture, not a safety certification.

An eligible result still requires a human release decision. Dossier attestations
are references to reviewed evidence; this command cannot verify their truth.
"""

from __future__ import annotations

import math
import re

from .taxonomy import DEFINITIONS


POLICY_VERSION = "local-release-2026-10-17-v1"
REQUIRED_REVIEWS = (
    "independent_holdout", "human_adjudication", "offline_inference", "no_input_telemetry",
    "no_remote_code", "safe_serialization", "redistribution_licence", "artifact_integrity",
    "browser_tokenizer_offsets", "long_document_coverage", "submission_upload_controls",
    "cancellation_concurrency", "worker_restart", "offline_corrupt_cache_recovery",
    "accessible_degraded_state", "production_identifier_non_regression",
)
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def _number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def evaluate_release(metrics: dict, dossier: dict) -> dict:
    """Require full-taxonomy test evidence and exact-artifact Chrome/Edge evidence.

    Missing/NaN/bool values never pass numerical gates. Native inference and Node
    WASM timings cannot stand in for measurements of the packaged extension.
    """
    checks = []

    def check(name: str, passed: bool, actual: object, required: object) -> None:
        checks.append({"gate": name, "passed": bool(passed), "actual": actual, "required": required})

    def lower(name: str, value: object, minimum: float) -> None:
        check(name, _number(value) and minimum <= value <= 1, value, {"minimum": minimum})

    def upper(name: str, value: object, maximum: float) -> None:
        check(name, _number(value) and 0 <= value <= maximum, value, {"maximum": maximum})

    evaluation = metrics.get("evaluation", {})
    check("test_partition", evaluation.get("partition") == "test", evaluation.get("partition"), "test")
    intervals = metrics.get("confidence_intervals", {})
    for name, minimum in (("weighted_recall", .995), ("document_full_protection_rate", .98),
                          ("clean_negative_document_rate", .98)):
        interval = intervals.get(name, {})
        lower(name + "_lower_95", interval.get("low_95"), minimum)
        rounds = interval.get("rounds")
        check(name + "_bootstrap_rounds", _number(rounds) and rounds >= 1000, rounds, {"minimum": 1000})
    upper("over_redaction_upper_95", intervals.get("over_redaction_rate", {}).get("high_95"), .02)
    rounds = intervals.get("over_redaction_rate", {}).get("rounds")
    check("over_redaction_bootstrap_rounds", _number(rounds) and rounds >= 1000, rounds, {"minimum": 1000})
    # Bootstrap percentiles collapse at perfect scores. Require independent
    # cluster success bounds as an additional conservative support guardrail.
    for name in ("clean_negative", "full_protection"):
        interval = metrics.get("cluster_guardrails", {}).get(name, {})
        lower(name + "_cluster_lower_95", interval.get("low_95"), .98)
        count = interval.get("trials")
        check(name + "_independent_clusters", _number(count) and count >= 1000, count, {"minimum": 1000})
    for label in DEFINITIONS:
        count = metrics.get("by_label", {}).get(label, {}).get("independent_clusters")
        check("label_support:" + label, _number(count) and count >= 100, count, {"minimum": 100})
    for family in sorted({item.family for item in DEFINITIONS.values() if item.risk == 5}):
        result = metrics.get("by_family", {}).get(family, {})
        lower("risk5_recall_lower_95:" + family, result.get("confidence_interval", {}).get("low_95"), .99)
        rounds = result.get("confidence_interval", {}).get("rounds")
        check("risk5_bootstrap_rounds:" + family, _number(rounds) and rounds >= 1000, rounds, {"minimum": 1000})
        lower("risk5_full_cluster_lower_95:" + family,
              result.get("full_cluster_protection_interval", {}).get("low_95"), .99)
        count = result.get("independent_clusters")
        check("risk5_independent_clusters:" + family, _number(count) and count >= 1000, count, {"minimum": 1000})

    run = metrics.get("run", {})
    for name in ("dataset_sha256", "artifact_sha256"):
        expected, actual = run.get(name), dossier.get(name)
        check("binding:" + name, isinstance(expected, str) and bool(_SHA256.fullmatch(expected)) and expected == actual,
              actual, expected or "SHA-256 from scored predictions")
    # The exact extension package must be bound separately: model hash alone is
    # not sufficient to test the code, tokenizer, worker and runtime being shipped.
    packages = dossier.get("extension_packages", {})
    upper("complete_download_mb", dossier.get("complete_download_mb"), 100)
    device = dossier.get("low_spec_device_id")
    check("low_spec_reference_device", isinstance(device, str) and bool(device.strip()), device, "named low-spec reference device")
    runs = dossier.get("browser_runs", [])
    if not isinstance(runs, list):
        runs = []
    for browser in ("chrome", "edge"):
        package_hash = packages.get(browser)
        check(browser + ":extension_package_sha256",
              isinstance(package_hash, str) and bool(_SHA256.fullmatch(package_hash)),
              package_hash, "SHA-256 of tested browser-specific package")
        valid = [item for item in runs if isinstance(item, dict) and item.get("browser") == browser
                 and item.get("device_id") == device and item.get("extension_package_sha256") == package_hash
                 and item.get("artifact_sha256") == run.get("artifact_sha256")
                 and item.get("scope") == "packaged-extension" and item.get("offline") is True
                 and isinstance(item.get("browser_version"), str) and item["browser_version"].strip()
                 and isinstance(item.get("repetition_id"), str) and item["repetition_id"].strip()
                 and isinstance(item.get("evidence_sha256"), str) and _SHA256.fullmatch(item["evidence_sha256"])]
        identifiers = [item["repetition_id"] for item in valid]
        unique = len(set(identifiers)) == len(identifiers)
        check(browser + ":timed_repetitions", len(valid) >= 3 and unique, len(valid), "at least 3 distinct packaged-extension repetitions")
        for index, item in enumerate(valid):
            for metric, maximum in (("short_document_warm_p95_ms", 50), ("cold_start_ms", 2000),
                                    ("peak_extension_memory_mib", 512)):
                upper(f"{browser}:{index}:{metric}", item.get(metric), maximum)
    reviews = dossier.get("reviews", {})
    for name in REQUIRED_REVIEWS:
        review = reviews.get(name, {})
        reference = review.get("evidence_sha256")
        check("review:" + name,
              review.get("status") == "pass" and isinstance(reference, str) and bool(_SHA256.fullmatch(reference)),
              review, "reviewed pass with evidence SHA-256")
    passed = all(item["passed"] for item in checks)
    return {"schema_version": 1, "policy_version": POLICY_VERSION,
            "decision": "eligible_for_human_release_review" if passed else "blocked",
            "eligible": passed, "failed_gates": [item["gate"] for item in checks if not item["passed"]],
            "checks": checks,
            "limitations": "Validates supplied evidence, not attestation truth. Does not certify safety or authorise publication."}
