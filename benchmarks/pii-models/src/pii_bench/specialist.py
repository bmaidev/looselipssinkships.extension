"""Small byte-CNN contextual PSI head, trained from scratch as research only.

No pretrained model, remote code, or unsafe checkpoint deserialisation. The
artifact uses safetensors and JSON; training never opens the test split.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import re
import time

from .dataset import iter_jsonl
from .specialist_data import PHRASES, write_curriculum


TOKEN = re.compile(r"\w+(?:['’\-]\w+)*|[^\w\s]", re.UNICODE)
MAX_BYTES = 40
WINDOW_TOKENS = 128
OVERLAP_TOKENS = 24
TAGS = ["O"] + [f"{prefix}-{label}" for label in PHRASES for prefix in ("B", "I")]


def tokens(text: str) -> list[tuple[str, int, int]]:
    return [(match.group(), match.start(), match.end()) for match in TOKEN.finditer(text)]


def encode_record(record: dict) -> tuple[list[list[int]], list[int], list[tuple[str, int, int]]]:
    pieces = tokens(record["text"])
    encoded = [[byte + 1 for byte in value.encode("utf-8")[:MAX_BYTES]] for value, _, _ in pieces]
    labels = [0] * len(pieces)
    for entity in record.get("entities", []):
        if entity["label"] not in PHRASES:
            continue
        first = True
        for index, (_, start, end) in enumerate(pieces):
            if start < entity["end"] and end > entity["start"]:
                prefix = "B" if first else "I"
                labels[index] = TAGS.index(f"{prefix}-{entity['label']}")
                first = False
    return encoded, labels, pieces


def build_model(config: dict):
    import torch
    from torch import nn

    class ContextualPsiHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding = nn.Embedding(257, config["byte_dimension"], padding_idx=0)
            self.byte_conv = nn.Conv1d(config["byte_dimension"], config["token_dimension"], 3, padding=1)
            self.context = nn.Sequential(
                nn.Conv1d(config["token_dimension"], config["hidden_dimension"], 5, padding=2),
                nn.GELU(),
                nn.Dropout(0.1),
                nn.Conv1d(config["hidden_dimension"], config["hidden_dimension"], 5, padding=2),
                nn.GELU(),
            )
            self.output = nn.Linear(config["hidden_dimension"], len(config["tags"]))

        def forward(self, input_ids):
            batch, length, width = input_ids.shape
            mask = input_ids.reshape(batch * length, width).ne(0)
            embedded = self.embedding(input_ids).reshape(batch * length, width, -1).transpose(1, 2)
            features = torch.relu(self.byte_conv(embedded))
            features = features.masked_fill(~mask.unsqueeze(1), -10000.0)
            pooled = features.max(dim=2).values
            valid = mask.any(dim=1, keepdim=True)
            pooled = torch.where(valid, pooled, torch.zeros_like(pooled))
            context = pooled.reshape(batch, length, -1).transpose(1, 2)
            sequence_mask = valid.reshape(batch, 1, length).to(context.dtype)
            for layer in self.context:
                context = layer(context)
                if config.get("mask_padding", False):
                    context = context * sequence_mask
            return self.output(context.transpose(1, 2))

    return ContextualPsiHead()


def collate(examples: list[tuple]):
    import torch

    length = min(WINDOW_TOKENS, max(len(item[0]) for item in examples))
    ids = torch.zeros((len(examples), length, MAX_BYTES), dtype=torch.long)
    targets = torch.full((len(examples), length), -100, dtype=torch.long)
    for row, (encoded, labels, _) in enumerate(examples):
        for column, value in enumerate(encoded[:length]):
            ids[row, column, :len(value)] = torch.tensor(value, dtype=torch.long)
        targets[row, :min(length, len(labels))] = torch.tensor(labels[:length], dtype=torch.long)
    return ids, targets


def train(data_dir: Path, output_dir: Path, epochs: int = 8, seed: int = 20261018,
          initial_model: Path | None = None) -> dict:
    import torch
    from safetensors.torch import save_file

    if epochs < 1:
        raise ValueError("epochs must be positive")
    torch.set_num_threads(2)
    torch.manual_seed(seed)
    random.seed(seed)
    config = {"architecture": "byte-cnn-context-psi-v1", "byte_dimension": 24,
              "token_dimension": 64, "hidden_dimension": 96, "tags": TAGS,
              "max_bytes": MAX_BYTES, "window_tokens": WINDOW_TOKENS,
              "seed": seed, "research_only": True, "mask_padding": True}
    manifest = json.loads((data_dir / "manifest.json").read_text())
    for split in ("train", "calibration"):
        actual_hash = hashlib.sha256((data_dir / f"{split}.jsonl").read_bytes()).hexdigest()
        if actual_hash != manifest["files"][split]["sha256"]:
            raise ValueError(f"{split} file does not match its manifest")
    records = list(iter_jsonl(data_dir / "train.jsonl"))
    # Calibration loss controls checkpoint selection; the test file is never read.
    calibration = list(iter_jsonl(data_dir / "calibration.jsonl"))
    if not records or not calibration:
        raise ValueError("Training and calibration datasets must be nonempty")
    for split, examples_to_check in (("train", records), ("calibration", calibration)):
        for record in examples_to_check:
            provenance = record.get("metadata", {})
            if provenance.get("split") != split or provenance.get("source_split") == "test":
                raise ValueError(f"{record['id']}: training/calibration provenance violates the split boundary")
    ids_train = {record["id"] for record in records}
    if ids_train & {record["id"] for record in calibration}:
        raise ValueError("Training/calibration IDs overlap")
    training_uids = {record.get("metadata", {}).get("source_uid") for record in records} - {None}
    calibration_uids = {record.get("metadata", {}).get("source_uid") for record in calibration} - {None}
    if training_uids & calibration_uids:
        raise ValueError("Training/calibration source document IDs overlap")
    if {record["text"].casefold() for record in records} & {record["text"].casefold() for record in calibration}:
        raise ValueError("Training/calibration texts overlap")
    examples = [encode_record(record) for record in records]
    calibration_examples = [encode_record(record) for record in calibration]
    if any(len(item[0]) > WINDOW_TOKENS for item in examples + calibration_examples):
        raise ValueError("Curriculum exceeds training window; split documents before training")
    model = build_model(config)
    if initial_model:
        parent = SpecialistPredictor(initial_model)
        model.load_state_dict(parent.model.state_dict())
        config["parent_weights_sha256"] = parent.config["weights_sha256"]
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=0.01)
    counts = torch.bincount(torch.tensor([label for _, labels, _ in examples for label in labels]), minlength=len(TAGS)).float()
    weights = (counts.sum() / counts.clamp_min(1)).sqrt()
    weights = (weights / weights.mean()).clamp(0.25, 4)
    loss_function = torch.nn.CrossEntropyLoss(weight=weights, ignore_index=-100)
    output_dir.mkdir(parents=True, exist_ok=True)
    best_loss = float("inf")
    history = []
    started = time.perf_counter()
    order = list(range(len(examples)))
    for epoch in range(epochs):
        random.shuffle(order)
        model.train()
        train_loss = 0.0
        for offset in range(0, len(order), 96):
            batch = [examples[index] for index in order[offset:offset + 96]]
            inputs, targets = collate(batch)
            optimizer.zero_grad(set_to_none=True)
            logits = model(inputs)
            loss = loss_function(logits.reshape(-1, len(TAGS)), targets.reshape(-1))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
            train_loss += float(loss.detach()) * len(batch)
        model.eval()
        calibration_loss = 0.0
        with torch.inference_mode():
            for offset in range(0, len(calibration_examples), 96):
                batch = calibration_examples[offset:offset + 96]
                inputs, targets = collate(batch)
                logits = model(inputs)
                loss = loss_function(logits.reshape(-1, len(TAGS)), targets.reshape(-1))
                calibration_loss += float(loss) * len(batch)
        calibration_loss /= len(calibration_examples)
        entry = {"epoch": epoch + 1, "train_loss": train_loss / len(examples), "calibration_loss": calibration_loss}
        history.append(entry)
        print(json.dumps(entry), flush=True)
        if calibration_loss < best_loss:
            best_loss = calibration_loss
            save_file({key: value.detach().contiguous() for key, value in model.state_dict().items()}, str(output_dir / "model.safetensors"))
            config["selected_epoch"] = epoch + 1
    config["parameters"] = sum(value.numel() for value in model.parameters())
    config["training_manifest"] = manifest
    config["training_seconds"] = time.perf_counter() - started
    config["history"] = history
    config["weights_sha256"] = hashlib.sha256((output_dir / "model.safetensors").read_bytes()).hexdigest()
    (output_dir / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return config


class SpecialistPredictor:
    def __init__(self, model_dir: Path):
        import torch
        from safetensors.torch import load_file

        torch.set_num_threads(2)
        self.config = json.loads((model_dir / "config.json").read_text())
        if self.config["tags"] != TAGS:
            raise ValueError("Specialist artifact taxonomy does not match this runtime")
        weights_path = model_dir / "model.safetensors"
        if hashlib.sha256(weights_path.read_bytes()).hexdigest() != self.config["weights_sha256"]:
            raise ValueError("Specialist weights checksum mismatch")
        self.model = build_model(self.config)
        self.model.load_state_dict(load_file(str(weights_path)))
        self.model.eval()

    def _window_predictions(self, window: list[list[int]]) -> list[tuple[float, int]]:
        import torch

        inputs, _ = collate([(window, [0] * len(window), [])])
        with torch.inference_mode():
            probabilities = self.model(inputs).softmax(-1)[0]
            scores, labels = probabilities.max(-1)
        return list(zip(scores.tolist(), labels.tolist()))

    def predict(self, text: str, record_id: str = "") -> list[dict]:
        del record_id
        encoded, _, pieces = encode_record({"text": text})
        if not pieces:
            return []
        # Keep predictions only from the central region of overlapping windows.
        # The CNN receptive field is nine tokens, so a 24-token overlap covers it.
        best = {}
        step = WINDOW_TOKENS - OVERLAP_TOKENS
        for offset in range(0, len(pieces), step):
            window = encoded[offset:offset + WINDOW_TOKENS]
            for relative, (score, label) in enumerate(self._window_predictions(window)):
                absolute = offset + relative
                margin = min(relative, len(window) - relative - 1)
                if absolute not in best or margin > best[absolute][0]:
                    best[absolute] = (margin, label, score)
            if offset + len(window) >= len(pieces):
                break
        spans = []
        current = None
        for index, (_, start, end) in enumerate(pieces):
            _, label_id, score = best[index]
            tag = TAGS[label_id]
            if tag == "O":
                if current:
                    spans.append(current)
                    current = None
                continue
            prefix, label = tag.split("-", 1)
            if current is None or prefix == "B" or current["label"] != label:
                if current:
                    spans.append(current)
                current = {"start": start, "end": end, "label": label, "score": score}
            else:
                current["end"] = end
                current["score"] = min(current["score"], score)
        if current:
            spans.append(current)
        return spans


class SpecialistOnnxPredictor(SpecialistPredictor):
    """Data-only deployment path: no torch or training stack imported."""

    def __init__(self, model_dir: Path):
        import numpy as np
        import onnxruntime as ort

        self.np = np
        ort.disable_telemetry_events()
        self.config = json.loads((model_dir / "config.json").read_text())
        verification = json.loads((model_dir / "onnx-verification.json").read_text())
        path = model_dir / "model.onnx"
        if hashlib.sha256(path.read_bytes()).hexdigest() != verification["sha256"]:
            raise ValueError("Specialist ONNX checksum mismatch")
        if verification["source_weights_sha256"] != self.config["weights_sha256"]:
            raise ValueError("Specialist ONNX export and training checkpoint do not match")
        if self.config["tags"] != TAGS:
            raise ValueError("Specialist artifact taxonomy does not match this runtime")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])

    def _window_predictions(self, window: list[list[int]]) -> list[tuple[float, int]]:
        inputs = self.np.zeros((1, len(window), MAX_BYTES), dtype=self.np.int64)
        for index, value in enumerate(window):
            inputs[0, index, :len(value)] = value
        logits = self.session.run(None, {"input_ids": inputs})[0][0]
        shifted = logits - logits.max(axis=-1, keepdims=True)
        exponential = self.np.exp(shifted)
        probabilities = exponential / exponential.sum(axis=-1, keepdims=True)
        labels = probabilities.argmax(axis=-1)
        return [(float(probabilities[index, label]), int(label)) for index, label in enumerate(labels)]


def predict_file(model_dir: Path, dataset_path: Path, output_path: Path, runtime: str = "torch",
                 predictor_factory=None) -> dict:
    import resource
    import sys

    started = time.perf_counter()
    predictor = predictor_factory(model_dir) if predictor_factory else (
        SpecialistOnnxPredictor(model_dir) if runtime == "onnx" else SpecialistPredictor(model_dir))
    cold_ms = (time.perf_counter() - started) * 1000
    metadata = {
        "candidate_id": f"llss-psi-{predictor.config['weights_sha256'][:8]}-{predictor.config.get('artifact_variant', runtime)}",
        "adapter": "specialist-research",
        "dataset_sha256": hashlib.sha256(dataset_path.read_bytes()).hexdigest(),
        "artifact_mb": (model_dir / ("model.onnx" if runtime == "onnx" else "model.safetensors")).stat().st_size / 1_000_000,
        "weights_sha256": predictor.config["weights_sha256"], "cold_start_ms": cold_ms,
        "release_eligible": False, "license": "FSL-1.1-MIT",
        "annotation_scope": "specialist PSI attributes; other gold labels count as misses",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(".jsonl.tmp")
    count = 0
    started = time.perf_counter()
    with temporary.open("w", encoding="utf-8") as output:
        output.write(json.dumps({"_meta": metadata}) + "\n")
        for record in iter_jsonl(dataset_path):
            begin = time.perf_counter()
            spans = predictor.predict(record["text"])
            output.write(json.dumps({"id": record["id"], "spans": spans,
                                     "latency_ms": (time.perf_counter() - begin) * 1000}) + "\n")
            count += 1
        divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
        summary = {"prediction_elapsed_ms": (time.perf_counter() - started) * 1000,
                   "peak_rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / divisor,
                   "prediction_records": count}
        output.write(json.dumps({"_summary": summary}) + "\n")
    temporary.replace(output_path)
    return {**metadata, **summary}


def export_onnx(model_dir: Path) -> dict:
    """Export safe data-only weights and verify logits over varying shapes."""
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch

    predictor = SpecialistPredictor(model_dir)
    ort.disable_telemetry_events()
    output = model_dir / "model.onnx"
    sample = torch.ones((1, 16, MAX_BYTES), dtype=torch.long)
    torch.onnx.export(
        predictor.model, sample, str(output), input_names=["input_ids"], output_names=["logits"],
        dynamic_axes={"input_ids": {0: "batch", 1: "tokens"}, "logits": {0: "batch", 1: "tokens"}},
        opset_version=17, dynamo=False,
    )
    onnx.checker.check_model(str(output))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(output), sess_options=options, providers=["CPUExecutionProvider"])
    generator = torch.Generator().manual_seed(20261018)
    max_error = 0.0
    for batch, length in ((1, 1), (1, 16), (2, 37), (1, 128)):
        inputs = torch.randint(0, 257, (batch, length, MAX_BYTES), generator=generator)
        with torch.inference_mode():
            expected = predictor.model(inputs).numpy()
        actual = session.run(None, {"input_ids": inputs.numpy()})[0]
        np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=1e-5)
        max_error = max(max_error, float(np.max(np.abs(actual - expected))))
    result = {"artifact": "model.onnx", "bytes": output.stat().st_size,
              "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
              "source_weights_sha256": predictor.config["weights_sha256"],
              "opset": 17, "max_logit_error": max_error,
              "verified_shapes": [[1, 1], [1, 16], [2, 37], [1, 128]],
              "release_eligible": False}
    (model_dir / "onnx-verification.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate")
    generate.add_argument("--output-dir", type=Path, required=True)
    generate.add_argument("--train-attempts", type=int, default=12000)
    training = commands.add_parser("train")
    training.add_argument("--data-dir", type=Path, required=True)
    training.add_argument("--output-dir", type=Path, required=True)
    training.add_argument("--epochs", type=int, default=8)
    training.add_argument("--initial-model", type=Path)
    predict = commands.add_parser("predict")
    predict.add_argument("--model-dir", type=Path, required=True)
    predict.add_argument("--dataset", type=Path, required=True)
    predict.add_argument("--output", type=Path, required=True)
    predict.add_argument("--runtime", choices=("torch", "onnx"), default="onnx")
    export = commands.add_parser("export-onnx")
    export.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "generate":
        result = write_curriculum(args.output_dir, args.train_attempts)
    elif args.command == "train":
        result = train(args.data_dir, args.output_dir, args.epochs, initial_model=args.initial_model)
    elif args.command == "export-onnx":
        result = export_onnx(args.model_dir)
    else:
        result = predict_file(args.model_dir, args.dataset, args.output, args.runtime)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
