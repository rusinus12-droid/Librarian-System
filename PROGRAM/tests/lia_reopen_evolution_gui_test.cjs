'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lia, wait, sleep } = require('./fixtures/companion_gui_fixture.cjs');
const CONFIG = 'dynamicPersonaLorebookGeneratorLLMConfig';

test('LIA repeated UI entry preserves unsaved model and shell without silently saving', async () => {
  const f = await lia();
  try {
    await f.open(); const shell = f.doc.querySelector('.lia-shell');
    const model = f.doc.getElementById('dpg-llm-model'); model.value = 'unsaved-model';
    model.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    const stored = f.values.get(CONFIG);
    await Promise.all([f.open(), f.open()]);
    assert.equal(f.doc.getElementById('dpg-llm-model').value, 'unsaved-model');
    assert.equal(f.doc.querySelector('.lia-shell'), shell, 'already open shell is not replaced');
    assert.equal(f.doc.querySelectorAll('.lia-shell').length, 1); assert.equal(f.values.get(CONFIG), stored);
    for (const tab of ['home', 'generate', 'edit', 'realtime', 'assets', 'vault', 'settings', 'server']) {
      const button = f.doc.querySelector('[data-workspace-tab="' + tab + '"]') || f.doc.querySelector('[data-pocket-tab="' + tab + '"]');
      assert(button, 'existing route remains: ' + tab); button.click();
      assert.equal(f.doc.querySelector('.lia-app-layout').dataset.page, tab);
      assert.equal(f.doc.getElementById('dpg-llm-model').value, 'unsaved-model');
    }
    f.doc.getElementById('dpg-save-llm-config').click();
    await wait(() => JSON.parse(f.values.get(CONFIG) || '{}').model === 'unsaved-model', 'explicit model save');
    f.doc.getElementById('dpg-close').click(); await sleep(20); await f.open();
    assert.equal(f.doc.getElementById('dpg-llm-model').value, 'unsaved-model');
    const ids = [...f.doc.querySelectorAll('[id]')].map(node => node.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(f.registrations.chat, 0); assert.equal(f.registrations.script, 0);
  } finally { await f.close(); }
});

test('LIA full-chat evolution displays review in editor and never applies it automatically', async () => {
  let calls = 0;
  const f = await lia({ configureApi(api, { values }) {
    values.set(CONFIG, JSON.stringify({ provider: 'ollama', model: 'fixture', endpoint: 'http://fixture.invalid/api/chat', stream: false, promptCacheMode: 'off' }));
    api.nativeFetch = async url => {
      assert.match(String(url), /^http:\/\/fixture\.invalid\//); calls++;
      return { ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify({ summary: 'Review this synthetic habit', evidenceQuality: 'high', suggestions: [{ field: 'personality', proposedValue: 'A cautious archivist', confidence: 90, evidence: ['User turn 1'], rationale: 'Synthetic repeated user evidence' }] }) } }) };
    };
  } });
  try {
    await f.open();
    const draft = { personaName: 'Adult Archivist', personaPrompt: 'Original adult persona', personaSpec: { name: 'Adult Archivist', age: '30', role: 'Archivist', personality: 'Curious' } };
    const output = f.doc.getElementById('dpg-llm-result'); output.value = JSON.stringify(draft); output.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    f.doc.getElementById('dpg-refresh').click();
    await wait(() => !f.doc.querySelector('.dpg-loading'), 'draft render');
    f.doc.querySelector('[data-workspace-tab="edit"]').click();
    f.doc.querySelector('button[data-editor-section="evolution"]').click();
    const beforePersonas = JSON.stringify(f.db.personas), bound = f.liveChat.bindedPersona;
    const run = f.doc.getElementById('dpg-run-persona-evolution'); assert.equal(run.disabled, false); run.click();
    await wait(() => /Persona Evolution 분석 완료/.test(f.doc.getElementById('dpg-status').textContent), 'evolution completion');
    assert.equal(calls, 1);
    assert.equal(f.doc.querySelector('.lia-app-layout').dataset.page, 'edit', 'full-chat review stays on edit, not five-turn manual workflow');
    assert.equal(f.doc.querySelector('.lia-result-card').dataset.editorSection, 'evolution');
    assert.match(f.doc.querySelector('.lia-evolution-list').textContent, /A cautious archivist/);
    assert.notEqual(f.w.getComputedStyle(f.doc.querySelector('.lia-result-card')).display, 'none');
    assert.notEqual(f.w.getComputedStyle(f.doc.querySelector('[data-editor-block="evolution"]')).display, 'none');
    assert.equal(JSON.stringify(f.db.personas), beforePersonas); assert.equal(f.liveChat.bindedPersona, bound);
    assert.equal(f.registrations.chat, 0); assert.equal(f.registrations.script, 0);
    assert.match(f.doc.getElementById('dpg-live-range').textContent, /TURN 1~5/, 'five-turn manual flow remains separate');
  } finally { await f.close(); }
});
