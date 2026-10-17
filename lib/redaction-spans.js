// Original-text UTF-16 coordinates are the shared contract for every detector.
// Union overlapping spans: selecting one winner can leak the other's suffix.
(function () {
  'use strict';
  const MAX_MATCHES = 50_000;

  function mergeMatches(text, matches) {
    if (typeof text !== 'string' || !Array.isArray(matches)) throw new Error('Invalid redaction input');
    if (matches.length > MAX_MATCHES) throw new Error('Redaction match limit exceeded');
    const sorted = matches.map(match => {
      if (!Number.isSafeInteger(match?.index) || match.index < 0 ||
          typeof match.original !== 'string' || !match.original.length ||
          match.index + match.original.length > text.length ||
          text.slice(match.index, match.index + match.original.length) !== match.original) {
        throw new Error('Redaction match does not reference the original text');
      }
      return { ...match, token: typeof match.token === 'string' && match.token.length ? match.token : '[REDACTED]' };
    }).sort((a, b) => a.index - b.index || b.original.length - a.original.length ||
      String(a.typeId || '').localeCompare(String(b.typeId || '')) || a.token.localeCompare(b.token));
    const merged = [];
    for (const match of sorted) {
      const previous = merged[merged.length - 1];
      const end = match.index + match.original.length;
      if (previous && match.index < previous.index + previous.original.length) {
        const previousEnd = previous.index + previous.original.length;
        // A contained detection adds no coverage. Preserve the containing type.
        if (end <= previousEnd) continue;
        previous.original = text.slice(previous.index, end);
        if (previous.typeId !== match.typeId || previous.token !== match.token) {
          previous.typeId = 'combined';
          previous.token = '[REDACTED]';
          delete previous.score;
        }
      } else {
        merged.push(match);
      }
    }
    return merged;
  }

  function applyMatches(text, matches) {
    const merged = mergeMatches(text, matches);
    const parts = [];
    let cursor = 0;
    for (const match of merged) {
      parts.push(text.slice(cursor, match.index), match.token);
      cursor = match.index + match.original.length;
    }
    parts.push(text.slice(cursor));
    return { redacted: parts.join(''), matches: merged };
  }

  const api = { mergeMatches, applyMatches, MAX_MATCHES };
  globalThis.LLSS_RedactionSpans = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
