# Loose Lips Sink Ships

**Enterprise-grade PII redaction for Chrome.** Local-first processing with progressive escalation to hosted and cloud providers. Designed for Australian government agencies and secure enterprise environments.

> **Zero PII leaves the browser** unless you explicitly configure a cloud provider. Every document, every text field, every file upload — scanned for personally identifiable information before it reaches the network.

---

## How It Works

```
  User types / pastes / uploads
            │
            ▼
  ┌─────────────────────────────────────────┐
  │  Content Guards                         │
  │  Auto-redact ─ Submit guard ─ Upload    │
  │  interception ─ AI chat detection       │
  └────────────┬────────────────────────────┘
               │
               ▼
  ┌─────────────────────────────────────────┐
  │  Pipeline Router                        │
  │  Picks the best provider by tier,       │
  │  availability, and user config          │
  └────┬──────────┬──────────┬──────────────┘
       │          │          │
  ┌────▼────┐ ┌──▼─────┐ ┌─▼──────────┐
  │  LOCAL  │ │ HOSTED │ │   CLOUD    │
  │         │ │        │ │            │
  │ Gemini  │ │ Your   │ │ Azure PII  │
  │ Nano    │ │ LLMs   │ │ Detection  │
  │         │ │        │ │            │
  │ Regex   │ │ OCR    │ │ Azure      │
  │ Engine  │ │ Server │ │ Native Doc │
  │         │ │        │ │            │
  │ OCR +   │ │        │ │ Microsoft  │
  │ Pixel   │ │        │ │ Purview    │
  │ Redact  │ │        │ │            │
  └─────────┘ └────────┘ └────────────┘
```

**Detection modes:** Auto (local-first) | AI Only | Regex Only | Cloud Only

---

## Supported File Types

| Format | Method | Output |
|--------|--------|--------|
| **DOCX** | XML text replacement in-place | Redacted `.docx` (formatting preserved) |
| **XLSX** | Convert to CSV, redact per-cell | Redacted `.csv` (structure preserved) |
| **PDF** (text) | pdf.js text extraction | Redacted `.txt` |
| **PDF** (scanned) | Render + Tesseract OCR + pixel redaction | Redacted image-only PDF |
| **PDF / DOCX / TXT** | Azure native document API (server-side) | Redacted in original format |
| **Images** | Tesseract OCR + pixel redaction | Redacted `.png` with black boxes |
| **CSV, TSV, JSON, XML, YAML** | UTF-8 text redaction | Same format |
| **Code** (.py, .js, .ts, .java, .go, .sql, etc.) | UTF-8 text redaction | Same format |
| **Config** (.env, .ini, .conf, .cfg, .toml) | UTF-8 text redaction | Same format |
| **Docs** (HTML, Markdown, RTF, LaTeX, TXT, LOG) | Text extraction + redaction | Same format |
| **ZIP** | Extract → redact each file → repack | Redacted `.zip` |

**50+ file extensions** recognised. If it's text-based, it's covered.

---

## Key Features

### Real-Time Text Protection
- **Direct Nano redaction** in text fields via Chrome's Prompt API — zero IPC, instant
- **Auto-redact on type/paste** with smart debouncing (configurable 500ms–5s)
- **Submit interception** — catches Enter key, form submit, and send button clicks
- **Conversational response guard** — detects when Nano goes off-script and returns original text

### Upload Interception ("Security Handshake")
- **Shadow DOM overlay** with scanning animation while processing
- **File replacement** — redacted file injected via `DataTransfer` before the site sees it
- **Multi-file queue** with bounded concurrency
- **Skip button** — users can bypass at any time

### AI Chat Guard
- **Auto-detects 30+ AI services** — ChatGPT, Claude, Gemini, Copilot, Grok, DeepSeek, Perplexity, and more
- **Custom AI domains** — add internal services (e.g. `internal-ai.agency.gov.au`)
- **Protection banner** on detected AI sites
- Enforces redaction before submit, upload, and paste

