# Live local architecture: next-stage evidence

17 October 2026. Research and release-engineering work; **no model promotion**.

The end state is the [live Chrome/Edge architecture](../../../LOCAL_PROTECTION_ARCHITECTURE.md),
not a research benchmark. This stage makes selection reject poor day-to-day
utility and missing release evidence, and isolates a browser-runtime cost.

## Utility selection correction

Replayed the previous 15-point literal + byte-head + INT8 BERT Tiny grid on the
same 1,792-record calibration-only file. No retraining or new test tuning.
The old objective constrained only non-PII characters. The new objective also
requires at least 98% of negative documents to remain completely untouched.

**All 15 combinations fail.** The cleanest configuration reaches only
95.1825% clean negative documents (685 negatives), despite just 0.5033%
character over-redaction. Its weighted recall is 66.9567%. This is not a selected
candidate: schema-v2 output has `feasible: false`, `selected: null` and retains
the configuration solely under `diagnostic_only`.

The earlier 98.25% four-category confirmation recall remains valid as an
exploratory measurement, but it is not evidence of acceptable full-product
coverage or utility. Future training must improve contextual person/public
discrimination, not only add span detections.

## Full-corpus release audit

Re-scored the existing budgeted full-taxonomy proposal, without changing spans,
on the 16,274-record normalized-text-grouped test partition with 1,000 cluster
bootstrap rounds, seed 20261017:

| Metric | 95% interval | Required bound |
| --- | --- | --- |
| Risk-weighted recall | 56.7234–57.8720% | Lower ≥99.5% |
| Whole-document protection | 25.4630–26.9715% | Lower ≥98% |
| Non-PII over-redaction | 1.6361–2.1910% | Upper ≤2% |
| Clean negative documents | 22.2222–77.7778% | Lower ≥98% |

The nominal 1.87% character over-redaction does **not** pass its upper-confidence
release gate. The negative corpus has only 14 independent text clusters in this
partition (seven remain clean), despite thousands of repeated negative rows.
The Wilson clean-cluster interval is 26.7992–73.2008%, far below release needs.
This both identifies a utility failure and exposes insufficient negative diversity.

The new executable release check rejects missing family/label support, safety,
utility, exact-package browser evidence and reviewed security/integration evidence.
It never treats unavailable measurements as zero cost. A pass would mean eligible
for **human release review**, not certification or automatic publication. The
current candidate remains blocked. Historical shared-template test data does not
become independent confirmation merely by adding confidence intervals.

## Runtime memory diagnosis

Same INT8 graph SHA-256
`9fb9a8357bc0ce4634f5f4f30165019fb859595baece0ef0d04c90e1561f4718`,
ONNX Runtime Web 1.30.0, one WASM thread, Node v25.2.1, macOS arm64.
`profile_wasm_memory.mjs` runs 100 synthetic inferences at each of
16, 64, 128, 256 and 16 tokens, disposing input and output tensors.

| Process RSS snapshot | Normal V8 | `--liftoff-only` diagnostic |
| --- | --- | --- |
| Before runtime import | 43.47 MiB | 44.50 MiB |
| After session creation | 174.00 MiB | 154.78 MiB |
| After first 100 short inferences | 297.80 MiB | 161.80 MiB |
| After 100 × 256-token inferences | 532.13 MiB | 172.66 MiB |
| After session release | 533.94 MiB | 172.81 MiB |

The normal process grows substantially during inference while its JavaScript
heap remains small. The same workload without V8 tier-up is much smaller but
slower: illustrative 256-token p95 is 7.52 versus 15.13 ms. These retained runs
shared a host with other research work; these timings are **diagnostic only**,
not isolated release benchmarks. Earlier separate runs showed the same broad
memory separation. Snapshots are not continuous peak measurements, and process
RSS is not equivalent to extension-wide browser memory.

This supports investigating compiled runtime code as a major contributor;
it does not fully attribute every byte or solve Chrome/Edge memory. V8 documents
its [baseline and optimising WASM compilation tiers](https://v8.dev/docs/wasm-compilation-pipeline)
and the [temporary code-memory cost of tiering](https://v8.dev/blog/liftoff).
An extension cannot require end users to disable their browser's optimising
compiler. The next deployable experiment is an
[operator-reduced ONNX Runtime Web build](https://onnxruntime.ai/docs/tutorials/web/deploy.html),
using the officially supported [custom build workflow](https://onnxruntime.ai/docs/build/custom.html),
followed by numerical/span parity and real packaged-browser tests. Smaller
weights alone are not yet an evidenced solution to this runtime overhead.

## Retained artifacts and reproduction

Raw generated artifacts remain gitignored under `generated/evidence/`:

- `specialist-dual-utility.calibration.json`, SHA-256
  `4b46cec84697584f63e40ebd580998fb9387c1643d9da3aab843bc2c0896c491`.
- `wasm-memory-default.json`, SHA-256
  `5425296b0969fe4d5dc9d1744bbbe30b8aacf1506a4bd1d66d374c9995399f70`.
- `wasm-memory-liftoff.json`, SHA-256
  `7cc4f3563c0cabcf509b42515f3c4d61756fd08b35f09534e0827fc1f41c9fb6`.
- `budget-proposal.release-audit.metrics.json` and
  `budget-proposal.release-audit.json` retain complete family/cluster results and
  explicit failed gates. No security/browser dossier was supplied or invented.

From `benchmarks/pii-models`:

```bash
node profile_wasm_memory.mjs generated/models/psi-bert-tiny-int8 default /tmp/wasm-default.json
node --liftoff-only profile_wasm_memory.mjs generated/models/psi-bert-tiny-int8 default /tmp/wasm-liftoff.json
PYTHONPATH=src .venv/bin/python -m pii_bench score \
  --dataset generated/data/llss-au-pii-psi-v1.jsonl \
  --predictions generated/evidence/llss-budget-proposal.full.predictions.jsonl \
  --partition test --bootstrap-rounds 1000 \
  --output /tmp/budget-proposal.audit.metrics.json
```

Run the memory probes sequentially on an idle reference device for defensible
performance comparisons. Repeat with the exact browser packages before making
any browser resource claim. The trained weights and production extension remain
unchanged in this stage.
