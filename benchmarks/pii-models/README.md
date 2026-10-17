# Local PII/PSI model benchmark

This is an isolated, reproducible harness for selecting local detection models for Loose Lips Sink Ships. It evaluates the actual production rules alongside browser-sized models, accuracy controls, and cached ensembles. It does not change extension runtime code or download a model for end users.

The benchmark is leak-focused. Aggregate F1 is reported, but selection prioritises risk-weighted recall, whole-document protection, hard-negative cleanliness, over-redaction, latency, memory, artifact size, licence, and offline deployability.

The [specialist training study](evidence/specialist-study-2026-10-17.md) records the trained models, independent external confirmation, corrected full-corpus results, runtime findings, and release blockers. [Machine-readable evidence](evidence/specialist-results-2026-10-17.json) retains aggregate metrics, hashes, calibration selections, and paired comparisons.

## Quick start

Core dataset, metric, production-adapter, and ensemble tests require only Python 3.10+ and Node:

```bash
cd benchmarks/pii-models
PYTHONPATH=src python -m unittest discover -s tests -v
PYTHONPATH=src python -m pii_bench generate \
  --records 20000 \
  --seed 20261017 \
  --output /tmp/llss-au-pii-psi-v1.jsonl \
  --manifest /tmp/llss-au-pii-psi-v1.manifest.json
PYTHONPATH=src python -m pii_bench validate \
  --dataset /tmp/llss-au-pii-psi-v1.jsonl \
  --sha256 58d9d81c9c9a0b42c322426bb77638af61b51a023cfb81101588951d0fbbabe6
```

Create an isolated environment only for model runs:

```bash
python -m venv .venv
.venv/bin/pip install -e '.[onnx,gliner,hf,monitoring]'
npm ci --ignore-scripts
```

List the governed 20-candidate matrix and run a pinned candidate:

```bash
PYTHONPATH=src .venv/bin/python -m pii_bench catalog
PYTHONPATH=src .venv/bin/python -m pii_bench run \
  --candidate masker-mini \
  --dataset /tmp/llss-au-pii-psi-v1.jsonl \
  --output /tmp/masker.predictions.jsonl \
  --cache-dir .cache/huggingface
```

Tune on the stable 20% calibration partition, then evaluate once on the 80% held-out partition:

```bash
PYTHONPATH=src .venv/bin/python -m pii_bench calibrate \
  --dataset /tmp/llss-au-pii-psi-v1.jsonl \
  --predictions /tmp/masker.predictions.jsonl \
  --threshold 0.25 --threshold 0.30 --threshold 0.35 \
  --max-over-redaction 0.02 \
  --output /tmp/masker.calibration.json

PYTHONPATH=src .venv/bin/python -m pii_bench score \
  --dataset /tmp/llss-au-pii-psi-v1.jsonl \
  --predictions /tmp/masker.predictions.jsonl \
  --partition test --minimum-score 0.30 \
  --bootstrap-rounds 1000 \
  --output /tmp/masker.test.json
```

Cached predictions can be combined without rerunning inference. Member thresholds are applied before union or precedence composition. `calibrate-ensemble` performs a bounded grid search using calibration records only.

Calibration now requires **both** at most 2% character over-redaction and at least
98% clean negative documents. It must include negatives. Schema-v2 results return
`selected: null` and `feasible: false` if nothing qualifies and the CLI exits 1; `diagnostic_only` is
not a deployable selection. Do not read a threshold from it as a fallback. Historical
schema-v1 selections used only the character constraint. Use
`--min-clean-negative-rate 0` solely to replay that older objective; it does not
relax release requirements. The score command above illustrates scoring a locked
threshold, not evidence that 0.30 will qualify.

## Release evidence

The end deliverable is the [live local architecture](../../LOCAL_PROTECTION_ARCHITECTURE.md),
not a research-only model. `release-check` enforces the [protocol](PROTOCOL.md):

```bash
PYTHONPATH=src python -m pii_bench release-check \
  --metrics /path/to/independent-test.metrics.json \
  --dossier /path/to/reviewed-release-dossier.json \
  --output /tmp/release-decision.json
```

Exit status 1 means blocked; a pass means eligible for human release review, never
automatic publication or a safety certification. Missing evidence, native-only
timings, incomplete label coverage and Node/WASM timings cannot qualify. Dossier
keys and required review names are defined in `src/pii_bench/release.py`. Browser
runs bind the exact package and architecture artifact hashes and use decimal MB
for download size and MiB for whole-extension memory. Only supply real reviewed
attestations; passing unit-test fixtures are explicitly fabricated.

The gate requires a scored `test` partition. For an externally split test-only
file, the current scorer's `all` partition is deliberately not accepted as a
release test declaration. Do not relabel historical scores to bypass this; a
future explicit split-manifest workflow must verify training/calibration/test
provenance. Supplied review hashes require human inspection of the actual files.

## Corpus

