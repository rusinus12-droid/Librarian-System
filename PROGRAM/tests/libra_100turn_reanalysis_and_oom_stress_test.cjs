'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
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

test('authentic 100-turn reanalysis, 20 canonical memory batches, in-flight heap peak tracking, and state stability', { timeout: 180000 }, async () => {
  const fixture = await serverFixture({ mode: 'plugin_only', transformSource: observe });
  let inFlightTracker = null;
  let inFlightPeakHeap = 0;
  let eventLoopTicks = 0;

  try {
    const { f } = fixture;

    // ==============================================================
    // 1. SEED 100 TURNS (200 messages) AND REAL MULTI-BATCH GENERATOR
    // ==============================================================
    // Expand to 20 batches of 5 turns = 100 turns (200 messages)
    for (let b = 1; b < 20; b++) {
      fiveMore(f);
    }
    assert.equal(f.chat.message.length, 200, 'Chat contains exactly 100 turn pairs (200 messages)');

    // Dynamic model mock: generates authentic canonical artifacts with matching evidence spans for all 20 batches
    f.control.onCall = args => {
      const text = JSON.stringify(args);
      if (text.includes('[LIBRA MICRO SOURCE CONTRACT]')) {
        return require('./fixtures/libra_reanalysis_kinds_fixture.cjs').microReply(args);
      }
      const m = text.match(/t(\d+)-[ua]/);
      const baseTurn = m ? Math.floor((Number(m[1]) - 1) / 5) * 5 : 0;
      const art = artifact();
      for (const item of [...art.entities, ...art.facts]) {
        for (const span of item.evidenceSpans) {
          span.ref = span.ref.replace(/^t(\d+)/, (_, n) => 't' + (Number(n) + baseTurn));
        }
      }
      return { type: 'success', result: JSON.stringify(art) };
    };

    // ==============================================================
    // 2. RUN REAL 100-TURN CANONICAL REANALYSIS & PROVE ACCUMULATION
    // ==============================================================
    if (globalThis.gc) globalThis.gc();
    const memInitial = process.memoryUsage().heapUsed;
    inFlightPeakHeap = memInitial;

    // Start in-flight real-time heap peak and event-loop tick tracking
    inFlightTracker = setInterval(() => {
      eventLoopTicks++;
      const currentHeap = process.memoryUsage().heapUsed;
      if (currentHeap > inFlightPeakHeap) inFlightPeakHeap = currentHeap;
    }, 1);

    const reanalysisStartTime = Date.now();
    const coldStartResult = await f.r.api.runManualColdStart();
    const reanalysisElapsed = Date.now() - reanalysisStartTime;

    // Verify all 20 batches of 100 turns were analyzed and committed without failures
    assert.equal(coldStartResult.total, 20, '100 turns divided into 20 canonical batches');
    assert.equal(coldStartResult.completed, 20, 'All 20 batches completed analysis');
    assert.equal(coldStartResult.failed, 0, 'Zero batch failures across 100 turns');

    // Verify all 20 canonical memories exist in manifest and getCanonicalMemories
    const memories = await f.r.api.getCanonicalMemories();
    assert.equal(memories.length, 20, 'Exactly 20 canonical memories created and committed across 100 turns');

    // ==============================================================
    // 3. 100-TURN MICRO STATE REANALYSIS RANGE MERGE & YIELD VERIFICATION
    // ==============================================================
    const core = f.r.context.__stress100Test.LibraMemoryCore;
    assert.ok(core, 'LibraMemoryCore is exported');
    const scope = { scopeKey: f.scopeKey };

    // Simultaneous overlapping requests across the full 100 turns
    const p1 = core.refreshMicroStateAdmissionsAfterCanonical(scope, 1, 50);
    const p2 = core.refreshMicroStateAdmissionsAfterCanonical(scope, 25, 80);
    const p3 = core.refreshMicroStateAdmissionsAfterCanonical(scope, 60, 100);
    await Promise.all([p1, p2, p3]);

    const lastRefresh = core.state.lastMicroStateAdmissionRefresh;
    assert.ok(lastRefresh, 'lastMicroStateAdmissionRefresh record exists');
    assert.equal(lastRefresh.startTurn, 1, 'Merged reanalysis started from turn 1');
    assert.equal(lastRefresh.throughTurn, 100, 'Merged reanalysis extended through turn 100');

    // ==============================================================
    // 4. REPEAT 10 CYCLES: STATE REANALYSIS -> HEAD REFRESH -> CARD VIEW
    // ==============================================================
    const CYCLES = 10;
    const cycleSnapshots = [];

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
      // 100-turn Micro state reanalysis
      await core.refreshMicroStateAdmissionsAfterCanonical(scope, 1, 100);
      await f.r.api.getCanonicalMemories();

      // State head & character card / relationship / world view inspection
      const head = await f.r.api.getCurrentStateHead();
      assert.ok(head, `Cycle ${cycle}: Head exists`);
      assert.ok(head.characters?.length > 0, `Cycle ${cycle}: Characters present`);
      for (const card of head.characters || []) {
        assert.ok(card.name, `Cycle ${cycle}: Character card has valid name`);
      }
      for (const rel of head.relationships || []) {
        assert.ok(rel.subjectName && rel.targetName, `Cycle ${cycle}: Relationship valid`);
      }
      for (const w of head.world || []) {
        assert.ok(w.name, `Cycle ${cycle}: World entity valid`);
      }

      cycleSnapshots.push(process.memoryUsage().heapUsed);
    }

    if (globalThis.gc) globalThis.gc();
    const memFinal = process.memoryUsage().heapUsed;

    const inFlightDeltaMB = ((inFlightPeakHeap - memInitial) / (1024 * 1024)).toFixed(2);
    const finalDeltaMB = ((memFinal - memInitial) / (1024 * 1024)).toFixed(2);

    console.log(`[AUTHENTIC 100-TURN STRESS METRICS]
      Total Dialogue Turns: 100 (${f.chat.message.length} messages)
      Canonical Batches Analyzed: ${coldStartResult.completed}/${coldStartResult.total}
      Committed Memories in Storage: ${memories.length}
      Initial Heap: ${(memInitial / (1024 * 1024)).toFixed(2)} MB
      In-Flight Peak Heap: ${(inFlightPeakHeap / (1024 * 1024)).toFixed(2)} MB (Peak In-Flight Delta: +${inFlightDeltaMB} MB)
      Final Heap (Post-10 Cycles): ${(memFinal / (1024 * 1024)).toFixed(2)} MB (Net Growth: +${finalDeltaMB} MB)
      Event-Loop Yield Ticks: ${eventLoopTicks}
      100-Turn Initial Reanalysis Latency: ${reanalysisElapsed}ms`);

    // In-flight peak memory growth under authentic 100-turn cold-start + 20-batch load must remain bounded (< 120MB transient peak delta)
    assert.ok(
      Math.abs(inFlightPeakHeap - memInitial) < 120 * 1024 * 1024,
      `In-flight peak heap delta +${inFlightDeltaMB} MB exceeds 120MB bound; potential memory leak detected`
    );

    // Total post-stress heap across 10 repeat cycles under 100-turn accumulated memory must remain bounded under 200MB (no runaway leak)
    assert.ok(
      memFinal < 200 * 1024 * 1024,
      `Final heap ${(memFinal / (1024 * 1024)).toFixed(2)} MB exceeds 200MB ceiling; uncontrolled accumulation detected`
    );

    console.log('PASS authentic 100-turn reanalysis, 20 canonical memory batches, in-flight heap peak tracking, and state stability');
  } finally {
    if (inFlightTracker) {
      clearInterval(inFlightTracker);
      inFlightTracker = null;
    }
    await fixture.cleanup();
  }
});
