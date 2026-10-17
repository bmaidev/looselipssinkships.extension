#!/usr/bin/env node
'use strict';
// Same input, historical rules versus current rules. No model or network access.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const [revision, dataset, output] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(revision || '') || !dataset || !output) {
    throw new Error('Provide immutable baseline commit, dataset and fresh output directory');
  }
  if (fs.existsSync(output)) throw new Error('Evidence output must be fresh');
  const root = path.resolve(__dirname, '../..');
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const oldSource = execFileSync('git', ['show', `${revision}:lib/regex-engine.js`], { cwd: root, encoding: 'utf8' });
  const oldTypes = execFileSync('git', ['show', `${revision}:lib/pii-types.js`], { cwd: root });
  const currentTypes = fs.readFileSync(path.join(root, 'lib/pii-types.js'));
  if (digest(oldTypes) !== digest(currentTypes)) throw new Error('Rules changed: this is not an isolated union comparison');
  const context = { module: { exports: {} } };
  vm.runInNewContext(oldSource, context, { filename: 'historical-regex-engine.js', timeout: 1000 });
  const oldRedact = context.module.exports.regexRedact;
  const { regexRedact } = require(path.join(root, 'lib/regex-engine'));
  const { DEFAULT_PII_TYPES } = require(path.join(root, 'lib/pii-types'));
  const labelMap = JSON.parse(execFileSync('python3', ['-c',
    'import json; from pii_bench.taxonomy import EXTENSION_LABELS; print(json.dumps(EXTENSION_LABELS))'],
  { cwd: __dirname, env: { ...process.env, PYTHONPATH: path.join(__dirname, 'src') }, encoding: 'utf8' }));
  const datasetHash = digest(fs.readFileSync(dataset));
  const sourceHashes = Object.fromEntries(['lib/regex-engine.js', 'lib/redaction-spans.js', 'lib/pii-types.js']
    .map(name => [name, digest(fs.readFileSync(path.join(root, name)))]));
  fs.mkdirSync(output, { recursive: true });
  const variants = [{ name: 'before', redact: oldRedact, source: { baseline_commit: revision, engine_sha256: digest(oldSource) } },
    { name: 'after', redact: regexRedact, source: sourceHashes }];
  async function write(stream, value) {
    if (!stream.write(JSON.stringify(value) + '\n')) await once(stream, 'drain');
  }
  const coverage = { records: 0, lost_coverage_records: 0, added_coverage_records: 0,
    additional_sensitive_characters: 0, additional_non_sensitive_characters: 0 };
  for (const variant of variants) {
    const stream = fs.createWriteStream(path.join(output, `${variant.name}.predictions.jsonl`), { flags: 'wx' });
    stream.on('error', error => { throw error; });
    await write(stream, { _meta: { candidate_id: `rules-union-${variant.name}`, dataset_sha256: datasetHash,
      artifact_sha256: digest(JSON.stringify(variant.source)), source: variant.source, release_eligible: false,
      measurement_scope: 'Exploratory rules regression under Node, not packaged browser performance',
      comparison_code_sha256: digest(fs.readFileSync(__filename)), node: process.version } });
    const input = readline.createInterface({ input: fs.createReadStream(dataset), crlfDelay: Infinity });
    let count = 0;
    for await (const line of input) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const began = performance.now();
      const result = variant.redact(record.text, DEFAULT_PII_TYPES);
      const latency = performance.now() - began;
      if (variant.name === 'after') {
        const previous = oldRedact(record.text, DEFAULT_PII_TYPES).matches;
        if (previous.some(old => !result.matches.some(now => now.index <= old.index &&
          now.index + now.original.length >= old.index + old.original.length))) coverage.lost_coverage_records++;
        // Use codepoint masks for the corpus's offsets; detector offsets are UTF-16.
        const oldMask = new Set();
        const newMask = new Set();
        for (const [matches, mask] of [[previous, oldMask], [result.matches, newMask]]) {
          for (const match of matches) {
            const start = Array.from(record.text.slice(0, match.index)).length;
            const end = start + Array.from(match.original).length;
            for (let i = start; i < end; i++) mask.add(i);
          }
        }
        const added = [...newMask].filter(i => !oldMask.has(i));
        if (added.length) coverage.added_coverage_records++;
        for (const i of added) {
          const sensitive = record.entities.some(entity => entity.start <= i && i < entity.end);
          coverage[sensitive ? 'additional_sensitive_characters' : 'additional_non_sensitive_characters']++;
        }
        coverage.records++;
      }
      const spans = result.matches.map(match => ({
        start: Array.from(record.text.slice(0, match.index)).length,
        end: Array.from(record.text.slice(0, match.index + match.original.length)).length,
        label: labelMap[match.typeId] || 'OTHER_PII', score: 1,
      }));
      await write(stream, { id: record.id, spans, latency_ms: latency });
      count++;
    }
    await write(stream, { _summary: { prediction_records: count } });
    stream.end();
    await once(stream, 'finish');
    process.stdout.write(`${variant.name}: ${count} documents\n`);
  }
  fs.writeFileSync(path.join(output, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n', { flag: 'wx' });
  if (coverage.lost_coverage_records) throw new Error('Mandatory identifier coverage regressed');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
