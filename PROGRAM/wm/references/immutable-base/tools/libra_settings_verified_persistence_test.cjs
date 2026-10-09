'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');

const KEY = 'LMAI_Config';
const disabled = { storyAuthorEnabled: false, storyAuthorMode: 'disabled', directorEnabled: false, directorMode: 'disabled' };
const enabled = { storyAuthorEnabled: true, storyAuthorMode: 'supportive', directorEnabled: true, directorMode: 'light' };
const json = value => JSON.stringify(value);
const importSettings = async (f, value) => {
  const input = f.overlay.querySelector('#settings-file-input');
  assert.equal(typeof input.onchange, 'function', 'registered file-import handler');
  await input.onchange({ target: { files: [{ name: 'fixture-settings.json', text: async () => json(value) }] } });
};
const assertModes = (f, expected) => {
  for (const key of Object.keys(disabled)) assert.equal(f.api.MemoryEngine.CONFIG[key], expected[key], key);
  assert.equal(f.overlay.querySelector('#ssam').value, expected.storyAuthorMode);
  assert.equal(f.overlay.querySelector('#sdm').value, expected.directorMode);
};

for (const failure of ['false', 'throw', 'ack-without-write', 'readback-throw', 'readback-mismatch']) {
  test(`registered import blocks runtime publication after ${failure}`, async () => {
    const before = json(disabled);
    const store = new Map([[KEY, before]]);
    const f = await loadGui({ store });
    try {
      assertModes(f, disabled);
      const storage = f.w.risuai.pluginStorage;
      const get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
      let attempted = false;
      storage.setItem = async (key, value) => {
        if (key !== KEY) return set(key, value);
        attempted = true;
        if (failure === 'false') return false;
        if (failure === 'throw') throw new Error('synthetic settings write failure');
        if (failure === 'ack-without-write') return true;
        return set(key, value);
      };
      storage.getItem = async key => {
        if (key === KEY && attempted && failure === 'readback-throw') throw new Error('synthetic settings read failure');
        if (key === KEY && attempted && failure === 'readback-mismatch') return before;
        return get(key);
      };
      await importSettings(f, enabled);
      assert(attempted);
      assertModes(f, disabled);
      assert(!f.w.document.body.textContent.includes('설정 파일 가져오기 완료'), 'no success toast');
      assert(f.w.document.body.textContent.includes('설정 파일 가져오기 실패'), 'visible failure');
      if (['false', 'throw', 'ack-without-write'].includes(failure)) assert.equal(store.get(KEY), before);
      else assert.equal(JSON.parse(store.get(KEY)).storyAuthorMode, enabled.storyAuthorMode, 'issued durable write is preserved; no compensating rollback');
      assert.equal(f.api.StoryAuthor.formatForPrompt(), '');
      assert.equal(f.api.Director.formatForPrompt(), '');
    } finally { f.close(); }
  });
}

test('verified imported modes reach storage, fresh runtime, GUI and prompt consumers', async () => {
  const store = new Map([[KEY, json(disabled)]]);
  const f = await loadGui({ store });
  let fresh;
  try {
    await importSettings(f, { ...enabled, fixtureMarker: 'settings-roundtrip-marker' });
    assertModes(f, enabled);
    const stored = JSON.parse(store.get(KEY));
    for (const key of Object.keys(enabled)) assert.equal(stored[key], enabled[key]);
    assert.equal(stored.fixtureMarker, 'settings-roundtrip-marker');
    assert.match(f.api.StoryAuthor.formatForPrompt(), /Supportive mode/);
    assert.match(f.api.Director.formatForPrompt(), /Light mode/);
    fresh = await loadGui({ store });
    assertModes(fresh, enabled);
    assert.match(fresh.api.StoryAuthor.formatForPrompt(), /Supportive mode/);
    assert.match(fresh.api.Director.formatForPrompt(), /Light mode/);
    await importSettings(fresh, disabled);
    assertModes(fresh, disabled);
    assert.equal(fresh.api.StoryAuthor.formatForPrompt(), '');
    assert.equal(fresh.api.Director.formatForPrompt(), '');
    assert.equal(JSON.parse(store.get(KEY)).directorEnabled, false);
  } finally { fresh?.close(); f.close(); }
});

