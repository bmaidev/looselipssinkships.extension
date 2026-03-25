// Tests for the OCR processor module.
// Since Tesseract.js isn't available in the test environment,
// we test the module's structural exports and error handling.

describe("ocr-processor module", () => {
  test("exports expected functions", () => {
    const mod = require("../lib/documents/ocr-processor");
    expect(typeof mod.ocrImage).toBe("function");
    expect(typeof mod.ocrPages).toBe("function");
    expect(typeof mod.ocrPagesParallel).toBe("function");
    expect(typeof mod.ocrPagesAdaptive).toBe("function");
    expect(typeof mod.initWorkerPool).toBe("function");
    expect(typeof mod.destroyOcrWorker).toBe("function");
    expect(typeof mod.destroyWorkerPool).toBe("function");
    expect(typeof mod.destroyAll).toBe("function");
  });

  test("POOL_THRESHOLD is exported and reasonable", () => {
    const mod = require("../lib/documents/ocr-processor");
    expect(mod.POOL_THRESHOLD).toBeGreaterThanOrEqual(2);
    expect(mod.POOL_THRESHOLD).toBeLessThanOrEqual(10);
  });

  test("ocrImage throws when Tesseract is not available", async () => {
    const mod = require("../lib/documents/ocr-processor");
    await mod.destroyAll();
    delete globalThis.Tesseract;

    await expect(mod.ocrImage({})).rejects.toThrow("Tesseract.js not loaded");
  });

  test("destroyOcrWorker succeeds when no worker exists", async () => {
    const mod = require("../lib/documents/ocr-processor");
    await expect(mod.destroyOcrWorker()).resolves.not.toThrow();
  });

  test("destroyWorkerPool succeeds when pool is empty", async () => {
    const mod = require("../lib/documents/ocr-processor");
    await expect(mod.destroyWorkerPool()).resolves.not.toThrow();
  });

  test("destroyAll cleans up both worker and pool", async () => {
    const mod = require("../lib/documents/ocr-processor");
    await expect(mod.destroyAll()).resolves.not.toThrow();
  });

  test("initWorkerPool throws when Tesseract is not available", async () => {
    const mod = require("../lib/documents/ocr-processor");
    delete globalThis.Tesseract;
    await expect(mod.initWorkerPool(2)).rejects.toThrow("Tesseract.js not loaded");
  });
});
