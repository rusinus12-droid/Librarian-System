'use strict';
const assert = require('node:assert/strict');
const input = require('./fixtures/unified_vertical_source.json');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const waitFor = async predicate => {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for verified conflicting T5 Micro');
};
const retryBusy = async action => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await action(); }
    catch (error) {
      if (!/BUSY/.test(String(error?.code || error?.message || '')) || attempt === 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};

(async () => {
  const modes = process.env.LIBRA_TEST_MODE
    ? [process.env.LIBRA_TEST_MODE] : ['plugin_only', 'server_only'];
  for (const mode of modes) {
    const sourceChat = {id: 'unified-chat', chatId: 'unified-chat', name: 'T5 conflict source',
      message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
    const conflictValue = '공연 허가자는 민아로 확인되었다';
    sourceChat.message[9].data += ` ${conflictValue}.`;
    sourceChat.messages = sourceChat.message;
    const targetChat = {id: 't5-conflict-target', chatId: 't5-conflict-target',
      name: 'T5 conflict target', message: []};
    targetChat.messages = targetChat.message;
    const character = {id: 'unified-char', chaId: 'unified-char', name: '민아',
      chatPage: 0, chats: [sourceChat, targetChat]};
    let currentChatIndex = 0, listener;
    const host = {
      getCurrentChatIndex: async () => currentChatIndex,
      getChat: async () => character.chats[currentChatIndex],
      getCurrentChat: async () => character.chats[currentChatIndex],
      getChatFromIndex: async (_ci, index) => character.chats[index],
      getCharacter: async () => character,
      getCharacterFromIndex: async () => character,
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [character], plugins: []};
        return Array.isArray(fields)
          ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      },
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    };
    const fx = await serverFixture({mode, snapshot: {chat: sourceChat}, host,
      transformSource: source => source.replace('\n\n  const RisuCompat = (() => {',
        '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
    try {
      let {f} = fx;
      const bridge = f.r.context.__fixtureStorageBridge;
      const sourceStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: sourceStatus.scopeKey, scopeKey: sourceStatus.scopeKey,
        characterId: character.id, chatId: sourceChat.id}, mode);
      f.control.onCall = async () => {
        const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(5)).receipt;
        const start = receipt.assistant.text.indexOf(conflictValue);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: 5, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{changeKind: 'event', text: `${conflictValue}.`, actor: '', target: '',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'set', stateIntent: {domain: 'narrative',
                target: {scope: 'current_narrative'}, field: 'summary', operation: 'set',
                value: conflictValue}, evidence: {role: 'assistant',
                messageId: receipt.assistant.chatId, startOffset: start,
                endOffset: start + conflictValue.length, exactQuote: conflictValue}}]}
        })};
      };
      assert.equal(typeof listener, 'function');
      listener({char: character, chat: sourceChat, characterIndex: 0,
        chatIndex: 0, messageIndex: 9});
      await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(5)).status === 'verified');
      await waitFor(async () => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5
        && f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'verified');
      f.control.onCall = null;
      const canonicalRun = await f.run();
      assert.equal(canonicalRun.completed + canonicalRun.skipped, 1);
      let sourceView;
      await waitFor(async () => {
        sourceView = await f.r.api.debugLoadContinuityStateForResponse();
        return sourceView.authority?.microProjection?.pendingClaims?.some(row => row.turn === 5);
      });
      assert.equal(sourceView.head?.narrative?.summary, '공연 허가자를 아직 알 수 없음');
      assert.ok(sourceView.authority?.microProjection?.pendingClaims?.some(row =>
        row.turn === 5 && ['canonical_overlap_conflict',
          'overlap_not_previously_admitted'].includes(row.reason)),
      JSON.stringify(sourceView.authority?.microProjection));
      const portable = f.r.context.__LIBRAPortableMemoryBackup;
      const envelope = await retryBusy(() => portable.exportCurrentScope());
      currentChatIndex = 1;
      const targetStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: targetStatus.scopeKey, scopeKey: targetStatus.scopeKey,
        characterId: character.id, chatId: targetChat.id}, mode);
      assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(envelope))).ok, true);
      f = await fx.restart();
      const view = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(view.head?.narrative?.summary, '공연 허가자를 아직 알 수 없음',
        `${mode}: inherited conflicting T5 Micro cannot overwrite Canonical`);
      assert.ok(view.authority?.microProjection?.pendingClaims?.some(row =>
        row.turn === 5 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.reason === 'canonical_overlap_conflict'));
      const rows = mode === 'server_only' ? fx.storedRows() : [...fx.local].map(([key, raw]) => {
        let value = raw;
        try { value = JSON.parse(raw); } catch { /* non-JSON row */ }
        return {key, value};
      });
      assert.ok(rows.some(row => row.value?.schema === 'libra.inherited_micro_state_admission.v1'
        && row.value.scopeKey === targetStatus.scopeKey && row.value.turn === 5
        && row.value.status === 'pending' && row.value.reason === 'canonical_overlap_conflict'),
      `${mode}: target-basis conflict decision is durable`);
      console.log(`PASS inherited T5 Canonical conflict remains pending in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
