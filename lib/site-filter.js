/**
 * Site Filter — whitelist/blacklist URL matching for the extension.
 * Determines whether the extension should activate on the current page.
 *
 * Modes:
 * - "all" — active on all sites (default)
 * - "whitelist" — only active on listed sites
 * - "blacklist" — active everywhere except listed sites
 *
 * Patterns support:
 * - Exact domain: "example.com"
 * - Wildcard subdomain: "*.example.com"
 * - Full URL prefix: "https://internal.agency.gov.au/portal/*"
 * - Simple glob: "*.gov.au" (all Australian government sites)
 */

(function () {

  /**
   * Check if a URL matches a site pattern.
   * @param {string} url - Full page URL
   * @param {string} pattern - Site pattern to match against
   * @returns {boolean}
   */
  function matchesPattern(url, pattern) {
    if (!url || !pattern) return false;

    let urlObj;
    try {
      urlObj = new URL(url);
    } catch {
      return false;
    }

    const hostname = urlObj.hostname.toLowerCase();
    const fullUrl = url.toLowerCase();
    pattern = pattern.toLowerCase().trim();

    // Full URL pattern (starts with http)
    if (pattern.startsWith("http://") || pattern.startsWith("https://")) {
      const regexStr = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*");
      return new RegExp("^" + regexStr).test(fullUrl);
    }

    // Domain pattern
    const domainPattern = pattern.replace(/^(\*\.)?/, "");

    // Exact match
    if (hostname === domainPattern || hostname === pattern) return true;

    // Wildcard subdomain: *.example.com matches sub.example.com, a.b.example.com
    if (pattern.startsWith("*.")) {
      return hostname === domainPattern || hostname.endsWith("." + domainPattern);
    }

    // Suffix match (e.g., ".gov.au" matches anything ending in .gov.au)
    if (pattern.startsWith(".")) {
      return hostname.endsWith(pattern);
    }

    return false;
  }

  /**
   * Check if the extension should be active on the given URL.
   * @param {string} url - Current page URL
   * @param {Object} siteFilter - Filter settings {mode, whitelist, blacklist}
   * @returns {boolean}
   */
  function isSiteAllowed(url, siteFilter) {
    if (!siteFilter || !siteFilter.mode || siteFilter.mode === "all") {
      return true;
    }

    if (siteFilter.mode === "whitelist") {
      const list = siteFilter.whitelist || [];
      return list.some((pattern) => matchesPattern(url, pattern));
    }

    if (siteFilter.mode === "blacklist") {
      const list = siteFilter.blacklist || [];
      return !list.some((pattern) => matchesPattern(url, pattern));
    }

    return true;
  }

  /**
   * Known AI chat service domains.
   * Used for automatic AI chat protection mode detection.
   */
  const AI_CHAT_DOMAINS = [
    // OpenAI / ChatGPT
    "chat.openai.com",
    "chatgpt.com",
    "*.openai.com",
    // Anthropic / Claude
    "claude.ai",
    "*.anthropic.com",
    // Google Gemini
    "gemini.google.com",
    "aistudio.google.com",
    "bard.google.com",
    "notebooklm.google.com",
    // Microsoft Copilot
    "copilot.microsoft.com",
    "copilot.cloud.microsoft",
    "*.copilot.microsoft.com",
    "bing.com/chat",
    "edgeservices.bing.com",
    // X / Grok
    "grok.x.ai",
    "x.com/i/grok",
    // Meta AI
    "meta.ai",
    "*.meta.ai",
    // Perplexity
    "perplexity.ai",
    "*.perplexity.ai",
    // Mistral
    "chat.mistral.ai",
    "*.mistral.ai",
    // HuggingChat
    "huggingface.co/chat",
    // Cohere
    "coral.cohere.com",
    "dashboard.cohere.com",
    // DeepSeek
    "chat.deepseek.com",
    "*.deepseek.com",
    // Poe
    "poe.com",
    // You.com
    "you.com",
    // Pi
    "pi.ai",
    // Character.AI
    "character.ai",
    "*.character.ai",
    // Replika
    "replika.ai",
    // Jasper
    "app.jasper.ai",
    // Inflection
    "inflection.ai",
    // Local/self-hosted (common patterns)
    "localhost",
    "127.0.0.1",
  ];

  /**
   * Check if the current page is a known AI chat service.
   * @param {string} url - Current page URL
   * @param {string[]} [customAiDomains] - Additional domains to treat as AI chat
   * @returns {boolean}
   */
  function isAiChatService(url, customAiDomains) {
    const allDomains = [...AI_CHAT_DOMAINS, ...(customAiDomains || [])];
    return allDomains.some((pattern) => matchesPattern(url, pattern));
  }

  /**
   * Check if the AI chat guard should be active on this page.
   * Respects the site whitelist/blacklist — if a site is blacklisted,
   * the AI guard doesn't apply either (extension is fully disabled).
   *
   * @param {string} url
   * @param {Object} settings - Full settings object
   * @returns {{active: boolean, reason: string}}
   */
  function getPageProtectionStatus(url, settings) {
    const siteFilter = settings.siteFilter || {};
    const aiGuard = settings.aiChatGuard || {};

    // Check site filter first
    if (!isSiteAllowed(url, siteFilter)) {
      return { active: false, reason: "site_filtered" };
    }

    // Check if AI guard is enabled and this is an AI service
    if (aiGuard.enabled && isAiChatService(url, aiGuard.customAiDomains)) {
      return { active: true, reason: "ai_chat_service" };
    }

    // Extension active but not in AI guard mode
    return { active: true, reason: "normal" };
  }

  // Exports
  const exports = {
    matchesPattern,
    isSiteAllowed,
    isAiChatService,
    getPageProtectionStatus,
    AI_CHAT_DOMAINS,
  };

  if (typeof globalThis !== "undefined") {
    globalThis.LLSS_matchesPattern = matchesPattern;
    globalThis.LLSS_isSiteAllowed = isSiteAllowed;
    globalThis.LLSS_isAiChatService = isAiChatService;
    globalThis.LLSS_getPageProtectionStatus = getPageProtectionStatus;
    globalThis.LLSS_AI_CHAT_DOMAINS = AI_CHAT_DOMAINS;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exports;
  }
})();
