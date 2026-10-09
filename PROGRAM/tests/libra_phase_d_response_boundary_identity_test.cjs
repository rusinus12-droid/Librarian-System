'use strict';

// Exercise the response-specific authority boundary: derived metadata may advance
// without changing response authority, while canonical ref identity changes reject.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const exposeResponseBoundary = source => {
  const coreAnchor = '      getUnifiedStorageStatus,';
  const apiAnchor = '    async getUnifiedStorageStatus() { return safeClone(await LibraMemoryCore.getUnifiedStorageStatus()); },';
  assert.ok(source.includes(coreAnchor), 'core debug injection anchor must exist');
  assert.ok(source.includes(apiAnchor), 'public debug injection anchor must exist');
  source = source.replace(coreAnchor,
    '      debugPhaseDResponseBoundary: async () => captureUnifiedResponseBoundary(await resolveContext()),\n' +
    '      debugPhaseDAssertResponseBoundary: boundary => assertUnifiedResponseBoundary(boundary),\n' + coreAnchor);
  return source.replace(apiAnchor,
    '    async debugPhaseDResponseBoundary() { return safeClone(await LibraMemoryCore.debugPhaseDResponseBoundary()); },\n' +
    '    async debugPhaseDAssertResponseBoundary(boundary) { return safeClone(await LibraMemoryCore.debugPhaseDAssertResponseBoundary(boundary)); },\n' + apiAnchor);
};

(async () => {
  const f = await fixture({ transformSource: exposeResponseBoundary });
  try {
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    const api = f.r.api;
    const boundary = await api.debugPhaseDResponseBoundary();
    const manifestKey = [...f.r.values.keys()].find(key => String(key).endsWith(':manifest'));
    assert.ok(manifestKey, 'canonical manifest exists in the plugin-only fixture');
    const manifest = JSON.parse(f.r.values.get(manifestKey));
    const start = Object.keys(manifest.memories || {})[0];
    const ref = manifest.memories[start];
    assert.ok(ref?.key && ref?.revision, 'canonical pointer has key and revision');

    const derived = JSON.parse(JSON.stringify(manifest));
    derived.memories[start].embeddingStatus = 'disabled';
    derived.memories[start].retrievalVersion = 'derived-refresh-v2';
    derived.memories[start].vectorCount = 7;
    derived.memories[start].updatedAt = '2099-01-01T00:00:00.000Z';
    await f.r.context.risuai.pluginStorage.setItem(manifestKey, JSON.stringify(derived));
    assert.equal(await api.debugPhaseDAssertResponseBoundary(boundary), true,
      'derived-only manifest metadata changes preserve response authority');

    const canonicalMutation = JSON.parse(JSON.stringify(derived));
    canonicalMutation.memories[start].revision += 1;
    await f.r.context.risuai.pluginStorage.setItem(manifestKey, JSON.stringify(canonicalMutation));
    await assert.rejects(api.debugPhaseDAssertResponseBoundary(boundary),
      error => /UNIFIED_RESPONSE_AUTHORITY_CHANGED/.test(String(error?.message || error)),
      'canonical revision changes are rejected by the response boundary');

    console.log(JSON.stringify({ test: 'libra_phase_d_response_boundary_identity',
      status: 'PASS', derivedMetadata: 'allowed', canonicalRevisionMutation: 'rejected',
      sameFixture: true, boundary: 'captured production response boundary, test-only debug access' }));
  } finally {
    await f.r.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
