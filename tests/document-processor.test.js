const {
  detectContentType,
  extractHtmlText,
  extractMarkdownText,
  MIME_TO_TYPE,
  EXT_TO_TYPE,
  parseZipEntries,
} = require("../lib/documents/document-processor");
const { buildZip } = require("../lib/documents/zip-writer");

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

  test("rejects invalid UTF-8 instead of silently replacing bytes", () => {
    const invalid = Uint8Array.from([0xc3, 0x28]).buffer;
    expect(() => extractHtmlText(invalid)).toThrow();
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

  test("recognises text-based formats", () => {
    expect(EXT_TO_TYPE[".json"]).toBe("text");
    expect(EXT_TO_TYPE[".xml"]).toBe("text");
    expect(EXT_TO_TYPE[".yaml"]).toBe("text");
    expect(EXT_TO_TYPE[".yml"]).toBe("text");
    expect(EXT_TO_TYPE[".toml"]).toBe("text");
    expect(EXT_TO_TYPE[".log"]).toBe("text");
    expect(EXT_TO_TYPE[".env"]).toBe("text");
    expect(EXT_TO_TYPE[".ini"]).toBe("text");
    expect(EXT_TO_TYPE[".rtf"]).toBe("text");
  });

  test("recognises code files", () => {
    expect(EXT_TO_TYPE[".py"]).toBe("text");
    expect(EXT_TO_TYPE[".js"]).toBe("text");
    expect(EXT_TO_TYPE[".ts"]).toBe("text");
    expect(EXT_TO_TYPE[".java"]).toBe("text");
    expect(EXT_TO_TYPE[".cs"]).toBe("text");
    expect(EXT_TO_TYPE[".go"]).toBe("text");
    expect(EXT_TO_TYPE[".sql"]).toBe("text");
    expect(EXT_TO_TYPE[".sh"]).toBe("text");
    expect(EXT_TO_TYPE[".ps1"]).toBe("text");
  });

  test("recognises CSV and ZIP", () => {
    expect(EXT_TO_TYPE[".csv"]).toBe("csv");
    expect(EXT_TO_TYPE[".zip"]).toBe("zip");
  });
});

describe("detectContentType — expanded formats", () => {
  test("detects JSON from MIME", () => {
    expect(detectContentType(null, "application/json")).toBe("text");
  });

  test("detects CSV from MIME and extension", () => {
    expect(detectContentType(null, "text/csv")).toBe("csv");
    expect(detectContentType("data.csv")).toBe("csv");
  });

  test("detects ZIP from MIME and extension", () => {
    expect(detectContentType(null, "application/zip")).toBe("zip");
    expect(detectContentType("archive.zip")).toBe("zip");
  });

  test("detects code files by extension", () => {
    expect(detectContentType("script.py")).toBe("text");
    expect(detectContentType("app.tsx")).toBe("text");
    expect(detectContentType("query.sql")).toBe("text");
  });
});

describe("ZIP safety limits", () => {
  test("rejects path traversal entry names", async () => {
    const zip = await buildZip([{ name: "../secret.txt", data: new TextEncoder().encode("secret") }]);
    await expect(parseZipEntries(zip.buffer)).rejects.toThrow(/unsafe file name/);
  });

  test("rejects an entry declaring an oversized expansion", async () => {
    const header = new ArrayBuffer(30);
    const view = new DataView(header);
    view.setUint32(0, 0x04034b50, true);
    view.setUint32(18, 1, true);
    view.setUint32(22, 26 * 1024 * 1024, true);
    await expect(parseZipEntries(header)).rejects.toThrow(/25 MiB safety limit/);
  });

  test("rejects entries whose data fails the ZIP CRC integrity check", async () => {
    const zip = await buildZip([{ name: "note.txt", data: new TextEncoder().encode("secret") }]);
    const tampered = new Uint8Array(zip);
    const fileNameLength = new DataView(tampered.buffer).getUint16(26, true);
    tampered[30 + fileNameLength] ^= 0xff;
    await expect(parseZipEntries(tampered.buffer)).rejects.toThrow(/integrity check/);
  });

  test("rejects duplicate entry names", async () => {
    const zip = await buildZip([
      { name: "note.txt", data: new TextEncoder().encode("one") },
      { name: "note.txt", data: new TextEncoder().encode("two") },
    ]);
    await expect(parseZipEntries(zip.buffer)).rejects.toThrow(/duplicate entry names/);
  });

  test("preserves legitimate empty files and directory entries", async () => {
    const zip = await buildZip([
      { name: "folder/", data: new Uint8Array(0) },
      { name: "folder/empty.txt", data: new Uint8Array(0) },
    ]);
    const entries = await parseZipEntries(zip.buffer);
    expect(entries.map((entry) => entry.name)).toEqual(["folder/", "folder/empty.txt"]);
    expect(entries.every((entry) => entry.data.byteLength === 0)).toBe(true);
  });
});
