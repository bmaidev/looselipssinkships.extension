const { ProviderRegistry } = require("../lib/providers/provider-registry");
const { BaseProvider, PROVIDER_TIERS, PROVIDER_CAPABILITIES } = require("../lib/providers/base-provider");

// Mock the pipeline module's globalThis dependencies
class MockProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: overrides.id || "mock",
      name: overrides.name || "Mock",
      tier: overrides.tier || "local",
      capabilities: overrides.capabilities || ["text"],
      priority: overrides.priority ?? 50,
      enabled: overrides.enabled !== false,
      settings: overrides.settings || {},
    });
    this._available = overrides.available !== false;
    this._shouldFail = overrides.shouldFail || false;
    this._redactFn = overrides.redactFn || ((text) => text + " [redacted by " + this.id + "]");
  }

  async checkAvailability() {
    return { available: this._available, status: this._available ? "readily" : "no" };
  }

  async redactText(text, piiTypes, settings) {
    if (this._shouldFail) throw new Error(`${this.id} failed`);
    return {
      redacted: this._redactFn(text),
      engine: this.id,
      matches: [{ typeId: "test", token: "[TEST]", original: "test", index: 0 }],
    };
  }
}

// Load pipeline after setting up globals
const { redactText, redactDocument } = require("../lib/pipeline");

describe("Pipeline - redactText", () => {
  let registry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  test("auto mode uses regex first for short text", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    // Short text → regex only (AI not attempted for <200 chars)
    expect(result.engine).toBe("regex");
    expect(result.pipelineSteps).toContain("regex_first");
  });

  test("auto mode runs regex when AI unavailable", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, available: false }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    expect(result.engine).toBe("regex");
    expect(result.pipelineSteps).toContain("regex_first");
  });

  test("auto mode runs regex when AI fails", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, shouldFail: true }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    // Use medium-length text to trigger AI attempt
    const mediumText = "a]".repeat(150);
    const result = await redactText(mediumText, {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    // Regex still runs first, AI failure is non-blocking
    expect(result.engine).toContain("regex");
    expect(result.pipelineSteps).toContain("regex_first");
  });

  test("regex_only mode skips AI", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "regex_only" },
    });

    expect(result.engine).toBe("regex");
    expect(result.pipelineSteps).toContain("regex_only");
  });

  test("ai_only mode uses local AI first", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "ai_only" },
    });

    expect(result.engine).toBe("local_ai+regex");
    expect(result.pipelineSteps).toContain("ai_only:local_ai");
    expect(result.pipelineSteps).toContain("regex_after_ai");
  });

  test("ai_only mode escalates to hosted when local unavailable", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, available: false }));
    registry.register(new MockProvider({ id: "hosted_llm", tier: "hosted", priority: 30 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "ai_only" },
    });

    expect(result.engine).toBe("hosted_llm");
    expect(result.tier).toBe("hosted");
  });

  test("ai_only mode throws when no AI available", async () => {
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    await expect(
      redactText("test input", {
        registry,
        piiTypes: [],
        settings: { detectionMode: "ai_only" },
      })
    ).rejects.toThrow("no AI providers are available");
  });

  test("forceProvider overrides routing", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "azure_pii", tier: "cloud", priority: 50 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
      forceProvider: "azure_pii",
    });

    expect(result.engine).toBe("azure_pii");
  });

  test("forceProvider throws for unknown provider", async () => {
    await expect(
      redactText("test", { registry, piiTypes: [], settings: {}, forceProvider: "nonexistent" })
    ).rejects.toThrow("not found");
  });

  test("forceTier routes to specific tier", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "azure", tier: "cloud", priority: 50 }));

    const result = await redactText("test", {
      registry,
      piiTypes: [],
      settings: {},
      forceTier: "cloud",
    });

    expect(result.engine).toBe("azure");
  });

  test("auto mode: regex runs first, AI enhances for medium text", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const mediumText = "a".repeat(300);
    const result = await redactText(mediumText, {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    // Regex runs first, AI enhancement attempted
    expect(result.pipelineSteps).toContain("regex_first");
    expect(result.pipelineSteps).toContain("ai_enhance");
  });

  test("auto mode: hosted enhancement for medium text", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, available: false }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));
    registry.register(new MockProvider({ id: "hosted_llm", tier: "hosted", priority: 30 }));

    const mediumText = "a".repeat(300);
    const result = await redactText(mediumText, {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    // Regex first, then hosted enhancement attempted
    expect(result.pipelineSteps).toContain("regex_first");
    expect(result.pipelineSteps).toEqual(
      expect.arrayContaining([expect.stringContaining("hosted")])
    );
  });

  test("throws when no providers available at all", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", available: false }));

    await expect(
      redactText("test", { registry, piiTypes: [], settings: { detectionMode: "auto" } })
    ).rejects.toThrow("No redaction providers available");
  });

  test("result includes pipeline steps", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    expect(result.pipelineSteps).toBeDefined();
    expect(Array.isArray(result.pipelineSteps)).toBe(true);
    expect(result.pipelineSteps.length).toBeGreaterThan(0);
  });
});

