/**
 * Security checks for messages that are restricted to extension-owned pages.
 *
 * Extension pages opened in a normal tab (including options.html) legitimately
 * include sender.tab. Content scripts also use the extension ID, so the sender
 * URL—not the presence or absence of a tab—is the security boundary.
 */
(function () {
  'use strict';

  function isTrustedExtensionSender(sender, runtime) {
    if (!runtime || sender?.id !== runtime.id || typeof sender.url !== 'string') {
      return false;
    }
    return sender.url.startsWith(runtime.getURL(''));
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.LLSS_isTrustedExtensionSender = isTrustedExtensionSender;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isTrustedExtensionSender };
  }
})();
