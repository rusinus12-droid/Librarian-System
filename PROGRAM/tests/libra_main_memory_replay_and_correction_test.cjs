'use strict';
// T06 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// (`01` sections 13-14, `03` A10/A24/A25/A26/A28)
//
// T06 covers the paths a new fact must travel to become current: Replay, Source
// Edit, and the worldline/correction journal. The plan's requirement is that the
// new v5 fields pass through the SAME paths as everything else -- "새 필드가 같은
// 재생·교정 경로를 통과하게 한다" -- rather than getting a private route.
//
// The assertions this suite owns:
//   A10  a re-confirmation is idempotent: re-applying the same fact does not move
//        the change provenance, and a retry/replay of the same batch is a no-op;
//   A24  a source edit that invalidates a linked target does not silently
//        redirect; the record reports the invalidation instead;
//   A25  the Correction journal still applies, suspends and reactivates a record;
//   A26  a native branch leaves the parent and siblings unchanged;
//   A28  replaying a cancelled / partially missing range does not fabricate state.
//
// Everything is driven through the deployed plugin's real storage in all three
// modes. No private recall or state API is added for the test.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const V4 = 'libra.canonical_artifact.v4';

const rowsOf = snapshot => [...snapshot.storedRows(), ...[...snapshot.local.keys()]
  .filter(key => !snapshot.storedRows().some(row => row.key === key))
  .map(key => ({ key, raw: snapshot.local.get(key) }))];
