/**
 * Offscreen Document message handler for Loose Lips Sink Ships.
 *
 * Coordinates PDF rendering, OCR, and pixel redaction inside the offscreen
 * document (which has Canvas + WASM access that MV3 service workers lack).
 *
 * Memory-efficient: renders pages in chunks, releases canvases after OCR,
 * and re-renders only pages that need redaction.
 *
 * Protocol (all messages have target: 'offscreen'):
 *
 *   RENDER_AND_OCR
 *     Input:  { fileData: number[], fileName, contentType }
 *     Output: { pages: [{pageNumber, text, blocks, width, height}], fullText }
 *     Side:   sends OCR_PROGRESS messages to background during processing
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

  // ── Startup diagnostic (always logs, not dependent on debug setting) ─────
  console.log('[LLSS:offscreen] Phase 1 status:',
    'Tesseract=' + (typeof Tesseract !== 'undefined' ? 'OK' : 'MISSING'),
    'LLSS_ocrPages=' + (typeof LLSS_ocrPages !== 'undefined' ? 'OK' : 'MISSING'),
    '(pdf.js loads in Phase 2 via module bridge)');

  // ── Debug logging activation ──────────────────────────────────────────────
  // The offscreen document doesn't load settings.js, so we check storage
  // directly on startup to enable debug logging.
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get('llss_settings', (result) => {
      if (result?.llss_settings?.debugMode && typeof LLSS_debug !== 'undefined') {
        LLSS_debug.setEnabled(true);
      }
      const dbg = typeof LLSS_debug !== 'undefined' ? LLSS_debug : null;
      if (dbg && dbg.isEnabled()) {
        dbg.log('offscreen', 'Offscreen document ready — vendor status:', {
          pdfjsWorker: typeof pdfjsWorker !== 'undefined' && pdfjsWorker?.WorkerMessageHandler ? 'OK (inline)' : 'MISSING',
          pdfjsLib: typeof pdfjsLib !== 'undefined' ? 'loaded (via module bridge)' : 'MISSING (deferred)',
          Tesseract: typeof Tesseract !== 'undefined' ? 'loaded' : 'MISSING',
          LLSS_ocrPages: typeof LLSS_ocrPages !== 'undefined' ? 'defined' : 'MISSING',
          LLSS_renderPdfPages: typeof LLSS_renderPdfPages !== 'undefined' ? 'defined' : 'MISSING',
          LanguageModel: typeof LanguageModel !== 'undefined' ? 'available' : 'not available',
        });
      }
    });
  }

  // ── Nano (LanguageModel) session — proxied from service worker ──────────
  // The service worker cannot access LanguageModel (it's a Worker context).
  // This offscreen document CAN, so it hosts the Nano session on behalf of
  // the background script.

  const nanoSession = (typeof LLSS_NanoSession !== 'undefined')
    ? new LLSS_NanoSession()
    : null;

  // Cache the raw file data (NOT rendered canvases) between phases.
  // Re-render only the pages that need redaction — much more memory-efficient.
  let cachedFileData = null;
  let cachedContentType = null;
  let cachedPageMeta = null; // [{pageNumber, width, height}] — no canvas data
  let cacheTimeout = null;
  const CACHE_TTL = 120000; // 2 minutes (large docs take time)
  const RENDER_CHUNK_SIZE = 5; // Render 5 pages at a time to limit memory

  function resetCacheTimer() {
    if (cacheTimeout) clearTimeout(cacheTimeout);
    cacheTimeout = setTimeout(() => {
      cachedFileData = null;
      cachedContentType = null;
      cachedPageMeta = null;
    }, CACHE_TTL);
  }

  function sendProgress(data) {
    try {
      chrome.runtime.sendMessage({
        type: 'OCR_PROGRESS',
        ...data,
      });
    } catch (_) {
      // Background may not be listening; ignore
    }
  }

  // ── Message handler ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    switch (message.type) {
      case 'RENDER_AND_OCR': {
        const dbg = typeof LLSS_debug !== 'undefined' ? LLSS_debug : null;
        if (dbg) dbg.log('offscreen', 'RENDER_AND_OCR received', { contentType: message.contentType, dataLen: message.fileData?.length });
        handleRenderAndOcr(message)
          .then((result) => {
            if (dbg) dbg.log('offscreen', 'RENDER_AND_OCR complete', { pages: result.pages?.length, textLen: result.fullText?.length });
            sendResponse(result);
          })
          .catch((err) => {
            const msg = err?.message || String(err) || 'Unknown error';
            if (dbg) dbg.error('offscreen', 'RENDER_AND_OCR failed:', msg, err);
            sendResponse({ error: msg });
          });
        return true;
      }

      case 'APPLY_REDACTIONS':
        handleApplyRedactions(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err?.message || String(err) }));
        return true;

      case 'OCR_IMAGE':
        handleOcrImage(message)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err?.message || String(err) }));
        return true;

      case 'CLEANUP':
        handleCleanup()
          .then(sendResponse)
          .catch((err) => sendResponse({ error: err?.message || String(err) }));
        return true;

      // ── Nano proxy messages (from service worker) ─────────────────────
      case 'NANO_CHECK_AVAILABILITY': {
        const dbg = typeof LLSS_debug !== 'undefined' ? LLSS_debug : null;
        (nanoSession
          ? nanoSession.checkAvailability()
          : Promise.resolve({ available: false, status: 'no', detail: 'NanoSession not loaded' })
        ).then((result) => {
          if (dbg) dbg.log('offscreen', 'NANO_CHECK_AVAILABILITY →', result.status, result.detail);
          sendResponse(result);
        }).catch((err) => {
          if (dbg) dbg.error('offscreen', 'NANO_CHECK_AVAILABILITY error:', err.message);
          sendResponse({ available: false, status: 'no', detail: err.message });
        });
        return true;
      }

      case 'NANO_REDACT': {
        const dbg = typeof LLSS_debug !== 'undefined' ? LLSS_debug : null;
        if (dbg) dbg.log('offscreen', 'NANO_REDACT received', { textLen: message.text?.length });
        (nanoSession
          ? nanoSession.redact(message.text, message.piiTypes)
          : Promise.reject(new Error('NanoSession not loaded'))
        ).then((result) => {
          if (dbg) dbg.log('offscreen', 'NANO_REDACT complete', { engine: result.engine });
          sendResponse(result);
        }).catch((err) => {
          if (dbg) dbg.error('offscreen', 'NANO_REDACT error:', err.message);
          sendResponse({ error: err.message });
        });
        return true;
      }

      case 'NANO_DESTROY':
        if (nanoSession) nanoSession.destroy();
        sendResponse({ success: true });
        return false;

      default:
        return false;
    }
  });

  // ── RENDER_AND_OCR ─────────────────────────────────────────────────────────
  // Renders pages in chunks, OCRs each chunk, then releases the canvas.
  // Only OCR results (text + bboxes) are kept in memory.

  async function handleRenderAndOcr(message) {
    const { fileData, contentType } = message;
    const buffer = new Uint8Array(fileData).buffer;

    // Cache raw data for APPLY_REDACTIONS phase
    cachedFileData = buffer;
    cachedContentType = contentType;
    resetCacheTimer();

    const ocrAdaptive = globalThis.LLSS_ocrPagesAdaptive;
    const ocrPages = globalThis.LLSS_ocrPages;
    const ocrFn = ocrAdaptive || ocrPages;
    if (!ocrFn) throw new Error('OCR processor not available');

    let allOcrResults;

    if (contentType === 'pdf') {
      // Try text extraction first (fast, no rendering/OCR needed).
      // Falls back to render+OCR only if text extraction yields nothing
      // (scanned/image-only PDFs).
      const textResult = await tryPdfTextExtraction(buffer);
      if (textResult) {
        console.log('[LLSS:offscreen] PDF text extraction succeeded:', textResult.fullText.length, 'chars');
        return textResult;
      }
      console.log('[LLSS:offscreen] PDF text extraction empty, falling back to render+OCR');
      allOcrResults = await renderAndOcrPdf(buffer, ocrFn);
    } else {
      allOcrResults = await renderAndOcrImage(buffer, contentType, ocrFn);
    }

    // Build page meta cache (for re-rendering in APPLY_REDACTIONS)
    cachedPageMeta = allOcrResults.map((r) => ({
      pageNumber: r.pageNumber,
      width: r.width,
      height: r.height,
    }));

    // Build combined text with page boundaries
    const fullText = allOcrResults.map((r) => r.text).join('\n');
    let offset = 0;
    const pages = allOcrResults.map((r) => {
      const page = {
        pageNumber: r.pageNumber,
        text: r.text,
        blocks: r.blocks,
        width: r.width,
        height: r.height,
        charStart: offset,
        charEnd: offset + r.text.length,
      };
      offset += r.text.length + 1;
      return page;
    });

    sendProgress({
      phase: 'ocr_complete',
      totalPages: pages.length,
    });

    return { pages, fullText };
  }

  /**
   * Wait for pdf.js module to load (it's deferred via type="module").
   * Returns immediately if already loaded, otherwise waits for the
   * pdfjsReady event dispatched by vendor/pdf-bridge.js.
   */
  function waitForPdfjs(timeoutMs = 10000) {
    // Check both the library object and the ready flag — the pdfjsReady event
    // may have already fired before this function is called (race condition
    // between deferred ES module execution and incoming messages).
    if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
    if (globalThis.__pdfjsReady) return Promise.resolve(globalThis.pdfjsLib);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // One final check before rejecting — module may have loaded during timeout
        if (globalThis.pdfjsLib || globalThis.__pdfjsReady) {
          resolve(globalThis.pdfjsLib);
        } else {
          reject(new Error('pdf.js module did not load within ' + timeoutMs + 'ms. Check that vendor/pdf.min.mjs exists.'));
        }
      }, timeoutMs);
      document.addEventListener('pdfjsReady', () => {
        clearTimeout(timer);
        resolve(globalThis.pdfjsLib);
      }, { once: true });
    });
  }

  /**
   * PDF: render pages in chunks, OCR each chunk, release canvases.
   */
  /**
   * Try extracting text directly from PDF (no rendering/OCR).
   * Works for text-based PDFs. Returns null for scanned/image-only PDFs.
   * Uses pdf.js getTextContent() which is much faster than render+OCR.
   */
  async function tryPdfTextExtraction(buffer) {
    try {
      const pdfjsLib = await waitForPdfjs();
      const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
      const totalPages = Math.min(pdfDoc.numPages, 50);

      const pageTexts = [];
      let offset = 0;
      const pages = [];

      for (let i = 1; i <= totalPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        page.cleanup();

        if (pageText.trim().length > 0) {
          pages.push({
            pageNumber: i,
            text: pageText,
            blocks: [], // No bounding boxes from text extraction
            width: 0,
            height: 0,
            charStart: offset,
            charEnd: offset + pageText.length,
          });
          pageTexts.push(pageText);
          offset += pageText.length + 1;
        }
      }

      pdfDoc.destroy();

      const fullText = pageTexts.join('\n');
      if (fullText.trim().length < 10) return null; // Too little text — probably scanned

      return { pages, fullText };
    } catch (err) {
      console.warn('[LLSS:offscreen] PDF text extraction failed:', err?.message || err);
      return null;
    }
  }

  async function renderAndOcrPdf(buffer, ocrFn) {
    const renderPdf = globalThis.LLSS_renderPdfPages;
    if (!renderPdf) throw new Error('PDF renderer not available');

    // Wait for pdf.js (loaded as deferred ES module)
    console.log('[LLSS:offscreen] renderAndOcrPdf: waiting for pdf.js...');
    const pdfjsLib = await waitForPdfjs();
    console.log('[LLSS:offscreen] renderAndOcrPdf: pdfjsLib ready, calling getDocument...');
    console.log('[LLSS:offscreen] pdfjsWorker check:', typeof globalThis.pdfjsWorker?.WorkerMessageHandler);
    const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
    console.log('[LLSS:offscreen] renderAndOcrPdf: PDF loaded, pages:', pdfDoc.numPages);
    const totalPages = Math.min(pdfDoc.numPages, 50);

    sendProgress({ phase: 'render_start', totalPages });

    const allResults = [];
    const scale = 2.0;

    // Process pages in chunks to limit memory usage
    for (let start = 0; start < totalPages; start += RENDER_CHUNK_SIZE) {
      const end = Math.min(start + RENDER_CHUNK_SIZE, totalPages);
      const chunkPages = [];

      // Render this chunk
      for (let i = start; i < end; i++) {
        console.log(`[LLSS:offscreen] Rendering page ${i + 1}/${totalPages}...`);
        const page = await pdfDoc.getPage(i + 1);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');

        // Timeout per page — fake worker can hang on complex pages
        const renderResult = await Promise.race([
          page.render({ canvasContext: ctx, viewport }).promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Page ${i + 1} render timed out after 30s`)), 30000)),
        ]);

        console.log(`[LLSS:offscreen] Page ${i + 1} rendered: ${canvas.width}x${canvas.height}`);

        chunkPages.push({
          pageNumber: i + 1,
          width: canvas.width,
          height: canvas.height,
          canvas,
          imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
        });
        page.cleanup();

        sendProgress({
          phase: 'rendering',
          currentPage: i + 1,
          totalPages,
        });
      }

      // OCR this chunk
      const ocrResults = await ocrFn(chunkPages, (progress) => {
        sendProgress({
          phase: 'ocr',
          currentPage: start + progress.completed,
          totalPages,
          completed: start + progress.completed,
        });
      });

      // Merge results and release canvases
      for (let j = 0; j < chunkPages.length; j++) {
        allResults.push({
          ...ocrResults[j],
          width: chunkPages[j].width,
          height: chunkPages[j].height,
        });
        // Release canvas memory
        chunkPages[j].canvas.width = 0;
        chunkPages[j].canvas.height = 0;
        chunkPages[j].canvas = null;
        chunkPages[j].imageData = null;
      }
    }

    pdfDoc.destroy();
    return allResults;
  }

  /**
   * Image: load, OCR, release.
   */
  async function renderAndOcrImage(buffer, contentType, ocrFn) {
    const canvas = await loadImageToCanvas(buffer, contentType);
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);

    sendProgress({ phase: 'ocr', currentPage: 1, totalPages: 1 });

    const ocrResults = await ocrFn(
      [{ pageNumber: 1, imageData, canvas }],
      (progress) => {
        sendProgress({ phase: 'ocr', currentPage: 1, totalPages: 1, completed: 1 });
      }
    );

    const result = {
      ...ocrResults[0],
      width: canvas.width,
      height: canvas.height,
    };

    // Release canvas
    canvas.width = 0;
    canvas.height = 0;

    return [result];
  }

  // ── APPLY_REDACTIONS ───────────────────────────────────────────────────────
  // Re-renders ONLY pages that have redactions, applies black rects, assembles.

  async function handleApplyRedactions(message) {
    const { pageRedactions, outputFormat = 'pdf' } = message;

    if (!cachedFileData || !cachedPageMeta) {
      throw new Error('No cached file data. Call RENDER_AND_OCR first.');
    }

    const redactCanvasRegions = globalThis.LLSS_redactCanvasRegions;
    const assemblePdf = globalThis.LLSS_assemblePdf;
    if (!redactCanvasRegions) throw new Error('Pixel redactor not available');

    sendProgress({ phase: 'redacting', totalPages: cachedPageMeta.length });

    // Determine which pages need redaction
    const redactionMap = new Map();
    for (const pr of pageRedactions) {
      if (pr.regions && pr.regions.length > 0) {
        redactionMap.set(pr.pageNumber, pr.regions);
      }
    }

    let redactedCanvases;

    if (cachedContentType === 'pdf') {
      redactedCanvases = await reRenderAndRedactPdf(redactionMap);
    } else {
      redactedCanvases = await reRenderAndRedactImage(redactionMap);
    }

    // Build output
    let fileArray;
    if (outputFormat === 'pdf' && assemblePdf) {
      const pdfBytes = await assemblePdf(redactedCanvases);
      fileArray = Array.from(pdfBytes);
    } else {
      // Single image output
      const canvas = redactedCanvases[0];
      const blob = await new Promise((r) => canvas.toBlob(r, outputFormat === 'pdf' ? 'image/png' : outputFormat));
      const buf = await blob.arrayBuffer();
      fileArray = Array.from(new Uint8Array(buf));
    }

    // Release canvases
    for (const c of redactedCanvases) {
      c.width = 0;
      c.height = 0;
    }

    // Clear cache
    cachedFileData = null;
    cachedContentType = null;
    cachedPageMeta = null;
    if (cacheTimeout) clearTimeout(cacheTimeout);

    sendProgress({ phase: 'complete' });

    return {
      file: fileArray,
      format: outputFormat === 'pdf' ? 'application/pdf' : outputFormat,
      pageCount: redactedCanvases.length,
    };
  }

  /**
   * Re-render PDF pages and apply redaction rectangles.
   * Pages without redactions are rendered clean (still flattened to image for security).
   */
  async function reRenderAndRedactPdf(redactionMap) {
    const pdfjsLib = await waitForPdfjs();
    const redactFn = globalThis.LLSS_redactCanvasRegions;
    const scale = 2.0;

    const pdfDoc = await pdfjsLib.getDocument({ data: cachedFileData }).promise;
    const canvases = [];

    for (const meta of cachedPageMeta) {
      const page = await pdfDoc.getPage(meta.pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      await Promise.race([
        page.render({ canvasContext: ctx, viewport }).promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Page ${meta.pageNumber} redaction render timed out after 30s`)), 30000)),
      ]);

      // Apply redactions if any
      const regions = redactionMap.get(meta.pageNumber);
      if (regions && regions.length > 0) {
        redactFn(canvas, regions);
      }

      canvases.push(canvas);
      page.cleanup();

      sendProgress({
        phase: 'redacting',
        currentPage: meta.pageNumber,
        totalPages: cachedPageMeta.length,
      });
    }

    pdfDoc.destroy();
    return canvases;
  }

  /**
   * Re-render an image and apply redaction rectangles.
   */
  async function reRenderAndRedactImage(redactionMap) {
    const redactFn = globalThis.LLSS_redactCanvasRegions;
    const canvas = await loadImageToCanvas(cachedFileData, cachedContentType);

    const regions = redactionMap.get(1);
    if (regions && regions.length > 0) {
      redactFn(canvas, regions);
    }

    return [canvas];
  }

  // ── OCR_IMAGE (standalone) ─────────────────────────────────────────────────

  async function handleOcrImage(message) {
    const { imageData, width, height } = message;
    const imgData = new ImageData(new Uint8ClampedArray(imageData), width, height);

    const ocrImage = globalThis.LLSS_ocrImage;
    if (!ocrImage) throw new Error('OCR processor not available');

    return ocrImage(imgData);
  }

  // ── CLEANUP ────────────────────────────────────────────────────────────────

  async function handleCleanup() {
    cachedFileData = null;
    cachedContentType = null;
    cachedPageMeta = null;
    if (cacheTimeout) clearTimeout(cacheTimeout);

    const destroyAll = globalThis.LLSS_destroyAll;
    const destroyOcr = globalThis.LLSS_destroyOcrWorker;
    if (destroyAll) await destroyAll();
    else if (destroyOcr) await destroyOcr();

    return { success: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function loadImageToCanvas(buffer, contentType) {
    return new Promise((resolve, reject) => {
      const mimeMap = {
        image: 'image/png', png: 'image/png', jpeg: 'image/jpeg',
        jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
        bmp: 'image/bmp', tiff: 'image/tiff',
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
