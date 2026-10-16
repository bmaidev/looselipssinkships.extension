# Security Policy

Loose Lips Sink Ships is a privacy tool — security reports are taken seriously
and are genuinely appreciated.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:
[Security Advisories](https://github.com/bmaidev/looselipssinkships.extension/security/advisories/new).

Include where possible:

- A description of the issue and its impact (e.g. PII leakage, redaction bypass,
  credential exposure)
- Steps to reproduce, or a proof of concept
- The extension version, browser name/channel, and browser version

You can expect an acknowledgement within a few business days.

## Scope

Reports of particular interest:

- **Redaction bypass** — any way PII can reach the network despite guards being
  enabled (submit guard, upload interception, AI chat guard)
- **Recoverable redaction** — redacted output (PDF, image, DOCX) from which the
  original content can be recovered
- **Credential handling** — leakage of configured API keys, OAuth tokens, or
  SAS URLs
- **Content script injection issues** — XSS or privilege escalation via the
  extension's DOM handling

Out of scope: issues requiring a compromised browser or machine, and the
inherent accuracy limits of PII detection engines (missed detections are quality
bugs — report those as regular issues).

## Supported Versions

Only the latest released version of the extension receives security fixes.
