'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const observe = source => source
  .replace(
    'assertConsumerEvidenceCurrent,',
    'assertConsumerEvidenceCurrent, refreshMicroStateAdmissionsAfterCanonical,'
  )
  .replace(
    '  const publicApi = Object.freeze({\n    getHostLineageStatus:',
    '  globalThis.__stress100Test = { LibraMemoryCore };\n  const publicApi = Object.freeze({\n    getHostLineageStatus:'
  );

test('authentic 100-turn reanalysis range merge, event-loop yield, and repeat state/card view heap memory stability', { timeout: 120000 }, async () => {
  const fixture = await serverFixture({ mode: 'plugin_only', transformSource: observe });
  try {
    const { f } = fixture;
    await f.run();
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 5);

    const core = f.r.context.__stress100Test.LibraMemoryCore;
    assert.ok(core, 'LibraMemoryCore is exported');
    assert.equal(typeof core.refreshMicroStateAdmissionsAfterCanonical, 'function', 'refreshMicroStateAdmissionsAfterCanonical is available');

    // ==============================================================
    // SEED 100 TURNS (200 messages) OF REAL DIALOGUE DATA
    // ==============================================================
    // Turns 1..5 are seeded by default fixture (10 messages).
    // Append turns 6..100 (190 messages) so the chat contains 100 authentic U+A turn pairs.
    for (let turn = 6; turn <= 100; turn++) {
      f.chat.message.push(
        { role: 'user', chatId: `t${turn}-u`, data: `사용자 ${turn}번째 발화입니다. 도서관과 서재의 은빛 열쇠 기록을 점검합니다.` },
        { role: 'assistant', chatId: `t${turn}-a`, data: `민아가 ${turn}번째 턴에서 도서관 서재 상황과 약속을 기록했습니다.` }
      );
    }
    f.chat.messages = f.chat.message;
    assert.equal(f.chat.message.length, 200, 'Chat contains exactly 100 turn pairs (200 messages)');

    // Baseline memory measurement
    if (globalThis.gc) globalThis.gc();
    const memInitial = process.memoryUsage().heapUsed;

    // ==============================================================
    // PART 1: Authentic 100-turn reanalysis range merge & event loop yield check
    // ==============================================================
    const scope = { scopeKey: f.scopeKey };

    // Track event-loop responsiveness while the 100-turn reanalysis executes
    let eventLoopTicks = 0;
    const tickInterval = setInterval(() => { eventLoopTicks++; }, 1);

    const startTime = Date.now();
    // Simulate overlapping reanalysis ranges across 100 turns: 1..50, 25..80, 60..100
    // The scheduler must merge these into a single run spanning 1..100.
    const p1 = core.refreshMicroStateAdmissionsAfterCanonical(scope, 1, 50);
    const p2 = core.refreshMicroStateAdmissionsAfterCanonical(scope, 25, 80);
    const p3 = core.refreshMicroStateAdmissionsAfterCanonical(scope, 60, 100);

    await Promise.all([p1, p2, p3]);
    const elapsed100 = Date.now() - startTime;
    clearInterval(tickInterval);

    // Verify range merge result: the single execution must span startTurn 1 through throughTurn 100
    const lastRefresh = core.state.lastMicroStateAdmissionRefresh;
    assert.ok(lastRefresh, 'lastMicroStateAdmissionRefresh record exists');
    assert.equal(lastRefresh.startTurn, 1, 'Merged reanalysis started from turn 1');
    assert.equal(lastRefresh.throughTurn, 100, 'Merged reanalysis extended through turn 100');

    // Verify non-blocking event-loop yielding: every 10 turns yields via setTimeout(0),
    // producing at least 9 yield points across 100 turns so ticks must be >= 9.
    assert.ok(
      eventLoopTicks >= 9,
      `Event loop yielded ${eventLoopTicks} times during 100-turn reanalysis (expected >= 9 yields for 10-turn cadence)`
    );
    assert.ok(elapsed100 < 15000, `100-turn reanalysis took ${elapsed100}ms, must be < 15s`);

    // ==============================================================
    // PART 2: Repeat 10 Cycles: 100-turn Reanalysis -> State Refresh -> Character Card View
    // ==============================================================
    const CYCLES = 10;
    const heapSnapshots = [];

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      // 1. Reanalysis step over full 100 turns
      await core.refreshMicroStateAdmissionsAfterCanonical(scope, 1, 100);
      await f.r.api.getCanonicalMemories();

      // 2. State Snapshot refresh (simulating GUI open / direct user refresh)
      const head = await f.r.api.getCurrentStateHead();
      assert.ok(head, `Cycle ${cycle}: Current state head is valid`);

      // 3. Character card & world view queries
      const cards = head.characters || [];
      assert.ok(cards.length > 0, `Cycle ${cycle}: Character cards present`);
      for (const card of cards) {
        assert.ok(card.name, `Cycle ${cycle}: character card has name`);
      }
      for (const rel of head.relationships || []) {
        assert.ok(rel.subjectName && rel.targetName, `Cycle ${cycle}: relationship valid`);
      }
      for (const w of head.world || []) {
        assert.ok(w.name, `Cycle ${cycle}: world entry valid`);
      }

      const heapNow = process.memoryUsage().heapUsed;
      heapSnapshots.push(heapNow);
    }

    if (globalThis.gc) globalThis.gc();
    const memFinal = process.memoryUsage().heapUsed;
    const peakHeap = Math.max(...heapSnapshots);
    const heapDeltaMB = ((peakHeap - memInitial) / (1024 * 1024)).toFixed(2);
    const netGrowthMB = ((memFinal - memInitial) / (1024 * 1024)).toFixed(2);

    console.log(`[STRESS METRICS] 100-turn authentic reanalysis + 10 cycles complete:
      Chat Size: ${f.chat.message.length} messages (100 turns)
      Event-Loop Yield Ticks: ${eventLoopTicks} (Cadence: every 10 turns)
      100-Turn Latency: ${elapsed100}ms
      Initial Heap: ${(memInitial / (1024 * 1024)).toFixed(2)} MB
      Peak Heap: ${(peakHeap / (1024 * 1024)).toFixed(2)} MB (Delta: +${heapDeltaMB} MB)
      Final Heap: ${(memFinal / (1024 * 1024)).toFixed(2)} MB (Net Growth: +${netGrowthMB} MB)`);

    // Memory growth across 10 full reanalysis & card render cycles must remain bounded (< 50MB delta)
    assert.ok(
      Math.abs(peakHeap - memInitial) < 50 * 1024 * 1024,
      `Peak heap delta +${heapDeltaMB} MB exceeds 50MB bound; potential memory leak detected`
    );

    console.log('PASS authentic 100-turn reanalysis range merge, event-loop yield, and repeat state/card view heap memory stability');
  } finally {
    await fixture.cleanup();
  }
});
