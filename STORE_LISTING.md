# Chrome Web Store Listing

## Name
Loose Lips Sink Ships — PII Redaction

## Short Description (132 chars max)
Enterprise PII redaction for Chrome. Local-first processing. Protects text, documents, and uploads from leaking sensitive information.

## Detailed Description

Loose Lips Sink Ships helps detect and redact configured categories of personally identifiable information in supported browser submits and file uploads. Built for Australian organisations and enterprise-managed environments.

**LOCAL-FIRST PROCESSING**
PII detection runs on your device by default — using Chrome's built-in on-device model when available and 17 regex patterns for Australian PII (TFN, ABN, Medicare, passports, and more). The extension does not send protected content to a hosted or cloud redaction provider unless one is explicitly configured.

**WHAT IT PROTECTS**
• Text fields — auto-redacts as you type or paste, intercepts form submissions and send buttons
• Voice dictation — temporarily captures speech in memory, transcribes it with the browser's ready on-device audio model, and redacts it before insertion; no cloud transcription fallback is used
• Documents — DOCX (XML replacement), PDF (text extraction + OCR), XLSX (CSV conversion), images (pixel-level black box redaction)
• Broad text/document support — JSON, CSV, XML, YAML, code files, config files (.env, .ini), logs, and safely inspectable ZIP archives
• AI chat services — auto-detects ChatGPT, Claude, Gemini, Copilot, Grok, and 30+ others

**KEY FEATURES**
• AI Chat Guard — enforces redaction before text or files reach AI services
• On-Device Voice Dictation — a mic button appears only when Chrome's built-in audio model reports ready. The extension redacts the transcript before insertion and never selects cloud transcription. It can also hide known site dictation controls and warn about potential microphone bypass paths.
• Classification Gate — reads Microsoft sensitivity labels (MSIP) and blocks PROTECTED/SECRET documents from uploading
• Standalone Redaction Tool — batch process files via drag-and-drop without visiting any website
• Layered detection — browser on-device AI, deterministic regex, heuristic names, Azure PII, and organisation-hosted models
• Guided Local AI setup — visible download progress, browser-specific recovery help, and a synthetic-data readiness test

**ENTERPRISE READY**
• Managed configuration via GPO, Intune, or Google Workspace
• Microsoft Entra OAuth2 PKCE — no stored OAuth tokens at rest; tenant Conditional Access can require MFA
• Azure native document API — server-side PDF/DOCX redaction via Blob Storage
• Lock settings so users can't disable protection
• 5 detection modes: Auto, AI Only, Regex Only, Hosted Only, Cloud Only

**PRIVACY**
• No telemetry, no analytics, no tracking
• No data leaves the browser in default mode
• Microphone access is user-initiated; a recording is held temporarily in extension memory for local transcription and then discarded
• Cloud providers are opt-in and require explicit configuration
• API credentials stored in memory-only session storage (Enterprise mode)
• Automated regression, dependency-audit, package-validation, and container-build gates

Detection and DOM interception reduce disclosure risk but cannot guarantee that every PII form is detected or stop a hostile website from transmitting keystrokes as they are typed. High-assurance deployments should combine the extension with browser policy, network controls, and organisational handling procedures.

Source available (Functional Source License): https://github.com/bmaidev/looselipssinkships.extension

## Category
Productivity

## Language
English

## Keywords
PII, redaction, privacy, data protection, enterprise, government, Australian, TFN, Medicare, DOCX, PDF, OCR, AI, Azure, DLP, sensitive information, classification
