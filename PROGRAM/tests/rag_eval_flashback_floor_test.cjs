'use strict';
// Retrieval-quality floor for Flashback on the shared Korean RAG fixture, using the
// offline synthetic embedder (not a real-provider quality claim). Guards the hybrid
// keyword boost and the keyword fallback against regressions.
const path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const tool = path.join(__dirname, '../tools/rag_eval/flashback_rag_eval.cjs');
const run = (env, args = []) => JSON.parse(execFileSync(process.execPath, [tool, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 300000 }));

const normal = run({ RAG_EVAL_QUERY_FAILURE: '' });
assert.equal(normal.hitRate, 1, `hybrid recall: ${normal.hitRate} misses=${normal.misses}`);
assert.equal(normal.families.name_number.hitRate, 1, 'names and numbers are found by the keyword boost');
assert.equal(normal.families.paraphrase.hitRate, 1, 'paraphrases are still found by the dense arm');
assert.ok(normal.embedding.recallCallsPerQuestion <= 1.1, 'one query embedding call per request');

const outage = run({ RAG_EVAL_QUERY_FAILURE: 'error' });
assert.ok(outage.hitRate >= 0.6, `keyword fallback floor during a provider outage: ${outage.hitRate}`);
assert.ok(outage.latencyMs.p50 < 1000, `cooldown keeps outage requests fast: ${JSON.stringify(outage.latencyMs)}`);
// server_only storage with a slow link while the host sends only recent turns: a
// background owner write landing during recall is retried, never delivered as nothing.
const server = run({ RAG_EVAL_QUERY_FAILURE: '', RAG_EVAL_SERVER_RTT_MS: '10' }, ['--server', '--visible', '4']);
assert.equal(server.storage.localScopeKeys, 0, 'server_only keeps no local scope rows');
assert.equal(server.availableRate, 1, `server_only available memory: ${server.availableRate} misses=${server.misses}`);
assert.ok(!server.misses.some(miss => /skipped:/.test(miss)), `no recall was skipped: ${server.misses}`);
console.log(JSON.stringify({ test: 'rag_eval_flashback_floor', normal: normal.hitRate, outage: outage.hitRate, outageLatency: outage.latencyMs,
  server: server.availableRate, serverLatency: server.latencyMs }));
