// popup.js — Queries the background worker for AI model status, current
// detection mode, and redaction statistics.

const dot = document.getElementById("status-dot");
const label = document.getElementById("status-label");
const detail = document.getElementById("status-detail");
const badgeContainer = document.getElementById("mode-badge-container");
const statRedactions = document.getElementById("stat-redactions");
const statMatches = document.getElementById("stat-matches");

const STATUS_MAP = {
  readily: {
    dotClass: "ready",
    label: "AI Model Ready",
    detail: "The local Gemini Nano model is loaded and ready to redact PII.",
  },
  downloadable: {
    dotClass: "downloading",
    label: "Downloading Model...",
    detail: "The model is being downloaded. This is a one-time setup.",
  },
  no: {
    dotClass: "unavailable",
    label: "AI Model Unavailable",
    detail: "On-device AI is not available. Using regex + heuristic fallback.",
  },
};

const MODE_LABELS = {
  auto: { text: "Auto (AI preferred)", cls: "auto" },
  ai_only: { text: "AI Only", cls: "ai" },
  regex_only: { text: "Regex Only", cls: "regex" },
};

// Fetch status from background.
chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
  const status = response?.status || "no";
  const info = STATUS_MAP[status] || STATUS_MAP["no"];

  // If AI is unavailable but we have regex fallback, show that.
  if (status === "no") {
    dot.className = "status-dot fallback";
    label.textContent = "Regex Fallback Active";
    detail.textContent = info.detail;
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
});

// Fetch stats.
chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
  if (response?.stats) {
    statRedactions.textContent = response.stats.totalRedactions || 0;
    statMatches.textContent = response.stats.totalMatches || 0;
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
  });
});
