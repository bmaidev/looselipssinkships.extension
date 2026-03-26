/**
 * Bridge module — imports pdf.min.mjs (which requires ES module context for
 * import.meta) and signals readiness.
 *
 * By the time this module executes, pdf.worker.min.mjs has already been loaded
 * as a regular <script> tag, setting globalThis.pdfjsWorker. pdf.js detects
 * pdfjsWorker.WorkerMessageHandler at getDocument() time and runs inline.
 */
import './pdf.min.mjs';

// Signal readiness
globalThis.__pdfjsReady = true;
document.dispatchEvent(new Event('pdfjsReady'));
