'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const { profile } = require('./wm-analysis-preset-test-support.cjs');
const KEY = 'LMAI_Config', sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const node = (f, selector) => f.overlay.querySelector(selector);
const change = (f, id, value, type = 'input') => { node(f, id).value = value; node(f, id).dispatchEvent(new f.w.Event(type, { bubbles: true })); };
const until = async (fn, label) => { const end = Date.now() + 2500; while (!fn()) { assert(Date.now() < end, label); await sleep(5); } };
const saved = f => JSON.parse(f.store.get(KEY));
const open = async () => {
  const config = { useLLM: true, llm: profile('legacy'), llmPresets: { a: profile('A'), b: profile('B'), c: profile('C') }, llmDefaultPreset: 'a' };
  const f = await loadGui({ observeCommonAnalysis: true, nativeInitialization: true, args: { use_llm: 'true' }, store: new Map([[KEY, JSON.stringify(config)]]) });
  node(f, '[data-tab="settings"]').click(); change(f, '#sllmpresetselect', 'b', 'change'); change(f, '#sllmpm', 'B-edited');
  return f;
};
const holdReadback = f => {
  const storage = f.w.risuai.pluginStorage, get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
  let release, landed = false, entered = false; const gate = new Promise(resolve => { release = resolve; });
  storage.setItem = async (k, v) => { const result = await set(k, v); if (k === KEY) landed = true; return result; };
  storage.getItem = async k => { if (k === KEY && landed) { entered = true; await gate; } return get(k); };
  return { release, entered: () => entered };
};
const startExitSave = f => { node(f, '#xbtn').click(); assert(node(f, '#common-ai-unsaved-save')); node(f, '#common-ai-unsaved-save').click(); };
for (const action of ['clone', 'delete']) test('dirty ' + action + ' cannot replace the draft without a navigation choice', async () => {
  const f = await open();
  try {
    node(f, '#btn-llmp-' + action).click();
    assert(node(f, '#common-ai-unsaved-dialog'), 'replacement action must guard the draft');
    node(f, '#common-ai-unsaved-cancel').click(); await sleep(40);
    assert.equal(node(f, '#sllmpm').value, 'B-edited'); assert(saved(f).llmPresets.b); assert.equal(saved(f).llmPresets.b_copy, undefined);
    assert.equal(f.calls.writes.filter(x => x.key === KEY).length, 0);
  } finally { f.close(); }
});
test('late completion of a cancelled exit cannot dismiss a newer confirmation', async () => {
  const f = await open(); const held = holdReadback(f);
  try {
    startExitSave(f); await until(held.entered, 'readback held');
    node(f, '#common-ai-unsaved-cancel').click(); change(f, '#sllmpm', 'NEWER-DRAFT');
    node(f, '[data-tab="logs"]').click(); const newerDialog = node(f, '#common-ai-unsaved-dialog'); assert(newerDialog);
    held.release(); await until(() => f.api.MemoryEngine.CONFIG.llmPresets.b.model === 'B-edited', 'earlier save verified'); await sleep(25);
    assert.equal(node(f, '#common-ai-unsaved-dialog'), newerDialog, 'old async completion cannot own a later dialog');
    assert(f.overlay.isConnected); assert.equal(node(f, '#sllmpm').value, 'NEWER-DRAFT');
    node(f, '#common-ai-unsaved-cancel').click(); assert(node(f, '#tab-settings').classList.contains('on'));
  } finally { held.release(); f.close(); }
});
test('typing while a navigation save is pending keeps the newer draft and blocks the old exit', async () => {
  const f = await open(); const held = holdReadback(f);
  try {
    startExitSave(f); await until(held.entered, 'readback held'); change(f, '#sllmpm', 'NEWER-DRAFT'); held.release();
    await until(() => node(f, '#common-ai-unsaved-status').textContent.includes('편집 내용이 바뀌어'), 'newer draft is explained');
    assert(f.overlay.isConnected); assert.equal(node(f, '#sllmpm').value, 'NEWER-DRAFT'); assert.equal(saved(f).llmPresets.b.model, 'B-edited');
    assert.equal(f.calls.writes.filter(x => x.key === KEY).length, 1);
  } finally { held.release(); f.close(); }
});
test('reopening during pending save disposes the old dialog and suppresses late close', async () => {
  const f = await open(); const held = holdReadback(f); let hidden = 0;
  try {
    f.w.risuai.hideContainer = async () => { hidden++; };
    startExitSave(f); await until(held.entered, 'readback held');
    // The registered show callback replaces the old overlay synchronously before its async reads.
    const reopened = f.callbacks.setting(); held.release(); await reopened; await sleep(40);
    assert(!f.overlay.isConnected); const latest = f.w.document.querySelector('#lmai-overlay'); assert(latest && latest !== f.overlay);
    assert(latest.isConnected); assert.equal(hidden, 0); assert.equal(latest.querySelector('#common-ai-unsaved-dialog'), null);
  } finally { held.release(); f.close(); }
});
test('dialog keeps keyboard focus inside and restores the originating control on cancel', async () => {
  const f = await open();
  try {
    const origin = node(f, '#sllmpm'); origin.focus(); node(f, '#xbtn').click();
    const cancel = node(f, '#common-ai-unsaved-cancel'), save = node(f, '#common-ai-unsaved-save');
    assert.equal(f.w.document.activeElement, cancel); assert.equal(node(f, '[data-libra-gui-backdrop]').inert, true);
    cancel.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); assert.equal(f.w.document.activeElement, save);
    save.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); assert.equal(f.w.document.activeElement, cancel);
    cancel.click(); assert.equal(f.w.document.activeElement, origin); assert.equal(node(f, '[data-libra-gui-backdrop]').inert, false);
  } finally { f.close(); }
});
test('explicit verified toolbar save marks the editor clean for the next close', async () => {
  const f = await open();
  try {
    node(f, '#btn-llmp-save').click(); await until(() => node(f, '#common-ai-save-status').dataset.state === 'saved', 'save verified');
    node(f, '#xbtn').click(); assert(!f.overlay.isConnected); assert.equal(f.calls.writes.filter(x => x.key === KEY).length, 1);
  } finally { f.close(); }
});
test('quick AI selection preserves a new draft identity until explicit creation', async () => {
  const f = await open();
  try {
    node(f, '#xbtn').click(); node(f, '#common-ai-unsaved-discard').click(); await f.callbacks.setting(); f.overlay = f.w.document.querySelector('#lmai-overlay');
    node(f, '#btn-llmp-new').click(); change(f, '#sllmpname', 'brand_new'); change(f, '#sllmpm', 'NEW');
    change(f, '#sllmdefault', 'c', 'change'); await until(() => f.api.MemoryEngine.CONFIG.llmDefaultPreset === 'c', 'quick selection saved');
    assert.equal(node(f, '#sllmpresetselect').value, '', 'new editor must not acquire an existing preset owner');
    node(f, '#btn-llmp-save').click(); await until(() => saved(f).llmPresets.brand_new, 'new definition saved');
    assert.equal(saved(f).llmPresets.b.model, 'B'); assert.equal(saved(f).llmPresets.a.model, 'A'); assert.equal(saved(f).llmDefaultPreset, 'c');
  } finally { f.close(); }
});
test('verified rename keeps editor ownership when typing continues during its cancelled exit', async () => {
  const f = await open(); const held = holdReadback(f);
  try {
    change(f, '#sllmpname', 'renamed_b'); startExitSave(f); await until(held.entered, 'rename readback held');
    node(f, '#common-ai-unsaved-cancel').click(); change(f, '#sllmpm', 'NEWER-DRAFT'); held.release();
    await until(() => f.api.MemoryEngine.CONFIG.llmPresets.renamed_b, 'rename published'); await sleep(20);
    assert.equal(node(f, '#sllmpresetselect').value, 'renamed_b', 'draft continues to own its renamed definition');
    assert.equal(node(f, '#sllmpm').value, 'NEWER-DRAFT'); node(f, '#btn-llmp-save').click();
    await until(() => saved(f).llmPresets.renamed_b.model === 'NEWER-DRAFT', 'newer draft saved to renamed owner');
    assert.equal(saved(f).llmPresets.a.model, 'A'); assert.equal(saved(f).llmPresets.b, undefined); assert.equal(saved(f).llmDefaultPreset, 'a');
  } finally { held.release(); f.close(); }
});
test('a newer close-save follows an already-issued rename without losing the new draft', async () => {
  const f = await open(); const held = holdReadback(f);
  try {
    change(f, '#sllmpname', 'renamed_b'); startExitSave(f); await until(held.entered, 'first rename readback held');
    node(f, '#common-ai-unsaved-cancel').click(); change(f, '#sllmpm', 'NEWER-DRAFT'); startExitSave(f);
    held.release(); await until(() => !f.overlay.isConnected || node(f, '#common-ai-save-status').dataset.state === 'failed', 'second save settles');
    assert(!f.overlay.isConnected, 'newer draft must save against the verified renamed identity');
    assert.equal(saved(f).llmPresets.renamed_b.model, 'NEWER-DRAFT'); assert.equal(saved(f).llmPresets.b, undefined);
    assert.equal(saved(f).llmDefaultPreset, 'a'); assert.equal(f.calls.writes.filter(x => x.key === KEY).length, 2);
  } finally { held.release(); f.close(); }
});
test('toolbar save followed by save-and-close does not conflict with its own pending create', async () => {
  const f = await open(); let held;
  try {
    node(f, '#btn-llmp-new').click(); node(f, '#common-ai-unsaved-discard').click(); change(f, '#sllmpname', 'brand_new');
    held = holdReadback(f); node(f, '#btn-llmp-save').click(); await until(held.entered, 'creation readback held');
    startExitSave(f); held.release(); await until(() => !f.overlay.isConnected || node(f, '#common-ai-save-status').dataset.state === 'failed', 'save-and-close settles');
    assert(!f.overlay.isConnected, 'queued save must follow the new definition identity'); assert(saved(f).llmPresets.brand_new); assert.equal(saved(f).llmDefaultPreset, 'a');
  } finally { held?.release(); f.close(); }
});
test('protected active delete never asks to discard an unsaved draft', async () => {
  const f = await open();
  try {
    node(f, '#xbtn').click(); node(f, '#common-ai-unsaved-discard').click(); await f.callbacks.setting(); f.overlay = f.w.document.querySelector('#lmai-overlay');
    change(f, '#sllmpresetselect', 'a', 'change'); change(f, '#sllmpm', 'UNSAVED-A'); node(f, '#btn-llmp-delete').click();
    assert.equal(node(f, '#common-ai-unsaved-dialog'), null); assert.equal(node(f, '#sllmpm').value, 'UNSAVED-A');
    assert.match(node(f, '#common-ai-save-status').textContent, /다른 프리셋/); assert.equal(f.calls.writes.filter(x => x.key === KEY).length, 0);
  } finally { f.close(); }
});
test('clone from a new unsaved draft stays blocked without discarding or cloning primary', async () => {
  const f = await open();
  try {
    node(f, '#btn-llmp-new').click(); node(f, '#common-ai-unsaved-discard').click(); change(f, '#sllmpname', 'brand_new');
    node(f, '#btn-llmp-clone').click(); assert.equal(node(f, '#common-ai-unsaved-dialog'), null);
    assert.equal(node(f, '#sllmpresetselect').value, ''); assert.equal(node(f, '#sllmpname').value, 'brand_new');
    assert.equal(f.calls.writes.filter(x => x.key === KEY).length, 0); assert.equal(saved(f).llmPresets.primary_copy, undefined);
  } finally { f.close(); }
});
