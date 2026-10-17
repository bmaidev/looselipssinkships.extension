#!/usr/bin/env node
// Backend transfer check using precomputed tokenizer windows. No remote fetching.
import fs from "node:fs";
import path from "node:path";
import { loadModel, configureRuntime, hashFile } from './wasm_artifacts.mjs';
import readline from "node:readline";
import { once } from "node:events";
import * as ort from "onnxruntime-web/wasm";

const [directory, framesPath, outputPath, memoryPolicy = "default", runtimeDirectory] = process.argv.slice(2);
if (!directory || !framesPath || !outputPath) throw new Error("Provide model directory, frames JSONL, and predictions output");
if (!["default", "bounded"].includes(memoryPolicy)) throw new Error("Memory policy must be default or bounded");
const { metadata, verification, graph, filename } = loadModel(directory);
const runtimeArtifact = configureRuntime(ort, runtimeDirectory);
const framesSha256 = hashFile(framesPath);
const tokenizerSha256 = hashFile(path.join(directory, 'tokenizer.json'));
ort.env.wasm.numThreads = 1;
const began = performance.now();
const session = await ort.InferenceSession.create(graph, { executionProviders: ["wasm"],
  ...(memoryPolicy === "bounded" ? { enableCpuMemArena: false, enableMemPattern: false } : {}) });
const coldStart = performance.now() - began;
const output = fs.createWriteStream(outputPath, { encoding: "utf8" });
const input = readline.createInterface({ input: fs.createReadStream(framesPath), crlfDelay: Infinity });
let count = 0;
let headerSeen = false;
let peakRss = 0;
const started = performance.now();
async function write(record) {
  if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, "drain");
}
for await (const line of input) {
  const record = JSON.parse(line);
  if (record._meta) {
    if (headerSeen || count) throw new Error('Expected exactly one leading frame manifest');
    if (!/^[a-f0-9]{64}$/.test(record._meta.dataset_sha256 || '')) throw new Error('Frames have no dataset binding');
    if (record._meta.tokenizer_sha256 !== tokenizerSha256) throw new Error('Tokenizer windows are not bound to the model tokenizer');
    headerSeen = true;
    await write({ _meta: { ...record._meta,
      frames_sha256: framesSha256,
      candidate_id: `llss-psi-${metadata.weights_sha256.slice(0, 8)}-${metadata.artifact_variant || "float"}-wasm-${filename}-${runtimeArtifact.kind}-${memoryPolicy}`,
      artifact_mb: graph.length / 1000000, artifact_sha256: verification.sha256,
      source_onnx_sha256: verification.source_onnx_sha256 || verification.sha256,
      weights_sha256: metadata.weights_sha256, adapter: "wasm-research", release_eligible: false,
      cold_start_ms: coldStart, runtime: ort.env.versions,
      model_format: filename, runtime_artifact: runtimeArtifact,
      memory_policy: memoryPolicy,
      measurement_scope: "browser WASM backend under Node; tokenizer windows prepared in Python" } });
    continue;
  }
  if (!headerSeen) throw new Error('Frames must begin with a verified manifest');
  const begin = performance.now();
  const unique = new Map();
  for (const window of record.windows) {
    const shape = [1, window.input_ids.length];
    const inputs = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(window.input_ids, BigInt), shape),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(window.attention_mask, BigInt), shape),
    };
    const result = await session.run(inputs);
    const logits = result.logits.data;
    let current = null;
    const finish = () => {
      if (current) {
        const key = `${current.start}:${current.end}:${current.label}`;
        if (!unique.has(key) || unique.get(key).score < current.score) unique.set(key, current);
      }
      current = null;
    };
    for (let index = 0; index < window.offsets.length; index++) {
      const [start, end] = window.offsets[index];
      if (start === end) continue;
      const values = logits.slice(index * metadata.tags.length, (index + 1) * metadata.tags.length);
      let choice = 0;
      for (let label = 1; label < values.length; label++) if (values[label] > values[choice]) choice = label;
      const tag = metadata.tags[choice];
      if (tag === "O") { finish(); continue; }
      let denominator = 0;
      for (const value of values) denominator += Math.exp(value - values[choice]);
      const score = 1 / denominator;
      const label = tag.slice(2);
      if (!current || tag.startsWith("B-") || current.label !== label) {
        finish(); current = { start, end, label, score };
      } else {
        current.end = end; current.score = Math.min(current.score, score);
      }
    }
    finish();
    for (const tensor of Object.values(result)) tensor.dispose();
    for (const tensor of Object.values(inputs)) tensor.dispose();
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss / 1048576);
  await write({ id: record.id, spans: [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end),
    latency_ms: performance.now() - begin });
  count++;
}
const memory = process.memoryUsage();
const summary = { prediction_records: count, prediction_elapsed_ms: performance.now() - started, peak_rss_mb: peakRss,
  final_memory_mb: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, value / 1048576])) };
await write({ _summary: summary });
output.end();
await once(output, "finish");
await session.release();
process.stdout.write(`${JSON.stringify(summary)}\n`);
