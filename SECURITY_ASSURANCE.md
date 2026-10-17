# Security Assurance and Threat Model

Status: engineering baseline for version 4.6.0, updated 17 October 2026.

This document defines what Loose Lips Sink Ships protects, where its trust
boundaries sit, and what must surround it in a high-assurance deployment. It is
not a certification, penetration-test report, IRAP assessment, or claim of
equivalence with an Australian Defence classified environment.

## Security objective

Reduce accidental disclosure of configured PII types through supported browser
text submissions and file uploads. Prefer local processing, make external data
flows explicit, and fail closed when a file cannot be completely inspected or a
redacted replacement cannot be produced.

The extension is a last-mile control. It is not a browser network firewall,
endpoint DLP suite, malware defence, document-classification authority, or a
replacement for access control and user training.

## Protected assets and trust boundaries

Protected assets include text entered into guarded fields, document contents,
in-memory reversible-token mappings, configured provider credentials, delegated
OAuth tokens, and redacted output files.

Trust boundaries are:

1. Host page to isolated content script. The page is untrusted and may modify
   its DOM, synthesize events, or transmit data independently of a form submit.
2. Content script to extension service worker. Only a narrow settings view is
   returned to content scripts; provider credentials remain in trusted extension
   contexts.
3. Service worker to offscreen document. Raw document/audio bytes can cross this
   internal boundary for local Canvas, OCR, PDF, or on-device-model processing.
4. Extension to configured providers. No hosted/cloud provider is enabled by
   default. Enabling one creates an explicit external processing boundary.
5. Extension to optional OCR service. The service receives document bytes and
   returns extracted text/bounding boxes. It therefore handles sensitive data
   even though PII classification remains in the extension.

## Secure-by-default controls

- Manifest V3, no remotely hosted scripts, restrictive extension-page CSP, and
  no persistent blanket host permission. HTTPS/loopback origins are requested at
  runtime only when a user configures a network feature.
- Local, managed, and sync storage are restricted to trusted extension contexts
  where the browser implements `storage.setAccessLevel`.
- Browser AI output is followed by a mandatory deterministic scan. Malformed or
  unsafe model output cannot replace the deterministic result.
- A browser-managed model is not treated as ready while it is merely downloadable
  or downloading. Its first-time setup is user-initiated, exposes download
  progress, creates no content prompt, and releases the verification session.
- Submit and upload listeners register at `document_start` and begin in a
  fail-closed state while settings and site classification load.
- Upload bypass is disabled, unsupported types are blocked, and the browser
  pipeline has a 25 MiB hard limit. ZIP entry count, expanded size, compression
  ratio, path, encryption, and method are validated.
- Image and scanned-PDF redaction is released only when every detected match can
  be mapped to a pixel region. If a match cannot be mapped, the pipeline returns
  a safe text output instead of a partially redacted visual file. Successfully
  inspected files with no configured matches retain their original bytes.
- OAuth uses Authorization Code with PKCE and validates state, nonce, audience,
  tenant, and expiry. Public extension clients do not accept a client secret.
- Hosted and Azure endpoints require HTTPS, except explicit loopback development
  endpoints. Azure resource URLs are constrained to expected Microsoft service
  domains and configured storage containers. Azure document jobs use unpredictable
  per-job blob names to avoid cross-user collisions.
- The optional Microsoft sensitivity-label gate reads embedded DOCX/XLSX label
  metadata locally. It does not send files to Graph or claim to classify unlabeled
  content.
- Remote policy requires HTTPS (loopback excepted), rejects redirects and
  credentials, is size/time bounded, cannot define providers or debugging, and
  cannot weaken fail-closed upload settings.
- Reversible-token mappings are memory-only, never restored into a host page,
  and capped at 1,000 originals per tab before falling back to an irreversible
  placeholder.
- Optional OCR service requires a mounted 32+ character bearer-key secret,
  disables API docs, uses constant-time credential comparison, bounds the raw
  request before multipart parsing, validates signatures and resource limits,
  processes PDFs one page at a time, runs as a non-root container user, and is
  bound to loopback by the supplied Compose profile.

## Reliability, performance, and interaction controls

- Binary document and audio messages use a bounded chunked base64 codec rather
  than expanding every byte into a JavaScript number array. File size is checked
  before `arrayBuffer()` allocation on user-facing upload paths.
