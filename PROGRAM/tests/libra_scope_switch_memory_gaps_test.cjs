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

const gapProbe = source => {
  const anchor = '    const repairMicroGapsAfterPublication = async scope => {';
  assert.ok(source.includes(anchor));
  return source.replace(anchor, `    globalThis.__microGapProbe = async ({ heads = [], works = [], options = {} } = {}) => {
      receiptGapScannedAt = 0; receiptGapAttempts.clear();
      const context = await resolveContext(true), pairs = buildPairs(context.chat, context.scope.scopeKey);
      const worldlineId = hostWorldlineIdForScope(context.scope);
      for (const turn of heads) await storage.setJson(key.microMemoryHead(context.scope, worldlineId, 0, turn), { schema: 'gap_probe_head' });
      for (const turn of works) await storage.setJson(key.microWork(context.scope, worldlineId, 0, turn,
        completedTurnRevisionId(pairs[turn - 1]), microProducerVersion), { schema: 'gap_probe_work', status: 'reserved', phase: 'invoking', leaseExpiresAt: Date.now() + 60000 });
      return (await findCompletedTurnGaps(context, pairs, pairs.slice(-1), options)).map(pair => Number(pair.turn));
    };
` + anchor);
};

test('never-planned turns after the first Micro are re-opened by the receipt reconcile, earlier history is not', async t => {
  const x = await fixture({ transformSource: gapProbe });
  t.after(() => x.r.cleanup());
  const probe = async options => JSON.parse(JSON.stringify(await x.r.context.__microGapProbe(options)));
  // Five pairs; the newest is the tail. T1 has Micro, T2–T4 have neither Micro nor any attempt.
  assert.deepEqual(await probe({ heads: [1], options: { includeUnplanned: true } }), [2, 3, 4]);
  // The post-publication repair cannot capture a receipt, so it keeps the old rule.
  assert.deepEqual(await probe({ heads: [1] }), []);
  // A chat with no Micro at all is history backfill, never automatic.
  const empty = await fixture({ transformSource: gapProbe });
  t.after(() => empty.r.cleanup());
  assert.deepEqual(JSON.parse(JSON.stringify(await empty.r.context.__microGapProbe({ options: { includeUnplanned: true } }))), []);
  // A turn with an attempt in flight for its revision is not an unplanned gap.
  assert.deepEqual(await probe({ heads: [1], works: [3], options: { includeUnplanned: true } }), [2, 4]);
});
