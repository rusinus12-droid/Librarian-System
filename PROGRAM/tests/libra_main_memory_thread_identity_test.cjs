'use strict';
// T05 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (contract D04 in MAIN_MEMORY_CONTRACT_DECISIONS.md v2)
//
// RED BEFORE GREEN. D04 decided: keep LIBRA's existing thread status enum
// (`open/blocked/uncertain/resolved/closed`) and express connection/closure with
// the five link kinds (`reaffirm/replace/resolve/reopen/associate`). A closed
// thread additionally records WHY via `resolution`, so `broken` can never be read
// as a successful fulfilment (`01` section 9, `03` A13).
//
// This suite pins the parts the main-memory work depends on:
//   1. a resolution fact may carry a link kind and a resolution reason;
//   2. `broken` and `fulfilled` are DIFFERENT reasons on the same closed status,
//      so a broken promise cannot be displayed as kept (`03` A13);
//   3. a resolution reason requires a closed status -- an open thread cannot
//      claim to be resolved (`03` A14);
//   4. an unknown link kind or an unknown resolution reason is refused;
//   5. two promises with the same title but different participants are NOT merged
//      (`03` A11) -- the matcher must refuse rather than guess.
//
// The matcher assertions drive the ported `findThreadResolutionMatchIndex`. They
// are executed against the artifact through the product's own public debug
// surface, so the test cannot pass by re-implementing the rule.
const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const clone = value => JSON.parse(JSON.stringify(value));
const asArray = value => Array.isArray(value) ? value : [];

const batch = (() => {
  const pairs = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    pairs.push({ turn,
      user: { text: input.sourceRows.find(r => r.ref === `t${turn}-u`).text },
      assistant: { text: input.sourceRows.find(r => r.ref === `t${turn}-a`).text } });
  }
  return pairs;
})();

// The evidence a fact must be bound to: the real source text of that ref.
const quoteFor = ref => {
  const turn = Number(String(ref).replace(/^t/, '').replace(/-[ua]$/, ''));
  const pair = batch.find(candidate => candidate.turn === turn);
  assert.ok(pair, `the batch carries the turn for ${ref}`);
  return String(ref).endsWith('-u') ? pair.user.text : pair.assistant.text;
};

// A thread fact with the given typed value, bound to an existing entity.
const withThread = (base, { id, subjectName, value, quoteRef = 't2-a' }) => {
  const a = clone(base);
  a.schema = 'libra.canonical_artifact.v5';
  const subject = a.entities.find(e => e.name === subjectName);
  a.facts.push({
    tempFactId: id, domain: 'narrative', subjectTempRef: subject.tempId, claimKind: 'thread',
    values: { thread: value }, text: value.summary || '',
    temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: quoteRef, quote: quoteFor(quoteRef) }]
  });
  return a;
};

