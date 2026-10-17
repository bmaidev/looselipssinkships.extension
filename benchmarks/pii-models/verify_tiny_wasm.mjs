#!/usr/bin/env node
// Compare the deployed INT8 graph in native ONNX and the browser WASM backend.
// Execution under Node verifies operators/parity, not Chrome/Edge integration.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as native from "onnxruntime-node";
import * as web from "onnxruntime-web/wasm";

const directory = process.argv[2];
if (!directory) throw new Error("Provide a fine-tuned BERT model directory");
const graph = fs.readFileSync(path.join(directory, "model.onnx"));
const verification = JSON.parse(fs.readFileSync(path.join(directory, "onnx-verification.json"), "utf8"));
if (crypto.createHash("sha256").update(graph).digest("hex") !== verification.sha256) {
  throw new Error("ONNX checksum mismatch");
}
web.env.wasm.numThreads = 1;
const nativeSession = await native.InferenceSession.create(graph, { executionProviders: ["cpu"], intraOpNumThreads: 1 });
const started = performance.now();
const wasmSession = await web.InferenceSession.create(graph, { executionProviders: ["wasm"] });
const wasmInitializationMs = performance.now() - started;
let maximumError = 0;
const cases = [];
for (const [batch, length] of [[1, 1], [1, 16], [2, 37], [1, 256]]) {
  const ids = BigInt64Array.from({ length: batch * length }, (_, index) => BigInt(100 + index % 1000));
  const mask = BigInt64Array.from({ length: batch * length }, (_, index) => (length > 3 && index % length > length - 3) ? 0n : 1n);
  const shapes = [batch, length];
  const nativeInputs = { input_ids: new native.Tensor("int64", ids, shapes), attention_mask: new native.Tensor("int64", mask, shapes) };
  const webInputs = { input_ids: new web.Tensor("int64", ids, shapes), attention_mask: new web.Tensor("int64", mask, shapes) };
  const expected = (await nativeSession.run(nativeInputs)).logits.data;
  const actual = (await wasmSession.run(webInputs)).logits.data;
  if (expected.length !== actual.length) throw new Error("Backend output shape mismatch");
  let error = 0;
  for (let index = 0; index < expected.length; index++) error = Math.max(error, Math.abs(expected[index] - actual[index]));
  if (!Number.isFinite(error) || error > 0.001) throw new Error(`WASM logit parity failed: ${error}`);
  maximumError = Math.max(maximumError, error);
  const times = [];
  for (let repeat = 0; repeat < 20; repeat++) {
    const begin = performance.now();
    await wasmSession.run(webInputs);
    times.push(performance.now() - begin);
  }
  times.sort((a, b) => a - b);
  cases.push({ batch, tokens: length, maximum_logit_error: error, wasm_model_only_p95_ms: times[18] });
}
process.stdout.write(`${JSON.stringify({ artifact_sha256: verification.sha256, wasm_initialization_ms: wasmInitializationMs,
  maximum_logit_error: maximumError, cases, wasm_runtime: web.env.versions,
  scope: "browser WASM backend under Node; real Chrome/Edge integration remains unverified" }, null, 2)}\n`);
await nativeSession.release();
await wasmSession.release();
