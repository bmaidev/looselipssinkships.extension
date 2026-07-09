# Contributing

Thanks for your interest in improving Loose Lips Sink Ships.

## Getting Started

```bash
git clone https://github.com/bmaidev/looselipssinkships.extension.git
cd looselipssinkships.extension

# Install dev dependencies (Jest)
npm install

# Optional: download vendored pdf.js + Tesseract.js for PDF/image support
chmod +x vendor/setup.sh && ./vendor/setup.sh
```

Load the extension in Chrome: `chrome://extensions` → enable **Developer mode**
→ **Load unpacked** → select the repo root.

## Running Tests

```bash
npm test              # full suite
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

All tests must pass before a PR is merged. New detection logic, document
handling, or provider code should come with tests — see `tests/` for the
existing patterns (plain Jest, no build step).

## Project Conventions

- **Plain JavaScript, no build step.** The extension loads source files
  directly; keep it that way.
- **Local-first.** No feature may send page content, files, or detected PII
  off-device unless the user has explicitly configured a cloud/hosted provider.
  This is the core promise of the project.
- **No telemetry.** Do not add analytics or phone-home behaviour of any kind.
- **Debug logging** goes through `lib/debug.js` (`LLSS_debug.log("subsystem", ...)`),
  never bare `console.log`.
- **PII patterns** live in `lib/pii-types.js`. New built-in patterns should
  include tests with both matching and non-matching samples.
- **Never use real PII in tests, fixtures, or screenshots.** Use clearly
  synthetic data (e.g. ACMA-reserved test phone numbers like `0491 570 110`,
  `example.com` emails).

## Submitting Changes

1. Fork and create a feature branch.
2. Make your change with tests.
3. Run `npm test` and make sure the suite is green.
4. Open a PR describing what changed and why. For behaviour changes, include
   before/after notes or screenshots.

For large features (new providers, new document formats), open an issue first
to discuss the approach.

## Licensing of Contributions

The project is licensed under the
[Functional Source License (FSL-1.1-MIT)](LICENSE.md). By submitting a
contribution, you agree that it is licensed to Black Mountain AI under the same
terms, and that Black Mountain AI may relicense the project (each release
already converts to MIT two years after publication).

## Reporting Bugs

Open a [GitHub issue](https://github.com/bmaidev/looselipssinkships.extension/issues).
Enable debug logging (Settings → Troubleshooting) and include console output —
but **scrub any real PII from logs before posting**.

Security vulnerabilities: see [SECURITY.md](SECURITY.md) — do not open a public
issue.
