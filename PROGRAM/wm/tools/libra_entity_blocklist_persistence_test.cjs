'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const KEY = 'LMAI_Config';
const list = f => Array.from(f.api.MemoryEngine.CONFIG.entityBlocklist || []);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = f => f.w.document.body.textContent;

async function fixture(blocked = []) {
  const seed = await loadGui();
  try {
    seed.api.MemoryEngine.setTurn(1);
    await seed.click('[data-health-action="quarantine-accept"][data-health-id="q1"]');
    const envelope = JSON.parse(seed.store.get(seed.key));
    envelope.entries.push({ key: 'lmai_memory::fixture-turn-anchor', comment: 'lmai_memory',
      content: '[META:{"t":1,"ttl":-1,"imp":8,"hiddenFromPrompt":true}]\nFixture turn anchor.' });
    seed.store.set(seed.key, JSON.stringify(envelope));
  }
  finally { seed.close(); }
  seed.store.set(KEY, JSON.stringify({ entityBlocklist: blocked, storyAuthorEnabled: false,
    storyAuthorMode: 'disabled', directorEnabled: false, directorMode: 'disabled', fixtureMarker: 'preserve-blocklist-marker' }));
  return loadGui({ store: seed.store, nativeInitialization: true });
}
async function action(f, route, name = 'Mira') {
  if (route === 'add') {
    f.overlay.querySelector('#entity-block-input').value = name;
    await f.overlay.querySelector('#btn-add-entity-block').onclick();
    return [];
  }
  const node = f.overlay.querySelector(route === 'row' ? '.act-block-ent' : '.act-unblock-ent');
  assert(node, 'registered ' + route + ' control');
  node.click();
  if (route === 'row') {
    const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
    assert(dialog, 'real confirmation dialog');
    Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '확인').click();
  }
  return Promise.allSettled(f.pending.splice(0));
}
function rejectSettings(f, kind) {
  const storage = f.w.risuai.pluginStorage, get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
  let issued = false;
  storage.setItem = async (key, value) => {
    if (key !== KEY) return set(key, value);
    issued = true;
    if (kind === 'false') return false;
    if (kind === 'throw') throw new Error('synthetic settings rejection');
    if (kind === 'drop') return true;
    return set(key, value);
  };
  storage.getItem = async key => {
    if (key === KEY && issued && kind === 'readback') throw new Error('synthetic settings readback failure');
    return get(key);
  };
  return () => { storage.getItem = get; storage.setItem = set; };
}
async function freshList(f, expectVisible) {
  const fresh = await loadGui({ store: f.store, nativeInitialization: true });
  try {
    if (expectVisible !== undefined) assert.equal((await request(fresh)).includes('Mira'), expectVisible, 'request after actual native restart');
    return list(fresh);
  } finally { fresh.close(); }
}
async function request(f) {
  const result = await f.callbacks.beforeRequest({ messages: [{ role: 'user', content: "Recall Mira's occupation from the current entity record." }], maxContextTokens: 128000 }, 'model');
  const messages = Array.isArray(result) ? result : result.messages;
  assert(Array.isArray(messages), 'registered request returned messages');
  return messages.slice(1).map(message => message.content || message.data || '').join('\n');
}
async function autosave(f) {
  const node = f.overlay.querySelector('#ssam');
  node.value = 'supportive';
  node.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  const status = f.overlay.querySelector('#settings-auto-save-status'), deadline = Date.now() + 6000;
  while (status.dataset.state === 'pending' || status.dataset.state === 'saving') {
    assert(Date.now() < deadline, 'autosave settles'); await sleep(10);
  }
  assert.equal(status.dataset.state, 'saved', status.textContent);
}

test('registered request fixture observes live entity name exclusion without modifying canonical source', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(f.key);
    assert((await request(f)).includes('Mira'), 'positive actual request contains source entity');
    f.api.MemoryEngine.CONFIG.entityBlocklist = ['Mira'];
    assert(!(await request(f)).includes('Mira'), 'actual request obeys active name exclusion');
    assert.equal(f.store.get(f.key), before);
  } finally { f.close(); }
});

for (const route of ['add', 'row', 'unblock']) for (const failure of ['false', 'throw', 'drop']) {
  test('registered ' + route + ' preserves exclusion and source after settings ' + failure, async () => {
    const prior = route === 'unblock' ? ['Mira'] : [], f = await fixture(prior);
    try {
      const beforeSettings = f.store.get(KEY), beforeSource = f.store.get(f.key);
      const undo = rejectSettings(f, failure), results = await action(f, route);
      assert.deepEqual(list(f), prior, 'failed save must not publish entityBlocklist');
      assert.equal(f.store.get(KEY), beforeSettings);
      assert.equal(f.store.get(f.key), beforeSource, 'failed settings save must not clean canonical source');
      assert(results.every(result => result.status === 'fulfilled'), 'registered event handles rejection');
      assert(text(f).includes('실패'), 'visible failure');
      assert(!text(f).includes('차단 해제됨') && !text(f).includes('Mira 차단됨'), 'no success toast');
      undo();
      assert.equal((await request(f)).includes('Mira'), prior.length === 0, 'same-runtime request preserves exclusion');
      assert.deepEqual(await freshList(f, prior.length === 0), prior, 'native restart preserves exclusion');
      await autosave(f);
      assert.deepEqual(JSON.parse(f.store.get(KEY)).entityBlocklist, prior, 'later autosave cannot promote failed change');
      assert.equal(JSON.parse(f.store.get(KEY)).fixtureMarker, 'preserve-blocklist-marker');
    } finally { f.close(); }
  });
}

