/**
 * Pixel Redactor — Canvas-based redaction and PDF reconstruction.
 * Runs inside the Offscreen Document.
 *
 * Security model: image-based flattening.
 * After redaction, the output is a raster image with no retained text layer.
 */

(function () {
  const REDACT_COLOR = '#000000';
  const REDACT_PADDING = 2; // px padding around each redacted region
  const JPEG_QUALITY = 0.92;

  // ── PII-to-region mapping ──────────────────────────────────────────────────

  /**
   * Map PII text matches back to OCR bounding boxes.
   *
   * Strategy: build a character-offset map from OCR words, then find which
   * word bounding boxes overlap each PII match's character span.
   *
   * @param {string} fullText — full OCR text for one page
   * @param {Array<{text: string, bbox: Object, words: Array}>} blocks — OCR line blocks
   * @param {Array<{original: string, index: number, typeId: string}>} matches — PII matches (indices relative to fullText)
   * @returns {Array<{x, y, w, h, typeId}>} — regions to redact
   */
  function mapMatchesToRegions(fullText, blocks, matches) {
    if (!matches || matches.length === 0) return [];

    // Build word-level character offset map
    const wordMap = [];
    let searchFrom = 0;

    for (const block of blocks) {
      for (const word of (block.words || [])) {
        const idx = fullText.indexOf(word.text, searchFrom);
        if (idx >= 0) {
          wordMap.push({
            text: word.text,
            bbox: word.bbox,
            charStart: idx,
            charEnd: idx + word.text.length,
          });
          searchFrom = idx + word.text.length;
        }
      }
    }

    // Map each PII match to overlapping word bounding boxes
    const regions = [];
    for (const match of matches) {
      const matchStart = match.index;
      const matchEnd = matchStart + match.original.length;

      const overlapping = wordMap.filter(
        (w) => w.charStart < matchEnd && w.charEnd > matchStart
      );

      if (overlapping.length > 0) {
        // Merge overlapping word bboxes into one region
        const x1 = Math.min(...overlapping.map((w) => w.bbox.x));
        const y1 = Math.min(...overlapping.map((w) => w.bbox.y));
        const x2 = Math.max(...overlapping.map((w) => w.bbox.x + w.bbox.w));
        const y2 = Math.max(...overlapping.map((w) => w.bbox.y + w.bbox.h));

        regions.push({
          x: x1 - REDACT_PADDING,
          y: y1 - REDACT_PADDING,
          w: x2 - x1 + REDACT_PADDING * 2,
          h: y2 - y1 + REDACT_PADDING * 2,
          typeId: match.typeId,
        });
      }
    }

    return regions;
  }

  // ── Canvas redaction ───────────────────────────────────────────────────────

  /**
   * Draw black rectangles over the specified regions on a canvas.
   *
   * @param {HTMLCanvasElement} canvas — the page canvas to redact
   * @param {Array<{x, y, w, h}>} regions — areas to black out
   * @returns {HTMLCanvasElement} — the same canvas (mutated in place)
   */
  function redactCanvasRegions(canvas, regions) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = REDACT_COLOR;

    for (const r of regions) {
      ctx.fillRect(
        Math.max(0, r.x),
        Math.max(0, r.y),
        Math.min(r.w, canvas.width - r.x),
        Math.min(r.h, canvas.height - r.y)
      );
    }

    return canvas;
  }

  /**
   * Redact an image (non-PDF) and return the result as a Blob.
   *
   * @param {ImageData|HTMLCanvasElement} image
   * @param {Array<{x, y, w, h}>} regions
   * @param {string} [outputType='image/png']
   * @returns {Promise<Blob>}
   */
  async function redactImage(image, regions, outputType = 'image/png') {
    let canvas;
    if (image instanceof HTMLCanvasElement) {
      canvas = image;
    } else {
      // ImageData → canvas
      canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d').putImageData(image, 0, 0);
    }

    redactCanvasRegions(canvas, regions);

    return new Promise((resolve) => {
      canvas.toBlob(resolve, outputType);
    });
  }

  // ── PDF reconstruction ─────────────────────────────────────────────────────
  // Builds a minimal image-only PDF from redacted page canvases.
  // No retained text layer: selecting/copying cannot reveal the OCR source text.

  /**
   * Assemble redacted page canvases into a new PDF (image-only, no text layer).
   *
   * @param {Array<HTMLCanvasElement>} pageCanvases — redacted page canvases
   * @returns {Promise<Uint8Array>} — the reconstructed PDF bytes
   */
  async function assemblePdf(pageCanvases) {
    // Collect JPEG data for each page
    const pageImages = [];
    for (const canvas of pageCanvases) {
      const blob = await new Promise((r) =>
        canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY)
      );
      const buffer = await blob.arrayBuffer();
      pageImages.push({
        data: new Uint8Array(buffer),
        width: canvas.width,
        height: canvas.height,
      });
    }

    return buildMinimalPdf(pageImages);
  }

  /**
   * Build a minimal PDF containing one JPEG image per page.
   * This is a hand-rolled PDF builder — no external dependency.
   *
   * @param {Array<{data: Uint8Array, width: number, height: number}>} images
   * @returns {Uint8Array}
   */
  function buildMinimalPdf(images) {
    const encoder = new TextEncoder();
    const parts = [];
    const offsets = [];
    let objNum = 0;

    function nextObj() {
      return ++objNum;
    }
    function write(str) {
      parts.push(encoder.encode(str));
    }
    function writeRaw(bytes) {
      parts.push(bytes);
    }
    function currentOffset() {
      let total = 0;
      for (const p of parts) total += p.length;
      return total;
    }

    // Header
    write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    // Plan object numbers:
    // 1 = Catalog, 2 = Pages
    // Then for each page: PageObj, ImageObj (2 objects per page)
    const catalogObj = nextObj(); // 1
    const pagesObj = nextObj();   // 2

    const pageObjNums = [];
    const imageObjNums = [];
    for (let i = 0; i < images.length; i++) {
      pageObjNums.push(nextObj());
      imageObjNums.push(nextObj());
    }

    // Write Catalog
    offsets[catalogObj] = currentOffset();
    write(`${catalogObj} 0 obj\n<< /Type /Catalog /Pages ${pagesObj} 0 R >>\nendobj\n`);

    // Write Pages
    offsets[pagesObj] = currentOffset();
    const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
    write(
      `${pagesObj} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`
    );

    // Write each page + image
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const pageNum = pageObjNums[i];
      const imgNum = imageObjNums[i];

      // Page dimensions in points (72 dpi base, but we scale to fit)
      // Use image dimensions directly — they'll be scaled by the cm matrix
      const pw = img.width;
      const ph = img.height;

      // Page object
      offsets[pageNum] = currentOffset();
      const contents = `q ${pw} 0 0 ${ph} 0 0 cm /Img${i} Do Q`;
      const contentsObj = nextObj();

      write(
        `${pageNum} 0 obj\n<< /Type /Page /Parent ${pagesObj} 0 R ` +
          `/MediaBox [0 0 ${pw} ${ph}] ` +
          `/Contents ${contentsObj} 0 R ` +
          `/Resources << /XObject << /Img${i} ${imgNum} 0 R >> >> >>\nendobj\n`
      );

      // Contents stream (the drawing command)
      offsets[contentsObj] = currentOffset();
      write(
        `${contentsObj} 0 obj\n<< /Length ${contents.length} >>\nstream\n${contents}\nendstream\nendobj\n`
      );

      // Image XObject (JPEG)
      offsets[imgNum] = currentOffset();
      write(
        `${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image ` +
          `/Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`
      );
      writeRaw(img.data);
      write('\nendstream\nendobj\n');
    }

    // Cross-reference table
    const xrefOffset = currentOffset();
    write('xref\n');
    write(`0 ${objNum + 1}\n`);
    write('0000000000 65535 f \n');
    for (let i = 1; i <= objNum; i++) {
      const off = (offsets[i] || 0).toString().padStart(10, '0');
      write(`${off} 00000 n \n`);
    }

    // Trailer
    write('trailer\n');
    write(`<< /Size ${objNum + 1} /Root ${catalogObj} 0 R >>\n`);
    write('startxref\n');
    write(`${xrefOffset}\n`);
    write('%%EOF\n');

    // Concatenate all parts
    let totalLen = 0;
    for (const p of parts) totalLen += p.length;
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of parts) {
      result.set(p, pos);
      pos += p.length;
    }
    return result;
  }

  // ── Multi-page redaction orchestrator ──────────────────────────────────────

  /**
   * Full redaction pipeline for a set of rendered pages.
   * Called by the offscreen document after PII detection has identified regions.
   *
   * @param {Array<{canvas: HTMLCanvasElement, regions: Array<{x,y,w,h}>}>} pageData
   * @param {string} outputFormat — 'pdf' or 'image/png' or 'image/jpeg'
   * @returns {Promise<{file: Uint8Array|Blob, format: string, pageCount: number}>}
   */
  async function redactPages(pageData, outputFormat = 'pdf') {
    // Redact each page canvas
    for (const page of pageData) {
      if (page.regions && page.regions.length > 0) {
        redactCanvasRegions(page.canvas, page.regions);
      }
    }

    if (outputFormat === 'pdf') {
      const pdfBytes = await assemblePdf(pageData.map((p) => p.canvas));
      return { file: pdfBytes, format: 'application/pdf', pageCount: pageData.length };
    }

    // Single image output
    const canvas = pageData[0].canvas;
    const blob = await new Promise((r) => canvas.toBlob(r, outputFormat));
    return { file: blob, format: outputFormat, pageCount: 1 };
  }

  // Exports
  const exports = {
    mapMatchesToRegions,
    redactCanvasRegions,
    redactImage,
    redactPages,
    assemblePdf,
    buildMinimalPdf,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_mapMatchesToRegions = mapMatchesToRegions;
    globalThis.LLSS_redactCanvasRegions = redactCanvasRegions;
    globalThis.LLSS_redactImage = redactImage;
    globalThis.LLSS_redactPages = redactPages;
    globalThis.LLSS_assemblePdf = assemblePdf;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
