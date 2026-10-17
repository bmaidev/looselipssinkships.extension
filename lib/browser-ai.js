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
    // Older Prompt API name retained for supported Chrome deployments.
    'readily',
  ]);
  const DOWNLOADABLE_STATES = new Set(['downloadable', 'after-download']);

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
      canDownload: DOWNLOADABLE_STATES.has(value),
      downloading: value === 'downloading',
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

  /**
   * Convert Prompt API download progress variants to a stable 0..1 fraction.
   * Chrome has exposed `loaded` as a fraction, while other implementations may
   * also provide a byte-like `total`. Unknown progress remains null rather than
   * presenting a made-up percentage.
   */
  function normaliseDownloadProgress(event) {
    const loaded = Number(event?.loaded);
    const total = Number(event?.total);
    let fraction = null;

    if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
      fraction = loaded / total;
    } else if (Number.isFinite(loaded) && loaded >= 0 && loaded <= 1) {
      fraction = loaded;
    }

    return fraction === null ? null : Math.min(1, Math.max(0, fraction));
  }

  /**
   * Start or resume the browser-managed model download from a user gesture.
   * The caller owns the consent UI; this helper only attaches the portable
   * Prompt API progress monitor and releases the verification session.
   */
  async function setupTextModel(options = {}, scope) {
    const { onProgress, signal } = options;
    const createOptions = {
      monitor(monitor) {
        if (!monitor || typeof monitor.addEventListener !== 'function') return;
        monitor.addEventListener('downloadprogress', (event) => {
          if (typeof onProgress === 'function') {
            onProgress(normaliseDownloadProgress(event), event);
          }
        });
      },
    };
    if (signal) createOptions.signal = signal;

    // Do not await availability first: create() must be invoked while the
    // setup-button user activation is still live in supporting browsers.
    const session = await createTextSession(createOptions, scope);
    try {
      if (typeof onProgress === 'function') onProgress(1, null);
    } finally {
      if (session && typeof session.destroy === 'function') session.destroy();
    }

    const result = await checkTextAvailability(scope);
    if (!result.available) {
      throw new Error(result.detail || 'The local model did not become ready');
    }
    return result;
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
    normaliseDownloadProgress,
    setupTextModel,
    detectBrowser,
    providerName,
  };

  if (typeof globalThis !== 'undefined') globalThis.LLSS_BrowserAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
