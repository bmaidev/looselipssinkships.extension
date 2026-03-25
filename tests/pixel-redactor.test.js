const { mapMatchesToRegions } = require("../lib/documents/pixel-redactor");

describe("mapMatchesToRegions", () => {
  test("maps a single PII match to its word bounding box", () => {
    const fullText = "Contact John Smith for details";
    const blocks = [
      {
        text: "Contact John Smith for details",
        bbox: { x: 10, y: 10, w: 400, h: 30 },
        words: [
          { text: "Contact", bbox: { x: 10, y: 10, w: 70, h: 30 } },
          { text: "John", bbox: { x: 90, y: 10, w: 50, h: 30 } },
          { text: "Smith", bbox: { x: 150, y: 10, w: 60, h: 30 } },
          { text: "for", bbox: { x: 220, y: 10, w: 30, h: 30 } },
          { text: "details", bbox: { x: 260, y: 10, w: 70, h: 30 } },
        ],
      },
    ];

    const matches = [
      { original: "John Smith", index: 8, typeId: "name" },
    ];

    const regions = mapMatchesToRegions(fullText, blocks, matches);

    expect(regions).toHaveLength(1);
    // Region should cover "John" and "Smith" words (merged bbox)
    expect(regions[0].x).toBeLessThanOrEqual(90);
    expect(regions[0].typeId).toBe("name");
    // Width should span from John's start to Smith's end
    const expectedRight = 150 + 60; // Smith x + w
    expect(regions[0].x + regions[0].w).toBeGreaterThanOrEqual(expectedRight);
  });

  test("maps multiple PII matches to separate regions", () => {
    const fullText = "Email: test@example.com Phone: 0412345678";
    const blocks = [
      {
        text: "Email: test@example.com Phone: 0412345678",
        bbox: { x: 0, y: 0, w: 500, h: 30 },
        words: [
          { text: "Email:", bbox: { x: 0, y: 0, w: 50, h: 30 } },
          { text: "test@example.com", bbox: { x: 60, y: 0, w: 160, h: 30 } },
          { text: "Phone:", bbox: { x: 240, y: 0, w: 60, h: 30 } },
          { text: "0412345678", bbox: { x: 310, y: 0, w: 100, h: 30 } },
        ],
      },
    ];

    const matches = [
      { original: "test@example.com", index: 7, typeId: "email" },
      { original: "0412345678", index: 31, typeId: "phone" },
    ];

    const regions = mapMatchesToRegions(fullText, blocks, matches);

    expect(regions).toHaveLength(2);
    expect(regions[0].typeId).toBe("email");
    expect(regions[1].typeId).toBe("phone");
  });

  test("returns empty array when no matches", () => {
    const regions = mapMatchesToRegions("Hello world", [], []);
    expect(regions).toEqual([]);
  });

  test("returns empty array when matches is null", () => {
    const regions = mapMatchesToRegions("Hello", [], null);
    expect(regions).toEqual([]);
  });

  test("handles multi-word PII spanning across block words", () => {
    const fullText = "Dear Mr John William Smith,";
    const blocks = [
      {
        text: "Dear Mr John William Smith,",
        bbox: { x: 0, y: 0, w: 300, h: 25 },
        words: [
          { text: "Dear", bbox: { x: 0, y: 0, w: 40, h: 25 } },
          { text: "Mr", bbox: { x: 50, y: 0, w: 25, h: 25 } },
          { text: "John", bbox: { x: 85, y: 0, w: 45, h: 25 } },
          { text: "William", bbox: { x: 140, y: 0, w: 70, h: 25 } },
          { text: "Smith,", bbox: { x: 220, y: 0, w: 55, h: 25 } },
        ],
      },
    ];

    const matches = [
      { original: "John William Smith", index: 8, typeId: "name" },
    ];

    const regions = mapMatchesToRegions(fullText, blocks, matches);

    expect(regions).toHaveLength(1);
    // Should span all three name words
    expect(regions[0].x).toBeLessThanOrEqual(85); // John's x (minus padding)
  });

  test("handles matches across multiple blocks", () => {
    const fullText = "Line one\nLine two with PII";
    const blocks = [
      {
        text: "Line one",
        bbox: { x: 0, y: 0, w: 100, h: 20 },
        words: [
          { text: "Line", bbox: { x: 0, y: 0, w: 40, h: 20 } },
          { text: "one", bbox: { x: 50, y: 0, w: 30, h: 20 } },
        ],
      },
      {
        text: "Line two with PII",
        bbox: { x: 0, y: 30, w: 200, h: 20 },
        words: [
          { text: "Line", bbox: { x: 0, y: 30, w: 40, h: 20 } },
          { text: "two", bbox: { x: 50, y: 30, w: 30, h: 20 } },
          { text: "with", bbox: { x: 90, y: 30, w: 40, h: 20 } },
          { text: "PII", bbox: { x: 140, y: 30, w: 30, h: 20 } },
        ],
      },
    ];

    const matches = [
      { original: "PII", index: 24, typeId: "custom" },
    ];

    const regions = mapMatchesToRegions(fullText, blocks, matches);
    expect(regions).toHaveLength(1);
    expect(regions[0].typeId).toBe("custom");
  });

  test("includes padding around redacted regions", () => {
    const fullText = "test@email.com";
    const blocks = [
      {
        text: "test@email.com",
        bbox: { x: 100, y: 100, w: 150, h: 20 },
        words: [
          { text: "test@email.com", bbox: { x: 100, y: 100, w: 150, h: 20 } },
        ],
      },
    ];

    const matches = [
      { original: "test@email.com", index: 0, typeId: "email" },
    ];

    const regions = mapMatchesToRegions(fullText, blocks, matches);
    expect(regions).toHaveLength(1);
    // Should have padding (region slightly larger than word bbox)
    expect(regions[0].x).toBeLessThan(100);
    expect(regions[0].w).toBeGreaterThan(150);
  });
});

describe("buildMinimalPdf", () => {
  const { buildMinimalPdf } = require("../lib/documents/pixel-redactor");

  test("produces valid PDF header", () => {
    // Create a tiny 1x1 JPEG-like blob (not a real JPEG, but tests the structure)
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const result = buildMinimalPdf([{ data: fakeJpeg, width: 1, height: 1 }]);

    expect(result).toBeInstanceOf(Uint8Array);
    // Check PDF header
    const header = new TextDecoder().decode(result.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  test("produces output containing %%EOF", () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const result = buildMinimalPdf([{ data: fakeJpeg, width: 100, height: 200 }]);

    const text = new TextDecoder().decode(result);
    expect(text).toContain("%%EOF");
  });

  test("includes multiple pages", () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const result = buildMinimalPdf([
      { data: fakeJpeg, width: 100, height: 200 },
      { data: fakeJpeg, width: 100, height: 200 },
      { data: fakeJpeg, width: 100, height: 200 },
    ]);

    const text = new TextDecoder().decode(result);
    expect(text).toContain("/Count 3");
  });

  test("embeds image dimensions in page MediaBox", () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8]);
    const result = buildMinimalPdf([{ data: fakeJpeg, width: 595, height: 842 }]);

    const text = new TextDecoder().decode(result);
    expect(text).toContain("/MediaBox [0 0 595 842]");
  });
});
