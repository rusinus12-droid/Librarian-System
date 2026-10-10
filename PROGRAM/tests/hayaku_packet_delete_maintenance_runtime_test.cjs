'use strict';
// Task 21 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// HAYAKU-PACKET-DELETE-MAINTENANCE was recorded as plugin_only = verified_supported
// while `tombstoneStorageSlot`, `restoreStorageSlot` and `removeOrphanedStorageRecords`
// had **zero** references anywhere under tests/. The two tests the inventory listed
// (`hayaku_actionable_maintenance_ui_test.cjs`, `hayaku_gui_ux_contract_test.cjs`)
// only cover the GUI contract.
//
// This test executes the real paths through the deployed public ledger API and
// asserts durable readback after a reload of the same storage:
//
//   ledger.forget  -> packet is tombstoned, suppressed on readback, not deleted
//   reload         -> the tombstone is durable, the record is still recoverable
//   ledger.restore -> the packet returns to its live/unbound state
//   orphanCleanup  -> the preview removes nothing, and a live packet is protected
//
// The last assertion is the one that matters for data safety: real memory may
// never be mistaken for an orphan.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { clone } = require('./fixtures/native_branch_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value ?? null));
const packetMessage = (turn, text) => hiddenPacketMessage(text, createValidPacket({ turn, subject: 'Alice', scene: 'archive', summary: text }));

const readState = async runtime => {
  const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  return {
    recordCount: records.length,
    activeRecordIds: records.filter(record => record.recordState === 'active').map(record => record.recordId).sort(),
    tombstonedRecordIds: records.filter(record => record.recordState === 'tombstoned').map(record => record.recordId).sort(),
    recordStates: Object.fromEntries(records.map(record => [record.recordId, record.recordState]).sort()),
    activeTombstoneSlots: (ledger?.tombstones || []).filter(tombstone => tombstone?.active === true).map(tombstone => tombstone.slotId).sort(),
    slotHeads: Object.fromEntries((ledger?.slotHeads || []).map(head => [head.slotId, head.state]).sort())
  };
};

(async () => {
  const messages = [
    { role: 'user', chatId: 'u1', data: 'Alice opened the archive door.' },
    { role: 'assistant', chatId: 'a1', data: packetMessage(1, 'Alice opened the archive door.') },
    { role: 'user', chatId: 'u2', data: 'Alice found a blue ribbon.' },
    { role: 'assistant', chatId: 'a2', data: packetMessage(2, 'Alice found a blue ribbon.') }
  ];
  const runtime = await createHayakuRuntime({ autoRepair: false, messages, chatId: 'hayaku-delete-maintenance' });
  let reopened = null;
  const observations = {};
  try {
    const t = runtime.hayaku._test;
    const scope = await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope, t.authoritativeChatSnapshot(scope.chatMessages, scope), 'delete_maintenance_task21');

    const before = await readState(runtime);
    assert.ok(before.activeRecordIds.length >= 1, `a live packet exists before the delete: ${JSON.stringify(before)}`);
    const targetId = before.activeRecordIds[0];

    // --- ledger.forget: real entry point -------------------------------------
    const forgotten = await runtime.hayaku.ledger.forget({ recordId: targetId });
    assert.equal(forgotten.ok, true, `delete succeeded: ${JSON.stringify(forgotten)}`);
    assert.equal(forgotten.forgotten, true);
    assert.equal(forgotten.recoverable, true, 'delete is a tombstone, not a destructive removal');
    assert.ok(forgotten.slotId, 'delete reports the affected slot');

    const afterForget = await readState(runtime);
    assert.equal(afterForget.recordCount, before.recordCount, 'the packet record is still present (nothing was physically deleted)');
    assert.ok(afterForget.tombstonedRecordIds.includes(targetId), 'the packet is tombstoned');
    assert.ok(afterForget.activeTombstoneSlots.includes(forgotten.slotId), 'the slot carries an active tombstone');
    assert.equal(afterForget.recordStates[targetId], 'tombstoned');

    // --- durable readback through a fresh runtime ---------------------------
    reopened = await createHayakuRuntime({
      autoRepair: false,
      messages: clone(messages),
      chatId: 'hayaku-delete-maintenance',
      pluginStorage: runtime.pluginStorage,
      safeLocalStorage: runtime.safeLocalStorage
    });
    const reopenedAfterForget = await readState(reopened);
    assert.equal(reopenedAfterForget.recordStates[targetId], 'tombstoned', 'the tombstone survives a reload of the same storage');
    assert.ok(reopenedAfterForget.activeTombstoneSlots.includes(forgotten.slotId), 'the active tombstone survives a reload');
    observations.afterForget = afterForget;

    // --- ledger.restore ------------------------------------------------------
    const restored = await reopened.hayaku.ledger.restore({ recordId: targetId });
    assert.equal(restored.ok, true, `restore succeeded: ${JSON.stringify(restored)}`);
    assert.equal(restored.restored, true);
    assert.equal(restored.durable, true);
    assert.equal(restored.slotId, forgotten.slotId);

    const afterRestore = await readState(reopened);
    assert.equal(afterRestore.recordCount, before.recordCount, 'restore does not duplicate or drop records');
    assert.ok(!afterRestore.tombstonedRecordIds.includes(targetId), 'the packet is no longer tombstoned');
    assert.ok(!afterRestore.activeTombstoneSlots.includes(forgotten.slotId), 'the slot tombstone is deactivated');
    assert.ok(['active', 'unbound'].includes(afterRestore.recordStates[targetId]), 'the packet returns to a usable state');
    observations.afterRestore = afterRestore;

    // Restoring a packet that is not tombstoned must be a no-op, not an error
    // and not a state change.
    const secondRestore = await reopened.hayaku.ledger.restore({ recordId: targetId });
    assert.equal(secondRestore.ok, true);
    assert.equal(secondRestore.restored, false);
    assert.equal(secondRestore.reason, 'not_tombstoned');
    assert.deepEqual(await readState(reopened), afterRestore, 'a redundant restore changes nothing');

    // --- orphan cleanup must never take live memory -------------------------
    const preview = await reopened.hayaku.ledger.orphanCleanup.inspect();
    assert.equal(preview.ok, true, `orphan preview completed: ${JSON.stringify(preview)}`);
    assert.equal(preview.preview, true);
    assert.equal(preview.removableRecords, 0, 'no live packet is classified as a removable orphan');
    assert.equal(preview.orphanedRecords, 0, 'a healthy live scope has no orphaned turn nodes');

    const removed = await reopened.hayaku.ledger.orphanCleanup.remove();
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, false);
    assert.equal(removed.reason, 'no_removable_orphans');
    assert.equal(removed.removedRecords, 0);
    const afterCleanup = await readState(reopened);
    assert.deepEqual(afterCleanup, afterRestore, 'orphan cleanup on a live scope is a verified no-op');
    for (const recordId of afterRestore.recordStates ? Object.keys(afterRestore.recordStates) : []) {
      assert.ok(afterCleanup.recordStates[recordId], `orphan cleanup kept real memory record ${recordId}`);
    }
    observations.orphanCleanup = { removable: preview.removableRecords, orphaned: preview.orphanedRecords, kept: afterCleanup.recordCount };

    console.log(JSON.stringify({
      test: 'hayaku_packet_delete_maintenance_runtime',
      passed: 1,
      boundary: 'real deployed HAYAKU public ledger API + durable readback; no model or provider calls',
      observations
    }));
  } finally {
    if (reopened) await reopened.dispose();
    await runtime.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
