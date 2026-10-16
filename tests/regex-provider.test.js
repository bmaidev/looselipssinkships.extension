const { RegexProvider } = require('../lib/providers/regex-provider');

describe('RegexProvider coordinate safety', () => {
  test('keeps vector matches aligned to the original text after regex matches', async () => {
    const provider = new RegexProvider();
    const text = 'Email john@example.com belongs to John Smith';
    const piiTypes = [{
      id: 'email',
      enabled: true,
      regex: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
      flags: 'gi',
      token: '[REDACTED_EMAIL]',
      priority: 100,
    }];

    const result = await provider.redactText(text, piiTypes, {
      enableVectorFallback: true,
      vectorThreshold: 0.45,
    });

    const nameMatch = result.matches.find((match) => match.typeId === 'name_vector');
    expect(nameMatch.original).toBe('John Smith');
    expect(nameMatch.index).toBe(text.indexOf('John Smith'));
    expect(result.redacted).not.toContain('john@example.com');
    expect(result.redacted).not.toContain('John Smith');
  });
});
