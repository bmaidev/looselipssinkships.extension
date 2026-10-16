/**
 * Microsoft sensitivity-label gate — pre-upload local metadata check.
 *
 * The gate reads embedded MSIP_Label_* metadata from DOCX/XLSX ZIP archives.
 * It never uploads the file or sends document-derived data to Microsoft.
 * Documents carrying blocked labels or encryption markers are rejected before
 * the redaction pipeline runs.
 */

(function () {
  'use strict';

  const ENCRYPT = 0x8;

  /**
   * Read enabled Microsoft Information Protection labels from an OOXML file.
   * Any parsing failure is security-sensitive and therefore fails closed.
   */
  async function readMsipLabels(buffer, contentType) {
    const parseZip = globalThis.LLSS_parseZipEntries;
    if (!parseZip || (contentType !== 'docx' && contentType !== 'xlsx')) return [];

    try {
      const entries = await parseZip(buffer);
      const customPropsEntry = entries.find((entry) =>
        entry.name === 'docProps/custom.xml' || entry.name === 'customXml/item1.xml'
      );
      if (!customPropsEntry) return [];

      const xml = new TextDecoder('utf-8', { fatal: true }).decode(customPropsEntry.data);
      return parseMsipFromXml(xml);
    } catch (err) {
      const dbg = globalThis.LLSS_debug;
      if (dbg) dbg.warn('purview-gate', 'Failed to read MSIP labels:', err.message);
      throw new Error('Could not safely inspect document sensitivity labels');
    }
  }

  /** Parse MSIP_Label_{GUID}_{Attribute} custom properties from XML. */
  function parseMsipFromXml(xml) {
    const labels = new Map();
    const propRegex = /(?:name|fmtid)[^>]*?["']MSIP_Label_([a-f0-9-]+)_(\w+)["'][^>]*>(?:<[^>]+>)?([^<]*)/gi;
    let match;

    while ((match = propRegex.exec(xml)) !== null) {
      const labelId = match[1].toLowerCase();
      const attr = match[2];
      const value = match[3].trim();
      if (!labels.has(labelId)) {
        labels.set(labelId, {
          labelId,
          labelName: null,
          siteId: null,
          method: null,
          enabled: false,
          contentBits: 0,
        });
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

    return Array.from(labels.values()).filter((label) => label.enabled);
  }

  /** Evaluate whether a file may enter the upload/redaction pipeline. */
  async function evaluateGate(fileData, _fileName, _mimeType, contentType, settings) {
    if (!settings?.gateEnabled) {
      return { allowed: true, severity: 'allowed', label: null, reason: 'Gate not enabled' };
    }

    // v6 and earlier exposed an API option whose endpoint does not classify raw
    // content. Never silently downgrade a legacy policy that expected it to.
    if (settings.checkViaApi) {
      throw new Error('Remote sensitivity-label evaluation is unsupported; disable checkViaApi and use the local label gate');
    }

    const dbg = globalThis.LLSS_debug;
    const blockedLabels = (settings.blockedLabels || []).map((label) => label.toLowerCase().trim()).filter(Boolean);
    const warnLabels = (settings.warnLabels || []).map((label) => label.toLowerCase().trim()).filter(Boolean);
    const blockEncrypted = settings.blockEncrypted !== false;
    const labels = await readMsipLabels(fileData, contentType);

    for (const label of labels) {
      const name = (label.labelName || '').toLowerCase().trim();
      if (blockEncrypted && (label.contentBits & ENCRYPT)) {
        return {
          allowed: false,
          severity: 'blocked',
          label: label.labelName,
          reason: `Document is encrypted/protected (${label.labelName || 'unknown label'})`,
        };
      }
      if (blockedLabels.some((blocked) => name.includes(blocked))) {
        return {
          allowed: false,
          severity: 'blocked',
          label: label.labelName,
          reason: `Document is classified "${label.labelName}" — upload to external services is not permitted`,
        };
      }
      if (warnLabels.some((warning) => name.includes(warning))) {
        return {
          allowed: true,
          severity: 'warned',
          label: label.labelName,
          reason: `Document is classified "${label.labelName}" — proceed with caution`,
        };
      }
    }

    if (dbg) dbg.log('purview-gate', 'Document allowed (no blocked labels found)');
    return {
      allowed: true,
      severity: 'allowed',
      label: labels[0]?.labelName || null,
      reason: 'No classification restrictions',
    };
  }

  const api = { readMsipLabels, parseMsipFromXml, evaluateGate };
  if (typeof globalThis !== 'undefined') globalThis.LLSS_PurviewGate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
