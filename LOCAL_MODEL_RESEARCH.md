# Low-resource private PII model research

Research snapshot: 17 October 2026.

## Decision

The browser vendors' built-in generative models are an optional enhancement, not the minimum required to protect users. The smallest production architecture for this extension is:

1. deterministic Australian PII rules (already shipped; zero model bytes and no GPU);
2. a compact token-classification model for contextual entities such as names and addresses; and
3. the browser Prompt API only when the browser has already made it available.

For a low-resource neural fallback, `divergentlabs/masker-mini` is the strongest current prototype candidate found. Its published INT4 ONNX artifact is 22 MB, has 35.4 million parameters, uses an Apache-2.0 licence, targets PII directly, and is designed for CPU/on-device use. It must still pass the Australian-sector benchmark and supply-chain gates below before it is shipped.

This is deliberately not an approval to put an unvalidated third-party model in the protection path.

## Why the published browser requirements are so high

Those requirements apply to general-purpose generative foundation models managed by the browser:

- Chrome currently documents 22 GB free profile-volume storage and either more than 4 GB VRAM or 16 GB RAM with at least four CPU cores. The initial download requires an unmetered connection. Inference is local.
- Edge's Phi-4-mini developer preview documents 20 GB free storage and at least 5.5 GB VRAM. Microsoft also documents a smaller prerelease Aion model that can use CPU inference, but it remains an Edge Dev/Canary preview.

They are browser eligibility thresholds, not the intrinsic requirements of PII detection. A purpose-built encoder only classifies spans; it does not need to generate arbitrary prose.

Sources: [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api), [Microsoft Edge Prompt API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api).

## Candidate comparison

| Candidate | Download / parameters | PII readiness | Licence | Assessment |
|---|---:|---|---|---|
| Deterministic rules | 0 model bytes | Production; structured Australian identifiers | Project licence | Mandatory safety floor. Fastest and smallest. Cannot reliably infer every name or ambiguous address. |
| BERT Tiny base | 17.8 MB FP32 / about 4.4M | Not trained for PII | MIT | Smallest credible base architecture found. Would require our own PII fine-tune, quantisation, evaluation and model governance. Not a deployable detector as published. |
| `divergentlabs/masker-mini` | 22 MB INT4 ONNX / 35.4M | Purpose-built; 12 PII types, 23 European languages | Apache-2.0 | Preferred prototype. Model-card results are self-reported and Australian identifiers are not a stated specialty, so it must remain behind the deterministic Australian rules. |
| MiniLM-L6 PII detector | about 90 MB FP32 / 22.6M | Purpose-built, broad Nemotron PII labels | MIT | Smaller parameter count than Masker Mini but a larger published artifact, very low adoption, and limited independent evidence. Research comparison only. |
| SmolLM2-135M-Instruct | 118 MB Q4F16 ONNX / 135M | General-purpose generative model, not PII-specific | Apache-2.0 | Small generative baseline, but less deterministic and larger than a token classifier. Not recommended for the low-resource default. |
| GLiNER small v2.1 | 183 MB INT8 ONNX / 166M | Flexible zero-shot named entities | Apache-2.0 | Useful for novel entity labels, but materially larger and more complex than the fixed PII task requires. |
| Piiranha v1 | 1.11 GB FP32 / about 0.3B | Purpose-built, strong published PII metrics | CC-BY-NC-ND-4.0 | Too large and its non-commercial/no-derivatives licence is unsuitable for the intended broadly distributable offering. |

Primary model sources: [BERT Tiny files](https://huggingface.co/prajjwal1/bert-tiny/tree/main), [Masker Mini model card](https://huggingface.co/divergentlabs/masker-mini), [MiniLM-L6 PII model card](https://huggingface.co/Negative-Star-Innovators/MiniLM-L6-finetuned-pii-detection), [SmolLM2 model and ONNX artifacts](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct), [GLiNER small model card](https://huggingface.co/urchade/gliner_small-v2.1), [GLiNER ONNX artifacts](https://huggingface.co/onnx-community/gliner_small-v2.1/tree/main/onnx), [Piiranha model card and files](https://huggingface.co/iiiorg/piiranha-v1-detect-personal-information).

## Browser deployment path

ONNX Runtime Web supports CPU inference through WebAssembly and states that WASM has the full ONNX operator set. This is the compatibility-first execution provider for the prototype. WebGPU can be evaluated as an optional acceleration path, never a requirement. A model-specific runtime build can reduce runtime binary size.

Source: [ONNX Runtime Web guidance](https://onnxruntime.ai/docs/tutorials/web/).

The model should be packaged or fetched as inert, hash-pinned model data from an explicitly controlled release endpoint. It must never execute remotely supplied JavaScript or WASM. Model metadata must include the upstream revision, SHA-256 hashes, licence and notice files, supported label map, evaluation version and rollback identifier.

## Release gates for the compact model

The compact model is not eligible for general release until all of these pass:

- Australian public/community-sector corpus covering names, addresses, Medicare, TFN, ABN/ACN, licences, passports, phone formats, email, banking and health narratives.
- Separate synthetic, public-domain and hand-reviewed out-of-distribution sets; no private production text in training or telemetry.
- Recall-first thresholds by entity type, plus leak-character recall, false-positive rate and exact boundary scoring. Aggregate F1 alone is insufficient.
- Comparison against deterministic-only and browser-AI paths on low-end managed Windows hardware, including cold start, steady-state latency, peak memory, package/download size and offline behaviour.
- Adversarial tests for prompt-like text, Unicode confusables, spacing, OCR noise, long documents, mixed languages and malicious model artifacts.
- Reproducible conversion, hash verification, SBOM, licence review, rollback and fail-closed integration: a load or inference failure must immediately retain deterministic protection.
- No content telemetry. Diagnostics may report model version, readiness, timings and coarse error categories only.

## Recommended delivery sequence

1. Ship the guided browser-model setup and full readiness self-test.
2. Build a benchmark-only Masker Mini WASM prototype behind a development flag.
3. Test INT4 operator compatibility and accuracy against FP16; use FP16 if the 22 MB graph is not consistently supported.
4. Fine-tune a smaller BERT Tiny-class Australian PII model only if Masker Mini misses the package, latency or recall targets.
5. Promote a compact model only after the release gates pass, while keeping deterministic rules before and after it as defence in depth.
