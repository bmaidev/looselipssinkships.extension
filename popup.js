// popup.js — Queries provider status, checks Nano availability directly
// (popup runs in a document context where LanguageModel is available),
// and shows redaction statistics.

const dot = document.getElementById("status-dot");
const label = document.getElementById("status-label");
const detail = document.getElementById("status-detail");
const badgeContainer = document.getElementById("mode-badge-container");
const providersList = document.getElementById("providers-list");
const statRedactions = document.getElementById("stat-redactions");
const statMatches = document.getElementById("stat-matches");
const statDocs = document.getElementById("stat-docs");

// Handles both old API values (readily, after-download) and new API values
// (available, downloadable, downloading, unavailable).
const STATUS_MAP = {
  // New Prompt API values
  available:    { dotClass: "ready",       label: "AI Model Ready",         detail: "Local Gemini Nano model is loaded and ready." },
  downloadable: { dotClass: "downloading", label: "Downloading Model...",   detail: "The model is being downloaded. This is a one-time setup." },
  downloading:  { dotClass: "downloading", label: "Downloading Model...",   detail: "The model is being downloaded. This is a one-time setup." },
  unavailable:  { dotClass: "unavailable", label: "Local AI Unavailable",   detail: "Using regex fallback and configured providers." },
  // Legacy values (older Chrome builds)
  readily:          { dotClass: "ready",       label: "AI Model Ready",       detail: "Local Gemini Nano model is loaded and ready." },
  "after-download": { dotClass: "downloading", label: "Downloading Model...", detail: "The model is being downloaded. This is a one-time setup." },
  no:               { dotClass: "unavailable", label: "Local AI Unavailable", detail: "Using regex fallback and configured providers." },
};

const MODE_LABELS = {
  auto: { text: "Auto (Local First)", cls: "auto" },
  ai_only: { text: "AI Only", cls: "ai" },
  regex_only: { text: "Regex Only", cls: "regex" },
};

const TIER_LABELS = { local: "Local", hosted: "Hosted", cloud: "Cloud" };

// ── Check Nano availability directly (popup is a document context) ────────

async function checkNanoDirectly() {
  if (typeof LanguageModel === "undefined") return "no";
  try {
    return await LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  } catch {
    return "no";
  }
}

// ── Main status fetch ─────────────────────────────────────────────────────

(async () => {
  // Run Nano check and background status fetch in parallel
  const [nanoStatus, bgResponse] = await Promise.all([
    checkNanoDirectly(),
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, resolve);
    }),
  ]);

  // Use direct Nano check for local_ai status (authoritative — we're in
  // a document context), but keep the background response for everything else.
  const response = bgResponse || {};
  const status = nanoStatus || "no";
  const info = STATUS_MAP[status] || STATUS_MAP["no"];

  const isNanoAvailable = status === "available" || status === "readily"
                       || status === "downloadable" || status === "after-download";

  if (!isNanoAvailable) {
    // Check if any other providers are available
    const providers = response.providers || [];
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
  const mode = response.detectionMode || "auto";
  const modeInfo = MODE_LABELS[mode] || MODE_LABELS.auto;
  const badge = document.createElement("span");
  badge.className = `mode-badge ${modeInfo.cls}`;
  badge.textContent = modeInfo.text;
  badgeContainer.appendChild(badge);

  // Show provider list — override local_ai status with our direct check
  const providers = (response.providers || []).map(p => {
    if (p.id === "local_ai") {
      return { ...p, available: isNanoAvailable, status: nanoStatus };
    }
    return p;
  });

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
})();

// Fetch stats.
chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
  if (response?.stats) {
    const s = response.stats;
    statRedactions.textContent = s.totalRedactions || 0;
    statMatches.textContent = s.totalMatches || 0;
    statDocs.textContent = s.documentsProcessed || 0;

    // Show guard stats if available
    const guardStats = [];
    if (s.submitsIntercepted) guardStats.push(`${s.submitsIntercepted} submits blocked`);
    if (s.uploadsIntercepted) guardStats.push(`${s.uploadsIntercepted} uploads checked`);
    if (s.autoRedactions) guardStats.push(`${s.autoRedactions} auto-redactions`);
    const guardEl = document.getElementById("guard-stats");
    if (guardEl && guardStats.length > 0) {
      guardEl.textContent = guardStats.join(" · ");
    }
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
