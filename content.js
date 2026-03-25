// content.js — Injects "Redact PII" buttons beside textareas and
// contenteditable elements. Sends text to the background worker for
// redaction and replaces the content in-place.

(() => {
  "use strict";

  const BUTTON_CLASS = "llss-redact-btn";
  const SPINNER_CLASS = "llss-spinner";

  if (window.__llssInjected) return;
  window.__llssInjected = true;

  // Cache settings from background. Refreshed periodically.
  let cachedSettings = { showRedactButton: true, enableContentEditable: true };

  function refreshSettings() {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
      if (response?.settings) cachedSettings = response.settings;
    });
  }
  refreshSettings();
  // Re-check settings every 30 seconds for live updates from the options page.
  setInterval(refreshSettings, 30000);

  // ── Button creation ──────────────────────────────────────────────────────

  function createRedactButton() {
    const btn = document.createElement("button");
    btn.className = BUTTON_CLASS;
    btn.innerHTML = '<span class="llss-btn-icon">&#x1f6e1;</span> Redact PII';
    btn.title = "Redact personally identifiable information (processed locally on your device)";
    btn.type = "button";
    return btn;
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
  }

  // ── Attach to contenteditable ────────────────────────────────────────────

  function attachToContentEditable(el) {
    if (el.dataset.llss === "attached") return;
    if (!cachedSettings.enableContentEditable) return;
    if (!cachedSettings.showRedactButton) return;
    el.dataset.llss = "attached";

    const btn = createRedactButton();
    btn.classList.add("llss-ce-btn");

    // Position relative to the editable element.
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
        showBadge(btn, response.engine, response.matchCount);
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
  // Brief visual feedback showing which engine was used and how many matches.

  function showBadge(btn, engine, matchCount) {
    const badge = document.createElement("span");
    badge.className = "llss-badge";
    const engineLabel = engine === "ai" ? "AI" :
                        engine === "ai+regex" ? "AI+Regex" :
                        engine === "regex+vector" ? "Regex+Names" : "Regex";
    badge.textContent = `${engineLabel} · ${matchCount || 0} found`;
    btn.parentNode.appendChild(badge);
    setTimeout(() => badge.remove(), 3000);
  }

  // ── Toast notification ───────────────────────────────────────────────────

  function showToast(parent, message) {
    const toast = document.createElement("div");
    toast.className = "llss-toast";
    toast.textContent = message;
    parent.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── DOM scanning ─────────────────────────────────────────────────────────

  function scanElement(root) {
    if (!root || !root.querySelectorAll) return;

    // Textareas.
    root.querySelectorAll("textarea").forEach(attachToTextarea);

    // Contenteditable elements.
    if (cachedSettings.enableContentEditable) {
      root
        .querySelectorAll("[contenteditable='true'], [contenteditable='']")
        .forEach((el) => {
          // Skip tiny elements (likely not text inputs).
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
