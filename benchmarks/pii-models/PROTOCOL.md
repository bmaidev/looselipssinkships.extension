# PII/PSI model evaluation protocol

Version 1.0 — 17 October 2026

## Decision question

Which fully local architecture gives the safest practical coverage of Australian personal information and sensitive information in a Chrome/Edge extension, while remaining fast, small, offline, redistributable, and usable on ordinary community-sector hardware?

The possible outcome is not limited to one model. Evaluated architectures include deterministic rules alone, one model, rules plus a model, and thresholded multi-model unions. The production rules remain a mandatory floor unless a replacement is separately proven to dominate them on every shipped identifier family.

## Threat and scope model

The target is accidental disclosure before text leaves the browser. The protected scope includes direct identifiers, quasi-identifiers, credentials, financial and health identifiers, and contextual sensitive information such as health, disability, racial or ethnic origin, religious or political association, trade-union association, sexual orientation, criminal records, victim/safeguarding status, financial hardship, income, and child status.

This benchmark does not prove protection against hostile pages observing keystrokes, novel identifiers outside the taxonomy, image-only content, adversarial Unicode beyond represented corruptions, or mistakes introduced after redaction. File and browser integration tests remain separate release gates.

## Corpus design

The primary corpus is generated from reviewed templates with exact character offsets. It has no scraped or real personal information.

- Scale: 20,000 documents and 55,706 entities.
- Labels: 44 across 16 risk families.
- Positives/negatives: 16,800 positive and 3,200 hard-negative documents.
- Sensitive slice: 7,956 documents.
- Formats: plain text, log, JSON, CSV, and Markdown.
- Stressors: case changes, spacing, OCR substitutions, Unicode confusables, zero-width characters, inserted line breaks, long-window boundaries, multilingual names, and code-switching.
- Domains: 28 community, health, legal, finance, government, HR, cybersecurity, support, and ordinary non-PII domains.

The immutable corpus identity is seed `20261017`, generator `2026.10.17.2`, and SHA-256 `58d9d81c9c9a0b42c322426bb77638af61b51a023cfb81101588951d0fbbabe6`.

Normalized text groups are deterministically assigned by `sha256-normalized-text-v2` to a calibration partition (3,726 records) and a test partition (16,274 records). Identical case/whitespace-normalized texts cannot cross partitions. A diversity audit found 16,075 unique normalized texts and 3,925 repeated records; uncertainty intervals resample document/text clusters rather than treating every repetition as independent. The older record-ID split had 225 crossing text groups and is retained only through an explicit legacy replay flag. Historical smoke tables use that legacy split and remain exploratory. Thresholds, label prompts, and ensemble membership may be chosen on calibration data only. A test result is invalid for confirmatory comparison if its held-out result influenced another tuning decision; such work must be labelled exploratory and repeated on a new sealed corpus version.

## Staged process

### Stage 0 — governance and supply chain

A candidate is screened before inference:

1. Record the repository, immutable revision, licence, expected artifact, and claimed label scope.
2. Reject unreviewed remote code, ambiguous redistribution rights, network-dependent inference, or missing executable model definitions. Pickle/state-dict files are never release artifacts; a pinned accuracy control may be evaluated only in an isolated environment with a verified weights-only loader, then must be converted and re-evaluated in a safe deployable format before release consideration.
3. Record exceptions as screened-out evidence; do not silently omit them.

### Stage 1 — 500-document engineering smoke test

Run all plausible candidates on the same deterministic smoke corpus. This stage detects broken offsets, label-map errors, unusable latency/memory, catastrophic over-redaction, and candidates dominated by smaller alternatives. It is exploratory and cannot authorise shipping.

### Stage 2 — full 20,000-document synthetic evaluation

Advance the deployable Pareto set and at least one accuracy ceiling. Lock thresholds on the 3,726-record calibration set, then score the 16,274 test records with 1,000 document-cluster bootstrap rounds. Preserve prediction hashes, hardware/runtime profile, model revision, and the selected threshold. The current smoke and full corpora share their generator and seed, and can share texts; the expansion is exploratory rather than an independent confirmatory holdout. Independent external source splits and phrase/template-disjoint specialist tests provide separate transfer checks.

