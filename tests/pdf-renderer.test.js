// Tests for the PDF renderer module.
// Since pdf.js isn't available in the test environment,
// we test module structure and error handling.

describe("pdf-renderer module", () => {
  test("exports renderPdfPages function", () => {
    const mod = require("../lib/documents/pdf-renderer");
    expect(typeof mod.renderPdfPages).toBe("function");
  });

  test("renderPdfPages throws when pdf.js is not loaded", async () => {
    delete globalThis.pdfjsLib;
    const mod = require("../lib/documents/pdf-renderer");

    await expect(
      mod.renderPdfPages(new ArrayBuffer(10))
    ).rejects.toThrow("pdf.js not loaded");
  });
});
