'use strict';
const assert = require('node:assert/strict');
const input = require('./fixtures/unified_vertical_source.json');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');

const waitFor = async predicate => {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for verified T5 Micro');
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
    const sourceChat = {id: 'unified-chat', chatId: 'unified-chat', name: 'T5 source',
      message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
    sourceChat.message[9].data += ' 도서관 문이 열렸다. 공연 허가자를 아직 알 수 없음.';
    sourceChat.messages = sourceChat.message;
    const targetChat = {id: 't5-overlap-target', chatId: 't5-overlap-target',
      name: 'T5 overlap target', message: []};
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
        const quote = '도서관 문이 열렸다';
        const start = receipt.assistant.text.indexOf(quote);
        const absorbedQuote = '공연 허가자를 아직 알 수 없음';
        const absorbedStart = receipt.assistant.text.indexOf(absorbedQuote);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: 5, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'set', stateIntent: {domain: 'world',
                target: {entityName: '도서관'}, field: 'doorStatus', operation: 'set', value: '열렸다'},
              evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
                startOffset: start, endOffset: start + quote.length, exactQuote: quote}},
              {changeKind: 'event', text: `${absorbedQuote}.`, actor: '', target: '',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
                stateChangeType: 'set', stateIntent: {domain: 'narrative',
                  target: {scope: 'current_narrative'}, field: 'summary', operation: 'set',
                  value: absorbedQuote}, evidence: {role: 'assistant',
                  messageId: receipt.assistant.chatId, startOffset: absorbedStart,
                  endOffset: absorbedStart + absorbedQuote.length, exactQuote: absorbedQuote}}]}
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
      assert.equal(canonicalRun.completed + canonicalRun.skipped, 1,
        `${mode}: T1-T5 Canonical commits independently: ${JSON.stringify(canonicalRun)}`);
      assert.equal((mode === 'server_only' ? fx.getHead() : [...fx.local.values()].map(raw => {
        try { return JSON.parse(raw); } catch { return null; }
      }).find(value => value?.schema === 'libra.continuity_state.v2'))?.status, 'ready',
      `${mode}: T1-T5 Canonical State is durable`);
      const sourceMicro = await f.r.api.debugReadActiveMicroMemory(5);
      assert.equal(sourceMicro.status, 'verified');
      await waitFor(async () => (await f.r.api.debugReadCurrentMicroStateAdmission(5, 0)).status
        === 'admitted');
      const sourceView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(sourceView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: Canonical omission retains the source T5 Micro State change`);
      assert.ok(sourceView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.disposition === 'still_current'));
      assert.ok(sourceView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 1 && row.disposition === 'absorbed'));
      sourceChat.message.push(...sourceChat.message.slice(0, 10).map((message, index) => ({
        ...message, chatId: `t${6 + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}`
      })));
      const correctedSummary = '공연 허가자는 민아로 확인되었다';
      sourceChat.message[19].data += ` ${correctedSummary}.`;
      sourceChat.messages = sourceChat.message;
      f.control.artifact = artifact();
      for (const item of [...f.control.artifact.entities, ...f.control.artifact.facts]) {
        for (const evidence of item.evidenceSpans) {
          evidence.ref = evidence.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + 5}`);
        }
      }
      const correctedFact = f.control.artifact.facts.find(fact => fact.tempFactId === 'f13');
      correctedFact.values.thread.summary = correctedSummary;
      correctedFact.text = `${correctedSummary}.`;
      correctedFact.evidenceSpans = [{ref: 't10-a', quote: correctedSummary}];
      const laterCanonicalRun = await f.run();
      assert.equal(laterCanonicalRun.total, 2);
      assert.equal(laterCanonicalRun.completed + laterCanonicalRun.skipped, 2,
        `${mode}: T6-T10 Canonical commits without repeating the T5 door state`);
      const laterSourceView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(laterSourceView.head?.reviewedThroughCanonical?.turnRange?.end, 10,
        `${mode}: the second Canonical is the durable State baseline: ${JSON.stringify(laterCanonicalRun)}`);
      assert.equal(laterSourceView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: a later Canonical omission retains the T5 Micro change`);
      assert.equal(laterSourceView.head?.narrative?.summary, correctedSummary);
      assert.ok(laterSourceView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 1 && row.disposition === 'corrected'));
      const portable = f.r.context.__LIBRAPortableMemoryBackup;
      const envelope = await retryBusy(() => portable.exportCurrentScope());
      currentChatIndex = 1;
      const targetStatus = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: targetStatus.scopeKey, scopeKey: targetStatus.scopeKey,
        characterId: character.id, chatId: targetChat.id}, mode);
      assert.equal((await retryBusy(() => portable.importAsPredecessorArchive(envelope))).ok, true);
      f = await fx.restart();
      const view = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(view.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: T5 Micro omitted by Canonical remains target State current`);
      assert.ok(view.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'still_current'));
      assert.ok(view.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 1
        && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'corrected'));
      assert.equal(view.head?.narrative?.summary, correctedSummary);
      targetChat.message = input.sourceRows.map(row => ({role: row.role,
        chatId: row.ref, data: row.text}));
      targetChat.messages = targetChat.message;
      f.control.onCall = null;
      const targetCanonicalRun = await f.run();
      assert.equal(targetCanonicalRun.completed + targetCanonicalRun.skipped, 1);
      const targetBaseline = await f.r.api.debugLoadContinuityStateForResponse();
      const library = targetBaseline.head?.world?.find(row => row.name === '도서관');
      assert.ok(library?.id);
      const correctedDoor = await f.r.api.addWorldManagerCorrection({anchorTurn: 5,
        target: {domain: 'world'}, patch: {world: [{id: library.id,
          set: {doorStatus: '닫혔다'}}]}});
      assert.equal(correctedDoor.ok, true, `${mode}: user correction sets the field`);
      const correctedView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(correctedView.head?.world?.find(row => row.id === library.id)
        ?.state?.doorStatus, '닫혔다');
      assert.ok(correctedView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 0 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'corrected' && row.decisionKey),
      `${mode}: user correction supersedes inherited Micro with a target-basis decision`);
      assert.ok(correctedView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 1 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'absorbed' && row.decisionKey),
      `${mode}: a field-unrelated inherited claim is reassessed too`);
      const clearedDoor = await f.r.api.addWorldManagerCorrection({anchorTurn: 5,
        target: {domain: 'world'}, patch: {world: [{id: library.id,
          clear: ['doorStatus']}]}});
      assert.equal(clearedDoor.ok, true, `${mode}: user correction explicitly clears the field`);
      const clearedView = await f.r.api.debugLoadContinuityStateForResponse();
      const clearedRow = clearedView.head?.world?.find(row => row.id === library.id);
      assert.equal(clearedRow?.clearedFieldCorrectionProvenance?.doorStatus?.correctionId,
        clearedDoor.correction?.correctionId, `${mode}: the explicit clear is durable`);
      assert.equal(clearedRow
        ?.state?.doorStatus, undefined,
      `${mode}: inherited T5 Micro cannot resurrect an explicitly cleared field`);
      assert.ok(clearedView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 0 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'corrected' && row.decisionKey),
      `${mode}: the clear supersedes Micro rather than losing its decision`);
      assert.ok(clearedView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 1 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'absorbed' && row.decisionKey),
      `${mode}: the unrelated inherited decision survives the clear`);
      const clearTransition = clearedView.authority.microProjection.transitions.find(row =>
        row.turn === 5 && row.claimIndex === 0 && row.sourceScopeKey === sourceStatus.scopeKey);
      const localDecision = mode === 'server_only' ? null
        : JSON.parse(fx.local.get(clearTransition.decisionKey));
      const serverDecision = mode === 'plugin_only' ? null
        : fx.storedRows().find(row => row.key === clearTransition.decisionKey)?.value;
      const durableDecision = serverDecision || localDecision;
      assert.equal(durableDecision?.schema, 'libra.inherited_micro_state_admission.v1');
      assert.equal(durableDecision?.status, 'superseded');
      assert.equal(durableDecision?.reason, 'explicit_user_correction');
      assert.ok(durableDecision?.basisDigest && durableDecision?.decisionDigest);
      if (mode === 'mirror') assert.deepEqual(serverDecision, localDecision,
        'mirror has matching physical user-correction decisions on both storage sides');
      assert.equal((await f.r.api.setWorldManagerCorrectionStatus(
        clearedDoor.correction.correctionId, 'suspended')).ok, true,
      `${mode}: the explicit clear can be suspended`);
      const restoredSetView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(restoredSetView.head?.world?.find(row => row.id === library.id)
        ?.state?.doorStatus, '닫혔다');
      assert.ok(restoredSetView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 0 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'corrected' && row.decisionKey),
      `${mode}: suspending the clear reassesses the surviving user set`);
      assert.equal((await f.r.api.setWorldManagerCorrectionStatus(
        correctedDoor.correction.correctionId, 'suspended')).ok, true,
      `${mode}: the user set can be suspended`);
      f = await fx.restart();
      const restoredMicroView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(restoredMicroView.head?.world?.find(row => row.id === library.id)
        ?.state?.doorStatus, '열렸다',
      `${mode}: predecessor Micro is re-admitted after both corrections are suspended`);
      assert.ok(restoredMicroView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 0 && row.sourceScopeKey === sourceStatus.scopeKey
        && row.disposition === 'still_current' && row.decisionKey),
      `${mode}: restart reads the new target-basis decision`);
      currentChatIndex = 0;
      const sourceBeforeCorrection = await f.r.api.debugLoadContinuityStateForResponse();
      const sourceLibrary = sourceBeforeCorrection.head?.world?.find(row => row.name === '도서관');
      assert.ok(sourceLibrary?.id);
      const sourceSet = await f.r.api.addWorldManagerCorrection({anchorTurn: 10,
        target: {domain: 'world'}, patch: {world: [{id: sourceLibrary.id,
          set: {doorStatus: '닫혔다'}}]}});
      assert.equal(sourceSet.ok, true);
      const sourceSetView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(sourceSetView.head?.world?.find(row => row.id === sourceLibrary.id)
        ?.state?.doorStatus, '닫혔다');
      assert.ok(sourceSetView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 0 && row.disposition === 'corrected'),
      `${mode}: an explicit source-scope correction supersedes active Micro`);
      const sourceClear = await f.r.api.addWorldManagerCorrection({anchorTurn: 10,
        target: {domain: 'world'}, patch: {world: [{id: sourceLibrary.id,
          clear: ['doorStatus']}]}});
      assert.equal(sourceClear.ok, true);
      const sourceClearView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(sourceClearView.head?.world?.find(row => row.id === sourceLibrary.id)
        ?.state?.doorStatus, undefined);
      assert.ok(sourceClearView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.claimIndex === 0 && row.disposition === 'corrected'),
      `${mode}: an explicit source-scope clear supersedes active Micro`);
      console.log(`PASS inherited T5 Micro overlap in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
