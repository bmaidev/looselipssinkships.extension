#!/usr/bin/env node
"use strict";

// Benchmark bridge that executes the extension's production detectors, not a
// Python approximation. One JSON record is read and answered per line.
const readline = require("node:readline");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const { DEFAULT_PII_TYPES } = require(path.join(repoRoot, "lib/pii-types"));
const { regexRedact } = require(path.join(repoRoot, "lib/regex-engine"));
const { vectorRedact } = require(path.join(repoRoot, "lib/vector-engine"));
const { mergeMatches } = require(path.join(repoRoot, "lib/redaction-spans"));

const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "hybrid";
if (!new Set(["regex", "hybrid"]).has(mode)) {
  process.stderr.write(`Unsupported extension adapter mode: ${mode}\n`);
  process.exit(2);
}

function asSpan(match, text) {
  return {
    start: Array.from(text.slice(0, match.index)).length,
    end: Array.from(text.slice(0, match.index + match.original.length)).length,
    label: match.typeId,
    score: match.confidence ?? 1,
  };
}

function detect(text) {
  const regexMatches = regexRedact(text, DEFAULT_PII_TYPES).matches;
  let matches = [...regexMatches];
  if (mode === "hybrid") {
    const vectorMatches = vectorRedact(text, "[REDACTED_NAME]", 0.45).matches;
    matches = mergeMatches(text, matches.concat(vectorMatches));
  }
  return matches.map((match) => asSpan(match, text));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const item = JSON.parse(line);
    const started = process.hrtime.bigint();
    const spans = detect(String(item.text || ""));
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(`${JSON.stringify({ id: item.id, spans, latency_ms: latencyMs, rss_mb: process.memoryUsage().rss / 1048576 })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error && error.message || error) })}\n`);
  }
});
