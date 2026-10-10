'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {clone, parent, branch, character} = require('./fixtures/native_branch_fixture.cjs');

const waitForMicro = async (api, turn, priorRecordKey = '') => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await api.debugReadActiveMicroMemory(turn);
    if (result.status === 'verified' && result.recordKey !== priorRecordKey) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for active Micro at T${turn}`);
};
const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    const root = parent(`micro-parent-${mode}`, 1);
    root.message[1].data = 'Alice placed the key on the table.';
    const char = character([root]);
    let current = root, outputListener, modelCalls = 0;
    const host = {
      getCurrentCharacterIndex: async () => 0,
      getCurrentChatIndex: async () => char.chats.indexOf(current),
      getCharacter: async () => clone(char),
      getCharacterFromIndex: async () => clone(char),
      getChat: async () => clone(current),
      getCurrentChat: async () => clone(current),
      getChatFromIndex: async (_characterIndex, chatIndex) => clone(char.chats[chatIndex]),
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [clone(char)], plugins: []};
        return Array.isArray(fields)
          ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      },
      addRisuChatListener: async (_kind, handler) => { outputListener = handler; return true; },
      runLLMModel: async () => { modelCalls += 1;
        return {type: 'error', result: 'controlled provider unavailable'}; }
    };
    const fx = await serverFixture({mode, host});
    try {
      const api = fx.f.r.api;
      const rows = () => mode === 'server_only' ? fx.storedRows() : localRows(fx.local);
      const settings = await api.getLibraMemorySettings();
      await api.saveLibraMemorySettings({...settings, enableCharacterAide: false,
        enableWorldAide: false, enablePlotAide: false, stateTrackingEnabled: false});
      assert.equal(typeof outputListener, 'function');
      outputListener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      const firstMicro = await waitForMicro(api, 1);
      assert.equal(firstMicro.record.analysisStatus, 'minimum_source_bound');
      root.message[1].data += ' She smiled.';
      outputListener({char, chat: root, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      const revisedMicro = await waitForMicro(api, 1, firstMicro.recordKey);
      assert.notEqual(revisedMicro.record.sourceRevisionId, firstMicro.record.sourceRevisionId);
      assert.equal(rows().some(row => row.key.endsWith(':manifest') && row.value.chatId === root.id
        && Object.keys(row.value.memories || {}).length > 0), false,
      `${mode}: the parent has no five-turn Canonical`);

      const child = branch(root, 1, `micro-child-${mode}`);
      char.chats.unshift(child);
      current = child;
      const callsBeforeCopy = modelCalls;
      const copy = await api.debugNativeChatCopy({force: true});
      assert.equal(copy.result?.ok, true, `${mode}: ${JSON.stringify(copy)}`);
      assert.equal(modelCalls, callsBeforeCopy, `${mode}: copy makes no provider call`);
      assert.equal(copy.result.expectedMicroRecords, 2);
      assert.equal(copy.result.verifiedMicroRecords, 2);
      assert.ok(copy.result.expectedMicroOwnerRecords > copy.result.expectedMicroRecords,
        `${mode}: the transfer receipt counts source, work and person records too`);
      assert.equal(copy.result.verifiedMicroOwnerRecords, copy.result.expectedMicroOwnerRecords);
      assert.ok(copy.result.sourceMicroGraphDigest && copy.result.targetMicroGraphDigest);
      const targetMicro = await api.debugReadActiveMicroMemory(1);
      assert.equal(targetMicro.status, 'verified', `${mode}: child active Micro is source-bound`);
      assert.equal(targetMicro.record.analysisStatus, 'minimum_source_bound');
      assert.notEqual(targetMicro.record.scopeKey, firstMicro.record.scopeKey);
      const targetScopeKey = targetMicro.record.scopeKey;
      const targetRecords = () => rows().filter(row => row.value?.schema === 'libra.micro_memory.v1'
        && row.value.scopeKey === targetScopeKey);
      assert.equal(targetRecords().length, 2, `${mode}: active and superseded Micro records are durable`);
      assert.equal(targetRecords().filter(row => row.value.sourceRevisionId
        === targetMicro.record.sourceRevisionId).length, 1,
      `${mode}: edited predecessor remains historical`);
      const inventories = rows().filter(row => row.value?.schema === 'libra.person_span_inventory.v1'
        && row.value.scopeKey === targetScopeKey);
      assert.equal(inventories.length, 2,
        `${mode}: person evidence inventories for both source revisions survive copy`);
      for (const schema of ['libra.completed_turn_receipt.v1', 'libra.completed_turn_capture.v1',
        'libra.micro_work.v1']) {
        const count = rows().filter(row => row.value?.schema === schema
          && row.value.scopeKey === targetScopeKey).length;
        assert.equal(count, 2, `${mode}: ${schema} preserves both source revisions`);
      }
      if (mode === 'mirror') {
        const local = localRows(fx.local).filter(row => row.value?.schema === 'libra.micro_memory.v1'
          && row.value.scopeKey === targetScopeKey);
        const remote = fx.storedRows().filter(row => row.value?.schema === 'libra.micro_memory.v1'
          && row.value.scopeKey === targetScopeKey);
        assert.deepEqual(local.map(row => [row.key, row.value]), remote.map(row => [row.key, row.value]),
          'mirror preserves identical Micro records in both physical stores');
      }
      const restarted = await fx.restart();
      const afterRestart = await restarted.r.api.debugReadActiveMicroMemory(1);
      assert.equal(afterRestart.status, 'verified', `${mode}: fresh bridge reads the copied active Micro`);
      assert.equal(afterRestart.recordKey, targetMicro.recordKey);
      assert.equal(targetRecords().length, 2, `${mode}: old revision survives restart`);
      console.log(`PASS pre-Canonical native copy retains active and historical Micro in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
