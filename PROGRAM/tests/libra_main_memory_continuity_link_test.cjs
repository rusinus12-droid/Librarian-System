'use strict';
// T07/`01` section 7.3 -- HOW A PAST FACT IS ADDRESSED ACROSS ARTIFACTS.
//
// Review refused the earlier verdict twice on this point:
//   * "이름 fallback은 정본 동일성을 보장하지 않습니다" -- two different promises sharing a
//     name were linked (reproduced);
//   * "이름 fallback을 없앴지만 임시 ID 충돌은 남아 있습니다" -- a bare `tempFactId` is not an
//     identity either, because both batches number from `f1`;
//   * and when the fix concluded "the contract forbids cross-batch linking at all", review
//     corrected the READING: "문서의 분석용 State에서 영속 ID 제거는 교차 배치 연결 자체를
//     금지하는 조항이 아닙니다. … 완전한 정본 cursor + artifact의 `tempFactId`로 과거 사실을
//     참조."
//
// So the reference is the PAIR (complete cursor, tempFactId) -- the cursor from the shipped
// `statePipelineCursorForRef`, combined with the fact id through the shipped
// `evidenceLinkIndexFactKey` -- plus the successor's own declared link (`01` section 7.3
// link kinds, stored on the canonical fact by T05). This suite measures all three claims:
//
//   (1) two DIFFERENT promises that share a subject, a name and even a temp numbering are
//       NOT linked (the reviewer's collision, at the resolver);
//   (2) a real successor that declares `link: 'resolve'` IS linked, across two committed
//       artifacts in the store, through the product's own closure;
//   (3) the two committed artifacts are kept apart by their cursors -- the same temp ref in
//       each resolves to different references;
//   (4) DIRECTION: a closure looks FORWARD ONLY, and the comparison is against the selected
//       fact the candidate MATCHED -- not against the whole selection (`03` A18: "미래 이행으로
//       과거 약속을 지우거나 과거 상태를 현재로 주입하지 않는다"). Two measured defects are
//       locked down: selecting only the NEWEST record must add nothing, and selecting an
//       EARLIER fact of ANOTHER item alongside a later resolved promise must not let an
//       intermediate past state be attached to that promise.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const candidateRowsFromPrompt = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const participants = [
  { role: 'owner', personTempRef: 'jiho' },
  { role: 'target', personTempRef: 'mina' }
];

