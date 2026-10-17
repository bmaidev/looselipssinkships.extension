from __future__ import annotations

import unittest

from pii_bench.report import render_markdown


def _result(candidate: str, dataset: str = "abc", partition: str = "test") -> dict:
    return {
        "run": {
            "candidate_id": candidate,
            "dataset_sha256": dataset,
            "artifact_mb": 1,
            "peak_rss_mb": 2,
        },
        "evaluation": {"partition": partition, "minimum_score": 0.5},
        "safety": {"weighted_recall": 0.9, "document_full_protection_rate": 0.8},
        "utility": {"over_redaction_rate": 0.01},
        "performance": {"latency_ms_p95": 3},
        "by_family": {"identity": {"character_recall": 0.85}},
        "confidence_intervals": {"weighted_recall": {"low_95": 0.88, "high_95": 0.92}},
    }


class ReportTests(unittest.TestCase):
    def test_report_records_dataset_partition_threshold_and_interval(self):
        report = render_markdown([_result("candidate")])
        self.assertIn("Dataset SHA-256: `abc`", report)
        self.assertIn("Evaluation partition: `test`", report)
        self.assertIn("0.50", report)
        self.assertIn("88.000%–92.000%", report)

    def test_report_rejects_mixed_partitions(self):
        with self.assertRaisesRegex(ValueError, "partitions"):
            render_markdown([_result("one"), _result("two", partition="calibration")])

    def test_report_rejects_mixed_datasets(self):
        with self.assertRaisesRegex(ValueError, "dataset"):
            render_markdown([_result("one"), _result("two", dataset="different")])


if __name__ == "__main__":
    unittest.main()
