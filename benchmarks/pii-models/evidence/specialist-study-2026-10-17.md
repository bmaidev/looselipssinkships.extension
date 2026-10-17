# Local specialist training study — 17 October 2026

Decision: continue with a layered architecture and pretrained compact specialist heads. The prototypes improve coverage, but none passes the release gates. They remain isolated from the shipped extension.

## What was delivered

- A governed 20-candidate matrix; 11 detectors and the two production baselines were executed in the initial smoke stage. Three candidates were screened out and four larger variants deferred with reasons recorded.
- A 20,000-record Australian PII/PSI corpus with 44 labels, exact offsets, corruption/format/domain slices, diversity auditing, content-grouped splits, and document-cluster confidence intervals.
- Three actual training runs: a byte-CNN trained from scratch, that head fine-tuned on external synthetic data, and a small pretrained BERT encoder fine-tuned with a new 31-tag classifier.
- Safe model serialization, ONNX export/parity checks, INT8 quantization, a training-only lexical control, cached ensemble calibration, paired cluster comparisons, and native/WASM transfer tests.
- Reproducible code, dependency snapshots, source attribution, hashes, and local trained artifacts under `generated/`.

## Training and test separation

The authored curriculum contains 5,772 unique training records, 292 calibration records, and 288 test records. Its phrases, names, and sentence templates are separately partitioned. The first byte-CNN experiment trained only on that curriculum and failed to generalize.

The augmented curriculum contains 9,772 training records: the authored 5,772 plus 4,000 windows from NVIDIA Nemotron-PII's training shard. Its 1,792 calibration records comprise 292 authored records plus 1,500 windows from separate source document IDs. The external source supplies four explicit sensitive labels: race/ethnicity, religion, political views, and sexuality. It does not supply the required health-condition, legal, safeguarding, or trade-union labels.

External source revision: `b70ffaf5ff39e079776134c5bf4381f00a9fd1ed`, CC-BY-4.0, authored by NVIDIA. The importer checks span offsets, groups variants by source UID, removes duplicate texts/windows, and rejects test UIDs also present in source training.

The initial 1,500 external evaluation records informed the decision to try a pretrained encoder and a lexical control. Those discovery results are exploratory. A fresh 1,500-record confirmation sample excludes every source UID in the discovery sample; 2,984 source rows were excluded by that reservation. No model checkpoint, confidence threshold, or ensemble membership was changed after reading confirmation results.

The confirmation sample has 977 positive and 523 negative records, 1,231 sensitive spans, and 1,482 source-document bootstrap clusters. It contains only the four explicitly mapped external categories. Results on it do not establish coverage of the other 40 benchmark labels.

The augmented training data contains two exact values from the authored test, `biromantic` and `Seventh-day Adventist`. Consequently, the augmented models' authored test is template/name-disjoint but not entirely phrase-disjoint. That limitation does not apply to the authored-only first trial.

## Training results

| Experiment | Parameters | Training | Checkpoint selection | Outcome |
|---|---:|---|---|---|
| Byte-CNN from scratch | 90,839 | 8 CPU epochs, authored curriculum | Minimum calibration loss; epoch 1 | 1.59% recall on authored unseen phrases; 0.17% on external discovery. Rejected. |
| Byte-CNN fine-tune | 90,839 | 6 CPU epochs, augmented curriculum | Minimum calibration loss; epoch 2 | Useful complementary signal, weak standalone coverage. |
| Pretrained BERT fine-tune | 4,373,407 | 4 CPU epochs, augmented curriculum | Minimum calibration loss; epoch 2 | Strongest trained single specialist. |

