const {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  getMergedPiiTypes,
  deepMerge,
  mergeWithManaged,
  isSettingLocked,
  deletePath,
  sanitizeRemoteConfig,
  isSecureConfigurationUrl,
} = require("../lib/settings");
const { DEFAULT_PII_TYPES } = require("../lib/pii-types");

describe("DEFAULT_SETTINGS", () => {
  test("has expected default values", () => {
    expect(DEFAULT_SETTINGS.detectionMode).toBe("auto");
    expect(DEFAULT_SETTINGS.enableVectorFallback).toBe(true);
    expect(DEFAULT_SETTINGS.vectorThreshold).toBe(0.45);
    expect(DEFAULT_SETTINGS.showRedactButton).toBe(true);
    expect(DEFAULT_SETTINGS.sessionTimeoutMinutes).toBe(5);
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(7);
  });

  test("has site filter defaults", () => {
    expect(DEFAULT_SETTINGS.siteFilter).toBeDefined();
    expect(DEFAULT_SETTINGS.siteFilter.mode).toBe("all");
    expect(DEFAULT_SETTINGS.siteFilter.whitelist).toEqual([]);
    expect(DEFAULT_SETTINGS.siteFilter.blacklist).toEqual([]);
  });

  test("has AI chat guard defaults", () => {
    expect(DEFAULT_SETTINGS.aiChatGuard).toBeDefined();
    expect(DEFAULT_SETTINGS.aiChatGuard.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.aiChatGuard.autoRedactOnAiSites).toBe(true);
    expect(DEFAULT_SETTINGS.aiChatGuard.blockSubmitUntilRedacted).toBe(true);
  });

  test("has auto-redact defaults", () => {
    expect(DEFAULT_SETTINGS.autoRedact).toBeDefined();
    expect(DEFAULT_SETTINGS.autoRedact.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.autoRedact.onlyOnAiSites).toBe(true);
  });

  test("has submit guard defaults", () => {
    expect(DEFAULT_SETTINGS.submitGuard).toBeDefined();
    expect(DEFAULT_SETTINGS.submitGuard.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.submitGuard.interceptEnter).toBe(true);
  });

  test("has upload guard defaults", () => {
    expect(DEFAULT_SETTINGS.uploadGuard).toBeDefined();
    expect(DEFAULT_SETTINGS.uploadGuard.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.uploadGuard.confirmBeforeUpload).toBe(true);
    expect(DEFAULT_SETTINGS.uploadGuard.allowBypass).toBe(false);
    expect(DEFAULT_SETTINGS.uploadGuard.blockUnsupported).toBe(true);
  });

  test("customPiiTypes defaults to empty array", () => {
    expect(DEFAULT_SETTINGS.customPiiTypes).toEqual([]);
  });

  test("piiTypeOverrides defaults to empty object", () => {
    expect(DEFAULT_SETTINGS.piiTypeOverrides).toEqual({});
  });
});

describe("settings migration", () => {
  test("v7 removes obsolete remote Purview configuration and credentials", () => {
    const result = mergeWithManaged(DEFAULT_SETTINGS, {
      schemaVersion: 6,
      providers: {
        purview: {
          enabled: true,
          tenantId: "tenant",
          clientId: "client",
          checkViaApi: true,
          gateEnabled: true,
          blockedLabels: ["SECRET"],
        },
      },
    }, null, null);

    expect(result.schemaVersion).toBe(7);
    expect(result.providers.purview).toEqual({
      gateEnabled: true,
      blockedLabels: ["SECRET"],
      warnLabels: [],
      blockEncrypted: true,
    });
  });
});

describe("DEFAULT_STATS", () => {
  test("has zeroed counters", () => {
    expect(DEFAULT_STATS.totalRedactions).toBe(0);
    expect(DEFAULT_STATS.totalMatches).toBe(0);
    expect(DEFAULT_STATS.lastRedactionAt).toBeNull();
  });
});

