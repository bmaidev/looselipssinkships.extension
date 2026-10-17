// Research-only, local artifact loading. No fetching or production approval.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RUNTIME_VERSION = '1.30.0';
export const SOURCE_REVISION = 'f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7';

export function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.alloc(65536);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function readJson(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function checkHash(filename, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || hashFile(filename) !== expected) {
    throw new Error(`Artifact checksum mismatch: ${path.basename(filename)}`);
  }
}

export function loadModel(directory) {
  const metadata = readJson(path.join(directory, 'training.json'));
  const deployment = path.join(directory, 'deployment.json');
  const verification = readJson(fs.existsSync(deployment) ? deployment : path.join(directory, 'onnx-verification.json'));
  const filename = verification.artifact_file || 'model.onnx';
  if (!['model.onnx', 'model.basic.ort'].includes(filename)) throw new Error('Unapproved model artifact filename');
  if (verification.runtime_version && verification.runtime_version !== RUNTIME_VERSION) {
    throw new Error('Unreviewed model conversion runtime');
  }
  const modelPath = path.join(directory, filename);
  checkHash(modelPath, verification.sha256);
  if (verification.weights_sha256 && verification.weights_sha256 !== metadata.weights_sha256) {
    throw new Error('Model weight lineage mismatch');
  }
  if (verification.tokenizer_sha256) checkHash(path.join(directory, 'tokenizer.json'), verification.tokenizer_sha256);
  if (!Array.isArray(metadata.tags) || ![3, 31].includes(metadata.tags.length) || metadata.tags[0] !== 'O'
      || metadata.tags.some(tag => typeof tag !== 'string') || new Set(metadata.tags).size !== metadata.tags.length) {
    throw new Error('Invalid research head tag map');
  }
  return { metadata, verification, graph: fs.readFileSync(modelPath), filename };
}

export function configureRuntime(ort, directory) {
  const defaultDirectory = path.join(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
  const location = directory || defaultDirectory;
  const names = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  let manifest;
  if (directory) {
    manifest = readJson(path.join(directory, 'runtime.json'));
    if (manifest.runtime_version !== RUNTIME_VERSION || manifest.runtime_version !== ort.env.versions.web
        || manifest.source_revision !== SOURCE_REVISION || manifest.telemetry_disabled !== true
        || manifest.minimal_build !== true || manifest.release_eligible !== false) {
      throw new Error('Unreviewed or incompatible research runtime');
    }
    for (const name of names) checkHash(path.join(location, name), manifest.files?.[name]?.sha256);
    ort.env.wasm.wasmPaths = {
      mjs: pathToFileURL(path.resolve(location, names[0])).href,
      wasm: pathToFileURL(path.resolve(location, names[1])).href,
    };
  }
  const wrapper = path.join(defaultDirectory, 'ort.wasm.bundle.min.mjs');
  const files = Object.fromEntries([...names.map(name => [name, path.join(location, name)]), ['wrapper', wrapper]]
    .map(([name, filename]) => [name, { sha256: hashFile(filename), bytes: fs.statSync(filename).size }]));
  return { kind: directory ? 'custom-minimal' : 'npm-default', runtime_version: ort.env.versions.web,
    files, total_bytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
    source_revision: manifest?.source_revision, build: manifest, release_eligible: false };
}
