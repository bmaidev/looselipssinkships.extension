// background.js — Core service worker for the Loose Lips Sink Ships extension.
// Manages the AI session lifecycle, loads settings, and orchestrates redaction
// through the engine chain (AI → Regex → Vector).

// Import library modules. In MV3 service workers, importScripts is synchronous.
importScripts(
  "lib/pii-types.js",
  "lib/regex-engine.js",
  "lib/vector-engine.js",
  "lib/settings.js",
  "lib/redaction-engine.js"
);

// ── AI Session Manager ──────────────────────────────────────────────────────

let session = null;
let aiAvailability = null; // cached availability status
let currentSystemPrompt = null;

async function checkAvailability() {
  try {
    if (!self.ai || !self.ai.languageModel) {
      aiAvailability = "no";
      return "no";
    }
    aiAvailability = await ai.languageModel.availability();
    return aiAvailability;
  } catch (err) {
    console.error("[LLSS] Availability check failed:", err);
    aiAvailability = "no";
    return "no";
  }
}

const sessionManager = {
  async getSession() {
    // Load current settings to build the system prompt dynamically.
    const settings = await LLSS_loadSettings();
    const piiTypes = LLSS_getMergedPiiTypes(LLSS_PII_TYPES, settings);
    const prompt = LLSS_buildSystemPrompt(piiTypes);

    // Recreate session if the prompt changed (user updated PII types).
    if (session && currentSystemPrompt !== prompt) {
      session.destroy();
      session = null;
    }

    if (session) return session;

    const status = await checkAvailability();
    if (status === "no") {
      throw new Error("Local AI model is not available on this device.");
    }

    session = await ai.languageModel.create({ systemPrompt: prompt });
    currentSystemPrompt = prompt;
    return session;
  },
};

function destroySession() {
  if (session) {
    session.destroy();
    session = null;
    currentSystemPrompt = null;
    console.log("[LLSS] Session destroyed, memory freed.");
  }
}

// ── Idle timer ──────────────────────────────────────────────────────────────

let idleTimer = null;

async function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  const settings = await LLSS_loadSettings();
  const timeout = (settings.sessionTimeoutMinutes || 5) * 60 * 1000;
  idleTimer = setTimeout(destroySession, timeout);
}

// ── Main redaction handler ──────────────────────────────────────────────────

async function handleRedact(text) {
  const settings = await LLSS_loadSettings();
  const piiTypes = LLSS_getMergedPiiTypes(LLSS_PII_TYPES, settings);

  // Determine AI availability (use cache, refresh if stale).
  if (aiAvailability === null) {
    await checkAvailability();
  }
  const aiReady = aiAvailability === "readily" || aiAvailability === "downloadable";

  const result = await LLSS_redact(text, {
    piiTypes,
    settings,
    sessionManager,
    aiAvailable: aiReady,
  });

  // Record statistics.
  const engine = result.engine.includes("ai") ? "ai" :
                 result.engine.includes("vector") ? "vector" : "regex";
  await LLSS_recordRedaction(engine, result.matches || []);

  return result;
}

// ── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  resetIdleTimer();

  switch (message.type) {
    case "CHECK_STATUS": {
      checkAvailability().then(async (status) => {
        const settings = await LLSS_loadSettings();
        sendResponse({
          status,
          detectionMode: settings.detectionMode,
        });
      }).catch(() => sendResponse({ status: "no" }));
      return true;
    }

    case "REDACT": {
      handleRedact(message.text)
        .then((result) =>
          sendResponse({
            success: true,
            redacted: result.redacted,
            engine: result.engine,
            matchCount: result.matches?.length || 0,
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
        .then(() => {
          // Destroy session so it picks up new system prompt on next use.
          destroySession();
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

    case "DESTROY_SESSION": {
      destroySession();
      sendResponse({ success: true });
      return false;
    }
  }
});

// Check availability on install/startup.
chrome.runtime.onInstalled.addListener(() => {
  checkAvailability();
});