The BERT parent is [Google BERT Miniatures 2/128](https://huggingface.co/google/bert_uncased_L-2_H-128_A-2), Apache-2.0, revision `30b0a37ccaaa32f332884b96992754e246e48c5f`. Fine-tuning uses AdamW, learning rate 0.0003, batch size 64, weight decay 0.01, gradient clipping 1.0, seed 20261018, 256-token windows with a 64-token stride, and inverse-square-root-frequency weighted cross-entropy. The classifier is initialized anew and the complete encoder is fine-tuned.

The float graph is 17,551,021 bytes. Dynamic INT8 MatMul/Gather quantization reduces it to 4,480,401 bytes. Calibration recall changes from 88.210% to 88.176%, with over-redaction 0.530%. Model plus tokenizer/config/provenance files total 5,200,833 bytes before the runtime; the stable WASM runtime itself adds roughly 14 MB.

## Confirmation results: four external sensitive categories

All thresholds were locked on calibration data. The individual neural heads use 0.10; the dictionary uses exact training values. The ensemble applies those thresholds before taking the union.

| Detector | Weighted character recall | Fully protected positive documents | Non-PII character over-redaction | Clean negative documents | Native p95 |
|---|---:|---:|---:|---:|---:|
| Training-only literal control, 763 entries | 91.07% | 89.46% | 0.566% | 96.18% | 0.55 ms |
| Fine-tuned byte-CNN, 0.37 MB | 56.47% | 48.00% | 0.167% | 94.65% | 1.08 ms |
| Fine-tuned BERT INT8, 4.48 MB | 93.75% | 84.24% | 0.559% | 90.44% | 1.12 ms |
| Dictionary + byte-CNN + BERT INT8 | 98.25% | 95.91% | 1.162% | 84.13% | 2.71 ms estimated serial |

The ensemble's recall interval is 97.54–98.95% using 1,000 source-document cluster bootstrap rounds. Its paired improvement over the literal control is 7.19 percentage points, with a 95% interval of 5.39–9.17 points. The paired over-redaction cost is 0.595 points, interval 0.517–0.672 points. These are meaningful coverage gains with a measurable utility cost.

The dictionary result is essential: much of this external corpus can be solved by recurring sensitive values. A neural result must beat that simple control and demonstrate useful transfer before its complexity is justified.

## Hard-negative and broad-category transfer

On the authored 288-record test, the fine-tuned BERT reaches 91.58% recall and 75.96% full-document protection, but over-redacts 11.60% of non-PII characters. Its clean-negative rate is 78.10%. These negatives include general educational/public mentions of sensitive topics. This failure is a release blocker even though the external four-category scores are high.

The corrected 20,000-record Australian corpus uses content-grouped partitions: 3,726 calibration and 16,274 test records. It has 16,075 unique normalized texts; identical text groups cannot cross partitions. The test partition has 12,895 text clusters. Shared grammar and historical smoke overlap mean this corpus is exploratory.

| Configuration | Weighted recall | Fully protected positive documents | Over-redaction | Clean negative documents |
|---|---:|---:|---:|---:|
| Production hybrid rules + Masker Mini | 53.65% | 23.56% | 1.716% | 57.14% |
| Same baseline + all specialist outputs at 0.10 | 69.52% | 30.80% | 2.423% | 42.86% |
| Same baseline + specialist threshold 0.70, selected on calibration under a 2% over-redaction limit | 57.27% | 26.20% | 1.871% | 50.00% |

The budgeted configuration's recall interval is 56.72–57.87%. The high-coverage configuration's interval is 68.99–70.01%. The strict utility budget retains a smaller gain; neither option protects enough complete documents to ship as a comprehensive PII/PSI control.

The corrected baseline has roughly 24.5 ms p95 and 771 ms p99 latency. Long-document tail cost matters: p95 alone concealed it. Cached ensemble timings sum component timings and are estimates rather than integrated browser measurements; unknown member memory is reported as unknown.

## Browser runtime findings

The float ONNX graph matches native ONNX in the browser WASM backend across token lengths 1, 16, 37, and 256, including a padded batch. Maximum logit difference is approximately 0.000003. Its model-only 256-token WASM p95 was about 8.6 ms in this run.

The INT8 graph executes in both development and stable WASM runtimes but fails the strict 0.001 logit-parity tolerance. Its actual confirmation-set recall is 93.62% in stable WASM versus 93.75% in native ONNX, with 0.555% over-redaction and roughly 3.7 ms p95. This is measured transfer evidence, not numerical identity.

Native INT8 peak process RSS is roughly 84 MB. Stable WASM process RSS peaks around 534 MB. Explicit tensor disposal and disabling CPU arena/memory-pattern caching did not materially reduce that peak. Final JS heap use was small, so reporting only JS heap size would conceal the process cost. The WASM test runs the browser backend under Node with tokenizer windows prepared by the pinned Python/Rust tokenizer; actual Chrome/Edge integration, JavaScript tokenizer parity, and device memory measurements remain required.

The byte-CNN JavaScript bridge matches Python on Unicode, emoji-prefix, public-mention, and long-window cases. That bridge uses native Node ONNX and is a separate check from the BERT WASM tests.

## Harness defects found and corrected

- The original record-ID split allowed 225 normalized text groups to cross calibration/test. The default now groups by normalized text; explicit legacy replay remains available.
- Repeated records previously narrowed uncertainty artificially. Bootstrap resampling now uses source-document/text clusters, and paired comparisons resample the same clusters for both runs.
- 4,420 of Masker's 24,420 character chunks exceeded 256 tokens. Direct ONNX adapters now visit overlapping token overflow windows; the full Masker run was repeated after the fix. Earlier smoke ONNX numbers remain provisional.
- The production bridge now converts UTF-16 offsets to Python code-point offsets, with an emoji-prefix regression case.
- Prediction scoring verifies dataset hashes; ensemble inputs reject duplicate record IDs; reports reject mixed dataset/partition schemes.
- A zero-byte baseline artifact is no longer treated as unknown/infinite size in Pareto analysis.
- Presidio is pinned to the small spaCy model and its bundled public-suffix snapshot, preventing inference-time suffix-list downloads.

## Artifacts and hashes

Locally retained models, data, and raw predictions are under `benchmarks/pii-models/generated/` and are intentionally excluded from git. The compact aggregate evidence and source code are tracked. Reproduction commands are in the benchmark README.

| Artifact | SHA-256 |
|---|---|
| Authored-only byte head safetensors | `b6b412dc32690da88a987f5259d91d8b1879be8ccd8b77761039faf36068a941` |
| Fine-tuned byte head safetensors | `de7386aca1b32daaaba63d4b21c4a3d7099554ebb681171f2f7be8e2cd7ff912` |
| Fine-tuned BERT safetensors | `1f1c47553b0a6edbb14aaa41159a9ad6bf5a3952c4e90ea0e4270d02d72ced40` |
| BERT INT8 ONNX | `9fb9a8357bc0ce4634f5f4f30165019fb859595baece0ef0d04c90e1561f4718` |
| Augmented training corpus | `0bacdcc29a2adaad4a4c46f777cd05da54c3a045b375cc752e5deb61399fcfd8` |
| Augmented calibration corpus | `59f167aa86dd6bdef268ff1135667dd9b6fc5c8b6e3255436e4786570a8d0105` |
| Reserved external confirmation corpus | `0d120dca04050752ac3475472f9156f8f7067ee1bfa55f582c2f84ef2a2410db` |
| Corrected full Masker predictions | `664b9563bba0d59b9ad8fa3157e85dca799d4bc34ba819ef6e18a77968ee95b9` |

## Next engineering work

1. Add substantially broader, independently reviewed health, legal, safeguarding, financial-hardship, child-status, and association examples. Include private/public, hypothetical, negated, quoted, historical, and third-person counterfactual pairs.
2. Expand independent hard-negative grammar families rather than multiplying a small fixed set of texts. Preserve document/source grouping and reserve a fresh holdout before each adaptive experiment.
3. Train the compact pretrained specialist with those data and test category-specific thresholds and agreement gates on calibration only. Use a stronger teacher only with clear data/model licensing and no real client inputs.
4. Reduce browser runtime memory, then verify the exact tokenizer and graph in Chrome and Edge on low-spec hardware. Include cancellation, concurrent tabs, cold/warm startup, service-worker suspension, offline recovery, and long-document p99.
5. Require the release gates to pass before enabling the specialist for users. The present research does not establish complete protection or equivalence to a defence deployment.
