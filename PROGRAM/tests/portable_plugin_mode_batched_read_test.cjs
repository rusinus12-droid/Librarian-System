'use strict';
// plugin_only portable backups read pluginStorage in groups: RisuAI has no batch read, so a
// group of up to 64 keys is requested together instead of one round trip per key. The
// backup must hold the same record set and restore. (Values may legitimately move between two
// exports while background analysis settles, so only the key set is compared.)
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { createStore, createValidPacket, hiddenPacketMessage, createHayakuRuntime, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');
const { createFixture: createFlashbackFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Count concurrent getItem calls on a pluginStorage object; each read takes a few ms like a host round trip.
const instrument = storage => {
  const original = storage.getItem.bind(storage);
  const stats = { active: 0, max: 0, reads: 0, measuring: false };
  storage.getItem = async key => {
    if (!stats.measuring) return await original(key);
    stats.reads += 1;
    stats.active += 1;
    stats.max = Math.max(stats.max, stats.active);
    try { await sleep(3); return await original(key); } finally { stats.active -= 1; }
  };
  return stats;
};
const measure = async (stats, operation) => {
  stats.max = 0; stats.reads = 0; stats.measuring = true;
  try { return await operation(); } finally { stats.measuring = false; }
};
const retryBusy = async operation => {
  for (let i = 0; i < 120; i += 1) {
    try { return await operation(); } catch (error) {
      if (!/BUSY|manifest_changed/.test(String(error?.code || error?.message))) throw error;
      await sleep(250);
    }
  }
  throw new Error('portable operation stayed busy');
};
const check = (label, stats) => {
  console.log(label, JSON.stringify({ reads: stats.reads, maxConcurrentReads: stats.max }));
  assert.ok(stats.max > 1, `${label}: plugin_only backup reads are grouped, not one at a time`);
  assert.ok(stats.max <= 64 * 3, `${label}: groups stay bounded`);
};

(async () => {
  {
    const snapshot = await serverFixture({ mode: 'plugin_only' });
    try {
      await snapshot.f.r.api.runManualColdStart({});
      const portable = await waitFor(() => snapshot.f.r.context.__LIBRAPortableMemoryBackup, 'LIBRA portable API');
      const serial = await retryBusy(() => portable.exportCurrentScope());
      const stats = instrument(snapshot.backend);
      const grouped = await measure(stats, () => retryBusy(() => portable.exportCurrentScope()));
      check('LIBRA', stats);
      assert.deepEqual(grouped.records.map(row => row.key).sort(), serial.records.map(row => row.key).sort(),
        'LIBRA: grouped reads export the same record set');
      assert.equal((await portable.restoreCurrentScope(grouped)).ok, true, 'LIBRA: the grouped backup restores');
    } finally { await snapshot.cleanup(); }
  }
  {
    const store = createStore();
    const messages = [
      { role: 'user', data: 'I enter the archive.', chatId: 'u1' },
      { role: 'assistant', data: hiddenPacketMessage('Alice entered the archive.', createValidPacket({ turn: 1, summary: 'Alice entered the archive.' })), chatId: 'a1' }
    ];
    const runtime = await createHayakuRuntime({ autoRepair: false, chatId: 'batched-chat', characterId: 'batched-bot', messages, pluginStorage: store });
    try {
      const scope = await runtime.hayaku._test.currentChatScope();
      const topology = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
      assert.equal((await runtime.hayaku._test.reconcileObservedChatTopology(scope, topology, 'batched_fixture')).durable, true);
      const portable = await waitFor(() => runtime.context.__HAYAKUPortableMemoryBackup, 'HAYAKU portable API');
      const serial = await portable.exportCurrentScope();
      const stats = instrument(store);
      const grouped = await measure(stats, () => portable.exportCurrentScope());
      check('HAYAKU', stats);
      assert.deepEqual(grouped.records.map(row => row.key).sort(), serial.records.map(row => row.key).sort(),
        'HAYAKU: grouped reads export the same record set');
      assert.equal((await portable.restoreCurrentScope(grouped)).ok, true, 'HAYAKU: the grouped backup restores');
    } finally { await runtime.dispose(); }
  }
  {
    const messages = [
      { role: 'user', data: 'Mira hides the brass key under the sundial.', chatId: 'u1' },
      { role: 'assistant', data: 'Mira pockets the key and waits for moonrise.', chatId: 'a1' },
      { role: 'user', data: 'She should meet Rowan alone.', chatId: 'u2' },
      { role: 'assistant', data: 'At moonrise, Mira meets Rowan alone.', chatId: 'a2' }
    ];
    const f = await createFlashbackFixture({ characterId: 'batched-bot', chat: { id: 'batched-chat', chatId: 'batched-chat', name: 'Batched', message: messages, messages } });
    try {
      const portable = await waitFor(() => f.context.__FlashbackPortableMemoryBackup, 'Flashback portable API');
      await f.api.ingestLiveChatColdStart({ scope: 'current', incremental: false, skipEpisodeRebuild: true, skipGuiRefresh: true, allowHashFallback: true });
      await sleep(3000);
      const serial = await retryBusy(() => portable.exportCurrentScope());
      const stats = instrument(f.pluginStorage);
      const grouped = await measure(stats, () => retryBusy(() => portable.exportCurrentScope()));
      check('Flashback', stats);
      assert.deepEqual(grouped.records.map(row => row.key).sort(), serial.records.map(row => row.key).sort(),
        'Flashback: grouped reads export the same record set');
      assert.equal((await retryBusy(() => portable.restoreCurrentScope(grouped))).ok, true, 'Flashback: the grouped backup restores');
    } finally { await f.dispose(); }
  }
  console.log('PASS portable_plugin_mode_batched_read_test');
  process.exit(0);
})().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
