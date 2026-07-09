// options.js — Settings page logic for managing PII types, detection mode,
// provider configuration, fallback options, and viewing statistics.

// PII_CATEGORIES and DEFAULT_PII_TYPES are loaded from lib/pii-types.js via <script> tag.

let currentSettings = null;
let editingCustomIndex = -1; // -1 = adding new, >= 0 = editing existing
let editingHostedIndex = -1;

// ── Load settings and populate UI ──────────────────────────────────────────

async function init() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
      currentSettings = response?.settings || {};
      // Ensure providers object exists
      if (!currentSettings.providers) currentSettings.providers = {};
      if (!currentSettings.providers.hosted) currentSettings.providers.hosted = [];
      populateUI();
      applyManagedState();
      loadStats();
      loadProviderStatus();
      resolve();
    });
  });
}

function populateUI() {
  const s = currentSettings;

  // Detection mode radio.
  const modeRadio = document.querySelector(
    `input[name="detectionMode"][value="${s.detectionMode || "auto"}"]`
  );
  if (modeRadio) modeRadio.checked = true;

  // Checkboxes.
  document.getElementById("enableVectorFallback").checked = s.enableVectorFallback !== false;
  document.getElementById("regexAfterAi").checked = !!s.regexAfterAi;
  document.getElementById("showRedactButton").checked = s.showRedactButton !== false;
  document.getElementById("enableContentEditable").checked = s.enableContentEditable !== false;
  document.getElementById("enableDocumentUpload").checked = s.enableDocumentUpload !== false;
  document.getElementById("debugMode").checked = !!s.debugMode;

  // Sliders.
  const thresholdSlider = document.getElementById("vectorThreshold");
  thresholdSlider.value = s.vectorThreshold || 0.45;
  document.getElementById("thresholdValue").textContent = thresholdSlider.value;

  const timeoutSlider = document.getElementById("sessionTimeout");
  timeoutSlider.value = s.sessionTimeoutMinutes || 5;
  document.getElementById("timeoutValue").textContent = `${timeoutSlider.value} min`;

  // Site filtering.
  const sf = s.siteFilter || {};
  const sfMode = document.querySelector(`input[name="siteFilterMode"][value="${sf.mode || "all"}"]`);
  if (sfMode) sfMode.checked = true;
  document.getElementById("site-whitelist").value = (sf.whitelist || []).join("\n");
  document.getElementById("site-blacklist").value = (sf.blacklist || []).join("\n");
  updateSiteFilterVisibility(sf.mode || "all");

  // AI Chat Guard.
  const ag = s.aiChatGuard || {};
  document.getElementById("aiGuardEnabled").checked = ag.enabled !== false;
  document.getElementById("aiGuardAutoRedact").checked = ag.autoRedactOnAiSites !== false;
  document.getElementById("aiGuardBlockSubmit").checked = ag.blockSubmitUntilRedacted !== false;
  document.getElementById("aiGuardInterceptUploads").checked = ag.interceptUploads !== false;
  document.getElementById("aiGuardBanner").checked = ag.showAiBanner !== false;
  document.getElementById("aiGuardCustomDomains").value = (ag.customAiDomains || []).join("\n");

  // Auto-redact.
  const ar = s.autoRedact || {};
  document.getElementById("autoRedactEnabled").checked = !!ar.enabled;
  document.getElementById("autoRedactOnlyAi").checked = ar.onlyOnAiSites !== false;
  document.getElementById("autoRedactOnPaste").checked = ar.onPaste !== false;
  const debounceSlider = document.getElementById("autoRedactDebounce");
  debounceSlider.value = ar.debounceMs || 1500;
  document.getElementById("debounceValue").textContent = `${debounceSlider.value} ms`;

  // Submit guard.
  const sg = s.submitGuard || {};
  document.getElementById("submitGuardEnabled").checked = sg.enabled !== false;
  document.getElementById("submitGuardEnter").checked = sg.interceptEnter !== false;
  document.getElementById("submitGuardForm").checked = sg.interceptFormSubmit !== false;
  document.getElementById("submitGuardSendBtn").checked = sg.interceptSendButtons !== false;
  document.getElementById("submitGuardOnlyAi").checked = sg.onlyOnAiSites !== false;

  // Upload guard.
  const ug = s.uploadGuard || {};
  document.getElementById("uploadGuardEnabled").checked = ug.enabled !== false;
  document.getElementById("uploadGuardOnlyAi").checked = ug.onlyOnAiSites !== false;
  document.getElementById("uploadGuardConfirm").checked = ug.confirmBeforeUpload !== false;

  // Voice capture detection.
  const vd = s.voiceDetection || {};
  document.getElementById("voiceDetectionEnabled").checked = vd.enabled !== false;
  document.getElementById("voiceDetectionWarn").checked = vd.warnOnLeak === true;

  // Inline voice dictation.
  const vdict = s.voiceDictation || {};
  document.getElementById("voiceDictationEnabled").checked = vdict.enabled !== false;
  document.getElementById("voiceDictationSuppress").checked = vdict.suppressNativeMic !== false;

  // Reversible tokenization.
  document.getElementById("reversibleTokenizationEnabled").checked =
    (s.reversibleTokenization || {}).enabled === true;

  // Provider configuration.
  const providers = s.providers || {};
  document.getElementById("provider-local-ai").checked = providers.local_ai?.enabled !== false;

  // Azure PII
  document.getElementById("provider-azure-pii").checked = providers.azure_pii?.enabled || false;
  document.getElementById("azure-endpoint").value = providers.azure_pii?.endpoint || "";
  document.getElementById("azure-apikey").value = providers.azure_pii?.apiKey || "";
  document.getElementById("azure-language").value = providers.azure_pii?.language || "en";
  const azureDomain = document.getElementById("azure-domain");
  if (azureDomain) azureDomain.value = providers.azure_pii?.domain || "none";
  // Azure connection mode
  const azureMode = providers.azure_pii?.connectionMode || "direct";
  const azureModeRadio = document.querySelector(`input[name="azureConnectionMode"][value="${azureMode}"]`);
  if (azureModeRadio) azureModeRadio.checked = true;
  updateAzureConnectionMode(azureMode);
  document.getElementById("azure-tenant-id").value = providers.azure_pii?.tenantId || "";
  document.getElementById("azure-client-id").value = providers.azure_pii?.clientId || "";
  refreshAzureAuthStatus();
  // Native document redaction
  const nativeDocEnabled = providers.azure_pii?.nativeDocEnabled || false;
  document.getElementById("azure-native-doc").checked = nativeDocEnabled;
  document.getElementById("azure-native-doc-fields").classList.toggle("hidden", !nativeDocEnabled);
  document.getElementById("azure-source-url").value = providers.azure_pii?.sourceContainerUrl || "";
  document.getElementById("azure-target-url").value = providers.azure_pii?.targetContainerUrl || "";
  document.getElementById("azure-redaction-policy").value = providers.azure_pii?.redactionPolicy || "entityMask";
  updateNativeDocHelp(azureMode);

  // Purview
  document.getElementById("provider-purview").checked = providers.purview?.enabled || false;
  document.getElementById("purview-tenant").value = providers.purview?.tenantId || "";
  document.getElementById("purview-clientid").value = providers.purview?.clientId || "";
  document.getElementById("purview-secret").value = providers.purview?.clientSecret || "";
  // Purview classification gate
  const gateEnabled = providers.purview?.gateEnabled || false;
  document.getElementById("purview-gate-enabled").checked = gateEnabled;
  document.getElementById("purview-gate-fields").classList.toggle("hidden", !gateEnabled);
  document.getElementById("purview-blocked-labels").value = (providers.purview?.blockedLabels || []).join("\n");
  document.getElementById("purview-warn-labels").value = (providers.purview?.warnLabels || []).join("\n");
  document.getElementById("purview-block-encrypted").checked = providers.purview?.blockEncrypted !== false;
  document.getElementById("purview-check-api").checked = providers.purview?.checkViaApi || false;

  // Hosted providers list.
  renderHostedProviders();

  // PII types list.
  renderPiiTypes();

  // Remote config URL
  document.getElementById("configUrl").value = s.configUrl || "";
}

