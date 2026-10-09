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
  throw new Error('timed out waiting for the conflicting T6 Micro decisions');
};

(async () => {
  const sourceChat = {id: 'unified-chat', chatId: 'unified-chat', name: 'Conflict source',
    message: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text}))};
  sourceChat.messages = sourceChat.message;
  const targetChat = {id: 'conflict-target', chatId: 'conflict-target',
    name: 'Conflict target', message: []};
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
  const fx = await serverFixture({mode: 'plugin_only', snapshot: {chat: sourceChat}, host,
    transformSource: source => source.replace('\n\n  const RisuCompat = (() => {',
      '\n  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n\n  const RisuCompat = (() => {')});
  try {
    let {f} = fx;
    const bridge = f.r.context.__fixtureStorageBridge;
    const sourceStatus = await f.r.api.getHostLineageStatus();
    await bridge.setScopeMode({scopeId: sourceStatus.scopeKey, scopeKey: sourceStatus.scopeKey,
      characterId: character.id, chatId: sourceChat.id}, 'plugin_only');
    assert.equal((await f.run()).completed, 1);
    sourceChat.message.push(
      {role: 'user', chatId: 't6-u', data: '도서관 문 상태를 확인해 줘.'},
      {role: 'assistant', chatId: 't6-a', data: '도서관 문이 열렸다. 곧 도서관 문이 닫혔다.'}
    );
    sourceChat.messages = sourceChat.message;
    f.control.onCall = async () => {
      const receipt = (await f.r.api.debugReadActiveCompletedTurnReceipt(6)).receipt;
      const claim = (quote, value) => {
        const start = receipt.assistant.text.indexOf(quote);
        return {changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관',
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
          stateChangeType: 'set', stateIntent: {domain: 'world',
            target: {entityName: '도서관'}, field: 'doorStatus', operation: 'set', value},
          evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
            startOffset: start, endOffset: start + quote.length, exactQuote: quote}};
      };
      return {type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
        micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
          worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
          turn: 6, sourceRevisionId: receipt.revisionId,
          sourceDigest: receipt.sourceDigest,
          claims: [claim('도서관 문이 열렸다', '열렸다'),
            claim('도서관 문이 닫혔다', '닫혔다')]}
      })};
    };
    assert.equal(typeof listener, 'function');
    listener({char: character, chat: sourceChat, characterIndex: 0,
      chatIndex: 0, messageIndex: 11});
    await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(6)).status === 'verified'
      && f.r.api.getCaptureBackendState().lastMicroPublication?.stateAdmission?.admitted === 2);
    const sourceView = await f.r.api.debugLoadContinuityStateForResponse();
    assert.equal(sourceView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
      undefined, 'same-turn conflicting source values cannot become State');
    const portable = f.r.context.__LIBRAPortableMemoryBackup;
    const envelope = await portable.exportCurrentScope();
    currentChatIndex = 1;
    const targetStatus = await f.r.api.getHostLineageStatus();
    await bridge.setScopeMode({scopeId: targetStatus.scopeKey, scopeKey: targetStatus.scopeKey,
      characterId: character.id, chatId: targetChat.id}, 'plugin_only');
    assert.equal((await portable.importAsPredecessorArchive(envelope)).ok, true);
    f = await fx.restart();
    const targetView = await f.r.api.debugLoadContinuityStateForResponse();
    assert.equal(targetView.head?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
      undefined, 'same-turn conflicting inherited values cannot become target State');
    assert.ok(targetView.authority?.microProjection?.pendingClaims?.some(row =>
      row.turn === 6 && row.reason === 'micro_same_turn_field_conflict'));
    const targetDecisions = [...fx.local.entries()].flatMap(([key, raw]) => {
      let value;
      try { value = JSON.parse(raw); } catch (_) { return []; }
      return value?.schema === 'libra.inherited_micro_state_admission.v1'
        && value.scopeKey === targetStatus.scopeKey ? [{key, value}] : [];
    });
    assert.equal(targetDecisions.length, 2);
    assert.ok(targetDecisions.every(row => row.value.status === 'pending'
      && row.value.reason === 'micro_same_turn_field_conflict'),
    'both conflicting claims have source- and target-basis-bound pending decisions');
    console.log('PASS inherited same-turn Micro conflict remains pending');
  } finally { await fx.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
