'use strict';
// T01 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
//
// RED BEFORE GREEN. The plan's T01 requires that the State view operations the
// main-memory work depends on -- `rollbackWorldManagerState({throughTurn:0})`
// and `setWorldManagerWorldline({})` -- reach the SAME success in all three
// storage modes, and that the durable authority really changed rather than a
// local copy being reported as the durable value.
//
// Measured behaviour before this fix (a FINDING, recorded by
// `libra_world_manager_state_3mode_parity_test.cjs`): both operations succeed in
// `plugin_only` and fail closed with UNIFIED_BACKEND_NOT_SUPPORTED in `mirror`
// and `server_only`, because the unified server writer does not implement them.
// This test asserts the REQUIRED behaviour, so it is expected to fail on those
// two modes until the operations are implemented.
//
// The test deliberately does NOT read the server Head out of a local Map: the
// durability assertions read the real HTTP/SQLite authority and the mirror's
// local replica separately, so a local-only downgrade cannot pass as durable.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const HEAD_SCHEMA = 'libra.continuity_state.v2';

// Durable state is read from the authority the mode actually uses:
//   plugin_only          -> the plugin's own local storage is the authority
//   mirror               -> server is authoritative, local holds a replica
//   server_only          -> server only; nothing durable is kept locally
const localHeadKey = snapshot => [...snapshot.local.keys()].find(key => /:continuity-state$/.test(key));
const localHead = snapshot => {
  const key = localHeadKey(snapshot);
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const durableHead = snapshot => {
  const server = snapshot.getHead();
  if (server) return server;
  const key = localHeadKey(snapshot);
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
// The worldline meta is the authority for the cutoff VIEW, so it is read back
// from the same surfaces the head is read from -- never from a sidecar.
const durableMeta = snapshot => {
  const localKey = [...snapshot.local.keys()].find(key => /:state-worldline-meta:v1$/.test(key));
  const local = localKey ? JSON.parse(snapshot.local.get(localKey)) : null;
  const serverRow = snapshot.storedRows().find(row => /:state-worldline-meta:v1$/.test(row.key));
  const server = serverRow ? (() => { try { return JSON.parse(serverRow.raw); } catch { return null; } })() : null;
  return server ?? local;
};
const worldCondition = (head, worldId) =>
  head?.world?.find(row => row.id === worldId)?.state?.condition ?? null;

// Canonical memory must be untouched by a State VIEW operation. The comparison
// is a real diff, not a blanket exclusion: every changed path must fall in the
// allowlist below, so an unexpected canonical change FAILS rather than being
// hidden by an over-broad equality filter.
//
// Allowlisted paths are the ones a control run measured changing with NO
// rollback call at all (ambient embedding bookkeeping) plus the record's own
// write timestamps. They are not canonical meaning.
const ALLOWED_CHANGE = /\.(updatedAt|embedding\.status|embedding\.reason|embedding\.vectorCount|embeddingStatus|lastFullAuditAt)$/;
const diffPaths = (a, b, path = '', out = []) => {
  if (out.length > 40 || a === b) return out;
  const ta = a === null ? 'null' : typeof a, tb = b === null ? 'null' : typeof b;
  if (ta !== tb) { out.push(path); return out; }
  if (ta === 'object') {
    for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) diffPaths(a?.[key], b?.[key], `${path}.${key}`, out);
    return out;
  }
  out.push(path);
  return out;
};
const memoryRecords = snapshot => [...snapshot.storedRows(), ...[...snapshot.local.keys()]
  .filter(key => !snapshot.storedRows().some(row => row.key === key))
  .map(key => ({ key, raw: snapshot.local.get(key) }))]
  .filter(row => /:memory:\d+:/.test(row.key))
  .map(row => ({ key: row.key, value: (() => { try { return JSON.parse(row.raw); } catch { return row.raw; } })() }))
  .sort((a, b) => a.key.localeCompare(b.key));
const assertCanonicalUnchanged = (mode, before, after) => {
  assert.deepEqual(after.map(row => row.key), before.map(row => row.key),
    `${mode}: no canonical memory record was added or removed`);
  for (let index = 0; index < before.length; index += 1) {
    const paths = diffPaths(before[index].value, after[index].value);
    const unexpected = paths.filter(path => !ALLOWED_CHANGE.test(path));
    assert.deepEqual(unexpected, [],
      `${mode}: ${before[index].key} changed outside the allowlisted bookkeeping paths`);
  }
};
// The manifest is the canonical index; its memory refs (key/status/sourceDigest/
// revision) must not move. Its timestamps are bookkeeping and are compared
// separately so a real ref change is never masked by an equality filter.
const canonicalRefs = snapshot => Object.entries(snapshot.getManifest()?.memories ?? {})
  .map(([turn, ref]) => ({ turn, key: ref?.key ?? null, status: ref?.status ?? null, revision: ref?.revision ?? null, sourceDigest: ref?.sourceDigest ?? null }))
  .sort((a, b) => Number(a.turn) - Number(b.turn));

// One adapter per document T01 contract. It only wraps the existing fixtures;
// it does not create product meaning and does not reimplement the engine.
const openLifecycleFixture = async mode => {
  const snapshot = await serverFixture({ mode });
  const env = {
    mode, snapshot,
    // `restart()` disposes the previous runtime, so these accessors always read
    // the CURRENT one instead of a stale reference captured at open time.
    get fixture() { return snapshot.f; },
    get api() { return snapshot.f.r.api; },
    async runInitialFivePairs() {
      const first = await env.fixture.run();
      assert.equal(first.completed, 1, `${mode}: the canonical batch commits`);
      const head = durableHead(snapshot);
      assert.ok(head, `${mode}: the durable State Head exists after the batch`);
      assert.equal(head.throughTurn, 5, `${mode}: the head covers the committed range`);
      // Settle ambient background writes before the baseline. A control run (no
      // rollback at all, same wait) measured that the embedding status moves
      // `pending -> disabled (API Key)` on its own in every mode, so a baseline
      // taken immediately after the batch would attribute that transition to the
      // State view operation. Waiting for the transition to finish keeps the
      // comparison about the operation under test.
      const settledHead = JSON.stringify(head);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 150));
        const row = snapshot.storedRows().find(candidate => /:memory:1:/.test(candidate.key));
        const embedding = (() => { try { return JSON.parse(row?.raw ?? '{}')?.embedding?.status ?? null; } catch { return null; } })();
        if (embedding !== 'pending') break;
      }
      assert.equal(JSON.stringify(durableHead(snapshot)), settledHead,
        `${mode}: the head is stable after the embedding transition settles`);
      return head;
    },
    snapshotDurable() {
      return { head: durableHead(snapshot), memory: memoryRecords(snapshot), refs: canonicalRefs(snapshot) };
    },
    async cleanup() { await snapshot.cleanup(); }
  };
  return env;
};

