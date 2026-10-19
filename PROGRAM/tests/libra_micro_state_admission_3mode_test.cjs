'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});
const decisions = rows => rows.filter(row => row.value?.schema === 'libra.micro_state_admission.v1');
const quoteSpan = (text, quote, messageId) => ({role: 'assistant', messageId,
  startOffset: text.indexOf(quote), endOffset: text.indexOf(quote) + quote.length, exactQuote: quote});

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture;
      assert.equal((await f.run()).completed, 1, `${mode}: T5 Canonical baseline commits`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
      const beforeHead = mode === 'plugin_only'
        ? localRows(fixture.local).find(row => row.value?.schema === 'libra.continuity_state.v2')?.value
        : fixture.getHead();
      assert.equal(beforeHead?.status, 'ready');
      f.chat.message.push(
        {role: 'user', chatId: 't6-u', data: '도서관 문과 새 방문자를 확인해 줘.'},
        {role: 'assistant', chatId: 't6-a', data: '도서관 문이 열렸다. 라온이 들어왔다.'}
      );
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        const receipt = active.receipt, body = receipt.assistant.text;
        const worldQuote = '도서관 문이 열렸다';
        const personQuote = '라온이 들어왔다';
        const worldClaim = {
          changeKind: 'world', text: '도서관 문이 열렸다.', actor: '', target: '도서관',
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
          stateChangeType: 'set', evidence: quoteSpan(body, worldQuote, receipt.assistant.chatId)
        };
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch, turn: 6,
            sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [
              {...worldClaim, stateIntent: {domain: 'world', target: {entityName: '도서관'},
                field: 'doorStatus', operation: 'set', value: '열렸다'}},
              {...worldClaim, stateIntent: {domain: 'world', target: {entityName: '도서관'},
                field: 'ownership', operation: 'set', value: '열렸다'}},
              {changeKind: 'person', text: '라온이 들어왔다.', actor: '라온', target: '',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
                stateChangeType: 'set', stateIntent: {domain: 'character',
                  target: {entityName: '라온'}, field: 'condition', operation: 'set', value: '들어왔다'},
                evidence: quoteSpan(body, personQuote, receipt.assistant.chatId)}
            ]}
        })};
      };
      assert.equal(typeof f.r.api.debugAdmitActiveMicroStateClaim, 'function');
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
      const micro = await f.r.api.debugReadActiveMicroMemory(6);
      assert.equal(micro.status, 'verified');
      assert.equal(micro.record.claims.length, 3);
      await waitFor(() => {
        const rows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
        return decisions(rows).length === 3;
      }, 15000);
      assert.deepEqual(JSON.parse(JSON.stringify(f.r.api.getCaptureBackendState().lastMicroPublication?.stateAdmission)),
        {admitted: 1, pending: 2, pendingReconciliation: 0},
        `${mode}: durable Micro publication automatically evaluates its State claims`);
      assert.equal(typeof f.r.api.debugReadCurrentMicroStateAdmission, 'function');
      const readOnly = await f.r.api.debugReadCurrentMicroStateAdmission(6, 0);
      assert.equal(readOnly.status, 'admitted', `${mode}: response reader sees only the persisted current-basis decision`);
      const readRows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      assert.equal(decisions(readRows).length, 3, `${mode}: read-only admission lookup writes no new decision`);
      assert.equal(typeof f.r.api.debugLoadContinuityStateForResponse, 'function');
      const projected = await f.r.api.debugLoadContinuityStateForResponse();
      const libraryState = projected.head?.world?.find(row => row.name === '도서관')?.state;
      assert.equal(libraryState?.doorStatus, '열렸다', `${mode}: response State includes admitted T6 Micro change`);
      assert.equal(Object.hasOwn(libraryState || {}, 'ownership'), false,
        `${mode}: unverified high-risk claim cannot enter response State`);
      assert.equal(projected.authority?.microProjection?.throughTurn, 6);
      const responseContext = await f.r.api.getResponseContext({currentInput: '도서관 문 상태'});
      assert.equal(responseContext.values?.currentHead?.world?.find(row => row.name === '도서관')?.state?.doorStatus,
        '열렸다', `${mode}: sealed response context carries the admitted Micro field`);
      const afterProjectionRows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      assert.equal(decisions(afterProjectionRows).length, 3,
        `${mode}: response projection reads admission decisions without persisting new ones`);
      const admitted = await f.r.api.debugAdmitActiveMicroStateClaim(6, 0);
      const guarded = await f.r.api.debugAdmitActiveMicroStateClaim(6, 1);
      const unknown = await f.r.api.debugAdmitActiveMicroStateClaim(6, 2);
      assert.equal(admitted.status, 'admitted', `${mode}: source-backed low-risk change is admitted: ${admitted.reason}`);
      assert.equal(admitted.decision?.patch?.set?.doorStatus, '열렸다');
      assert.equal(guarded.status, 'pending');
      assert.equal(guarded.reason, 'independent_verifier_required');
      assert.equal(unknown.status, 'pending');
      assert.equal(unknown.reason, 'registry_target_unresolved');
      const rows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      assert.equal(decisions(rows).length, 3, `${mode}: all decisions survive physical readback`);
      if (mode === 'mirror') {
        assert.deepEqual(decisions(localRows(fixture.local)).map(row => row.value),
          decisions(fixture.storedRows()).map(row => row.value), 'mirror transports one decision set');
        const localDecision = decisions(localRows(fixture.local)).find(row => row.value.claimIndex === 0);
        const savedDecision = fixture.local.get(localDecision.key);
        fixture.local.delete(localDecision.key);
        const oneSided = await f.r.api.debugLoadContinuityStateForResponse();
        assert.equal(Object.hasOwn(oneSided.head?.world?.find(row => row.name === '도서관')?.state || {}, 'doorStatus'), false,
          'one-sided mirror admission read cannot project its effect');
        assert.equal(oneSided.authority?.microProjection?.status, 'partial');
        assert.equal(fixture.local.has(localDecision.key), false,
          'read-only response projection does not repair or rewrite a one-sided decision');
        fixture.local.set(localDecision.key, savedDecision);
      }
      const afterHead = mode === 'plugin_only'
        ? localRows(fixture.local).find(row => row.value?.schema === 'libra.continuity_state.v2')?.value
        : fixture.getHead();
      assert.deepEqual(afterHead, beforeHead, `${mode}: admission does not mutate Canonical State Head`);
      const repeat = await f.r.api.debugAdmitActiveMicroStateClaim(6, 0);
      assert.equal(repeat.decisionKey, admitted.decisionKey, 'duplicate reuses the immutable decision');
      if (mode === 'plugin_only') {
        const headKey = localRows(fixture.local).find(row => row.value?.schema === 'libra.continuity_state.v2')?.key;
        assert.ok(headKey);
        const changedHead = JSON.parse(fixture.local.get(headKey));
        fixture.local.set(headKey, JSON.stringify({...changedHead, updatedAt: `${changedHead.updatedAt}-before` }));
        const originalSet = fixture.backend.setItem;
        let raced = false;
        fixture.backend.setItem = async (storageKey, value) => {
          if (!raced && String(storageKey).includes(':micro-state-admission:')) {
            raced = true;
            const latestHead = JSON.parse(fixture.local.get(headKey));
            fixture.local.set(headKey, JSON.stringify({...latestHead, updatedAt: `${latestHead.updatedAt}-during` }));
          }
          return originalSet(storageKey, value);
        };
        const racingBasis = await f.r.api.debugAdmitActiveMicroStateClaim(6, 0);
        fixture.backend.setItem = originalSet;
        assert.equal(raced, true);
        assert.equal(racingBasis.status, 'stale_basis',
          'a State Head changed during decision write cannot be returned as admitted');
        fixture.local.delete(headKey);
        const missingBasis = await f.r.api.debugAdmitActiveMicroStateClaim(6, 0);
        assert.equal(missingBasis.status, 'pending');
        assert.equal(missingBasis.reason, 'canonical_state_basis_unavailable',
          'an existing Canonical cannot be replaced with a synthetic genesis basis');
      }
      f.chat.message[11].data += ' 수정된 응답.';
      const stale = await f.r.api.debugAdmitActiveMicroStateClaim(6, 0);
      assert.equal(stale.status, 'stale_source', `${mode}: an edited source cannot use the old decision`);
      const afterEdit = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(Object.hasOwn(afterEdit.head?.world?.find(row => row.name === '도서관')?.state || {}, 'doorStatus'), false,
        `${mode}: source edit removes the old Micro effect from the response projection`);
      console.log(`PASS source-bound Micro State admission decisions in ${mode}`);
    } finally { await fixture.cleanup(); }
  }
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture;
      const fullMessages = f.chat.message;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      const value = '도서관 전체는 정숙 구역';
      f.control.onCall = async () => {
        const source = await f.r.api.debugReadActiveCompletedTurnReceipt(1);
        const receipt = source.receipt;
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
            worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
            turn: 1, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
            claims: [{changeKind: 'event', text: `${value}이다.`, actor: '', target: '',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'set', stateIntent: {domain: 'narrative',
                target: {scope: 'current_narrative'}, field: 'summary', operation: 'set', value},
              evidence: quoteSpan(receipt.assistant.text, value, receipt.assistant.chatId)}]}
        })};
      };
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
      const rows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      const decision = decisions(rows)[0]?.value;
      assert.equal(decision?.status, 'admitted', `${mode}: first-turn Micro has a verified genesis basis: ${decision?.reason}`);
      assert.equal(rows.some(row => row.value?.schema === 'libra.continuity_state.v2'), false,
        `${mode}: genesis admission does not fabricate a Canonical Head`);
      const genesisView = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(genesisView.head?.narrative?.summary, value,
        `${mode}: first-turn admitted Micro change is visible before a Canonical exists`);
      assert.equal(genesisView.authority?.microProjection?.throughTurn, 1);
      assert.equal((await f.r.api.getWorldManagerNarrative()).summary, value,
        `${mode}: the public narrative viewer reads the admitted Micro projection before Canonical`);
      const overlapping = await Promise.all(Array.from({length:3},()=>f.r.api.getWorldManagerNarrative()));
      for(const row of overlapping)assert.equal(row.summary,value,
        `${mode}: superseded refreshes still return their verified Micro view to their own caller`);
      assert.equal(f.control.calls.length, 1);
      f.chat.message = fullMessages;
      f.chat.messages = fullMessages;
      f.control.onCall = null;
      assert.equal((await f.run()).completed, 1);
      await waitFor(() => {
        const current = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
        return decisions(current).filter(row => row.value.turn === 1 && row.value.claimIndex === 0).length >= 2;
      }, 15000);
      const updated = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      const t1Decisions = decisions(updated).filter(row => row.value.turn === 1 && row.value.claimIndex === 0);
      assert.equal(new Set(t1Decisions.map(row => row.value.basisDigest)).size, 2,
        `${mode}: Canonical State commits cause a fresh basis-bound assessment`);
      console.log(`PASS pre-Canonical Micro State admission in ${mode}`);
    } finally { await fixture.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
