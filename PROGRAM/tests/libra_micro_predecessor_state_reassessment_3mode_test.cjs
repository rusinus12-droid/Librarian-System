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
  throw new Error('timed out waiting for verified T6 Micro and State decision');
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
    const sourceChat = {id: 'unified-chat', chatId: 'unified-chat', name: 'T6 source',
      message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
    sourceChat.messages = sourceChat.message;
    const targetChat = {id: 't6-predecessor-target', chatId: 't6-predecessor-target',
      name: 'T6 predecessor target', message: []};
    targetChat.messages = targetChat.message;
    const character = {id: 'unified-char', chaId: 'unified-char', name: '민아', chatPage: 0,
      chats: [sourceChat, targetChat]};
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
      let bridge = f.r.context.__fixtureStorageBridge;
      const sourceStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: sourceStatus.scopeKey, scopeKey: sourceStatus.scopeKey,
        characterId: character.id, chatId: sourceChat.id}, mode);
      assert.equal((await f.run()).completed, 1, `${mode}: source Canonical T1-T5 commits`);
      sourceChat.message.push(
        {role: 'user', chatId: 't6-u', data: '도서관 문 상태를 확인해 줘.'},
        {role: 'assistant', chatId: 't6-a', data: '도서관 문이 열렸다. 민아가 이를 확인했다.'}
      );
      sourceChat.messages = sourceChat.message;
      f.control.onCall = async () => {
        const source = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        const receipt = source.receipt;
        const quote = '도서관 문이 열렸다';
        const start = receipt.assistant.text.indexOf(quote);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: 6, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'set', stateIntent: {domain: 'world',
                target: {entityName: '도서관'}, field: 'doorStatus', operation: 'set', value: '열렸다'},
              evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset: start, endOffset: start + quote.length, exactQuote: quote}}]}
        })};
      };
      assert.equal(typeof listener, 'function', 'the completed-output listener is installed');
      listener({char: character, chat: sourceChat, characterIndex: 0, chatIndex: 0,
        messageIndex: 11});
      await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(6)).status === 'verified');
      await waitFor(async () => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6
        && f.r.api.getCaptureBackendState().lastMicroPublication?.stateAdmission?.admitted === 1);
      const sourceDecision = await f.r.api.debugReadCurrentMicroStateAdmission(6, 0);
      assert.equal(sourceDecision.status, 'admitted', `${mode}: source T6 change is admitted`);
      const sourceView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(sourceView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: source State projects its admitted T6 change`);
      const portable = f.r.context.__LIBRAPortableMemoryBackup;
      const envelope = await retryBusy(() => portable.exportCurrentScope());
      currentChatIndex = 1;
      const targetStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: targetStatus.scopeKey, scopeKey: targetStatus.scopeKey,
        characterId: character.id, chatId: targetChat.id}, mode);
      const preview = await portable.previewImport(envelope);
      assert.equal(preview.modes.import_as_predecessor_archive.available, true);
      assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(envelope))).ok, true);
      f = await fx.restart();
      const targetView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(targetView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: a target-basis decision projects the inherited T6 change`);
      const responseContext = await f.r.api.getResponseContext({currentInput: '도서관 문 상태'});
      assert.equal(responseContext.values?.currentHead?.world?.find(row => row.name === '도서관')
        ?.state?.doorStatus, '열렸다',
      `${mode}: the sealed response context receives the target-admitted inherited change`);
      assert.equal(f.control.calls.length, 0,
        `${mode}: inherited State readback does not repeat model analysis`);
      const targetRows = () => mode === 'server_only' ? fx.storedRows()
        : [...fx.local].map(([key, raw]) => {
          let value = raw;
          try { value = JSON.parse(raw); } catch (_) { /* non-JSON storage row */ }
          return {key, value};
        });
      const targetDecision = targetRows().find(row => row.value?.schema === 'libra.inherited_micro_state_admission.v1'
        && row.value.scopeKey === targetStatus.scopeKey && row.value.sourceScopeKey === sourceStatus.scopeKey
        && row.value.turn === 6)?.value;
      assert.equal(targetDecision?.status, 'admitted',
        `${mode}: a fresh decision is durably bound to the target Registry and State basis`);
      assert.ok(targetDecision?.archiveDigest && targetDecision?.basisDigest
        && targetDecision?.claimDigest && targetDecision?.decisionDigest);
      assert.notEqual(targetDecision?.scopeKey, sourceDecision.decision?.scopeKey,
        `${mode}: source-basis authority is never copied as target authority`);
      targetChat.message = input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}));
      targetChat.messages = targetChat.message;
      f.control.onCall = null;
      assert.equal((await f.run()).completed, 1,
        `${mode}: the target commits its own unrelated five-turn Canonical`);
      await waitFor(async () => (await f.r.api.debugLoadContinuityStateForResponse())
        .head?.world?.find(row => row.name === '도서관')?.state?.doorStatus === '열렸다');
      const laterView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(laterView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: an unrelated newer Canonical retains the re-admitted predecessor change`);
      const laterTransition = laterView.authority?.microProjection?.transitions?.find(row =>
        row.turn === 6 && row.sourceScopeKey === sourceStatus.scopeKey);
      assert.ok(laterTransition?.decisionKey, `${mode}: the later projection cites a target-basis decision`);
      if (mode === 'mirror') {
        const localDecision = targetRows().find(row => row.key === laterTransition.decisionKey)?.value;
        const serverDecision = fx.storedRows().find(row => row.key === laterTransition.decisionKey)?.value;
        assert.deepEqual(serverDecision, localDecision,
          'mirror physically keeps the same target-basis decision in plugin and server storage');
      }
      if (mode !== 'plugin_only') {
        const serverDecision = fx.storedRows().find(row => row.key === laterTransition.decisionKey);
        assert.ok(serverDecision, `${mode}: the target-basis decision is physically present in SQLite`);
        await fx.mutate(serverDecision.key, {...serverDecision.value, reason: 'tampered_server_decision'});
        const compromised = await f.r.api.debugLoadContinuityStateForResponse();
        assert.notEqual(compromised.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
          '열렸다', `${mode}: tampering cannot leave an inherited State claim authoritative`);
        assert.ok(compromised.authority?.microProjection?.pendingClaims?.some(row =>
          row.turn === 6 && row.sourceScopeKey === sourceStatus.scopeKey),
        `${mode}: tampered target decisions remain visible as pending`);
      }
      console.log(`PASS predecessor T6 State reassessment in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