// ── Managed / Enterprise State ────────────────────────────────────────────────

/**
 * Map of dot-path setting keys to DOM element info for lock visuals.
 */
const SETTING_MAP = {
  "detectionMode":                   { type: "radio-group", name: "detectionMode" },
  "enableVectorFallback":            { type: "checkbox", id: "enableVectorFallback" },
  "regexAfterAi":                    { type: "checkbox", id: "regexAfterAi" },
  "showRedactButton":                { type: "checkbox", id: "showRedactButton" },
  "enableContentEditable":           { type: "checkbox", id: "enableContentEditable" },
  "enableDocumentUpload":            { type: "checkbox", id: "enableDocumentUpload" },
  "debugMode":                       { type: "checkbox", id: "debugMode" },
  "aiChatGuard.enabled":             { type: "checkbox", id: "aiGuardEnabled" },
  "aiChatGuard.autoRedactOnAiSites": { type: "checkbox", id: "aiGuardAutoRedact" },
  "aiChatGuard.blockSubmitUntilRedacted": { type: "checkbox", id: "aiGuardBlockSubmit" },
  "aiChatGuard.interceptUploads":    { type: "checkbox", id: "aiGuardInterceptUploads" },
  "aiChatGuard.showAiBanner":        { type: "checkbox", id: "aiGuardBanner" },
  "autoRedact.enabled":              { type: "checkbox", id: "autoRedactEnabled" },
  "autoRedact.onlyOnAiSites":        { type: "checkbox", id: "autoRedactOnlyAi" },
  "autoRedact.onPaste":              { type: "checkbox", id: "autoRedactOnPaste" },
  "submitGuard.enabled":             { type: "checkbox", id: "submitGuardEnabled" },
  "submitGuard.interceptEnter":      { type: "checkbox", id: "submitGuardEnter" },
  "submitGuard.interceptFormSubmit":  { type: "checkbox", id: "submitGuardForm" },
  "submitGuard.interceptSendButtons": { type: "checkbox", id: "submitGuardSendBtn" },
  "submitGuard.onlyOnAiSites":       { type: "checkbox", id: "submitGuardOnlyAi" },
  "uploadGuard.enabled":             { type: "checkbox", id: "uploadGuardEnabled" },
  "uploadGuard.onlyOnAiSites":       { type: "checkbox", id: "uploadGuardOnlyAi" },
  "uploadGuard.confirmBeforeUpload":  { type: "checkbox", id: "uploadGuardConfirm" },
  "voiceDetection.enabled":          { type: "checkbox", id: "voiceDetectionEnabled" },
  "voiceDetection.warnOnLeak":       { type: "checkbox", id: "voiceDetectionWarn" },
  "voiceDictation.enabled":          { type: "checkbox", id: "voiceDictationEnabled" },
  "voiceDictation.suppressNativeMic":{ type: "checkbox", id: "voiceDictationSuppress" },
  "reversibleTokenization.enabled":  { type: "checkbox", id: "reversibleTokenizationEnabled" },
  "providers.local_ai":              { type: "checkbox", id: "provider-local-ai" },
  "providers.azure_pii":             { type: "section", id: "azure-config" },
  "providers.azure_pii.enabled":     { type: "checkbox", id: "provider-azure-pii" },
  "providers.purview":               { type: "section", id: "purview-config" },
  "providers.purview.enabled":       { type: "checkbox", id: "provider-purview" },
};

function isSettingLocked(meta, dotPath) {
  if (!meta?.locked) return false;
  if (meta.locked[dotPath]) return true;
  const parts = dotPath.split(".");
  for (let i = 1; i < parts.length; i++) {
    if (meta.locked[parts.slice(0, i).join(".")]) return true;
  }
  return false;
}

