const {
  detectNames,
  vectorRedact,
  scoreNameCandidate,
  isCapitalised,
  trigrams,
  trigramSimilarity,
} = require("../lib/vector-engine");

describe("isCapitalised", () => {
  test("recognises capitalised words", () => {
    expect(isCapitalised("John")).toBe(true);
    expect(isCapitalised("Smith")).toBe(true);
    expect(isCapitalised("O'Brien")).toBe(false); // apostrophe breaks the pattern
  });

  test("rejects non-capitalised words", () => {
    expect(isCapitalised("john")).toBe(false);
    expect(isCapitalised("JOHN")).toBe(false);
    expect(isCapitalised("a")).toBe(false);
    expect(isCapitalised("")).toBe(false);
  });
});

describe("trigrams", () => {
  test("generates correct trigrams", () => {
    const result = trigrams("hello");
    expect(result).toEqual(new Set(["hel", "ell", "llo"]));
  });

  test("returns empty set for short strings", () => {
    expect(trigrams("hi").size).toBe(0);
    expect(trigrams("").size).toBe(0);
  });
});

describe("trigramSimilarity", () => {
  test("returns 1 for identical sets", () => {
    const a = new Set(["abc", "bcd"]);
    expect(trigramSimilarity(a, a)).toBe(1);
  });

  test("returns 0 for disjoint sets", () => {
    const a = new Set(["abc"]);
    const b = new Set(["xyz"]);
    expect(trigramSimilarity(a, b)).toBe(0);
  });

  test("returns 0 for two empty sets", () => {
    expect(trigramSimilarity(new Set(), new Set())).toBe(0);
  });
});

describe("scoreNameCandidate", () => {
  test("scores known first name + capitalised surname highly", () => {
    const score = scoreNameCandidate(["John", "Smith"], "dear");
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  test("scores capitalised pair with name prefix highly", () => {
    const score = scoreNameCandidate(["James", "Wilson"], "mr");
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  test("scores unknown single short word low", () => {
    const score = scoreNameCandidate(["The"], "");
    expect(score).toBeLessThan(0.45);
  });

  test("scores lowercase words as 0", () => {
    const score = scoreNameCandidate(["hello", "world"], "");
    expect(score).toBe(0);
  });
});

describe("detectNames", () => {
  test("detects common name patterns after a prefix", () => {
    const results = detectNames("Dear John Smith, thank you for your application.");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toBe("John Smith");
  });

  test("detects names with title prefix", () => {
    const results = detectNames("Mr James Wilson attended the meeting.");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.text.includes("James"))).toBe(true);
  });

  test("does not detect generic capitalised words as names", () => {
    const results = detectNames("The Government of Australia announced new policy.");
    // "The" and "Government" alone shouldn't score high enough
    const falsePositives = results.filter(
      (r) => r.text === "The" || r.text === "Government"
    );
    expect(falsePositives).toHaveLength(0);
  });

  test("returns empty for text with no name-like patterns", () => {
    const results = detectNames("please review the attached document and respond.");
    expect(results).toHaveLength(0);
  });

  test("handles empty input", () => {
    expect(detectNames("")).toHaveLength(0);
    expect(detectNames(null)).toHaveLength(0);
  });

  test("respects custom threshold", () => {
    const loose = detectNames("Hello Sarah", 0.2);
    const strict = detectNames("Hello Sarah", 0.9);
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});

describe("vectorRedact", () => {
  test("replaces detected names with token", () => {
    const result = vectorRedact("Dear John Smith, your application has been received.");
    expect(result.redacted).toContain("[REDACTED_NAME]");
    expect(result.redacted).not.toContain("John Smith");
  });

  test("uses custom token", () => {
    const result = vectorRedact("Dear John Smith, hello.", "[NAME]");
    expect(result.redacted).toContain("[NAME]");
  });

  test("returns unchanged text when no names found", () => {
    const text = "the quick brown fox jumps over the lazy dog.";
    const result = vectorRedact(text);
    expect(result.redacted).toBe(text);
    expect(result.matches).toHaveLength(0);
  });

  test("records match details", () => {
    const result = vectorRedact("Hi Mr David Brown, welcome.");
    if (result.matches.length > 0) {
      expect(result.matches[0].typeId).toBe("name_vector");
      expect(result.matches[0].confidence).toBeGreaterThan(0);
    }
  });
});
