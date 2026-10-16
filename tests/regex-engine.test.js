const { regexRedact, testRegexPattern } = require("../lib/regex-engine");
const { DEFAULT_PII_TYPES } = require("../lib/pii-types");

describe("regexRedact", () => {
  const allTypes = DEFAULT_PII_TYPES;

  test("returns unchanged text when no PII present", () => {
    const result = regexRedact("Hello world, this is a test.", allTypes);
    expect(result.redacted).toBe("Hello world, this is a test.");
    expect(result.matches).toHaveLength(0);
  });

  test("returns empty string for empty input", () => {
    const result = regexRedact("", allTypes);
    expect(result.redacted).toBe("");
    expect(result.matches).toHaveLength(0);
  });

  test("handles null input gracefully", () => {
    const result = regexRedact(null, allTypes);
    expect(result.redacted).toBe("");
  });

  // ── Email ──────────────────────────────────────────────────────────────

  test("redacts email addresses", () => {
    const result = regexRedact("Contact me at john.doe@example.com for details.", allTypes);
    expect(result.redacted).toContain("[REDACTED_EMAIL]");
    expect(result.redacted).not.toContain("john.doe@example.com");
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].typeId).toBe("email");
  });

  test("redacts multiple emails", () => {
    const text = "Email alice@test.com or bob@company.org";
    const result = regexRedact(text, allTypes);
    expect(result.redacted).toBe("Email [REDACTED_EMAIL] or [REDACTED_EMAIL]");
  });

  // ── Phone numbers ─────────────────────────────────────────────────────

  test("redacts Australian mobile numbers", () => {
    const result = regexRedact("Call me on 0412 345 678.", allTypes);
    expect(result.redacted).toContain("[REDACTED_PHONE]");
    expect(result.redacted).not.toContain("0412 345 678");
  });

  test("redacts AU landline numbers", () => {
    const result = regexRedact("Office: (02) 9876 5432", allTypes);
    expect(result.redacted).toContain("[REDACTED_PHONE]");
    expect(result.redacted).not.toContain("9876 5432");
  });

  test("redacts +61 format numbers", () => {
    const result = regexRedact("Reach us at +61 2 9876 5432", allTypes);
    expect(result.redacted).toContain("[REDACTED_PHONE]");
  });

  test("redacts international phone numbers", () => {
    const result = regexRedact("US office: +1 555 123 4567", allTypes);
    expect(result.redacted).toContain("[REDACTED_PHONE]");
  });

  // ── Financial data ────────────────────────────────────────────────────

  test("redacts credit card numbers (Visa)", () => {
    const result = regexRedact("Card: 4111 1111 1111 1111", allTypes);
    expect(result.redacted).toContain("[REDACTED_CARD]");
    expect(result.redacted).not.toContain("4111");
  });

  test("redacts credit card numbers (Mastercard)", () => {
    const result = regexRedact("MC: 5500-0000-0000-0004", allTypes);
    expect(result.redacted).toContain("[REDACTED_CARD]");
  });

  test("redacts BSB numbers with keyword", () => {
    const result = regexRedact("BSB: 062-000", allTypes);
    expect(result.redacted).toContain("[REDACTED_BSB]");
  });

  test("redacts bank account numbers with keyword", () => {
    const result = regexRedact("Account: 12345678", allTypes);
    expect(result.redacted).toContain("[REDACTED_ACCOUNT]");
  });

  test("redacts ACN with keyword", () => {
    const result = regexRedact("ACN: 123 456 789", allTypes);
    expect(result.redacted).toContain("[REDACTED_ACN]");
  });

  // ── Identity documents ────────────────────────────────────────────────

  test("redacts passport numbers with keyword", () => {
    const result = regexRedact("Passport: N1234567", allTypes);
    expect(result.redacted).toContain("[REDACTED_PASSPORT]");
  });

  test("redacts driver licence with keyword", () => {
    const result = regexRedact("Licence: 12345678", allTypes);
    expect(result.redacted).toContain("[REDACTED_LICENCE]");
  });

  test("redacts date of birth with keyword", () => {
    const result = regexRedact("DOB: 15/03/1990", allTypes);
    expect(result.redacted).toContain("[REDACTED_DOB]");
    expect(result.redacted).not.toContain("15/03/1990");
  });

  // ── Addresses ─────────────────────────────────────────────────────────

  test("redacts Australian street addresses", () => {
    const result = regexRedact("Lives at 42 Smith Street", allTypes);
    expect(result.redacted).toContain("[REDACTED_ADDRESS]");
  });

  test("redacts state + postcode", () => {
    const result = regexRedact("Located in NSW 2000", allTypes);
    expect(result.redacted).toContain("[REDACTED_POSTCODE]");
  });

  // ── IP addresses ──────────────────────────────────────────────────────

  test("redacts IPv4 addresses", () => {
    const result = regexRedact("Server IP: 192.168.1.1", allTypes);
    expect(result.redacted).toContain("[REDACTED_IP]");
    expect(result.redacted).not.toContain("192.168.1.1");
  });

  // ── Multiple PII in one text ──────────────────────────────────────────

  test("redacts multiple PII types in a single text", () => {
    const text = "John's email is john@test.com and phone is 0412 345 678. DOB: 01/01/1990";
    const result = regexRedact(text, allTypes);
    expect(result.redacted).toContain("[REDACTED_EMAIL]");
    expect(result.redacted).toContain("[REDACTED_PHONE]");
    expect(result.redacted).toContain("[REDACTED_DOB]");
    expect(result.matches.length).toBeGreaterThanOrEqual(3);
  });

  // ── Disabled types ────────────────────────────────────────────────────

  test("skips disabled PII types", () => {
    const types = allTypes.map((t) =>
      t.id === "email" ? { ...t, enabled: false } : t
    );
    const result = regexRedact("Email: test@example.com", types);
    expect(result.redacted).toContain("test@example.com");
  });

  // ── Custom types ──────────────────────────────────────────────────────

  test("supports custom PII types", () => {
    const custom = [
      {
        id: "custom_student",
        name: "Student ID",
        token: "[REDACTED_STUDENT]",
        enabled: true,
        regex: "STU-\\d{6}",
        flags: "g",
      },
    ];
    const result = regexRedact("Student STU-123456 enrolled.", custom);
    expect(result.redacted).toBe("Student [REDACTED_STUDENT] enrolled.");
  });

  test("fails closed instead of silently truncating excessive matches", () => {
    const custom = [{
      id: "custom_dense", category: "custom", token: "[DENSE]",
      enabled: true, regex: "a", flags: "g",
    }];
    expect(() => regexRedact("a".repeat(10_001), custom)).toThrow(/match safety limit/);
  });

  test("adds global matching when a custom rule omits the g flag", () => {
    const custom = [{
      id: "custom_student", category: "custom", token: "[STUDENT]",
      enabled: true, regex: "STU-\\d{2}", flags: "i",
    }];
    const result = regexRedact("STU-12 and stu-34", custom);
    expect(result.redacted).toBe("[STUDENT] and [STUDENT]");
  });

  // ── Overlapping matches ───────────────────────────────────────────────

  test("does not double-redact overlapping patterns", () => {
    // A phone number that could also match a TFN-like pattern.
    const text = "Call 0412 345 678";
    const result = regexRedact(text, allTypes);
    // Should only be redacted once.
    const tokenCount = (result.redacted.match(/\[REDACTED_/g) || []).length;
    expect(tokenCount).toBe(1);
  });
});

describe("testRegexPattern", () => {
  test("returns matches for valid pattern", () => {
    const result = testRegexPattern("\\d+", "g", "abc 123 def 456");
    expect(result.valid).toBe(true);
    expect(result.matches).toEqual(["123", "456"]);
  });

  test("returns error for invalid pattern", () => {
    const result = testRegexPattern("[invalid", "g", "test");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("returns empty matches when no match found", () => {
    const result = testRegexPattern("xyz", "g", "abc def");
    expect(result.valid).toBe(true);
    expect(result.matches).toEqual([]);
  });

  test("rejects a nested-quantifier pattern", () => {
    const result = testRegexPattern("(a+)+$", "g", "aaaaaaaaaaaaaaaa!");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/safety limits/);
  });

  test("rejects ambiguous repeated alternation", () => {
    const result = testRegexPattern("(a|aa)+$", "g", "aaaaaaaaaaaaaaaa!");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/safety limits/);
  });
});
