// popup.js — Queries the background worker for the local AI model status
// and renders it in the popup UI.

const dot = document.getElementById("status-dot");
const label = document.getElementById("status-label");
const detail = document.getElementById("status-detail");

const STATUS_MAP = {
  readily: {
    dotClass: "ready",
    label: "Ready",
    detail: "The local AI model is loaded and ready to redact PII.",
  },
  downloadable: {
    dotClass: "downloading",
    label: "Downloading Model…",
    detail:
      "The model is being downloaded to your device. This is a one-time setup and may take a few minutes.",
  },
  no: {
    dotClass: "unavailable",
    label: "Hardware Not Supported",
    detail:
      "This device does not support on-device AI. Chrome 136+ with a compatible GPU is required.",
  },
};

// Ask the background service worker for the current availability status.
chrome.runtime.sendMessage({ type: "CHECK_STATUS" }, (response) => {
  const status = response?.status || "no";
  const info = STATUS_MAP[status] || STATUS_MAP["no"];

  dot.className = `status-dot ${info.dotClass}`;
  label.textContent = info.label;
  detail.textContent = info.detail;
});
