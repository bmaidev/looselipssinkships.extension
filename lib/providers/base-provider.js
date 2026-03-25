/**
 * Base provider interface for PII redaction engines.
 * All providers implement this contract.
 */

const PROVIDER_TIERS = {
  LOCAL: 'local',       // On-device processing (Gemini Nano, regex)
  HOSTED: 'hosted',     // Organisation-hosted models (on-prem / private cloud)
  CLOUD: 'cloud',       // Cloud APIs (Azure, Purview)
};

const PROVIDER_CAPABILITIES = {
  TEXT: 'text',
  DOCX: 'docx',
  XLSX: 'xlsx',
  IMAGE: 'image',
  HTML: 'html',
  MARKDOWN: 'markdown',
  PDF: 'pdf',
};

/**
 * @typedef {Object} RedactionResult
 * @property {string} redacted - The redacted content
 * @property {string} engine - Provider ID that performed the redaction
 * @property {Array<{typeId: string, token: string, original: string, index: number}>} matches
 * @property {Object} [metadata] - Provider-specific metadata
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} id - Unique provider identifier
 * @property {string} name - Display name
 * @property {string} tier - One of PROVIDER_TIERS
 * @property {boolean} enabled - Whether provider is active
 * @property {string[]} capabilities - Array of PROVIDER_CAPABILITIES
 * @property {number} priority - Lower = preferred (used in routing)
 * @property {Object} settings - Provider-specific configuration
 */

/**
 * Base class for all redaction providers.
 * Subclasses must implement checkAvailability(), redactText(), and optionally redactDocument().
 */
class BaseProvider {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.tier = config.tier;
    this.capabilities = config.capabilities || [PROVIDER_CAPABILITIES.TEXT];
    this.priority = config.priority ?? 100;
    this.enabled = config.enabled !== false;
    this.settings = config.settings || {};
  }

  /**
   * Check if this provider is currently available.
   * @returns {Promise<{available: boolean, status: string, detail?: string}>}
   */
  async checkAvailability() {
    throw new Error('checkAvailability() must be implemented by subclass');
  }

  /**
   * Redact PII from plain text.
   * @param {string} text - Input text
   * @param {Array} piiTypes - Enabled PII type definitions
   * @param {Object} settings - Current extension settings
   * @returns {Promise<RedactionResult>}
   */
  async redactText(text, piiTypes, settings) {
    throw new Error('redactText() must be implemented by subclass');
  }

  /**
   * Redact PII from a document.
   * @param {ArrayBuffer|string} content - Document content
   * @param {string} contentType - One of PROVIDER_CAPABILITIES
   * @param {Array} piiTypes - Enabled PII type definitions
   * @param {Object} settings - Current extension settings
   * @returns {Promise<RedactionResult>}
   */
  async redactDocument(content, contentType, piiTypes, settings) {
    throw new Error(`Provider ${this.id} does not support document redaction`);
  }

  /**
   * Check if this provider supports a given content type.
   * @param {string} contentType
   * @returns {boolean}
   */
  supports(contentType) {
    return this.capabilities.includes(contentType);
  }

  /**
   * Clean up resources (sessions, connections, etc.)
   */
  async destroy() {
    // Override if cleanup needed
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      tier: this.tier,
      capabilities: this.capabilities,
      priority: this.priority,
      enabled: this.enabled,
    };
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.LLSS_BaseProvider = BaseProvider;
  globalThis.LLSS_PROVIDER_TIERS = PROVIDER_TIERS;
  globalThis.LLSS_PROVIDER_CAPABILITIES = PROVIDER_CAPABILITIES;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BaseProvider, PROVIDER_TIERS, PROVIDER_CAPABILITIES };
}
