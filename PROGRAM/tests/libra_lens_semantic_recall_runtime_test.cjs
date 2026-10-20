'use strict';
// Lens recall in the canonical embedding space: note vectors are stored per lens after a run
// (int8 + scale), the query is embedded once and reused, a paraphrase with no shared words is
// recalled by meaning only when embeddings are on, unrelated input is not, a note the delivered
// canonical/Micro text already says is skipped, and every failure falls back to lexical recall.
// The embedding provider is a controlled concept embedder (no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const DIM = 64;
// Concepts stand in for meaning: words of one concept share a direction.
const CONCEPTS = [['몸 상태', '열이', '두통', '아프', '기침', '건강', '컨디션', '38도'], ['열쇠', '반환', '돌려', '약속'], ['비', '날씨', '창밖'], ['암호', '비밀', '속삭']];
const embed = text => {
  const vector = Array(DIM).fill(0);
  CONCEPTS.forEach((words, index) => { if (words.some(word => text.includes(word))) vector[index] += 1; });
  let h = 7; for (const char of text) h = (h * 31 + char.codePointAt(0)) >>> 0;
  vector[8 + (h % (DIM - 8))] += 0.35; // text-specific noise so unrelated texts are not identical
  return vector;
};
const config = { enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings', model: 'synthetic-concepts', key: 'synthetic-not-a-real-key', dimensions: DIM, maxRetries: 0 };
const provider = () => {
  const requests = []; let fail = false;
  const fetch = async (_url, init) => {
    const inputs = JSON.parse(init.body).input; requests.push(inputs);
    if (fail) throw new Error('synthetic embedding outage');
    return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: embed(text) })), usage: { total_tokens: 5 } }), { status: 200 });
  };
  return { requests, fetch, fail: value => { fail = value; } };
};
const setup = async ({ embeddings = true } = {}) => {
  const p = provider();
  const f = await lensFixture();
  f.r.context.risuai.nativeFetch = p.fetch;
  await f.api.saveEmbeddingSettings(embeddings ? config : { ...config, enabled: false });
  f.setReply({ items: [
    { label: '증상', text: '지호는 열이 38도까지 올랐다.', refs: ['t2-a'], basis: '본문 서술' },
    { label: '열쇠', text: '은빛 열쇠를 오늘 돌려주겠다고 했다.', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다' }
  ] });
  const lens = await f.add('몸 상태 기록', 'active');
  return { f, p, lens };
};
const PARAPHRASE = '요즘 컨디션은 괜찮아?'; // no bigram shared with either note

test('a run stores compact note vectors in the canonical embedding space', async () => {
  const { f, lens } = await setup();
  try {
    const storeKey = [...f.r.values.keys()].find(key => key.endsWith(`:lens:${lens.lensId}:vectors`));
    assert.ok(storeKey, 'the vector store is written after the run');
    const store = JSON.parse(f.r.values.get(storeKey));
    assert.equal(store.schema, 'libra.lens_vector_store.v1');
    assert.equal(Object.keys(store.entries).length, 2);
    assert.equal(store.dimensions, DIM);
    const entry = Object.values(store.entries)[0];
    assert.equal(Buffer.from(entry.q, 'base64').length, DIM, 'one byte per dimension');
    assert.ok(store.profileId, 'bound to the embedding profile');
    const again = plain(await f.api.refreshLensVectors({ lensId: lens.lensId }));
    assert.equal(again.embedded, 0, 'an unchanged note is not embedded twice');
  } finally { await f.close(); }
});

test('a paraphrase is recalled by meaning only with embeddings; unrelated input is not', async () => {
  const lexical = await setup({ embeddings: false });
  try {
    const result = plain(await lexical.f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.equal(result.renderedBlock, '', 'without embeddings the paraphrase finds nothing');
    assert.equal(result.semantic.status, 'embedding_disabled');
  } finally { await lexical.f.close(); }
  const { f, p } = await setup();
  try {
    const before = p.requests.length;
    const result = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.equal(result.semantic.status, 'ready');
    assert.match(result.renderedBlock, /열이 38도까지/, 'the health note is recalled by meaning');
    assert.doesNotMatch(result.renderedBlock, /열쇠/, 'the unrelated note is not');
    assert.equal(result.semantic.admittedBySemantic, 1);
    assert.ok(result.injectedItems[0].similarity >= 0.42 && result.injectedItems[0].lexicalOverlap === 0);
    assert.equal(p.requests.length - before, 1, 'one query embedding request');
    const repeat = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.equal(repeat.semantic.queryCached, true, 'the same input reuses the cached query vector');
    assert.equal(p.requests.length - before, 1);
    const unrelated = plain(await f.api.recallLensMemories({ query: '오늘 저녁 메뉴 추천해 줘', canonicalBudgetChars: 12000 }));
    assert.equal(unrelated.renderedBlock, '', 'meaning-unrelated input stays below the floor');
    const lexicalHit = plain(await f.api.recallLensMemories({ query: '은빛 열쇠 약속', canonicalBudgetChars: 12000 }));
    assert.match(lexicalHit.renderedBlock, /은빛 열쇠/, 'lexical recall still works with embeddings on');
    const off = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000, semantic: false }));
    assert.equal(off.renderedBlock, '');
    const registry = await f.api.getLensRegistry();
    await f.api.saveLensRegistry({ ...plain(registry), recallSemantic: false });
    const switchedOff = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.equal(switchedOff.semantic.status, 'off', 'the studio switch turns the semantic lane off');
    assert.equal(switchedOff.renderedBlock, '');
  } finally { await f.close(); }
});

