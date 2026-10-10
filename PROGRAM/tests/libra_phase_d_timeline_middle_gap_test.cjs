'use strict';

// D4 regression: unreadable middle canonical refs break semantic continuity.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const parse = value => { try { return JSON.parse(value); } catch (_) { return null; } };
const PREF = { content: '민트차를 좋아한다', topic: '민트차', kind: 'preference' };
const PREF_QUOTE = '민아는 민트차를 좋아한다고 말했다. 민아는 오늘 민트차를 함께 마시자고 약속했다.';
const appendFivePairs = (f, startTurn) => {
  const source = f.chat.message.filter(row => /^t[1-5]-(u|a)$/.test(row.chatId)).slice(0, 10);
  for (let index = 0; index < 10; index += 1) {
    const row = source[index];
    f.chat.message.push({ ...row, chatId: `t${startTurn + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}` });
  }
  f.chat.messages = f.chat.message;
};

const makeArtifact = (startTurn, action) => {
  const value = clone(artifact());
  value.schema = 'libra.canonical_artifact.v5';
  const offset = startTurn - 1;
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
  }
  value.facts = value.facts.filter(row => row.claimKind !== 'thread');
  value.facts.push({
    tempFactId: `d4_middle_gap_preference_${startTurn}`, domain: 'character', subjectTempRef: 'mina',
    claimKind: 'character_preference', values: { preferences: [clone(PREF)] },
    effect: action === 'remove' ? 'remove' : 'set', text: PREF.content,
    temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: `t${startTurn + 3}-a`, quote: PREF_QUOTE }]
  });
  if (action !== 'remove') value.facts.push({
    tempFactId: `d4_middle_gap_thread_${startTurn}`, domain: 'narrative', subjectTempRef: 'promise', claimKind: 'thread',
    values: { thread: { summary: '오늘 민트차를 함께 마시자는 약속', status: 'open', kind: 'promise',
      ...(action === 'reaffirm' ? { link: 'reaffirm', linkCandidateAlias: '' } : {}),
      participants: [{ role: 'owner', personTempRef: 'mina' }, { role: 'target', personTempRef: 'jiho' }] } },
    text: '민아는 오늘 민트차를 함께 마시자고 약속했다.', temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: `t${startTurn + 3}-a`, quote: PREF_QUOTE }]
  });
  return value;
};

