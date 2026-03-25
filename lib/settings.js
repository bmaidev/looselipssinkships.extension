// lib/settings.js — Manages extension settings via chrome.storage.local.
// Provides defaults, load/save, and migration logic.

const SETTINGS_KEY = "llss_settings";
const STATS_KEY = "llss_stats";

const DEFAULT_SETTINGS = {
  // Detection mode: "auto" (AI preferred, fallback to regex+vector), "ai_only", "regex_only"
  detectionMode: "auto",
  // Whether to run the vector name detector alongside regex fallback.
  enableVectorFallback: true,
  // Confidence threshold for vector name detection (0..1).
  vectorThreshold: 0.45,
  // Whether to also run regex after AI (belt-and-suspenders mode).
  regexAfterAi: false,
  // Custom PII types (merged with defaults).
  customPiiTypes: [],
  // Overrides for default PII types (e.g., { email: { enabled: false } }).
  piiTypeOverrides: {},
  // Show the redact button on all textareas.
  showRedactButton: true,
  // Also attach to contenteditable elements.
  enableContentEditable: true,
  // Idle timeout before destroying AI session (minutes).
  sessionTimeoutMinutes: 5,
  // Settings schema version for future migrations.
  schemaVersion: 1,
};

const DEFAULT_STATS = {
  totalRedactions: 0,
  totalMatches: 0,
  matchesByType: {},
  lastRedactionAt: null,
  engineUsage: { ai: 0, regex: 0, vector: 0 },
};

/**
 * Load settings from chrome.storage.local, merging with defaults.
 * @returns {Promise<object>}
 */
async function loadSettings() {
  // In non-extension context (tests), return defaults.
  if (typeof chrome === "undefined" || !chrome.storage) {
    return { ...DEFAULT_SETTINGS };
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      const saved = result[SETTINGS_KEY] || {};
      resolve({ ...DEFAULT_SETTINGS, ...saved });
    });
  });
}

/**
 * Save settings to chrome.storage.local.
 * @param {object} settings
 * @returns {Promise<void>}
 */
async function saveSettings(settings) {
  if (typeof chrome === "undefined" || !chrome.storage) return;

  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }, resolve);
  });
}

/**
 * Load redaction statistics.
 * @returns {Promise<object>}
 */
async function loadStats() {
  if (typeof chrome === "undefined" || !chrome.storage) {
    return { ...DEFAULT_STATS };
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(STATS_KEY, (result) => {
      resolve({ ...DEFAULT_STATS, ...(result[STATS_KEY] || {}) });
    });
  });
}

/**
 * Record a redaction event in statistics.
 * @param {string} engine - "ai", "regex", or "vector"
 * @param {Array} matches - Array of match objects.
 * @returns {Promise<void>}
 */
async function recordRedaction(engine, matches) {
  const stats = await loadStats();
  stats.totalRedactions++;
  stats.totalMatches += matches.length;
  stats.lastRedactionAt = new Date().toISOString();
  stats.engineUsage[engine] = (stats.engineUsage[engine] || 0) + 1;

  for (const match of matches) {
    const typeId = match.typeId || "unknown";
    stats.matchesByType[typeId] = (stats.matchesByType[typeId] || 0) + 1;
  }

  if (typeof chrome !== "undefined" && chrome.storage) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STATS_KEY]: stats }, resolve);
    });
  }
}

/**
 * Reset statistics.
 * @returns {Promise<void>}
 */
async function resetStats() {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STATS_KEY]: { ...DEFAULT_STATS } }, resolve);
  });
}

/**
 * Merge default PII types with user customisations (overrides + custom types).
 * @param {Array} defaultTypes - The built-in PII type definitions.
 * @param {object} settings - User settings containing overrides and custom types.
 * @returns {Array} Merged PII type list.
 */
function getMergedPiiTypes(defaultTypes, settings) {
  const overrides = settings.piiTypeOverrides || {};
  const customTypes = settings.customPiiTypes || [];

  const merged = defaultTypes.map((t) => {
    if (overrides[t.id]) {
      return { ...t, ...overrides[t.id], id: t.id }; // never override the id
    }
    return { ...t };
  });

  // Append custom types.
  for (const custom of customTypes) {
    // Don't duplicate if somehow an ID clashes.
    if (!merged.find((t) => t.id === custom.id)) {
      merged.push({ ...custom, category: custom.category || "custom" });
    }
  }

  return merged;
}

if (typeof globalThis !== "undefined") {
  globalThis.LLSS_loadSettings = loadSettings;
  globalThis.LLSS_saveSettings = saveSettings;
  globalThis.LLSS_loadStats = loadStats;
  globalThis.LLSS_recordRedaction = recordRedaction;
  globalThis.LLSS_resetStats = resetStats;
  globalThis.LLSS_getMergedPiiTypes = getMergedPiiTypes;
  globalThis.LLSS_DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  globalThis.LLSS_DEFAULT_STATS = DEFAULT_STATS;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_SETTINGS,
    DEFAULT_STATS,
    loadSettings,
    saveSettings,
    loadStats,
    recordRedaction,
    resetStats,
    getMergedPiiTypes,
  };
}
