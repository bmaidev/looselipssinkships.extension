const {
  buildEntitySchema,
  buildEntitySystemPrompt,
  parseEntityResponse,
  applyEntityMatches,
  chunkTextForAi,
  correctPosition,
  mapEntityType,
  buildTypeMap,
  deduplicateMatches,
} = require("../lib/ai-entity-parser");

// Sample PII types for testing
const samplePiiTypes = [
  { id: "email", name: "Email Address", token: "[REDACTED_EMAIL]", enabled: true },
  { id: "phone_au", name: "Phone Number (AU)", token: "[REDACTED_PHONE]", enabled: true },
  { id: "tfn", name: "Tax File Number", token: "[REDACTED_TFN]", enabled: true },
  { id: "name", name: "Person Name", token: "[REDACTED_NAME]", enabled: true },
  { id: "disabled_type", name: "Disabled", token: "[X]", enabled: false },
];

// ── buildEntitySchema ───────────────────────────────────────────────────────

describe("buildEntitySchema", () => {
  test("returns valid JSON Schema object", () => {
    const schema = buildEntitySchema();
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("entities");
    expect(schema.properties.entities.type).toBe("array");
  });

  test("entity items have required fields", () => {
    const schema = buildEntitySchema();
    const item = schema.properties.entities.items;
    expect(item.required).toEqual(expect.arrayContaining(["text", "type", "start", "end"]));
    expect(item.properties.text.type).toBe("string");
    expect(item.properties.start.type).toBe("integer");
  });
});

// ── buildEntitySystemPrompt ─────────────────────────────────────────────────

describe("buildEntitySystemPrompt", () => {
  test("includes enabled PII type names", () => {
    const prompt = buildEntitySystemPrompt(samplePiiTypes);
    expect(prompt).toContain("Email Address");
    expect(prompt).toContain("Phone Number (AU)");
    expect(prompt).toContain("Tax File Number");
  });

  test("excludes disabled PII types", () => {
    const prompt = buildEntitySystemPrompt(samplePiiTypes);
    expect(prompt).not.toContain("Disabled");
  });

  test("instructs JSON-only output", () => {
    const prompt = buildEntitySystemPrompt(samplePiiTypes);
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("entities");
    expect(prompt).toContain("Do NOT");
  });

  test("handles empty piiTypes", () => {
    const prompt = buildEntitySystemPrompt([]);
    expect(prompt).toContain("entities");
  });
});

// ── parseEntityResponse ─────────────────────────────────────────────────────

