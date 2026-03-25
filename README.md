# Loose Lips Sink Ships

Enterprise-grade PII redaction for Chrome with local-first processing. Designed for Australian government agencies and secure enterprise environments.

## Architecture

**Progressive Processing Pipeline: Local → Hosted → Cloud**

```
Content Input (text / document / upload)
       │
       ▼
┌──────────────────────────────────────────────────┐
│  Site Filter (lib/site-filter.js)                │
│  Whitelist / Blacklist / All sites               │
│  AI Chat Service auto-detection (30+ services)   │
└──────────┬───────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│  Content Guards (content.js)                     │
│  - Auto-redact on type/paste                     │
│  - Submit interception (Enter, forms, buttons)   │
│  - Upload interception (file inputs, drag-drop)  │
│  - Security Handshake (Shadow DOM overlay)       │
└──────────┬───────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│  Pipeline Router (lib/pipeline.js)               │
│  Selects best provider based on content type,    │
│  availability, tier preference, user config      │
└─────────┬───────────┬───────────┬────────────────┘
          │           │           │
    ┌─────▼─────┐ ┌──▼──────┐ ┌─▼──────────┐
    │  LOCAL     │ │ HOSTED  │ │  CLOUD      │
    │           │ │         │ │             │
    │ Gemini    │ │ Org LLM │ │ Azure PII   │
    │ Nano      │ │ (vLLM,  │ │ Detection   │
    │           │ │ Ollama, │ │             │
    │ Regex     │ │ TGI,    │ │ Microsoft   │
    │ Engine    │ │ custom) │ │ Purview DLP │
    │           │ │         │ │             │
    │ Vector    │ │ OCR     │ │             │
    │ Names     │ │ Extract │ │             │
    │           │ │ Server  │ │             │
    │ PDF/Image │ │         │ │             │
    │ OCR       │ │         │ │             │
    └───────────┘ └─────────┘ └─────────────┘
```

## Features

### PDF & Image Redaction (Provably Secure)
Local OCR-based redaction for PDFs and images. Uses image-based flattening — there is **no hidden text layer** in the output, so copy-paste / select-all cannot recover redacted content.

