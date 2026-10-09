'use strict';

// D4: a missing canonical prefix must disclose unknown origin even when the
// requested cursor is inside an otherwise complete two-ref chain.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const parse = value => { try { return JSON.parse(value); } catch (_) { return null; } };
const preferenceQuote = '민아는 민트차를 좋아한다고 말했다.';

const makeArtifact = (startTurn, batch) => {
  const value = clone(artifact());
  value.schema = 'libra.canonical_artifact.v5';
  const offset = startTurn - 1;
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
  }
  const mina = value.entities.find(entity => entity.tempId === 'mina');
  value.facts.push({
    tempFactId: `d4_gap_preference_${batch}`,
    domain: 'character', subjectTempRef: mina.tempId, claimKind: 'character_preference',
    values: { preferences: [{ content: '민트차를 좋아한다', topic: '민트차', kind: 'preference' }] },
    text: preferenceQuote, temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: `t${startTurn + 3}-a`, quote: preferenceQuote }]
  });
  return value;
};

(async () => {
  const snapshot = await serverFixture({ mode: 'plugin_only' });
  try {
    const f = snapshot.f;
    f.control.onCall = () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
    const firstSource = f.chat.message.find(row => row.chatId === 't4-a');
    firstSource.data = preferenceQuote;
    f.control.artifact = makeArtifact(1, 1);
    assert.equal((await f.run()).completed, 1, 'first canonical producer batch commits');
    fiveMore(f);
    const secondSource = f.chat.message.find(row => row.chatId === 't9-a');
    secondSource.data = preferenceQuote;
    f.control.artifact = makeArtifact(6, 2);
    assert.equal((await f.run()).completed, 1, 'second canonical producer batch commits');
    assert.equal(f.control.calls.length, 2, 'the gap probe uses two deterministic provider calls');

    const manifestKey = [...snapshot.local.keys()].find(key => /:manifest$/.test(key));
    const manifest = snapshot.getManifest() || parse(snapshot.local.get(manifestKey || ''));
    assert.ok(manifest?.memories, 'manifest has committed canonical references');
    const targetRef = manifest.memories['6'];
    const before = await f.r.api.getWorldManagerHistoryDetail({ memoryId: targetRef.memoryId, revision: targetRef.revision });
    assert.equal(before.semanticTimeline.firstObservation, 'known_from_chain_origin', 'complete prefix establishes known origin');
    assert.ok(before.semanticTimeline.events.some(event => event.field === 'preferences' && event.type === 'created'), 'complete prefix emits created profile event');

    const missingPrefixKey = manifest.memories['1'].key;
    assert.equal(snapshot.local.has(missingPrefixKey), true, 'the first canonical row is present before the fault');
    snapshot.local.delete(missingPrefixKey);
    const after = await f.r.api.getWorldManagerHistoryDetail({ memoryId: targetRef.memoryId, revision: targetRef.revision });
    const timeline = after.semanticTimeline;
    assert.equal(timeline.partial, true, 'unreadable canonical prefix is partial');
    assert.ok(timeline.reasons.includes('canonical_authority_gap'), 'unreadable prefix reports an authority gap');
    assert.ok(timeline.reasons.includes('canonical_memory_unreadable'), 'unreadable prefix reports the memory read failure');
    assert.equal(timeline.firstObservation, 'first_observed', 'gap prevents an origin claim for the visible suffix');
    const profileEvents = timeline.events.filter(event => event.field === 'preferences');
    assert.ok(profileEvents.some(event => event.type === 'first_observed'), 'suffix profile event is first_observed after the gap');
    assert.ok(profileEvents.every(event => event.note.includes('원래 생성 시점으로 단정하지 않습니다')), 'first_observed event carries the unknown-origin note');
    assert.equal(timeline.requestedCursor.memoryId, targetRef.memoryId, 'timeline remains anchored to the requested canonical cursor');
    console.log(JSON.stringify({
      test: 'libra_phase_d_timeline_gap', passed: 1,
      result: { mode: 'plugin_only', providerCalls: f.control.calls.length, before: {
        firstObservation: before.semanticTimeline.firstObservation,
        profileEventTypes: before.semanticTimeline.events.filter(event => event.field === 'preferences').map(event => event.type)
      }, after: {
        firstObservation: timeline.firstObservation, reasons: timeline.reasons,
        profileEventTypes: profileEvents.map(event => event.type), scannedCanonicalRefs: timeline.scannedCanonicalRefs,
        availableCanonicalRefs: timeline.availableCanonicalRefs
      } },
      boundary: 'actual plugin_only canonical memory readback with the first prefix row removed after two committed producer batches; unknown origin is disclosed without changing canonical authority'
    }));
  } finally {
    await snapshot.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
