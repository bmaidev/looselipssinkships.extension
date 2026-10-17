from __future__ import annotations

import json
import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from pii_bench.dataset import evaluation_partition, write_dataset, iter_jsonl
from pii_bench.cli import main
from pii_bench.metrics import calibrate_ensemble, calibrate_threshold, compare_predictions, pareto_frontier, score_predictions


def _write_predictions(path: Path, dataset: Path, mode: str, candidate_id: str | None = None) -> None:
    with path.open("w", encoding="utf-8") as output:
        output.write(json.dumps({"_meta": {"candidate_id": candidate_id or mode, "artifact_mb": 1}}) + "\n")
        for record in iter_jsonl(dataset):
            spans = record["entities"] if mode == "perfect" else []
            output.write(json.dumps({"id": record["id"], "spans": spans, "latency_ms": 1}) + "\n")
        output.write(json.dumps({"_summary": {"prediction_elapsed_ms": 250, "peak_rss_mb": 10}}) + "\n")


class MetricTests(unittest.TestCase):
    def test_small_false_positive_on_every_negative_is_not_acceptable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset, predictions = root / "data.jsonl", root / "predictions.jsonl"
            write_dataset(dataset, 250, 25)
            with predictions.open("w") as output:
                output.write(json.dumps({"_meta": {"candidate_id": "utility-test"}}) + "\n")
                for record in iter_jsonl(dataset):
                    spans = [{**span, "score": .9} for span in record["entities"]]
                    if not record["entities"]:
                        spans.append({"start": 0, "end": 1, "label": "OTHER_PII", "score": .2})
                    output.write(json.dumps({"id": record["id"], "spans": spans}) + "\n")
            result = calibrate_threshold(dataset, predictions, thresholds=[0, .5], calibration_partition="all")
            self.assertLess(result["thresholds"][0]["over_redaction_rate"], .02)
            self.assertEqual(result["thresholds"][0]["clean_negative_document_rate"], 0)
            self.assertEqual(result["selected"]["threshold"], .5)
            infeasible = calibrate_threshold(dataset, predictions, thresholds=[0], calibration_partition="all")
            self.assertFalse(infeasible["feasible"])
            self.assertIsNone(infeasible["selected"])
            self.assertIsNotNone(infeasible["diagnostic_only"])
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as raised:
                main(["calibrate", "--dataset", str(dataset), "--predictions", str(predictions),
                      "--threshold", "0", "--calibration-partition", "all", "--output", str(root / "selection.json")])
            self.assertEqual(raised.exception.code, 1)
            self.assertIsNone(json.loads((root / "selection.json").read_text())["selected"])
            empty = root / "empty.jsonl"
            _write_predictions(empty, dataset, "empty")
            ensemble = calibrate_ensemble(dataset, [predictions, empty], threshold_grids=[[0], [0]],
                                          calibration_partition="all")
            self.assertFalse(ensemble["feasible"])
            self.assertIsNone(ensemble["selected"])

    def test_repeated_perfect_documents_do_not_imply_certainty(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset, predictions = root / "data.jsonl", root / "predictions.jsonl"
            with dataset.open("w") as output:
                for index in range(200):
                    output.write(json.dumps({"id": str(index), "domain": "test", "text": "Private condition: asthma",
                                             "entities": [{"label": "HEALTH_CONDITION", "family": "sensitive_health",
                                                           "start": 19, "end": 25}]}) + "\n")
            _write_predictions(predictions, dataset, "perfect")
            result = score_predictions(dataset, predictions, bootstrap_rounds=20)
            self.assertEqual(result["evaluation"]["independent_bootstrap_clusters"], 1)
            self.assertEqual(result["by_label"]["HEALTH_CONDITION"]["independent_clusters"], 1)
            family = result["by_family"]["sensitive_health"]
            self.assertEqual(family["confidence_interval"]["low_95"], 1)
            self.assertLess(family["full_cluster_protection_interval"]["low_95"], .5)
            self.assertLess(result["cluster_guardrails"]["full_protection"]["low_95"], .5)
            self.assertNotIn("clean_negative_document_rate", result["confidence_intervals"])
            calibration = calibrate_threshold(dataset, predictions, thresholds=[0], calibration_partition="all")
            self.assertFalse(calibration["feasible"])

    def test_paired_bootstrap_uses_same_documents_for_both_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset, before, after = root / "data.jsonl", root / "before.jsonl", root / "after.jsonl"
            write_dataset(dataset, 100, 99)
            _write_predictions(before, dataset, "empty")
            _write_predictions(after, dataset, "perfect")
            result = compare_predictions(dataset, before, after, rounds=20)
            self.assertEqual(result["paired_differences"]["weighted_recall"],
                             {"difference": 1.0, "low_95": 1.0, "high_95": 1.0})

    def test_duplicate_texts_cannot_cross_content_grouped_partitions(self):
        first = evaluation_partition("first", "A private NOTE\nwith spaces")
        second = evaluation_partition("different-id", "a PRIVATE note with  spaces")
        self.assertEqual(first, second)

    def test_perfect_predictions_score_one_without_overredaction(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "dataset.jsonl"
            predictions = Path(directory) / "predictions.jsonl"
            write_dataset(dataset, 250, 22)
            _write_predictions(predictions, dataset, "perfect")
            result = score_predictions(dataset, predictions, bootstrap_rounds=20)
            self.assertEqual(result["safety"]["weighted_recall"], 1)
            self.assertEqual(result["safety"]["document_full_protection_rate"], 1)
            self.assertEqual(result["utility"]["over_redaction_rate"], 0)
            self.assertEqual(result["entities"]["typed_exact"]["f1"], 1)

    def test_empty_predictions_are_measured_as_leaks(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "dataset.jsonl"
            predictions = Path(directory) / "predictions.jsonl"
            write_dataset(dataset, 250, 23)
            _write_predictions(predictions, dataset, "empty")
            result = score_predictions(dataset, predictions, bootstrap_rounds=0)
            self.assertEqual(result["safety"]["weighted_recall"], 0)
            self.assertEqual(result["safety"]["document_full_protection_rate"], 0)

    def test_partition_is_stable_and_partitions_are_disjoint(self):
        record_ids = [f"synthetic-{index:08d}" for index in range(200)]
        calibration = {item for item in record_ids if evaluation_partition(item, item) == "calibration"}
        test = {item for item in record_ids if evaluation_partition(item, item) == "test"}
        self.assertEqual(calibration | test, set(record_ids))
        self.assertFalse(calibration & test)
        self.assertGreater(len(calibration), 20)
        self.assertGreater(len(test), 120)

    def test_score_filters_partition_and_confidence(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "dataset.jsonl"
            predictions = Path(directory) / "predictions.jsonl"
            write_dataset(dataset, 250, 24)
            _write_predictions(predictions, dataset, "perfect")
            records = list(iter_jsonl(dataset))
            with predictions.open("w", encoding="utf-8") as output:
                output.write(json.dumps({"_meta": {"candidate_id": "scored", "artifact_mb": 1}}) + "\n")
                for record in records:
                    spans = [{**span, "score": 0.4} for span in record["entities"]]
                    output.write(json.dumps({"id": record["id"], "spans": spans, "latency_ms": 1}) + "\n")
                output.write(json.dumps({"_summary": {"prediction_elapsed_ms": 250}}) + "\n")
            result = score_predictions(
                dataset, predictions, bootstrap_rounds=0, partition="test", minimum_score=0.5
            )
            self.assertEqual(result["evaluation"]["partition"], "test")
            self.assertEqual(result["evaluation"]["records"], sum(evaluation_partition(item["id"], item["text"]) == "test" for item in records))
            self.assertEqual(result["safety"]["weighted_recall"], 0)

    def test_calibration_obeys_overredaction_constraint(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "dataset.jsonl"
            predictions = Path(directory) / "predictions.jsonl"
            write_dataset(dataset, 250, 25)
            with predictions.open("w", encoding="utf-8") as output:
                output.write(json.dumps({"_meta": {"candidate_id": "threshold-test"}}) + "\n")
                for record in iter_jsonl(dataset):
                    spans = [{**span, "score": 0.9} for span in record["entities"]]
                    if record["text"]:
                        spans.append({"start": 0, "end": 1, "label": "OTHER_PII", "score": 0.2})
                    output.write(json.dumps({"id": record["id"], "spans": spans, "latency_ms": 1}) + "\n")
                output.write(json.dumps({"_summary": {"prediction_elapsed_ms": 250}}) + "\n")
            result = calibrate_threshold(
                dataset, predictions, thresholds=[0.0, 0.5, 0.95], max_over_redaction=0.0
            )
            self.assertEqual(result["selected"]["threshold"], 0.5)
            self.assertEqual(result["selected"]["weighted_recall"], 1)

    def test_ensemble_calibration_searches_each_member_grid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "dataset.jsonl"
            first = root / "first.jsonl"
            second = root / "second.jsonl"
            write_dataset(dataset, 100, 26)
            _write_predictions(first, dataset, "perfect", "first")
            _write_predictions(second, dataset, "perfect", "second")
            result = calibrate_ensemble(
                dataset,
                [first, second],
                threshold_grids=[[0.5, 1.0], [0.5, 1.0]],
            )
            self.assertEqual(result["combinations_evaluated"], 4)
            self.assertEqual(result["selected"]["weighted_recall"], 1)

    def test_pareto_frontier_rejects_strictly_worse_run(self):
        def result(candidate_id, recall, over, latency, size):
            return {
                "run": {"candidate_id": candidate_id, "artifact_mb": size, "peak_rss_mb": size},
                "safety": {"weighted_recall": recall, "document_full_protection_rate": recall},
                "utility": {"over_redaction_rate": over},
                "performance": {"latency_ms_p95": latency},
            }

        frontier = pareto_frontier([result("better", 0.99, 0.01, 5, 10), result("worse", 0.9, 0.02, 10, 20)])
        self.assertEqual(frontier, ["better"])


if __name__ == "__main__":
    unittest.main()
