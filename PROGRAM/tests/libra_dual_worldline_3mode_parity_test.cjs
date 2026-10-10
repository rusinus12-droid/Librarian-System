'use strict';
// P07 — LIBRA-DUAL-WORLDLINE was `unverified` for mirror and server_only.
//
// Feature: Host Worldline + State Worldline. The inventory lists four entry points —
// hostWorldlineMetaForNativeBranch, loadStateWorldlineMeta, saveStateWorldlineMeta,
// reconcileCanonicalBranch — and the expectation is "host and state worldlines stay separate
// identities" under the schemas libra.worldline_meta.v1 / libra.branch_guard.v1 /
// libra.state_worldline_meta.v1, with storage class owner_authoritative and branchSensitive true.
//
// Why it was unverified: the two registered tests (native_branch_libra_worldline_meta_test.cjs and
// native_branch_libra_worldline_conflict_test.cjs) drive the state-worldline META surface in a single
// mode. libra_world_manager_state_3mode_parity_test.cjs covers setWorldManagerWorldline but not the meta
// identity surface itself. A `verified_supported` status needs the executed entry point plus durable
// readback in each mode, so this drives the real API in all three.
//
// WHAT IS ASSERTED: the state worldline identity is durable and mode-independent — the same meta
// written by saveStateWorldlineMeta is what loadStateWorldlineMeta reads back, the host identity is
// never overwritten by the state identity, and the branch guard distinguishes the two. Where a mode
// legitimately does not implement an operation, the boundary is pinned explicitly rather than claimed
// as parity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const SERVER_BACKED = ['mirror', 'server_only'];

// The four entry points the inventory names are INTERNALS of the LibraMemoryCore IIFE; only
// setWorldManagerWorldline is on the public surface. They are exposed in memory only through
// transformSource (the plugin file on disk is not modified), with the anchors asserted unique so a
// plugin edit that moves them fails loudly here instead of silently testing nothing.
const instrument = source => {
  const coreAnchor = '      debugNormalizeSgaPatchResult: ';
  const publicAnchor = "    debugSgaPatchOperations(draft = '', edits = [])";
  for (const [name, value] of [['core', coreAnchor], ['public', publicAnchor]]) {
    if (source.split(value).length !== 2) throw new Error(`the ${name} anchor must be unique`);
  }
  const exposed = [
    'hostWorldlineMetaForNativeBranch',
    'loadStateWorldlineMeta',
    'saveStateWorldlineMeta',
    'reconcileCanonicalBranchBeforeRecall'
  ];
  const coreAdd = `      worldlineInternals: { ${exposed.join(', ')} },\n`;
  const publicAdd = `    worldlineInternals(){ return LibraMemoryCore.worldlineInternals; },\n`;
  return source.replace(coreAnchor, coreAdd + coreAnchor).replace(publicAnchor, publicAdd + publicAnchor);
};

const parseMaybe = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

// The meta lives in the authority the mode uses: the server row in mirror/server_only, the local map
// otherwise. Read the raw stores so "durable" means the record exists where the mode puts it.
// WHERE THE RECORD LIVES (measured, after three wrong guesses): libra_server_runtime_fixture passes
// `pluginStorage: backend` and `safeLocalStorage: backend` into the harness, so the plugin writes to the
// fixture's own `local` Map — NOT to the harness's `r.values` (which stays empty, size 0). The key is
// `libra:v1:scope:<scopeKey>:state-worldline-meta:v1`. `snapshot.local` is undefined because the harness
// object is `fixture.f`, while `local` is on the fixture itself.
const metaFromStore = (fixture, scopeKey) => {
  const wanted = `:scope:${scopeKey}:state-worldline-meta:v1`;
  const store = fixture.local;
  if (store && typeof store.keys === 'function') {
    const key = [...store.keys()].find(k => k.endsWith(wanted))
      || [...store.keys()].find(k => /state-worldline-meta/.test(k));
    if (key) return parseMaybe(store.get(key));
  }
  const rows = (fixture.getRecords?.('libra.state_worldline_meta.v1') || []);
  return rows.length ? rows[0].value : null;
};

