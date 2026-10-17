// popup.js — Queries provider status, checks Nano availability directly
// (popup runs in a document context where LanguageModel may be available),
// and shows redaction statistics.

const dot = document.getElementById("status-dot");
const label = document.getElementById("status-label");
const detail = document.getElementById("status-detail");
const badgeContainer = document.getElementById("mode-badge-container");
const providersList = document.getElementById("providers-list");
const statRedactions = document.getElementById("stat-redactions");
const statMatches = document.getElementById("stat-matches");
const statDocs = document.getElementById("stat-docs");
const resetStatsButton = document.getElementById("btn-reset-stats");
const setupAiButton = document.getElementById("btn-setup-ai");
const NANO_STATUS_TIMEOUT_MS = 2500;

document.getElementById("popup-version").textContent = `v${chrome.runtime.getManifest().version}`;

function sendMessage(message, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    } catch {
      clearTimeout(timer);
      settled = true;
      resolve(null);
    }
  });
}

// Handles both old API values (readily, after-download) and new API values
// (available, downloadable, downloading, unavailable).
const STATUS_MAP = {
  // New Prompt API values
  available:    { dotClass: "ready",       label: "AI Model Ready",         detail: "The browser's local model is loaded and ready." },
  downloadable: { dotClass: "downloading", label: "Local AI Setup Available", detail: "Choose Set up Local AI to start the browser-managed download." },
  downloading:  { dotClass: "downloading", label: "Downloading Model...",   detail: "The model is being downloaded. This is a one-time setup." },
  unavailable:  { dotClass: "unavailable", label: "Local AI Unavailable",   detail: "Using regex fallback and configured providers." },
  // Legacy values (older Chrome builds)
  readily:          { dotClass: "ready",       label: "AI Model Ready",       detail: "The browser's local model is loaded and ready." },
  "after-download": { dotClass: "downloading", label: "Local AI Setup Available", detail: "Choose Set up Local AI to start the browser-managed download." },
  no:               { dotClass: "unavailable", label: "Local AI Unavailable", detail: "Using regex fallback and configured providers." },
};

const MODE_LABELS = {
  auto: { text: "Auto (Local First)", cls: "auto" },
  ai_only: { text: "AI Only", cls: "ai" },
  regex_only: { text: "Regex Only", cls: "regex" },
  hosted_only: { text: "Hosted Only", cls: "ai" },
  cloud_only: { text: "Cloud Only", cls: "ai" },
};

const TIER_LABELS = { local: "Local", hosted: "Hosted", cloud: "Cloud" };

// ── Check Nano availability directly (popup is a document context) ────────

async function checkNanoDirectly() {
  let timeoutId;
  try {
    const result = await Promise.race([
      LLSS_BrowserAI.checkTextAvailability(),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ status: "unavailable" }), NANO_STATUS_TIMEOUT_MS);
      }),
    ]);
    return result?.status || "unavailable";
  } catch {
    return "unavailable";
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Main status fetch ─────────────────────────────────────────────────────

(async () => {
  // Run Nano check and background status fetch in parallel
  const [nanoStatus, bgResponse] = await Promise.all([
    checkNanoDirectly(),
    sendMessage({ type: "CHECK_STATUS" }),
  ]);

  // Use direct Nano check for local_ai status (authoritative — we're in
  // a document context), but keep the background response for everything else.
  const response = bgResponse || {};
  const status = nanoStatus || "no";
  const info = STATUS_MAP[status] || STATUS_MAP["no"];

  const isNanoAvailable = status === "available" || status === "readily";
  const canSetUpNano = status === "downloadable" || status === "after-download" || status === "downloading";

  setupAiButton.classList.toggle("hidden", isNanoAvailable);
  setupAiButton.textContent = canSetUpNano ? "Set up Local AI" : "Local AI help";

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
    const fragment = document.createDocumentFragment();
    for (const provider of providers) {
      const row = document.createElement("div");
      row.className = "provider-row";
      row.setAttribute("role", "listitem");

      const providerDot = document.createElement("span");
      providerDot.className = `provider-dot ${provider.available ? "on" : "off"}`;
      providerDot.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "provider-name";
      name.textContent = provider.name || "Provider";

      const tier = document.createElement("span");
      tier.className = "provider-tier";
      tier.textContent = TIER_LABELS[provider.tier] || provider.tier || "";

      row.setAttribute("aria-label", `${name.textContent}: ${provider.available ? "available" : "unavailable"}`);
      row.append(providerDot, name, tier);
      fragment.appendChild(row);
    }
    providersList.replaceChildren(fragment);
  }
})();

// Fetch stats.
(async () => {
  const response = await sendMessage({ type: "GET_STATS" });
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
})();

// Open redact tool in a new tab.
document.getElementById("btn-redact").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("redact.html") });
});

// Open options page.
document.getElementById("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Open the guided setup directly. The user starts any browser-managed model
// download from the explicit setup button on that page.
setupAiButton.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("options.html?section=providers&focus=local-ai"),
  });
});

// Reset stats.
resetStatsButton.addEventListener("click", async () => {
  resetStatsButton.disabled = true;
  const response = await sendMessage({ type: "RESET_STATS" });
  if (response !== null) {
    statRedactions.textContent = "0";
    statMatches.textContent = "0";
    statDocs.textContent = "0";
    document.getElementById("guard-stats").textContent = "Activity cleared";
  } else {
    document.getElementById("guard-stats").textContent = "Could not clear activity";
  }
  resetStatsButton.disabled = false;
});
