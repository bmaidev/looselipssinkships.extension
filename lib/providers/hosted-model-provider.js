/**
 * Hosted Model Provider - Organisation-hosted LLM or PII detection model.
 * Tier: HOSTED — runs on the organisation's own infrastructure (on-prem or private cloud).
 *
 * Supports two API modes:
 * 1. "openai" — OpenAI-compatible chat completion API (vLLM, TGI, Ollama, Azure OpenAI, etc.)
 * 2. "pii_api" — Custom PII detection REST API returning structured entity data
 *
 * This allows Australian government agencies to host models within their
 * own PROTECTED/SECRET enclaves and route sensitive content to them.
 */

(function () {
  const BaseProvider = globalThis.LLSS_BaseProvider || (typeof require !== 'undefined' ? require('./base-provider').BaseProvider : null);
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : {});
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_CAPABILITIES : {});

  class HostedModelProvider extends BaseProvider {
    constructor(config = {}) {
      super({
        id: config.settings?.providerId || 'hosted_model',
        name: config.settings?.displayName || 'Organisation-Hosted Model',
        tier: TIERS.HOSTED || 'hosted',
        capabilities: config.settings?.capabilities || [CAPS.TEXT || 'text'],
        priority: config.settings?.priority || 30, // Between local and cloud
        enabled: config.enabled || false,
        settings: {
          providerId: 'hosted_model',
          displayName: 'Organisation-Hosted Model',
          endpoint: '',                // e.g., https://internal-llm.agency.gov.au/v1
          apiKey: '',                  // Bearer token or API key
          apiMode: 'openai',           // 'openai' | 'pii_api'
          model: '',                   // Model name for OpenAI-compat (e.g., 'llama-3-70b')
          maxTokens: 4096,
          temperature: 0.0,
          timeout: 30000,              // 30s default
          customHeaders: {},           // Additional headers (e.g., X-Agency-ID)
          tlsSkipVerify: false,        // For self-signed certs in secure networks
          capabilities: ['text'],
          priority: 30,
          // PII API mode settings
          piiApiRequestFormat: 'body', // 'body' | 'query' (pii_api mode)
          // OCR Extract mode settings (for container integration)
          // apiMode: 'ocr_extract' — server returns text + bounding boxes, no PII detection
          piiApiTextField: 'text',     // Field name for input text
          piiApiResponsePath: 'entities', // JSON path to entities array
          ...(config.settings || {}),
        },
      });
    }

    async checkAvailability() {
      if (!this.settings.endpoint) {
        return { available: false, status: 'no', detail: 'Endpoint not configured' };
      }
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        // Health check — try the appropriate endpoint for each mode
        let checkUrl;
        if (this.settings.apiMode === 'openai') {
          checkUrl = `${this.settings.endpoint.replace(/\/$/, '')}/models`;
        } else {
          // pii_api and ocr_extract both use GET on the base endpoint
          checkUrl = this.settings.endpoint.replace(/\/$/, '');
        }

        const response = await fetch(checkUrl, {
          method: 'GET',
          headers: this._getHeaders(),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        return {
          available: response.ok || response.status === 401, // 401 means endpoint exists but auth issue
          status: response.ok ? 'readily' : 'no',
          detail: response.ok ? `${this.settings.displayName} reachable` : `HTTP ${response.status}`,
        };
      } catch (err) {
        return {
          available: false,
          status: 'no',
          detail: err.name === 'AbortError' ? 'Connection timeout' : err.message,
        };
      }
    }

    _getHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      if (this.settings.apiKey) {
        headers['Authorization'] = `Bearer ${this.settings.apiKey}`;
      }
      // Merge custom headers
      if (this.settings.customHeaders && typeof this.settings.customHeaders === 'object') {
        Object.assign(headers, this.settings.customHeaders);
      }
      return headers;
    }

    _buildSystemPrompt(piiTypes) {
      const enabledTypes = piiTypes.filter(t => t.enabled);
      const rules = enabledTypes.map(t => `- ${t.name} → ${t.token}`).join('\n');

      return `You are a PII redaction engine. Replace personally identifiable information with the specified tokens.

REPLACEMENT RULES:
${rules}

INSTRUCTIONS:
1. Return ONLY the redacted text — no explanations or commentary.
2. Preserve original formatting exactly.
3. Replace ALL instances of each PII category with its token.
4. When uncertain, err on the side of redaction.
5. If no PII found, return the text unchanged.`;
    }

    async redactText(text, piiTypes, settings) {
      if (this.settings.apiMode === 'pii_api') {
        return this._redactViaPiiApi(text, piiTypes);
      }
      if (this.settings.apiMode === 'ocr_extract') {
        // OCR extract mode doesn't do text redaction — it only extracts from documents.
        // For text input, fall through to openai mode or throw.
        throw new Error(`Provider ${this.id} (ocr_extract mode) does not support text redaction`);
      }
      return this._redactViaOpenAi(text, piiTypes);
    }

    /**
     * Extract text + bounding boxes from a document via the OCR container.
     * Used by the pipeline when apiMode is 'ocr_extract'.
     *
     * @param {ArrayBuffer} content — raw file bytes
     * @param {string} contentType — 'pdf', 'image', etc.
     * @returns {Promise<{pages: Array, fullText: string}>}
     */
    async extractOcr(content, contentType) {
      const url = `${this.settings.endpoint.replace(/\/$/, '')}/extract`;

      const formData = new FormData();
      const blob = content instanceof ArrayBuffer ? new Blob([content]) : new Blob([content]);
      const ext = contentType === 'pdf' ? 'pdf' : 'png';
      formData.append('file', blob, `document.${ext}`);
      formData.append('content_type', contentType === 'image' ? 'image/png' : `application/${contentType}`);

      const headers = {};
      if (this.settings.apiKey) {
        headers['Authorization'] = `Bearer ${this.settings.apiKey}`;
      }
      Object.assign(headers, this.settings.customHeaders || {});

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.settings.timeout * 3); // OCR can be slow

      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: formData,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`OCR extract API error: ${response.status} - ${errBody}`);
      }

      const result = await response.json();

      // Build page boundary map for PII match mapping
      let offset = 0;
      const pages = (result.pages || []).map((p) => {
        const page = {
          ...p,
          charStart: offset,
          charEnd: offset + (p.text || '').length,
        };
        offset += (p.text || '').length + 1;
        return page;
      });

      return {
        pages,
        fullText: result.fullText || pages.map(p => p.text).join('\n'),
      };
    }

    async _redactViaOpenAi(text, piiTypes) {
      const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

      // Try structured entity detection (JSON mode) first
      const buildPrompt = globalThis.LLSS_buildEntitySystemPrompt;
      const parseResponse = globalThis.LLSS_parseEntityResponse;
      const applyMatches = globalThis.LLSS_applyEntityMatches;

      if (buildPrompt && parseResponse && applyMatches) {
        try {
          const result = await this._redactViaOpenAiStructured(text, piiTypes);
          if (result) return result;
        } catch (err) {
          if (dbg) dbg.warn('hosted', 'Structured JSON mode failed, using legacy:', err.message);
        }
      }

      return this._redactViaOpenAiLegacy(text, piiTypes);
    }

    /**
     * Structured mode: request JSON entity output via response_format.
     */
    async _redactViaOpenAiStructured(text, piiTypes) {
      const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;
      const url = `${this.settings.endpoint.replace(/\/$/, '')}/chat/completions`;
      const systemPrompt = globalThis.LLSS_buildEntitySystemPrompt(piiTypes);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.settings.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.settings.model || undefined,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          max_tokens: this.settings.maxTokens,
          temperature: 0,
          response_format: { type: 'json_object' },
        }),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text();
        // If server doesn't support response_format, fall back
        if (response.status === 400 || response.status === 422) {
          if (dbg) dbg.warn('hosted', 'Server may not support response_format, falling back');
          return null;
        }
        throw new Error(`Hosted model API error: ${response.status} - ${errBody}`);
      }

      const result = await response.json();
      const raw = result.choices?.[0]?.message?.content?.trim();
      if (!raw) return null;

      if (dbg) dbg.log('hosted', 'Structured response:', raw.substring(0, 200));

      const parsed = globalThis.LLSS_parseEntityResponse(raw, text, piiTypes);
      if (!parsed.valid) {
        if (dbg) dbg.warn('hosted', 'Structured parse failed:', parsed.error);
        return null;
      }

      const { redacted, matches } = globalThis.LLSS_applyEntityMatches(text, parsed.matches);
      if (dbg) dbg.log('hosted', `Structured: ${matches.length} entities with real positions`);

      return {
        redacted,
        engine: this.id,
        matches,
        metadata: {
          model: result.model || this.settings.model,
          usage: result.usage,
          provider: this.settings.displayName,
          structured: true,
        },
      };
    }

    /**
     * Legacy mode: ask model to return redacted text, estimate matches.
     */
    async _redactViaOpenAiLegacy(text, piiTypes) {
      const url = `${this.settings.endpoint.replace(/\/$/, '')}/chat/completions`;
      const systemPrompt = this._buildSystemPrompt(piiTypes);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.settings.timeout);

      const response = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.settings.model || undefined,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          max_tokens: this.settings.maxTokens,
          temperature: this.settings.temperature,
        }),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Hosted model API error: ${response.status} - ${errBody}`);
      }

      const result = await response.json();
      const redacted = result.choices?.[0]?.message?.content?.trim() || text;

      // Estimate match count from token counting
      const tokenPattern = /\[REDACTED_[A-Z_]+\]/g;
      const outputTokens = redacted.match(tokenPattern) || [];
      const inputTokens = text.match(tokenPattern) || [];
      const newTokenCount = Math.max(0, outputTokens.length - inputTokens.length);
      const estimatedMatches = Array.from({ length: newTokenCount }, (_, i) => ({
        typeId: 'ai_detected',
        token: outputTokens[inputTokens.length + i] || '[REDACTED]',
        original: '',
        index: 0,
      }));

      return {
        redacted,
        engine: this.id,
        matches: estimatedMatches,
        metadata: {
          model: result.model || this.settings.model,
          usage: result.usage,
          provider: this.settings.displayName,
          matchesEstimated: true,
        },
      };
    }

    async _redactViaPiiApi(text, piiTypes) {
      const url = this.settings.endpoint.replace(/\/$/, '');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.settings.timeout);

      const body = {};
      body[this.settings.piiApiTextField || 'text'] = text;

      const response = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`PII API error: ${response.status} - ${errBody}`);
      }

      const result = await response.json();

      // Extract entities from the configured response path
      const entities = this._extractFromPath(result, this.settings.piiApiResponsePath || 'entities') || [];

      // Build matches and redact
      const matches = entities.map(entity => ({
        typeId: entity.type || entity.category || 'unknown',
        token: entity.replacement || `[REDACTED_${(entity.type || entity.category || 'PII').toUpperCase()}]`,
        original: entity.text || entity.value || '',
        index: entity.offset || entity.start || 0,
        confidence: entity.confidence || entity.score || 0,
      }));

      // If the API returns pre-redacted text, use it; otherwise redact ourselves
      let redacted = result.redacted || result.redactedText || result.redacted_text;
      if (!redacted) {
        redacted = text;
        const sorted = [...matches].filter(m => m.original).sort((a, b) => b.index - a.index);
        for (const match of sorted) {
          const before = redacted.slice(0, match.index);
          const after = redacted.slice(match.index + match.original.length);
          redacted = before + match.token + after;
        }
      }

      return {
        redacted,
        engine: this.id,
        matches,
        metadata: { provider: this.settings.displayName, entitiesDetected: entities.length },
      };
    }

    _extractFromPath(obj, path) {
      const parts = path.split('.');
      let current = obj;
      for (const part of parts) {
        if (current == null) return null;
        current = current[part];
      }
      return current;
    }

    async redactDocument(content, contentType, piiTypes, settings) {
      // Some hosted APIs support document upload
      if (this.settings.apiMode === 'pii_api') {
        const url = `${this.settings.endpoint.replace(/\/$/, '')}/documents`;
        const formData = new FormData();

        const blob = content instanceof ArrayBuffer ? new Blob([content]) : new Blob([content]);
        formData.append('file', blob, `document.${contentType}`);
        formData.append('content_type', contentType);

        const headers = {};
        if (this.settings.apiKey) {
          headers['Authorization'] = `Bearer ${this.settings.apiKey}`;
        }
        Object.assign(headers, this.settings.customHeaders || {});

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.settings.timeout * 2);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: formData,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Hosted document API error: ${response.status}`);
        }

        const result = await response.json();
        return {
          redacted: result.redacted || result.redactedText || '[Document processed]',
          engine: this.id,
          matches: result.entities || [],
          metadata: { provider: this.settings.displayName, documentType: contentType },
        };
      }

      throw new Error(`Hosted provider ${this.id} in openai mode does not support document upload`);
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.LLSS_HostedModelProvider = HostedModelProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = { HostedModelProvider };
})();
