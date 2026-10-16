const {
  getLanguageModel,
  hasLanguageModel,
  normaliseAvailability,
  checkTextAvailability,
  createTextSession,
  detectBrowser,
  providerName,
} = require('../lib/browser-ai');

describe('browser built-in AI compatibility', () => {
  test('reports an absent API without throwing', async () => {
    expect(getLanguageModel({})).toBeNull();
    expect(hasLanguageModel({})).toBe(false);
    await expect(checkTextAvailability({})).resolves.toMatchObject({
      available: false,
      status: 'unavailable',
    });
  });

  test.each([
    ['available', true],
    ['downloadable', true],
    ['readily', true],
    ['after-download', true],
    ['downloading', false],
    ['unavailable', false],
  ])('normalises the %s availability state', (status, available) => {
    expect(normaliseAvailability(status).available).toBe(available);
  });

  test('uses the portable no-argument availability call', async () => {
    const availability = jest.fn(async () => 'available');
    const create = jest.fn();
    const result = await checkTextAvailability({ LanguageModel: { availability, create } });

    expect(result).toMatchObject({ available: true, status: 'available' });
    expect(availability).toHaveBeenCalledTimes(1);
    expect(availability).toHaveBeenCalledWith();
  });

  test('returns capability errors as unavailable details', async () => {
    const scope = {
      LanguageModel: {
        availability: jest.fn(async () => { throw new Error('model disabled'); }),
        create: jest.fn(),
      },
    };
    await expect(checkTextAvailability(scope)).resolves.toMatchObject({
      available: false,
      status: 'unavailable',
      detail: 'model disabled',
    });
  });

  test('creates sessions without browser-specific modality declarations', async () => {
    const session = { prompt: jest.fn(), destroy: jest.fn() };
    const create = jest.fn(async (options) => ({ ...session, options }));
    const scope = { LanguageModel: { availability: jest.fn(), create } };
    const initialPrompts = [{ role: 'system', content: 'Redact PII.' }];

    const result = await createTextSession({ initialPrompts }, scope);

    expect(result.options).toEqual({ initialPrompts });
    expect(result.options).not.toHaveProperty('expectedInputs');
    expect(result.options).not.toHaveProperty('expectedOutputs');
  });

  test('recognises Edge from both client hints and its user agent token', () => {
    expect(detectBrowser({ userAgentData: { brands: [{ brand: 'Microsoft Edge' }] } })).toBe('edge');
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 Edg/150.0.0.0' })).toBe('edge');
    expect(providerName({ userAgent: 'Mozilla/5.0 Edg/150.0.0.0' }))
      .toBe('Microsoft Edge On-Device AI (Local)');
  });

  test('recognises Chrome without misclassifying generic user agents', () => {
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36' })).toBe('chrome');
    expect(detectBrowser({ userAgent: 'Mozilla/5.0 Firefox/142.0' })).toBe('unknown');
  });
});
