'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
assert.ok(fs.existsSync(path.join(__dirname, '../tools/libra_memory_network.cjs')), 'A1 requires runtime canonical registry wiring');
const { seedSnapshot, finalProofFixture, REQUEST } = require('./fixtures/libra_associative_final_proof_fixture.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const input = () => [{ role: 'user', content: REQUEST }];
const plain = value => JSON.parse(JSON.stringify(value));
// Recreate the approved A0 scorer path by removing only the A1 adapter. During
// validation LIBRA_NETWORK_A0_SOURCE points to the untouched A0 ordinary copy.
const baseline = source => process.env.LIBRA_NETWORK_A0_SOURCE
  ? fs.readFileSync(process.env.LIBRA_NETWORK_A0_SOURCE, 'utf8')
  : source.replace(/^[ \t]*\/\/ BEGIN LIBRA NETWORK CANONICAL ADAPTER[\s\S]*?^[ \t]*\/\/ END LIBRA NETWORK CANONICAL ADAPTER/m, '');
const observation = async f => {
  const supplied = input();
  const delivered = await f.control.hooks.beforeRequest(supplied, 'model');
  const recall = plain(f.r.api.getRuntime().lastMemoryRecall);
  const viewer = plain(f.r.api.getLastMemoryRecallViewer());
  assert.equal(viewer.errorCode || '', '');
  assert.ok(viewer.injectedMemories > 0, 'actual beforeRequest must deliver canonical bytes');
  const context = plain(f.r.api.getLastResponseContext());
  assert.ok(context.requestId, 'issued request nonce stays a separate sidecar');
  assert.equal((await f.r.api.validateResponseContext(context)).current, true);
  assert.ok(Number(recall.at) > 0, 'wall timestamp stays a separate sidecar');
  return { packet: JSON.stringify(delivered), candidates: recall.memories.map(m => m.id),
    candidateCounts: ['candidates', 'catalogCandidates', 'shortlistedCandidates', 'candidateLimitApplied'].map(key => recall.diagnostics[key]),
    scorer: recall.memories.map(({memory, ...row}) => row), sources: viewer.rows.filter(r => r.injected).map(r => [r.memoryId, r.revision, r.selectedText]), diagnostic: f.r.api.getRuntime().lastMemoryNetworkDiagnostics };
};
(async () => {
  const snapshot = await seedSnapshot();
  for (const graph of [false, true]) {
    const before = await finalProofFixture(snapshot, graph, { transformSource: baseline });
    let prior;
    try { prior = await observation(before); } finally { await before.r.cleanup(); }
    const after = await finalProofFixture(snapshot, graph);
    try {
      const actual = await observation(after);
      assert.equal(actual.packet, prior.packet, 'plugin_only final provider packet byte parity after A0');
      assert.deepEqual(actual.candidates, prior.candidates);
      assert.deepEqual(actual.candidateCounts, prior.candidateCounts);
      assert.deepEqual(actual.scorer, prior.scorer, 'existing scorer/excerpt byte-equivalent values survive A1');
      assert.deepEqual(actual.sources, prior.sources);
      assert.ok(actual.diagnostic?.canonicalCandidates > 0, 'actual normal hook must pass candidates through the registry');
      assert.equal(actual.diagnostic.pathBonus, 0);
      assert.equal(after.counts.document, 0);
      assert.equal(after.counts.query, 1);
      assert.equal(actual.diagnostic.identityCoverage, 'partial', 'existing corpus lacks stable source object assignment; no automatic reanalysis');
    } finally { await after.r.cleanup(); }
  }
  // Synthetic restore boundary during the ACTUAL final physical owner read.
  // Canonical A bytes and IDs remain identical; only the live runtime epoch
  // advances. This is a test-only interleaving, never a product/test export.
  const aba = await finalProofFixture(snapshot, true, { transformSource: source => {
    const needle = 'const memory = await storage.getVerifiedJson(proof.recordKey, context.scope, null);';
    assert.equal(source.split(needle).length, 2);
    return source.replace(needle, needle + '\n state.microRestoreGeneration += 4;');
  } });
  try {
    const delivered = await aba.control.hooks.beforeRequest(input(), 'model');
    assert.deepEqual(plain(delivered), input(), 'ABA restores identical physical A but invalidates the old issued readset');
    assert.equal(aba.r.api.getLastMemoryRecallViewer().injectedMemories, 0);
    assert.match(aba.r.api.getLastMemoryRecallViewer().errorCode, /NETWORK.*BINDING/);
  } finally { await aba.r.cleanup(); }
  // One server owner corpus, restarted with the same durable rows and fixed query.
  const server = await serverFixture({ mode: 'server_only', transformSource: baseline });
  try {
    assert.equal((await server.f.run()).completed, 1);
    const before = await observation(server.f);
    // Restart takes the fixture's options by reference; switch only the source adapter.
    await server.f.r.cleanup();
    const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
    const after = await fixture({ args: { memory_suite_server_mode: 'server_only', memory_suite_server_url: server.url }, host: {
      pluginStorage: server.backend, safeLocalStorage: server.backend, getLocalPluginStorage: async () => server.backend,
      nativeFetch: async (url, init) => fetch(url, init)
    } });
    try {
      const actual = await observation(after);
      assert.equal(actual.packet, before.packet, 'server_only final provider packet byte parity after A0');
      assert.deepEqual(actual.candidates, before.candidates);
      assert.deepEqual(actual.candidateCounts, before.candidateCounts);
      assert.deepEqual(actual.scorer, before.scorer);
      assert.deepEqual(actual.sources, before.sources);
      assert.ok(actual.diagnostic?.canonicalCandidates > 0);
    } finally { await after.r.cleanup(); }
    const { fixture: ownerFixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
    const shiftedOwner = await ownerFixture({ args: { memory_suite_server_mode: 'server_only', memory_suite_server_url: server.url },
      host: { pluginStorage: server.backend, safeLocalStorage: server.backend, getLocalPluginStorage: async () => server.backend,
        nativeFetch: async (url, init) => fetch(url, init) },
      transformSource: source => {
        const ownerAtom = 'MemorySuiteStorageBridge.status().serverBinding';
        assert.equal(source.split(ownerAtom).length, 3, 'test controls only the two new-network owner snapshots');
        source = source.replaceAll(ownerAtom,
          "({...MemorySuiteStorageBridge.status().serverBinding, dataInstanceId: state.networkTestOwnerVariant || 'initial-owner'})");
        // Reproduce a collision in the previous owner fingerprint without changing
        // legacy physical proof hashing. Exact currentness must use the raw tuple.
        source = source.replace('const owner = digest(', "const owner = (() => 'synthetic-owner-collision')(");
        source = source.replace('networkFrame = { owner: digest(', "networkFrame = { owner: (() => 'synthetic-owner-collision')(");
        const needle = 'const memory = await storage.getVerifiedJson(proof.recordKey, context.scope, null);';
        assert.equal(source.split(needle).length, 2);
        return source.replace(needle, needle + "\n state.networkTestOwnerVariant = 'changed-owner';");
      } });
    try {
      const delivered = await shiftedOwner.control.hooks.beforeRequest(input(), 'model');
      assert.deepEqual(plain(delivered), input(), 'same-body final read rejects a changed exact owner tuple despite colliding old owner fingerprints');
      assert.equal(shiftedOwner.r.api.getLastMemoryRecallViewer().injectedMemories, 0);
      assert.match(shiftedOwner.r.api.getLastMemoryRecallViewer().errorCode, /NETWORK.*BINDING/);
    } finally { await shiftedOwner.r.cleanup(); }
  } finally { await server.cleanup(); }
  console.log('libra_network_registry_parity_test: PASS (plugin_only graph OFF/ON + server_only)');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