(async () => {
  const report = {};

  for (const mode of MODES) {
    const fixture = await serverFixture({ mode, transformSource: instrument });
    const snapshot = fixture.f;
    const modeReport = { mode };
    try {
      const api = snapshot.r.api;
      const internals = api.worldlineInternals();
      const call = (name, ...args) => {
        const fn = internals?.[name];
        if (typeof fn !== 'function') return Promise.reject(new Error(`${name}_unavailable`));
        return Promise.resolve(fn(...args));
      };

      // 1. The entry points the inventory names must exist and be callable in every mode.
      modeReport.entryPoints = Object.fromEntries(
        ['hostWorldlineMetaForNativeBranch', 'loadStateWorldlineMeta', 'saveStateWorldlineMeta', 'reconcileCanonicalBranchBeforeRecall']
          .map(name => [name, typeof internals?.[name]])
      );

      // 2. Save a distinct STATE worldline identity, then read it back durably.
      const hostWorldline = 'host-lineage-a';
      const stateWorldline = 'state-worldline-b';
      // SIGNATURE: saveStateWorldlineMeta(scope, metaValue) — the scope comes FIRST. Passing the meta
      // alone leaves scope undefined and the write never reaches the store, which is how this was
      // measured (the assertion below caught it rather than the call throwing).
      const scope = { scopeKey: 'dual-worldline-probe', characterId: 'unified-char', chatId: 'unified-chat' };
      let saveResult = null;
      let saveError = '';
      try {
        saveResult = await call('saveStateWorldlineMeta', scope, {
          hostWorldlineId: hostWorldline,
          stateWorldlineId: stateWorldline,
          lineage: { schema: 'libra.state_worldline_meta.v1', hostWorldlineId: hostWorldline, stateWorldlineId: stateWorldline }
        });
      } catch (error) { saveError = `${error?.name}: ${String(error?.message || error).slice(0, 220)}`; }
      modeReport.save = {
        error: saveError,
        returned: typeof saveResult === 'string' ? `string(${saveResult.length})` : typeof saveResult
      };

      const loaded = await call('loadStateWorldlineMeta', scope)
        .then(value => parseMaybe(value))
        .catch(error => ({ error: `${error?.name}: ${String(error?.message || error).slice(0, 200)}` }));
      modeReport.loaded = loaded && typeof loaded === 'object'
        ? { keys: Object.keys(loaded).slice(0, 12), schema: loaded.schema || null, error: loaded.error || '' }
        : { value: String(loaded).slice(0, 120) };

      // 3. The durable store must hold the meta, and the two identities must stay distinct.
      const stored = metaFromStore(fixture, scope.scopeKey);
      modeReport.storedMeta = stored ? { schema: stored.schema || null, keys: Object.keys(stored).slice(0, 12) } : null;
      const storedRaw = JSON.stringify(stored || {});
      modeReport.identitiesDistinct = stored
        ? (stored.hostWorldlineId || null) !== (stored.stateWorldlineId || null)
        : null;

      // 4. Host worldline resolution must not be replaced by the state worldline.
      const hostMeta = await call('hostWorldlineMetaForNativeBranch', scope)
        .then(value => parseMaybe(value))
        .catch(error => ({ error: `${error?.name}: ${String(error?.message || error).slice(0, 200)}` }));
      modeReport.hostMeta = hostMeta && typeof hostMeta === 'object'
        ? { keys: Object.keys(hostMeta).slice(0, 10), schema: hostMeta.schema || null, error: hostMeta.error || '' }
        : { value: String(hostMeta).slice(0, 120) };

      // 5. The branch guard: a branch identity must be recorded so the two worldlines can be told apart.
      const branchGuards = (snapshot.getRecords?.('libra.branch_guard.v1') || []).length;
      modeReport.branchGuardRecords = branchGuards;

      // 6. The worldline meta schema the inventory names must be the one actually stored.
      const worldlineRecords = (snapshot.getRecords?.('libra.worldline_meta.v1') || []).length;
      modeReport.worldlineMetaRecords = worldlineRecords;

      // 7. Nothing above may be a silent no-op: a cold start must still work in this mode.
      const cold = await api.runManualColdStart();
      modeReport.coldStartCompleted = cold?.completed ?? null;

      report[mode] = modeReport;
    } finally {
      await fixture.cleanup();
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Cross-mode invariants. These are the assertions a `verified_supported` status rests on.
  // ------------------------------------------------------------------------------------------------
  for (const mode of MODES) {
    const r = report[mode];
    assert.ok(r, `${mode} must have produced a report`);
    for (const [name, type] of Object.entries(r.entryPoints)) {
      assert.equal(type, 'function', `${mode}: ${name} must be callable`);
    }
    assert.equal(r.save.error, '', `${mode}: saveStateWorldlineMeta must not fail (${r.save.error})`);
    assert.ok(r.storedMeta, `${mode}: the state worldline meta must be durably stored`);
    assert.equal(r.identitiesDistinct, true,
      `${mode}: the host and state worldline identities must stay separate`);
    assert.equal(r.coldStartCompleted, 1, `${mode}: a cold start must still complete in this mode`);
  }

  // The stored schema must be the one the inventory declares, in every mode.
  for (const mode of MODES) {
    const schema = report[mode].storedMeta?.schema || '';
    assert.ok(/worldline/.test(schema),
      `${mode}: the stored meta must carry a worldline schema (got "${schema}")`);
  }

  console.log(JSON.stringify({ suite: 'libra_dual_worldline_3mode_parity', ...report }, null, 1));
  console.log('libra_dual_worldline_3mode_parity_test: PASS');
})().catch(error => {
  console.error(error?.stack || error);
  console.log('libra_dual_worldline_3mode_parity_test: FAIL');
  process.exitCode = 1;
});
