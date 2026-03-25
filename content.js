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

  // ── Settings ─────────────────────────────────────────────────────────────

  function refreshSettings() {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
      if (!response?.settings) return;
      cachedSettings = response.settings;
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
    btn.innerHTML = '<span class="llss-btn-icon">&#x1f6e1;</span> Redact PII';
    btn.title = "Redact personally identifiable information";
    btn.type = "button";
    return btn;
  }

  function createUploadButton() {
    const btn = document.createElement("button");
    btn.className = `${BUTTON_CLASS} ${UPLOAD_CLASS}`;
    btn.innerHTML = '<span class="llss-btn-icon">&#x1f4c4;</span> Redact File';
    btn.title = "Upload a document for PII redaction (Word, Excel, HTML, Markdown, Image)";
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
    copyBtn.textContent = "Copy";
    copyBtn.className = "llss-result-btn";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(response.redacted);
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.className = "llss-result-btn llss-result-btn-close";
    closeBtn.addEventListener("click", () => overlay.remove());

    actions.appendChild(copyBtn);
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

    if (cachedSettings.enableDocumentUpload) {
      const uploadBtn = createUploadButton();
      wrapper.appendChild(uploadBtn);
      uploadBtn.addEventListener("click", () =>
        triggerFileUpload((val) => {
          textarea.value = val;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }, uploadBtn)
      );
    }
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

    if (cachedSettings.enableDocumentUpload) {
      const uploadBtn = createUploadButton();
      uploadBtn.classList.add("llss-ce-btn");
      wrapper.appendChild(uploadBtn);
      uploadBtn.addEventListener("click", () =>
        triggerFileUpload((val) => {
          el.innerText = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, uploadBtn)
      );
    }
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
      const response = await chrome.runtime.sendMessage({ type: "REDACT", text });

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

  const autoRedactTimers = new WeakMap();

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
    const debounce = config.debounceMs || 1500;

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

    // Short delay to let paste complete
    setTimeout(() => autoRedactElement(el), 100);
  }

  async function autoRedactElement(el) {
    const text = getElementText(el).trim();
    if (!text || text.length < 5) return;

    el.dataset.llssAutoRedacting = "true";
    const redactId = Symbol();
    pendingRedactions.add(redactId);

    try {
      const response = await chrome.runtime.sendMessage({ type: "REDACT", text });
      if (response?.success && response.redacted !== text) {
        setElementText(el, response.redacted);

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
      const response = await chrome.runtime.sendMessage({ type: "REDACT", text });
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
        const response = await chrome.runtime.sendMessage({ type: "REDACT", text });
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

    chrome.runtime.sendMessage({ type: "REDACT", text }, (response) => {
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
  // Intercepts file input changes to redact documents before they're uploaded.

  let uploadGuardActive = false;

  function setupUploadGuard() {
    const config = cachedSettings.uploadGuard || {};
    if (!config.enabled) return;
    if (config.onlyOnAiSites && !isAiSite) return;
    if (uploadGuardActive) return;
    uploadGuardActive = true;

    // Intercept all file input changes
    document.addEventListener("change", onFileInputChange, true);

    // Intercept drag-and-drop uploads
    document.addEventListener("drop", onFileDrop, true);
  }

  async function onFileInputChange(e) {
    const input = e.target;
    if (input.type !== "file") return;
    // Skip our own file inputs
    if (input.dataset.llssOwn === "true") return;

    const files = input.files;
    if (!files || files.length === 0) return;

    const config = cachedSettings.uploadGuard || {};

    // Check if any files are document types we can redact
    const redactableFiles = Array.from(files).filter((f) => isRedactableFile(f));
    if (redactableFiles.length === 0) return;

    if (config.confirmBeforeUpload) {
      e.preventDefault();
      e.stopImmediatePropagation();

      // Show confirmation
      const confirmed = await showUploadConfirmation(redactableFiles);
      if (!confirmed) {
        // Clear the input
        input.value = "";
        return;
      }

      // Redact each file and show results
      for (const file of redactableFiles) {
        try {
          const buffer = await file.arrayBuffer();
          const data = Array.from(new Uint8Array(buffer));

          const response = await chrome.runtime.sendMessage({
            type: "REDACT_DOCUMENT",
            fileData: data,
            fileName: file.name,
            mimeType: file.type,
          });

          if (response?.success) {
            showResultOverlay(document.body, response, file.name);
            chrome.runtime.sendMessage({ type: "RECORD_UPLOAD_INTERCEPT" });
          }
        } catch {
          showToast(document.body, `Could not redact ${file.name}`);
        }
      }

      // Clear the upload since we've intercepted it
      input.value = "";
    }
  }

  async function onFileDrop(e) {
    const config = cachedSettings.uploadGuard || {};
    if (!config.enabled) return;
    if (config.onlyOnAiSites && !isAiSite) return;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const redactableFiles = Array.from(files).filter((f) => isRedactableFile(f));
    if (redactableFiles.length === 0) return;

    // Show warning toast
    showToast(document.body, `${redactableFiles.length} file(s) detected — checking for PII...`);

    for (const file of redactableFiles) {
      try {
        const buffer = await file.arrayBuffer();
        const data = Array.from(new Uint8Array(buffer));

        const response = await chrome.runtime.sendMessage({
          type: "REDACT_DOCUMENT",
          fileData: data,
          fileName: file.name,
          mimeType: file.type,
        });

        if (response?.success && response.matchCount > 0) {
          showResultOverlay(document.body, response, file.name);
          chrome.runtime.sendMessage({ type: "RECORD_UPLOAD_INTERCEPT" });
        }
      } catch {
        // Don't block the drop, just warn
      }
    }
  }

  function isRedactableFile(file) {
    const ext = "." + (file.name || "").split(".").pop().toLowerCase();
    const redactableExts = [
      ".docx", ".doc", ".xlsx", ".xls", ".pdf", ".html", ".htm",
      ".md", ".markdown", ".txt", ".csv",
    ];
    return redactableExts.includes(ext);
  }

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
