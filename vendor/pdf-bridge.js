/**
 * Bridge module — imports pdf.js (ES module) and ensures globalThis.pdfjsLib
 * is set before signalling readiness.
 *
 * pdf.min.mjs uses import.meta which requires module context. Regular scripts
 * can't load it. This bridge is loaded as type="module" and fires a custom
 * event when pdfjsLib is available.
 */
import './pdf.min.mjs';

// pdf.min.mjs sets globalThis.pdfjsLib via webpack, but confirm it:
if (!globalThis.pdfjsLib) {
  console.error('[LLSS] pdf.min.mjs loaded but pdfjsLib not on globalThis');
}

// Disable the pdf.js web worker — the offscreen document is already off the
// UI thread, so a worker-in-a-worker just adds complexity.  The .mjs worker
// file can't be loaded as a classic web worker anyway (needs module worker
// support which isn't available in all extension contexts).
//
// Setting workerSrc to empty string no longer works in v4.  Instead, import
// the worker code directly so pdf.js detects it and runs inline.
import './pdf.worker.min.mjs';

// Signal that pdf.js is ready
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
