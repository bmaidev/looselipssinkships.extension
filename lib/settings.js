// lib/settings.js — Manages extension settings via chrome.storage.local.
// Provides defaults, load/save, and migration logic.

const SETTINGS_KEY = "llss_settings";
const STATS_KEY = "llss_stats";

const DEFAULT_SETTINGS = {
  // Detection mode: "auto" | "ai_only" | "regex_only" | "cloud_only" | "hosted_only"
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

  // ── Voice Capture Detection ───────────────────────────────────────────────
  // Detects (and optionally warns about) sites that capture microphone audio
  // for server-side dictation — spoken PII that would leave the browser as an
  // audio blob before any text guard sees it. Site-agnostic (hooks the browser
  // mic APIs, not a domain list). See lib/voice-detector.js.
  voiceDetection: {
    // Observe-only detection of mic-capture-to-upload. Non-disruptive.
    enabled: true,
    // Show a warning when a site uploads dictation audio off-device.
    warnOnLeak: false,
    // Language pack for on-device transcription (BCP-47).
    language: "en-US",
  },

  // ── Inline Voice Dictation ────────────────────────────────────────────────
  // Adds a mic button to AI-chat composers that transcribes speech on-device
  // (Gemini Nano) and redacts it before inserting into the composer. Audio
  // never leaves the device.
  voiceDictation: {
    enabled: true,
    // Hide the site's own dictation/microphone button on AI chat sites so
    // users can't accidentally use the leaky (audio-uploading) path. The safe
    // on-device mic button remains.
    suppressNativeMic: true,
  },

  // ── Reversible Tokenization ───────────────────────────────────────────────
  // Replace PII with unique, stable tokens ([[EMAIL_1]] …) instead of generic
  // masks, keeping a memory-only vault so the model can reason over the
  // placeholders. Off by default: irreversible redaction is the safer default.
  // (Outbound only for now — inbound restoration is a later phase.)
  reversibleTokenization: {
    enabled: false,
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
      connectionMode: "direct", // 'direct' (API key) or 'enterprise' (Azure AD OAuth2)
      tenantId: "",
      clientId: "",
      // Native document redaction (server-side PDF/DOCX processing via Azure)
      nativeDocEnabled: false,
      sourceContainerUrl: "", // Direct: URL with SAS (read+list). Enterprise: plain URL (managed identity)
      targetContainerUrl: "", // Direct: URL with SAS (write+list). Enterprise: plain URL (managed identity)
      redactionPolicy: "entityMask", // 'characterMask' | 'entityMask' | 'noMask'
    },
    // Microsoft Purview DLP
    purview: {
      enabled: false,
      tenantId: "",
      clientId: "",
      clientSecret: "",
      accessToken: "",
      graphEndpoint: "https://graph.microsoft.com/beta",
      useDelegatedAuth: false,
      dlpPolicyId: "",
      sensitiveInfoTypes: [],
      // Classification gate — blocks uploads of classified documents
      gateEnabled: false,
      blockedLabels: [],       // Label names to block (e.g., ["PROTECTED", "SECRET", "TOP SECRET"])
      warnLabels: [],          // Label names to warn but allow (e.g., ["OFFICIAL:Sensitive"])
      blockedSensitivity: 0,   // Block labels with sensitivity >= this (0 = disabled)
      blockEncrypted: true,    // Block files with encryption markers
      checkViaApi: false,      // Also check via Graph API (requires auth)
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

  // Remote configuration URL (for small-business deployment without MDM).
  configUrl: "",

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

// ── Deep merge utility ──────────────────────────────────────────────────────

/**
 * Deep merge source into target. Arrays are replaced, not concatenated.
 * @param {object} target
 * @param {object} source
 * @returns {object} Merged result (new object, inputs not mutated)
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Managed storage (enterprise) ────────────────────────────────────────────

const REMOTE_CONFIG_KEY = "llss_remote_config";

/**
 * Load managed settings from chrome.storage.managed (set by enterprise policy).
 * Returns null if not in a managed environment.
 * @returns {Promise<object|null>}
 */
async function loadManagedSettings() {
  if (typeof chrome === "undefined" || !chrome.storage?.managed) return null;
  return new Promise((resolve) => {
    chrome.storage.managed.get(null, (result) => {
      if (chrome.runtime.lastError) {
        // Not in a managed environment — expected for non-enterprise installs
        resolve(null);
      } else {
        resolve(result && Object.keys(result).length > 0 ? result : null);
      }
    });
  });
}

/**
 * Load remote configuration from chrome.storage.local (fetched from configUrl).
 * @returns {Promise<object|null>}
 */
async function loadRemoteConfig() {
  if (typeof chrome === "undefined" || !chrome.storage) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(REMOTE_CONFIG_KEY, (result) => {
      resolve(result[REMOTE_CONFIG_KEY] || null);
    });
  });
}

/**
 * Fetch remote configuration from a URL and cache it locally.
 * @param {string} url
 * @returns {Promise<object|null>}
 */
async function fetchRemoteConfig(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.set({ [REMOTE_CONFIG_KEY]: config });
    }
    return config;
  } catch (err) {
    const dbg = typeof globalThis !== "undefined" && globalThis.LLSS_debug;
    if (dbg) dbg.warn("remote-config", "Failed to fetch:", err.message);
    return null;
  }
}

