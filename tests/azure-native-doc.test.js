const {
  uploadToBlob,
  downloadBlob,
} = require('../lib/azure-native-doc');

const FUTURE = '2099-01-01T00%3A00%3A00Z';
const SOURCE_SAS = `?sp=rw&spr=https&se=${FUTURE}&sig=source-signature`;
const TARGET_SAS = `?sp=rw&spr=https&se=${FUTURE}&sig=target-signature`;

afterEach(() => {
  jest.restoreAllMocks();
  delete global.LLSS_AzureAuth;
});

describe('Azure native document storage boundaries', () => {
  test('direct mode requires a valid HTTPS-only, expiring read/write SAS', async () => {
    await expect(uploadToBlob(
      'https://account.blob.core.windows.net/source',
      'doc.pdf',
      new Uint8Array([1]),
      'application/pdf',
      { connectionMode: 'direct' },
    )).rejects.toThrow(/require an unexpired HTTPS-only SAS/i);

    await expect(uploadToBlob(
      `https://account.blob.core.windows.net/source?sp=r&spr=https&se=${FUTURE}&sig=x`,
      'doc.pdf',
      new Uint8Array([1]),
      'application/pdf',
      { connectionMode: 'direct' },
    )).rejects.toThrow(/read and write permissions/i);
  });

  test('enterprise mode rejects SAS-bearing container URLs', async () => {
    await expect(uploadToBlob(
      `https://account.blob.core.windows.net/source${SOURCE_SAS}`,
      'doc.pdf',
      new Uint8Array([1]),
      'application/pdf',
      { connectionMode: 'enterprise' },
    )).rejects.toThrow(/must not contain SAS credentials/i);
  });

  test('enterprise mode does not fall back when a storage token is unavailable', async () => {
    global.LLSS_AzureAuth = { getAccessToken: jest.fn().mockResolvedValue(null) };
    await expect(uploadToBlob(
      'https://account.blob.core.windows.net/source',
      'doc.pdf',
      new Uint8Array([1]),
      'application/pdf',
      { connectionMode: 'enterprise', tenantId: 'tenant', clientId: 'client' },
    )).rejects.toThrow(/not signed in to Azure Blob Storage/i);
  });

  test('downloads ignore query credentials returned by the job', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      new Uint8Array([1, 2, 3]),
      { status: 200, headers: { 'Content-Type': 'application/pdf' } },
    ));
    const configured = `https://account.blob.core.windows.net/target${TARGET_SAS}`;

    const result = await downloadBlob(
      'https://account.blob.core.windows.net/target/redacted.pdf?sp=r&sig=untrusted',
      { connectionMode: 'direct' },
      TARGET_SAS,
      configured,
    );

    expect(result.data.byteLength).toBe(3);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://account.blob.core.windows.net/target/redacted.pdf${TARGET_SAS}`,
      expect.objectContaining({ redirect: 'error', credentials: 'omit' }),
    );
  });

  test('rejects result paths outside the configured container', async () => {
    await expect(downloadBlob(
      'https://account.blob.core.windows.net/other/redacted.pdf',
      { connectionMode: 'direct' },
      TARGET_SAS,
      `https://account.blob.core.windows.net/target${TARGET_SAS}`,
    )).rejects.toThrow(/outside the configured storage container/i);
  });
});
