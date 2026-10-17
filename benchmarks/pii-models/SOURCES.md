# Benchmark sources and provenance

Sources were reviewed on 17 October 2026. Model and dataset licences must be rechecked at the pinned revision before distribution; a model-card licence tag is not a substitute for legal review.

## Scope and synthetic-value safety

- [OAIC — What is personal information?](https://www.oaic.gov.au/privacy/your-privacy-rights/your-personal-information/what-is-personal-information) informs the benchmark's direct and sensitive-information scope.
- [ACMA — Phone numbers for creative works](https://www.acma.gov.au/phone-numbers-use-tv-shows-films-and-creative-works) supplies fictional Australian phone ranges used by the generator.
- `example.com` and documentation IP ranges are used for synthetic network identifiers. Government, health, financial, and organisation identifiers are deliberately invalid or reserved-looking test values.

## Candidate model sources

- [Masker Mini](https://huggingface.co/divergentlabs/masker-mini) — Apache-2.0; 35.4M parameters; published INT4 ONNX artifact.
- [Rampart](https://huggingface.co/nationaldesignstudio/rampart) — CC-BY-4.0; browser-native quantized ONNX detector.
- [Gravitee BERT Small PII](https://huggingface.co/gravitee-io/bert-small-pii-detection) and its [ONNX conversion](https://huggingface.co/onnx-community/bert-small-pii-detection-ONNX) — Apache-2.0.
- [DataFog PII EN 65M](https://huggingface.co/DataFog/pii-en-65m) — Apache-2.0; standard token-classification control with a narrow taxonomy.
- [DataFog PII EN 71M](https://huggingface.co/DataFog/pii-en-71m) — broad taxonomy, screened out because its pinned custom architecture is not reproducibly implemented in the repository.
- [AI4Privacy English anonymiser](https://huggingface.co/ai4privacy/llama-ai4privacy-english-anonymiser-openpii) — MIT.
- [Piiranha v1](https://huggingface.co/iiiorg/piiranha-v1-detect-personal-information) — CC-BY-NC-ND-4.0; research control only, not distributable in the extension.
- [NVIDIA GLiNER PII](https://huggingface.co/nvidia/gliner-PII) — NVIDIA Open Model License; accuracy control requiring licence review.
- [Knowledgator GLiNER PII collection](https://huggingface.co/collections/knowledgator/gliner-pii) — Apache-2.0 edge/small open-label controls.
- [Vicgalle GLiNER Small PII](https://huggingface.co/vicgalle/gliner-small-pii) — Apache-2.0 accuracy control.
- [Gretel GLiNER Bi Small](https://huggingface.co/gretelai/gretel-gliner-bi-small-v1.0) — Apache-2.0 accuracy control.
- [Scotoma Small](https://huggingface.co/DJLougen/scotoma-small) — Apache-2.0 quantized clinical PHI ONNX control.
- [Microsoft Presidio](https://github.com/microsoft/presidio) — MIT classical rules-plus-NER control.
- [dslim BERT Base NER](https://huggingface.co/dslim/bert-base-NER) — Apache-2.0 generic-NER control.
- [Perplexity PII Masking](https://huggingface.co/perplexity-ai/pplx-pii-masking) — MIT accuracy control, screened out of release consideration because it requires custom remote code and is far outside the browser resource envelope.
- [OpenMed Privacy Filter Nemotron v2](https://huggingface.co/OpenMed/privacy-filter-nemotron-v2) — Apache-2.0 high-capacity health-domain control, outside the default extension resource envelope.
- [Desert Ant Redact](https://huggingface.co/desert-ant-labs/redact) — current source-available LiteRT distribution; screened out pending licence review and a dedicated safe LiteRT adapter. The harness does not fall back to its pickle-only PyTorch weights.

## External validation datasets

- [NVIDIA Nemotron-PII](https://huggingface.co/datasets/nvidia/Nemotron-PII) — 100,000 synthetic records, broad PII/PHI taxonomy, CC-BY-4.0.
- [Gretel PII Masking English v1](https://huggingface.co/datasets/gretelai/gretel-pii-masking-en-v1) — synthetic English PII masking corpus, Apache-2.0.
- [OpenPII 1.5M](https://huggingface.co/datasets/ai4privacy/pii-masking-openpii-1.5m) — large multilingual synthetic corpus, CC-BY-4.0; download size and possible candidate-training overlap require controlled sampling and explicit disclosure.
- [PII Masking Benchmark](https://huggingface.co/datasets/piimb/pii-masking-benchmark) — unified benchmark with non-commercial licensing; research comparison only unless legal review approves the intended use.

Synthetic and public benchmarks can share templates or training lineage with evaluated models. Final assurance therefore requires a separately governed, manually adjudicated Australian holdout that no candidate developer has seen.

## Specialist fine-tuning source

[Google BERT Miniatures 2/128](https://huggingface.co/google/bert_uncased_L-2_H-128_A-2) is an Apache-2.0 pretrained encoder, pinned to revision `30b0a37ccaaa32f332884b96992754e246e48c5f`. The research trial replaces its classifier, fine-tunes 4,373,407 parameters, and exports safe ONNX artifacts. Pretrained encoder authors: Iulia Turc, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova, *Well-Read Students Learn Better: On the Importance of Pre-training Compact Models* (2019).

The contextual fine-tuning source is NVIDIA Nemotron-PII, revision `b70ffaf5ff39e079776134c5bf4381f00a9fd1ed`, CC-BY-4.0. Its published train/test shards each contain 100,000 records at this revision. Four explicit source labels are mapped to the specialist taxonomy; the original authored curriculum supplies the remaining categories. Derived weights and lexical artifacts must retain NVIDIA attribution and identify the modifications. No benchmark test split is used for training.
