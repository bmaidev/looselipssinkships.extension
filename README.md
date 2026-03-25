# Loose Lips Sink Ships

Enterprise-grade PII redaction for Chrome with local-first processing. Designed for Australian government agencies and secure enterprise environments.

## Architecture

**Progressive Processing Pipeline: Local → Hosted → Cloud**

```
Content Input (text / document)
       │
       ▼
┌─────────────────────────────────────────────┐
│  Pipeline Router (lib/pipeline.js)          │
│  Selects best provider based on:            │
│  - Content type (text, docx, image...)      │
│  - Provider availability                    │
│  - Tier preference (local first)            │
│  - User configuration                       │
└─────────┬───────────┬───────────┬───────────┘
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
    │ Vector    │ │         │ │             │
    │ Names     │ │         │ │             │
    └───────────┘ └─────────┘ └─────────────┘
```

## Features

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
- **Images** — Routes to hosted/cloud providers with OCR capability.
- **PDF** — Routes to hosted/cloud providers for extraction.

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
- **Azure PII** — Full Azure AI Language integration with Australian entity categories.
- **Purview DLP** — Microsoft 365 sensitive information type detection.
- **Belt-and-suspenders mode** — Run regex after AI for extra safety.
- **Custom PII rules** — Add organisation-specific patterns via the settings page.
- **Provider health monitoring** — Real-time status of all configured providers.
- **Statistics tracking** — Redaction counts by engine, tier, document type, and PII category.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in top-right).
4. Click **Load unpacked** and select the extension directory.
5. The shield icon appears in the toolbar.

**Requirements:**
- Chrome 128+ (for Gemini Nano, Chrome 136+ recommended)
- For Azure/Purview: valid Azure subscription and credentials
- For hosted models: network access to your organisation's endpoint

## Configuration

### Quick Start (Local Only)
Works out of the box. Gemini Nano + regex fallback requires no configuration.

### Enterprise Setup
1. Click the extension icon → **Settings**.
2. Under **Processing Providers**, configure your providers:
   - Enable/configure **Azure AI Language PII Detection** with your endpoint and API key.
   - Enable/configure **Microsoft Purview DLP** with your tenant ID and app registration.
   - Add **Hosted Providers** for organisation-hosted models (supports OpenAI-compatible APIs and custom PII detection APIs).
3. Set **Detection Mode** to "Auto" for progressive local-first routing.
4. Save settings. Providers reinitialise automatically.

### Document Upload
Enable "Redact File" buttons in settings to upload documents directly from any text field on any webpage. Extracted text is redacted through the same pipeline.

## File Structure

```
├── manifest.json                    # Chrome extension manifest v3
├── background.js                    # Service worker — thin orchestrator
├── content.js                       # Injected UI (buttons, file upload, overlays)
├── content.css                      # Injected styles
├── popup.html / popup.js            # Toolbar popup (status, stats)
├── options.html / options.js / .css # Full settings page
├── lib/
│   ├── pii-types.js                 # 17 default PII type definitions
│   ├── regex-engine.js              # Pattern-based redaction with overlap resolution
│   ├── vector-engine.js             # Heuristic name detection (trigram similarity)
│   ├── redaction-engine.js          # Legacy orchestrator (AI/regex/vector routing)
│   ├── settings.js                  # Storage abstraction + migration
│   ├── pipeline.js                  # Progressive processing pipeline
│   ├── providers/
│   │   ├── base-provider.js         # Abstract provider interface
│   │   ├── provider-registry.js     # Provider lifecycle + capability routing
│   │   ├── local-ai-provider.js     # Gemini Nano (on-device)
│   │   ├── regex-provider.js        # Regex + vector (always available)
│   │   ├── azure-pii-provider.js    # Azure AI Language PII Detection
│   │   ├── purview-provider.js      # Microsoft Purview DLP
│   │   └── hosted-model-provider.js # Organisation-hosted models
│   └── documents/
│       └── document-processor.js    # File parsing (DOCX, XLSX, HTML, MD)
├── tests/
│   ├── provider-registry.test.js
│   ├── document-processor.test.js
│   ├── pipeline.test.js
│   ├── regex-engine.test.js
│   ├── vector-engine.test.js
│   ├── pii-types.test.js
│   └── settings.test.js
└── icons/
```

## Development

```bash
npm install
npm test              # Run all 132 tests
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

## Privacy & Security

- **Local-first by default.** Gemini Nano and regex run entirely on-device.
- **No telemetry.** The extension collects no analytics and phones home to nowhere.
- **Enterprise providers are opt-in.** Azure, Purview, and hosted model connections only activate when explicitly configured.
- **Credentials stored locally.** API keys are saved in `chrome.storage.local` (not synced).
- **Document processing is local.** DOCX, XLSX, HTML, and Markdown are parsed in the browser using built-in APIs. Only images and PDFs require a provider with those capabilities.

## License

MIT