/**
 * Merge settings from all sources: managed (admin) > remote > local > defaults.
 * Attaches _meta with lock information and managed status.
 *
 * @param {object} defaults
 * @param {object} local - User's local settings
 * @param {object|null} managed - Enterprise managed storage
 * @param {object|null} remote - Remote config (small business)
 * @returns {object} Merged settings with _meta
 */
function mergeWithManaged(defaults, local, managed, remote) {
  // Layer 1: defaults
  let merged = deepMerge({}, defaults);
  // Layer 2: local user settings
  merged = deepMerge(merged, local);
  merged = migrateSettings(merged);

  // Build meta
  const meta = { locked: {}, policyVersion: null, isManaged: false, isRemoteConfig: false };

  // Layer 3: remote config (lower priority than managed)
  if (remote && Object.keys(remote).length > 0) {
    meta.isRemoteConfig = true;
    const { _locked: remoteLocked, _policyVersion: remoteVer, ...remoteSettings } = remote;
    if (remoteLocked) Object.assign(meta.locked, remoteLocked);
    if (remoteVer) meta.policyVersion = remoteVer;
    merged = deepMerge(merged, remoteSettings);
  }

  // Layer 4: managed storage (highest priority — overwrites everything)
  if (managed && Object.keys(managed).length > 0) {
    meta.isManaged = true;
    const { _locked: managedLocked, _policyVersion: managedVer, ...adminSettings } = managed;
    if (managedLocked) Object.assign(meta.locked, managedLocked);
    if (managedVer) meta.policyVersion = managedVer;
    merged = deepMerge(merged, adminSettings);
  }

  merged._meta = meta;
  return merged;
}

/**
 * Check if a setting is locked by enterprise policy.
 * Supports exact path and parent-path locking (e.g., "aiChatGuard" locks "aiChatGuard.enabled").
 *
 * @param {object} meta - The _meta object from merged settings
 * @param {string} dotPath - Dot-separated setting path (e.g., "aiChatGuard.enabled")
 * @returns {boolean}
 */
function isSettingLocked(meta, dotPath) {
  if (!meta?.locked) return false;
  // Exact match
  if (meta.locked[dotPath]) return true;
  // Parent path locks children
  const parts = dotPath.split(".");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join(".");
    if (meta.locked[parent]) return true;
  }
  return false;
}

/**
 * Delete a value at a dot-path in an object.
 * @param {object} obj
 * @param {string} dotPath
 */
function deletePath(obj, dotPath) {
  const parts = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current || typeof current !== "object") return;
    current = current[parts[i]];
  }
  if (current && typeof current === "object") {
    delete current[parts[parts.length - 1]];
  }
}

// ── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load settings from all sources, merged with managed policy.
 * @returns {Promise<object>} Settings with _meta attached
 */
async function loadSettings() {
  // In non-extension context (tests), return defaults.
  if (typeof chrome === "undefined" || !chrome.storage) {
    return { ...DEFAULT_SETTINGS, _meta: { locked: {}, isManaged: false, isRemoteConfig: false } };
  }

  const [localResult, managed, remote] = await Promise.all([
    new Promise((r) => chrome.storage.local.get(SETTINGS_KEY, r)),
    loadManagedSettings(),
    loadRemoteConfig(),
  ]);

  const local = localResult[SETTINGS_KEY] || {};
  return mergeWithManaged(DEFAULT_SETTINGS, local, managed, remote);
}

/**
 * Save settings to chrome.storage.local.
 * Strips locked keys so managed values always win on next load.
 * @param {object} settings
 * @returns {Promise<void>}
 */
async function saveSettings(settings) {
  if (typeof chrome === "undefined" || !chrome.storage) return;

  // Clone and strip metadata + locked keys before persisting
  const toSave = JSON.parse(JSON.stringify(settings));
  const locked = toSave._meta?.locked || {};
  delete toSave._meta;

  for (const [path, isLocked] of Object.entries(locked)) {
    if (isLocked) deletePath(toSave, path);
  }

  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: toSave }, resolve);
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

  if (settings.schemaVersion < 4) {
    // v4: Azure connection mode (migrate useManagedIdentity → connectionMode)
    if (settings.providers?.azure_pii) {
      if (!settings.providers.azure_pii.connectionMode) {
        settings.providers.azure_pii.connectionMode =
          settings.providers.azure_pii.useManagedIdentity ? "enterprise" : "direct";
      }
      delete settings.providers.azure_pii.useManagedIdentity;
    }
    settings.schemaVersion = 4;
  }

  if (settings.schemaVersion < 5) {
    // v5: Purview classification gate
    if (settings.providers?.purview) {
      if (settings.providers.purview.gateEnabled === undefined) {
        settings.providers.purview.gateEnabled = false;
      }
      if (!settings.providers.purview.blockedLabels) {
        settings.providers.purview.blockedLabels = [];
      }
      if (!settings.providers.purview.warnLabels) {
        settings.providers.purview.warnLabels = [];
      }
      if (settings.providers.purview.blockEncrypted === undefined) {
        settings.providers.purview.blockEncrypted = true;
      }
    }
    settings.schemaVersion = 5;
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
  globalThis.LLSS_isSettingLocked = isSettingLocked;
  globalThis.LLSS_fetchRemoteConfig = fetchRemoteConfig;
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
    deepMerge,
    mergeWithManaged,
    isSettingLocked,
    deletePath,
    fetchRemoteConfig,
  };
}
