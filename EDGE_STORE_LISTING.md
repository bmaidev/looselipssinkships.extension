# Microsoft Edge Add-ons Listing

## Package

Upload `dist/loose-lips-sink-ships-edge-v4.4.0.zip`.

## Name

Loose Lips Sink Ships — PII Redaction

## Short description

Enterprise PII redaction for Microsoft Edge. Local-first protection for text, documents, and uploads.

## Description

Loose Lips Sink Ships helps detect and redact configured PII categories in supported Microsoft Edge text submissions and file uploads. It is designed for Australian organisations and enterprise-managed environments, with local-first processing, central policy control, and optional organisation-managed providers.

LOCAL-FIRST PROTECTION

The built-in regex and name-detection engines run entirely on the device and cover 17 Australian-focused PII types, including TFNs, ABNs, ACNs, Medicare numbers, phone numbers, email addresses, payment details, passport numbers, driver licence numbers, dates of birth, addresses, and IP addresses. On supported Microsoft Edge channels and hardware, the extension can also use Edge's on-device Prompt API. No cloud provider is enabled by default.

WHAT IT PROTECTS

• Text fields — detects and redacts PII as users type or paste, and checks form submissions and send-button actions.

• File uploads — inspects supported files and replaces them with a redacted output before release; unsupported or partially inspectable files are blocked by default.

• Documents and images — supports DOCX, XLSX, PDF, images, safely inspectable ZIP archives, source code, structured data, configuration files, and logs.

• AI services — identifies ChatGPT, Microsoft Copilot, Claude, Gemini, Grok, DeepSeek, Perplexity, and other AI chat sites, with support for custom organisation domains.

• Voice dictation — when Microsoft Edge exposes a supported on-device speech or multimodal Prompt API, the extension can transcribe and redact speech locally. It never falls back to cloud transcription; the control stays unavailable when a local engine is not ready.

ENTERPRISE CONTROLS

• Force-install through Microsoft Edge management, Microsoft Intune, or Group Policy.

• Push read-only settings through managed storage and lock individual controls.

• Use Microsoft Entra ID delegated OAuth2 PKCE; tenant Conditional Access can require MFA for Azure AI Language.

• Route detection through Azure AI Language, Azure native document processing, or organisation-hosted models when an administrator explicitly configures them.

• Read Microsoft Information Protection labels and block classified documents according to policy.

PRIVACY AND SECURITY

• No product telemetry, analytics, advertising, or user tracking. Configured provider, OAuth, remote-policy, and browser model-download traffic are explicit exceptions.

• No remote executable code. pdf.js, Tesseract.js, OCR language data, and WASM dependencies are bundled in the extension package.

• Default processing is on-device. Original PII is processed in memory and is not written to extension storage.

• Optional cloud and hosted providers are disabled until a user or administrator supplies an endpoint and credentials.

• OAuth access and refresh tokens are kept in browser session storage and cleared when the browser session ends.

Source code: https://github.com/bmaidev/looselipssinkships.extension

Privacy policy: https://llss.blackmountainai.com.au/privacy

Support: https://llss.blackmountainai.com.au/support

## Category

Productivity

## Search terms

1. PII redaction
2. data loss prevention
3. AI privacy
4. document redaction
5. Australian privacy
6. sensitivity labels
7. Azure PII

## Store assets

| Partner Center field | Repository asset |
|---|---|
| Extension logo | `icons/icon128.png` (128 × 128, meets minimum) |
| Small promotional tile | `store-screenshots/promo-small-440x280.png` |
| Large promotional tile | `store-screenshots/promo-marquee-1400x560.png` |
| Screenshots | Use `screenshot-2.png`, `screenshot-4.png`, and `screenshot-6.png` (1280 × 800). Screenshots 1 and 3 contain obsolete Chrome-specific AI labels and must not be used for Edge. |

## Privacy declarations

Select **Yes** when Partner Center asks whether the extension accesses, collects, or transmits personal information. The extension necessarily accesses website text and selected files to perform redaction, even though default processing is local and the publisher does not collect that content.

- Purpose: detect and redact PII in website text and user-selected documents before submission or upload.
- Local data: settings, provider configuration, policy cache, and aggregate redaction counters. Original PII is not persisted.
- Optional transmission: website text or documents are sent only to Azure or organisation-hosted endpoints explicitly configured by the user or administrator. Sensitivity-label checks are local.
- Selling/sharing: none.
- Advertising/analytics: none.
- Remote code: **No**. All executable code and third-party runtime files are packaged with the extension.

## Permission justifications

| Permission/access | Justification |
|---|---|
| `storage` | Stores user settings, managed configuration, aggregate counters, and session-only OAuth tokens. |
| `offscreen` | Provides DOM, Canvas, Web Worker, and WASM facilities for local PDF rendering, OCR, image redaction, and supported on-device AI calls. |
| `alarms` | Schedules managed remote-configuration refresh and OAuth token renewal. |
| `identity` | Runs the optional Microsoft Entra ID OAuth2 PKCE sign-in flow through `launchWebAuthFlow`. |
| Optional HTTPS/loopback host access | Requested at setup time for the exact provider or remote-policy origins the user configures; there is no persistent blanket host permission. |
| `<all_urls>` content scripts | PII can be entered or uploaded on any website. Site filtering and AI-site rules run locally and can narrow protection by policy. |
| `wasm-unsafe-eval` CSP | Required to instantiate the packaged Tesseract OCR WebAssembly module; it does not permit remote scripts. |

## Certification notes

The extension is fully functional with no account and no cloud configuration. To verify the default path:

1. Load the extension and keep Detection Mode set to Auto.
2. Open a normal webpage with an input or textarea.
3. Enter synthetic data such as `person@example.com` or the ACMA-reserved test number `0491 570 110`.
4. Use the Redact control or submit guard and confirm the value is replaced by a `[REDACTED_*]` token.
5. Open the toolbar popup, choose **Redact Files**, and test a synthetic TXT or CSV file.

The browser on-device language model is optional and capability-detected. Microsoft Edge devices without a compatible Prompt API use the local deterministic engines automatically. Azure, organisation-hosted providers, and Entra sign-in require customer-owned infrastructure and are not required to verify the extension's core purpose.

This extension reduces accidental disclosure risk but is not a network firewall. Detection can miss novel PII, and a website can observe or transmit text while it is typed. High-assurance deployments should combine it with managed browser policy, egress controls, endpoint DLP, testing, and organisational handling procedures.