function applyManagedState() {
  const meta = currentSettings._meta;
  if (!meta) return;

  // Show managed banner
  if (meta.isManaged || meta.isRemoteConfig) {
    document.getElementById("managed-banner").classList.remove("hidden");
    const verEl = document.getElementById("managed-policy-version");
    if (meta.policyVersion) {
      verEl.textContent = `Policy version: ${meta.policyVersion}`;
    }
    if (meta.isRemoteConfig && !meta.isManaged) {
      document.querySelector(".managed-banner-icon").textContent = "\u{1F517}"; // link icon
      document.querySelector(".managed-banner strong").textContent = "Remote configuration active";
    }
  }

  // Lock individual settings
  if (!meta.locked || Object.keys(meta.locked).length === 0) return;

  for (const [path, domInfo] of Object.entries(SETTING_MAP)) {
    if (isSettingLocked(meta, path)) {
      lockElement(domInfo);
    }
  }
}

function lockElement(domInfo) {
  if (domInfo.type === "radio-group") {
    document.querySelectorAll(`input[name="${domInfo.name}"]`).forEach(r => {
      r.disabled = true;
    });
    const group = document.querySelector(".radio-group");
    if (group) {
      group.classList.add("locked");
      appendAdminBadge(group);
    }
  } else if (domInfo.type === "section") {
    const section = document.getElementById(domInfo.id);
    if (section) {
      section.classList.add("locked");
      appendAdminBadge(section.parentElement);
    }
  } else {
    const el = document.getElementById(domInfo.id);
    if (el) {
      el.disabled = true;
      const container = el.closest("label") || el.closest(".form-group");
      if (container) {
        container.classList.add("locked");
        appendAdminBadge(container);
      }
    }
  }
}

function appendAdminBadge(container) {
  if (!container || container.querySelector(".admin-badge")) return;
  const badge = document.createElement("span");
  badge.className = "admin-badge";
  badge.title = "This setting is managed by your organisation";
  badge.textContent = "Admin";
  container.appendChild(badge);
}

// ── Provider Status ──────────────────────────────────────────────────────────

/**
 * Check Nano availability directly from the options page (document context).
 * The options page is an extension page where LanguageModel IS available.
 */
async function checkNanoDirectly() {
  if (typeof LanguageModel === "undefined") return { available: false, status: "no", detail: "LanguageModel API not present" };
  try {
    const status = await LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
    const available = status === "available" || status === "downloadable"
                   || status === "readily"   || status === "after-download";
    const detailMap = {
      available: "Model ready", readily: "Model ready",
      downloadable: "Model available after download", "after-download": "Model available after download",
      downloading: "Model is downloading",
    };
    return { available, status, detail: detailMap[status] || "Model not available" };
  } catch (err) {
    return { available: false, status: "no", detail: err.message };
  }
}

async function loadProviderStatus() {
  // Run direct Nano check and background provider list in parallel
  const [nanoResult, bgResponse] = await Promise.all([
    checkNanoDirectly(),
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_PROVIDERS" }, resolve);
    }),
  ]);

  // Override local_ai status with our direct check (authoritative)
  const providers = (bgResponse?.providers || []).map(p => {
    if (p.id === "local_ai") {
      return { ...p, available: nanoResult.available, status: nanoResult.status, detail: nanoResult.detail };
    }
    return p;
  });

  const container = document.getElementById("provider-status");
  if (providers.length === 0) {
    container.innerHTML = '<div class="help">No provider status available.</div>';
    return;
  }
  container.innerHTML = providers.map(p => {
    const dot = p.available ? "green" : (p.status === "disabled" ? "gray" : "red");
    const tierIcon = p.tier === "local" ? "🏠" : p.tier === "hosted" ? "🏢" : "☁️";
    return `<div class="provider-status-item">
      <span class="status-dot status-${dot}"></span>
      <span>${tierIcon} <strong>${escapeHtml(p.name)}</strong></span>
      <span class="provider-status-detail">${escapeHtml(p.detail || p.status)}</span>
    </div>`;
  }).join("");
}

// ── Hosted Providers ────────────────────────────────────────────────────────

function renderHostedProviders() {
  const container = document.getElementById("hosted-providers-list");
  const hostedList = currentSettings.providers?.hosted || [];
  container.innerHTML = "";

  if (hostedList.length === 0) {
    container.innerHTML = '<div class="help">No hosted providers configured. Add one to connect to your organisation\'s infrastructure.</div>';
    return;
  }

  for (let i = 0; i < hostedList.length; i++) {
    const h = hostedList[i];
    const item = document.createElement("div");
    item.className = "hosted-provider-item";
    item.innerHTML = `
      <label class="checkbox-label">
        <input type="checkbox" class="hosted-toggle" data-index="${i}" ${h.enabled ? "checked" : ""}>
        <span>
          <strong>${escapeHtml(h.displayName || h.providerId)}</strong>
          <span class="hosted-detail">${escapeHtml(h.endpoint || "")} · ${h.apiMode || "openai"}</span>
        </span>
      </label>
      <div class="pii-type-actions">
        <button class="hosted-edit" data-index="${i}">Edit</button>
        <button class="hosted-delete delete" data-index="${i}">Delete</button>
      </div>
    `;
    container.appendChild(item);
  }

  // Event delegation
  container.querySelectorAll(".hosted-toggle").forEach(el => {
    el.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.index);
      currentSettings.providers.hosted[idx].enabled = e.target.checked;
    });
  });
  container.querySelectorAll(".hosted-edit").forEach(el => {
    el.addEventListener("click", (e) => {
      openHostedModal(parseInt(e.target.dataset.index));
    });
  });
  container.querySelectorAll(".hosted-delete").forEach(el => {
    el.addEventListener("click", (e) => {
      currentSettings.providers.hosted.splice(parseInt(e.target.dataset.index), 1);
      renderHostedProviders();
    });
  });
}

