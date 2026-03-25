// background.js — Core engine: manages the local AI session and handles redaction requests.
// All processing happens on-device via Chrome's built-in ai.languageModel (Gemini Nano).
// No data is ever sent to external servers.

const SYSTEM_PROMPT = `You are a strict data compliance assistant for an Australian government agency.
Your ONLY job is to redact Personally Identifiable Information (PII) from the provided text.

Replace the following categories with bracketed tokens:
- Full names → [REDACTED_NAME]
- Email addresses → [REDACTED_EMAIL]
- Phone numbers (any format) → [REDACTED_PHONE]
- Street/postal addresses → [REDACTED_ADDRESS]
- Financial data (bank accounts, credit card numbers, BSBs, TFNs, ABNs) → [REDACTED_FINANCIAL]
- Dates of birth → [REDACTED_DOB]
- Medicare numbers → [REDACTED_MEDICARE]
- Passport numbers → [REDACTED_PASSPORT]
- Driver licence numbers → [REDACTED_LICENCE]
- IP addresses → [REDACTED_IP]

Rules:
1. Return ONLY the redacted text. Do not add explanations, commentary, or formatting.
2. Preserve the original structure, punctuation, and line breaks exactly.
3. If the text contains no PII, return it unchanged.
4. When in doubt, redact. False positives are acceptable; false negatives are not.`;

let session = null;

// Check whether the on-device language model is available.
async function checkAvailability() {
  try {
    if (!self.ai || !self.ai.languageModel) {
      return "no";
    }
    const status = await ai.languageModel.availability();
    return status; // 'readily' | 'downloadable' | 'no'
  } catch (err) {
    console.error("[LLSS] Availability check failed:", err);
    return "no";
  }
}

// Initialise (or reuse) the local AI session.
async function getSession() {
  if (session) return session;

  const status = await checkAvailability();

  if (status === "no") {
    throw new Error("Local AI model is not available on this device.");
  }

  // 'downloadable' — the model will be fetched on first create() call.
  // 'readily' — already cached locally.
  session = await ai.languageModel.create({
    systemPrompt: SYSTEM_PROMPT,
  });

  return session;
}

// Tear down the session to free local memory. Called when the extension is
// idle or on explicit request.
function destroySession() {
  if (session) {
    session.destroy();
    session = null;
    console.log("[LLSS] Session destroyed, memory freed.");
  }
}

// Redact PII from the supplied text using the local model.
async function redactText(text) {
  const sess = await getSession();
  const prompt = `Redact all PII from the following text:\n\n${text}`;
  const result = await sess.prompt(prompt);
  return result;
}

// ── Message listener ────────────────────────────────────────────────────────
// Content scripts and the popup communicate with the background worker here.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CHECK_STATUS") {
    // Popup requests current model availability.
    checkAvailability()
      .then((status) => sendResponse({ status }))
      .catch(() => sendResponse({ status: "no" }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "REDACT") {
    // Content script sends text to be redacted.
    redactText(message.text)
      .then((redacted) => sendResponse({ success: true, redacted }))
      .catch((err) =>
        sendResponse({ success: false, error: err.message })
      );
    return true;
  }

  if (message.type === "DESTROY_SESSION") {
    destroySession();
    sendResponse({ success: true });
    return false;
  }
});

// Auto-destroy session after 5 minutes of inactivity to conserve resources.
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(destroySession, 5 * 60 * 1000);
}

chrome.runtime.onMessage.addListener(() => {
  resetIdleTimer();
});
