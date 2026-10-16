const {
  buildRunMap,
  applyRedactionsToXml,
  isRedactablePart,
} = require("../lib/documents/docx-redactor");

// ── buildRunMap ────────────────────────────────────────────────────────────

describe("buildRunMap", () => {
  test("extracts text from w:t elements", () => {
    const xml = '<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);
    expect(virtualText).toContain("Hello World");
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("Hello World");
  });

  test("extracts text from multiple w:t elements in sequence", () => {
    const xml =
      '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);
    expect(virtualText).toContain("Hello ");
    expect(virtualText).toContain("World");
    expect(runs).toHaveLength(2);
    expect(runs[0].text).toBe("Hello ");
    expect(runs[1].text).toBe("World");
    // Runs should be contiguous in virtualText
    expect(runs[1].charStart).toBe(runs[0].charEnd);
  });

  test("handles paragraph boundaries with w:p", () => {
    const xml =
      '<w:p><w:r><w:t>Line one</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Line two</w:t></w:r></w:p>';
    const { virtualText } = buildRunMap(xml);
    expect(virtualText).toMatch(/Line one\nLine two/);
  });

  test("handles empty w:t elements", () => {
    const xml =
      '<w:p><w:r><w:t></w:t></w:r><w:r><w:t>Visible</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);
    expect(virtualText.trim()).toBe("Visible");
    // Empty w:t should be skipped
    expect(runs).toHaveLength(1);
  });

  test("handles w:t with xml:space attribute", () => {
    const xml =
      '<w:p><w:r><w:t xml:space="preserve"> spaced </w:t></w:r></w:p>';
    const { virtualText } = buildRunMap(xml);
    expect(virtualText).toContain(" spaced ");
  });

  test("run map offsets are consistent with virtualText", () => {
    const xml =
      '<w:p><w:r><w:t>abc</w:t></w:r><w:r><w:t>def</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);
    for (const run of runs) {
      expect(virtualText.substring(run.charStart, run.charEnd)).toBe(run.text);
    }
  });

  test("decodes XML entities while retaining raw XML replacement offsets", () => {
    const xml = '<w:p><w:r><w:t>Smith &amp; Jones john@example.com</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);
    expect(virtualText).toContain('Smith & Jones john@example.com');
    expect(runs[0].text).toContain('Smith & Jones');
  });
});

// ── applyRedactionsToXml ───────────────────────────────────────────────────

