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
const MAX_REGEX_PATTERN_LENGTH = 1000;
const MAX_REGEX_MATCHES = 10_000;
const MAX_REGEX_PATTERNS = 256;
const REDACTION_SPANS = globalThis.LLSS_RedactionSpans || (typeof require !== 'undefined' ? require('./redaction-spans') : null);

function normalizeRegexFlags(flags) {
  const requested = typeof flags === "string" ? flags : "";
  if (!/^[dgimsuvy]*$/.test(requested) || new Set(requested).size !== requested.length) {
    throw new Error("Invalid or duplicate regular-expression flags");
  }
  return requested.includes("g") ? requested : requested + "g";
}

function isLikelyUnsafeRegex(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;
  // Reject the most common catastrophic-backtracking construction: a group
  // containing a variable quantifier that is itself variably quantified.
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(pattern)) return true;
  // Ambiguous repeated alternation and backreferences are also common ReDoS
  // primitives. Custom detection rules should remain regular and bounded.
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(pattern)) return true;
  return /\\[1-9]/.test(pattern);
}

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
  if (sorted.length > MAX_REGEX_PATTERNS) {
    throw new Error(`Too many enabled regex patterns (maximum ${MAX_REGEX_PATTERNS})`);
  }

  // First pass: collect all matches with their positions.
  const allMatches = [];

  for (const piiType of sorted) {
    let re;
    try {
      if (typeof piiType.regex !== "string" || piiType.regex.length === 0 || piiType.regex.length > MAX_REGEX_PATTERN_LENGTH) {
        throw new Error("Pattern rejected by safety limits");
      }
      if (piiType.category === "custom" && isLikelyUnsafeRegex(piiType.regex)) {
        throw new Error("Pattern rejected by safety limits");
      }
      re = new RegExp(piiType.regex, normalizeRegexFlags(piiType.flags));
    } catch (e) {
      globalThis.LLSS_debug?.warn("regex", "Rejected an invalid or unsafe pattern");
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
      if (allMatches.length > MAX_REGEX_MATCHES) {
        throw new Error(`Regex match count exceeds the ${MAX_REGEX_MATCHES.toLocaleString()}-match safety limit`);
      }
    }
  }

  // Sort matches by position (earliest first), then by priority (highest first) for overlaps.
  allMatches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.priority - a.priority;
  });

  // Union coverage instead of discarding partially overlapping identifiers.
  return REDACTION_SPANS.applyMatches(text, allMatches.map(m => ({
    typeId: m.typeId, token: m.token, original: m.original, index: m.start,
  })));
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
    if (isLikelyUnsafeRegex(pattern)) throw new Error("Pattern rejected by safety limits");
    const re = new RegExp(pattern, normalizeRegexFlags(flags));
    const found = [];
    let match;
    while ((match = re.exec(sampleText)) !== null) {
      found.push(match[0]);
      if (match[0].length === 0) break;
      if (found.length >= MAX_REGEX_MATCHES) break;
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
  module.exports = { regexRedact, testRegexPattern, normalizeRegexFlags, isLikelyUnsafeRegex };
}
