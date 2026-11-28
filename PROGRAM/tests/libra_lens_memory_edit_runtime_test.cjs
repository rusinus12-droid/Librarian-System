'use strict';
// A stored Lens note can be corrected by the user. Only its own wording changes (text, label,
// interpretation basis); the quote, refs, time and people stay as verified against the source, the
// item keeps its id, the first original wording is kept, and recall serves the corrected text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const NOTE = { label: '증상', text: '지호의 왼손 손목이 붓고 아프다.', refs: ['t1-u'], basis: '손목을 감싸 쥐는 묘사', who: ['지호'], whoRef: 't2-a' };
const setup = async () => {
  const f = await lensFixture();
  f.setReply({ items: [NOTE] });
  const lens = await f.add('몸 상태', 'active', { trackSubject: true, cadence: { mode: 'manual' } });
  const notes = async () => plain(await f.api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId);
  return { f, lens, notes };
};

test('editing a lens note changes its wording, keeps its id and source fields, and recall serves the new text', async () => {
  const { f, lens, notes } = await setup();
  try {
    const [before] = await notes();
    assert.ok(before, 'the note was stored');
    assert.equal(before.evidenceLevel, 'interpreted');
    const result = await f.api.editLensMemory({ memoryId: before.id, recordId: before.recordId,
      text: '지호의 왼손 손목은 삐었을 뿐 붓기는 가라앉고 있다.', label: '부상', basis: '사용자가 직접 바로잡음' });
    assert.equal(result.ok, true); assert.equal(result.changed, true);
    const [after] = await notes();
    assert.equal(after.id, before.id, 'the item keeps its id, so closures and vectors still point at it');
    assert.equal(after.text, '지호의 왼손 손목은 삐었을 뿐 붓기는 가라앉고 있다.');
    assert.equal(after.label, '부상');
    assert.equal(after.basis, '사용자가 직접 바로잡음');
    assert.ok(after.editedAt, 'the reader can mark the note as edited');
    assert.deepEqual(after.original, { text: before.text, label: before.label, basis: before.basis });
    for (const field of ['refs', 'quote', 'quoteRef', 'who', 'when', 'turnRange', 'recordKey', 'recordId', 'evidenceLevel']) {
      assert.deepEqual(after[field], before[field], field + ' stays as verified');
    }
    const block = plain(await f.api.recallLensMemories({ query: '지호 손목 부상 상태', canonicalBudgetChars: 12000 })).renderedBlock;
    assert.match(block, /붓기는 가라앉고 있다/);
    assert.doesNotMatch(block, /붓고 아프다/);
    // A second edit keeps the first original wording.
    await f.api.editLensMemory({ memoryId: before.id, text: '지호의 손목은 다 나았다.' });
    const [twice] = await notes();
    assert.equal(twice.text, '지호의 손목은 다 나았다.');
    assert.equal(twice.original.text, before.text);
    const same = await f.api.editLensMemory({ memoryId: before.id, text: '지호의 손목은 다 나았다.' });
    assert.equal(same.changed, false, 'an unchanged edit writes nothing');
  } finally { f.close(); }
});

test('edits that would break a note or touch a record that moved on are refused', async () => {
  const { f, notes } = await setup();
  try {
    const [note] = await notes();
    await assert.rejects(() => f.api.editLensMemory({ memoryId: note.id, text: '   ' }), /비워 둘 수 없습니다/);
    await assert.rejects(() => f.api.editLensMemory({ memoryId: note.id, basis: '' }), /해석 근거가 있어야/);
    await assert.rejects(() => f.api.editLensMemory({ memoryId: note.id, text: 'x'.repeat(601) }), /600자/);
    await assert.rejects(() => f.api.editLensMemory({ memoryId: note.id, recordId: 'other', text: '새 내용' }), /그사이 바뀌었습니다/);
    await assert.rejects(() => f.api.editLensMemory({ memoryId: 'inherited::archive::rec::item', text: '새 내용' }), /수정할 수 없습니다/);
    const [unchanged] = await notes();
    assert.equal(unchanged.text, note.text);
    assert.equal(unchanged.editedAt, '');
  } finally { f.close(); }
});

