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

  test("uses local AI when available in auto mode", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    expect(result.engine).toBe("local_ai");
    expect(result.pipelineSteps).toContain("local_ai");
    expect(result.escalated).toBe(false);
  });

  test("falls back to regex when local AI unavailable", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, available: false }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    expect(result.engine).toBe("regex");
    expect(result.escalated).toBe(true);
  });

  test("falls back to regex when local AI fails", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, shouldFail: true }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    expect(result.engine).toBe("regex");
    expect(result.pipelineSteps).toEqual(expect.arrayContaining([
      expect.stringContaining("local_ai:failed"),
    ]));
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

  test("belt-and-suspenders runs regex after AI", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto", regexAfterAi: true },
    });

    expect(result.engine).toContain("regex");
    expect(result.pipelineSteps).toContain("regex_after_ai");
  });

  test("progressive escalation: regex then hosted enhancement", async () => {
    registry.register(new MockProvider({ id: "local_ai", tier: "local", priority: 10, available: false }));
    registry.register(new MockProvider({ id: "regex", tier: "local", priority: 20 }));
    registry.register(new MockProvider({ id: "hosted_llm", tier: "hosted", priority: 30 }));
    registry.register(new MockProvider({ id: "azure_pii", tier: "cloud", priority: 50 }));

    const result = await redactText("test input", {
      registry,
      piiTypes: [],
      settings: { detectionMode: "auto" },
    });

    // Regex handles local fallback, then hosted runs as enhancement pass
    expect(result.engine).toBe("hosted_llm");
    expect(result.escalated).toBe(true);
    expect(result.pipelineSteps).toContain("regex_fallback");
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
