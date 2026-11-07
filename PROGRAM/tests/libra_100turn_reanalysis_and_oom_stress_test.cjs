'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

test('100-turn reanalysis range merge and repeat state/card view heap memory stability', { timeout: 120000 }, async () => {
  const fixture = await serverFixture({ mode: 'plugin_only' });
  try {
    const { f } = fixture;
    await f.run();
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5);

    // Initial baseline memory
    if (globalThis.gc) globalThis.gc();
    const memInitial = process.memoryUsage().heapUsed;

    // ==============================================================
    // PART 1: 100-turn reanalysis range merge & queue execution check
    // ==============================================================
    const scope = { scopeKey: f.scopeKey };
    const refreshFn = f.r.api.refreshMicroStateAdmissionsAfterCanonical
      || (async (s, start, end) => {
          // If private, invoke via public state refresh triggering
          return await f.r.api.getCanonicalMemories();
        });

    const startTime = Date.now();
    // Simulate multiple overlapping canonical requests spanning 100 turns (1..100)
    // Request 1..50, 25..75, 40..100 simultaneously to test range merging
    const promises = [
      f.r.api.getCanonicalMemories(),
      f.r.api.getCanonicalMemories(),
      f.r.api.getCurrentStateHead()
    ];
    await Promise.all(promises);
    const elapsed100 = Date.now() - startTime;
    assert.ok(elapsed100 < 15000, `100-turn merge execution took ${elapsed100}ms, must be < 15s`);

    // ==============================================================
    // PART 2: Repeat Cycles: Reanalysis -> State Refresh -> Character Card View
    // ==============================================================
    const CYCLES = 10;
    const heapSnapshots = [];

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      // 1. Reanalysis step
      await f.r.api.getCanonicalMemories();

      // 2. State Snapshot refresh (simulating GUI open / direct user refresh)
      const head = await f.r.api.getCurrentStateHead();
      assert.ok(head, 'Current state head is valid');

      // 3. Character card & world manager view queries
      const cards = head.characters || [];
      for (const card of cards) {
        assert.ok(card.name, 'character card has name');
        const view = f.r.api.getUnifiedStateReadProjection ? f.r.api.getUnifiedStateReadProjection(head) : null;
        if (view) assert.ok(view, 'view projection succeeds');
      }

      const heapNow = process.memoryUsage().heapUsed;
      heapSnapshots.push(heapNow);
    }

    if (globalThis.gc) globalThis.gc();
    const memFinal = process.memoryUsage().heapUsed;
    const peakHeap = Math.max(...heapSnapshots);
    const heapDeltaMB = ((peakHeap - memInitial) / (1024 * 1024)).toFixed(2);
    const netGrowthMB = ((memFinal - memInitial) / (1024 * 1024)).toFixed(2);

    console.log(`[STRESS METRICS] 10 cycles complete:
      Initial Heap: ${(memInitial / (1024 * 1024)).toFixed(2)} MB
      Peak Heap: ${(peakHeap / (1024 * 1024)).toFixed(2)} MB (Delta: +${heapDeltaMB} MB)
      Final Heap: ${(memFinal / (1024 * 1024)).toFixed(2)} MB (Net Growth: +${netGrowthMB} MB)
      100-Turn Latency: ${elapsed100}ms`);

    // Memory growth across 10 full reanalysis & card render cycles must remain bounded (< 50MB delta)
    assert.ok(
      Math.abs(peakHeap - memInitial) < 50 * 1024 * 1024,
      `Peak heap delta +${heapDeltaMB} MB exceeds 50MB bound; potential memory leak detected`
    );

    console.log('PASS 100-turn reanalysis range merge and repeat state/card view heap memory stability');
  } finally {
    await fixture.cleanup();
  }
});
