const { ProviderRegistry, TIER_ORDER } = require("../lib/providers/provider-registry");
const { BaseProvider, PROVIDER_TIERS, PROVIDER_CAPABILITIES } = require("../lib/providers/base-provider");

class MockProvider extends BaseProvider {
  constructor(overrides = {}) {
    super({
      id: overrides.id || "mock",
      name: overrides.name || "Mock Provider",
      tier: overrides.tier || PROVIDER_TIERS.LOCAL,
      capabilities: overrides.capabilities || [PROVIDER_CAPABILITIES.TEXT],
      priority: overrides.priority ?? 50,
      enabled: overrides.enabled !== false,
      settings: overrides.settings || {},
    });
    this._available = overrides.available !== false;
    this._redactResult = overrides.redactResult || { redacted: "redacted", engine: this.id, matches: [] };
  }

  async checkAvailability() {
    return {
      available: this._available,
      status: this._available ? "readily" : "no",
      detail: this._available ? "Ready" : "Unavailable",
    };
  }

  async redactText(text, piiTypes, settings) {
    return { ...this._redactResult, redacted: text.replace(/test/g, "[REDACTED]") };
  }
}

describe("ProviderRegistry", () => {
  let registry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  test("register and retrieve a provider", () => {
    const provider = new MockProvider({ id: "test1" });
    registry.register(provider);
    expect(registry.get("test1")).toBe(provider);
  });

  test("getAll returns all registered providers", () => {
    registry.register(new MockProvider({ id: "a" }));
    registry.register(new MockProvider({ id: "b" }));
    expect(registry.getAll()).toHaveLength(2);
  });

  test("unregister removes provider", async () => {
    registry.register(new MockProvider({ id: "x" }));
    await registry.unregister("x");
    expect(registry.get("x")).toBeUndefined();
  });

  test("getForContentType filters and sorts correctly", () => {
    registry.register(new MockProvider({ id: "local", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "cloud", tier: "cloud", priority: 50 }));
    registry.register(new MockProvider({ id: "hosted", tier: "hosted", priority: 30 }));

    const sorted = registry.getForContentType("text");
    expect(sorted.map(p => p.id)).toEqual(["local", "hosted", "cloud"]);
  });

  test("disabled providers sort after enabled", () => {
    registry.register(new MockProvider({ id: "enabled", enabled: true, priority: 100 }));
    registry.register(new MockProvider({ id: "disabled", enabled: false, priority: 1 }));

    const sorted = registry.getForContentType("text");
    expect(sorted[0].id).toBe("enabled");
  });

  test("getByTier filters correctly", () => {
    registry.register(new MockProvider({ id: "l1", tier: "local" }));
    registry.register(new MockProvider({ id: "c1", tier: "cloud" }));
    registry.register(new MockProvider({ id: "l2", tier: "local" }));

    expect(registry.getByTier("local")).toHaveLength(2);
    expect(registry.getByTier("cloud")).toHaveLength(1);
    expect(registry.getByTier("hosted")).toHaveLength(0);
  });

  test("checkAvailability caches results", async () => {
    const provider = new MockProvider({ id: "cached" });
    registry.register(provider);

    const first = await registry.checkAvailability("cached");
    expect(first.available).toBe(true);

    // Even if we change the provider's internal state, cache returns old value
    provider._available = false;
    const second = await registry.checkAvailability("cached");
    expect(second.available).toBe(true); // still cached

    // Skip cache
    const third = await registry.checkAvailability("cached", true);
    expect(third.available).toBe(false);
  });

  test("checkAvailability returns unavailable for disabled provider", async () => {
    registry.register(new MockProvider({ id: "dis", enabled: false }));
    const result = await registry.checkAvailability("dis");
    expect(result.available).toBe(false);
    expect(result.status).toBe("disabled");
  });

  test("checkAvailability returns unavailable for unknown provider", async () => {
    const result = await registry.checkAvailability("nonexistent");
    expect(result.available).toBe(false);
  });

  test("findBestProvider returns local first", async () => {
    registry.register(new MockProvider({ id: "local", tier: "local", priority: 10 }));
    registry.register(new MockProvider({ id: "cloud", tier: "cloud", priority: 50 }));

    const best = await registry.findBestProvider("text");
    expect(best.id).toBe("local");
  });

  test("findBestProvider skips unavailable providers", async () => {
    registry.register(new MockProvider({ id: "bad", tier: "local", priority: 1, available: false }));
    registry.register(new MockProvider({ id: "good", tier: "cloud", priority: 50, available: true }));

    const best = await registry.findBestProvider("text");
    expect(best.id).toBe("good");
  });

  test("findBestProvider respects preferredTier", async () => {
    registry.register(new MockProvider({ id: "local", tier: "local", priority: 1 }));
    registry.register(new MockProvider({ id: "cloud", tier: "cloud", priority: 50 }));

    const best = await registry.findBestProvider("text", { preferredTier: "cloud" });
    expect(best.id).toBe("cloud");
  });

  test("findBestProvider with excludeProviders", async () => {
    registry.register(new MockProvider({ id: "a", tier: "local", priority: 1 }));
    registry.register(new MockProvider({ id: "b", tier: "local", priority: 2 }));

    const best = await registry.findBestProvider("text", { excludeProviders: ["a"] });
    expect(best.id).toBe("b");
  });

  test("findBestProvider returns null when nothing available", async () => {
    registry.register(new MockProvider({ id: "bad", available: false }));
    const best = await registry.findBestProvider("text");
    expect(best).toBeNull();
  });

  test("getStatusSummary includes all providers", async () => {
    registry.register(new MockProvider({ id: "p1", name: "Provider 1" }));
    registry.register(new MockProvider({ id: "p2", name: "Provider 2", enabled: false }));

    const summary = await registry.getStatusSummary();
    expect(summary).toHaveLength(2);
    expect(summary[0].available).toBe(true);
    expect(summary[1].available).toBe(false);
  });

  test("destroyAll clears all providers", async () => {
    registry.register(new MockProvider({ id: "a" }));
    registry.register(new MockProvider({ id: "b" }));
    await registry.destroyAll();
    expect(registry.getAll()).toHaveLength(0);
  });

  test("clearCache clears availability cache", async () => {
    registry.register(new MockProvider({ id: "c" }));
    await registry.checkAvailability("c");
    registry.clearCache();
    // After clear, the cache is empty — next check will re-query
    expect(registry._availabilityCache.size).toBe(0);
  });
});

describe("TIER_ORDER", () => {
  test("local < hosted < cloud", () => {
    expect(TIER_ORDER.local).toBeLessThan(TIER_ORDER.hosted);
    expect(TIER_ORDER.hosted).toBeLessThan(TIER_ORDER.cloud);
  });
});

describe("BaseProvider", () => {
  test("supports() checks capabilities", () => {
    const p = new MockProvider({ capabilities: ["text", "docx"] });
    expect(p.supports("text")).toBe(true);
    expect(p.supports("docx")).toBe(true);
    expect(p.supports("image")).toBe(false);
  });

  test("toJSON serialises correctly", () => {
    const p = new MockProvider({ id: "test", name: "Test", tier: "local" });
    const json = p.toJSON();
    expect(json.id).toBe("test");
    expect(json.name).toBe("Test");
    expect(json).not.toHaveProperty("settings");
    expect(json).not.toHaveProperty("_available");
  });
});
