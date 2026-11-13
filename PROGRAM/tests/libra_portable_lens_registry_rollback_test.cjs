'use strict';
// The lens registry is global, so it is outside every chat checkpoint. A portable restore
// must refuse a permanently deleted lens before it writes anything, and must take back the
// lens definitions it added when a later step of the same restore fails.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const snapshot = values => JSON.stringify([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
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

test('a permanently deleted lens is refused before any storage write, in every restore path', async () => {
  const f = await lensFixture();
  try {
    const lens = await f.add();
    const portable = await waitFor(() => f.r.context.__LIBRAPortableMemoryBackup);
    const backup = await portable.exportCurrentScope();
    await f.api.trashLens(lens.lensId);
    await f.api.purgeLens(lens.lensId);
    assert.equal((await registryIds(f.api)).includes(lens.lensId), false);

    const sameChatBefore = snapshot(f.r.values);
    await assert.rejects(portable.restoreCurrentScope(backup), /영구 삭제된 렌즈/);
    assert.equal(snapshot(f.r.values), sameChatBefore, 'same-chat restore wrote nothing');

    f.target();
    // Resolving a newly selected chat registers its scope once; do that before the snapshot.
    assert.equal((await portable.previewImport(backup)).modes.import_as_predecessor_archive.available, true);
    const migrationBefore = snapshot(f.r.values);
    await assert.rejects(portable.importAsPredecessorArchive(backup), /영구 삭제된 렌즈/);
    assert.equal(snapshot(f.r.values), migrationBefore, 'chat migration wrote nothing');
  } finally {
    await f.close();
  }
});
