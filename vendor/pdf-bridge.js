/**
 * Bridge module — imports pdf.js (ES module) and ensures globalThis.pdfjsLib
 * and globalThis.pdfjsWorker are set before signalling readiness.
 *
 * IMPORT ORDER MATTERS: worker MUST be imported BEFORE pdf.min.mjs.
 * Static imports are evaluated in source order for sibling dependencies.
 * When pdf.js checks for globalThis.pdfjsWorker?.WorkerMessageHandler at
 * getDocument() time, the worker code is already loaded and available.
 */

// 1. Worker code first — sets globalThis.pdfjsWorker (with WorkerMessageHandler)
import './pdf.worker.min.mjs';

// 2. Main library — sets globalThis.pdfjsLib
import './pdf.min.mjs';

// 3. Diagnostics
const hasPdfjsLib = typeof globalThis.pdfjsLib !== 'undefined';
const hasWorker = typeof globalThis.pdfjsWorker?.WorkerMessageHandler !== 'undefined';
console.log('[LLSS:pdf-bridge] pdfjsLib=' + (hasPdfjsLib ? 'OK' : 'MISSING') +
            ' pdfjsWorker=' + (hasWorker ? 'OK (inline)' : 'MISSING'));

// 4. Signal readiness
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
