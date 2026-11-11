'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { seedSnapshot, finalProofFixture, GRAPH_FACT } = require('./fixtures/libra_associative_final_proof_fixture.cjs');
const queries = ['Is the auxiliary entrance undergoing a safety inspection?', '予備の入口は安全点検中ですか？'];
let seed;
const snapshot = () => seed ||= seedSnapshot();
const options = queryText => ({ queryText, consumerPolicy: { maxCharacters: 12000, maxUnits: 24 } });
const expose = source => source.replace('stateMemoryRuntime = createLibraStateMemoryRuntime(',
  'globalThis.__semanticAuthorities = memoryEvidenceAuthority; stateMemoryRuntime = createLibraStateMemoryRuntime(');
async function fixture(t, behavior = 'ready', transform = x => x) {
  const counts = { query: 0, document: 0 };
  const f = await finalProofFixture(await snapshot(), false, { transformSource: source => expose(transform(source)), host: {
    nativeFetch: async (_url, init) => {
      const body = JSON.parse(init.body), inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (inputs.some(text => queries.includes(text))) counts.query++;
      else { counts.document++; throw Error('search must not embed documents'); }
      if (behavior === 'hang') return new Promise(() => {});
      if (behavior === 'failed') throw Error('synthetic embedding service unavailable');
      const vector = Array(256).fill(0); vector[101] = 1;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: behavior === 'dimensions' ? [1,0] : vector }] }), { status: 200 });
    }
  } });
  t.after(() => f.r.cleanup());
  f.control.onCall = async () => { throw Error('search must not call a generative model'); };
  return { f, counts, query: text => f.r.api.executeStateMemoryQuery(options(text)) };
}

test('English and Japanese query vectors find Korean canonical evidence beyond the lexical shortlist; repeat queries reuse cache', async t => {
  const { f, counts, query } = await fixture(t);
  const sparse = await f.r.api.executeStateMemoryQuery({ ...options(queries[0]), semantic: false });
  assert.equal(sparse.guiSearch.sourceKeys.includes(f.graphRef.key), false);
  for (const text of queries) {
    const result = await query(text);
    assert.equal(result.diagnostics.semantic.status, 'ready', JSON.stringify(result.diagnostics.semantic));
    assert.ok(result.diagnostics.semantic.selected > 0, JSON.stringify(result.diagnostics.semantic));
    assert.ok(result.bundle.items.some(row => row.family === 'canonical' && row.sourceKey === f.graphRef.key && row.text.includes(GRAPH_FACT)));
    assert.ok(result.guiSearch.sourceKeys.includes(f.graphRef.key), 'GUI includes dense-only matches');
    assert.equal(result.bundle.items.some(row => row.family === 'lore'), false);
  }
  assert.equal(counts.query, 2); assert.equal(counts.document, 0);
  const warm = await query(queries[0]);
  assert.equal(warm.diagnostics.semantic.queryCached, true);
  assert.equal(warm.diagnostics.semantic.queryRequests, 0);
  assert.equal(counts.query, 2);
  assert.equal(warm.bundle.budget.familyAllocation.lens.weight, 40);
});

test('without embeddings the same corpus remains searchable and makes no embedding request', async t => {
  const { f, counts } = await fixture(t);
  await f.r.api.saveEmbeddingSettings({ ...await f.r.api.getEmbeddingSettings(), enabled: false });
  const result = await f.r.api.executeStateMemoryQuery(options('은빛 열쇠'));
  assert.equal(result.diagnostics.semantic.status, 'disabled');
  assert.ok(result.bundle.items.length > 0);
  assert.equal(counts.query + counts.document, 0);
});

for (const behavior of ['failed','dimensions','hang']) test('optional embedding ' + behavior + ' falls back to basic recall', async t => {
  const { f, counts, query } = await fixture(t, behavior, source => source.replace('const STATE_SEMANTIC_DEADLINE_MS = 2500;', 'const STATE_SEMANTIC_DEADLINE_MS = 50;'));
  const started = Date.now(), result = await query(queries[0]);
  assert.ok(['failed','timeout'].includes(result.diagnostics.semantic.status), JSON.stringify(result.diagnostics.semantic));
  assert.ok(result.bundle.items.length > 0);
  assert.ok(Date.now() - started < 3000, 'the optional provider cannot block recall');
  assert.equal(counts.document, 0);
  const control = await f.r.api.executeStateMemoryQuery({ ...options(queries[0]), semantic: false });
  assert.deepEqual(result.bundle.items.map(row => row.id), control.bundle.items.map(row => row.id));
});

test('a semantic selection keeps vector and embedding-configuration currentness checks at delivery', async t => {
  const { f } = await fixture(t);
  const result = await f.r.core.executeStateMemoryQuery(options(queries[0]));
  const authority = f.r.context.__semanticAuthorities.get(result); t.after(() => authority.release());
  const vectorKey = f.getMemory(6).embedding.vectorKey;
  const raw = f.r.values.get(vectorKey), value = JSON.parse(raw);
  f.r.values.set(vectorKey, JSON.stringify({ ...value, changedForTest: true }));
  await assert.rejects(() => authority.validatePacket(result.packet), /CHANGED/);
  f.r.values.set(vectorKey, raw);
  await authority.validatePacket(result.packet);
  await f.r.api.saveEmbeddingSettings({ ...await f.r.api.getEmbeddingSettings(), enabled: false });
  await assert.rejects(() => authority.validatePacket(result.packet), /SEMANTIC_CONFIG_CHANGED/);
});

