const {
  detectContentType,
  extractHtmlText,
  extractMarkdownText,
  MIME_TO_TYPE,
  EXT_TO_TYPE,
} = require("../lib/documents/document-processor");

describe("detectContentType", () => {
  test("detects from MIME type", () => {
    expect(detectContentType(null, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(detectContentType(null, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx");
    expect(detectContentType(null, "text/html")).toBe("html");
    expect(detectContentType(null, "text/markdown")).toBe("markdown");
    expect(detectContentType(null, "text/plain")).toBe("text");
    expect(detectContentType(null, "image/png")).toBe("image");
    expect(detectContentType(null, "image/jpeg")).toBe("image");
    expect(detectContentType(null, "application/pdf")).toBe("pdf");
  });

  test("detects from file extension", () => {
    expect(detectContentType("report.docx")).toBe("docx");
    expect(detectContentType("data.xlsx")).toBe("xlsx");
    expect(detectContentType("page.html")).toBe("html");
    expect(detectContentType("notes.md")).toBe("markdown");
    expect(detectContentType("readme.txt")).toBe("text");
    expect(detectContentType("photo.jpg")).toBe("image");
    expect(detectContentType("scan.tiff")).toBe("image");
    expect(detectContentType("doc.pdf")).toBe("pdf");
  });

  test("MIME takes priority over extension", () => {
    expect(detectContentType("file.txt", "text/html")).toBe("html");
  });

  test("returns null for unknown types", () => {
    expect(detectContentType("file.xyz")).toBeNull();
    expect(detectContentType(null, "application/octet-stream")).toBeNull();
  });

  test("handles case-insensitive extensions", () => {
    expect(detectContentType("FILE.DOCX")).toBe("docx");
    expect(detectContentType("photo.JPG")).toBe("image");
  });
});

describe("extractHtmlText", () => {
  test("strips HTML tags", () => {
    const html = "<p>Hello <strong>World</strong></p>";
    const text = extractHtmlText(html);
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<strong>");
  });

  test("removes script and style elements", () => {
    const html = '<style>.foo{}</style><p>Content</p><script>alert(1)</script>';
    const text = extractHtmlText(html);
    expect(text).toContain("Content");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".foo");
  });

  test("converts block elements to newlines", () => {
    const html = "<p>Line 1</p><p>Line 2</p>";
    const text = extractHtmlText(html);
    expect(text).toMatch(/Line 1[\n\s]+Line 2/);
  });

  test("decodes HTML entities", () => {
    const html = "Tom &amp; Jerry &lt;3 &quot;cheese&quot;";
    const text = extractHtmlText(html);
    expect(text).toContain('Tom & Jerry <3 "cheese"');
  });

  test("handles ArrayBuffer input", () => {
    const encoder = new TextEncoder();
    const buffer = encoder.encode("<p>Test</p>").buffer;
    const text = extractHtmlText(buffer);
    expect(text).toContain("Test");
  });

  test("handles empty content", () => {
    expect(extractHtmlText("")).toBe("");
  });
});

describe("extractMarkdownText", () => {
  test("strips heading markers", () => {
    expect(extractMarkdownText("# Title")).toBe("Title");
    expect(extractMarkdownText("### Subheading")).toBe("Subheading");
  });

  test("strips bold and italic", () => {
    expect(extractMarkdownText("**bold** and *italic*")).toBe("bold and italic");
    expect(extractMarkdownText("__bold__ and _italic_")).toBe("bold and italic");
  });

  test("strips links", () => {
    expect(extractMarkdownText("[click here](http://example.com)")).toBe("click here");
  });

  test("strips image syntax", () => {
    expect(extractMarkdownText("![alt text](image.png)")).toBe("alt text");
  });

  test("strips list markers", () => {
    const md = "- Item 1\n- Item 2\n1. Ordered";
    const text = extractMarkdownText(md);
    expect(text).toContain("Item 1");
    expect(text).toContain("Ordered");
    expect(text).not.toMatch(/^-\s/m);
  });

  test("strips blockquotes", () => {
    expect(extractMarkdownText("> Quote text").trim()).toBe("Quote text");
  });

  test("strips inline code", () => {
    expect(extractMarkdownText("Run `npm install`")).toBe("Run npm install");
  });

  test("strips code blocks", () => {
    const md = "Before\n```js\nconst x = 1;\n```\nAfter";
    const text = extractMarkdownText(md);
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("const x");
  });

  test("strips strikethrough", () => {
    expect(extractMarkdownText("~~deleted~~")).toBe("deleted");
  });

  test("handles ArrayBuffer input", () => {
    const encoder = new TextEncoder();
    const buffer = encoder.encode("# Title").buffer;
    const text = extractMarkdownText(buffer);
    expect(text).toBe("Title");
  });
});

describe("MIME_TO_TYPE map", () => {
  test("covers key document types", () => {
    expect(Object.keys(MIME_TO_TYPE).length).toBeGreaterThan(5);
    expect(MIME_TO_TYPE["image/png"]).toBe("image");
    expect(MIME_TO_TYPE["text/plain"]).toBe("text");
  });
});

describe("EXT_TO_TYPE map", () => {
  test("covers key extensions", () => {
    expect(Object.keys(EXT_TO_TYPE).length).toBeGreaterThan(10);
    expect(EXT_TO_TYPE[".docx"]).toBe("docx");
    expect(EXT_TO_TYPE[".xlsx"]).toBe("xlsx");
  });
});
