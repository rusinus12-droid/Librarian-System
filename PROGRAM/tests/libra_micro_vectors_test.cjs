'use strict';
// Micro vectors. Each Micro turn's stored search text (the text the Micro index screens) is
// embedded in the background after a Micro publication, only for new or changed turns. Recall
// reads those vectors in its single dense scan and lets them rank Micro turns; it never embeds
// a document. The recent-work overview reports the real vector count instead of a fixed 0.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createEngine = require('../tools/libra_state_memory_engine.cjs');
const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the background Micro vectors');
};

const engine = createEngine({ fingerprint: value => value });

test('a stored Micro vector lets a turn match a query it shares no words with', () => {
  const index = new Map([[1, '등불'], [2, '은빛 열쇠를 돌려주기로 했다'], [3, '빵'], [4, '우산'], [5, '정원'], [6, '복도']]);
  const turns = [1, 2, 3, 4, 5, 6], query = '약속한 물건은 어떻게 됐지?';
  const plain = engine.rankMicroTurns({ turns, index, query, limit: 3 });
  assert.deepEqual(plain.turns, [6, 5, 4], 'without a vector only recency fills the shortlist');
  const dense = engine.rankMicroTurns({ turns, index, query, limit: 3, semanticScores: new Map([[2, 0.8]]) });
  assert.ok(dense.turns.includes(2), 'the dense match is read');
  assert.equal(dense.reasons[2], 'index_match');
  assert.equal(dense.matches, 1);
  assert.equal(dense.matchesRead, 1, 'a dense match counts toward the primary screening');
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

test('a Micro publication produces vectors in the background; recall uses them without embedding documents', async t => {
  const { fixture } = require('./fixtures/libra_direct_memory_reader_fixture.cjs');
  const embedded = [];
  const x = await fixture({
    mode: 'plugin_only',
    transformSource: source => {
      const marker = '    // END LIBRA STATE OWNER';
      assert.equal(source.split(marker).length, 2);
      return source.replace(marker, '    globalThis.__microVectors = { refreshMicroVectorsForContext, microVectorStore, resolveContext };\n' + marker);
    },
    embeddingConfig: { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
      model: 'text-embedding-3-small', key: 'synthetic-only-not-real', dimensions: 256, maxRetries: 0 },
    embeddingFetch: async (_url, init) => {
      const inputs = [].concat(JSON.parse(init.body).input);
      embedded.push(...inputs);
      return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })) }), { status: 200 });
    }
  });
  t.after(() => x.cleanup());
  const api = x.f.r.api, mv = x.f.r.context.__microVectors;
  const context = await mv.resolveContext(), scope = context.scope;

  // The publication's snapshot refresh embeds the Micro search text in the background.
  const store = await waitFor(async () => {
    const value = await mv.microVectorStore.load(scope);
    return Object.keys(value.entries).length ? value : null;
  }, 15000);
  assert.ok(Object.keys(store.entries).length >= 1, 'the published Micro turn has a vector');

  const again = await mv.refreshMicroVectorsForContext(context);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.embedded, 0, 'an unchanged Micro corpus embeds nothing');

  const overview = await api.getRecentWorkOverview({ expectedScopeKey: scope.scopeKey });
  const vectors = overview.jobs.find(job => job.id === 'embedding');
  const microPart = vectors.parts.find(part => part.id === 'micro');
  assert.ok(microPart.total >= 1);
  assert.equal(microPart.ready, microPart.total, `the overview counts real Micro vectors: ${vectors.headline}`);

  const beforeRecall = embedded.length;
  const result = await api.executeStateMemoryQuery({ queryInput: { queryText: '열쇠는 지금 누가 보관하지?' },
    consumerPolicy: { maxCharacters: 8000, maxUnits: 24 } });
  assert.equal(result.diagnostics.microVectors.used, true, JSON.stringify(result.diagnostics.microVectors));
  assert.equal(result.diagnostics.microVectors.status, 'ready');
  assert.equal(result.diagnostics.microVectors.missing, 0);
  assert.deepEqual(embedded.slice(beforeRecall), ['열쇠는 지금 누가 보관하지?'], 'recall embeds only its query');
});
