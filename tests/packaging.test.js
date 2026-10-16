const fs = require('fs');
const path = require('path');
const { createManifest } = require('../scripts/build-manifest');
const {
  EDGE_SUPPORTED_APIS,
  collectManifestReferences,
} = require('../scripts/validate-extension');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function walkJavaScript(relativeDirectory) {
  const absoluteDirectory = path.join(ROOT, relativeDirectory);
  const files = [];
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScript(relative));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

describe('browser package manifests', () => {
  const baseManifest = readJson('manifest.json');
  const edgeOverrides = readJson('manifests/edge.json');

  test('repository versions remain aligned', () => {
    expect(readJson('package.json').version).toBe(baseManifest.version);
    expect(readJson('package-lock.json').version).toBe(baseManifest.version);
    expect(readJson('package-lock.json').packages[''].version).toBe(baseManifest.version);
  });

  test('Edge changes only store-facing description metadata', () => {
    const edgeManifest = createManifest(baseManifest, edgeOverrides, 'edge');
    const changedKeys = Object.keys(edgeManifest)
      .filter((key) => JSON.stringify(edgeManifest[key]) !== JSON.stringify(baseManifest[key]));

    expect(changedKeys).toEqual(['description']);
    expect(edgeManifest.description).toMatch(/Microsoft Edge/);
    expect(`${edgeManifest.name} ${edgeManifest.description}`).not.toMatch(/\bChrome\b/i);
  });

  test('rejects overrides that could make browser packages drift', () => {
    expect(() => createManifest(baseManifest, { permissions: [] }, 'edge'))
      .toThrow(/Disallowed edge manifest override/);
  });

  test('all base-manifest resources exist', () => {
    for (const reference of collectManifestReferences(baseManifest)) {
      const prefix = reference.split('*')[0];
      const candidate = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      expect(fs.existsSync(path.join(ROOT, candidate))).toBe(true);
    }
  });
});

describe('Microsoft Edge compatibility guardrails', () => {
  test('all used chrome.* namespaces are supported by Microsoft Edge', () => {
    const sourceFiles = [
      'background.js',
      'content.js',
      'offscreen.js',
      'options.js',
      'popup.js',
      'redact.js',
      ...walkJavaScript('lib'),
    ];
    const source = sourceFiles
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n');
    const usedApis = [...source.matchAll(/\bchrome\.([A-Za-z_]+)/g)]
      .map((match) => match[1]);
    const unsupported = [...new Set(usedApis)]
      .filter((api) => !EDGE_SUPPORTED_APIS.has(api));

    expect(unsupported).toEqual([]);
    expect(source).not.toMatch(/chrome\.identity\.(?:getAuthToken|getAccounts)\b/);
  });

  test('Chrome and Edge managed configurations stay equivalent', () => {
    const chromeConfig = readJson('enterprise/intune-policy.json').configuration;
    const edgeTemplate = readJson('enterprise/edge-intune-policy.json');

    expect(edgeTemplate.updateUrl).toBe('https://edge.microsoft.com/extensionwebstorebase/v1/crx');
    expect(edgeTemplate.managedConfiguration).toEqual(chromeConfig);
  });
});
