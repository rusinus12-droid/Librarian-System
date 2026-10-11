'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
const transformSource = source => {
  const anchor = '      debugReadActiveCompletedTurnReceipt: async turnValue => {';
  assert.ok(source.includes(anchor));
  source = source.replace(anchor, `      debugExpireMicroLeaseForTurn: async turnValue => {
        const context=await resolveContext();
        const active=await readActiveCompletedTurnReceipt(context.scope,hostWorldlineIdForScope(context.scope),0,turnValue);
        if(active.status!=='verified')throw new Error('receipt_missing');
        const workKey=key.microWork(context.scope,active.receipt.worldlineId,0,turnValue,
          active.receipt.revisionId,microProducerVersion);
        const work=await readRecoverableMicroJson(workKey,context.scope);
        if(work?.phase!=='invoking')throw new Error('expected_invoking_work');
        await storage.setVerifiedJson(workKey,{...work,leaseExpiresAt:Date.now()-1},context.scope);
      },\n`+anchor);
  const root="    debugBuildPairs(chat = {}, cacheKey = '')";
  assert.ok(source.includes(root));
  return source.replace(root,"    async debugExpireMicroLeaseForTurn(turn) { return LibraMemoryCore.debugExpireMicroLeaseForTurn(turn); },\n"+root);
};
const waitForAsync = async (predicate, timeoutMs = 15000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for durable T6 receipt');
};
const localHead = local => [...local.values()].map(raw => {
  try { return JSON.parse(raw); } catch { return null; }
}).find(value => value?.schema === 'libra.continuity_state.v2');

