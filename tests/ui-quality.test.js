const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('user interface quality guardrails', () => {
  test('the document workspace is keyboard and screen-reader operable', () => {
    const html = read('redact.html');
    const source = read('redact.js');

    expect(html).toMatch(/id="drop-zone"[^>]+role="button"[^>]+tabindex="0"/);
    expect(html).toMatch(/id="queue-announcement"[^>]+role="status"[^>]+aria-live="polite"/);
    expect(html).toMatch(/id="dictation-status"[^>]+role="status"[^>]+aria-live="polite"/);
    expect(source).toContain("dropZone.addEventListener('keydown'");
    expect(source).toContain('MAX_FILE_BYTES = 25 * 1024 * 1024');
    expect(source.indexOf('entry.file.size > MAX_FILE_BYTES'))
      .toBeLessThan(source.indexOf('entry.file.arrayBuffer()'));
    expect(source).toContain('if (processing) return;');
  });

  test('settings dialogs manage focus and announce save outcomes', () => {
    const html = read('options.html');
    const source = read('options.js');

    expect(html).toMatch(/class="modal" role="dialog" aria-modal="true"/);
    expect(html).toMatch(/id="save-status"[^>]+role="status"[^>]+aria-live="polite"/);
    expect(html).toMatch(/id="settings-load-error"[^>]+role="alert"/);
    expect(source).toContain('function showModalOverlay');
    expect(source).toContain('function hideModalOverlay');
    expect(source).toContain('if (event.key === "Escape")');
    expect(source).toContain('modalReturnFocus');
    expect(source).toContain('saveButton.disabled = true');
    expect(source).toContain('setSettingsLoadFailure(true)');
  });

  test('in-page controls and result dialogs preserve accessible interaction', () => {
    const source = read('content.js');
    const styles = read('content.css');

    expect(source).toContain('aria-label", "Redact personal information"');
    expect(source).toContain('aria-label", "Start on-device dictation"');
    expect(source).toContain('className = "llss-result-backdrop"');
    expect(source).toContain('if (returnFocus?.isConnected) returnFocus.focus()');
    expect(source).toMatch(/spreadsheetml\.sheet": "\.xlsx"/);
    expect(source).not.toMatch(/spreadsheetml\.sheet['"]:\s*['"]\.csv/);
    expect(source.indexOf('file.size > MAX_DOCUMENT_BYTES'))
      .toBeLessThan(source.indexOf('const buffer = await file.arrayBuffer()'));
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('.llss-redact-btn:focus-visible');
  });

  test('primary extension surfaces share responsive, reduced-motion styling', () => {
    for (const file of ['popup.html', 'options.css', 'redact.css']) {
      expect(read(file)).toContain('prefers-reduced-motion: reduce');
    }
    expect(read('options.html')).toContain('aria-current="page"');
    expect(read('redact.html')).toContain('icons/icon128.png');
    expect(read('popup.html')).toContain('icons/icon48.png');
  });
});
