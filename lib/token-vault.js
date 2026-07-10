/**
 * Token Vault — reversible PII tokenization.
 *
 * Instead of collapsing every match to a generic mask ("[REDACTED_EMAIL]"),
 * mint a UNIQUE, stable placeholder per distinct value:
 *   jane@x.com  -> [[EMAIL_1]]
 *   John Smith  -> [[PERSON_1]]
 * and remember the mapping in a local, in-memory vault. The same original value
 * always maps to the same token (within a vault), so an assistant that echoes a
 * placeholder can later be de-tokenized back to the original for display.
 *
 * This module is pure and side-effect-free — no DOM, no network, no storage.
 * The vault is a plain object the caller holds (per conversation/tab) and must
 * keep in memory only. `restore()` is the inbound primitive used to swap tokens
 * back to originals; the outbound prototype only uses `tokenize()`.
 *
 * Token format `[[LABEL_N]]` is ASCII and double-bracketed to be distinctive
 * (unlikely to collide with normal text) and to survive an LLM round-trip as an
 * opaque span. If a token does NOT survive, restore simply leaves it in place —
 * the user sees a placeholder, never a leak.
 */

(function () {
  'use strict';

  /** Derive a short uppercase label from a PII type id (e.g. "name_vector" -> "NAME"). */
  function labelFor(typeId) {
    if (!typeId) return 'PII';
    let label = String(typeId).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    // Common id -> friendlier label.
    if (label === 'NAME_VECTOR') label = 'PERSON';
    if (label === 'NAME') label = 'PERSON';
    return label || 'PII';
  }

  function createVault() {
    return {
      byToken: {},     // token -> original
      byOriginal: {},  // original -> token
      counters: {},    // label -> highest N used
      order: [],       // tokens in creation order (longest-lived first is fine)
    };
  }

  /** Get (or mint) the stable token for an original value. */
  function tokenFor(vault, original, typeId) {
    if (Object.prototype.hasOwnProperty.call(vault.byOriginal, original)) {
      return vault.byOriginal[original];
    }
    const label = labelFor(typeId);
    vault.counters[label] = (vault.counters[label] || 0) + 1;
    const token = `[[${label}_${vault.counters[label]}]]`;
    vault.byOriginal[original] = token;
    vault.byToken[token] = original;
    vault.order.push(token);
    return token;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Replace PII originals in `text` with unique, stable tokens.
   * Matches are used only for their `original` value and `typeId` — positions
   * are not required. Distinct originals are replaced longest-first so a shorter
   * value can't shadow a longer one it's a substring of.
   *
   * @param {string} text - the original (unredacted) text
   * @param {Array<{original: string, typeId?: string}>} matches
   * @param {object} [vault] - reused across calls for cross-message consistency
   * @returns {{text: string, vault: object, applied: Array<{token: string, original: string}>}}
   */
  function tokenize(text, matches, vault) {
    vault = vault || createVault();
    if (!text || !Array.isArray(matches) || matches.length === 0) {
      return { text: text || '', vault, applied: [] };
    }

    // Pass 1: mint tokens in appearance order, so [[EMAIL_1]] is the first
    // email seen (intuitive numbering), reusing existing vault entries.
    const seen = new Set();
    const distinct = [];
    for (const m of matches) {
      if (!m || typeof m.original !== 'string' || m.original === '') continue;
      if (seen.has(m.original)) continue;
      seen.add(m.original);
      distinct.push({ original: m.original, token: tokenFor(vault, m.original, m.typeId) });
    }

    // Pass 2: replace longest-first, so a shorter value can't shadow a longer
    // one it's a substring of. Numbering (pass 1) is independent of this order.
    distinct.sort((a, b) => b.original.length - a.original.length);
    const applied = [];
    let out = text;
    for (const d of distinct) {
      const before = out;
      out = out.replace(new RegExp(escapeRe(d.original), 'g'), d.token);
      if (out !== before) applied.push({ token: d.token, original: d.original });
    }
    return { text: out, vault, applied };
  }

  /**
   * Swap tokens in `text` back to their original values (inbound primitive).
   * Unknown tokens are left untouched. Tokens are replaced longest-first so one
   * token string can't be a prefix of another (e.g. [[EMAIL_1]] vs [[EMAIL_10]]).
   *
   * @param {string} text
   * @param {object} vault
   * @returns {string}
   */
  function restore(text, vault) {
    if (!text || !vault || !Array.isArray(vault.order) || vault.order.length === 0) {
      return text || '';
    }
    let out = text;
    const tokens = vault.order.slice().sort((a, b) => b.length - a.length);
    for (const t of tokens) {
      const original = vault.byToken[t];
      if (original == null) continue;
      out = out.split(t).join(original);
    }
    return out;
  }

  const api = { createVault, tokenize, restore, labelFor };
  if (typeof globalThis !== 'undefined') globalThis.LLSS_tokenVault = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
