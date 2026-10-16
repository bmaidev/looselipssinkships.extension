// background.js — Core service worker for the Loose Lips Sink Ships extension.
// Thin orchestrator: loads providers, initialises the pipeline, routes messages.
// Architecture: LOCAL (browser AI + Regex) → HOSTED (org models) → CLOUD (Azure)

importScripts(
  "lib/debug.js",
  "lib/binary-transfer.js",
  "lib/browser-ai.js",
  "lib/pii-types.js",
  "lib/regex-engine.js",
  "lib/vector-engine.js",
  "lib/settings.js",
  "lib/redaction-engine.js",
  "lib/site-filter.js",
  "lib/ai-entity-parser.js",
  "lib/azure-auth.js",
  "lib/azure-native-doc.js",
  "lib/purview-gate.js",
  "lib/providers/base-provider.js",
  "lib/providers/local-ai-provider.js",
  "lib/providers/regex-provider.js",
  "lib/providers/azure-pii-provider.js",
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
const MAX_TEXT_CHARS = 1_000_000;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const PRIVILEGED_MESSAGE_TYPES = new Set([
  "CHECK_STATUS", "GET_SETTINGS", "SAVE_SETTINGS", "GET_STATS", "RESET_STATS",
  "TEST_REGEX", "GET_PROVIDERS", "CHECK_PROVIDER", "DESTROY_SESSION",
  "REFRESH_REMOTE_CONFIG", "AZURE_SIGN_IN", "AZURE_SIGN_OUT", "AZURE_AUTH_STATUS",
]);

function isTrustedExtensionSender(sender) {
  const extensionOrigin = chrome.runtime.getURL("");
  return sender?.id === chrome.runtime.id &&
    !sender.tab &&
    (typeof sender.url !== "string" || sender.url.startsWith(extensionOrigin));
}

function contentSettings(settings) {
  const allowed = [
    "detectionMode", "regexAfterAi", "showRedactButton", "enableContentEditable",
    "enableDocumentUpload", "aiChatGuard", "autoRedact", "submitGuard",
    "uploadGuard", "voiceDetection", "voiceDictation", "reversibleTokenization",
  ];
  return Object.fromEntries(allowed.map((key) => [key, settings[key]]));
}

async function restrictStorageToExtensionContexts() {
  const trustedOnly = { accessLevel: "TRUSTED_CONTEXTS" };
  for (const area of [chrome.storage.local, chrome.storage.managed, chrome.storage.sync]) {
    if (typeof area?.setAccessLevel !== "function") continue;
    try {
      await area.setAccessLevel(trustedOnly);
    } catch (err) {
      LLSS_debug.warn("storage", "Could not restrict a storage area:", err.message);
    }
  }
}

function broadcastSettingsUpdated() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED" }).catch(() => {});
    }
  });
}