- Document work is serialized through one active job and at most one queued job.
  This matches the singleton offscreen renderer, prevents cross-document cache
  corruption, and bounds peak OCR/PDF memory pressure.
- Offscreen requests, hosted providers, Azure polling/downloads, model sessions,
  OAuth, and remote configuration all have explicit time or size bounds. Completed
  offscreen results expire instead of accumulating for the browser session.
- The OCR service processes PDF pages incrementally and its supplied container
  limits request concurrency, memory, CPU, processes, privileges, and keep-alive
  duration.
- Text replacement uses the native input setter and verifies that the page's
  framework accepted the new value. A synchronous rollback is treated as a
  failed redaction rather than permitting a send with the original text.
- User-facing workflows expose progress and failure states, prevent queue mutation
  during processing, restore focus after dialogs, trap keyboard focus in modal
  decisions, support reduced-motion preferences, and announce state changes to
  assistive technology. The Local AI readiness test uses a fixed synthetic value;
  its copyable support report excludes page content, URLs, settings, account data,
  extension identifiers, and device identifiers.

These controls reduce avoidable latency, memory amplification, race conditions,
and unsafe user recovery paths. They are not a substitute for load testing with
representative fleet hardware and documents.

## Important residual risks

- Detection is not perfect. New identifiers, unusual formatting, OCR errors,
  handwriting, adversarial text, and ambiguous names can produce false negatives
  or false positives. Deterministic patterns and language models are not proofs.
- A website can observe keystrokes, clipboard events, or DOM values before the
  extension's submit-time redaction and can send its own `fetch`, WebSocket,
  beacon, or media traffic. The extension does not mediate every network request.
- Browser-internal pages and other restricted origins cannot be protected by an
  extension. Closed shadow roots and browser/site UI changes can also prevent DOM
  interception.
- Native site dictation suppression and microphone-risk detection are heuristic.
  Recording audio is not proof it was uploaded, while uninstrumented capture paths
  may not be detected.
- Configuring hosted, Azure, remote-policy, or OCR endpoints authorises
  corresponding network traffic. Their operators, retention policies, tenant
  controls, certificates, and incident response remain deployment responsibilities.
- Azure native document mode writes source and redacted blobs to the configured
  containers. Deploy short-lived SAS credentials or managed identity plus storage
  lifecycle/deletion policy; the extension does not delete those service-side blobs.
- Local browser/OS compromise, malicious extensions, administrator compromise,
  screen capture, side channels, and physical access are outside this control's
  security boundary.
- Redacted output can retain contextual or non-configured sensitive information.
  Organisations must validate output against their classification and release
  process rather than relying only on match counts.

## High-assurance deployment profile

For government, health, legal, or community-sector sensitive workloads:

- Force-install the signed store package and pin a minimum version through Edge
  or Chrome enterprise policy.
- Lock AI chat, submit, and upload guards. Keep `allowBypass: false`,
  `blockUnsupported: true`, and limit activation to approved sites only when a
  separate control blocks all other destinations.
- Prefer local deterministic processing for data that must not cross the device
  boundary. Treat any enabled provider or OCR service as a sensitive-data system.
- Use Entra Conditional Access, least-privilege app registrations, managed
  identities, short token lifetimes, audited sign-in, and organisation-controlled
  endpoints. Do not embed client secrets in an extension.
- Combine the extension with egress filtering/SWG, endpoint DLP, browser URL
  policy, sensitivity labels, device compliance, patch management, central
  logging, user training, and an incident-response path.
- Pilot with representative documents and sites. Test every protected site after
  browser or site UI updates and treat a failed guard as a release blocker.
- Commission independent source review and penetration testing. For Australian
  Government use, map the complete deployment—not just this extension—to the
  current ISM and obtain the assessment/authorisation appropriate to the data.

## Verification gates

Repository CI is designed to fail on JavaScript syntax errors, test failures,
npm or Python dependency advisories, fixed high/critical container findings,
invalid Chrome/Edge packages, missing package resources, browser-API drift,
Python import failures, or an unbuildable OCR container. It also emits a
CycloneDX container SBOM. Dependencies, scanner images, and GitHub Actions are
locked; automated update checks are configured.

These gates provide repeatable engineering evidence. They do not replace runtime
browser tests on managed Windows devices, store review, SAST/DAST, fuzzing,
penetration testing, privacy impact assessment, or operational accreditation.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