function openHostedModal(index) {
  editingHostedIndex = index === undefined ? -1 : index;
  const overlay = document.getElementById("hosted-modal-overlay");
  const title = document.getElementById("hosted-modal-title");

  if (editingHostedIndex >= 0) {
    title.textContent = "Edit Hosted Provider";
    const h = currentSettings.providers.hosted[editingHostedIndex];
    document.getElementById("hosted-name").value = h.displayName || "";
    document.getElementById("hosted-endpoint").value = h.endpoint || "";
    document.getElementById("hosted-apikey").value = h.apiKey || "";
    document.getElementById("hosted-apimode").value = h.apiMode || "openai";
    document.getElementById("hosted-model").value = h.model || "";
    document.getElementById("hosted-timeout").value = h.timeout || 30000;
    document.getElementById("hosted-priority").value = h.priority || 30;
    const caps = h.capabilities || ["text"];
    document.getElementById("hosted-cap-text").checked = caps.includes("text");
    document.getElementById("hosted-cap-docx").checked = caps.includes("docx");
    document.getElementById("hosted-cap-xlsx").checked = caps.includes("xlsx");
    document.getElementById("hosted-cap-image").checked = caps.includes("image");
    document.getElementById("hosted-cap-pdf").checked = caps.includes("pdf");
  } else {
    title.textContent = "Add Hosted Provider";
    document.getElementById("hosted-name").value = "";
    document.getElementById("hosted-endpoint").value = "";
    document.getElementById("hosted-apikey").value = "";
    document.getElementById("hosted-apimode").value = "openai";
    document.getElementById("hosted-model").value = "";
    document.getElementById("hosted-timeout").value = "30000";
    document.getElementById("hosted-priority").value = "30";
    document.getElementById("hosted-cap-text").checked = true;
    document.getElementById("hosted-cap-docx").checked = false;
    document.getElementById("hosted-cap-xlsx").checked = false;
    document.getElementById("hosted-cap-image").checked = false;
    document.getElementById("hosted-cap-pdf").checked = false;
  }

  document.getElementById("hosted-modal-errors").textContent = "";
  overlay.classList.remove("hidden");
}

function closeHostedModal() {
  document.getElementById("hosted-modal-overlay").classList.add("hidden");
  editingHostedIndex = -1;
}

function saveHostedModal() {
  const name = document.getElementById("hosted-name").value.trim();
  const endpoint = document.getElementById("hosted-endpoint").value.trim();

  if (!name) {
    document.getElementById("hosted-modal-errors").textContent = "Display name is required.";
    return;
  }
  if (!endpoint) {
    document.getElementById("hosted-modal-errors").textContent = "Endpoint URL is required.";
    return;
  }

  const capabilities = [];
  if (document.getElementById("hosted-cap-text").checked) capabilities.push("text");
  if (document.getElementById("hosted-cap-docx").checked) capabilities.push("docx");
  if (document.getElementById("hosted-cap-xlsx").checked) capabilities.push("xlsx");
  if (document.getElementById("hosted-cap-image").checked) capabilities.push("image");
  if (document.getElementById("hosted-cap-pdf").checked) capabilities.push("pdf");

  const provider = {
    enabled: true,
    providerId: editingHostedIndex >= 0
      ? currentSettings.providers.hosted[editingHostedIndex].providerId
      : "hosted_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    displayName: name,
    endpoint,
    apiKey: document.getElementById("hosted-apikey").value,
    apiMode: document.getElementById("hosted-apimode").value,
    model: document.getElementById("hosted-model").value.trim(),
    timeout: parseInt(document.getElementById("hosted-timeout").value) || 30000,
    priority: parseInt(document.getElementById("hosted-priority").value) || 30,
    capabilities,
    customHeaders: {},
  };

  if (!currentSettings.providers.hosted) currentSettings.providers.hosted = [];

  if (editingHostedIndex >= 0) {
    currentSettings.providers.hosted[editingHostedIndex] = provider;
  } else {
    currentSettings.providers.hosted.push(provider);
  }

  closeHostedModal();
  renderHostedProviders();
}

// ── PII Types Rendering ────────────────────────────────────────────────────

function renderPiiTypes() {
  const container = document.getElementById("pii-type-list");
  container.innerHTML = "";

  const overrides = currentSettings.piiTypeOverrides || {};
  const customTypes = currentSettings.customPiiTypes || [];

  // Group defaults by category.
  const categories = { ...LLSS_PII_CATEGORIES };
  const grouped = {};

  for (const type of LLSS_PII_TYPES) {
    const cat = type.category || "custom";
    if (!grouped[cat]) grouped[cat] = [];
    const merged = { ...type, ...(overrides[type.id] || {}) };
    grouped[cat].push({ ...merged, isCustom: false });
  }

  // Add custom types.
  for (let i = 0; i < customTypes.length; i++) {
    const cat = customTypes[i].category || "custom";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ ...customTypes[i], isCustom: true, customIndex: i });
  }

  // Render by category order.
  const sortedCats = Object.entries(categories).sort((a, b) => a[1].order - b[1].order);
  for (const [catId, catInfo] of sortedCats) {
    if (!grouped[catId] || grouped[catId].length === 0) continue;

    const heading = document.createElement("div");
    heading.className = "category-heading";
    heading.textContent = catInfo.name;
    container.appendChild(heading);

    for (const type of grouped[catId]) {
      container.appendChild(createPiiTypeItem(type));
    }
  }
}

