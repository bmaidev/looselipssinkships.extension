/**
 * Microsoft Purview DLP Provider.
 * Tier: CLOUD — uses Microsoft Purview Information Protection / DLP APIs.
 * Designed for Australian government agencies with M365 E5/G5 licensing.
 *
 * Purview provides:
 * - Sensitive information type (SIT) detection
 * - Australian-specific classifiers (TFN, Medicare, ABN, etc.)
 * - Custom sensitive information types defined in Purview compliance center
 * - Trainable classifiers for document-level analysis
 *
 * API: Microsoft Graph API - /informationProtection/policy/labels
 *       and /security/dataLossPreventionPolicies
 */

(function () {
  const BaseProvider = globalThis.LLSS_BaseProvider || (typeof require !== 'undefined' ? require('./base-provider').BaseProvider : null);
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : {});
  const CAPS = globalThis.LLSS_PROVIDER_CAPABILITIES || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_CAPABILITIES : {});

  // Map Purview SIT entity names to our tokens
  const PURVIEW_SIT_MAP = {
    'Australia Tax File Number': '[REDACTED_TFN]',
    'Australia Business Number': '[REDACTED_ABN]',
    'Australia Company Number': '[REDACTED_ACN]',
    'Australia Medical Account Number': '[REDACTED_MEDICARE]',
    'Australia Passport Number': '[REDACTED_PASSPORT]',
    'Australia Driver\'s License Number': '[REDACTED_LICENCE]',
    'Australia Bank Account Number': '[REDACTED_ACCOUNT]',
    'Credit Card Number': '[REDACTED_CARD]',
    'Email Address': '[REDACTED_EMAIL]',
    'IP Address': '[REDACTED_IP]',
    'Person Name': '[REDACTED_NAME]',
    'Phone Number': '[REDACTED_PHONE]',
    'Physical Address': '[REDACTED_ADDRESS]',
    'All Full Names': '[REDACTED_NAME]',
    'Date of Birth': '[REDACTED_DOB]',
    'SWIFT Code': '[REDACTED_FINANCIAL]',
  };

  class PurviewProvider extends BaseProvider {
    constructor(config = {}) {
      super({
        id: 'purview',
        name: 'Microsoft Purview DLP',
        tier: TIERS.CLOUD || 'cloud',
        capabilities: [
          CAPS.TEXT || 'text',
          CAPS.DOCX || 'docx',
          CAPS.XLSX || 'xlsx',
          CAPS.IMAGE || 'image',
          CAPS.PDF || 'pdf',
        ],
        priority: 60, // Cloud tier, lower than Azure PII (which is text-specific)
        enabled: config.enabled || false,
        settings: {
          tenantId: '',
          clientId: '',
          clientSecret: '',       // For service principal auth
          accessToken: '',        // Pre-obtained OAuth token
          graphEndpoint: 'https://graph.microsoft.com/v1.0',
          useDelegatedAuth: false, // Use interactive user auth vs app-only
          dlpPolicyId: '',        // Specific DLP policy to evaluate against
          sensitiveInfoTypes: [], // Filter to specific SITs; empty = all
          ...(config.settings || {}),
        },
      });
      this._tokenExpiry = null;
      this._cachedToken = null;
    }

    async checkAvailability() {
      if (!this.settings.tenantId) {
        return { available: false, status: 'no', detail: 'Purview tenant ID not configured' };
      }
      if (!this.settings.accessToken && !this.settings.clientSecret) {
        return { available: false, status: 'no', detail: 'No authentication configured' };
      }
      try {
        const token = await this._getAccessToken();
        const response = await fetch(
          `${this.settings.graphEndpoint}/security/informationProtection/sensitivityLabels`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        return {
          available: response.ok,
          status: response.ok ? 'readily' : 'no',
          detail: response.ok ? 'Purview endpoint accessible' : `HTTP ${response.status}`,
        };
      } catch (err) {
        return { available: false, status: 'no', detail: err.message };
      }
    }

    async _getAccessToken() {
      // Use pre-set token if available and not expired
      if (this.settings.accessToken) {
        return this.settings.accessToken;
      }

      // Use cached token if still valid
      if (this._cachedToken && this._tokenExpiry && Date.now() < this._tokenExpiry) {
        return this._cachedToken;
      }

      // Obtain token via client credentials flow
      const tokenUrl = `https://login.microsoftonline.com/${this.settings.tenantId}/oauth2/v2.0/token`;
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        throw new Error(`Purview auth failed: HTTP ${response.status}`);
      }

      const data = await response.json();
      this._cachedToken = data.access_token;
      this._tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      return this._cachedToken;
    }

    async redactText(text, piiTypes, settings) {
      const token = await this._getAccessToken();

      // Use the content classification API to detect sensitive info types
      const url = `${this.settings.graphEndpoint}/security/informationProtection/sensitivityLabels/evaluateClassificationResults`;

      const body = {
        contentInfo: {
          '@odata.type': '#microsoft.graph.security.contentInfo',
          format: 'default',
          identifier: null,
          state: 'rest',
          content: text,
          contentFormat: 'text',
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Purview API error: ${response.status} - ${errBody}`);
      }

      const result = await response.json();
      return this._processClassificationResult(text, result);
    }

    async redactDocument(content, contentType, piiTypes, settings) {
      const token = await this._getAccessToken();

      // For documents, use the file-based classification endpoint
      const base64Content = typeof content === 'string'
        ? btoa(content)
        : btoa(String.fromCharCode(...new Uint8Array(content)));

      const mimeMap = {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        image: 'image/png',
        pdf: 'application/pdf',
      };

      const url = `${this.settings.graphEndpoint}/security/informationProtection/sensitivityLabels/evaluateClassificationResults`;

      const body = {
        contentInfo: {
          '@odata.type': '#microsoft.graph.security.contentInfo',
          format: 'default',
          state: 'rest',
          content: base64Content,
          contentFormat: mimeMap[contentType] || 'application/octet-stream',
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Purview document API error: ${response.status}`);
      }

      const result = await response.json();
      return this._processClassificationResult(
        typeof content === 'string' ? content : '[binary document]',
        result
      );
    }

    _processClassificationResult(originalText, result) {
      const matches = [];
      const sensitiveTypes = result.sensitiveTypeAssessments || result.value || [];

      for (const assessment of sensitiveTypes) {
        const sitName = assessment.sensitiveType?.name || assessment.displayName || '';
        const token = PURVIEW_SIT_MAP[sitName] || `[REDACTED_${sitName.toUpperCase().replace(/\s+/g, '_')}]`;
        const locations = assessment.locations || assessment.matches || [];

        for (const location of locations) {
          matches.push({
            typeId: `purview_${sitName.toLowerCase().replace(/\s+/g, '_')}`,
            token,
            original: location.matchedText || location.text || '',
            index: location.offset || 0,
            confidence: assessment.confidence || assessment.confidenceLevel || 0,
            purviewSitName: sitName,
          });
        }
      }

      // Apply redactions to text
      let redacted = originalText;
      const sortedMatches = [...matches]
        .filter(m => m.original && m.original.length > 0)
        .sort((a, b) => b.index - a.index);

      for (const match of sortedMatches) {
        if (match.index >= 0 && match.index < redacted.length) {
          const before = redacted.slice(0, match.index);
          const after = redacted.slice(match.index + match.original.length);
          redacted = before + match.token + after;
        }
      }

      return {
        redacted,
        engine: this.id,
        matches,
        metadata: {
          sensitiveTypesDetected: sensitiveTypes.length,
          provider: 'Microsoft Purview',
        },
      };
    }

    async destroy() {
      this._cachedToken = null;
      this._tokenExpiry = null;
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.LLSS_PurviewProvider = PurviewProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = { PurviewProvider, PURVIEW_SIT_MAP };
})();
