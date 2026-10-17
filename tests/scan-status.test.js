const { describe: describeScan } = require('../lib/scan-status');
const fs = require('node:fs');
const path = require('node:path');

describe('Honest scan status', () => {
  test.each(['skipped_length', 'unavailable', 'failed', 'timeout', 'not_requested', 'unverified', 'unknown'])(
    'explains limited %s coverage without a safe/clean claim', status => {
      const notice = describeScan({ rules: { status: 'processed' }, contextual: { status } });
      expect(notice.limited).toBe(true);
      expect(notice.label).toContain('Limited scan');
      expect(notice.detail).toContain('Review');
      expect(notice.detail).not.toMatch(/guaranteed|all PII|safe to/i);
    });

  test('even processed or claimed qualified results retain a review warning', () => {
    const notice = describeScan({ rules: { status: 'processed' }, contextual: { status: 'processed' }, qualityQualified: true });
    expect(notice.detail).toContain('can still miss');
    expect(describeScan(null).label).toBe('Coverage unconfirmed');
    expect(describeScan({ rules: { status: 'not_run' } }).limited).toBe(true);
  });

  test('does not echo arbitrary provider text and is loaded in user-facing contexts', () => {
    expect(describeScan({ rules: { status: 'processed' }, contextual: { status: 'PRIVATE_SECRET' } }).detail)
      .not.toContain('PRIVATE_SECRET');
    const root = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts.flatMap(entry => entry.js || []);
    expect(scripts.indexOf('lib/scan-status.js')).toBeLessThan(scripts.indexOf('content.js'));
    const html = fs.readFileSync(path.join(root, 'redact.html'), 'utf8');
    expect(html.indexOf('lib/scan-status.js')).toBeLessThan(html.indexOf('src="redact.js"'));
  });
});
