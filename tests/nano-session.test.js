require("../lib/nano-session");

const NanoSession = globalThis.LLSS_NanoSession;

describe("NanoSession", () => {
  // ── isAvailable ────────────────────────────────────────────────────────

  describe("isAvailable", () => {
    test("returns false when LanguageModel is undefined", () => {
      // LanguageModel is not defined in the test environment
      expect(NanoSession.isAvailable()).toBe(false);
    });

    test("returns true when LanguageModel is defined", () => {
      globalThis.LanguageModel = {
        availability: jest.fn(),
        create: jest.fn(),
      };
      try {
        expect(NanoSession.isAvailable()).toBe(true);
      } finally {
        delete globalThis.LanguageModel;
      }
    });
  });

  // ── _buildSystemPrompt ─────────────────────────────────────────────────

  describe("_buildSystemPrompt", () => {
    let session;

    beforeEach(() => {
      session = new NanoSession();
    });

    afterEach(() => {
      session.destroy();
    });

    test("includes PII type rules for enabled types", () => {
      const piiTypes = [
        { id: "email", name: "Email", token: "[REDACTED_EMAIL]", enabled: true },
        { id: "phone", name: "Phone", token: "[REDACTED_PHONE]", enabled: true },
      ];
      const prompt = session._buildSystemPrompt(piiTypes);
      expect(prompt).toContain("- Email");
      expect(prompt).toContain("[REDACTED_EMAIL]");
      expect(prompt).toContain("- Phone");
      expect(prompt).toContain("[REDACTED_PHONE]");
    });

    test("excludes disabled PII types from rules", () => {
      const piiTypes = [
        { id: "email", name: "Email", token: "[REDACTED_EMAIL]", enabled: true },
        { id: "phone", name: "Phone", token: "[REDACTED_PHONE]", enabled: false },
      ];
      const prompt = session._buildSystemPrompt(piiTypes);
      expect(prompt).toContain("- Email");
      expect(prompt).not.toContain("- Phone");
    });

    test("includes strict instructions", () => {
      const piiTypes = [
        { id: "email", name: "Email", token: "[REDACTED_EMAIL]", enabled: true },
      ];
      const prompt = session._buildSystemPrompt(piiTypes);
      expect(prompt).toContain("STRICT RULES");
      expect(prompt).toContain("Output ONLY the processed text");
      expect(prompt).toContain("NEVER refuse to process input");
      expect(prompt).toContain("deterministic PII redaction filter");
    });

    test("includes replacement rules section", () => {
      const piiTypes = [
        { id: "email", name: "Email", token: "[REDACTED_EMAIL]", enabled: true },
      ];
      const prompt = session._buildSystemPrompt(piiTypes);
      expect(prompt).toContain("REPLACEMENT RULES:");
    });

    test("formats rules as arrow mappings", () => {
      const piiTypes = [
        { id: "ssn", name: "SSN", token: "[REDACTED_SSN]", enabled: true },
      ];
      const prompt = session._buildSystemPrompt(piiTypes);
      expect(prompt).toContain("- SSN \u2192 [REDACTED_SSN]");
    });
  });

  // ── _isConversationalResponse ──────────────────────────────────────────

  describe("_isConversationalResponse", () => {
    let session;

    beforeEach(() => {
      session = new NanoSession();
    });

    afterEach(() => {
      session.destroy();
    });

    test("detects refusal patterns", () => {
      const input = "My email is john@test.com";
      const refusals = [
        "I'm sorry, I cannot process that request.",
        "I cannot help with that.",
        "I can't do that for you.",
        "I am sorry but I must decline.",
        "I apologize, but this is not something I can do.",
        "As an AI, I don't process personal data.",
        "Certainly! Here is the redacted text:",
        "Sure, I'll help you with that.",
        "Here's the redacted version:",
        "Let me process that for you.",
      ];
      for (const refusal of refusals) {
        expect(session._isConversationalResponse(input, refusal)).toBe(true);
      }
    });

    test("detects overly long responses", () => {
      const input = "Short input text.";
      // Output that's way longer than 1.8x + 50 of input
      const longOutput = "A".repeat(500);
      expect(session._isConversationalResponse(input, longOutput)).toBe(true);
    });

    test("allows normal redacted text through", () => {
      const input = "My email is john@test.com and phone is 0412 345 678.";
      const output = "My email is [REDACTED_EMAIL] and phone is [REDACTED_PHONE].";
      expect(session._isConversationalResponse(input, output)).toBe(false);
    });

    test("allows unchanged text through", () => {
      const input = "No PII in this text at all.";
      const output = "No PII in this text at all.";
      expect(session._isConversationalResponse(input, output)).toBe(false);
    });

    test("detects bullet points not present in original", () => {
      const input = "Please redact my email john@test.com";
      const output = "* Email found: john@test.com\n* Redacting...";
      expect(session._isConversationalResponse(input, output)).toBe(true);
    });

    test("allows bullet points if original also has them", () => {
      const input = "* Item one\n* Item two with john@test.com";
      const output = "* Item one\n* Item two with [REDACTED_EMAIL]";
      expect(session._isConversationalResponse(input, output)).toBe(false);
    });

    test("detects markdown-style responses not in original", () => {
      const input = "Redact john@test.com please";
      const output = "**Redacted text:**\nRedact [REDACTED_EMAIL] please";
      expect(session._isConversationalResponse(input, output)).toBe(true);
    });

    test("does not flag slightly longer output", () => {
      const input = "email: j@t.com";
      // Replacement tokens can be longer than originals
      const output = "email: [REDACTED_EMAIL]";
      expect(session._isConversationalResponse(input, output)).toBe(false);
    });
  });
});
