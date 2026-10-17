"""Inference adapters. Heavy model runtimes are optional benchmark extras."""

from __future__ import annotations

from abc import ABC, abstractmethod
import gc
import inspect
import json
import os
from pathlib import Path
import subprocess
from typing import Iterator

from .taxonomy import EXTENSION_LABELS, LABELS, canonical_label


class Adapter(ABC):
    candidate_id: str

    @abstractmethod
    def predict(self, text: str, record_id: str) -> list[dict]:
        raise NotImplementedError

    def close(self) -> None:
        return None


def _chunks(text: str, size: int = 1200, overlap: int = 160) -> Iterator[tuple[int, str]]:
    if len(text) <= size:
        yield 0, text
        return
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            boundary = max(text.rfind("\n", start + size // 2, end), text.rfind(" ", start + size // 2, end))
            if boundary > start:
                end = boundary + 1
        yield start, text[start:end]
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)


def _deduplicate(spans: list[dict]) -> list[dict]:
    unique: dict[tuple[int, int, str], dict] = {}
    for span in spans:
        key = (int(span["start"]), int(span["end"]), str(span["label"]))
        if key[0] >= key[1]:
            continue
        current = unique.get(key)
        if current is None or float(span.get("score", 0)) > float(current.get("score", 0)):
            unique[key] = span
    return sorted(unique.values(), key=lambda item: (item["start"], item["end"], item["label"]))


class ExtensionAdapter(Adapter):
    def __init__(self, benchmark_root: Path, mode: str):
        self.candidate_id = f"extension-{mode}"
        self.child_rss_mb = 0.0
        bridge = benchmark_root / "extension_adapter.cjs"
        self.process = subprocess.Popen(
            ["node", str(bridge), "--mode", mode],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def predict(self, text: str, record_id: str) -> list[dict]:
        if not self.process.stdin or not self.process.stdout:
            raise RuntimeError("Extension bridge is not available")
        self.process.stdin.write(json.dumps({"id": record_id, "text": text}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"Extension bridge exited unexpectedly: {stderr.strip()}")
        result = json.loads(line)
        if result.get("error"):
            raise RuntimeError(f"Extension bridge error: {result['error']}")
        self.child_rss_mb = float(result.get("rss_mb", self.child_rss_mb))
        for span in result.get("spans", []):
            span["label"] = EXTENSION_LABELS.get(span["label"], canonical_label(span["label"]))
        return result.get("spans", [])

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class TransformersJsAdapter(Adapter):
    def __init__(self, candidate: dict, benchmark_root: Path, cache_dir: Path | None):
        self.candidate_id = candidate["id"]
        self.child_rss_mb = 0.0
        self.label_map = candidate.get("label_map", {})
        bridge = benchmark_root / "transformers_js_adapter.mjs"
        options = {
            "repository": candidate["repository"],
            "revision": candidate.get("revision"),
            "dtype": candidate.get("dtype", "q4"),
            "cache_dir": str(cache_dir) if cache_dir else None,
        }
        self.process = subprocess.Popen(
            ["node", str(bridge), json.dumps(options, separators=(",", ":"))],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def predict(self, text: str, record_id: str) -> list[dict]:
        if not self.process.stdin or not self.process.stdout:
            raise RuntimeError("Transformers.js bridge is not available")
        self.process.stdin.write(json.dumps({"id": record_id, "text": text}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise RuntimeError(f"Transformers.js bridge exited unexpectedly: {stderr.strip()}")
        result = json.loads(line)
        if result.get("error"):
            raise RuntimeError(f"Transformers.js adapter error: {result['error']}")
        self.child_rss_mb = float(result.get("rss_mb", self.child_rss_mb))
        for span in result.get("spans", []):
            span["label"] = canonical_label(span["label"], self.label_map)
        return _deduplicate(result.get("spans", []))

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class OnnxTokenAdapter(Adapter):
    """Direct ONNX Runtime adapter for the exact deployable artifact."""

    def __init__(self, candidate: dict, cache_dir: Path | None):
        try:
            import numpy as np
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from tokenizers import Tokenizer
            from transformers import AutoConfig, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("Install the benchmark's 'onnx' optional dependencies") from exc
        self.np = np
        ort.disable_telemetry_events()
        self.candidate_id = candidate["id"]
        self.label_map = candidate.get("label_map", {})
        repository = candidate["repository"]
        revision = candidate.get("revision")
        cache = str(cache_dir) if cache_dir else None
        model_path = hf_hub_download(
            repository,
            candidate["model_file"],
            revision=revision,
            cache_dir=cache,
        )
        self.raw_tokenizer = False
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(repository, revision=revision, cache_dir=cache)
        except (OSError, ValueError):
            tokenizer_path = hf_hub_download(repository, "tokenizer.json", revision=revision, cache_dir=cache)
            self.tokenizer = Tokenizer.from_file(tokenizer_path)
            self.tokenizer.enable_truncation(max_length=256, stride=64)
            self.raw_tokenizer = True
        try:
            config = AutoConfig.from_pretrained(repository, revision=revision, cache_dir=cache)
            raw_id2label = config.id2label
        except (OSError, ValueError):
            config_path = hf_hub_download(repository, "config.json", revision=revision, cache_dir=cache)
            raw_id2label = json.loads(Path(config_path).read_text(encoding="utf-8")).get("id2label", {})
        if not raw_id2label:
            raise ValueError(f"{repository} config does not define id2label")
        self.id2label = {int(key): value for key, value in raw_id2label.items()}
        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = int(candidate.get("threads", 1))
        session_options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, sess_options=session_options, providers=["CPUExecutionProvider"])
        self.input_names = {item.name for item in self.session.get_inputs()}

    @staticmethod
    def _tag(raw_label: str) -> tuple[str, str]:
        normalized = raw_label.upper().replace("_", "-")
        if len(normalized) > 2 and normalized[0] in "BIESUL" and normalized[1] == "-":
            return normalized[0], raw_label[2:]
        return "S", raw_label

    def _decode(self, offsets, label_ids, logits, base_offset: int) -> list[dict]:
        spans: list[dict] = []
        current: dict | None = None

        def finish() -> None:
            nonlocal current
            if current and current["end"] > current["start"]:
                spans.append(current)
            current = None

        for token_index, (relative_start, relative_end) in enumerate(offsets):
            start, end = int(relative_start), int(relative_end)
            if start == end:
                continue
            raw_label = self.id2label.get(int(label_ids[token_index]), "O")
            if raw_label.upper() == "O":
                finish()
                continue
            tag, entity_type = self._tag(raw_label)
            label = canonical_label(entity_type, self.label_map)
            token_logits = logits[token_index]
            shifted = token_logits - token_logits.max()
            probabilities = self.np.exp(shifted)
            score = float(probabilities[int(label_ids[token_index])] / probabilities.sum())
            absolute_start, absolute_end = base_offset + start, base_offset + end
            if tag in {"S", "U"}:
                finish()
                spans.append({"start": absolute_start, "end": absolute_end, "label": label, "score": score})
            elif tag == "B" or current is None or current["label"] != label:
                finish()
                current = {"start": absolute_start, "end": absolute_end, "label": label, "score": score}
            else:
                current["end"] = absolute_end
                current["score"] = min(current["score"], score)
                if tag in {"E", "L"}:
                    finish()
        finish()
        return spans

    def predict(self, text: str, record_id: str) -> list[dict]:
        del record_id
        spans: list[dict] = []
        for base_offset, chunk in _chunks(text):
            if self.raw_tokenizer:
                raw = self.tokenizer.encode(chunk)
                windows = [
                    (item.offsets, {
                        "input_ids": self.np.asarray([item.ids], dtype=self.np.int64),
                        "attention_mask": self.np.asarray([item.attention_mask], dtype=self.np.int64),
                        "token_type_ids": self.np.asarray([item.type_ids], dtype=self.np.int64),
                    }) for item in [raw, *raw.overflowing]
                ]
            else:
                encoded = self.tokenizer(
                    chunk,
                    return_tensors="np",
                    return_offsets_mapping=True,
                    truncation=True,
                    max_length=256,
                    stride=64,
                    return_overflowing_tokens=True,
                    padding=True,
                )
                all_offsets = encoded.pop("offset_mapping")
                windows = [
                    (offsets, {name: value[index:index + 1] for name, value in encoded.items()
                               if name in self.input_names})
                    for index, offsets in enumerate(all_offsets)
                ]
            for offsets, inputs in windows:
                feed = {name: value.astype(self.np.int64) for name, value in inputs.items()
                        if name in self.input_names}
                logits = self.session.run(None, feed)[0][0]
                labels = logits.argmax(axis=-1)
                spans.extend(self._decode(offsets, labels, logits, base_offset))
        return _deduplicate(spans)

    def close(self) -> None:
        self.session = None
        self.tokenizer = None
        gc.collect()


class HuggingFaceTokenAdapter(Adapter):
    def __init__(self, candidate: dict, cache_dir: Path | None, allow_remote_code: bool):
        try:
            from transformers import pipeline
        except ImportError as exc:
            raise RuntimeError("Install the benchmark's 'hf' optional dependencies") from exc
        if candidate.get("requires_remote_code") and not allow_remote_code:
            raise RuntimeError("Candidate requires remote model code; rerun only after review with --allow-remote-code")
        self.candidate_id = candidate["id"]
        self.label_map = candidate.get("label_map", {})
        self.pipe = pipeline(
            "token-classification",
            model=candidate["repository"],
            tokenizer=candidate["repository"],
            revision=candidate.get("revision"),
            aggregation_strategy="simple",
            device=-1,
            trust_remote_code=bool(candidate.get("requires_remote_code")),
            model_kwargs={
                "cache_dir": str(cache_dir) if cache_dir else None,
                "use_safetensors": True,
            },
        )

    def predict(self, text: str, record_id: str) -> list[dict]:
        del record_id
        spans: list[dict] = []
        for offset, chunk in _chunks(text):
            # Character counts cannot guarantee token-window fit. The pipeline
            # must visit overflow windows rather than silently truncating tails.
            for entity in self.pipe(chunk, stride=64):
                raw_label = entity.get("entity_group") or entity.get("entity") or "OTHER_PII"
                spans.append(
                    {
                        "start": offset + int(entity["start"]),
                        "end": offset + int(entity["end"]),
                        "label": canonical_label(raw_label, self.label_map),
                        "score": float(entity.get("score", 0)),
                    }
                )
        return _deduplicate(spans)

    def close(self) -> None:
        self.pipe = None
        gc.collect()


class GlinerAdapter(Adapter):
    def __init__(self, candidate: dict, cache_dir: Path | None):
        try:
            from gliner import GLiNER
        except ImportError as exc:
            raise RuntimeError("Install the benchmark's 'gliner' optional dependencies") from exc
        loader_source = inspect.getsource(GLiNER._load_state_dict)
        if "weights_only=True" not in loader_source:
            raise RuntimeError(
                "Installed GLiNER does not visibly enforce torch.load(weights_only=True); "
                "refusing to load the checkpoint"
            )
        self.candidate_id = candidate["id"]
        self.threshold = float(candidate.get("threshold", 0.25))
        self.labels = candidate.get("query_labels") or [label.lower().replace("_", " ") for label in LABELS]
        self.label_map = candidate.get("label_map", {})
        self.model = GLiNER.from_pretrained(
            candidate["repository"],
            revision=candidate.get("revision"),
            cache_dir=str(cache_dir) if cache_dir else None,
        )

    def predict(self, text: str, record_id: str) -> list[dict]:
        del record_id
        spans: list[dict] = []
        for offset, chunk in _chunks(text):
            for entity in self.model.predict_entities(chunk, self.labels, threshold=self.threshold):
                spans.append(
                    {
                        "start": offset + int(entity["start"]),
                        "end": offset + int(entity["end"]),
                        "label": canonical_label(entity.get("label", "OTHER_PII"), self.label_map),
                        "score": float(entity.get("score", 0)),
                    }
                )
        return _deduplicate(spans)

    def close(self) -> None:
        self.model = None
        gc.collect()


class PresidioAdapter(Adapter):
    def __init__(self, candidate: dict, cache_dir: Path):
        cache_dir.mkdir(parents=True, exist_ok=True)
        # Presidio's email recognizer imports tldextract, whose default is to
        # refresh the public-suffix list over HTTP. Use its bundled snapshot so
        # inference remains fully offline and reproducible.
        os.environ.setdefault("TLDEXTRACT_PUBLIC_SUFFIX_LIST_URLS", "")
        os.environ.setdefault("TLDEXTRACT_CACHE", str(cache_dir / "tldextract"))
        try:
            from presidio_analyzer import AnalyzerEngine
            from presidio_analyzer.nlp_engine import NlpEngineProvider
        except ImportError as exc:
            raise RuntimeError("Install the benchmark's 'presidio' optional dependencies and en_core_web_sm") from exc
        self.candidate_id = candidate["id"]
        provider = NlpEngineProvider(
            nlp_configuration={
                "nlp_engine_name": "spacy",
                "models": [
                    {
                        "lang_code": "en",
                        "model_name": candidate.get("spacy_model", "en_core_web_sm"),
                    }
                ],
            }
        )
        self.analyzer = AnalyzerEngine(nlp_engine=provider.create_engine())

    def predict(self, text: str, record_id: str) -> list[dict]:
        del record_id
        return [
            {
                "start": item.start,
                "end": item.end,
                "label": canonical_label(item.entity_type),
                "score": float(item.score),
            }
            for item in self.analyzer.analyze(text=text, language="en")
        ]


def create_adapter(
    candidate: dict,
    benchmark_root: Path,
    cache_dir: Path | None = None,
    allow_remote_code: bool = False,
) -> Adapter:
    adapter = candidate["adapter"]
    if adapter == "extension":
        return ExtensionAdapter(benchmark_root, candidate["mode"])
    if adapter == "transformers-js":
        return TransformersJsAdapter(candidate, benchmark_root, cache_dir)
    if adapter == "onnx-token":
        return OnnxTokenAdapter(candidate, cache_dir)
    if adapter == "huggingface-token":
        return HuggingFaceTokenAdapter(candidate, cache_dir, allow_remote_code)
    if adapter == "gliner":
        return GlinerAdapter(candidate, cache_dir)
    if adapter == "presidio":
        return PresidioAdapter(candidate, cache_dir or benchmark_root / ".cache")
    raise ValueError(f"Unsupported adapter type: {adapter}")
