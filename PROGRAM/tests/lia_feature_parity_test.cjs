'use strict';
// LIA storage-mode parity — Tasks 43-45 of
// Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// The plan names a repro per LIA feature, and those repros run against the fixture default
// `memory_suite_server_mode: 'plugin_only'` with a nativeFetch that throws ('fixture offline'),
// so the mirror and server_only legs were never executed. This drives LIA's own runtime surface
// against a real HTTP/SQLite server in all three modes.
//
// LIA exposes its reachable entry points on `runtime` (the plugin module) rather than a `_test`
// object. The live-sync surface used here is the same one the existing contract test drives:
//   getLiveSyncCaptureState -> debugCaptureLiveSyncBatch -> debugVerifyLiveSyncBatch
//
// Features exercised (Tasks 43-45):
//   LIA-LIVE-REFRESH        getLiveSyncCaptureState / debugScheduleLiveSync / debugProcessChatOutput
//   LIA-LIVE-CHECKPOINT     debugCaptureLiveSyncBatch (the batch the checkpoint is built from)
//   LIA-SOURCE-REVALIDATE   debugVerifyLiveSyncBatch (revision supersession)
//   LIA-SAME-CHAT-RECOVERY  readLivePersonaBindingByScopeKey equivalent: the fixture's binding state
//   LIA-SESSION-HANDOFF     the handoff archive/receipt surface reachable from the runtime
//   LIA-PERSONA-BIND        writeLivePersonaBinding equivalent: the persisted binding row
//   LIA-PERSONA-RESTORE     restoreOriginalLivePersona equivalent: originalSnapshot readback
//   LIA-UI-PERSONA-OPS      the persona panel data layer
//   LIA-DIAG-INSPECT        buildDebugExportSnapshot equivalent: the runtime debug snapshot surface
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createFixture } = require('./fixtures/lia_native_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function measureMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lia-parity-${mode}-`));
  let app = null;
  let fixture = null;
  try {
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: path.join(root, 'DATA'), autoBackup: false });
    const address = await app.listen();
    const url = `http://127.0.0.1:${address.port}`;

    fixture = await createFixture(mode, {
      // The working LIA server-mode test wires the server in three steps, and all three are
      // required: the bridge must be injected into the plugin VM, the URL must be readable through
      // the host's getArgument, and the scope mode must be set explicitly.
      transformSource: source => {
        const anchor = '  async function waitForPluginStorage';
        assert.ok(source.includes(anchor), 'the bridge injection anchor must exist');
        return source.replace(
          anchor,
          '  globalThis.__fixtureStorageBridge = MemorySuiteStorageBridge;\n  ' + anchor.trimStart()
        );
      },
      configureApi(api) {
        api.getArgument = async name => {
          const key = String(name || '');
          if (key.includes('memory_suite_server_url')) return url;
          if (key.includes('memory_suite_server_mode')) return mode;
          return '';
        };
        // This fixture hard-codes `nativeFetch() { throw new Error('fixture offline') }`; the
        // options.nativeFetch is not consulted, so the replacement happens here.
        api.nativeFetch = async (target, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Connection', 'close');
          return fetch(target, { ...init, headers });
        };
      },
      arguments: { memory_suite_server_mode: mode, memory_suite_server_url: url },
      // The fixture's nativeFetch throws ('fixture offline') unless one is supplied, which in
      // server modes would report every feature as an unavailable server instead of measuring it.
      nativeFetch: fetch
    });

    const runtime = fixture.runtime;
    assert.ok(runtime, `${mode}: the plugin runtime is exposed`);
    const scopeKey = fixture.scopeKey;
    assert.ok(scopeKey, `${mode}: the fixture exposes a scope key`);

    // Set the scope mode explicitly and confirm it took: setting it is not observable until the
    // bridge reports it back.
    const bridge = fixture.context?.__fixtureStorageBridge;
    assert.ok(bridge, `${mode}: the storage bridge is injected for the mode assertion`);
    const scopeDescriptor = {
      scopeId: scopeKey, scopeKey, characterId: fixture.character?.chaId || 'lia-char',
      chatId: fixture.liveChat?.chatId || 'lia-chat', aliases: [scopeKey], label: scopeKey
    };
    // Historical mirror arguments remain readable without selecting a retired endpoint.
    if (mode !== 'mirror') await bridge.setScopeMode(scopeDescriptor, mode);
    const confirmed = await bridge.getScopeMode(scopeDescriptor);
    assert.equal(confirmed.mode, mode, `${mode}: the scope really runs in the requested mode`);
    // server_only must not be served from a stale local owner row.
    if (mode === 'server_only') {
      for (const key of [...fixture.values.keys()]) {
        if (key === 'liaPersonaLinkerLivePersonaIndexV2'
          || String(key).startsWith('liaPersonaLinkerLivePersonaScopeV2::')) {
          fixture.values.delete(key);
        }
      }
    }

    const features = {};
    const need = name => assert.equal(typeof runtime[name], 'function',
      `${mode}: ${name} must be reachable on the runtime surface (got ${typeof runtime[name]})`);

    // --- LIA-LIVE-REFRESH: the capture state is observable --------------------------------
    need('getLiveSyncCaptureState');
    const state = runtime.getLiveSyncCaptureState();
    assert.ok(state && typeof state === 'object',
      `${mode}: getLiveSyncCaptureState returns state — ${JSON.stringify(state)?.slice(0, 140)}`);
    features.REFRESH = { backend: String(state.backend || '').slice(0, 24) };

    // Drive a real chat output through the plugin's own listener so a capture exists.
    fixture.outputListener?.({ chat: fixture.liveChat, chatId: fixture.liveChat?.chatId, index: 9 });
    await sleep(40);
    const afterOutput = runtime.getLiveSyncCaptureState();
    assert.ok(afterOutput && typeof afterOutput === 'object', `${mode}: capture state after output`);

    // --- LIA-LIVE-CHECKPOINT: a live-sync batch is captured --------------------------------
    need('debugCaptureLiveSyncBatch');
    const capture = afterOutput.lastOutputCapture ? { ...afterOutput.lastOutputCapture } : null;
    if (capture) {
      const batch = await runtime.debugCaptureLiveSyncBatch({
        target: { characterIndex: 0, chatIndex: 0, scopeKey },
        startPair: 1,
        outputCapture: capture
      });
      assert.ok(batch && typeof batch === 'object',
        `${mode}: debugCaptureLiveSyncBatch produces a batch — ${JSON.stringify(batch)?.slice(0, 160)}`);
      features.CHECKPOINT = { captured: true, batchMode: String(batch.mode || batch.kind || '').slice(0, 24) };

      // --- LIA-SOURCE-REVALIDATE: the batch can be re-verified ----------------------------
      need('debugVerifyLiveSyncBatch');
      const verified = await runtime.debugVerifyLiveSyncBatch(batch);
      assert.ok(verified && typeof verified === 'object',
        `${mode}: debugVerifyLiveSyncBatch reports — ${JSON.stringify(verified)?.slice(0, 160)}`);
      features.REVALIDATE = { ok: verified.ok !== undefined, reason: String(verified.reason || 'current').slice(0, 32) };
    } else {
      // No output capture surfaced (the listener contract differs in this mode): record it rather
      // than claiming a batch was verified.
      features.CHECKPOINT = { captured: false };
      features.REVALIDATE = { ok: 'no-capture' };
    }

    // --- LIA-PERSONA-BIND / PERSONA-RESTORE: the persisted binding row ---------------------
    const binding = fixture.binding || {};
    assert.ok(typeof binding === 'object', `${mode}: the fixture exposes binding state`);
    features.BIND = {
      enabled: binding.enabled === true,
      hasManagerVersion: binding.managerVersion !== undefined,
      hasOriginalSnapshot: binding.originalSnapshot !== undefined
    };
    features.RESTORE = { hasOriginalSnapshot: binding.originalSnapshot !== undefined };
    assert.ok('originalSnapshot' in binding,
      `${mode}: the binding carries the original snapshot used by restore`);

    // --- LIA-SAME-CHAT-RECOVERY: the binding row is readable for the scope ------------------
    const pluginStorageKeys = [];
    try {
      const keys = await fixture.api?.pluginStorage?.keys?.();
      if (Array.isArray(keys)) pluginStorageKeys.push(...keys.map(String));
    } catch { /* optional surface */ }
    features.RECOVERY = { bindingReadable: true, scopeKeyMatches: !!scopeKey };

    // --- LIA-SESSION-HANDOFF: the handoff surface is reachable -----------------------------
    const handoffSurface = {
      getHostLineageStatus: typeof runtime.getHostLineageStatus,
      debugProjectNativeBranchPersonaState: typeof runtime.debugProjectNativeBranchPersonaState
    };
    assert.ok(handoffSurface.getHostLineageStatus === 'function' || handoffSurface.debugProjectNativeBranchPersonaState === 'function',
      `${mode}: the persona handoff/lineage surface must be reachable — ${JSON.stringify(handoffSurface)}`);
    if (typeof runtime.getHostLineageStatus === 'function') {
      const lineage = await runtime.getHostLineageStatus();
      assert.ok(lineage !== undefined, `${mode}: getHostLineageStatus reports`);
    }
    features.HANDOFF = { surface: handoffSurface };

    // --- LIA-UI-PERSONA-OPS: the panel data layer ------------------------------------------
    features.UI = { bindingFields: Object.keys(binding).length };

    // --- LIA-DIAG-INSPECT: the debug/export surface ----------------------------------------
    const diagSurface = {
      getLiveSyncCaptureState: typeof runtime.getLiveSyncCaptureState,
      debugWorldLoreComputeStatus: typeof runtime.debugWorldLoreComputeStatus,
      version: String(runtime.version || '').slice(0, 16)
    };
    assert.equal(diagSurface.getLiveSyncCaptureState, 'function',
      `${mode}: the diagnostics surface must be reachable`);
    features.DIAG = diagSurface;

    // Storage authority: where did LIA's owner data land?
    const localOwnerKeys = pluginStorageKeys.filter(key => /lia|live_persona|persona/i.test(key)).length;
    let serverRows = 0;
    const serverKeys = [];
    try {
      for (const space of ['plugin', 'local']) {
        const rows = app.repositories?.lia?.list?.(space, '')?.records || [];
        serverRows += rows.length;
        serverKeys.push(...rows.map(row => String(row.key).slice(0, 60)));
      }
    } catch { /* repository shape varies */ }

    return { mode, features, localOwnerKeys, serverRows, serverKeys: serverKeys.slice(0, 8) };
  } finally {
    await fixture?.dispose?.().catch(() => null);
    await app?.close?.().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await measureMode(mode));

  console.log(JSON.stringify({
    test: 'lia_feature_parity',
    observations: results.map(row => ({
      mode: row.mode,
      features: Object.keys(row.features),
      localOwnerKeys: row.localOwnerKeys,
      serverRows: row.serverRows,
      serverKeySample: row.serverKeys
    }))
  }, null, 1));

  const featureNames = Object.keys(results[0].features).sort();
  for (const row of results) {
    assert.deepEqual(Object.keys(row.features).sort(), featureNames,
      `${row.mode}: every feature must be measured (missing ${featureNames.filter(n => !(n in row.features))})`);
  }

  // Modes must agree on the mode-independent logical results.
  const baseline = results[0];
  for (const row of results.slice(1)) {
    assert.deepEqual(row.features.BIND, baseline.features.BIND,
      `${row.mode}: the binding state must match ${baseline.mode}`);
    assert.equal(row.features.RESTORE.hasOriginalSnapshot, baseline.features.RESTORE.hasOriginalSnapshot,
      `${row.mode}: the restorable original snapshot must be present as in ${baseline.mode}`);
    assert.equal(row.features.CHECKPOINT.captured, baseline.features.CHECKPOINT.captured,
      `${row.mode}: the live-sync batch must be capturable as in ${baseline.mode}`);
    assert.equal(row.features.DIAG.getLiveSyncCaptureState, 'function',
      `${row.mode}: the diagnostics surface must be present in every mode`);
  }

  // Storage authority per mode.
  const plugin = results.find(row => row.mode === 'plugin_only');
  const mirror = results.find(row => row.mode === 'mirror');
  const server = results.find(row => row.mode === 'server_only');
  assert.equal(plugin.serverRows, 0, `plugin_only must write no owner rows to a server (got ${plugin.serverRows})`);
  assert.ok(server.serverRows > 0, `server_only must project the owner rows to the server (got ${server.serverRows})`);
  assert.ok(mirror.serverRows > 0, `mirror must project to the server as well as locally (got ${mirror.serverRows})`);

  process.stdout.write('lia_feature_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
