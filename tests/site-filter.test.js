const {
  matchesPattern,
  isSiteAllowed,
  isAiChatService,
  getPageProtectionStatus,
  AI_CHAT_DOMAINS,
} = require("../lib/site-filter");

describe("matchesPattern", () => {
  test("matches exact domain", () => {
    expect(matchesPattern("https://example.com/page", "example.com")).toBe(true);
  });

  test("does not match different domain", () => {
    expect(matchesPattern("https://other.com/page", "example.com")).toBe(false);
  });

  test("matches wildcard subdomain", () => {
    expect(matchesPattern("https://sub.example.com/page", "*.example.com")).toBe(true);
    expect(matchesPattern("https://a.b.example.com/page", "*.example.com")).toBe(true);
  });

  test("wildcard also matches the base domain", () => {
    expect(matchesPattern("https://example.com/page", "*.example.com")).toBe(true);
  });

  test("does not match unrelated domain with wildcard", () => {
    expect(matchesPattern("https://notexample.com", "*.example.com")).toBe(false);
  });

  test("matches .gov.au suffix pattern", () => {
    expect(matchesPattern("https://agency.gov.au/portal", "*.gov.au")).toBe(true);
    expect(matchesPattern("https://sub.agency.gov.au", "*.gov.au")).toBe(true);
  });

  test("matches dot-prefix suffix pattern", () => {
    expect(matchesPattern("https://sub.agency.gov.au", ".gov.au")).toBe(true);
    expect(matchesPattern("https://example.com", ".gov.au")).toBe(false);
  });

  test("matches full URL prefix pattern", () => {
    expect(matchesPattern(
      "https://portal.agency.gov.au/app/page",
      "https://portal.agency.gov.au/*"
    )).toBe(true);
    expect(matchesPattern(
      "https://other.agency.gov.au/app",
      "https://portal.agency.gov.au/*"
    )).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(matchesPattern("https://Example.COM/page", "example.com")).toBe(true);
    expect(matchesPattern("https://example.com", "EXAMPLE.COM")).toBe(true);
  });

  test("handles invalid URL gracefully", () => {
    expect(matchesPattern("not-a-url", "example.com")).toBe(false);
    expect(matchesPattern("", "example.com")).toBe(false);
  });

  test("handles empty pattern", () => {
    expect(matchesPattern("https://example.com", "")).toBe(false);
  });

  test("handles null/undefined inputs", () => {
    expect(matchesPattern(null, "example.com")).toBe(false);
    expect(matchesPattern("https://example.com", null)).toBe(false);
  });
});

describe("isSiteAllowed", () => {
  test("allows all sites when mode is 'all'", () => {
    expect(isSiteAllowed("https://anything.com", { mode: "all" })).toBe(true);
  });

  test("allows all sites when no filter configured", () => {
    expect(isSiteAllowed("https://anything.com", {})).toBe(true);
    expect(isSiteAllowed("https://anything.com", null)).toBe(true);
  });

  test("whitelist mode only allows listed sites", () => {
    const filter = { mode: "whitelist", whitelist: ["example.com", "*.gov.au"] };
    expect(isSiteAllowed("https://example.com", filter)).toBe(true);
    expect(isSiteAllowed("https://agency.gov.au", filter)).toBe(true);
    expect(isSiteAllowed("https://other.com", filter)).toBe(false);
  });

  test("blacklist mode blocks listed sites", () => {
    const filter = { mode: "blacklist", blacklist: ["social.com", "*.entertainment.com"] };
    expect(isSiteAllowed("https://social.com", filter)).toBe(false);
    expect(isSiteAllowed("https://sub.entertainment.com", filter)).toBe(false);
    expect(isSiteAllowed("https://work.com", filter)).toBe(true);
  });

  test("empty whitelist blocks everything", () => {
    expect(isSiteAllowed("https://anything.com", { mode: "whitelist", whitelist: [] })).toBe(false);
  });

  test("empty blacklist allows everything", () => {
    expect(isSiteAllowed("https://anything.com", { mode: "blacklist", blacklist: [] })).toBe(true);
  });
});

