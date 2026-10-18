'use strict';
// Full production writer/approval/reader, with physical local or HTTP/SQLite storage.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
const observe = source => source.replace('  const publicApi = Object.freeze({\n    getHostLineageStatus:',
  '  globalThis.__stateViewTest = {LibraMemoryCore};\n  const publicApi = Object.freeze({\n    getHostLineageStatus:');
const clone = value => JSON.parse(JSON.stringify(value));

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    for (const scenario of ['ready', 'partial', 'event_identity']) {
      const partial = scenario === 'partial';
      let listener;
      const fixture = await serverFixture({mode, transformSource: observe, host: {
        addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
      }});
      try {
        const {f} = fixture, core = f.r.context.__stateViewTest.LibraMemoryCore;
        if (partial) f.control.artifact.facts.find(row => row.tempFactId === 'f13').values.thread.status = 'invalid';
        if (scenario === 'event_identity') {
          f.control.artifact.facts = f.control.artifact.facts.filter(row => !['f1', 'f5'].includes(row.tempFactId));
        }
        assert.equal((await f.run()).completed, 1);
        await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5);
        const before = clone(core.peekSnapshot().continuityState);
        const placeName = scenario === 'event_identity' ? '서재' : '공연실';
        const registry = mode === 'plugin_only'
          ? [...fixture.local.values()].map(raw => {try{return JSON.parse(raw);}catch{return null;}}).find(row => row?.schema === 'libra.entity_registry.v2')
          : fixture.getRecords('libra.entity_registry.v2')[0].value;
        const placeId = registry.entities.find(row => row.name === placeName)?.id;
        assert.ok(placeId, 'a source-verified identity survives even without a current State field');
        if (scenario === 'event_identity') assert.equal(before.characters.find(row => row.name === '민아').state.locationRef, undefined);
        assert.equal(before.status, partial ? 'partial' : 'ready');
        f.control.onCall = async () => {
          const turn = f.chat.message.length / 2;
          const {receipt} = await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
          const body = receipt.assistant.text;
          const claim = (quote, field, value) => ({changeKind: 'person', text: quote,
            actor: '민아', target: '', temporalRole: 'current', certainty: 'confirmed',
            epistemicStatus: 'observed', stateChangeType: 'set', stateIntent: {
              domain: 'character', target: {entityName: '민아'}, field, operation: 'set', value
            }, evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
              startOffset: body.indexOf(quote), endOffset: body.indexOf(quote) + quote.length, exactQuote: quote}});
          return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1',
              scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
              turn, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
              claims: turn === 6 ? [claim(scenario === 'event_identity' ? '민아가 공연실에서 서재로 이동했다.' : '민아가 서재에서 공연실로 이동했다.', 'locationRef', placeName),
                claim('민아가 기절했다.', 'condition', '기절했다')]
                : [claim(body, 'locationRef', '낯선방')]}})};
        };
        const append = (turn, body) => {
          f.chat.message.push({role: 'user', chatId: `t${turn}-u`, data: '민아의 변화를 확인해 줘.'},
            {role: 'assistant', chatId: `t${turn}-a`, data: body});
          f.chat.messages = f.chat.message;
          listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
            messageIndex: f.chat.message.length - 1});
        };
        append(6, (scenario === 'event_identity' ? '민아가 공연실에서 서재로 이동했다.' : '민아가 서재에서 공연실로 이동했다.') + ' 민아가 기절했다.');
        await waitFor(() => f.r.api.getCurrentStateHead()?.throughTurn === 6, 15000).catch(error => {
          const snapshot = core.peekSnapshot();
          throw new Error(`${mode} partial=${partial}: ${error.message} ${JSON.stringify({
            publication: f.r.api.getCaptureBackendState().lastMicroPublication,
            viewError: snapshot.currentStateView?.error,
            authority: snapshot.currentStateView?.authority,
            domains: Object.fromEntries(Object.entries(snapshot.continuityState?.domainStatus || {}).map(([k,v]) => [k,v.status]))})}`);
        });
        const snapshot = clone(core.peekSnapshot());
        assert.deepEqual(snapshot.continuityState, before, 'GUI projection never overwrites Canonical Head');
        assert.equal(snapshot.currentStateView.head.characters.find(row => row.name === '민아').state.locationRef,
          placeId, 'Micro cited place is resolved to the canonical Registry ID');
        assert.equal(snapshot.currentStateView.head.world.find(row => row.id === placeId)?.name, placeName,
          'a location reference has a verified display identity even without a Canonical world field');
        const person = f.r.api.getCurrentStateHead().characters.find(row => row.name === '민아');
        assert.equal(person.state.condition, '기절했다');
        assert.equal(person.fieldEvidence.condition.evidenceSpans[0].quote, '민아가 기절했다.');
        if (partial) {
          assert.equal(snapshot.currentStateView.authority.pending, true);
          assert.equal(snapshot.currentStateView.head.status, 'partial');
          assert.equal(snapshot.currentStateView.head.domainStatus.narrative.status, 'partial');
        }
        assert.equal(f.control.calls.length, 2, 'one Canonical and one Micro generation, no observer call');
        append(7, '민아가 낯선방으로 이동했다.');
        await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 7, 15000);
        const unknown = await f.r.api.debugReadCurrentMicroStateAdmission(7, 0);
        assert.equal(unknown.status, 'pending');
        assert.equal(unknown.reason, 'registry_location_unresolved');
        await f.r.api.getCanonicalMemories();
        assert.equal(f.r.api.getCurrentStateHead().characters.find(row => row.name === '민아').state.locationRef,
          placeId, 'unknown location cannot replace the approved field');
        f.chat.message[11].data = '민아는 계속 서재에 있었다.';
        await f.r.api.getCanonicalMemories();
        const stale = f.r.api.getCurrentStateHead().characters.find(row => row.name === '민아');
        assert.equal(stale.state.condition, undefined, 'source edit removes the formerly approved Micro field');
        assert.equal(stale.state.locationRef, before.characters.find(row => row.name === '민아').state.locationRef);
        assert.equal(f.control.calls.length, 3, 'view refresh does not generate or repair memory');
        console.log(`PASS automatic verified State view, typed location and source edit in ${mode}, scenario=${scenario}`);
      } finally { await fixture.cleanup(); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
