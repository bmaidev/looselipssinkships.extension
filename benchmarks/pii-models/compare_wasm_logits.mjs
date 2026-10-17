#!/usr/bin/env node
// Fixed-tolerance parity check in separate processes: ORT caches its WASM backend.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadModel, configureRuntime, hashFile } from './wasm_artifacts.mjs';

const tolerance = 0.0001;
const args = process.argv.slice(2);
if (args[0] === '--child') {
  const [, directory, output, runtime] = args;
  const ort = await import('onnxruntime-web/wasm');
  const model = loadModel(directory);
  const runtimeArtifact = configureRuntime(ort, runtime);
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(model.graph, { executionProviders: ['wasm'] });
  const cases = [];
  try {
    for (const [batch, length] of [[1, 1], [1, 16], [2, 37], [1, 128], [1, 256]]) {
      const ids = BigInt64Array.from({ length: batch * length }, (_, index) => BigInt(100 + index % 1000));
      const mask = new BigInt64Array(batch * length).fill(1n);
      if (length > 3) for (let row = 0; row < batch; row++) {
        for (let index = length - 2; index < length; index++) { ids[row * length + index] = 0n; mask[row * length + index] = 0n; }
      }
      const inputs = { input_ids: new ort.Tensor('int64', ids, [batch, length]),
        attention_mask: new ort.Tensor('int64', mask, [batch, length]) };
      let result;
      try {
        result = await session.run(inputs);
        cases.push({ batch, tokens: length, dims: result.logits.dims, values: Array.from(result.logits.data) });
      } finally {
        for (const tensor of Object.values(result || {})) tensor.dispose();
        for (const tensor of Object.values(inputs)) tensor.dispose();
      }
    }
  } finally { await session.release(); }
  fs.writeFileSync(output, JSON.stringify({ artifact_sha256: model.verification.sha256, runtime_artifact: runtimeArtifact, cases }));
} else {
  const [onnx, converted, runtime, output] = args;
  if (!output) throw new Error('Provide ONNX model, ORT model, minimal runtime and fresh output directory');
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Output must be fresh');
  fs.mkdirSync(output, { recursive: true });
  const variants = [{ name: 'full-onnx', model: onnx }, { name: 'full-ort', model: converted },
    { name: 'minimal-ort', model: converted, runtime }];
  const results = {};
  for (const variant of variants) {
    const filename = path.join(output, `${variant.name}.json`);
    const childArgs = [import.meta.filename, '--child', variant.model, filename];
    if (variant.runtime) childArgs.push(variant.runtime);
    const child = spawnSync(process.execPath, childArgs, { encoding: 'utf8', timeout: 60000 });
    if (child.error || child.status !== 0) throw new Error(`${variant.name}: ${child.error || child.stderr}`);
    results[variant.name] = JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
  const comparisons = [];
  for (const [first, second] of [['full-onnx', 'full-ort'], ['full-ort', 'minimal-ort'], ['full-onnx', 'minimal-ort']]) {
    let maximum = 0;
    for (let index = 0; index < results[first].cases.length; index++) {
      const expected = results[first].cases[index], actual = results[second].cases[index];
      if (JSON.stringify(expected.dims) !== JSON.stringify(actual.dims) || expected.values.length !== actual.values.length) {
        throw new Error('Backend shape mismatch');
      }
      for (let position = 0; position < expected.values.length; position++) {
        const error = Math.abs(expected.values[position] - actual.values[position]);
        if (!Number.isFinite(error)) throw new Error('Non-finite logits');
        maximum = Math.max(maximum, error);
      }
    }
    comparisons.push({ first, second, maximum_absolute_error: maximum, tolerance, passed: maximum <= tolerance });
  }
  const report = { scope: 'Synthetic padded shape parity, not accuracy or packaged-browser approval', release_eligible: false,
    source_code_sha256: hashFile(import.meta.filename), comparisons,
    variants: Object.fromEntries(variants.map(variant => [variant.name, { artifact_sha256: results[variant.name].artifact_sha256,
      raw_logits_sha256: hashFile(path.join(output, `${variant.name}.json`)),
      cases: results[variant.name].cases.map(({ values, ...shape }) => shape) }])) };
  fs.writeFileSync(path.join(output, 'parity.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (comparisons.some(comparison => !comparison.passed)) process.exitCode = 1;
}
