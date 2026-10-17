'use strict';
// A query-embedding provider slower than the default 3.5 s budget: the first recall
// falls back to its lexical graph, the budget adapts, and the next recall is semantic.
// An explicit semanticPolicy.queryBudgetMs is never adapted.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings', model: 'text-embedding-3-small',
  key: 'synthetic-not-a-real-key', dimensions: 256, maxRetries: 0 };
const queries = ['keepsake custodian rendezvous', 'custodian of the keepsake', 'where the keepsake rests'];
const QUERY_DELAY_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async predicate => { for (let i = 0; i < 2000; i++) { if (await predicate()) return; await sleep(5); } throw Error('wait timed out'); };

(async () => {
  let slow = false;
  const fetch = async (_url, init) => {
    const inputs = JSON.parse(init.body).input;
    if (slow && inputs.length === 1 && queries.includes(inputs[0])) await sleep(QUERY_DELAY_MS);
    return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0) })),
      usage: { total_tokens: 5 } }), { status: 200 });
  };
  const host = await fixture({ mode: 'plugin_only', embeddingConfig: config, embeddingFetch: fetch });
  try {
    const api = host.f.r.api;
    await wait(() => !api.inspectMicroRepresentationVectors().warming);
    slow = true;
    const query = text => api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: text }, consumerPolicy: { maxUnits: 64 } });
    const first = await query(queries[0]);
    assert.equal(first.diagnostics.nativeSemantic.queryBudgetMs, 3500, 'the default budget starts at 3.5 s');
    assert.notEqual(first.diagnostics.nativeSemantic.status, 'available', 'a 5 s provider misses the default budget');
    assert.ok(first.bundle.items.length, 'the lexical graph still answers');
    const second = await query(queries[1]);
    assert.equal(second.diagnostics.nativeSemantic.queryBudgetMs, 7000, 'a timeout doubles the budget');
    assert.equal(second.diagnostics.nativeSemantic.status, 'available', 'the adapted budget admits the slow provider');
    const third = await query(queries[2]);
    const measured = third.diagnostics.nativeSemantic.queryBudgetMs;
    assert.ok(measured >= 7500 && measured <= 9000, 'measured latency sets the budget (1.5x the slowest): ' + measured);
    assert.equal(third.diagnostics.nativeSemantic.status, 'available');
    const explicit = await api.executeMemoryGraphUnifiedQuery({ queryInput: { queryText: 'keepsake rendezvous custodian' },
      semanticPolicy: { queryBudgetMs: 3500 }, consumerPolicy: { maxUnits: 64 } });
    assert.equal(explicit.diagnostics.nativeSemantic.queryBudgetMs, 3500, 'an explicit budget is kept');
    console.log('PASS adaptive query-embedding budget: lexical fallback, then semantic within the adapted budget');
  } finally { await host.cleanup(); }
})().catch(error => { console.error(error); process.exit(1); });
