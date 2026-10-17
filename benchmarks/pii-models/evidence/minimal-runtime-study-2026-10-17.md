# Reduced local runtime: 2026-10-17

Status: promising research result, **not shipped or release-qualified**. Same
model weights; no accuracy improvement. [Machine evidence](minimal-runtime-results-2026-10-17.json)
contains the complete nine profiles, format and WASM parity checks, two final
1,500-document runs, paired metrics, hashes and isolated Python build audit.

## Outcome

Three repetitions per variant, sequential child processes, rotated order, one
WASM inference thread, normal Node/V8 flags. Host: Apple M4, 10 CPU cores, 24 GiB,
macOS 26.2, Node 25.2.1. This is not the low-spec reference device.

| Diagnostic | Default ONNX runtime | Reduced ORT runtime |
| --- | --- | --- |
| Runtime assets, including unchanged JS wrapper | 14,337,332 bytes | 1,956,530 bytes |
| OS peak process RSS, three runs | 532.73–535.78 MiB | 96.34–97.08 MiB |
| Cold session startup | 153.70–156.77 ms | 38.02–38.33 ms |
| 256-token model-only p95 | 7.01–7.61 ms | 11.82–11.91 ms |

Approximately 82% lower process memory and 86% smaller runtime assets, but
approximately 60% slower 256-token inference. Converting to ORT format without
reducing the runtime still used 530–533 MiB: format conversion alone is not the
memory fix. Build configuration changes together; this experiment does not
isolate each compiler flag's contribution.

RSS is process memory, including Node and compiled code, not whole-extension
memory. The profiler records OS peak RSS separately from sampled snapshots.
Neither captures an actual extension's browser processes. Tokenizer, worker
messaging, DOM work, packaging, lifecycle and low-spec devices remain unmeasured.

## Output verification

Native same-version ONNX→ORT parity and full/minimal WASM comparisons passed five
synthetic shape cases: 1, 16, padded batch-two 37, 128 and 256 tokens. Maximum
observed logit error was zero at the predeclared 1e-4 tolerance.

Then replayed the existing 1,500-document external confirmation set, with pinned
Python/Rust tokenizer windows and verified dataset, tokenizer and frame hashes.
It covers four PSI categories, not comprehensive PII/PSI or independent new
confirmation for future tuning.

- All 1,500 span-boundary and label sets match.
- 1,414 documents also match exact span scores; 86 differ in confidence. Maximum
  aligned score difference: 0.0014681246060964659. This is **not bit-identical**.
- No detection changes at 0.1, 0.3, 0.5, 0.7, 0.9, 0.95 or 0.99. This does not
  establish equality at every possible threshold or on unseen inputs.
- At the previously used 0.1 threshold, both runs retain 93.617% weighted recall,
  84.135% whole-document protection, 0.555% character over-redaction and 90.631%
  clean-negative documents. These results still fail the safety/utility gates.
- Final replay sampled process peaks: 529.625 versus 100.1875 MiB; prediction
  elapsed times: 3,941.61 versus 6,848.49 ms. Pre-tokenized model execution only,
  not end-to-end user latency. Paired bootstrap metric differences are zero.

## Build and reproduction

This follows upstream [custom runtime](https://onnxruntime.ai/docs/build/custom.html)
and [WASM build](https://onnxruntime.ai/docs/build/web.html) mechanisms. Source
ONNX Runtime 1.30.0 is pinned to `f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7`;
emsdk submodule to `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56`, SDK 4.0.23.
Install build tools in an isolated environment, not the training environment:
Python 3.13.0, cmake 3.31.10, onnxruntime 1.30.0, onnx 1.23.2, numpy 2.4.6.
The observed Ninja version was 1.11.1.git.kitware.jobserver-1. These are observed
tool versions, not a claim of byte-reproducible builds.

From the benchmark directory, prepare the converted graph and inclusion config:

```sh
PYTHONPATH=src .cache/ort-build-venv/bin/python -m pii_bench.minimal_runtime \
  --source generated/models/psi-bert-tiny-int8 \
  --output generated/models/psi-bert-tiny-ort-minimal
```

Checkout pinned upstream source under `.cache/ort-source-v1.30.0`, initialize its
build submodules and install/activate emsdk 4.0.23 following upstream guidance.
When nested inside this benchmark's ESM package, copy `runtime_source_scope.json`
to the source checkout's `package.json` so upstream CommonJS build scripts keep
their intended scope. The bundle helper checks and hashes this override; tracked
upstream files were unchanged.

Run upstream `tools/ci_build/build.py` from that checkout with absolute paths for
the isolated Python, CMake, CTest, build directory and generated inclusion config:

```text
--config MinSizeRel --cmake_generator Ninja
--build_wasm --enable_wasm_simd --enable_wasm_threads --minimal_build
--include_ops_by_config <converted-model>/model.required_operators_and_types.basic.config
--enable_reduced_operator_type_support --disable_ml_ops --disable_rtti
--skip_tests --skip_submodule_sync --parallel 4 --compile_no_warning_as_error
```

`--skip_tests` skips upstream suites, not this study's parity and corpus checks.
Bundle completed MinSizeRel outputs using `python -m pii_bench.bundle_runtime`
with `--source`, `--build`, `--operator-config` and a fresh `--output` directory.
The helper verifies source and SDK revisions, tracked changes, CMake policy
flags, generated operator registration hashes and WASM magic before bundling.

```sh
node profile_runtime_matrix.mjs generated/models/psi-bert-tiny-int8 \
  generated/models/psi-bert-tiny-ort-minimal \
  generated/runtime/ort-minimal-bundle-v1 generated/evidence/runtime-matrix-v1
node compare_wasm_logits.mjs generated/models/psi-bert-tiny-int8 \
  generated/models/psi-bert-tiny-ort-minimal \
  generated/runtime/ort-minimal-bundle-v1 generated/evidence/runtime-parity-v1
PYTHONPATH=src .venv/bin/python -m pii_bench.runtime_pair \
  --dataset generated/data/psi-external-confirm-v4/test.jsonl \
  --first generated/evidence/runtime-confirm-v2.full-onnx.predictions.jsonl \
  --second generated/evidence/runtime-confirm-v2.minimal-ort.predictions.jsonl \
  --output generated/evidence/runtime-confirm-v2.pair.json
```

Replay inputs with `wasm_token_benchmark.mjs MODEL FRAMES OUTPUT default [RUNTIME]`.
Use fresh output locations. Neither runtime assets nor model weights are committed
or added to production packaging. Raw inputs, windows and logits remain ignored.

## Still required

The development WASM contains absolute source/build paths. Rebuild with suitable
file/debug-prefix mapping and inspect the resulting binary before redistribution.
The isolated build Python audit reported no known vulnerabilities, **not** a
review of C++ dependencies, an SBOM, licensing clearance or a security guarantee.
Complete those checks and deterministic-build investigation. The runtime loader
uses local files and checks custom bundle hashes/version/build policy; this is
research tooling, not a signed or trusted production model delivery system.

Next, prove tokenizer/offset parity and bounded worker behaviour in exact Chrome
and Edge packages, including cancellation, corrupt assets, offline operation and
restart. Independently improve model coverage and clean-negative quality; do not
use the memory gain to waive safety gates or silently replace live protection.