The deterministic corpus contains 20,000 records, 55,706 exact-span entities, 44 labels, 28 domains, 3,200 hard-negative records, 7,956 sensitive-information records, and clean plus six corruption/noise modes. It includes plain text, logs, JSON, CSV, Markdown, long-window cases, multilingual names, and code-switching. There are 16,075 unique normalized texts; repeated examples and shared templates limit statistical independence. The default split groups identical normalized texts and confidence intervals resample document/text clusters. Historical smoke results remain exploratory.

```bash
PYTHONPATH=src python -m pii_bench audit-dataset --dataset /tmp/llss-au-pii-psi-v1.jsonl
```

All values are synthetic. Phone numbers use ACMA fictional ranges; domains use `example.com`; IP addresses use documentation ranges; Australian identifiers use deliberately invalid or reserved-looking forms. Do not replace them with scraped or real personal data.

The checked manifest is in [`data/manifests/llss-au-pii-psi-v1.json`](data/manifests/llss-au-pii-psi-v1.json). Generated corpora, model weights, and raw predictions are intentionally gitignored.

## Specialist training experiments

`specialist.py` implements a 90,839-parameter byte-CNN with a contextual token head for 15 sensitive-information categories. It can train from scratch, fine-tune a safetensors parent checkpoint, export a dynamic-shape ONNX graph, verify export parity, and run inference without importing PyTorch. The initial authored-only experiment failed to generalize; keep that negative result when comparing later experiments.

```bash
.venv/bin/pip install -e '.[specialist]'
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist generate \
  --output-dir generated/psi-curriculum-v1
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist train \
  --data-dir generated/psi-curriculum-v1 \
  --output-dir generated/psi-head-v1 --epochs 8
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist export-onnx \
  --model-dir generated/psi-head-v1
```

The authored curriculum separates exact phrases, sentence templates, and names across training, calibration, and test. `specialist_external.py` supplements it using explicitly labelled race/ethnicity, religion, political views, and sexuality spans from the pinned NVIDIA Nemotron-PII training shard. It groups variants by source document ID, checks offsets, removes duplicate texts/windows, and excludes any test document ID also present in training. It does not infer missing health, legal, or safeguarding labels from unannotated source text.

```bash
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist_external \
  --train-parquet /path/to/pinned/train.parquet \
  --test-parquet /path/to/pinned/test.parquet \
  --curriculum generated/psi-curriculum-v1 \
  --output generated/psi-external-v2 --train-limit 4000 --eval-limit 1500
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist train \
  --data-dir generated/psi-external-v2 --initial-model generated/psi-head-v1 \
  --output-dir generated/psi-head-v2 --epochs 6
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist export-onnx \
  --model-dir generated/psi-head-v2
PYTHONPATH=src .venv/bin/python -m pii_bench.specialist predict \
  --model-dir generated/psi-head-v2 --runtime onnx \
  --dataset generated/psi-external-v2/calibration.jsonl \
  --output generated/head-v2.calibration.predictions.jsonl
```

