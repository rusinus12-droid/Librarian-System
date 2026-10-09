'use strict';
// P04 — HAYAKU storage ledger must not let a stale snapshot erase a newer write.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §6 P04
// ("HAYAKU storage ledger stale snapshot write"). Its required regression:
//
//   stale writer 강제 / tombstone 유지 / restore 유지 /
//   recovery member 유지 / worldline head 유지
//
// THE DEFECT: `writeStorageLedgerDirect(scope, ledger, …)` builds the new ledger from the
// snapshot the CALLER passes in:
//
//     const ledgerForWrite = { ...ledger, records: localRecords };
//     const reconciled = reconcileStorageSlotHeads(ledgerForWrite, activeRecords, []);
//
// Callers read the ledger, compute a change, and write the WHOLE resulting document. Between
// the caller's read and its write, another operation can commit a change to the same ledger —
// a tombstone, a restore, a packet delete, a recovery update, a worldline update. The stale
// writer then republishes its own snapshot, and the newer change disappears:
//
//     T0  Writer A reads rev 10
//     T1  Writer B reads rev 10, commits a TOMBSTONE  -> rev 11
//     T2  Writer A writes its rev-10-based document   -> the tombstone is gone
//
// `enqueueStorageOperation` serializes the WRITES, which is why this is easy to miss: ordering
// is preserved, but A's document was computed before B's change existed, so serialization
// alone cannot save the newer field.
//
// WHAT THIS TEST ASSERTS: a change committed by one writer must survive an interleaved write
// that was computed from an older snapshot. The durable ledger must contain BOTH changes.
//
// Method: drive two real public operations on one scope and interleave them so the second
// computes its snapshot before the first commits. The harness store lets us pause the first
// write, letting the second read the pre-commit state.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const packetMessage = (turn, text) => hiddenPacketMessage(
  text, createValidPacket({ turn, subject: 'Alice', scene: 'archive', summary: text })
);

// A store that can hold one ledger write open, so another operation can start from the
// pre-commit snapshot.
const createGatedLedgerStore = () => {
  const values = new Map();
  let gate = null;
  return {
    values,
    holdNextLedgerWrite() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      gate = { promise, release };
      return gate;
    },
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      const k = String(key);
      if (gate && k.startsWith('hayaku.v2.ledger.')) {
        const held = gate;
        gate = null;
        await held.promise;
      }
      values.set(k, value);
      return true;
    },
    async removeItem(key) { values.delete(String(key)); return true; },
    async clear() { values.clear(); return true; },
    async key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
    async keys() { return Array.from(values.keys()); },
    async length() { return values.size; }
  };
};

const readLedger = async runtime => {
  const ledger = await runtime.hayaku.ledger.inspect({ includeRecords: true });
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  return {
    ledgers: ledger,
    recordCount: records.length,
    states: Object.fromEntries(records.map(r => [r.recordId, r.recordState])),
    activeTombstoneSlots: (ledger?.tombstones || []).filter(t => t?.active === true).map(t => t.slotId).sort(),
    records: records.map(r => ({ recordId: r.recordId, recordState: r.recordState, slotId: r.slotId }))
  };
};

