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
  throw new Error('timed out waiting for verified T6 Micro State');
};

(async () => {
  const modes = process.env.LIBRA_TEST_MODE
    ? [process.env.LIBRA_TEST_MODE] : ['plugin_only', 'server_only'];
  for (const mode of modes) {
    const chat = {id: 'unified-chat', chatId: 'unified-chat', name: 'Micro correction order',
      message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
    chat.messages = chat.message;
    const character = {id: 'unified-char', chaId: 'unified-char', name: '민아',
      chatPage: 0, chats: [chat]};
    let listener;
    const host = {
      getCurrentChatIndex: async () => 0,
      getChat: async () => chat,
      getCurrentChat: async () => chat,
      getChatFromIndex: async () => chat,
      getCharacter: async () => character,
      getCharacterFromIndex: async () => character,
      getDatabase: async fields => {
        const db = {personas: [], selectedPersona: '', characters: [character], plugins: []};
        return Array.isArray(fields)
          ? Object.fromEntries(fields.map(field => [field, db[field] ?? null])) : db;
      },
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    };
    const fx = await serverFixture({mode, snapshot: {chat}, host,
      transformSource: source => source.replace('\n\n  const RisuCompat = (() => {',
        '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
    try {
      let {f} = fx;
      const bridge = f.r.context.__fixtureStorageBridge;
      const status = await f.r.api.getHostLineageStatus();
      await bridge.setScopeMode({scopeId: status.scopeKey, scopeKey: status.scopeKey,
        characterId: character.id, chatId: chat.id}, mode);
      assert.equal((await f.run()).completed, 1, `${mode}: T1-T5 Canonical commits`);
      const state = async () => f.r.api.debugLoadContinuityStateForResponse();
      const library = (await state()).head?.world?.find(row => row.name === '도서관');
      assert.ok(library?.id, `${mode}: Canonical registers the target`);
      const correct = async doorStatus => f.r.api.addWorldManagerCorrection({
        anchorTurn: 5, target: {domain: 'world'},
        patch: {world: [{id: library.id, set: {doorStatus}}]}
      });
      const before = await correct('닫혔다');
      assert.equal(before.ok, true, `${mode}: correction before T6 commits`);
      assert.equal(before.correction.observedThroughTurn, 5,
        `${mode}: correction seals the last completed source turn it observed`);
      assert.ok(before.correction.observedRevisionDigest,
        `${mode}: the durable correction seals the source revisions it observed`);

      chat.message.push(
        {role: 'user', chatId: 't6-u', data: '도서관 문 상태를 확인해 줘.'},
        {role: 'assistant', chatId: 't6-a', data: '도서관 문이 열렸다. 민아가 이를 확인했다.'}
      );
      chat.messages = chat.message;
      f.control.onCall = async () => {
        const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(6)).receipt;
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
      assert.equal(typeof listener, 'function');
      listener({char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: 11});
      await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(6)).status === 'verified');
      await waitFor(async () => (await f.r.api.debugReadCurrentMicroStateAdmission(6, 0)).status === 'admitted');
      assert.equal((await state()).head?.world?.find(row => row.id === library.id)?.state?.doorStatus,
        '열렸다', `${mode}: new T6 event supersedes a correction made before T6`);

      const after = await correct('잠겼다');
      assert.equal(after.ok, true, `${mode}: correction after T6 commits`);
      assert.equal(after.correction.observedThroughTurn, 6,
        `${mode}: later correction records that it observed T6`);
      assert.ok(after.correction.observedRevisionDigest);
      const afterView = await state();
      assert.equal(afterView.head?.world?.find(row => row.id === library.id)?.state?.doorStatus,
        '잠겼다', `${mode}: later user correction controls current State`);
      const afterDecision = await f.r.api.debugReadCurrentMicroStateAdmission(6, 0);
      assert.equal(afterDecision.status, 'superseded',
        `${mode}: T6 Micro receives a durable decision on the changed basis`);
      assert.equal(afterDecision.decision?.reason, 'explicit_user_correction');
      assert.ok(afterView.authority?.microProjection?.transitions?.some(row =>
        row.turn === 6 && row.disposition === 'corrected' && row.decisionKey),
      `${mode}: response State explains why the older T6 change is not current`);

      assert.equal((await f.r.api.setWorldManagerCorrectionStatus(
        after.correction.correctionId, 'suspended')).ok, true,
      `${mode}: later correction can be suspended`);
      f = await fx.restart();
      assert.equal((await f.r.api.debugReadCurrentMicroStateAdmission(6, 0)).status,
        'admitted', `${mode}: T6 receives a fresh decision after suspension`);
      assert.equal((await f.r.api.debugLoadContinuityStateForResponse()).head?.world
        ?.find(row => row.id === library.id)?.state?.doorStatus, '열렸다',
      `${mode}: the earlier correction remains older than the T6 event after restart`);
      console.log(`PASS Micro correction turn order in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
