'use strict';
// State row vectors. A large State (at least 24 rows) ranks its anchors with stored row
// vectors; a small one is selected exactly as before. Vectors are produced after a State
// change, never on the recall path, and only changed rows are embedded again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createEngine = require('../tools/libra_state_memory_engine.cjs');
const createRuntime = require('../tools/libra_state_memory_runtime.cjs');

const engine = createEngine({ fingerprint: value => value });
const head = count => ({ throughTurn: 9, characters: Array.from({ length: count }, (_, index) =>
  ({ id: `c${index}`, name: `인물${index}`, condition: `상태 ${index}` })) });
const runtimeFor = (stateHead, stateScores) => {
  const calls = [];
  const frame = { head: stateHead, refs: [], turns: [], settings: {}, identity: 'id', owner: 'libra', scope: { scopeKey: 's' },
    worldlineId: 'main', stateKey: 'state', check() {},
    async semantic(query) {
      calls.push(query);
      return { scores: new Map(), stateScores, diagnostics: { status: 'ready', stateVectors: { rows: 30, scored: stateScores.size, missing: 0, status: 'ready' } } };
    },
    register() { return 'token'; }, async assertCurrent() {}, release() {} };
  return { calls, runtime: createRuntime({ engine, capture: async () => frame, fingerprint: value => value, authorityStore: new Map() }) };
};
const QUERY = '오늘 저녁 메뉴는 무엇이었지?';

test('a large State ranks its anchors with stored row vectors; a small State is unchanged', async () => {
  const large = head(80), target = engine.stateRows(large).find(row => row.text.includes('인물57 ')).text;
  const control = runtimeFor(large, new Map());
  const plain = await control.runtime.query({ queryInput: { queryText: QUERY }, consumerPolicy: { maxUnits: 8 } });
  assert.equal(plain.bundle.items.some(item => item.text.includes('인물57 —')), false, 'without a vector the row is not an anchor');
  control.runtime.release(plain);

  const { calls, runtime } = runtimeFor(large, new Map([[target, 0.9]]));
  const result = await runtime.query({ queryInput: { queryText: QUERY }, consumerPolicy: { maxUnits: 8 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, QUERY);
  assert.equal(calls[0].stateTexts.length, 80, 'the State row texts travel with the one semantic call');
  assert.ok(result.bundle.items.some(item => item.family === 'state' && item.text.includes('인물57 —')), 'the dense row becomes an anchor');
  assert.equal(result.diagnostics.stateVectors.used, true);
  runtime.release(result);

  const small = runtimeFor(head(10), new Map());
  const smallResult = await small.runtime.query({ queryInput: { queryText: QUERY } });
  assert.deepEqual(small.calls, [QUERY], 'a small State keeps the plain single-query call');
  assert.deepEqual(smallResult.diagnostics.stateVectors, { used: false, rows: 10 });
  small.runtime.release(smallResult);
});

// Deterministic 256-dimension vectors: equal texts are equal, distinct texts are near-orthogonal.
const vectorFor = text => {
  let seed = 2166136261;
  for (const char of String(text)) seed = Math.imul(seed ^ char.codePointAt(0), 16777619) >>> 0;
  return Array.from({ length: 256 }, () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296 - 0.5;
  });
};

test('row vectors are stored once, re-embedded only when a row changes, and read without embedding', async t => {
  const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const embedded = [];
  const f = await fixture({
    transformSource: source => {
      const marker = '    // END LIBRA STATE OWNER';
      assert.equal(source.split(marker).length, 2);
      return source.replace(marker, '    globalThis.__stateVectors = { refreshStateVectors, loadStateVectorStore, readStateSemanticCandidates, refreshStateVectorsForContext, resolveContext };\n' + marker);
    },
    host: { nativeFetch: async (_url, init) => {
      const inputs = [].concat(JSON.parse(init.body).input);
      embedded.push(...inputs);
      return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })) }), { status: 200 });
    } }
  });
  t.after(() => f.r.cleanup());
  await f.r.api.saveEmbeddingSettings({ enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
    model: 'text-embedding-3-small', key: 'synthetic-only-not-real', dimensions: 256, maxRetries: 0 });
  const sv = f.r.context.__stateVectors, context = await sv.resolveContext(), scope = context.scope;
  const texts = Array.from({ length: 30 }, (_, index) => `인물 · 인물${index} · 상태: 서재에서 기다리는 중 ${index}`);

  const first = await sv.refreshStateVectors(scope, texts);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.embedded, 30);
  const stored = await sv.loadStateVectorStore(scope);
  assert.equal(Object.keys(stored.entries).length, 30);
  assert.ok(stored.pages.length >= 1);
  assert.ok([...f.r.values.keys()].some(storageKey => storageKey.endsWith(':state-vector:v1')), 'the store lives under the chat scope');

  const changed = texts.slice(); changed[3] = '인물 · 인물3 · 상태: 정원으로 나갔다';
  const before = embedded.length;
  const second = await sv.refreshStateVectors(scope, changed);
  assert.equal(second.embedded, 1, 'only the changed row is embedded again');
  assert.equal(second.total, 30);
  assert.deepEqual(embedded.slice(before), [changed[3]]);
  assert.equal((await sv.refreshStateVectors(scope, changed)).embedded, 0, 'an unchanged State embeds nothing');

  const beforeRecall = embedded.length;
  const semantic = await sv.readStateSemanticCandidates(context, { semanticAllowed: true, refs: [] },
    { text: changed[17], stateTexts: [...changed, '인물 · 새 인물 · 상태: 방금 등장'] });
  assert.equal(semantic.diagnostics.stateVectors.status, 'ready');
  assert.ok(semantic.stateScores.get(changed[17]) > 0.9, 'the matching row scores');
  assert.equal(semantic.stateScores.size, 1, 'unrelated rows do not score');
  assert.equal(semantic.diagnostics.stateVectors.missing, 1, 'a row without a vector is reported, not embedded');
  assert.deepEqual(embedded.slice(beforeRecall), [changed[17]], 'recall embeds only its query, never a document');

  const small = await sv.refreshStateVectorsForContext(context);
  assert.equal(small.skipped, 'small_state', 'the fixture State is below the row threshold');
});