test('mismatched source text hashes cannot boost canonical rows', async t => {
  const { f, query } = await fixture(t);
  const key = f.getMemory(6).embedding.vectorKey, record = JSON.parse(f.r.values.get(key));
  for (const entry of Object.values(record.entries)) entry.textHash = 'another-source';
  f.r.values.set(key, JSON.stringify(record));
  const result = await query(queries[0]);
  assert.equal(result.diagnostics.semantic.selected, 0);
});

test('same-sized vectors from another model are excluded and the query cache is invalidated', async t => {
  const { f, query, counts } = await fixture(t);
  assert.ok((await query(queries[0])).diagnostics.semantic.selected > 0);
  await f.r.api.saveEmbeddingSettings({ ...await f.r.api.getEmbeddingSettings(), model: 'other-synthetic-model' });
  const result = await query(queries[0]);
  assert.equal(result.diagnostics.semantic.queryCached, false);
  assert.equal(result.diagnostics.semantic.selected, 0);
  assert.ok(result.diagnostics.semantic.missing > 0);
  assert.equal(counts.query, 2); assert.equal(counts.document, 0);
});

test('bounded vector screening reports partial coverage without building anything', async t => {
  const { query, counts } = await fixture(t, 'ready', source => source.replace('const STATE_SEMANTIC_VECTOR_LIMIT = 128;', 'const STATE_SEMANTIC_VECTOR_LIMIT = 2;'));
  const result = await query(queries[0]);
  assert.equal(result.diagnostics.semantic.scanned, 2);
  assert.equal(result.diagnostics.semantic.total, 10);
  assert.equal(result.diagnostics.semantic.limited, true);
  assert.ok(result.bundle.items.length > 0);
  assert.equal(counts.document, 0);
});

test('a timed-out vector batch cannot resume individual reads after recall has fallen back', async t => {
  const { f, query } = await fixture(t, 'ready', source => source
    .replace('const STATE_SEMANTIC_DEADLINE_MS = 2500;', 'const STATE_SEMANTIC_DEADLINE_MS = 50;')
    .replace('readFrame = await openNativeReadFrame(scanScope);', `readFrame = await openNativeReadFrame(scanScope);
      const originalFrame = readFrame;
      readFrame = { close: () => originalFrame.close(), prefetch: async keys => {
        await originalFrame.prefetch(keys);
        await new Promise(resolve => { globalThis.__releaseSemanticBatch = resolve; });
      } };`)
    .replace('await storage.getVerifiedJson(row.key, scanScope, null)',
      'await (globalThis.__semanticBodyReads = (globalThis.__semanticBodyReads || 0) + 1, storage.getVerifiedJson(row.key, scanScope, null))'));
  const result = await query(queries[0]);
  assert.equal(result.diagnostics.semantic.status, 'timeout');
  assert.equal(typeof f.r.context.__releaseSemanticBatch, 'function');
  assert.equal(f.r.context.__semanticBodyReads || 0, 0);
  f.r.context.__releaseSemanticBatch();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.r.context.__semanticBodyReads || 0, 0);
  assert.ok(result.bundle.items.length > 0);
});

for (const mode of ['mirror','server_only']) test(mode + ': stored document vectors serve real owner reads without query-time writes', async t => {
  const { fixture } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
  const counts = { query: 0, document: 0 };
  const x = await fixture({ mode, includeMicro: false, pauseAutomaticAnalysis: true,
    embeddingConfig: { enabled: true, provider: 'openai', model: 'text-embedding-3-small', dimensions: 256,
      key: 'synthetic-only', url: 'https://synthetic.invalid/v1/embeddings', maxRetries: 0 },
    embeddingFetch: async (_url, init) => {
      const body = JSON.parse(init.body), inputs = Array.isArray(body.input) ? body.input : [body.input];
      counts[inputs.some(text => queries.includes(text)) ? 'query' : 'document']++;
      return new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1,...Array(255).fill(0)] })) }), { status: 200 });
    } });
  t.after(() => x.cleanup());
  assert.ok(counts.document > 0, 'the normal producer persisted actual vectors');
  const documents = counts.document, start = x.server.requests.length;
  for (let n = 0; n < 2; n++) {
    const result = await x.f.r.api.executeStateMemoryQuery(options(queries[0]));
    assert.equal(result.diagnostics.semantic.status, 'ready', JSON.stringify(result.diagnostics.semantic));
    assert.ok(result.diagnostics.semantic.selected > 0);
    assert.equal(result.diagnostics.semantic.queryCached, n > 0);
  }
  assert.equal(counts.query, 1); assert.equal(counts.document, documents);
  assert.equal(x.server.requests.slice(start).some(row => /\/v1\/kv\/(batch|set|remove)$/.test(row.url)), false);
});
