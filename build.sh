#!/usr/bin/env bash
# build.sh — Package the extension for Chrome Web Store submission.
#
# Usage:
#   chmod +x build.sh && ./build.sh
#
# Output:
#   dist/loose-lips-sink-ships-v{version}.zip
#
# Excludes: .git, tests, node_modules, .claude, server, enterprise templates,
#           package.json, build scripts, and other dev-only files.

set -euo pipefail

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUTDIR="dist"
OUTFILE="${OUTDIR}/loose-lips-sink-ships-v${VERSION}.zip"

echo "=== Loose Lips Sink Ships — Build v${VERSION} ==="
echo ""

# Clean previous builds
rm -rf "${OUTDIR}"
mkdir -p "${OUTDIR}"

# Check vendor files exist
if [ ! -f "vendor/tesseract/tesseract.min.js" ]; then
  echo "WARNING: Vendor files missing. Run vendor/setup.sh first for PDF/image support."
  echo ""
fi

# Create the zip — include only extension files
zip -r "${OUTFILE}" \
  manifest.json \
  managed_schema.json \
  background.js \
  content.js \
  content.css \
  offscreen.html \
  offscreen.js \
  popup.html \
  popup.js \
  redact.html \
  redact.js \
  redact.css \
  options.html \
  options.js \
  options.css \
  lib/ \
  vendor/ \
  icons/ \
  -x "*.DS_Store" \
  -x "__MACOSX/*" \
  -x "vendor/setup.sh" \
  2>/dev/null

# Show results
echo ""
echo "=== Build complete ==="
FILESIZE=$(du -h "${OUTFILE}" | cut -f1)
echo "  Output: ${OUTFILE}"
echo "  Size:   ${FILESIZE}"
echo "  Version: ${VERSION}"

# Warn if too large
BYTES=$(wc -c < "${OUTFILE}" | tr -d ' ')
if [ "${BYTES}" -gt 20000000 ]; then
  echo ""
  echo "WARNING: File exceeds 20MB Chrome Web Store limit!"
fi

echo ""
echo "Upload this file to the Chrome Web Store Developer Dashboard:"
echo "  https://chrome.google.com/webstore/devconsole"
