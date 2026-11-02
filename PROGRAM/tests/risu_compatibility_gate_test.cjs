'use strict';
/**
 * Targeted Positive & Negative Regression Suite for the RisuAI Compatibility Gate
 *
 * Covers the 9 mandatory regression scenarios from the specification:
 * 1. New unmapped RisuAI API usage (static AST & runtime Proxy) -> FAIL
 * 2. Upstream API signature incompatible fixture -> FAIL
 * 3. Critical implementation drift -> FAIL (`RISUAI_UPSTREAM_SEMANTIC_DRIFT`)
 * 4. IPC `allowed-ipc` mismatch -> FAIL (`IPC_ALLOWED_IPC_MISMATCH`)
 * 5. Minification directive loss -> FAIL (`MINIFICATION_DIRECTIVE_LOSS`)
 * 6. `plugin_only` server canonical write -> FAIL (`PLUGIN_ONLY_SERVER_CANONICAL_REQUEST_FORBIDDEN`)
 * 7. `server_only` local `pluginStorage` canonical write -> FAIL (`SERVER_ONLY_LOCAL_CANONICAL_WRITE_FORBIDDEN`)
 * 8. `server_only` + server offline local fallback -> FAIL (`SERVER_ONLY_OFFLINE_FALLBACK_FORBIDDEN`)
 * 9. Normal pinned contract + release artifacts + storage authority + H06 replay -> PASS
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { analyzePluginSource } = require('../tools/risu_api_usage_inventory.cjs');
const {
  loadCompatibilityPack,
  verifyApiSurfaceContract,
  verifyRuntimeSemantics,
  verifyLoaderAndIpcContracts,
  checkUpstreamDrift
} = require('../tools/risu_contract_verifier.cjs');
const { createContractBackedHostCluster } = require('../tools/risu_contract_host.cjs');
const {
  SERVER_BACKED_OWNERS,
  verifyPluginOnlyAuthorityContract,
  verifyServerOnlyAuthorityAndFailClosedContract,
  verifyLiaLocalOnlyAuthorityContract,
  verifyStorageAuthorityOwnerMatrix,
  verifyStorageTransitionContract,
  runH06CompatibilityReplay
} = require('../tools/risu_compatibility_gate.cjs');

const programDir = path.resolve(__dirname, '..');
const contractsDir = path.join(programDir, 'contracts', 'risuai');

test('1. Unmapped RisuAI API usage fails both static contract verification and runtime contract-backed host', async () => {
  const pack = loadCompatibilityPack(contractsDir);

  // 1a. Static AST detection of unmapped API call via alias/helper
  const syntheticPluginWithUnmappedApi = `
    //@name libra
    //@api 3.0
    //@version 1.0.0
    (async () => {
      const host = globalThis.risuai || Risuai;
      await host.unmappedExperimentalRisuApi('arg');
    })();
  `;
  const analysis = analyzePluginSource(syntheticPluginWithUnmappedApi);
  assert.ok(analysis.apis.includes('unmappedExperimentalRisuApi'));

  assert.throws(
    () => verifyApiSurfaceContract(pack.apiSurface, {
      apis: { unmappedExperimentalRisuApi: { owners: ['libra'] } }
    }),
    err => err.code === 'UNMAPPED_RISUAI_API_USAGE'
  );

  // 1b. Runtime Proxy trap on contract-backed host
  const cluster = createContractBackedHostCluster({ contractsDir });
  const handle = cluster.createHostForPlugin({ name: 'libra' });
  assert.throws(
    () => handle.api.unmappedExperimentalRisuApi('arg'),
    err => err.code === 'UNMAPPED_RISUAI_API_CALL'
  );
});

test('2. Upstream API signature incompatibility fails with RISUAI_API_SIGNATURE_INCOMPATIBLE', () => {
  const pack = loadCompatibilityPack(contractsDir);
  const mutatedUpstream = {
    dtsSurface: JSON.parse(JSON.stringify(pack.apiSurface.hostSurface))
  };
  // Mutate getChatFromIndex to require 3 arguments instead of 2
  mutatedUpstream.dtsSurface.getChatFromIndex.requiredArgs = 3;

  assert.throws(
    () => verifyApiSurfaceContract(
      pack.apiSurface,
      { apis: { getChatFromIndex: { owners: ['libra'] } } },
      mutatedUpstream
    ),
    err => err.code === 'RISUAI_API_SIGNATURE_INCOMPATIBLE'
  );
});

test('3. Critical implementation drift fails with RISUAI_UPSTREAM_SEMANTIC_DRIFT', () => {
  const pack = loadCompatibilityPack(contractsDir);
  const driftedUpstream = {
    runtimeSemantics: JSON.parse(JSON.stringify(pack.runtimeSemantics.methods))
  };
  driftedUpstream.runtimeSemantics.postPluginChannelMessage.implementationFingerprint =
    '0000000000000000000000000000000000000000000000000000000000000000';

  assert.throws(
    () => verifyRuntimeSemantics(pack.runtimeSemantics, driftedUpstream),
    err => err.code === 'RISUAI_UPSTREAM_SEMANTIC_DRIFT'
  );
});

test('4. IPC allowed-ipc mismatch fails static verification and is blocked at runtime by contract host', async () => {
  const pack = loadCompatibilityPack(contractsDir);

  // 4a. Static verification failure when an expected //@allowed-ipc peer is missing
  const tempPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-ipc-mismatch-'));
  try {
    for (const file of fs.readdirSync(path.join(programDir, 'plugins'))) {
      if (!file.endsWith('.js')) continue;
      let text = fs.readFileSync(path.join(programDir, 'plugins', file), 'utf8');
      if (file === 'LIBRA.js') {
        // Strip //@allowed-ipc directives from LIBRA.js
        text = text.replace(/^\/\/@allowed-ipc[^\n]*\n/gm, '');
      }
      fs.writeFileSync(path.join(tempPluginDir, file), text, 'utf8');
    }

    assert.throws(
      () => verifyLoaderAndIpcContracts(pack.pluginLoaderContract, pack.ipcContract, {
        sourcePluginDir: tempPluginDir
      }),
      err => err.code === 'IPC_ALLOWED_IPC_MISMATCH'
    );
  } finally {
    fs.rmSync(tempPluginDir, { recursive: true, force: true });
  }

  // 4b. Runtime IPC enforcement when sender or receiver lacks mutual allowedIPC
  const cluster = createContractBackedHostCluster({ contractsDir });
  const sender = cluster.createHostForPlugin({
    name: 'plugin_sender',
    allowedIPC: ['plugin_receiver']
  });
  const receiver = cluster.createHostForPlugin({
    name: 'plugin_receiver',
    allowedIPC: [] // receiver does NOT allow plugin_sender
  });

  let received = false;
  await receiver.api.addPluginChannelListener('test_channel', () => {
    received = true;
  });
  await sender.api.postPluginChannelMessage('plugin_receiver', 'test_channel', { hello: 'world' });
  assert.equal(received, false, 'IPC message must be blocked when receiver does not allow sender');
  assert.ok(cluster.ipcWarnings.some(w => w.code === 'IPC_ALLOWED_IPC_MISMATCH'));
});

test('5. Minification directive loss fails with MINIFICATION_DIRECTIVE_LOSS', () => {
  const pack = loadCompatibilityPack(contractsDir);
  const tempArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-minify-loss-'));
  try {
    for (const file of fs.readdirSync(path.join(programDir, 'plugins'))) {
      if (!file.endsWith('.js')) continue;
      let text = fs.readFileSync(path.join(programDir, 'plugins', file), 'utf8');
      if (file === 'HAYAKU_Locator_Continuity.js') {
        // Simulate minifier stripping one //@arg directive
        text = text.replace(/^\/\/@arg\s+\S+[^\n]*\n/m, '');
      }
      fs.writeFileSync(path.join(tempArtifactDir, file), text, 'utf8');
    }

    assert.throws(
      () => verifyLoaderAndIpcContracts(pack.pluginLoaderContract, pack.ipcContract, {
        artifactPluginDir: tempArtifactDir
      }),
      err => err.code === 'MINIFICATION_DIRECTIVE_LOSS'
    );
  } finally {
    fs.rmSync(tempArtifactDir, { recursive: true, force: true });
  }
});

test('6. plugin_only server canonical write fails with PLUGIN_ONLY_SERVER_CANONICAL_REQUEST_FORBIDDEN', async () => {
  await assert.rejects(
    () => verifyPluginOnlyAuthorityContract({
      contractsDir,
      simulateForbiddenServerCanonicalWrite: async (api) => {
        await api.nativeFetch('http://127.0.0.1:65534/v1/kv/set', { method: 'POST' });
      }
    }),
    err => err.code === 'PLUGIN_ONLY_SERVER_CANONICAL_REQUEST_FORBIDDEN'
  );
});

test('7. server_only local pluginStorage canonical write fails with SERVER_ONLY_LOCAL_CANONICAL_WRITE_FORBIDDEN', async () => {
  await assert.rejects(
    () => verifyServerOnlyAuthorityAndFailClosedContract({
      contractsDir,
      simulateForbiddenLocalCanonicalWrite: async (pluginStorage) => {
        await pluginStorage.setItem('scope:s2:canonical:illegal-local-write', { leaked: true });
      }
    }),
    err => err.code === 'SERVER_ONLY_LOCAL_CANONICAL_WRITE_FORBIDDEN'
  );
});

test('8. server_only + server offline local fallback fails with SERVER_ONLY_OFFLINE_FALLBACK_FORBIDDEN', async () => {
  await assert.rejects(
    () => verifyServerOnlyAuthorityAndFailClosedContract({
      contractsDir,
      simulateForbiddenOfflineLocalFallback: async (pluginStorage) => {
        await pluginStorage.setItem('scope:s2:canonical:illegal-offline-fallback', { fallback: true });
      }
    }),
    err => err.code === 'SERVER_ONLY_OFFLINE_FALLBACK_FORBIDDEN'
  );
});

test('9. Pinned compatibility contract + storage authority (plugin_only, server_only, fail-closed, transitions) + H06 replay pass', async () => {
  const pluginOnly = await verifyPluginOnlyAuthorityContract({ contractsDir });
  assert.equal(pluginOnly.ok, true);
  assert.equal(pluginOnly.serverCanonicalRequests, 0);

  const serverOnly = await verifyServerOnlyAuthorityAndFailClosedContract({ contractsDir });
  assert.equal(serverOnly.ok, true);
  assert.equal(serverOnly.localCanonicalWrites, 0);
  assert.equal(serverOnly.serverOfflineFailClosedVerified, true);

  const transition = await verifyStorageTransitionContract({ contractsDir });
  assert.equal(transition.ok, true);
  assert.equal(transition.pluginToServerVerified, true);
  assert.equal(transition.failedCutoverPreservesAuthority, true);
  assert.equal(transition.serverToPluginVerified, true);

  const replay = await runH06CompatibilityReplay({ contractsDir });
  assert.equal(replay.ok, true);
  assert.equal(replay.scenarioCount, 8);
});

test('10. Storage authority owner matrix covers server-backed owners (libra, hayaku, flashback) and LIA local-only policy', async () => {
  assert.deepEqual(SERVER_BACKED_OWNERS, ['libra', 'hayaku', 'flashback']);

  for (const owner of SERVER_BACKED_OWNERS) {
    const pluginOnly = await verifyPluginOnlyAuthorityContract({ contractsDir, owner });
    assert.equal(pluginOnly.ok, true);
    assert.equal(pluginOnly.owner, owner);
    assert.equal(pluginOnly.serverCanonicalRequests, 0, `${owner}: server canonical requests must be 0 in plugin_only`);

    const serverOnly = await verifyServerOnlyAuthorityAndFailClosedContract({ contractsDir, owner });
    assert.equal(serverOnly.ok, true);
    assert.equal(serverOnly.owner, owner);
    assert.equal(serverOnly.localCanonicalWrites, 0, `${owner}: local canonical writes must be 0 in server_only`);
    assert.equal(serverOnly.serverDigestVerified, true);
    assert.equal(serverOnly.serverOfflineFailClosedVerified, true);
  }

  // LIA local-only policy verification
  const liaResult = await verifyLiaLocalOnlyAuthorityContract({ contractsDir });
  assert.equal(liaResult.ok, true);
  assert.equal(liaResult.owner, 'lia');
  assert.equal(liaResult.pluginOnlyVerified, true);
  assert.equal(liaResult.serverOnlyRejectedWithLocalOnlyPolicy, true);
});

test('11. H06 scenarios clearly distinguish Product-path replay (4) and Contract fixture validation (4)', async () => {
  const replay = await runH06CompatibilityReplay({ contractsDir });
  assert.equal(replay.ok, true);
  assert.equal(replay.scenarioCount, 8);

  // Product-path replay scenarios (calls actual Librarian SDK/plugin/host path)
  assert.equal(replay.productPathReplay.total, 4);
  assert.equal(replay.productPathReplay.passed, 4);
  assert.deepEqual(replay.productPathReplay.scenarios, ['H06-01', 'H06-02', 'H06-04', 'H06-06']);

  // Contract fixture validation scenarios (validates synthetic fixture invariants)
  assert.equal(replay.contractFixtureValidation.total, 4);
  assert.equal(replay.contractFixtureValidation.passed, 4);
  assert.deepEqual(replay.contractFixtureValidation.scenarios, ['H06-03', 'H06-05', 'H06-07', 'H06-08']);

  for (const s of replay.scenarios) {
    if (['H06-01', 'H06-02', 'H06-04', 'H06-06'].includes(s.scenarioId)) {
      assert.equal(s.kind, 'product_path_replay');
      assert.equal(s.actualLibrarianReplay, true);
    } else {
      assert.equal(s.kind, 'contract_fixture_validation');
      assert.equal(s.actualLibrarianReplay, false);
    }
  }
});

test('12. Upstream drift report schema conforms to normalized specification with guaranteed array fields', () => {
  const pack = loadCompatibilityPack(contractsDir);

  // Create a synthetic clean upstream directory matching pinned lock hashes
  const tempUpstreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-drift-clean-'));
  try {
    for (const [relFile, expectedHash] of Object.entries(pack.upstreamLock.files || {})) {
      const full = path.join(tempUpstreamDir, ...relFile.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // Write content that satisfies sha256File hash
      // If we don't have matching content, checkUpstreamDrift marks it modified/missing, which still tests the schema!
      fs.writeFileSync(full, 'upstream-stub', 'utf8');
    }

    const report = checkUpstreamDrift({
      contractsDir,
      upstreamDir: tempUpstreamDir,
      headCommit: 'test-head-sha'
    });

    assert.equal(report.schema, 'librarian.risu-upstream-drift-report.v1');
    assert.ok(report.status === 'compatible_pin_current' || report.status === 'upstream_review_required');
    assert.equal(report.lockedCommit, pack.upstreamLock.commit);
    assert.equal(report.pinnedCommit, pack.upstreamLock.commit);
    assert.equal(report.headCommit, 'test-head-sha');

    // Invariant: all summary array fields exist and are Arrays (never undefined)
    assert.ok(Array.isArray(report.changedFiles), 'changedFiles must be Array');
    assert.ok(Array.isArray(report.missingUsedApis), 'missingUsedApis must be Array');
    assert.ok(Array.isArray(report.signatureChanges), 'signatureChanges must be Array');
    assert.ok(Array.isArray(report.semanticDrift), 'semanticDrift must be Array');
  } finally {
    fs.rmSync(tempUpstreamDir, { recursive: true, force: true });
  }
});