const observations = new Map([
  [1, '도서관 전체는 정숙 구역'],
  [3, '준호가 지호에게서 열쇠를 받아 들었다'],
  [5, '공연 허가를 누가 내주는지는 아직 밝혀지지 않았다'],
  [6, 'FUTURE_MICRO_STATE_SENTINEL']
]);
const sourceClaim = (input, value) => {
  const text = input.assistant.text, startOffset = text.indexOf(value);
  assert.ok(startOffset >= 0, `T${input.binding.turn} quote belongs to the completed assistant source`);
  return {changeKind: 'event', text: value, actor: '', target: '', temporalRole: 'current',
    certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
    stateIntent: {domain: 'narrative', target: {scope: 'current_narrative'},
      field: 'summary', operation: 'set', value},
    evidence: {role: 'assistant', messageId: input.assistant.messageId,
      startOffset, endOffset: startOffset + value.length, exactQuote: value}};
};

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fx = await serverFixture({mode, transformSource, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fx, fullMessages = f.chat.message;
      const canonical = artifact();
      canonical.facts.find(fact => fact.tempFactId === 'f13').values.thread.summary = observations.get(5);
      f.control.artifact = canonical;
      let allowCanonical = false;
      let releaseT6, heldT6 = false;
      f.control.onCall = async args => {
        const messages = args[0].messages;
        if (!String(messages[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
          return allowCanonical ? {type: 'success', result: JSON.stringify(canonical)}
            : {type: 'error', result: 'Canonical held until explicit cold-start fixture step'};
        }
        const input = JSON.parse(messages[1].content), turn = input.binding.turn;
        const value = observations.get(turn);
        if (turn === 6 && !heldT6) {
          heldT6 = true;
          await new Promise(resolve => { releaseT6 = resolve; });
        }
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1',
          personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: value ? [sourceClaim(input, value)] : []}
        })};
      };
      for (let turn = 1; turn <= 5; turn += 1) {
        f.chat.message = fullMessages.slice(0, turn * 2);
        f.chat.messages = f.chat.message;
        listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
          messageIndex: turn * 2 - 1});
        await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === turn, 15000);
      }
      const preCanonical = await waitForAsync(async () => {
        const view = await f.r.api.debugLoadContinuityStateForResponse();
        return view.head?.narrative?.summary === observations.get(5)
          && view.authority?.microProjection?.throughTurn === 5 ? view : null;
      });
      assert.equal(preCanonical.head?.narrative?.summary, observations.get(5),
        `${mode}: last admitted pre-Canonical Micro state is projected`);
      assert.equal(preCanonical.authority?.microProjection?.throughTurn, 5);
      assert.equal(fx.getRecords('libra.continuity_state.v2').length, 0,
        `${mode}: Micro projection leaves the persistent Canonical Head absent`);
      f.chat.message = fullMessages;
      f.chat.messages = fullMessages;
      allowCanonical = true;
      const canonicalRun = await f.run();
      assert.equal(canonicalRun.completed + canonicalRun.skipped, 1,
        `${mode}: T5 Canonical is committed alongside T5 Micro: ${JSON.stringify(canonicalRun)}`);
      assert.equal((mode === 'server_only' ? fx.getHead() : localHead(fx.local))?.status,
        'ready', `${mode}: Canonical Head is durable`);
      assert.equal((await f.r.api.debugReadActiveMicroMemory(5)).status, 'verified',
        `${mode}: T5 Micro survives Canonical commit`);
      const after = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(after.head?.narrative?.summary, observations.get(5));
      const overlap = after.authority?.microProjection?.transitions || [];
      assert.ok(overlap.some(row => row.turn === 5 && row.disposition === 'absorbed'),
        `${mode}: T5 matching Micro effect is acknowledged without double application`);
      assert.ok(overlap.some(row => row.turn === 3 && row.disposition === 'corrected'),
        `${mode}: T3 interim effect is superseded by the admitted T5 effect`);

      // A provider response can finish after the user rolls the State view back.
      // Keep its verified Micro, but never project that future turn into T5.
      fullMessages.push({role: 'user', data: 'Continue after T5.', chatId: 't6-u'},
        {role: 'assistant', data: observations.get(6), chatId: 't6-a'});
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0,
        messageIndex: 11});
      const t6 = await waitForAsync(async () => {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(6);
        return active.status === 'verified' ? active : null;
      });
      const lineage = await f.r.api.getHostLineageStatus();
      const scope = {scopeKey:lineage.scopeKey, scopeId:lineage.scopeKey,
        characterId:f.character.id, chatId:f.chat.id};
      // A source-only receipt without a durable planned Micro marker is unknown.
      // Start the explicit, bounded retry before rolling back the State view.
      const pendingT6 = f.r.api.resumeNeverStartedMicro({scope,receiptRef:t6.receiptKey,
        revision:t6.receipt.revisionId,digest:t6.receipt.sourceDigest});
      await waitFor(() => releaseT6, 15000);
      assert.equal((await f.r.api.rollbackWorldManagerState({throughTurn: 5})).ok, true);
      releaseT6();
      const lateT6 = await pendingT6;
      assert.equal(lateT6.status,'stale',`${mode}: restore fence rejects a late provider result`);
      assert.equal(lateT6.reason,'source_or_restore_boundary_changed');
      assert.equal((await f.r.api.debugReadActiveMicroMemory(6)).status,'missing',
        `${mode}: stale late result is not published`);
      await f.r.api.debugExpireMicroLeaseForTurn(6);
      await new Promise(resolve => setTimeout(resolve, 1600));
      const retriedT6 = await f.r.api.retryMicroAnalysis({scope,receiptRef:t6.receiptKey,
        revision:t6.receipt.revisionId,digest:t6.receipt.sourceDigest});
      assert.equal(retriedT6.status,'verified',
        `${mode}: explicit retry after rollback publishes a current source-bound Micro`);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6, 15000);
      const future = await f.r.api.debugReadActiveMicroMemory(6);
      assert.equal(future.status, 'verified', `${mode}: a late Micro retains its source-bound record`);
      const microBytes = () => mode === 'server_only'
        ? fx.storedRows().find(row => row.key === future.recordKey)?.raw : fx.local.get(future.recordKey);
      const futureBytes = microBytes();
      assert.equal(typeof futureBytes, 'string');
      const blocked = await f.r.api.debugReadCurrentMicroStateAdmission(6);
      assert.equal(blocked.status, 'pending');
      assert.equal(blocked.reason, 'outside_state_worldline_cutoff');
      const beforeReads = JSON.stringify([...fx.local]);
      const beforeServerReads = JSON.stringify(fx.storedRows());
      const rolledResponse = await f.r.api.getResponseContext();
      const queryContext = await f.r.api.getResponseContext({currentInput:'Continue at T5.'});
      for (const context of [rolledResponse, queryContext]) {
        assert.equal((await f.r.api.validateResponseContext(context)).current, true,
          `${mode}: rolled-back public context retains its source and State authority`);
        assert.equal(context.cutoffTurn, 5);
        assert.equal(context.values.currentHead.throughTurn, 5);
        assert.equal(context.values.currentHead.narrative.summary, observations.get(5));
        assert.ok((context.values.currentHead.microProjection?.pendingClaims || [])
          .every(row => row.turn == null || row.turn <= 5),
        `${mode}: a hidden future turn must not downgrade current State authority`);
      }
      assert.equal(JSON.stringify([...fx.local]), beforeReads, `${mode}: cutoff response reads leave local bytes unchanged`);
      assert.equal(JSON.stringify(fx.storedRows()), beforeServerReads, `${mode}: cutoff response reads leave server bytes unchanged`);

      assert.equal((await f.r.api.setWorldManagerWorldline({worldlineId: 'main', cutoffTurn: null})).ok, true);
      assert.equal((await f.r.api.debugAdmitActiveMicroStateClaim(6)).status, 'admitted',
        `${mode}: reopening the view can admit the retained T6 Micro`);
      const resumed = await f.r.api.getResponseContext();
      assert.equal(resumed.cutoffTurn, null);
      assert.equal(resumed.values.currentHead.throughTurn, 6);
      assert.equal(resumed.values.currentHead.narrative.summary, observations.get(6));
      assert.equal((await f.r.api.rollbackWorldManagerState({throughTurn: 5})).ok, true);
      assert.equal((await f.r.api.debugAdmitActiveMicroStateClaim(6)).reason, 'outside_state_worldline_cutoff',
        `${mode}: an older admitted decision cannot bypass a newly restored cutoff`);
      const reopened = await fx.restart();
      // restart() supplies the fixture's original five-turn host chat. Restore
      // the actual six-turn transcript before checking the retained T6 binding.
      reopened.chat.message = JSON.parse(JSON.stringify(fullMessages));
      reopened.chat.messages = reopened.chat.message;
      const replay = await reopened.r.api.debugLoadContinuityStateForResponse();
      assert.equal(replay.head?.narrative?.summary, observations.get(5));
      assert.ok(replay.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.disposition === 'absorbed'),
      `${mode}: fresh bridge reconstructs the same T5 overlap disposition`);
      assert.equal(replay.head?.throughTurn, 5, `${mode}: fresh bridge still excludes the retained T6 Micro`);
      assert.equal(JSON.stringify((await reopened.r.api.debugReadActiveMicroMemory(6)).record), JSON.stringify(future.record),
        `${mode}: rollback and reopening preserve exact Micro content`);
      assert.equal(microBytes(), futureBytes, `${mode}: the durable Micro bytes are preserved through restart`);
      console.log(`PASS Micro-to-Canonical State frontier in ${mode}`);
    } finally { await fx.cleanup(); }
  }
  {
    let listener;
    const fx = await serverFixture({mode: 'plugin_only', host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fx, fullMessages = f.chat.message;
      f.control.onCall = async args => {
        const messages = args[0].messages;
        if (!String(messages[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
          return {type: 'success', result: JSON.stringify(artifact())};
        }
        const input = JSON.parse(messages[1].content);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: input.binding.turn === 1 ? [sourceClaim(input, observations.get(1))] : []}
        })};
      };
      f.chat.message = fullMessages.slice(0, 2);
      f.chat.messages = f.chat.message;
      listener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
      f.chat.message = fullMessages;
      f.chat.messages = fullMessages;
      await f.run();
      const after = await f.r.api.debugLoadContinuityStateForResponse();
      assert.equal(after.head?.narrative?.summary, '공연 허가자를 아직 알 수 없음',
        'a contradictory Micro value does not overwrite Canonical State');
      assert.ok(after.authority?.microProjection?.pendingClaims?.some(item =>
        item.turn === 1 && item.reason === 'canonical_overlap_conflict'
          && item.candidateValue === observations.get(1)),
      'the last admitted Micro effect remains visible as uncertain evidence');
      assert.equal(after.authority?.current, false);
      console.log('PASS contradictory Canonical overlap remains pending');
    } finally { await fx.cleanup(); }
  }
  {
    const fx = await serverFixture({mode: 'plugin_only'});
    try {
      const {f} = fx, canonical = artifact();
      canonical.facts.find(fact => fact.tempFactId === 'f13').values.thread.summary = observations.get(5);
      f.control.onCall = async args => {
        const messages = args[0].messages;
        if (!String(messages[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
          return {type: 'success', result: JSON.stringify(canonical)};
        }
        const input = JSON.parse(messages[1].content);
        if (input.binding.turn !== 5 || !f.upgradeT5) {
          return {type: 'error', result: 'controlled Micro analysis unavailable'};
        }
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: [sourceClaim(input, observations.get(5))]}
        })};
      };
      assert.equal((await f.run()).completed, 1);
      const lineage = await f.r.api.getHostLineageStatus();
      const scope = {scopeKey:lineage.scopeKey,scopeId:lineage.scopeKey,
        characterId:f.character.id,chatId:f.chat.id};
      const t5 = await f.r.api.debugReadActiveCompletedTurnReceipt(5);
      assert.equal(t5.status,'verified');
      const request = {scope,receiptRef:t5.receiptKey,
        revision:t5.receipt.revisionId,digest:t5.receipt.sourceDigest};
      assert.equal((await f.r.api.retryMicroAnalysis(request)).status,'verified');
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5, 15000);
      assert.equal((await f.r.api.debugReadActiveMicroMemory(5)).record?.analysisStatus,
        'minimum_source_bound');
      f.upgradeT5 = true;
      await new Promise(resolve => setTimeout(resolve,1600));
      const upgraded = await f.r.api.retryMicroAnalysis(request);
      assert.equal(upgraded.status, 'verified');
      const after = await f.r.api.debugLoadContinuityStateForResponse();
      assert.ok(after.authority?.microProjection?.transitions?.some(row =>
        row.turn === 5 && row.disposition === 'absorbed'),
      'a source-verified T5 Micro produced after Canonical is recognized as absorbed');
      console.log('PASS Canonical-first T5 Micro is absorbed without a second State write');
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
