# Local protection architecture: delivery contract

Status: target architecture, not a claim that it is implemented or release-ready.
The end state is a supportable, commercially viable local PII/PSI architecture in
the live Chrome and Edge extensions. A benchmark win is not completion.

## Product boundaries

Protect against accidental disclosure before submission or upload. Keep raw
content on-device in local mode, including when models fail. Do not promise
complete protection, defence accreditation, or protection from a hostile site
already observing typing. Community and paid deployments must share the same
protection engine and safety fixes; commercial features must not be needed to
make the free engine safe.

The free default must operate on ordinary CPU-only hardware, without a mandatory
GPU, subscription, inference service or input telemetry. Measure the complete
download and runtime footprint, not just compressed model weights. Support and
update costs, model redistribution rights, accessibility and recovery are release
concerns alongside accuracy.

## Detector layers

1. Retain the shipped deterministic identifier rules as a mandatory floor. A
   contextual model cannot remove their detections. Preserve original offsets
   and combine spans before applying redactions once.
2. Add a compact contextual identifier/PSI detector only after independent
   evidence supports promotion. Distinguish an individual's sensitive attributes
   from general education, public policy and fictional discussions. Do not use a
   document-wide "not personal" classifier to suppress identifier rules.
3. Use specialist heads or a small ensemble only when paired tests demonstrate
   useful coverage gains within false-positive and resource budgets. Include the
   literal control; complexity and aggregate recall alone do not justify a model.
4. Enforce submission and upload controls independently of inference. Unsupported
   content, incomplete extraction and model failure must never become an
   affirmative "safe" result.

## Browser runtime contract

Use an extension-owned execution context, not a model instance per content tab.
Keep inference off page/main UI threads. Benchmark a bounded shared worker or
offscreen-context design against Manifest V3 suspension, memory limits and
concurrent tabs before selecting its final lifecycle implementation.

- Package executable code with the extension. Bind approved model/tokenizer/
  runtime/label-map versions together with immutable hashes. Do not execute model
  repository code or fetch inference code from a CDN.
- Verify downloaded data artifacts before atomic activation; keep the last
  verified version until an update passes integrity and startup self-tests.
- Bound input size, queue depth, working buffers and idle residency. Apply token
  overflow windows with overlap to **all** input; do not silently truncate or skip
  short/long text. Test Unicode codepoint/UTF-16 and tokenizer offset parity.
- Tag each request with a content revision and tab ownership. Ignore stale
  results, cancel superseded work and release tensors. A timeout must not leave
  unbounded background inference or permit the stale scan to authorise a send.
- Represent ready, downloading, degraded, failed and scanning states explicitly.
  Return completed coverage and detector status with matches. Zero matches with
  incomplete coverage is not a clean scan.
- Recovery must be usable without technical knowledge: explain what remains
  protected, offer retry/repair, and retain text without disclosing it in logs.
  Organisations requiring contextual coverage must be able to block sending
  until that coverage is restored. Do not silently switch them to rules-only.
- Local mode must not escalate to hosted/cloud inference on failure. Existing
  separately configured remote providers remain a distinct, explicit policy path.

These are target requirements. The current auto pipeline still has short/long
text AI exclusions and optional remote routing, so integration must address those
behaviours rather than claiming that the research runner has fixed production.

## Evidence required to finish

The [evaluation protocol](benchmarks/pii-models/PROTOCOL.md) specifies the safety,
utility, support, privacy and browser performance gates. The executable
`pii-bench release-check` blocks missing evidence and failed gates; even a pass
only makes a candidate eligible for human release review.

Delivery order:

1. Strengthen calibration, independent label coverage and release evidence.
2. Train contextual improvements against diverse person/public counterfactuals;
   reserve new source/grammar holdouts before tuning. Expand health, legal,
   safeguarding and child coverage beyond the four externally labelled classes.
3. Reduce and verify the browser inference runtime. The current tiny model's
   Node/WASM RSS remains above budget; investigate operator-reduced builds and
   exact Chrome/Edge measurements. Browser flags are not an end-user remedy.
4. Implement the shared local runtime and explicit coverage/failure contract,
   initially behind a non-default research switch with no production claims.
5. Exercise the exact packaged architecture on low-spec devices in both browsers:
   offsets, long inputs, corrupt cache, cancellation, tab races, offline recovery,
   sleep/restart, accessibility and upload/submission behaviour.
6. Complete independent and human-adjudicated evaluation, then a consented pilot
   and staged rollout with rollback. Operational diagnostics must exclude raw
   input, entity text and reversible content hashes.

Completion requires the tested architecture in both live extension packages,
verified release evidence, honest user-facing limitations, recovery documentation
and a sustainable update path. No current research candidate meets that contract.