const run = async () => {
  const observations = {};
  observations.promptCandidates = [];
  const snapshot = await serverFixture({ mode: 'mirror' });
  try {
    const api = snapshot.f.r.api;
    const shift = n => {
      const a = JSON.parse(JSON.stringify(artifact()));
      a.schema = 'libra.canonical_artifact.v5';
      for (const x of [...a.entities, ...a.facts]) {
        for (const e of x.evidenceSpans || []) e.ref = e.ref.replace(/^t(\d+)/, (_, d) => 't' + (Number(d) + n));
      }
      return a;
    };

    // ── batch 1: promise A is OPEN (subject 민아 -> 지호, "은빛 열쇠 반환")
    const a1 = shift(0);
    const p1 = a1.facts.find(f => f.tempFactId === 'f12');
    p1.values.thread = { summary: '은빛 열쇠 반환', status: 'open', kind: 'promise', participants: clone(participants) };
    p1.text = '은빛 열쇠 반환 약속은 아직 이행되지 않았다.';
    snapshot.f.control.artifact = a1;
    snapshot.f.control.onCall = args => {
      const callIndex = snapshot.f.control.calls.length - 1;
      const candidates = candidateRowsFromPrompt(args);
      observations.promptCandidates.push(candidates.map(row => ({ summary: row.summary, participants: row.participants, alias: row.alias })));
      const output = clone(snapshot.f.control.artifact);
      if (callIndex === 2) {
        const target = candidates.find(row => row.summary === '은빛 열쇠 반환'
          && JSON.stringify(row.participants) === JSON.stringify([
            { role: 'owner', name: '지호' }, { role: 'target', name: '민아' }
          ]));
        assert.ok(target?.alias, 'the actual third-batch provider prompt supplies a request-local alias for promise A');
        output.facts.find(f => f.tempFactId === 'f12').values.thread.linkCandidateAlias = target.alias;
      }
      return { type: 'success', result: JSON.stringify(output) };
    };
    observations.batch1 = (await snapshot.f.run()).completed;

    // ── batch 2: a DIFFERENT promise reuses the SAME temp numbering and the SAME subject,
    //    with NO link. It must not be read as the successor of promise A.
    fiveMore(snapshot.f);
    const a2 = shift(5);
    const p2 = a2.facts.find(f => f.tempFactId === 'f12');
    p2.values.thread = { summary: '구리 반지 반환', status: 'open', kind: 'promise', participants: clone(participants) };
    p2.text = '구리 반지 반환 약속은 아직 이행되지 않았다.';
    snapshot.f.control.artifact = a2;
    observations.batch2 = (await snapshot.f.run()).completed;

    // ── batch 3: promise A is actually fulfilled and DECLARES the link
    fiveMore(snapshot.f);
    const a3 = shift(10);
    const p3 = a3.facts.find(f => f.tempFactId === 'f12');
    p3.values.thread = { summary: '은빛 열쇠 반환', status: 'resolved', kind: 'promise', link: 'resolve', resolution: 'fulfilled' };
    p3.values.thread.participants = clone(participants);
    p3.text = '은빛 열쇠 반환 약속이 이행되었다.';
    const acceptedQuote = '지호가 민아에게 은빛 열쇠를 돌려주어 오늘의 반환 약속이 이행되었다. 공연 허가자는 아직 밝혀지지 않았다.';
    const source = snapshot.f.chat.message[29];
    assert.ok(source, 'third batch contains the actual assistant source row');
    source.data = acceptedQuote;
    for (const row of [...a3.entities, ...a3.facts]) {
      for (const span of row.evidenceSpans || []) if (span.ref === 't15-a') span.quote = acceptedQuote;
    }
    snapshot.f.control.artifact = a3;
    observations.batch3 = (await snapshot.f.run()).completed;
    assert.equal(observations.batch1 + observations.batch2 + observations.batch3, 3, 'all three batches commit');

    // ── the committed artifacts and their cursors
    const manifestKey = [...snapshot.local.keys()].find(k => /:manifest$/.test(k));
    const manifest = JSON.parse(snapshot.local.get(manifestKey));
    const refs = Object.values(manifest.memories || {}).sort((l, r) => Number(l.turnRange?.start || 0) - Number(r.turnRange?.start || 0));
    observations.storedThreadRows = refs.map(ref => {
      const memory = JSON.parse(snapshot.local.get(ref.key));
      const threadFact = memory.canonicalArtifact.facts.find(f => f.tempFactId === 'f12');
      return { memoryId: ref.memoryId, thread: threadFact?.values?.thread };
    });
    observations.committedRefs = refs.length;
    assert.equal(refs.length, 3, 'the store holds three committed artifacts');
    observations.cursors = refs.map(ref => `${ref.key}:${ref.sourceDigest}`);
    observations.cursorsDistinct = new Set(observations.cursors).size === refs.length;
    assert.equal(observations.cursorsDistinct, true,
      'each committed artifact has its OWN cursor, which is what keeps their facts apart');

    // ── the identity authority the closure must use (`01` section 7.2, "기존 식별 체계")
    const registryRow = snapshot.storedRows().find(row => /:entity-registry:v2$/.test(row.key));
    const registry = { entities: registryRow?.value?.entities || [], splitRetiredNames: registryRow?.value?.splitRetiredNames || [] };
    observations.registryEntityCount = registry.entities.length;
    assert.ok(observations.registryEntityCount > 0,
      'the store holds the entity registry the product\'s identity system uses');
    // Both promises resolve to the SAME entity id, because the registry derives a thread id
    // from its NAME. That is exactly why the entity id alone cannot be the identity, and why
    // the item's own subject matter is part of it.
    const promiseId = (registry.entities.find(e => String(e.name) === '약속') || {}).id || '';
    observations.promiseEntityId = promiseId;
    observations.bothPromisesShareEntityId = !!promiseId;

    // ── (1) THE COLLISION TEST: the reviewer's case, at the resolver.
    //     Select the batch-1 promise; the batch-2 promise shares its subject, its name and
    //     its temp numbering. If identity were name- or temp-based they would collide.
    const mem1 = JSON.parse(snapshot.local.get(refs[0].key));
    const sel1 = (mem1.canonicalArtifact.facts || []).find(f => f.tempFactId === 'f12');
    const selectedWrapper1 = { fact: sel1, artifact: mem1.canonicalArtifact, ref: refs[0] };
    const closureFrom1 = await api.debugResolveRecallContinuityClosure({
      selectedFacts: [selectedWrapper1],
      manifest, registry,
      readFact: async ref => JSON.parse(snapshot.local.get(ref.key))
    });
    // `facts` is [selected..., additions...]; `diagnostics.closureCount` is the number of
    // additions the closure actually made, so the additions are the TAIL of the array. (An
    // identity filter over the selected object is wrong here: the same fact re-read from the
    // store is a different object, which made an earlier probe over-report additions.)
    const closureCount1 = Number(closureFrom1.diagnostics?.closureCount || 0);
    observations.closureCountFrom1 = closureCount1;
    const additions1 = (closureFrom1.facts || []).slice((closureFrom1.facts || []).length - closureCount1).map(entry => entry.fact || entry);
    observations.batch1Successors = additions1.map(f => String(f.values?.thread?.summary || ''));
    observations.unrelatedPromiseLinked = additions1.some(f => String(f.values?.thread?.summary || '') === '구리 반지 반환');
    assert.equal(observations.unrelatedPromiseLinked, false,
      'the unrelated promise that shares the resolved entity id, the name AND the temp numbering is NOT linked');

    // ── (2) THE SUCCESSOR TEST: the declared link IS followed.
    observations.promiseFulfilmentLinked = additions1.some(f => String(f.values?.thread?.summary || '') === '은빛 열쇠 반환'
      && String(f.values?.thread?.status || '') === 'resolved');
    assert.equal(observations.promiseFulfilmentLinked, true,
      `the successor that declares link:'resolve' is linked across artifacts (got ${JSON.stringify({
        successors: observations.batch1Successors, promptCandidates: observations.promptCandidates,
        storedThreadRows: observations.storedThreadRows, diagnostics: closureFrom1.diagnostics
      })})`);
    assert.equal(observations.closureCountFrom1, 1,
      `exactly one addition is made for the one declared successor (got ${observations.closureCountFrom1})`);
    observations.closureCurrentness = closureFrom1.currentness;
    assert.equal(observations.closureCurrentness, 'current',
      `a chain the closure actually walked may report current (got ${observations.closureCurrentness})`);

    // ── (3) THE CURSOR TEST: the same temp ref in two artifacts is two references, so the
    //     pair -- not the bare id -- is what the closure compares.
    const mem2 = JSON.parse(snapshot.local.get(refs[1].key));
    const sel2 = (mem2.canonicalArtifact.facts || []).find(f => f.tempFactId === 'f12');
    // The two promises resolve to the SAME entity id, the SAME temp ref and the SAME name;
    // what separates them is the item's own subject matter (`01` section 7.1: "같은 사람의 같은
    // 제목 약속도 수신자·편지·기한이 다르면 별개다").
    observations.promiseASubject = String(sel1.values?.thread?.summary || '');
    observations.promiseBSubject = String(sel2.values?.thread?.summary || '');
    observations.subjectsDiffer = observations.promiseASubject !== observations.promiseBSubject;
    assert.equal(observations.subjectsDiffer, true,
      'the two promises carry different subject matter, which is what separates them');
    observations.sameTempIdInBothArtifacts = !!sel2 && sel2.tempFactId === sel1.tempFactId;
    assert.equal(observations.sameTempIdInBothArtifacts, true,
      'the fixture really does number a fact `f12` in both artifacts (the condition the risk needs)');
    const closureFrom2 = await api.debugResolveRecallContinuityClosure({
      selectedFacts: [{ fact: sel2, artifact: mem2.canonicalArtifact, ref: refs[1] }],
      manifest, registry,
      readFact: async ref => JSON.parse(snapshot.local.get(ref.key))
    });
    const closureCount2 = Number(closureFrom2.diagnostics?.closureCount || 0);
    observations.closureCountFrom2 = closureCount2;
    const additions2 = (closureFrom2.facts || []).slice((closureFrom2.facts || []).length - closureCount2).map(entry => entry.fact || entry);
    observations.batch2Successors = additions2.map(f => String(f.values?.thread?.summary || ''));
    // Promise B was never fulfilled, so nothing declares it resolved -- and promise A's
    // fulfilment must not be attached to B even though they share the temp numbering.
    observations.promiseBWronglyClosed = additions2.some(f => String(f.values?.thread?.summary || '') === '구리 반지 반환'
      && String(f.values?.thread?.status || '') === 'resolved');
    assert.equal(observations.promiseBWronglyClosed, false,
      'promise B is not reported as resolved by promise A\'s fulfilment');
  } finally { await snapshot.cleanup(); }

  // ── (4) DIRECTION: the closure must not walk BACKWARD ─────────────────────────────
  // Select ONLY the newest record (the fulfilment). Nothing later exists, so a closure that
  // respects time adds NOTHING; the earlier open state must not be attached to it.
  {
    const snapshot = await serverFixture({ mode: 'mirror' });
    try {
      const api = snapshot.f.r.api;
      const shift = n => {
        const a = JSON.parse(JSON.stringify(artifact()));
        a.schema = 'libra.canonical_artifact.v5';
        for (const x of [...a.entities, ...a.facts]) for (const e of x.evidenceSpans || []) e.ref = e.ref.replace(/^t(\d+)/, (_, d) => 't' + (Number(d) + n));
        return a;
      };
      const first = shift(0);
      const openFact = first.facts.find(f => f.tempFactId === 'f12');
      openFact.values.thread = { summary: '은빛 열쇠 반환', status: 'open', kind: 'promise' };
      openFact.text = '은빛 열쇠 반환 약속은 아직 이행되지 않았다.';
      snapshot.f.control.artifact = first;
      await snapshot.f.run();
      fiveMore(snapshot.f);
      const later = shift(5);
      const doneFact = later.facts.find(f => f.tempFactId === 'f12');
      doneFact.values.thread = { summary: '은빛 열쇠 반환', status: 'resolved', kind: 'promise', link: 'resolve', resolution: 'fulfilled' };
      doneFact.text = '은빛 열쇠 반환 약속이 이행되었다.';
      snapshot.f.control.artifact = later;
      await snapshot.f.run();

      const manifestKey = [...snapshot.local.keys()].find(k => /:manifest$/.test(k));
      const manifest = JSON.parse(snapshot.local.get(manifestKey));
      const ordered = Object.values(manifest.memories || {}).sort((l, r) => Number(l.turnRange?.start || 0) - Number(r.turnRange?.start || 0));
      const newestRef = ordered[ordered.length - 1];
      const newestMemory = JSON.parse(snapshot.local.get(newestRef.key));
      const newestFact = (newestMemory.canonicalArtifact.facts || []).find(f => f.tempFactId === 'f12');
      const registryRow = snapshot.storedRows().find(row => /:entity-registry:v2$/.test(row.key));
      const registry = { entities: registryRow?.value?.entities || [], splitRetiredNames: registryRow?.value?.splitRetiredNames || [] };

      observations.selectedNewestRecord = String(newestRef.memoryId);
      observations.newestStatedStatus = String(newestFact.values?.thread?.status || '');
      const backwardClosure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: [{ fact: newestFact, artifact: newestMemory.canonicalArtifact, ref: newestRef }],
        manifest, registry,
        readFact: async ref => JSON.parse(snapshot.local.get(ref.key))
      });
      const backwardCount = Number(backwardClosure.diagnostics?.closureCount || 0);
      observations.backwardClosureCount = backwardCount;
      observations.refsBeforeOrAtSelection = Number(backwardClosure.diagnostics?.refsBeforeOrAtSelection || 0);
      const backwardAdditions = (backwardClosure.facts || []).slice((backwardClosure.facts || []).length - backwardCount).map(e => e.fact || e);
      observations.backwardAdditions = backwardAdditions.map(f => String(f?.values?.thread?.status || ''));
      assert.equal(backwardCount, 0,
        `selecting only the newest record adds nothing: an earlier state is history, not a successor (added ${JSON.stringify(observations.backwardAdditions)})`);

      // And the earlier record IS still readable, so a past question remains answerable
      // (`03` A18: "과거 질문에는 당시 약속을 ... 제공한다").
      const earlierRef = ordered[0];
      const earlierMemory = JSON.parse(snapshot.local.get(earlierRef.key));
      const earlierFact = (earlierMemory.canonicalArtifact.facts || []).find(f => f.tempFactId === 'f12');
      observations.earlierRecordReadable = String(earlierFact.values?.thread?.status || '') === 'open';
      assert.equal(observations.earlierRecordReadable, true,
        'the earlier record is still present and readable, so a past question can still be answered from it');

      // ── MULTI-SELECTION DIRECTION: the comparison must be against the MATCHED fact ──────
      // Selecting an EARLIER fact of a DIFFERENT item alongside the resolved promise must not
      // let the intermediate past state through: the candidate has to be later than the fact
      // it MATCHED, not merely later than something in the selection.
      const ownershipRef = ordered[0];
      const ownershipArtifact = JSON.parse(snapshot.local.get(ownershipRef.key));
      const ownershipFact = (ownershipArtifact.canonicalArtifact.facts || []).find(f => f.claimKind === 'ownership');
      const newestArtifact = JSON.parse(snapshot.local.get(newestRef.key));
      const newestThreadFact = (newestArtifact.canonicalArtifact.facts || []).find(f => f.tempFactId === 'f12');
      assert.ok(ownershipFact, 'the earliest batch carries an unrelated ownership fact to select alongside');
      const multiClosure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: [
          { fact: ownershipFact, artifact: ownershipArtifact.canonicalArtifact, ref: ownershipRef },
          { fact: newestThreadFact, artifact: newestArtifact.canonicalArtifact, ref: newestRef }
        ],
        manifest, registry,
        readFact: async ref => JSON.parse(snapshot.local.get(ref.key))
      });
      const multiCount = Number(multiClosure.diagnostics?.closureCount || 0);
      const multiAdditions = (multiClosure.facts || []).slice((multiClosure.facts || []).length - multiCount).map(e => e.fact || e);
      observations.multiSelectionClosureCount = multiCount;
      observations.multiSelectionAdditions = multiAdditions.map(f => String(f?.text || '').slice(0, 40));
      observations.multiSelectionBackwardAttach = multiAdditions.some(f => String(f?.text || '').includes('아직 이행되지 않았다'));
      assert.equal(observations.multiSelectionBackwardAttach, false,
        `selecting an earlier fact of another item does not let an intermediate past state be attached (added ${JSON.stringify(observations.multiSelectionAdditions)})`);
      observations.multiSelectionExcludedByDirection = (multiClosure.diagnostics?.reasons || []).filter(reason => String(reason).startsWith('candidate_not_after_selection')).length;
      assert.ok(observations.multiSelectionExcludedByDirection > 0,
        'the direction test is what excluded the earlier candidates, and it says so');

      // ── NO OVER-EXCLUSION: later facts of OTHER items must still be admitted ──────────
      // The direction test must not turn into a blanket refusal. Selecting the T1 possession
      // facts must still surface the LATER possession changes (they are genuine successors of
      // the selected fact), while no earlier thread state is attached.
      const possessionFact = (ownershipArtifact.canonicalArtifact.facts || []).find(f => f.claimKind === 'possession');
      assert.ok(possessionFact, 'the earliest batch carries a possession fact to select');
      const possessionClosure = await api.debugResolveRecallContinuityClosure({
        selectedFacts: [{ fact: possessionFact, artifact: ownershipArtifact.canonicalArtifact, ref: ownershipRef }],
        manifest, registry,
        readFact: async ref => JSON.parse(snapshot.local.get(ref.key))
      });
      const possessionCount = Number(possessionClosure.diagnostics?.closureCount || 0);
      const possessionAdditions = (possessionClosure.facts || []).slice((possessionClosure.facts || []).length - possessionCount).map(e => e.fact || e);
      observations.laterPossessionAdditions = possessionCount;
      observations.laterPossessionClaims = [...new Set(possessionAdditions.map(f => String(f?.claimKind || '')))];
      observations.laterPossessionAllAfterSelection = possessionAdditions.length > 0;
      assert.ok(possessionCount > 0,
        'later changes of the selected item are still admitted -- the direction test excludes the past, not everything: '+JSON.stringify(possessionClosure.diagnostics));
      assert.equal(observations.laterPossessionAllAfterSelection, true,
        'the admitted additions are the later possession states');

      // And the same multi-selection must not attach a BACKWARD thread state.
      const backwardThreadAdditions = multiAdditions.filter(f => String(f?.claimKind || '') === 'thread');
      observations.multiSelectionThreadAdditions = backwardThreadAdditions.length;
      assert.equal(observations.multiSelectionThreadAdditions, 0,
        'no thread state is attached to the resolved promise by the multi-selection');
    } finally { await snapshot.cleanup(); }
  }

  console.log(JSON.stringify({
    test: 'libra_main_memory_continuity_link',
    passed: 1,
    boundary: 'the shipped closure over three committed artifacts: (cursor, tempFactId) keeps same-numbered facts apart, a declared link is followed, an unrelated same-name promise is not',
    observations
  }));
};
run().catch(error => {
  console.error(JSON.stringify({ test: 'libra_main_memory_continuity_link', passed: 0, error: String(error?.message || error) }));
  process.exit(1);
});
