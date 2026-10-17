"""Offline tiny-encoder export/head-map checks using random synthetic weights."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


HAS_TINY = all(importlib.util.find_spec(name) for name in (
    "torch", "transformers", "tokenizers", "safetensors", "onnx", "onnxruntime"))


@unittest.skipUnless(HAS_TINY, "Install the specialist optional dependencies")
class TinyRuntimeTests(unittest.TestCase):
    def test_agnostic_head_exports_and_loads_its_own_tag_map_offline(self):
        import torch
        from tokenizers import Tokenizer
        from tokenizers.models import WordPiece
        from tokenizers.pre_tokenizers import Whitespace
        from transformers import BertConfig, BertForTokenClassification
        from pii_bench.specialist import predict_file
        from pii_bench.tiny_finetune import TinyPredictor, export, training_tags

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tags = training_tags("agnostic")
            torch.manual_seed(7)
            config = BertConfig(vocab_size=400, hidden_size=16, num_hidden_layers=1,
                                num_attention_heads=2, intermediate_size=32,
                                num_labels=3, id2label=dict(enumerate(tags)),
                                label2id={label: index for index, label in enumerate(tags)})
            config._attn_implementation = "eager"
            BertForTokenClassification(config).save_pretrained(root, safe_serialization=True)
            vocabulary = {"[UNK]": 0, "[PAD]": 1, "private": 2, "asthma": 3}
            tokenizer = Tokenizer(WordPiece(vocabulary, unk_token="[UNK]"))
            tokenizer.pre_tokenizer = Whitespace()
            tokenizer.save(str(root / "tokenizer.json"))
            metadata = {"tags": tags, "weights_sha256": hashlib.sha256((root / "model.safetensors").read_bytes()).hexdigest()}
            (root / "training.json").write_text(json.dumps(metadata))
            verification = export(root)
            self.assertLess(verification["max_logit_error"], 1e-4)
            predictor = TinyPredictor(root)
            self.assertEqual(predictor.adapter.id2label, dict(enumerate(tags)))
            for span in predictor.predict("private asthma"):
                self.assertEqual(span["label"], "OTHER_PII")
            (root / "data.jsonl").write_text(json.dumps({"id": "synthetic", "text": "private asthma"}) + "\n")
            result = predict_file(root, root / "data.jsonl", root / "predictions.jsonl", "onnx", predictor_factory=TinyPredictor)
            self.assertEqual(result["artifact_sha256"], verification["sha256"])
            self.assertEqual(result["license"], "pending-derived-artifact-review")
            metadata["tags"] = ["O", "B-UNREVIEWED_LABEL"]
            (root / "training.json").write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, "tag map"):
                TinyPredictor(root)