describe("getMergedPiiTypes", () => {
  test("returns all default types when no overrides", () => {
    const merged = getMergedPiiTypes(DEFAULT_PII_TYPES, DEFAULT_SETTINGS);
    expect(merged.length).toBe(DEFAULT_PII_TYPES.length);
  });

  test("applies overrides to default types", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      piiTypeOverrides: {
        email: { enabled: false },
      },
    };
    const merged = getMergedPiiTypes(DEFAULT_PII_TYPES, settings);
    const email = merged.find((t) => t.id === "email");
    expect(email.enabled).toBe(false);
  });

  test("does not override the type ID", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      piiTypeOverrides: {
        email: { id: "hacked", enabled: false },
      },
    };
    const merged = getMergedPiiTypes(DEFAULT_PII_TYPES, settings);
    const email = merged.find((t) => t.id === "email");
    expect(email.id).toBe("email");
  });

  test("appends custom types", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      customPiiTypes: [
        {
          id: "custom_test",
          name: "Test",
          token: "[REDACTED_TEST]",
          regex: "TEST-\\d+",
          flags: "g",
          enabled: true,
        },
      ],
    };
    const merged = getMergedPiiTypes(DEFAULT_PII_TYPES, settings);
    expect(merged.length).toBe(DEFAULT_PII_TYPES.length + 1);
    expect(merged.find((t) => t.id === "custom_test")).toBeDefined();
  });

  test("does not duplicate custom types with clashing IDs", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      customPiiTypes: [
        { id: "email", name: "Duplicate", token: "[DUP]", enabled: true },
      ],
    };
    const merged = getMergedPiiTypes(DEFAULT_PII_TYPES, settings);
    // Should not add a second "email" entry.
    const emails = merged.filter((t) => t.id === "email");
    expect(emails.length).toBe(1);
  });

  test("assigns 'custom' category to custom types without one", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      customPiiTypes: [
        { id: "custom_x", name: "X", token: "[X]", enabled: true },
      ],
    };
    const merged = getMergedPiiTypes(DEFAULT_PII_TYPES, settings);
    const x = merged.find((t) => t.id === "custom_x");
    expect(x.category).toBe("custom");
  });
});

// ── Deep Merge ──────────────────────────────────────────────────────────────

describe("deepMerge", () => {
  test("merges flat objects", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  test("deep merges nested objects", () => {
    const result = deepMerge(
      { x: { a: 1, b: 2 } },
      { x: { b: 3, c: 4 } }
    );
    expect(result).toEqual({ x: { a: 1, b: 3, c: 4 } });
  });

  test("replaces arrays (does not concatenate)", () => {
    const result = deepMerge({ arr: [1, 2] }, { arr: [3] });
    expect(result).toEqual({ arr: [3] });
  });

  test("does not mutate inputs", () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    deepMerge(target, source);
    expect(target).toEqual({ a: { b: 1 } });
    expect(source).toEqual({ a: { c: 2 } });
  });

  test("rejects prototype-pollution keys from JSON settings", () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const result = deepMerge({}, payload);
    expect(result.safe).toBe(1);
    expect(result).not.toHaveProperty("__proto__.polluted");
    expect({}.polluted).toBeUndefined();
  });
});

