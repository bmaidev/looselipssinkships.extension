// popup.js — Queries the background worker for provider status, current
// detection mode, and redaction statistics.

const dot = document.getElementById("status-dot");
const label = document.getElementById("status-label");
const detail = document.getElementById("status-detail");
const badgeContainer = document.getElementById("mode-badge-container");
const providersList = document.getElementById("providers-list");
const statRedactions = document.getElementById("stat-redactions");
const statMatches = document.getElementById("stat-matches");
const statDocs = document.getElementById("stat-docs");

const STATUS_MAP = {
  readily: {
    dotClass: "ready",
    label: "AI Model Ready",
    detail: "Local Gemini Nano model is loaded and ready.",
  },
  "after-download": {
    dotClass: "downloading",
    label: "Downloading Model...",
    detail: "The model is being downloaded. This is a one-time setup.",
  },
  downloadable: {
    dotClass: "downloading",
    label: "Downloading Model...",
    detail: "The model is being downloaded. This is a one-time setup.",
  },
  no: {
    dotClass: "unavailable",
    label: "Local AI Unavailable",
    detail: "Using regex fallback and configured providers.",
  },
};

const MODE_LABELS = {
  auto: { text: "Auto (Local First)", cls: "auto" },
  ai_only: { text: "AI Only", cls: "ai" },
  regex_only: { text: "Regex Only", cls: "regex" },
};

const TIER_LABELS = { local: "Local", hosted: "Hosted", cloud: "Cloud" };

// Fetch status from background.
chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
  const status = response?.status || "no";
  const info = STATUS_MAP[status] || STATUS_MAP["no"];

  if (status === "no") {
    // Check if any other providers are available
    const providers = response?.providers || [];
    const anyAvailable = providers.some(p => p.available && p.id !== "regex");
    if (anyAvailable) {
      dot.className = "status-dot ready";
      label.textContent = "Providers Active";
      detail.textContent = "Enterprise providers are handling redaction.";
    } else {
      dot.className = "status-dot fallback";
      label.textContent = "Regex Fallback Active";
      detail.textContent = info.detail;
    }
  } else {
    dot.className = `status-dot ${info.dotClass}`;
    label.textContent = info.label;
    detail.textContent = info.detail;
  }

  // Show current detection mode badge.
  const mode = response?.detectionMode || "auto";
  const modeInfo = MODE_LABELS[mode] || MODE_LABELS.auto;
  const badge = document.createElement("span");
  badge.className = `mode-badge ${modeInfo.cls}`;
  badge.textContent = modeInfo.text;
  badgeContainer.appendChild(badge);

  // Show provider list
  const providers = response?.providers || [];
  if (providers.length > 0) {
    providersList.innerHTML = providers.map(p => {
      const dotCls = p.available ? "on" : "off";
      const tier = TIER_LABELS[p.tier] || p.tier;
      return `<div class="provider-row">
        <span class="provider-dot ${dotCls}"></span>
        <span class="provider-name">${escapeHtml(p.name)}</span>
        <span class="provider-tier">${tier}</span>
      </div>`;
    }).join("");
  }
});

// Fetch stats.
chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
  if (response?.stats) {
    statRedactions.textContent = response.stats.totalRedactions || 0;
    statMatches.textContent = response.stats.totalMatches || 0;
    statDocs.textContent = response.stats.documentsProcessed || 0;
  }
});

// Open options page.
document.getElementById("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Reset stats.
document.getElementById("btn-reset-stats").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_STATS" }, () => {
    statRedactions.textContent = "0";
    statMatches.textContent = "0";
    statDocs.textContent = "0";
  });
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
