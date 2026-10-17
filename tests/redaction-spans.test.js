const { mergeMatches, applyMatches, MAX_MATCHES } = require('../lib/redaction-spans');
const { regexRedact } = require('../lib/regex-engine');
const { applyEntityMatches } = require('../lib/ai-entity-parser');
const { ProviderRegistry } = require('../lib/providers/provider-registry');
const { RegexProvider } = require('../lib/providers/regex-provider');
const { redactText } = require('../lib/pipeline');

function match(text, start, end, typeId = 'test') {
  return { index: start, original: text.slice(start, end), token: '[MASK]', typeId };
}

describe('Original-text span union', () => {
  test('unions crossing and chained detections without exposing their suffixes', () => {
    const text = 'abcdefghijk rest';
    const result = applyMatches(text, [match(text, 0, 4), match(text, 3, 8), match(text, 7, 11)]);
    expect(result.redacted).toBe('[MASK] rest');
    expect(result.matches).toEqual([match(text, 0, 11)]);
  });

  test('preserves containing types, adjacent matches, gaps and original Unicode offsets', () => {
    const text = '🔒Jane Smith@example.test;Z';
    const input = [match(text, 2, 6, 'name'), match(text, 2, 25, 'email'), match(text, 26, 27)];
    const before = JSON.stringify(input);
    const result = applyMatches(text, input);
    expect(result.matches[0].typeId).toBe('email');
    expect(result.redacted).toBe('🔒[MASK];[MASK]');
    expect(JSON.stringify(input)).toBe(before);
    expect(mergeMatches('abcd', [match('abcd', 0, 2), match('abcd', 2, 4)])).toHaveLength(2);
  });

  test('labels genuinely mixed crossing spans honestly instead of inventing a type', () => {
    const text = 'John Smith@example.test';
    const result = applyMatches(text, [match(text, 0, 10, 'name'), match(text, 5, text.length, 'email')]);
    expect(result.redacted).toBe('[REDACTED]');
    expect(result.matches[0]).toMatchObject({ index: 0, original: text, typeId: 'combined' });
  });

  test.each([-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects unsafe index %s', index => {
    expect(() => applyMatches('abc', [{ index, original: 'a' }])).toThrow();
  });

  test('rejects stale, missing, empty, out-of-range and excessive detections', () => {
    for (const invalid of [null, {}, { index: 0, original: '' }, { index: 0, original: 'wrong' },
      { index: 2, original: 'cd' }]) {
      expect(() => applyMatches('abc', [invalid])).toThrow();
    }
    expect(() => mergeMatches('a', new Array(MAX_MATCHES + 1).fill(match('a', 0, 1)))).toThrow(/limit/);
    expect(applyMatches('unchanged', [])).toEqual({ redacted: 'unchanged', matches: [] });
  });

  test('deterministically preserves exactly the union across 1,000 generated interval sets', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let seed = 20261017;
    const random = maximum => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % maximum;
    };
    for (let run = 0; run < 1000; run++) {
      const input = Array.from({ length: 1 + random(25) }, () => {
        const start = random(text.length);
        return match(text, start, start + 1 + random(text.length - start));
      });
      const mask = spans => Array.from({ length: text.length }, (_, i) =>
        spans.some(m => m.index <= i && i < m.index + m.original.length));
      const actual = mergeMatches(text, input);
      expect(mask(actual)).toEqual(mask(input));
      expect(mergeMatches(text, actual)).toEqual(actual);
      expect(mergeMatches(text, [...input].reverse())).toEqual(actual);
    }
  });

  test('both production rules and structured AI cover crossing detections completely', () => {
    const text = 'John Smith@example.test';
    const rules = [
      { id: 'name', enabled: true, regex: 'John Smith', token: '[NAME]' },
      { id: 'email', enabled: true, regex: 'Smith@example\\.test', token: '[EMAIL]' },
    ];
    expect(regexRedact(text, rules).redacted).toBe('[REDACTED]');
    expect(applyEntityMatches(text, [match(text, 0, 10), match(text, 5, text.length)]).redacted).toBe('[MASK]');
  });

  test('an AI match cannot suppress the deterministic email suffix in the live pipeline', async () => {
    const text = 'John Smith@example.test';
    const registry = new ProviderRegistry();
    registry.register(new RegexProvider());
    registry.register({ id: 'local_ai', tier: 'local', enabled: true,
      checkAvailability: async () => ({ available: true }),
      redactText: async () => ({ redacted: '[MASK]@example.test', engine: 'local_ai',
        matches: [match(text, 0, 10, 'name')] }) });
    const result = await redactText(text, { registry,
      piiTypes: [{ id: 'email', enabled: true, regex: 'Smith@example\\.test', token: '[EMAIL]' }],
      settings: { detectionMode: 'ai_only', enableVectorFallback: false } });
    expect(result.redacted).toBe('[REDACTED]');
    expect(result.matches[0].original).toBe(text);
    expect(result.metadata.unmappableMatchCount).toBe(0);
  });

  test('unlocatable AI output cannot activate a rewrite path that weakens the rule floor', async () => {
    const text = 'John Smith@example.test';
    const registry = new ProviderRegistry();
    registry.register(new RegexProvider());
    registry.register({ id: 'local_ai', tier: 'local', enabled: true,
      checkAvailability: async () => ({ available: true }),
      redactText: async () => ({ redacted: '[MASK]@example.test', engine: 'local_ai',
        matches: [{ index: 999, original: 'John Smith', token: '[MASK]' }] }) });
    await expect(redactText(text, { registry,
      piiTypes: [{ id: 'email', enabled: true, regex: 'Smith@example\\.test', token: '[EMAIL]' }],
      settings: { detectionMode: 'ai_only', enableVectorFallback: false } })).rejects.toThrow(/could not be verified/);
  });
});
