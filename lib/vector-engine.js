// lib/vector-engine.js — Lightweight name/entity detection using character n-grams.
// No external dependencies. Used as an additional fallback for detecting person
// names that regex alone cannot catch (e.g., "John Smith" without keyword context).
//
// Strategy: builds character trigram profiles of common name patterns and compares
// against word sequences in the input text. This is NOT a full NER system — it's
// a practical heuristic that catches common Western and Australian naming patterns.

// Heuristic signals that a word sequence might be a person's name.
const NAME_INDICATORS = {
  // Words that commonly precede a name.
  prefixes: new Set([
    "mr", "mrs", "ms", "miss", "dr", "prof", "professor", "sir", "dame",
    "rev", "reverend", "hon", "honourable", "judge", "justice",
    "dear", "hi", "hello", "hey", "regards", "sincerely", "from", "to",
    "by", "author", "signed", "attn", "attention", "contact", "name",
    "patient", "client", "applicant", "employee", "staff", "officer",
    "minister", "secretary", "director", "manager",
  ]),
  // Common Australian/English first names (top 200 — used as a signal, not exhaustive).
  commonFirstNames: new Set([
    "james", "john", "robert", "michael", "david", "william", "richard",
    "joseph", "thomas", "charles", "christopher", "daniel", "matthew",
    "anthony", "mark", "donald", "steven", "paul", "andrew", "joshua",
    "kenneth", "kevin", "brian", "george", "timothy", "ronald", "edward",
    "jason", "jeffrey", "ryan", "jacob", "gary", "nicholas", "eric",
    "jonathan", "stephen", "larry", "justin", "scott", "brandon", "benjamin",
    "samuel", "raymond", "gregory", "frank", "alexander", "patrick",
    "jack", "dennis", "jerry", "tyler", "aaron", "jose", "adam", "nathan",
    "peter", "henry", "douglas", "zachary", "carl", "kyle", "noah",
    "mary", "patricia", "jennifer", "linda", "barbara", "elizabeth",
    "susan", "jessica", "sarah", "karen", "lisa", "nancy", "betty",
    "margaret", "sandra", "ashley", "dorothy", "kimberly", "emily",
    "donna", "michelle", "carol", "amanda", "melissa", "deborah",
    "stephanie", "rebecca", "sharon", "laura", "cynthia", "kathleen",
    "amy", "angela", "shirley", "anna", "brenda", "pamela", "emma",
    "nicole", "helen", "samantha", "katherine", "christine", "debra",
    "rachel", "carolyn", "janet", "catherine", "maria", "heather",
    "diane", "ruth", "julie", "olivia", "joyce", "virginia", "victoria",
    "kelly", "lauren", "christina", "joan", "evelyn", "judith", "megan",
    "andrea", "cheryl", "hannah", "jacqueline", "martha", "gloria",
    "teresa", "ann", "sara", "madison", "frances", "kathryn", "janice",
    "jean", "abigail", "alice", "judy", "sophia", "grace", "denise",
    "amber", "doris", "marilyn", "danielle", "beverly", "isabella",
    "theresa", "diana", "natalie", "brittany", "charlotte", "marie",
    "kayla", "alexis", "lori",
  ]),
};
const MAX_VECTOR_MATCHES = 10_000;

/**
 * Check whether a word looks like it could be a capitalised proper noun.
 * Simple heuristic: starts with uppercase, rest is lowercase, length > 1.
 */
function isCapitalised(word) {
  if (word.length < 2) return false;
  return /^[A-Z][a-z]+$/.test(word);
}

/**
 * Generate character trigrams from a string.
 * @param {string} str
 * @returns {Set<string>}
 */
