// lib/settings.js — Manages extension settings via chrome.storage.local.
// Provides defaults, load/save, and migration logic.

const SETTINGS_KEY = "llss_settings";
const STATS_KEY = "llss_stats";

const DEFAULT_SETTINGS = {
  // Detection mode: "auto" | "ai_only" | "regex_only" | "cloud_only"
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
  // Show document upload button alongside text redact button.
  enableDocumentUpload: true,
  // Idle timeout before destroying AI session (minutes).
  sessionTimeoutMinutes: 5,

  // ── Site Filtering ─────────────────────────────────────────────────────────
  // Controls which sites the extension activates on.
  siteFilter: {
    mode: "all",      // "all" | "whitelist" | "blacklist"
    whitelist: [],     // Patterns: "example.com", "*.gov.au", "https://portal.agency.gov.au/*"
    blacklist: [],     // Same pattern format
  },

  // ── AI Chat Guard ─────────────────────────────────────────────────────────
  // Protects against PII being submitted to AI chat services.
  aiChatGuard: {
    enabled: true,
    // Auto-redact text before it can be submitted to AI services.
    autoRedactOnAiSites: true,
    // Block submit until redaction completes on AI chat sites.
    blockSubmitUntilRedacted: true,
    // Intercept file uploads on AI chat sites.
    interceptUploads: true,
    // Additional domains to treat as AI chat services.
    customAiDomains: [],
    // Show a warning banner on detected AI chat sites.
    showAiBanner: true,
  },

  // ── Auto-Redact Mode ──────────────────────────────────────────────────────
  // Automatically redact PII as users type or paste, without requiring button click.
  autoRedact: {
    enabled: false,       // Off by default (can be noisy); auto-enabled on AI chat sites if aiChatGuard.autoRedactOnAiSites
    debounceMs: 2500,     // Wait for typing to pause before redacting
    onPaste: true,        // Immediately redact pasted content
    onlyOnAiSites: true,  // Only auto-redact on detected AI chat sites (safer default)
  },

  // ── Submit Interception ───────────────────────────────────────────────────
  // Intercept form submissions and Enter-key sends to ensure redaction.
  submitGuard: {
    enabled: true,
    // Intercept Enter key in textareas (common in chat UIs)
    interceptEnter: true,
    // Intercept form submit events
    interceptFormSubmit: true,
    // Intercept click on send/submit buttons
    interceptSendButtons: true,
    // Only active on AI chat sites by default
    onlyOnAiSites: true,
  },

  // ── Upload Interception ───────────────────────────────────────────────────
  // Intercept file input changes to redact documents before upload.
  uploadGuard: {
    enabled: true,
    // Only active on AI chat sites by default
    onlyOnAiSites: true,
    // Show confirmation dialog before allowing upload
    confirmBeforeUpload: true,
  },

  // ── Provider Configuration ────────────────────────────────────────────────
  // Each provider can be enabled/disabled and configured independently.
  // The pipeline routes local → hosted → cloud by default.

  providers: {
    local_ai: {
      enabled: true, // Default: use Gemini Nano when available
    },
    regex: {
      enabled: true, // Always-available fallback
    },
    // Azure AI Language PII Detection
    azure_pii: {
      enabled: false,
      endpoint: "",
      apiKey: "",
      apiVersion: "2023-04-01",
      language: "en",
      domain: "none",
      categoriesFilter: [],
      useManagedIdentity: false,
      tenantId: "",
      clientId: "",
    },
    // Microsoft Purview DLP
    purview: {
      enabled: false,
      tenantId: "",
      clientId: "",
      clientSecret: "",
      accessToken: "",
      graphEndpoint: "https://graph.microsoft.com/v1.0",
      useDelegatedAuth: false,
      dlpPolicyId: "",
      sensitiveInfoTypes: [],
    },
    // Organisation-hosted models (can have multiple instances)
    hosted: [],
    // Example hosted entry:
    // {
    //   enabled: true,
    //   providerId: "agency_llm",
    //   displayName: "Agency LLM (On-Prem)",
    //   endpoint: "https://internal-llm.agency.gov.au/v1",
    //   apiKey: "",
    //   apiMode: "openai",
    //   model: "llama-3-70b",
    //   maxTokens: 4096,
    //   temperature: 0.0,
    //   timeout: 30000,
    //   customHeaders: {},
    //   capabilities: ["text"],
    //   priority: 30,
    // }
  },

  // Debug logging — outputs detailed diagnostics to the browser console.
  debugMode: false,

  // Settings schema version for future migrations.
  schemaVersion: 3,
};

