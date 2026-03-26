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

// pdf.js v4 requires a valid workerSrc — point to the worker bundle.
// import.meta.url gives us the module's own URL, so we can resolve relative paths.
globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('./pdf.worker.min.mjs', import.meta.url).href;

// Signal that pdf.js is ready
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
