// Tests for the OCR processor module.
// Since Tesseract.js isn't available in the test environment,
// we test the module's structural exports and error handling.

describe("ocr-processor module", () => {
  test("exports expected functions", () => {
    // The module uses IIFE + globalThis, so in Node it exports via module.exports
    const mod = require("../lib/documents/ocr-processor");
    expect(typeof mod.ocrImage).toBe("function");
    expect(typeof mod.ocrPages).toBe("function");
    expect(typeof mod.destroyOcrWorker).toBe("function");
  });

  test("ocrImage throws when Tesseract is not available", async () => {
    // Clear any cached worker
    const mod = require("../lib/documents/ocr-processor");
    await mod.destroyOcrWorker();

    // globalThis.Tesseract is not set in test environment
    delete globalThis.Tesseract;

    await expect(mod.ocrImage({})).rejects.toThrow("Tesseract.js not loaded");
  });

  test("destroyOcrWorker succeeds when no worker exists", async () => {
    const mod = require("../lib/documents/ocr-processor");
    // Should not throw
    await expect(mod.destroyOcrWorker()).resolves.not.toThrow();
  });
});
