/**
 * Bridge module — loads pdf.js and its worker via ES module imports.
 *
 * IMPORT ORDER IS CRITICAL: worker must be imported BEFORE the main library.
 * Static ES module imports execute in source order. When pdf.js calls
 * _setupFakeWorker() at getDocument() time, it checks for
 * globalThis.pdfjsWorker.WorkerMessageHandler — which is already set.
 *
 * Both files are loaded here (not as regular <script> tags) because:
 *   - pdf.min.mjs uses import.meta (requires module context)
 *   - pdf.worker loaded as a regular script silently fails in Chrome
 *     extension offscreen documents
 */

// 1. Worker first — sets globalThis.pdfjsWorker with WorkerMessageHandler
import './pdf.worker.min.mjs';

// 2. Main library — sets globalThis.pdfjsLib
import './pdf.min.mjs';

// 3. Verify both loaded
const hasLib = typeof globalThis.pdfjsLib !== 'undefined';
const hasWorker = typeof globalThis.pdfjsWorker?.WorkerMessageHandler !== 'undefined';
console.log('[LLSS:pdf-bridge]',
  'pdfjsLib=' + (hasLib ? 'OK' : 'MISSING'),
  'pdfjsWorker=' + (hasWorker ? 'OK' : 'MISSING'));

// 4. Signal readiness to waitForPdfjs()
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
