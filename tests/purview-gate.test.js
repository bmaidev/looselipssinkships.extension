const { parseMsipFromXml, evaluateGate } = require('../lib/purview-gate');

const LABEL_ID = '11111111-2222-3333-8444-555555555555';

function labelXml(name = 'SECRET', contentBits = 0) {
  return `<?xml version="1.0"?>
    <Properties>
      <property name="MSIP_Label_${LABEL_ID}_Enabled"><vt:lpwstr>true</vt:lpwstr></property>
      <property name="MSIP_Label_${LABEL_ID}_Name"><vt:lpwstr>${name}</vt:lpwstr></property>
      <property name="MSIP_Label_${LABEL_ID}_ContentBits"><vt:i4>${contentBits}</vt:i4></property>
    </Properties>`;
}

function installZip(xml) {
  global.LLSS_parseZipEntries = jest.fn().mockResolvedValue([{
    name: 'docProps/custom.xml',
    data: new TextEncoder().encode(xml),
  }]);
}

afterEach(() => {
  delete global.LLSS_parseZipEntries;
  delete global.LLSS_debug;
});

describe('Microsoft sensitivity-label gate', () => {
  test('parses enabled embedded MSIP labels', () => {
    expect(parseMsipFromXml(labelXml('PROTECTED', 8))).toEqual([
      expect.objectContaining({
        labelId: LABEL_ID,
        labelName: 'PROTECTED',
        enabled: true,
        contentBits: 8,
      }),
    ]);
  });

  test('blocks configured labels before upload', async () => {
    installZip(labelXml('TOP SECRET'));
    const result = await evaluateGate(new ArrayBuffer(0), 'report.docx', '', 'docx', {
      gateEnabled: true,
      blockedLabels: ['SECRET'],
      blockEncrypted: true,
    });
    expect(result).toEqual(expect.objectContaining({ allowed: false, severity: 'blocked', label: 'TOP SECRET' }));
  });

  test('blocks embedded encryption markers', async () => {
    installZip(labelXml('INTERNAL', 8));
    const result = await evaluateGate(new ArrayBuffer(0), 'report.docx', '', 'docx', {
      gateEnabled: true,
      blockedLabels: [],
      blockEncrypted: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/encrypted\/protected/i);
  });

  test('warns without blocking configured warning labels', async () => {
    installZip(labelXml('OFFICIAL: Sensitive'));
    const result = await evaluateGate(new ArrayBuffer(0), 'report.docx', '', 'docx', {
      gateEnabled: true,
      warnLabels: ['official: sensitive'],
    });
    expect(result).toEqual(expect.objectContaining({ allowed: true, severity: 'warned' }));
  });

  test('fails closed for retired remote API policies', async () => {
    await expect(evaluateGate(new ArrayBuffer(0), 'report.docx', '', 'docx', {
      gateEnabled: true,
      checkViaApi: true,
    })).rejects.toThrow(/unsupported/i);
  });
});
