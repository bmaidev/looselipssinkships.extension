const { isTrustedExtensionSender } = require('../lib/message-security');

const runtime = {
  id: 'abcdefghijklmnop',
  getURL: (path = '') => `chrome-extension://abcdefghijklmnop/${path}`,
};

describe('privileged extension message sender validation', () => {
  test('accepts an extension options page opened in a browser tab', () => {
    expect(isTrustedExtensionSender({
      id: runtime.id,
      url: runtime.getURL('options.html'),
      tab: { id: 42, url: runtime.getURL('options.html') },
    }, runtime)).toBe(true);
  });

  test('accepts popup and offscreen extension contexts', () => {
    expect(isTrustedExtensionSender({ id: runtime.id, url: runtime.getURL('popup.html') }, runtime)).toBe(true);
    expect(isTrustedExtensionSender({ id: runtime.id, url: runtime.getURL('offscreen.html') }, runtime)).toBe(true);
  });

  test('rejects content scripts even when the extension ID matches', () => {
    expect(isTrustedExtensionSender({
      id: runtime.id,
      url: 'https://example.com/account',
      tab: { id: 7, url: 'https://example.com/account' },
    }, runtime)).toBe(false);
  });

  test('rejects missing, foreign and lookalike sender URLs', () => {
    expect(isTrustedExtensionSender({ id: runtime.id }, runtime)).toBe(false);
    expect(isTrustedExtensionSender({ id: 'foreign', url: runtime.getURL('options.html') }, runtime)).toBe(false);
    expect(isTrustedExtensionSender({
      id: runtime.id,
      url: 'chrome-extension://abcdefghijklmnop.evil/options.html',
    }, runtime)).toBe(false);
  });
});
