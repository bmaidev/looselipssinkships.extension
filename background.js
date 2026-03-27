// background.js — Core service worker for the Loose Lips Sink Ships extension.
// Thin orchestrator: loads providers, initialises the pipeline, routes messages.
// Architecture: LOCAL (Gemini Nano + Regex) → HOSTED (org models) → CLOUD (Azure/Purview)

importScripts(
  "lib/debug.js",
  "lib/pii-types.js",
  "lib/regex-engine.js",
  "lib/vector-engine.js",
  "lib/settings.js",
  "lib/redaction-engine.js",
  "lib/site-filter.js",
  "lib/azure-auth.js",
  "lib/azure-native-doc.js",
  "lib/purview-gate.js",
  "lib/providers/base-provider.js",
  "lib/providers/local-ai-provider.js",
  "lib/providers/regex-provider.js",
  "lib/providers/azure-pii-provider.js",
  "lib/providers/purview-provider.js",
  "lib/providers/hosted-model-provider.js",
  "lib/providers/provider-registry.js",
  "lib/documents/document-processor.js",
  "lib/documents/pixel-redactor.js",
  "lib/documents/zip-writer.js",
  "lib/documents/docx-redactor.js",
  "lib/pipeline.js"
);

// ── Provider Registry ──────────────────────────────────────────────────────

const registry = new LLSS_ProviderRegistry();

/**
 * Initialise providers from current settings.
 * Called on startup and whenever settings change.
 */
async function initProviders() {
  await registry.destroyAll();
  const settings = await LLSS_loadSettings();
  const providerConfig = settings.providers || {};

  // Activate debug mode from settings
  if (settings.debugMode) LLSS_debug.setEnabled(true);
  LLSS_debug.log("init", "Initialising providers", { debugMode: settings.debugMode });

  // Local AI (Gemini Nano) — always registered, enabled by default.
  // Service workers cannot access LanguageModel, so install a proxy that
  // routes availability checks and redaction calls through the offscreen
  // document (which has a full document context).
  const localAiProvider = new LLSS_LocalAiProvider({
    enabled: providerConfig.local_ai?.enabled !== false,
    settings: { sessionTimeoutMinutes: settings.sessionTimeoutMinutes },
  });
  localAiProvider.setProxy(async (msg) => {
    switch (msg.action) {
      case 'checkAvailability':
        return sendToOffscreen('NANO_CHECK_AVAILABILITY');
      case 'redactText':
        return sendToOffscreen('NANO_REDACT', {
          text: msg.text,
          piiTypes: msg.piiTypes,
          settings: msg.settings,
        });
      case 'destroy':
        return sendToOffscreen('NANO_DESTROY');
      default:
        throw new Error(`Unknown Nano proxy action: ${msg.action}`);
    }
  });
  registry.register(localAiProvider);

  // Regex — always registered, always enabled (ultimate fallback)
  registry.register(new LLSS_RegexProvider({
    settings: {},
  }));

  // Azure PII — only if configured
  if (providerConfig.azure_pii) {
    registry.register(new LLSS_AzurePiiProvider({
      enabled: providerConfig.azure_pii.enabled || false,
      settings: providerConfig.azure_pii,
    }));
  }

  // Purview — only if configured
  if (providerConfig.purview) {
    registry.register(new LLSS_PurviewProvider({
      enabled: providerConfig.purview.enabled || false,
      settings: providerConfig.purview,
    }));
  }

  // Hosted models — can have multiple instances
  const hostedConfigs = providerConfig.hosted || [];
  for (const hostedConfig of hostedConfigs) {
    if (hostedConfig.providerId) {
      registry.register(new LLSS_HostedModelProvider({
        enabled: hostedConfig.enabled || false,
        settings: hostedConfig,
      }));
    }
  }

  LLSS_debug.log("init", "Providers initialised:", registry.getAll().map(p => `${p.id}(${p.tier})`).join(", "));
}

// ── Offscreen Document Management ────────────────────────────────────────────

let offscreenReady = false;

async function ensureOffscreenDocument() {
  if (offscreenReady) return;

  // Check if an offscreen document already exists
  if (chrome.offscreen) {
    try {
      const contexts = await chrome.runtime.getContexts?.({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (contexts && contexts.length > 0) {
        offscreenReady = true;
        return;
      }
    } catch {
      // getContexts not available — try creating and catch if exists
    }

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER', 'WORKERS'],
        justification: 'PDF rendering (Canvas) and OCR (WASM) for PII redaction',
      });
      offscreenReady = true;
    } catch (err) {
      if (err.message?.includes('already exists') || err.message?.includes('Only a single')) {
        offscreenReady = true;
      } else {
        throw err;
      }
    }
  }
}