test('delivered canonical/Micro text suppresses a note that repeats it', async () => {
  const { f } = await setup();
  try {
    const result = plain(await f.api.recallLensMemories({ query: '지호 열이 몇 도까지 올랐지', canonicalBudgetChars: 12000,
      deliveredText: '[정본] T2: 지호는 열이 38도까지 올랐다. 민아가 서재에 도착했다.' }));
    assert.doesNotMatch(result.renderedBlock, /38도/);
    assert.ok(result.skippedCandidates.some(row => row.reasonCode === 'covered_by_delivered_memory'));
    const partial = plain(await f.api.recallLensMemories({ query: '지호 열이 몇 도까지 올랐지', canonicalBudgetChars: 12000, deliveredText: '지호는 서재에 있었다.' }));
    assert.match(partial.renderedBlock, /38도/, 'a note that adds something is kept');
  } finally { await f.close(); }
});

test('failures and profile changes fall back to lexical recall and self-repair', async () => {
  const { f, p, lens } = await setup();
  try {
    p.fail(true);
    const outage = plain(await f.api.recallLensMemories({ query: '지호 열이 내렸어?', canonicalBudgetChars: 12000 }));
    assert.equal(outage.semantic.status, 'query_embedding_unavailable');
    assert.match(outage.renderedBlock, /38도/, 'an embedding outage falls back to lexical recall without throwing');
    p.fail(false);
    await f.api.saveEmbeddingSettings({ ...config, model: 'synthetic-concepts-v2' });
    const mismatch = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.equal(mismatch.semantic.scored, 0, 'vectors of another profile are never compared');
    assert.equal(mismatch.semantic.missingVectors, 2);
    await f.api.refreshLensVectors({ lensId: lens.lensId });
    const repaired = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.match(repaired.renderedBlock, /38도/, 'refreshed vectors restore meaning recall');
  } finally { await f.close(); }
});

test('inherited notes get vectors in the successor; purge removes the vector store', async () => {
  const { f, lens } = await setup();
  try {
    await f.api.prepareSessionHandoff({ transferId: 'semantic-1' });
    const next = f.target('승계');
    await f.api.adoptSessionHandoff({ transferId: 'semantic-1', targetChatId: next.id });
    const first = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.equal(first.semantic.missingVectors > 0, true, 'the successor has no vectors yet');
    await f.api.refreshLensVectors({ lensId: lens.lensId });
    const second = plain(await f.api.recallLensMemories({ query: PARAPHRASE, canonicalBudgetChars: 12000 }));
    assert.match(second.renderedBlock, /이전 대화[^\n]*38도/, 'an inherited note is recalled by meaning');
    await f.api.trashLens(lens.lensId);
    await f.api.purgeLens(lens.lensId);
    assert.equal([...f.r.values.keys()].filter(key => key.includes(`:lens:${lens.lensId}:vectors`)).length, 0);
  } finally { await f.close(); }
});

test('the actual request hook delivers a meaning-only lens note', async () => {
  const { f, p } = await setup();
  try {
    const before = p.requests.length;
    const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: PARAPHRASE }], 'model');
    const system = messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
    assert.match(system, /PERSPECTIVE NOTES[\s\S]*열이 38도까지/);
    const lensQueries = p.requests.slice(before).filter(inputs => inputs.length === 1 && inputs[0] === PARAPHRASE);
    assert.ok(lensQueries.length <= 2, `the lens query is embedded at most once beside canonical recall (${lensQueries.length})`);
  } finally { await f.close(); }
});
