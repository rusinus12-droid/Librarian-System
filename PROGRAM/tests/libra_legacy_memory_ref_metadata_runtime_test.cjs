'use strict';
// Legacy pointers and bodies that both predate identity metadata retain their
// existing read behavior through the deployed LIBRA storage bridge.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const exposeLoader = source => {
  const marker = '    return Object.freeze({\n      VERSION, BATCH_SIZE';
  assert.ok(source.includes(marker), 'LIBRA core return marker exists');
  return source.replace(marker, '    globalThis.__LIBRA_LOAD_MEMORY_REF__ = loadMemoryRef;\n' + marker);
};
const manifestOf = (snapshot, mode) => mode === 'plugin_only'
  ? JSON.parse(snapshot.local.get([...snapshot.local.keys()].find(key => key.endsWith(':manifest'))))
  : snapshot.getManifest();
const manifestKeyOf = (snapshot, mode) => mode === 'plugin_only'
  ? [...snapshot.local.keys()].find(key => key.endsWith(':manifest'))
  : snapshot.storedRows().find(row => row.key.endsWith(':manifest')).key;
const rawOf = (snapshot, mode, key) => mode === 'plugin_only'
  ? snapshot.local.get(key)
  : snapshot.storedRows().find(row => row.key === key)?.raw;
const setDurable = async (snapshot, mode, key, value) => {
  if (mode !== 'server_only') snapshot.local.set(key, JSON.stringify(value));
  if (mode !== 'plugin_only') await snapshot.mutate(key, value);
};

async function check(mode) {
  const snapshot = await serverFixture({ mode, transformSource: exposeLoader });
  try {
    assert.equal((await snapshot.f.run()).completed, 1, `${mode}: fixture commits a canonical memory`);
    const manifest = manifestOf(snapshot, mode);
    const ref = { ...manifest.memories['1'] };
    const memory = JSON.parse(rawOf(snapshot, mode, ref.key));
    const idOnly = { ...memory, id: memory.memoryId };
    delete idOnly.memoryId;
    await setDurable(snapshot, mode, ref.key, idOnly);
    const restartedWithIdAlias = await snapshot.restart();
    const aliasLoader = restartedWithIdAlias.r.context.__LIBRA_LOAD_MEMORY_REF__;
    assert.equal((await aliasLoader(ref))?.id, ref.memoryId, `${mode}: an id-only legacy body satisfies the established memoryId alias`);
    await setDurable(snapshot, mode, ref.key, { ...idOnly, id: 'foreign-memory-id' });
    const restartedWithForeignId = await snapshot.restart();
    const foreignLoader = restartedWithForeignId.r.context.__LIBRA_LOAD_MEMORY_REF__;
    assert.equal(await foreignLoader(ref), null, `${mode}: a foreign legacy id cannot satisfy the active memoryId ref`);

    for (const field of ['memoryId', 'revision', 'sourceDigest']) {
      delete ref[field];
    }
    const legacyBody = { ...memory };
    for (const field of ['memoryId', 'revision', 'sourceDigest']) delete legacyBody[field];
    await setDurable(snapshot, mode, ref.key, legacyBody);
    await setDurable(snapshot, mode, manifestKeyOf(snapshot, mode), manifest);

    const restarted = await snapshot.restart();
    const loader = restarted.r.context.__LIBRA_LOAD_MEMORY_REF__;
    assert.equal(typeof loader, 'function', `${mode}: test reaches the deployed canonical loader`);
    const loaded = await loader(ref);
    assert.equal(loaded?.status, 'committed', `${mode}: a legacy canonical remains readable`);
    assert.equal(loaded?.canonicalArtifact?.schema, artifact().schema, `${mode}: the legacy body reaches its consumer intact`);
    assert.equal(loaded?.memoryId, undefined, `${mode}: absent legacy identity metadata is preserved as absent`);
    assert.equal(loaded?.revision, undefined, `${mode}: absent legacy revision metadata is preserved as absent`);
    assert.equal(loaded?.sourceDigest, undefined, `${mode}: absent legacy source digest is preserved as absent`);
    return { mode, loaded: true, metadataAbsent: true };
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const observations = [];
  for (const mode of MODES) observations.push(await check(mode));
  process.stdout.write(JSON.stringify({ test: 'libra_legacy_memory_ref_metadata_runtime', observations }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