### Stage 3 — external and human validation

Evaluate without training on held-out subsets from compatible licensed corpora, including NVIDIA Nemotron-PII, Gretel PII masking, and OpenPII where licence and provenance permit. Map labels explicitly and report unmapped categories. Add a manually adjudicated Australian community-sector set created under an ethics/privacy process; never place genuine client data in this repository.

### Stage 4 — browser integration and soak

Test the exact packaged ONNX/WebGPU/WASM artifact in current Chrome and Edge on low-, middle-, and high-spec reference devices. Measure model download/install recovery, cold/warm startup, p50/p95/p99 latency by text length, peak memory, CPU utilisation, cancellation, concurrent tabs, service-worker suspension, offline operation, and corrupt-cache recovery.

## Primary metrics

- Risk-weighted character recall and leak rate. Risk weights are fixed in `taxonomy.py` before evaluation.
- Whole-document protection rate: every gold character must be covered.
- Per-label and per-family character recall, especially risk-5 categories.
- Hard-negative clean-document rate and non-PII character over-redaction.
- Exact and overlap entity precision/recall/F1, typed and untyped.
- p50/p95 latency, characters per second, cold start, peak RSS, and artifact size.
- Slice results for each corruption, format, domain, PSI, long document, multilingual text, and hard negatives.

Character spans are the safety unit because partially redacting an identifier can still leak it. Entity F1 is diagnostic, not the selection objective.

## Calibration objective

The default threshold objective is maximum risk-weighted recall subject to no more than 2% non-PII character over-redaction on calibration data. Ties prefer whole-document protection, character precision, then the more conservative threshold. Ensemble grids are capped at 10,000 combinations.

The 2% limit is an engineering starting point. Product research with community-sector users may tighten it, but a relaxed gate requires an explicit protocol revision before inspecting held-out results.

## Release gates

Targets for a default, fail-safe local detector are deliberately demanding:

- Risk-weighted recall lower 95% confidence bound at least 99.5%.
- Each risk-5 family recall lower bound at least 99%.
- Whole-document protection lower bound at least 98%.
- Over-redaction upper 95% bound no more than 2% and hard-negative clean-document rate at least 98%.
- Warm p95 at most 50 ms per representative short document and cold start at most 2 seconds on the low-spec reference device.
- Default downloaded artifact at most 100 MB and stable peak extension memory at most 512 MB; an optional enhanced pack may exceed these only with informed consent and graceful fallback.
- Offline inference, no input telemetry, no remote code, safe model serialization, immutable hashes, acceptable redistribution licence, and Chrome/Edge parity.

No smoke-stage candidate currently satisfies these safety gates. Until one does, the extension must describe local detection as risk reduction, retain layered submission/upload controls, and avoid claims of guaranteed or defence-equivalent protection.

## Statistical reporting

- Use document/text-cluster bootstrap intervals with a fixed recorded seed. A paired bootstrap of differences is required before claiming small candidate-to-candidate improvements; the `compare` command resamples identical clusters for both candidates.
- Report absolute values and confidence intervals, not only rankings.
- Report every predefined family and stress slice, including zero-recall failures.
- Do not infer statistical significance from overlapping or non-overlapping per-run intervals alone; calculate a paired interval for the difference.
- Do not merge calibration and test scores.
- Preserve failures and screened-out candidates to reduce survivorship bias.
- Run at least three timed repetitions for finalists on each browser/device; report medians and worst observed p95/p99.

## Reproducibility record

Every retained result must include source commit, candidate commit, corpus SHA-256, prediction SHA-256, dependency lock, OS/architecture, CPU count, runtime versions, artifact size/hash, thresholds, partition, warmup count, and commands. Raw predictions and model files stay outside git because they are large; reviewed aggregate scorecards may be committed under `evidence/`.