test('unblock event catches settings rejection and reports it visibly', async () => {
  const f = await fixture(['Mira']);
  try {
    rejectSettings(f, 'false');
    const results = await action(f, 'unblock');
    assert(results.every(result => result.status === 'fulfilled'), 'unblock has no rejected event promise');
    assert(text(f).includes('차단 해제 실패'), 'specific visible unblock failure');
  } finally { f.close(); }
});

test('readback failure keeps verified RAM and explicitly reports uncertain storage outcome', async () => {
  const f = await fixture(['Mira']);
  try {
    const undo = rejectSettings(f, 'readback');
    const results = await action(f, 'unblock');
    assert.deepEqual(list(f), ['Mira']);
    assert.deepEqual(JSON.parse(f.store.get(KEY)).entityBlocklist, [], 'issued write is preserved without compensating rollback');
    assert(results.every(result => result.status === 'fulfilled'));
    assert(text(f).includes('저장 결과 미확인'), 'uncertain outcome is not ordinary rollback or success');
    undo();
    assert.deepEqual(await freshList(f, true), [], 'restart adopts actual stored value');
  } finally { f.close(); }
});

test('concurrent additions and autosave preserve both exclusion updates and the edited setting', async () => {
  const f = await fixture();
  try {
    const storage = f.w.risuai.pluginStorage, set = storage.setItem.bind(storage);
    let release, enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    let held = false, activeWrites = 0, maxActiveWrites = 0;
    storage.setItem = async (key, value) => {
      if (key !== KEY) return set(key, value);
      activeWrites++; maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      try {
        if (!held) { held = true; enteredResolve(); await new Promise(resolve => { release = resolve; }); }
        return await set(key, value);
      } finally { activeWrites--; }
    };
    const first = action(f, 'add', 'Mira');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replacement must reach its actual settings write')), 6000);
      entered.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    const second = action(f, 'add', 'Vale'), saving = autosave(f);
    await sleep(20);
    release(); await Promise.all([first, second, saving]);
    assert.equal(maxActiveWrites, 1, 'actual settings storage calls are serialized');
    assert.deepEqual(list(f).slice().sort(), ['Mira', 'Vale']);
    const saved = JSON.parse(f.store.get(KEY));
    assert.deepEqual(saved.entityBlocklist.slice().sort(), ['Mira', 'Vale']);
    assert.equal(saved.storyAuthorMode, 'supportive');
    assert.equal(saved.fixtureMarker, 'preserve-blocklist-marker');
    assert.deepEqual((await freshList(f, false)).sort(), ['Mira', 'Vale']);
  } finally { f.close(); }
});

for (const ack of ['void', 'true']) test('successful native ' + ack + ' acknowledgment keeps the adapter settings contract', async () => {
  const f = await fixture(['Mira']);
  try {
    const storage = f.w.risuai.pluginStorage, set = storage.setItem.bind(storage);
    storage.setItem = async (key, value) => { await set(key, value); return ack === 'true' ? true : undefined; };
    const results = await action(f, 'unblock');
    assert(results.every(result => result.status === 'fulfilled'));
    assert.deepEqual(list(f), []);
    assert.deepEqual(JSON.parse(f.store.get(KEY)).entityBlocklist, []);
    assert(text(f).includes('차단 해제됨'));
    assert.deepEqual(await freshList(f, true), []);
  } finally { f.close(); }
});

test('successful settings commit followed by cleanup rejection is reported as partial completion', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(f.key); f.control.rejectWrites = true;
    await action(f, 'add');
    assert.deepEqual(list(f), ['Mira']);
    assert.deepEqual(JSON.parse(f.store.get(KEY)).entityBlocklist, ['Mira']);
    assert.equal(f.store.get(f.key), before);
    assert(text(f).includes('설정 저장 완료') && text(f).includes('정리 실패'), 'two committed/failed phases are distinguished');
    assert(!text(f).includes('Mira 차단됨'), 'no complete-success toast');
  } finally { f.close(); }
});

