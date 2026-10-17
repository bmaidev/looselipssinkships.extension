from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.dataset import iter_jsonl, validate_record
from pii_bench.specialist import encode_record, tokens
from pii_bench.specialist_data import PHRASES, TEMPLATES, curriculum_records, write_curriculum
from pii_bench.specialist_baseline import run as run_literal


class SpecialistDataTests(unittest.TestCase):
    def test_literal_control_retains_offsets_for_unicode_case_matching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            training = {"id": "train", "text": "Islam", "entities": [
                {"start": 0, "end": 5, "label": "RELIGION"}], "metadata": {"split": "train"}}
            target = {"id": "test", "text": "Private: İslam"}
            (root / "train.jsonl").write_text(json.dumps(training) + "\n", encoding="utf-8")
            (root / "test.jsonl").write_text(json.dumps(target) + "\n", encoding="utf-8")
            run_literal(root / "train.jsonl", root / "test.jsonl", root / "predictions.jsonl")
            prediction = next(item for item in iter_jsonl(root / "predictions.jsonl") if "id" in item)
            self.assertEqual(prediction["spans"][0]["label"], "RELIGION")
            self.assertEqual(target["text"][prediction["spans"][0]["start"]:prediction["spans"][0]["end"]], "İslam")

    def test_phrases_and_templates_do_not_cross_splits(self):
        for phrases in PHRASES.values():
            train, calibration, test = map(set, (phrases[:8], phrases[8:10], phrases[10:]))
            self.assertFalse(train & calibration or train & test or calibration & test)
            self.assertEqual(len(phrases), 12)
        partitions = [{template for kind in value.values() for template in kind} for value in TEMPLATES.values()]
        self.assertFalse(partitions[0] & partitions[1] or partitions[0] & partitions[2] or partitions[1] & partitions[2])

    def test_generated_offsets_and_documents_are_valid_and_unique(self):
        by_split = {}
        for split in TEMPLATES:
            records = list(curriculum_records(split, 1200))
            for record in records:
                validate_record(record)
            texts = {record["text"] for record in records}
            self.assertEqual(len(texts), len(records))
            by_split[split] = texts
        self.assertFalse(by_split["train"] & by_split["calibration"])
        self.assertFalse(by_split["train"] & by_split["test"])

    def test_curriculum_manifest_matches_actual_bytes_and_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = write_curriculum(root, 400)
            for split, entry in manifest["files"].items():
                path = root / f"{split}.jsonl"
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
                self.assertEqual(sum(1 for _ in iter_jsonl(path)), entry["records"])
            self.assertEqual(json.loads((root / "manifest.json").read_text()), manifest)

    def test_unicode_token_offsets_and_bio_targets(self):
        text = "王小明 disclosed hearing loss."
        start = text.index("hearing")
        encoded, labels, pieces = encode_record({"text": text, "entities": [
            {"start": start, "end": start + len("hearing loss"), "label": "DISABILITY"}]})
        self.assertEqual(len(encoded), len(pieces))
        self.assertEqual(sum(label > 0 for label in labels), 2)
        for value, begin, end in tokens(text):
            self.assertEqual(text[begin:end], value)
        self.assertNotIn(0, encoded[0])


if __name__ == "__main__":
    unittest.main()
