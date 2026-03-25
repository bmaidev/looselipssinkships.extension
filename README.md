# Loose Lips Sink Ships

**Local-only PII redaction for Chrome.** This extension intercepts text input on web pages and redacts Personally Identifiable Information entirely on the user's machine. When Chrome's built-in AI (Gemini Nano) is available, it uses that. When it isn't, it falls back to a regex engine and a lightweight name-detection heuristic. No data ever leaves the device.

Designed for strict data governance environments, such as Australian government agencies, where sensitive data cannot leave the local machine under any circumstances.

## Features

- **Three detection engines** with automatic fallback:
  - **AI Engine** — Chrome's built-in `ai.languageModel` API (Gemini Nano, Chrome 136+)
  - **Regex Engine** — configurable pattern matching for structured PII (emails, phone numbers, TFNs, etc.)
  - **Vector Engine** — heuristic name detection using n-gram scoring for catching person names that regex misses
- **16 built-in PII types** covering Australian and international formats (TFN, ABN, Medicare, email, phone, credit cards, addresses, IP addresses, and more)
- **User-configurable rules** — add, edit, toggle, or delete PII detection types via the settings page
- **Regex tester** — test custom patterns against sample text before saving
- **Belt-and-suspenders mode** — optionally run regex *after* AI for maximum coverage
- **Contenteditable support** — works with rich text editors, not just `<textarea>` elements
- **Statistics dashboard** — track redaction counts, PII types found, and engine usage
- **Zero network calls** — all processing happens on-device

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Chrome Extension                   │
│                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐  │
│  │content.js│───>│background.js │───>│ popup.js / │  │
│  │          │<───│(svc worker)  │    │ options.js │  │
│  └──────────┘    └──────┬───────┘    └───────────┘  │
│                         │                            │
│              ┌──────────┴──────────┐                 │
│              │ redaction-engine.js │                 │
│              │   (orchestrator)    │                 │
│              └───┬──────┬─────┬───┘                 │
│                  │      │     │                      │
│           ┌──────┴┐  ┌──┴───┐ ┌┴────────┐           │
│           │  AI   │  │Regex │ │ Vector  │           │
│           │Engine │  │Engine│ │ Engine  │           │
│           └───────┘  └──────┘ └─────────┘           │
│                                                      │
│  ┌─────────────┐  ┌────────────┐                    │
│  │ pii-types.js│  │settings.js │                    │
│  │  (defaults) │  │  (storage) │                    │
│  └─────────────┘  └────────────┘                    │
└─────────────────────────────────────────────────────┘
```

### File Structure

```
├── manifest.json           # MV3 manifest with permissions and service worker
├── background.js           # Service worker — session management, message routing
├── content.js              # Injected into pages — adds Redact buttons to text fields
├── content.css             # Styles for injected UI elements
├── popup.html / popup.js   # Toolbar popup — status, stats, quick actions
├── options.html / .js / .css  # Full settings page — PII types, detection mode, stats
├── lib/
│   ├── pii-types.js        # Default PII type definitions with regex patterns
│   ├── regex-engine.js     # Regex-based redaction engine
│   ├── vector-engine.js    # Heuristic name detection (n-gram scoring)
│   ├── redaction-engine.js # Orchestrator — routes through AI → Regex → Vector
│   └── settings.js         # Settings & statistics manager (chrome.storage)
├── tests/
│   ├── regex-engine.test.js
│   ├── pii-types.test.js
│   ├── vector-engine.test.js
│   └── settings.test.js
├── icons/                  # Extension icons (16/48/128px)
└── package.json            # Dev dependencies (Jest)
```

## Setup

### Install for Development

```bash
# Clone the repository
git clone https://github.com/bmaidev/looselipssinkships.extension.git
cd looselipssinkships.extension

# Install dev dependencies (Jest for testing)
npm install
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this directory
4. The extension icon appears in the toolbar

### AI Engine Requirements

The AI engine requires:
- **Chrome 136+** (or Canary/Dev channel)
- A device with a compatible GPU
- The Gemini Nano model downloaded locally (happens automatically on first use)

If these aren't met, the extension automatically falls back to the regex + vector engines.

## Usage

### Basic Redaction

1. Navigate to any page with a text input (textarea or contenteditable)
2. A small **"Redact PII"** button appears in the top-right corner of the field
3. Type or paste text containing PII
4. Click the button — PII is replaced with bracketed tokens like `[REDACTED_EMAIL]`
5. A brief badge shows which engine was used and how many items were found

### Detection Modes

Configure via the extension's **Settings** page (right-click icon > Options):

| Mode | Behaviour |
|------|-----------|
| **Auto** (default) | Tries AI first, falls back to regex + vector |
| **AI Only** | Only uses the local AI model (fails if unavailable) |
| **Regex Only** | Pattern matching only, no AI required |

### Adding Custom PII Types

1. Open Settings > **PII Detection Rules**
2. Click **"+ Add Custom Rule"**
3. Fill in:
   - **Name**: human-readable label
   - **Token**: replacement text in `[BRACKETS]`
   - **Regex**: pattern to match (tested live)
   - **Flags**: regex flags (default: `gi`)
4. Use the **Regex Tester** to validate your pattern
5. Click **Save Settings**

### Built-in PII Types

| Category | Types |
|----------|-------|
| Contact | Email, Phone (AU), Phone (International), Street Address, Postcode (AU) |
| Financial | TFN, ABN, ACN, Credit Card, BSB, Bank Account |
| Health | Medicare Number |
| Identity | Passport, Driver Licence, Date of Birth |
| Technical | IPv4, IPv6 |

All types can be individually toggled on/off.

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

The test suite covers:
- **Regex engine**: pattern matching, overlap handling, disabled types, custom types
- **Vector engine**: name scoring, trigram similarity, detection thresholds
- **PII types**: validation, ID generation, regex validity
- **Settings**: merging, overrides, custom types, defaults

## How the Fallback Chain Works

```
1. Check user's detection mode setting
2. If "auto" or "ai_only":
   a. Check ai.languageModel.availability()
   b. If "readily" or "downloadable" → use AI engine
   c. Build system prompt dynamically from enabled PII types
   d. Send text through session.prompt()
3. If AI fails or mode is "regex_only":
   a. Run regex engine with all enabled PII types
   b. Sort patterns by priority, apply non-overlapping matches
   c. If vector fallback enabled:
      - Scan redacted text for name-like word sequences
      - Score candidates using prefix context + known name lists
      - Replace high-confidence matches with [REDACTED_NAME]
4. Record statistics (engine used, match count, types found)
```

## Privacy & Security

- **Zero network calls**: no data is sent to external servers, ever
- **No telemetry**: the extension collects no usage data
- **Local storage only**: settings and stats use `chrome.storage.local`
- **AI runs on-device**: Chrome's Gemini Nano model processes text locally
- **Open source**: full source code available for audit

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes and add tests
4. Run `npm test` to verify all tests pass
5. Commit with a descriptive message
6. Open a pull request

### Code Style

- Vanilla JS (no build step, no framework)
- All library modules in `lib/` export via both `globalThis` (for the extension) and `module.exports` (for Jest)
- Service worker uses `importScripts()` to load library modules
- Content script and options page load library modules via `<script>` tags

## Licence

MIT