async function sendToOffscreen(type, data = {}, timeoutMs = 120000) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Offscreen ${type} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    chrome.runtime.sendMessage(
      { target: 'offscreen', type, ...data },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else if (response === undefined || response === null) {
          reject(new Error(`Offscreen document did not respond to ${type} (scripts may still be loading)`));
        } else {
          resolve(response);
        }
      }
    );
  });
}

/**
 * Offscreen processor interface — passed to the pipeline so it can
 * delegate Canvas/WASM work without knowing about Chrome's offscreen API.
 */
const offscreenProcessor = {
  renderAndOcr: (data) => sendToOffscreen('RENDER_AND_OCR', data),
  applyRedactions: (data) => sendToOffscreen('APPLY_REDACTIONS', data),
};

// ── Progress forwarding ─────────────────────────────────────────────────────
// Track which tab is currently processing, so we can forward OCR_PROGRESS
// messages from the offscreen document to the right content script.

let processingTabId = null;

// ── Service worker keep-alive ────────────────────────────────────────────────
// MV3 kills service workers after ~30s of inactivity.  Long-running operations
// (offscreen OCR, Nano sessions) need periodic pings to prevent termination.

let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  // Periodic chrome API calls prevent MV3 from killing the service worker.
  // We ping every 4 seconds (Chrome's idle threshold is ~5s of no API activity).
  keepAliveInterval = setInterval(() => {
    chrome.storage.local.get('__keepalive', () => {});
  }, 4000);
  LLSS_debug.log("keepalive", "Started (4s interval)");
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    LLSS_debug.log("keepalive", "Stopped");
  }
}

// ── Idle timer ──────────────────────────────────────────────────────────────

let idleTimer = null;

async function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  const settings = await LLSS_loadSettings();
  const timeout = (settings.sessionTimeoutMinutes || 5) * 60 * 1000;
  idleTimer = setTimeout(() => {
    const localAi = registry.get("local_ai");
    if (localAi) localAi.destroy();
    console.log("[LLSS] Idle timeout — local AI session destroyed.");
  }, timeout);
}

// ── Main redaction handlers ─────────────────────────────────────────────────

async function handleRedactText(text, options = {}) {
  const settings = await LLSS_loadSettings();
  const piiTypes = LLSS_getMergedPiiTypes(LLSS_PII_TYPES, settings);

  const result = await LLSS_pipelineRedactText(text, {
    registry,
    piiTypes: piiTypes.filter(t => t.enabled),
    settings,
    forceProvider: options.forceProvider,
    forceTier: options.forceTier,
    beltAndSuspenders: settings.regexAfterAi,
  });

  // Record statistics
  const engineKey = result.engine.includes("+") ? result.engine.split("+")[0] : result.engine;
  await LLSS_recordRedaction(engineKey, result.matches || [], {
    tier: result.tier,
  });

  return result;
}

async function handleRedactDocument(fileData, fileName, mimeType, options = {}) {
  const settings = await LLSS_loadSettings();
  const piiTypes = LLSS_getMergedPiiTypes(LLSS_PII_TYPES, settings);

  const contentType = LLSS_detectContentType(fileName, mimeType);
  if (!contentType) {
    throw new Error(`Unsupported file type: ${fileName} (${mimeType})`);
  }

  const enabledPiiTypes = piiTypes.filter(t => t.enabled);
  LLSS_debug.log("doc", `Processing ${contentType}: ${fileName}, ${enabledPiiTypes.length} PII types enabled`);

  // Classification gate: check if file is blocked by sensitivity label
  if (LLSS_PurviewGate && settings.providers?.purview?.gateEnabled) {
    const gateResult = await LLSS_PurviewGate.evaluateGate(
      fileData, fileName, mimeType, contentType, settings.providers.purview
    );
    if (!gateResult.allowed) {
      LLSS_debug.log("purview-gate", `BLOCKED: ${fileName} — ${gateResult.reason}`);
      throw new Error(`CLASSIFICATION_BLOCKED:${gateResult.label || 'Unknown'}:${gateResult.reason}`);
    }
    if (gateResult.severity === 'warned') {
      LLSS_debug.log("purview-gate", `WARNING: ${fileName} — ${gateResult.reason}`);
      // Warning is noted but processing continues
    }
  }

  const result = await LLSS_pipelineRedactDocument(fileData, contentType, {
    registry,
    piiTypes: enabledPiiTypes,
    settings,
    fileName,
    forceProvider: options.forceProvider,
    forceTier: options.forceTier,
    offscreenProcessor,
  });

  LLSS_debug.log("doc", `Result: engine=${result.engine} matches=${result.matches?.length} redacted_len=${result.redacted?.length} steps=[${result.pipelineSteps?.join("→")}]`);
  if (result.redacted) {
    LLSS_debug.log("doc", `Extracted text preview (first 200 chars): "${result.redacted.substring(0, 200)}"`);
  }

  // Record statistics
  const engineKey = result.engine.includes("+") ? result.engine.split("+")[0] : result.engine;
  await LLSS_recordRedaction(engineKey, result.matches || [], {
    tier: result.tier,
    documentType: contentType,
  });

  return result;
}

// ── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  resetIdleTimer();
  LLSS_debug.log("msg", `← ${message.type}`, message.target ? `(target: ${message.target})` : "");

  switch (message.type) {
    case "CHECK_STATUS": {
      (async () => {
        try {
          const settings = await LLSS_loadSettings();
          const statusSummary = await registry.getStatusSummary();
          const localAi = statusSummary.find(p => p.id === "local_ai");
          LLSS_debug.log("status", "local_ai status:", localAi?.status, localAi?.detail);
          sendResponse({
            status: localAi?.status || "no",
            detectionMode: settings.detectionMode,
            providers: statusSummary,
          });
        } catch (err) {
          LLSS_debug.error("status", "CHECK_STATUS failed:", err.message);
          sendResponse({ status: "no", error: err.message });
        }
      })();
      return true;
    }

    case "REDACT": {
      const redactDone = LLSS_debug.time("redact", `text (${message.text?.length || 0} chars)`);
      handleRedactText(message.text, {
        forceProvider: message.forceProvider,
        forceTier: message.forceTier,
      })
        .then((result) => {
          redactDone();
          LLSS_debug.log("redact", `engine=${result.engine} tier=${result.tier} matches=${result.matches?.length || 0} steps=[${result.pipelineSteps?.join("→")}]`);
          sendResponse({
            success: true,
            redacted: result.redacted,
            engine: result.engine,
            tier: result.tier,
            matchCount: result.matches?.length || 0,
            pipelineSteps: result.pipelineSteps,
            escalated: result.escalated,
          });
        })
        .catch((err) => {
          redactDone();
          LLSS_debug.error("redact", "REDACT failed:", err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    case "REDACT_DOCUMENT": {
      LLSS_debug.log("doc", `REDACT_DOCUMENT: ${message.fileName} (${message.mimeType}, ${message.fileData?.length || 0} bytes)`);
      startKeepAlive(); // Prevent service worker termination during long OCR
      // fileData arrives as an array (serialised ArrayBuffer)
      const buffer = message.fileData instanceof ArrayBuffer
        ? message.fileData
        : new Uint8Array(message.fileData).buffer;

      // Track the requesting tab so OCR_PROGRESS messages can be forwarded
      processingTabId = _sender.tab?.id || null;

      handleRedactDocument(buffer, message.fileName, message.mimeType, {
        forceProvider: message.forceProvider,
        forceTier: message.forceTier,
      })
        .then((result) => {
          stopKeepAlive();
          LLSS_debug.log("doc", `REDACT_DOCUMENT complete: engine=${result.engine} matches=${result.matches?.length || 0} steps=[${result.pipelineSteps?.join("→")}]`);
          processingTabId = null;
          sendResponse({
            success: true,
            redacted: result.redacted,
            engine: result.engine,
            tier: result.tier,
            matchCount: result.matches?.length || 0,
            pipelineSteps: result.pipelineSteps,
            metadata: result.metadata,
            redactedFile: result.redactedFile || null,
            redactedFileFormat: result.redactedFileFormat || null,
          });
        })
        .catch((err) => {
          stopKeepAlive();
          LLSS_debug.error("doc", "REDACT_DOCUMENT failed:", err.message);
          processingTabId = null;
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    case "OCR_PROGRESS": {
      // Forwarded from offscreen document → content script
      if (processingTabId) {
        chrome.tabs.sendMessage(processingTabId, {
          type: "REDACT_PROGRESS",
          phase: message.phase,
          currentPage: message.currentPage,
          totalPages: message.totalPages,
          completed: message.completed,
        }).catch(() => {}); // Tab may have closed
      }
      return false;
    }

    case "GET_SETTINGS": {
      LLSS_loadSettings().then((settings) => sendResponse({ settings }));
      return true;
    }

    case "SAVE_SETTINGS": {
      LLSS_saveSettings(message.settings)
        .then(async () => {
          // Reinitialise providers with new config
          await initProviders();
          sendResponse({ success: true });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case "GET_STATS": {
      LLSS_loadStats().then((stats) => sendResponse({ stats }));
      return true;
    }

    case "RESET_STATS": {
      LLSS_resetStats().then(() => sendResponse({ success: true }));
      return true;
    }

    case "TEST_REGEX": {
      const result = LLSS_testRegexPattern(
        message.pattern,
        message.flags,
        message.sampleText
      );
      sendResponse(result);
      return false;
    }

    case "GET_PROVIDERS": {
      registry.getStatusSummary()
        .then((summary) => sendResponse({ providers: summary }))
        .catch((err) => sendResponse({ providers: [], error: err.message }));
      return true;
    }

    case "CHECK_PROVIDER": {
      registry.checkAvailability(message.providerId, true)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ available: false, status: "no", detail: err.message }));
      return true;
    }

    case "CHECK_SITE": {
      LLSS_loadSettings().then((settings) => {
        const result = LLSS_getPageProtectionStatus(message.url, settings);
        sendResponse(result);
      });
      return true;
    }

    case "RECORD_AUTO_REDACTION": {
      LLSS_loadStats().then(async (stats) => {
        stats.autoRedactions = (stats.autoRedactions || 0) + 1;
        stats.totalMatches += (message.matchCount || 0);
        if (typeof chrome !== "undefined" && chrome.storage) {
          chrome.storage.local.set({ llss_stats: stats });
        }
        sendResponse({ success: true });
      });
      return true;
    }

    case "RECORD_SUBMIT_INTERCEPT": {
      LLSS_loadStats().then(async (stats) => {
        stats.submitsIntercepted = (stats.submitsIntercepted || 0) + 1;
        if (typeof chrome !== "undefined" && chrome.storage) {
          chrome.storage.local.set({ llss_stats: stats });
        }
        sendResponse({ success: true });
      });
      return true;
    }

    case "RECORD_UPLOAD_INTERCEPT": {
      LLSS_loadStats().then(async (stats) => {
        stats.uploadsIntercepted = (stats.uploadsIntercepted || 0) + 1;
        if (typeof chrome !== "undefined" && chrome.storage) {
          chrome.storage.local.set({ llss_stats: stats });
        }
        sendResponse({ success: true });
      });
      return true;
    }

    case "DESTROY_SESSION": {
      const localAi = registry.get("local_ai");
      if (localAi) localAi.destroy();
      sendResponse({ success: true });
      return false;
    }

    // ── Azure AD OAuth2 ─────────────────────────────────────────────
    case "AZURE_SIGN_IN": {
      LLSS_AzureAuth.signIn(message.tenantId, message.clientId)
        .then((userInfo) => sendResponse({ success: true, userInfo }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case "AZURE_SIGN_OUT": {
      LLSS_AzureAuth.signOut()
        .then(() => { initProviders(); sendResponse({ success: true }); })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case "AZURE_AUTH_STATUS": {
      (async () => {
        const signedIn = await LLSS_AzureAuth.isSignedIn();
        const userInfo = signedIn ? await LLSS_AzureAuth.getUserInfo() : null;
        sendResponse({ signedIn, userInfo });
      })();
      return true;
    }
  }
});

// ── Long-lived port connections ──────────────────────────────────────────────
// Content scripts open a port during document processing to keep the service
// worker alive. An open port prevents Chrome MV3 from terminating the worker.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'doc-processing') {
    LLSS_debug.log("keepalive", "Content script connected (doc-processing port)");
    startKeepAlive();
    port.onDisconnect.addListener(() => {
      LLSS_debug.log("keepalive", "Content script disconnected");
      stopKeepAlive();
    });
  }
});

// ── Managed storage change listener ──────────────────────────────────────────
// When enterprise admin pushes a policy update via GPO/Intune/Workspace,
// reinitialise providers and notify all content scripts immediately.

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "managed") {
    LLSS_debug.log("policy", "Managed storage changed:", Object.keys(changes));
    initProviders();
    // Broadcast to all tabs so content scripts refresh settings immediately
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" }).catch(() => {});
      }
    });
  }
});

// ── Remote config periodic refresh ──────────────────────────────────────────
// For small-business deployment: periodically fetch remote config from URL.

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "llss-azure-token-refresh") {
    LLSS_debug.log("azure-auth", "Token refresh alarm fired");
    await LLSS_AzureAuth.handleRefreshAlarm();
    return;
  }
  if (alarm.name === "llss-remote-config-refresh") {
    const settings = await LLSS_loadSettings();
    if (settings.configUrl) {
      LLSS_debug.log("remote-config", "Periodic refresh from:", settings.configUrl);
      await LLSS_fetchRemoteConfig(settings.configUrl);
      await initProviders();
    }
  }
});

async function setupRemoteConfigAlarm() {
  const settings = await LLSS_loadSettings();
  if (settings.configUrl) {
    chrome.alarms.create("llss-remote-config-refresh", { periodInMinutes: 360 }); // Every 6 hours
    LLSS_debug.log("remote-config", "Alarm set for periodic refresh (every 6h)");
    // Fetch immediately on startup
    await LLSS_fetchRemoteConfig(settings.configUrl);
  }
}

// ── Startup ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  initProviders();
  setupRemoteConfigAlarm();
});

// Also init on service worker startup (covers restarts)
initProviders();
setupRemoteConfigAlarm();
