/**
 * AI Entity Parser — shared utilities for structured PII entity detection.
 *
 * Instead of asking LLMs to "redact the text," we ask them to "identify PII
 * entities with positions." The extension then does the replacement locally
 * with full control over the output.
 *
 * Used by: nano-session.js, local-ai-provider.js, hosted-model-provider.js
 *
 * Exports:
 *   buildEntitySchema()           → JSON Schema for responseConstraint / response_format
 *   buildEntitySystemPrompt(piiTypes) → system prompt requesting JSON entity output
 *   parseEntityResponse(json, text, piiTypes) → { matches, valid, error? }
 *   applyEntityMatches(text, matches) → { redacted, matches }
 *   chunkTextForAi(text, maxChars) → [{ chunk, offset }]
 */

(function () {
  'use strict';

  // ── JSON Schema ───────────────────────────────────────────────────────────

  /**
   * Compact JSON Schema for structured PII entity output.
   * ~250 bytes — fits within Nano's context window.
   */
  function buildEntitySchema() {
    return {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              type: { type: 'string' },
              start: { type: 'integer' },
              end: { type: 'integer' },
            },
            required: ['text', 'type', 'start', 'end'],
          },
        },
      },
      required: ['entities'],
    };
  }

  // ── System Prompt ─────────────────────────────────────────────────────────

  /**
   * Build a system prompt that asks the LLM to identify PII entities
   * with exact positions, NOT to redact the text.
   */
  function buildEntitySystemPrompt(piiTypes) {
    const types = (piiTypes || [])
      .filter(t => t.enabled)
      .map(t => `- ${t.name}`)
      .join('\n');

    return `You are a PII entity detector. Analyse the text and identify all personally identifiable information.

Respond with JSON only. The JSON must have an "entities" array. Each entity object has:
- "text": the exact PII string as it appears in the input
- "type": the PII category name from the list below
- "start": 0-based character index where the PII begins
- "end": character index after the last character of the PII

PII CATEGORIES TO DETECT:
${types}

RULES:
- Report only entities that exist verbatim in the input text.
- "start" and "end" must be exact 0-based character positions.
- input.substring(start, end) must equal "text" exactly.
- When uncertain whether something is PII, err on the side of reporting it.
- If no PII is found, return {"entities":[]}.
- Do NOT redact, modify, or return the input text. Only return the JSON.
- Do NOT include explanations, preamble, or anything outside the JSON object.`;
  }

  // ── Response Parsing ──────────────────────────────────────────────────────

  /**
   * Parse an LLM JSON response into the standard match format.
   * Includes position correction for when the LLM gets offsets wrong.
   *
   * @param {string} jsonStr - Raw JSON string from LLM
   * @param {string} inputText - Original input text (for validation)
   * @param {Array} piiTypes - PII type definitions (for type→token mapping)
   * @returns {{ matches: Array, valid: boolean, error?: string }}
   */
  function parseEntityResponse(jsonStr, inputText, piiTypes) {
    if (typeof jsonStr !== 'string' || jsonStr.length > 2_000_000 || typeof inputText !== 'string') {
      return { matches: [], valid: false, error: 'Model response exceeds limits or has an invalid input type' };
    }
    // Step 1: Parse JSON
    let parsed;
    try {
      // Handle cases where LLM wraps JSON in markdown code blocks
      let cleaned = jsonStr.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch (err) {
      // Native parse errors can quote sensitive model output. Never relay it.
      return { matches: [], valid: false, error: 'JSON parse failed' };
    }

    // Step 2: Validate structure
    const entities = parsed?.entities;
    if (!Array.isArray(entities)) {
      return { matches: [], valid: false, error: 'Response missing "entities" array' };
    }
    if (entities.length > 10_000) {
      return { matches: [], valid: false, error: 'Model entity count exceeds safety limits' };
    }

    if (entities.length === 0) {
      return { matches: [], valid: true };
    }

    // Step 3: Build type→token lookup from piiTypes
    const typeMap = buildTypeMap(piiTypes);

    // Step 4: Validate and correct each entity
    const matches = [];
    let invalidEntityCount = 0;
    for (const entity of entities) {
      if (!entity || typeof entity.text !== 'string' || !entity.text.length ||
          typeof entity.type !== 'string' || !entity.type.trim() ||
          !Number.isSafeInteger(entity.start) || !Number.isSafeInteger(entity.end) ||
          entity.start < 0 || entity.end <= entity.start) {
        invalidEntityCount++;
        continue;
      }

      // Try to find the correct position
      let actualStart = entity.start;
      let actualEnd = entity.end;
      const claimed = inputText.substring(entity.start, entity.end);

      if (claimed !== entity.text) {
        // Position correction: search for the text in the input
        const corrected = correctPosition(entity.text, entity.start, inputText);
        if (corrected === null) {
          // Text not found in input — discard this entity
          const dbg = (typeof globalThis !== 'undefined' && globalThis.LLSS_debug) || null;
          if (dbg) dbg.warn('entity-parser', 'Model-reported entity was not found in input; discarding');
          invalidEntityCount++;
          continue;
        }
        actualStart = corrected;
        actualEnd = corrected + entity.text.length;
      }

      // Map type name to typeId and token
      const mapped = mapEntityType(entity.type, typeMap);

      matches.push({
        typeId: mapped.typeId,
        token: mapped.token,
        original: entity.text,
        index: actualStart,
      });
    }

    // Preserve locatable matches for diagnostics, but never call partial parsing
    // a successful inspection (especially when every entity was discarded).
    return invalidEntityCount
      ? { matches, valid: false, invalidEntityCount, error: 'Model response contains invalid or unlocatable entities' }
      : { matches, valid: true };
  }

  /**
   * Search for entity text in the input, returning the best position.
   * Handles LLMs that get character offsets wrong.
   */
  function correctPosition(entityText, claimedStart, inputText) {
    const firstIdx = inputText.indexOf(entityText);
    if (firstIdx === -1) return null;

    // If there's only one occurrence, use it
    const secondIdx = inputText.indexOf(entityText, firstIdx + 1);
    if (secondIdx === -1) return firstIdx;

    // Multiple occurrences — find the one closest to the claimed position
    let bestIdx = firstIdx;
    let bestDist = Math.abs(firstIdx - claimedStart);
    let searchFrom = secondIdx;

    while (searchFrom !== -1 && searchFrom < inputText.length) {
      const dist = Math.abs(searchFrom - claimedStart);
      if (dist < bestDist) {
        bestIdx = searchFrom;
        bestDist = dist;
      }
      searchFrom = inputText.indexOf(entityText, searchFrom + 1);
    }

    return bestIdx;
  }

  /**
   * Build a lookup map from PII type names to { typeId, token }.
   */
  function buildTypeMap(piiTypes) {
    const map = Object.create(null);
    for (const t of (piiTypes || [])) {
      if (!t.enabled) continue;
      // Normalize the name for fuzzy matching
      const key = t.name.toLowerCase().trim();
      map[key] = { typeId: t.id, token: t.token };
      // Also add without parenthetical (e.g., "Phone Number" matches "Phone Number (AU)")
      const noParens = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (noParens !== key) map[noParens] = { typeId: t.id, token: t.token };
    }
    return map;
  }

  /**
   * Map an entity type name from the LLM to a typeId and redaction token.
   */
  function mapEntityType(typeName, typeMap) {
    if (typeof typeName !== 'string' || !typeName) return { typeId: 'ai_detected', token: '[REDACTED_PII]' };

    const key = typeName.toLowerCase().trim();

    // Exact match
    if (Object.hasOwn(typeMap, key)) return typeMap[key];

    // Partial match — check if any key is contained in the type name or vice versa
    for (const [mapKey, mapped] of Object.entries(typeMap)) {
      if (key.includes(mapKey) || mapKey.includes(key)) return mapped;
    }

    // Fallback: generate token from the type name
    const cleanName = typeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    return { typeId: `ai_${cleanName.toLowerCase()}`, token: `[REDACTED_${cleanName}]` };
  }

  // ── Text Replacement ──────────────────────────────────────────────────────

  /**
   * Apply entity matches to text, producing the redacted output.
   * Replaces right-to-left to preserve earlier indices.
   *
   * @param {string} text - Original text
   * @param {Array} matches - Matches with { index, original, token }
   * @returns {{ redacted: string, matches: Array }}
   */
  function applyEntityMatches(text, matches) {
    if (!matches || matches.length === 0) return { redacted: text, matches: [] };

    const spans = globalThis.LLSS_RedactionSpans || (typeof require !== 'undefined' ? require('./redaction-spans') : null);
    return spans.applyMatches(text, matches);
  }

  /**
   * Merge overlapping matches without dropping detected characters.
   * The original text is mandatory to preserve exact source coordinates.
   */
  function deduplicateMatches(matches, text) {
    const spans = globalThis.LLSS_RedactionSpans || (typeof require !== 'undefined' ? require('./redaction-spans') : null);
    return spans.mergeMatches(text, matches);
  }

  // ── Text Chunking ─────────────────────────────────────────────────────────

  /**
   * Split text into chunks for AI processing.
   * Splits at sentence boundaries to keep context.
   *
   * @param {string} text - Input text
   * @param {number} [maxChars=2000] - Max characters per chunk
   * @returns {Array<{ chunk: string, offset: number }>}
   */
  function chunkTextForAi(text, maxChars = 2000) {
    if (!text || text.length <= maxChars) {
      return [{ chunk: text, offset: 0 }];
    }

    const chunks = [];
    let pos = 0;

    while (pos < text.length) {
      let end = Math.min(pos + maxChars, text.length);

      // If not at the end, find a sentence boundary to split at
      if (end < text.length) {
        // Look backwards for a sentence boundary
        const searchRegion = text.substring(pos, end);
        const lastPeriod = searchRegion.lastIndexOf('. ');
        const lastNewline = searchRegion.lastIndexOf('\n');
        const splitAt = Math.max(lastPeriod, lastNewline);

        if (splitAt > maxChars * 0.3) {
          // Found a reasonable split point
          end = pos + splitAt + 1; // Include the period/newline
        }
      }

      chunks.push({ chunk: text.substring(pos, end), offset: pos });
      pos = end;
    }

    return chunks;
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  const exports = {
    buildEntitySchema,
    buildEntitySystemPrompt,
    parseEntityResponse,
    applyEntityMatches,
    chunkTextForAi,
    correctPosition,
    mapEntityType,
    buildTypeMap,
    deduplicateMatches,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_buildEntitySchema = buildEntitySchema;
    globalThis.LLSS_buildEntitySystemPrompt = buildEntitySystemPrompt;
    globalThis.LLSS_parseEntityResponse = parseEntityResponse;
    globalThis.LLSS_applyEntityMatches = applyEntityMatches;
    globalThis.LLSS_chunkTextForAi = chunkTextForAi;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
