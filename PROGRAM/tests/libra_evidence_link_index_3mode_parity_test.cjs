'use strict';
// The evidence link index is a projection of canonical memory, so it must not depend on
// where canonical memory happens to live. All three storage modes must produce the same
// view, and server_only must hold it through the server path only: the index may never
// become a second local copy of canonical memory.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const INDEX_KEY = /evidence-link-index/;
const CANONICAL_KEY = /:memory:\d+:r\d+$/;
const MANIFEST_KEY = /:manifest$/;
const REGISTRY_KEY = /entity-registry/;
const HEAD_KEY = /continuity-state/;

// Build time is a measurement of the run, and the signature fingerprints the storage basis
// (its own per-mode revisions), not the projection. Both are asserted separately below.
const VOLATILE = new Set(['builtAt', 'buildMs', 'signature']);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
};

// Values built inside the plugin VM carry that realm's prototypes, so compare plain JSON.
const plain = value => JSON.parse(JSON.stringify(value));

async function viewFor(mode) {
  const snapshot = await serverFixture({ mode, args: { evidence_link_index_enabled: 'true' } });
  try {
    const generated = await snapshot.f.run();
    assert.equal(generated.completed, 1, `${mode}: ${JSON.stringify(generated).slice(0, 400)}`);

    const index = await snapshot.f.r.api.getEvidenceLinkIndex({});
    assert.equal(index.schema, 'libra.evidence_link_index.v1', `${mode}: the index was built`);
    assert.equal(index.status.persisted, true, `${mode}: the index reached its storage facade`);

    const serverRows = snapshot.storedRows().map(row => row.key);
    const localKeys = [...snapshot.local.keys()];
    const owned = (keys, pattern) => keys.filter(key => pattern.test(key)).length;
    const canonicalBytes = () => ({
      local: [...snapshot.local.entries()].filter(([key]) => CANONICAL_KEY.test(key) || MANIFEST_KEY.test(key)).sort(([a], [b]) => a.localeCompare(b)),
      server: snapshot.storedRows().filter(row => CANONICAL_KEY.test(row.key) || MANIFEST_KEY.test(row.key))
        .map(row => [row.key, row.raw]).sort(([a], [b]) => a.localeCompare(b))
    });
    const originalBytes = canonicalBytes();
    const indexKey = [...localKeys, ...serverRows].find(key => INDEX_KEY.test(key));
    assert.ok(indexKey, `${mode}: the persisted derived index has a key`);
    if (mode !== 'server_only') snapshot.local.delete(indexKey);
    if (mode !== 'plugin_only') await snapshot.mutate(indexKey, null, 'remove');
    assert.equal([...snapshot.local.keys(), ...snapshot.storedRows().map(row => row.key)].includes(indexKey), false,
      `${mode}: the derived index is absent before rebuild`);
    const fresh = await snapshot.restart();
    const rebuilt = await fresh.r.api.getEvidenceLinkIndex({});
    assert.equal(rebuilt.status.persisted, true, `${mode}: a fresh runtime persists the rebuilt index`);
    assert.equal(JSON.stringify(stable(plain(rebuilt))), JSON.stringify(stable(plain(index))),
      `${mode}: rebuild projects the same logical evidence from canonical`);
    assert.equal(JSON.stringify(canonicalBytes()), JSON.stringify(originalBytes),
      `${mode}: rebuilding the derived index never changes canonical bytes`);

    return {
      mode,
      view: stable(plain(index)),
      signature: String(index.signature || ''),
      facts: index.facts.length,
      entities: index.entities.length,
      serverIndexRows: owned(serverRows, INDEX_KEY),
      localIndexRows: owned(localKeys, INDEX_KEY),
      serverCanonicalRows: owned(serverRows, CANONICAL_KEY) + owned(serverRows, MANIFEST_KEY),
      localCanonicalRows: owned(localKeys, CANONICAL_KEY) + owned(localKeys, MANIFEST_KEY),
      serverRegistryRows: owned(serverRows, REGISTRY_KEY),
      localRegistryRows: owned(localKeys, REGISTRY_KEY),
      serverHeadRows: owned(serverRows, HEAD_KEY),
      localHeadRows: owned(localKeys, HEAD_KEY)
    };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const observations = [];
  for (const mode of MODES) observations.push(await viewFor(mode));

  console.log(JSON.stringify(observations.map(o => ({
    mode: o.mode, facts: o.facts, entities: o.entities,
    serverIndexRows: o.serverIndexRows, localIndexRows: o.localIndexRows,
    serverCanonicalRows: o.serverCanonicalRows, localCanonicalRows: o.localCanonicalRows
  })), null, 1));

  // 1. The feature really ran in every mode.
  for (const o of observations) {
    assert.ok(o.facts >= 1, `${o.mode}: the index projects committed facts`);
    assert.equal(o.entities, 10, `${o.mode}: the resolved scope entities`);
    assert.ok(o.serverIndexRows + o.localIndexRows >= 1, `${o.mode}: the index was stored`);
    assert.match(o.signature, /^[0-9a-f]+:\d+$/, `${o.mode}: the storage-basis fingerprint is present`);
  }

  // 2. The view is mode-independent. Storage location must never change what the index says.
  const [first, ...rest] = observations;
  for (const o of rest) {
    assert.equal(JSON.stringify(o.view), JSON.stringify(first.view),
      `${o.mode}: the index view must match ${first.mode} (storage mode must not change the projection)`);
  }

  // 3. Mode-specific storage invariants, and no local canonical fallback in server_only.
  const plugin = observations.find(o => o.mode === 'plugin_only');
  const mirror = observations.find(o => o.mode === 'mirror');
  const server = observations.find(o => o.mode === 'server_only');
  assert.equal(plugin.localIndexRows, 1, 'plugin_only keeps the index locally');
  assert.equal(plugin.serverIndexRows, 0, 'plugin_only writes no server row');
  assert.equal(mirror.localIndexRows, 1, 'mirror keeps the local copy');
  assert.equal(mirror.serverIndexRows, 1, 'mirror also writes the server row');
  assert.equal(server.serverIndexRows, 1, 'server_only holds the index on the server');
  assert.equal(server.localIndexRows, 0, 'server_only must not leave the index locally');
  for (const o of [plugin, mirror, server]) {
    assert.ok(o.serverCanonicalRows + o.localCanonicalRows >= 1, `${o.mode}: canonical memory exists`);
  }
  assert.equal(server.localCanonicalRows, 0, 'server_only has no local canonical fallback');
  assert.equal(server.localRegistryRows, 0, 'server_only has no local registry fallback');
  assert.equal(server.localHeadRows, 0, 'server_only has no local Head fallback');

  process.stdout.write('libra_evidence_link_index_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
