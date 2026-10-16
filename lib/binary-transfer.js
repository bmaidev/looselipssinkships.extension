/**
 * Bounded binary transport for Chromium extension messages.
 *
 * Chromium serialises extension messages as JSON. A number[] representation of
 * a large document is extremely memory-inefficient; bounded base64 remains
 * below the transport ceiling for the extension's 25 MiB document limit.
 */
(function () {
  'use strict';

  const CHUNK_BYTES = 24 * 1024; // Divisible by 3 so base64 chunks concatenate.

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error('Binary value must be an ArrayBuffer or typed array');
  }

  function toBase64(value, maxBytes) {
    const bytes = asBytes(value);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
      throw new Error('Binary value exceeds its safety limit');
    }

    const encoded = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
      let binary = '';
      for (let index = 0; index < chunk.length; index++) {
        binary += String.fromCharCode(chunk[index]);
      }
      encoded.push(btoa(binary));
    }
    return encoded.join('');
  }

  function fromBase64(value, maxBytes) {
    if (typeof value !== 'string' || value.length === 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Encoded binary value is invalid');
    }
    const maxEncodedChars = 4 * Math.ceil(maxBytes / 3);
    if (value.length > maxEncodedChars || value.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error('Encoded binary value exceeds its safety limit or is malformed');
    }

    let decoded;
    try {
      decoded = atob(value);
    } catch {
      throw new Error('Encoded binary value is malformed');
    }
    if (decoded.length === 0 || decoded.length > maxBytes) {
      throw new Error('Decoded binary value exceeds its safety limit');
    }
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  }

  const api = { toBase64, fromBase64 };
  if (typeof globalThis !== 'undefined') globalThis.LLSS_BinaryTransfer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
