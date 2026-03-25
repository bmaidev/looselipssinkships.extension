// background.js — Core service worker for the Loose Lips Sink Ships extension.
// Thin orchestrator: loads providers, initialises the pipeline, routes messages.
// Architecture: LOCAL (Gemini Nano + Regex) → HOSTED (org models) → CLOUD (Azure/Purview)

importScripts(
  "lib/pii-types.js",
  "lib/regex-engine.js",
  "lib/vector-engine.js",
  "lib/settings.js",
  "lib/redaction-engine.js",
  "lib/providers/base-provider.js",
  "lib/providers/local-ai-provider.js",
  "lib/providers/regex-provider.js",
  "lib/providers/azure-pii-provider.js",
  "lib/providers/purview-provider.js",
  "lib/providers/hosted-model-provider.js",
  "lib/providers/provider-registry.js",
  "lib/documents/document-processor.js",
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

  // Local AI (Gemini Nano) — always registered, enabled by default
  registry.register(new LLSS_LocalAiProvider({
    enabled: providerConfig.local_ai?.enabled !== false,
    settings: { sessionTimeoutMinutes: settings.sessionTimeoutMinutes },
  }));

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

  console.log("[LLSS] Providers initialised:", registry.getAll().map(p => `${p.id}(${p.tier})`).join(", "));
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

  const result = await LLSS_pipelineRedactDocument(fileData, contentType, {
    registry,
    piiTypes: piiTypes.filter(t => t.enabled),
    settings,
    forceProvider: options.forceProvider,
    forceTier: options.forceTier,
  });

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

  switch (message.type) {
    case "CHECK_STATUS": {
      (async () => {
        try {
          const settings = await LLSS_loadSettings();
          const statusSummary = await registry.getStatusSummary();
          const localAi = statusSummary.find(p => p.id === "local_ai");
          sendResponse({
            status: localAi?.status || "no",
            detectionMode: settings.detectionMode,
            providers: statusSummary,
          });
        } catch (err) {
          sendResponse({ status: "no", error: err.message });
        }
      })();
      return true;
    }

    case "REDACT": {
      handleRedactText(message.text, {
        forceProvider: message.forceProvider,
        forceTier: message.forceTier,
      })
        .then((result) =>
          sendResponse({
            success: true,
            redacted: result.redacted,
            engine: result.engine,
            tier: result.tier,
            matchCount: result.matches?.length || 0,
            pipelineSteps: result.pipelineSteps,
            escalated: result.escalated,
          })
        )
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      return true;
    }

    case "REDACT_DOCUMENT": {
      // fileData arrives as an array (serialised ArrayBuffer)
      const buffer = message.fileData instanceof ArrayBuffer
        ? message.fileData
        : new Uint8Array(message.fileData).buffer;

      handleRedactDocument(buffer, message.fileName, message.mimeType, {
        forceProvider: message.forceProvider,
        forceTier: message.forceTier,
      })
        .then((result) =>
          sendResponse({
            success: true,
            redacted: result.redacted,
            engine: result.engine,
            tier: result.tier,
            matchCount: result.matches?.length || 0,
            pipelineSteps: result.pipelineSteps,
            metadata: result.metadata,
          })
        )
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      return true;
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

    case "DESTROY_SESSION": {
      const localAi = registry.get("local_ai");
      if (localAi) localAi.destroy();
      sendResponse({ success: true });
      return false;
    }
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  initProviders();
});

// Also init on service worker startup (covers restarts)
initProviders();