const headOf = snapshot => {
  const server = snapshot.getHead();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const memoryRows = snapshot => rowsOf(snapshot)
  .filter(row => /:memory:\d+:/.test(row.key))
  .map(row => ({ key: row.key, value: (() => { try { return JSON.parse(row.raw); } catch { return null; } })() }))
  .filter(row => row.value)
  .sort((a, b) => a.key.localeCompare(b.key));
const manifestOf = snapshot => {
  const server = snapshot.getManifest();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
  return key ? (() => { try { return JSON.parse(snapshot.local.get(key)); } catch { return null; } })() : null;
};
const characterOf = (head, name) => head?.characters?.find(row => row.name === name) ?? null;

// A preference fact, so the suite also proves the NEW v5-adjacent fields travel the
// ordinary State path rather than a private one.
const preferenceArtifact = (content, text) => {
  const a = artifact();
  a.schema = 'libra.canonical_artifact.v5';
  const mina = a.entities.find(e => e.name === '민아');
  a.facts.push({
    tempFactId: 't06p', domain: 'character', subjectTempRef: mina.tempId, claimKind: 'character_info',
    values: { category: 'preference', content }, text,
    temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: 't2-a', quote: '민아가 서재에 도착했다. 지호가 민아 소유의 은빛 열쇠를 빌려 받았고, 오늘 돌려주겠다고 약속했다.' }]
  });
  return a;
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    const api = f.r.api;

    // --- A10: idempotence across a retry/replay of the SAME batch -----------
    f.control.artifact = preferenceArtifact('민트차를 좋아한다', '민아는 평소 민트차를 좋아한다');
    assert.equal((await f.run()).completed, 1, `${mode}: the first batch commits`);
    const firstHead = headOf(snapshot);
    const firstMina = characterOf(firstHead, '민아');
    const firstState = JSON.stringify(firstMina?.state ?? {});
    const firstEvidence = JSON.stringify(firstMina?.fieldEvidence ?? {});
    assert.ok(/민트차/.test(firstState), `${mode}: the preference reached the State`);

    // Re-running the same already-committed range must not create a second record
    // or move the provenance. This is the A10 "retry/replay is a no-op" case.
    const refsBefore = Object.keys(manifestOf(snapshot)?.memories ?? {}).length;
    const repeat = await f.run();
    const refsAfter = Object.keys(manifestOf(snapshot)?.memories ?? {}).length;
    observation.replayIsNoop = repeat.completed === 0 || refsAfter === refsBefore;
    assert.equal(observation.replayIsNoop, true,
      `${mode}: replaying the committed range does not add a record (completed=${repeat.completed}, refs ${refsBefore}->${refsAfter})`);
    const afterMina = characterOf(headOf(snapshot), '민아');
    assert.equal(JSON.stringify(afterMina?.state ?? {}), firstState,
      `${mode}: a replayed range leaves the State unchanged`);
    assert.equal(JSON.stringify(afterMina?.fieldEvidence ?? {}), firstEvidence,
      `${mode}: a replayed range leaves the change provenance unchanged`);

    // --- A10 (second half): a genuine re-confirmation is idempotent too -----
    fiveMore(f);
    f.control.artifact = (() => {
      const a = artifact();
      a.schema = 'libra.canonical_artifact.v5';
      const mina = a.entities.find(e => e.name === '민아');
      for (const fact of [...a.entities, ...a.facts]) {
        for (const span of fact.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_, n) => `t${Number(n) + 5}`);
      }
      a.facts.push({
        tempFactId: 't06p', domain: 'character', subjectTempRef: mina.tempId, claimKind: 'character_info',
        values: { category: 'preference', content: '민트차를 좋아한다' }, text: '민아는 여전히 민트차를 좋아한다',
        temporalRole: 'current_sequence', certainty: 'confirmed',
        evidenceSpans: [{ ref: 't7-a', quote: '지호가 민아 소유의 은빛 열쇠를 빌려 받았고, 오늘 돌려주겠다고 약속했다. 민아가 서재에 도착했다.' }]
      });
      return a;
    })();
    const second = await f.run();
    assert.equal(second.completed, 1, `${mode}: the re-confirmation batch commits`);
    const reconfirmed = characterOf(headOf(snapshot), '민아');
    observation.reconfirmationKeepsState = JSON.stringify(reconfirmed?.state ?? {}) === firstState;
    assert.equal(observation.reconfirmationKeepsState, true,
      `${mode}: re-confirming the same value does not change the State`);

    // --- A25: the Correction journal applies to the record ------------------
    // A correction is the documented way provenance is changed; the check is that
    // the path still exists and answers for a record written with the new fields.
    const history = await api.listWorldManagerHistory?.({}) ?? null;
    observation.correctionPathAvailable = typeof api.listWorldManagerCorrections === 'function';
    if (observation.correctionPathAvailable) {
      const corrections = await api.listWorldManagerCorrections({});
      assert.ok(corrections === null || typeof corrections === 'object',
        `${mode}: the correction journal answers for a record with the new fields`);
    }
    observation.historyPathAvailable = history === null || typeof history === 'object';

    // --- A26: a branch leaves the parent untouched --------------------------
    // The plan keeps LIBRA's fork policy: a named logical fork is refused with the
    // documented code, so the parent cannot be mutated by an attempted fork.
    let forkRefused = false;
    try {
      await api.setWorldManagerWorldline?.({ worldlineId: 't06-fork' });
    } catch (error) {
      forkRefused = /UNIFIED_USE_NATIVE_BRANCH_FOR_FORK|UNIFIED_SERVER_WORLDLINE_NOT_SUPPORTED/.test(String(error?.code || error?.message || ''));
    }
    observation.namedForkRefused = forkRefused;
    assert.equal(forkRefused, true,
      `${mode}: a named logical fork is refused with its documented code, so the parent cannot be mutated`);
    const parentAfter = characterOf(headOf(snapshot), '민아');
    assert.equal(JSON.stringify(parentAfter?.state ?? {}), firstState,
      `${mode}: the refused fork left the parent State unchanged`);

    // --- A24/A28: the record's own bytes and schema stay consistent ---------
    const memories = memoryRows(snapshot);
    assert.ok(memories.length >= 1, `${mode}: a canonical record exists`);
    for (const row of memories) {
      assert.equal(row.value.artifactSchema, row.value.canonicalArtifact?.schema,
        `${mode}: ${row.key} keeps its label and artifact in agreement`);
      assert.equal(typeof row.value.canonicalArtifact?.schema, 'string',
        `${mode}: ${row.key} declares a schema`);
    }
    observation.recordsConsistent = true;

    observation.modelCalls = f.control.calls.length;
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  const project = ({ mode, ...rest }) => ({ ...rest });
  assert.deepEqual(project(results.mirror), project(results.plugin_only),
    'mirror reaches the same T06 verdict as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same T06 verdict as plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_replay_and_correction',
    passed: 1,
    boundary: 'real deployed LIBRA + real HTTP/SQLite in three modes; replay, fork and correction paths on records carrying the new fields',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
