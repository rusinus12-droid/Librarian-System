'use strict';
const assert = require('node:assert/strict');
const { load } = require('./libra_management_storage_verified_test.cjs');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const checks = [];
const MARKER = 'PRE_RESET_ARCHIVIST_ROLE';
async function fixture() {
  const seed = await load({ artifact: true, extraExports: 'IntegrityMetaManager,getChatRuntimeScopeKey' });
  const char = { id: 'fixture-char', chatPage: 0 }, chat = { id: 'fixture-chat', bindedPersona: 'persona-a' };
  const scope = seed.api.LibraDataStorage.scopeKeyFor(char, chat);
  const entity = { id: 'mira', name: 'Mira Archivist', background: { occupation: MARKER }, meta: { created: 1, updated: 1 } };
  seed.api.IntegrityMetaManager.applyIntegrityMeta(entity, { domain: 'entity', recordId: 'mira', scopeKey: seed.api.getChatRuntimeScopeKey(chat, char), turn: 1 });
  const store = new Map([[seed.api.LibraDataStorage.storageKeyFor(scope), JSON.stringify({ scopeKey: scope, entries: [{ key: 'mira', comment: 'lmai_entity', content: JSON.stringify(entity) }] })]]);
  return loadGui({ nativeInitialization: true, store });
}
async function test(name, fn) {
  let f;
  try { f = await fixture(); await fn(f); checks.push({ name, ok: true }); }
  catch (error) { checks.push({ name, ok: false, error: error.stack }); process.exitCode = 1; }
  finally { f?.close(); }
}
(async () => {
  const input = [{ role: 'user', content: 'Describe Mira Archivist and her occupation.' }];
  await test('unchanged request still emits its owned entity in the actual prompt', async f => {
    assert(JSON.stringify(await f.callbacks.beforeRequest(input, 'model')).includes(MARKER));
  });
  for (const change of ['reset', 'persona', 'reset with failed preparation', 'persona with failed preparation']) await test(`final beforeRequest emission rejects a ${change} change during awaited preparation`, async f => {
    const original = f.api.SectionWorldInferenceManager.inferPrompt;
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.api.SectionWorldInferenceManager.inferPrompt = async (...args) => { const result = await original(...args); entered(); await gate; if (change.endsWith('failed preparation')) throw new Error('synthetic delayed preparation failure'); return result; };
    const pending = f.callbacks.beforeRequest(input, 'model');
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('request did not reach controlled preparation')), 5000))]);
    if (change.startsWith('reset')) {
      const reset = f.overlay.querySelector('#lmai-data-reset').onclick();
      const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
      assert(dialog); [...dialog.querySelectorAll('button')].find(button => button.textContent === '확인').click();
      await reset;
      assert.equal(JSON.parse(f.store.get(f.key)).entries.length, 0);
    } else {
      f.control.chat.bindedPersona = 'persona-b';
      const scope = 'char:fixture-char|chat:fixture-chat|persona:persona-b';
      f.store.set(f.api.LibraDataStorage.storageKeyFor(scope), JSON.stringify({ scopeKey: scope, entries: [] }));
    }
    f.api.MemoryState.pendingTurnCommits.set('fresh-runtime-sentinel', { createdAt: Date.now(), marker: 'must survive' });
    release();
    const output = await pending;
    assert(!JSON.stringify(output).includes(MARKER));
    assert.equal(JSON.stringify(output), JSON.stringify(input));
    assert(f.api.MemoryState.pendingTurnCommits.has('fresh-runtime-sentinel'));
  });
  console.log(JSON.stringify({ passed: checks.filter(item => item.ok).length, failed: checks.filter(item => !item.ok).length, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
