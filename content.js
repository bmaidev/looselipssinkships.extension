// content.js — Content script for Loose Lips Sink Ships.
// Injects redaction buttons, handles auto-redact, submit interception,
// upload guarding, AI chat service detection, and site filtering.

(() => {
  "use strict";

  const BUTTON_CLASS = "llss-redact-btn";
  const UPLOAD_CLASS = "llss-upload-btn";
  const SPINNER_CLASS = "llss-spinner";
  const DICTATE_CLASS = "llss-dictate-btn";
  const MAX_DICTATION_MS = 60_000;
  const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
  const REDACTED_FILE_EXTENSIONS = Object.freeze({
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/zip": ".zip",
  });
  const TEXT_FIELD_SELECTOR = [
    "textarea",
    "input:not([type])",
    'input[type="text"]',
    'input[type="search"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="url"]',
    "[contenteditable='true']",
    "[contenteditable='']",
    '[role="textbox"]',
  ].join(", ");
  const MIC_SVG = '<svg class="llss-btn-svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 10a2.5 2.5 0 0 0 2.5-2.5v-4a2.5 2.5 0 0 0-5 0v4A2.5 2.5 0 0 0 8 10Z"/><path d="M12 7.5a.6.6 0 0 0-1.2 0 2.8 2.8 0 0 1-5.6 0A.6.6 0 0 0 4 7.5a4 4 0 0 0 3.4 3.96V13.4H6a.6.6 0 0 0 0 1.2h4a.6.6 0 0 0 0-1.2H8.6v-1.94A4 4 0 0 0 12 7.5Z"/></svg>';

  if (window.__llssInjected) return;
  window.__llssInjected = true;

  // ── State ────────────────────────────────────────────────────────────────

  // Start fail-closed until managed/local policy and site classification arrive.
  // This closes the document_start race where a fast scripted submit or upload
  // could otherwise occur before the service worker replies.
  let cachedSettings = {
    aiChatGuard: { enabled: true, blockSubmitUntilRedacted: true, interceptUploads: true },
    autoRedact: { enabled: false, onlyOnAiSites: false },
    submitGuard: {
      enabled: true,
      interceptEnter: true,
      interceptFormSubmit: true,
      interceptSendButtons: true,
      onlyOnAiSites: false,
    },
    uploadGuard: {
      enabled: true,
      onlyOnAiSites: false,
      confirmBeforeUpload: true,
      allowBypass: false,
      blockUnsupported: true,
      maxFileSizeBytes: 25 * 1024 * 1024,
    },
    voiceDetection: { enabled: true, warnOnLeak: false },
    voiceDictation: { enabled: true, suppressNativeMic: true },
  };
  let pageProtection = { active: true, reason: "initializing" };
  let isAiSite = false;
  let pendingRedactions = new Set(); // Track in-flight redactions
  let dictationCapability = "unknown";
  let dictationCapabilityPromise = null;

  // The service worker owns routing so every path receives the deterministic
  // regex-first safety pass. Browser AI remains available through its
  // offscreen provider, but the content script never bypasses that policy.

  // Per-tab vault for reversible tokenization. Memory-only, cleared on tab
  // close; accumulates across submits so a value keeps the same token across
  // the conversation. Never persisted, never sent anywhere.
  const reversibleVault =
    (typeof LLSS_tokenVault !== "undefined") ? LLSS_tokenVault.createVault() : null;

  async function redactText(text) {
    const result = await _redactTextInner(text);
    return _maybeTokenize(text, result);
  }

  // When reversible tokenization is on, re-express the redaction as unique,
  // stable tokens ([[EMAIL_1]] …) instead of generic masks, using the match
  // list. Falls back silently to the generic redaction if anything is missing.
  function _maybeTokenize(originalText, result) {
    if (!result || !result.success) return result;
    if (cachedSettings.reversibleTokenization?.enabled !== true) return result;
    if (typeof LLSS_tokenVault === "undefined" || !reversibleVault) return result;
    if (!Array.isArray(result.matches) || result.matches.length === 0) return result;
    const tok = LLSS_tokenVault.tokenize(originalText, result.matches, reversibleVault);
    if (tok.applied.length === 0) return result;
    return { ...result, redacted: tok.text, reversible: true, tokensApplied: tok.applied.length };
  }

  // PII is never restored into the host page. Page scripts can read rendered
  // DOM, so re-inserting originals would cross the very trust boundary this
  // extension is intended to protect.
  let inboundObserver = null;

  function updateInboundRestoration() {
    if (inboundObserver) {
      inboundObserver.disconnect();
      inboundObserver = null;
    }
  }

  async function _redactTextInner(text) {
    const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;
    if (dbg) dbg.log("redact", `Policy pipeline (${text.length} chars)`);
    return _sendToBackground(text);
  }

  function _sendToBackground(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "REDACT", text }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: "The protection service is unavailable" });
          return;
        }
        resolve(response || { success: false, error: "The protection service did not respond" });
      });
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  function refreshSettings() {
    chrome.runtime.sendMessage({ type: "GET_CONTENT_SETTINGS" }, (response) => {
      if (!response?.settings) return;
      cachedSettings = response.settings;
      // Activate debug logging from settings
      if (typeof LLSS_debug !== "undefined" && cachedSettings.debugMode) {
        LLSS_debug.setEnabled(true);
      }
      updatePageProtection();
    });
  }
  refreshSettings();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SETTINGS_UPDATED") refreshSettings();
  });

  // ── Voice-capture detection bridge ────────────────────────────────────────
  // Receives observe-only detections from the MAIN-world voice detector
  // (lib/voice-detector.js) and forwards leak-risk signals. Attaches once.
  // Disable via managed/remote config: voiceDetection.enabled = false.
  const VOICE_DETECTION_TYPES = new Set([
    "audio_capture_to_recorder",
    "local_speech_recognition",
    "remote_speech_recognition",
  ]);
  let lastVoiceDetectionAt = 0;

  function setupVoiceDetectionBridge() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "llss-voice-detector" || !data.detection) return;
      if (cachedSettings.voiceDetection?.enabled === false) return;

      const { type, leakRisk } = data.detection;
      if (!VOICE_DETECTION_TYPES.has(type) || typeof leakRisk !== "boolean") return;
      if (typeof LLSS_debug !== "undefined") {
        LLSS_debug.warn("voice", `Detected ${type}`, { leakRisk });
      }
      // Record only potential off-device paths. Explicitly local speech
      // recognition remains informational.
      if (leakRisk) {
        const nowTs = Date.now();
        if (nowTs - lastVoiceDetectionAt < 5000) return;
        lastVoiceDetectionAt = nowTs;
        try {
          chrome.runtime.sendMessage({
            type: "RECORD_VOICE_CAPTURE_DETECTED",
            detail: type,
          });
        } catch {
          /* background may be asleep; detection is best-effort */
        }
        // Optional user-facing warning (off by default).
        if (cachedSettings.voiceDetection?.warnOnLeak === true) {
          maybeWarnVoiceLeak();
        }
      }
    }, true);
  }

  // Rate-limited warning so a chatty page can't spam toasts.
  let lastVoiceWarnAt = 0;
  function maybeWarnVoiceLeak() {
    const nowTs = Date.now();
    if (nowTs - lastVoiceWarnAt < 15000) return;
    lastVoiceWarnAt = nowTs;
    try {
      showToast(
        document.body,
        "This site is recording speech through a path that may process audio off-device. Spoken PII may bypass redaction — type sensitive details instead."
      );
    } catch {
      /* toast is best-effort */
    }
  }
  setupVoiceDetectionBridge();

  function updatePageProtection() {
    const pageUrl = new URL(window.location.href);
    pageUrl.search = "";
    pageUrl.hash = "";
    chrome.runtime.sendMessage({
      type: "CHECK_SITE",
      url: pageUrl.toString(),
    }, (response) => {
      if (response) {
        pageProtection = response;
        isAiSite = response.reason === "ai_chat_service";
        if (isAiSite && cachedSettings.aiChatGuard?.showAiBanner) {
          showAiBanner();
        }
        // Re-evaluate auto-redact setup
        setupAutoRedact();
        setupSubmitGuard();
        setupUploadGuard();
        // Composers may have been wrapped before we knew this was an AI site —
        // attach the inline dictation mic button to any that are missing it.
        refreshInlineDictation();
        applyNativeMicSuppression();
        updateInboundRestoration();
      }
    });
  }

  // ── Native mic suppression ────────────────────────────────────────────────
  // Hide the site's own dictation/microphone button on AI sites so the leaky
  // (audio-uploading) path can't be used by accident. Implemented as injected
  // CSS matching specific aria-label substrings — self-applying across SPA
  // re-renders, specific enough to avoid unrelated controls, and excludes our
  // own button. Toggle: voiceDictation.suppressNativeMic.
  const NATIVE_MIC_STYLE_ID = "llss-native-mic-suppress";

  function applyNativeMicSuppression() {
    const shouldSuppress =
      isAiSite &&
      cachedSettings.voiceDictation?.enabled !== false &&
      cachedSettings.voiceDictation?.suppressNativeMic !== false;

    const existing = document.getElementById(NATIVE_MIC_STYLE_ID);
    if (!shouldSuppress) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const sel = (label) =>
      `button[aria-label*="${label}" i]:not(.${DICTATE_CLASS}), [role="button"][aria-label*="${label}" i]:not(.${DICTATE_CLASS})`;
    const style = document.createElement("style");
    style.id = NATIVE_MIC_STYLE_ID;
    style.textContent = [
      sel("dictation"),
      sel("dictate"),
      sel("microphone"),
      sel("press and hold to record"),
      sel("voice input"),
      sel("voice typing"),
    ].join(",\n") + " { display: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  }

  // Attach the dictation mic to already-wrapped composers (used once AI-site
  // status is known, since wrappers can be created before that).
  async function refreshInlineDictation() {
    if (!isAiSite || cachedSettings.voiceDictation?.enabled === false) {
      removeInlineDictationControls();
      return;
    }
    if (dictationCapability === "unknown") await checkDictationCapability();
    if (!shouldShowInlineDictation()) {
      removeInlineDictationControls();
      return;
    }
    document.querySelectorAll(".llss-wrapper").forEach((wrapper) => {
      if (wrapper.dataset.llssDictate === "attached") return;
      const el = wrapper.querySelector("textarea, [contenteditable='true'], [contenteditable='']");
      if (el) attachInlineDictation(el, wrapper);
    });
  }

  function checkDictationCapability() {
    if (dictationCapabilityPromise) return dictationCapabilityPromise;
    dictationCapabilityPromise = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CHECK_DICTATION_CAPABILITY" }, (response) => {
        dictationCapability = !chrome.runtime.lastError && response?.available === true
          ? "ready"
          : "unavailable";
        resolve(dictationCapability);
      });
    });
    return dictationCapabilityPromise;
  }

  // ── Site filter gate ─────────────────────────────────────────────────────
  // If the site is filtered out, the extension does nothing.

  function isExtensionActive() {
    return pageProtection.active;
  }

  // ── AI Chat Banner ────────────────────────────────────────────────────────

  let bannerShown = false;
  function showAiBanner() {
    if (bannerShown) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", showAiBanner, { once: true });
      return;
    }
    bannerShown = true;

    const banner = document.createElement("div");
    banner.className = "llss-ai-banner";
    banner.innerHTML = '<span class="llss-ai-banner-icon">&#x1f6e1;</span>' +
      '<span class="llss-ai-banner-text"><strong>Loose Lips Sink Ships</strong> — Submission checks active. Detection can miss sensitive information; review before sharing.</span>' +
      '<button class="llss-ai-banner-close" aria-label="Dismiss protection notice">&times;</button>';

    banner.querySelector(".llss-ai-banner-close").addEventListener("click", () => {
      banner.remove();
    });

    document.body.prepend(banner);

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      if (banner.parentNode) {
        banner.style.animation = "llss-fade 1s ease forwards";
        setTimeout(() => banner.remove(), 1000);
      }
    }, 8000);
  }

  // ── Button creation ──────────────────────────────────────────────────────

  function createRedactButton() {
    const btn = document.createElement("button");
    btn.className = BUTTON_CLASS;
    btn.innerHTML = '<svg class="llss-btn-svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.2a5.8 5.8 0 0 1 3.36 10.53L4.27 5.64A5.78 5.78 0 0 1 8 2.2Zm0 11.6a5.8 5.8 0 0 1-3.36-10.53l7.09 7.09A5.78 5.78 0 0 1 8 13.8Z"/></svg>';
    btn.title = "Redact PII";
    btn.setAttribute("aria-label", "Redact personal information");
    btn.type = "button";
    return btn;
  }

  // ── Inline dictation (AI composers) ───────────────────────────────────────
  // A mic button on AI-chat composers: capture speech, transcribe on-device
  // (offscreen/Nano), redact, and insert the clean text — closing the voice
  // dictation bypass in place without selecting a cloud transcription engine.

  function shouldShowInlineDictation() {
    if (!isAiSite) return false;
    if (cachedSettings.voiceDictation?.enabled === false) return false;
    return dictationCapability === "ready" &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined";
  }

  function createDictationButton() {
    const btn = document.createElement("button");
    btn.className = `${BUTTON_CLASS} ${DICTATE_CLASS}`;
    btn.innerHTML = MIC_SVG;
    btn.title = "Dictate (on-device, redacted)";
    btn.setAttribute("aria-label", "Start on-device dictation");
    btn.setAttribute("aria-pressed", "false");
    btn.type = "button";
    return btn;
  }

  const inlineControls = new Map();

  function removeInlineDictationControls() {
    for (const control of inlineControls.values()) control.cleanup();
  }

  function attachInlineDictation(el, wrapper) {
    if (!shouldShowInlineDictation()) return;
    if (wrapper.dataset.llssDictate === "attached") return;
    wrapper.dataset.llssDictate = "attached";

    // Float the button and track the composer's bottom-right corner. AI
    // composers wrap a very short editable node (≈22px when empty), so
    // anchoring absolutely inside the wrapper makes the button overflow. A
    // fixed, rect-tracked button stays correctly placed as the composer grows.
    const btn = createDictationButton();
    btn.classList.add("llss-dictate-floating");
    document.body.appendChild(btn);
    btn.addEventListener("click", () => toggleInlineDictation(el, btn));

    let resizeObserver = null;
    const cleanup = () => {
      const recorder = inlineRecorders.get(btn);
      if (recorder) {
        inlineRecorders.delete(btn);
        btn.dataset.recording = "false";
        recorder.stop().catch(() => {});
      }
      btn.remove();
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      el.removeEventListener("input", reposition);
      el.removeEventListener("focus", reposition, true);
      resizeObserver?.disconnect();
      delete wrapper.dataset.llssDictate;
      inlineControls.delete(el);
    };
    const reposition = () => positionFloatingDictation(el, btn, cleanup);
    inlineControls.set(el, { cleanup });
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    el.addEventListener("input", reposition);
    el.addEventListener("focus", reposition, true);
    try {
      resizeObserver = new ResizeObserver(reposition);
      resizeObserver.observe(el);
    } catch { /* ResizeObserver unavailable — event listeners still cover it */ }
  }

  function positionFloatingDictation(el, btn, cleanup) {
    // Clean up if the composer was removed (SPA navigation).
    if (!el.isConnected || !btn.isConnected) {
      cleanup();
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { btn.style.display = "none"; return; }
    btn.style.display = "";
    const SIZE = 26;
    // Bottom-right of the composer, offset left to clear the site's own send
    // controls, clamped to stay on-screen.
    let top = r.bottom - SIZE - 4;
    let left = r.right - SIZE - 52;
    top = Math.min(Math.max(top, 8), window.innerHeight - SIZE - 8);
    left = Math.min(Math.max(left, 8), window.innerWidth - SIZE - 8);
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
  }

  const inlineRecorders = new WeakMap();

  async function toggleInlineDictation(el, btn) {
    // Stop → transcribe → redact → insert.
    if (btn.dataset.recording === "true") {
      btn.dataset.recording = "false";
      btn.classList.remove("llss-recording");
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", "Start on-device dictation");
      btn.disabled = true;
      btn.dataset.originalHtml = btn.innerHTML;
      btn.innerHTML = "";
      btn.classList.add(SPINNER_CLASS);
      const recorder = inlineRecorders.get(btn);
      inlineRecorders.delete(btn);
      try {
        const blob = recorder ? await recorder.stop() : null;
        if (!blob || !blob.size) {
          showToast(btn.parentNode || document.body, "No audio captured.");
          return;
        }
        const buffer = await blob.arrayBuffer();
        const audioBase64 = LLSS_BinaryTransfer.toBase64(buffer, 10 * 1024 * 1024);
        const resp = await chrome.runtime.sendMessage({
          type: "DICTATE_AUDIO",
          audioBase64,
          mime: blob.type,
        });
        if (resp?.success && resp.redacted) {
          insertIntoComposer(el, resp.redacted);
          showBadge(btn, resp.engine || "local_ai", resp.matchCount, resp.tier || "local", resp.coverage);
        } else if (resp?.success) {
          showToast(btn.parentNode || document.body, "No speech detected.");
        } else {
          showToast(btn.parentNode || document.body, `Dictation failed: ${resp?.error || "unknown error"}`);
        }
      } catch (err) {
        showToast(btn.parentNode || document.body, "Could not transcribe audio on-device.");
      } finally {
        btn.classList.remove(SPINNER_CLASS);
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalHtml || MIC_SVG;
        btn.title = "Dictate (on-device, redacted)";
      }
      return;
    }

    // Start recording.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.start();
      const recorderState = {
        timeoutId: null,
        stop: () => new Promise((resolve) => {
          if (recorderState.timeoutId) clearTimeout(recorderState.timeoutId);
          mr.onstop = () => {
            try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
            resolve(new Blob(chunks, { type: mr.mimeType || "audio/webm" }));
          };
          try {
            mr.stop();
          } catch {
            try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
            resolve(new Blob(chunks));
          }
        }),
      };
      recorderState.timeoutId = setTimeout(() => {
        if (btn.dataset.recording === "true") {
          showToast(btn.parentNode || document.body, "Dictation stopped after the 60-second safety limit.");
          btn.click();
        }
      }, MAX_DICTATION_MS);
      inlineRecorders.set(btn, recorderState);
      btn.dataset.recording = "true";
      btn.classList.add("llss-recording");
      btn.title = "Stop dictation";
      btn.setAttribute("aria-pressed", "true");
      btn.setAttribute("aria-label", "Stop dictation and redact transcript");
    } catch (err) {
      showToast(btn.parentNode || document.body, "Microphone unavailable or permission denied.");
    }
  }

  // Insert transcribed+redacted text into a composer, framework-safe.
  function insertIntoComposer(el, text) {
    if (!text) return;
    try { el.focus(); } catch { /* ignore */ }

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const existing = el.value || "";
      const sep = existing && !/\s$/.test(existing) ? " " : "";
      el.value = existing + sep + text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // contenteditable (ProseMirror/React composers) — move caret to end and use
    // execCommand('insertText') so the editor's own change tracking registers it.
    const existing = getElementText(el);
    const sep = existing && !/\s$/.test(existing) ? " " : "";
    let inserted = false;
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(el);
        sel.collapseToEnd();
      }
      inserted = document.execCommand && document.execCommand("insertText", false, sep + text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      el.innerText = existing + sep + text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ── File upload handler ────────────────────────────────────────────────────

  const SUPPORTED_ACCEPT =
    // Office documents
    ".docx,.xlsx,.pdf" +
    // Web / markup
    ",.html,.htm,.md,.markdown" +
    // Structured text
    ",.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.env" +
    // Plain text / docs
    ",.txt,.log,.rtf,.rst,.adoc,.tex" +
    // Code files
    ",.py,.rb,.php,.js,.ts,.jsx,.tsx,.java,.cs,.go,.rs,.swift,.kt,.c,.cpp,.h,.sh,.ps1,.sql,.r,.bat" +
    // Images
    ",.png,.jpg,.jpeg,.gif,.webp,.bmp,.tiff,.tif" +
    // Archives
    ",.zip" +
    // MIME types
    ",application/vnd.openxmlformats-officedocument.wordprocessingml.document" +
    ",application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" +
    ",application/pdf,text/html,text/markdown,text/plain,text/csv,application/json,application/xml" +
    ",application/zip,image/*";

  function triggerFileUpload(setText, btn) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = SUPPORTED_ACCEPT;
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;

      btn.disabled = true;
      btn.dataset.originalHtml = btn.innerHTML;
      btn.innerHTML = "";
      btn.classList.add(SPINNER_CLASS);

      try {
        if (file.size > MAX_DOCUMENT_BYTES) {
          showToast(btn.parentNode || document.body, "File is larger than the 25 MB safety limit.");
          return;
        }
        const buffer = await file.arrayBuffer();
        const data = LLSS_BinaryTransfer.toBase64(buffer, MAX_DOCUMENT_BYTES);

        const response = await chrome.runtime.sendMessage({
          type: "REDACT_DOCUMENT",
          fileDataBase64: data,
          fileName: file.name,
          mimeType: file.type,
        });

        if (response && response.success) {
          if (setText && !response.redactedPreviewTruncated) {
            setText(response.redacted);
          } else {
            showResultOverlay(btn.parentNode || document.body, response, file.name);
          }
          showBadge(btn, response.engine, response.matchCount, response.tier, response.coverage);
        } else {
          showToast(btn.parentNode || document.body, `Redaction failed: ${response?.error || "Unknown error"}`);
        }
      } catch (err) {
        showToast(btn.parentNode || document.body, "Could not process the document.");
      } finally {
        btn.disabled = false;
        btn.classList.remove(SPINNER_CLASS);
        btn.innerHTML = btn.dataset.originalHtml;
        input.remove();
      }
    });

    document.body.appendChild(input);
    input.click();
  }

  // ── Result overlay ─────────────────────────────────────────────────────────

  function showResultOverlay(parent, response, fileName) {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = document.createElement("div");
    layer.className = "llss-result-backdrop";

    const overlay = document.createElement("div");
    overlay.className = "llss-result-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "llss-result-title");
    overlay.tabIndex = -1;

    const header = document.createElement("div");
    header.className = "llss-result-header";
    const heading = document.createElement("strong");
    heading.id = "llss-result-title";
    heading.textContent = `Redacted: ${fileName}`;
    const meta = document.createElement("span");
    meta.className = "llss-result-meta";
    meta.textContent = `${response.engine || "unknown"} · ${response.matchCount || 0} items · ${response.tier || "local"}`;
    header.append(heading, meta);
    const notice = document.createElement('p');
    notice.className = 'llss-result-coverage';
    notice.textContent = LLSS_ScanStatus.describe(response.coverage).detail;
    header.appendChild(notice);

    const content = document.createElement("pre");
    content.className = "llss-result-content";
    content.textContent = response.redacted;

    const actions = document.createElement("div");
    actions.className = "llss-result-actions";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy text";
    copyBtn.className = "llss-result-btn";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(response.redacted);
        copyBtn.textContent = "Copied";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => { copyBtn.textContent = "Copy text"; }, 2000);
    });

    actions.appendChild(copyBtn);

    // If a redacted file is available (PDF/image), offer download
    if (response.redactedFileBase64) {
      const downloadBtn = document.createElement("button");
      downloadBtn.textContent = "Download redacted file";
      downloadBtn.className = "llss-result-btn";
      downloadBtn.addEventListener("click", () => {
        try {
          const bytes = LLSS_BinaryTransfer.fromBase64(response.redactedFileBase64, MAX_DOCUMENT_BYTES);
          const format = response.redactedFileFormat || "application/pdf";
          const blob = new Blob([bytes], { type: format });
          const url = URL.createObjectURL(blob);
          const ext = REDACTED_FILE_EXTENSIONS[format]
            || fileName.match(/\.[A-Za-z0-9]{1,10}$/)?.[0].toLowerCase()
            || "";
          const baseName = fileName.replace(/\.[^.]+$/, "");
          const a = document.createElement("a");
          a.href = url;
          a.download = `${baseName}_redacted${ext}`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
          downloadBtn.textContent = "Downloaded";
        } catch {
          downloadBtn.textContent = "Download failed";
        }
        setTimeout(() => { downloadBtn.textContent = "Download redacted file"; }, 2000);
      });
      actions.appendChild(downloadBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.className = "llss-result-btn llss-result-btn-close";
    const close = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      layer.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(actions.querySelectorAll("button:not([disabled])"));
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons[buttons.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
        event.preventDefault();
        buttons[0].focus();
      }
    };
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKeyDown, true);

    actions.appendChild(closeBtn);
    overlay.appendChild(header);
    overlay.appendChild(content);
    overlay.appendChild(actions);
    layer.appendChild(overlay);
    document.body.appendChild(layer);
    closeBtn.focus();
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Attach to textarea ───────────────────────────────────────────────────

  function attachToTextarea(textarea) {
    if (!isExtensionActive()) return;
    if (textarea.dataset.llss === "attached") return;
    if (!cachedSettings.showRedactButton) return;
    textarea.dataset.llss = "attached";

    const btn = createRedactButton();
    const wrapper = document.createElement("div");
    wrapper.className = "llss-wrapper";
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.width = textarea.offsetWidth ? `${textarea.offsetWidth}px` : "100%";

    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);
    wrapper.appendChild(btn);

    btn.addEventListener("click", () =>
      handleRedact(
        () => textarea.value,
        (val) => {
          textarea.value = val;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        },
        btn
      )
    );

    attachInlineDictation(textarea, wrapper);
  }

  // ── Attach to contenteditable ────────────────────────────────────────────

  function attachToContentEditable(el) {
    if (!isExtensionActive()) return;
    if (el.dataset.llss === "attached") return;
    if (!cachedSettings.enableContentEditable) return;
    if (!cachedSettings.showRedactButton) return;
    el.dataset.llss = "attached";

    const btn = createRedactButton();
    btn.classList.add("llss-ce-btn");

    const wrapper = document.createElement("div");
    wrapper.className = "llss-wrapper";
    wrapper.style.position = "relative";

    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    wrapper.appendChild(btn);

    btn.addEventListener("click", () =>
      handleRedact(
        () => el.innerText,
        (val) => {
          el.innerText = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        btn
      )
    );

    attachInlineDictation(el, wrapper);
  }

  // ── Manual redaction handler ──────────────────────────────────────────────

  async function handleRedact(getText, setText, btn) {
    const text = getText().trim();
    if (!text) return;

    btn.disabled = true;
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = "";
    btn.classList.add(SPINNER_CLASS);

    try {
      const response = await redactText(text);

      if (response && response.success) {
        setText(response.redacted);
        showBadge(btn, response.engine, response.matchCount, response.tier, response.coverage);
      } else {
        showToast(btn.parentNode, `Redaction failed: ${response?.error || "Unknown error"}`);
      }
    } catch (err) {
      showToast(btn.parentNode, "Could not reach the redaction engine.");
    } finally {
      btn.disabled = false;
      btn.classList.remove(SPINNER_CLASS);
      btn.innerHTML = btn.dataset.originalHtml;
    }
  }

  // ── Auto-Redact Mode ──────────────────────────────────────────────────────
  // Automatically redacts PII as the user types or pastes into text fields.
  // Designed to be non-disruptive: waits for a meaningful pause in typing,
  // tracks what was already scanned, and requires minimum content length.

  const autoRedactTimers = new WeakMap();
  const autoRedactLastText = new WeakMap(); // Last text we processed for this element
  let autoRedactActive = false;

  function shouldAutoRedact() {
    const config = cachedSettings.autoRedact || {};
    const aiGuardActive = isAiSite && cachedSettings.aiChatGuard?.enabled !== false &&
      cachedSettings.aiChatGuard?.autoRedactOnAiSites === true;
    return (config.enabled === true || aiGuardActive) && (!config.onlyOnAiSites || isAiSite);
  }

  function setupAutoRedact() {
    if (autoRedactActive) return;
    autoRedactActive = true;

    // Attach auto-redact listeners to all text inputs
    document.addEventListener("input", onAutoRedactInput, true);
    document.addEventListener("paste", onAutoRedactPaste, true);
  }

  function onAutoRedactInput(e) {
    const config = cachedSettings.autoRedact || {};
    if (!shouldAutoRedact()) return;
    const el = e.target;
    if (!isTextInput(el)) return;
    if (el.dataset.llssAutoRedacting === "true") return;

    const debounce = config.debounceMs || 2500;

    // Clear existing timer
    const existing = autoRedactTimers.get(el);
    if (existing) clearTimeout(existing);

    // Set new debounced redaction
    const timer = setTimeout(() => {
      autoRedactElement(el);
    }, debounce);
    autoRedactTimers.set(el, timer);
  }

  function onAutoRedactPaste(e) {
    const config = cachedSettings.autoRedact || {};
    if (!shouldAutoRedact()) return;
    const el = e.target;
    if (!isTextInput(el)) return;

    if (!config.onPaste) return;

    // Short delay to let paste complete, then redact
    setTimeout(() => autoRedactElement(el), 300);
  }

  async function autoRedactElement(el) {
    if (!shouldAutoRedact()) return;
    const text = getElementText(el).trim();

    // Need meaningful content (short fragments are likely still being composed)
    if (!text || text.length < 12) return;

    // Skip if the text hasn't changed since we last processed this element
    const lastProcessed = autoRedactLastText.get(el);
    if (lastProcessed === text) return;

    // Skip if the text has changed while we were waiting (user still typing)
    // — snapshot now, check again after a micro-delay
    await new Promise(r => setTimeout(r, 150));
    const currentText = getElementText(el).trim();
    if (currentText !== text) return; // User typed more — bail out

    el.dataset.llssAutoRedacting = "true";
    autoRedactLastText.set(el, text); // Mark as processed before async work
    const redactId = Symbol();
    pendingRedactions.add(redactId);

    try {
      const response = await redactText(text);
      if (response?.success && response.redacted !== text) {
        const inserted = setElementText(el, response.redacted);
        if (inserted) {
          autoRedactLastText.set(el, response.redacted); // Track the redacted version too

          // Brief visual indicator
          el.style.outline = "2px solid #22c55e";
          setTimeout(() => { el.style.outline = ""; }, 1000);

          // Track stats
          chrome.runtime.sendMessage({
            type: "RECORD_AUTO_REDACTION",
            matchCount: response.matchCount || 0,
          });
        }
        // If not inserted, the submit guard will catch it at send time and
        // block + offer the clipboard fallback — no false success indicator here.
      }
    } finally {
      el.dataset.llssAutoRedacting = "false";
      pendingRedactions.delete(redactId);
    }
  }

  // ── Submit Interception ───────────────────────────────────────────────────
  // Intercepts form submissions, Enter key, and send button clicks to ensure
  // redaction has been applied before content leaves the page.

  let submitGuardActive = false;

  function setupSubmitGuard() {
    if (submitGuardActive) return;
    submitGuardActive = true;

    // Attach once; handlers consult current settings so live policy changes do
    // not require duplicate listeners or a page reload.
    document.addEventListener("keydown", onSubmitKeydown, true);
    document.addEventListener("submit", onFormSubmit, true);
    document.addEventListener("click", onSendButtonClick, true);
  }

  async function onSubmitKeydown(e) {
    const config = cachedSettings.submitGuard || {};
    if (!isExtensionActive()) return;
    if (!config.enabled || !config.interceptEnter || (config.onlyOnAiSites && !isAiSite)) return;
    if (e.key !== "Enter") return;
    // Only intercept in text inputs (not in general navigation)
    const el = e.target;
    if (!isTextInput(el)) return;
    if (el.dataset.llssAllowSubmit === "true") return;

    // Shift+Enter is usually newline, not submit
    if (e.shiftKey) return;

    const text = getElementText(el).trim();
    if (!text) return;

    // Check if there are pending redactions
    if (pendingRedactions.size > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showToast(el.parentNode || document.body, "Please wait — redaction in progress...");
      return;
    }

    // Run a quick redaction check
    e.preventDefault();
    e.stopImmediatePropagation();

    el.dataset.llssSubmitBlocked = "true";
    const indicator = showSubmitIndicator(el);

    try {
      const response = await redactText(text);
      if (response?.success) {
        if (response.redacted !== text) {
          const inserted = setElementText(el, response.redacted);
          if (!inserted) {
            // The site's editor rejected the redacted text — do NOT send the
            // original. Block and hand the user the redacted text to paste.
            removeSubmitIndicator(indicator);
            el.dataset.llssSubmitBlocked = "false";
            _clipboardFallback(el, response.redacted);
            return;
          }
        }
        // Track intercept
        chrome.runtime.sendMessage({ type: "RECORD_SUBMIT_INTERCEPT" });

        // Re-dispatch the Enter key to actually submit
        el.dataset.llssSubmitBlocked = "false";
        removeSubmitIndicator(indicator);

        // Allow the original action through
        const newEvent = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        });
        el.dataset.llssAllowSubmit = "true";
        el.dispatchEvent(newEvent);
        el.dataset.llssAllowSubmit = "false";
      } else {
        el.dataset.llssSubmitBlocked = "false";
        removeSubmitIndicator(indicator);
        showToast(el.parentNode || document.body, "Protection check failed — message not sent.");
      }
    } catch {
      el.dataset.llssSubmitBlocked = "false";
      removeSubmitIndicator(indicator);
      showToast(el.parentNode || document.body, "Protection check failed — message not sent.");
    }
  }

  function onFormSubmit(e) {
    const config = cachedSettings.submitGuard || {};
    if (!isExtensionActive()) return;
    if (!config.enabled || !config.interceptFormSubmit || (config.onlyOnAiSites && !isAiSite)) return;
    // If we already allowed this submit, let it through
    const form = e.target;
    if (form.dataset.llssAllowSubmit === "true") return;

    // Find text inputs in the form
    const textInputs = form.querySelectorAll(TEXT_FIELD_SELECTOR);
    if (textInputs.length === 0) return;

    // Check for pending redactions
    if (pendingRedactions.size > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showToast(form, "Please wait — redaction in progress...");
      return;
    }

    // Block and redact all text fields in the form
    e.preventDefault();
    e.stopImmediatePropagation();

    redactFormFields(form, textInputs).then((allInserted) => {
      if (!allInserted) {
        // At least one field's redacted text couldn't be inserted — block the
        // submit rather than let un-redacted content through.
        return;
      }
      form.dataset.llssAllowSubmit = "true";
      // Use requestSubmit for proper validation, fallback to submit()
      if (form.requestSubmit) {
        form.requestSubmit();
      } else {
        form.submit();
      }
      form.dataset.llssAllowSubmit = "false";
    });
  }

  // Redacts every field; returns false if any field needed redaction but the
  // redacted text couldn't be inserted (so the caller blocks the submit).
  async function redactFormFields(form, fields) {
    const results = await Promise.all(Array.from(fields).map(async (field) => {
      const text = getElementText(field).trim();
      if (!text) return true;

      try {
        const response = await redactText(text);
        if (!response?.success) return false;
        if (response.redacted !== text) {
          const inserted = setElementText(field, response.redacted);
          if (!inserted) {
            _clipboardFallback(field, response.redacted);
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    }));
    const safe = results.every(Boolean);
    if (!safe) showToast(form, "Protection check failed — form not submitted.");
    return safe;
  }

  function onSendButtonClick(e) {
    const config = cachedSettings.submitGuard || {};
    if (!isExtensionActive()) return;
    if (!config.enabled || !config.interceptSendButtons || (config.onlyOnAiSites && !isAiSite)) return;
    const btn = e.target.closest("button, [role='button'], input[type='submit']");
    if (!btn) return;
    // Allow our own buttons through
    if (btn.classList.contains(BUTTON_CLASS)) return;
    // If we already allowed this, let it through
    if (btn.dataset.llssAllowSubmit === "true") return;

    // Heuristic: detect send/submit buttons
    if (!isSendButton(btn)) return;

    // Check for pending redactions
    if (pendingRedactions.size > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showToast(btn.parentNode || document.body, "Please wait — redaction in progress...");
      return;
    }

    // Find the nearest text input
    const textInput = findNearestTextInput(btn);
    if (!textInput) return;

    const text = getElementText(textInput).trim();
    if (!text) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const indicator = showSubmitIndicator(textInput);

    redactText(text).then((response) => {
      removeSubmitIndicator(indicator);
      if (!response?.success) {
        showToast(btn.parentNode || document.body, "Protection check failed — message not sent.");
        return;
      }
      if (response.redacted !== text) {
        const inserted = setElementText(textInput, response.redacted);
        if (!inserted) {
          // Editor rejected the redacted text — do not click send with the
          // original still in the box.
          _clipboardFallback(textInput, response.redacted);
          return;
        }
      }
      chrome.runtime.sendMessage({ type: "RECORD_SUBMIT_INTERCEPT" });

      // Re-click the button
      btn.dataset.llssAllowSubmit = "true";
      btn.click();
      btn.dataset.llssAllowSubmit = "false";
    }).catch(() => {
      removeSubmitIndicator(indicator);
      showToast(btn.parentNode || document.body, "Protection check failed — message not sent.");
    });
  }

  /**
   * Heuristic to detect send/submit buttons.
   */
  function isSendButton(el) {
    const text = (el.textContent || "").toLowerCase().trim();
    const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
    const title = (el.getAttribute("title") || "").toLowerCase();
    const testStr = text + " " + ariaLabel + " " + title;

    const sendWords = ["send", "submit", "post", "reply", "ask", "generate", "chat", "go"];
    if (sendWords.some((w) => testStr.includes(w))) return true;

    // Check for send icon (SVG arrow, paper plane)
    if (el.querySelector("svg") && text.length < 3) return true;

    // Check type=submit
    if (el.type === "submit") return true;

    // Check data attributes
    const dataAction = el.dataset.action || el.dataset.testid || "";
    if (/send|submit|compose/i.test(dataAction)) return true;

    return false;
  }

  function findNearestTextInput(btn) {
    // Walk up to find a form or container, then find text input within it
    let container = btn.parentNode;
    for (let i = 0; i < 10 && container; i++) {
      const textField = container.querySelector(TEXT_FIELD_SELECTOR);
      if (textField) return textField;
      container = container.parentNode;
    }
    return null;
  }

  function showSubmitIndicator(el) {
    const indicator = document.createElement("div");
    indicator.className = "llss-submit-indicator";
    indicator.textContent = "Redacting before send...";
    const parent = el.parentNode || document.body;
    parent.appendChild(indicator);
    return indicator;
  }

  function removeSubmitIndicator(indicator) {
    if (indicator && indicator.parentNode) indicator.remove();
  }

  // ── Upload Interception ───────────────────────────────────────────────────
  // "Security Handshake" — intercepts file uploads, redacts PII at the pixel
  // level, then replaces the original file with the secured version before
  // the target site ever sees it.
  //
  // Features:
  //   - Shadow DOM security overlay with scanning animation
  //   - stopImmediatePropagation blocks the site's handlers until redaction is done
  //   - File replacement: creates a new File object with redacted content
  //   - AsyncQueue limits concurrency for multi-file drops (max 2 active)
  //   - Progress reporting from background → content for large documents

  let uploadGuardActive = false;
  let isRedactedDispatch = false; // Prevents re-intercepting our own dispatched events

  function setupUploadGuard() {
    if (uploadGuardActive) return;
    uploadGuardActive = true;

    // Capture phase ensures we run BEFORE the target site's listeners
    document.addEventListener("change", onFileInputChange, true);
    document.addEventListener("drop", onFileDrop, true);

    // Listen for progress updates from background (forwarded from offscreen OCR).
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "REDACT_PROGRESS" && activeOverlay) {
        activeOverlay.updateProgress(msg);
      }
    });
  }

  // ── Security overlay (Shadow DOM) ─────────────────────────────────────────

  let activeOverlay = null;

  function createSecurityOverlay(fileNames, allowBypass = false) {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const host = document.createElement("div");
    host.setAttribute("data-llss-overlay", "true");
    host.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:all;";

    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .backdrop {
          position: fixed; top: 0; left: 0; width: 100%; height: 100%;
          background: rgba(15, 23, 42, 0.65);
          display: flex; align-items: center; justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        }

        .card {
          background: #fff; border-radius: 16px; padding: 32px 40px;
          width: 400px; max-width: 90vw;
          box-shadow: 0 25px 50px rgba(0,0,0,0.25);
          text-align: center;
        }

        .icon-container {
          position: relative; width: 80px; height: 100px;
          margin: 0 auto 20px; overflow: hidden;
        }

        .doc-icon {
          width: 80px; height: 100px;
          fill: #e2e8f0; stroke: #64748b; stroke-width: 1.5;
        }

        .scanner-line {
          position: absolute; left: 8px; right: 8px; height: 3px;
          background: linear-gradient(90deg, transparent, #3b82f6, #60a5fa, #3b82f6, transparent);
          border-radius: 2px;
          animation: scan 1.8s ease-in-out infinite;
          box-shadow: 0 0 12px rgba(59, 130, 246, 0.6);
        }

        @keyframes scan {
          0%, 100% { top: 12px; opacity: 0.4; }
          50% { top: 85px; opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          .scanner-line { animation: none; top: 48px; }
          .progress-fill { transition: none; }
        }

        .title {
          font-size: 18px; font-weight: 700; color: #1e293b;
          margin-bottom: 4px;
        }

        .subtitle {
          font-size: 13px; color: #64748b; margin-bottom: 20px;
        }

        .file-list {
          list-style: none; text-align: left; margin-bottom: 16px;
          max-height: 120px; overflow-y: auto;
        }
        .file-list li {
          font-size: 12px; color: #475569; padding: 4px 8px;
          border-radius: 4px; margin-bottom: 2px;
          background: #f8fafc; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }
        .file-list li.active { background: #dbeafe; color: #1e40af; font-weight: 500; }
        .file-list li.done { color: #16a34a; }
        .file-list li.done::before { content: "\\2713 "; }

        .progress-track {
          width: 100%; height: 6px; background: #e2e8f0;
          border-radius: 3px; overflow: hidden; margin-bottom: 8px;
        }
        .progress-fill {
          height: 100%; width: 0%; border-radius: 3px;
          background: linear-gradient(90deg, #3b82f6, #60a5fa);
          transition: width 0.3s ease;
        }

        .status-text {
          font-size: 12px; color: #64748b; min-height: 18px;
        }

        .complete .scanner-line { display: none; }
        .complete .doc-icon { fill: #d1fae5; stroke: #16a34a; }
        .complete .title { color: #16a34a; }
        .complete .progress-fill { width: 100% !important; background: #16a34a; }

        .skip-btn {
          margin-top: 12px; padding: 6px 16px;
          font-size: 12px; color: #64748b; background: none;
          border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer;
        }
        .skip-btn:hover { background: #f8fafc; }
      </style>

      <div class="backdrop">
        <div class="card" role="dialog" aria-modal="true" aria-labelledby="llss-overlay-title" aria-describedby="llss-overlay-status" tabindex="-1">
          <div class="icon-container">
            <svg class="doc-icon" viewBox="0 0 80 100">
              <path d="M10 5 h40 l20 20 v70 a5 5 0 0 1 -5 5 H15 a5 5 0 0 1 -5 -5 V10 a5 5 0 0 1 5 -5z" />
              <path d="M50 5 v15 a5 5 0 0 0 5 5 h15" fill="none" />
              <line x1="22" y1="45" x2="58" y2="45" stroke-width="2" opacity="0.3" />
              <line x1="22" y1="55" x2="52" y2="55" stroke-width="2" opacity="0.3" />
              <line x1="22" y1="65" x2="45" y2="65" stroke-width="2" opacity="0.3" />
              <line x1="22" y1="75" x2="55" y2="75" stroke-width="2" opacity="0.3" />
            </svg>
            <div class="scanner-line"></div>
          </div>
          <div class="title" id="llss-overlay-title">Securing Documents</div>
          <div class="subtitle">Scanning for personal information...</div>
          <ul class="file-list"></ul>
          <div class="progress-track" role="progressbar" aria-label="Document redaction progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div>
          <div class="status-text" id="llss-overlay-status" role="status" aria-live="polite">Preparing...</div>
          <button class="skip-btn"></button>
        </div>
      </div>
    `;

    document.body.appendChild(host);

    const card = shadow.querySelector(".card");
    const progressTrack = shadow.querySelector(".progress-track");
    const progressFill = shadow.querySelector(".progress-fill");
    const statusText = shadow.querySelector(".status-text");
    const titleEl = shadow.querySelector(".title");
    const subtitleEl = shadow.querySelector(".subtitle");
    const skipBtn = shadow.querySelector(".skip-btn");
    const fileList = shadow.querySelector(".file-list");
    for (const fileName of fileNames) {
      const item = document.createElement("li");
      item.textContent = fileName;
      fileList.appendChild(item);
    }
    skipBtn.textContent = allowBypass ? "Upload original without redaction" : "Cancel upload";
    let skipped = false;
    let _onSkip = null;
    const onOverlayKeydown = (event) => {
      const buttons = Array.from(shadow.querySelectorAll("button"))
        .filter((button) => button.style.display !== "none" && !button.disabled);
      if (event.key === "Escape") {
        if (buttons.length) {
          event.preventDefault();
          buttons[buttons.length - 1].click();
        }
        return;
      }
      if (event.key !== "Tab") return;
      if (!buttons.length) {
        event.preventDefault();
        card.focus();
        return;
      }
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && (shadow.activeElement === first || shadow.activeElement === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onOverlayKeydown, true);

    const api = {
      /** Update progress from OCR_PROGRESS messages */
      updateProgress(msg) {
        if (!msg) return;
        const { phase, currentPage, totalPages, completed } = msg;

        if (phase === "rendering" && totalPages) {
          const pct = Math.round((currentPage / totalPages) * 30); // Render = 0-30%
          progressFill.style.width = pct + "%";
          progressTrack.setAttribute("aria-valuenow", String(pct));
          statusText.textContent = `Rendering page ${currentPage} of ${totalPages}...`;
        } else if (phase === "ocr" && totalPages) {
          const pct = 30 + Math.round(((completed || currentPage) / totalPages) * 50); // OCR = 30-80%
          progressFill.style.width = pct + "%";
          progressTrack.setAttribute("aria-valuenow", String(pct));
          statusText.textContent = `OCR: page ${completed || currentPage} of ${totalPages}...`;
        } else if (phase === "redacting" && totalPages) {
          const pct = 80 + Math.round((currentPage / totalPages) * 15); // Redact = 80-95%
          progressFill.style.width = pct + "%";
          progressTrack.setAttribute("aria-valuenow", String(pct));
          statusText.textContent = `Redacting page ${currentPage} of ${totalPages}...`;
        } else if (phase === "ocr_complete" || phase === "complete") {
          progressFill.style.width = "95%";
          progressTrack.setAttribute("aria-valuenow", "95");
          statusText.textContent = "Finalising...";
        }
      },

      /** Update for multi-file queue progress */
      updateFileProgress(fileName, fileIndex, totalFiles) {
        statusText.textContent = `Processing ${fileName} (${fileIndex + 1}/${totalFiles})...`;
        // Mark previous files as done
        const items = shadow.querySelectorAll(".file-list li");
        items.forEach((li, i) => {
          li.classList.remove("active");
          if (i < fileIndex) li.classList.add("done");
          if (i === fileIndex) li.classList.add("active");
        });
        // Overall file-level progress
        const basePct = Math.round((fileIndex / totalFiles) * 100);
        progressFill.style.width = basePct + "%";
        progressTrack.setAttribute("aria-valuenow", String(basePct));
      },

      /** Mark a single file as done in the list */
      markFileDone(fileName) {
        const li = Array.from(shadow.querySelectorAll(".file-list li"))
          .find((item) => item.textContent === fileName);
        if (li) { li.classList.remove("active"); li.classList.add("done"); }
      },

      /** Transition to "complete" state.  @param {number} matchCount  @param {string[]} [errors] */
      complete(matchCount, errors) {
        card.classList.add("complete");
        if (errors && errors.length > 0) {
          titleEl.textContent = "Processing Errors";
          titleEl.style.color = "#dc2626";
          subtitleEl.textContent = errors.join("; ");
          subtitleEl.style.color = "#dc2626";
        } else {
          titleEl.textContent = "Documents Secured";
          subtitleEl.textContent = matchCount
            ? `${matchCount} PII item(s) redacted`
            : "No configured PII patterns were detected";
        }
        progressFill.style.width = "100%";
        progressTrack.setAttribute("aria-valuenow", "100");
        statusText.textContent = "";
        skipBtn.style.display = "none";

        // Mark all files done
        shadow.querySelectorAll(".file-list li").forEach((li) => li.classList.add("done"));

        // Auto-dismiss after 2.5s (longer if errors)
        setTimeout(() => api.remove(), errors?.length ? 4000 : 1500);
      },

      /** Show blocked state — classification gate prevented upload */
      blocked(label, reason) {
        card.classList.add("complete");
        titleEl.textContent = "Upload Blocked";
        titleEl.style.color = "#dc2626";
        subtitleEl.textContent = reason || `Document classified "${label}" — upload not permitted`;
        subtitleEl.style.color = "#dc2626";
        progressFill.style.width = "100%";
        progressTrack.setAttribute("aria-valuenow", "100");
        progressFill.style.background = "#dc2626";
        statusText.textContent = `Classification: ${label}`;
        statusText.style.color = "#dc2626";
        statusText.style.fontWeight = "700";
        skipBtn.style.display = "none";

        // DO NOT auto-dismiss — user must acknowledge
        const dismissBtn = document.createElement("button");
        dismissBtn.className = "skip-btn";
        dismissBtn.textContent = "Dismiss";
        dismissBtn.style.marginTop = "12px";
        dismissBtn.addEventListener("click", () => api.remove());
        const cardEl = shadow.querySelector(".card");
        if (cardEl) cardEl.appendChild(dismissBtn);
      },

      /** Register skip callback */
      onSkip(fn) { _onSkip = fn; },

      /** Whether the user clicked skip */
      get wasSkipped() { return skipped; },

      /** Remove the overlay */
      remove() {
        document.removeEventListener("keydown", onOverlayKeydown, true);
        host.remove();
        activeOverlay = null;
        if (returnFocus?.isConnected) returnFocus.focus();
      },
    };

    skipBtn.addEventListener("click", () => {
      skipped = true;
      if (_onSkip) _onSkip();
      api.remove();
    });

    activeOverlay = api;
    queueMicrotask(() => card.focus());
    return api;
  }

  // ── File input interception ───────────────────────────────────────────────

  async function onFileInputChange(e) {
    const config = cachedSettings.uploadGuard || {};
    if (!isExtensionActive()) return;
    if (!config.enabled || (config.onlyOnAiSites && !isAiSite)) return;
    const input = e.target;
    if (input.type !== "file") return;
    if (input.dataset.llssOwn === "true") return;
    if (isRedactedDispatch) return; // Don't re-intercept our own dispatch

    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    const redactableFiles = files.filter((f) => isRedactableFile(f));
    const nonRedactable = files.filter((f) => !isRedactableFile(f));
    if (config.blockUnsupported !== false && nonRedactable.length > 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      clearFileInput(input);
      showToast(document.body, `Upload blocked — ${nonRedactable.length} file(s) use an unsupported format.`);
      return;
    }
    if (redactableFiles.length === 0) return;

    // Block the original event — we'll replace the files and re-dispatch.
    // This is necessary because redaction is async and we can't let the
    // original (unredacted) file reach the site's handlers.
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    if (config.confirmBeforeUpload) {
      const confirmed = await showUploadConfirmation(redactableFiles, config.allowBypass === true);
      if (!confirmed) {
        if (config.allowBypass === true) releaseFileInput(input, files);
        else {
          clearFileInput(input);
          showToast(document.body, "Upload cancelled. No file was shared with this site.");
        }
        return;
      }
    }

    // Show security overlay
    const overlay = createSecurityOverlay(redactableFiles.map((f) => f.name), config.allowBypass === true);
    let totalMatches = 0;
    let skipRequested = false;
    overlay.onSkip(() => { skipRequested = true; });

    // Process sequentially because the offscreen renderer has one isolated
    // document cache; this also bounds peak memory on large batches.
    const redactedFiles = [];
    const errors = [];
    for (let i = 0; i < redactableFiles.length; i++) {
      if (skipRequested) break;
      const file = redactableFiles[i];
      overlay.updateFileProgress(file.name, i, redactableFiles.length);

      try {
        const result = await processFileForRedaction(file);
        totalMatches += result.matchCount || 0;
        if (result.redactedFile) {
          redactedFiles.push(result.redactedFile);
        } else {
          throw new Error("No secured replacement was produced");
        }
        overlay.markFileDone(file.name);
        chrome.runtime.sendMessage({ type: "RECORD_UPLOAD_INTERCEPT" });
      } catch (err) {
        const msg = err?.message || "Unknown error";
        const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;

        // Check if this is a classification gate block
        if (msg.startsWith("CLASSIFICATION_BLOCKED:")) {
          const parts = msg.split(":");
          const label = parts[1] || "Unknown";
          const reason = parts.slice(2).join(":") || "Upload blocked by classification policy";
          if (dbg) dbg.log("upload", `BLOCKED by classification: ${file.name} (${label})`);
          overlay.blocked(label, reason);
          // Do NOT add to redactedFiles — block the entire upload
          clearFileInput(input);
          return;
        }

        if (dbg) dbg.error("upload", `Failed to redact ${file.name}:`, msg);
        errors.push(`${file.name}: ${msg}`);
        overlay.markFileDone(file.name);
        break;
      }
    }

    if (skipRequested) {
      if (config.allowBypass === true) releaseFileInput(input, files);
      else clearFileInput(input);
      return;
    }

    overlay.complete(totalMatches, errors);
    if (errors.length > 0 || redactedFiles.length !== redactableFiles.length) {
      clearFileInput(input);
      showToast(document.body, "Upload blocked because one or more files could not be secured.");
      return;
    }

    // Replace the input's files with the redacted versions + any non-redactable files
    const allFiles = [...redactedFiles, ...nonRedactable];
    replaceFileInput(input, allFiles);

    // Many sites (especially AI chat UIs) use hidden file inputs triggered by
    // custom buttons. They read input.files in their own callback which we
    // blocked with stopImmediatePropagation. Re-triggering the input's click()
    // would open the file dialog again, which is wrong. Instead, try to
    // programmatically trigger the site's upload by clicking the input again
    // in a way that re-reads the files. As a fallback, notify the user.
    const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;
    if (dbg) dbg.log("upload", `Redaction complete: ${totalMatches} PII items across ${allFiles.length} file(s). Files set on input.`);
  }

  // ── Drag-and-drop interception ────────────────────────────────────────────

  async function onFileDrop(e) {
    const config = cachedSettings.uploadGuard || {};
    if (!isExtensionActive()) return;
    if (!config.enabled) return;
    if (config.onlyOnAiSites && !isAiSite) return;
    if (isRedactedDispatch) return;

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    const redactableFiles = files.filter((f) => isRedactableFile(f));
    const nonRedactable = files.filter((f) => !isRedactableFile(f));
    if (config.blockUnsupported !== false && nonRedactable.length > 0) {
      e.stopImmediatePropagation();
      e.stopPropagation();
      e.preventDefault();
      showToast(document.body, `Upload blocked — ${nonRedactable.length} file(s) use an unsupported format.`);
      return;
    }
    if (redactableFiles.length === 0) return;

    // Block the drop — we'll re-dispatch with redacted files
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();

    if (config.confirmBeforeUpload) {
      const confirmed = await showUploadConfirmation(redactableFiles, config.allowBypass === true);
      if (!confirmed) {
        if (config.allowBypass === true) reDispatchDrop(e.target, files);
        else showToast(document.body, "Upload cancelled. No file was shared with this site.");
        return;
      }
    }

    const overlay = createSecurityOverlay(redactableFiles.map((f) => f.name), config.allowBypass === true);
    let totalMatches = 0;
    let skipRequested = false;
    overlay.onSkip(() => { skipRequested = true; });

    const redactedFiles = [];
    const errors = [];

    for (let i = 0; i < redactableFiles.length; i++) {
      if (skipRequested) break;
      const file = redactableFiles[i];
      overlay.updateFileProgress(file.name, i, redactableFiles.length);

      try {
        const result = await processFileForRedaction(file);
        totalMatches += result.matchCount || 0;
        if (result.redactedFile) {
          redactedFiles.push(result.redactedFile);
        } else {
          throw new Error("No secured replacement was produced");
        }
        overlay.markFileDone(file.name);
        chrome.runtime.sendMessage({ type: "RECORD_UPLOAD_INTERCEPT" });
      } catch (err) {
        const msg = err?.message || "Unknown error";
        const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;

        if (msg.startsWith("CLASSIFICATION_BLOCKED:")) {
          const parts = msg.split(":");
          const label = parts[1] || "Unknown";
          const reason = parts.slice(2).join(":") || "Upload blocked by classification policy";
          if (dbg) dbg.log("upload", `BLOCKED by classification: ${file.name} (${label})`);
          overlay.blocked(label, reason);
          return;
        }

        if (dbg) dbg.error("upload", `Failed to redact ${file.name}:`, msg);
        errors.push(`${file.name}: ${msg}`);
        overlay.markFileDone(file.name);
        break;
      }
    }

    if (skipRequested) {
      if (config.allowBypass === true) reDispatchDrop(e.target, files);
      return;
    }

    overlay.complete(totalMatches, errors);
    if (errors.length > 0 || redactedFiles.length !== redactableFiles.length) {
      showToast(document.body, "Upload blocked because one or more files could not be secured.");
      return;
    }

    // Re-dispatch the drop event with redacted files
    const allFiles = [...redactedFiles, ...nonRedactable];
    reDispatchDrop(e.target, allFiles);
  }

  // ── File processing ───────────────────────────────────────────────────────

  async function processFileForRedaction(file) {
    const maxBytes = Number(cachedSettings.uploadGuard?.maxFileSizeBytes) || (25 * 1024 * 1024);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error("File is empty or has an invalid size");
    }
    if (file.size > maxBytes) {
      throw new Error(`File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB safety limit`);
    }
    const buffer = await file.arrayBuffer();
    const data = LLSS_BinaryTransfer.toBase64(buffer, maxBytes);

    // Open a long-lived port to keep the service worker alive during
    // potentially long document processing (OCR can take minutes).
    // A connected port prevents Chrome from terminating the worker.
    let keepAlivePort = null;
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'doc-processing' });
    } catch (_) {}

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "REDACT_DOCUMENT",
        fileDataBase64: data,
        fileName: file.name,
        mimeType: file.type,
      });
    } finally {
      if (keepAlivePort) {
        try { keepAlivePort.disconnect(); } catch (_) {}
      }
    }

    if (!response?.success) {
      throw new Error(response?.error || "Redaction failed");
    }

    let redactedFile = null;
    if (response.redactedFileBase64) {
      // Build a new File from the redacted bytes, preserving the original extension
      const bytes = LLSS_BinaryTransfer.fromBase64(response.redactedFileBase64, 25 * 1024 * 1024);
      const format = response.redactedFileFormat || file.type;
      const ext = REDACTED_FILE_EXTENSIONS[format]
        || file.name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0].toLowerCase()
        || '';
      const baseName = file.name.replace(/\.[^.]+$/, "");
      redactedFile = new File([bytes], `${baseName}_secured${ext}`, { type: format });
    }

    return {
      redactedFile,
      matchCount: response.matchCount || 0,
      response,
    };
  }

  // ── File replacement ──────────────────────────────────────────────────────

  /**
   * Replace a file input's files with new File objects, then re-dispatch
   * the change event so the target site's handler processes the secured files.
   */
  function replaceFileInput(input, files) {
    const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;
    try {
      const dt = new DataTransfer();
      for (const f of files) {
        if (dbg) dbg.log("upload", `Adding to DataTransfer: ${f.name} (${f.size} bytes, ${f.type})`);
        dt.items.add(f);
      }
      input.files = dt.files;

      // Re-dispatch events to notify the site that files have changed.
      // We fire both 'input' and 'change' since different frameworks listen
      // on different events.  A small delay before dispatch ensures the
      // input.files property is readable by the site's handlers.
      isRedactedDispatch = true;
      setTimeout(() => {
        input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        setTimeout(() => { isRedactedDispatch = false; }, 50);
        if (dbg) dbg.log("upload", "File input replaced, input+change events dispatched");
      }, 100);
    } catch (err) {
      if (dbg) dbg.error("upload", "replaceFileInput failed:", err?.message || String(err));
      showToast(document.body, "File redaction complete but could not update the upload. Try re-selecting the file.");
    }
  }

  function clearFileInput(input) {
    try {
      const dt = new DataTransfer();
      input.files = dt.files;
    } catch {
      input.value = "";
    }
  }

  /**
   * Release the original files to the target site (user chose "skip").
   */
  function releaseFileInput(input, files) {
    isRedactedDispatch = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    setTimeout(() => { isRedactedDispatch = false; }, 0);
  }

  /**
   * Re-dispatch a drop event with new files.
   */
  function reDispatchDrop(target, files) {
    try {
      const dt = new DataTransfer();
      for (const f of files) {
        dt.items.add(f);
      }
      isRedactedDispatch = true;
      const newEvent = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      target.dispatchEvent(newEvent);
      setTimeout(() => { isRedactedDispatch = false; }, 0);
    } catch {
      // DragEvent construction not supported — show toast
      showToast(document.body, "Files redacted. Drag again to upload the secured versions.");
    }
  }

  // ── File type detection ───────────────────────────────────────────────────

  function isRedactableFile(file) {
    const ext = "." + (file.name || "").split(".").pop().toLowerCase();
    const redactableExts = [
      ".docx", ".xlsx", ".pdf", ".html", ".htm", ".md", ".markdown",
      ".txt", ".text", ".csv", ".tsv", ".tab", ".json", ".jsonl",
      ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
      ".env", ".log", ".rtf", ".rst", ".adoc", ".tex", ".latex",
      ".py", ".rb", ".php", ".js", ".ts", ".jsx", ".tsx", ".java",
      ".cs", ".go", ".rs", ".swift", ".kt", ".scala", ".c", ".cpp",
      ".h", ".hpp", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".sql", ".r",
      ".zip",
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
    ];
    return redactableExts.includes(ext);
  }

  // ── Upload confirmation dialog ────────────────────────────────────────────

  function showUploadConfirmation(files, allowBypass = false) {
    return new Promise((resolve) => {
      const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overlay = document.createElement("div");
      overlay.className = "llss-confirm-overlay";

      const dialog = document.createElement("div");
      dialog.className = "llss-confirm-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "llss-confirm-title");
      dialog.tabIndex = -1;
      dialog.innerHTML = `
        <div class="llss-confirm-header">
          <span class="llss-ai-banner-icon">&#x1f6e1;</span>
          <strong id="llss-confirm-title">PII Check Required</strong>
        </div>
        <p class="llss-confirm-body">
          ${files.length} file(s) will be uploaded. Would you like to check for PII first?
        </p>
        <ul class="llss-confirm-files">
          ${files.map((f) => `<li>${escapeHtml(f.name)} (${formatSize(f.size)})</li>`).join("")}
        </ul>
        <div class="llss-confirm-actions">
          <button class="llss-result-btn" data-action="skip">${allowBypass ? "Upload Original" : "Cancel Upload"}</button>
          <button class="llss-result-btn llss-result-btn-close" data-action="redact">Check &amp; Redact</button>
        </div>
      `;

      const finish = (value) => {
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        if (returnFocus?.isConnected) returnFocus.focus();
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
          return;
        }
        if (event.key !== "Tab") return;
        const buttons = Array.from(dialog.querySelectorAll("button:not([disabled])"));
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      dialog.querySelector('[data-action="skip"]').addEventListener("click", () => finish(false));
      dialog.querySelector('[data-action="redact"]').addEventListener("click", () => finish(true));
      document.addEventListener("keydown", onKeyDown, true);

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      dialog.querySelector('[data-action="redact"]').focus();
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ── Utility: text input detection and manipulation ────────────────────────

  function isTextInput(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT" && ["text", "search", "email", "tel", "url"].includes(el.type)) return true;
    if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return true;
    // Check role
    if (el.getAttribute("role") === "textbox") return true;
    return false;
  }

  function getElementText(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return el.innerText || el.textContent || "";
  }

  function _normText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  // Returns true only if the field verifiably holds the new text. For rich
  // React editors (e.g. Copilot) that reject programmatic writes, this returns
  // false so leak-sensitive callers can block the send and fall back to the
  // clipboard rather than send the un-redacted original.
  function setElementText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const prototype = el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // A controlled framework or synchronous page handler may restore the old
      // value. Never report success unless the shared DOM contains the redacted
      // text after its input handlers have run.
      return el.value === text;
    }
    // contenteditable / rich editors (ProseMirror, Lexical): replace the whole
    // content via execCommand so the editor's change tracking registers it,
    // then verify it actually took. execCommand is a no-op in editors that
    // intercept programmatic input — hence the verification.
    try {
      el.focus();
      const sel = window.getSelection();
      if (sel) sel.selectAllChildren(el);
      if (document.execCommand) document.execCommand("insertText", false, text);
    } catch { /* verified below */ }
    return _normText(getElementText(el)) === _normText(text);
  }

  // When a site's editor blocks programmatic insertion, put the redacted text
  // on the clipboard and tell the user to paste it — so they're never stuck
  // with un-redacted text they can't replace.
  function _clipboardFallback(el, text) {
    const parent = (el && el.parentNode) || document.body;
    const paste = (navigator.platform || "").toLowerCase().includes("mac") ? "⌘V" : "Ctrl+V";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => showToast(parent, `This site blocks automatic insertion. Redacted text copied — press ${paste} to paste it before sending.`),
          () => showToast(parent, "This site blocks automatic insertion of redacted text. Please redact manually before sending.")
        );
        return;
      }
    } catch { /* fall through */ }
    showToast(parent, "This site blocks automatic insertion of redacted text.");
  }

  // ── Engine badge ─────────────────────────────────────────────────────────

  function showBadge(btn, engine, matchCount, tier, coverage) {
    const badge = document.createElement("span");
    badge.className = "llss-badge";

    const engineLabel = engine === "local_ai" ? "AI (Local)" :
                        engine === "regex" ? "Regex" :
                        engine === "regex+vector" ? "Regex+Names" :
                        engine.includes("+") ? engine.replace("local_ai+regex", "AI+Regex") :
                        engine.includes("azure") ? "Azure PII" :
                        engine.includes("hosted") ? "Hosted" : engine;

    const tierIcon = tier === "local" ? "\u{1F3E0}" :
                     tier === "hosted" ? "\u{1F3E2}" :
                     tier === "cloud" ? "\u{2601}\u{FE0F}" : "";

    const status = LLSS_ScanStatus.describe(coverage);
    badge.textContent = `${status.label} · ${matchCount || 0} found · ${tierIcon} ${engineLabel}`;
    badge.classList.toggle('llss-badge-limited', status.limited);
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.setAttribute('aria-label', `${matchCount || 0} items found. ${status.detail}`);
    badge.title = status.detail;
    const parent = btn.parentNode || document.body;
    parent.appendChild(badge);
    setTimeout(() => badge.remove(), 3000);
  }

  // ── Toast notification ───────────────────────────────────────────────────

  function showToast(parent, message) {
    const toast = document.createElement("div");
    toast.className = "llss-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = message;
    (parent || document.body).appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── DOM scanning ─────────────────────────────────────────────────────────

  function scanElement(root) {
    if (!root || !root.querySelectorAll) return;
    if (!isExtensionActive()) return;

    // Avoid re-parenting compact single-line inputs: doing so can break site
    // layout/framework bindings. Submit and auto-redact guards still cover
    // those fields through TEXT_FIELD_SELECTOR/isTextInput.
    root.querySelectorAll("textarea").forEach(attachToTextarea);

    if (cachedSettings.enableContentEditable) {
      root
        .querySelectorAll("[contenteditable='true'], [contenteditable='']")
        .forEach((el) => {
          if (el.offsetHeight < 20 || el.offsetWidth < 50) return;
          attachToContentEditable(el);
        });
    }
  }

  function startDomProtection() {
    if (!document.body) return;
    scanElement(document);

    // Watch for dynamically added elements (SPAs, lazy-loaded UI).
    const observer = new MutationObserver((mutations) => {
      if (!isExtensionActive()) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.tagName === "TEXTAREA") {
            attachToTextarea(node);
          } else if (
            node.getAttribute &&
            (node.getAttribute("contenteditable") === "true" ||
             node.getAttribute("contenteditable") === "")
          ) {
            attachToContentEditable(node);
          } else {
            scanElement(node);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Register capture-phase guards before page scripts install their own event
  // handlers. Each handler consults the asynchronously loaded settings.
  setupAutoRedact();
  setupSubmitGuard();
  setupUploadGuard();

  if (document.body) startDomProtection();
  else document.addEventListener("DOMContentLoaded", startDomProtection, { once: true });
})();
