#!/usr/bin/env node
// Isolate graph/session/inference memory. This is NOT an extension browser gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [directory, policy = 'default', outputPath] = process.argv.slice(2);
if (!directory || !['default', 'bounded'].includes(policy)) {
  throw new Error('Usage: node profile_wasm_memory.mjs MODEL_DIRECTORY [default|bounded]');
}
const snapshots = [];
function snapshot(phase) {
  snapshots.push({ phase, ...Object.fromEntries(Object.entries(process.memoryUsage())
    .map(([key, value]) => [`${key}_mib`, value / 1048576])) });
}
snapshot('baseline');
const ort = await import('onnxruntime-web/wasm');
snapshot('runtime_imported');
const graph = fs.readFileSync(path.join(directory, 'model.onnx'));
const verification = JSON.parse(fs.readFileSync(path.join(directory, 'onnx-verification.json'), 'utf8'));
const sha256 = crypto.createHash('sha256').update(graph).digest('hex');
if (sha256 !== verification.sha256) throw new Error('Graph checksum mismatch');
ort.env.wasm.numThreads = 1;
const started = performance.now();
const session = await ort.InferenceSession.create(graph, { executionProviders: ['wasm'],
  ...(policy === 'bounded' ? { enableCpuMemArena: false, enableMemPattern: false } : {}) });
const coldStartMs = performance.now() - started;
snapshot('session_created');
const measurements = [];
try {
  for (const length of [16, 64, 128, 256, 16]) {
    const durations = [];
    for (let repetition = 0; repetition < 100; repetition++) {
      const inputs = {
        input_ids: new ort.Tensor('int64', new BigInt64Array(length).fill(101n), [1, length]),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(length).fill(1n), [1, length]),
      };
      let result;
      try {
        const begin = performance.now();
        result = await session.run(inputs);
        durations.push(performance.now() - begin);
      } finally {
        for (const tensor of Object.values(result || {})) tensor.dispose();
        for (const tensor of Object.values(inputs)) tensor.dispose();
      }
      if (repetition === 0) snapshot(`tokens_${length}_first_${measurements.length}`);
    }
    snapshot(`tokens_${length}_after_100_${measurements.length}`);
    durations.sort((a, b) => a - b);
    measurements.push({ tokens: length, repetitions: durations.length, p95_ms: durations[94] });
  }
} finally {
  await session.release();
}
snapshot('session_released');
const report = JSON.stringify({ scope: 'Node WASM synthetic memory diagnosis, not browser release evidence',
  artifact_sha256: sha256, runtime: ort.env.versions, node: process.version, policy,
  v8_flags: process.execArgv, cold_start_ms: coldStartMs, measurements, snapshots }, null, 2) + '\n';
if (outputPath) fs.writeFileSync(outputPath, report);
process.stdout.write(report);
