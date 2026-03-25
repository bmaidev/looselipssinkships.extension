// content.js — Injects "Redact PII" buttons beside textareas and
// contenteditable elements, plus document upload buttons.
// Sends text/documents to the background worker for redaction.

(() => {
  "use strict";

  const BUTTON_CLASS = "llss-redact-btn";
  const UPLOAD_CLASS = "llss-upload-btn";
  const SPINNER_CLASS = "llss-spinner";

  if (window.__llssInjected) return;
  window.__llssInjected = true;

  // Cache settings from background. Refreshed periodically.
  let cachedSettings = {
    showRedactButton: true,
    enableContentEditable: true,
    enableDocumentUpload: true,
  };

  function refreshSettings() {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
      if (response?.settings) cachedSettings = response.settings;
    });
  }
  refreshSettings();
  setInterval(refreshSettings, 30000);

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

  const SUPPORTED_EXTENSIONS = [
    ".docx", ".doc", ".xlsx", ".xls", ".pdf",
    ".html", ".htm", ".md", ".markdown", ".txt",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
  ];

  const SUPPORTED_ACCEPT = SUPPORTED_EXTENSIONS.join(",") +
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
        // Send as array (ArrayBuffer can't be sent via chrome.runtime.sendMessage)
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
            // No text field — show result in a modal overlay
            showResultOverlay(btn.parentNode || document.body, response, file.name);
          }
          showBadge(btn, response.engine, response.matchCount, response.tier);
        } else {
          const errMsg = response?.error || "Unknown error";
          console.error("[LLSS] Document redaction failed:", errMsg);
          showToast(btn.parentNode || document.body, `Redaction failed: ${errMsg}`);
        }
      } catch (err) {
        console.error("[LLSS] Document upload failed:", err);
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

  // ── Result overlay for document redaction ──────────────────────────────────

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

    // Append to body for visibility
    document.body.appendChild(overlay);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Attach to textarea ───────────────────────────────────────────────────

  function attachToTextarea(textarea) {
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

    // Add document upload button if enabled
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

    // Add document upload button if enabled
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

  // ── Redaction handler ────────────────────────────────────────────────────

  async function handleRedact(getText, setText, btn) {
    const text = getText().trim();
    if (!text) return;

    btn.disabled = true;
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = "";
    btn.classList.add(SPINNER_CLASS);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "REDACT",
        text,
      });

      if (response && response.success) {
        setText(response.redacted);
        showBadge(btn, response.engine, response.matchCount, response.tier);
      } else {
        const errMsg = response?.error || "Unknown error";
        console.error("[LLSS] Redaction failed:", errMsg);
        showToast(btn.parentNode, `Redaction failed: ${errMsg}`);
      }
    } catch (err) {
      console.error("[LLSS] Message send failed:", err);
      showToast(btn.parentNode, "Could not reach the redaction engine.");
    } finally {
      btn.disabled = false;
      btn.classList.remove(SPINNER_CLASS);
      btn.innerHTML = btn.dataset.originalHtml;
    }
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

    const tierIcon = tier === "local" ? "🏠" :
                     tier === "hosted" ? "🏢" :
                     tier === "cloud" ? "☁️" : "";

    badge.textContent = `${tierIcon} ${engineLabel} · ${matchCount || 0} found`;
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
