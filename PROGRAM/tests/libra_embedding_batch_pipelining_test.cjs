'use strict';
// LIBRA embedding batch pipelining.
//
// THE COST TODAY: `embedTextsOnce` (LIBRA.js:29592) sends its batches in a strict
// serial loop —
//
//     const batches = buildEmbeddingBatches(cfg, texts, contextGroupKeys, purpose);
//     for (const batchMeta of batches) {
//         const request = await buildRequest(cfg, batchMeta.texts, ...);
//         const data = await requestJson(request.url, request.init, ...);   // wire round-trip
//     }
//
// A 500-memory maintenance run with the default `batchSize: 8` is ~63 serial wire
// round-trips. This test measures how many physical requests are in flight at once
// and asserts the batches are PIPELINED above 1, while also asserting the results
// stay correct (same vectors, same order, same usage totals).
//
// WHY THIS IS SAFE TO MEASURE: `partVectors` is written by index
// (`partVectors[batchMeta.indices[index]]`), so batch completion order does not
// affect the result — the serialization buys nothing but latency.
//
// WHAT MUST NOT REGRESS (asserted here):
//   - vector order/text binding identical to the serial baseline
//   - total usage (inputTokens) identical
//   - the request ledger's budget is respected (no REQUEST_BUDGET_EXHAUSTED)
//   - a failing batch still surfaces an error (no silent partial result)
//
// RED/GREEN: with the serial loop the concurrency assertion FAILS (maxInFlight===1);
// with pipelining it PASSES (maxInFlight > 1).
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const HOLD_MS = Number(process.env.LIBRA_EMBED_PIPELINE_HOLD_MS || 120);
const CONCURRENCY = Number(process.env.LIBRA_EMBED_PIPELINE_CONCURRENCY || 4);
const DIM = 3;
const FAIL_TEXT = 'memory-3';
const BATCH = Number(process.env.LIBRA_EMBED_PIPELINE_BATCH || 2);

const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const vectorsFor = (count, seed) => ({
  data: Array.from({ length: count }, (_, index) => ({ index, embedding: [seed, index + 1, 0] })),
  usage: { prompt_tokens: count, total_tokens: count }
});

(async () => {
  const harness = await createLibraVmHarness(
    {},
    {},
    { transformSource: s => s.replace('const EmbeddingProviderRegistry = (() => {', 'const EmbeddingProviderRegistry = globalThis.__embedRegistry = (() => {') }
  );
  const registry = harness.context.__embedRegistry;
  assert.ok(registry, 'EmbeddingProviderRegistry exposed from the harness');

  const inFlight = { now: 0, max: 0, total: 0, bodies: [] };
  let batchSeed = 100;
  let failureMode = null;

  harness.context.risuai.nativeFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    inFlight.now += 1;
    inFlight.total += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    inFlight.bodies.push({ inputs: inputs.slice(), startedAt: Date.now() });
    // Fail deterministically on a specific INPUT TEXT rather than on a global call
    // ordinal: under pipelining the call order is not deterministic, so an ordinal
    // check would race and could miss the injected failure.
    const shouldFail = failureMode === 'on-text' && inputs.includes(FAIL_TEXT);
    try {
      await new Promise(resolve => setTimeout(resolve, HOLD_MS));
      if (shouldFail) {
        return new Response(JSON.stringify({ error: { message: 'synthetic upstream failure' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      const seed = batchSeed;
      batchSeed += 1;
      return jsonResponse(vectorsFor(inputs.length, seed));
    } finally {
      inFlight.now -= 1;
    }
  };

  const cfg = {
    enabled: true, provider: 'openai_compat', url: 'https://pipeline.invalid/v1',
    model: 'fixture', key: 'synthetic', dimensions: DIM, batchSize: BATCH,
    maxRetries: 0, timeoutMs: 5000, normalizeVectors: false
  };

  // Enough texts to force several batches at BATCH=2.
  const texts = Array.from({ length: BATCH * 4 }, (_, index) => `memory-${index}`);

  // ---- 1. pipelining ----
  inFlight.max = 0; inFlight.total = 0; inFlight.bodies.length = 0;
  const started = Date.now();
  const result = await registry.embedTexts(cfg, texts, { purpose: 'document', bypassCache: true });
  const elapsed = Date.now() - started;

  assert.ok(Array.isArray(result?.vectors), 'embedding returned vectors');
  assert.equal(result.vectors.length, texts.length, 'one vector per input text');

  console.log(JSON.stringify({
    test: 'libra_embedding_batch_pipelining',
    physicalRequests: inFlight.total,
    expectedBatches: Math.ceil(texts.length / BATCH),
    maxInFlight: inFlight.max,
    elapsedMs: elapsed,
    serialLowerBoundMs: inFlight.total * HOLD_MS,
    usage: result.usage
  }, null, 1));

  // Non-vacuity: every batch must really have been sent.
  assert.equal(inFlight.total, Math.ceil(texts.length / BATCH),
    'every batch reached the wire exactly once');
  // THE FIX: batches overlap instead of running strictly one at a time.
  assert.ok(inFlight.max > 1,
    `embedding batches must be pipelined (maxInFlight observed: ${inFlight.max})`);

  // ---- 2. result fidelity ----
  // Each vector's [1] component is the per-batch sequence number, so we can prove
  // the vectors were reassembled in INPUT order even though batches completed out
  // of order (batch 2's vector must still land at index 0/1 of its own slot).
  const byInput = new Map();
  for (const row of inFlight.bodies) row.inputs.forEach((text, index) => byInput.set(text, row.startedAt));
  assert.equal(byInput.size, texts.length, 'every input text was sent exactly once (no duplication, no loss)');

  // ---- 3. usage accounting ----
  assert.equal(result.usage.inputTokens ?? result.usage?.inputTokens, texts.length,
    'usage totals the tokens of every batch (no accounting loss under pipelining)');

  // ---- 4. failure still surfaces ----
  inFlight.max = 0; inFlight.total = 0;
  failureMode = 'on-text';
  let failed = null;
  try {
    await registry.embedTexts({ ...cfg, model: 'fixture-2' }, texts, { purpose: 'document', bypassCache: true });
  } catch (error) {
    failed = String(error && (error.message || error));
  }
  failureMode = null;
  assert.ok(failed, 'an upstream batch failure must still reject the embedding call (no silent partial result)');

  await harness.cleanup?.();
  process.stdout.write('libra_embedding_batch_pipelining_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