(async () => {
  const snapshot = await serverFixture({ mode: 'plugin_only' });
  try {
    const f = snapshot.f;
    let linkSuffixThread = false;
    f.control.onCall = args => {
      const candidateArtifact = clone(f.control.artifact);
      if (linkSuffixThread) {
        const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
        const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
        const candidates = match ? JSON.parse(match[1]) : [];
        const target = candidates.find(row => row.summary === '오늘 민트차를 함께 마시자는 약속'
          && JSON.stringify(row.participants) === JSON.stringify([{ role: 'owner', name: '민아' }, { role: 'target', name: '지호' }]));
        assert.ok(target?.alias, 'suffix provider receives the exact prior request-local target alias');
        const fact = candidateArtifact.facts.find(row => row.tempFactId === 'd4_middle_gap_thread_11');
        fact.values.thread.linkCandidateAlias = target.alias;
      }
      return { type: 'success', result: JSON.stringify(candidateArtifact) };
    };
    f.chat.message.find(row => row.chatId === 't4-a').data = PREF_QUOTE;
    f.control.artifact = makeArtifact(1, 'set');
    assert.equal((await f.run()).completed, 1, 'first canonical set batch commits');
    fiveMore(f);
    f.chat.message.find(row => row.chatId === 't9-a').data = PREF_QUOTE;
    f.control.artifact = makeArtifact(6, 'remove');
    assert.equal((await f.run()).completed, 1, 'middle canonical remove batch commits');
    appendFivePairs(f, 11);
    f.chat.message.find(row => row.chatId === 't14-a').data = PREF_QUOTE;
    f.control.artifact = makeArtifact(11, 'reaffirm');
    linkSuffixThread = true;
    assert.equal((await f.run()).completed, 1, 'suffix canonical set batch commits');
    linkSuffixThread = false;
    assert.equal(f.control.calls.length, 3, 'the middle-gap probe uses three deterministic provider calls');

    const manifestKey = [...snapshot.local.keys()].find(key => /:manifest$/.test(key));
    const manifest = snapshot.getManifest() || parse(snapshot.local.get(manifestKey || ''));
    const targetRef = manifest?.memories?.['11'];
    assert.ok(targetRef, 'suffix ref is available as the requested cursor');
    const before = await f.r.api.getWorldManagerHistoryDetail({ memoryId: targetRef.memoryId, revision: targetRef.revision });
    const beforeProfile = before.semanticTimeline.events.filter(event => event.field === 'preferences');
    const targetMemory = parse(snapshot.local.get(targetRef.key));
    const targetThreadFact = targetMemory?.canonicalArtifact?.facts?.find(row => row.tempFactId === 'd4_middle_gap_thread_11');
    const targetLifecycleId = targetThreadFact?.values?.thread?.lifecycleId;
    assert.ok(targetLifecycleId, 'valid thread fact is accepted with a sealed lifecycle id');
    assert.equal(targetThreadFact.values.thread.linkStatus, 'accepted', 'suffix fact seals an exact accepted prior target');
    assert.ok(targetThreadFact.values.thread.linkTarget?.lineageDigest, 'suffix fact persists its exact lineage proof');
    const beforeThread = before.semanticTimeline.events.filter(event => event.field === 'threads' && event.threadLifecycleId === targetLifecycleId);
    assert.equal(JSON.stringify(beforeProfile.map(event => event.type)), JSON.stringify(['created', 'removed', 'created']), 'complete chain retains the set/remove/set transitions');
    assert.equal(JSON.stringify(beforeThread.map(event => event.type)), JSON.stringify(['created', 'reaffirmed']), 'complete chain exposes the target ref thread lifecycle');

    const missingMiddleKey = manifest.memories['6'].key;
    assert.equal(snapshot.local.has(missingMiddleKey), true, 'middle canonical row exists before the fault');
    snapshot.local.delete(missingMiddleKey);
    const after = await f.r.api.getWorldManagerHistoryDetail({ memoryId: targetRef.memoryId, revision: targetRef.revision });
    const timeline = after.semanticTimeline;
    const profile = timeline.events.filter(event => event.field === 'preferences');
    const thread = timeline.events.filter(event => event.field === 'threads' && event.threadLifecycleId === targetLifecycleId);
    assert.equal(timeline.partial, true, 'an unreadable middle ref is partial');
    assert.ok(timeline.reasons.includes('canonical_authority_gap'), 'middle continuity loss is an authority gap');
    assert.ok(timeline.reasons.includes('canonical_memory_unreadable'), 'middle row read failure is disclosed');
    assert.equal(JSON.stringify(profile.map(event => event.type)), JSON.stringify(['created', 'first_observed']), 'post-gap profile set must not reaffirm across missing removal');
    assert.equal(JSON.stringify(thread.map(event => event.type)), JSON.stringify(['created']), 'an accepted suffix link to a pre-gap target emits no post-gap transition');
    assert.ok(timeline.reasons.includes('thread_state_pending:thread_target_canonical_fact_missing'),
      `the unreadable middle ref invalidates pre-gap canonical thread targets (${JSON.stringify(timeline.reasons)})`);
    assert.equal(timeline.firstObservation, 'first_observed', 'origin is unknown after the middle gap');
    console.log(JSON.stringify({ test: 'libra_phase_d_timeline_middle_gap', passed: 1,
      before: { profile: beforeProfile.map(event => event.type), thread: beforeThread.map(event => event.type) },
      after: { profile: profile.map(event => event.type), thread: thread.map(event => event.type), reasons: timeline.reasons },
      boundary: 'three committed canonical refs with the middle record deleted from authoritative plugin_only storage; fails closed for both profile and thread continuity' }));
  } finally { await snapshot.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