describe("remote configuration trust boundary", () => {
  test("strips providers, network destinations and debug mode", () => {
    const result = sanitizeRemoteConfig({
      detectionMode: "regex_only",
      providers: { hosted: [{ endpoint: "https://attacker.example" }] },
      configUrl: "https://attacker.example/config.json",
      debugMode: true,
      _policyVersion: 4,
    });
    expect(result.detectionMode).toBe("regex_only");
    expect(result._policyVersion).toBe(4);
    expect(result.providers).toBeUndefined();
    expect(result.configUrl).toBeUndefined();
    expect(result.debugMode).toBeUndefined();
  });

  test("cannot remotely enable unsafe upload bypasses or oversized files", () => {
    const result = sanitizeRemoteConfig({
      uploadGuard: {
        allowBypass: true,
        blockUnsupported: false,
        maxFileSizeBytes: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(result.uploadGuard.allowBypass).toBe(false);
    expect(result.uploadGuard.blockUnsupported).toBe(true);
    expect(result.uploadGuard.maxFileSizeBytes).toBe(25 * 1024 * 1024);
  });

  test("sanitizes remote lock maps", () => {
    const result = sanitizeRemoteConfig({
      _locked: {
        "submitGuard.enabled": true,
        "__proto__.polluted": true,
        "uploadGuard.enabled": "yes",
      },
    });
    expect(result._locked).toEqual({ "submitGuard.enabled": true });
    expect({}.polluted).toBeUndefined();
  });

  test("requires HTTPS except for loopback development", () => {
    expect(isSecureConfigurationUrl("https://config.example/policy.json")).toBe(true);
    expect(isSecureConfigurationUrl("http://localhost:8080/policy.json")).toBe(true);
    expect(isSecureConfigurationUrl("http://config.example/policy.json")).toBe(false);
    expect(isSecureConfigurationUrl("https://user:pass@config.example/policy.json")).toBe(false);
  });
});

// ── mergeWithManaged ────────────────────────────────────────────────────────

describe("mergeWithManaged", () => {
  test("returns defaults when no local, managed, or remote", () => {
    const result = mergeWithManaged(DEFAULT_SETTINGS, {}, null, null);
    expect(result.detectionMode).toBe("auto");
    expect(result._meta.isManaged).toBe(false);
    expect(result._meta.isRemoteConfig).toBe(false);
  });

  test("local settings override defaults", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS,
      { detectionMode: "regex_only" },
      null, null
    );
    expect(result.detectionMode).toBe("regex_only");
  });

  test("managed settings override local and defaults", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS,
      { detectionMode: "regex_only" },
      { detectionMode: "cloud_only", _policyVersion: 5 },
      null
    );
    expect(result.detectionMode).toBe("cloud_only");
    expect(result._meta.isManaged).toBe(true);
    expect(result._meta.policyVersion).toBe(5);
  });

  test("remote config overrides local but not managed", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS,
      { detectionMode: "regex_only" },
      { detectionMode: "cloud_only" },
      { detectionMode: "ai_only" }
    );
    // Managed wins over remote
    expect(result.detectionMode).toBe("cloud_only");
  });

  test("remote config applies when no managed", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS,
      { detectionMode: "regex_only" },
      null,
      { detectionMode: "ai_only", _policyVersion: 2 }
    );
    expect(result.detectionMode).toBe("ai_only");
    expect(result._meta.isRemoteConfig).toBe(true);
    expect(result._meta.policyVersion).toBe(2);
  });

  test("_locked map is extracted from managed", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS, {},
      { _locked: { detectionMode: true, "aiChatGuard.enabled": true } },
      null
    );
    expect(result._meta.locked.detectionMode).toBe(true);
    expect(result._meta.locked["aiChatGuard.enabled"]).toBe(true);
  });

  test("_locked maps merge from both remote and managed", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS, {},
      { _locked: { detectionMode: true } },
      { _locked: { "submitGuard.enabled": true } }
    );
    expect(result._meta.locked.detectionMode).toBe(true);
    expect(result._meta.locked["submitGuard.enabled"]).toBe(true);
  });

  test("deep merges nested provider settings", () => {
    const result = mergeWithManaged(
      DEFAULT_SETTINGS, {},
      {
        providers: {
          azure_pii: {
            enabled: true,
            endpoint: "https://managed.example.com",
          },
        },
      },
      null
    );
    expect(result.providers.azure_pii.enabled).toBe(true);
    expect(result.providers.azure_pii.endpoint).toBe("https://managed.example.com");
    // Default values preserved
    expect(result.providers.azure_pii.language).toBe("en");
  });
});

// ── isSettingLocked ─────────────────────────────────────────────────────────

describe("isSettingLocked", () => {
  test("returns false when no locked map", () => {
    expect(isSettingLocked({}, "detectionMode")).toBe(false);
    expect(isSettingLocked(null, "detectionMode")).toBe(false);
  });

  test("exact path match", () => {
    const meta = { locked: { detectionMode: true } };
    expect(isSettingLocked(meta, "detectionMode")).toBe(true);
    expect(isSettingLocked(meta, "showRedactButton")).toBe(false);
  });

  test("parent path locks children", () => {
    const meta = { locked: { aiChatGuard: true } };
    expect(isSettingLocked(meta, "aiChatGuard")).toBe(true);
    expect(isSettingLocked(meta, "aiChatGuard.enabled")).toBe(true);
    expect(isSettingLocked(meta, "aiChatGuard.showAiBanner")).toBe(true);
    expect(isSettingLocked(meta, "submitGuard.enabled")).toBe(false);
  });

  test("child lock does not lock parent", () => {
    const meta = { locked: { "aiChatGuard.enabled": true } };
    expect(isSettingLocked(meta, "aiChatGuard.enabled")).toBe(true);
    expect(isSettingLocked(meta, "aiChatGuard")).toBe(false);
    expect(isSettingLocked(meta, "aiChatGuard.showAiBanner")).toBe(false);
  });

  test("deep nested path", () => {
    const meta = { locked: { providers: true } };
    expect(isSettingLocked(meta, "providers.azure_pii.endpoint")).toBe(true);
    expect(isSettingLocked(meta, "providers.local_ai")).toBe(true);
  });
});

// ── deletePath ──────────────────────────────────────────────────────────────

describe("deletePath", () => {
  test("deletes top-level key", () => {
    const obj = { a: 1, b: 2 };
    deletePath(obj, "a");
    expect(obj).toEqual({ b: 2 });
  });

  test("deletes nested key", () => {
    const obj = { x: { y: { z: 1 }, w: 2 } };
    deletePath(obj, "x.y.z");
    expect(obj.x.y).toEqual({});
    expect(obj.x.w).toBe(2);
  });

  test("no-op for non-existent path", () => {
    const obj = { a: 1 };
    deletePath(obj, "b.c.d");
    expect(obj).toEqual({ a: 1 });
  });
});
