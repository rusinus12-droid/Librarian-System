'use strict';
// Capacity regression against the deployed storage bridge and real HTTP/SQLite server.
// The provider is controlled; 125 synthetic stored runs each hold 24 distinct notes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

for (const mode of ['server_only', 'mirror']) test(`${mode}: 3000 1024D vectors fit, resume after restart, and purge completely`, async () => {
  const s = await serverFixture({ mode });
  try {
    let f = s.f;
    f.control.onCall = async () => ({ type: 'success', result: JSON.stringify({ items: [{ label: '약속', text: '열쇠를 오늘 돌려주기로 했다.', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다' }] }) });
    const lens = await f.r.api.createLens({ name: '장기 채팅', instruction: { goal: '약속을 기록한다.' }, cadence: { mode: 'manual' } });
    await f.r.core.runLensForRange(lens.lensId, { startTurn: 1, endTurn: 5 });
    const row = s.storedRows().find(row => row.key.endsWith(`:lens:${lens.lensId}:records`));
    const records = structuredClone(row.value), template = Object.values(records.records)[0];
    records.records = {};
    for (let run = 0; run < 125; run += 1) {
      const record = structuredClone(template);
      record.recordKey = `main:t${run * 5 + 1}-t${run * 5 + 5}`;
      record.turnRange = { start: run * 5 + 1, end: run * 5 + 5 };
      record.items = Array.from({ length: 24 }, (_, index) => ({ ...template.items[0], itemId: `li_${run}_${index}`, text: `합성 약속 ${run} ${index}` }));
      records.records[record.recordKey] = record;
    }
    await s.mutate(row.key, records);
    let embedded = 0;
    s.hooks.externalFetch = async (_url, init) => {
      const inputs = JSON.parse(init.body).input; embedded += inputs.length;
      return new Response(JSON.stringify({ data: inputs.map((_text, index) => ({ index, embedding: Array.from({ length: 1024 }, (_, n) => n === 0 ? 1 : 0) })) }), { status: 200 });
    };
    await f.r.api.saveEmbeddingSettings({ enabled: true, provider: 'openai', url: 'https://synthetic.invalid/v1/embeddings', model: 'capacity1024', key: 'synthetic-key', dimensions: 1024, maxRetries: 0 });
    const result = await f.r.api.refreshLensVectors({ lensId: lens.lensId });
    assert.equal(result.ok, true);
    assert.equal(result.total, 3000);
    assert.equal(result.missing, 0);
    assert.equal(embedded, 3000);
    const all = s.storedRows().filter(row => row.key.includes(`:lens:${lens.lensId}:vectors`));
    assert.ok(all.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.value)), 0) > 4 * 1024 ** 2, 'the logical store exceeds the old single-value ceiling');
    for (const row of all) assert.ok(Buffer.byteLength(JSON.stringify(row.value)) <= 192 * 1024, `${row.key} stays byte-bounded`);
    const index = all.find(row => row.key.endsWith(':vectors')).value;
    assert.equal(index.pages.reduce((sum, page) => sum + page.count, 0), 3000);
    assert.equal(all.filter(row => row.value.schema === 'libra.lens_vector_page.v1').length, index.pages.length);
    const local = [...s.local.keys()].filter(key => key.includes(`:lens:${lens.lensId}:vectors`));
    assert.equal(local.length > 0, mode === 'mirror');
    f = await s.restart();
    assert.equal((await f.r.api.refreshLensVectors({ lensId: lens.lensId })).embedded, 0, 'restart reuses persisted pages');
    assert.equal(embedded, 3000, 'restart makes no additional provider calls');
    await f.r.api.trashLens(lens.lensId);
    await f.r.api.purgeLens(lens.lensId);
    assert.equal(s.storedRows().some(row => row.key.includes(`:lens:${lens.lensId}:vectors`)), false);
    assert.equal([...s.local.keys()].some(key => key.includes(`:lens:${lens.lensId}:vectors`)), false);
  } finally { await s.cleanup(); }
});
