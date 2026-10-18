# Protection evidence dashboard

Static, dependency-free reporting over committed research evidence. This is not
an independent validation, new experiment, live monitor or release certificate.
No model inference, raw client inputs, telemetry, external fonts or analytics.

From `benchmarks/pii-models`:

```sh
PYTHONPATH=src python3 -m pii_bench.dashboard
```

Open `dashboard/dist/index.html` directly for offline exploration, or serve that
directory over localhost to enable the source-download hash verification button:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dashboard/dist
```

The default display uses calibration-selected primary thresholds, not permissive
diagnostics. Nine comparison groups retain their dataset hash, partition, split
scheme and sample size. The exporter refuses mixed identities and invalid numeric
measurements. It preserves missing intervals as unknown and actual zeros as zero.
All displayed proportions are bound to original JSON Pointers and exact source
SHA-256 hashes. CSV exports retain full precision, operating point, source
bindings and explicit non-qualification. Raw metrics and source downloads remain
available for an independent re-analysis.

`integrity.json` binds every generated distribution file; this is byte integrity,
not an authenticated signature or assurance of scientific validity. Regenerate
after changing frontend, exporter, protocol, catalog or evidence inputs. Generated
`dist/` is ignored; source evidence remains the committed files under `evidence/`.
Output contains aggregates only and never models or raw predictions.

The source Site identity is retained in `.openai/hosting.json`. Hosted publication
uses a separate ignored checkout under `.cache/evidence-site` so Sites source
history never replaces the extension repository's Git history. New Site audience
is owner-private. Publication copies this tested distribution and uses the Sites
source workflow; no token belongs in this directory or in Git.

## Verification

```sh
PYTHONPATH=src python3 -m unittest tests.test_dashboard -v
node dashboard/browser-smoke.cjs /absolute/path/to/chrome generated/evidence/dashboard-ui-qa-FRESH
```

The optional browser smoke check uses Node 22+ with built-in WebSocket and an
existing Chrome executable. It opens a fresh headless profile, binds its static
server to loopback, exercises all 13 cohort/operating-point views, verifies all
five source downloads, checks the 44-label and 20-candidate inventories, checks
CSV provenance, captures desktop/mobile screenshots and closes its own browser
and server. Profiles/reports stay under the supplied ignored output directory.
**Dashboard browser QA does not qualify the extension or its models.** It does
not constitute a full accessibility audit or independent scientific review.

## Retained limitations

- Later evaluations reuse viewed data; no new sealed confirmation was created.
- Source IDs and shared generators do not guarantee independence. Sparse negative
  diversity and limited PSI label coverage remain explicit per cohort.
- Historical artifacts lack some intervals, support counts and paired threshold
  metadata. These are not guessed or inferred from repeated rows.
- The inventory is not a competitive leaderboard. Initial engineering smoke runs
  and some early failed experiments do not have matching full aggregate outputs
  in this snapshot; do not infer missing standalone model results from ensembles.
- Individual metric confidence bounds can meet a numeric target while the model
  fails safety elsewhere. Every candidate remains not release-qualified, and
  exact-package Chrome/Edge evidence and human review are still absent.
