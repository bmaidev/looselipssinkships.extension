#!/usr/bin/env node
import readline from "node:readline";
import { env, pipeline } from "@huggingface/transformers";

const options = JSON.parse(process.argv[2] || "{}");
if (!options.repository) throw new Error("repository is required");
env.allowRemoteModels = true;
env.allowLocalModels = true;
if (options.cache_dir) env.cacheDir = options.cache_dir;

const detector = await pipeline("token-classification", options.repository, {
  revision: options.revision || "main",
  dtype: options.dtype || "q4",
});

function chunks(text, size = 1200, overlap = 160) {
  if (text.length <= size) return [[0, text]];
  const result = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      const space = text.lastIndexOf(" ", end);
      const boundary = Math.max(newline, space);
      if (boundary > start + Math.floor(size / 2)) end = boundary + 1;
    }
    result.push([start, text.slice(start, end)]);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return result;
}

function offsetsForOutput(chunk, output) {
  let cursor = 0;
  const located = [];
  for (const entity of output) {
    if (Number.isInteger(entity.start) && Number.isInteger(entity.end)) {
      located.push(entity);
      cursor = entity.end;
      continue;
    }
    const word = String(entity.word || "").replace(/^##/, "").replace(/^[▁Ġ]/, "");
    if (!word || /^\[.+\]$/.test(word)) continue;
    const start = chunk.toLocaleLowerCase().indexOf(word.toLocaleLowerCase(), cursor);
    if (start < 0) continue;
    const end = start + word.length;
    located.push({ ...entity, start, end });
    cursor = end;
  }
  // Reconstruct the aggregation that Transformers.js cannot perform when its
  // token-classification output omits offsets (v4). Only bridge whitespace or
  // punctuation between adjacent tokens carrying exactly the same raw label.
  const merged = [];
  for (const entity of located) {
    const label = entity.entity_group || entity.entity || "OTHER_PII";
    const previous = merged.at(-1);
    const gap = previous ? chunk.slice(previous.end, entity.start) : "";
    if (previous && previous.label === label && /^[\s@._+:/-]*$/.test(gap)) {
      previous.end = entity.end;
      previous.score = Math.min(previous.score, entity.score);
    } else {
      merged.push({ start: entity.start, end: entity.end, label, score: entity.score });
    }
  }
  return merged;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const item = JSON.parse(line);
    const started = process.hrtime.bigint();
    const text = String(item.text || "");
    const unique = new Map();
    for (const [offset, chunk] of chunks(text)) {
      const output = await detector(chunk, {
        aggregation_strategy: "simple",
        ignore_labels: ["O"],
      });
      for (const entity of offsetsForOutput(chunk, output)) {
        if (entity.end <= entity.start) continue;
        const span = {
          start: Array.from(text.slice(0, offset + entity.start)).length,
          end: Array.from(text.slice(0, offset + entity.end)).length,
          label: entity.label,
          score: entity.score,
        };
        const key = `${span.start}:${span.end}:${span.label}`;
        if (!unique.has(key) || unique.get(key).score < span.score) unique.set(key, span);
      }
    }
    const spans = [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(`${JSON.stringify({ id: item.id, spans, latency_ms: latencyMs, rss_mb: process.memoryUsage().rss / 1048576 })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error && error.stack || error) })}\n`);
  }
});
