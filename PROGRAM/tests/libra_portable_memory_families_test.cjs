'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const { retryHistoricalMicro } = require('./fixtures/libra_explicit_micro_retry.cjs');
const { microReply } = require('./fixtures/libra_reanalysis_kinds_fixture.cjs');

test('same-chat JSON restores Canonical, Micro, Lens and State, including missing lens definitions', async () => {
  const f = await lensFixture();
  try {
    const lens = await f.add();
    f.control.onCall = microReply;
    await retryHistoricalMicro(f, [1], {});
    const portable = await waitFor(() => f.r.context.__LIBRAPortableMemoryBackup);
    const backup = await portable.exportCurrentScope();
    assert.ok(backup.lensDefinitions.some(row => row.lensId === lens.lensId));
    const families = [':memory:', ':micro-memory-head:', ':lens:', ':continuity-state'];
    for (const family of families) {
      assert.ok(backup.records.some(row => row.key.includes(family)), family);
    }
    const state = f.api.getCurrentStateHead();
    const micro = await f.api.debugReadActiveMicroMemory(1);
    assert.equal(micro.status, 'verified');
    assert.equal(state.throughTurn, 5);
    const beforeLens = (await f.api.inspectScopeLenses()).memories.find(row => row.lensId === lens.lensId);
    assert.ok(beforeLens);
    await f.api.saveLensRegistry({ lenses: [], trash: [] });
    for (const row of backup.records) {
      if (families.some(family => row.key.includes(family))) f.r.values.delete(row.key);
    }
    const restored = await portable.restoreCurrentScope(backup);
    assert.equal(restored.ok, true);
    assert.ok((await f.api.inspectScopeLenses()).memories.some(row => row.text === beforeLens.text));
    assert.equal((await f.api.debugReadActiveMicroMemory(1)).record?.analysisRevisionId, micro.record?.analysisRevisionId);
    assert.equal(f.api.getCurrentStateHead()?.throughTurn, state?.throughTurn);
    const after = await portable.exportCurrentScope();
    for (const row of backup.records.filter(row => families.some(family => row.key.includes(family)))) {
      assert.equal(JSON.stringify(after.records.find(record => record.key === row.key)?.value), JSON.stringify(row.value), row.key);
    }
  } finally {
    await f.close();
  }
});

test('JSON transfer to another chat links verified lens notes as inherited memory', async () => {
  const f = await lensFixture();
  try {
    const lens = await f.add();
    const portable = await waitFor(() => f.r.context.__LIBRAPortableMemoryBackup);
    const backup = await portable.exportCurrentScope();
    assert.equal(backup.portableLensArchives.length, 1);
    f.target();
    const result = await portable.importAsPredecessorArchive(backup);
    assert.equal(result.receipt?.verified, true);
    assert.ok((await f.api.inspectScopeLenses()).memories.some(row => row.inherited && row.lensId === lens.lensId));
  } finally {
    await f.close();
  }
});
