/**
 * Document Processor — routes documents through the appropriate parser
 * to extract text, then delegates to the redaction pipeline.
 *
 * Supported formats:
 * - DOCX (Word) — XML-based text extraction
 * - XLSX (Excel) — XML-based cell extraction
 * - HTML — DOM-based text extraction
 * - Markdown — regex-based text extraction
 * - Images — delegates to OCR-capable providers (hosted/cloud)
 * - PDF — delegates to text extraction or OCR providers
 */

(function () {
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('../providers/base-provider').PROVIDER_CAPABILITIES : {});
  const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
  const MAX_ZIP_ENTRIES = 500;
  const MAX_ZIP_ENTRY_BYTES = 25 * 1024 * 1024;
  const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;
  const MAX_COMPRESSION_RATIO = 200;

  function decodeUtf8(content) {
    if (typeof content === 'string') return content;
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  }

  const MIME_TO_TYPE = {
    // Office documents
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/pdf': 'pdf',
    // Web / markup
    'text/html': 'html',
    'text/markdown': 'markdown',
    'text/xml': 'text',
    'application/xml': 'text',
    'application/json': 'text',
    // Plain text variants
    'text/plain': 'text',
    'text/csv': 'csv',
    'text/tab-separated-values': 'text',
    'text/x-yaml': 'text',
    'application/x-yaml': 'text',
    'text/x-python': 'text',
    'text/javascript': 'text',
    'application/javascript': 'text',
    'text/x-sql': 'text',
    'text/rtf': 'text',
    'application/rtf': 'text',
    // Images
    'image/png': 'image',
    'image/jpeg': 'image',
    'image/gif': 'image',
    'image/webp': 'image',
    'image/bmp': 'image',
    'image/tiff': 'image',
    // Archives
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
  };

  const EXT_TO_TYPE = {
    // Office documents
    '.docx': 'docx',
    '.xlsx': 'xlsx',
    '.pdf': 'pdf',
    // Web / markup
    '.html': 'html', '.htm': 'html',
    '.md': 'markdown', '.markdown': 'markdown',
    // Structured text (preserve format)
    '.csv': 'csv',
    '.tsv': 'text', '.tab': 'text',
    '.json': 'text', '.jsonl': 'text',
    '.xml': 'text',
    '.yaml': 'text', '.yml': 'text',
    '.toml': 'text',
    '.ini': 'text', '.cfg': 'text', '.conf': 'text',
    '.env': 'text',
    // Plain text
    '.txt': 'text', '.text': 'text',
    '.log': 'text',
    '.rtf': 'text',
    '.rst': 'text', '.adoc': 'text',
    '.tex': 'text', '.latex': 'text',
    // Code files (contain PII in comments, strings, configs)
    '.py': 'text', '.rb': 'text', '.php': 'text',
    '.js': 'text', '.ts': 'text', '.jsx': 'text', '.tsx': 'text',
    '.java': 'text', '.cs': 'text', '.go': 'text', '.rs': 'text',
    '.swift': 'text', '.kt': 'text', '.scala': 'text',
    '.c': 'text', '.cpp': 'text', '.h': 'text', '.hpp': 'text',
    '.sh': 'text', '.bash': 'text', '.zsh': 'text', '.ps1': 'text', '.bat': 'text',
    '.sql': 'text', '.r': 'text',
    // Images
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
    '.gif': 'image', '.webp': 'image',
    '.bmp': 'image', '.tiff': 'image', '.tif': 'image',
    // Archives
    '.zip': 'zip',
  };

  /**
   * Detect content type from file name or MIME type.
   * @param {string} [fileName]
   * @param {string} [mimeType]
   * @returns {string|null} Content type constant
   */
  function detectContentType(fileName, mimeType) {
    if (mimeType && MIME_TO_TYPE[mimeType]) {
      return MIME_TO_TYPE[mimeType];
    }
    if (fileName) {
      const ext = '.' + fileName.split('.').pop().toLowerCase();
      if (EXT_TO_TYPE[ext]) return EXT_TO_TYPE[ext];
    }
    return null;
  }

  /**
   * Extract text from a DOCX file (Office Open XML).
   * DOCX files are ZIP archives containing XML. We parse word/document.xml.
   * Uses the browser's built-in compression streams where available,
   * otherwise falls back to manual ZIP parsing.
   *
   * @param {ArrayBuffer} buffer - The .docx file contents
   * @returns {Promise<string>} Extracted plain text
   */
  async function extractDocxText(buffer) {
    const entries = await parseZipEntries(buffer);
    const docEntry = entries.find(e =>
      e.name === 'word/document.xml' || e.name.endsWith('/document.xml')
    );
    if (!docEntry) {
      throw new Error('Invalid DOCX: word/document.xml not found');
    }

    const xmlText = decodeUtf8(docEntry.data);

    // Parse XML and extract text from <w:t> elements
    // Also handle <w:p> (paragraph) and <w:br/> (line break) elements
    const text = [];
    let currentParagraph = '';

    // Simple XML text extraction — handles the common OOXML patterns
    const tagRegex = /<\/?([a-zA-Z0-9:]+)[^>]*\/?>/g;
    const textContentRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;

    let match;
    while ((match = textContentRegex.exec(xmlText)) !== null) {
      currentParagraph += match[1];
    }

    // Also extract paragraph boundaries
    const paragraphs = xmlText.split(/<\/w:p>/);
    const extractedLines = [];
    for (const para of paragraphs) {
      let line = '';
      const tMatches = para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
      for (const tm of tMatches) {
        line += tm[1];
      }
      if (line.trim()) {
        extractedLines.push(line);
      }
    }

    return extractedLines.join('\n');
  }

  /**
   * Extract text from an XLSX file (Office Open XML Spreadsheet).
   * Reads shared strings and sheet data to reconstruct cell contents.
   *
   * @param {ArrayBuffer} buffer - The .xlsx file contents
   * @returns {Promise<string>} Extracted text (tab-separated cells, newline-separated rows)
   */
  async function extractXlsxText(buffer) {
    const entries = await parseZipEntries(buffer);

    // Read shared strings table
    const sharedStringsEntry = entries.find(e =>
      e.name === 'xl/sharedStrings.xml' || e.name.endsWith('/sharedStrings.xml')
    );
    const sharedStrings = [];
    if (sharedStringsEntry) {
      const xml = decodeUtf8(sharedStringsEntry.data);
      const siMatches = xml.matchAll(/<si>([^]*?)<\/si>/g);
      for (const si of siMatches) {
        // Extract text from <t> elements within <si>
        let cellText = '';
        const tMatches = si[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g);
        for (const tm of tMatches) {
          cellText += tm[1];
        }
        sharedStrings.push(cellText);
      }
    }

    // Read sheet data
    const sheetEntries = entries
      .filter(e => /xl\/worksheets\/sheet\d+\.xml/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const allText = [];

    for (const sheetEntry of sheetEntries) {
      const xml = decodeUtf8(sheetEntry.data);
      const rows = xml.matchAll(/<row[^>]*>([^]*?)<\/row>/g);

      for (const row of rows) {
        const cells = [];
        const cellMatches = row[1].matchAll(/<c[^>]*(?:t="([^"]*)")?[^>]*>([^]*?)<\/c>/g);

        for (const cell of cellMatches) {
          const type = cell[1];
          const cellContent = cell[2];
          const valueMatch = cellContent.match(/<v>([^<]*)<\/v>/);
          if (valueMatch) {
            if (type === 's') {
              // Shared string reference
              const idx = parseInt(valueMatch[1], 10);
              cells.push(sharedStrings[idx] || '');
            } else {
              cells.push(valueMatch[1]);
            }
          }
        }

        if (cells.some(c => c.trim())) {
          allText.push(cells.join('\t'));
        }
      }
    }

    return allText.join('\n');
  }

  /**
   * Extract XLSX as CSV with proper quoting.
   * Preserves row/column structure so PII redaction doesn't break tabular data.
   *
   * @param {ArrayBuffer} buffer - The .xlsx file contents
   * @returns {Promise<string>} CSV-formatted text
   */
  async function extractXlsxToCsv(buffer) {
    const entries = await parseZipEntries(buffer);

    // Read shared strings table
    const sharedStringsEntry = entries.find(e =>
      e.name === 'xl/sharedStrings.xml' || e.name.endsWith('/sharedStrings.xml')
    );
    const sharedStrings = [];
    if (sharedStringsEntry) {
      const xml = decodeUtf8(sharedStringsEntry.data);
      const siMatches = xml.matchAll(/<si>([^]*?)<\/si>/g);
      for (const si of siMatches) {
        let cellText = '';
        const tMatches = si[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g);
        for (const tm of tMatches) cellText += tm[1];
        sharedStrings.push(cellText);
      }
    }

    // Read sheet data
    const sheetEntries = entries
      .filter(e => /xl\/worksheets\/sheet\d+\.xml/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const csvRows = [];

    for (const sheetEntry of sheetEntries) {
      const xml = decodeUtf8(sheetEntry.data);
      const rows = xml.matchAll(/<row[^>]*>([^]*?)<\/row>/g);

      for (const row of rows) {
        const cells = [];
        const cellMatches = row[1].matchAll(/<c[^>]*(?:t="([^"]*)")?[^>]*>([^]*?)<\/c>/g);

        for (const cell of cellMatches) {
          const type = cell[1];
          const cellContent = cell[2];
          const valueMatch = cellContent.match(/<v>([^<]*)<\/v>/);
          if (valueMatch) {
            const value = type === 's'
              ? (sharedStrings[parseInt(valueMatch[1], 10)] || '')
              : valueMatch[1];
            cells.push(csvEscapeCell(value));
          } else {
            cells.push('');
          }
        }

        if (cells.some(c => c.trim())) {
          csvRows.push(cells.join(','));
        }
      }

      // Separator between sheets
      if (sheetEntries.length > 1) {
        csvRows.push('');
      }
    }

    return csvRows.join('\n');
  }

  /**
   * Escape a CSV cell value (RFC 4180).
   */
  function csvEscapeCell(value) {
    if (!value) return '';
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  /**
   * Extract text from HTML content.
   * @param {string|ArrayBuffer} content
   * @returns {string}
   */
  function extractHtmlText(content) {
    const html = decodeUtf8(content);

    // Remove script and style elements
    let cleaned = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

    // Convert block elements to newlines
    cleaned = cleaned
      .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '') // Remove remaining tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
      .trim();

    return cleaned;
  }

  /**
   * Extract text from Markdown content.
   * Strips markdown formatting while preserving text content.
   * @param {string|ArrayBuffer} content
   * @returns {string}
   */
  function extractMarkdownText(content) {
    let md = decodeUtf8(content);

    // Strip common markdown formatting (order matters: blocks before inline)
    md = md
      .replace(/```[\s\S]*?```/g, '')          // Code blocks (before inline code)
      .replace(/^#{1,6}\s+/gm, '')           // Headers
      .replace(/\*\*([^*]+)\*\*/g, '$1')      // Bold
      .replace(/\*([^*]+)\*/g, '$1')          // Italic
      .replace(/__([^_]+)__/g, '$1')          // Bold alt
      .replace(/_([^_]+)_/g, '$1')            // Italic alt
      .replace(/~~([^~]+)~~/g, '$1')          // Strikethrough
      .replace(/`([^`]+)`/g, '$1')            // Inline code
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // Images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Links
      .replace(/^\s*[-*+]\s+/gm, '')          // Unordered lists
      .replace(/^\s*\d+\.\s+/gm, '')          // Ordered lists
      .replace(/^\s*>\s+/gm, '')              // Blockquotes
      .replace(/^---+$/gm, '')                // Horizontal rules
      .replace(/\|/g, '\t')                   // Table pipes to tabs
      .replace(/^[\s\-:]+$/gm, '')            // Table separator rows
      .trim();

    return md;
  }

  /**
   * Minimal ZIP parser for extracting OOXML entries.
   * Handles the ZIP local file headers to extract uncompressed entries.
   * For compressed entries, uses DecompressionStream API when available.
   *
   * @param {ArrayBuffer} buffer
   * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
   */
  async function parseZipEntries(buffer) {
    if (!(buffer instanceof ArrayBuffer)) throw new Error('ZIP input must be an ArrayBuffer');
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error('ZIP archive is empty or exceeds the 25 MiB safety limit');
    }
    const view = new DataView(buffer);
    const entries = [];
    const seenNames = new Set();
    let offset = 0;
    let totalUncompressed = 0;

    while (offset <= buffer.byteLength - 30) {
      const signature = view.getUint32(offset, true);

      // Local file header signature = 0x04034b50
      if (signature !== 0x04034b50) break;

      if (entries.length >= MAX_ZIP_ENTRIES) throw new Error('ZIP archive contains too many entries');
      const flags = view.getUint16(offset + 6, true);
      if ((flags & 0x0041) !== 0) throw new Error('Encrypted ZIP entries are not supported');
      if ((flags & 0x0008) !== 0) throw new Error('ZIP data descriptors are not supported');
      const compressionMethod = view.getUint16(offset + 8, true);
      if (compressionMethod !== 0 && compressionMethod !== 8) {
        throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
      }
      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const expectedCrc32 = view.getUint32(offset + 14, true);
      const fileNameLength = view.getUint16(offset + 26, true);
      const extraFieldLength = view.getUint16(offset + 28, true);

      if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP entry exceeds the 25 MiB safety limit');
      if (uncompressedSize > 0 && compressedSize === 0) throw new Error('ZIP entry has inconsistent size metadata');
      if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
        throw new Error('ZIP entry has an unsafe compression ratio');
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) throw new Error('ZIP archive expands beyond the 100 MiB safety limit');

      const headerEnd = offset + 30 + fileNameLength + extraFieldLength;
      if (headerEnd > buffer.byteLength) throw new Error('Truncated ZIP local header');

      const fileNameBytes = new Uint8Array(buffer, offset + 30, fileNameLength);
      let fileName;
      try {
        fileName = new TextDecoder('utf-8', { fatal: true }).decode(fileNameBytes);
      } catch {
        throw new Error('ZIP entry name is not valid UTF-8');
      }
      if (!fileName || fileName.includes('\0') || fileName.includes('\\') || fileName.startsWith('/') ||
          /^[A-Za-z]:\//.test(fileName) || fileName.split('/').includes('..')) {
        throw new Error('ZIP entry has an unsafe file name');
      }
      const normalizedName = fileName.normalize('NFC');
      if (seenNames.has(normalizedName)) throw new Error('ZIP archive contains duplicate entry names');
      seenNames.add(normalizedName);

      const dataStart = headerEnd;
      const dataSize = compressedSize;
      if (dataStart + dataSize > buffer.byteLength) throw new Error('Truncated ZIP entry data');

      {
        const compressedData = new Uint8Array(buffer, dataStart, dataSize);

        let data;
        if (dataSize === 0 && uncompressedSize === 0) {
          data = new Uint8Array(0);
        } else if (compressionMethod === 0) {
          // Stored (no compression)
          data = compressedData;
        } else if (compressionMethod === 8 && typeof DecompressionStream !== 'undefined') {
          // Deflated — use DecompressionStream
          data = await decompressDeflate(compressedData, MAX_ZIP_ENTRY_BYTES);
        } else {
          throw new Error('This browser cannot safely decompress ZIP entries');
        }

        if (data.byteLength !== uncompressedSize) throw new Error('ZIP entry size does not match its header');
        const crc32Fn = globalThis.LLSS_crc32 ||
          (typeof require !== 'undefined' ? require('./zip-writer').crc32 : null);
        if (!crc32Fn || crc32Fn(data) !== expectedCrc32) throw new Error('ZIP entry failed its integrity check');

        entries.push({ name: fileName, data });
      }

      offset = dataStart + dataSize;
    }

    if (entries.length === 0) throw new Error('ZIP archive contains no readable entries');
    if (offset < buffer.byteLength - 3) {
      const trailingSignature = view.getUint32(offset, true);
      if (trailingSignature !== 0x02014b50 && trailingSignature !== 0x06054b50) {
        throw new Error('ZIP archive has unexpected trailing data');
      }
    }

    return entries;
  }

  /**
   * Decompress deflate data using the DecompressionStream API.
   * @param {Uint8Array} compressed
   * @returns {Promise<Uint8Array>}
   */
  async function decompressDeflate(compressed, maxOutputBytes = MAX_ZIP_ENTRY_BYTES) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();

    const reader = ds.readable.getReader();
    const chunks = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
      if (totalLength > maxOutputBytes) {
        await reader.cancel('Decompressed ZIP entry exceeded its safety limit');
        throw new Error('Decompressed ZIP entry exceeds its safety limit');
      }
    }

    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }
    return result;
  }

  /**
   * Main document processing entry point.
   * Extracts text from the document and returns it for redaction.
   *
   * @param {ArrayBuffer|string} content - Document content
   * @param {string} contentType - Detected content type
   * @returns {Promise<{text: string, contentType: string, requiresProvider: boolean}>}
   */
  async function processDocument(content, contentType) {
    switch (contentType) {
      case 'text':
        return {
          text: decodeUtf8(content),
          contentType,
          requiresProvider: false,
        };

      case 'docx':
        return {
          text: await extractDocxText(content),
          contentType,
          requiresProvider: false,
        };

      case 'xlsx':
        return {
          text: await extractXlsxToCsv(content),
          contentType: 'csv', // Promote to CSV for structured output
          requiresProvider: false,
        };

      case 'csv':
        return {
          text: decodeUtf8(content),
          contentType,
          requiresProvider: false,
        };

      case 'zip':
        return {
          text: null,
          contentType,
          requiresZipProcessing: true,
        };

      case 'html':
        return {
          text: extractHtmlText(content),
          contentType,
          requiresProvider: false,
        };

      case 'markdown':
        return {
          text: extractMarkdownText(content),
          contentType,
          requiresProvider: false,
        };

      case 'image':
        // Images require OCR — routed through offscreen document (local)
        // or hosted container (optional upgrade)
        return {
          text: null,
          contentType,
          requiresOffscreen: true,
        };

      case 'pdf':
        // PDFs require rendering + OCR — routed through offscreen document (local)
        // or hosted container (optional upgrade)
        return {
          text: null,
          contentType,
          requiresOffscreen: true,
        };

      default:
        throw new Error(`Unsupported document type: ${contentType}`);
    }
  }

  // Exports
  const exports = {
    detectContentType,
    processDocument,
    extractDocxText,
    extractXlsxText,
    extractHtmlText,
    extractMarkdownText,
    parseZipEntries,
    MIME_TO_TYPE,
    EXT_TO_TYPE,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_detectContentType = detectContentType;
    globalThis.LLSS_processDocument = processDocument;
    globalThis.LLSS_parseZipEntries = parseZipEntries;
    globalThis.LLSS_extractDocxText = extractDocxText;
    globalThis.LLSS_extractXlsxText = extractXlsxText;
    globalThis.LLSS_extractXlsxToCsv = extractXlsxToCsv;
    globalThis.LLSS_extractHtmlText = extractHtmlText;
    globalThis.LLSS_extractMarkdownText = extractMarkdownText;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
