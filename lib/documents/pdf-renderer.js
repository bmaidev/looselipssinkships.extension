/**
 * PDF Renderer — wraps pdf.js to render PDF pages as canvas images.
 * Runs inside the Offscreen Document (requires DOM/Canvas access).
 *
 * MV3 service workers cannot access Canvas, so all rendering happens here.
 */

(function () {
  const DEFAULT_SCALE = 2.0; // 2× for better OCR accuracy
  const MAX_PAGES = 50;      // Safety limit
  const MAX_PAGE_PIXELS = 25_000_000;

  /**
   * Render every page of a PDF to canvas elements.
   *
   * @param {ArrayBuffer|Uint8Array} pdfData — raw PDF bytes
   * @param {Object} [options]
   * @param {number} [options.scale=2.0] — render scale (higher = better OCR, more memory)
   * @param {number} [options.maxPages=50]
   * @returns {Promise<{pages: Array<{pageNumber, width, height, canvas, imageData}>, totalPages, renderedPages}>}
   */
  async function renderPdfPages(pdfData, options = {}) {
    const pdfjsLib = globalThis.pdfjsLib;
    if (!pdfjsLib) {
      throw new Error('pdf.js not loaded. Run vendor/setup.sh to install dependencies.');
    }

    const scale = options.scale || DEFAULT_SCALE;
    const maxPages = options.maxPages || MAX_PAGES;

    // workerSrc is configured by vendor/pdf-bridge.js at module load time.

    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    const pdf = await loadingTask.promise;
    if (pdf.numPages > maxPages) {
      pdf.destroy();
      throw new Error(`PDF exceeds the ${maxPages}-page safety limit`);
    }
    const numPages = pdf.numPages;
    const pages = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      if (viewport.width * viewport.height > MAX_PAGE_PIXELS) {
        page.cleanup();
        pdf.destroy();
        throw new Error(`PDF page ${i} exceeds the pixel safety limit`);
      }

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;

      pages.push({
        pageNumber: i,
        width: canvas.width,
        height: canvas.height,
        canvas,
        imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      });

      page.cleanup();
    }

    pdf.destroy();

    return { pages, totalPages: pdf.numPages, renderedPages: numPages };
  }

  // Exports
  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_renderPdfPages = renderPdfPages;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderPdfPages };
  }
})();
