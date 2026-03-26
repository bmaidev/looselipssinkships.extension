const { buildZip, crc32 } = require("../lib/documents/zip-writer");
const { parseZipEntries } = require("../lib/documents/document-processor");

describe("crc32", () => {
  test("returns correct checksum for known input", () => {
    const data = new TextEncoder().encode("hello");
    // CRC-32 of "hello" is 0x3610a686
    expect(crc32(data)).toBe(0x3610a686);
  });

  test("returns correct checksum for empty input", () => {
    const data = new Uint8Array(0);
    // CRC-32 of empty data is 0x00000000
    expect(crc32(data)).toBe(0x00000000);
  });

  test("returns different checksums for different inputs", () => {
    const a = new TextEncoder().encode("abc");
    const b = new TextEncoder().encode("xyz");
    expect(crc32(a)).not.toBe(crc32(b));
  });

  test("returns a 32-bit unsigned integer", () => {
    const data = new TextEncoder().encode("test data");
    const result = crc32(data);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xFFFFFFFF);
  });
});

describe("buildZip", () => {
  test("produces valid ZIP local file header signature", async () => {
    const zip = await buildZip([
      { name: "test.txt", data: new TextEncoder().encode("hello") },
    ]);
    // Local file header signature: 0x04034b50 (little-endian: 50 4b 03 04)
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  test("builds a ZIP with a single entry", async () => {
    const content = new TextEncoder().encode("Hello, World!");
    const zip = await buildZip([{ name: "greeting.txt", data: content }]);

    expect(zip).toBeInstanceOf(Uint8Array);
    expect(zip.length).toBeGreaterThan(0);

    // Check end of central directory signature (last 22 bytes start)
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Find EOCD signature 0x06054b50
    let eocdOffset = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    expect(eocdOffset).toBeGreaterThanOrEqual(0);

    // EOCD says 1 entry
    expect(view.getUint16(eocdOffset + 10, true)).toBe(1);
  });

  test("builds a ZIP with multiple entries", async () => {
    const entries = [
      { name: "a.txt", data: new TextEncoder().encode("alpha") },
      { name: "b.txt", data: new TextEncoder().encode("bravo") },
      { name: "c.txt", data: new TextEncoder().encode("charlie") },
    ];
    const zip = await buildZip(entries);

    expect(zip).toBeInstanceOf(Uint8Array);

    // Find EOCD and verify entry count
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocdOffset = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    expect(eocdOffset).toBeGreaterThanOrEqual(0);
    expect(view.getUint16(eocdOffset + 10, true)).toBe(3);
  });

  test("handles empty data entries", async () => {
    const zip = await buildZip([
      { name: "empty.txt", data: new Uint8Array(0) },
    ]);

    expect(zip).toBeInstanceOf(Uint8Array);
    // Should still have valid local header
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  test("handles large entry names", async () => {
    const longName = "a".repeat(255) + ".txt";
    const zip = await buildZip([
      { name: longName, data: new TextEncoder().encode("data") },
    ]);

    expect(zip).toBeInstanceOf(Uint8Array);
    expect(zip.length).toBeGreaterThan(0);

    // The file name length field should reflect the encoded name length
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const nameLen = view.getUint16(26, true);
    expect(nameLen).toBe(new TextEncoder().encode(longName).length);
  });

  test("round-trip: buildZip entries can be parsed back by parseZipEntries", async () => {
    const entries = [
      { name: "word/document.xml", data: new TextEncoder().encode("<doc>Hello</doc>") },
      { name: "meta.txt", data: new TextEncoder().encode("metadata here") },
    ];
    const zip = await buildZip(entries);

    // parseZipEntries expects an ArrayBuffer
    const parsed = await parseZipEntries(zip.buffer);

    expect(parsed.length).toBe(entries.length);
    for (let i = 0; i < entries.length; i++) {
      expect(parsed[i].name).toBe(entries[i].name);
      const text = new TextDecoder().decode(parsed[i].data);
      const original = new TextDecoder().decode(entries[i].data);
      expect(text).toBe(original);
    }
  });
});
