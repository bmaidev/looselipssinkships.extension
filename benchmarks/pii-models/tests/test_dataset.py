from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.dataset import generate_records, validate_dataset, validate_record, write_dataset
from pii_bench.taxonomy import LABELS


class DatasetTests(unittest.TestCase):
    def test_generation_is_byte_reproducible_and_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.jsonl"
            second = Path(directory) / "second.jsonl"
            first_manifest = write_dataset(first, 250, 20261017)
            second_manifest = write_dataset(second, 250, 20261017)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first_manifest["sha256"], second_manifest["sha256"])
            self.assertEqual(set(first_manifest["labels"]), set(LABELS))

    def test_entity_offsets_recover_nonempty_exact_text(self):
        for record in generate_records(250, 42):
            validate_record(record)
            for entity in record["entities"]:
                self.assertTrue(record["text"][entity["start"] : entity["end"]])

    def test_validation_rejects_overlapping_gold(self):
        record = next(generate_records(250, 7))
        record["entities"].append({**record["entities"][0], "start": record["entities"][0]["start"] + 1})
        with self.assertRaisesRegex(ValueError, "overlapping"):
            validate_record(record)

    def test_validation_enforces_expected_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            manifest = write_dataset(path, 250, 9)
            self.assertEqual(validate_dataset(path, manifest["sha256"])["records"], 250)
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                validate_dataset(path, "0" * 64)


if __name__ == "__main__":
    unittest.main()
