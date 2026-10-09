'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {clone, parent, branch, character} = require('./fixtures/native_branch_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    const root = parent(`pending-parent-${mode}`, 1);
    root.message[1].data = 'Alice placed the key on the table.';
    const char = character([root]);
    let current = root, listener, modelCalls = 0, releaseProvider;
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
      runLLMModel: async () => { modelCalls += 1; return await waitingProvider; }
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
      await waitFor(() => rows().some(row => row.value?.schema === 'libra.micro_work.v1'
        && row.value.status === 'reserved'), 15000);
      await waitFor(() => modelCalls >= 1, 15000);
      const parentReceipt = rows().find(row => row.value?.schema === 'libra.completed_turn_receipt.v1'
        && row.value.scopeKey === proof.scopeKey);
      assert.ok(parentReceipt, `${mode}: receipt is durable before provider returns`);
      assert.equal(rows().filter(row => row.value?.schema === 'libra.micro_memory.v1'
        && row.value.scopeKey === proof.scopeKey).length, 0);
      const child = branch(root, 1, `pending-child-${mode}`);
      char.chats.unshift(child);
      current = child;
      const callsBefore = modelCalls;
      if (mode === 'mirror') {
        const originalSet = fx.backend.setItem;
        let injected = false;
        fx.backend.setItem = async (storageKey, value) => {
          if (!injected && String(storageKey).includes(':source-receipt-head:')
            && !String(storageKey).includes(`:scope:${proof.scopeKey}:`)) {
            injected = true;
            throw new Error('fixture_pending_target_receipt_head_failure');
          }
          return originalSet(storageKey, value);
        };
        await assert.rejects(() => api.debugNativeChatCopy({force: true}),
          /fixture_pending_target_receipt_head_failure|LIBRA_VERIFIED_STORAGE_COPY_MISMATCH/);
        fx.backend.setItem = originalSet;
        assert.equal(injected, true);
        const pendingTargetKey = storageKey => String(storageKey).startsWith('libra:v1:scope:')
          && !String(storageKey).includes(`:scope:${proof.scopeKey}:`)
          && /:(?:source-receipt|person-span-inventory|micro-work):/.test(storageKey);
        assert.equal([...fx.local.keys()].filter(pendingTargetKey).length, 0,
          'local rollback removes a partial pending-work copy');
        assert.equal(fx.storedRows().filter(row => pendingTargetKey(row.key)).length, 0,
          'server rollback removes a partial pending-work copy');
      }
      const copy = await api.debugNativeChatCopy({force: true});
      assert.equal(copy.result?.ok, true, `${mode}: ${JSON.stringify(copy)}`);
      assert.equal(modelCalls, callsBefore, `${mode}: copy does not spend another provider call`);
      const childScope = (await api.getHostLineageStatus()).scopeKey;
      const childRows = rows().filter(row => row.key.includes(`:scope:${childScope}:`));
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.completed_turn_receipt.v1').length, 1);
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.micro_work.v1').length, 1);
      assert.equal(childRows.filter(row => row.value?.schema === 'libra.micro_memory_head.v1').length, 0,
        `${mode}: pending work is not promoted to an active Micro head`);
      const targetReceipt = await api.debugReadActiveCompletedTurnReceipt(1);
      assert.equal(targetReceipt.status, 'verified');
      assert.notEqual(targetReceipt.receipt.scopeKey, parentReceipt.value.scopeKey);
      assert.equal(copy.result.expectedMicroOwnerRecords, copy.result.verifiedMicroOwnerRecords);
      const restarted = await fx.restart();
      assert.equal((await restarted.r.api.debugReadActiveCompletedTurnReceipt(1)).status,
        'verified', `${mode}: fresh bridge re-reads the pending receipt`);
      assert.equal(rows().filter(row => row.value?.schema === 'libra.micro_work.v1'
        && row.value.scopeKey === childScope).length, 1,
      `${mode}: pending reservation remains physically readable after restart`);
      assert.equal(modelCalls, callsBefore,
        `${mode}: restart does not re-invoke the pending provider automatically`);
      releaseProvider({type: 'error', result: 'fixture provider stopped'});
      console.log(`PASS pending Micro work survives native copy in ${mode}`);
    } finally {
      releaseProvider({type: 'error', result: 'fixture cleanup'});
      await fx.cleanup();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
