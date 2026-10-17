"""Safetensors-only fine-tuning control: 4.4M-parameter pretrained BERT.

The document-disjoint curriculum and calibration files are shared with the byte
head. Test inputs never participate in training or checkpoint selection.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import shutil
import time

from .dataset import iter_jsonl, validate_record
from .specialist import TAGS, predict_file


REPOSITORY = "google/bert_uncased_L-2_H-128_A-2"
REVISION = "30b0a37ccaaa32f332884b96992754e246e48c5f"


def training_tags(label_scheme: str) -> tuple[str, ...]:
    if label_scheme == "typed":
        return tuple(TAGS)
    if label_scheme == "agnostic":
        return ("O", "B-OTHER_PII", "I-OTHER_PII")
    raise ValueError("Label scheme must be typed or agnostic")


def train(data_dir: Path, output_dir: Path, epochs: int = 4, label_scheme: str = "typed"):
    tags = training_tags(label_scheme)
    if epochs < 1:
        raise ValueError("Training requires at least one epoch")
    if output_dir.exists() and (not output_dir.is_dir() or any(output_dir.iterdir())):
        raise FileExistsError("Refusing to overwrite a trained candidate; choose a fresh output directory")
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    torch.set_num_threads(2)
    torch.manual_seed(20261018)
    rng = random.Random(20261018)
    tokenizer = AutoTokenizer.from_pretrained(REPOSITORY, revision=REVISION)
    manifest = json.loads((data_dir / "manifest.json").read_text())
    examples = {}
    source_ids = {}
    normalized_texts = {}
    for split in ("train", "calibration"):
        path = data_dir / f"{split}.jsonl"
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["files"][split]["sha256"]:
            raise ValueError(f"{split} checksum mismatch")
        examples[split] = []
        source_ids[split] = set()
        normalized_texts[split] = set()
        for record in iter_jsonl(path):
            validate_record(record)
            metadata = record["metadata"]
            if metadata.get("split") != split or metadata.get("source_split") == "test":
                raise ValueError("Refusing test data in training/calibration")
            source_ids[split].add(metadata.get("source_uid", record["id"]))
            normalized_texts[split].add(" ".join(record["text"].casefold().split()))
            encoded = tokenizer(record["text"], truncation=True, max_length=256,
                                stride=64, return_overflowing_tokens=True, return_offsets_mapping=True)
            for index, offsets in enumerate(encoded["offset_mapping"]):
                labels = [0] * len(offsets)
                for position, (start, end) in enumerate(offsets):
                    if start == end:
                        labels[position] = -100
                        continue
                    for entity in record["entities"]:
                        if start < entity["end"] and end > entity["start"]:
                            prefix = "B" if start <= entity["start"] else "I"
                            label = entity["label"] if label_scheme == "typed" else "OTHER_PII"
                            labels[position] = tags.index(f"{prefix}-{label}")
                            break
                examples[split].append({"input_ids": encoded["input_ids"][index],
                                         "attention_mask": encoded["attention_mask"][index],
                                         "labels": labels})
    if source_ids["train"] & source_ids["calibration"]:
        raise ValueError("Source documents cross training/calibration")
    if normalized_texts["train"] & normalized_texts["calibration"]:
        raise ValueError("Normalized texts cross training/calibration")
    model = AutoModelForTokenClassification.from_pretrained(
        REPOSITORY, revision=REVISION, use_safetensors=True, trust_remote_code=False,
        num_labels=len(tags), id2label=dict(enumerate(tags)), label2id={label: index for index, label in enumerate(tags)},
        attn_implementation="eager",
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0003, weight_decay=0.01)
    counts = torch.bincount(torch.tensor([label for item in examples["train"] for label in item["labels"] if label >= 0]), minlength=len(tags)).float()
    weights = (counts.sum() / counts.clamp_min(1)).sqrt()
    weights = (weights / weights.mean()).clamp(0.25, 4)
    criterion = torch.nn.CrossEntropyLoss(weight=weights, ignore_index=-100)

    def collate(items):
        maximum = max(len(item["input_ids"]) for item in items)
        ids = torch.zeros((len(items), maximum), dtype=torch.long)
        mask = torch.zeros_like(ids)
        targets = torch.full_like(ids, -100)
        for row, item in enumerate(items):
            size = len(item["input_ids"])
            ids[row, :size] = torch.tensor(item["input_ids"])
            mask[row, :size] = torch.tensor(item["attention_mask"])
            targets[row, :size] = torch.tensor(item["labels"])
        return ids, mask, targets

    best = float("inf")
    history = []
    started = time.perf_counter()
    selected_epoch = None
    for epoch in range(epochs):
        model.train()
        order = list(range(len(examples["train"])))
        rng.shuffle(order)
        total = 0.0
        for offset in range(0, len(order), 64):
            items = [examples["train"][index] for index in order[offset:offset + 64]]
            ids, mask, targets = collate(items)
            optimizer.zero_grad(set_to_none=True)
            logits = model(input_ids=ids, attention_mask=mask).logits
            loss = criterion(logits.reshape(-1, len(tags)), targets.reshape(-1))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
            total += float(loss.detach()) * len(items)
        model.eval()
        validation = 0.0
        with torch.inference_mode():
            for offset in range(0, len(examples["calibration"]), 64):
                items = examples["calibration"][offset:offset + 64]
                ids, mask, targets = collate(items)
                logits = model(input_ids=ids, attention_mask=mask).logits
                validation += float(criterion(logits.reshape(-1, len(tags)), targets.reshape(-1))) * len(items)
        validation /= len(examples["calibration"])
        history.append({"epoch": epoch + 1, "train_loss": total / len(order), "calibration_loss": validation})
        print(json.dumps(history[-1]), flush=True)
        if validation < best:
            best = validation
            selected_epoch = epoch + 1
            model.save_pretrained(output_dir, safe_serialization=True)
            tokenizer.save_pretrained(output_dir)
    metadata = {"architecture": "bert-tiny-psi-v1" if label_scheme == "typed" else "bert-tiny-psi-agnostic-v1",
                "label_scheme": label_scheme, "repository": REPOSITORY, "revision": REVISION,
                "parameters": sum(parameter.numel() for parameter in model.parameters()), "tags": tags,
                "selected_epoch": selected_epoch, "history": history, "training_manifest": manifest,
                "training_parameters": {"seed": 20261018, "cpu_threads": 2, "epochs_requested": epochs,
                                        "batch_size": 64, "optimizer": "AdamW", "learning_rate": .0003,
                                        "weight_decay": .01, "gradient_clip_norm": 1,
                                        "class_weights": "inverse-sqrt token frequency, mean-normalized, clipped [0.25,4]",
                                        "maximum_tokens": 256, "overflow_stride": 64,
                                        "checkpoint_selection": "minimum calibration token loss"},
                "trainer_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "torch_version": torch.__version__,
                "training_seconds": time.perf_counter() - started, "release_eligible": False,
                "weights_sha256": hashlib.sha256((output_dir / "model.safetensors").read_bytes()).hexdigest()}
    (output_dir / "training.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    shutil.copyfile(__file__, output_dir / "trainer_source.py")
    return metadata


def export(model_dir: Path):
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from transformers import AutoModelForTokenClassification

    torch.set_num_threads(2)
    ort.disable_telemetry_events()
    model = AutoModelForTokenClassification.from_pretrained(model_dir, use_safetensors=True, attn_implementation="eager").eval()

    class Wrapper(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.model = model

        def forward(self, input_ids, attention_mask):
            return self.model(input_ids=input_ids, attention_mask=attention_mask).logits

    wrapper = Wrapper().eval()
    inputs = torch.ones((1, 16), dtype=torch.long)
    path = model_dir / "model.onnx"
    torch.onnx.export(wrapper, (inputs, inputs), str(path), input_names=["input_ids", "attention_mask"],
                      output_names=["logits"], dynamic_axes={name: {0: "batch", 1: "tokens"}
                      for name in ("input_ids", "attention_mask", "logits")}, opset_version=17, dynamo=False)
    onnx.checker.check_model(str(path))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    max_error = 0.0
    for length in (1, 16, 128, 256):
        ids = torch.arange(length).unsqueeze(0) + 100
        mask = torch.ones_like(ids)
        with torch.inference_mode():
            expected = wrapper(ids, mask).numpy()
        actual = session.run(None, {"input_ids": ids.numpy(), "attention_mask": mask.numpy()})[0]
        np.testing.assert_allclose(actual, expected, atol=1e-4, rtol=1e-4)
        max_error = max(max_error, float(abs(actual - expected).max()))
    result = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size,
              "max_logit_error": max_error, "verified_token_lengths": [1, 16, 128, 256],
              "release_eligible": False}
    (model_dir / "onnx-verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def quantize(model_dir: Path, output_dir: Path):
    """Create a separate INT8 research artifact; validate accuracy on calibration."""
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    shutil.copytree(model_dir, output_dir)
    quantize_dynamic(str(model_dir / "model.onnx"), str(output_dir / "model.onnx"),
                     weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gather"],
                     per_channel=False)
    path = output_dir / "model.onnx"
    onnx.checker.check_model(str(path))
    metadata = json.loads((output_dir / "training.json").read_text())
    metadata["artifact_variant"] = "int8"
    (output_dir / "training.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    result = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size,
              "quantization": "dynamic INT8 MatMul/Gather",
              "accuracy_status": "requires separate calibration and held-out evaluation",
              "release_eligible": False}
    (output_dir / "onnx-verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def prepare_wasm(model_dir: Path, dataset: Path, output: Path):
    """Prepare the same tokenizer windows for an isolated WASM-backend check."""
    from tokenizers import Tokenizer
    from .adapters import _chunks

    tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=256, stride=64)
    metadata = {"dataset_sha256": hashlib.sha256(dataset.read_bytes()).hexdigest(),
                "tokenizer_sha256": hashlib.sha256((model_dir / "tokenizer.json").read_bytes()).hexdigest(),
                "frame_generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "tokenizer": "pinned Python/Rust tokenizer; JavaScript tokenizer parity remains separate"}
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps({"_meta": metadata}) + "\n")
        for record in iter_jsonl(dataset):
            windows = []
            for offset, chunk in _chunks(record["text"]):
                first = tokenizer.encode(chunk)
                for encoded in [first, *first.overflowing]:
                    windows.append({"input_ids": encoded.ids, "attention_mask": encoded.attention_mask,
                                    "offsets": [[start + offset, end + offset] if start != end else [0, 0]
                                                for start, end in encoded.offsets]})
            handle.write(json.dumps({"id": record["id"], "windows": windows}, separators=(",", ":")) + "\n")
            count += 1
    return {**metadata, "records": count}


class TinyPredictor:
    def __init__(self, model_dir: Path):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        from .adapters import OnnxTokenAdapter

        self.config = json.loads((model_dir / "training.json").read_text())
        ort.disable_telemetry_events()
        verification = json.loads((model_dir / "onnx-verification.json").read_text())
        path = model_dir / "model.onnx"
        if hashlib.sha256(path.read_bytes()).hexdigest() != verification["sha256"]:
            raise ValueError("Fine-tuned ONNX checksum mismatch")
        self.adapter = OnnxTokenAdapter.__new__(OnnxTokenAdapter)
        self.adapter.np = np
        self.adapter.raw_tokenizer = True
        self.adapter.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.adapter.tokenizer.enable_truncation(max_length=256, stride=64)
        tags = self.config.get("tags")
        if tuple(tags or ()) not in (training_tags("typed"), training_tags("agnostic")):
            raise ValueError("Unrecognised PSI head tag map")
        self.adapter.id2label = dict(enumerate(tags))
        self.adapter.label_map = {}
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        self.adapter.session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        self.adapter.input_names = {item.name for item in self.adapter.session.get_inputs()}

    def predict(self, text, record_id=""):
        return self.adapter.predict(text, record_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    training = commands.add_parser("train")
    training.add_argument("--data-dir", type=Path, required=True)
    training.add_argument("--output-dir", type=Path, required=True)
    training.add_argument("--epochs", type=int, default=4)
    training.add_argument("--label-scheme", choices=("typed", "agnostic"), default="typed")
    exporting = commands.add_parser("export")
    exporting.add_argument("--model-dir", type=Path, required=True)
    quantization = commands.add_parser("quantize")
    quantization.add_argument("--model-dir", type=Path, required=True)
    quantization.add_argument("--output-dir", type=Path, required=True)
    wasm = commands.add_parser("wasm-prepare")
    wasm.add_argument("--model-dir", type=Path, required=True)
    wasm.add_argument("--dataset", type=Path, required=True)
    wasm.add_argument("--output", type=Path, required=True)
    prediction = commands.add_parser("predict")
    prediction.add_argument("--model-dir", type=Path, required=True)
    prediction.add_argument("--dataset", type=Path, required=True)
    prediction.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "train":
        result = train(args.data_dir, args.output_dir, args.epochs, args.label_scheme)
    elif args.command == "export":
        result = export(args.model_dir)
    elif args.command == "quantize":
        result = quantize(args.model_dir, args.output_dir)
    elif args.command == "wasm-prepare":
        result = prepare_wasm(args.model_dir, args.dataset, args.output)
    else:
        result = predict_file(args.model_dir, args.dataset, args.output, "onnx", predictor_factory=TinyPredictor)
    print(json.dumps(result, indent=2))
