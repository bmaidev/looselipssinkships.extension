// lib/redaction-engine.js — Orchestrator that routes text through the
// appropriate redaction engine(s) based on user settings.
//
// Fallback chain: AI → Regex → Vector (name detection)
// In "auto" mode, tries AI first; if unavailable, falls back to regex + vector.

/**
 * Build a dynamic system prompt that includes all enabled PII types.
 * This ensures the AI model knows about custom user-defined PII categories.
 *
 * @param {Array} piiTypes - Merged PII type definitions.
 * @returns {string}
 */
function buildSystemPrompt(piiTypes) {
  const enabledTypes = piiTypes.filter((t) => t.enabled);
  const typeLines = enabledTypes
    .map((t) => `- ${t.name} → ${t.token}`)
    .join("\n");

  return `You are a strict data compliance assistant for an Australian government agency.
Your ONLY job is to redact Personally Identifiable Information (PII) from the provided text.

Replace the following categories with their bracketed tokens:
${typeLines}

Rules:
1. Return ONLY the redacted text. Do not add explanations, commentary, or formatting.
2. Preserve the original structure, punctuation, and line breaks exactly.
3. If the text contains no PII, return it unchanged.
4. When in doubt, redact. False positives are acceptable; false negatives are not.`;
}

/**
 * Redact text using the browser's built-in LanguageModel API.
 *
 * @param {string} text - Input text.
 * @param {object} sessionManager - Object with getSession() method.
 * @returns {Promise<{ redacted: string, engine: string }>}
 */
async function redactWithAi(text, sessionManager) {
  const session = await sessionManager.getSession();
  const prompt = `Redact all PII from the following text:\n\n${text}`;
  const redacted = await session.prompt(prompt);
  return { redacted, engine: "ai", matches: [] };
}

/**
 * Redact text using the regex engine, optionally followed by vector name detection.
 *
 * @param {string} text - Input text.
 * @param {Array} piiTypes - Merged PII type definitions.
 * @param {object} settings - User settings.
 * @returns {{ redacted: string, engine: string, matches: Array }}
 */
function redactWithFallback(text, piiTypes, settings) {
  // Step 1: Regex redaction.
  const regexResult = LLSS_regexRedact(text, piiTypes);
  let { redacted } = regexResult;
  let allMatches = [...regexResult.matches];

  // Step 2: Vector name detection on the already-regex-redacted text.
  if (settings.enableVectorFallback) {
    const nameToken =
      piiTypes.find((t) => t.id === "name_vector")?.token || "[REDACTED_NAME]";
    const vectorResult = LLSS_vectorRedact(
      redacted,
      nameToken,
      settings.vectorThreshold
    );
    redacted = vectorResult.redacted;
    allMatches = allMatches.concat(vectorResult.matches);
  }

  return {
    redacted,
    engine: settings.enableVectorFallback ? "regex+vector" : "regex",
    matches: allMatches,
  };
}

/**
 * Main redaction entry point. Routes to the appropriate engine(s) based on settings.
 *
 * @param {string} text - Input text.
 * @param {object} options
 * @param {Array} options.piiTypes - Merged PII type definitions.
 * @param {object} options.settings - User settings.
 * @param {object} options.sessionManager - AI session manager.
 * @param {boolean} options.aiAvailable - Whether the AI model is available.
 * @returns {Promise<{ redacted: string, engine: string, matches: Array }>}
 */
async function redact(text, options) {
  const { piiTypes, settings, sessionManager, aiAvailable } = options;
  const mode = settings.detectionMode || "auto";

  // AI-only mode.
  if (mode === "ai_only") {
    if (!aiAvailable) {
      throw new Error(
        "AI model is not available and detection mode is set to AI-only."
      );
    }
    return redactWithAi(text, sessionManager);
  }

  // Regex-only mode.
  if (mode === "regex_only") {
    return redactWithFallback(text, piiTypes, settings);
  }

  // Auto mode: try AI first, fall back to regex+vector.
  if (aiAvailable) {
    try {
      const result = await redactWithAi(text, sessionManager);

      // Belt-and-suspenders: also run regex after AI if configured.
      if (settings.regexAfterAi) {
        const regexResult = LLSS_regexRedact(result.redacted, piiTypes);
        return {
          redacted: regexResult.redacted,
          engine: "ai+regex",
          matches: regexResult.matches,
        };
      }

      return result;
    } catch (err) {
      console.warn("[LLSS] AI redaction failed, falling back to regex:", err.message);
      // Fall through to regex.
    }
  }

  return redactWithFallback(text, piiTypes, settings);
}

if (typeof globalThis !== "undefined") {
  globalThis.LLSS_redact = redact;
  globalThis.LLSS_buildSystemPrompt = buildSystemPrompt;
  globalThis.LLSS_redactWithFallback = redactWithFallback;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { redact, buildSystemPrompt, redactWithFallback };
}
