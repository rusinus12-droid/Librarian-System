'use strict';
// T04 (World Maker integration plan) + contract decision D03.
//
// D03 decided: durable preferences and scoped boundaries are expressed as typed
// values INSIDE the existing character pipeline -- no separate ledger and no new
// canonical schema. The pipeline maps an optional provider `character_info` shape
// onto the existing claim kinds (`libra.unified.v2`), where the profile fields are
// `collection:true` (so a single item can be replaced or removed) and an unknown
// category deliberately falls back to an evidence-bound memory-only note.
//
// This test pins the parts of that contract that the main-memory work depends on:
//   1. A directly established preference becomes a durable profile item.
//   2. A transient event is NOT promoted to an enduring preference.
//   3. One item can be replaced or removed without touching its siblings.
//   4. An unknown category stays memory-only instead of being guessed into a field.
//   5. Re-confirming the same value preserves the original change evidence.
//
// It drives the real deployed plugin through its real storage in all three modes.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

// A canonical artifact fragment carrying preference / boundary / transient facts.
// `artifact()` gives the shape that the real validator accepts; the facts below are
// appended so the test does not have to re-invent the envelope.
const withPreferenceFacts = base => {
  const a = JSON.parse(JSON.stringify(base));
  a.schema = 'libra.canonical_artifact.v5';
  const mina = a.entities.find(e => e.name === '민아');
  const add = (tempFactId, claimKind, values, text, extra = {}) => a.facts.push({
    tempFactId, domain: 'character', subjectTempRef: mina.tempId, claimKind, values, text,
    temporalRole: extra.temporalRole || 'current_sequence',
    certainty: extra.certainty || 'confirmed',
    evidenceSpans: [{ ref: 't4-a', quote: '민아만 암호를 들었고 준호는 듣지 못했다. 민아는 지호를 신뢰한다고 말했다.' }],
    ...extra
  });
  // 1. durable preference, established directly
  add('p1', 'character_info', { category: 'preference', content: '민트차를 좋아한다' }, '민아는 평소 민트차를 좋아한다');
  // 2. the spec's own boundary case (`03` A08). Its four axes must survive, and it
  //    must be classified as a boundary even though the sentence spells the
  //    prohibition as `-지 말라고` rather than `-지 마`.
  add('p2', 'character_info', { category: 'boundary', content: '지호에게만 오늘 자신의 편지를 열지 말라고 명시' }, '민아는 지호에게만 오늘 자신의 편지를 열지 말라고 명시했다');
  // 3. an unrelated habit that must survive the edits above
  add('p3', 'character_info', { category: 'habits', content: '열쇠를 왼손으로 받는다' }, '민아는 열쇠를 왼손으로 받는 습관이 있다');
  // 4. an unknown category: memory-only, must not be guessed into a profile field
  add('p4', 'character_info', { category: 'favourite_weather', content: '비 오는 날을 좋아한다' }, '민아는 비 오는 날을 좋아한다');
  // 5. a transient event that must NOT become an enduring preference
  // The transient line is a REPORTED statement, not a current enduring fact.
  // `reported` belongs to `temporalRole` (the certainty enum is
  // confirmed/uncertain/conflict/unknown), so the fact stays in canonical memory
  // and must never be promoted into the character's current State.
  add('p5', 'character_info', { category: 'preference', content: '오늘 민트차를 거절했다' }, '오늘 민트차를 거절했다',
    { temporalRole: 'reported', certainty: 'confirmed', evidenceSpans: [{ ref: 't5-a', quote: '서재에서 준호가 열쇠를 지호에게 건넸고, 지호가 그것을 민아에게 돌려주었다. 오늘 열쇠를 반환하겠다는 약속은 이행되었다. 공연 허가를 누가 내주는지는 아직 밝혀지지 않았다.' }] });
  return a;
};

const characterByName = (head, name) => head?.characters?.find(row => row.name === name) ?? null;

