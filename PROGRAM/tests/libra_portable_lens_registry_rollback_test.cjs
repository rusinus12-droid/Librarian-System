'use strict';
// The lens registry is global, so it is outside every chat checkpoint. A permanently deleted
// lens stays deleted: a portable restore leaves it out and restores everything else, and takes
// back the lens definitions it added when a later step of the same restore fails.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const registryIds = async api => {
  const registry = await api.getLensRegistry();
  return [...(registry.lenses || []), ...(registry.trash || [])].map(lens => lens.lensId);
};

test('a failure after the lens merge removes the definitions that restore added', async () => {
  const f = await lensFixture();
  try {
    const lens = await f.add();
    const portable = await waitFor(() => f.r.context.__LIBRAPortableMemoryBackup);
    const backup = await portable.exportCurrentScope();
    assert.ok(backup.lensDefinitions.some(row => row.lensId === lens.lensId));
    await f.api.saveLensRegistry({ lenses: [], trash: [] });
    assert.equal((await registryIds(f.api)).includes(lens.lensId), false);

    // The completed Micro recall epoch is sealed after the lens merge; make that write fail.
    const storage = f.r.context.risuai.pluginStorage;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = async (key, value) => (/:micro-recall-epoch:.*:completed$/.test(String(key)) ? false : await setItem(key, value));
    try {
      await assert.rejects(portable.restoreCurrentScope(backup), error => error?.code === 'PORTABLE_RESTORE_FAILED_ROLLED_BACK');
    } finally {
      storage.setItem = setItem;
    }
    assert.equal((await registryIds(f.api)).includes(lens.lensId), false, 'the added lens definition is taken back');
  } finally {
    await f.close();
  }
});

test('a permanently deleted lens is left out while everything else restores, in every restore path', async () => {
  const f = await lensFixture();
  try {
    const kept = await f.add('유지 렌즈');
    const purged = await f.add('삭제 렌즈');
    assert.notEqual(kept.lensId, purged.lensId);
    const portable = await waitFor(() => f.r.context.__LIBRAPortableMemoryBackup);
    const backup = await portable.exportCurrentScope();
    const keptNoteKeys = backup.records.map(row => row.key).filter(key => key.includes(`:lens:${kept.lensId}:`));
    const purgedNoteKeys = backup.records.map(row => row.key).filter(key => key.includes(`:lens:${purged.lensId}:`));
    assert.ok(keptNoteKeys.length && purgedNoteKeys.length, 'the backup holds notes of both lenses');
    const memoryKey = backup.records.map(row => row.key).find(key => /:memory:\d+:r\d+$/.test(key));
    assert.ok(memoryKey, 'the backup holds a canonical memory');
    await f.api.trashLens(purged.lensId);
    await f.api.purgeLens(purged.lensId);

    // Same chat: lose the kept lens notes and a canonical memory, then restore the old file.
    for (const key of [...keptNoteKeys, memoryKey]) f.r.values.delete(key);
    const restored = await portable.restoreCurrentScope(backup);
    assert.equal(restored.ok, true, 'the restore succeeds');
    assert.deepEqual(Array.from(restored.skippedPurgedLensIds), [purged.lensId]);
    assert.ok(f.r.values.has(memoryKey), 'the canonical memory is restored');
    for (const key of keptNoteKeys) assert.ok(f.r.values.has(key), `kept lens note restored: ${key}`);
    assert.equal([...f.r.values.keys()].some(key => key.includes(`:lens:${purged.lensId}:`)), false,
      'no note of the deleted lens comes back');
    assert.equal((await registryIds(f.api)).includes(purged.lensId), false, 'the deleted lens definition stays deleted');
    const lenses = (await f.api.inspectScopeLenses()).memories;
    assert.ok(lenses.some(row => row.lensId === kept.lensId), 'the kept lens is readable');
    assert.equal(lenses.some(row => row.lensId === purged.lensId), false, 'the deleted lens is not readable');

    // Another chat: the move links the kept lens and leaves the deleted one out.
    f.target();
    const moved = await portable.importAsPredecessorArchive(backup);
    assert.equal(moved.ok, true, 'the chat move succeeds');
    assert.deepEqual(Array.from(moved.skippedPurgedLensIds), [purged.lensId]);
    const inherited = (await f.api.inspectScopeLenses()).memories.filter(row => row.inherited);
    assert.ok(inherited.some(row => row.lensId === kept.lensId), 'the kept lens is inherited');
    assert.equal(inherited.some(row => row.lensId === purged.lensId), false, 'the deleted lens is not inherited');
    assert.equal([...f.r.values.keys()].some(key => key.startsWith('libra:v1:lens-handoff-archive:') && key.endsWith(`:${purged.lensId}`)), false,
      'no archive of the deleted lens is written');
  } finally {
    await f.close();
  }
});
