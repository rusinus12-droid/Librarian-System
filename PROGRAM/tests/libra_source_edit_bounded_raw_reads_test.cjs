'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

// Exercise the production read boundary with its real verified receipts and
// original packets. The transform only exposes the private reader to this VM.
const exposeRawRead = source => {
  const core = '      getUnifiedStorageStatus,';
  const api = '    async getUnifiedStorageStatus() {';
  assert.equal(source.split(core).length, 2);
  assert.equal(source.split(api).length, 2);
  return source.replace(core,
    '      rawBatchProbe: async () => {const context=await resolveContext();return readCanonicalRawBatch(buildPairs(context.chat,context.scope.scopeKey).slice(0,BATCH_SIZE));},\n' + core)
    .replace(api, '    rawBatchProbe: () => LibraMemoryCore.rawBatchProbe(),\n' + api);
};

for (const change of ['none', 'source_edit', 'source_delete', 'source_append', 'source_revert', 'scope_change']) {
  test(`raw boundary joins five reads while one is held and checks ${change}`, async () => {
    const f = await fixture({ transformSource: exposeRawRead });
    let release;
    let work;
    try {
      assert.equal((await f.run()).completed, 1);
      const expected = f.getMemory().rawPacketRefs;
      const storage = f.r.context.risuai.pluginStorage;
      const get = storage.getItem;
      const heads = new Set();
      let held = false;
      storage.getItem = async key => {
        const raw = await get(key);
        const match = String(key).match(/:source-receipt-head:[^:]+:e0:t(\d+)$/);
        if (match) {
          heads.add(Number(match[1]));
          if (Number(match[1]) === 2 && !held) {
            held = true;
            await new Promise(resolve => { release = resolve; });
          }
        }
        return raw;
      };
      work = f.r.api.rawBatchProbe();
      work.catch(() => {});
      await waitFor(() => held, 1000);
      await waitFor(() => heads.size === 5, 1000).catch(() => {});
      assert.deepEqual([...heads].sort((a, b) => a - b), [1, 2, 3, 4, 5],
        'all five physical head reads enter before the held read resolves');
      if (change === 'source_edit') f.chat.message[9].data += ' Changed after the raw read started.';
      if (change === 'source_delete') f.chat.message.splice(8, 2);
      if (change === 'source_append') f.chat.message.push(
        { ...f.chat.message[8], chatId: 'new-u6' },
        { ...f.chat.message[9], chatId: 'new-a6' });
      if (change === 'source_revert') {
        const original = f.chat.message[9].data;
        f.chat.message[9].data += ' Temporary edit.';
        f.chat.message[9].data = original;
      }
      if (change === 'scope_change') f.chat.id = f.chat.chatId = 'different-source-owner';
      release();
      release = null;
      if (['source_edit', 'source_delete', 'scope_change'].includes(change))
        await assert.rejects(work, /CANONICAL_(?:COMPLETED_RECEIPT|ORIGINAL_RAW)/);
      else {
        const result = await work;
        assert.deepEqual(Array.from(result.batch, pair => pair.turn), [1, 2, 3, 4, 5]);
        assert.equal(JSON.stringify(result.refs), JSON.stringify(expected), 'exact physical ref order and digests survive');
      }
    } finally {
      release?.();
      await work?.catch(() => {});
      await f.r.cleanup();
    }
  });
}
