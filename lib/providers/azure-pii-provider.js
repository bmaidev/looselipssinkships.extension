/**
 * Azure AI Language PII Detection Provider.
 * Tier: CLOUD — uses Azure Cognitive Services Text Analytics PII endpoint.
 * Designed for Australian government / enterprise environments with Azure tenancy.
 *
 * API: POST {endpoint}/language/:analyze-text?api-version=2023-04-01
 * Docs: https://learn.microsoft.com/en-us/azure/ai-services/language-service/personally-identifiable-information/overview
 */

(function () {
  const BaseProvider = globalThis.LLSS_BaseProvider || (typeof require !== 'undefined' ? require('./base-provider').BaseProvider : null);
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : {});
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_CAPABILITIES : {});

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
        priority: 50, // Cloud tier — lower preference than local
        enabled: config.enabled || false,
        settings: {
          endpoint: '',           // e.g., https://myinstance.cognitiveservices.azure.com
          apiKey: '',             // Subscription key (or use managed identity)
          apiVersion: '2023-04-01',
          language: 'en',
          domain: 'none',        // 'none' or 'phi' (protected health info)
          categoriesFilter: [],  // Empty = detect all; otherwise array of category names
          useManagedIdentity: false,
          tenantId: '',
          clientId: '',
          ...(config.settings || {}),
        },
      });
    }

    async checkAvailability() {
      if (!this.settings.endpoint) {
        return { available: false, status: 'no', detail: 'Azure endpoint not configured' };
      }
      if (!this.settings.apiKey && !this.settings.useManagedIdentity) {
        return { available: false, status: 'no', detail: 'No API key or managed identity configured' };
      }
      try {
        const url = `${this.settings.endpoint.replace(/\/$/, '')}/language/:analyze-text?api-version=${this.settings.apiVersion}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify({
            kind: 'PiiEntityRecognition',
            parameters: { domain: this.settings.domain, modelVersion: 'latest' },
            analysisInput: { documents: [{ id: '1', language: this.settings.language, text: 'test' }] },
          }),
        });
        return {
          available: response.ok,
          status: response.ok ? 'readily' : 'no',
          detail: response.ok ? 'Azure PII endpoint reachable' : `HTTP ${response.status}`,
        };
      } catch (err) {
        return { available: false, status: 'no', detail: err.message };
      }
    }

    _getHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      if (this.settings.apiKey) {
        headers['Ocp-Apim-Subscription-Key'] = this.settings.apiKey;
      }
      return headers;
    }

    async redactText(text, piiTypes, settings) {
      const url = `${this.settings.endpoint.replace(/\/$/, '')}/language/:analyze-text?api-version=${this.settings.apiVersion}`;

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

      const response = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Azure PII API error: ${response.status} - ${errBody}`);
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
      // Sort matches by offset descending to preserve indices
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
          documentsProcessed: 1,
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