const DEFAULT_STATS = {
  totalRedactions: 0,
  totalMatches: 0,
  matchesByType: {},
  lastRedactionAt: null,
  engineUsage: { ai: 0, regex: 0, vector: 0, hosted: 0, azure: 0, purview: 0 },
  documentsProcessed: 0,
  documentsByType: {},
  tierUsage: { local: 0, hosted: 0, cloud: 0 },
  submitsIntercepted: 0,
  uploadsIntercepted: 0,
  autoRedactions: 0,
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
      const merged = { ...DEFAULT_SETTINGS, ...saved };
      // Deep-merge providers so individual provider configs aren't lost
      if (saved.providers) {
        merged.providers = { ...DEFAULT_SETTINGS.providers };
        for (const key of Object.keys(saved.providers)) {
          if (key === 'hosted') {
            merged.providers.hosted = saved.providers.hosted || [];
          } else if (typeof saved.providers[key] === 'object') {
            merged.providers[key] = {
              ...(DEFAULT_SETTINGS.providers[key] || {}),
              ...saved.providers[key],
            };
          }
        }
      }
      resolve(migrateSettings(merged));
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
 * @param {string} engine - Provider ID or engine label
 * @param {Array} matches - Array of match objects.
 * @param {Object} [extra] - Optional extra data (tier, documentType, etc.)
 * @returns {Promise<void>}
 */
async function recordRedaction(engine, matches, extra = {}) {
  const stats = await loadStats();
  stats.totalRedactions++;
  stats.totalMatches += matches.length;
  stats.lastRedactionAt = new Date().toISOString();
  stats.engineUsage[engine] = (stats.engineUsage[engine] || 0) + 1;

  if (extra.tier) {
    stats.tierUsage = stats.tierUsage || { local: 0, hosted: 0, cloud: 0 };
    stats.tierUsage[extra.tier] = (stats.tierUsage[extra.tier] || 0) + 1;
  }

  if (extra.documentType) {
    stats.documentsProcessed = (stats.documentsProcessed || 0) + 1;
    stats.documentsByType = stats.documentsByType || {};
    stats.documentsByType[extra.documentType] = (stats.documentsByType[extra.documentType] || 0) + 1;
  }

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
 * Migrate settings from v1 to v2 (add provider configuration).
 * @param {object} settings
 * @returns {object} Migrated settings
 */
function migrateSettings(settings) {
  if (!settings.schemaVersion || settings.schemaVersion < 2) {
    if (!settings.providers) {
      settings.providers = { ...DEFAULT_SETTINGS.providers };
    }
    if (settings.enableDocumentUpload === undefined) {
      settings.enableDocumentUpload = true;
    }
    settings.schemaVersion = 2;
  }
  if (settings.schemaVersion < 3) {
    // v3: site filter, AI chat guard, auto-redact, submit/upload guard
    if (!settings.siteFilter) settings.siteFilter = { ...DEFAULT_SETTINGS.siteFilter };
    if (!settings.aiChatGuard) settings.aiChatGuard = { ...DEFAULT_SETTINGS.aiChatGuard };
    if (!settings.autoRedact) settings.autoRedact = { ...DEFAULT_SETTINGS.autoRedact };
    if (!settings.submitGuard) settings.submitGuard = { ...DEFAULT_SETTINGS.submitGuard };
    if (!settings.uploadGuard) settings.uploadGuard = { ...DEFAULT_SETTINGS.uploadGuard };
    settings.schemaVersion = 3;
  }
  return settings;
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
  globalThis.LLSS_migrateSettings = migrateSettings;
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
    migrateSettings,
  };
}
