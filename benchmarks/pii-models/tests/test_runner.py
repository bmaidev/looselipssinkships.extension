from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.dataset import iter_jsonl, write_dataset
from pii_bench.runner import combine_predictions, load_predictions


def _predictions(path: Path, dataset: Path, candidate: str, score: float) -> None:
    with path.open("w", encoding="utf-8") as output:
        output.write(json.dumps({"_meta": {"candidate_id": candidate, "dataset_sha256": "same"}}) + "\n")
        for record in iter_jsonl(dataset):
            spans = [{**span, "score": score} for span in record["entities"]]
            output.write(json.dumps({"id": record["id"], "spans": spans, "latency_ms": 1}) + "\n")
        output.write(json.dumps({"_summary": {"prediction_elapsed_ms": 1}}) + "\n")


class EnsembleTests(unittest.TestCase):
    def test_member_thresholds_are_applied_before_union(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / "dataset.jsonl"
            low = root / "low.jsonl"
            high = root / "high.jsonl"
            ensemble = root / "ensemble.jsonl"
            write_dataset(dataset, 40, 42)
            _predictions(low, dataset, "low", 0.2)
            _predictions(high, dataset, "high", 0.9)
            result = combine_predictions([low, high], ensemble, minimum_scores=[0.5, 0.5])
            self.assertEqual(result["member_minimum_scores"], {"low": 0.5, "high": 0.5})
            _, records, _ = load_predictions(ensemble)
            expected = {record["id"]: len(record["entities"]) for record in iter_jsonl(dataset)}
            self.assertEqual({record_id: len(item["spans"]) for record_id, item in records.items()}, expected)

    def test_member_threshold_count_must_match_inputs(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            combine_predictions([Path("a"), Path("b")], Path("out"), minimum_scores=[0.5])


if __name__ == "__main__":
    unittest.main()
