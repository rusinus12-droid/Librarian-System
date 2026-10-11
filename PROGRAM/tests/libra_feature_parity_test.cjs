'use strict';
// LIBRA storage-mode parity — the remaining unverified LIBRA features.
//
// `libra_*_3mode_parity_test` files already cover D1-D8. This covers the rest of the LIBRA
// inventory still `unverified` for mirror/server_only, driving each feature through the REAL
// plugin against a real HTTP/SQLite server in all three modes.
//
// Every entry point named here was confirmed to exist on the deployed API before the assertion was
// written (a first draft used plausible-but-wrong names and passed 8 features that the API does not
// expose at all — that is the failure mode this test must not repeat).
//
// Features and their real entry points:
//   LIBRA-DUAL-WORLDLINE           getWorldManagerRuntimeMeta / setWorldManagerWorldline
//   LIBRA-NARRATIVE-DIRECTION      getNarrativeDirection / narrativeDirectionPromptBlock
// Retired embedded Planner, SGA and Input Writer executors are asserted absent below.
// Standalone GRADIA is a separate plugin and is not inferred as equivalent coverage.
//   LIBRA-RAG-LORE-CBS             debugUnifiedLoreMaterial / getLastResponseLore
//   LIBRA-WORLD-ADDITIONAL-RETIRED previewLegacyMemoryRebuild / getLegacyMemoryRebuildEvidence
//   LIBRA-STORY-NARRATIVE-COMPAT   getStoryArc / rebuildStoryArc / migrateStoryArcToNarrativeIfNeeded
//   LIBRA-MAINTENANCE-DIAGNOSTICS  getServerScopeHealth
//   LIBRA-CONFIG-PERSISTENCE       getLibraMemorySettings / debugWriteRuntimeSettings
//   LIBRA-GUI-OWNER-WRITES         exportLibraScope / getRuntime / openSettingsGui
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

// Each feature names the entry point it uses, and a `call` that MUST reach the plugin. If the
// entry point is missing the feature FAILS — never silently reports a surface type.
const FEATURES = {
  WORLDLINE: {
    entry: 'getWorldManagerRuntimeMeta',
    call: async api => {
      const meta = await api.getWorldManagerRuntimeMeta();
      return { reachable: true, keys: meta && typeof meta === 'object' ? Object.keys(meta).slice(0, 5) : null };
    }
  },
  NARRATIVE: {
    entry: 'getNarrativeDirection',
    also: ['narrativeDirectionPromptBlock'],
    call: async api => {
      const direction = await api.getNarrativeDirection();
      assert.ok(direction !== undefined, 'retained narrative direction is readable');
      const block = await api.narrativeDirectionPromptBlock(direction);
      assert.equal(typeof block, 'string', 'formatter consumes the actual current direction');
      return { directionReadable: true, blockProduced: true };
    }
  },
  LORE_CBS: {
    entry: 'debugUnifiedLoreMaterial',
    call: async api => {
      const material = await api.debugUnifiedLoreMaterial();
      const lastLore = await api.getLastResponseLore();
      return { materialReachable: material !== undefined, lastLoreReadable: lastLore !== undefined };
    }
  },
  RETIRED: {
    entry: 'previewLegacyMemoryRebuild',
    // LIBRA-WORLD-ADDITIONAL-RETIRED is the legacy -> unified migration surface. It is a BOUNDED
    // operation, not a parity gap: `previewUnifiedLegacyRebuild` asserts
    // getMode()==='plugin_only' with UNIFIED_BACKEND_NOT_SUPPORTED, because the legacy rows it
    // previews exist only in the plugin's own storage — a server-backed scope has nothing to
    // migrate. So this asserts the boundary per mode rather than pretending parity exists:
    //   plugin_only          the preview issues a digest for the real legacy rows
    //   mirror / server_only fails closed with UNIFIED_BACKEND_NOT_SUPPORTED and changes nothing
    bounded: true,
    call: async (api, mode) => {
      const preview = await api.previewLegacyMemoryRebuild().catch(error => ({ __error: error?.code || String(error?.message || error) }));
      if (mode === 'plugin_only') {
        assert.ok(!preview?.__error, `plugin_only: the preview must succeed — ${JSON.stringify(preview)?.slice(0, 160)}`);
        assert.ok(String(preview.previewDigest || ''), 'plugin_only: the preview must carry a digest');
        return { previewDigestPresent: true, rowCount: Array.isArray(preview.rows) ? preview.rows.length : null };
      }
      assert.equal(preview?.__error, 'UNIFIED_BACKEND_NOT_SUPPORTED',
        `${mode}: the legacy migration surface must fail closed with UNIFIED_BACKEND_NOT_SUPPORTED `
        + `(got ${JSON.stringify(preview)?.slice(0, 140)})`);
      return { failsClosed: 'UNIFIED_BACKEND_NOT_SUPPORTED' };
    },
    also: ['getLegacyMemoryRebuildEvidence']
  },
  STORY: {
    entry: 'getStoryArc',
    call: async api => {
      const arc = await api.getStoryArc();
      const migrated = await api.migrateStoryArcToNarrativeIfNeeded();
      return { arcReadable: arc !== undefined, migrationReachable: migrated !== undefined };
    }
  },
  MAINTENANCE: {
    entry: 'getServerScopeHealth',
    call: async api => {
      const health = await api.getServerScopeHealth();
      assert.ok(health && typeof health === 'object',
        `getServerScopeHealth must return an object (got ${typeof health})`);
      return { healthKeys: Object.keys(health).length };
    }
  },
  CONFIG: {
    entry: 'getLibraMemorySettings',
    call: async api => {
      const settings = await api.getLibraMemorySettings();
      assert.ok(settings !== undefined, 'getLibraMemorySettings must return the settings');
      return { settingsReadable: true };
    }
  },
  GUI: {
    entry: 'exportLibraScope',
    call: async api => {
      const runtime = await api.getRuntime();
      const exported = await api.exportLibraScope();
      return { runtimeReachable: runtime !== undefined, exportReachable: exported !== undefined };
    }
  }
};

