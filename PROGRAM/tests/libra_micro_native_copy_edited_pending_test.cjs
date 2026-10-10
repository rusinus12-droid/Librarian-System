'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {clone, parent, branch, character} = require('./fixtures/native_branch_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const waitForAsync = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for a physically verified Micro.');
};

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    const root = parent(`edited-pending-parent-${mode}`, 1);
    root.message[1].data = 'Alice placed the key on the table.';
    const char = character([root]);
    let current = root, listener, modelCalls = 0, holdNext = false, releaseProvider;
    const waitingProvider = new Promise(resolve => { releaseProvider = resolve; });
    const host = {
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => char.chats.indexOf(current),
      getCharacter: async () => clone(char),
      getCharacterFromIndex: async () => clone(char),
      getChat: async () => clone(current),
      getCurrentChat: async () => clone(current),
      getChatFromIndex: async (_ci, i) => clone(char.chats[i]),
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [clone(char)], plugins: []};
        return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      },
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
      runLLMModel: async () => {
        modelCalls += 1;
        return holdNext ? await waitingProvider
          : {type: 'error', result: 'fixture first revision unavailable'};
      }
    };
    const fx = await serverFixture({mode, host,
      transformSource: source => source.replace('\n\n  const RisuCompat = (() => {',
        '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
    try {
      const api = fx.f.r.api;
      const rows = () => mode === 'server_only' ? fx.storedRows() : localRows(fx.local);
      const proof = await api.getHostLineageStatus();
      const scope = {scopeId: proof.scopeKey, scopeKey: proof.scopeKey,
        characterId: char.id, chatId: root.id, aliases: [proof.scopeKey, root.id], label: root.id};
      await fx.f.r.context.__fixtureStorageBridge.setScopeMode(scope, mode);
      listener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => rows().some(row => row.value?.schema === 'libra.micro_memory.v1'
        && row.value.scopeKey === proof.scopeKey), 15000);
      const firstMicro = await waitForAsync(async () => {
        const candidate = await api.debugReadActiveMicroMemory(1);
        return candidate.status === 'verified' ? candidate : false;
      }, 15000);
      assert.equal(firstMicro.status, 'verified');
      holdNext = true;
      root.message[1].data += ' She smiled.';
      listener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => rows().some(row => row.value?.schema === 'libra.micro_work.v1'
        && row.value.scopeKey === proof.scopeKey
        && row.value.status === 'reserved'
        && row.value.sourceRevisionId !== firstMicro.record.sourceRevisionId), 15000);
      await waitFor(() => modelCalls >= 2, 15000);
      const child = branch(root, 1, `edited-pending-child-${mode}`);
      char.chats.unshift(child);
      current = child;
      const beforeCopyCalls = modelCalls;
      const copy = await api.debugNativeChatCopy({force: true});
      assert.equal(copy.result?.ok, true, `${mode}: ${JSON.stringify(copy)}`);
      assert.equal(modelCalls, beforeCopyCalls);
      const childScope = (await api.getHostLineageStatus()).scopeKey;
      const childRows = rows().filter(row => row.key.includes(`:scope:${childScope}:`));
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.micro_memory.v1').length, 1,
        `${mode}: old Micro remains historical`);
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.micro_memory_head.v1').length, 0,
        `${mode}: stale predecessor is never promoted to active head`);
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.completed_turn_receipt.v1').length, 2);
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.micro_work.v1').length, 2);
      if (mode !== 'plugin_only') {
        const serverRows = fx.storedRows().filter(row => row.key.includes(`:scope:${childScope}:`));
        assert.equal(serverRows.filter(row => row.value?.schema === 'libra.micro_memory.v1').length, 1,
          `${mode}: historical Micro is physically present in SQLite`);
        assert.equal(serverRows.filter(row => row.value?.schema === 'libra.micro_memory_head.v1').length, 0);
      }
      const activeReceipt = await api.debugReadActiveCompletedTurnReceipt(1);
      assert.equal(activeReceipt.status, 'verified');
      assert.equal(activeReceipt.receipt.sourceDigest,
        childRows.find(row => row.value?.schema === 'libra.micro_work.v1'
          && row.value.status === 'reserved')?.value.sourceDigest);
      const restarted = await fx.restart();
      assert.notEqual((await restarted.r.api.debugReadActiveMicroMemory(1)).status, 'verified',
        `${mode}: restart cannot promote the predecessor`);
      assert.equal((await restarted.r.api.debugReadActiveCompletedTurnReceipt(1)).status, 'verified');
      releaseProvider({type: 'error', result: 'fixture provider stopped'});
      console.log(`PASS edited pending Micro keeps predecessor historical in ${mode}`);
    } finally {
      releaseProvider({type: 'error', result: 'fixture cleanup'});
      await fx.cleanup();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
