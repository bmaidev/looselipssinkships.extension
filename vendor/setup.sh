#!/usr/bin/env bash
# vendor/setup.sh — Downloads required vendor libraries for PDF/image redaction.
#
# Run from the extension root:
#   chmod +x vendor/setup.sh && ./vendor/setup.sh
#
# Libraries downloaded:
#   1. pdf.js (pdfjs-dist) — PDF rendering
#   2. Tesseract.js — OCR with WASM
#
# Total size: ~15MB (including trained data for English OCR)

set -euo pipefail
cd "$(dirname "$0")"

PDFJS_VERSION="4.9.155"
TESSERACT_VERSION="5.1.1"
TESSERACT_CORE_VERSION="5.1.0"

echo "=== Loose Lips Sink Ships — Vendor Setup ==="
echo ""

# ── pdf.js ────────────────────────────────────────────────────────────────────

echo "[1/4] Downloading pdf.js v${PDFJS_VERSION}..."
curl -sL "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs" -o pdf.min.mjs
curl -sL "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs" -o pdf.worker.min.mjs
echo "      ✓ pdf.min.mjs, pdf.worker.min.mjs"

# ── Tesseract.js ──────────────────────────────────────────────────────────────

echo "[2/4] Downloading Tesseract.js v${TESSERACT_VERSION}..."
curl -sL "https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js" -o tesseract/tesseract.min.js
echo "      ✓ tesseract/tesseract.min.js"

echo "[3/4] Downloading Tesseract.js core WASM v${TESSERACT_CORE_VERSION}..."
curl -sL "https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd.wasm.js" -o tesseract/tesseract-core-simd.wasm.js
curl -sL "https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd.wasm" -o tesseract/tesseract-core-simd.wasm
echo "      ✓ tesseract/tesseract-core-simd.wasm.js, .wasm"

echo "[4/4] Downloading Tesseract trained data (English — fast model)..."
mkdir -p tesseract/lang-data
curl -sL "https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/lang-data/eng.traineddata.gz" -o tesseract/lang-data/eng.traineddata.gz 2>/dev/null || \
curl -sL "https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata.gz" -o tesseract/lang-data/eng.traineddata.gz
echo "      ✓ tesseract/lang-data/eng.traineddata.gz"

echo ""
echo "=== Setup complete ==="
echo "Vendor files installed:"
du -sh . | awk '{print "  Total: " $1}'
echo ""
echo "The extension is ready for PDF/image redaction."
