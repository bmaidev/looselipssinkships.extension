# Contextual PSI training: counterfactual transfer study

17 October 2026. Both new candidates remain research-only and are **rejected for
release**. The production Chrome/Edge detector is unchanged.

## Question and design

Can a more diverse person/public curriculum improve the tiny contextual detector
without a larger default download? Does a category-agnostic sensitive-span head
generalise better than a 31-label BIO head?

The authored v2 curriculum covers all 15 research PSI labels. Identical attribute
vocabulary occurs in paired personal and public sentences; names occur in both
and are unscored. Half the positive examples mix a public and personal mention
of the same attribute, in either order; only the personal occurrence is gold.
Person-specific denials, historical disclosures and public self-disclosures remain
sensitive under the conservative annotation policy. General educational,
dictionary, policy and fictional references are negatives.

The authored banks have 16 personal/public templates each for training, six each
for calibration and six each for test. Values and names are separated across
authored banks before rendering. This is broader than v1 but still a small,
shared-author synthetic grammar, **not independent human validation**. There are
only 60 source-pair clusters per label in test, below release support requirements.

| Partition | Records | Negatives | Composition |
| --- | --- | --- | --- |
| Train | 16,000 | 7,575 | 12,000 authored + 4,000 external |
| Calibration | 3,300 | 1,479 | 1,800 authored + 1,500 external |
| New test | 1,800 | 900 | Authored only; 900 counterfactual pairs |
| Regression | 1,500 | 523 | Previously viewed four-category external confirmation |

External rows come from the same pinned, CC-BY-4.0 NVIDIA Nemotron source as the
earlier study. Its test shard is not loaded into training or calibration. New
generation rejects duplicate normalized text and cross-partition source IDs,
verifies parent file hashes, and refuses existing corpus destinations. The tiny
trainer now independently checks normalized-text leakage as well as source IDs.

The combined training set is **not entirely phrase-disjoint**: exact whole-phrase
audit finds `levothyroxine` once (new test vocabulary), and `bisexual` 30 times
and `lesbian` 31 times (new calibration vocabulary). These occur in the external
rows. A naive substring audit also matched `Romani` inside longer words; a
word-boundary audit does not count those as exact exposures. No identical new
test text or source pair crosses partitions. Pretraining exposure is unknown.

## Candidates and locked analysis

All use the pinned Google BERT Tiny encoder from the earlier study. Both new
models train from that parent, not from a checkpoint tuned on the new test.
Four CPU epochs, two threads, seed 20261018, AdamW 0.0003, batch 64, inverse-sqrt
class weights, 256-token windows/64-token overlap. Minimum calibration token loss
selects the checkpoint. More training reduces training loss while worsening
calibration loss; later checkpoints are not promoted.

| Candidate | Parameters | Selected epoch | Training time | INT8 graph |
| --- | --- | --- | --- | --- |
| Previous typed control | 4,373,407 | 2, earlier curriculum | Earlier study | 4,480,401 bytes |
| Counterfactual typed | 4,373,407 | 2 | 110.33 s | 4,480,401 bytes |
| Counterfactual agnostic | 4,369,795 | 1 | 110.29 s | 4,476,704 bytes |

The agnostic head has `O/B-OTHER_PII/I-OTHER_PII` outputs; it protects sensitive
spans without claiming a specific category. It cannot provide category-specific
toggles or typed metrics comparable to the 31-tag models. It does **not** reduce
the gold taxonomy or release requirements. Its changed class-frequency loss
weights are an inherent consequence of the collapsed target space, so this is
not an isolated head-size-only ablation.

`context_study.py` evaluates all three candidates on calibration, locks the
candidate/tokenizer hashes, threshold grid and operating points to disk, then
opens the test data for inference. Primary thresholds maximise recall under both
2% character over-redaction and 98% clean negative-document constraints. Locked
thresholds are 0.90 (control), 0.95 (new typed), 0.90 (agnostic). A separate fixed
0.10 operating point is explicitly diagnostic, not release-eligible. No test
result changes these choices. Paired intervals use 1,000 source-pair/document
cluster resamples, seed 20261017.

## New holdout results