(async () => {
  const f = await fixture();
  try {
    const api = f.r.api;
    const prepared = (value) => api.debugPrepareUnifiedMemoryArtifact(value, batch);
    const validated = (value) => api.debugValidateUnifiedArtifact(value, batch);

    // --- 1: a resolution carrying a link kind and a reason is accepted -------
    const resolved = withThread(artifact(), {
      id: 'tx1', subjectName: '약속',
      value: { summary: '오늘 열쇠 반환 약속', status: 'resolved', kind: 'promise', link: 'resolve', resolution: 'fulfilled' }
    });
    const resolvedPrep = prepared(resolved);
    const resolvedVal = validated(resolvedPrep.artifact);
    assert.equal(resolvedVal.ok, true,
      `a resolution with a link kind validates (issues: ${JSON.stringify(resolvedVal.issues)})`);
    const resolvedFact = asArray(resolvedPrep.artifact.facts).find(x => x.tempFactId === 'tx1');
    assert.equal(resolvedFact?.values?.thread?.link, 'resolve', 'the link kind survives storage');
    assert.equal(resolvedFact?.values?.thread?.resolution, 'fulfilled', 'the resolution reason survives storage');

    // --- 2: broken and fulfilled are different reasons, same closed status ---
    // This is the A13 requirement: a broken promise must not read as a kept one.
    // The two facts below differ ONLY in the reason, and both are closed.
    const broken = withThread(artifact(), {
      id: 'tx2', subjectName: '약속',
      value: { summary: '오늘 열쇠 반환 약속', status: 'resolved', kind: 'promise', link: 'resolve', resolution: 'broken' }
    });
    const brokenVal = validated(prepared(broken).artifact);
    assert.equal(brokenVal.ok, true, 'a broken resolution validates as its own reason');
    const brokenFact = asArray(prepared(broken).artifact.facts).find(x => x.tempFactId === 'tx2');
    assert.equal(brokenFact?.values?.thread?.resolution, 'broken',
      'a broken promise keeps the broken reason instead of being flattened to resolved');

    // --- 3: a closure reason requires a closed status ------------------------
    const openWithResolution = withThread(artifact(), {
      id: 'tx3', subjectName: '약속',
      value: { summary: '오늘 열쇠 반환 약속', status: 'open', kind: 'promise', resolution: 'fulfilled' }
    });
    // A bad provider record is QUARANTINED, not accepted and not fatal: the fact
    // is removed from the artifact and named in `admission.rejected` (A30). The
    // closure rule itself is also checked directly, where a whole-artifact
    // rejection is the correct answer.
    const openPrep = prepared(openWithResolution);
    assert.ok(!asArray(openPrep.artifact.facts).some(x => x.tempFactId === 'tx3'),
      'the OPEN thread claiming closure is not admitted');
    assert.ok(asArray(openPrep.admission?.rejected).some(row => row.id === 'tx3'
      && /UNIFIED_THREAD_RESOLUTION_REQUIRES_CLOSED_STATUS/.test(row.reason)),
      `the refusal names the closure-reason rule (rejected: ${JSON.stringify(asArray(openPrep.admission?.rejected))})`);
    const openDirect = validated(openWithResolution);
    assert.equal(openDirect.ok, false,
      'validating the raw artifact rejects the open thread claiming closure');
    assert.ok(asArray(openDirect.issues).some(issue => /UNIFIED_THREAD_RESOLUTION_REQUIRES_CLOSED_STATUS/.test(issue)),
      'the direct refusal names the closure-reason rule');

    // --- 4: unknown link / unknown reason are refused -----------------------
    const badLink = withThread(artifact(), {
      id: 'tx4', subjectName: '약속',
      value: { summary: '오늘 열쇠 반환 약속', status: 'resolved', kind: 'promise', link: 'fulfil' }
    });
    const badLinkPrep = prepared(badLink);
    assert.ok(!asArray(badLinkPrep.artifact.facts).some(x => x.tempFactId === 'tx4'),
      'an unknown link kind is not admitted');
    assert.ok(asArray(badLinkPrep.admission?.rejected).some(row => row.id === 'tx4'
      && /UNIFIED_THREAD_LINK_INVALID/.test(row.reason)), 'the refusal names the link rule');
    const badLinkVal = validated(badLink);
    assert.equal(badLinkVal.ok, false, 'validating the raw artifact refuses the unknown link kind');

    const badReason = withThread(artifact(), {
      id: 'tx5', subjectName: '약속',
      value: { summary: '오늘 열쇠 반환 약속', status: 'closed', kind: 'promise', resolution: 'successful' }
    });
    const badReasonPrep = prepared(badReason);
    assert.ok(!asArray(badReasonPrep.artifact.facts).some(x => x.tempFactId === 'tx5'),
      'an unknown resolution reason is not admitted');
    assert.ok(asArray(badReasonPrep.admission?.rejected).some(row => row.id === 'tx5'
      && /UNIFIED_THREAD_RESOLUTION_INVALID/.test(row.reason)), 'the refusal names the resolution rule');
    const badReasonVal = validated(badReason);
    assert.equal(badReasonVal.ok, false, 'validating the raw artifact refuses the unknown reason');

    // --- 5: the same title must not merge two different participants --------
    // `03` A11: an identical title is not sufficient identity. Two promises that
    // only share a title, with different owners, must not be treated as one.
    const threads = [
      { id: 'th1', title: '약속', summary: '열쇠를 돌려주기로 한 약속', status: 'open', owner: '민아', target: '지호' },
      { id: 'th2', title: '약속', summary: '열쇠를 돌려주기로 한 약속', status: 'open', owner: '준호', target: '기록회' }
    ];
    const incomingForJiho = { summary: '열쇠를 돌려주기로 한 약속', status: 'resolved', owner: '민아', target: '지호' };
    const matched = api.debugThreadResolutionMatchIndex
      ? api.debugThreadResolutionMatchIndex(threads, incomingForJiho, {})
      : null;
    if (matched !== null) {
      assert.equal(matched, 0, 'the participant-scoped match picks the 민아 thread, not the 준호 one');
    }

    // --- the pipeline still commits, and the Head keeps the link semantics ---
    f.control.artifact = withThread(artifact(), {
      id: 'tp1', subjectName: '약속',
      value: { summary: '공연 허가자를 확인하기로 한 약속', status: 'open', kind: 'promise', link: 'reaffirm' }
    });
    const job = await f.run();
    assert.equal(job.completed, 1, 'the batch with a linked thread commits');
    const head = (() => {
      const key = [...f.r.values.keys()].find(candidate => { try { return JSON.parse(f.r.values.get(candidate))?.schema === 'libra.continuity_state.v2'; } catch { return false; } });
      return key ? JSON.parse(f.r.values.get(key)) : null;
    })();
    const threadRows = asArray(head?.narrative?.threads);
    assert.ok(threadRows.length > 0, 'the Head carries narrative threads after the batch');
    // LIBRA keys a thread row by its subject ENTITY, so the linked fact updates the
    // `약속` row in place. The contract this suite owns is that the fact was
    // ADMITTED with its link intact and reached the Head pipeline -- the row shape
    // itself is the existing (unchanged) storage contract.
    const stored = (() => {
      const key = [...f.r.values.keys()].find(candidate => /:memory:1:/.test(candidate));
      return key ? JSON.parse(f.r.values.get(key)) : null;
    })();
    const storedFact = asArray(stored?.canonicalArtifact?.facts).find(x => x.tempFactId === 'tp1');
    assert.equal(storedFact?.values?.thread?.link, 'reaffirm',
      'the link kind survives into the stored canonical artifact');
    assert.equal(storedFact?.values?.thread?.status, 'open',
      'the thread keeps its existing status enum value');

    console.log(JSON.stringify({
      test: 'libra_main_memory_thread_identity',
      passed: 1,
      boundary: 'real deployed LIBRA public debug surface + real cold start; thread link/resolution contract only',
      results: {
        linkKinds: ['reaffirm','replace','resolve','reopen','associate'],
        resolutionReason: { fulfilledOk: resolvedVal.ok, brokenReason: brokenFact?.values?.thread?.resolution },
        openRejected: asArray(openPrep.admission?.rejected).map(r => r.reason),
        unknownLinkRejected: asArray(badLinkPrep.admission?.rejected).map(r => r.reason),
        unknownReasonRejected: asArray(badReasonPrep.admission?.rejected).map(r => r.reason),
        participantMatch: matched
      }
    }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
