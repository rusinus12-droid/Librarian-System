'use strict';
// C.3: official capture, durable readback, fresh runtime, source edit, final beforeRequest injection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const { syntheticFetch, configure, readyForRecall } = require('./helpers/unload_recall_contract_fixture.cjs');
const MODES = ['plugin_only', 'mirror', 'server_only'];
const USER = 'I check the gauge and step back.';
const OLD_REPLY = 'The needle holds at the red mark and the spare valve hangs on the north wall hook.';
const NEW_REPLY = 'The needle holds at the blue mark and the spare valve rests inside the east cabinet.';
const OLD_FACT = 'needle holds at the red mark';
const NEW_FACT = 'needle holds at the blue mark';
const OLD_LOCATION = 'north wall hook';
const NEW_LOCATION = 'east cabinet';
const QUERY = 'What color did the needle show, and where is the spare valve now?';
const SETTINGS = {
  embeddingProvider: 'openai_compat', embeddingModel: 'unload-synthetic-v1', embeddingUrl: 'https://unload-fixture.invalid/v1', embeddingDimensions: 3, embeddingMaxRetries: 0, embeddingAutoProcess: false, embeddingEnabled: true,
  captureAfterRequest: true, episodeIndexEnabled: false, hookRecallTimeoutMs: 5000,
  maxInjectionChars: 4000
};
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 300; i += 1) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const flat = messages => JSON.stringify(messages ?? null);
const serverPluginRows = app => app.repositories.flashback.list('plugin', '').records || [];
const writerSnapshot = app => {
  try { return app.repositories.flashback.database.prepare('SELECT alias, epoch, owner, expires_at FROM flashback_writer_fences').all(); }
  catch (_) { return []; }
};
async function checkMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `flashback-c3-${mode}-`));
  let app = null;
  let fixture = null;
  let storage = null;
  let localStorage = null;
  const networkCalls = [];
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const fixtureOptions = {
      exposeStorageBridge: true,
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: serverUrl },
      nativeFetch: async (url, options) => {
        const call = { url: String(url), method: String(options?.method || 'GET') };
        if (call.url.endsWith('/v1/flashback/writer')) {
          try {
            const body = JSON.parse(String(options?.body || '{}'));
            call.action = body.action || ''; call.key = body.key || ''; call.owner = body.owner || '';
          } catch (_) {}
        }
        networkCalls.push(call);
        const response = await syntheticFetch(url, options, fetch);
        if (!response.ok) call.error = await response.clone().text();
        call.status = response.status;
        return response;
      }
    };
    fixture = await createFixture(fixtureOptions);
    storage = fixture.pluginStorage;
    localStorage = fixture.host.safeLocalStorage;
    const bridge = fixture.context.__fixtureStorageBridge;
    assert.ok(bridge, `${mode}: storage bridge exists`);
    // mirror is imported from the historical argument fixture; it is no longer selectable.
    if (mode !== 'plugin_only' && mode !== 'mirror') await bridge.setMode(mode);
    assert.equal(await bridge.getMode(), mode, `${mode}: actual scope mode is selected`);

    const api = fixture.api;
    const t = api._test;
    const sel = api._selectionTest;
    const captureBackend = await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, `${mode} registered Risu output listener`);
    await configure(fixture, 'configured');
    await api.saveSettings({ ...await api.loadSettings(), ...SETTINGS });
    await api.ingestLiveChatColdStart({ scope: 'current', canonical: true });
    await sel.beforeRequest([{ role: 'user', chatId: 'u1', content: USER }], 'model');
    await delay(50);
    fixture.currentChat.message = [
      { role: 'user', chatId: 'u1', data: USER },
      { role: 'assistant', chatId: 'a1', data: OLD_REPLY }
    ];
    fixture.currentChat.messages = fixture.currentChat.message;
    const dispatched = await fixture.dispatchRisuChatEvent('output', {
      char: fixture.character, chat: fixture.currentChat, characterIndex: 0, chatIndex: 0,
      messageIndex: fixture.currentChat.message.length - 1
    });
    assert.equal(dispatched, 1, `${mode}: the registered output handler receives the committed event`);
    const capture = await waitFor(() => {
      const state = api.getCaptureBackendState();
      return state.observedRuns > captureBackend.observedRuns && state.lastOutputCapture ? state : null;
    }, `${mode} registered output handler capture`);
    const scope = await api.resolveCurrentScope();
    const initial = await waitFor(async () => {
      const rows = await t.loadScopeRecords(scope.scopeKey);
      return (rows?.records || []).some(record => String(record.text || '').includes(OLD_FACT)) ? rows : null;
    }, `${mode} durable initial capture`);
    await readyForRecall(fixture, 'configured', OLD_FACT);
    const readyInitial = await t.loadScopeRecords(scope.scopeKey);
    const initialRecord = readyInitial.records.find(record => String(record.text || '').includes(OLD_FACT));
    assert.ok(initialRecord, `${mode}: durable readback contains the original fact`);
    const originalRaw = JSON.stringify(initialRecord);
    const captureRuntimeAfterPersist = t.pendingCaptureRuntimeSnapshot?.() || {};
    const captureActivityAfterPersist = api.getActivityLog().slice(-6).map(entry => ({ event: entry.event, level: entry.level, data: entry.data }));
    const writerAfterCapture = writerSnapshot(app);
    const chatSnapshot = clone(fixture.currentChat);
    const characterSnapshot = clone(fixture.character);
    await fixture.dispose();
    const writerAfterDispose = writerSnapshot(app);
    if (mode !== 'plugin_only' && writerAfterCapture.some(row => row.owner && row.expires_at > Date.now())) {
      const ownerAfterDispose = writerAfterDispose.find(row => row.alias === writerAfterCapture[0].alias);
      assert.ok(ownerAfterDispose && !ownerAfterDispose.owner && Number(ownerAfterDispose.expires_at || 0) === 0,
        `${mode}: successful unload drain releases the active output writer before disposal returns; before=${JSON.stringify(writerAfterCapture)} after=${JSON.stringify(writerAfterDispose)} queues=${JSON.stringify(captureRuntimeAfterPersist)}`);
    }

    // Fresh plugin runtime over the same durable owner stores and live chat snapshot.
    fixture = await createFixture({ ...fixtureOptions, pluginStorage: storage, safeLocalStorage: localStorage, chat: chatSnapshot, character: characterSnapshot });
    const writerAfterFreshStart = writerSnapshot(app);
    const freshApi = fixture.api;
    const freshTest = freshApi._test;
    const freshSelection = freshApi._selectionTest;
    await configure(fixture, 'configured');
    await freshApi.saveSettings({ ...await freshApi.loadSettings(), ...SETTINGS });
    const freshScope = await freshApi.resolveCurrentScope();
    assert.equal(freshScope.scopeKey, scope.scopeKey, `${mode}: restart resolves the same character/chat scope`);
    const freshBridge = fixture.context.__fixtureStorageBridge;
    const freshScopeMode = await freshBridge.getScopeMode(freshScope);
    assert.equal(freshScopeMode.mode, mode, `${mode}: the selected scope route survives plugin runtime restart`);
    const freshExecutionPolicy = await freshBridge.getScopeExecutionPolicy(freshScope);
    assert.equal(freshExecutionPolicy.storageMode, mode, `${mode}: fresh runtime resolves the expected storage authority`);
    const freshCaptureBackend = await waitFor(() => {
      const state = freshApi.getCaptureBackendState();
      return state.registered && state.backend === 'chat_output_v3' ? state : null;
    }, `${mode} fresh Risu output listener`);
    const durableAfterReload = await freshTest.loadScopeRecords(freshScope.scopeKey);
    assert.ok(durableAfterReload.records.some(record => JSON.stringify(record) === originalRaw),
      `${mode}: a fresh runtime reads back the captured canonical record intact`);

    // The first request reconciles the output event with the live turn worldline. The next request
    // reaches the same real beforeRequest path after that durable synchronization has completed.
    await readyForRecall(fixture, 'configured', OLD_FACT);
    fixture.currentChat.message.push({role:'user',chatId:'u8',data:QUERY});
    fixture.currentChat.messages=fixture.currentChat.message;
    const writerBeforeFirstRequest = writerSnapshot(app);
    const firstFreshMessages = await freshSelection.beforeRequest([{ role: 'user', chatId: 'u8', content: QUERY }], 'model');
    const writerAfterFirstRequest = writerSnapshot(app);
    const firstFreshInjection = flat(firstFreshMessages);
    const oldMessages = await freshSelection.beforeRequest([{ role: 'user', chatId: 'u9', content: QUERY }], 'model');
    const writerAfterSecondRequest = writerSnapshot(app);
    const oldInjection = flat(oldMessages);
    if (!oldInjection.includes(OLD_FACT)) {
      const runtimeRecall = freshTest.pendingCaptureRuntimeSnapshot?.().lastRecall || {};
      const manifest = await freshTest.loadScopeManifest(freshScope.scopeKey);
      const modeState = await freshBridge.getScopeMode(freshScope);
      const routePolicy = await freshBridge.getScopeExecutionPolicy(freshScope);
      const activity = freshApi.getActivityLog().slice(-8).map(entry => ({ event: entry.event, level: entry.level, data: entry.data }));
      const writerCalls = networkCalls.filter(call => call.url.endsWith('/v1/flashback/writer'));
      const failedCalls = networkCalls.filter(call => Number(call.status) >= 400).map(call => ({ url: call.url, action: call.action || '', owner: call.owner || '', status: call.status, error: call.error || '' }));
      assert.ok(false, `${mode}: final beforeRequest failed to inject current fact; ${JSON.stringify({ firstFreshHasFact: firstFreshInjection.includes(OLD_FACT), firstFreshRecall: freshTest.pendingCaptureRuntimeSnapshot?.().lastRecall, scope: { key: freshScope.scopeKey, mode: modeState.mode, policy: routePolicy.storageMode }, manifest: { commitId: manifest.commitId, shardCount: manifest.shardCount, count: manifest.count }, runtimeRecall, writerTimeline: { afterCapture: writerAfterCapture, afterDispose: writerAfterDispose, afterFreshStart: writerAfterFreshStart, beforeFirstRequest: writerBeforeFirstRequest, afterFirstRequest: writerAfterFirstRequest, afterSecondRequest: writerAfterSecondRequest }, failedCalls, activity })}; messages=${oldInjection}`);
    }
    assert.ok(firstFreshInjection.includes(OLD_FACT), `${mode}: first fresh-runtime request injects the canonical fact immediately after successful unload drain`);

    // Explicit reanalysis is available only after the model request completes.
    await freshSelection.afterRequest('The gauge reading is acknowledged.', 'model');
    // Edit the stored turn without changing either native message identity.
    fixture.currentChat.message[1].data = NEW_REPLY;
    fixture.currentChat.messages = fixture.currentChat.message;
    const ticket = await freshApi.previewSourceEdits(['1']);
    assert.equal(ticket.allowed, true, `${mode}: exact current turn is available for explicit replacement: ${JSON.stringify(ticket)}`);
    const applied = await freshApi.applySourceEdits(ticket);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.rawSaved, true);
    assert.equal(applied.remoteEmbeddingQueued, false, 'raw reanalysis cannot dispatch embedding itself');
    await readyForRecall(fixture, 'configured', NEW_FACT);
    const editedMessages = await freshSelection.beforeRequest([{ role: 'user', chatId: 'u10', content: QUERY }], 'model');
    const afterEdit = await freshTest.loadScopeRecords(freshScope.scopeKey);
    const editedRecord = afterEdit.records.find(record => String(record.text || '').includes(NEW_FACT));
    assert.ok(editedRecord, `${mode}: durable active records contain the edited fact`);
    assert.ok(!afterEdit.records.some(record => String(record.text || '').includes(OLD_FACT)),
      `${mode}: the retired text is not an active recall record`);
    const afterWorldline = await freshTest.loadTurnWorldline(freshScope.scopeKey);
    assert.ok(afterWorldline.retiredRecords?.some(record => record.id === initialRecord.id && String(record.text || '').includes(OLD_FACT)),
      `${mode}: old canonical remains as inactive worldline history`);
    const retiredOriginal = afterWorldline.retiredRecords?.find(record => record.id === initialRecord.id);
    assert.ok(retiredOriginal, `${mode}: the original record remains in retired worldline history`);
    const stableCanonical = record => ({ text: record.text, vector: record.vector, sourceHash: record.sourceHash,
      sourceMessageIds: record.sourceMessageIds, rawDigest: record.metadata?.sourceRawDigest });
    const beforeStable = stableCanonical(initialRecord), afterStable = stableCanonical(retiredOriginal);
    const changedStableFields = Object.keys(beforeStable).filter(key => JSON.stringify(beforeStable[key]) !== JSON.stringify(afterStable[key]));
    assert.equal(JSON.stringify(afterStable), JSON.stringify(beforeStable),
      `${mode}: source bytes and embedding remain intact; changed=${JSON.stringify(changedStableFields)}`);

    // One more public request observes the durable replacement and is the outcome sent to the model.
    const finalMessages = await freshSelection.beforeRequest([{ role: 'user', chatId: 'u11', content: QUERY }], 'model');
    const finalInjection = flat(finalMessages);
    assert.ok(finalInjection.includes(NEW_FACT), `${mode}: final request injects the edited fact`);
    assert.ok(finalInjection.includes(NEW_LOCATION), `${mode}: final request injects the edited location`);
    assert.ok(!finalInjection.includes(OLD_FACT), `${mode}: retired fact never returns as current injected evidence`);
    assert.ok(!finalInjection.includes(OLD_LOCATION), `${mode}: retired location never returns as current injected evidence`);

    const serverRows = serverPluginRows(app);
    const finalManifest = await freshTest.loadScopeManifest(freshScope.scopeKey);
    const serverCanonical = Array.from({ length: finalManifest.shardCount }, (_, index) => {
      const key = `vector_rag_memory:scope:${finalManifest.storageHash}:records:commit:${finalManifest.commitId}:shard:${String(index).padStart(4, '0')}`;
      return app.repositories.flashback.get('plugin', key).value;
    }).filter(Boolean);
    const serverHasCurrent = serverCanonical.some(value => JSON.stringify(value).includes(NEW_FACT));
    const localValues = [...storage.values.values()].map(value => JSON.stringify(value));
    const localHasCurrent = localValues.some(value => value.includes(NEW_FACT));
    const localKeys = [...storage.values.keys()].map(String);
    if (mode === 'plugin_only') {
      assert.equal(networkCalls.filter(call => new URL(call.url).hostname === '127.0.0.1').length, 0, 'plugin_only uses no storage server calls');
      assert.equal(serverRows.length, 0, 'plugin_only writes no Flashback server rows');
      assert.ok(localHasCurrent, 'plugin_only keeps the active canonical locally');
    } else if (mode === 'mirror') {
      assert.ok(serverHasCurrent, 'mirror projects the active canonical to the server');
      assert.ok(localHasCurrent, 'mirror retains the active canonical locally');
    } else {
      assert.ok(serverHasCurrent, 'server_only keeps the active canonical on the server');
      assert.equal(localHasCurrent, false, 'server_only has no local canonical body');
      assert.equal(localKeys.some(key => /:records:commit:|:records:shard:|:turn_worldline:v1/.test(key)), false,
        'server_only has no local canonical shard or turn-worldline key');
    }

    return { mode, scopeKey: scope.scopeKey, initialId: initialRecord.id, currentId: editedRecord.id,
      currentFact: NEW_FACT, currentLocation: NEW_LOCATION, serverRows: serverRows.length,
      networkCalls: networkCalls.length, captureBackend: capture.backend, freshCaptureBackend: freshCaptureBackend.backend,
      serverCanonicalShards: serverCanonical.length, oldCanonicalRetained: true,
      writer: { afterCapture: writerAfterCapture, afterDispose: writerAfterDispose,
        afterFreshStart: writerAfterFreshStart, beforeFirstRequest: writerBeforeFirstRequest,
        afterFirstRequest: writerAfterFirstRequest, afterSecondRequest: writerAfterSecondRequest,
        events: networkCalls.filter(call => call.url.endsWith('/v1/flashback/writer'))
          .map(({ action, key, owner, status }) => ({ action, key, owner, status })) } };
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await checkMode(mode));
  const logical = results.map(({ currentFact, currentLocation }) => `${currentFact}|${currentLocation}`);
  assert.deepEqual(logical, [`${NEW_FACT}|${NEW_LOCATION}`, `${NEW_FACT}|${NEW_LOCATION}`, `${NEW_FACT}|${NEW_LOCATION}`],
    'all storage modes produce the same current injected facts');
  process.stdout.write(JSON.stringify({ test: 'flashback_source_edit_final_injection_3mode', results }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