function createPiiTypeItem(type) {
  const item = document.createElement("div");
  item.className = "pii-type-item";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "toggle";
  toggle.checked = type.enabled !== false;
  toggle.addEventListener("change", () => {
    if (type.isCustom) {
      currentSettings.customPiiTypes[type.customIndex].enabled = toggle.checked;
    } else {
      if (!currentSettings.piiTypeOverrides) currentSettings.piiTypeOverrides = {};
      if (!currentSettings.piiTypeOverrides[type.id]) currentSettings.piiTypeOverrides[type.id] = {};
      currentSettings.piiTypeOverrides[type.id].enabled = toggle.checked;
    }
  });

  const info = document.createElement("div");
  info.className = "pii-type-info";
  info.innerHTML = `
    <div class="pii-type-name">${escapeHtml(type.name)}</div>
    <div class="pii-type-desc">${escapeHtml(type.description || "")}</div>
    <div class="pii-type-token">${escapeHtml(type.token)}</div>
    ${type.regex ? `<div class="pii-type-regex">${escapeHtml(type.regex)}</div>` : ""}
  `;

  const actions = document.createElement("div");
  actions.className = "pii-type-actions";

  if (type.isCustom) {
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openModal(type.customIndex));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "delete";
    deleteBtn.addEventListener("click", () => {
      currentSettings.customPiiTypes.splice(type.customIndex, 1);
      renderPiiTypes();
    });
    actions.appendChild(deleteBtn);
  }

  item.appendChild(toggle);
  item.appendChild(info);
  item.appendChild(actions);
  return item;
}

// ── Modal for custom PII types ─────────────────────────────────────────────

function openModal(customIndex) {
  editingCustomIndex = customIndex === undefined ? -1 : customIndex;
  const overlay = document.getElementById("modal-overlay");
  const title = document.getElementById("modal-title");

  if (editingCustomIndex >= 0) {
    title.textContent = "Edit Custom Rule";
    const type = currentSettings.customPiiTypes[editingCustomIndex];
    document.getElementById("modal-name").value = type.name || "";
    document.getElementById("modal-desc").value = type.description || "";
    document.getElementById("modal-token").value = type.token || "";
    document.getElementById("modal-regex").value = type.regex || "";
    document.getElementById("modal-flags").value = type.flags || "gi";
  } else {
    title.textContent = "Add Custom Rule";
    document.getElementById("modal-name").value = "";
    document.getElementById("modal-desc").value = "";
    document.getElementById("modal-token").value = "[REDACTED_]";
    document.getElementById("modal-regex").value = "";
    document.getElementById("modal-flags").value = "gi";
  }

  document.getElementById("modal-errors").textContent = "";
  overlay.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  editingCustomIndex = -1;
}

function saveModal() {
  const name = document.getElementById("modal-name").value.trim();
  const description = document.getElementById("modal-desc").value.trim();
  const token = document.getElementById("modal-token").value.trim();
  const regex = document.getElementById("modal-regex").value.trim();
  const flags = document.getElementById("modal-flags").value.trim();

  const type = {
    id: editingCustomIndex >= 0
      ? currentSettings.customPiiTypes[editingCustomIndex].id
      : LLSS_generatePiiTypeId(name),
    name,
    description,
    token,
    regex,
    flags,
    enabled: true,
    category: "custom",
  };

  const validation = LLSS_validatePiiType(type);
  if (!validation.valid) {
    document.getElementById("modal-errors").textContent = validation.errors.join(" ");
    return;
  }

  if (!currentSettings.customPiiTypes) currentSettings.customPiiTypes = [];

  if (editingCustomIndex >= 0) {
    currentSettings.customPiiTypes[editingCustomIndex] = type;
  } else {
    currentSettings.customPiiTypes.push(type);
  }

  closeModal();
  renderPiiTypes();
}

// ── Regex Tester ───────────────────────────────────────────────────────────

function testRegex() {
  const pattern = document.getElementById("test-pattern").value;
  const flags = document.getElementById("test-flags").value;
  const sample = document.getElementById("test-sample").value;
  const resultsDiv = document.getElementById("test-results");

  if (!pattern || !sample) {
    resultsDiv.innerHTML = '<span class="no-match">Enter a pattern and sample text.</span>';
    return;
  }

  chrome.runtime.sendMessage(
    { type: "TEST_REGEX", pattern, flags, sampleText: sample },
    (response) => {
      if (!response.valid) {
        resultsDiv.innerHTML = `<span class="error">Invalid regex: ${escapeHtml(response.error)}</span>`;
        return;
      }
      if (response.matches.length === 0) {
        resultsDiv.innerHTML = '<span class="no-match">No matches found.</span>';
        return;
      }
      resultsDiv.innerHTML = response.matches
        .map((m) => `<span class="match">${escapeHtml(m)}</span>`)
        .join(" ");
    }
  );
}

// ── Provider connection tests ────────────────────────────────────────────────

function testAzureConnection() {
  const result = document.getElementById("azure-test-result");
  result.textContent = "Testing...";
  result.className = "test-inline-result";

  chrome.runtime.sendMessage(
    { type: "CHECK_PROVIDER", providerId: "azure_pii" },
    (response) => {
      if (response?.available) {
        result.textContent = "Connected";
        result.className = "test-inline-result test-success";
      } else {
        result.textContent = response?.detail || "Failed";
        result.className = "test-inline-result test-fail";
      }
    }
  );
}

function testPurviewConnection() {
  const result = document.getElementById("purview-test-result");
  result.textContent = "Testing...";
  result.className = "test-inline-result";

  chrome.runtime.sendMessage(
    { type: "CHECK_PROVIDER", providerId: "purview" },
    (response) => {
      if (response?.available) {
        result.textContent = "Connected";
        result.className = "test-inline-result test-success";
      } else {
        result.textContent = response?.detail || "Failed";
        result.className = "test-inline-result test-fail";
      }
    }
  );
}

// ── Statistics ─────────────────────────────────────────────────────────────

