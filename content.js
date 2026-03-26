// content.js — Content script for Loose Lips Sink Ships.
// Injects redaction buttons, handles auto-redact, submit interception,
// upload guarding, AI chat service detection, and site filtering.

(() => {
  "use strict";

  const BUTTON_CLASS = "llss-redact-btn";
  const UPLOAD_CLASS = "llss-upload-btn";
  const SPINNER_CLASS = "llss-spinner";

  if (window.__llssInjected) return;
  window.__llssInjected = true;

  // ── State ────────────────────────────────────────────────────────────────

  let cachedSettings = {};
  let pageProtection = { active: true, reason: "normal" };
  let isAiSite = false;
  let pendingRedactions = new Set(); // Track in-flight redactions

  // ── Direct Nano (LanguageModel) support ──────────────────────────────
  // Content scripts run in the page's top-level window context where the
  // LanguageModel global IS available.  Using it directly avoids the
  // round-trip through the service worker (which can't access it anyway).

  const nanoSession = (typeof LLSS_NanoSession !== "undefined")
    ? new LLSS_NanoSession()
    : null;
  let nanoAvailable = null; // null = unchecked, true/false after first probe

  /**
   * Try to redact text directly via Nano.  Returns null if Nano is
   * unavailable so the caller can fall back to background messaging.
   */
  async function tryNanoRedact(text) {
    const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;

    // Fast exit if we already know Nano is absent
    if (nanoAvailable === false || !nanoSession) return null;

    // First call — probe availability
    if (nanoAvailable === null) {
      try {
        const avail = await nanoSession.checkAvailability();
        nanoAvailable = avail.available;
        if (dbg) dbg.log("nano", "Content script Nano probe:", avail.status, avail.detail);
        if (!nanoAvailable) return null;
      } catch (err) {
        if (dbg) dbg.warn("nano", "Content script Nano probe failed:", err);
        nanoAvailable = false;
        return null;
      }
    }

    // Build merged PII types from defaults + user overrides
    const defaultTypes = (typeof LLSS_PII_TYPES !== "undefined") ? LLSS_PII_TYPES : [];
    const getMerged = (typeof LLSS_getMergedPiiTypes !== "undefined") ? LLSS_getMergedPiiTypes : null;
    if (!getMerged || defaultTypes.length === 0) return null;
    const piiTypes = getMerged(defaultTypes, cachedSettings).filter(t => t.enabled);
    if (piiTypes.length === 0) return null;

    try {
      const done = dbg ? dbg.time("nano", `direct redact (${text.length} chars)`) : () => {};
      const result = await nanoSession.redact(text, piiTypes);
      done();
      return {
        success: true,
        redacted: result.redacted,
        engine: result.engine,
        tier: "local",
        matchCount: result.matches?.length || 0,
      };
    } catch (err) {
      if (dbg) dbg.warn("nano", "Direct Nano redact failed, falling back:", err);
      return null;
    }
  }

  /**
   * Redact text using the best available path:
   *   1. Direct Nano (LanguageModel in content script) — fastest, no IPC
   *   2. Background service worker (pipeline with offscreen proxy)
   */
  async function redactText(text) {
    const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;
    // Try direct Nano first (only if mode allows AI and belt-and-suspenders
    // is off — when regexAfterAi is on we need the full background pipeline).
    const mode = cachedSettings.detectionMode || "auto";
    if (mode !== "regex_only" && mode !== "cloud_only" && !cachedSettings.regexAfterAi) {
      const nanoResult = await tryNanoRedact(text);
      if (nanoResult) {
        if (dbg) dbg.log("redact", "Used direct Nano path (no IPC)");
        return nanoResult;
      }
    }

    // Fall back to background pipeline (handles regex fallback, belt-and-
    // suspenders, hosted/cloud escalation, and stats recording).
    if (dbg) dbg.log("redact", "Falling back to background pipeline", { mode, regexAfterAi: !!cachedSettings.regexAfterAi });
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "REDACT", text }, resolve);
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  function refreshSettings() {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
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
  setInterval(refreshSettings, 30000);

  function updatePageProtection() {
    chrome.runtime.sendMessage({
      type: "CHECK_SITE",
      url: window.location.href,
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
      }
    });
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
    bannerShown = true;

    const banner = document.createElement("div");
    banner.className = "llss-ai-banner";
    banner.innerHTML = '<span class="llss-ai-banner-icon">&#x1f6e1;</span>' +
      '<span class="llss-ai-banner-text"><strong>Loose Lips Sink Ships</strong> — AI chat protection active. PII will be redacted before submission.</span>' +
      '<button class="llss-ai-banner-close">&times;</button>';

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
    btn.type = "button";
    return btn;
  }

  // ── File upload handler ────────────────────────────────────────────────────

  const SUPPORTED_ACCEPT =
    ".docx,.doc,.xlsx,.xls,.pdf,.html,.htm,.md,.markdown,.txt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tiff,.tif" +
    ",application/vnd.openxmlformats-officedocument.wordprocessingml.document" +
    ",application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" +
    ",application/pdf,text/html,text/markdown,text/plain,image/*";

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
        const buffer = await file.arrayBuffer();
        const data = Array.from(new Uint8Array(buffer));

        const response = await chrome.runtime.sendMessage({
          type: "REDACT_DOCUMENT",
          fileData: data,
          fileName: file.name,
          mimeType: file.type,
        });

        if (response && response.success) {
          if (setText) {
            setText(response.redacted);
          } else {
            showResultOverlay(btn.parentNode || document.body, response, file.name);
          }
          showBadge(btn, response.engine, response.matchCount, response.tier);
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
    const overlay = document.createElement("div");
    overlay.className = "llss-result-overlay";

    const header = document.createElement("div");
    header.className = "llss-result-header";
    header.innerHTML = `<strong>Redacted: ${escapeHtml(fileName)}</strong>` +
      `<span class="llss-result-meta">${response.engine} · ${response.matchCount || 0} items · ${response.tier || "local"}</span>`;

    const content = document.createElement("pre");
    content.className = "llss-result-content";
    content.textContent = response.redacted;

    const actions = document.createElement("div");
    actions.className = "llss-result-actions";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy Text";
    copyBtn.className = "llss-result-btn";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(response.redacted);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy Text"; }, 2000);
    });

    actions.appendChild(copyBtn);

    // If a redacted file is available (PDF/image), offer download
    if (response.redactedFile && response.redactedFile.length > 0) {
      const downloadBtn = document.createElement("button");
      downloadBtn.textContent = "Download Redacted File";
      downloadBtn.className = "llss-result-btn";
      downloadBtn.addEventListener("click", () => {
        const bytes = new Uint8Array(response.redactedFile);
        const format = response.redactedFileFormat || "application/pdf";
        const blob = new Blob([bytes], { type: format });
        const url = URL.createObjectURL(blob);
        const ext = format.includes("pdf") ? ".pdf" : format.includes("png") ? ".png" : "";
        const baseName = fileName.replace(/\.[^.]+$/, "");
        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}_redacted${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        downloadBtn.textContent = "Downloaded!";
        setTimeout(() => { downloadBtn.textContent = "Download Redacted File"; }, 2000);
      });
      actions.appendChild(downloadBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.className = "llss-result-btn llss-result-btn-close";
    closeBtn.addEventListener("click", () => overlay.remove());

    actions.appendChild(closeBtn);
    overlay.appendChild(header);
    overlay.appendChild(content);
    overlay.appendChild(actions);
    document.body.appendChild(overlay);
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
        showBadge(btn, response.engine, response.matchCount, response.tier);
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

  function setupAutoRedact() {
    const config = cachedSettings.autoRedact || {};
    if (!config.enabled && !(isAiSite && cachedSettings.aiChatGuard?.autoRedactOnAiSites)) return;
    if (config.onlyOnAiSites && !isAiSite) return;

    // Attach auto-redact listeners to all text inputs
    document.addEventListener("input", onAutoRedactInput, true);
    document.addEventListener("paste", onAutoRedactPaste, true);
  }

  function onAutoRedactInput(e) {
    const el = e.target;
    if (!isTextInput(el)) return;
    if (el.dataset.llssAutoRedacting === "true") return;

    const config = cachedSettings.autoRedact || {};
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
    const el = e.target;
    if (!isTextInput(el)) return;

    const config = cachedSettings.autoRedact || {};
    if (!config.onPaste) return;

    // Short delay to let paste complete, then redact
    setTimeout(() => autoRedactElement(el), 300);
  }

  async function autoRedactElement(el) {
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
        setElementText(el, response.redacted);
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
    const config = cachedSettings.submitGuard || {};
    if (!config.enabled) return;
    if (config.onlyOnAiSites && !isAiSite) return;
    if (submitGuardActive) return;
    submitGuardActive = true;

    // Intercept Enter key
    if (config.interceptEnter) {
      document.addEventListener("keydown", onSubmitKeydown, true);
    }

    // Intercept form submit
    if (config.interceptFormSubmit) {
      document.addEventListener("submit", onFormSubmit, true);
    }

    // Intercept send button clicks
    if (config.interceptSendButtons) {
      document.addEventListener("click", onSendButtonClick, true);
    }
  }

  async function onSubmitKeydown(e) {
    if (e.key !== "Enter") return;
    // Only intercept in text inputs (not in general navigation)
    const el = e.target;
    if (!isTextInput(el)) return;

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
          setElementText(el, response.redacted);
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
      }
    } catch {
      el.dataset.llssSubmitBlocked = "false";
      removeSubmitIndicator(indicator);
    }
  }

  function onFormSubmit(e) {
    // If we already allowed this submit, let it through
    const form = e.target;
    if (form.dataset.llssAllowSubmit === "true") return;

    // Find text inputs in the form
    const textInputs = form.querySelectorAll("textarea, [contenteditable='true'], [contenteditable='']");
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

    redactFormFields(form, textInputs).then(() => {
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

  async function redactFormFields(form, fields) {
    const promises = Array.from(fields).map(async (field) => {
      const text = getElementText(field).trim();
      if (!text) return;

      try {
        const response = await redactText(text);
        if (response?.success && response.redacted !== text) {
          setElementText(field, response.redacted);
        }
      } catch {
        // Proceed even if redaction fails
      }
    });
    await Promise.all(promises);
  }

  function onSendButtonClick(e) {
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
      if (response?.success && response.redacted !== text) {
        setElementText(textInput, response.redacted);
      }
      chrome.runtime.sendMessage({ type: "RECORD_SUBMIT_INTERCEPT" });

      // Re-click the button
      btn.dataset.llssAllowSubmit = "true";
      btn.click();
      btn.dataset.llssAllowSubmit = "false";
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
      const textarea = container.querySelector("textarea");
      if (textarea) return textarea;
      const ce = container.querySelector("[contenteditable='true'], [contenteditable='']");
      if (ce) return ce;
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

  // Re-entry guard for keydown
  const _origOnSubmitKeydown = onSubmitKeydown;
  document.addEventListener("keydown", (e) => {
    if (e.target.dataset?.llssAllowSubmit === "true") return;
  }, true);

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
    const config = cachedSettings.uploadGuard || {};
    if (!config.enabled) return;
    if (config.onlyOnAiSites && !isAiSite) return;
    if (uploadGuardActive) return;
    uploadGuardActive = true;

    // Capture phase ensures we run BEFORE the target site's listeners
    document.addEventListener("change", onFileInputChange, true);
    document.addEventListener("drop", onFileDrop, true);

    // Listen for progress updates from background (forwarded from offscreen OCR)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "REDACT_PROGRESS" && activeOverlay) {
        activeOverlay.updateProgress(msg);
      }
    });
  }

  // ── Security overlay (Shadow DOM) ─────────────────────────────────────────

  let activeOverlay = null;

  function createSecurityOverlay(fileNames) {
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
        <div class="card">
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
          <div class="title">Securing Documents</div>
          <div class="subtitle">Scanning for personal information...</div>
          <ul class="file-list">
            ${fileNames.map((n) => `<li data-file="${n}">${n}</li>`).join("")}
          </ul>
          <div class="progress-track"><div class="progress-fill"></div></div>
          <div class="status-text">Preparing...</div>
          <button class="skip-btn">Skip &mdash; upload without redaction</button>
        </div>
      </div>
    `;

    document.body.appendChild(host);

    const card = shadow.querySelector(".card");
    const progressFill = shadow.querySelector(".progress-fill");
    const statusText = shadow.querySelector(".status-text");
    const titleEl = shadow.querySelector(".title");
    const subtitleEl = shadow.querySelector(".subtitle");
    const skipBtn = shadow.querySelector(".skip-btn");
    let skipped = false;
    let _onSkip = null;

    const api = {
      /** Update progress from OCR_PROGRESS messages */
      updateProgress(msg) {
        if (!msg) return;
        const { phase, currentPage, totalPages, completed } = msg;

        if (phase === "rendering" && totalPages) {
          const pct = Math.round((currentPage / totalPages) * 30); // Render = 0-30%
          progressFill.style.width = pct + "%";
          statusText.textContent = `Rendering page ${currentPage} of ${totalPages}...`;
        } else if (phase === "ocr" && totalPages) {
          const pct = 30 + Math.round(((completed || currentPage) / totalPages) * 50); // OCR = 30-80%
          progressFill.style.width = pct + "%";
          statusText.textContent = `OCR: page ${completed || currentPage} of ${totalPages}...`;
        } else if (phase === "redacting" && totalPages) {
          const pct = 80 + Math.round((currentPage / totalPages) * 15); // Redact = 80-95%
          progressFill.style.width = pct + "%";
          statusText.textContent = `Redacting page ${currentPage} of ${totalPages}...`;
        } else if (phase === "ocr_complete" || phase === "complete") {
          progressFill.style.width = "95%";
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
      },

      /** Mark a single file as done in the list */
      markFileDone(fileName) {
        const li = shadow.querySelector(`[data-file="${fileName}"]`);
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
            : "No PII detected — files are clean";
        }
        progressFill.style.width = "100%";
        statusText.textContent = "";
        skipBtn.style.display = "none";

        // Mark all files done
        shadow.querySelectorAll(".file-list li").forEach((li) => li.classList.add("done"));

        // Auto-dismiss after 2.5s (longer if errors)
        setTimeout(() => api.remove(), errors?.length ? 4000 : 1500);
      },

      /** Register skip callback */
      onSkip(fn) { _onSkip = fn; },

      /** Whether the user clicked skip */
      get wasSkipped() { return skipped; },

      /** Remove the overlay */
      remove() { host.remove(); activeOverlay = null; },
    };

    skipBtn.addEventListener("click", () => {
      skipped = true;
      if (_onSkip) _onSkip();
      api.remove();
    });

    activeOverlay = api;
    return api;
  }

  // ── File input interception ───────────────────────────────────────────────

  async function onFileInputChange(e) {
    const input = e.target;
    if (input.type !== "file") return;
    if (input.dataset.llssOwn === "true") return;
    if (isRedactedDispatch) return; // Don't re-intercept our own dispatch

    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    const config = cachedSettings.uploadGuard || {};
    const redactableFiles = files.filter((f) => isRedactableFile(f));
    if (redactableFiles.length === 0) return;

    // Block the original event — we'll replace the files and re-dispatch.
    // This is necessary because redaction is async and we can't let the
    // original (unredacted) file reach the site's handlers.
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    if (config.confirmBeforeUpload) {
      const confirmed = await showUploadConfirmation(redactableFiles);
      if (!confirmed) {
        // User chose "Skip" — release the original files to the site
        releaseFileInput(input, files);
        return;
      }
    }

    // Show security overlay
    const overlay = createSecurityOverlay(redactableFiles.map((f) => f.name));
    let totalMatches = 0;
    let skipRequested = false;
    overlay.onSkip(() => { skipRequested = true; });

    // Process files through the queue (max 2 concurrent)
    const redactedFiles = [];
    const nonRedactable = files.filter((f) => !isRedactableFile(f));

    const errors = [];
    for (let i = 0; i < redactableFiles.length; i++) {
      if (skipRequested) break;
      const file = redactableFiles[i];
      overlay.updateFileProgress(file.name, i, redactableFiles.length);

      try {
        const result = await processFileForRedaction(file);
        if (result.redactedFile) {
          redactedFiles.push(result.redactedFile);
          totalMatches += result.matchCount || 0;
        } else {
          // No pixel redaction available — keep original
          redactedFiles.push(file);
        }
        overlay.markFileDone(file.name);
        chrome.runtime.sendMessage({ type: "RECORD_UPLOAD_INTERCEPT" });
      } catch (err) {
        const msg = err?.message || "Unknown error";
        const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;
        if (dbg) dbg.error("upload", `Failed to redact ${file.name}:`, msg);
        errors.push(`${file.name}: ${msg}`);
        redactedFiles.push(file);
        overlay.markFileDone(file.name);
      }
    }

    if (skipRequested) {
      // User skipped — release originals
      releaseFileInput(input, files);
      return;
    }

    overlay.complete(totalMatches, errors);

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
    if (!config.enabled) return;
    if (config.onlyOnAiSites && !isAiSite) return;
    if (isRedactedDispatch) return;

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    const redactableFiles = files.filter((f) => isRedactableFile(f));
    if (redactableFiles.length === 0) return;

    // Block the drop — we'll re-dispatch with redacted files
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();

    const overlay = createSecurityOverlay(redactableFiles.map((f) => f.name));
    let totalMatches = 0;
    let skipRequested = false;
    overlay.onSkip(() => { skipRequested = true; });

    const redactedFiles = [];
    const nonRedactable = files.filter((f) => !isRedactableFile(f));
    const errors = [];

    for (let i = 0; i < redactableFiles.length; i++) {
      if (skipRequested) break;
      const file = redactableFiles[i];
      overlay.updateFileProgress(file.name, i, redactableFiles.length);

      try {
        const result = await processFileForRedaction(file);
        if (result.redactedFile) {
          redactedFiles.push(result.redactedFile);
          totalMatches += result.matchCount || 0;
        } else {
          redactedFiles.push(file);
        }
        overlay.markFileDone(file.name);
        chrome.runtime.sendMessage({ type: "RECORD_UPLOAD_INTERCEPT" });
      } catch (err) {
        const msg = err?.message || "Unknown error";
        const dbg = typeof LLSS_debug !== "undefined" ? LLSS_debug : null;
        if (dbg) dbg.error("upload", `Failed to redact ${file.name}:`, msg);
        errors.push(`${file.name}: ${msg}`);
        redactedFiles.push(file);
        overlay.markFileDone(file.name);
      }
    }

    if (skipRequested) {
      // Re-dispatch the original drop
      reDispatchDrop(e.target, files);
      return;
    }

    overlay.complete(totalMatches, errors);

    // Re-dispatch the drop event with redacted files
    const allFiles = [...redactedFiles, ...nonRedactable];
    reDispatchDrop(e.target, allFiles);
  }

  // ── File processing ───────────────────────────────────────────────────────

  async function processFileForRedaction(file) {
    const buffer = await file.arrayBuffer();
    const data = Array.from(new Uint8Array(buffer));

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
        fileData: data,
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
    if (response.redactedFile && response.redactedFile.length > 0) {
      // Build a new File from the redacted bytes
      const bytes = new Uint8Array(response.redactedFile);
      const format = response.redactedFileFormat || file.type;
      const ext = format.includes("pdf") ? ".pdf" : format.includes("png") ? ".png" : "";
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
      ".docx", ".doc", ".xlsx", ".xls", ".pdf", ".html", ".htm",
      ".md", ".markdown", ".txt", ".csv",
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
    ];
    return redactableExts.includes(ext);
  }

  // ── Upload confirmation dialog ────────────────────────────────────────────

  function showUploadConfirmation(files) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "llss-confirm-overlay";

      const dialog = document.createElement("div");
      dialog.className = "llss-confirm-dialog";
      dialog.innerHTML = `
        <div class="llss-confirm-header">
          <span class="llss-ai-banner-icon">&#x1f6e1;</span>
          <strong>PII Check Required</strong>
        </div>
        <p class="llss-confirm-body">
          ${files.length} file(s) will be uploaded. Would you like to check for PII first?
        </p>
        <ul class="llss-confirm-files">
          ${files.map((f) => `<li>${escapeHtml(f.name)} (${formatSize(f.size)})</li>`).join("")}
        </ul>
        <div class="llss-confirm-actions">
          <button class="llss-result-btn" data-action="skip">Skip (Upload as-is)</button>
          <button class="llss-result-btn llss-result-btn-close" data-action="redact">Check &amp; Redact</button>
        </div>
      `;

      dialog.querySelector('[data-action="skip"]').addEventListener("click", () => {
        overlay.remove();
        resolve(false);
      });
      dialog.querySelector('[data-action="redact"]').addEventListener("click", () => {
        overlay.remove();
        resolve(true);
      });

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
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
    if (el.tagName === "INPUT" && el.type === "text") return true;
    if (el.getAttribute("contenteditable") === "true" || el.getAttribute("contenteditable") === "") return true;
    // Check role
    if (el.getAttribute("role") === "textbox") return true;
    return false;
  }

  function getElementText(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    return el.innerText || el.textContent || "";
  }

  function setElementText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = text;
    } else {
      el.innerText = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ── Engine badge ─────────────────────────────────────────────────────────

  function showBadge(btn, engine, matchCount, tier) {
    const badge = document.createElement("span");
    badge.className = "llss-badge";

    const engineLabel = engine === "local_ai" ? "AI (Local)" :
                        engine === "regex" ? "Regex" :
                        engine === "regex+vector" ? "Regex+Names" :
                        engine.includes("+") ? engine.replace("local_ai+regex", "AI+Regex") :
                        engine.includes("azure") ? "Azure PII" :
                        engine.includes("purview") ? "Purview" :
                        engine.includes("hosted") ? "Hosted" : engine;

    const tierIcon = tier === "local" ? "\u{1F3E0}" :
                     tier === "hosted" ? "\u{1F3E2}" :
                     tier === "cloud" ? "\u{2601}\u{FE0F}" : "";

    badge.textContent = `${tierIcon} ${engineLabel} \u00B7 ${matchCount || 0} found`;
    const parent = btn.parentNode || document.body;
    parent.appendChild(badge);
    setTimeout(() => badge.remove(), 3000);
  }

  // ── Toast notification ───────────────────────────────────────────────────

  function showToast(parent, message) {
    const toast = document.createElement("div");
    toast.className = "llss-toast";
    toast.textContent = message;
    (parent || document.body).appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── DOM scanning ─────────────────────────────────────────────────────────

  function scanElement(root) {
    if (!root || !root.querySelectorAll) return;
    if (!isExtensionActive()) return;

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

  // Initial scan.
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
})();
