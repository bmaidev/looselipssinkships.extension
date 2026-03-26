/**
 * Minimal ZIP Writer — builds a valid ZIP archive from an array of entries.
 *
 * Mirrors parseZipEntries() in document-processor.js.
 * Uses CompressionStream('deflate-raw') for deflate compression.
 *
 * Usage:
 *   const zip = await buildZip([
 *     { name: 'word/document.xml', data: new Uint8Array([...]) },
 *     { name: 'image.png', data: pngBytes },
 *   ]);
 */

(function () {
  'use strict';

  const encoder = new TextEncoder();

  /**
   * Compress data using deflate-raw via CompressionStream.
   * @param {Uint8Array} data
   * @returns {Promise<Uint8Array>}
   */
  async function compressDeflate(data) {
    if (typeof CompressionStream === 'undefined') {
      // Fallback: store uncompressed
      return null;
    }
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();

    const reader = cs.readable.getReader();
    const chunks = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
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
   * Compute CRC-32 for a Uint8Array.
   * @param {Uint8Array} data
   * @returns {number}
   */
  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Write a 16-bit unsigned integer (little-endian) to a DataView.
   */
  function writeU16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  /**
   * Write a 32-bit unsigned integer (little-endian) to a DataView.
   */
  function writeU32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  /**
   * Build a ZIP archive from an array of entries.
   *
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Promise<Uint8Array>} Complete ZIP file bytes
   */
  async function buildZip(entries) {
    const localHeaders = [];
    const centralHeaders = [];
    let localOffset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const uncompressedData = entry.data;
      const crc = crc32(uncompressedData);

      // Try to compress
      let compressedData = await compressDeflate(uncompressedData);
      let compressionMethod = 8; // deflate

      // Use stored if compression didn't help or isn't available
      if (!compressedData || compressedData.length >= uncompressedData.length) {
        compressedData = uncompressedData;
        compressionMethod = 0; // stored
      }

      // Local file header (30 bytes + name + data)
      const localHeaderSize = 30 + nameBytes.length;
      const localHeader = new ArrayBuffer(localHeaderSize);
      const lv = new DataView(localHeader);

      writeU32(lv, 0, 0x04034b50);        // Local file header signature
      writeU16(lv, 4, 20);                 // Version needed to extract (2.0)
      writeU16(lv, 6, 0);                  // General purpose bit flag
      writeU16(lv, 8, compressionMethod);  // Compression method
      writeU16(lv, 10, 0);                 // Last mod file time
      writeU16(lv, 12, 0);                 // Last mod file date
      writeU32(lv, 14, crc);               // CRC-32
      writeU32(lv, 18, compressedData.length);   // Compressed size
      writeU32(lv, 22, uncompressedData.length); // Uncompressed size
      writeU16(lv, 26, nameBytes.length);  // File name length
      writeU16(lv, 28, 0);                 // Extra field length

      // Copy file name into local header
      new Uint8Array(localHeader).set(nameBytes, 30);

      localHeaders.push({
        header: new Uint8Array(localHeader),
        data: compressedData,
        name: nameBytes,
        crc,
        compressedSize: compressedData.length,
        uncompressedSize: uncompressedData.length,
        compressionMethod,
        localOffset,
      });

      localOffset += localHeaderSize + compressedData.length;

      // Central directory entry (46 bytes + name)
      const centralSize = 46 + nameBytes.length;
      const centralHeader = new ArrayBuffer(centralSize);
      const cv = new DataView(centralHeader);

      writeU32(cv, 0, 0x02014b50);        // Central directory file header signature
      writeU16(cv, 4, 20);                 // Version made by
      writeU16(cv, 6, 20);                 // Version needed to extract
      writeU16(cv, 8, 0);                  // General purpose bit flag
      writeU16(cv, 10, compressionMethod); // Compression method
      writeU16(cv, 12, 0);                 // Last mod file time
      writeU16(cv, 14, 0);                 // Last mod file date
      writeU32(cv, 16, crc);              // CRC-32
      writeU32(cv, 20, compressedData.length);   // Compressed size
      writeU32(cv, 24, uncompressedData.length); // Uncompressed size
      writeU16(cv, 28, nameBytes.length);  // File name length
      writeU16(cv, 30, 0);                 // Extra field length
      writeU16(cv, 32, 0);                 // File comment length
      writeU16(cv, 34, 0);                 // Disk number start
      writeU16(cv, 36, 0);                 // Internal file attributes
      writeU32(cv, 38, 0);                 // External file attributes
      writeU32(cv, 42, localHeaders[localHeaders.length - 1].localOffset); // Relative offset of local header

      new Uint8Array(centralHeader).set(nameBytes, 46);
      centralHeaders.push(new Uint8Array(centralHeader));
    }

    // Calculate total central directory size
    const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);
    const centralDirOffset = localOffset;

    // End of central directory record (22 bytes)
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);

    writeU32(ev, 0, 0x06054b50);           // End of central directory signature
    writeU16(ev, 4, 0);                     // Disk number
    writeU16(ev, 6, 0);                     // Disk where central directory starts
    writeU16(ev, 8, entries.length);         // Number of central directory records on this disk
    writeU16(ev, 10, entries.length);        // Total number of central directory records
    writeU32(ev, 12, centralDirSize);        // Size of central directory
    writeU32(ev, 16, centralDirOffset);      // Offset of start of central directory
    writeU16(ev, 20, 0);                     // Comment length

    // Assemble the complete ZIP
    const totalSize = localOffset + centralDirSize + 22;
    const result = new Uint8Array(totalSize);
    let pos = 0;

    // Write local file headers + data
    for (const entry of localHeaders) {
      result.set(entry.header, pos);
      pos += entry.header.length;
      result.set(entry.data, pos);
      pos += entry.data.length;
    }

    // Write central directory
    for (const header of centralHeaders) {
      result.set(header, pos);
      pos += header.length;
    }

    // Write end of central directory
    result.set(new Uint8Array(eocd), pos);

    return result;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_buildZip = buildZip;
    globalThis.LLSS_crc32 = crc32;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildZip, crc32 };
  }
})();