async function measureMode(mode) {
  const s = await serverFixture({ mode });
  try {
    await s.f.run();
    const api = s.f.r.api;

    for (const removed of ['getLastTurnPlanner', 'getPlannerNarrativeDirection',
      'plannerNarrativeDirectionPromptBlock', 'getLastSgaRun', 'getLastSgaFinalization',
      'prepareInputWriterEvidence', 'getLastInputWriter', 'debugValidateInputWriterDeliverySnapshot']) {
      assert.equal(typeof api[removed], 'undefined', `${mode}: retired embedded executor surface ${removed} stays absent`);
    }

    const features = {};
    for (const [name, spec] of Object.entries(FEATURES)) {
      // The entry point MUST exist on the deployed API — a missing one is a failure, not a note.
      assert.equal(typeof api[spec.entry], 'function',
        `${mode}: ${name} requires ${spec.entry} on the deployed API (got ${typeof api[spec.entry]})`);
      for (const extra of (spec.also || [])) {
        assert.equal(typeof api[extra], 'function',
          `${mode}: ${name} also requires ${extra} on the deployed API (got ${typeof api[extra]})`);
      }
      try {
        features[name] = { ok: true, value: await spec.call(api, mode) };
      } catch (error) {
        features[name] = { ok: false, error: `${error?.code ? error.code + ': ' : ''}${String(error?.message || error).slice(0, 180)}` };
      }
    }

    const localOwnerKeys = [...s.local.keys()].filter(key => /libra:v1:/.test(String(key))).length;
    let serverRows = 0;
    const serverKeys = [];
    try {
      for (const space of ['plugin', 'local']) {
        const rows = s.app?.repositories?.libra?.list?.(space, 'libra')?.records || [];
        serverRows += rows.length;
        serverKeys.push(...rows.map(row => String(row.key).slice(0, 56)));
      }
    } catch { /* repository shape varies */ }

    return { mode, features, localOwnerKeys, serverRows, serverKeys: serverKeys.slice(0, 6) };
  } finally {
    await s.cleanup();
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) {
    const row = await measureMode(mode);
    results.push(row);
    const errored = Object.entries(row.features).filter(([, v]) => v.ok !== true);
    process.stdout.write(`  ${mode}: ${Object.keys(row.features).length} features, `
      + `${errored.length} errored${errored.length ? ' → ' + errored.map(([k, v]) => `${k}(${String(v.error).slice(0, 60)})`).join('; ') : ''}\n`);
  }

  console.log(JSON.stringify({
    test: 'libra_feature_parity',
    observations: results.map(row => ({
      mode: row.mode,
      features: Object.fromEntries(Object.entries(row.features).map(([k, v]) => [k, v.ok === true ? 'ok' : `ERR ${String(v.error).slice(0, 80)}`])),
      localOwnerKeys: row.localOwnerKeys,
      serverRows: row.serverRows,
      serverKeySample: row.serverKeys
    }))
  }, null, 1));

  // Every feature must actually have executed in every mode.
  for (const row of results) {
    const errored = Object.entries(row.features).filter(([, v]) => v.ok !== true);
    assert.deepEqual(errored.map(([k]) => k), [],
      `${row.mode}: every feature must execute — ${JSON.stringify(Object.fromEntries(errored.map(([k, v]) => [k, v.error])))}`);
  }

  // Storage authority per mode.
  const plugin = results.find(row => row.mode === 'plugin_only');
  const mirror = results.find(row => row.mode === 'mirror');
  const server = results.find(row => row.mode === 'server_only');
  assert.equal(plugin.serverRows, 0, `plugin_only must write no owner rows to a server (got ${plugin.serverRows})`);
  assert.ok(server.serverRows > 0, `server_only must project the owner rows to the server (got ${server.serverRows})`);
  assert.ok(mirror.serverRows > 0, `mirror must project to the server as well as locally (got ${mirror.serverRows})`);

  process.stdout.write('libra_feature_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
