'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const body = '오른손 손목이 계속 욱신거려 움직이기 어렵다.';
const sentence = `어제 지호는 ${body}`;
const vectorConfig = dimensions => ({ enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings',
  model: 'merge-regression', key: 'synthetic-key', dimensions, maxRetries: 0 });
const indexOf = (f, lensId) => {
  const key = [...f.r.values.keys()].find(key => key.endsWith(`:lens:${lensId}:vectors`));
  const index = key ? JSON.parse(f.r.values.get(key)) : null;
  return { key, index, entries: index?.pages?.flatMap(ref => Object.entries(JSON.parse(f.r.values.get(`${key}:page:${ref.id}`)).entries)) || [] };
};
const seedNotes = async (f, total) => {
  const lens = await f.add();
  const key = [...f.r.values.keys()].find(key => key.endsWith(`:lens:${lens.lensId}:records`));
  const store = JSON.parse(f.r.values.get(key)), template = Object.values(store.records)[0];
  store.records = {};
  for (let offset = 0; offset < total; offset += 24) {
    const record = structuredClone(template);
    record.recordKey = `main:t${offset + 1}-t${offset + 5}`;
    record.items = Array.from({ length: Math.min(24, total - offset) }, (_, index) => ({ ...template.items[0], itemId: `li_${offset + index}`, text: `렌즈 메모 ${offset + index}` }));
    store.records[record.recordKey] = record;
  }
  f.r.values.set(key, JSON.stringify(store));
  return lens;
};
const provider = (f, dimensions = 64) => {
  const state = { accepted: [], failAfter: Infinity };
  f.r.context.risuai.nativeFetch = async (_url, init) => {
    const input = JSON.parse(init.body).input;
    if (state.accepted.length >= state.failAfter) throw Error('controlled provider outage');
    state.accepted.push(...input);
    return new Response(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: Array.from({ length: dimensions }, (_, n) => n === 0 ? 1 : 0) })) }), { status: 200 });
  };
  return state;
};

test('delivery coverage preserves separately tracked people/time and unknown identity', async () => {
  const f = await lensFixture({ beforeRun: f => { f.chat.message[0].data += ` ${sentence} 오늘 민아는 ${body}`; } });
  try {
    f.setReply({ items: [{ label: '증상', text: body, refs: ['t1-u'], quote: sentence, who: ['지호'], when: '어제' }] });
    const lens = await f.add('손목', 'active', { trackSubject: true, trackTime: true });
    const recall = deliveredText => f.api.recallLensMemories({ query: '어제 지호 오른손 손목', canonicalBudgetChars: 12000, semantic: false, deliveredText });
    for (const text of [`오늘 민아는 ${body}`, `오늘 지호는 ${body}`, `어제 민아는 ${body}`, sentence]) {
      assert.equal((await recall(text)).injectedItems.length, 1, 'a bare note body does not certify delivery of its separately stored identity');
    }
    f.setReply({ items: [{ label: '증상', text: sentence, refs: ['t1-u'], quote: sentence, who: ['지호'], when: '어제' }] });
    await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    assert.equal((await recall(`[정본] ${sentence}`)).injectedItems.length, 0, 'a complete exact sentence containing the same identity is redundant');
    assert.equal((await recall(`오늘 지호는 ${body}`)).injectedItems.length, 1);
    assert.equal((await recall(`어제 지호는 ${body.replace('어렵다', '어렵지 않다')}`)).injectedItems.length, 1, 'near-identical opposite meaning is not coverage');
    f.setReply({ items: [{ label: '증상', text: sentence, refs: ['t1-u'], quote: sentence }] });
    await f.api.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    assert.equal((await recall(sentence)).injectedItems.length, 1, 'unknown person/time cannot certify the same event');
  } finally { await f.close(); }
});

test('individual Japanese names keep internal と while explicit lists still split', async () => {
  const f = await lensFixture();
  try {
    const result = plain(f.api.evaluateLensCandidateItems({ items: [{ text: '全員が来た。', label: '到着', refs: ['t1-u'], basis: '本文', who: ['ひとみ', 'さとし', 'ことね', 'まこと'] }] },
      { trackSubject: true, evidenceMode: 'interpretive' }, [{ turn: 1, user: { text: 'ひとみ、さとし、ことね、まことが来た。' }, assistant: { text: '全員が座った。' } }]));
    assert.deepEqual(result.acceptedItems[0].who.map(person => person.name), ['ひとみ', 'さとし', 'ことね', 'まこと']);
    assert.equal(result.acceptedItems[0].whoIssue, '');
    const list = plain(f.api.evaluateLensCandidateItems({ items: [{ text: '二人が来た。', refs: ['t1-u'], basis: '本文', who: ['ひとみ、さとし'] }] },
      { trackSubject: true, evidenceMode: 'interpretive' }, [{ turn: 1, user: { text: 'ひとみとさとしが来た。' }, assistant: { text: '二人が座った。' } }]));
    assert.deepEqual(list.acceptedItems[0].who.map(person => person.name), ['ひとみ', 'さとし']);
  } finally { await f.close(); }
});

