/**
 * Bridge module — imports pdf.js (ES module) and ensures globalThis.pdfjsLib
 * is set before signalling readiness.
 *
 * pdf.min.mjs uses import.meta which requires module context. Regular scripts
 * can't load it. This bridge is loaded as type="module" and fires a custom
 * event when pdfjsLib is available.
 */

// Step 1: Import the main pdf.js library (sets globalThis.pdfjsLib)
import './pdf.min.mjs';

if (!globalThis.pdfjsLib) {
  console.error('[LLSS:pdf-bridge] pdf.min.mjs loaded but pdfjsLib not on globalThis');
}

// Step 2: Import the worker code inline (sets globalThis.pdfjsWorker).
// pdf.js detects pdfjsWorker.WorkerMessageHandler and uses _setupFakeWorker()
// (inline mode) instead of spawning a Web Worker.
// Use dynamic import so a failure here doesn't abort the entire bridge.
try {
  await import('./pdf.worker.min.mjs');
} catch (err) {
  console.warn('[LLSS:pdf-bridge] Worker import failed, falling back to workerSrc:', err);
  // Fallback: set workerSrc so pdf.js can try creating a web worker.
  // This may fail in MV3 extension contexts but pdf.js will then use fake worker.
  if (globalThis.pdfjsLib) {
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
      new URL('./pdf.worker.min.mjs', import.meta.url).href;
  }
}

console.log('[LLSS:pdf-bridge] Ready:',
  'pdfjsLib=' + (globalThis.pdfjsLib ? 'OK' : 'MISSING'),
  'pdfjsWorker=' + (globalThis.pdfjsWorker?.WorkerMessageHandler ? 'OK (inline)' : 'MISSING'));

// Signal that pdf.js is ready
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
