'use strict';
// R1 regression — a semantic no-op must not rewrite a field's provenance.
//
// Defect (supervisor R1, reproduced before the fix): committing a second batch whose ownerRef equals the
// current value replaced `fieldEvidence.ownerRef` with the NEW commit — memoryId mem_000001 -> mem_000006
// and sourceTurnRange 1-5 -> 6-10 — while `changedThroughTurn` correctly stayed at 5. The Head then
// pointed at the newest REVIEW instead of the commit that actually established the value.
//
// The sparse reducer already had this guard (`statePipelineSemanticEqual(...) -> continue` before it
// binds evidence). The unified reducer did not.
//
// Run: node tests/libra_unified_noop_provenance_runtime_test.cjs

const assert = require('node:assert/strict');
const { fixture, artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

// chatId shape must be `t<turn>-<u|a>`: the runtime parses it for the evidence order key.
// The first batch occupies turns 1-5, so a second batch starts at turn 6 — matching the supervisor's
// probe (`t${6 + Math.floor(i/2)}-${i%2?'a':'u'}`). An earlier version derived the turn from `from/2+1`,
// which collided with the first batch and made the second batch a no-op that never committed.
const bumpTurns = (chat, from, startTurn) => chat.message.push(...chat.message.slice(from, from + 10).map((m, i) => ({
  ...m, chatId: `t${startTurn + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}`
})));

// Point the ownership fact at a different person entity — the value lives in `values.ownerRef`.
const setOwner = (next, ownerTempId) => {
  const fact = next.facts.find(f => f.claimKind === 'ownership');
  assert.ok(fact && fact.values, 'fixture must carry an ownership fact with values');
  fact.values.ownerRef = ownerTempId;
  return next;
};

const bumpEvidence = (next, offset) => {
  for (const x of [...next.entities, ...next.facts]) {
    for (const e of x.evidenceSpans) e.ref = e.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + offset}`);
  }
  return next;
};

const cases = [];
const record = (name, fn) => cases.push({ name, fn });

// ── 1. the defect itself: same value in a later batch holds provenance ──────────────────────────
record('same value in a later commit holds fieldEvidence', async () => {
  const f = await fixture();
  try {
    await f.run();
    const before = f.getHead().world.find(r => r.name === '은빛 열쇠');
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.ownerRef));

    bumpTurns(f.chat, 0, 6);
    f.control.artifact = bumpEvidence(artifact(), 5);

    const run = await f.run();
    const head = f.getHead();
    const after = head.world.find(r => r.id === before.id);

    assert.equal(run.completed, 1, 'the second batch must commit');
    assert.deepEqual(after.state.ownerRef, before.state.ownerRef, 'the value must be unchanged');
    assert.deepEqual(after.fieldEvidence.ownerRef, beforeEvidence,
      'a semantic no-op must not drift fieldEvidence');
    assert.equal(after.fieldEvidence.ownerRef.memoryId, beforeEvidence.memoryId);
    assert.deepEqual(after.fieldEvidence.ownerRef.sourceTurnRange, beforeEvidence.sourceTurnRange);
    assert.equal(head.domainStatus.world.changedThroughTurn, 5, 'changedThroughTurn must not advance');
    assert.equal(head.domainStatus.world.reviewedThroughTurn, 10, 'the review cursor must advance');
  } finally { await f.r.cleanup(); }
});

// ── 2. control: a REAL change still writes new provenance ───────────────────────────────────────
record('a real change still advances fieldEvidence and changedThroughTurn', async () => {
  const f = await fixture();
  try {
    await f.run();
    const before = f.getHead().world.find(r => r.name === '은빛 열쇠');
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.ownerRef));

    bumpTurns(f.chat, 0, 6);
    f.control.artifact = setOwner(bumpEvidence(artifact(), 5), 'junho');

    const run = await f.run();
    const head = f.getHead();
    const after = head.world.find(r => r.id === before.id);

    assert.equal(run.completed, 1);
    assert.notDeepEqual(after.state.ownerRef, before.state.ownerRef, 'the value must actually change');
    assert.notDeepEqual(after.fieldEvidence.ownerRef, beforeEvidence,
      'a real change must write new provenance — the no-op guard must not freeze it');
    assert.equal(after.fieldEvidence.ownerRef.memoryId, 'mem_000006');
    assert.equal(head.domainStatus.world.changedThroughTurn, 10, 'a real change must advance changedThroughTurn');
  } finally { await f.r.cleanup(); }
});

// ── 3. control: repeating the NEW value holds provenance again (no bypass) ──────────────────────
record('repeating the new value in a third batch holds provenance', async () => {
  const f = await fixture();
  try {
    await f.run();
    bumpTurns(f.chat, 0, 6);
    f.control.artifact = setOwner(bumpEvidence(artifact(), 5), 'junho');
    await f.run();
    const mid = f.getHead().world.find(r => r.name === '은빛 열쇠');
    const midEvidence = JSON.parse(JSON.stringify(mid.fieldEvidence.ownerRef));

    bumpTurns(f.chat, 0, 11);
    f.control.artifact = setOwner(bumpEvidence(artifact(), 10), 'junho');

    const run = await f.run();
    const head = f.getHead();
    const end = head.world.find(r => r.id === mid.id);

    assert.equal(run.completed, 1);
    assert.deepEqual(end.state.ownerRef, mid.state.ownerRef);
    assert.deepEqual(end.fieldEvidence.ownerRef, midEvidence, 'a repeated value must hold provenance');
    assert.equal(head.domainStatus.world.changedThroughTurn, 10, 'changedThroughTurn stays at the real change');
    assert.equal(head.domainStatus.world.reviewedThroughTurn, 15, 'the review cursor keeps advancing');
  } finally { await f.r.cleanup(); }
});

// ── 4. narrative: an unchanged open thread holds its provenance ─────────────────────────────────
record('an unchanged narrative thread holds fieldEvidence', async () => {
  const f = await fixture();
  try {
    await f.run();
    const before = f.getHead().narrative;
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.summary));
    const beforeThreads = JSON.stringify((before.threads || []).map(t => ({ id: t.id, s: t.summary, st: t.status })));
    const beforeRowsId = (before.threads || [])[0]?.id;
    assert.ok(beforeRowsId, 'the fixture must produce at least one thread row');

    bumpTurns(f.chat, 0, 6);
    f.control.artifact = bumpEvidence(artifact(), 5);

    const run = await f.run();
    const head = f.getHead();
    const after = head.narrative;
    const afterThreads = JSON.stringify((after.threads || []).map(t => ({ id: t.id, s: t.summary, st: t.status })));

    const oldThread = (before.threads || []).find(t => t.id === beforeRowsId);
    const newThread = (after.threads || []).find(t => t.id === beforeRowsId);
    assert.ok(newThread, 'the open thread must still be present');

    assert.equal(run.completed, 1, 'the second batch must commit');
    assert.equal(afterThreads, beforeThreads, 'the thread content must be unchanged');
    // The INDIVIDUAL row must be untouched — its own evidence and per-field provenance, not only the
    // aggregate above it. Measured before the fix: the aggregate held mem_000001 while this row still
    // moved to mem_000006, so an aggregate-only assertion passed on a broken build.
    assert.deepEqual(newThread.fieldEvidence.summary, oldThread.fieldEvidence.summary,
      'an unchanged thread must not drift its own fieldEvidence.summary');
    assert.deepEqual(newThread.fieldEvidence.status, oldThread.fieldEvidence.status,
      'an unchanged thread must not drift its own fieldEvidence.status');
    assert.deepEqual(newThread.evidence, oldThread.evidence,
      'an unchanged thread must not drift its own row evidence');
    assert.equal(newThread.fieldEvidence.summary.memoryId, oldThread.fieldEvidence.summary.memoryId);
    assert.deepEqual(newThread.fieldEvidence.summary.sourceTurnRange, oldThread.fieldEvidence.summary.sourceTurnRange);
    // ...and the aggregate is checked separately (it can be correct while the row is not).
    assert.deepEqual(after.fieldEvidence.summary, beforeEvidence,
      'an unchanged thread must not drift narrative provenance');
    assert.equal(after.fieldEvidence.summary.memoryId, beforeEvidence.memoryId);
    assert.deepEqual(after.fieldEvidence.summary.sourceTurnRange, beforeEvidence.sourceTurnRange);
    assert.equal(head.domainStatus.narrative.changedThroughTurn, 5, 'changedThroughTurn must not advance');
    assert.equal(head.domainStatus.narrative.reviewedThroughTurn, 10, 'the review cursor must advance');
  } finally { await f.r.cleanup(); }
});

// ── 5. narrative control: a REAL thread edit still writes new provenance ────────────────────────
record('a real narrative edit still advances fieldEvidence', async () => {
  const f = await fixture();
  try {
    await f.run();
    const before = f.getHead().narrative;
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.summary));

    bumpTurns(f.chat, 0, 6);
    const next = bumpEvidence(artifact(), 5);
    // Change the OPEN thread's summary — the digest the reducer compares is (id, summary, status).
    // f12 is already `resolved` (which deletes the row), so the open thread is the one to edit.
    const threadFact = next.facts.find(x => x.claimKind === 'thread' && x.values?.thread?.status === 'open');
    assert.ok(threadFact && threadFact.values, 'fixture must carry an open thread fact with values');
    threadFact.values.thread = { ...threadFact.values.thread, summary: `${threadFact.values.thread.summary} (수정)` };
    f.control.artifact = next;

    const run = await f.run();
    const head = f.getHead();
    const after = head.narrative;

    assert.equal(run.completed, 1);
    assert.notEqual(after.summary, before.summary, 'the narrative summary must actually change');
    assert.notDeepEqual(after.fieldEvidence.summary, beforeEvidence,
      'a real thread edit must write new provenance — the no-op guard must not freeze it');
    assert.equal(head.domainStatus.narrative.changedThroughTurn, 10, 'a real edit must advance changedThroughTurn');
  } finally { await f.r.cleanup(); }
});

// ── 6. narrative control: a KIND-ONLY edit is a real change (the signature includes kind) ───────
record('a kind-only narrative edit still counts as a change', async () => {
  const f = await fixture();
  try {
    await f.run();
    const before = f.getHead().narrative;
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.summary));
    const beforeThread = (before.threads || [])[0];
    assert.ok(beforeThread, 'the fixture must produce a thread row');

    bumpTurns(f.chat, 0, 6);
    const next = bumpEvidence(artifact(), 5);
    const threadFact = next.facts.find(x => x.claimKind === 'thread' && x.values?.thread?.status === 'open');
    // Same summary and status, different kind — the signature must notice.
    threadFact.values.thread = { ...threadFact.values.thread, kind: beforeThread.kind === 'other' ? 'promise' : 'other' };
    f.control.artifact = next;

    const run = await f.run();
    const head = f.getHead();
    const after = head.narrative;
    const afterThread = (after.threads || [])[0];

    assert.equal(run.completed, 1);
    assert.notEqual(afterThread?.kind, beforeThread.kind, 'the kind must actually change');
    assert.notDeepEqual(after.fieldEvidence.summary, beforeEvidence,
      'a kind-only edit is a real change and must write new provenance');
    assert.equal(head.domainStatus.narrative.changedThroughTurn, 10,
      'a kind-only edit must advance changedThroughTurn');
  } finally { await f.r.cleanup(); }
});

// ── 7. collection (knowledge) no-op holds provenance ────────────────────────────────────────────
record('a repeated collection value holds its fieldEvidence', async () => {
  const f = await fixture();
  try {
    await f.run();
    const head0 = f.getHead();
    // The knowledge field is a collection (c.collection === true) — f9 supplies ["상자의 암호"].
    const before = head0.characters.find(r => r.fieldEvidence && r.fieldEvidence.knowledge);
    assert.ok(before, 'the fixture must produce a character row carrying knowledge evidence');
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.knowledge));
    const beforeValue = JSON.parse(JSON.stringify(before.state.knowledge));

    bumpTurns(f.chat, 0, 6);
    f.control.artifact = bumpEvidence(artifact(), 5);   // same facts -> same knowledge value

    const run = await f.run();
    const head = f.getHead();
    const after = head.characters.find(r => r.id === before.id);

    assert.equal(run.completed, 1, 'the second batch must commit');
    assert.deepEqual(after.state.knowledge, beforeValue, 'the collection value must be unchanged');
    assert.deepEqual(after.fieldEvidence.knowledge, beforeEvidence,
      'a repeated collection value must not drift its provenance');
    assert.equal(head.domainStatus.characters.changedThroughTurn, 5, 'changedThroughTurn must not advance');
    assert.equal(head.domainStatus.characters.reviewedThroughTurn, 10, 'the review cursor must advance');
  } finally { await f.r.cleanup(); }
});

// ── 8. collection control: ADDING an item is a real change ──────────────────────────────────────
record('an added collection item still advances fieldEvidence', async () => {
  const f = await fixture();
  try {
    await f.run();
    const head0 = f.getHead();
    const before = head0.characters.find(r => r.fieldEvidence && r.fieldEvidence.knowledge);
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence.knowledge));

    bumpTurns(f.chat, 0, 6);
    const next = bumpEvidence(artifact(), 5);
    const knowledgeFact = next.facts.find(x => x.claimKind === 'knowledge');
    assert.ok(knowledgeFact && knowledgeFact.values, 'fixture must carry a knowledge fact');
    knowledgeFact.values.knowledge = [...(knowledgeFact.values.knowledge || []), '숨겨진 문의 위치'];
    f.control.artifact = next;

    const run = await f.run();
    const head = f.getHead();
    const after = head.characters.find(r => r.id === before.id);

    assert.equal(run.completed, 1);
    assert.ok(after.state.knowledge.includes('숨겨진 문의 위치'), 'the new item must be applied');
    assert.notDeepEqual(after.fieldEvidence.knowledge, beforeEvidence,
      'a real collection change must write new provenance');
    assert.equal(head.domainStatus.characters.changedThroughTurn, 10, 'a real change must advance the cursor');
  } finally { await f.r.cleanup(); }
});

// ── 9. relationship no-op holds provenance ──────────────────────────────────────────────────────
record('a repeated relationship value holds its fieldEvidence', async () => {
  const f = await fixture();
  try {
    const first = await f.run();
    const head0 = f.getHead();
    // relationship rows live under the `narrative` domain head key (STATE_PIPELINE_DOMAIN_HEAD_KEYS).
    const relRows = (head0.relationships || []).filter(r => r.fieldEvidence && Object.keys(r.fieldEvidence).length);
    if (!relRows.length) { assert.ok(first.completed === 1, 'relationship fixture must produce a row'); return; }
    const before = relRows[0];
    const field = Object.keys(before.fieldEvidence)[0];
    const beforeEvidence = JSON.parse(JSON.stringify(before.fieldEvidence[field]));

    bumpTurns(f.chat, 0, 6);
    f.control.artifact = bumpEvidence(artifact(), 5);

    const run = await f.run();
    const head = f.getHead();
    const after = (head.relationships || []).find(r => r.id === before.id);

    assert.equal(run.completed, 1, 'the second batch must commit');
    assert.deepEqual(after.fieldEvidence[field], beforeEvidence,
      'a repeated relationship value must not drift its provenance');
  } finally { await f.r.cleanup(); }
});

// ── 10. correction provenance survives a no-op and is replaced by a real change ────────────────
// R1 closure condition 4. `getHead()` re-parses the stored JSON on every call, so the correction is
// seeded into the storage value itself — mutating the returned object would prove nothing.
record('a user correction provenance survives a no-op and yields to a real change', async () => {
  const f = await fixture();
  try {
    await f.run();
    const headKeyOf = (r) => [...r.values.keys()].find(k => { try { return JSON.parse(r.values.get(k))?.schema === 'libra.continuity_state.v2'; } catch { return false; } });
    const key = headKeyOf(f.r);
    const stored = JSON.parse(f.r.values.get(key));
    const target = stored.world.find(r => r.fieldEvidence && r.fieldEvidence.ownerRef);
    assert.ok(target, 'the fixture must produce a world row carrying ownerRef evidence');
    const MARK = { schema: 'libra.state_correction.v1', correctionId: 'corr_probe_noop', worldlineId: 'main', anchor: { throughTurn: 10 }, policy: 'point_in_time_override' };
    const seeded = { ...(target.fieldCorrectionProvenance || {}), ownerRef: MARK };
    stored.world = stored.world.map(r => (r.id === target.id ? { ...r, fieldCorrectionProvenance: seeded } : r));
    f.r.values.set(key, JSON.stringify(stored));
    assert.equal(f.getHead().world.find(r => r.id === target.id).fieldCorrectionProvenance.ownerRef.correctionId, 'corr_probe_noop', 'the seed must reach the stored Head');

    // (a) same value -> the correction provenance must survive.
    bumpTurns(f.chat, 0, 6);
    f.control.artifact = bumpEvidence(artifact(), 5);
    await f.run();
    const held = f.getHead().world.find(r => r.id === target.id);
    assert.equal(held.fieldCorrectionProvenance.ownerRef.correctionId, 'corr_probe_noop',
      'a no-op must not delete the user correction provenance — measured defect before the guard');
    assert.equal(held.fieldEvidence.ownerRef.memoryId, 'mem_000001', 'and the canonical evidence must hold too');

    // (b) a real change -> new evidence and the stale correction provenance goes away.
    bumpTurns(f.chat, 10, 11);
    const next = bumpEvidence(artifact(), 10);
    const ownerFact = next.facts.find(x => x.claimKind === 'ownership');
    const other = next.entities.find(e => e.type === 'person' && e.tempId !== ownerFact.values.ownerRef);
    ownerFact.values.ownerRef = other.tempId;
    f.control.artifact = next;
    await f.run();
    const changedRow = f.getHead().world.find(r => r.id === target.id);
    assert.notEqual(changedRow.state.ownerRef, target.state.ownerRef, 'the value must actually change');
    assert.equal(changedRow.fieldCorrectionProvenance?.ownerRef, undefined,
      'a real change must clear the stale correction provenance');
    assert.notEqual(changedRow.fieldEvidence.ownerRef.memoryId, 'mem_000001', 'a real change must write new evidence');
  } finally { await f.r.cleanup(); }
});

(async () => {
  const results = [];
  for (const c of cases) {
    try { await c.fn(); results.push({ name: c.name, ok: true }); }
    catch (error) { results.push({ name: c.name, ok: false, error: String(error && error.message || error).slice(0, 300) }); }
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`libra_unified_noop_provenance_runtime_test: ${passed}/${results.length} PASS`);
  console.log(JSON.stringify({ test: 'libra_unified_noop_provenance_runtime', passed, results }));
  process.exit(passed === results.length ? 0 : 1);
})();
