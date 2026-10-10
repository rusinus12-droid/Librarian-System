'use strict';
// Stage 5 (first requirement): the LORE link index must not depend on where storage lives.
//
// Stage 1 established this contract for the evidence index — all three storage modes produce the SAME
// projection, and server_only holds it on the server only, never as a second local copy. Stage 2 added a
// second index that reads its input from a different source (the host-allowed lore corpus, not canonical
// memory), so the same contract has to be shown for it rather than assumed from the sibling.
//
// What this suite asserts, and why each claim matters:
//
//   1. The feature really ran in every mode (a mode that silently skipped the build would otherwise pass
//      every equality check by producing nothing).
//   2. The projection is mode-independent: storage location must never change what the index SAYS.
//   3. Mode-specific storage invariants hold, and server_only leaves no local fallback.
//   4. The lore index never becomes canonical memory: it holds no memory body, and the modes do not
//      acquire canonical rows as a side effect of building it.
const assert = require('node:assert/strict');
const { serverFixture, withLorebook } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const LORE_INDEX_KEY = /lore-link-index/;
const EVIDENCE_INDEX_KEY = /evidence-link-index/;
const CANONICAL_KEY = /:memory:\d+:r\d+$/;
const MANIFEST_KEY = /:manifest$/;
const REGISTRY_KEY = /entity-registry/;
const HEAD_KEY = /continuity-state/;

// Build time is a measurement of the run; the signature fingerprints the storage basis (its own per-mode
// revisions), not the projection. Both are asserted separately so neither hides inside an equality check.
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
  const snapshot = await serverFixture({ mode, args: { evidence_link_index_enabled: 'true', lore_link_index_enabled: 'true' } });
  try {
    // The corpus must be installed BEFORE the run: the collector reads the allowed lorebook while the
    // batch executes, and an empty corpus would let every equality check below pass on three empty views.
    withLorebook(snapshot.f);
    const generated = await snapshot.f.run();
    assert.equal(generated.completed, 1, `${mode}: ${JSON.stringify(generated).slice(0, 400)}`);

    const index = plain(await snapshot.f.r.api.getLoreLinkIndex({ force: true }));
    assert.equal(index.schema, 'libra.lore_link_index.v1', `${mode}: the lore index was built`);

    const serverRows = snapshot.storedRows().map(row => row.key);
    const localKeys = [...snapshot.local.keys()];
    const owned = (keys, pattern) => keys.filter(key => pattern.test(key)).length;

    return {
      mode,
      view: stable(plain(index)),
      signature: String(index.signature || ''),
      entries: index.entries.length,
      links: index.links.length,
      serverLoreIndexRows: owned(serverRows, LORE_INDEX_KEY),
      localLoreIndexRows: owned(localKeys, LORE_INDEX_KEY),
      serverEvidenceIndexRows: owned(serverRows, EVIDENCE_INDEX_KEY),
      localEvidenceIndexRows: owned(localKeys, EVIDENCE_INDEX_KEY),
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
    mode: o.mode, entries: o.entries, links: o.links,
    serverLoreIndexRows: o.serverLoreIndexRows, localLoreIndexRows: o.localLoreIndexRows,
    serverCanonicalRows: o.serverCanonicalRows, localCanonicalRows: o.localCanonicalRows
  })), null, 1));

  // 1. The feature really ran in every mode. An index that never built would satisfy every equality
  //    check below by producing the same nothing three times.
  for (const o of observations) {
    assert.ok(o.entries >= 1, `${o.mode}: the index projects allowed-lore entries`);
    assert.ok(o.links >= 1, `${o.mode}: the index resolved links`);
    assert.ok(o.serverLoreIndexRows + o.localLoreIndexRows >= 1, `${o.mode}: the index was stored`);
    assert.match(o.signature, /^[0-9a-f]+:\d+$/, `${o.mode}: the storage-basis fingerprint is present`);
  }

  // 2. The view is mode-independent: where storage lives must never change what the index says.
  const [first, ...rest] = observations;
  for (const o of rest) {
    assert.equal(JSON.stringify(o.view), JSON.stringify(first.view),
      `${o.mode}: the lore index view must match ${first.mode} (storage mode must not change the projection)`);
  }

  // 3. Mode-specific storage invariants, and no local fallback in server_only.
  const plugin = observations.find(o => o.mode === 'plugin_only');
  const mirror = observations.find(o => o.mode === 'mirror');
  const server = observations.find(o => o.mode === 'server_only');
  assert.equal(plugin.localLoreIndexRows, 1, 'plugin_only keeps the lore index locally');
  assert.equal(plugin.serverLoreIndexRows, 0, 'plugin_only writes no server row');
  assert.equal(mirror.localLoreIndexRows, 1, 'mirror keeps the local copy');
  assert.equal(mirror.serverLoreIndexRows, 1, 'mirror also writes the server row');
  assert.equal(server.serverLoreIndexRows, 1, 'server_only holds the lore index on the server');
  assert.equal(server.localLoreIndexRows, 0, 'server_only must not leave the lore index locally');
  assert.equal(server.localCanonicalRows, 0, 'server_only has no local canonical fallback');
  assert.equal(server.localRegistryRows, 0, 'server_only has no local registry fallback');
  assert.equal(server.localHeadRows, 0, 'server_only has no local Head fallback');

  // 4. The lore index is a projection, not a copy of the corpus. It stores name-level entity rows and
  //    passage LOCATORS; it must not carry a memory body or a canonical artifact. The distinction matters
  //    because the passages legitimately quote an excerpt — that is the locator's evidence — while the
  //    corpus itself and canonical memory must stay out.
  for (const o of observations) {
    assert.ok(o.serverCanonicalRows + o.localCanonicalRows >= 1, `${o.mode}: canonical memory exists`);
  }
  for (const o of observations) {
    const serialized = JSON.stringify(o.view);
    for (const field of ['canonicalArtifact', 'recallKeys', 'embedding', 'vectorRecord']) {
      assert.equal(serialized.includes(`"${field}"`), false,
        `${o.mode}: the lore index must not carry \`${field}\` — it stores a projection, not the corpus`);
    }
    // The locator keeps the RENDERED coordinate space and says so; an empty raw hash with a rendered one
    // is the honest statement that the raw template is not addressable.
    for (const entry of o.view.entries) {
      for (const passage of entry.passages) {
        assert.equal(String(passage.coordinateSpace), 'rendered',
          `${o.mode}: a passage locator declares the coordinate space it actually measured`);
        assert.notEqual(String(passage.renderedHash || ''), '',
          `${o.mode}: a passage locator carries the hash of what it measured`);
      }
    }
  }

  process.stdout.write('libra_lore_link_index_3mode_parity_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
