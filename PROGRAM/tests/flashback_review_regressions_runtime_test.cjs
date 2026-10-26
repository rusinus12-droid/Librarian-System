'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { serverModeFixture } = require('./flashback_server_mode_recovery_test.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

function cloneHostReads(f) {
  for (const name of ['getCharacter', 'getCharacterFromIndex', 'getChat', 'getCurrentChat', 'getChatFromIndex']) {
    const read = f.host[name].bind(f.host);
    f.host[name] = async (...args) => structuredClone(await read(...args));
  }
}

function observeMutations(f) {
  const fetch = f.host.nativeFetch;
  let writes = 0;
  f.host.nativeFetch = async (url, init) => {
    if (/\/v1\/kv\/(set|batch|remove)/.test(url) && init.method === 'POST') writes++;
    return fetch(url, init);
  };
  return () => writes;
}

for (const change of ['text', 'chat', 'settings', 'inventory', 'cancel']) {
  test(`server sync refuses stale ${change} before any KV mutation`, async () => {
    const f = await serverModeFixture();
    try {
      cloneHostReads(f);
      const plan = await f.api.inspectMemoryMaintenance();
      const writes = observeMutations(f);
      const controller = new AbortController();
      if (change === 'text') f.currentChat.message[3].data = 'The map has been burned.';
      if (change === 'chat') f.currentChat.id = f.currentChat.chatId = 'another-chat';
      if (change === 'settings') {
        const key = 'vector_rag_memory:settings:v2';
        const settings = JSON.parse(await f.pluginStorage.getItem(key));
        settings.overrides.hashDimensions = 64;
        f.pluginStorage.values.set(key, JSON.stringify(settings));
      }
      if (change === 'inventory') {
        const row = [...f.serverRows.values()].find(row => row.key.endsWith(':manifest:v2'));
        row.revision++;
      }
      if (change === 'cancel') controller.abort();
      const before = JSON.stringify([...f.serverRows]);
      await assert.rejects(() => f.api.runMemoryMaintenance('sync', { preflight: plan, signal: controller.signal }),
        /changed|변경|STALE_SOURCE|cancel|ABORTED|HEALTH_/i);
      assert.equal(writes(), 0, 'a refusal must precede storage mutations');
      assert.equal(JSON.stringify([...f.serverRows]), before);
    } finally { await f.dispose(); }
  });
}

for (const change of ['text', 'cancel', 'serverIdentity', 'reset', 'route']) {
  test(`server sync rechecks ${change} after awaited worldline reads`, async () => {
    const f = await serverModeFixture();
    try {
      cloneHostReads(f);
      const plan = await f.api.inspectMemoryMaintenance();
      const writes = observeMutations(f);
      const fetch = f.host.nativeFetch;
      const controller = new AbortController();
      let changed = false;
      f.host.nativeFetch = async (url, init) => {
        const response = await fetch(url, init);
        if (!changed && url.includes('/v1/kv/get') && new URL(url).searchParams.get('key')?.endsWith(':turn_worldline:v1')) {
          changed = true;
          if (change === 'text') f.currentChat.message[3].data = 'Edited while loading the worldline.';
          if (change === 'cancel') controller.abort();
          const raw = f.context.__inspectionFixture;
          if (change === 'serverIdentity') raw.state.bootstrap.value = { ...raw.state.bootstrap.value, dataInstanceId: 'Z'.repeat(32) };
          if (change === 'reset') raw.state.bootstrap.value.resetEpochs.flashback++;
          if (change === 'route') {
            const route = JSON.parse(await f.pluginStorage.getItem(raw.routeKey));
            route.entries[f.scope.scopeKey].mode = 'plugin_only';
            f.pluginStorage.values.set(raw.routeKey, JSON.stringify(route));
          }
        }
        return response;
      };
      const before = JSON.stringify([...f.serverRows]);
      await assert.rejects(() => f.api.runMemoryMaintenance('sync', { preflight: plan, signal: controller.signal }),
        /changed|변경|STALE_SOURCE|cancel|ABORTED|HEALTH_/i);
      assert.ok(changed, 'the asynchronous read boundary was reached');
      assert.equal(writes(), 0, 'no stale worldline or record is published');
      assert.equal(JSON.stringify([...f.serverRows]), before);
    } finally { await f.dispose(); }
  });
}

