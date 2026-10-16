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

  test('uses least-privilege network access and hardened extension CSP', () => {
    expect(baseManifest.host_permissions).toBeUndefined();
    expect(baseManifest.optional_host_permissions).toContain('https://*/*');
    expect(baseManifest.content_security_policy.extension_pages).toContain("object-src 'none'");
    expect(baseManifest.content_security_policy.extension_pages).toContain("base-uri 'none'");
  });

  test('upload interception starts fail-closed in every document frame', () => {
    const contentScript = baseManifest.content_scripts.find((entry) => entry.js.includes('content.js'));
    expect(contentScript.run_at).toBe('document_start');
    expect(contentScript.all_frames).toBe(true);
    expect(contentScript.match_about_blank).toBe(true);
    expect(contentScript.js).not.toEqual(expect.arrayContaining([
      'lib/providers/azure-pii-provider.js',
      'lib/providers/hosted-model-provider.js',
    ]));
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

describe('security regression guardrails', () => {
  test('content scripts cannot request provider secrets', () => {
    const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    expect(contentSource).toContain('GET_CONTENT_SETTINGS');
    expect(contentSource).not.toContain('{ type: "GET_SETTINGS" }');
    expect(contentSource).not.toContain('LLSS_tokenVault.restore');
  });

  test('submit interception covers standard textual input fields', () => {
    const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    expect(contentSource).toContain('TEXT_FIELD_SELECTOR');
    for (const type of ['text', 'search', 'email', 'tel', 'url']) {
      expect(contentSource).toContain(`input[type="${type}"]`);
    }
    expect(contentSource).toContain('form.querySelectorAll(TEXT_FIELD_SELECTOR)');
    expect(contentSource).toContain('container.querySelector(TEXT_FIELD_SELECTOR)');
  });

  test('large document messages use bounded base64 instead of number arrays', () => {
    const sources = ['background.js', 'content.js', 'redact.js', 'offscreen.js']
      .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
      .join('\n');
    expect(sources).toContain('LLSS_BinaryTransfer');
    expect(sources).toContain('fileDataBase64');
    expect(sources).toContain('redactedFileBase64');
    expect(sources).not.toContain('fileData: Array.from(new Uint8Array');
    expect(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')).toContain('enqueueDocumentJob');
  });

  test('the optional OCR server requires auth and has no wildcard CORS', () => {
    const serverSource = fs.readFileSync(path.join(ROOT, 'server/main.py'), 'utf8');
    expect(serverSource).toContain('secrets.compare_digest');
    expect(serverSource).toContain('Depends(require_api_key)');
    expect(serverSource).toContain('LLSS_API_KEY_FILE');
    expect(serverSource).toContain('RequestSizeLimitMiddleware');
    expect(serverSource).toContain('origin == "*"');
    expect(serverSource).toContain('allow_credentials=False');
    expect(serverSource).not.toContain('allow_origins=["*"]');
  });

  test('the OCR container uses locked dependencies and hardened runtime defaults', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'server/Dockerfile'), 'utf8');
    const compose = fs.readFileSync(path.join(ROOT, 'server/docker-compose.yml'), 'utf8');

    expect(dockerfile).toMatch(/^FROM python:3\.12-slim@sha256:[a-f0-9]{64}$/m);
    expect(dockerfile).toContain('pip install --no-cache-dir --require-hashes');
    expect(dockerfile).toContain('USER llss');
    expect(dockerfile).toContain('"--limit-concurrency", "4"');
    expect(compose).toContain('LLSS_API_KEY_FILE=/run/secrets/llss_api_key');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('127.0.0.1:8000:8000');
  });
});