const importConfig = async (f, value) => {
  const envelope = f.w.LibraSettingsSchema.buildPublicExport({ ...JSON.parse(f.store.get(KEY)), ...value });
  const raw = JSON.stringify(envelope);
  await f.overlay.querySelector('#settings-file-input').onchange({
    target: { files: [{ name: 'overlap-settings.json', size: Buffer.byteLength(raw), text: async () => raw }] }
  });
  const apply = f.overlay.querySelector('#btn-apply-settings-import');
  assert.equal(apply.disabled, false, 'valid portable import reaches actual preview');
  return apply.onclick();
};
async function waitStatus(f, expected) {
  const status = f.overlay.querySelector('#settings-auto-save-status'), deadline = Date.now() + 6000;
  while (status.dataset.state !== expected) {
    assert(Date.now() < deadline, 'settings status becomes ' + expected + ': ' + status.textContent);
    await sleep(10);
  }
  return status;
}

for (const route of ['import', 'reset']) test(route + ' cannot be overwritten by an autosave captured from the prior settings view', async () => {
  const f = await fixture();
  let release;
  try {
    if (route === 'reset') await importConfig(f, { directorEnabled: true, directorMode: 'light' });
    const source = f.store.get(f.key);
    const storage = f.w.risuai.pluginStorage, set = storage.setItem.bind(storage);
    let enteredResolve, held = false;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    storage.setItem = async (key, value) => {
      if (key === KEY && !held) {
        held = true; enteredResolve();
        await new Promise(resolve => { release = resolve; });
      }
      return set(key, value);
    };
    const replacing = route === 'import'
      ? importConfig(f, { directorEnabled: true, directorMode: 'light', storyAuthorEnabled: false, storyAuthorMode: 'disabled', fixtureMarker: 'latest-import' })
      : f.overlay.querySelector('#btn-reset-settings').onclick();
    if (route === 'reset') {
      const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
      assert(dialog, 'actual reset confirmation');
      Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '확인').click();
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('replacement must reach its actual settings write')), 6000);
      entered.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    const node = f.overlay.querySelector('#ssam');
    node.value = 'supportive';
    node.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    await waitStatus(f, 'saving'); // Capture the prior UI before releasing the replacement write.
    release(); release = null;
    await replacing;
    await sleep(100);
    const saved = JSON.parse(f.store.get(KEY)), expectedDirector = route === 'import' ? 'light' : 'disabled';
    assert.equal(saved.directorMode, expectedDirector, 'verified replacement retains its Director setting');
    assert.equal(saved.storyAuthorMode, 'disabled', 'stale autosave does not overwrite the replacement');
    assert.equal(f.api.MemoryEngine.CONFIG.directorMode, expectedDirector);
    assert.equal(f.store.get(f.key), source, 'settings conflict leaves canonical source intact');
    const status = await waitStatus(f, 'failed');
    assert(status.textContent.includes('이전 화면'), 'discarded edit is visibly reported');
    await autosave(f); // A deliberate edit of the refreshed view can be saved.
    assert.equal(JSON.parse(f.store.get(KEY)).directorMode, expectedDirector);
    assert.equal(JSON.parse(f.store.get(KEY)).storyAuthorMode, 'supportive');
    const fresh = await loadGui({ store: f.store, nativeInitialization: true });
    try { assert.equal(fresh.api.MemoryEngine.CONFIG.directorMode, expectedDirector); }
    finally { fresh.close(); }
  } finally { if (release) release(); f.close(); }
});

for (const failure of ['throw', 'mismatch']) test('unverified import readback ' + failure + ' cannot later be rolled back by the old UI autosave', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(KEY), storage = f.w.risuai.pluginStorage;
    const get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
    let issued = false;
    storage.setItem = async (key, value) => { const result = await set(key, value); if (key === KEY) issued = true; return result; };
    storage.getItem = async key => {
      if (key === KEY && issued) {
        if (failure === 'throw') throw new Error('synthetic import readback failure');
        return before;
      }
      return get(key);
    };
    await importConfig(f, { directorEnabled: true, directorMode: 'light', storyAuthorEnabled: false, storyAuthorMode: 'disabled' });
    assert.equal(f.api.MemoryEngine.CONFIG.directorMode, 'disabled', 'unverified import does not publish RAM');
    assert.equal(JSON.parse(f.store.get(KEY)).directorMode, 'light', 'issued replacement remains physically stored');
    storage.getItem = get; storage.setItem = set;
    const node = f.overlay.querySelector('#ssam');
    node.value = 'supportive';
    node.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    await sleep(100);
    assert.equal(JSON.parse(f.store.get(KEY)).directorMode, 'light', 'old UI cannot compensate an uncertain replacement');
    const status = await waitStatus(f, 'failed');
    assert(status.textContent.includes('이전 화면'));
    const fresh = await loadGui({ store: f.store, nativeInitialization: true });
    try { assert.equal(fresh.api.MemoryEngine.CONFIG.directorMode, 'light'); }
    finally { fresh.close(); }
  } finally { f.close(); }
});
