#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_TARGETS = new Set(['chrome', 'edge']);
const EDGE_SUPPORTED_APIS = new Set([
  'alarms',
  'identity',
  'offscreen',
  'runtime',
  'storage',
  'tabs',
]);
const PACKAGE_FILES = new Set([
  'manifest.json',
  'managed_schema.json',
  'background.js',
  'content.js',
  'content.css',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.js',
  'redact.html',
  'redact.js',
  'redact.css',
  'options.html',
  'options.js',
  'options.css',
  'LICENSE.md',
  'THIRD_PARTY_NOTICES.md',
]);
const PACKAGE_DIRECTORIES = new Set(['icons', 'lib', 'vendor']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkFiles(root) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  walk(root);
  return files.sort();
}

function collectManifestReferences(manifest) {
  const refs = new Set();
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  if (manifest.options_page) refs.add(manifest.options_page);
  if (manifest.storage?.managed_schema) refs.add(manifest.storage.managed_schema);

  for (const icon of Object.values(manifest.icons || {})) refs.add(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) refs.add(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) refs.add(file);
    for (const file of script.css || []) refs.add(file);
  }
  for (const resourceGroup of manifest.web_accessible_resources || []) {
    for (const resource of resourceGroup.resources || []) refs.add(resource);
  }
  return refs;
}

function referenceExists(root, reference) {
  if (!reference.includes('*')) return fs.existsSync(path.join(root, reference));
  const prefix = reference.slice(0, reference.indexOf('*'));
  const directory = path.dirname(prefix);
  const basenamePrefix = path.basename(prefix);
  const absoluteDirectory = path.join(root, directory);
  return fs.existsSync(absoluteDirectory)
    && fs.readdirSync(absoluteDirectory).some((name) => name.startsWith(basenamePrefix));
}

function validateExtension(root, target, options = {}) {
  const errors = [];
  const warnings = [];
  const packageMode = options.packageMode === true;
  const resolvedRoot = path.resolve(root);

  if (!SUPPORTED_TARGETS.has(target)) errors.push(`Unsupported target: ${target}`);

  let manifest;
  try {
    manifest = readJson(path.join(resolvedRoot, 'manifest.json'));
  } catch (err) {
    return { errors: [`Invalid or missing manifest.json: ${err.message}`], warnings, files: [], apis: [] };
  }

  if (manifest.manifest_version !== 3) errors.push('Only Manifest V3 packages are supported');
  if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version || '')) errors.push('Manifest version is invalid');
  if (!manifest.name || !manifest.description) errors.push('Manifest name and description are required');
  if (manifest.update_url) errors.push('Store packages must not contain an update_url');
  if (!manifest.permissions?.includes('storage')) errors.push('storage permission is required');
  if (!manifest.permissions?.includes('offscreen')) errors.push('offscreen permission is required');
  if (!manifest.storage?.managed_schema) errors.push('Managed storage schema must be declared');

  const csp = manifest.content_security_policy?.extension_pages || '';
  if (!csp.includes("script-src 'self'")) errors.push("Extension CSP must restrict scripts to 'self'");
  if (/https?:/i.test(csp)) errors.push('Extension CSP must not allow remote script origins');

  if (target === 'edge') {
    const listingText = `${manifest.name} ${manifest.description}`;
    if (/\bChrome\b/i.test(listingText)) {
      errors.push('Edge manifest name/description must not use Chrome branding');
    }
    if (!/Microsoft Edge/i.test(manifest.description)) {
      errors.push('Edge manifest description must identify Microsoft Edge');
    }
  }

  for (const reference of collectManifestReferences(manifest)) {
    if (!referenceExists(resolvedRoot, reference)) {
      errors.push(`Manifest reference does not exist: ${reference}`);
    }
  }

  const files = walkFiles(resolvedRoot);
  const sourceFiles = files.filter((file) => file.endsWith('.js') && !file.startsWith('vendor/'));
  const source = sourceFiles
    .map((file) => fs.readFileSync(path.join(resolvedRoot, file), 'utf8'))
    .join('\n');
  const apis = [...source.matchAll(/\bchrome\.([A-Za-z_]+)/g)]
    .map((match) => match[1])
    .filter((api, index, all) => all.indexOf(api) === index)
    .sort();

  if (target === 'edge') {
    const unsupported = apis.filter((api) => !EDGE_SUPPORTED_APIS.has(api));
    if (unsupported.length) errors.push(`Unsupported Microsoft Edge extension API(s): ${unsupported.join(', ')}`);
    if (/chrome\.identity\.(?:getAuthToken|getAccounts)\b/.test(source)) {
      errors.push('Edge does not support the identity.getAuthToken/getAccounts methods');
    }
  }

  for (const htmlFile of files.filter((file) => file.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(resolvedRoot, htmlFile), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const scriptRef = match[1];
      if (/^(?:https?:)?\/\//i.test(scriptRef)) {
        errors.push(`Remote script is not allowed in ${htmlFile}: ${scriptRef}`);
      } else {
        const scriptPath = path.resolve(path.dirname(path.join(resolvedRoot, htmlFile)), scriptRef);
        if (!scriptPath.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(scriptPath)) {
          errors.push(`Missing script referenced by ${htmlFile}: ${scriptRef}`);
        }
      }
    }
  }

  const backgroundPath = path.join(resolvedRoot, manifest.background?.service_worker || '');
  if (fs.existsSync(backgroundPath)) {
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const importBlock = background.match(/importScripts\(([\s\S]*?)\);/);
    for (const match of (importBlock?.[1] || '').matchAll(/["']([^"']+)["']/g)) {
      if (!fs.existsSync(path.join(resolvedRoot, match[1]))) {
        errors.push(`Missing service-worker dependency: ${match[1]}`);
      }
    }
  }

  if (packageMode) {
    for (const file of files) {
      const topLevel = file.split('/')[0];
      if (!PACKAGE_FILES.has(file) && !PACKAGE_DIRECTORIES.has(topLevel)) {
        errors.push(`Development-only file found in package: ${file}`);
      }
    }
    for (const required of PACKAGE_FILES) {
      if (!files.includes(required)) errors.push(`Required package file is missing: ${required}`);
    }
    if (files.some((file) => /(?:^|\/)\.DS_Store$|__MACOSX|\.map$/.test(file))) {
      errors.push('Package contains metadata or source-map files');
    }
  }

  return { errors, warnings, files, apis, manifest };
}

function main(argv) {
  const [root = '.', target = 'chrome', ...flags] = argv;
  const result = validateExtension(root, target, { packageMode: flags.includes('--package') });
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Validated ${target} MV3 package: ${result.files.length} files; APIs: ${result.apis.join(', ')}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  EDGE_SUPPORTED_APIS,
  PACKAGE_DIRECTORIES,
  PACKAGE_FILES,
  collectManifestReferences,
  validateExtension,
};