function loadStats() {
  chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
    const stats = response?.stats || {};
    const container = document.getElementById("stats-display");

    const tierUsage = stats.tierUsage || {};
    const docsProcessed = stats.documentsProcessed || 0;

    container.innerHTML = `
      <div class="stat-card">
        <div class="value">${stats.totalRedactions || 0}</div>
        <div class="label">Total Redactions</div>
      </div>
      <div class="stat-card">
        <div class="value">${stats.totalMatches || 0}</div>
        <div class="label">PII Items Found</div>
      </div>
      <div class="stat-card">
        <div class="value">${docsProcessed}</div>
        <div class="label">Documents Processed</div>
      </div>
      <div class="stat-card">
        <div class="value">${stats.engineUsage?.ai || stats.engineUsage?.local_ai || 0} / ${stats.engineUsage?.regex || 0} / ${stats.engineUsage?.vector || 0}</div>
        <div class="label">AI / Regex / Vector</div>
      </div>
      <div class="stat-card">
        <div class="value">${tierUsage.local || 0} / ${tierUsage.hosted || 0} / ${tierUsage.cloud || 0}</div>
        <div class="label">Local / Hosted / Cloud</div>
      </div>
      <div class="stat-card">
        <div class="value">${stats.engineUsage?.azure_pii || 0} / ${stats.engineUsage?.purview || 0}</div>
        <div class="label">Azure / Purview</div>
      </div>
    `;
  });
}

// ── Save settings ──────────────────────────────────────────────────────────

function saveSettings() {
  // Collect values from the UI.
  const mode = document.querySelector('input[name="detectionMode"]:checked');
  currentSettings.detectionMode = mode ? mode.value : "auto";
  currentSettings.enableVectorFallback = document.getElementById("enableVectorFallback").checked;
  currentSettings.regexAfterAi = document.getElementById("regexAfterAi").checked;
  currentSettings.showRedactButton = document.getElementById("showRedactButton").checked;
  currentSettings.enableContentEditable = document.getElementById("enableContentEditable").checked;
  currentSettings.enableDocumentUpload = document.getElementById("enableDocumentUpload").checked;
  currentSettings.debugMode = document.getElementById("debugMode").checked;
  currentSettings.vectorThreshold = parseFloat(document.getElementById("vectorThreshold").value);
  currentSettings.sessionTimeoutMinutes = parseInt(document.getElementById("sessionTimeout").value, 10);

  // Provider config
  if (!currentSettings.providers) currentSettings.providers = {};
  currentSettings.providers.local_ai = {
    ...currentSettings.providers.local_ai,
    enabled: document.getElementById("provider-local-ai").checked,
  };

  currentSettings.providers.azure_pii = {
    ...currentSettings.providers.azure_pii,
    enabled: document.getElementById("provider-azure-pii").checked,
    connectionMode: document.querySelector('input[name="azureConnectionMode"]:checked')?.value || "direct",
    endpoint: document.getElementById("azure-endpoint").value.trim(),
    apiKey: document.getElementById("azure-apikey").value,
    tenantId: document.getElementById("azure-tenant-id").value.trim(),
    clientId: document.getElementById("azure-client-id").value.trim(),
    language: document.getElementById("azure-language").value.trim(),
    domain: document.getElementById("azure-domain").value,
    nativeDocEnabled: document.getElementById("azure-native-doc").checked,
    sourceContainerUrl: document.getElementById("azure-source-url").value.trim(),
    targetContainerUrl: document.getElementById("azure-target-url").value.trim(),
    redactionPolicy: document.getElementById("azure-redaction-policy").value,
  };

  currentSettings.providers.purview = {
    ...currentSettings.providers.purview,
    enabled: document.getElementById("provider-purview").checked,
    tenantId: document.getElementById("purview-tenant").value.trim(),
    clientId: document.getElementById("purview-clientid").value.trim(),
    clientSecret: document.getElementById("purview-secret").value,
    gateEnabled: document.getElementById("purview-gate-enabled").checked,
    blockedLabels: parseLines(document.getElementById("purview-blocked-labels").value),
    warnLabels: parseLines(document.getElementById("purview-warn-labels").value),
    blockEncrypted: document.getElementById("purview-block-encrypted").checked,
    checkViaApi: document.getElementById("purview-check-api").checked,
  };

  // Hosted providers are already updated via renderHostedProviders toggles

  // Site filtering
  const sfMode = document.querySelector('input[name="siteFilterMode"]:checked');
  currentSettings.siteFilter = {
    mode: sfMode ? sfMode.value : "all",
    whitelist: parseLines(document.getElementById("site-whitelist").value),
    blacklist: parseLines(document.getElementById("site-blacklist").value),
  };

  // AI Chat Guard
  currentSettings.aiChatGuard = {
    enabled: document.getElementById("aiGuardEnabled").checked,
    autoRedactOnAiSites: document.getElementById("aiGuardAutoRedact").checked,
    blockSubmitUntilRedacted: document.getElementById("aiGuardBlockSubmit").checked,
    interceptUploads: document.getElementById("aiGuardInterceptUploads").checked,
    showAiBanner: document.getElementById("aiGuardBanner").checked,
    customAiDomains: parseLines(document.getElementById("aiGuardCustomDomains").value),
  };

  // Auto-redact
  currentSettings.autoRedact = {
    enabled: document.getElementById("autoRedactEnabled").checked,
    onlyOnAiSites: document.getElementById("autoRedactOnlyAi").checked,
    onPaste: document.getElementById("autoRedactOnPaste").checked,
    debounceMs: parseInt(document.getElementById("autoRedactDebounce").value, 10) || 1500,
  };

  // Submit guard
  currentSettings.submitGuard = {
    enabled: document.getElementById("submitGuardEnabled").checked,
    interceptEnter: document.getElementById("submitGuardEnter").checked,
    interceptFormSubmit: document.getElementById("submitGuardForm").checked,
    interceptSendButtons: document.getElementById("submitGuardSendBtn").checked,
    onlyOnAiSites: document.getElementById("submitGuardOnlyAi").checked,
  };

  // Upload guard
  currentSettings.uploadGuard = {
    enabled: document.getElementById("uploadGuardEnabled").checked,
    onlyOnAiSites: document.getElementById("uploadGuardOnlyAi").checked,
    confirmBeforeUpload: document.getElementById("uploadGuardConfirm").checked,
  };

  // Voice capture detection
  currentSettings.voiceDetection = {
    ...(currentSettings.voiceDetection || {}),
    enabled: document.getElementById("voiceDetectionEnabled").checked,
    warnOnLeak: document.getElementById("voiceDetectionWarn").checked,
  };

  // Inline voice dictation
  currentSettings.voiceDictation = {
    ...(currentSettings.voiceDictation || {}),
    enabled: document.getElementById("voiceDictationEnabled").checked,
    suppressNativeMic: document.getElementById("voiceDictationSuppress").checked,
  };

  // Reversible tokenization
  currentSettings.reversibleTokenization = {
    ...(currentSettings.reversibleTokenization || {}),
    enabled: document.getElementById("reversibleTokenizationEnabled").checked,
  };

  // Remote config URL
  currentSettings.configUrl = document.getElementById("configUrl").value.trim();

  chrome.runtime.sendMessage(
    { type: "SAVE_SETTINGS", settings: currentSettings },
    (response) => {
      const status = document.getElementById("save-status");
      if (response?.success) {
        status.textContent = "Settings saved!";
        status.style.color = "#22c55e";
        loadProviderStatus(); // Refresh status after re-init
      } else {
        status.textContent = "Failed to save.";
        status.style.color = "#dc2626";
      }
      setTimeout(() => { status.textContent = ""; }, 3000);
    }
  );
}

