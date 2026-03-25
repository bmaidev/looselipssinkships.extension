/**
 * Provider Registry — manages all redaction providers and their lifecycle.
 * Handles provider registration, availability checks, and capability queries.
 */

(function () {
  const TIERS = globalThis.LLSS_PROVIDER_TIERS || (typeof require !== 'undefined' ? require('./base-provider').PROVIDER_TIERS : { LOCAL: 'local', HOSTED: 'hosted', CLOUD: 'cloud' });

  // Tier priority order: local first, then hosted, then cloud
  const TIER_ORDER = { local: 0, hosted: 1, cloud: 2 };

  class ProviderRegistry {
    constructor() {
      /** @type {Map<string, BaseProvider>} */
      this._providers = new Map();
      this._availabilityCache = new Map();
      this._cacheMaxAge = 30000; // 30s availability cache
    }

    /**
     * Register a provider instance.
     * @param {BaseProvider} provider
     */
    register(provider) {
      this._providers.set(provider.id, provider);
      this._availabilityCache.delete(provider.id);
    }

    /**
     * Unregister and destroy a provider.
     * @param {string} providerId
     */
    async unregister(providerId) {
      const provider = this._providers.get(providerId);
      if (provider) {
        await provider.destroy();
        this._providers.delete(providerId);
        this._availabilityCache.delete(providerId);
      }
    }

    /**
     * Get a specific provider by ID.
     * @param {string} providerId
     * @returns {BaseProvider|undefined}
     */
    get(providerId) {
      return this._providers.get(providerId);
    }

    /**
     * Get all registered providers.
     * @returns {BaseProvider[]}
     */
    getAll() {
      return Array.from(this._providers.values());
    }

    /**
     * Get providers that support a given content type, sorted by routing preference.
     * Sort order: enabled first, then by tier (local > hosted > cloud), then by priority.
     * @param {string} contentType - e.g., 'text', 'docx', 'image'
     * @returns {BaseProvider[]}
     */
    getForContentType(contentType) {
      return this.getAll()
        .filter(p => p.supports(contentType))
        .sort((a, b) => {
          // Enabled providers first
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          // Then by tier order
          const tierDiff = (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99);
          if (tierDiff !== 0) return tierDiff;
          // Then by priority (lower = better)
          return a.priority - b.priority;
        });
    }

    /**
     * Get providers by tier.
     * @param {string} tier
     * @returns {BaseProvider[]}
     */
    getByTier(tier) {
      return this.getAll()
        .filter(p => p.tier === tier)
        .sort((a, b) => a.priority - b.priority);
    }

    /**
     * Check availability of a specific provider (with caching).
     * @param {string} providerId
     * @param {boolean} [skipCache=false]
     * @returns {Promise<{available: boolean, status: string, detail?: string}>}
     */
    async checkAvailability(providerId, skipCache = false) {
      const provider = this._providers.get(providerId);
      if (!provider) {
        return { available: false, status: 'no', detail: 'Provider not registered' };
      }
      if (!provider.enabled) {
        return { available: false, status: 'disabled', detail: 'Provider disabled' };
      }

      // Check cache
      if (!skipCache) {
        const cached = this._availabilityCache.get(providerId);
        if (cached && (Date.now() - cached.timestamp) < this._cacheMaxAge) {
          return cached.result;
        }
      }

      const result = await provider.checkAvailability();
      this._availabilityCache.set(providerId, { result, timestamp: Date.now() });
      return result;
    }

    /**
     * Check availability of all enabled providers.
     * @returns {Promise<Map<string, {available: boolean, status: string, detail?: string}>>}
     */
    async checkAllAvailability() {
      const results = new Map();
      const checks = this.getAll()
        .filter(p => p.enabled)
        .map(async (p) => {
          const result = await this.checkAvailability(p.id);
          results.set(p.id, result);
        });
      await Promise.allSettled(checks);
      return results;
    }

    /**
     * Find the best available provider for a content type.
     * Follows the progressive processing rule: local → hosted → cloud.
     * @param {string} contentType
     * @param {Object} [options]
     * @param {string} [options.preferredTier] - Force a specific tier
     * @param {string[]} [options.excludeProviders] - Provider IDs to skip
     * @returns {Promise<BaseProvider|null>}
     */
    async findBestProvider(contentType, options = {}) {
      const candidates = this.getForContentType(contentType)
        .filter(p => p.enabled)
        .filter(p => !(options.excludeProviders || []).includes(p.id));

      // If preferred tier specified, try that first
      if (options.preferredTier) {
        const tierCandidates = candidates.filter(p => p.tier === options.preferredTier);
        for (const provider of tierCandidates) {
          const avail = await this.checkAvailability(provider.id);
          if (avail.available) return provider;
        }
      }

      // Otherwise, try in order (local → hosted → cloud)
      for (const provider of candidates) {
        const avail = await this.checkAvailability(provider.id);
        if (avail.available) return provider;
      }

      return null;
    }

    /**
     * Get a status summary of all providers for the UI.
     * @returns {Promise<Array<{id, name, tier, enabled, available, status, capabilities}>>}
     */
    async getStatusSummary() {
      const summary = [];
      for (const provider of this.getAll()) {
        const avail = provider.enabled
          ? await this.checkAvailability(provider.id)
          : { available: false, status: 'disabled' };
        summary.push({
          ...provider.toJSON(),
          available: avail.available,
          status: avail.status,
          detail: avail.detail,
        });
      }
      return summary;
    }

    /**
     * Destroy all providers and clear registry.
     */
    async destroyAll() {
      for (const provider of this._providers.values()) {
        await provider.destroy();
      }
      this._providers.clear();
      this._availabilityCache.clear();
    }

    /**
     * Clear the availability cache.
     */
    clearCache() {
      this._availabilityCache.clear();
    }
  }

  if (typeof globalThis !== 'undefined') globalThis.LLSS_ProviderRegistry = ProviderRegistry;
  if (typeof module !== 'undefined' && module.exports) module.exports = { ProviderRegistry, TIER_ORDER };
})();
