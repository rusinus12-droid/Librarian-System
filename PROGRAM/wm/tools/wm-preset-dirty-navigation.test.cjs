'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const { profile } = require('./wm-analysis-preset-test-support.cjs');
const KEY = 'LMAI_Config';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const node = (f, id) => f.overlay.querySelector(id);
const saved = f => JSON.parse(f.store.get(KEY));
const writes = f => f.calls.writes.filter(row => row.key === KEY);
const change = (f, id, value, type = 'input') => {
  node(f, id).value = value;
  node(f, id).dispatchEvent(new f.w.Event(type, { bubbles: true }));
};
const until = async (fn, label) => {
  const end = Date.now() + 2500;
  while (!fn()) { assert(Date.now() < end, label); await sleep(5); }
};
const dialog = f => node(f, '#common-ai-unsaved-dialog');
const choice = (f, name) => { assert(dialog(f), 'unsaved draft choice is visible'); node(f, '#common-ai-unsaved-' + name).click(); };
const open = async () => {
  const config = { useLLM: true, llm: profile('legacy'), llmPresets: { a: profile('A'), b: profile('B', { temp: 0, retryCount: 7, customHeader: { opaque: 'preserve' } }), c: profile('C') }, llmDefaultPreset: 'a' };
  const f = await loadGui({ observeCommonAnalysis: true, nativeInitialization: true, args: { use_llm: 'true' }, store: new Map([[KEY, JSON.stringify(config)]]) });
  node(f, '[data-tab="settings"]').click();
  change(f, '#sllmpresetselect', 'b', 'change');
  f.common.LLMProvider.call = async () => { assert.fail('draft navigation must not call a model'); };
  return f;
};
const dirty = f => change(f, '#sllmpm', 'B-edited');
const exits = {
  close: f => node(f, '#xbtn').click(),
  escape: f => f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  backdrop: f => node(f, '[data-libra-gui-backdrop]').click()
};

