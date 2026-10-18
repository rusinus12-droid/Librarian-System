'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture, api = f.r.api;
      assert.equal((await f.run()).completed, 1);
      f.control.onCall = async () => {
        const {receipt} = await api.debugReadActiveCompletedTurnReceipt(6);
        const quote = receipt.assistant.text;
        return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1',
            scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: 6, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{changeKind: 'event', text: quote, actor: '', target: '', temporalRole: 'current',
              certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {
                role: 'assistant', messageId: receipt.assistant.chatId, startOffset: 0,
                endOffset: quote.length, exactQuote: quote}}]}})};
      };
      f.chat.message.push({role: 'user', chatId: 't6-u', data: '다음 장면은?'},
        {role: 'assistant', chatId: 't6-a', data: '민아가 공연실로 이동했다.'});
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11});
      await waitFor(() => api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
      const scopeKey = 'seventh-server-scope';
      const page = await api.listMicroReaderTurns({limit: 2, expectedScopeKey: scopeKey});
      assert.deepEqual(Array.from(page.items, row => row.turn), [6, 5]);
      assert.equal(page.items[0].status, 'verified');
      assert.ok(page.items[0].summary.includes('민아가 공연실로 이동했다.'));
      assert.equal(page.hasMore, true);
      assert.deepEqual(Array.from((await api.listMicroReaderTurns({beforeTurn: page.nextBeforeTurn, limit: 2})).items, row => row.turn), [4, 3]);
      await assert.rejects(api.listMicroReaderTurns({expectedScopeKey: 'other-scope'}), /MICRO_READER_SCOPE_CHANGED/);
      const saved = await api.readActiveMicroMemoryForTurn(6, scopeKey);
      assert.equal(saved.status, 'verified');
      const changed = JSON.parse(JSON.stringify(saved.record));
      changed.claims[0].text = '위조된 Micro 내용';
      if (mode === 'plugin_only') fixture.local.set(saved.recordKey, JSON.stringify(changed));
      else await fixture.mutate(saved.recordKey, changed);
      const invalid = await api.listMicroReaderTurns({limit: 1});
      assert.notEqual(invalid.items[0].status, 'verified');
      assert.equal(invalid.items[0].summary, '');
      assert.equal((await api.readActiveMicroMemoryForTurn(6, scopeKey)).record, null);
      assert.equal(f.control.calls.length, 2, 'catalog/detail reads do not invoke models');
      console.log(`PASS independent Micro reader pagination, scope and tampered body in ${mode}`);
    } finally { await fixture.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