describe("applyRedactionsToXml", () => {
  test("single-run replacement", () => {
    const xml = '<w:p><w:r><w:t>Call me at john@test.com today</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);

    const emailStart = virtualText.indexOf("john@test.com");
    const matches = [
      { index: emailStart, original: "john@test.com", token: "[REDACTED_EMAIL]" },
    ];

    const result = applyRedactionsToXml(xml, matches, runs);
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).not.toContain("john@test.com");
    expect(result).toContain("Call me at");
    expect(result).toContain("today");
  });

  test("multi-run span (PII split across runs)", () => {
    // Simulate "john@test.com" split across two runs: "john@te" | "st.com"
    const xml =
      '<w:p><w:r><w:t>john@te</w:t></w:r><w:r><w:t>st.com</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);

    // virtualText may have trailing \n from paragraph end
    expect(virtualText.trim()).toBe("john@test.com");
    const matches = [
      { index: 0, original: "john@test.com", token: "[REDACTED_EMAIL]" },
    ];

    const result = applyRedactionsToXml(xml, matches, runs);
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).not.toContain("john@te");
    expect(result).not.toContain("st.com");
  });

  test("preserves non-PII text", () => {
    const xml =
      '<w:p><w:r><w:t>No PII here just normal text</w:t></w:r></w:p>';
    const { runs } = buildRunMap(xml);
    const result = applyRedactionsToXml(xml, [], runs);
    expect(result).toBe(xml);
  });

  test("returns original XML when matches array is null", () => {
    const xml = '<w:p><w:r><w:t>Some text</w:t></w:r></w:p>';
    const { runs } = buildRunMap(xml);
    const result = applyRedactionsToXml(xml, null, runs);
    expect(result).toBe(xml);
  });

  test("handles XML entity escaping in replacement text", () => {
    const xml = '<w:p><w:r><w:t>Tom and Jerry</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);

    // Replace "Tom" with a token that contains characters needing XML escaping
    const matches = [
      { index: 0, original: "Tom", token: "T&J<>" },
    ];
    const result = applyRedactionsToXml(xml, matches, runs);
    // The replacement should be XML-escaped
    expect(result).toContain("T&amp;J&lt;&gt;");
    expect(result).toContain(" and Jerry");
  });

  test("preserves existing XML entities without double-escaping them", () => {
    const xml = '<w:p><w:r><w:t>Smith &amp; Jones john@test.com</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);
    const original = 'john@test.com';
    const result = applyRedactionsToXml(xml, [{
      index: virtualText.indexOf(original),
      original,
      token: '[EMAIL]',
    }], runs);

    expect(result).toContain('Smith &amp; Jones [EMAIL]');
    expect(result).not.toContain('&amp;amp;');
  });

  test("rejects a match that does not map exactly to DOCX text", () => {
    const xml = '<w:p><w:r><w:t>John Smith</w:t></w:r></w:p>';
    const { runs } = buildRunMap(xml);
    expect(() => applyRedactionsToXml(xml, [{
      index: 1,
      original: 'John Smith',
      token: '[NAME]',
    }], runs)).toThrow(/could not be mapped exactly/);
  });

  test("processes matches in correct order (right-to-left)", () => {
    const xml =
      '<w:p><w:r><w:t>Email john@a.com and jane@b.com here</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);

    const match1Start = virtualText.indexOf("john@a.com");
    const match2Start = virtualText.indexOf("jane@b.com");
    const matches = [
      { index: match1Start, original: "john@a.com", token: "[EMAIL1]" },
      { index: match2Start, original: "jane@b.com", token: "[EMAIL2]" },
    ];

    const result = applyRedactionsToXml(xml, matches, runs);
    expect(result).toContain("[EMAIL1]");
    expect(result).toContain("[EMAIL2]");
    expect(result).not.toContain("john@a.com");
    expect(result).not.toContain("jane@b.com");
    // Surrounding text is preserved
    expect(result).toContain("Email ");
    expect(result).toContain(" and ");
    expect(result).toContain(" here");
  });

  test("multiple matches in same run are all applied", () => {
    const xml = '<w:p><w:r><w:t>A 0412345678 B 0498765432 C</w:t></w:r></w:p>';
    const { virtualText, runs } = buildRunMap(xml);

    const m1 = virtualText.indexOf("0412345678");
    const m2 = virtualText.indexOf("0498765432");
    const matches = [
      { index: m1, original: "0412345678", token: "[PHONE]" },
      { index: m2, original: "0498765432", token: "[PHONE]" },
    ];

    const result = applyRedactionsToXml(xml, matches, runs);
    const tokenCount = (result.match(/\[PHONE\]/g) || []).length;
    expect(tokenCount).toBe(2);
  });
});

// ── isRedactablePart ───────────────────────────────────────────────────────

describe("isRedactablePart", () => {
  test("identifies document.xml", () => {
    expect(isRedactablePart("word/document.xml")).toBe(true);
  });

  test("identifies header files", () => {
    expect(isRedactablePart("word/header1.xml")).toBe(true);
    expect(isRedactablePart("word/header2.xml")).toBe(true);
  });

  test("identifies footer files", () => {
    expect(isRedactablePart("word/footer1.xml")).toBe(true);
    expect(isRedactablePart("word/footer3.xml")).toBe(true);
  });

  test("identifies comments and footnotes", () => {
    expect(isRedactablePart("word/comments.xml")).toBe(true);
    expect(isRedactablePart("word/footnotes.xml")).toBe(true);
    expect(isRedactablePart("word/endnotes.xml")).toBe(true);
  });

  test("rejects non-redactable parts", () => {
    expect(isRedactablePart("word/styles.xml")).toBe(false);
    expect(isRedactablePart("word/settings.xml")).toBe(false);
    expect(isRedactablePart("[Content_Types].xml")).toBe(false);
    expect(isRedactablePart("word/media/image1.png")).toBe(false);
  });

  test("rejects partial matches", () => {
    expect(isRedactablePart("word/document.xml.bak")).toBe(false);
    expect(isRedactablePart("other/document.xml")).toBe(false);
  });
});