### Voice Dictation
- **Dictation leak detection (observe-only)** — on any site, detects when a page captures the microphone in a way that would upload it (`getUserMedia` feeding a `MediaRecorder`), i.e. server-side dictation where spoken PII leaves the browser as audio before any text guard sees it. Local, observe-only — no audio is recorded or sent. Optional warning toast on leak.
- **Inline on-device dictation** — adds a green microphone button to AI chat composers. Speak, and audio is transcribed **on-device** (Gemini Nano via the Prompt API's audio input; on-device Web Speech where available), redacted through the normal pipeline, and the clean text is inserted. Audio **never leaves the device**; cloud transcription is never used. Also available in the Redact Files tool as a "Dictate (on-device)" panel.
- **Native dictation-button suppression** — hides the site's own dictation button (e.g. ChatGPT's "Start dictation", Claude's "Press and hold to record") so only the safe on-device button remains. Targets dictation buttons, not full realtime voice mode.
- **Requires** Chrome 138+ with the on-device model (Gemini Nano) available; transcription runs in the offscreen document.

### Standalone Redaction Tool
Click **"Redact Files"** in the popup to open a dedicated tab:
- Drag-and-drop with multi-file batch processing
- Per-file results: match count, engine, pipeline steps, text preview
- Individual and bulk download of redacted files
- On-device **Dictate** panel — transcribe speech locally and redact before it appears
- Works independently of any website

### Provably Secure Image/PDF Redaction
- **Image-based flattening** — no hidden text layer in the output
- Copy-paste and select-all **cannot recover** redacted content
- The `pdf-lib` overlay approach (used by ~65% of government "redacted" PDFs) is **deliberately avoided**

---

## Detection Engines

| Engine | Tier | Description |
|--------|------|-------------|
| **Gemini Nano** | Local | Chrome's on-device AI via the Prompt API. Zero network calls. |
| **Regex Engine** | Local | 17 built-in Australian PII patterns. Always available. |
| **Vector Names** | Local | Heuristic name detection via trigram similarity. |
| **Azure AI Language** | Cloud | Microsoft's PII API with Australian entity support. Direct (API key) or Enterprise (OAuth2 PKCE) auth. |
| **Azure Native Document** | Cloud | Server-side PDF/DOCX/TXT redaction via Azure Blob Storage. |
| **Microsoft Purview** | Cloud | M365 DLP sensitive information types. |
| **Hosted Models** | Hosted | Your infrastructure — vLLM, Ollama, TGI, Azure OpenAI, or custom PII APIs. |

### 17 Built-in PII Types (Australian Focus)

| Category | Types |
|----------|-------|
| Contact | Email, Phone (AU), Phone (International), Street Address, Postcode |
| Financial | TFN, ABN, ACN, Credit Card, BSB, Bank Account |
| Health | Medicare Number |
| Identity | Passport, Driver Licence, Date of Birth |
| Technical | IPv4, IPv6 |

Custom patterns can be added via the Settings page.

---

## Installation

**Live on the Chrome Web Store:** [Loose Lips Sink Ships](https://chromewebstore.google.com/detail/loose-lips-sink-ships/bkjmleaamcpimcnlgfcejocbfgbhgldp) — click **Add to Chrome**.

To build from source or side-load a development copy:

```bash
# 1. Clone the repo
git clone https://github.com/bmaidev/looselipssinkships.extension.git

# 2. Install vendor dependencies (PDF/image support)
cd looselipssinkships.extension
chmod +x vendor/setup.sh && ./vendor/setup.sh

# 3. Load in Chrome
#    → chrome://extensions → Enable Developer mode → Load unpacked
```

**Requirements:**
- Chrome 128+ (Chrome 136+ recommended)
- `chrome://flags/#optimization-guide-on-device-model` — Enabled
- `chrome://flags/#prompt-api-for-gemini-nano` — Enabled

The extension works without Nano — it falls back to regex. Vendor dependencies are optional — without them, PDF/image processing routes to hosted/cloud.

---

## Configuration

### Quick Start
Works out of the box. Gemini Nano + regex with AI Chat Guard enabled by default. The green dot in the popup confirms Nano is available.

### Detection Modes

| Mode | Behaviour |
|------|-----------|
| **Auto** (default) | Nano → Regex → Hosted → Cloud |
| **AI Only** | AI providers across all tiers |
| **Regex Only** | Pattern matching only |
| **Cloud Only** | Azure PII / Purview first, regex fallback |

### Enterprise Setup

Two authentication modes for Azure PII:

| Mode | Auth | Secrets Stored | Setup |
|------|------|----------------|-------|
| **Direct** | API key | Key in settings | Paste endpoint + key |
| **Enterprise** | Azure AD OAuth2 PKCE | None (short-lived tokens) | App Registration + sign-in |

Enterprise mode provides: MFA, Conditional Access, per-user audit, automatic token refresh, and no stored credentials.

**Azure Native Document Redaction** (server-side PDF/DOCX) is available with Azure Blob Storage:
- **Direct mode**: SAS tokens for source/target containers
- **Enterprise mode**: Language resource managed identity (zero SAS tokens)

See [`enterprise/README.md`](enterprise/README.md) for full deployment guides (Intune, GPO, Google Workspace, and small-business remote config).

### Managed Configuration

Admins can push settings via Chrome's managed storage API and lock specific settings:

```json
{
  "_policyVersion": 2,
  "_locked": { "detectionMode": true, "providers.azure_pii": true },
  "detectionMode": "cloud_only",
  "providers": { "azure_pii": { "enabled": true, "connectionMode": "enterprise" } }
}
```

Locked settings appear as disabled with an **Admin** badge in the options page.

---

## Privacy & Security

- **Local-first.** Nano and regex run entirely on-device. Text field redaction happens in the content script — text never leaves the page context.
- **No telemetry.** Zero analytics, zero phone-home.
- **Enterprise providers are opt-in.** Cloud connections only activate when explicitly configured.
- **Provably secure.** Image/PDF output has no hidden text layer. DOCX redaction removes PII from the XML. ZIP processing redacts every text file inside.
- **Pre-send, pre-upload.** Redaction happens before content reaches the network — not after.
- **Enterprise OAuth2.** Short-lived tokens, no stored API keys, MFA enforced, per-user audit trail.
- **Managed identity for storage.** In enterprise mode, the Language resource accesses Blob Storage via its own identity — no SAS tokens in the extension.

---

## File Structure

```
├── manifest.json                    # MV3 manifest with managed storage schema
├── background.js                    # Service worker — routing, providers, keep-alive
├── content.js                       # Content script — guards, Nano, interception
├── offscreen.html / offscreen.js    # Offscreen Document — Canvas, WASM, PDF, Nano proxy
├── popup.html / popup.js            # Toolbar popup — status, stats, "Redact Files"
├── redact.html / redact.js / .css   # Standalone batch redaction tool
├── options.html / options.js / .css # Full settings page with managed lock visuals
├── managed_schema.json              # Chrome managed storage JSON Schema
├── lib/
│   ├── debug.js                     # Debug logger ([LLSS:subsystem])
│   ├── azure-auth.js                # OAuth2 PKCE for Azure AD
│   ├── azure-native-doc.js          # Native document PII via Azure Blob Storage
│   ├── nano-session.js              # LanguageModel session manager
│   ├── pipeline.js                  # Progressive pipeline (auto/ai/regex/cloud)
│   ├── settings.js                  # 4-tier merge (managed > remote > local > defaults)
│   ├── pii-types.js                 # 17 Australian PII patterns
│   ├── regex-engine.js              # Regex redaction with overlap resolution
│   ├── vector-engine.js             # Trigram name detection
│   ├── site-filter.js               # URL matching, 30+ AI service detection
│   ├── providers/
│   │   ├── base-provider.js         # Provider interface
│   │   ├── provider-registry.js     # Lifecycle + routing
│   │   ├── local-ai-provider.js     # Gemini Nano (direct or offscreen proxy)
│   │   ├── regex-provider.js        # Regex + vector
│   │   ├── azure-pii-provider.js    # Azure PII (direct API key or OAuth2)
│   │   ├── purview-provider.js      # Microsoft Purview DLP
│   │   └── hosted-model-provider.js # Org-hosted models + OCR Extract
│   └── documents/
│       ├── document-processor.js    # 50+ file types, ZIP reader, XLSX→CSV
│       ├── zip-writer.js            # ZIP builder (CompressionStream + CRC-32)
│       ├── docx-redactor.js         # Run-aware XML redaction
│       ├── pdf-renderer.js          # pdf.js page rendering
│       ├── ocr-processor.js         # Tesseract.js with worker pool
│       ├── pixel-redactor.js        # PII→bbox mapping + canvas redaction
│       └── async-queue.js           # Bounded concurrency task queue
├── enterprise/
│   ├── README.md                    # Deployment guide (Intune/GPO/Workspace)
│   ├── workspace-config.json        # Google Workspace template
│   ├── intune-policy.json           # Intune template
│   └── small-business-config.json   # Remote config template
├── vendor/
│   ├── setup.sh                     # Downloads pdf.js + Tesseract.js
│   ├── pdf-bridge.js                # ES module bridge for pdf.js
│   └── tesseract/                   # WASM core + trained data
├── tests/                           # 285 tests (Jest)
└── icons/
```

---

## Development

```bash
npm install
npm test              # 285 tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Adding Custom PII Types

Via Settings, or programmatically:
```javascript
{
  id: "student_id",
  name: "Student ID",
  token: "[REDACTED_STUDENT_ID]",
  regex: "\\bSTU-\\d{6}\\b",
  flags: "gi",
  enabled: true,
  category: "custom"
}
```

### Settings Schema

| Version | Changes |
|---------|---------|
| v1 | Detection mode, vector fallback, PII overrides |
| v2 | Provider configuration, document upload |
| v3 | Site filter, AI chat guard, auto-redact, submit/upload guard |
| v4 | Azure connection mode (direct/enterprise), OAuth2 PKCE |

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
test, and PR guidelines. Security issues should be reported privately per
[SECURITY.md](SECURITY.md).

---

## License

[Functional Source License, Version 1.1, MIT Future License](LICENSE.md)
(FSL-1.1-MIT) © Black Mountain AI

In plain terms: the source is available and **free to use, modify, and
self-host** — including internal commercial use inside your organisation. What
you may not do is resell the Software (or a substantially similar product or
service) in competition with us. Each release automatically converts to the
**MIT license two years** after it is published.

Bundled third-party components (pdf.js, Tesseract.js) are Apache-2.0 licensed —
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