describe("parseEntityResponse", () => {
  const inputText = "Contact john@test.com or call 0412345678 for help.";

  test("parses valid JSON with correct positions", () => {
    const json = JSON.stringify({
      entities: [
        { text: "john@test.com", type: "Email Address", start: 8, end: 21 },
        { text: "0412345678", type: "Phone Number (AU)", start: 30, end: 40 },
      ],
    });
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.valid).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].typeId).toBe("email");
    expect(result.matches[0].token).toBe("[REDACTED_EMAIL]");
    expect(result.matches[0].original).toBe("john@test.com");
    expect(result.matches[0].index).toBe(8);
    expect(result.matches[1].typeId).toBe("phone_au");
    expect(result.matches[1].index).toBe(30);
  });

  test("corrects wrong positions via indexOf", () => {
    const json = JSON.stringify({
      entities: [
        { text: "john@test.com", type: "Email Address", start: 0, end: 13 }, // wrong position
      ],
    });
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.valid).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].index).toBe(8); // corrected to actual position
    expect(result.matches[0].original).toBe("john@test.com");
  });

  test("unlocatable entities never become a valid clean result", () => {
    const json = JSON.stringify({
      entities: [
        { text: "nonexistent@fake.com", type: "Email Address", start: 0, end: 20 },
      ],
    });
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.valid).toBe(false);
    expect(result.invalidEntityCount).toBe(1);
    expect(result.matches).toHaveLength(0);
  });

  test("handles empty entities array", () => {
    const json = JSON.stringify({ entities: [] });
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.valid).toBe(true);
    expect(result.matches).toHaveLength(0);
  });

  test("returns invalid for malformed JSON", () => {
    const result = parseEntityResponse("not json", inputText, samplePiiTypes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("JSON parse failed");
  });

  test("returns invalid for missing entities array", () => {
    const result = parseEntityResponse('{"data":[]}', inputText, samplePiiTypes);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("missing");
  });

  test("handles JSON wrapped in markdown code blocks", () => {
    const json = '```json\n{"entities":[{"text":"john@test.com","type":"Email Address","start":8,"end":21}]}\n```';
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.valid).toBe(true);
    expect(result.matches).toHaveLength(1);
  });

  test("partial entity validation is explicitly incomplete", () => {
    const json = JSON.stringify({
      entities: [
        { text: "john@test.com", type: "Email Address", start: 8, end: 21 },
        { text: null, type: "Bad", start: 0, end: 5 }, // null text
        { text: "x", type: "Bad", start: -1, end: 0 }, // negative start
      ],
    });
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.valid).toBe(false);
    expect(result.invalidEntityCount).toBe(2);
    expect(result.matches).toHaveLength(1);
  });

  test("maps unknown types to fallback tokens", () => {
    const json = JSON.stringify({
      entities: [
        { text: "john@test.com", type: "Unusual Category", start: 8, end: 21 },
      ],
    });
    const result = parseEntityResponse(json, inputText, samplePiiTypes);
    expect(result.matches[0].token).toContain("REDACTED_");
  });

  test('rejects null, fractional, missing-type and excessive entities without quoting content', () => {
    const invalid = [null, { text: 'john@test.com', type: 'Email', start: .5, end: 21 },
      { text: 'john@test.com', type: null, start: 8, end: 21 }];
    const parsed = parseEntityResponse(JSON.stringify({ entities: invalid }), inputText, samplePiiTypes);
    expect(parsed.valid).toBe(false);
    expect(parsed.invalidEntityCount).toBe(3);
    expect(parseEntityResponse(JSON.stringify({ entities: Array(10001).fill(null) }), inputText, []).valid).toBe(false);
    expect(parseEntityResponse('x'.repeat(2000001), inputText, []).valid).toBe(false);
    const result = parseEntityResponse('PRIVATE_SECRET_not_json', inputText, []);
    expect(result.error).not.toContain('PRIVATE_SECRET');
  });

  test('model type names cannot resolve inherited prototype properties', () => {
    const result = parseEntityResponse(JSON.stringify({ entities: [
      { text: 'john@test.com', type: 'constructor', start: 8, end: 21 },
    ] }), inputText, samplePiiTypes);
    expect(result.valid).toBe(true);
    expect(result.matches[0].token).toBe('[REDACTED_CONSTRUCTOR]');
  });
});

// ── correctPosition ─────────────────────────────────────────────────────────

describe("correctPosition", () => {
  test("returns null when text not found", () => {
    expect(correctPosition("xyz", 0, "abc def")).toBeNull();
  });

  test("returns index for single occurrence", () => {
    expect(correctPosition("def", 0, "abc def ghi")).toBe(4);
  });

  test("returns closest occurrence for multiple matches", () => {
    const text = "foo bar foo baz foo";
    expect(correctPosition("foo", 9, text)).toBe(8); // closest to 9
    expect(correctPosition("foo", 0, text)).toBe(0); // closest to 0
    expect(correctPosition("foo", 20, text)).toBe(16); // closest to 20
  });
});

// ── mapEntityType ───────────────────────────────────────────────────────────

describe("mapEntityType", () => {
  const typeMap = buildTypeMap(samplePiiTypes);

  test("exact match", () => {
    const result = mapEntityType("Email Address", typeMap);
    expect(result.typeId).toBe("email");
    expect(result.token).toBe("[REDACTED_EMAIL]");
  });

  test("matches without parenthetical", () => {
    const result = mapEntityType("Phone Number", typeMap);
    expect(result.typeId).toBe("phone_au");
  });

  test("case insensitive", () => {
    const result = mapEntityType("email address", typeMap);
    expect(result.typeId).toBe("email");
  });

  test("partial match", () => {
    const result = mapEntityType("Tax File", typeMap);
    expect(result.typeId).toBe("tfn");
  });

  test("returns fallback for unknown type", () => {
    const result = mapEntityType("Unknown Category", typeMap);
    expect(result.typeId).toContain("ai_");
    expect(result.token).toContain("REDACTED_");
  });

  test("handles null type", () => {
    const result = mapEntityType(null, typeMap);
    expect(result.typeId).toBe("ai_detected");
  });
});

