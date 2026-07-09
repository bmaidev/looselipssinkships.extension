# Chrome Web Store Listing

## Name
Loose Lips Sink Ships — PII Redaction

## Short Description (132 chars max)
Enterprise PII redaction for Chrome. Local-first processing. Protects text, documents, and uploads from leaking sensitive information.

## Detailed Description

Loose Lips Sink Ships automatically detects and redacts personally identifiable information before it leaves your browser. Built for Australian government agencies and enterprise environments.

**LOCAL-FIRST PROCESSING**
All PII detection runs on your device by default — using Chrome's built-in Gemini Nano AI and 17 regex patterns for Australian PII (TFN, ABN, Medicare, passports, and more). No data is sent to any server unless you explicitly configure a cloud provider.

**WHAT IT PROTECTS**
• Text fields — auto-redacts as you type or paste, intercepts form submissions and send buttons
• Voice dictation — transcribes speech on-device and redacts it before it reaches the chat box; your microphone audio never leaves the device
• Documents — DOCX (XML replacement), PDF (text extraction + OCR), XLSX (CSV conversion), images (pixel-level black box redaction)
• 50+ file types — JSON, CSV, XML, YAML, code files, config files (.env, .ini), logs, ZIP archives
• AI chat services — auto-detects ChatGPT, Claude, Gemini, Copilot, Grok, and 30+ others

**KEY FEATURES**
• AI Chat Guard — enforces redaction before text or files reach AI services
• On-Device Voice Dictation — a mic button on AI chat composers transcribes your speech locally with Chrome's built-in AI (Gemini Nano) and redacts PII before insertion; audio is never uploaded. Detects and can hide a site's own dictation button, which would send your raw voice to their servers.
• Classification Gate — reads Microsoft sensitivity labels (MSIP) and blocks PROTECTED/SECRET documents from uploading
• Standalone Redaction Tool — batch process files via drag-and-drop without visiting any website
• 6 detection engines — Gemini Nano, regex, vector names, Azure PII, Purview DLP, and organisation-hosted models

**ENTERPRISE READY**
• Managed configuration via GPO, Intune, or Google Workspace
• Azure AD OAuth2 PKCE — no stored API keys, short-lived tokens, MFA enforced
• Azure native document API — server-side PDF/DOCX redaction via Blob Storage
• Lock settings so users can't disable protection
• 5 detection modes: Auto, AI Only, Regex Only, Hosted Only, Cloud Only

**PRIVACY**
• No telemetry, no analytics, no tracking
• No data leaves the browser in default mode
• Microphone is used only for on-device voice dictation — audio is transcribed locally by Chrome's built-in AI and is never recorded or uploaded
• Cloud providers are opt-in and require explicit configuration
• API credentials stored in memory-only session storage (Enterprise mode)
• 360 automated tests

Source available (Functional Source License): https://github.com/bmaidev/looselipssinkships.extension

## Category
Productivity

## Language
English

## Keywords
PII, redaction, privacy, data protection, enterprise, government, Australian, TFN, Medicare, DOCX, PDF, OCR, AI, Azure, DLP, sensitive information, classification
