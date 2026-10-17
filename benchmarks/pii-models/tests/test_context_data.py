from collections import defaultdict
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.context_data import GRAMMARS, HELD_VALUES, NAMES, records, write
from pii_bench.dataset import iter_jsonl, validate_record
from pii_bench.specialist_data import PHRASES
from pii_bench.tiny_finetune import train, training_tags


class ContextDataTests(unittest.TestCase):
    def test_training_refuses_overwriting_or_invalid_epochs_before_loading_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "existing-evidence.json").write_text("{}")
            with self.assertRaises(FileExistsError):
                train(root, root)
            with self.assertRaises(ValueError):
                train(root, root / "fresh", epochs=0)
            self.assertFalse((root / "fresh").exists())

    def test_agnostic_head_preserves_bio_without_claiming_a_sensitive_category(self):
        self.assertEqual(training_tags("agnostic"), ("O", "B-OTHER_PII", "I-OTHER_PII"))
        self.assertEqual(len(training_tags("typed")), 31)
        with self.assertRaises(ValueError):
            training_tags("unknown")

    def test_banks_are_disjoint_and_cover_all_psi_classes(self):
        self.assertEqual(set(HELD_VALUES), set(PHRASES))
        for label, held in HELD_VALUES.items():
            self.assertEqual(len(set(held)), 4)
            self.assertFalse(set(held) & set(PHRASES[label][:8]))
        banks = [set(sum(GRAMMARS[split].values(), [])) for split in GRAMMARS]
        for left in range(3):
            for right in range(left):
                self.assertFalse(banks[left] & banks[right])
        self.assertFalse(set(NAMES["train"]) & set(NAMES["test"]))

    def test_counterfactual_pairs_have_identical_vocabulary_but_different_gold(self):
        partitions = {}
        for split in GRAMMARS:
            rows = list(records(split, 150))
            self.assertEqual(rows, list(records(split, 150)))
            self.assertEqual(len(rows), 300)
            groups = defaultdict(list)
            for item in rows:
                validate_record(item)
                self.assertNotIn("⟦TARGET⟧", item["text"])
                groups[item["metadata"]["source_uid"]].append(item)
            for positive, negative in groups.values():
                value = positive["metadata"]["attribute_value"]
                self.assertIn(value, positive["text"])
                self.assertIn(value, negative["text"])
                self.assertEqual(len(positive["entities"]), 1)
                self.assertEqual(negative["entities"], [])
                entity = positive["entities"][0]
                self.assertEqual(positive["text"][entity["start"]:entity["end"]], value)
                if "mixed_context" in positive["slices"]:
                    self.assertEqual(positive["text"].count(value), 2)
            partitions[split] = {" ".join(row["text"].casefold().split()) for row in rows}
        self.assertFalse(partitions["train"] & partitions["calibration"])
        self.assertFalse(partitions["train"] & partitions["test"])

    def test_manifests_match_generated_bytes_and_balance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = write(root, train_pairs=150, evaluation_pairs=90)
            for split, entry in manifest["files"].items():
                rows = list(iter_jsonl(root / f"{split}.jsonl"))
                self.assertEqual(entry["sha256"], hashlib.sha256((root / f"{split}.jsonl").read_bytes()).hexdigest())
                self.assertEqual(len(rows), entry["records"])
                self.assertEqual(entry["negative_documents"], len(rows) // 2)
                self.assertEqual(set(entry["labels"]), set(PHRASES))
            self.assertEqual(manifest, json.loads((root / "manifest.json").read_text()))
            with self.assertRaises(FileExistsError):
                write(root, train_pairs=150, evaluation_pairs=90)

    def test_external_parent_never_needs_its_test_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / "parent"
            parent.mkdir()
            manifest = {"files": {}}
            # Different seed/source text avoids duplicate rows with the new authored bank.
            for split in ("train", "calibration"):
                item = next(records(split, 1, seed=999))
                item["text"] = "External prefix. " + item["text"]
                for entity in item["entities"]:
                    entity["start"] += len("External prefix. ")
                    entity["end"] += len("External prefix. ")
                item["metadata"].update(source="nvidia/Nemotron-PII", source_split="train")
                data = (json.dumps(item) + "\n").encode()
                (parent / f"{split}.jsonl").write_bytes(data)
                manifest["files"][split] = {"sha256": hashlib.sha256(data).hexdigest()}
            (parent / "manifest.json").write_text(json.dumps(manifest))
            result = write(root / "mixed", 15, 15, parent)
            self.assertEqual(result["files"]["train"]["external_records"], 1)
            self.assertEqual(result["files"]["test"]["external_records"], 0)

    def test_invalid_requests_fail_loudly(self):
        for split, pairs in (("test", 0), ("not-a-split", 100)):
            with self.assertRaises(ValueError):
                list(records(split, pairs))
