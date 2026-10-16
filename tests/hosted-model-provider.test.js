const { HostedModelProvider } = require('../lib/providers/hosted-model-provider');

afterEach(() => jest.restoreAllMocks());

describe('hosted OCR response validation', () => {
  test('keeps multi-page character offsets aligned with joined full text', async () => {
    const payload = {
      pages: [
        { pageNumber: 1, text: 'John', width: 100, height: 100, blocks: [] },
        { pageNumber: 2, text: 'Jane', width: 100, height: 100, blocks: [] },
      ],
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const provider = new HostedModelProvider({
      enabled: true,
      settings: {
        providerId: 'ocr',
        endpoint: 'https://ocr.example.gov.au',
        apiMode: 'ocr_extract',
        apiKey: 'test-key',
        timeout: 1000,
      },
    });

    const result = await provider.extractOcr(new Uint8Array([1]).buffer, 'pdf');
    expect(result.fullText).toBe('John\nJane');
    expect(result.pages.map(({ charStart, charEnd }) => [charStart, charEnd]))
      .toEqual([[0, 4], [5, 9]]);
  });
});
