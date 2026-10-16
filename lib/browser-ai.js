/**
 * Browser built-in AI compatibility layer.
 *
 * Chromium browsers expose the Prompt API through the LanguageModel global,
 * but model branding and the set of accepted capability options differ across
 * release channels. Text redaction only needs the common API surface, so this
 * module deliberately uses the portable calls documented by both Chrome and
 * Microsoft Edge: availability(), create(), prompt(), and destroy().
 */

(function () {
  'use strict';

  const READY_STATES = new Set([
    'available',
    'downloadable',
    // Older Prompt API names retained for supported Chrome deployments.
    'readily',
    'after-download',
  ]);

  function getLanguageModel(scope) {
    const env = scope || (typeof globalThis !== 'undefined' ? globalThis : {});
    const model = env.LanguageModel;
    return (model && (typeof model === 'object' || typeof model === 'function'))
      ? model
      : null;
  }

  function hasLanguageModel(scope) {
    const model = getLanguageModel(scope);
    return !!model
      && typeof model.availability === 'function'
      && typeof model.create === 'function';
  }

  function normaliseAvailability(status) {
    const value = typeof status === 'string' ? status : 'unavailable';
    const detailMap = {
      available: 'Model ready',
      readily: 'Model ready',
      downloadable: 'Model available after download',
      'after-download': 'Model available after download',
      downloading: 'Model is downloading',
      unavailable: 'Model not available',
      no: 'Model not available',
    };
    return {
      available: READY_STATES.has(value),
      status: value,
      detail: detailMap[value] || 'Model not available',
    };
  }

  /** Check text-model availability using the cross-browser Prompt API. */
  async function checkTextAvailability(scope) {
    const model = getLanguageModel(scope);
    if (!model || typeof model.availability !== 'function') {
      return {
        available: false,
        status: 'unavailable',
        detail: 'Browser on-device Prompt API not present',
      };
    }
    try {
      // Text is the default Prompt API modality. Avoid browser-specific
      // expectedInputs/expectedOutputs dictionaries here: Edge and Chrome
      // release channels have not always shipped them in lockstep.
      return normaliseAvailability(await model.availability());
    } catch (err) {
      return {
        available: false,
        status: 'unavailable',
        detail: err?.message || 'Unable to query the browser on-device model',
      };
    }
  }

  /**
   * Create a text session using only options common to Chromium Prompt API
   * implementations. Callers may supply initialPrompts, monitor, or signal.
   */
  async function createTextSession(options = {}, scope) {
    const model = getLanguageModel(scope);
    if (!model || typeof model.create !== 'function') {
      throw new Error('Browser on-device Prompt API not present');
    }
    return model.create({ ...options });
  }

  function detectBrowser(navigatorLike) {
    const nav = navigatorLike
      || (typeof navigator !== 'undefined' ? navigator : null);
    const brands = nav?.userAgentData?.brands || [];
    const brandText = brands.map((entry) => entry?.brand || '').join(' ');
    const ua = nav?.userAgent || '';

    if (/Microsoft Edge/i.test(brandText) || /Edg\//.test(ua)) return 'edge';
    if (/Google Chrome/i.test(brandText) || /Chrom(?:e|ium)\//.test(ua)) return 'chrome';
    return 'unknown';
  }

  function providerName(navigatorLike) {
    switch (detectBrowser(navigatorLike)) {
      case 'edge': return 'Microsoft Edge On-Device AI (Local)';
      case 'chrome': return 'Chrome On-Device AI (Local)';
      default: return 'Browser On-Device AI (Local)';
    }
  }

  const api = {
    getLanguageModel,
    hasLanguageModel,
    normaliseAvailability,
    checkTextAvailability,
    createTextSession,
    detectBrowser,
    providerName,
  };

  if (typeof globalThis !== 'undefined') globalThis.LLSS_BrowserAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
