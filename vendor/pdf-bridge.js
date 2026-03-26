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

// Disable pdf.js web worker — run in the offscreen document's main thread
globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = '';

// Signal that pdf.js is ready
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
