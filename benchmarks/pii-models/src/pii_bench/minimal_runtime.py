"""Prepare and verify a basic-optimised ORT graph for a reduced WASM runtime.

Safe-format research artifacts only. Format/native parity cannot establish
browser span parity, model accuracy, redistribution rights or release approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil


RUNTIME_VERSION = "1.30.0"
SOURCE_REVISION = "f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7"
SDK_REVISION = "c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source: Path, destination: Path) -> dict:
    if destination.exists() and any(destination.iterdir()):
        raise FileExistsError("Use a fresh conversion directory; evidence cannot be overwritten")
    verification = json.loads((source / "onnx-verification.json").read_text())
    source_hash = digest(source / "model.onnx")
    if source_hash != verification["sha256"]:
        raise ValueError("Source ONNX checksum mismatch")
    import onnxruntime as ort
    from onnxruntime.tools.convert_onnx_models_to_ort import OptimizationStyle, convert_onnx_models_to_ort

    if ort.__version__ != RUNTIME_VERSION:
        raise ValueError(f"Conversion must use ONNX Runtime {RUNTIME_VERSION}, got {ort.__version__}")
    ort.disable_telemetry_events()
    # Basic optimisations avoid platform-specific layout/fusion decisions. The
    # matched-version converter emits the kernel AND type inclusion manifest.
    key = "ORT_CONVERT_ONNX_MODELS_TO_ORT_OPTIMIZATION_LEVEL"
    previous = os.environ.get(key)
    os.environ[key] = "basic"
    try:
        convert_onnx_models_to_ort(source / "model.onnx", output_dir=destination,
                                   optimization_styles=[OptimizationStyle.Fixed], enable_type_reduction=True)
    finally:
        if previous is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = previous
    for name in ("training.json", "tokenizer.json"):
        shutil.copyfile(source / name, destination / name)
    return verify(source, destination)


def verify(source: Path, destination: Path) -> dict:
    import numpy as np
    import onnxruntime as ort

    if ort.__version__ != RUNTIME_VERSION:
        raise ValueError("Native parity requires the matched runtime version")
    ort.disable_telemetry_events()
    verification = json.loads((source / "onnx-verification.json").read_text())
    if digest(source / "model.onnx") != verification["sha256"]:
        raise ValueError("Source ONNX checksum mismatch")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    native = ort.InferenceSession(str(source / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
    converted = ort.InferenceSession(str(destination / "model.basic.ort"), sess_options=options, providers=["CPUExecutionProvider"])
    maximum = 0.0
    cases = []
    for batch, length in ((1, 1), (1, 16), (2, 37), (1, 128), (1, 256)):
        ids = (np.arange(batch * length, dtype=np.int64).reshape(batch, length) % 1000) + 100
        mask = np.ones_like(ids)
        if length > 3:
            mask[:, -2:] = 0
            ids[:, -2:] = 0
        inputs = {"input_ids": ids, "attention_mask": mask}
        expected = native.run(None, inputs)[0]
        actual = converted.run(None, inputs)[0]
        np.testing.assert_allclose(actual, expected, atol=1e-4, rtol=1e-4)
        error = float(np.abs(actual - expected).max())
        maximum = max(maximum, error)
        cases.append({"batch": batch, "tokens": length, "padded_mask": length > 3, "maximum_logit_error": error})
    config = destination / "model.required_operators_and_types.basic.config"
    # Drop machine-specific source-path comments for a reproducible build input.
    text = "\n".join(line for line in config.read_text().splitlines() if line and not line.startswith("#")) + "\n"
    canonical = destination / "required-operators.config"
    if canonical.exists() and canonical.read_text() != text:
        raise ValueError("Existing canonical operator config differs")
    canonical.write_text(text)
    metadata = json.loads((source / "training.json").read_text())
    result = {"schema_version": 1, "release_eligible": False, "artifact_file": "model.basic.ort",
              "sha256": digest(destination / "model.basic.ort"), "source_onnx_sha256": verification["sha256"],
              "weights_sha256": metadata["weights_sha256"], "tokenizer_sha256": digest(source / "tokenizer.json"),
              "bytes": (destination / "model.basic.ort").stat().st_size,
              "operator_config_sha256": digest(canonical), "runtime_version": RUNTIME_VERSION,
              "runtime_source_revision": SOURCE_REVISION, "sdk_revision": SDK_REVISION,
              "optimization": "basic-fixed, no platform-specific target", "cases": cases,
              "maximum_native_logit_error": maximum,
              "limitations": "Native same-version format parity only; WASM output/span and exact-package browser tests still required"}
    (destination / "deployment.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify-existing", action="store_true")
    args = parser.parse_args()
    if args.verify_existing:
        for name in ("training.json", "tokenizer.json"):
            target = args.output / name
            if target.exists() and digest(target) != digest(args.source / name):
                raise ValueError(f"Existing {name} differs from the source artifact")
            if not target.exists():
                shutil.copyfile(args.source / name, target)
        result = verify(args.source, args.output)
    else:
        result = prepare(args.source, args.output)
    print(json.dumps(result, indent=2))