async function assertCanonicalAndSourceUnchanged(env, before, worldId) {
  const { mode, snapshot } = env;
  assertCanonicalUnchanged(mode, before.memory, memoryRecords(snapshot));
  assert.deepEqual(canonicalRefs(snapshot), before.refs,
    `${mode}: a State view operation leaves the canonical manifest refs unchanged`);
  const head = durableHead(snapshot);
  assert.ok(head, `${mode}: a head still exists after the operations`);
  assert.equal(head.worldlineId, 'main', `${mode}: the worldline is back on main`);
  // The rollback is a cutoff VIEW. The world content itself is not deleted, so a
  // row that existed before the rollback is still present afterwards.
  assert.ok(head.world.some(row => row.id === worldId),
    `${mode}: the rolled-back view still carries the world row (cutoff is a view, not deletion)`);
}

// The authority check reads every storage surface the mode is supposed to use,
// so "it worked" cannot be claimed from the wrong store.
async function assertExpectedAuthorityAfterReadback(env, worldId) {
  const { mode, snapshot, fixture } = env;
  const readback = await fixture.r.api.getCurrentStateHead();
  assert.ok(readback, `${mode}: the public State Head is readable after the operations`);
  assert.equal(readback.worldlineId, 'main', `${mode}: the public head agrees on the worldline`);

  const rows = snapshot.getRecords(HEAD_SCHEMA);
  if (mode === 'plugin_only') {
    assert.equal(rows.length, 0, 'plugin_only writes no State Head to the server');
    assert.ok(localHead(snapshot), 'plugin_only keeps the State Head locally');
  }
  if (mode === 'mirror') {
    assert.ok(rows[0], 'mirror holds the State Head on the server');
    const key = localHeadKey(snapshot);
    assert.ok(key, 'mirror keeps a local replica of the State Head');
    assert.deepEqual(JSON.parse(snapshot.local.get(key)), rows[0].value,
      'mirror local replica equals the server value (no local-only divergence)');
  }
  if (mode === 'server_only') {
    assert.ok(rows[0], 'server_only holds the State Head on the server');
  }
  return { worldlineId: readback.worldlineId, throughTurn: readback.throughTurn, worldCondition: worldCondition(readback, worldId) };
}