(async () => {
  const messages = [
    { role: 'user', chatId: 'u1', data: 'Alice opened the archive door.' },
    { role: 'assistant', chatId: 'a1', data: packetMessage(1, 'Alice opened the archive door.') },
    { role: 'user', chatId: 'u2', data: 'Alice found a blue ribbon.' },
    { role: 'assistant', chatId: 'a2', data: packetMessage(2, 'Alice found a blue ribbon.') }
  ];
  const store = createGatedLedgerStore();
  const runtime = await createHayakuRuntime({
    autoRepair: false, messages, chatId: 'hayaku-stale-ledger', pluginStorage: store
  });
  const observations = {};

  try {
    const t = runtime.hayaku._test;
    const scope = await t.currentChatScope();
    await t.reconcileObservedChatTopology(scope, t.authoritativeChatSnapshot(scope.chatMessages, scope), 'p04_stale_writer');

    const before = await readLedger(runtime);
    observations.before = { recordCount: before.recordCount, activeTombstoneSlots: before.activeTombstoneSlots };
    assert.ok(before.recordCount >= 2,
      `the scope must hold at least two packets so a delete and a recovery write can interleave: ${JSON.stringify(before.records)}`);
    const ids = Object.keys(before.states).sort();
    const firstId = ids[0];
    const secondId = ids[1];

    // ---- Interleave ---------------------------------------------------------------------
    // Two REAL writes on the same ledger. Writer B (the first forget) is held open at its
    // ledger write; writer A (the second forget) then reads the ledger, computes its document
    // from the PRE-commit state, and writes it. If A's document is stale, B's tombstone is gone.
    const gate = store.holdNextLedgerWrite();
    const deletionB = runtime.hayaku.ledger.forget({ recordId: firstId });
    await new Promise(resolve => setTimeout(resolve, 40));

    const deletionA = runtime.hayaku.ledger.forget({ recordId: secondId });

    gate.release();
    const deletedB = await deletionB;
    const deletedA = await deletionA;

    assert.equal(deletedB.ok, true, `delete B must succeed: ${JSON.stringify(deletedB)}`);
    assert.equal(deletedA.ok, true, `delete A must succeed: ${JSON.stringify(deletedA)}`);
    const deleted = deletedB;
    const other = deletedA;
    /// Both tombstones must exist — A's document must not have erased B's.
    assert.notEqual(deleted.slotId, other.slotId, 'the two deletes must touch different slots');

    // ---- Durable outcome ----------------------------------------------------------------
    const after = await readLedger(runtime);
    observations.after = {
      recordCount: after.recordCount,
      states: after.states,
      activeTombstoneSlots: after.activeTombstoneSlots
    };

    // THE INVARIANT: the tombstone committed by writer B must still be present. A stale
    // snapshot write from writer A would have republished the pre-delete document.
    assert.ok(after.activeTombstoneSlots.includes(deleted.slotId),
      `the first tombstone must survive the interleaved write `
      + `(expected slot ${deleted.slotId}, durable active tombstones ${JSON.stringify(after.activeTombstoneSlots)})`);
    assert.ok(after.activeTombstoneSlots.includes(other.slotId),
      `the second tombstone must also be present (got ${JSON.stringify(after.activeTombstoneSlots)})`);
    assert.equal(after.states[firstId], 'tombstoned',
      `the first deleted packet must stay tombstoned (got '${after.states[firstId]}')`);
    assert.equal(after.states[secondId], 'tombstoned',
      `the second deleted packet must stay tombstoned (got '${after.states[secondId]}')`);
    assert.equal(after.recordCount, before.recordCount,
      'no packet may be lost by the interleaved write');

    // ---- Reload: the tombstone must be durable, not just in-memory ----------------------
    const reopened = await createHayakuRuntime({
      autoRepair: false, messages, chatId: 'hayaku-stale-ledger',
      pluginStorage: store, safeLocalStorage: runtime.safeLocalStorage
    });
    try {
      const reloaded = await readLedger(reopened);
      observations.reloaded = { activeTombstoneSlots: reloaded.activeTombstoneSlots, states: reloaded.states };
      assert.ok(reloaded.activeTombstoneSlots.includes(deleted.slotId),
        'the first tombstone must be durable across a reload');
      assert.ok(reloaded.activeTombstoneSlots.includes(other.slotId),
        'the second tombstone must be durable across a reload');
      assert.equal(reloaded.states[firstId], 'tombstoned',
        'the deleted packet must remain tombstoned after a reload');

      // ---- Restore must still work on the surviving ledger ------------------------------
      const restored = await reopened.hayaku.ledger.restore({ recordId: firstId });
      assert.equal(restored.ok, true, `restore after the interleave must succeed: ${JSON.stringify(restored)}`);
      assert.equal(restored.restored, true, 'the tombstoned packet must be restorable');
      const afterRestore = await readLedger(reopened);
      assert.ok(!afterRestore.activeTombstoneSlots.includes(deleted.slotId),
        'restore must deactivate the tombstone');
      observations.afterRestore = { states: afterRestore.states };
    } finally {
      await reopened.dispose();
    }

    console.log(JSON.stringify({ test: 'hayaku_storage_ledger_stale_writer', passed: 1, observations }, null, 1));
    process.stdout.write('hayaku_storage_ledger_stale_writer_test: PASS\n');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
