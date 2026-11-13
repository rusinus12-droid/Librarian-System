'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

test('lens reader keeps excluded notes in a separate selectable list and deletes only confirmed stale notes', async () => {
  const { window } = new JSDOM('<div id="app"></div>');
  const { document } = window;
  const seam = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
  const f = await lensFixture({
    contextGlobals: { document, window, MutationObserver: window.MutationObserver },
    transformSource: raw => {
      const source = raw.replace(/\r\n/g, '\n');
      assert.ok(source.includes(seam));
      return source.replace(seam, '  globalThis.__lensUi={Gui,buildBookLensReaderProjection,loadLensReaderData,refreshGuiSnapshot};\n' + seam);
    }
  });
  try {
    const { Gui, buildBookLensReaderProjection, loadLensReaderData, refreshGuiSnapshot } = f.r.context.__lensUi;
    f.setReply({ items: [
      { label: '약속', text: '되돌린 열쇠 약속', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다' },
      { label: '관찰', text: '되돌린 열쇠 관찰', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다' }
    ] });
    await f.add('되돌린 기록');
    const original = f.chat.message[3].data;
    f.chat.message[3].data = '원문을 되돌린 후의 새 응답입니다.';
    f.setReply({ items: [{ label: '관찰', text: '현재 기록', refs: ['t2-a'], quote: '원문을 되돌린 후의 새 응답입니다.' }] });
    await f.add('현재 기록');
    const inspected = await f.api.inspectScopeLenses();
    const excluded = inspected.memories.filter(item => item.sourceCurrent === false);
    assert.equal(excluded.length, 2);
    assert.equal(inspected.memories.filter(item => item.sourceCurrent).length, 1);

    Gui.app = document.querySelector('#app');
    Gui.bookPage = 'memory';
    Gui.bookMemoryKind = 'lens';
    const render = () => Gui.app.replaceChildren(buildBookLensReaderProjection());
    await loadLensReaderData(true);
    render();
    const cards = () => [...Gui.app.querySelectorAll('.lens-item__text')].map(node => node.textContent);
    assert.deepEqual(cards(), ['현재 기록']);
    const categories = () => [...Gui.app.querySelectorAll('[aria-label="렌즈 기록 범주"] button')];
    assert.equal(categories()[1].textContent, '제외 2');
    categories()[1].click();
    render();
    assert.deepEqual(cards().sort(), ['되돌린 열쇠 관찰', '되돌린 열쇠 약속']);
    const all = () => Gui.app.querySelector('[data-lens-excluded-select-all]');
    const checks = () => [...Gui.app.querySelectorAll('[data-lens-excluded-select]')];
    const remove = () => Gui.app.querySelector('[data-lens-excluded-delete]');
    assert.equal(remove().disabled, true);
    all().click();
    assert.ok(checks().every(node => node.checked));
    all().click();
    assert.ok(checks().every(node => !node.checked));
    checks()[0].click();
    assert.equal(all().indeterminate, true);
    checks()[0].click();
    assert.equal(all().indeterminate, false);
    all().click();
    checks()[1].click();
    const selectedId = checks()[0].dataset.lensExcludedSelect;

    Gui.visible = true;
    remove().click();
    Gui.app.querySelector('[data-operation-confirm-execute]').click();
    await waitFor(() => Gui.lensReader.excludedNotice && !Gui.lensReader.deletingExcluded);
    render();
    assert.equal(cards().length, 1, Gui.lensReader.excludedNotice);
    const remaining = await f.api.inspectScopeLenses();
    assert.ok(!remaining.memories.some(item => item.id === selectedId));
    assert.ok(remaining.memories.some(item => item.text === '현재 기록'));
    assert.equal(remaining.memories.filter(item => item.sourceCurrent === false).length, 1);
    assert.match(Gui.app.textContent, /1개 삭제했습니다/);

    checks()[0].click();
    remove().click();
    f.chat.message[3].data = original;
    Gui.app.querySelector('[data-operation-confirm-execute]').click();
    await waitFor(() => /상태가 바뀌었습니다/.test(Gui.lensReader.excludedNotice) && !Gui.lensReader.deletingExcluded);
    const restored = await f.api.inspectScopeLenses();
    assert.ok(restored.memories.some(item => item.sourceCurrent && item.text.startsWith('되돌린 열쇠')));
    await loadLensReaderData(true);
    render();
    categories()[0].click();
    render();
    assert.equal(cards().length, 1);
    assert.match(cards()[0], /^되돌린 열쇠/);

    const rollback = await f.api.rollbackWorldManagerState({ throughTurn: 0 });
    assert.equal(rollback.ok, true);
    await refreshGuiSnapshot(false);
    render();
    assert.deepEqual(cards(), []);
    await waitFor(() => !Gui.lensReader.loading);
    render();
    assert.deepEqual(cards(), []);
    assert.equal(categories()[1].textContent, '제외 2');
  } finally {
    await f.close();
    window.close();
  }
});