test('scope metadata inspection preserves server routing and server records', async () => {
  const f = await serverModeFixture();
  try {
    const key = f.context.__inspectionFixture.routeKey;
    const route = await f.pluginStorage.getItem(key);
    const before = JSON.stringify([...f.serverRows]);
    const result = await f.api._test.repairScopeRegistryMetadata();
    assert.ok(result.checked > 0, 'actually inspect a registered scope');
    assert.equal(await f.pluginStorage.getItem(key), route);
    assert.equal(JSON.stringify([...f.serverRows]), before);
    assert.equal((await f.api._test.classifyScopeForManagement(f.scope.scopeKey)).kind, 'server_managed');
  } finally { await f.dispose(); }
});

const editorSource = () => fs.readFileSync(process.env.FLASHBACK_TEST_PLUGIN || require.resolve('../plugins/Flashback_Memory.js'), 'utf8')
  .replace('_test: { maintenanceResultText,', '_test: { renderManualEditorPanelHtml,listManualEditorRecords,ensureManualEditorState,renderFlashbackWorldlineView,maintenanceResultText,');
const record = (i, turn = i + 1) => ({
  id: 'r' + i, hash: 'h' + i, sourceId: 's' + i, type: 'response', sourceType: 'response',
  text: 'Original turn ' + turn, turnIndex: turn,
  createdAt: new Date(1700000000000 + i * 1000).toISOString(), dim: 4, vector: [1, 0, 0, 0]
});

test('turn search scans beyond the first page, invalidates selection cache and pages all chunks', async () => {
  const f = await createFixture({ source: editorSource() });
  try {
    const t = f.api._test, scope = await f.api.resolveCurrentScope(false);
    await t.saveAllRecords(Array.from({ length: 100 }, (_, i) => record(i)), null, scope);
    const all = await t.listManualEditorRecords({ scope });
    assert.equal(all.records.length, 80);
    assert.equal(all.total, 100);
    t.ensureManualEditorState().selectedTurn = 1;
    const found = await t.listManualEditorRecords({ scope });
    assert.deepEqual(Array.from(found.records, r => r.turnIndex), [1]);
    assert.equal(found.total, 1);
    assert.equal(found.countMismatch, false);
    assert.doesNotMatch(t.renderManualEditorPanelHtml(found), /T1 턴에 해당하는 응답 원문이 없습니다/);
    t.ensureManualEditorState().selectedTurn = null;
    assert.equal((await t.listManualEditorRecords({ scope })).total, 100, 'clear filter invalidates cached selection');
    await t.saveAllRecords(Array.from({ length: 101 }, (_, i) => record(i, 1)), null, scope);
    t.ensureManualEditorState().selectedTurn = 1;
    const first = await t.listManualEditorRecords({ scope });
    assert.equal(first.total, 101);
    assert.equal(first.records.length, 80);
    assert.equal(first.hasMore, true);
    assert.match(t.renderManualEditorPanelHtml(first), /data-manual-load-more/);
    const last = await t.listManualEditorRecords({ scope, limit: 160 });
    assert.equal(last.records.length, 101);
    assert.equal(last.hasMore, false);
  } finally { await f.dispose(); }
});

test('unknown worldline memory never appears stored or fully connected', async () => {
  const f = await createFixture({ source: editorSource() });
  try {
    const t = f.api._test, scope = await f.api.resolveCurrentScope(false);
    const view = { scope, nodes: [{ status: 'active', pairIndex: 1, turnNodeId: 'n1', memory: 'unknown' }], revision: 1, present: true };
    const html = t.renderFlashbackWorldlineView(view);
    assert.doesNotMatch(html, /기억 연결률 100%|<small>보관됨<\/small>|없음 · 삭제되었거나/);
    assert.match(html, /확인 불가|미확인/);
    view.nodes[0].memory = 'stored';
    assert.match(t.renderFlashbackWorldlineView(view), /기억 연결률 100%/);
    view.nodes[0].memory = 'none';
    assert.match(t.renderFlashbackWorldlineView(view), /누락 1턴/);
    view.nodes = [];
    assert.doesNotMatch(t.renderFlashbackWorldlineView(view), /기억 연결률 100%/);
  } finally { await f.dispose(); }
});
