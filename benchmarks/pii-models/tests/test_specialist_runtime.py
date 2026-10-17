"""Optional runtime checks; the zero-dependency CI core skips these."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


HAS_RUNTIME = all(importlib.util.find_spec(name) for name in ("torch", "safetensors", "onnx", "onnxruntime"))
HAS_PARQUET = importlib.util.find_spec("pyarrow") is not None


@unittest.skipUnless(HAS_RUNTIME, "Install the specialist optional dependencies")
class SpecialistRuntimeTests(unittest.TestCase):
    def test_onnx_adapter_visits_token_overflow_windows(self):
        import numpy as np
        from pii_bench.adapters import OnnxTokenAdapter

        class Tokenizer:
            def __call__(self, text, **kwargs):
                if not kwargs.get("return_overflowing_tokens"):
                    raise AssertionError("Overflow windows must be requested")
                return {
                    "input_ids": np.array([[0, 1, 0], [0, 2, 0]]),
                    "attention_mask": np.ones((2, 3), dtype=np.int64),
                    "offset_mapping": np.array([[[0, 0], [5, 10], [0, 0]], [[0, 0], [300, 305], [0, 0]]]),
                }

        class Session:
            def run(self, output_names, feed):
                logits = np.zeros((1, 3, 2))
                logits[0, :, 0] = 1
                logits[0, 1, 1] = 10
                return [logits]

        adapter = OnnxTokenAdapter.__new__(OnnxTokenAdapter)
        adapter.np = np
        adapter.raw_tokenizer = False
        adapter.tokenizer = Tokenizer()
        adapter.session = Session()
        adapter.input_names = {"input_ids", "attention_mask"}
        adapter.id2label = {0: "O", 1: "B-HEALTH_CONDITION"}
        adapter.label_map = {}
        spans = adapter.predict("x" * 400, "overflow")
        self.assertEqual([(item["start"], item["end"]) for item in spans], [(5, 10), (300, 305)])

    def test_padding_does_not_change_real_token_logits(self):
        import torch
        from pii_bench.specialist import TAGS, build_model

        torch.set_num_threads(1)
        config = {"byte_dimension": 8, "token_dimension": 8, "hidden_dimension": 12,
                  "tags": TAGS, "mask_padding": True}
        model = build_model(config).eval()
        ids = torch.randint(1, 257, (1, 5, 40))
        padded = torch.cat([ids, torch.zeros((1, 7, 40), dtype=torch.long)], dim=1)
        with torch.inference_mode():
            torch.testing.assert_close(model(ids), model(padded)[:, :5], rtol=1e-5, atol=1e-6)

    def test_safe_export_inference_and_checksum_rejection(self):
        import hashlib
        import torch
        from safetensors.torch import save_file
        from pii_bench.specialist import TAGS, SpecialistOnnxPredictor, SpecialistPredictor, build_model, export_onnx

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = {"byte_dimension": 8, "token_dimension": 8, "hidden_dimension": 12,
                      "tags": TAGS, "mask_padding": True}
            torch.manual_seed(7)
            model = build_model(config).eval()
            save_file(model.state_dict(), str(root / "model.safetensors"))
            config["weights_sha256"] = hashlib.sha256((root / "model.safetensors").read_bytes()).hexdigest()
            (root / "config.json").write_text(json.dumps(config), encoding="utf-8")
            verification = export_onnx(root)
            self.assertLess(verification["max_logit_error"], 1e-4)
            text = "Private note for 王小明: a sensitive condition. " * 30
            expected = SpecialistPredictor(root).predict(text)
            actual = SpecialistOnnxPredictor(root).predict(text)
            self.assertEqual([(item["start"], item["end"], item["label"]) for item in expected],
                             [(item["start"], item["end"], item["label"]) for item in actual])
            (root / "model.onnx").write_bytes(b"corrupt model")
            with self.assertRaisesRegex(ValueError, "checksum"):
                SpecialistOnnxPredictor(root)


@unittest.skipUnless(HAS_PARQUET, "Install PyArrow for external-corpus integrity checks")
class ExternalDataTests(unittest.TestCase):
    def test_shared_source_ids_and_invalid_offsets_are_excluded(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        from pii_bench.dataset import iter_jsonl
        from pii_bench.specialist_data import write_curriculum
        from pii_bench.specialist_external import prepare

        def record(uid, prefix="Client", bad=False):
            text = f"{prefix} identifies as Catholic."
            start = text.index("Catholic")
            return {"uid": uid, "text": text, "domain": "Healthcare",
                    "spans": repr([{"start": start, "end": start + (3 if bad else 8),
                                    "text": "Catholic", "label": "religious_belief"}])}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_curriculum(root / "authored", 60)
            train = [record("same-source"), record("same-source", "A person"), record("bad", "Invalid source", bad=True)]
            test = [record("same-source", "A different rendition"), record("independent", "Independent example")]
            pq.write_table(pa.Table.from_pylist(train), root / "train.parquet")
            pq.write_table(pa.Table.from_pylist(test), root / "test.parquet")
            manifest = prepare(root / "train.parquet", root / "test.parquet", root / "authored", root / "out")
            self.assertEqual(manifest["rejected"]["test_uid_also_present_in_source_training"], 1)
            self.assertEqual(manifest["rejected"]["bad_source_offsets"], 1)
            train_uids = {item["metadata"].get("source_uid") for item in iter_jsonl(root / "out/train.jsonl")} - {None}
            cal_uids = {item["metadata"].get("source_uid") for item in iter_jsonl(root / "out/calibration.jsonl")} - {None}
            self.assertFalse(train_uids & cal_uids)
            self.assertEqual([item["metadata"]["source_uid"] for item in iter_jsonl(root / "out/test.jsonl")], ["independent"])


if __name__ == "__main__":
    unittest.main()