function trigrams(str) {
  const s = str.toLowerCase();
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * Jaccard similarity between two trigram sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0..1
 */
function trigramSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Score a candidate word sequence (1-3 words) for how likely it is a person's name.
 * Returns a confidence score between 0 and 1.
 *
 * @param {string[]} words - The candidate words.
 * @param {string} precedingWord - The word before the candidate (lowercase).
 * @returns {number}
 */
function scoreNameCandidate(words, precedingWord) {
  let score = 0;

  // All words must be capitalised.
  if (!words.every(isCapitalised)) return 0;

  // Bonus: preceded by a name indicator.
  if (precedingWord && NAME_INDICATORS.prefixes.has(precedingWord.toLowerCase())) {
    score += 0.4;
  }

  // Bonus: first word is a known first name.
  if (NAME_INDICATORS.commonFirstNames.has(words[0].toLowerCase())) {
    score += 0.35;
  }

  // Bonus: exactly 2-3 words (typical full name).
  if (words.length >= 2 && words.length <= 3) {
    score += 0.15;
  }

  // Bonus: second word looks like a surname (capitalised, > 2 chars).
  if (words.length >= 2 && words[1].length > 2) {
    score += 0.1;
  }

  // Penalty: single word that's very short.
  if (words.length === 1 && words[0].length <= 3) {
    score -= 0.3;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Detect potential person names in text using heuristic scoring.
 *
 * @param {string} text - Input text.
 * @param {number} [threshold=0.45] - Minimum confidence score (0..1).
 * @returns {Array<{ text: string, start: number, end: number, confidence: number }>}
 */
function detectNames(text, threshold) {
  if (threshold === undefined) threshold = 0.45;
  if (!text) return [];

  const results = [];
  // Split into tokens preserving their positions.
  const tokenRegex = /[A-Za-z'\-]+/g;
  const tokens = [];
  let m;
  while ((m = tokenRegex.exec(text)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }

  const seen = new Set(); // track start positions we've already captured

  for (let i = 0; i < tokens.length; i++) {
    if (seen.has(i)) continue;

    // Try 3-word, 2-word, then 1-word sequences.
    for (let len = Math.min(3, tokens.length - i); len >= 1; len--) {
      const candidate = tokens.slice(i, i + len);
      const words = candidate.map((t) => t.word);

      // All words must be capitalised.
      if (!words.every(isCapitalised)) continue;

      // Ensure tokens are adjacent (no big gaps — allow up to 2 chars for spaces/hyphens).
      let adjacent = true;
      for (let j = 1; j < candidate.length; j++) {
        if (candidate[j].start - candidate[j - 1].end > 2) {
          adjacent = false;
          break;
        }
      }
      if (!adjacent) continue;

      const preceding = i > 0 ? tokens[i - 1].word : "";
      const confidence = scoreNameCandidate(words, preceding);

      if (confidence >= threshold) {
        const start = candidate[0].start;
        const end = candidate[candidate.length - 1].end;
        results.push({
          text: text.slice(start, end),
          start,
          end,
          confidence,
        });
        if (results.length > MAX_VECTOR_MATCHES) {
          throw new Error(`Name match count exceeds the ${MAX_VECTOR_MATCHES.toLocaleString()}-match safety limit`);
        }
        for (let j = i; j < i + len; j++) seen.add(j);
        break; // don't try shorter sequences
      }
    }
  }

  return results;
}

/**
 * Redact detected names from text.
 *
 * @param {string} text - Input text.
 * @param {string} [token="[REDACTED_NAME]"] - Replacement token.
 * @param {number} [threshold=0.45] - Detection threshold.
 * @returns {{ redacted: string, matches: Array }}
 */
function vectorRedact(text, token, threshold) {
  if (token === undefined) token = "[REDACTED_NAME]";
  if (threshold === undefined) threshold = 0.45;

  const detected = detectNames(text, threshold);
  if (detected.length === 0) return { redacted: text, matches: [] };

  let redacted = text;
  const matches = [];

  // Replace from end to preserve indices.
  for (let i = detected.length - 1; i >= 0; i--) {
    const d = detected[i];
    redacted = redacted.slice(0, d.start) + token + redacted.slice(d.end);
    matches.unshift({
      typeId: "name_vector",
      token,
      original: d.text,
      index: d.start,
      confidence: d.confidence,
    });
  }

  return { redacted, matches };
}

if (typeof globalThis !== "undefined") {
  globalThis.LLSS_detectNames = detectNames;
  globalThis.LLSS_vectorRedact = vectorRedact;
  globalThis.LLSS_scoreNameCandidate = scoreNameCandidate;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectNames,
    vectorRedact,
    scoreNameCandidate,
    isCapitalised,
    trigrams,
    trigramSimilarity,
    NAME_INDICATORS,
  };
}