test('failed GUI auto-save keeps stored/runtime modes and succeeds on explicit retry', async () => {
  const store = new Map([[KEY, json(disabled)]]);
  const f = await loadGui({ store });
  try {
    const storage = f.w.risuai.pluginStorage, set = storage.setItem.bind(storage);
    let reject = true;
    storage.setItem = async (key, value) => key === KEY && reject ? false : set(key, value);
    for (const [id, value] of [['ssam', 'supportive'], ['sdm', 'light']]) {
      const node = f.overlay.querySelector('#' + id);
      node.value = value;
      node.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    }
    const status = f.overlay.querySelector('#settings-auto-save-status');
    const deadline = Date.now() + 4000;
    while (status.dataset.state === 'pending' || status.dataset.state === 'saving') {
      assert(Date.now() < deadline, 'auto-save settles');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.dataset.state, 'failed');
    assert.equal(store.get(KEY), json(disabled));
    for (const key of Object.keys(disabled)) assert.equal(f.api.MemoryEngine.CONFIG[key], disabled[key]);
    reject = false;
    f.overlay.querySelector('#sdm').dispatchEvent(new f.w.Event('change', { bubbles: true }));
    while (status.dataset.state !== 'saved') {
      assert(Date.now() < deadline, 'retry settles');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assertModes(f, enabled);
    assert.equal(JSON.parse(store.get(KEY)).storyAuthorMode, 'supportive');
  } finally { f.close(); }
});

test('chunked settings import verifies reconstructed payload and detects missing chunk', async () => {
  const store = new Map([[KEY, json(disabled)]]);
  const f = await loadGui({ store });
  try {
    const payload = { ...enabled, fixtureMarker: 'chunk-marker-' + 'x'.repeat(530000) };
    await importSettings(f, payload);
    assertModes(f, enabled);
    const manifest = JSON.parse(store.get(KEY));
    assert.equal(manifest.schemaVersion, 1);
    assert(manifest.chunks.length > 1);
    const readback = manifest.chunks.map(key => store.get(key)).join('');
    assert.equal(JSON.parse(readback).fixtureMarker, payload.fixtureMarker);
    const storage = f.w.risuai.pluginStorage, get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
    let published = false;
    storage.setItem = async (key, value) => { const result = await set(key, value); if (key === KEY) published = true; return result; };
    storage.getItem = async key => published && key.startsWith(KEY + '::chunk:v1:') ? null : get(key);
    await importSettings(f, { ...disabled, fixtureMarker: payload.fixtureMarker });
    for (const key of Object.keys(enabled)) assert.equal(f.api.MemoryEngine.CONFIG[key], enabled[key]);
    assert(f.w.document.body.textContent.includes('설정 파일 가져오기 실패'));
  } finally { f.close(); }
});

test('registered settings reset preserves prior configuration when storage rejects it', async () => {
  const store = new Map([[KEY, json(enabled)]]);
  const f = await loadGui({ store });
  try {
    assertModes(f, enabled);
    const storage = f.w.risuai.pluginStorage, set = storage.setItem.bind(storage);
    storage.setItem = async (key, value) => key === KEY ? false : set(key, value);
    const reset = f.overlay.querySelector('#btn-reset-settings').onclick();
    const dialog = f.w.document.querySelector('[data-libra-dialog="true"]');
    assert(dialog, 'actual confirmation dialog opens');
    [...dialog.querySelectorAll('button')].find(button => button.textContent === '확인').click();
    await reset;
    assertModes(f, enabled);
    assert.equal(store.get(KEY), json(enabled));
    assert(f.w.document.body.textContent.includes('설정 초기화 저장 실패'));
    assert(!f.w.document.body.textContent.includes('설정 초기화됨'));
  } finally { f.close(); }
});
