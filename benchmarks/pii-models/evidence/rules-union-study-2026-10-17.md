# Live detector composition and scan reporting: 2026-10-17

Status: production-source correctness improvements, not model qualification.
[Machine evidence](rules-union-results-2026-10-17.json) retains both rule runs,
cluster-bootstrap intervals and the coverage check. No model weights changed.

## Fixed failure mechanism

The rules, name heuristic, structured entity parser and pipeline previously
discarded overlapping matches. A detection that began earlier could suppress a
later detection that extended beyond it, leaving the latter's suffix exposed.
For example, a name covering `John Smith` could suppress the email covering
`Smith@example.test`, leaving `@example.test` in the output.

All four active composition paths now use a shared original-text UTF-16 span
union. Crossing spans expand to their full union; adjacent spans remain separate,
and uncovered gaps are not redacted. Contained spans retain the containing type.
Crossing spans of different types use a generic combined mask rather than invent
a category. Returned `original`/`index` coordinates still refer to the input, for
pixel mapping and reversible tokenization. The helper validates exact source
slices, bounds match count, leaves caller inputs untouched and constructs output
in one forward pass. Its sweep avoids the old regex overlap scan's quadratic
pair comparisons; no packaged-browser speed improvement is claimed here.

Tests include 1,000 deterministic generated interval sets for exact union,
idempotence and reversed-input invariance, plus Unicode, containment, chains,
mixed types, invalid inputs and an actual provider-pipeline regression.

## Measured regression result

Compared the historical rule engine at commit
`ff92a52f013fd5583a1cc022609dd020f29c0a73` against the changed engine, with identical
PII definitions, across all 20,000 documents in the existing synthetic corpus:

- No previous detected character coverage lost in any document.
- Ten documents gain coverage: 21 additional sensitive characters protected.
- Zero additional non-sensitive characters redacted on this corpus.

On the established 16,274-record test partition, weighted recall changes from
24.095357% to 24.097350%: **+0.001992 percentage points**, paired 95% interval
+0.000651 to +0.003824 points over 1,000 cluster-bootstrap rounds. Whole-document
protection remains 6.568205%. Over-redaction remains 0.625583%; clean negatives
remain 78.571429%. These are rules alone, not the stronger PSI model's results.
The clean-negative count still has poor independent diversity. This is a small
regression improvement on previously viewed data, not independent confirmation
or a demonstration that release gates are nearly met. Other inputs may add false
positives when union preserves detections the old code discarded.

Reproduce from the benchmark directory, using a fresh output directory:

```sh
node compare_rules_union.cjs ff92a52f013fd5583a1cc022609dd020f29c0a73 \
  generated/data/llss-au-pii-psi-v1.jsonl generated/evidence/rules-union-v2
```

Score both emitted prediction files with `pii-bench score --partition test
--bootstrap-rounds 1000`, then `pii-bench compare --partition test --rounds 1000`.
The script hashes the corpus, code and unchanged definitions, checks every old
span remains covered, and fails if coverage regresses. It uses no network/model.
Node VM isolation of the historical source means these timings are diagnostic,
not a controlled performance comparison. The hybrid benchmark bridge was also
updated to match the production union instead of maintaining the old discard
logic; the retained before/after corpus result above is **regex-only**.

## Response validity, privacy and user-facing limitations

Structured entity responses containing malformed or unlocatable entities now
return `valid: false` (including when all reported entities were discarded).
Valid locatable matches remain available for diagnostics; production structured
callers reject the incomplete response under their existing fallback behaviour.
Response/entity limits, safe-integer positions and prototype-safe type lookup
are checked. JSON parse errors no longer include excerpts of model output.
Generative legacy fallback still exists in providers, but the mandatory regex
composition now rejects estimated or unlocatable model matches instead of
re-scanning rewritten text. Auto mode retains the original-text rule result;
explicit AI/provider requests fail visibly. This closes a second bypass where a
partial model rewrite could break the syntax of an identifier before the rule
scan. Valid positioned model spans are composed only against original text.

Text pipeline responses now carry `coverage`: rule processing status, contextual
processing/skipping/unavailability/failure/timeout status, input length and
`qualityQualified: false`. A successful zero-match structured local response
does not trigger hosted/cloud enhancement merely because there were no matches.
Enabled remote providers can still be used when local processing is unavailable
or unverified, or explicitly selected. **This does not create a strict local-only
policy or fix the existing length exclusions.**

Manual text badges, document result notices and the document workspace explain
limited or unconfirmed coverage and ask for review. A processed scan is not
called safe. Text coverage does not attest complete OCR/document extraction,
and document paths without coverage metadata show an unconfirmed notice. Submit
policy enforcement, cancellation of underlying timed-out inference, bounded
shared execution and exact-browser verification remain separate work.
