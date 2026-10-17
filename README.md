# Loose Lips Sink Ships

**Local-first PII redaction for Google Chrome and Microsoft Edge.** Layered text, document, upload, and AI-chat controls with optional organisation-hosted and cloud providers.

> **The extension does not send protected content to an external redaction provider in its default configuration.** Hosted/cloud processing requires explicit configuration and an origin permission grant. This is a risk-reduction control, not a network firewall: detection can miss novel PII, and a website can observe or transmit text while it is being typed. See [Security Assurance](SECURITY_ASSURANCE.md) before high-assurance deployment.

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
  │ Browser │ │ Your   │ │ Azure PII  │
  │ AI      │ │ LLMs   │ │ Detection  │
  │         │ │        │ │            │
  │ Regex   │ │ OCR    │ │ Azure      │
  │ Engine  │ │ Server │ │ Native Doc │
  │         │ │        │ │            │
  │ OCR +   │ │        │ │            │
  │ Pixel   │ │        │ │            │
  │ Redact  │ │        │ │            │
  └─────────┘ └────────┘ └────────────┘
```

**Detection modes:** Auto (local-first) | AI Only | Regex Only | Hosted Only | Cloud Only

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

Only the formats listed above are accepted. Unsupported, binary, oversized, encrypted, malformed, or partially inspectable archive content is blocked by the fail-closed upload guard.

---

## Key Features

### Real-Time Text Protection
- **Browser on-device AI** when the compatible Prompt API and local model are available, followed by a mandatory deterministic safety pass
- **Auto-redact on type/paste** with smart debouncing (configurable 500ms–5s)
- **Submit interception** — catches Enter key, form submit, and send button clicks
- **Model-output validation** — rejects unsafe or malformed AI results and retains deterministic redaction

### Upload Interception ("Security Handshake")
- **Shadow DOM overlay** with scanning animation while processing
- **File replacement** — redacted file injected via `DataTransfer` before the site sees it
- **Multi-file queue** with bounded concurrency
- **Fail-closed default** — no release of the original file when inspection or redaction fails; unsupported files are blocked

### AI Chat Guard
- **Auto-detects 30+ AI services** — ChatGPT, Claude, Gemini, Copilot, Grok, DeepSeek, Perplexity, and more
- **Custom AI domains** — add internal services (e.g. `internal-ai.agency.gov.au`)
- **Protection banner** on detected AI sites
- Enforces redaction before submit, upload, and paste

### Voice Dictation
- **Dictation bypass detection (observe-only)** — on any site, detects microphone capture being packaged by `MediaRecorder`, plus speech recognition that is not explicitly marked local. These are potential off-device paths, not proof that a network upload occurred. Detection itself records no audio and performs no network activity.
- **Inline on-device dictation** — adds a green microphone button only when the browser reports its multimodal Prompt API audio model ready. The extension temporarily holds the recording in memory, transcribes it with that on-device model, redacts the transcript, and does not select a cloud transcription fallback.
- **Native dictation-button suppression** — hides the site's own dictation button (e.g. ChatGPT's "Start dictation", Claude's "Press and hold to record") so only the safe on-device button remains. Targets dictation buttons, not full realtime voice mode.
- **Capability-gated** — the dictation control remains unavailable unless an on-device transcription engine is genuinely ready. Text, upload, and document protection are unaffected.

### Standalone Redaction Tool
Click **"Redact Files"** in the popup to open a dedicated tab:
- Drag-and-drop with multi-file batch processing
- Per-file results: match count, engine, pipeline steps, text preview
- Individual and bulk download of redacted files
- On-device **Dictate** panel — transcribe speech locally and redact before it appears
- Works independently of any website

### Flattened Image/PDF Redaction
- **Image-based flattening** — no hidden text layer in the output
- Copy-paste and select-all do not expose a retained text layer in image-based output
- The `pdf-lib` overlay approach (used by ~65% of government "redacted" PDFs) is **deliberately avoided**

---

## Detection Engines

| Engine | Tier | Description |
|--------|------|-------------|
| **Browser On-Device AI** | Local | Chrome/Edge local model through a compatible Prompt API. Model installation may use the network; inference content stays on-device according to the browser API contract. |
| **Regex Engine** | Local | 17 built-in Australian PII patterns. Always available. |
| **Vector Names** | Local | Heuristic name detection via trigram similarity. |
| **Azure AI Language** | Cloud | Microsoft's PII API with Australian entity support. Direct (API key) or Enterprise (OAuth2 PKCE) auth. |
| **Azure Native Document** | Cloud | Server-side PDF/DOCX/TXT redaction via Azure Blob Storage. |
| **Microsoft Label Gate** | Local | Reads embedded Microsoft sensitivity-label metadata from DOCX/XLSX files and blocks configured classifications before upload. |
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

**Chrome:** [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/loose-lips-sink-ships/bkjmleaamcpimcnlgfcejocbfgbhgldp).

**Microsoft Edge:** the Microsoft Edge Add-ons package and submission material are ready in this repository. See [EDGE_RELEASE.md](EDGE_RELEASE.md) for the Partner Center and 700+ user rollout runbook.

To build from source or side-load a development copy:

```bash
# 1. Clone the repo
git clone https://github.com/bmaidev/looselipssinkships.extension.git