| Candidate / operating point | Weighted recall | Whole-document protection | Clean negatives | Over-redaction |
| --- | --- | --- | --- | --- |
| Control, diagnostic 0.10 | 40.57% | 19.22% | 35.00% | 6.17% |
| New typed, diagnostic 0.10 | 50.65% | 20.56% | 58.00% | 4.03% |
| Agnostic, diagnostic 0.10 | 43.62% | 21.11% | 45.44% | 5.23% |
| Control, primary 0.90 | 0% | 0% | 100% | 0% |
| New typed, primary 0.95 | 0% | 0% | 99.56% | 0.045% |
| Agnostic, primary 0.90 | 7.53% | 8.67% | 86.22% | 0.883% |

The diagnostic new-typed recall improvement is **+10.07 percentage points**
(paired 95% interval **+6.97 to +13.70 points**). Over-redaction drops 2.14 points
(paired interval −2.59 to −1.68). Whole-document protection improvement is not
resolved by the paired interval (−1.33 to +4.11 points). These intervals account
for paired text/source reuse, not shared grammar/authorship dependence.

The primary result is the decisive failure: calibration thresholds do not
transfer to the new phrasing/values. Both typed models protect **none** of the
new sensitive spans at their utility-constrained thresholds. The agnostic head
retains little recall and fails cleanliness. Increasing a threshold to suppress
false positives is not an acceptable safety solution.

Per-label results are retained in the machine evidence, including zero full-entity
protection for several classes at diagnostic 0.10. For the new typed model,
mental-health character recall is only 19.41%, medication 26.56%, hardship 25.99%
and child status 34.43%. This is not a generally safe PSI detector.

## Previously viewed external regression

At fixed diagnostic 0.10, the control has 93.75% weighted recall and 90.44% clean
negatives. New typed has 93.94% recall and 91.97% clean negatives, with
over-redaction reduced from 0.559% to 0.419%. The paired recall difference is
unresolved (−0.70 to +1.02 percentage points), while whole-document protection
improves 2.97 points (interval +1.44 to +4.69).

The agnostic head falls to 90.44% recall: a regression of 3.32 points (paired
interval −4.58 to −2.00). It is not an improvement over the typed approach here.
This set has already influenced earlier research and is a regression check, not
a fresh confirmation claim. Native CPU timings/RSS are retained for debugging,
not represented as packaged-browser performance or isolated comparative timings.

## Evidence, reproducibility and next decision

Complete aggregates, all calibration grid rows, hashes, per-label/family/slice
results and paired intervals are in
[`context-results-2026-10-17.json`](context-results-2026-10-17.json).

- Locked plan SHA-256: `8ce1e21841767d09c14d29936b419b975b0434f438264a7915e62869dcb45efc`.
- Raw study SHA-256: `269d9babb8e36a4a76a77f59fd89a4f1e9f6858986eb80ae75d153ae0daaaddb`.
- Train/calibration/test SHA-256 values are retained in the manifest and machine evidence.
- Generated model folders retain safe weights, export verification and trainer source
  snapshots. Original/agnostic trainer hashes are respectively
  `34907324bb7106cd4fa91f070599e694ea93eca8405acf9c67907fb08cb913d0` and
  `ce4ef5a92a704e9b3d4059ca19f5511f03267fa11886211c64cef4de6f02f50d`.
- Root and benchmark dependency locks are unchanged; use the recorded macOS arm64
  environment lock for this research run.

Neither custom head qualifies for release or replaces the existing detector.
The data change helps at a permissive diagnostic point, but the tiny encoder's
semantic/boundary generalisation and span confidence remain inadequate. Next
compare a stronger compact pretrained encoder and structured/span-boundary
decoding, while retaining this failed head experiment. Future iterations may use
this set only as exploratory regression data; promotion still requires a fresh
holdout, broader PII coverage, independent/human evidence, and exact-package
browser/resource/privacy verification. The runtime memory blocker is unchanged.

Prediction metadata no longer automatically labels derived weights with the
repository licence. It records pending derived-artifact review and hashes the
graph/tokenizer; base-model and training-data rights require explicit review
before commercial or community redistribution.