function hasPrefix(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

function validateDocumentSignature(fileData, contentType) {
  const bytes = new Uint8Array(fileData);
  if (['docx', 'xlsx', 'zip'].includes(contentType)) {
    if (!hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new Error('File content is not a valid ZIP/Office document');
    if (contentType === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (contentType === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return 'application/zip';
  }
  if (contentType === 'pdf') {
    if (!hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new Error('File content is not a valid PDF');
    return 'application/pdf';
  }
  if (contentType === 'image') {
    if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (hasPrefix(bytes, [0x42, 0x4d])) return 'image/bmp';
    if (hasPrefix(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
    if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    throw new Error('File content is not a supported image');
  }
  if (['text', 'csv', 'html', 'markdown'].includes(contentType)) {
    if (bytes.includes(0)) throw new Error('Text document contains binary data');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Text document is not valid UTF-8');
    }
    return contentType === 'csv' ? 'text/csv' : 'text/plain';
  }
  throw new Error('Unsupported document type');
}

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

  // Browser on-device AI — always registered, enabled by default.
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

// Provider replacement is destructive (the old sessions are torn down), so
// serialise refreshes and make all consumers await the current generation.
let providerInitPromise = Promise.resolve();

function scheduleProviderInit() {
  const operation = providerInitPromise
    .catch(() => {})
    .then(() => initProviders());
  providerInitPromise = operation;
  return operation;
}

async function waitForProviders() {
  if (extensionInitialization) {
    await extensionInitialization;
    return;
  }
  await providerInitPromise;
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
  renderAndOcr: (data) => sendToOffscreen('RENDER_AND_OCR', {
    ...data,
    fileData: undefined,
    fileDataBase64: LLSS_BinaryTransfer.toBase64(data.fileData, MAX_DOCUMENT_BYTES),
  }, 10 * 60_000),
  applyRedactions: async (data) => {
    const response = await sendToOffscreen('APPLY_REDACTIONS', data, 10 * 60_000);
    return {
      ...response,
      fileBase64: undefined,
      file: LLSS_BinaryTransfer.fromBase64(response.fileBase64, MAX_DOCUMENT_BYTES),
    };
  },
};

// ── Progress forwarding ─────────────────────────────────────────────────────
// Track which tab is currently processing, so we can forward OCR_PROGRESS
// messages from the offscreen document to the right content script.

let processingTabId = null;
let pendingDocumentJobs = 0;
let documentJobQueue = Promise.resolve();

function enqueueDocumentJob(operation) {
  if (pendingDocumentJobs >= 2) {
    return Promise.reject(new Error('Document processor is busy; try again when the current files finish'));
  }
  pendingDocumentJobs++;
  const job = documentJobQueue.catch(() => {}).then(operation);
  documentJobQueue = job.then(() => undefined, () => undefined);
  return job.finally(() => { pendingDocumentJobs--; });
}

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
    LLSS_debug.log("session", "Idle timeout — local AI session destroyed.");
  }, timeout);
}

// ── Main redaction handlers ─────────────────────────────────────────────────

async function handleRedactText(text, options = {}) {
  if (typeof text !== "string") throw new Error("Text must be a string");
  if (text.length > MAX_TEXT_CHARS) throw new Error("Text exceeds the 1,000,000 character safety limit");
  await waitForProviders();
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
  if (!(fileData instanceof ArrayBuffer)) throw new Error("Document data is invalid");
  if (fileData.byteLength === 0) throw new Error("Document is empty");
  if (fileData.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds the 25 MiB safety limit");
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 255) {
    throw new Error("Document name is invalid");
  }
  await waitForProviders();
  const settings = await LLSS_loadSettings();
  const piiTypes = LLSS_getMergedPiiTypes(LLSS_PII_TYPES, settings);

  const contentType = LLSS_detectContentType(fileName, mimeType);
  if (!contentType) {
    throw new Error(`Unsupported file type: ${fileName} (${mimeType})`);
  }
  const verifiedMimeType = validateDocumentSignature(fileData, contentType);

  const enabledPiiTypes = piiTypes.filter(t => t.enabled);
  LLSS_debug.log("doc", `Processing ${contentType} document, ${enabledPiiTypes.length} PII types enabled`);

  // Classification gate: check if file is blocked by sensitivity label
  if (LLSS_PurviewGate && settings.providers?.purview?.gateEnabled) {
    const gateResult = await LLSS_PurviewGate.evaluateGate(
      fileData, fileName, mimeType, contentType, settings.providers.purview
    );
    if (!gateResult.allowed) {
      LLSS_debug.log("purview-gate", `BLOCKED: ${gateResult.reason}`);
      throw new Error(`CLASSIFICATION_BLOCKED:${gateResult.label || 'Unknown'}:${gateResult.reason}`);
    }
    if (gateResult.severity === 'warned') {
      LLSS_debug.log("purview-gate", `WARNING: ${gateResult.reason}`);
      // Warning is noted but processing continues
    }
  }

  const result = await LLSS_pipelineRedactDocument(fileData, contentType, {
    registry,
    piiTypes: enabledPiiTypes,
    settings,
    fileName,
    verifiedMimeType,
    forceProvider: options.forceProvider,
    forceTier: options.forceTier,
    offscreenProcessor,
  });

  LLSS_debug.log("doc", `Result: engine=${result.engine} matches=${result.matches?.length} redacted_len=${result.redacted?.length} steps=[${result.pipelineSteps?.join("→")}]`);
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
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    sendResponse({ success: false, error: "Invalid message" });
    return false;
  }
  if (PRIVILEGED_MESSAGE_TYPES.has(message.type) && !isTrustedExtensionSender(_sender)) {
    sendResponse({ success: false, error: "This operation is only available to extension pages" });
    return false;
  }
  resetIdleTimer();
  LLSS_debug.log("msg", `← ${message.type}`, message.target ? `(target: ${message.target})` : "");

  switch (message.type) {
    case "CHECK_STATUS": {
      (async () => {
        try {
          await waitForProviders();
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
            matches: result.matches || [],
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
      if (pendingDocumentJobs >= 2) {
        sendResponse({ success: false, error: "Document processor is busy; try again when the current files finish" });
        return false;
      }
      let buffer;
      try {
        const bytes = LLSS_BinaryTransfer.fromBase64(message.fileDataBase64, MAX_DOCUMENT_BYTES);
        buffer = bytes.buffer;
      } catch {
        sendResponse({ success: false, error: "Document data is invalid or exceeds the 25 MiB safety limit" });
        return false;
      }
      LLSS_debug.log("doc", `REDACT_DOCUMENT: ${message.mimeType || "unknown"}, ${buffer.byteLength} bytes`);
      const requestingTabId = _sender.tab?.id || null;

      enqueueDocumentJob(async () => {
        startKeepAlive();
        processingTabId = requestingTabId;
        try {
          const result = await handleRedactDocument(buffer, message.fileName, message.mimeType, {
            forceProvider: message.forceProvider,
            forceTier: message.forceTier,
          });
          LLSS_debug.log("doc", `REDACT_DOCUMENT complete: engine=${result.engine} matches=${result.matches?.length || 0} steps=[${result.pipelineSteps?.join("→")}]`);
          const redactedFile = result.redactedFile
            ? LLSS_BinaryTransfer.toBase64(new Uint8Array(result.redactedFile), MAX_DOCUMENT_BYTES)
            : null;
          return {
            success: true,
            redacted: typeof result.redacted === "string" ? result.redacted.slice(0, 10_000) : "",
            redactedPreviewTruncated: typeof result.redacted === "string" && result.redacted.length > 10_000,
            engine: result.engine,
            tier: result.tier,
            matchCount: result.matches?.length || 0,
            pipelineSteps: result.pipelineSteps,
            redactedFileBase64: redactedFile,
            redactedFileFormat: result.redactedFileFormat || null,
          };
        } finally {
          processingTabId = null;
          stopKeepAlive();
        }
      })
        .then(sendResponse)
        .catch((err) => {
          LLSS_debug.error("doc", "REDACT_DOCUMENT failed:", err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    case "OCR_PROGRESS": {
      if (!isTrustedExtensionSender(_sender)) return false;
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

    case "GET_CONTENT_SETTINGS": {
      LLSS_loadSettings().then((settings) => sendResponse({ settings: contentSettings(settings) }));
      return true;
    }

    case "SAVE_SETTINGS": {
      LLSS_saveSettings(message.settings)
        .then(async () => {
          // Reinitialise providers with new config
          await scheduleProviderInit();
          broadcastSettingsUpdated();
          sendResponse({ success: true });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case "REFRESH_REMOTE_CONFIG": {
      LLSS_fetchRemoteConfig(message.url)
        .then(async (config) => {
          if (!config) throw new Error("Remote configuration could not be loaded");
          await scheduleProviderInit();
          broadcastSettingsUpdated();
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
      waitForProviders()
        .then(() => registry.getStatusSummary())
        .then((summary) => sendResponse({ providers: summary }))
        .catch((err) => sendResponse({ providers: [], error: err.message }));
      return true;
    }

    case "CHECK_PROVIDER": {
      waitForProviders()
        .then(() => registry.checkAvailability(message.providerId, true))
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
      LLSS_mutateStats((stats) => {
        stats.autoRedactions = (stats.autoRedactions || 0) + 1;
        stats.totalMatches += (message.matchCount || 0);
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false, error: "Could not update statistics" }));
      return true;
    }

    case "RECORD_SUBMIT_INTERCEPT": {
      LLSS_mutateStats((stats) => {
        stats.submitsIntercepted = (stats.submitsIntercepted || 0) + 1;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false, error: "Could not update statistics" }));
      return true;
    }

    case "RECORD_UPLOAD_INTERCEPT": {
      LLSS_mutateStats((stats) => {
        stats.uploadsIntercepted = (stats.uploadsIntercepted || 0) + 1;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false, error: "Could not update statistics" }));
      return true;
    }

    case "CHECK_DICTATION_CAPABILITY": {
      sendToOffscreen("CHECK_TRANSCRIBE_AUDIO", {}, 15_000)
        .then((result) => sendResponse({
          available: result?.available === true,
          state: result?.state || "unavailable",
        }))
        .catch(() => sendResponse({ available: false, state: "unavailable" }));
      return true;
    }

    case "DICTATE_AUDIO": {
      let audioBytes;
      try {
        audioBytes = LLSS_BinaryTransfer.fromBase64(message.audioBase64, MAX_AUDIO_BYTES);
      } catch {
        sendResponse({ success: false, error: "Audio data is invalid or exceeds the 10 MiB safety limit" });
        return false;
      }
      // Transcribe a captured audio clip with the browser's on-device model,
      // then redact the transcript through the normal pipeline.
      const dictDone = LLSS_debug.time("dictate", `audio (${audioBytes.byteLength} bytes)`);
      sendToOffscreen("TRANSCRIBE_AUDIO", {
        audioBase64: message.audioBase64,
        mime: message.mime,
      })
        .then(async (res) => {
          const transcript = (res?.transcript || "").trim();
          if (!transcript) {
            dictDone();
            sendResponse({ success: true, redacted: "", matchCount: 0 });
            return;
          }
          const result = await handleRedactText(transcript, {});
          dictDone();
          LLSS_debug.log("dictate", `transcript=${transcript.length}ch engine=${result.engine} matches=${result.matches?.length || 0}`);
          sendResponse({
            success: true,
            redacted: result.redacted,
            engine: result.engine,
            tier: result.tier,
            matchCount: result.matches?.length || 0,
          });
        })
        .catch((err) => {
          dictDone();
          LLSS_debug.error("dictate", "DICTATE_AUDIO failed:", err.message);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    case "RECORD_VOICE_CAPTURE_DETECTED": {
      LLSS_mutateStats((stats) => {
        stats.voiceCapturesDetected = (stats.voiceCapturesDetected || 0) + 1;
      }).then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false, error: "Could not update statistics" }));
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
        .then(() => scheduleProviderInit())
        .then(() => sendResponse({ success: true }))
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
      if (pendingDocumentJobs === 0) stopKeepAlive();
    });
  }
});

// ── Managed storage change listener ──────────────────────────────────────────
// When enterprise admin pushes a policy update via GPO/Intune/Workspace,
// reinitialise providers and notify all content scripts immediately.

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "managed") {
    LLSS_debug.log("policy", "Managed storage changed:", Object.keys(changes));
    scheduleProviderInit().catch((err) => LLSS_debug.error("init", "Policy refresh failed:", err.message));
    broadcastSettingsUpdated();
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
      LLSS_debug.log("remote-config", "Periodic refresh requested");
      await LLSS_fetchRemoteConfig(settings.configUrl);
      await scheduleProviderInit();
      broadcastSettingsUpdated();
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

let extensionInitialization = null;
function initializeExtension() {
  if (!extensionInitialization) {
    extensionInitialization = (async () => {
      await restrictStorageToExtensionContexts();
      await setupRemoteConfigAlarm();
      await scheduleProviderInit();
    })().catch((err) => {
      extensionInitialization = null;
      LLSS_debug.error("init", "Extension initialisation failed:", err.message);
      throw err;
    });
  }
  return extensionInitialization;
}

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension().catch(() => {});
});

// Also initialise on service worker startup (covers restarts).
initializeExtension().catch(() => {});
