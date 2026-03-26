/**
 * OCR Processor — wraps Tesseract.js for text extraction with bounding boxes.
 * Runs inside the Offscreen Document.
 *
 * Supports two modes:
 *   1. Single worker   — for 1–3 page documents (low overhead)
 *   2. Worker pool      — for 4+ page documents (hardware parallelism)
 *
 * The pool distributes pages round-robin across N workers, turning
 * a 60-second single-thread OCR task into a ~15-second multi-thread task.
 */

(function () {
  const DEFAULT_POOL_SIZE = 4;
  const POOL_THRESHOLD = 4; // Use pool for documents with >= this many pages

  let worker = null;
  let workerPool = [];
  let poolSize = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getUrl(p) {
    return typeof chrome !== 'undefined' && chrome.runtime
      ? chrome.runtime.getURL(p)
      : p;
  }

  function buildBlocks(data) {
    return (data.lines || []).map((line) => ({
      text: line.text.trim(),
      bbox: {
        x: line.bbox.x0,
        y: line.bbox.y0,
        w: line.bbox.x1 - line.bbox.x0,
        h: line.bbox.y1 - line.bbox.y0,
      },
      confidence: line.confidence,
      words: (line.words || []).map((word) => ({
        text: word.text,
        bbox: {
          x: word.bbox.x0,
          y: word.bbox.y0,
          w: word.bbox.x1 - word.bbox.x0,
          h: word.bbox.y1 - word.bbox.y0,
        },
        confidence: word.confidence,
      })),
    }));
  }

  async function createWorker() {
    const Tesseract = globalThis.Tesseract;
    if (!Tesseract) {
      throw new Error('Tesseract.js not loaded. Run vendor/setup.sh to install dependencies.');
    }
    return Tesseract.createWorker('eng', 1, {
      workerPath: getUrl('vendor/tesseract/tesseract.min.js'),
      corePath: getUrl('vendor/tesseract/tesseract-core-simd.wasm.js'),
      langPath: getUrl('vendor/tesseract/lang-data'),
      cacheMethod: 'none',
      // MV3 offscreen documents can't use blob URL workers (importScripts fails).
      // Setting workerBlobURL to false creates the worker directly from the URL.
      workerBlobURL: false,
    });
  }

  // ── Single worker (small docs) ─────────────────────────────────────────────

  async function getWorker() {
    if (worker) return worker;
    worker = await createWorker();
    return worker;
  }

  /**
   * OCR a single image.
   * @param {ImageData|HTMLCanvasElement|Blob|string} image
   * @returns {Promise<{text: string, blocks: Array}>}
   */
  /**
   * Convert a canvas or ImageData to a PNG blob for Tesseract.
   * Tesseract.js workers can't access DOM elements (canvas), so we
   * convert to a blob in the main thread before sending.
   */
  function toBlob(image) {
    if (image instanceof Blob) return Promise.resolve(image);
    // Canvas element — convert to blob
    if (image.toBlob) {
      return new Promise((resolve) => image.toBlob(resolve, 'image/png'));
    }
    // ImageData — draw to a temp canvas, then blob
    if (image instanceof ImageData) {
      const c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      c.getContext('2d').putImageData(image, 0, 0);
      return new Promise((resolve) => {
        c.toBlob(resolve, 'image/png');
        // Release after blob is created
        setTimeout(() => { c.width = 0; c.height = 0; }, 0);
      });
    }
    // Fallback — hope Tesseract can handle it
    return Promise.resolve(image);
  }

  async function ocrImage(image) {
    const w = await getWorker();
    const blob = await toBlob(image);
    const { data } = await w.recognize(blob);
    return { text: data.text, blocks: buildBlocks(data) };
  }

  /**
   * OCR pages sequentially (single worker, low overhead).
   * @param {Array<{imageData?, canvas?, pageNumber}>} pages
   * @param {Function} [onProgress]
   * @returns {Promise<Array<{pageNumber, text, blocks}>>}
   */
  async function ocrPages(pages, onProgress) {
    const results = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      // Prefer canvas over ImageData — ImageData can hang when serialized
      // to the Tesseract worker. Canvas is converted to a blob internally.
      const result = await ocrImage(page.canvas || page.imageData);
      results.push({
        pageNumber: page.pageNumber,
        text: result.text,
        blocks: result.blocks,
      });
      if (onProgress) {
        onProgress({ completed: i + 1, total: pages.length, pageNumber: page.pageNumber });
      }
    }
    return results;
  }

  // ── Worker pool (large docs) ───────────────────────────────────────────────

  /**
   * Initialise a pool of N Tesseract workers.
   * Call once before ocrPagesParallel. Reuses existing pool if same size.
   * @param {number} [size=4]
   */
  async function initWorkerPool(size = DEFAULT_POOL_SIZE) {
    if (workerPool.length === size) return;

    await destroyWorkerPool();

    const promises = [];
    for (let i = 0; i < size; i++) {
      promises.push(createWorker());
    }
    workerPool = await Promise.all(promises);
    poolSize = size;
  }

  /**
   * OCR pages in parallel using the worker pool.
   * Distributes pages round-robin across workers.
   *
   * @param {Array<{imageData?, canvas?, pageNumber}>} pages
   * @param {Function} [onProgress] — called after each page: ({completed, total, pageNumber})
   * @returns {Promise<Array<{pageNumber, text, blocks}>>}
   */
  async function ocrPagesParallel(pages, onProgress) {
    if (workerPool.length === 0) {
      await initWorkerPool();
    }

    const results = new Array(pages.length);
    let completed = 0;

    // Group pages by worker (round-robin)
    const workerBuckets = Array.from({ length: workerPool.length }, () => []);
    pages.forEach((page, idx) => {
      workerBuckets[idx % workerPool.length].push({ page, idx });
    });

    // Each worker processes its bucket sequentially; all workers run in parallel
    await Promise.all(
      workerBuckets.map(async (bucket, workerIdx) => {
        const w = workerPool[workerIdx];
        for (const { page, idx } of bucket) {
          const blob = await toBlob(page.canvas || page.imageData);
          const { data } = await w.recognize(blob);

          results[idx] = {
            pageNumber: page.pageNumber,
            text: data.text,
            blocks: buildBlocks(data),
          };

          completed++;
          if (onProgress) {
            onProgress({
              completed,
              total: pages.length,
              pageNumber: page.pageNumber,
            });
          }
        }
      })
    );

    return results;
  }

  /**
   * Choose the right OCR strategy based on page count.
   * - 1–3 pages: single worker (minimal overhead)
   * - 4+ pages: worker pool (parallel)
   *
   * @param {Array} pages
   * @param {Function} [onProgress]
   * @returns {Promise<Array>}
   */
  async function ocrPagesAdaptive(pages, onProgress) {
    if (pages.length < POOL_THRESHOLD) {
      return ocrPages(pages, onProgress);
    }
    return ocrPagesParallel(pages, onProgress);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async function destroyOcrWorker() {
    if (worker) {
      await worker.terminate();
      worker = null;
    }
  }

  async function destroyWorkerPool() {
    await Promise.all(workerPool.map((w) => w.terminate()));
    workerPool = [];
    poolSize = 0;
  }

  async function destroyAll() {
    await destroyOcrWorker();
    await destroyWorkerPool();
  }

  // ── Exports ────────────────────────────────────────────────────────────────

  const exports = {
    ocrImage,
    ocrPages,
    ocrPagesParallel,
    ocrPagesAdaptive,
    initWorkerPool,
    destroyOcrWorker,
    destroyWorkerPool,
    destroyAll,
    POOL_THRESHOLD,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_ocrImage = ocrImage;
    globalThis.LLSS_ocrPages = ocrPages;
    globalThis.LLSS_ocrPagesParallel = ocrPagesParallel;
    globalThis.LLSS_ocrPagesAdaptive = ocrPagesAdaptive;
    globalThis.LLSS_initWorkerPool = initWorkerPool;
    globalThis.LLSS_destroyOcrWorker = destroyOcrWorker;
    globalThis.LLSS_destroyWorkerPool = destroyWorkerPool;
    globalThis.LLSS_destroyAll = destroyAll;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
