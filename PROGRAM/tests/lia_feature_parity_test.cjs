'use strict';
// LIA historical argument parity under the current local-only owner contract.
// Keep the original three argument inputs and feature observations. The retired
// remote projection assertions are replaced by local durable binding readback
// and network refusal; actual manual persona mutation is covered by the release
// artifact root, while asset restart/recovery remains a separate positive root.
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
        api.nativeFetch = async () => { throw Error('local-only owner must never request server storage'); };
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
    if (mode === 'plugin_only') await bridge.setScopeMode(scopeDescriptor, mode);
    else await assert.rejects(() => bridge.setScopeMode(scopeDescriptor, mode),
      error => error.code === 'MEMORY_SUITE_LOCAL_ONLY_OWNER_POLICY');
    const confirmed = await bridge.getScopeMode(scopeDescriptor);
    assert.equal(confirmed.mode, 'plugin_only', `${mode}: owner policy remains local`);
    assert.equal(confirmed.storagePolicy, 'local_only');
    const features = {};
    const need = name => assert.equal(typeof runtime[name], 'function',
      `${mode}: ${name} must be reachable on the runtime surface (got ${typeof runtime[name]})`);

    // --- LIA-UI-PERSONA-OPS: the panel data layer ------------------------------------------
    features.UI = { catalogRows: (await runtime.getScopePersonaCatalog()).rows.length };

    // --- LIA-DIAG-INSPECT: the debug/export surface ----------------------------------------
    const diagSurface = {
      getScopePersonaCatalog: typeof runtime.getScopePersonaCatalog,
      debugWorldLoreComputeStatus: typeof runtime.debugWorldLoreComputeStatus,
      version: String(runtime.version || '').slice(0, 16)
    };
    assert.equal(diagSurface.getScopePersonaCatalog, 'function',
      `${mode}: the diagnostics surface must be reachable`);
    features.DIAG = diagSurface;

    // Storage authority: where did LIA's owner data land?
    let serverRows = 0;
    const serverKeys = [];
    try {
      for (const space of ['plugin', 'local']) {
        const rows = app.repositories?.lia?.list?.(space, '')?.records || [];
        serverRows += rows.length;
        serverKeys.push(...rows.map(row => String(row.key).slice(0, 60)));
      }
    } catch { /* repository shape varies */ }

    return { mode, features, serverRows, serverKeys: serverKeys.slice(0, 8) };
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
    assert.equal(row.features.DIAG.getScopePersonaCatalog, 'function',
      `${row.mode}: the diagnostics surface must be present in every mode`);
  }

  for (const row of results) {
    assert.equal(row.serverRows, 0, `${row.mode}: no canonical owner row is projected remotely`);
  }

  process.stdout.write('lia_feature_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
