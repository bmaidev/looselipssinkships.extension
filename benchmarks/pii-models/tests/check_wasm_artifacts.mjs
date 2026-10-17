import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadModel, configureRuntime, hashFile, RUNTIME_VERSION, SOURCE_REVISION } from '../wasm_artifacts.mjs';

function fixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llss-wasm-artifact-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'model.onnx'), 'synthetic graph, never executed');
    fs.writeFileSync(path.join(directory, 'tokenizer.json'), '{}');
    fs.writeFileSync(path.join(directory, 'training.json'), JSON.stringify({
      weights_sha256: 'a'.repeat(64), tags: ['O', 'B-OTHER_PII', 'I-OTHER_PII'],
    }));
    const verification = { sha256: hashFile(path.join(directory, 'model.onnx')),
      weights_sha256: 'a'.repeat(64), tokenizer_sha256: hashFile(path.join(directory, 'tokenizer.json')) };
    fs.writeFileSync(path.join(directory, 'onnx-verification.json'), JSON.stringify(verification));
    callback(directory, verification);
  } finally { fs.rmSync(directory, { recursive: true }); }
}

test('verified ONNX and ORT files load without executing any model', () => fixture((directory, verification) => {
  assert.equal(loadModel(directory).filename, 'model.onnx');
  fs.copyFileSync(path.join(directory, 'model.onnx'), path.join(directory, 'model.basic.ort'));
  fs.writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify({ ...verification, artifact_file: 'model.basic.ort' }));
  assert.equal(loadModel(directory).filename, 'model.basic.ort');
}));

test('corrupt model and tokenizer are rejected', () => fixture((directory) => {
  fs.writeFileSync(path.join(directory, 'tokenizer.json'), 'modified');
  assert.throws(() => loadModel(directory), /checksum/);
  fs.writeFileSync(path.join(directory, 'model.onnx'), 'modified');
  assert.throws(() => loadModel(directory), /checksum/);
}));

test('model path traversal and weight-lineage mismatches are rejected', () => fixture((directory, verification) => {
  const manifest = path.join(directory, 'deployment.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...verification, artifact_file: '../model.onnx' }));
  assert.throws(() => loadModel(directory), /filename/);
  fs.writeFileSync(manifest, JSON.stringify({ ...verification, weights_sha256: 'b'.repeat(64) }));
  assert.throws(() => loadModel(directory), /lineage/);
}));

test('invalid tag maps are rejected', () => fixture((directory) => {
  fs.writeFileSync(path.join(directory, 'training.json'), JSON.stringify({ weights_sha256: 'a'.repeat(64), tags: ['O', 'O', 'O'] }));
  assert.throws(() => loadModel(directory), /tag map/);
}));

test('runtime policies and both executable hashes are verified before activation', () => fixture((directory) => {
  const names = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  for (const name of names) fs.writeFileSync(path.join(directory, name), 'test-only, never executed');
  const valid = { runtime_version: RUNTIME_VERSION, source_revision: SOURCE_REVISION,
    telemetry_disabled: true, minimal_build: true, release_eligible: false,
    files: Object.fromEntries(names.map(name => [name, { sha256: hashFile(path.join(directory, name)) }])) };
  for (const modification of [{ telemetry_disabled: false }, { minimal_build: false },
    { release_eligible: true }, { source_revision: 'unreviewed' }, { runtime_version: 'unknown' }]) {
    fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify({ ...valid, ...modification }));
    const ort = { env: { versions: { web: RUNTIME_VERSION }, wasm: {} } };
    assert.throws(() => configureRuntime(ort, directory), /incompatible/);
    assert.equal(ort.env.wasm.wasmPaths, undefined);
  }
  fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(valid));
  for (const name of names) {
    fs.writeFileSync(path.join(directory, name), 'corrupt');
    const ort = { env: { versions: { web: RUNTIME_VERSION }, wasm: {} } };
    assert.throws(() => configureRuntime(ort, directory), /checksum/);
    assert.equal(ort.env.wasm.wasmPaths, undefined);
    fs.writeFileSync(path.join(directory, name), 'test-only, never executed');
  }
}));
