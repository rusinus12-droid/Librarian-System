'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');

test('registered successful settings reset keeps dual recall available now and after reload', async () => {
  const f = await loadGui();
  let fresh;
  try {
    assert(f.api.TypedRecallRollout.begin(), 'production rollout exists before reset');
    const reset = f.overlay.querySelector('#btn-reset-settings').onclick();
    const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
    assert(dialog, 'registered reset opens actual confirmation');
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '확인').click();
    await reset;
    assert(f.w.document.body.textContent.includes('설정 초기화됨'));
    assert.equal(JSON.parse(f.store.get('LMAI_Config')).dualRecallMode, 'dual');
    assert(f.api.TypedRecallRollout.begin(), 'successful reset retains an available typed rollout');
    assert.match(f.overlay.querySelector('#sdual-readiness').textContent, /Mode dual; semantic configured false; semantic ready false/);
    await f.callbacks.beforeRequest({ messages: [{ role: 'user', content: 'recall current context' }], maxContextTokens: 128000 }, 'model');
    assert.equal(f.api.TypedRecallRollout.inspect().last.mode, 'dual');
    fresh = await loadGui({ store: f.store });
    assert(fresh.api.TypedRecallRollout.begin(), 'persisted defaults configure rollout after reload');
  } finally { fresh?.close(); f.close(); }
});