// ── applyEntityMatches ──────────────────────────────────────────────────────

describe("applyEntityMatches", () => {
  test("replaces entities in correct positions", () => {
    const text = "Email john@test.com here";
    const matches = [
      { typeId: "email", token: "[REDACTED_EMAIL]", original: "john@test.com", index: 6 },
    ];
    const result = applyEntityMatches(text, matches);
    expect(result.redacted).toBe("Email [REDACTED_EMAIL] here");
  });

  test("handles multiple non-overlapping matches", () => {
    const text = "Call 0412345678 or email john@test.com";
    const emailIdx = text.indexOf("john@test.com");
    const matches = [
      { typeId: "phone", token: "[PHONE]", original: "0412345678", index: 5 },
      { typeId: "email", token: "[EMAIL]", original: "john@test.com", index: emailIdx },
    ];
    const result = applyEntityMatches(text, matches);
    expect(result.redacted).toBe("Call [PHONE] or email [EMAIL]");
  });

  test("deduplicates overlapping matches", () => {
    const text = "John Smith is here";
    const matches = [
      { typeId: "name", token: "[NAME]", original: "John Smith", index: 0 },
      { typeId: "name", token: "[NAME2]", original: "Smith", index: 5 }, // overlaps
    ];
    const result = applyEntityMatches(text, matches);
    expect(result.redacted).toBe("[NAME] is here");
    expect(result.matches).toHaveLength(1);
  });

  test("returns original text with empty matches", () => {
    const result = applyEntityMatches("hello", []);
    expect(result.redacted).toBe("hello");
  });
});

// ── deduplicateMatches ──────────────────────────────────────────────────────

describe("deduplicateMatches", () => {
  test("removes overlapping matches", () => {
    const matches = [
      { index: 0, original: "John Smith" },
      { index: 5, original: "Smith Jones" }, // overlaps
      { index: 20, original: "test" },
    ];
    const result = deduplicateMatches(matches, 'John Smith Jones    test');
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(20);
  });

  test("keeps non-overlapping matches", () => {
    const matches = [
      { index: 0, original: "abc" },
      { index: 5, original: "def" },
      { index: 10, original: "ghi" },
    ];
    expect(deduplicateMatches(matches, 'abc  def  ghi')).toHaveLength(3);
  });
});

// ── chunkTextForAi ──────────────────────────────────────────────────────────

describe("chunkTextForAi", () => {
  test("returns single chunk for short text", () => {
    const chunks = chunkTextForAi("Hello world", 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk).toBe("Hello world");
    expect(chunks[0].offset).toBe(0);
  });

  test("splits at sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const chunks = chunkTextForAi(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should start at the right offset
    for (const chunk of chunks) {
      expect(text.substring(chunk.offset, chunk.offset + chunk.chunk.length)).toBe(chunk.chunk);
    }
  });

  test("handles text with no sentence boundaries", () => {
    const text = "a".repeat(100);
    const chunks = chunkTextForAi(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // Concatenated chunks should equal original
    const reconstructed = chunks.map(c => c.chunk).join("");
    expect(reconstructed).toBe(text);
  });

  test("offsets are correct for entity position adjustment", () => {
    const text = "Email: john@test.com. Phone: 0412345678.";
    const chunks = chunkTextForAi(text, 25);
    for (const chunk of chunks) {
      expect(text.substring(chunk.offset, chunk.offset + chunk.chunk.length)).toBe(chunk.chunk);
    }
  });

  test("handles empty text", () => {
    const chunks = chunkTextForAi("", 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk).toBe("");
  });
});
