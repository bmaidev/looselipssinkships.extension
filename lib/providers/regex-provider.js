/**
 * Regex Provider - Pattern-based PII redaction using the existing regex engine.
 * Tier: LOCAL — deterministic, zero network, always available.
 */

(function () {
  const BaseProvider = globalThis.LLSS_BaseProvider || (typeof require !== 'undefined' ? require('./base-provider').BaseProvider : null);
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : {});
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_CAPABILITIES : {});

  // Import existing engines
  const regexRedact = globalThis.LLSS_regexRedact || (typeof require !== 'undefined' ? require('../regex-engine').regexRedact : null);
  const vectorRedact = globalThis.LLSS_vectorRedact || (typeof require !== 'undefined' ? require('../vector-engine').vectorRedact : null);

  class RegexProvider extends BaseProvider {
    constructor(config = {}) {
      super({
        id: 'regex',
        name: 'Regex Pattern Engine (Local)',
        tier: TIERS.LOCAL || 'local',
        capabilities: [
          CAPS.TEXT || 'text',
          CAPS.HTML || 'html',
          CAPS.MARKDOWN || 'markdown',
        ],
        priority: 20, // Second preference after local AI
        enabled: true, // Always enabled as ultimate fallback
        settings: config.settings || {},
      });
    }

    async checkAvailability() {
      return { available: true, status: 'readily', detail: 'Regex engine always available' };
    }

    async redactText(text, piiTypes, settings) {
      const enabledTypes = piiTypes.filter(t => t.enabled && t.regex);

      // Pass 1: Regex patterns
      const regexResult = regexRedact(text, enabledTypes);

      // Pass 2: Vector/heuristic name detection if enabled
      let finalText = regexResult.redacted;
      let allMatches = [...regexResult.matches];
      let engineLabel = 'regex';

      if (settings.enableVectorFallback !== false) {
        const threshold = settings.vectorThreshold || 0.45;
        const nameToken = '[REDACTED_NAME]';
        const vectorResult = vectorRedact(finalText, nameToken, threshold);
        if (vectorResult.matches.length > 0) {
          finalText = vectorResult.redacted;
          allMatches = allMatches.concat(vectorResult.matches);
          engineLabel = 'regex+vector';
        }
      }

      return {
        redacted: finalText,
        engine: engineLabel,
        matches: allMatches,
        metadata: { patternsUsed: enabledTypes.length },
      };
    }

    async redactDocument(content, contentType, piiTypes, settings) {
      // For HTML and Markdown, extract text and redact
      if (contentType === 'html' || contentType === 'markdown') {
        const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
        return this.redactText(text, piiTypes, settings);
      }
      throw new Error(`Regex provider cannot process ${contentType} documents`);
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.LLSS_RegexProvider = RegexProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = { RegexProvider };
})();
