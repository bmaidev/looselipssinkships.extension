// options.js — Settings page logic for managing PII types, detection mode,
// fallback options, and viewing statistics.

// PII_CATEGORIES and DEFAULT_PII_TYPES are loaded from lib/pii-types.js via <script> tag.

let currentSettings = null;
let editingCustomIndex = -1; // -1 = adding new, >= 0 = editing existing

// ── Load settings and populate UI ──────────────────────────────────────────

async function init() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
      currentSettings = response?.settings || {};
      populateUI();
      loadStats();
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

  // Sliders.
  const thresholdSlider = document.getElementById("vectorThreshold");
  thresholdSlider.value = s.vectorThreshold || 0.45;
  document.getElementById("thresholdValue").textContent = thresholdSlider.value;

  const timeoutSlider = document.getElementById("sessionTimeout");
  timeoutSlider.value = s.sessionTimeoutMinutes || 5;
  document.getElementById("timeoutValue").textContent = `${timeoutSlider.value} min`;

  // PII types list.
  renderPiiTypes();
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

// ── Statistics ─────────────────────────────────────────────────────────────

function loadStats() {
  chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
    const stats = response?.stats || {};
    const container = document.getElementById("stats-display");
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
        <div class="value">${stats.engineUsage?.ai || 0} / ${stats.engineUsage?.regex || 0} / ${stats.engineUsage?.vector || 0}</div>
        <div class="label">AI / Regex / Vector</div>
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
  currentSettings.vectorThreshold = parseFloat(document.getElementById("vectorThreshold").value);
  currentSettings.sessionTimeoutMinutes = parseInt(document.getElementById("sessionTimeout").value, 10);

  chrome.runtime.sendMessage(
    { type: "SAVE_SETTINGS", settings: currentSettings },
    (response) => {
      const status = document.getElementById("save-status");
      if (response?.success) {
        status.textContent = "Settings saved!";
        status.style.color = "#22c55e";
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

// ── Event listeners ────────────────────────────────────────────────────────

document.getElementById("vectorThreshold").addEventListener("input", (e) => {
  document.getElementById("thresholdValue").textContent = e.target.value;
});

document.getElementById("sessionTimeout").addEventListener("input", (e) => {
  document.getElementById("timeoutValue").textContent = `${e.target.value} min`;
});

document.getElementById("btn-add-custom").addEventListener("click", () => openModal());
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("modal-save").addEventListener("click", saveModal);
document.getElementById("btn-test-regex").addEventListener("click", testRegex);
document.getElementById("btn-save").addEventListener("click", saveSettings);

document.getElementById("btn-reset-stats").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_STATS" }, () => loadStats());
});

// Close modal on overlay click.
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

// Initialise.
init();