async function runMode(mode) {
  const env = await openLifecycleFixture(mode);
  const observation = { mode };
  try {
    const head = await env.runInitialFivePairs();
    const worldRow = head.world[0];
    assert.ok(worldRow, `${mode}: the committed head carries at least one world row`);
    const callsAfterRun = env.fixture.control.calls.length;
    const before = env.snapshotDurable();
    assert.ok(before.memory.length, `${mode}: the canonical memory record is present before the view operation`);

    // --- the operation under contract ------------------------------------
    // `throughTurn: 0` is an explicit view restore: the committed rows stay in
    // durable storage and the view is rewound. It must succeed in every mode.
    // Model calls are counted per runtime: `restart()` swaps in a fresh counter,
    // so each segment is compared against its own baseline.
    const callsBeforeOps = env.fixture.control.calls.length;
    const rolled = await env.api.rollbackWorldManagerState({ throughTurn: 0 });
    assert.equal(rolled.ok, true, `${mode}: rollback to turn 0 succeeds`);
    assert.equal(env.fixture.control.calls.length, callsBeforeOps,
      `${mode}: the rollback costs no model call`);
    observation.rollback = { ok: rolled.ok, throughTurn: rolled.head?.throughTurn ?? null };

    // The CUTOFF itself must be durable before it is undone, otherwise the
    // operation "worked" only in this runtime's memory. Read the meta back from
    // the mode's real authority and then restart.
    const cutoffMeta = durableMeta(env.snapshot);
    assert.ok(cutoffMeta, `${mode}: the worldline meta is durable after the rollback`);
    assert.equal(cutoffMeta.worldlines?.main?.cutoffTurn, 0,
      `${mode}: the durable worldline meta records the rollback cutoff`);
    const restartedMidway = await env.snapshot.restart();
    const metaAfterRestart = durableMeta(env.snapshot);
    assert.equal(metaAfterRestart?.worldlines?.main?.cutoffTurn, 0,
      `${mode}: the rollback cutoff survives a reload`);
    const headAfterRestart = durableHead(env.snapshot);
    assert.equal(headAfterRestart?.throughTurn, 0,
      `${mode}: the reloaded head reflects the rolled-back view`);
    assert.equal(restartedMidway.control.calls.length, 0, `${mode}: reload is non-generative`);
    observation.rollbackDurable = { cutoffAfterRestart: metaAfterRestart?.worldlines?.main?.cutoffTurn ?? null, headThroughTurn: headAfterRestart?.throughTurn ?? null };

    const resumed = await env.api.setWorldManagerWorldline({});
    assert.equal(resumed.ok, true, `${mode}: re-opening the main worldline succeeds`);
    assert.equal(env.fixture.control.calls.length, 0,
      `${mode}: re-opening main costs no model call`);
    observation.resume = { ok: resumed.ok, worldlineId: resumed.meta?.activeWorldlineId ?? null };
    const resumedMeta = durableMeta(env.snapshot);
    assert.equal(resumedMeta?.worldlines?.main?.cutoffTurn, null,
      `${mode}: re-opening main clears the durable cutoff`);

    await assertCanonicalAndSourceUnchanged(env, before, worldRow.id);
    observation.durable = await assertExpectedAuthorityAfterReadback(env, worldRow.id);

    // --- the view is durable across a restart ----------------------------
    const restarted = await env.snapshot.restart();
    const afterRestart = durableHead(env.snapshot);
    assert.ok(afterRestart, `${mode}: the head survives a reload`);
    assert.equal(afterRestart.worldlineId, 'main', `${mode}: the reloaded head is on main`);
    assert.equal(restarted.control.calls.length, 0, `${mode}: reload is non-generative`);
    observation.reload = { worldlineId: afterRestart.worldlineId, modelCalls: restarted.control.calls.length };

    // --- rollback at a COMMITTED BOUNDARY, not only at turn 0 ---------------
    // A02 requires the boundary case as well: with two committed batches the view
    // must be able to stop at the first one, and the second batch must stay in
    // durable storage (a cutoff is a view, never a deletion).
    const { fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
    fiveMore(env.fixture);
    const second = await env.fixture.run();
    assert.equal(second.completed, 1, `${mode}: the second batch commits`);
    const twoBatchHead = durableHead(env.snapshot);
    assert.equal(twoBatchHead.throughTurn, 10, `${mode}: the head now covers ten turns`);
    const callsBeforeBoundary = env.fixture.control.calls.length;
    const boundaryRollback = await env.api.rollbackWorldManagerState({ throughTurn: 5 });
    assert.equal(boundaryRollback.ok, true, `${mode}: rollback to the committed boundary succeeds`);
    const boundaryMeta = durableMeta(env.snapshot);
    assert.equal(boundaryMeta?.worldlines?.main?.cutoffTurn, 5,
      `${mode}: the durable cutoff stops at the committed boundary`);
    assert.equal(durableHead(env.snapshot)?.throughTurn, 5,
      `${mode}: the durable head reflects the boundary cutoff`);
    assert.equal(env.fixture.control.calls.length, callsBeforeBoundary,
      `${mode}: the boundary rollback costs no model call`);
    // The second batch is still recoverable: re-opening main brings it back.
    const reopened = await env.api.setWorldManagerWorldline({});
    assert.equal(reopened.ok, true, `${mode}: re-opening main after a boundary rollback succeeds`);
    assert.equal(durableHead(env.snapshot)?.throughTurn, 10,
      `${mode}: re-opening main restores the full committed range`);
    observation.boundaryRollback = {
      cutoff: boundaryMeta?.worldlines?.main?.cutoffTurn ?? null,
      restoredThroughTurn: durableHead(env.snapshot)?.throughTurn ?? null,
      modelCalls: env.fixture.control.calls.length
    };
    return observation;
  } finally {
    await env.cleanup();
  }
}

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  // The whole point of T01: the same operations reach the same verdict in every
  // mode. The `mode` label itself identifies the row, so it is excluded from the
  // comparison; every observed value stays in it.
  const project = ({ mode, ...rest }) => rest;
  assert.deepEqual(project(results.mirror), project(results.plugin_only),
    'mirror reaches the same State view verdict as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same State view verdict as plugin_only');
  console.log(JSON.stringify({
    test: 'libra_main_memory_state_operations_parity',
    passed: 1,
    boundary: 'real deployed LIBRA public State API + real HTTP/SQLite in three modes; synthetic RisuAI/LLM boundary only',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
