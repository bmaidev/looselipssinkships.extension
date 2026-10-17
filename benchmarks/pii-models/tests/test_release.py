from __future__ import annotations

import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.cli import main
from pii_bench.release import REQUIRED_REVIEWS, evaluate_release
from pii_bench.taxonomy import DEFINITIONS


def complete_evidence():
    """Fabricated passing fixture; never a real release attestation."""
    interval = {"low_95": .999, "high_95": 1, "rounds": 1000}
    guard = {"low_95": .999, "trials": 5000}
    metrics = {
        "run": {"dataset_sha256": "a" * 64, "artifact_sha256": "b" * 64},
        "evaluation": {"partition": "test"},
        "confidence_intervals": {name: copy.deepcopy(interval) for name in (
            "weighted_recall", "document_full_protection_rate", "clean_negative_document_rate")},
        "cluster_guardrails": {name: copy.deepcopy(guard) for name in ("clean_negative", "full_protection")},
        "by_label": {label: {"independent_clusters": 100} for label in DEFINITIONS},
        "by_family": {item.family: {"independent_clusters": 5000, "confidence_interval": copy.deepcopy(interval),
                                    "full_cluster_protection_interval": copy.deepcopy(guard)}
                      for item in DEFINITIONS.values()},
    }
    metrics["confidence_intervals"]["over_redaction_rate"] = {"high_95": .01, "rounds": 1000}
    dossier = {**metrics["run"], "extension_packages": {"chrome": "c" * 64, "edge": "f" * 64}, "complete_download_mb": 25,
               "low_spec_device_id": "reference-low-1", "browser_runs": [],
               "reviews": {name: {"status": "pass", "evidence_sha256": "d" * 64} for name in REQUIRED_REVIEWS}}
    for browser in ("chrome", "edge"):
        for repetition in range(3):
            dossier["browser_runs"].append({
                "browser": browser, "browser_version": "test-only", "repetition_id": f"{browser}-{repetition}",
                "device_id": dossier["low_spec_device_id"], "scope": "packaged-extension", "offline": True,
                "extension_package_sha256": dossier["extension_packages"][browser], "artifact_sha256": dossier["artifact_sha256"],
                "evidence_sha256": "e" * 64, "short_document_warm_p95_ms": 10,
                "cold_start_ms": 500, "peak_extension_memory_mib": 100})
    return metrics, dossier


class ReleaseTests(unittest.TestCase):
    def test_empty_evidence_is_blocked(self):
        result = evaluate_release({}, {})
        self.assertFalse(result["eligible"])
        self.assertGreater(len(result["failed_gates"]), 50)

    def test_complete_fixture_only_becomes_eligible_for_human_review(self):
        metrics, dossier = complete_evidence()
        result = evaluate_release(metrics, dossier)
        self.assertTrue(result["eligible"], result["failed_gates"])
        self.assertEqual(result["decision"], "eligible_for_human_release_review")

    def test_every_individual_evidence_requirement_blocks_when_missing(self):
        metrics, dossier = complete_evidence()
        for name in REQUIRED_REVIEWS:
            with self.subTest(review=name):
                modified = copy.deepcopy(dossier)
                del modified["reviews"][name]
                self.assertIn("review:" + name, evaluate_release(metrics, modified)["failed_gates"])

    def test_unsafe_or_unrepresentative_results_cannot_pass(self):
        mutations = [
            lambda m, d: m["confidence_intervals"]["weighted_recall"].update(low_95=.9949),
            lambda m, d: m["confidence_intervals"]["clean_negative_document_rate"].update(low_95=.9799),
            lambda m, d: m["confidence_intervals"]["over_redaction_rate"].update(high_95=.0201),
            lambda m, d: m["confidence_intervals"]["weighted_recall"].update(low_95=float("nan")),
            lambda m, d: m["confidence_intervals"]["weighted_recall"].update(low_95=True),
            lambda m, d: m["confidence_intervals"]["weighted_recall"].update(rounds=10),
            lambda m, d: m["evaluation"].update(partition="calibration"),
            lambda m, d: m["by_label"].pop("CHILD_STATUS"),
            lambda m, d: m["by_family"]["sensitive_health"]["confidence_interval"].update(low_95=.98),
            lambda m, d: m["cluster_guardrails"]["clean_negative"].update(trials=16),
            lambda m, d: d.update(artifact_sha256="f" * 64),
            lambda m, d: d.update(complete_download_mb=101),
            lambda m, d: d["browser_runs"][0].update(peak_extension_memory_mib=513),
            lambda m, d: d["browser_runs"][0].update(short_document_warm_p95_ms=51),
            lambda m, d: d["browser_runs"][0].update(cold_start_ms=2001),
            lambda m, d: d["browser_runs"][0].update(scope="Node WASM"),
            lambda m, d: d["browser_runs"][0].update(offline=False),
            lambda m, d: d["browser_runs"][0].update(extension_package_sha256="f" * 64),
            lambda m, d: d["browser_runs"][0].update(repetition_id="chrome-1"),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                metrics, dossier = complete_evidence()
                mutate(metrics, dossier)
                self.assertFalse(evaluate_release(metrics, dossier)["eligible"])

    def test_cli_exits_nonzero_and_preserves_blocked_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("metrics", "dossier"):
                (root / f"{name}.json").write_text("{}")
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as raised:
                main(["release-check", "--metrics", str(root / "metrics.json"),
                      "--dossier", str(root / "dossier.json"), "--output", str(root / "report.json")])
            self.assertEqual(raised.exception.code, 1)
            self.assertEqual(json.loads((root / "report.json").read_text())["decision"], "blocked")
