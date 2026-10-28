'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const hostFactory = require('./fixtures/libra_gui_memory_dom_host.cjs');

async function run() {
  console.log('[TEST] Starting libra_memory_maintenance_intelligent_scenarios_test...');

  // Scenario 1: Preflight inspection with 10 turns (2 completed batches) and 0 saved memories -> triggers Cold Start
  const host1 = await hostFactory.create('LIBRA', 'Full', {
    initialChat: [
      { role: 'user', data: 'T1 user' },
      { role: 'assistant', data: 'T1 assistant' },
      { role: 'user', data: 'T2 user' },
      { role: 'assistant', data: 'T2 assistant' },
      { role: 'user', data: 'T3 user' },
      { role: 'assistant', data: 'T3 assistant' },
      { role: 'user', data: 'T4 user' },
      { role: 'assistant', data: 'T4 assistant' },
      { role: 'user', data: 'T5 user' },
      { role: 'assistant', data: 'T5 assistant' },
      { role: 'user', data: 'T6 user' },
      { role: 'assistant', data: 'T6 assistant' },
      { role: 'user', data: 'T7 user' },
      { role: 'assistant', data: 'T7 assistant' },
      { role: 'user', data: 'T8 user' },
      { role: 'assistant', data: 'T8 assistant' },
      { role: 'user', data: 'T9 user' },
      { role: 'assistant', data: 'T9 assistant' },
      { role: 'user', data: 'T10 user' },
      { role: 'assistant', data: 'T10 assistant' }
    ]
  });

  try {
    const plan = await host1.api.inspectMemoryMaintenance();
    assert.equal(plan.liveTurns, 10);
    assert.equal(plan.completeBatches, 2);
    assert.equal(plan.savedRangesCount, 0);
    assert.equal(plan.coldStartNeeded, true, 'coldStartNeeded must be true when 0 saved memories and completeBatches > 0');
    assert.ok(plan.issues.some(i => i.code === 'COLD_START_REQUIRED'), 'Issues must report COLD_START_REQUIRED');

    // Run auto maintenance with preflight
    const result = await host1.api.runMemoryMaintenance('auto', { preflight: plan });
    assert.equal(result.status, 'completed');
    assert.ok(Array.isArray(result.actionsTaken));
    // Verify cold start action was recorded
    const coldStartAction = result.actionsTaken.find(a => a.includes('수동 콜드스타트'));
    assert(coldStartAction, 'Auto maintenance must execute and record cold start action');
    console.log('✓ Scenario 1 (Cold Start execution): PASS');
  } finally {
    await host1.close();
  }

  // Scenario 2: Auto recovery with mock missing ranges
  const host2 = await hostFactory.create('LIBRA', 'Full', {
    initialChat: [
      { role: 'user', data: 'T1' },
      { role: 'assistant', data: 'T1 A' }
    ]
  });

  try {
    const mockPreflight = {
      schema: 'libra.memory_maintenance_plan.v1',
      healthy: false,
      liveTurns: 15,
      completeBatches: 3,
      pendingTurns: 0,
      savedRangesCount: 1, // Already has 1 saved memory -> not cold start
      missingRangesCount: 1,
      missingRanges: [
        { startTurn: 6, endTurn: 10, status: 'missing', sourceDigest: 'mock_digest_6_10', identityDigest: 'mock_ident_6_10' }
      ],
      failedRangesCount: 0,
      failedRanges: [],
      lastCommittedTurn: 5,
      stateThroughTurn: 5,
      stateLagging: false,
      embedSummary: { state: 'ready', text: 'Ready' },
      vectorTotal: 10,
      vectorCompleted: 8,
      vectorPending: 0,
      vectorFailed: 2, // 2 failed vectors
      issues: [
        { code: 'CANONICAL_BATCHES_MISSING', text: '누락된 정본 5턴 구간 1개' },
        { code: 'EMBEDDING_VECTORS_FAILED', text: '임베딩 벡터 생성 실패 2건' }
      ]
    };

    const callsBefore = host2.wire.length;
    await assert.rejects(host2.api.runMemoryMaintenance('auto', { preflight: mockPreflight }), /점검한 채팅 범위/);
    assert.equal(host2.wire.length, callsBefore, 'unbound plans cannot authorize model or embedding work');
    console.log('✓ Scenario 2 (Unbound recovery plan refused): PASS');
  } finally {
    await host2.close();
  }

  console.log('[TEST] PASS: All intelligent maintenance scenarios passed successfully!');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
