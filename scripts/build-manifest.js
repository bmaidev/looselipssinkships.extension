#!/usr/bin/env node

'use strict';

const fs = require('fs');

const TARGET_OVERRIDES = {
  chrome: new Set(),
  edge: new Set(['description']),
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createManifest(base, overrides, target) {
  const allowed = TARGET_OVERRIDES[target];
  if (!allowed) throw new Error(`Unknown browser target: ${target}`);

  const keys = Object.keys(overrides || {});
  const disallowed = keys.filter((key) => !allowed.has(key));
  if (disallowed.length) {
    throw new Error(`Disallowed ${target} manifest override(s): ${disallowed.join(', ')}`);
  }

  return { ...base, ...overrides };
}

function main(argv) {
  const [basePath, overridesPath, outputPath, target] = argv;
  if (!basePath || !outputPath || !target) {
    throw new Error('Usage: build-manifest.js <base> <overrides-or-> <output> <chrome|edge>');
  }

  const base = readJson(basePath);
  const overrides = overridesPath === '-' ? {} : readJson(overridesPath);
  const manifest = createManifest(base, overrides, target);
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`Manifest build failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createManifest, TARGET_OVERRIDES };
