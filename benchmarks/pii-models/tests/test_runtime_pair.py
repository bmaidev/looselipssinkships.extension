import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.runtime_pair import compare_spans


class RuntimePairTests(unittest.TestCase):
    def test_confidence_drift_is_not_reported_as_exact_parity(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = (Path(directory) / name for name in ("a.jsonl", "b.jsonl"))
            def write(path, score):
                rows = [{"_meta": {}}, {"id": "one", "spans": [
                    {"start": 0, "end": 4, "label": "PERSON", "score": score}]}, {"_summary": {}}]
                path.write_text("\n".join(json.dumps(row) for row in rows))
            write(a, .71)
            write(b, .69)
            result = compare_spans(a, b)
            self.assertTrue(result["same_span_boundaries_and_labels_all_records"])
            self.assertEqual(result["exact_span_and_score_match_records"], 0)
            self.assertEqual(result["differing_records_at_thresholds"]["0.7"], 1)
            self.assertEqual(result["differing_records_at_thresholds"]["0.5"], 0)
            b.write_text(json.dumps({"id": "other", "spans": []}))
            with self.assertRaisesRegex(ValueError, "ID sets"):
                compare_spans(a, b)
            b.write_text('\n'.join([json.dumps({"id": "one", "spans": []})] * 2))
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                compare_spans(a, b)
