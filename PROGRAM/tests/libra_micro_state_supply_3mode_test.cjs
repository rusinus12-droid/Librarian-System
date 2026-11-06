'use strict';
// A later Micro observation reaches State even when an older Canonical fact was rejected,
// and a typed reference field stores the verified Registry id rather than the cited name.
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const HOLDER_QUOTE = '은빛 열쇠는 지호가 들고 있다';
const UNKNOWN_QUOTE = '금빛 열쇠는 라온이 들고 있다';
const span = (text, quote, messageId) => ({role: 'assistant', messageId,
  startOffset: text.indexOf(quote), endOffset: text.indexOf(quote) + quote.length, exactQuote: quote});

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture;
      const rejected = f.clone(f.control.artifact.facts.find(row => row.tempFactId === 'f8'));
      f.control.artifact.facts.push({...rejected, tempFactId: 'fx', domain: 'world', subjectTempRef: 'junho',
        claimKind: 'location', values: {locationRef: 'hall'}, text: '거부되는 사실.', effect: undefined});
      assert.equal((await f.run()).completed, 1, `${mode}: baseline commits`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);

      f.chat.message.push({role: 'user', chatId: 't6-u', data: '열쇠는 누가 가졌어?'},
        {role: 'assistant', chatId: 't6-a', data: `${HOLDER_QUOTE}. ${UNKNOWN_QUOTE}.`});
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const {receipt} = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        const body = receipt.assistant.text, id = receipt.assistant.chatId;
        const claim = (quote, value) => ({changeKind: 'world', text: `${quote}.`, actor: '', target: quote.split('는 ')[0],
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
          stateIntent: {domain: 'world', target: {entityName: quote.split('는 ')[0]}, field: 'holderRef', operation: 'set', value},
          evidence: span(body, quote, id)});
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId,
            sessionEpoch: receipt.sessionEpoch, turn: 6, sourceRevisionId: receipt.revisionId,
            sourceDigest: receipt.sourceDigest, claims: [claim(HOLDER_QUOTE, '지호'), claim(UNKNOWN_QUOTE, '라온')]}
        })};
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);

      const known = await f.r.api.debugAdmitActiveMicroStateClaim(6, 0);
      const unknown = await f.r.api.debugAdmitActiveMicroStateClaim(6, 1);
      assert.equal(known.status, 'admitted', `${mode}: ${known.reason}`);
      assert.match(String(known.decision.patch.set.holderRef), /^ce_person_/, `${mode}: the Registry id is stored, not the name`);
      assert.equal(unknown.status, 'admitted', `${mode}: someone the source names but no record holds yet is new`);
      assert.match(String(unknown.decision.patch.set.holderRef), /^ce_person_/, `${mode}: stored as an id, not a name`);
      assert.deepEqual(Array.from(unknown.decision.patch.microNewEntities, row => row.name).sort(), ['금빛 열쇠', '라온'], `${mode}: the decision carries what is new`);
      if (mode === 'plugin_only') {
        // Heads stored before the rule still say not_updated; what they actually hold decides.
        const headKey = [...fixture.local.keys()].find(key => key.endsWith(':continuity-state'));
        const rewrite = pendingRow => {
          const head = JSON.parse(fixture.local.get(headKey));
          head.domainStatus.world = {...head.domainStatus.world, status: 'not_updated', reason: 'unified_bindings_pending'};
          head.unifiedApplied = {...head.unifiedApplied, pending: [pendingRow]};
          fixture.local.set(headKey, JSON.stringify(head));
        };
        rewrite({fact: 'fy', domain: 'world', reason: 'missing_current_binding'});
        assert.equal((await f.r.api.debugAdmitActiveMicroStateClaim(6, 0)).reason, 'state_domain_not_ready', 'a real hold still blocks Micro');
        rewrite({fact: 'fy', domain: 'world', reason: 'memory_record_quarantined'});
        assert.equal((await f.r.api.debugAdmitActiveMicroStateClaim(6, 0)).status, 'admitted', 'a rejected fact alone does not');
      }
      console.log(`PASS micro state supply in ${mode}`);
    } finally { await fixture.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
