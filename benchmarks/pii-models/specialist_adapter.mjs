#!/usr/bin/env node
// Research-only JavaScript parity bridge. This is not bundled into the extension.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import * as ort from "onnxruntime-node";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node specialist_adapter.mjs /path/to/model-directory");
const config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"));
const verification = JSON.parse(fs.readFileSync(path.join(directory, "onnx-verification.json"), "utf8"));
const graph = fs.readFileSync(path.join(directory, "model.onnx"));
if (crypto.createHash("sha256").update(graph).digest("hex") !== verification.sha256) {
  throw new Error("Specialist ONNX checksum mismatch");
}
if (verification.source_weights_sha256 !== config.weights_sha256) {
  throw new Error("Specialist ONNX export and training checkpoint do not match");
}
if (config.max_bytes !== 40 || config.window_tokens !== 128 || config.tags.length !== 31) {
  throw new Error("Unsupported specialist artifact schema");
}
const session = await ort.InferenceSession.create(graph, {
  executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1,
});
const encoder = new TextEncoder();

function tokenize(text) {
  const tokens = [];
  const pattern = /[\p{L}\p{N}_]+(?:['’\-][\p{L}\p{N}_]+)*|[^\p{L}\p{N}_\s]/gu;
  // Python annotations count Unicode code points; JS regex offsets count UTF-16.
  const codePointAt = new Map([[0, 0]]);
  let utf16 = 0;
  let points = 0;
  for (const character of text) {
    utf16 += character.length;
    points += 1;
    codePointAt.set(utf16, points);
  }
  for (const match of text.matchAll(pattern)) {
    tokens.push({
      start: codePointAt.get(match.index),
      end: codePointAt.get(match.index + match[0].length),
      bytes: encoder.encode(match[0]).slice(0, 40),
    });
  }
  return tokens;
}

async function predict(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return [];
  const best = new Map();
  for (let offset = 0; offset < tokens.length; offset += 104) {
    const window = tokens.slice(offset, offset + 128);
    const ids = new BigInt64Array(window.length * 40);
    for (let index = 0; index < window.length; index++) {
      for (let byte = 0; byte < window[index].bytes.length; byte++) {
        ids[index * 40 + byte] = BigInt(window[index].bytes[byte] + 1);
      }
    }
    const inputIds = new ort.Tensor("int64", ids, [1, window.length, 40]);
    const result = await session.run({ input_ids: inputIds });
    const logits = result.logits.data;
    for (let relative = 0; relative < window.length; relative++) {
      const values = logits.slice(relative * config.tags.length, (relative + 1) * config.tags.length);
      let label = 0;
      for (let index = 1; index < values.length; index++) {
        if (values[index] > values[label]) label = index;
      }
      let denominator = 0;
      for (const value of values) denominator += Math.exp(value - values[label]);
      const score = 1 / denominator;
      const absolute = offset + relative;
      const margin = Math.min(relative, window.length - relative - 1);
      if (!best.has(absolute) || margin > best.get(absolute).margin) {
        best.set(absolute, { margin, label, score });
      }
    }
    for (const tensor of Object.values(result)) tensor.dispose();
    inputIds.dispose();
    if (offset + window.length >= tokens.length) break;
  }
  const spans = [];
  let current = null;
  for (let index = 0; index < tokens.length; index++) {
    const prediction = best.get(index);
    const tag = config.tags[prediction.label];
    if (tag === "O") {
      if (current) spans.push(current);
      current = null;
      continue;
    }
    const label = tag.slice(2);
    if (!current || tag.startsWith("B-") || current.label !== label) {
      if (current) spans.push(current);
      current = { start: tokens[index].start, end: tokens[index].end, label, score: prediction.score };
    } else {
      current.end = tokens[index].end;
      current.score = Math.min(current.score, prediction.score);
    }
  }
  if (current) spans.push(current);
  return spans;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    const record = JSON.parse(line);
    const started = performance.now();
    const spans = await predict(String(record.text || ""));
    process.stdout.write(`${JSON.stringify({ id: record.id, spans, latency_ms: performance.now() - started,
      rss_mb: process.memoryUsage().rss / 1048576 })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error.message || error) })}\n`);
  }
}
