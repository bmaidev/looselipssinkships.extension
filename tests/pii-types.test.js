const {
  DEFAULT_PII_TYPES,
  PII_CATEGORIES,
  validatePiiType,
  generatePiiTypeId,
} = require("../lib/pii-types");

describe("DEFAULT_PII_TYPES", () => {
  test("contains at least 10 default types", () => {
    expect(DEFAULT_PII_TYPES.length).toBeGreaterThanOrEqual(10);
  });

  test("every type has required fields", () => {
    for (const type of DEFAULT_PII_TYPES) {
      expect(type.id).toBeDefined();
      expect(typeof type.id).toBe("string");
      expect(type.name).toBeDefined();
      expect(type.token).toMatch(/^\[.+\]$/);
      expect(type.regex).toBeDefined();
      expect(type.category).toBeDefined();
    }
  });

  test("every regex is valid", () => {
    for (const type of DEFAULT_PII_TYPES) {
      expect(() => {
        new RegExp(type.regex, type.flags || "g");
      }).not.toThrow();
    }
  });

  test("all IDs are unique", () => {
    const ids = DEFAULT_PII_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all categories are defined in PII_CATEGORIES", () => {
    for (const type of DEFAULT_PII_TYPES) {
      expect(PII_CATEGORIES[type.category]).toBeDefined();
    }
  });

  test("includes Australian-specific types", () => {
    const ids = DEFAULT_PII_TYPES.map((t) => t.id);
    expect(ids).toContain("tfn");
    expect(ids).toContain("abn");
    expect(ids).toContain("medicare");
    expect(ids).toContain("phone_au");
    expect(ids).toContain("postcode_au");
  });
});

describe("PII_CATEGORIES", () => {
  test("contains expected categories", () => {
    expect(PII_CATEGORIES.contact).toBeDefined();
    expect(PII_CATEGORIES.financial).toBeDefined();
    expect(PII_CATEGORIES.identity).toBeDefined();
    expect(PII_CATEGORIES.custom).toBeDefined();
  });

  test("each category has a name and order", () => {
    for (const [, cat] of Object.entries(PII_CATEGORIES)) {
      expect(cat.name).toBeDefined();
      expect(typeof cat.order).toBe("number");
    }
  });
});

describe("validatePiiType", () => {
  test("accepts a valid PII type", () => {
    const result = validatePiiType({
      id: "test",
      name: "Test Type",
      token: "[REDACTED_TEST]",
      regex: "\\d+",
      flags: "g",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects missing ID", () => {
    const result = validatePiiType({
      name: "Test",
      token: "[REDACTED_TEST]",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("rejects missing name", () => {
    const result = validatePiiType({
      id: "test",
      token: "[REDACTED_TEST]",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects token without brackets", () => {
    const result = validatePiiType({
      id: "test",
      name: "Test",
      token: "REDACTED_TEST",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects invalid regex", () => {
    const result = validatePiiType({
      id: "test",
      name: "Test",
      token: "[REDACTED_TEST]",
      regex: "[invalid",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("regex"))).toBe(true);
  });

  test("accepts type without regex (AI-only detection)", () => {
    const result = validatePiiType({
      id: "test",
      name: "Test",
      token: "[REDACTED_TEST]",
    });
    expect(result.valid).toBe(true);
  });
});

describe("generatePiiTypeId", () => {
  test("generates a clean ID from a name", () => {
    expect(generatePiiTypeId("Student ID")).toBe("custom_student_id");
  });

  test("handles special characters", () => {
    expect(generatePiiTypeId("Medicare (AU)")).toBe("custom_medicare_au");
  });

  test("trims trailing underscores", () => {
    expect(generatePiiTypeId("Test!!!")).toBe("custom_test");
  });
});
