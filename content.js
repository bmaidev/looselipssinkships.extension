// content.js — Injects a "Redact" button beside active <textarea> elements.
// Clicking the button sends the textarea content to the background service
// worker for on-device PII redaction, then replaces the text in-place.

(() => {
  "use strict";

  const BUTTON_CLASS = "llss-redact-btn";
  const SPINNER_CLASS = "llss-spinner";

  // Avoid injecting twice if the content script runs more than once.
  if (window.__llssInjected) return;
  window.__llssInjected = true;

  // ── Button creation ──────────────────────────────────────────────────────
  function createRedactButton() {
    const btn = document.createElement("button");
    btn.className = BUTTON_CLASS;
    btn.textContent = "Redact PII";
    btn.title = "Redact personally identifiable information (processed locally)";
    btn.type = "button"; // prevent accidental form submission
    return btn;
  }

  // ── Attach button to a textarea ──────────────────────────────────────────
  function attachButton(textarea) {
    if (textarea.dataset.llss === "attached") return;
    textarea.dataset.llss = "attached";

    const btn = createRedactButton();

    // Position the button relative to the textarea's parent.
    const wrapper = document.createElement("div");
    wrapper.className = "llss-wrapper";
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.style.width = textarea.offsetWidth ? `${textarea.offsetWidth}px` : "100%";

    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);
    wrapper.appendChild(btn);

    btn.addEventListener("click", () => handleRedact(textarea, btn));
  }

  // ── Redaction handler ────────────────────────────────────────────────────
  async function handleRedact(textarea, btn) {
    const text = textarea.value.trim();
    if (!text) return;

    // Visual feedback: show spinner state.
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "";
    btn.classList.add(SPINNER_CLASS);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "REDACT",
        text,
      });

      if (response && response.success) {
        textarea.value = response.redacted;
        // Dispatch input event so page frameworks (React, Vue, etc.) detect the change.
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        const errMsg = response?.error || "Unknown error";
        console.error("[LLSS] Redaction failed:", errMsg);
        showToast(textarea, `Redaction failed: ${errMsg}`);
      }
    } catch (err) {
      console.error("[LLSS] Message send failed:", err);
      showToast(textarea, "Could not reach the redaction engine.");
    } finally {
      btn.disabled = false;
      btn.classList.remove(SPINNER_CLASS);
      btn.textContent = btn.dataset.originalText;
    }
  }

  // ── Toast notification ───────────────────────────────────────────────────
  function showToast(anchor, message) {
    const toast = document.createElement("div");
    toast.className = "llss-toast";
    toast.textContent = message;
    anchor.parentNode.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── Observe the DOM for dynamically added textareas ──────────────────────
  function scanTextareas(root) {
    const areas = root.querySelectorAll("textarea");
    areas.forEach(attachButton);
  }

  // Initial scan.
  scanTextareas(document);

  // Watch for textareas added after initial page load (SPAs, lazy-loaded UI).
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "TEXTAREA") {
          attachButton(node);
        } else {
          scanTextareas(node);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