describe("Pipeline - hosted OCR coordinate safety", () => {
  test("scales hosted OCR regions to the local redaction canvas", async () => {
    const registry = new ProviderRegistry();
    const regex = new MockProvider({
      id: "regex",
      redactFn: () => "[NAME]",
    });
    regex.redactText = async () => ({
      redacted: "[NAME]",
      engine: "regex",
      matches: [{ typeId: "name", token: "[NAME]", original: "John", index: 0 }],
    });
    registry.register(regex);
    const hosted = new MockProvider({
      id: "hosted_ocr",
      tier: "hosted",
      settings: { apiMode: "ocr_extract" },
    });
    hosted.extractOcr = async () => ({
      fullText: "John",
      pages: [{
        pageNumber: 1,
        text: "John",
        charStart: 0,
        charEnd: 4,
        width: 100,
        height: 100,
        blocks: [],
      }],
    });
    registry.register(hosted);

    const originalProcessor = globalThis.LLSS_processDocument;
    const originalMapper = globalThis.LLSS_mapMatchesToRegions;
    globalThis.LLSS_processDocument = async () => ({ requiresOffscreen: true });
    globalThis.LLSS_mapMatchesToRegions = () => [{ x: 10, y: 20, w: 30, h: 40 }];

    let renderCalls = 0;
    let applied;
    const offscreenProcessor = {
      renderAndOcr: async () => {
        renderCalls += 1;
        if (renderCalls === 1) throw new Error("local OCR unavailable");
        return { pages: [{ pageNumber: 1, width: 200, height: 300 }] };
      },
      applyRedactions: async (request) => {
        applied = request;
        return { file: [1, 2, 3], format: "image/png", pageCount: 1 };
      },
    };

    try {
      const result = await redactDocument(new Uint8Array([1, 2, 3]).buffer, "image", {
        registry,
        piiTypes: [],
        settings: { detectionMode: "auto", providers: {} },
        offscreenProcessor,
        verifiedMimeType: "image/png",
      });

      expect(Array.from(result.redactedFile)).toEqual([1, 2, 3]);
      expect(applied.pageRedactions[0].regions).toEqual([
        { x: 20, y: 60, w: 60, h: 120 },
      ]);
    } finally {
      globalThis.LLSS_processDocument = originalProcessor;
      globalThis.LLSS_mapMatchesToRegions = originalMapper;
    }
  });
});

describe("Pipeline - Azure native document release safety", () => {
  let originalNative;
  let originalProcessor;

  beforeEach(() => {
    originalNative = globalThis.LLSS_AzureNativeDoc;
    originalProcessor = globalThis.LLSS_processDocument;
  });

  afterEach(() => {
    globalThis.LLSS_AzureNativeDoc = originalNative;
    globalThis.LLSS_processDocument = originalProcessor;
  });

  test("coerces detect-only policy to an actual redaction policy", async () => {
    let receivedPolicy;
    globalThis.LLSS_AzureNativeDoc = {
      redactDocument: async (_content, _name, _mime, _provider, nativeSettings) => {
        receivedPolicy = nativeSettings.redactionPolicy;
        return {
          redactedFile: new TextEncoder().encode("%PDF-secured").buffer,
          contentType: "application/octet-stream",
          entities: [],
        };
      },
    };

    const result = await redactDocument(new TextEncoder().encode("%PDF-source").buffer, "pdf", {
      registry: new ProviderRegistry(),
      piiTypes: [],
      fileName: "source.pdf",
      settings: {
        detectionMode: "cloud_only",
        providers: {
          azure_pii: {
            enabled: true,
            nativeDocEnabled: true,
            endpoint: "https://example.cognitiveservices.azure.com",
            sourceContainerUrl: "https://example.blob.core.windows.net/source",
            targetContainerUrl: "https://example.blob.core.windows.net/target",
            redactionPolicy: "noMask",
          },
        },
      },
    });

    expect(receivedPolicy).toBe("entityMask");
    expect(result.redactedFileFormat).toBe("application/pdf");
  });

  test("does not release a cloud result with the wrong file signature", async () => {
    globalThis.LLSS_AzureNativeDoc = {
      redactDocument: async () => ({
        redactedFile: new TextEncoder().encode("not a pdf").buffer,
        contentType: "application/pdf",
        entities: [],
      }),
    };
    globalThis.LLSS_processDocument = async () => {
      throw new Error("local fallback unavailable");
    };

    await expect(redactDocument(new TextEncoder().encode("%PDF-source").buffer, "pdf", {
      registry: new ProviderRegistry(),
      piiTypes: [],
      settings: {
        providers: {
          azure_pii: {
            enabled: true,
            nativeDocEnabled: true,
            endpoint: "https://example.cognitiveservices.azure.com",
            sourceContainerUrl: "https://example.blob.core.windows.net/source",
            targetContainerUrl: "https://example.blob.core.windows.net/target",
          },
        },
      },
    })).rejects.toThrow("local fallback unavailable");
  });
});
