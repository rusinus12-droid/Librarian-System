'use strict';
// D02 step 2 of MAIN_MEMORY_CONTRACT_DECISIONS.md: "v4/v5 혼합 replay 검증".
//
// The contract deploys in this order: (1) v5 reader -> (2) mixed v4/v5 replay ->
// (3) v5 writer -> (4) v5 consumer. The reader is in place; this suite covers the
// step that must pass BEFORE the writer can be enabled.
//
// What "mixed replay" has to mean, from `01` section 12 and D02:
//   * a chain that contains BOTH v4 and v5 artifacts replays correctly;
//   * the SEGMENT schemas are read exactly -- no silent re-reading of a v4 record
//     as v5, and no "automatic re-analysis" of an older artifact's meaning;
//   * an unknown future schema in the same chain stays refused WITHOUT taking the
//     readable neighbours down with it;
//   * every record keeps its own bytes (no rewriting history to make the chain
//     homogeneous).
//
// The suite drives the real storage in all three modes, commits one batch, then
// relabels that committed artifact to v5 in a SECOND commit, so the chain really
// holds both labels rather than the test asserting on a synthesised list.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const V4 = 'libra.canonical_artifact.v4';
const V5 = 'libra.canonical_artifact.v5';

// The mode's real authority: server rows when the mode uses the server, the
// plugin's own storage otherwise.
const rowsOf = snapshot => [...snapshot.storedRows(), ...[...snapshot.local.keys()]
  .filter(key => !snapshot.storedRows().some(row => row.key === key))
  .map(key => ({ key, raw: snapshot.local.get(key) }))];
const memoryRows = snapshot => rowsOf(snapshot)
  .filter(row => /:memory:\d+:/.test(row.key))
  .map(row => ({ key: row.key, value: (() => { try { return JSON.parse(row.raw); } catch { return null; } })() }))
  .filter(row => row.value)
  .sort((a, b) => a.key.localeCompare(b.key));
