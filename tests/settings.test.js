const {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  getMergedPiiTypes,
} = require("../lib/settings");
const { DEFAULT_PII_TYPES } = require("../lib/pii-types");

describe("DEFAULT_SETTINGS", () => {
  test("has expected default values", () => {
    expect(DEFAULT_SETTINGS.detectionMode).toBe("auto");
    expect(DEFAULT_SETTINGS.enableVectorFallback).toBe(true);
    expect(DEFAULT_SETTINGS.vectorThreshold).toBe(0.45);
    expect(DEFAULT_SETTINGS.showRedactButton).toBe(true);
    expect(DEFAULT_SETTINGS.sessionTimeoutMinutes).toBe(5);
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(3);
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
  });

  test("customPiiTypes defaults to empty array", () => {
    expect(DEFAULT_SETTINGS.customPiiTypes).toEqual([]);
  });

  test("piiTypeOverrides defaults to empty object", () => {
    expect(DEFAULT_SETTINGS.piiTypeOverrides).toEqual({});
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
