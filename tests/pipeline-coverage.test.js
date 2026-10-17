const { ProviderRegistry } = require('../lib/providers/provider-registry');
const { redactText } = require('../lib/pipeline');

function provider(id, tier, redact) {
  return { id, tier, enabled: true, priority: 10, supports: () => true,
    checkAvailability: jest.fn(async () => ({ available: true })),
    redactText: jest.fn(redact || (async text => ({ engine: id, redacted: text, matches: [] }))) };
}

describe('Text processing coverage is not a safety verdict', () => {
  test.each(['short', 'a'.repeat(1001)])('reports length exclusions rather than a clean contextual scan', async text => {
    const registry = new ProviderRegistry();
    const local = provider('local_ai', 'local');
    registry.register(provider('regex', 'local'));
    registry.register(local);
    const result = await redactText(text, { registry, piiTypes: [], settings: {} });
    expect(result.coverage).toMatchObject({ inputCharacters: text.length, qualityQualified: false,
      rules: { status: 'processed' }, contextual: { status: 'skipped_length' } });
    expect(local.redactText).not.toHaveBeenCalled();
  });

  test('a valid zero-match local response does not send the text to hosted or cloud providers', async () => {
    const registry = new ProviderRegistry();
    const local = provider('local_ai', 'local', async text => ({
      engine: 'local_ai', redacted: text, matches: [], metadata: { structured: true } }));
    const hosted = provider('hosted', 'hosted');
    const cloud = provider('cloud', 'cloud');
    for (const item of [provider('regex', 'local'), local, hosted, cloud]) registry.register(item);
    const result = await redactText('a'.repeat(300), { registry, piiTypes: [], settings: {} });
    expect(result.coverage.contextual).toEqual({ status: 'processed', provider: 'local_ai' });
    expect(result.coverage.qualityQualified).toBe(false);
    for (const remote of [hosted, cloud]) {
      expect(remote.checkAvailability).not.toHaveBeenCalled();
      expect(remote.redactText).not.toHaveBeenCalled();
    }
  });

  test('reports unavailable and failed models distinctly', async () => {
    for (const available of [false, true]) {
      const registry = new ProviderRegistry();
      registry.register(provider('regex', 'local'));
      const local = provider('local_ai', 'local', async () => { throw new Error('provider failure'); });
      local.checkAvailability.mockResolvedValue({ available });
      registry.register(local);
      const result = await redactText('a'.repeat(300), { registry, piiTypes: [], settings: {} });
      expect(result.coverage.contextual.status).toBe(available ? 'failed' : 'unavailable');
      expect(result.coverage.qualityQualified).toBe(false);
    }
  });

  test('a claimed structured response without valid matches remains unverified', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('regex', 'local'));
    registry.register(provider('local_ai', 'local', async text => ({
      engine: 'local_ai', redacted: text, matches: null, metadata: { structured: true } })));
    const result = await redactText('a'.repeat(300), { registry, piiTypes: [], settings: {} });
    expect(result.coverage.contextual.status).toBe('unverified');
  });

  test('rejected cloud output cannot overwrite the original deterministic result', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('regex', 'local'));
    registry.register(provider('cloud', 'cloud', async () => ({ engine: 'cloud', redacted: 'unverified rewrite',
      matches: [{ index: 999, original: 'missing', token: '[MASK]' }] })));
    const result = await redactText('public text', { registry, piiTypes: [], settings: {} });
    expect(result.redacted).toBe('public text');
    expect(result.engine).toBe('regex');
    expect(result.coverage.contextual.status).toBe('failed');
  });

  test('regex-only mode never implies contextual coverage', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('regex', 'local'));
    const result = await redactText('input', { registry, piiTypes: [], settings: { detectionMode: 'regex_only' } });
    expect(result.coverage.contextual.status).toBe('not_requested');
  });

  test('late AI output cannot change the reported timed-out result', async () => {
    jest.useFakeTimers();
    try {
      const registry = new ProviderRegistry();
      registry.register(provider('regex', 'local'));
      let finish;
      registry.register(provider('local_ai', 'local', () => new Promise(resolve => { finish = resolve; })));
      const pending = redactText('a'.repeat(300), { registry, piiTypes: [], settings: {} });
      await jest.advanceTimersByTimeAsync(3001);
      const result = await pending;
      expect(result.coverage.contextual.status).toBe('timeout');
      finish({ engine: 'local_ai', redacted: 'late result', matches: [], metadata: { structured: true } });
      await Promise.resolve();
      expect(result.coverage.contextual.status).toBe('timeout');
      expect(result.redacted).toBe('a'.repeat(300));
    } finally {
      jest.useRealTimers();
    }
  });
});
