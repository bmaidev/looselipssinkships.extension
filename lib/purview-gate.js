/**
 * Purview Classification Gate — pre-upload sensitivity label check.
 *
 * Checks whether a document should be allowed to leave the organisation
 * BEFORE any PII redaction is attempted. Documents with blocked sensitivity
 * labels (e.g., PROTECTED, SECRET) are rejected outright.
 *
 * Two-layer check:
 *   Layer 1 (local, instant): Read MSIP_Label_* metadata from DOCX/XLSX
 *     ZIP archives (docProps/custom.xml). No API call needed.
 *   Layer 2 (optional, API): Evaluate classification via Microsoft Graph
 *     beta API for deeper policy checking.
 *
 * MSIP metadata format:
 *   MSIP_Label_{GUID}_Enabled = true
 *   MSIP_Label_{GUID}_Name = "PROTECTED"
 *   MSIP_Label_{GUID}_SiteId = {tenant GUID}
 *   MSIP_Label_{GUID}_Method = Standard | Privileged
 *   MSIP_Label_{GUID}_ContentBits = 8 (bitmask: 0x8 = encrypted)
 */

(function () {
  'use strict';

  // ContentBits bitmask values
  const CONTENT_HEADER = 0x1;
  const CONTENT_FOOTER = 0x2;
  const WATERMARK = 0x4;
  const ENCRYPT = 0x8;

  // ── Layer 1: Local MSIP metadata reading ──────────────────────────────────

  /**
   * Read MSIP sensitivity labels from a DOCX/XLSX file's custom properties.
   *
   * OOXML files store custom properties in docProps/custom.xml inside the ZIP.
   * MSIP labels are stored as key-value pairs with the prefix MSIP_Label_.
   *
   * @param {ArrayBuffer} buffer - Raw file bytes
   * @param {string} contentType - 'docx', 'xlsx', or other
   * @returns {Promise<Array<{labelName, labelId, siteId, method, enabled, contentBits}>>}
   */
  async function readMsipLabels(buffer, contentType) {
    const parseZip = globalThis.LLSS_parseZipEntries;
    if (!parseZip) return [];

    // Only OOXML formats (DOCX, XLSX) have ZIP-based custom properties
    if (contentType !== 'docx' && contentType !== 'xlsx') return [];

    try {
      const entries = await parseZip(buffer);

      // Look for custom properties in both standard and co-authoring locations
      const customPropsEntry = entries.find(e =>
        e.name === 'docProps/custom.xml' || e.name === 'customXml/item1.xml'
      );

      if (!customPropsEntry) return [];

      const xml = new TextDecoder().decode(customPropsEntry.data);
      return parseMsipFromXml(xml);
    } catch (err) {
      const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;
      if (dbg) dbg.warn('purview-gate', 'Failed to read MSIP labels:', err.message);
      return [];
    }
  }

  /**
   * Parse MSIP_Label_* properties from XML content.
   * Works with both docProps/custom.xml format and custom.xml component format.
   */
  function parseMsipFromXml(xml) {
    const labels = new Map(); // labelId → properties

    // Match custom property elements: <property name="MSIP_Label_GUID_Attr">value</property>
    // Also handles: <vt:lpwstr>value</vt:lpwstr> format
    const propRegex = /(?:name|fmtid)[^>]*?["']MSIP_Label_([a-f0-9-]+)_(\w+)["'][^>]*>(?:<[^>]+>)?([^<]*)/gi;
    let match;

    while ((match = propRegex.exec(xml)) !== null) {
      const labelId = match[1].toLowerCase();
      const attr = match[2];
      const value = match[3].trim();

      if (!labels.has(labelId)) {
        labels.set(labelId, { labelId, labelName: null, siteId: null, method: null, enabled: false, contentBits: 0 });
      }

      const label = labels.get(labelId);
      switch (attr) {
        case 'Enabled': label.enabled = value.toLowerCase() === 'true'; break;
        case 'Name': label.labelName = value; break;
        case 'SiteId': label.siteId = value; break;
        case 'Method': label.method = value; break;
        case 'ContentBits': label.contentBits = parseInt(value, 10) || 0; break;
        case 'SetDate': label.setDate = value; break;
      }
    }

    // Return only enabled labels
    return Array.from(labels.values()).filter(l => l.enabled);
  }

  // ── Layer 2: Graph API classification check (optional) ────────────────────

  /**
   * Check classification via Microsoft Graph API.
   * Uses the evaluateClassificationResults endpoint (beta).
   *
   * @param {Object} fileMetadata - Existing label metadata
   * @param {Object} purviewSettings - Purview provider settings
   * @returns {Promise<{labelName: string, sensitivity: number, actions: Array}|null>}
   */
  async function checkViaGraphApi(fileMetadata, purviewSettings) {
    const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

    if (!purviewSettings.tenantId || (!purviewSettings.clientSecret && !purviewSettings.accessToken)) {
      if (dbg) dbg.warn('purview-gate', 'Graph API check requires auth credentials');
      return null;
    }

    try {
      // Get access token
      let token = purviewSettings.accessToken;
      if (!token && purviewSettings.clientSecret) {
        const tokenUrl = `https://login.microsoftonline.com/${purviewSettings.tenantId}/oauth2/v2.0/token`;
        const params = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: purviewSettings.clientId,
          client_secret: purviewSettings.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        });
        const tokenResponse = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        });
        if (!tokenResponse.ok) return null;
        const tokenData = await tokenResponse.json();
        token = tokenData.access_token;
      }

      // Build metadata key-value pairs from existing labels
      const metadata = [];
      if (fileMetadata && fileMetadata.length > 0) {
        const label = fileMetadata[0];
        metadata.push(
          { name: `MSIP_Label_${label.labelId}_Enabled`, value: 'true' },
          { name: `MSIP_Label_${label.labelId}_Name`, value: label.labelName || '' },
          { name: `MSIP_Label_${label.labelId}_SiteId`, value: label.siteId || '' },
        );
      }

      const endpoint = purviewSettings.graphEndpoint || 'https://graph.microsoft.com/beta';
      const url = `${endpoint}/users/security/informationProtection/sensitivityLabels/evaluateClassificationResults`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'LLSS/1.0',
        },
        body: JSON.stringify({
          contentInfo: {
            '@odata.type': '#microsoft.graph.security.contentInfo',
            format: 'default',
            contentFormat: 'File',
            state: 'rest',
            metadata,
          },
          classificationResults: [],
        }),
      });

      if (!response.ok) {
        if (dbg) dbg.warn('purview-gate', 'Graph API evaluation failed:', response.status);
        return null;
      }

      const result = await response.json();
      const actions = result.value || [];

      for (const action of actions) {
        if (action['@odata.type']?.includes('applyLabelAction') && action.label) {
          return {
            labelName: action.label.name,
            labelId: action.label.id,
            sensitivity: action.label.sensitivity || 0,
            isActive: action.label.isActive,
            actions: action.actions || [],
            hasProtection: (action.actions || []).some(a =>
              a['@odata.type']?.includes('protectByTemplate') ||
              a['@odata.type']?.includes('protectAdhoc') ||
              a['@odata.type']?.includes('protectDoNotForward')
            ),
          };
        }
      }

      return null;
    } catch (err) {
      if (dbg) dbg.warn('purview-gate', 'Graph API check failed:', err.message);
      return null;
    }
  }

  // ── Gate evaluation ───────────────────────────────────────────────────────

  /**
   * Evaluate whether a file should be allowed to upload.
   *
   * @param {ArrayBuffer} fileData - Raw file bytes
   * @param {string} fileName - File name
   * @param {string} mimeType - MIME type
   * @param {string} contentType - Detected content type ('docx', 'xlsx', etc.)
   * @param {Object} purviewSettings - Purview settings from settings.providers.purview
   * @returns {Promise<{allowed: boolean, severity: string, label: string|null, reason: string}>}
   */
  async function evaluateGate(fileData, fileName, mimeType, contentType, purviewSettings) {
    const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

    if (!purviewSettings?.gateEnabled) {
      return { allowed: true, severity: 'allowed', label: null, reason: 'Gate not enabled' };
    }

    if (dbg) dbg.log('purview-gate', `Checking ${fileName} (${contentType})...`);

    const blockedLabels = (purviewSettings.blockedLabels || []).map(l => l.toLowerCase().trim());
    const warnLabels = (purviewSettings.warnLabels || []).map(l => l.toLowerCase().trim());
    const blockEncrypted = purviewSettings.blockEncrypted !== false;

    // Layer 1: Read existing MSIP labels from file metadata
    const labels = await readMsipLabels(fileData, contentType);

    if (labels.length > 0) {
      if (dbg) dbg.log('purview-gate', `Found ${labels.length} MSIP label(s):`, labels.map(l => l.labelName).join(', '));

      for (const label of labels) {
        const name = (label.labelName || '').toLowerCase().trim();

        // Check if encrypted (ContentBits & ENCRYPT)
        if (blockEncrypted && (label.contentBits & ENCRYPT)) {
          if (dbg) dbg.log('purview-gate', `BLOCKED: ${fileName} is encrypted (ContentBits=${label.contentBits})`);
          return {
            allowed: false,
            severity: 'blocked',
            label: label.labelName,
            reason: `Document is encrypted/protected (${label.labelName || 'unknown label'})`,
          };
        }

        // Check blocked labels
        if (blockedLabels.length > 0 && blockedLabels.some(bl => name.includes(bl))) {
          if (dbg) dbg.log('purview-gate', `BLOCKED: ${fileName} has label "${label.labelName}"`);
          return {
            allowed: false,
            severity: 'blocked',
            label: label.labelName,
            reason: `Document is classified "${label.labelName}" — upload to external services is not permitted`,
          };
        }

        // Check warn labels
        if (warnLabels.length > 0 && warnLabels.some(wl => name.includes(wl))) {
          if (dbg) dbg.log('purview-gate', `WARNING: ${fileName} has label "${label.labelName}"`);
          return {
            allowed: true,
            severity: 'warned',
            label: label.labelName,
            reason: `Document is classified "${label.labelName}" — proceed with caution`,
          };
        }
      }
    }

    // Layer 2: Optional Graph API check
    if (purviewSettings.checkViaApi) {
      const apiResult = await checkViaGraphApi(labels, purviewSettings);
      if (apiResult) {
        const apiName = (apiResult.labelName || '').toLowerCase().trim();

        if (apiResult.hasProtection && blockEncrypted) {
          return {
            allowed: false,
            severity: 'blocked',
            label: apiResult.labelName,
            reason: `Document requires protection (${apiResult.labelName}) — upload not permitted`,
          };
        }

        if (blockedLabels.some(bl => apiName.includes(bl))) {
          return {
            allowed: false,
            severity: 'blocked',
            label: apiResult.labelName,
            reason: `Document classified "${apiResult.labelName}" by policy — upload not permitted`,
          };
        }

        // Check sensitivity threshold
        if (purviewSettings.blockedSensitivity > 0 && apiResult.sensitivity >= purviewSettings.blockedSensitivity) {
          return {
            allowed: false,
            severity: 'blocked',
            label: apiResult.labelName,
            reason: `Document sensitivity level (${apiResult.sensitivity}) exceeds threshold — upload not permitted`,
          };
        }

        if (warnLabels.some(wl => apiName.includes(wl))) {
          return {
            allowed: true,
            severity: 'warned',
            label: apiResult.labelName,
            reason: `Document classified "${apiResult.labelName}" by policy — proceed with caution`,
          };
        }
      }
    }

    // No issues found
    if (dbg) dbg.log('purview-gate', `${fileName}: allowed (no blocked labels found)`);
    return { allowed: true, severity: 'allowed', label: labels[0]?.labelName || null, reason: 'No classification restrictions' };
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_PurviewGate = {
      readMsipLabels,
      parseMsipFromXml,
      evaluateGate,
      checkViaGraphApi,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readMsipLabels, parseMsipFromXml, evaluateGate, checkViaGraphApi };
  }
})();
