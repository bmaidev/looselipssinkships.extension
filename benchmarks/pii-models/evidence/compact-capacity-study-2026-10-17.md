# Compact encoder capacity study — 17 October 2026

Decision: **reject for release**. No model replacement in either extension.
The larger model improves one difficult regression set but loses recall on
another and fails the safety/utility combination. This is not near-qualification.

[Full evidence](compact-capacity-results-2026-10-17.json) includes the
[pre-training plan](compact-capacity-plan-2026-10-17.json), all calibration rows,
training history, checkpoint choice, exact hashes, per-label results and paired
1,000-round cluster intervals. All evaluated test sets were previously viewed;
this is exploratory regression, **not independent confirmation**.

## Controlled change

Compare the previous typed BERT-Tiny v2 with an 11,112,735-parameter BERT-Mini.
Google's [model card](https://huggingface.co/google/bert_uncased_L-4_H-256_A-4)
describes the compact English uncased encoder family. The run pins the repository
to safetensors conversion commit `43ca9bbcdffc2f4220d09f6e4fc48c28bfffeede`
(upstream PR 2), uses `use_safetensors=True` and `trust_remote_code=False`, and
never loads the repository's pickle weights. Base safetensors SHA-256:
`a87bf8a95a0de735b9be59e3e00ad3ca365fcd331e0bc0265c8df44e4dbfb98a`.
Base Apache-2.0 metadata is not derived-artifact redistribution clearance.

Both models use the same 16,000-record contextual training curriculum, 3,300
calibration records, 15 PSI categories, typed BIO targets, overflow windows,
class weighting and fixed training recipe. Names are unscored. Mini trains four
epochs with AdamW at 0.0003, seed 20261018, batch 64, two CPU threads. The locked
recipe is a controlled comparison, not an optimised hyperparameter search for
Mini or a claim that the entire model family is incapable.

Observed Mini calibration losses: 0.18951, 0.20685, 0.22546, 0.25840. Select epoch
one by the predeclared minimum-calibration-loss rule, without using test scores.
Training took 532.96 seconds on an Apple M4, 24 GiB, macOS 26.2, CPU only. The
INT8 graph is 11,312,379 bytes; float ONNX is 44,540,902 bytes. Native float export
passed four length checks (1/16/128/256), maximum logit error 4.77e-6. This does
not establish quantized parity or browser performance: the exact INT8 artifact
is separately calibrated and evaluated below.

## Results

At fixed diagnostic threshold 0.1:

| Metric | Tiny v2 | Mini |
| --- | --- | --- |
| Authored contextual weighted recall | 50.65% | 60.19% |
| Authored full-document protection | 20.56% | 32.11% |
| Authored clean negatives | 58.00% | 58.33% |
| Authored non-PII over-redaction | 4.03% | 4.03% |
| External regression weighted recall | 93.94% | 88.30% |
| External full-document protection | 87.21% | 82.40% |
| External clean negatives | 91.97% | 96.18% |

Authored recall improves 9.54 percentage points (paired 95% interval +6.74 to
+12.04); full-document protection improves 11.56 points (+8.56 to +14.56).
External recall **regresses 5.63 points** (−7.51 to −3.81), with full-document
protection down 4.81 points (−7.22 to −2.29). These are materially different
trade-offs, not an overall safety win.

Calibration chooses 0.95 for Tiny and 0.99 for Mini to satisfy its <=2%
over-redaction and >=98% clean-negative point-estimate constraints. At those
operating points, both models have **zero recall on the authored test**; Mini
also has zero recall on the external regression. Utility feasibility is not
safety eligibility. Do not lower release gates or deploy the diagnostic point.

Mini's diagnostic mental-health character recall is only 37.45%, medication
50.49% and hardship 46.17%. Political attributes reach 85.55% character recall
but only 21.67% full-entity protection, illustrating the remaining boundary
problem. The authored set has only 60 source clusters per label and covers 15,
not all 44 required labels. The external set covers four PSI categories.

## Reproduction and retained limitations

Use [the recorded environment](../environment.macos-arm64.lock). From the
benchmark directory:

```sh
PYTHONPATH=src HF_HUB_DISABLE_TELEMETRY=1 .venv/bin/python -m pii_bench.tiny_finetune train \
  --encoder mini --epochs 4 --data-dir generated/data/psi-context-v2 \
  --output-dir generated/models/psi-context-mini-v1
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune export \
  --model-dir generated/models/psi-context-mini-v1
PYTHONPATH=src .venv/bin/python -m pii_bench.tiny_finetune quantize \
  --model-dir generated/models/psi-context-mini-v1 \
  --output-dir generated/models/psi-context-mini-v1-int8
PYTHONPATH=src .venv/bin/python -m pii_bench.context_study \
  --data generated/data/psi-context-v2 \
  --candidate tiny=generated/models/psi-context-tiny-v2-int8 \
  --candidate mini=generated/models/psi-context-mini-v1-int8 \
  --regression generated/data/psi-external-confirm-v4/test.jsonl \
  --output generated/evidence/compact-capacity-v2
```

Use fresh output directories. Final raw study SHA-256:
`a69bc490ffd1a143eaafa305973f26a28c58e849f68e004aaca50f70073c69e1`.
Evaluation-plan SHA-256:
`8de29eebbcc98e780006aad9e9fab602a1eb9917566498fccf031efc9c243ef1`.
The final study repeats the initial run after adding explicit per-candidate
thresholds and the bootstrap seed to paired-report metadata; measured metrics
and confidence intervals are unchanged. Historical paired `evaluation` remains
the first candidate's evaluation; use `minimum_scores` for both operating points.
No trained weights, raw predictions or inputs are committed or shipped.

Next model work should target more diverse person/public/boundary supervision
and calibration-only optimisation of span decoding/training, with a new sealed
holdout before any confirmatory comparison. More capacity alone is not enough
in this experiment. Independent/human validation, full taxonomy support, exact
Chrome/Edge package and worker testing, licences and operational privacy remain
mandatory; none are waived by this study.