- **PDF rendering** — pdf.js renders each page to a canvas image at 2× scale.
- **OCR extraction** — Tesseract.js extracts text + word-level bounding boxes.
- **PII detection** — Existing pipeline (Gemini Nano / regex / hosted) finds PII in the extracted text.
- **Pixel redaction** — Black rectangles drawn at the bounding box coordinates on the canvas.
- **PDF reconstruction** — Redacted page images assembled into a new image-only PDF.
- **Worker pool** — 4 parallel Tesseract.js workers for documents with 4+ pages (~4× speedup).
- **Chunked rendering** — Pages rendered in groups of 5, canvases released after OCR, re-rendered only for redaction (memory-efficient for 50-page PDFs).
- **Optional OCR container** — Self-hosted FastAPI + Tesseract 5 + Poppler for server-grade accuracy (see [OCR Container Setup](#ocr-container-setup)).

### Security Handshake (Visual Interception)
When a user uploads a file, the extension performs a "Security Handshake" — intercepting the upload before the target site sees it.

- **Shadow DOM overlay** — Closed shadow root prevents style leakage. Shows a document icon with scanning laser-line animation.
- **Event blocking** — `stopImmediatePropagation()` in capture phase blocks the site's change/drop handlers.
- **File replacement** — After redaction, a new `File` object is created from the redacted bytes and injected into the original input via `DataTransfer` API. The target site receives the secured file transparently.
- **Progress reporting** — Real-time render %, OCR %, and redaction % per page.
- **Skip button** — Users can bypass redaction at any time.
- **Multi-file queue** — `AsyncQueue` with bounded concurrency (max 2 active files) prevents CPU pegging on bulk drops.

### AI Chat Guard
Automatically protects against PII being submitted to AI chat services.
- **Auto-detects 30+ services** — ChatGPT, Claude, Gemini (all interfaces), Copilot, Grok, DeepSeek, Perplexity, Mistral, Poe, Character.AI, HuggingChat, Meta AI, and more.
- **Custom AI domains** — Add internal or self-hosted AI services (e.g. `internal-ai.agency.gov.au`).
- **Protection banner** — Visual indicator when active on an AI chat site.
- **Respects site filtering** — Blacklisted sites are fully excluded, even if they're AI services.

### Site Filtering
- **All sites** (default) — Extension active everywhere.
- **Whitelist mode** — Only active on listed sites (e.g. `*.gov.au`, `internal.agency.gov.au`).
- **Blacklist mode** — Active everywhere except listed sites.
- **Pattern support** — Exact domains, wildcard subdomains (`*.example.com`), dot-suffix (`.gov.au`), full URL prefixes (`https://portal.agency.gov.au/*`).

### Auto-Redact
Automatically redact PII as users type or paste, without requiring a button click.
- **Debounced typing detection** — Waits for a pause (configurable 500ms–5s) before redacting.
- **Immediate paste redaction** — Redacts pasted content right away.
- **AI-site-only default** — Only activates on detected AI chat services unless globally enabled.

### Submit Interception
Intercepts form submissions and send actions to ensure redaction is complete.
- **Enter key interception** — Catches Enter-to-send in chat UIs.
- **Form submit interception** — Blocks form submission, redacts all text fields, then resubmits.
- **Send button detection** — Heuristic detection of send/submit buttons (text content, `aria-label`, SVG icons, `data-testid`, `type=submit`).
- **In-flight protection** — Blocks submission while any redaction is still processing.

### Upload Interception
Intercepts file uploads to redact documents before they leave the page.
- **File input monitoring** — Catches `<input type="file">` changes and blocks propagation.
- **Drag-and-drop interception** — Captures drop events with `preventDefault()` and `stopImmediatePropagation()`.
- **File replacement** — Secured files injected into the original input via `DataTransfer`, then the event is re-dispatched.
- **Confirmation dialog** — "Check & Redact" or "Skip (Upload as-is)".
- **Supports** — DOCX, XLSX, PDF, HTML, Markdown, TXT, CSV, PNG, JPG, GIF, WebP, BMP, TIFF.

### Detection Engines
- **Gemini Nano (Local AI)** — Chrome's built-in on-device model. Zero network calls.
- **Regex Engine** — 17 built-in Australian PII patterns. Always available as fallback.
- **Vector Name Detection** — Heuristic name detection using trigram similarity.
- **Azure AI Language** — Microsoft's PII detection API with Australian entity support.
- **Microsoft Purview** — M365 DLP sensitive information types and trainable classifiers.
- **Organisation-Hosted Models** — Connect to your own infrastructure (vLLM, Ollama, TGI, Azure OpenAI, or custom PII APIs).

### Document Processing
- **Word (.docx)** — Local XML-based text extraction, no external dependencies.
- **Excel (.xlsx)** — Local spreadsheet parsing with shared strings support.
- **HTML** — DOM-based text extraction with script/style stripping.
- **Markdown** — Formatting-aware text extraction.
- **PDF** — Local OCR via pdf.js + Tesseract.js in Offscreen Document. Image-based flattening for provably secure redaction.
- **Images** — Local OCR via Tesseract.js. Pixel-level redaction on canvas.

### 17 Built-in PII Types (Australian Focus)
| Category | Types |
|----------|-------|
| Contact | Email, Phone (AU), Phone (International), Street Address, Postcode |
| Financial | TFN, ABN, ACN, Credit Card, BSB, Bank Account |
| Health | Medicare Number |
| Identity | Passport, Driver Licence, Date of Birth |
| Technical | IPv4, IPv6 |

### Enterprise Features
- **Provider hierarchy** — Local → Hosted → Cloud with automatic fallback.
- **Multiple hosted providers** — Connect several organisation-hosted models simultaneously.
- **OCR Extract server** — Optional containerised Tesseract 5 + Poppler for high-accuracy OCR.
- **Azure PII** — Full Azure AI Language integration with Australian entity categories.
- **Purview DLP** — Microsoft 365 sensitive information type detection.
- **Belt-and-suspenders mode** — Run regex after AI for extra safety.
- **Custom PII rules** — Add organisation-specific patterns via the settings page.
- **Provider health monitoring** — Real-time status of all configured providers.
- **Statistics tracking** — Redaction counts by engine, tier, document type, PII category, submits intercepted, uploads checked, and auto-redactions.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in top-right).
4. Click **Load unpacked** and select the extension directory.
5. The shield icon appears in the toolbar.

### Vendor Dependencies (PDF/Image Support)

PDF and image redaction require pdf.js and Tesseract.js. Install them with:

```bash
chmod +x vendor/setup.sh
./vendor/setup.sh
```

This downloads ~15MB of vendor files (pdf.js, Tesseract.js WASM core, and English OCR trained data). The extension works without these files — PDF/image processing falls back to hosted/cloud providers.

### OCR Container Setup

For agencies wanting server-grade OCR accuracy or batch processing:

```bash
cd server/
docker-compose up -d
```

Then in extension settings: **Hosted Providers** → Add new → **API Mode: OCR Extract Server** → Endpoint: `http://localhost:8000`.

The container only extracts text + bounding boxes. All PII detection and redaction stays in the browser.

**Requirements:**
- Chrome 128+ (for Gemini Nano, Chrome 136+ recommended)
- For PDF/image: run `vendor/setup.sh` (or configure hosted/cloud OCR)
- For Azure/Purview: valid Azure subscription and credentials
- For hosted models: network access to your organisation's endpoint

## Configuration

### Quick Start (Local Only)
Works out of the box. Gemini Nano + regex fallback requires no configuration. AI Chat Guard is enabled by default.

### Site Filtering
1. Open **Settings** → **Site Filtering**.
2. Choose **Whitelist** to restrict to specific sites (e.g. `*.gov.au`), or **Blacklist** to exclude sites.
3. Enter one pattern per line.

### AI Chat Guard
Enabled by default. On any detected AI service, the extension will:
- Show a protection banner.
- Auto-redact text before submission.
- Intercept Enter/send to ensure redaction completes.
- Check uploaded files for PII.

To add internal AI services, go to **Settings** → **AI Chat Guard** → **Additional AI domains**.

### Auto-Redact
Off globally by default. Auto-activates on AI chat sites when AI Chat Guard is enabled.
- To enable globally: **Settings** → **Auto-Redact** → uncheck "Only auto-redact on AI chat sites".
- Adjust debounce timing to balance responsiveness vs. processing load.

### Enterprise Setup
1. Click the extension icon → **Settings**.
2. Under **Processing Providers**, configure your providers:
   - Enable/configure **Azure AI Language PII Detection** with your endpoint and API key.
   - Enable/configure **Microsoft Purview DLP** with your tenant ID and app registration.
   - Add **Hosted Providers** for organisation-hosted models (supports OpenAI-compatible APIs, custom PII detection APIs, and OCR Extract servers).
3. Set **Detection Mode** to "Auto" for progressive local-first routing.
4. Save settings. Providers reinitialise automatically.

### Document Upload
Enable "Redact File" buttons in settings to upload documents directly from any text field on any webpage. Extracted text is redacted through the same pipeline. PDFs and images are processed via local OCR (requires vendor setup) or hosted/cloud providers.

## File Structure

```
├── manifest.json                    # Chrome extension manifest v3
├── background.js                    # Service worker — message routing, providers, offscreen mgmt
├── content.js                       # Content script — UI, guards, interception, Shadow DOM overlay
├── content.css                      # Injected styles (buttons, banners, overlays)
├── offscreen.html / offscreen.js    # Offscreen Document — Canvas/WASM for PDF/image processing
├── popup.html / popup.js            # Toolbar popup (status, stats, providers)
├── options.html / options.js / .css # Full settings page
├── lib/
│   ├── site-filter.js               # URL matching, AI service detection
│   ├── pii-types.js                 # 17 default PII type definitions
│   ├── regex-engine.js              # Pattern-based redaction with overlap resolution
│   ├── vector-engine.js             # Heuristic name detection (trigram similarity)
│   ├── redaction-engine.js          # AI/regex/vector routing (legacy compat)
│   ├── settings.js                  # Storage, migration (v1→v2→v3)
│   ├── pipeline.js                  # Progressive processing pipeline
│   ├── providers/
│   │   ├── base-provider.js         # Abstract provider interface
│   │   ├── provider-registry.js     # Provider lifecycle + capability routing
│   │   ├── local-ai-provider.js     # Gemini Nano (on-device)
│   │   ├── regex-provider.js        # Regex + vector (always available)
│   │   ├── azure-pii-provider.js    # Azure AI Language PII Detection
│   │   ├── purview-provider.js      # Microsoft Purview DLP
│   │   └── hosted-model-provider.js # Org-hosted models + OCR Extract
│   └── documents/
│       ├── document-processor.js    # File parsing (DOCX, XLSX, HTML, MD)
│       ├── pdf-renderer.js          # pdf.js wrapper — PDF pages to canvas
│       ├── ocr-processor.js         # Tesseract.js — OCR with worker pool
│       ├── pixel-redactor.js        # Canvas redaction + PDF reconstruction
│       └── async-queue.js           # FIFO task queue with concurrency control
├── vendor/
│   ├── setup.sh                     # Downloads pdf.js + Tesseract.js
│   └── tesseract/                   # Tesseract.js WASM + trained data
├── server/
│   ├── Dockerfile                   # OCR container (Tesseract 5 + Poppler)
│   ├── main.py                      # FastAPI — POST /extract endpoint
│   ├── docker-compose.yml           # One-command deployment
│   └── requirements.txt             # Python dependencies
├── tests/
│   ├── site-filter.test.js
│   ├── provider-registry.test.js
│   ├── document-processor.test.js
│   ├── pipeline.test.js
│   ├── regex-engine.test.js
│   ├── vector-engine.test.js
│   ├── pii-types.test.js
│   ├── settings.test.js
│   ├── pixel-redactor.test.js       # PII→bbox mapping, PDF builder
│   ├── pdf-renderer.test.js
│   ├── ocr-processor.test.js        # Worker pool exports
│   └── async-queue.test.js          # Concurrency, FIFO, callbacks
└── icons/
```

## Development

```bash
npm install
npm test              # Run all 203 tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Adding a New Provider

1. Create a new class extending `BaseProvider` in `lib/providers/`.
2. Implement `checkAvailability()`, `redactText()`, and optionally `redactDocument()`.
3. Register it in `background.js`'s `initProviders()`.
4. Add configuration UI to `options.html` / `options.js`.
5. Add tests.

### Adding Custom PII Types

Via the Settings page, or programmatically:
```javascript
{
  id: "student_id",
  name: "Student ID",
  description: "University student identifier",
  token: "[REDACTED_STUDENT_ID]",
  regex: "\\bSTU-\\d{6}\\b",
  flags: "gi",
  enabled: true,
  category: "custom"
}
```

### Adding AI Chat Service Domains

To detect a new AI service, add its domain to `AI_CHAT_DOMAINS` in `lib/site-filter.js`. Users can also add custom domains via the settings page without code changes.

## Settings Schema

Settings are stored in `chrome.storage.local` with automatic migration across versions.

| Version | Changes |
|---------|---------|
| v1 | Initial: detection mode, vector fallback, PII overrides |
| v2 | Added: provider configuration, document upload |
| v3 | Added: site filter, AI chat guard, auto-redact, submit/upload guard |

## Privacy & Security

- **Local-first by default.** Gemini Nano and regex run entirely on-device.
- **No telemetry.** The extension collects no analytics and phones home to nowhere.
- **Enterprise providers are opt-in.** Azure, Purview, and hosted model connections only activate when explicitly configured.
- **Credentials stored locally.** API keys are saved in `chrome.storage.local` (not synced).
- **Document processing is local.** DOCX, XLSX, HTML, Markdown, PDF, and images are all processed in the browser. PDF/image OCR runs in an Offscreen Document using WASM — no document content leaves the browser unless a hosted/cloud provider is explicitly configured.
- **Provably secure redaction.** PDF/image output uses image-based flattening — there is no hidden text layer. The `pdf-lib` overlay approach (which 65% of government "redacted" PDFs use) is deliberately avoided.
- **AI Chat Guard protects outbound data.** Redaction happens before text leaves the text field, not after.
- **Submit interception is pre-send.** The extension blocks the submit action, redacts, then re-dispatches — content is never sent unredacted.
- **Upload interception is pre-upload.** Files are intercepted, redacted, and replaced before the target site's handlers run. The original unredacted file never reaches the site's JavaScript.

## License

MIT