test('the lens reader edits a note in place: 수정 opens a form, 저장 stores it and marks the card', { timeout: 60000 }, async () => {
  const { create, until } = require('./fixtures/libra_gui_memory_dom_host.cjs');
  const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const input = require('./fixtures/unified_vertical_source.json');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-lens-edit-')), pluginPath = path.join(temporary, 'LIBRA.js');
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8'), anchor = '  const publicApi = Object.freeze({\n    getHostLineageStatus:';
  assert.ok(source.includes(anchor));
  fs.writeFileSync(pluginPath, source.replace(anchor, '  globalThis.__lensEdit={core:LibraMemoryCore,Gui};\n' + anchor));
  let f;
  try {
    f = await create('LIBRA', 'Full', { pluginPath, initialChat: input.sourceRows.map(row => ({ role: row.role, chatId: row.ref, data: row.text })), host: { runLLMModel: async options => {
      const system = options.messages[0].content;
      if (system.includes('[LIBRA LENS ANALYZER')) return { type: 'success', result: JSON.stringify({ items: [{ label: '사건', text: '도서관의 설정을 기록했다.', refs: ['t1-a'], quote: input.sourceRows.find(row => row.ref === 't1-a').text.slice(0, 24) }] }) };
      return { type: 'success', result: JSON.stringify(artifact()) };
    } } });
    const { api, doc, context } = f, { core } = context.__lensEdit;
    assert.equal((await api.runManualColdStart()).completed, 1);
    const lens = await api.createLens({ name: '수정 확인 렌즈', instruction: { goal: '사건을 기록한다.' }, cadence: { mode: 'manual' }, evidenceMode: 'strict' });
    assert.equal((await core.runLensForRange({ lensId: lens.lensId, startTurn: 1, endTurn: 2 })).ok, true);
    await f.open();
    await until(() => doc.querySelector('.sidebar [data-go="memory"]'), 'LIBRA window', 10000);
    doc.querySelector('.sidebar [data-go="memory"]').click();
    await until(() => doc.querySelector('[data-memory-reader-kind="lens"]'), 'memory reader', 10000);
    doc.querySelector('[data-memory-reader-kind="lens"]').click();
    await until(() => doc.querySelector('[data-lens-row-toggle]'), 'lens row toggle', 10000);
    doc.querySelector('[data-lens-row-toggle]').click();
    await until(() => doc.querySelector('[data-lens-item-edit]'), 'lens edit button', 10000);
    doc.querySelector('[data-lens-item-edit]').click();
    await until(() => doc.querySelector('[data-lens-edit-form] [data-lens-edit-text]'), 'edit form', 10000);
    assert.equal(doc.querySelector('[data-lens-edit-text]').value, '도서관의 설정을 기록했다.');
    assert.equal(doc.querySelector('[data-lens-edit-basis]'), null, 'a quoted note has no basis field');
    const area = doc.querySelector('[data-lens-edit-text]');
    area.value = '도서관의 규칙을 사용자가 바로잡았다.';
    area.dispatchEvent(new context.Event('input', { bubbles: true }));
    doc.querySelector('[data-lens-edit-save]').click();
    await until(() => !doc.querySelector('[data-lens-edit-form]') && doc.querySelector('.lens-item__text')?.textContent.includes('사용자가 바로잡았다'), 'saved note', 10000);
    assert.ok(doc.querySelector('.lens-item').textContent.includes('직접 수정함'));
    // Cancel leaves the stored text alone.
    doc.querySelector('[data-lens-item-edit]').click();
    await until(() => doc.querySelector('[data-lens-edit-cancel]'), 'second form', 10000);
    doc.querySelector('[data-lens-edit-text]').value = '버릴 내용';
    doc.querySelector('[data-lens-edit-text]').dispatchEvent(new context.Event('input', { bubbles: true }));
    doc.querySelector('[data-lens-edit-cancel]').click();
    await until(() => !doc.querySelector('[data-lens-edit-form]'), 'form closed', 10000);
    assert.ok(doc.querySelector('.lens-item__text').textContent.includes('사용자가 바로잡았다'));
  } finally { await f?.close?.(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
