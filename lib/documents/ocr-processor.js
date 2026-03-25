/**
 * OCR Processor — wraps Tesseract.js for text extraction with bounding boxes.
 * Runs inside the Offscreen Document.
 *
 * Returns structured data: text + word/line-level bounding boxes per page,
 * which the pixel redactor uses to locate PII regions.
 */

(function () {
  let worker = null;

  /**
   * Initialise the Tesseract.js worker (lazy, reused across calls).
   * @returns {Promise<Object>} Tesseract worker
   */
  async function getWorker() {
    if (worker) return worker;

    const Tesseract = globalThis.Tesseract;
    if (!Tesseract) {
      throw new Error('Tesseract.js not loaded. Run vendor/setup.sh to install dependencies.');
    }

    // Resolve paths relative to the extension root
    const getUrl = typeof chrome !== 'undefined' && chrome.runtime
      ? (p) => chrome.runtime.getURL(p)
      : (p) => p;

    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: getUrl('vendor/tesseract/tesseract.min.js'),
      corePath: getUrl('vendor/tesseract/tesseract-core-simd.wasm.js'),
      langPath: getUrl('vendor/tesseract/lang-data'),
      cacheMethod: 'none', // Don't cache in IndexedDB (extension has its own storage)
    });

    return worker;
  }

  /**
   * Run OCR on a single image and return text + bounding boxes.
   *
   * @param {ImageData|HTMLCanvasElement|Blob|string} image — image source
   * @returns {Promise<OcrPageResult>}
   *
   * @typedef {Object} OcrPageResult
   * @property {string} text — full extracted text
   * @property {OcrBlock[]} blocks — line-level blocks with word detail
   */
  async function ocrImage(image) {
    const w = await getWorker();
    const { data } = await w.recognize(image);

    // Build structured blocks from Tesseract's output.
    // Tesseract.js returns: data.lines[] → each has .words[]
    // Each word/line has .bbox = {x0, y0, x1, y1} and .text
    const blocks = (data.lines || []).map((line) => ({
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

    return { text: data.text, blocks };
  }

  /**
   * OCR multiple images (e.g. PDF pages) and return per-page results.
   *
   * @param {Array<{imageData: ImageData, pageNumber: number}>} pages
   * @returns {Promise<Array<{pageNumber, text, blocks}>>}
   */
  async function ocrPages(pages) {
    const results = [];
    for (const page of pages) {
      const result = await ocrImage(page.imageData || page.canvas);
      results.push({
        pageNumber: page.pageNumber,
        text: result.text,
        blocks: result.blocks,
      });
    }
    return results;
  }

  /**
   * Destroy the worker and free resources.
   */
  async function destroyOcrWorker() {
    if (worker) {
      await worker.terminate();
      worker = null;
    }
  }

  // Exports
  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_ocrImage = ocrImage;
    globalThis.LLSS_ocrPages = ocrPages;
    globalThis.LLSS_destroyOcrWorker = destroyOcrWorker;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ocrImage, ocrPages, destroyOcrWorker };
  }
})();
