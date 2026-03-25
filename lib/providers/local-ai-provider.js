/**
 * Local AI Provider - Chrome's built-in Gemini Nano via ai.languageModel API.
 * Tier: LOCAL — all processing on-device, zero network calls.
 */

(function () {
  const BaseProvider = globalThis.LLSS_BaseProvider || (typeof require !== 'undefined' ? require('./base-provider').BaseProvider : null);
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : {});
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_CAPABILITIES : {});

  class LocalAiProvider extends BaseProvider {
    constructor(config = {}) {
      super({
        id: 'local_ai',
        name: 'Chrome Gemini Nano (Local)',
        tier: TIERS.LOCAL || 'local',
        capabilities: [CAPS.TEXT || 'text'],
        priority: 10, // Highest priority — local first
        enabled: config.enabled !== false,
        settings: config.settings || {},
      });
      this._session = null;
      this._currentPrompt = null;
      this._idleTimer = null;
      this._idleTimeoutMs = (config.settings?.sessionTimeoutMinutes || 5) * 60 * 1000;
    }

    async checkAvailability() {
      try {
        if (typeof self === 'undefined' || !self.ai || !self.ai.languageModel) {
          return { available: false, status: 'no', detail: 'ai.languageModel API not present' };
        }
        const caps = await self.ai.languageModel.capabilities();
        const status = caps.available || 'no';
        return {
          available: status === 'readily' || status === 'after-download',
          status,
          detail: status === 'readily' ? 'Model ready' :
                  status === 'after-download' ? 'Model available after download' :
                  'Model not available',
        };
      } catch (err) {
        return { available: false, status: 'no', detail: err.message };
      }
    }

    /**
     * Build a system prompt from enabled PII types.
     */
    _buildSystemPrompt(piiTypes) {
      const enabledTypes = piiTypes.filter(t => t.enabled);
      const rules = enabledTypes.map(t => `- ${t.name} → ${t.token}`).join('\n');

      return `You are a PII redaction engine. Your ONLY job is to replace personally identifiable information in the user's text with the specified tokens.

REPLACEMENT RULES:
${rules}

INSTRUCTIONS:
1. Return ONLY the redacted text — no explanations, preamble, or commentary.
2. Preserve the original text structure, formatting, punctuation, and line breaks exactly.
3. Replace ALL instances of each PII category with its corresponding token.
4. When uncertain whether something is PII, err on the side of redaction.
5. Do NOT redact common nouns, place names of countries/states, or generic titles.
6. If the input contains no PII, return it unchanged.`;
    }

    async _getSession(systemPrompt) {
      if (this._session && this._currentPrompt === systemPrompt) {
        this._resetIdleTimer();
        return this._session;
      }
      if (this._session) {
        this._session.destroy();
        this._session = null;
      }
      this._session = await self.ai.languageModel.create({ systemPrompt });
      this._currentPrompt = systemPrompt;
      this._resetIdleTimer();
      return this._session;
    }

    _resetIdleTimer() {
      if (this._idleTimer) clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => this.destroy(), this._idleTimeoutMs);
    }

    async redactText(text, piiTypes, settings) {
      const systemPrompt = this._buildSystemPrompt(piiTypes);
      const session = await this._getSession(systemPrompt);
      const redacted = await session.prompt(text);
      this._resetIdleTimer();
      return {
        redacted: redacted.trim(),
        engine: this.id,
        matches: [], // AI doesn't provide structured match data
        metadata: { model: 'gemini-nano-local' },
      };
    }

    async destroy() {
      if (this._idleTimer) {
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
      }
      if (this._session) {
        this._session.destroy();
        this._session = null;
        this._currentPrompt = null;
      }
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.LLSS_LocalAiProvider = LocalAiProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = { LocalAiProvider };
})();
