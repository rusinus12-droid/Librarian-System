'use strict';
const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });

(async () => {
  console.log('[TEST] Starting hayaku_reroll_cascade_rebinding_test...');

  const packet1 = createValidPacket({ turn: 1, subject: 'Alice', scene: 'library', summary: 'Alice entered the library.' });
  const packet2 = createValidPacket({ turn: 2, subject: 'Alice', scene: 'hallway', summary: 'Alice walked down the hallway.' });
  const packet3 = createValidPacket({ turn: 3, subject: 'Alice', scene: 'archive', summary: 'Alice found the ancient book.' });
  const packet4 = createValidPacket({ turn: 4, subject: 'Alice', scene: 'vault', summary: 'Alice unlocked the secret vault.' });

  const runtime = await createHayakuRuntime({
    autoRepair: false,
    messages: [
      user('u1', 'I enter the library.'),
      assistant('a1', hiddenPacketMessage('Alice entered the library.', packet1)),
      user('u2', 'I walk down the hallway.'),
      assistant('a2', hiddenPacketMessage('Alice walked down the hallway.', packet2)),
      user('u3', 'I look for the ancient book.'),
      assistant('a3', hiddenPacketMessage('Alice found the ancient book.', packet3)),
      user('u4', 'I unlock the secret vault.'),
      assistant('a4', hiddenPacketMessage('Alice unlocked the secret vault.', packet4))
    ],
    llmResponder: async () => { throw new Error('no model call expected'); }
  });

  try {
    const t = runtime.hayaku._test;
    const scope = await t.currentChatScope();
    let snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);

    // Initial reconcile to populate worldline and storage ledger with turns 1..4
    await t.reconcileObservedChatTopology(scope, snapshot, 'initial_setup', { prompt: false });

    let ledger = await t.loadStorageLedger(scope, { hydrateArchive: false });
    assert.equal(ledger.logicalRecordCount, 4, `Initial setup should have 4 active logical records, got ${ledger.logicalRecordCount}`);
    
    const activeRecordsBefore = ledger.records.filter(r => r.recordState === 'active');
    assert.equal(activeRecordsBefore.length, 4, `Should have 4 active records initially, got ${activeRecordsBefore.length}`);

    // Record the old node IDs before reroll
    const oldNode1 = ledger.worldline?.nodes?.find(n => n.pairIndex === 1 && n.status === 'active');
    const oldNode2 = ledger.worldline?.nodes?.find(n => n.pairIndex === 2 && n.status === 'active');
    const oldNode4 = ledger.worldline?.nodes?.find(n => n.pairIndex === 4 && n.status === 'active');
    assert.ok(oldNode1, 'Turn 1 active node must exist');
    assert.ok(oldNode2, 'Turn 2 active node must exist');
    assert.ok(oldNode4, 'Turn 4 active node must exist');

    // Simulate rerolling Turn 1:
    // User rerolled Turn 1's assistant message with a new response and new packet.
    // Downstream turns 2..4 remain completely untouched in chat.
    const packet1Rerolled = createValidPacket({ turn: 1, subject: 'Alice', scene: 'grand_library', summary: 'Alice entered the grand library rerolled.' });
    
    runtime.setMessages([
      user('u1', 'I enter the library.'),
      assistant('a1_v2', hiddenPacketMessage('Alice entered the grand library rerolled.', packet1Rerolled)),
      user('u2', 'I walk down the hallway.'),
      assistant('a2', hiddenPacketMessage('Alice walked down the hallway.', packet2)),
      user('u3', 'I look for the ancient book.'),
      assistant('a3', hiddenPacketMessage('Alice found the ancient book.', packet3)),
      user('u4', 'I unlock the secret vault.'),
      assistant('a4', hiddenPacketMessage('Alice unlocked the secret vault.', packet4))
    ]);

    const scope2 = await t.currentChatScope();
    const snapshot2 = t.authoritativeChatSnapshot(scope2.chatMessages, scope2);

    // Reconcile observed chat topology after reroll
    await t.reconcileObservedChatTopology(scope2, snapshot2, 'reroll_turn1', { prompt: false });

    ledger = await t.loadStorageLedger(scope2, { hydrateArchive: false });

    // Node 1 should be superseded by the new Node 1
    const newNode1 = ledger.worldline?.nodes?.find(n => n.pairIndex === 1 && n.status === 'active');
    assert.notEqual(newNode1.turnNodeId, oldNode1.turnNodeId, 'Turn 1 should have a new active node ID after reroll');

    // Due to the hash chain cascade, Turn 2 also gets a new turnNodeId
    const newNode2 = ledger.worldline?.nodes?.find(n => n.pairIndex === 2 && n.status === 'active');
    assert.notEqual(newNode2.turnNodeId, oldNode2.turnNodeId, 'Turn 2 should have a new active node ID due to cascade');

    // CRITICAL ASSERTION 1: logicalRecordCount must remain 4!
    // Before the fix, turns 2..4 became "superseded" and logicalRecordCount collapsed to 1.
    assert.equal(
      ledger.logicalRecordCount,
      4,
      `After rerolling Turn 1, all 4 turns must remain active in storage ledger! Got ${ledger.logicalRecordCount}`
    );

    // CRITICAL ASSERTION 2: Records for turns 2, 3, 4 must be rebound to the active cascaded nodes
    for (const turn of [2, 3, 4]) {
      const activeRecord = ledger.records.find(r => Number(r.targetPairIndex) === turn && r.recordState === 'active');
      assert.ok(activeRecord, `Turn ${turn} must have an active record in ledger`);
      const activeNode = ledger.worldline?.nodes?.find(n => n.pairIndex === turn && n.status === 'active');
      assert.equal(
        activeRecord.ownerTurnNodeId,
        activeNode.turnNodeId,
        `Turn ${turn} record ownerTurnNodeId must be rebound to the new active node ID`
      );
    }

    // CRITICAL ASSERTION 3: Coverage scan should show ALL 4 turns covered!
    const scan = await t.scanCurrentChatForNativeRecoveryDebts({ reason: 'post_reroll_scan', manualFullScan: true });
    assert.equal(scan.ok, true, 'Coverage scan should succeed');
    
    for (const turn of [1, 2, 3, 4]) {
      const row = scan.coverage.rows.find(r => r.turn === turn);
      assert.ok(row, `Turn ${turn} row must exist in coverage scan`);
      assert.equal(row.state, 'covered', `Turn ${turn} must be covered, but got ${row.state} (${row.reason || ''})`);
    }

    // CRITICAL ASSERTION 4: Cascaded declared parent rebase
    // Add Turn 5 where the packet declared parent_turn_node_id as oldNode4 (simulating a packet generated on a branch that cascaded)
    const packet5WithOldParent = createValidPacket({
      turn: 5,
      subject: 'Alice',
      scene: 'treasury',
      summary: 'Alice entered the treasury.'
    });
    packet5WithOldParent.meta.lineage = {
      parent_turn_node_id: oldNode4.turnNodeId,
      logical_turn_id: 'declared_pre_cascade_logical_id',
      request_nonce: 'nonce_turn_5'
    };

    runtime.setMessages([
      user('u1', 'I enter the library.'),
      assistant('a1_v2', hiddenPacketMessage('Alice entered the grand library rerolled.', packet1Rerolled)),
      user('u2', 'I walk down the hallway.'),
      assistant('a2', hiddenPacketMessage('Alice walked down the hallway.', packet2)),
      user('u3', 'I look for the ancient book.'),
      assistant('a3', hiddenPacketMessage('Alice found the ancient book.', packet3)),
      user('u4', 'I unlock the secret vault.'),
      assistant('a4', hiddenPacketMessage('Alice unlocked the secret vault.', packet4)),
      user('u5', 'I step into the treasury.'),
      assistant('a5', hiddenPacketMessage('Alice entered the treasury.', packet5WithOldParent))
    ]);

    const scope3 = await t.currentChatScope();
    const snapshot3 = t.authoritativeChatSnapshot(scope3.chatMessages, scope3);
    const worldline3 = t.reconcileTurnWorldline(ledger.worldline, snapshot3, scope3);

    const node5 = worldline3.nodes.find(n => n.pairIndex === 5 && n.status === 'active');
    assert.ok(node5, 'Turn 5 active node should exist');
    assert.equal(
      node5.packetLineageStatus,
      'rebased',
      `Turn 5 should be rebased from cascaded parent, not quarantined! Got ${node5.packetLineageStatus} (${node5.packetLineageReason || ''})`
    );
    assert.equal(
      node5.lineageRepairReason,
      'verified_upstream_cascade_rebase',
      `Turn 5 repair reason should be verified_upstream_cascade_rebase, got ${node5.lineageRepairReason}`
    );

    console.log('[TEST] PASS: hayaku_reroll_cascade_rebinding_test passed all assertions!');
  } finally {
    await runtime.dispose();
  }
})();
