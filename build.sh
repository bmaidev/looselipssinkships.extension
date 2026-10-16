#!/usr/bin/env bash
# Package store-ready Chrome and Microsoft Edge Manifest V3 extensions.
#
# Usage:
#   ./build.sh              # both browser packages
#   ./build.sh chrome       # Chrome Web Store package only
#   ./build.sh edge         # Microsoft Edge Add-ons package only

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

TARGET="${1:-all}"
case "${TARGET}" in
  all) TARGETS=(chrome edge) ;;
  chrome|edge) TARGETS=("${TARGET}") ;;
  *)
    echo "Usage: ./build.sh [all|chrome|edge]" >&2
    exit 2
    ;;
esac

VERSION="$(node -p "require('./manifest.json').version")"
OUTDIR="${ROOT_DIR}/dist"
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/llss-build.XXXXXX")"
trap 'rm -rf -- "${BUILD_ROOT}"' EXIT

PACKAGE_SOURCES=(
  manifest.json
  managed_schema.json
  background.js
  content.js
  content.css
  offscreen.html
  offscreen.js
  popup.html
  popup.js
  redact.html
  redact.js
  redact.css
  options.html
  options.js
  options.css
  LICENSE.md
  THIRD_PARTY_NOTICES.md
  lib
  vendor
  icons
)

if [[ ! -f "vendor/tesseract/tesseract.min.js" ]]; then
  echo "ERROR: Vendor files are missing. Run vendor/setup.sh before packaging." >&2
  exit 1
fi

mkdir -p "${OUTDIR}"
echo "Loose Lips Sink Ships — packaging v${VERSION}"

for browser in "${TARGETS[@]}"; do
  stage="${BUILD_ROOT}/${browser}"
  mkdir -p "${stage}"

  for source in "${PACKAGE_SOURCES[@]}"; do
    cp -Rp "${source}" "${stage}/"
  done
  # Remove known development-only files from the isolated staging directory.
  find "${stage}" -name .DS_Store -type f -delete
  rm -f -- "${stage}/vendor/setup.sh"

  if [[ "${browser}" == "edge" ]]; then
    node scripts/build-manifest.js \
      manifest.json manifests/edge.json "${stage}/manifest.json" edge
    outfile="${OUTDIR}/loose-lips-sink-ships-edge-v${VERSION}.zip"
  else
    outfile="${OUTDIR}/loose-lips-sink-ships-v${VERSION}.zip"
  fi

  node scripts/validate-extension.js "${stage}" "${browser}" --package
  # ZIP records DOS timestamps. Normalising staged files makes repeated builds
  # from the same source byte-for-byte reproducible across Chrome and Edge.
  find "${stage}" -type f -exec touch -t 198001010000 {} +
  rm -f -- "${outfile}"
  (
    cd "${stage}"
    find . -type f -print | LC_ALL=C sort | zip -q -X "${outfile}" -@
  )
  unzip -tq "${outfile}" >/dev/null

  bytes="$(wc -c < "${outfile}" | tr -d ' ')"
  size="$(du -h "${outfile}" | cut -f1)"
  if [[ "${bytes}" -gt 20000000 ]]; then
    echo "WARNING: ${browser} package exceeds the conservative 20 MB review threshold." >&2
  fi
  echo "  ${browser}: ${outfile} (${size})"
done

echo "Package validation and ZIP integrity checks passed."