test('successful vector batches survive provider failure and resume without re-embedding', async () => {
  const f = await lensFixture();
  try {
    const lens = await seedNotes(f, 80), p = provider(f);
    await f.api.saveEmbeddingSettings(vectorConfig(64));
    p.failAfter = 32;
    const failed = await f.api.refreshLensVectors({ lensId: lens.lensId });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /outage|embedding/i);
    assert.equal(indexOf(f, lens.lensId).entries.length, 32, 'the first completed batch is durable');
    p.failAfter = Infinity;
    const retry = plain(await f.api.refreshLensVectors({ lensId: lens.lensId }));
    assert.equal(retry.embedded, 48);
    assert.equal(retry.total, 80);
    assert.equal(new Set(p.accepted).size, 80);
    assert.equal(p.accepted.length, 80, 'no completed note is paid for again');
    assert.equal((await f.api.refreshLensVectors({ lensId: lens.lensId })).embedded, 0);
  } finally { await f.close(); }
});

test('legacy vectors migrate without provider calls; a missing page alone is repaired', async () => {
  const f = await lensFixture();
  try {
    const lens = await seedNotes(f, 40), p = provider(f);
    await f.api.saveEmbeddingSettings(vectorConfig(64));
    await f.api.refreshLensVectors({ lensId: lens.lensId });
    const before = indexOf(f, lens.lensId);
    f.r.values.set(before.key, JSON.stringify({ ...before.index, schema: 'libra.lens_vector_store.v1', pages: undefined, entries: Object.fromEntries(before.entries) }));
    assert.equal((await f.api.refreshLensVectors({ lensId: lens.lensId })).embedded, 0);
    const migrated = indexOf(f, lens.lensId);
    assert.equal(migrated.index.schema, 'libra.lens_vector_store.v2');
    assert.equal(migrated.entries.length, 40);
    assert.equal(p.accepted.length, 40);
    const missing = migrated.index.pages[0];
    f.r.values.delete(`${before.key}:page:${missing.id}`);
    const repaired = await f.api.refreshLensVectors({ lensId: lens.lensId });
    assert.equal(repaired.embedded, missing.count);
    assert.equal(indexOf(f, lens.lensId).entries.length, 40);
  } finally { await f.close(); }
});

test('failed page publication preserves the prior checkpoint and purge removes every page', async () => {
  const f = await lensFixture();
  try {
    const lens = await seedNotes(f, 80);
    provider(f);
    await f.api.saveEmbeddingSettings(vectorConfig(64));
    const storage = f.r.context.risuai.pluginStorage, write = storage.setItem;
    let blocked = false;
    storage.setItem = async (key, value) => {
      if (key.endsWith(`:lens:${lens.lensId}:vectors`) && JSON.parse(value).pages.length > 1) { blocked = true; throw Error('controlled index write failure'); }
      return write.call(storage, key, value);
    };
    assert.equal((await f.api.refreshLensVectors({ lensId: lens.lensId })).ok, false);
    assert.equal(blocked, true);
    assert.equal(indexOf(f, lens.lensId).entries.length, 32);
    storage.setItem = write;
    assert.equal((await f.api.refreshLensVectors({ lensId: lens.lensId })).embedded, 48);
    await f.api.trashLens(lens.lensId);
    await f.api.purgeLens(lens.lensId);
    assert.equal([...f.r.values.keys()].some(key => key.includes(`:lens:${lens.lensId}:vectors`)), false);
  } finally { await f.close(); }
});

test('concurrent refreshes coalesce and an in-flight refresh cannot recreate a purged lens', async () => {
  const f = await lensFixture(); let release = () => {};
  try {
    const lens = await seedNotes(f, 16), p = provider(f);
    await f.api.saveEmbeddingSettings(vectorConfig(64));
    const fetch = f.r.context.risuai.nativeFetch;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let blocked = false;
    f.r.context.risuai.nativeFetch = async (...args) => {
      if (!blocked) { blocked = true; entered(); await gate; }
      return await fetch(...args);
    };
    const first = f.api.refreshLensVectors({ lensId: lens.lensId });
    await started;
    const second = f.api.refreshLensVectors({ lensId: lens.lensId });
    await f.api.trashLens(lens.lensId);
    await f.api.purgeLens(lens.lensId);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results.every(result => result.ok === false), true);
    assert.equal(results.every(result => result.reason === 'lens_not_found'), true);
    assert.equal(p.accepted.length, 16, 'two refresh callers share one provider batch');
    assert.equal([...f.r.values.keys()].some(key => key.includes(`:lens:${lens.lensId}:`)), false);
  } finally { release(); await f.close(); }
});
