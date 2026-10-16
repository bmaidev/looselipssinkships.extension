/**
 * Azure AI Language PII Detection Provider.
 * Tier: CLOUD — uses Azure Cognitive Services Text Analytics PII endpoint.
 *
 * Supports two connection modes:
 *   - Direct: API key authentication (Ocp-Apim-Subscription-Key header)
 *   - Enterprise: Azure AD OAuth2 PKCE (Bearer token via LLSS_AzureAuth)
 *
 * API: POST {endpoint}/language/:analyze-text?api-version=2023-04-01
 * Docs: https://learn.microsoft.com/en-us/azure/ai-services/language-service/personally-identifiable-information/overview
 */

(function () {
  const BaseProvider = globalThis.LLSS_BaseProvider || (typeof require !== 'undefined' ? require('./base-provider').BaseProvider : null);
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : {});
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_CAPABILITIES : {});

  function validatedAzureEndpoint(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(host.endsWith('.cognitiveservices.azure.com') || host.endsWith('.api.cognitive.microsoft.com'))) {
      throw new Error('Azure endpoint must use HTTPS on an approved Azure AI hostname');
    }
    return url.origin;
  }

  function secureFetch(url, init = {}) {
    return fetch(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  }

  // Map Azure PII entity categories to our tokens
  const AZURE_CATEGORY_MAP = {
    'Person': '[REDACTED_NAME]',
    'PersonType': '[REDACTED_NAME]',
    'Email': '[REDACTED_EMAIL]',
    'PhoneNumber': '[REDACTED_PHONE]',
    'Address': '[REDACTED_ADDRESS]',
    'AUBusinessNumber': '[REDACTED_ABN]',
    'AUCompanyNumber': '[REDACTED_ACN]',
    'AUTaxFileNumber': '[REDACTED_TFN]',
    'AUMedicalAccountNumber': '[REDACTED_MEDICARE]',
    'AUDriversLicenseNumber': '[REDACTED_LICENCE]',
    'AUPassportNumber': '[REDACTED_PASSPORT]',
    'AUBankAccountNumber': '[REDACTED_ACCOUNT]',
    'CreditCardNumber': '[REDACTED_CARD]',
    'IPAddress': '[REDACTED_IP]',
    'DateTime': '[REDACTED_DOB]',
    'URL': '[REDACTED_URL]',
    'InternationalBankingAccountNumber': '[REDACTED_FINANCIAL]',
    'SWIFTCode': '[REDACTED_FINANCIAL]',
    'Organization': '[REDACTED_ORG]',
  };

  class AzurePiiProvider extends BaseProvider {
    constructor(config = {}) {
      super({
        id: 'azure_pii',
        name: 'Azure AI Language PII Detection',
        tier: TIERS.CLOUD || 'cloud',
        capabilities: [CAPS.TEXT || 'text'],
        priority: 50,
        enabled: config.enabled || false,
        settings: {
          endpoint: '',
          apiKey: '',
          apiVersion: '2023-04-01',
          language: 'en',
          domain: 'none',
          categoriesFilter: [],
          connectionMode: 'direct', // 'direct' (API key) or 'enterprise' (OAuth2)
          tenantId: '',
          clientId: '',
          ...(config.settings || {}),
        },
      });
    }

    // ── Availability ───────────────────────────────────────────────────────

    async checkAvailability() {
      if (!this.settings.endpoint) {
        return { available: false, status: 'no', detail: 'Azure endpoint not configured' };
      }

      if (this.settings.connectionMode === 'enterprise') {
        if (!this.settings.tenantId || !this.settings.clientId) {
          return { available: false, status: 'no', detail: 'Tenant ID and Client ID required for Enterprise mode' };
        }
        const auth = globalThis.LLSS_AzureAuth;
        if (!auth || !(await auth.isSignedIn())) {
          return { available: false, status: 'no', detail: 'Not signed in to Azure AD — sign in via Settings' };
        }
      } else {
        if (!this.settings.apiKey) {
          return { available: false, status: 'no', detail: 'No API key configured' };
        }
      }

      try {
        const url = `${validatedAzureEndpoint(this.settings.endpoint)}/language/:analyze-text?api-version=${this.settings.apiVersion}`;
        const headers = await this._getHeaders();
        const response = await secureFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            kind: 'PiiEntityRecognition',
            parameters: { domain: this.settings.domain, modelVersion: 'latest' },
            analysisInput: { documents: [{ id: '1', language: this.settings.language, text: 'test' }] },
          }),
        });
        return {
          available: response.ok,
          status: response.ok ? 'readily' : 'no',
          detail: response.ok
            ? `Azure PII ready (${this.settings.connectionMode} mode)`
            : `HTTP ${response.status}`,
        };
      } catch (err) {
        return { available: false, status: 'no', detail: err.message };
      }
    }

    // ── Headers (dual-mode) ────────────────────────────────────────────────

    async _getHeaders() {
      const headers = { 'Content-Type': 'application/json' };

      if (this.settings.connectionMode === 'enterprise') {
        const auth = globalThis.LLSS_AzureAuth;
        if (!auth) throw new Error('Azure Auth module not loaded');
        const token = await auth.getAccessToken(this.settings.tenantId, this.settings.clientId);
        if (!token) throw new Error('Not signed in to Azure AD — sign in via Settings');
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        if (this.settings.apiKey) {
          headers['Ocp-Apim-Subscription-Key'] = this.settings.apiKey;
        }
      }

      return headers;
    }

    // ── Redaction ──────────────────────────────────────────────────────────

    async redactText(text, piiTypes, settings) {
      const url = `${validatedAzureEndpoint(this.settings.endpoint)}/language/:analyze-text?api-version=${this.settings.apiVersion}`;

      const body = {
        kind: 'PiiEntityRecognition',
        parameters: {
          domain: this.settings.domain,
          modelVersion: 'latest',
          piiCategories: this.settings.categoriesFilter.length > 0
            ? this.settings.categoriesFilter
            : undefined,
        },
        analysisInput: {
          documents: [{
            id: '1',
            language: this.settings.language,
            text,
          }],
        },
      };

      const headers = await this._getHeaders();
      const response = await secureFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Azure PII API error: HTTP ${response.status}`);
      }

      const result = await response.json();
      const doc = result.results?.documents?.[0];
      if (!doc) {
        throw new Error('Azure PII returned no document results');
      }

      // Azure returns redactedText directly
      const redacted = doc.redactedText || text;
      const matches = (doc.entities || []).map(entity => ({
        typeId: this._mapCategory(entity.category),
        token: AZURE_CATEGORY_MAP[entity.category] || `[REDACTED_${entity.category.toUpperCase()}]`,
        original: entity.text,
        index: entity.offset,
        confidence: entity.confidenceScore,
        azureCategory: entity.category,
        azureSubcategory: entity.subcategory,
      }));

      // Re-redact using our token format (Azure uses *****)
      let tokenRedacted = text;
      const sortedMatches = [...matches].sort((a, b) => b.index - a.index);
      for (const match of sortedMatches) {
        const before = tokenRedacted.slice(0, match.index);
        const after = tokenRedacted.slice(match.index + match.original.length);
        tokenRedacted = before + match.token + after;
      }

      return {
        redacted: tokenRedacted,
        engine: this.id,
        matches,
        metadata: {
          azureRedactedText: redacted,
          modelVersion: doc.modelVersion,
          connectionMode: this.settings.connectionMode,
        },
      };
    }

    _mapCategory(azureCategory) {
      const mapping = {
        'Person': 'name', 'Email': 'email', 'PhoneNumber': 'phone_au',
        'Address': 'street_address', 'AUTaxFileNumber': 'tfn',
        'AUBusinessNumber': 'abn', 'AUCompanyNumber': 'acn',
        'AUMedicalAccountNumber': 'medicare', 'CreditCardNumber': 'credit_card',
        'IPAddress': 'ip_address', 'AUDriversLicenseNumber': 'drivers_licence',
        'AUPassportNumber': 'passport',
      };
      return mapping[azureCategory] || `azure_${azureCategory.toLowerCase()}`;
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.LLSS_AzurePiiProvider = AzurePiiProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = { AzurePiiProvider, AZURE_CATEGORY_MAP };
})();
