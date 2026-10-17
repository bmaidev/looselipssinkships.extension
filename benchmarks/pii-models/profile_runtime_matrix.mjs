#!/usr/bin/env node
// Sequential diagnostic comparison. No special V8 flags or concurrent inference.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashFile } from './wasm_artifacts.mjs';

const [onnxDirectory, ortDirectory, runtimeDirectory, outputDirectory] = process.argv.slice(2);
if (!outputDirectory) throw new Error('Provide ONNX model, ORT model, minimal runtime and fresh output directories');
if (fs.existsSync(outputDirectory) && fs.readdirSync(outputDirectory).length) throw new Error('Output must be fresh');
fs.mkdirSync(outputDirectory, { recursive: true });
const variants = [
  { name: 'full-onnx', model: onnxDirectory },
  { name: 'full-ort', model: ortDirectory },
  { name: 'minimal-ort', model: ortDirectory, runtime: runtimeDirectory },
];
const results = [];
for (let repetition = 0; repetition < 3; repetition++) {
  // Rotate variant order to reduce systematic order/thermal bias.
  for (let offset = 0; offset < variants.length; offset++) {
    const variant = variants[(offset + repetition) % variants.length];
    const filename = path.join(outputDirectory, `${variant.name}.${repetition + 1}.json`);
    const args = [path.join(import.meta.dirname, 'profile_wasm_memory.mjs'), variant.model, 'default', filename];
    if (variant.runtime) args.push(variant.runtime);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 2_000_000 });
    if (result.error || result.status !== 0) throw new Error(`Failed ${variant.name}: ${result.error || result.stderr}`);
    const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
    results.push({ variant: variant.name, repetition: repetition + 1, result_sha256: hashFile(filename), report });
    process.stdout.write(JSON.stringify({ variant: variant.name, repetition: repetition + 1,
      peak_rss_mib: report.os_peak_rss_mib, cold_start_ms: report.cold_start_ms }) + '\n');
  }
}
const report = { scope: 'Sequential Node/WASM synthetic diagnostic, not packaged-browser evidence',
  release_eligible: false, repetitions: 3, source_code_sha256: hashFile(new URL(import.meta.url)),
  profiler_sha256: hashFile(path.join(import.meta.dirname, 'profile_wasm_memory.mjs')),
  results };
fs.writeFileSync(path.join(outputDirectory, 'matrix.json'), JSON.stringify(report, null, 2) + '\n');