Choose the confidence threshold from that calibration-only file with `calibrate --calibration-partition all`, then apply it unchanged to the external test file and the authored phrase-disjoint test. The calibration file may control checkpoint/threshold selection; test files must never influence training. Artifacts remain research-only until external, human, and browser gates pass. The training source is [NVIDIA Nemotron-PII](https://huggingface.co/datasets/nvidia/Nemotron-PII), CC-BY-4.0, revision `b70ffaf5ff39e079776134c5bf4381f00a9fd1ed`; preserve attribution in derived artifacts.

The pretrained comparison uses `tiny_finetune.py`: a pinned Google BERT Miniature receives a new 31-tag classification head, is fine-tuned on the same training/calibration data, and is exported to ONNX. INT8 quantization produces a 4.48 MB graph. `specialist_baseline.py` learns a 763-entry literal-span dictionary from training annotations as a simpler control.

```bash
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune train \
  --data-dir generated/psi-external-v2 --output-dir generated/psi-bert-tiny --epochs 4
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune export \
  --model-dir generated/psi-bert-tiny
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune quantize \
  --model-dir generated/psi-bert-tiny --output-dir generated/psi-bert-tiny-int8
```

Use `specialist_external --exclude-evaluation /path/to/discovery-test.jsonl` to reserve a new external sample with no source IDs from the discovery sample. `compare` computes paired document-cluster bootstrap differences. `verify_tiny_wasm.mjs` checks strict native/WASM logit parity; `wasm_token_benchmark.mjs` measures actual backend transfer on prepared tokenizer windows. Float ONNX passes strict parity; INT8 has small backend differences and must be evaluated with actual spans. The default runtime's roughly 534 MiB Node process RSS is the historical baseline. The [minimal runtime study](evidence/minimal-runtime-study-2026-10-17.md) reduces this to roughly 97 MiB in repeated synthetic diagnostics, and 100 MiB on 1,500 documents, with slower inference. This is not browser memory evidence or release approval; model quality remains insufficient.

`profile_wasm_memory.mjs MODEL_DIRECTORY [default|bounded] [OUTPUT_JSON]`
isolates runtime import, session creation, fixed-shape inference and release.
Compare normal Node with `node --liftoff-only` only as a V8 compiler diagnostic,
not a deployment setting. Snapshots are process RSS samples, not measured browser
extension memory or a continuous peak. See the
[next-stage evidence](evidence/local-release-next-stage-2026-10-17.md).

The profiler also reports OS process peak RSS separately. An optional final
runtime-directory argument verifies a research bundle before loading local WASM.
`profile_runtime_matrix.mjs` rotates three variants across three sequential runs;
`compare_wasm_logits.mjs` checks five padded shape cases in separate processes.
`pii_bench.runtime_pair` compares real span boundaries, confidence drift, seven
fixed thresholds and paired bootstrap metrics without conflating those checks.
Reproduction instructions and known build hygiene issues are in the study above.

The augmented training set contains two values also present in the authored test (`biromantic` and `Seventh-day Adventist`). That test remains template/name-disjoint, but must not be described as entirely phrase-disjoint for augmented models. The authored-only first experiment has strict phrase separation.

## Counterfactual context study

The [v2 contextual study](evidence/context-study-2026-10-17.md) adds person/public
counterfactual pairs and mixed-context documents, then compares the previous
typed model with newly trained typed and category-agnostic BIO heads. It improves
diagnostic transfer but **neither new model passes release gates**. Complete
[machine evidence](evidence/context-results-2026-10-17.json) includes failures,
locked calibration choices and paired cluster intervals. Test data viewed in
this study is now exploratory/regression data for subsequent research.

Use fresh output directories; corpus generation, training and study commands
refuse to overwrite existing results. Generated corpora and weights stay ignored.
Names are unscored: this curriculum evaluates 15 PSI categories, not all PII.

```bash
PYTHONPATH=src .venv/bin/python -m pii_bench.context_data \
  --output generated/data/psi-context-v2 \
  --external-parent generated/data/psi-external-v2
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune train \
  --data-dir generated/data/psi-context-v2 \
  --output-dir generated/models/psi-context-typed --epochs 4
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune train \
  --data-dir generated/data/psi-context-v2 \
  --output-dir generated/models/psi-context-agnostic --epochs 4 --label-scheme agnostic
```

Export and quantize each trained candidate using the existing commands, then
evaluate the exact INT8 artifacts (the first named candidate is the control):

```bash
PYTHONPATH=src .venv/bin/python -m pii_bench.context_study \
  --data generated/data/psi-context-v2 \
  --candidate baseline=generated/models/psi-bert-tiny-int8 \
  --candidate typed=generated/models/psi-context-typed-int8 \
  --candidate agnostic=generated/models/psi-context-agnostic-int8 \
  --regression generated/data/psi-external-confirm-v4/test.jsonl \
  --output generated/evidence/context-transfer-study
```

The driver writes `locked-plan.json` with candidate/tokenizer/prediction hashes
and selected thresholds **before** any test prediction or scoring. Its primary
operating point uses both calibration utility constraints; a separately reported
fixed 0.10 threshold is diagnostic only. If calibration is infeasible, no primary
threshold is invented. Optional regression data must be labelled previously
viewed, never fresh confirmation. Source-pair clusters keep counterfactual pairs
together in bootstrap comparisons. Current native measurements do not establish
browser performance, and the source grammar/value diversity remains insufficient
for release assurance.

## Layout

- `candidates.json` — pinned models, licences, deployment gates, and rationale.
- `src/pii_bench/dataset.py` — deterministic synthetic corpus and validation.
- `src/pii_bench/adapters.py` — production, ONNX, Transformers.js, GLiNER, Hugging Face, and Presidio adapters.
- `src/pii_bench/metrics.py` — leak, utility, slice, confidence-interval, calibration, and Pareto metrics.
- `extension_adapter.cjs` — bridge to the actual shipped regex/vector implementation.
- `transformers_js_adapter.mjs` — browser-runtime inference bridge.
- `PROTOCOL.md` — preregistered staged evaluation and release gates.
- `SOURCES.md` — scope, dataset, candidate, and licence provenance.
- `evidence/` — compact reviewed scorecards; never raw private inputs.

## Security rules

- Repositories and model revisions must be immutable commit hashes.
- No PyTorch pickle/state-dict artifact may ship. Hugging Face token adapters require safetensors; deployable ONNX is loaded as data. Pinned GLiNER research controls run only when the installed loader visibly enforces `torch.load(..., weights_only=True)`, and still require safe-format conversion plus re-evaluation before release.
- Remote model code is disabled by default and is not release-eligible.
- Runtime inference must work offline. Presidio is forced to its bundled public-suffix snapshot.
- Model licences and distribution rights are hard gates, not scoring tie-breakers.
- Synthetic results are comparative evidence, not a guarantee that arbitrary real-world PII will be detected.
