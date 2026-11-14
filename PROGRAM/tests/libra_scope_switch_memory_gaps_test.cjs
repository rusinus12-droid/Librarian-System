'use strict';
// Regressions from the 2026-11-14 debug export (scope e6bb50f0_18:0):
// 1. a Canonical batch analysed while the user stepped into another chat was refused at
//    commit as CANONICAL_ORIGINAL_RAW_UNAVAILABLE:raw_packet_current_source_changed;
// 2. turns whose Micro was never planned stayed without Micro for good;
// 3. the final recall proof failed on its fixed 11.5 s cap while the recall had 46 s left.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const switchableHost = chats => {
  const view = { index: 0 };
  return { view, host: {
    getCurrentChatIndex: async () => view.index,
    getCurrentChat: async () => chats[view.index],
    getChat: async () => chats[view.index],
    getChatFromIndex: async (_character, index) => chats[Number(index ?? view.index)] || null
  } };
};

test('a Canonical batch commits for its own chat when the user opens another chat during analysis', async t => {
  const other = { id: 'other-chat', chatId: 'other-chat', name: 'Other', message: [{ role: 'user', chatId: 'o1-u', data: '다른 방' }] };
  other.messages = other.message;
  const chats = [];
  const { view, host } = switchableHost(chats);
  const x = await fixture({ host });
  t.after(() => x.r.cleanup());
  chats.push(x.chat, other);
  x.character.chats = chats;
  const artifactReply = JSON.stringify(x.control.artifact);
  x.control.onCall = args => {
    const text = JSON.stringify(args);
    if (text.includes('[LIBRA MICRO SOURCE CONTRACT]')) return require('./fixtures/libra_reanalysis_kinds_fixture.cjs').microReply(args);
    // The user clicks into another chat while the Canonical model call is in flight.
    view.index = 1;
    return { type: 'success', result: artifactReply };
  };
  const run = await x.run();
  assert.deepEqual(JSON.parse(JSON.stringify(run.failures || [])), [], 'the batch is not refused');
  view.index = 0;
  const memory = x.getMemory(1);
  assert.ok(memory, 'T1–5 Canonical is committed for the chat the batch came from');
  assert.equal(memory.status, 'committed');
  assert.equal(x.getManifest().memories['1'].key.includes(':memory:1:'), true);
  assert.equal(Object.keys(x.getManifest().failedBatches || {}).length, 0, 'no failure is recorded for a view change');
});