// ── Utility ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function parseLines(text) {
  return (text || "").split("\n").map(l => l.trim()).filter(Boolean);
}

function updateSiteFilterVisibility(mode) {
  document.getElementById("whitelist-section").classList.toggle("hidden", mode !== "whitelist");
  document.getElementById("blacklist-section").classList.toggle("hidden", mode !== "blacklist");
}

// ── Event listeners ────────────────────────────────────────────────────────

document.getElementById("vectorThreshold").addEventListener("input", (e) => {
  document.getElementById("thresholdValue").textContent = e.target.value;
});

document.getElementById("sessionTimeout").addEventListener("input", (e) => {
  document.getElementById("timeoutValue").textContent = `${e.target.value} min`;
});

// Site filter mode toggle
document.querySelectorAll('input[name="siteFilterMode"]').forEach(r => {
  r.addEventListener("change", (e) => updateSiteFilterVisibility(e.target.value));
});

// Auto-redact debounce slider
document.getElementById("autoRedactDebounce").addEventListener("input", (e) => {
  document.getElementById("debounceValue").textContent = `${e.target.value} ms`;
});

document.getElementById("btn-add-custom").addEventListener("click", () => openModal());
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("modal-save").addEventListener("click", saveModal);
document.getElementById("btn-test-regex").addEventListener("click", testRegex);
document.getElementById("btn-save").addEventListener("click", saveSettings);

document.getElementById("btn-reset-stats").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_STATS" }, () => loadStats());
});

