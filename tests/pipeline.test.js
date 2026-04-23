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
const { redactText } = require("../lib/pipeline");

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

    expect(result.engine).toBe("local_ai");
    expect(result.pipelineSteps).toContain("ai_only:local_ai");
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
