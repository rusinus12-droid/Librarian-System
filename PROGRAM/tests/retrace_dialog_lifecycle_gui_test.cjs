'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retrace, sleep, wait } = require('./fixtures/companion_gui_fixture.cjs');

async function withDialog(run) {
  const f = await retrace();
  try {
    await f.plugin.showUi();
    const opener = f.doc.getElementById('createSession');
    opener.focus(); opener.click();
    await wait(() => f.doc.getElementById('dlg-next')?.hidden === false, 'live session confirmation', 30000);
    assert.match(f.doc.querySelector('#dlg-next [data-dialog-title]').textContent, /다음 세션/);
    let writes = 0;
    f.host.setDatabase = f.host.setCharacter = f.host.setCharacterToIndex = async () => { writes++; throw Error('SYNTHETIC_WRITER_BLOCKED'); };
    await run(f, opener, () => writes);
    assert.equal(f.llmCalls.length, 0, 'no model calls');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

test('RETRACE reopening cancels pending consent and detached confirmation cannot reach the writer', async () => withDialog(async (f, opener, writes) => {
  const oldConfirm = f.doc.querySelector('#dlg-next [data-dialog-confirm]');
  await f.plugin.showUi();
  const unrelated = f.doc.getElementById('serverScopeSearch'); unrelated.focus();
  const event = new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  unrelated.dispatchEvent(event); oldConfirm.click();
  await sleep(250);
  assert.equal(writes(), 0, 'hidden or detached dialog never grants consent');
  assert.equal(event.defaultPrevented, false, 'no stale document Enter listener');
  assert.equal(f.doc.getElementById('createSession').disabled, false, 'replacement action is available after cancellation');
  assert.equal(f.doc.querySelectorAll('#flashback-hayaku-bridge-root').length, 1);
}));

test('RETRACE close cancels pending consent before reopening and Escape restores focus', async () => withDialog(async (f, opener, writes) => {
  const oldConfirm = f.doc.querySelector('#dlg-next [data-dialog-confirm]');
  await f.plugin.closeUi(); oldConfirm.click();
  f.doc.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(150); assert.equal(writes(), 0);
  await f.plugin.showUi();
  const next = f.doc.getElementById('createSession'); next.focus(); next.click();
  await wait(() => f.doc.getElementById('dlg-next')?.hidden === false, 'second confirmation', 30000);
  f.doc.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await wait(() => !next.disabled, 'cancelled action');
  assert.equal(f.doc.getElementById('dlg-next').hidden, true);
  assert.equal(f.doc.activeElement, next, 'focus returns to the triggering action after unlock');
  assert.equal(writes(), 0);
}));

test('RETRACE modal contains focus and Enter on Cancel cancels rather than approving', async () => withDialog(async (f, opener, writes) => {
  const layer = f.doc.getElementById('dlg-next');
  f.doc.getElementById('closeBridge').focus();
  assert(layer.contains(f.doc.activeElement), 'focus remains inside the live modal');
  const cancel = f.doc.querySelector('#dlg-next [data-dialog-cancel]'); cancel.focus();
  cancel.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(150);
  assert.equal(writes(), 0, 'Cancel keyboard activation never approves');
  assert.equal(layer.hidden, true);
}));

test('RETRACE explicit live confirmation remains functional and is single-use', async () => withDialog(async (f, opener, writes) => {
  const confirm = f.doc.querySelector('#dlg-next [data-dialog-confirm]');
  confirm.focus(); confirm.click(); confirm.click();
  await wait(() => writes() > 0, 'explicit confirmation reaches synthetic writer', 30000);
  assert.equal(writes(), 1);
}));

test('RETRACE unload settles a pending confirmation as cancelled', async () => withDialog(async (f, opener, writes) => {
  const layer = f.doc.getElementById('dlg-next');
  const confirm = f.doc.querySelector('#dlg-next [data-dialog-confirm]');
  const unload = f.retraceUnload;
  assert(unload, 'actual plugin unload callback is registered');
  await unload(); await sleep(20);
  assert.equal(layer.hidden, true, 'pending modal is dismissed during unload');
  assert.equal(opener.disabled, false, 'pending action is settled, not abandoned');
  confirm.click();
  assert.equal(writes(), 0);
}));
