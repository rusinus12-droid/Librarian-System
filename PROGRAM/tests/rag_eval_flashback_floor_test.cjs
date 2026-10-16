'use strict';
// Retrieval-quality floor for Flashback on the shared Korean RAG fixture, using the
// offline synthetic embedder (not a real-provider quality claim). Guards the hybrid
// keyword boost and the keyword fallback against regressions.
const path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const tool = path.join(__dirname, '../tools/rag_eval/flashback_rag_eval.cjs');
const run = env => JSON.parse(execFileSync(process.execPath, [tool], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300000 }));

const normal = run({ RAG_EVAL_QUERY_FAILURE: '' });
assert.ok(normal.hitRate >= 0.9, `hybrid recall floor: ${normal.hitRate} misses=${normal.misses}`);
assert.equal(normal.families.name_number.hitRate, 1, 'names and numbers are found by the keyword boost');
assert.equal(normal.families.paraphrase.hitRate, 1, 'paraphrases are still found by the dense arm');
assert.ok(normal.embedding.recallCallsPerQuestion <= 1.1, 'one query embedding call per request');

const outage = run({ RAG_EVAL_QUERY_FAILURE: 'error' });
assert.ok(outage.hitRate >= 0.6, `keyword fallback floor during a provider outage: ${outage.hitRate}`);
assert.ok(outage.latencyMs.p50 < 1000, `cooldown keeps outage requests fast: ${JSON.stringify(outage.latencyMs)}`);
console.log(JSON.stringify({ test: 'rag_eval_flashback_floor', normal: normal.hitRate, outage: outage.hitRate, outageLatency: outage.latencyMs }));
