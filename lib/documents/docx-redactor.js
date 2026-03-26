/**
 * DOCX Redactor — run-aware XML text replacement for PII redaction.
 *
 * Strategy:
 *   1. Parse the DOCX ZIP, extract XML files (document.xml, headers, footers)
 *   2. For each XML file, build a virtual text stream from <w:t> elements
 *      while maintaining a run map (character offsets → XML positions)
 *   3. Run regex PII detection on the virtual text
 *   4. Map matches back to XML runs and replace PII with tokens
 *   5. Repack the modified ZIP using zip-writer.js
 *
 * Handles PII spanning multiple <w:r> runs (e.g., an email address split
 * across two <w:t> tags due to spell-check or formatting changes).
 */

(function () {
  'use strict';

  // XML files within a DOCX that may contain PII text
  const REDACTABLE_PARTS = [
    'word/document.xml',
    /^word\/header\d+\.xml$/,
    /^word\/footer\d+\.xml$/,
    /^word\/comments\.xml$/,
    /^word\/footnotes\.xml$/,
    /^word\/endnotes\.xml$/,
  ];

  /**
   * Check if a ZIP entry name is a redactable XML part.
   */
  function isRedactablePart(name) {
    return REDACTABLE_PARTS.some(p =>
      typeof p === 'string' ? name === p : p.test(name)
    );
  }

  /**
   * Build a run map from OOXML content.
   *
   * Walks <w:t> elements within <w:p> paragraphs. Produces:
   *   - virtualText: flat string of all text content (paragraphs joined by \n)
   *   - runs: array of { charStart, charEnd, tagStart, tagEnd } mapping
   *     character offsets in virtualText to byte positions of the text
   *     content within the XML string.
   *
   * @param {string} xml - Raw XML string
   * @returns {{ virtualText: string, runs: Array<{charStart: number, charEnd: number, tagStart: number, tagEnd: number, text: string}> }}
   */
  function buildRunMap(xml) {
    const runs = [];
    let virtualText = '';

    // Match <w:t ...>text</w:t> capturing the text and its position.
    // The regex captures:
    //   - Full match position (for locating in XML)
    //   - The text content between tags
    const wtRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    // Also track paragraph boundaries for newlines
    const wpEndRegex = /<\/w:p>/g;

    // Build a combined event stream of text runs and paragraph breaks
    const events = [];

    let m;
    while ((m = wtRegex.exec(xml)) !== null) {
      const text = m[1];
      if (text.length === 0) continue;
      // tagStart/tagEnd point to the TEXT CONTENT within the XML
      // (after the opening tag, before </w:t>)
      const fullMatchStart = m.index;
      const openTagEnd = xml.indexOf('>', fullMatchStart) + 1;
      events.push({
        type: 'text',
        text,
        tagStart: openTagEnd,          // Start of text content in XML
        tagEnd: openTagEnd + text.length, // End of text content in XML
        xmlIndex: m.index,
      });
    }

    while ((m = wpEndRegex.exec(xml)) !== null) {
      events.push({ type: 'para_end', xmlIndex: m.index });
    }

    // Sort by XML position
    events.sort((a, b) => a.xmlIndex - b.xmlIndex);

    let lastWasPara = false;
    for (const evt of events) {
      if (evt.type === 'para_end') {
        if (virtualText.length > 0 && !lastWasPara) {
          virtualText += '\n';
          lastWasPara = true;
        }
      } else if (evt.type === 'text') {
        const charStart = virtualText.length;
        virtualText += evt.text;
        runs.push({
          charStart,
          charEnd: virtualText.length,
          tagStart: evt.tagStart,
          tagEnd: evt.tagEnd,
          text: evt.text,
        });
        lastWasPara = false;
      }
    }

    return { virtualText, runs };
  }

  /**
   * Apply PII match replacements to XML using the run map.
   *
   * For each match, finds overlapping runs and replaces the text content
   * in the XML string. Handles:
   *   - Single-run matches (most common)
   *   - Multi-run spans (PII split across formatting runs)
   *
   * Processes matches in REVERSE order (right-to-left) so that earlier
   * replacements don't shift the positions of later ones.
   *
   * @param {string} xml - Original XML string
   * @param {Array} matches - PII matches with { index, original, token }
   * @param {Array} runs - Run map from buildRunMap
   * @returns {string} Modified XML
   */
  function applyRedactionsToXml(xml, matches, runs) {
    if (!matches || matches.length === 0) return xml;

    // Collect all XML replacements (may be multiple per match for multi-run spans)
    const replacements = [];

    for (const match of matches) {
      const matchStart = match.index;
      const matchEnd = matchStart + match.original.length;

      // Find all runs that overlap this match
      const overlapping = runs.filter(r =>
        r.charStart < matchEnd && r.charEnd > matchStart
      );

      if (overlapping.length === 0) continue;

      if (overlapping.length === 1) {
        // Single run — replace within the run's text
        const run = overlapping[0];
        const relStart = matchStart - run.charStart;
        const relEnd = matchEnd - run.charStart;
        const newText = run.text.substring(0, relStart) +
                        (match.token || '[REDACTED]') +
                        run.text.substring(relEnd);
        replacements.push({
          tagStart: run.tagStart,
          tagEnd: run.tagEnd,
          newText,
        });
      } else {
        // Multi-run span — put token in first run, blank subsequent runs
        for (let i = 0; i < overlapping.length; i++) {
          const run = overlapping[i];
          const overlapStart = Math.max(matchStart, run.charStart);
          const overlapEnd = Math.min(matchEnd, run.charEnd);
          const relStart = overlapStart - run.charStart;
          const relEnd = overlapEnd - run.charStart;

          let newText;
          if (i === 0) {
            // First run: keep prefix + token
            newText = run.text.substring(0, relStart) +
                      (match.token || '[REDACTED]');
          } else if (i === overlapping.length - 1) {
            // Last run: keep suffix
            newText = run.text.substring(relEnd);
          } else {
            // Middle runs: blank out entirely
            newText = '';
          }

          replacements.push({
            tagStart: run.tagStart,
            tagEnd: run.tagEnd,
            newText,
          });
        }
      }
    }

    // Sort replacements by position (descending) so we can apply right-to-left
    replacements.sort((a, b) => b.tagStart - a.tagStart);

    // Deduplicate: if multiple replacements target the same tag position,
    // keep the first one (which was from the last match processed)
    const seen = new Set();
    const deduped = replacements.filter(r => {
      const key = `${r.tagStart}:${r.tagEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Apply replacements right-to-left
    let result = xml;
    for (const rep of deduped) {
      result = result.substring(0, rep.tagStart) +
               escapeXml(rep.newText) +
               result.substring(rep.tagEnd);
    }

    return result;
  }

  /**
   * Escape special XML characters in replacement text.
   */
  function escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Unescape XML entities in text content (for regex matching).
   */
  function unescapeXml(text) {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Redact PII in a DOCX file.
   *
   * @param {ArrayBuffer} buffer - Raw DOCX file bytes
   * @param {Array} piiTypes - PII type definitions (with .enabled, .regex, .token)
   * @param {Object} settings - Extension settings
   * @param {Object} [options]
   * @param {Function} [options.redactFn] - Custom redaction function (text, piiTypes) => {redacted, matches}.
   *   Defaults to regex engine. Pass a cloud provider's redactText for cloud_only mode.
   * @returns {Promise<{redactedFile: Uint8Array, redacted: string, matches: Array, metadata: Object}>}
   */
  async function redactDocx(buffer, piiTypes, settings, options = {}) {
    const parseZip = globalThis.LLSS_parseZipEntries ||
      (typeof require !== 'undefined' ? require('./document-processor').parseZipEntries : null);
    const buildZip = globalThis.LLSS_buildZip ||
      (typeof require !== 'undefined' ? require('./zip-writer').buildZip : null);
    const defaultRedactFn = globalThis.LLSS_regexRedact ||
      (typeof require !== 'undefined' ? require('../regex-engine').regexRedact : null);
    const redactFn = options.redactFn || defaultRedactFn;

    if (!parseZip) throw new Error('ZIP parser not available');
    if (!buildZip) throw new Error('ZIP writer not available');
    if (!redactFn) throw new Error('Redaction engine not available');

    const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;

    // Parse the DOCX ZIP
    const entries = await parseZip(buffer);
    const allMatches = [];
    let allRedactedText = '';
    let totalReplacements = 0;

    // Process each redactable XML part
    const modifiedEntries = [];
    for (const entry of entries) {
      if (isRedactablePart(entry.name)) {
        let xml = new TextDecoder().decode(entry.data);

        // Build run map and extract virtual text
        const { virtualText, runs } = buildRunMap(xml);

        if (virtualText.trim().length > 0) {
          // Unescape XML entities for regex matching
          // (the run map positions reference the ESCAPED xml, so we need
          //  to match against unescaped text and map back carefully)
          // Actually, <w:t> content in OOXML is already unescaped by the
          // XML parser — but since we're using regex on raw XML, the text
          // between tags may contain &amp; etc. We need to handle this.

          // Run PII detection on the virtual text
          const redactResult = await redactFn(virtualText, piiTypes);
          const matches = redactResult.matches || [];

          if (matches.length > 0) {
            if (dbg) dbg.log('docx', `${entry.name}: ${matches.length} PII matches in ${virtualText.length} chars`);

            // Apply redactions to XML
            xml = applyRedactionsToXml(xml, matches, runs);
            totalReplacements += matches.length;

            // Collect matches with part name for reporting
            for (const m of matches) {
              allMatches.push({ ...m, part: entry.name });
            }
          }

          allRedactedText += virtualText + '\n';
        }

        // Store modified XML
        modifiedEntries.push({
          name: entry.name,
          data: new TextEncoder().encode(xml),
        });
      } else {
        // Keep non-text entries unchanged (images, styles, etc.)
        modifiedEntries.push(entry);
      }
    }

    if (dbg) dbg.log('docx', `Total: ${totalReplacements} replacements across ${entries.length} ZIP entries`);

    // Rebuild the ZIP with modified XML
    const redactedZip = await buildZip(modifiedEntries);

    return {
      redactedFile: Array.from(redactedZip),
      redactedFileFormat: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      redacted: allRedactedText,
      matches: allMatches,
      engine: 'regex',
      metadata: { documentType: 'docx', method: 'xml_replacement', replacements: totalReplacements },
    };
  }

  // Also expose buildRunMap and applyRedactionsToXml for the XLSX redactor (similar XML structure)

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_redactDocx = redactDocx;
    globalThis.LLSS_buildRunMap = buildRunMap;
    globalThis.LLSS_applyRedactionsToXml = applyRedactionsToXml;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { redactDocx, buildRunMap, applyRedactionsToXml, isRedactablePart };
  }
})();