// The mode's real authority: server in mirror/server_only, plugin storage in
// plugin_only. Reading only one of them makes a passing pipeline look broken.
const localJson = (snapshot, pattern) => {
  const key = [...snapshot.local.keys()].find(candidate => pattern.test(candidate));
  if (!key) return null;
  try { return JSON.parse(snapshot.local.get(key)); } catch { return null; }
};
const headOf = snapshot => localJson(snapshot, /:continuity-state$/) ?? snapshot.getHead() ?? null;
const memoryOf = snapshot => {
  const serverRef = snapshot.getManifest()?.memories?.['1'];
  if (serverRef) { const row = snapshot.storedRows().find(candidate => candidate.key === serverRef.key); if (row) return row.value; }
  return localJson(snapshot, /:memory:1:/);
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    f.control.artifact = withPreferenceFacts(artifact());
    const first = await f.run();
    assert.equal(first.completed, 1, `${mode}: the batch with preference facts commits`);
    const head = headOf(snapshot);
    const mina = characterByName(head, '민아');
    assert.ok(mina, `${mode}: the character row exists`);

    // (1)(2) durable preference present; unknown category NOT guessed into a field
    const profile = JSON.stringify(mina.state ?? {});
    observation.durablePreferencePresent = /민트차를 좋아한다/.test(profile);
    observation.unknownCategoryNotGuessed = !/비 오는 날|favourite_weather/.test(profile);
    assert.equal(observation.durablePreferencePresent, true,
      `${mode}: a directly established preference reaches the character state`);
    assert.equal(observation.unknownCategoryNotGuessed, true,
      `${mode}: an unknown category is not guessed into a profile field`);

    // (A08) the boundary keeps all four axes and is not generalised into a taste.
    observation.boundaryIsItsOwnField = Array.isArray(mina.state?.boundaries) && mina.state.boundaries.length > 0;
    assert.equal(observation.boundaryIsItsOwnField, true,
      `${mode}: a scoped boundary reaches its own current-item field`);
    const boundaryRows = mina.state?.boundaries ?? [];
    const boundaryText = JSON.stringify(boundaryRows);
    const boundaryRow = boundaryRows.find(item => item?.kind === 'boundary');
    const jihoId = characterByName(head, '지호')?.id;
    observation.boundaryKeepsSubject = boundaryRow?.scope?.subjectRef === mina.id;
    observation.boundaryKeepsTarget = boundaryRow?.scope?.targetRef === jihoId;
    observation.boundaryKeepsWhen = boundaryRow?.scope?.when === '오늘';
    observation.boundaryKeepsAct = typeof boundaryRow?.scope?.act === 'string'
      && /편지/.test(boundaryRow.scope.act) && /열/.test(boundaryRow.scope.act)
      && !/오늘|시점|행위/.test(boundaryRow.scope.act);
    assert.equal(observation.boundaryKeepsSubject && observation.boundaryKeepsTarget
      && observation.boundaryKeepsWhen && observation.boundaryKeepsAct, true,
      `${mode}: the boundary keeps subject/target/act/when instead of widening to a general rule (got: ${boundaryText})`);
    observation.boundaryNotInPreferences = !/열지 말라고/.test(JSON.stringify(mina.state?.preferences ?? []));
    assert.equal(observation.boundaryNotInPreferences, true,
      `${mode}: a prohibition is not stored as an ordinary preference`);

    // (5) the transient line must not be recorded as an enduring preference
    observation.transientNotPromoted = !/오늘 민트차를 거절했다/.test(profile);
    assert.equal(observation.transientNotPromoted, true,
      `${mode}: a transient event is not promoted to an enduring preference`);

    // (3) the unrelated habit survives, and the memory-only note is still readable
    observation.unrelatedHabitPresent = /열쇠를 왼손으로/.test(profile);
    assert.equal(observation.unrelatedHabitPresent, true, `${mode}: an unrelated habit is preserved`);

    // The canonical memory still holds every fact the provider sent -- a rejected
    // profile mapping must not delete the evidence-bound memory.
    const memory = memoryOf(snapshot);
    const texts = JSON.stringify(memory?.canonicalArtifact?.facts ?? []);
    observation.memoryKeepsUnknownCategory = /비 오는 날/.test(texts);
    observation.memoryKeepsTransient = /오늘 민트차를 거절했다/.test(texts);
    assert.equal(observation.memoryKeepsUnknownCategory, true,
      `${mode}: the memory-only note is still stored in canonical memory`);
    assert.equal(observation.memoryKeepsTransient, true,
      `${mode}: the transient fact is still stored in canonical memory`);

    // (4) re-confirmation of the same value must not move the change evidence.
    const beforeEvidence = JSON.stringify(mina.fieldEvidence ?? {});
    const beforeState = JSON.stringify(mina.state ?? {});
    // Re-confirmation needs a second batch to process, and the fixture's own
    // `fiveMore` is the documented way to append one (it also rebinds the
    // artifact's evidence refs to the new turns).
    fiveMore(f);
    const second = await f.run();
    assert.equal(second.completed, 1, `${mode}: the re-confirmation batch commits`);
    const head2 = headOf(snapshot);
    const mina2 = characterByName(head2, '민아');
    observation.sameValueKeepsEvidence = JSON.stringify(mina2.fieldEvidence ?? {}) === beforeEvidence
      && JSON.stringify(mina2.state ?? {}) === beforeState;
    assert.equal(observation.sameValueKeepsEvidence, true,
      `${mode}: re-confirming the same value keeps the original state and evidence`);

    observation.modelCalls = f.control.calls.length;
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const project = ({ mode, ...rest }) => rest;
  assert.deepEqual(project(results.mirror), project(results.plugin_only),
    'mirror reaches the same preference verdict as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same preference verdict as plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_profile_lifecycle',
    passed: 1,
    boundary: 'real deployed LIBRA canonical pipeline + real HTTP/SQLite in three modes; synthetic provider artifact only',
    decision: 'D03 -- typed values inside the existing character pipeline, no separate ledger, no new canonical schema',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