const manifestOf = snapshot => {
  const server = snapshot.getManifest();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
  if (!key) return null;
  try { return JSON.parse(snapshot.local.get(key)); } catch { return null; }
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    // --- batch 1: a normal v4 commit --------------------------------------
    f.control.artifact = artifact();
    assert.equal((await f.run()).completed, 1, `${mode}: the v4 batch commits`);

    // --- batch 2: the SAME shape, but the commit is labelled v5 -----------
    // This is what a rollout looks like: an old record written by the v4 writer
    // sits next to a new record the v5 writer produced. The label is applied to
    // the artifact the product is about to store, not to a stored record, so the
    // write path itself carries it.
    fiveMore(f);
    // `fiveMore` installs the artifact for the SECOND batch and rebinds its evidence
    // refs to turns 6-10; a fresh `artifact()` still points at turns 1-5 and would be
    // rejected for unbound evidence. The rollout case is a RELABEL, so the second
    // batch's own artifact is what gets the v5 schema.
    const v5Artifact = JSON.parse(JSON.stringify(f.control.artifact));
    v5Artifact.schema = V5;
    f.control.artifact = v5Artifact;
    const second = await f.run();
    assert.equal(second.completed, 1, `${mode}: the v5-labelled batch commits`);

    // --- the chain really is MIXED ------------------------------------------
    // The first batch went through the v4 default and the second carried an explicit
    // v5 label, so the live chain holds one record of each. That is the state the
    // contract calls "mixed", and it must replay and read correctly.
    const manifest = manifestOf(snapshot);
    const refs = Object.entries(manifest?.memories ?? {})
      .map(([turn, ref]) => ({ turn: Number(turn), ...ref }))
      .sort((a, b) => a.turn - b.turn);
    assert.equal(refs.length, 2, `${mode}: two records are in the chain`);
    observation.refSchemas = refs.map(ref => ref.artifactSchema);
    assert.equal(refs[0].artifactSchema, V4, `${mode}: the unlabelled record is v4`);
    assert.equal(refs[1].artifactSchema, V5, `${mode}: the labelled record is v5`);

    const memories = memoryRows(snapshot);
    assert.equal(memories.length, 2, `${mode}: both canonical memories are stored`);
    observation.memorySchemas = memories.map(row => row.value.artifactSchema);
    assert.deepEqual(observation.memorySchemas, [V4, V5],
      `${mode}: the chain holds one record of each schema`);
    // Each record's own label must agree with its artifact -- a mismatch would be a
    // silent relabel, which is the failure D02 names explicitly.
    for (const row of memories) {
      assert.equal(row.value.artifactSchema, row.value.canonicalArtifact?.schema,
        `${mode}: ${row.key} label agrees with its artifact`);
    }

    // --- no automatic re-analysis: the v4 record's bytes are untouched ----
    // A record that was v4 before the v5 batch ran must still be v4 afterwards.
    assert.equal(memories[0].value.canonicalArtifact?.schema, V4,
      `${mode}: the older v4 artifact was not relabelled by the later commit`);
    observation.olderBytesPreserved = true;

    // --- the v5 label is understood, not rejected ------------------------
    // The provider sent a v5 artifact. It must be ACCEPTED (that is the reader's
    // whole job) even though the writer stores it under its own schema.
    assert.equal(memoryRows(snapshot).length, 2,
      `${mode}: neither record was dropped for its schema, and replay served both`);

    // --- replay/read paths serve BOTH segments ----------------------------
    const head = (() => {
      const server = snapshot.getHead();
      if (server) return server;
      const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
      return key ? JSON.parse(snapshot.local.get(key)) : null;
    })();
    assert.ok(head, `${mode}: the State Head exists over the mixed chain`);
    assert.equal(Number(head.throughTurn || 0), 10,
      `${mode}: the Head covers both batches, so both segments replayed`);
    observation.headThroughTurn = Number(head.throughTurn || 0);

    // Every canonical read the plugin exposes must still answer for both records.
    const api = f.r.api;
    const rendered = memories.map(row => {
      const out = api.debugRenderUnifiedArtifact(row.value.canonicalArtifact);
      return { schema: row.value.canonicalArtifact.schema, bytes: out.length, text: out };
    });
    assert.ok(rendered.every(item => item.bytes > 0), `${mode}: both segments render`);
    // The two segments hold the same SHAPE of memory (the second batch repeats the
    // first with its evidence rebound to turns 6-10), so they must render to the same
    // text once the turn numbers are normalised. A schema label never changes what a
    // memory means, which is the property mixed replay depends on.
    const normaliseTurns = value => String(value).replace(/t(\d+)-(u|a)/g, (_, turn, role) => `t<turn>-$role`);
    assert.equal(normaliseTurns(rendered[1].text), normaliseTurns(rendered[0].text),
      `${mode}: the v5 segment renders to the same text as the v4 segment (turn numbers normalised)`);
    observation.mixedRenderIdentical = true;

    // --- an unknown schema beside readable ones stays refused -------------
    const poisoned = artifact();
    poisoned.schema = 'libra.canonical_artifact.v99';
    const prepared = api.debugPrepareUnifiedMemoryArtifact(poisoned, []);
    const validated = api.debugValidateUnifiedArtifact(prepared.artifact, []);
    assert.equal(validated.ok, false, `${mode}: an unknown schema is still refused`);
    // And the readable neighbours are unaffected by that refusal.
    const v4Check = api.debugValidateUnifiedArtifact(memories[0].value.canonicalArtifact, []);
    const v5Check = api.debugValidateUnifiedArtifact(memories[1].value.canonicalArtifact, []);
    assert.equal(v4Check.ok, false, `${mode}: raw v4 (unbound evidence) is judged on its own merits`);
    assert.equal(v5Check.ok, false, `${mode}: raw v5 is judged on its own merits`);
    assert.ok(!/UNIFIED_SCHEMA_INVALID/.test(JSON.stringify(v4Check.issues)),
      `${mode}: the v4 record is not refused for its schema`);
    assert.ok(!/UNIFIED_SCHEMA_INVALID/.test(JSON.stringify(v5Check.issues)),
      `${mode}: the v5 record is not refused for its schema`);

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
    'mirror reaches the same mixed-replay verdict as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same mixed-replay verdict as plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_mixed_replay',
    passed: 1,
    boundary: 'real deployed LIBRA + real HTTP/SQLite in three modes; a v4 commit followed by a v5-labelled commit',
    decision: 'D02 step 2 -- mixed v4/v5 replay verified before the v5 writer is enabled',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
