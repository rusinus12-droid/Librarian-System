'use strict';
// The durable v5 target is keyless, so it must survive native prefix copy and
// session handoff without being redirected to a similarly named ref.
const assert = require('node:assert/strict');
const { lineageFixture } = require('./fixtures/libra_unified_lineage_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const { actualClassicPacket, deliveredClosureRows } = require('./fixtures/libra_actual_classic_request.cjs');

const sourceRows = [
  ['민아는 지호에게 은빛 열쇠를 건넸다.', '오늘 열쇠 반환을 약속했다.'],
  ['두 사람은 도서관에 들어갔다.', '열쇠 약속은 계속 열려 있었다.'],
  ['민아는 서재에 남았다.', '지호는 복도로 나갔다.'],
  ['준호는 공연실에 있었다.', '공연 허가는 아직 미정이었다.'],
  ['도서관은 문을 닫았다.', '열쇠는 아직 반환되지 않았다.'],
  ['민아는 기록을 확인했다.', '반환 시각은 확인되지 않았다.'],
  ['지호는 서재로 돌아왔다.', '열쇠를 손에 들고 있었다.'],
  ['준호는 공연실을 떠났다.', '허가 담당자는 나타나지 않았다.'],
  ['민아는 복도에서 기다렸다.', '도서관은 조용했다.'],
  ['지호가 은빛 열쇠를 민아에게 돌려주었다.', '오늘 열쇠 반환 다짐이 이행되었다.']
];
const rows = sourceRows.flatMap((pair, index) => [
  { role: 'user', chatId: `t${index + 1}-u`, data: pair[0] },
  { role: 'assistant', chatId: `t${index + 1}-a`, data: pair[1] }
]);
const chat = { id: 'thread-transfer-source', chatId: 'thread-transfer-source', name: 'Lifecycle transfer source', message: rows };
const quote = (turn, role = 'assistant') => ({
  ref: `t${turn}-${role === 'user' ? 'u' : 'a'}`,
  quote: sourceRows[turn - 1][role === 'user' ? 0 : 1]
});
const aliasRows = args => {
  const content = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = content.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const threadArtifact = ({ turn, summary, status, link = '', resolution = '', alias = '' }) => ({
  schema: 'libra.canonical_artifact.v5',
  entities: [
    { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
    { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
    { tempId: 'thread', name: '열쇠 반환', type: 'world', kind: 'thread', evidenceSpans: [quote(turn)] }
  ],
  facts: [{
    tempFactId: 'f1', domain: 'narrative', subjectTempRef: 'thread', claimKind: 'thread',
    values: { thread: {
      summary, status, kind: 'promise',
      participants: [{ role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }],
      ...(link ? { link } : {}), ...(resolution ? { resolution } : {}), ...(alias ? { linkCandidateAlias: alias } : {})
    } },
    text: summary, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: [quote(turn)]
  }],
  stateBindings: []
});
const manifestRefs = manifest => [...(manifest?.inheritedMemories || []), ...Object.values(manifest?.memories || {})]
  .filter(ref => ref?.status === 'committed').sort((a,b) => Number(a.sessionEpoch || 0) - Number(b.sessionEpoch || 0)
    || Number(a.turnRange?.start || 0) - Number(b.turnRange?.start || 0));

(async () => {
  const f = await lineageFixture({ snapshot: { chat } });
  try {
    const promptAliases = [];
    let canonicalCalls = 0;
    let aliasStage = 'source_resolve';
    f.control.onCall = args => {
      if (JSON.stringify(args).includes('[LIBRA MICRO SOURCE CONTRACT]')) {
        const rawInput = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '{}';
        const input = JSON.parse(rawInput);
        if (Number(input.binding?.turn) === 2) {
          const quote = input.assistant.text;
          return {type: 'success', result: JSON.stringify({
            schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []},
            micro: {schema: 'libra.micro_memory.v1', ...input.binding,
              claims: [{changeKind: 'event', text: quote, actor: '', target: '',
                temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
                stateChangeType: 'set', stateIntent: {domain: 'narrative',
                  target: {scope: 'current_narrative'}, field: 'summary',
                  operation: 'set', value: quote},
                evidence: {role: 'assistant', messageId: input.assistant.messageId,
                  startOffset: 0, endOffset: quote.length, exactQuote: quote}}]}
          })};
        }
        return { type: 'error', result: 'fixture Micro provider unavailable' };
      }
      canonicalCalls += 1;
      const candidates = aliasRows(args);
      promptAliases.push(candidates);
      if (canonicalCalls === 1) return { type: 'success', result: JSON.stringify(threadArtifact({
        turn: 1, summary: '오늘 열쇠를 돌려주겠다는 약속', status: 'open'
      })) };
      const expectedSummary = aliasStage === 'source_resolve'
        ? '오늘 열쇠를 돌려주겠다는 약속' : '은빛 열쇠를 민아에게 돌려준 약속의 이행';
      const candidate = candidates.find(row => row.summary === expectedSummary
        && JSON.stringify(row.participants) === JSON.stringify([{ role: 'owner', name: '지호' }, { role: 'target', name: '민아' }]));
      assert.ok(candidate?.alias, `request-local target alias is supplied by the actual provider prompt (${JSON.stringify(candidates)})`);
      if (aliasStage === 'target_reopen') return { type: 'success', result: JSON.stringify(threadArtifact({
        turn: 1, summary: '은빛 열쇠 반환 약속을 이번 회차에 다시 열었다.', status: 'open',
        link: 'reopen', alias: candidate.alias
      })) };
      return { type: 'success', result: JSON.stringify(threadArtifact({
        turn: 10, summary: '은빛 열쇠를 민아에게 돌려준 약속의 이행', status: 'resolved',
        link: 'resolve', resolution: 'fulfilled', alias: candidate.alias
      })) };
    };
    const committed = await f.run();
    assert.equal(committed.completed, 2, JSON.stringify(committed));
    assert.equal(canonicalCalls, 2);
    assert.equal(promptAliases[1].length, 1);
    const parentFirst = f.getMemory(1), parentSecond = f.getMemory(6);
    const acceptedFactText = parentSecond.canonicalArtifact.facts[0].text;
    assert.equal(parentSecond.canonicalArtifact.facts[0].values.thread.linkStatus, 'accepted');
    const sourceManifest = f.manifest(f.current());
    const sourceRefs = manifestRefs(sourceManifest);
    assert.equal(sourceRefs.length, 2);
    // Cold-start history is receipt-ready but does not automatically invoke Micro.
    // Explicitly retry the ten verified completed receipts before testing that
    // their archive, admission, and canonical lifecycle survive transfer.
    await require('./fixtures/libra_explicit_micro_retry.cjs').retryHistoricalMicro(
      f, Array.from({length:10},(_,index)=>index+1), {});
    await waitFor(() => f.getRecords('libra.micro_memory_head.v1').filter(row =>
      row.value.scopeKey === sourceManifest.scopeKey).length === 10, 15000);
    const sourceMicroT2 = f.getRecords('libra.micro_memory.v1').find(row =>
      row.value.scopeKey === sourceManifest.scopeKey && row.value.turn === 2);
    assert.ok(sourceMicroT2?.value?.claims?.[0]?.evidence?.exactQuote,
      'the source has a durable turn-specific Micro detail before handoff');
    await waitFor(() => f.getRecords('libra.micro_state_admission.v1').some(row =>
      row.value.scopeKey === sourceManifest.scopeKey && row.value.turn === 2), 15000);
    const sourceBytes = new Map(sourceRefs.map(ref => [ref.key, f.r.values.get(ref.key)]));

    f.branch(10, 'thread-lifecycle-native-child');
    const copied = await f.r.api.debugNativeChatCopy({ force: true });
    assert.equal(copied.result?.ok, true, JSON.stringify(copied));
    assert.equal(canonicalCalls, 2, 'native prefix copy reuses stored canonical v5 data without a provider call');
    let activeManifest = f.manifest(f.current());
    let activeRefs = manifestRefs(activeManifest);
    assert.ok(activeRefs.length >= 2, 'native child has the source prefix in its active manifest');
    const branchMeta = f.getRecords('libra.state_worldline_meta.v1').find(row => row.value.scopeKey === activeManifest.scopeKey)?.value;
    assert.equal(branchMeta?.activeWorldlineId || 'main', 'main');
    const branchWorldline = branchMeta?.worldlines?.[branchMeta?.activeWorldlineId || 'main'];
    assert.equal(branchWorldline?.cutoffTurn ?? null, null, 'native child is checked at its actual active lineage head');
    const branchBytes = new Map(activeRefs.map(ref => [ref.key, f.r.values.get(ref.key)]));
    const branchReplay = await f.r.api.rebuildWorldManagerState();
    assert.equal(branchReplay.ok, true, JSON.stringify(branchReplay));
    assert.equal(branchReplay.providerCalls, 0);
    for (const [key, bytes] of branchBytes) assert.equal(f.r.values.get(key), bytes, `native replay leaves ${key} bytes unchanged`);

    const settings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(settings?.settings || settings || {}), recallMaxMemories: 1 });
    const query = '오늘 열쇠를 돌려주겠다는 약속은 아직 이행되지 않았다';
    const branchRecall = await f.r.api.previewUnifiedMemoryRecall(query);
    assert.equal(branchRecall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount, 1,
      'the keyless target resolves in the native child prefix');
    const branchPacket = await actualClassicPacket(f, query, activeManifest.scopeKey);
    assert.equal(deliveredClosureRows(branchPacket).filter(row => row.memoryId === parentSecond.memoryId
      && row.revision === parentSecond.revision && row.text === acceptedFactText).length, 1,
      'native branch delivers the exact later lifecycle outcome in the sealed Classic request');
    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: parentSecond.memoryId, revision: parentSecond.revision });
    assert.equal(history.provenance?.domains?.narrative?.canonicalAssertions?.[0]?.values?.thread?.resolution, 'fulfilled');

    const prepared = await f.r.api.prepareSessionHandoff({ transferId: 'thread-lifecycle-keyless-handoff' });
    assert.notEqual(prepared.ok, false, JSON.stringify(prepared));
    f.empty('thread-lifecycle-handoff-target');
    const preparedMicroArchiveKey = 'libra:v1:micro-handoff-archive:thread-lifecycle-keyless-handoff';
    const preparedMicroArchiveBytes = f.r.values.get(preparedMicroArchiveKey);
    const corruptedPreparedArchive = JSON.parse(preparedMicroArchiveBytes);
    corruptedPreparedArchive.records.find(row => row.value?.schema === 'libra.micro_memory.v1')
      .value.analysisStatus = 'forged';
    f.r.values.set(preparedMicroArchiveKey, JSON.stringify(corruptedPreparedArchive));
    await assert.rejects(() => f.r.api.adoptSessionHandoff({
      transferId: 'thread-lifecycle-keyless-handoff',
      targetChatId: 'thread-lifecycle-handoff-target'
    }), /LIBRA_MICRO_HANDOFF_ARCHIVE_DIGEST_INVALID/,
    'archive corruption must abort adoption before publishing a target manifest');
    assert.equal(f.manifest(f.current())?.lastSessionHandoff?.transferId, undefined);
    f.r.values.set(preparedMicroArchiveKey, preparedMicroArchiveBytes);
    const adopted = await f.r.api.adoptSessionHandoff({ transferId: 'thread-lifecycle-keyless-handoff', targetChatId: 'thread-lifecycle-handoff-target' });
    assert.equal(adopted.verified, true, JSON.stringify(adopted));
    assert.equal(canonicalCalls, 2, 'handoff adoption replays without a provider call');
    activeManifest = f.manifest(f.current());
    activeRefs = manifestRefs(activeManifest);
    assert.ok(activeRefs.length >= 2, 'handoff target has the v5 source prefix');
    const inheritedMicroRef = activeManifest.inheritedMicroArchives?.[0];
    assert.equal(inheritedMicroRef?.schema, 'libra.micro_handoff_archive_ref.v1');
    const microArchive = JSON.parse(f.r.values.get(inheritedMicroRef.archiveKey) || 'null');
    assert.equal(microArchive?.schema, 'libra.micro_handoff_archive.v1');
    assert.equal(inheritedMicroRef.recordCount, microArchive.records.length);
    assert.equal(microArchive.records.filter(row => row.value?.schema === 'libra.micro_memory.v1').length, 10,
      'all source Micro records remain physically archived');
    assert.ok(microArchive.records.some(row => row.value?.schema === 'libra.micro_state_admission.v1'
      && row.value.turn === 2), 'the Micro State decision remains in the same sealed owner archive');
    const adoptedMeta = f.getRecords('libra.state_worldline_meta.v1').find(row => row.value.scopeKey === activeManifest.scopeKey)?.value;
    assert.equal(adoptedMeta?.activeWorldlineId || 'main', 'main');
    const adoptedWorldline = adoptedMeta?.worldlines?.[adoptedMeta?.activeWorldlineId || 'main'];
    assert.equal(adoptedWorldline?.cutoffTurn ?? null, null, 'handoff target uses the active uncut main worldline');
    const adoptedHead = f.head(f.current());
    assert.equal(adoptedHead?.throughSessionEpoch, -1, 'handoff State is read at the inherited source epoch');
    assert.equal(adoptedHead?.domainStatus?.narrative?.throughTurn, 10,
      'handoff narrative State reaches the transferred source head within its inherited epoch');
    assert.equal(adoptedHead?.narrative?.fieldEvidence?.threads?.canonical?.memoryId,
      activeRefs.find(ref => ref.turnRange?.end === 10)?.memoryId,
      'handoff State names the active canonical v5 outcome revision');
    const handoffBytes = new Map(activeRefs.map(ref => [ref.key, f.r.values.get(ref.key)]));
    const handoffReplay = await f.r.api.rebuildWorldManagerState();
    assert.equal(handoffReplay.ok, true, JSON.stringify(handoffReplay));
    assert.equal(handoffReplay.providerCalls, 0);
    for (const [key, bytes] of handoffBytes) assert.equal(f.r.values.get(key), bytes, `handoff replay leaves ${key} bytes unchanged`);
    const handoffRecall = await f.r.api.previewUnifiedMemoryRecall(query);
    assert.equal(handoffRecall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount, 1,
      'the keyless target resolves in the adopted session prefix');
    const handoffOutcome = activeRefs.find(ref => Number(ref.sessionEpoch) === -1
      && ref.turnRange?.start === 6 && ref.turnRange?.end === 10);
    assert.ok(handoffOutcome, 'the active handoff manifest identifies the inherited outcome');
    assert.equal(handoffOutcome.sourceDigest, parentSecond.sourceDigest,
      'the archive identity remains bound to the original completed source batch');
    const handoffPacket = await actualClassicPacket(f, query, activeManifest.scopeKey);
    assert.equal(deliveredClosureRows(handoffPacket).filter(row => row.memoryId === handoffOutcome.memoryId
      && row.memoryKey === handoffOutcome.key && row.revision === handoffOutcome.revision
      && row.sourceDigest === handoffOutcome.sourceDigest && row.sessionEpoch === -1
      && row.text === acceptedFactText).length, 1,
      'handoff delivers the exact archived lifecycle outcome in the sealed Classic request');
    const inheritedMicroQuery = sourceMicroT2.value.claims[0].evidence.exactQuote;
    const widerSettings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(widerSettings?.settings || widerSettings || {}),
      recallMaxMemories: 8 });
    const inheritedMicroRecall = await f.r.api.previewUnifiedMemoryRecall(inheritedMicroQuery);
    assert.ok((inheritedMicroRecall.memories || []).some(row => row.memory?.kind === 'micro'
      && (row.memory?.sourceSpans || []).some(span => span.exactQuote === inheritedMicroQuery)),
      'handoff target can recall the source-session Micro detail as inherited evidence');
    await f.r.api.saveLibraMemorySettings({ ...(widerSettings?.settings || widerSettings || {}),
      recallMaxMemories: 1 });

    // A handoff starts a new local turn coordinate. The old canonical target is
    // inherited at epoch -1 through turn 10; the actual next batch begins at
    // epoch 0, turn 1. Epoch order must therefore win over the larger old turn.
    const targetChat = f.current();
    const reopenedUser = '민아는 지호에게 은빛 열쇠 반환 약속을 다시 이어 달라고 했다.';
    const reopenedAssistant = '지호는 민아에게 은빛 열쇠 반환 약속을 다시 열었다.';
    const localBatch = Array.from({ length: 5 }, (_, index) => ({
      turn: index + 1,
      user: { text: index === 0 ? reopenedUser : `두 사람은 그 뒤 ${index + 1}번째 기록을 남겼다.` },
      assistant: { text: index === 0 ? reopenedAssistant : `다른 변화 없이 기록 ${index + 1}을 보관했다.` }
    }));
    sourceRows[0] = [reopenedUser, reopenedAssistant];
    targetChat.message.push(
      { role: 'user', chatId: 't1-u', data: reopenedUser },
      { role: 'assistant', chatId: 't1-a', data: reopenedAssistant }
    );
    for (let turn = 2; turn <= 5; turn += 1) {
      targetChat.message.push(
        { role: 'user', chatId: `t${turn}-u`, data: localBatch[turn - 1].user.text },
        { role: 'assistant', chatId: `t${turn}-a`, data: localBatch[turn - 1].assistant.text }
      );
    }
    targetChat.messages = targetChat.message;
    const reopenArtifact = threadArtifact({
      turn: 1, summary: '은빛 열쇠 반환 약속을 이번 회차에 다시 열었다.',
      status: 'open', link: 'reopen'
    });
    assert.equal(f.r.api.debugValidateUnifiedArtifact(reopenArtifact, localBatch).ok, true,
      JSON.stringify(f.r.api.debugValidateUnifiedArtifact(reopenArtifact, localBatch)));
    f.control.artifact = reopenArtifact;
    aliasStage = 'target_reopen';
    const localCommit = await f.run();
    assert.equal(localCommit.completed, 1, JSON.stringify({ localCommit,
      diagnostic: f.r.api.getRuntime()?.lastMemoryAnalysisDiagnostic }));
    assert.equal(canonicalCalls, 3, 'the next local batch uses one existing provider call');
    const localManifest = f.manifest(f.current());
    const localRef = localManifest.memories['1'];
    const localMemory = JSON.parse(f.r.values.get(localRef.key));
    const localThread = localMemory.canonicalArtifact.facts[0].values.thread;
    assert.equal(localThread.linkStatus, 'accepted');
    assert.equal(localThread.link, 'reopen');
    assert.equal(localThread.lifecycleId, sourceRefs[0] && parentFirst.canonicalArtifact.facts[0].values.thread.lifecycleId,
      'request-local target alias reopens the inherited exact lifecycle');
    const inheritedLatest = manifestRefs(localManifest).find(ref => Number(ref.sessionEpoch) === -1 && Number(ref.turnRange?.end) === 10);
    assert.ok(inheritedLatest, 'the transferred old outcome remains in the active inherited prefix');
    assert.equal(Number(inheritedLatest.sessionEpoch), -1);
    assert.equal(Number(inheritedLatest.turnRange.end), 10);
    assert.equal(Number(localRef.sessionEpoch), 0);
    assert.equal(Number(localRef.turnRange.start), 1);

    const oldEpochQuery = '은빛 열쇠를 민아에게 돌려준 약속의 이행';
    const oldEpochRecall = await f.r.api.previewUnifiedMemoryRecall(oldEpochQuery);
    assert.equal(oldEpochRecall.memories[0]?.memory?.memoryId, inheritedLatest.memoryId,
      'the old high-turn inherited fact is selected by its own anchor');
    assert.equal(oldEpochRecall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount, 1,
      'epoch-0 turn 1 is a forward successor of epoch -1 turn 10');
    const oldEpochPacket = await actualClassicPacket(f, oldEpochQuery, localManifest.scopeKey);
    assert.equal(deliveredClosureRows(oldEpochPacket).filter(row => row.memoryId === localRef.memoryId
      && row.revision === localRef.revision && row.text === reopenArtifact.facts[0].text).length, 1,
      'the sealed Classic request delivers the later-epoch reopen despite its smaller turn number');

    const newEpochQuery = '이번 회차에 다시 열린 은빛 열쇠 반환 약속';
    const newEpochRecall = await f.r.api.previewUnifiedMemoryRecall(newEpochQuery);
    assert.equal(newEpochRecall.memories[0]?.memory?.memoryId, localRef.memoryId,
      'the new local epoch fact can be selected directly');
    assert.equal(newEpochRecall?.diagnostics?.recallContinuityClosure?.diagnostics?.closureCount, 0,
      'the selected epoch-0 turn 1 never receives epoch -1 turn 10 as a backward successor');
    assert.ok((newEpochRecall?.diagnostics?.recallContinuityClosure?.diagnostics?.reasons || [])
      .some(reason => String(reason).startsWith('candidate_not_after_selection')),
      'the earlier high-turn fact is excluded by tuple order, not by a blanket closure refusal');

    // The predecessor's owner scope can disappear after handoff. Its immutable
    // Micro archive must remain sufficient for the target's historical Recall.
    for (const storageKey of [...f.r.values.keys()]) {
      if (storageKey.startsWith(`libra:v1:scope:${sourceManifest.scopeKey}:`))
        f.r.values.delete(storageKey);
    }
    const postHandoffSettings = await f.r.api.getLibraMemorySettings();
    await f.r.api.saveLibraMemorySettings({ ...(postHandoffSettings?.settings || postHandoffSettings || {}),
      recallMaxMemories: 8 });
    const afterSourceRemoval = await f.r.api.previewUnifiedMemoryRecall(inheritedMicroQuery);
    assert.ok((afterSourceRemoval.memories || []).some(row => row.memory?.kind === 'micro'
      && (row.memory?.sourceSpans || []).some(span => span.exactQuote === inheritedMicroQuery)),
      'inherited Micro Recall survives removal of the original owner scope');
    const originalArchiveBytes = f.r.values.get(inheritedMicroRef.archiveKey);
    const tamperedArchive = JSON.parse(originalArchiveBytes);
    const tamperedMicro = tamperedArchive.records.find(row =>
      row.value?.schema === 'libra.micro_memory.v1');
    tamperedMicro.value.excerpt.exactQuote += ' tampered';
    f.r.values.set(inheritedMicroRef.archiveKey, JSON.stringify(tamperedArchive));
    const afterArchiveTamper = await f.r.api.previewUnifiedMemoryRecall(inheritedMicroQuery);
    assert.equal((afterArchiveTamper.memories || []).some(row => row.memory?.kind === 'micro'
      && row.memory?.microArchiveKey === inheritedMicroRef.archiveKey), false,
      'a changed archive cannot inject inherited Micro evidence');
    assert.equal((await f.r.api.verifySessionHandoff({transferId: 'thread-lifecycle-keyless-handoff',
      targetChatId: 'thread-lifecycle-handoff-target'})).verified, false,
      'a corrupted Micro archive invalidates the entire handoff readback');
    f.r.values.set(inheritedMicroRef.archiveKey, originalArchiveBytes);
    assert.equal((await f.r.api.verifySessionHandoff({transferId: 'thread-lifecycle-keyless-handoff',
      targetChatId: 'thread-lifecycle-handoff-target'})).verified, true);
    assert.ok((await f.r.api.previewUnifiedMemoryRecall(inheritedMicroQuery)).memories.some(
      row => row.memory?.kind === 'micro'
        && row.memory?.microArchiveKey === inheritedMicroRef.archiveKey),
      'restoring the exact archive bytes restores inherited evidence');
    await require('./fixtures/libra_explicit_micro_retry.cjs').retryHistoricalMicro(
      f, [1,2,3,4,5], {});
    await waitFor(() => f.getRecords('libra.micro_memory_head.v1').filter(row =>
      row.value.scopeKey === localManifest.scopeKey).length === 5, 15000);
    const nextTransferId = 'thread-lifecycle-micro-second-handoff';
    const nextPrepared = await f.r.api.prepareSessionHandoff({transferId: nextTransferId});
    assert.equal(nextPrepared.microArchiveCount, 2,
      'the second package includes inherited and current-session Micro archives');
    f.empty('thread-lifecycle-micro-second-target');
    const nextAdopted = await f.r.api.adoptSessionHandoff({transferId: nextTransferId,
      targetChatId: 'thread-lifecycle-micro-second-target'});
    assert.equal(nextAdopted.verified, true);
    const grandchildManifest = f.manifest(f.current());
    assert.deepEqual(grandchildManifest.inheritedMicroArchives.map(ref => ref.sessionEpoch),
      [-2, -1], 'each handoff retains the predecessor epoch order');
    const secondHandoffRecall = await f.r.api.previewUnifiedMemoryRecall(inheritedMicroQuery);
    assert.ok((secondHandoffRecall.memories || []).some(row => row.memory?.kind === 'micro'
      && row.memory?.sessionEpoch === -2
      && (row.memory?.sourceSpans || []).some(span => span.exactQuote === inheritedMicroQuery)),
      'a second handoff retains the first session’s precise Micro evidence');

    console.log(JSON.stringify({
      test: 'libra_main_memory_thread_lifecycle_transfer', providerCalls: f.control.calls.length,
      canonicalCalls,
      activeWorldline: 'main', activeThroughSessionEpoch: adoptedHead?.throughSessionEpoch,
      activeNarrativeThroughTurn: adoptedHead?.domainStatus?.narrative?.throughTurn,
      nativeClosureCount: branchRecall.diagnostics.recallContinuityClosure.diagnostics.closureCount,
      handoffClosureCount: handoffRecall.diagnostics.recallContinuityClosure.diagnostics.closureCount,
      nativeAndHandoffReplayProviderCalls: 0, canonicalBytesUnchanged: true,
      sourceMemoryIds: sourceRefs.map(ref => ref.memoryId), adoptedMemoryIds: activeRefs.map(ref => ref.memoryId),
      epochOrder: { oldInherited: [inheritedLatest.sessionEpoch, inheritedLatest.turnRange.start, inheritedLatest.turnRange.end],
        newLocal: [localRef.sessionEpoch, localRef.turnRange.start, localRef.turnRange.end], forwardClosure: 1, backwardClosure: 0 }
    }));
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
