# Security Policy

Loose Lips Sink Ships is a privacy and disclosure-risk reduction tool. Security
and detection-bypass reports are taken seriously and are genuinely appreciated.

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

- **Redaction or interception bypass** — a supported guarded flow releases an
  original value or file despite the relevant guards being enabled
- **Recoverable redaction** — redacted output (PDF, image, DOCX) from which the
  original content can be recovered
- **Credential handling** — leakage of configured API keys, OAuth tokens, or
  SAS URLs
- **Content script injection issues** — XSS or privilege escalation via the
  extension's DOM handling

Issues requiring a compromised browser or operating system are normally out of
scope. Detection false negatives are still valuable reports; use private
reporting whenever the example, method, or attachment contains real sensitive
data or describes a broadly exploitable bypass.

## Supported Versions

Only the latest released version of the extension receives security fixes.

## Security Model

The engineering security model, high-assurance deployment profile, and known
limitations are documented in [SECURITY_ASSURANCE.md](SECURITY_ASSURANCE.md).
The project does not claim an IRAP assessment, ASD certification, or equivalence
to a classified-environment security control.
