'use strict';
// Entire emitted plugin, real DOM events, synthetic host and storage only.
const assert = require('node:assert/strict');
const path = require('node:path');
const { create, pause, until } = require('./fixtures/libra_gui_memory_dom_host.cjs');
const pluginPath = process.argv[2] || path.resolve(__dirname, '../plugins/LIBRA.js');
const results = [];
const sessions = [];
const field = (s, label) => [...s.doc.querySelectorAll('.page[data-page="settings"] .field,.page[data-page="settings"] .setting')]
  .find(node => (node.querySelector('label')?.textContent === label || node.querySelector('.setting__name')?.textContent === label))?.querySelector('input,select,textarea');
async function input(s, label, value) {
  const node = field(s, label);
  assert.ok(node, `field exists: ${label}`);
  node.value = String(value);
  node.dispatchEvent(new s.dom.window.Event('input', { bubbles: true }));
  await pause(25);
}
async function boot(options = {}) {
  const s = await create('LIBRA', 'Full', { ...options, pluginPath });
  sessions.push(s);
  await s.open(); await pause(250);
  await s.click('.sidebar [data-go="settings"]');
  await s.click('.setnav [data-subtab="mem"]');
  const maintenance=s.doc.querySelector('[data-memory-maintenance]');maintenance.open=true;maintenance.dispatchEvent(new s.dom.window.Event('toggle'));await pause(40);
  return s;
}
async function save(s, dedicated = false) {
  if (dedicated) {
    const button = [...s.doc.querySelectorAll('button')].find(n => n.textContent === '리콜 · 최근 대화 설정 저장');
    assert.ok(button, 'dedicated save remains reachable'); button.click();
  } else s.doc.querySelector('[data-settings-room-save]').click();
  await until(() => !s.doc.querySelector('[data-settings-room-save]').disabled, 'save settles');
  await pause(100);
}
async function test(name, fn) {
  const start = sessions.length;
  try { await fn(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.stack }); }
  finally {
    for (const s of sessions.splice(start)) {
      if (s.wire.length || s.errors.length) results.push({ name: name + ' safety', status: 'FAIL', wire: s.wire, errors: s.errors });
      await s.close();
    }
  }
  console.log(JSON.stringify(results.at(-1)));
}
(async () => {
  await test('numeric memory edit marks dirty without changing live settings; revert restores all fields', async () => {
    const s = await boot();
    assert.equal(field(s, '통합 검색 최대 근거 수').value, '24');
    await input(s, '통합 검색 최대 근거 수', 17);
    assert.equal(s.api.debugGuiSettingsState().dirty, true);
    assert.equal(s.doc.querySelector('[data-settings-room-revert]').disabled, false);
    assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits, 24, 'unsaved edits stay out of runtime');
    const toggle = [...s.doc.querySelectorAll('label')].find(n => n.textContent === '새 LIBRA 사용').querySelector('input');
    toggle.checked = false; toggle.dispatchEvent(new s.dom.window.Event('change', { bubbles: true }));
    await s.click('[data-settings-room-revert]');
    assert.equal(field(s, '통합 검색 최대 근거 수').value, '24');
    assert.equal([...s.doc.querySelectorAll('label')].find(n => n.textContent === '새 LIBRA 사용').querySelector('input').checked, true);
    assert.equal(s.api.debugGuiSettingsState().dirty, false);
  });
  for (const dedicated of [false, true]) await test(`${dedicated ? 'dedicated' : 'global'} save persists memory and runtime together across restart`, async () => {
    const s = await boot();
    await input(s, '통합 검색 최대 근거 수', 17); await input(s, '최근 대화 최대 턴', 3);
    await save(s, dedicated);
    assert.equal(s.api.debugGuiSettingsState().dirty, false);
    const restarted = await boot({ initialValues: [...s.values] });
    assert.equal(field(restarted, '통합 검색 최대 근거 수').value, '17');
    assert.equal(field(restarted, '최근 대화 최대 턴').value, '3');
  });
  await test('a memory draft survives navigation and saves from a different settings section', async () => {
    const s = await boot(); await input(s, '통합 검색 최대 근거 수', 17);
    await s.click('.setnav [data-subtab="adv"]'); await save(s);
    const restarted = await boot({ initialValues: [...s.values] });
    assert.equal(field(restarted, '통합 검색 최대 근거 수').value, '17');
  });
  for (const failure of ['memory', 'runtime', 'dropped_memory']) await test(`${failure} write failure keeps the draft and rolls back both owners; retry works`, async () => {
    let enabled = false;
    const matches = k => String(k) === (failure === 'runtime' ? 'libra:v1:runtime-settings' : 'libra:v1:memory-settings');
    const s = await boot({ failWrites: k => enabled && failure !== 'dropped_memory' && matches(k), dropWrites: k => enabled && failure === 'dropped_memory' && matches(k) });
    const before = [...s.values];
    await input(s, '통합 검색 최대 근거 수', 17); await input(s, '최근 대화 최대 턴', 3);
    enabled = true; await save(s); enabled = false;
    assert.equal(s.api.debugGuiSettingsState().dirty, true, 'failed save remains dirty');
    assert.match(s.doc.querySelector('[data-settings-room-save-status]').textContent,
      failure === 'runtime' ? /복원하지 못했습니다.*일부 설정이 적용되었을 수 있습니다/ : /저장하지 못했습니다/);
    assert.equal(field(s, '통합 검색 최대 근거 수').value, '17', 'draft remains editable');
    assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits, 24, 'failed write does not change live runtime');
    const restarted = await boot({ initialValues: [...s.values] });
    assert.equal(field(restarted, '통합 검색 최대 근거 수').value, '24');
    assert.equal(field(restarted, '최근 대화 최대 턴').value, '4');
    await save(s);
    assert.equal(s.api.debugGuiSettingsState().dirty, false);
    assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits, 17);
  });
  await test('retired ranker presets are absent and common evidence admission is reversible', async () => {
    const s = await boot();
    assert.equal(s.doc.querySelector('[data-performance-preset]'),null);
    await input(s,'통합 검색 최대 근거 수',30);
    assert.equal(s.api.debugGuiSettingsState().dirty,true);
    assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits,24);
    await s.click('[data-settings-room-revert]');
    assert.equal(field(s,'통합 검색 최대 근거 수').value,'24');
  });
  await test('an external memory setting change is not overwritten by a stale GUI draft', async () => {
    const s = await boot(); await input(s, '통합 검색 최대 근거 수', 17);
    await s.api.saveLibraMemorySettings({ unifiedMaxUnits: 14 });
    const writesBeforeSave = s.writes.length;
    await save(s);
    assert.equal(s.api.debugGuiSettingsState().dirty, true);
    assert.match(s.doc.querySelector('[data-settings-room-save-status]').textContent, /memory_settings_stale_basis/);
    assert.deepEqual(s.writes.slice(writesBeforeSave).filter(w => w.key !== 'libra:v1:migration:remove-world-additional:v1'), [], 'stale save writes no settings; only the independent startup migration marker is excluded');
    assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits, 14);
    await s.click('[data-settings-room-revert]');
    assert.equal(field(s, '통합 검색 최대 근거 수').value, '14');
  });
  await test('global and dedicated buttons share one in-flight save', async () => {
    const s = await boot(); await input(s, '통합 검색 최대 근거 수', 17);
    const before = s.writes.filter(w => w.key === 'libra:v1:memory-settings').length;
    const dedicated = [...s.doc.querySelectorAll('button')].find(n => n.textContent === '리콜 · 최근 대화 설정 저장');
    s.doc.querySelector('[data-settings-room-save]').click(); dedicated.click(); dedicated.click();
    await until(() => !s.doc.querySelector('[data-settings-room-save]').disabled, 'shared save settles');
    assert.equal(s.writes.filter(w => w.key === 'libra:v1:memory-settings').length - before, 1);
    assert.equal(s.api.debugGuiSettingsState().dirty, false);
  });
  await test('failure after the memory write rolls back an existing saved record exactly', async () => {
    let failOnce = false;
    const s = await boot({ failRemoves: k => {
      if (failOnce && k === 'libra:v1:settings-transaction-journal') { failOnce = false; return true; }
      return false;
    } });
    await save(s);
    const beforeMemory = s.values.get('libra:v1:memory-settings');
    const beforeRuntime = s.values.get('libra:v1:runtime-settings');
    await input(s, '통합 검색 최대 근거 수', 17); await input(s, '최근 대화 최대 턴', 3);
    failOnce = true; await save(s);
    assert.equal(s.api.debugGuiSettingsState().dirty, true);
    assert.equal(s.values.get('libra:v1:memory-settings'), beforeMemory, 'owner restores exact prior bytes');
    assert.equal(s.values.get('libra:v1:runtime-settings'), beforeRuntime, 'runtime rollback shares the same transaction');
    assert.equal((await s.api.getLibraMemorySettings()).unifiedMaxUnits, 24);
    assert.equal(field(s, '통합 검색 최대 근거 수').value, '17');
    await save(s); assert.equal(s.api.debugGuiSettingsState().dirty, false);
  });
  await test('visible field labels provide names and notes are separate descriptions', async () => {
    const s = await boot();
    const controls = [...s.doc.querySelectorAll('.page[data-page="settings"] .field input,.page[data-page="settings"] .field select,.page[data-page="settings"] .field textarea')];
    assert.ok(controls.length >= 6);
    for (const n of controls) {
      const visual = n.closest('.field').querySelector('label')?.textContent;
      if (!visual) continue;
      const names = [...n.labels || []].map(label => label.textContent);
      assert.ok(names.includes(visual), `label association: ${visual}`);
      const note = n.closest('.field').querySelector('small');
      if (note) {
        assert.ok(note.id, `description has an id: ${visual}`);
        assert.ok((n.getAttribute('aria-describedby') || '').split(/\s+/).includes(note.id));
        assert.equal(s.doc.querySelectorAll(`[id="${note.id}"]`).length, 1);
      }
    }
  });
  console.log(JSON.stringify({ pluginPath, results }, null, 2));
  if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