# 2. Install vendor dependencies (PDF/image support)
cd looselipssinkships.extension
chmod +x vendor/setup.sh && ./vendor/setup.sh

# 3. Load unpacked
#    Chrome → chrome://extensions
#    Edge   → edge://extensions
#    Enable Developer mode → Load unpacked → select the repository root
```

**Core requirements:**
- A current desktop release of Google Chrome or Microsoft Edge
- Vendor files in `vendor/` for local PDF/image OCR (already included in store packages)

The extension works without a browser language model: deterministic regex and vector detection remain local and available. Chrome's Prompt API can use Gemini Nano. Microsoft Edge exposes its own Prompt API model in supported preview channels/devices; availability is detected at runtime and never assumed.

Settings → Providers includes guided Local AI setup with consent-first download progress, browser-specific recovery guidance, a synthetic-data end-to-end readiness test, and a privacy-safe support report. See [Low-resource private PII model research](LOCAL_MODEL_RESEARCH.md) for the 22 MB CPU-oriented fallback candidate and its mandatory evaluation gates.

The [local protection architecture delivery contract](LOCAL_PROTECTION_ARCHITECTURE.md)
defines the target for a compact, offline PII/PSI engine in both live extensions.
Research models are not shipped: the executable [release evidence gates](benchmarks/pii-models/PROTOCOL.md)
require independent safety/utility evidence and exact-package browser verification.
No current research candidate passes those gates.

The separate [local PII/PSI model benchmark](benchmarks/pii-models/README.md) contains the governed 20-candidate matrix, deterministic 20,000-document Australian corpus, calibration/held-out protocol, model adapters, ensemble search, and reviewed evidence. Benchmark models and generated data are not bundled into the extension.

### Store Packages

```bash
npm run build         # Chrome and Edge
npm run build:chrome  # dist/loose-lips-sink-ships-v4.6.0.zip
npm run build:edge    # dist/loose-lips-sink-ships-edge-v4.6.0.zip
```

Every build validates manifest references, package contents, local-only scripts, and browser API compatibility before creating the ZIP.

---

## Configuration

### Quick Start
Works out of the box with local regex and AI Chat Guard enabled. When the browser's on-device model is available, Auto mode can use it as an additional local provider; the popup reports its live status.

### Detection Modes

| Mode | Behaviour |
|------|-----------|
| **Auto** (default) | Browser AI → Regex → Hosted → Cloud |
| **AI Only** | AI providers across all tiers |
| **Regex Only** | Pattern matching only |
| **Cloud Only** | Azure PII first, deterministic regex fallback |

### Enterprise Setup

Two authentication modes for Azure PII:

| Mode | Auth | Secrets Stored | Setup |
|------|------|----------------|-------|
| **Direct** | API key | Key in settings | Paste endpoint + key |
| **Enterprise** | Azure AD OAuth2 PKCE | None (short-lived tokens) | App Registration + sign-in |

Enterprise mode uses public-client OAuth2 PKCE with short-lived tokens and automatic refresh. Microsoft Entra Conditional Access can require MFA and provide sign-in audit records; the extension does not itself enforce tenant policy.

**Azure Native Document Redaction** (server-side PDF/DOCX) is available with Azure Blob Storage:
- **Direct mode**: SAS tokens for source/target containers
- **Enterprise mode**: Language resource managed identity (zero SAS tokens)

See [`enterprise/README.md`](enterprise/README.md) for full deployment guides (Intune, GPO, Google Workspace, and small-business remote config).

### Managed Configuration

Admins can push settings through Chromium managed storage in Chrome or Edge and lock specific settings:

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

- **Local-first.** Browser AI, regex, vector detection, OCR, and pixel redaction run within extension/browser contexts unless a hosted or cloud provider is explicitly configured.
- **No product telemetry.** The extension contains no analytics or product phone-home endpoint. Configured provider, OAuth, remote-policy, and model-download traffic remain explicit exceptions.
- **Enterprise providers are opt-in.** Cloud connections only activate when explicitly configured.
- **Fail-closed files.** Unsupported or partially inspectable files are blocked. Rasterised output does not retain a selectable text layer; text-based formats are rebuilt from inspected content.
- **Pre-submit and pre-upload guards.** Supported DOM submits and file inputs are intercepted before release. This does not prevent a hostile site from transmitting keystrokes or making unrelated programmatic requests.
- **Enterprise OAuth2.** Short-lived delegated tokens use PKCE; client secrets are not accepted by the extension.
- **Managed identity for storage.** In enterprise mode, the Language resource accesses Blob Storage via its own identity — no SAS tokens in the extension.

The security model, limits, deployment profile, and residual risks are documented in [SECURITY_ASSURANCE.md](SECURITY_ASSURANCE.md).

---

## File Structure

```
├── manifest.json                    # MV3 manifest with managed storage schema
├── background.js                    # Service worker — routing, providers, keep-alive
├── content.js                       # Content script — guards, local AI, interception
├── offscreen.html / offscreen.js    # Offscreen Document — Canvas, WASM, PDF, AI proxy
├── popup.html / popup.js            # Toolbar popup — status, stats, "Redact Files"
├── redact.html / redact.js / .css   # Standalone batch redaction tool
├── options.html / options.js / .css # Full settings page with managed lock visuals
├── managed_schema.json              # Chromium managed storage JSON Schema
├── lib/
│   ├── browser-ai.js                # Chrome/Edge Prompt API compatibility layer
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
│   │   ├── local-ai-provider.js     # Browser AI (direct or offscreen proxy)
│   │   ├── regex-provider.js        # Regex + vector
│   │   ├── azure-pii-provider.js    # Azure PII (direct API key or OAuth2)
│   │   └── hosted-model-provider.js # Org-hosted models + OCR Extract
│   └── documents/
│       ├── document-processor.js    # Text/document formats, ZIP reader, XLSX→CSV
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
│   ├── edge-intune-policy.json      # Edge force-install + managed config
│   └── small-business-config.json   # Remote config template
├── vendor/
│   ├── setup.sh                     # Downloads pdf.js + Tesseract.js
│   ├── pdf-bridge.js                # ES module bridge for pdf.js
│   └── tesseract/                   # WASM core + trained data
├── manifests/edge.json              # Edge store metadata override
├── scripts/                         # Package creation and validation
├── tests/                           # Jest test suite
└── icons/
```

---

## Development

```bash
npm install
npm test              # Full test suite
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run build:edge    # Validated Microsoft Edge Add-ons ZIP
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
| v5 | Purview classification gate |
| v6 | Fail-closed uploads, mandatory deterministic pass, credential isolation |
| v7 | Local-only Microsoft sensitivity-label gate; retired unsupported remote Purview route |

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