// Provider buttons
document.getElementById("btn-add-hosted").addEventListener("click", () => openHostedModal());
document.getElementById("hosted-modal-cancel").addEventListener("click", closeHostedModal);
document.getElementById("hosted-modal-save").addEventListener("click", saveHostedModal);
document.getElementById("hosted-modal-test").addEventListener("click", async () => {
  const endpoint = document.getElementById("hosted-endpoint").value.trim();
  const apiKey = document.getElementById("hosted-apikey").value;
  const apiMode = document.getElementById("hosted-apimode").value;
  const errEl = document.getElementById("hosted-modal-errors");

  if (!endpoint) {
    errEl.textContent = "Enter an endpoint URL first.";
    errEl.style.color = "#dc2626";
    return;
  }

  errEl.textContent = "Testing connection...";
  errEl.style.color = "#6b7280";

  try {
    let checkUrl;
    if (apiMode === "openai") {
      checkUrl = `${endpoint.replace(/\/$/, "")}/models`;
    } else {
      checkUrl = endpoint.replace(/\/$/, "");
    }

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(checkUrl, { method: "GET", headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.ok) {
      errEl.textContent = `Connected (HTTP ${response.status})`;
      errEl.style.color = "#059669";
    } else {
      errEl.textContent = `HTTP ${response.status} — endpoint responded but returned an error`;
      errEl.style.color = "#f59e0b";
    }
  } catch (err) {
    errEl.textContent = err.name === "AbortError" ? "Connection timed out (10s)" : `Failed: ${err.message}`;
    errEl.style.color = "#dc2626";
  }
});
// ── Azure connection mode toggle and OAuth2 ──────────────────────────────────

function updateAzureConnectionMode(mode) {
  document.getElementById("azure-direct-fields").classList.toggle("hidden", mode !== "direct");
  document.getElementById("azure-enterprise-fields").classList.toggle("hidden", mode !== "enterprise");
  updateNativeDocHelp(mode);
}

function updateNativeDocHelp(mode) {
  const directHelp = document.getElementById("azure-native-doc-help-direct");
  const enterpriseHelp = document.getElementById("azure-native-doc-help-enterprise");
  const sourceLabel = document.getElementById("azure-source-label");
  const targetLabel = document.getElementById("azure-target-label");
  const sourceInput = document.getElementById("azure-source-url");
  const targetInput = document.getElementById("azure-target-url");

  if (!directHelp) return;

  if (mode === "enterprise") {
    directHelp.classList.add("hidden");
    enterpriseHelp.classList.remove("hidden");
    sourceLabel.textContent = "Source Container URL";
    targetLabel.textContent = "Target Container URL";
    sourceInput.placeholder = "https://account.blob.core.windows.net/source";
    targetInput.placeholder = "https://account.blob.core.windows.net/target";
  } else {
    directHelp.classList.remove("hidden");
    enterpriseHelp.classList.add("hidden");
    sourceLabel.textContent = "Source Container URL (with SAS token)";
    targetLabel.textContent = "Target Container URL (with SAS token)";
    sourceInput.placeholder = "https://account.blob.core.windows.net/source?sv=2022-11-02&ss=b&srt=co&sp=rl&se=...";
    targetInput.placeholder = "https://account.blob.core.windows.net/target?sv=2022-11-02&ss=b&srt=co&sp=wl&se=...";
  }
}

function refreshAzureAuthStatus() {
  chrome.runtime.sendMessage({ type: "AZURE_AUTH_STATUS" }, (response) => {
    const userInfoDiv = document.getElementById("azure-user-info");
    const signinBtn = document.getElementById("btn-azure-signin");
    if (!userInfoDiv || !signinBtn) return;

    if (response?.signedIn && response.userInfo) {
      userInfoDiv.classList.remove("hidden");
      signinBtn.classList.add("hidden");
      document.getElementById("azure-user-display").textContent = response.userInfo.name || "Signed in";
      document.getElementById("azure-user-email").textContent = response.userInfo.email || "";
    } else {
      userInfoDiv.classList.add("hidden");
      signinBtn.classList.remove("hidden");
    }
  });
}

function azureSignIn() {
  const tenantId = document.getElementById("azure-tenant-id").value.trim();
  const clientId = document.getElementById("azure-client-id").value.trim();
  const resultEl = document.getElementById("azure-auth-result");
  if (!tenantId || !clientId) {
    resultEl.textContent = "Tenant ID and Client ID are required.";
    resultEl.style.color = "#dc2626";
    return;
  }
  resultEl.textContent = "Signing in...";
  resultEl.style.color = "#6b7280";
  chrome.runtime.sendMessage({ type: "AZURE_SIGN_IN", tenantId, clientId }, (response) => {
    if (response?.success) {
      resultEl.textContent = `Signed in as ${response.userInfo?.name || "user"}`;
      resultEl.style.color = "#059669";
      refreshAzureAuthStatus();
    } else {
      resultEl.textContent = response?.error || "Sign-in failed";
      resultEl.style.color = "#dc2626";
    }
  });
}

function azureSignOut() {
  chrome.runtime.sendMessage({ type: "AZURE_SIGN_OUT" }, () => {
    refreshAzureAuthStatus();
    const resultEl = document.getElementById("azure-auth-result");
    if (resultEl) resultEl.textContent = "";
  });
}

document.querySelectorAll('input[name="azureConnectionMode"]').forEach(r => {
  r.addEventListener("change", (e) => updateAzureConnectionMode(e.target.value));
});
document.getElementById("btn-azure-signin").addEventListener("click", azureSignIn);
document.getElementById("btn-azure-signout").addEventListener("click", azureSignOut);
document.getElementById("azure-native-doc").addEventListener("change", (e) => {
  document.getElementById("azure-native-doc-fields").classList.toggle("hidden", !e.target.checked);
});
document.getElementById("purview-gate-enabled").addEventListener("change", (e) => {
  document.getElementById("purview-gate-fields").classList.toggle("hidden", !e.target.checked);
});

document.getElementById("btn-test-azure").addEventListener("click", testAzureConnection);
document.getElementById("btn-test-purview").addEventListener("click", testPurviewConnection);

// Remote config fetch
document.getElementById("btn-fetch-config").addEventListener("click", async () => {
  const url = document.getElementById("configUrl").value.trim();
  const resultEl = document.getElementById("config-fetch-result");
  if (!url) {
    resultEl.textContent = "Enter a URL first.";
    resultEl.style.color = "#dc2626";
    return;
  }
  resultEl.textContent = "Fetching...";
  resultEl.style.color = "#6b7280";
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    // Save to local storage
    chrome.storage.local.set({ llss_remote_config: config }, () => {
      const keys = Object.keys(config).filter(k => !k.startsWith("_"));
      const locked = Object.keys(config._locked || {}).filter(k => config._locked[k]);
      resultEl.textContent = `Fetched: ${keys.length} settings, ${locked.length} locked. Save and reload to apply.`;
      resultEl.style.color = "#059669";
    });
  } catch (err) {
    resultEl.textContent = `Failed: ${err.message}`;
    resultEl.style.color = "#dc2626";
  }
});

// Close modals on overlay click.
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});
document.getElementById("hosted-modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "hosted-modal-overlay") closeHostedModal();
});

// ── Category navigation ─────────────────────────────────────────────────────
// The settings are grouped into categories; the sidebar shows one at a time.
function setupCategoryNav() {
  const CAT_TITLES = {
    general: "General",
    providers: "Processing Providers",
    protection: "AI Chat Protection",
    voice: "Voice Dictation",
    documents: "Documents",
    rules: "PII Detection Rules",
    enterprise: "Enterprise & Remote Config",
    diagnostics: "Diagnostics",
  };
  const navItems = Array.from(document.querySelectorAll(".side-nav-item"));
  const sections = Array.from(document.querySelectorAll(".card[data-cat]"));
  const titleEl = document.getElementById("panel-title");

  function activate(cat) {
    if (!CAT_TITLES[cat]) cat = "general";
    sections.forEach((sec) => {
      sec.classList.toggle("cat-hidden", sec.dataset.cat !== cat);
    });
    navItems.forEach((n) => n.classList.toggle("active", n.dataset.target === cat));
    if (titleEl) titleEl.textContent = CAT_TITLES[cat];
    try { localStorage.setItem("llss_settings_cat", cat); } catch { /* ignore */ }
    window.scrollTo({ top: 0 });
  }

  navItems.forEach((n) => {
    n.addEventListener("click", () => activate(n.dataset.target));
  });

  let initial = "general";
  try {
    const saved = localStorage.getItem("llss_settings_cat");
    if (saved && CAT_TITLES[saved]) initial = saved;
  } catch { /* ignore */ }
  activate(initial);
}
setupCategoryNav();

// Initialise.
init();
