// lib/regex-engine.js — Regex-based PII redaction engine.
// Used as the primary fallback when the AI model is unavailable.
// Applies patterns from the PII type definitions in priority order.

/**
 * Run all enabled regex patterns against the input text and replace matches
 * with their corresponding redaction tokens.
 *
 * @param {string} text - The input text to redact.
 * @param {Array} piiTypes - Array of PII type definitions (from settings or defaults).
 * @returns {{ redacted: string, matches: Array<{ typeId: string, token: string, original: string, index: number }> }}
 */
function regexRedact(text, piiTypes) {
  if (!text || !piiTypes || piiTypes.length === 0) {
    return { redacted: text || "", matches: [] };
  }

  // Sort by priority (higher first), then by regex specificity (longer patterns first).
  const sorted = [...piiTypes]
    .filter((t) => t.enabled && t.regex)
    .sort((a, b) => {
      const pa = a.priority || 0;
      const pb = b.priority || 0;
      if (pb !== pa) return pb - pa;
      return (b.regex?.length || 0) - (a.regex?.length || 0);
    });

  const matches = [];
  // Track which character positions have already been redacted to prevent overlaps.
  const redactedRanges = [];

  function isOverlapping(start, end) {
    return redactedRanges.some(
      (r) => start < r.end && end > r.start
    );
  }

  // First pass: collect all matches with their positions.
  const allMatches = [];

  for (const piiType of sorted) {
    let re;
    try {
      re = new RegExp(piiType.regex, piiType.flags || "g");
    } catch (e) {
      console.warn(`[LLSS] Invalid regex for ${piiType.id}:`, e.message);
      continue;
    }

    let match;
    // Reset lastIndex for global regexes
    re.lastIndex = 0;

    while ((match = re.exec(text)) !== null) {
      const original = match[0];
      const start = match.index;
      const end = start + original.length;

      // Skip zero-length matches to prevent infinite loops.
      if (original.length === 0) {
        re.lastIndex++;
        continue;
      }

      allMatches.push({
        typeId: piiType.id,
        token: piiType.token,
        original,
        start,
        end,
        priority: piiType.priority || 0,
      });
    }
  }

  // Sort matches by position (earliest first), then by priority (highest first) for overlaps.
  allMatches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.priority - a.priority;
  });

  // Second pass: apply non-overlapping matches.
  const accepted = [];
  for (const m of allMatches) {
    if (!isOverlapping(m.start, m.end)) {
      accepted.push(m);
      redactedRanges.push({ start: m.start, end: m.end });
    }
  }

  // Build the redacted string by replacing from end to start (to preserve indices).
  let redacted = text;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const m = accepted[i];
    redacted = redacted.slice(0, m.start) + m.token + redacted.slice(m.end);
    matches.push({
      typeId: m.typeId,
      token: m.token,
      original: m.original,
      index: m.start,
    });
  }

  // Reverse matches so they're in document order.
  matches.reverse();

  return { redacted, matches };
}

/**
 * Test a single regex pattern against sample text.
 * Useful for the options page "Test" button.
 *
 * @param {string} pattern - Regex pattern string.
 * @param {string} flags - Regex flags.
 * @param {string} sampleText - Text to test against.
 * @returns {{ valid: boolean, matches: string[], error?: string }}
 */
function testRegexPattern(pattern, flags, sampleText) {
  try {
    const re = new RegExp(pattern, flags || "g");
    const found = [];
    let match;
    while ((match = re.exec(sampleText)) !== null) {
      found.push(match[0]);
      if (match[0].length === 0) break;
    }
    return { valid: true, matches: found };
  } catch (e) {
    return { valid: false, matches: [], error: e.message };
  }
}

if (typeof globalThis !== "undefined") {
  globalThis.LLSS_regexRedact = regexRedact;
  globalThis.LLSS_testRegexPattern = testRegexPattern;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { regexRedact, testRegexPattern };
}
