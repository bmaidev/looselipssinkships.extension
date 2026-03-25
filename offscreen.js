/**
 * Offscreen Document message handler for Loose Lips Sink Ships.
 *
 * Coordinates PDF rendering, OCR, and pixel redaction inside the offscreen
 * document (which has Canvas + WASM access that MV3 service workers lack).
 *
 * Protocol (all messages have target: 'offscreen'):
 *
 *   RENDER_AND_OCR
 *     Input:  { fileData: number[], fileName, contentType }
 *     Output: { pages: [{pageNumber, text, blocks, width, height}], fullText }
 *
 *   APPLY_REDACTIONS
 *     Input:  { pageRedactions: [{pageNumber, regions: [{x,y,w,h}]}], outputFormat }
 *     Output: { file: number[], format, pageCount }
 *
 *   OCR_IMAGE
 *     Input:  { imageData: number[], width, height }
 *     Output: { text, blocks }
 *
 *   CLEANUP
 *     Input:  (none)
 *     Output: { success: true }
 */

(() => {
  'use strict';

  // Cache rendered page canvases between RENDER_AND_OCR and APPLY_REDACTIONS
  let cachedPageCanvases = null;
  let cacheTimeout = null;
  const CACHE_TTL = 60000; // 1 minute

  function resetCacheTimer() {
    if (cacheTimeout) clearTimeout(cacheTimeout);
    cacheTimeout = setTimeout(() => {
      cachedPageCanvases = null;
    }, CACHE_TTL);
  }

  // ── Message handler ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    switch (message.type) {
      case 'RENDER_AND_OCR':
        handleRenderAndOcr(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;

      case 'APPLY_REDACTIONS':
        handleApplyRedactions(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;

      case 'OCR_IMAGE':
        handleOcrImage(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;

      case 'CLEANUP':
        handleCleanup()
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err.message }));
        return true;

      default:
        return false;
    }
  });

  // ── RENDER_AND_OCR ─────────────────────────────────────────────────────────

  async function handleRenderAndOcr(message) {
    const { fileData, contentType } = message;
    const buffer = new Uint8Array(fileData).buffer;

    let pageImages;

    if (contentType === 'pdf') {
      // Render PDF pages to canvas images
      const renderPdf = globalThis.LLSS_renderPdfPages;
      if (!renderPdf) throw new Error('PDF renderer not available');

      const result = await renderPdf(buffer);
      pageImages = result.pages;
    } else {
      // Single image — load onto canvas
      const canvas = await loadImageToCanvas(buffer, contentType);
      pageImages = [{
        pageNumber: 1,
        width: canvas.width,
        height: canvas.height,
        canvas,
        imageData: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height),
      }];
    }

    // Cache canvases for the APPLY_REDACTIONS step
    cachedPageCanvases = pageImages;
    resetCacheTimer();

    // OCR each page
    const ocrPages = globalThis.LLSS_ocrPages;
    if (!ocrPages) throw new Error('OCR processor not available');

    const ocrResults = await ocrPages(pageImages);

    // Build combined full text with page separators
    const fullText = ocrResults.map((r) => r.text).join('\n');

    // Build page boundary map so background can split matches by page
    let offset = 0;
    const pages = ocrResults.map((r) => {
      const page = {
        pageNumber: r.pageNumber,
        text: r.text,
        blocks: r.blocks,
        width: pageImages.find((p) => p.pageNumber === r.pageNumber)?.width || 0,
        height: pageImages.find((p) => p.pageNumber === r.pageNumber)?.height || 0,
        charStart: offset,
        charEnd: offset + r.text.length,
      };
      offset += r.text.length + 1; // +1 for the \n separator
      return page;
    });

    return { pages, fullText };
  }

  // ── APPLY_REDACTIONS ───────────────────────────────────────────────────────

  async function handleApplyRedactions(message) {
    const { pageRedactions, outputFormat = 'pdf' } = message;

    if (!cachedPageCanvases) {
      throw new Error('No cached pages. Call RENDER_AND_OCR first.');
    }

    const redactPages = globalThis.LLSS_redactPages;
    if (!redactPages) throw new Error('Pixel redactor not available');

    // Build page data array matching cached canvases with their redaction regions
    const pageData = cachedPageCanvases.map((cachedPage) => {
      const redactionEntry = pageRedactions.find(
        (r) => r.pageNumber === cachedPage.pageNumber
      );
      return {
        canvas: cachedPage.canvas,
        regions: redactionEntry?.regions || [],
      };
    });

    const result = await redactPages(pageData, outputFormat);

    // Convert output to transferable array
    let fileArray;
    if (result.file instanceof Uint8Array) {
      fileArray = Array.from(result.file);
    } else if (result.file instanceof Blob) {
      const buf = await result.file.arrayBuffer();
      fileArray = Array.from(new Uint8Array(buf));
    }

    // Clear cache after redaction is complete
    cachedPageCanvases = null;
    if (cacheTimeout) clearTimeout(cacheTimeout);

    return {
      file: fileArray,
      format: result.format,
      pageCount: result.pageCount,
    };
  }

  // ── OCR_IMAGE (standalone, for single image without PDF context) ──────────

  async function handleOcrImage(message) {
    const { imageData, width, height } = message;

    const imgData = new ImageData(
      new Uint8ClampedArray(imageData),
      width,
      height
    );

    const ocrImage = globalThis.LLSS_ocrImage;
    if (!ocrImage) throw new Error('OCR processor not available');

    return ocrImage(imgData);
  }

  // ── CLEANUP ────────────────────────────────────────────────────────────────

  async function handleCleanup() {
    cachedPageCanvases = null;
    if (cacheTimeout) clearTimeout(cacheTimeout);

    const destroyOcr = globalThis.LLSS_destroyOcrWorker;
    if (destroyOcr) await destroyOcr();

    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Load raw image bytes onto a canvas.
   */
  function loadImageToCanvas(buffer, contentType) {
    return new Promise((resolve, reject) => {
      const mimeMap = {
        image: 'image/png',
        png: 'image/png',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        tiff: 'image/tiff',
      };
      const mime = mimeMap[contentType] || 'image/png';
      const blob = new Blob([buffer], { type: mime });
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  }
})();