// Discriminating mutations: remove the centralized guard, resolve before readback,
// let cancel/discard write, or use a newer draft/obsolete scope for a pending exit.
for (const [name, exit] of Object.entries(exits)) {
  test('dirty ' + name + ' offers save/discard/cancel and cancel preserves the draft', async () => {
    const f = await open();
    try {
      dirty(f); exit(f);
      assert(f.overlay.isConnected, 'dirty editor stays open until a choice');
      assert(dialog(f), 'explicit three-way choice is shown');
      assert.equal(dialog(f).getAttribute('role'), 'dialog');
      assert.match(dialog(f).textContent, /지금 사용할 분석 AI.*바꾸지/);
      choice(f, 'cancel');
      assert(!dialog(f)); assert(f.overlay.isConnected);
      assert.equal(node(f, '#sllmpm').value, 'B-edited');
      assert.equal(writes(f).length, 0); assert.equal(saved(f).llmPresets.b.model, 'B');
    } finally { f.close(); }
  });
}
test('unchanged and reverted editor closes without a prompt or write', async () => {
  const f = await open();
  try { dirty(f); change(f, '#sllmpm', 'B'); exits.close(f); assert(!f.overlay.isConnected); assert(!dialog(f)); assert.equal(writes(f).length, 0); }
  finally { f.close(); }
});
test('discard closes without saving and reopening restores the stored definition', async () => {
  const f = await open();
  try {
    dirty(f); exits.close(f); choice(f, 'discard');
    assert(!f.overlay.isConnected); assert.equal(writes(f).length, 0);
    await f.callbacks.setting();
    const overlay = f.w.document.querySelector('#lmai-overlay');
    const select = overlay.querySelector('#sllmpresetselect'); select.value = 'b'; select.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(overlay.querySelector('#sllmpm').value, 'B');
  } finally { f.close(); }
});
test('save-and-close waits for verified readback, writes once and preserves common selection', async () => {
  const f = await open(); let release;
  try {
    dirty(f); change(f, '#sllmpk', '');
    const storage = f.w.risuai.pluginStorage, get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
    let landed = false, entered = false; const gate = new Promise(resolve => { release = resolve; });
    storage.setItem = async (k, v) => { const result = await set(k, v); if (k === KEY) landed = true; return result; };
    storage.getItem = async k => { if (k === KEY && landed) { entered = true; await gate; } return get(k); };
    exits.close(f); choice(f, 'save'); choice(f, 'save');
    await until(() => entered, 'save reached readback');
    assert(f.overlay.isConnected); assert.equal(f.api.MemoryEngine.CONFIG.llmPresets.b.model, 'B');
    assert.equal(writes(f).length, 1);
    release(); await until(() => !f.overlay.isConnected, 'verified save may close');
    assert.equal(saved(f).llmPresets.b.model, 'B-edited'); assert.equal(saved(f).llmDefaultPreset, 'a');
    assert.equal(saved(f).llmPresets.b.key, 'synthetic-test-only'); assert.equal(saved(f).llmPresets.b.temp, 0);
    assert.equal(saved(f).llmPresets.b.retryCount, 7); assert.deepEqual(saved(f).llmPresets.b.customHeader, { opaque: 'preserve' });
    assert.equal(f.calls.hostWrites.length, 0);
  } finally { release?.(); f.close(); }
});
for (const mode of ['rejected', 'uncertain']) {
  test(mode + ' save keeps the draft and does not navigate or silently retry', async () => {
    const f = await open();
    try {
      dirty(f);
      const storage = f.w.risuai.pluginStorage, get = storage.getItem.bind(storage), set = storage.setItem.bind(storage); let landed = false, attempts = 0;
      storage.setItem = async (k, v) => { if (k === KEY) { attempts++; if (mode === 'rejected') return false; } const result = await set(k, v); if (k === KEY) landed = true; return result; };
      storage.getItem = async k => { if (mode === 'uncertain' && k === KEY && landed) throw Error('synthetic readback uncertainty'); return get(k); };
      exits.close(f); choice(f, 'save');
      await until(() => node(f, '#common-ai-save-status').dataset.state === 'failed', 'failure is visible');
      assert(f.overlay.isConnected); assert.equal(node(f, '#sllmpm').value, 'B-edited');
      assert.equal(f.api.MemoryEngine.CONFIG.llmPresets.b.model, 'B');
      await sleep(50); assert.equal(attempts, 1);
      choice(f, 'cancel'); assert(!dialog(f)); assert(f.overlay.isConnected);
    } finally { f.close(); }
  });
}
test('tab/back cancellation stays put; discard resets only the draft before navigating', async () => {
  const f = await open();
  try {
    dirty(f); const back = f.w.document.createElement('button'); back.dataset.back = 'home'; f.overlay.appendChild(back); back.click();
    assert(node(f, '#tab-settings').classList.contains('on')); choice(f, 'cancel');
    node(f, '[data-tab="logs"]').click(); choice(f, 'discard');
    assert(node(f, '#tab-logs').classList.contains('on')); assert.equal(writes(f).length, 0);
    node(f, '[data-tab="settings"]').click(); assert.equal(node(f, '#sllmpm').value, 'B'); assert(!dialog(f));
  } finally { f.close(); }
});
test('editor selection restores its old value on cancel and saves the old draft before moving', async () => {
  const f = await open();
  try {
    dirty(f); change(f, '#sllmpresetselect', 'c', 'change');
    assert.equal(node(f, '#sllmpresetselect').value, 'b'); assert.equal(node(f, '#sllmpm').value, 'B-edited'); choice(f, 'cancel');
    change(f, '#sllmpresetselect', 'c', 'change'); choice(f, 'save');
    await until(() => node(f, '#sllmpresetselect').value === 'c', 'saved before editor changes');
    assert.equal(node(f, '#sllmpm').value, 'C'); assert.equal(saved(f).llmPresets.b.model, 'B-edited');
    assert.equal(saved(f).llmDefaultPreset, 'a'); assert.equal(writes(f).length, 1);
  } finally { f.close(); }
});
test('quick common-AI selection neither prompts nor saves the editor draft', async () => {
  const f = await open();
  try {
    dirty(f); change(f, '#sllmdefault', 'c', 'change');
    await until(() => f.api.MemoryEngine.CONFIG.llmDefaultPreset === 'c', 'common selection verified');
    assert(!dialog(f)); assert.equal(saved(f).llmPresets.b.model, 'B'); assert.equal(node(f, '#sllmpm').value, 'B-edited');
    exits.close(f); choice(f, 'discard'); assert.equal(saved(f).llmDefaultPreset, 'c'); assert.equal(writes(f).length, 1);
  } finally { f.close(); }
});
test('repeated navigation uses one dialog and cancel/Escape never triggers an older exit', async () => {
  const f = await open();
  try {
    dirty(f); exits.close(f); node(f, '[data-tab="logs"]').click(); exits.close(f);
    assert.equal(f.overlay.querySelectorAll('#common-ai-unsaved-dialog').length, 1);
    exits.escape(f); assert(!dialog(f)); assert(f.overlay.isConnected); assert(node(f, '#tab-settings').classList.contains('on'));
    await sleep(25); assert(f.overlay.isConnected); assert.equal(writes(f).length, 0);
  } finally { f.close(); }
});
test('new unsaved preset is guarded even before further typing', async () => {
  const f = await open();
  try { node(f, '#btn-llmp-new').click(); exits.close(f); assert(dialog(f)); choice(f, 'discard'); assert(!f.overlay.isConnected); assert.equal(writes(f).length, 0); }
  finally { f.close(); }
});
test('new-preset action cannot silently discard an existing edited draft', async () => {
  const f = await open();
  try { dirty(f); node(f, '#btn-llmp-new').click(); assert(dialog(f)); choice(f, 'cancel'); assert.equal(node(f, '#sllmpm').value, 'B-edited'); assert.equal(node(f, '#sllmpresetselect').value, 'b'); assert.equal(writes(f).length, 0); }
  finally { f.close(); }
});
test('scope change while confirmation is open blocks its stale save and destination', async () => {
  const f = await open();
  try {
    dirty(f); exits.close(f); f.api.MemoryState._activeScopeKey = 'changed-scope'; choice(f, 'save'); await sleep(35);
    assert(f.overlay.isConnected); assert.equal(writes(f).length, 0); assert.equal(node(f, '#sllmpm').value, 'B-edited');
  } finally { f.close(); }
});
test('scope change during readback suppresses the pending navigation after durable save', async () => {
  const f = await open(); let release;
  try {
    dirty(f); const storage = f.w.risuai.pluginStorage, get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
    let landed = false, entered = false; const gate = new Promise(resolve => { release = resolve; });
    storage.setItem = async (k, v) => { const result = await set(k, v); if (k === KEY) landed = true; return result; };
    storage.getItem = async k => { if (k === KEY && landed) { entered = true; await gate; } return get(k); };
    exits.close(f); choice(f, 'save'); await until(() => entered, 'save is awaiting readback');
    f.api.MemoryState._activeScopeKey = 'changed-scope'; release(); await sleep(60);
    assert(f.overlay.isConnected); assert.equal(writes(f).length, 1); assert.equal(saved(f).llmPresets.b.model, 'B-edited');
  } finally { release?.(); f.close(); }
});