describe("isAiChatService", () => {
  test("detects ChatGPT", () => {
    expect(isAiChatService("https://chat.openai.com/c/123")).toBe(true);
    expect(isAiChatService("https://chatgpt.com/")).toBe(true);
  });

  test("detects Claude", () => {
    expect(isAiChatService("https://claude.ai/chat")).toBe(true);
  });

  test("detects Gemini", () => {
    expect(isAiChatService("https://gemini.google.com/app")).toBe(true);
    expect(isAiChatService("https://aistudio.google.com/")).toBe(true);
  });

  test("detects Copilot", () => {
    expect(isAiChatService("https://copilot.microsoft.com/")).toBe(true);
  });

  test("detects Grok", () => {
    expect(isAiChatService("https://grok.x.ai/")).toBe(true);
  });

  test("detects Perplexity", () => {
    expect(isAiChatService("https://perplexity.ai/search")).toBe(true);
  });

  test("detects DeepSeek", () => {
    expect(isAiChatService("https://chat.deepseek.com/")).toBe(true);
  });

  test("detects Mistral", () => {
    expect(isAiChatService("https://chat.mistral.ai/")).toBe(true);
  });

  test("does not flag regular websites", () => {
    expect(isAiChatService("https://google.com")).toBe(false);
    expect(isAiChatService("https://github.com")).toBe(false);
    expect(isAiChatService("https://example.gov.au")).toBe(false);
  });

  test("respects custom AI domains", () => {
    expect(isAiChatService("https://internal-ai.agency.gov.au", ["internal-ai.agency.gov.au"])).toBe(true);
    expect(isAiChatService("https://internal-ai.agency.gov.au")).toBe(false);
  });
});

describe("getPageProtectionStatus", () => {
  test("returns normal when no special config", () => {
    const result = getPageProtectionStatus("https://example.com", {});
    expect(result.active).toBe(true);
    expect(result.reason).toBe("normal");
  });

  test("returns site_filtered when blacklisted", () => {
    const settings = {
      siteFilter: { mode: "blacklist", blacklist: ["example.com"] },
    };
    const result = getPageProtectionStatus("https://example.com", settings);
    expect(result.active).toBe(false);
    expect(result.reason).toBe("site_filtered");
  });

  test("returns ai_chat_service when guard enabled and on AI site", () => {
    const settings = {
      aiChatGuard: { enabled: true },
    };
    const result = getPageProtectionStatus("https://chat.openai.com", settings);
    expect(result.active).toBe(true);
    expect(result.reason).toBe("ai_chat_service");
  });

  test("site filter takes priority over AI guard", () => {
    const settings = {
      siteFilter: { mode: "blacklist", blacklist: ["chat.openai.com"] },
      aiChatGuard: { enabled: true },
    };
    const result = getPageProtectionStatus("https://chat.openai.com", settings);
    expect(result.active).toBe(false);
    expect(result.reason).toBe("site_filtered");
  });

  test("AI guard with custom domains", () => {
    const settings = {
      aiChatGuard: { enabled: true, customAiDomains: ["internal-ai.company.com"] },
    };
    const result = getPageProtectionStatus("https://internal-ai.company.com", settings);
    expect(result.active).toBe(true);
    expect(result.reason).toBe("ai_chat_service");
  });

  test("AI guard disabled returns normal for AI sites", () => {
    const settings = {
      aiChatGuard: { enabled: false },
    };
    const result = getPageProtectionStatus("https://chat.openai.com", settings);
    expect(result.active).toBe(true);
    expect(result.reason).toBe("normal");
  });
});

describe("AI_CHAT_DOMAINS", () => {
  test("contains major AI services", () => {
    expect(AI_CHAT_DOMAINS).toEqual(
      expect.arrayContaining([
        "chat.openai.com",
        "claude.ai",
        "gemini.google.com",
        "copilot.microsoft.com",
        "grok.x.ai",
        "perplexity.ai",
      ])
    );
  });

  test("contains at least 15 domains", () => {
    expect(AI_CHAT_DOMAINS.length).toBeGreaterThanOrEqual(15);
  });
});
