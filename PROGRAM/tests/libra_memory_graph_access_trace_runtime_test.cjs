'use strict';
// N01 completion: the read path is observable. This suite checks that the access trace reports what the
// query actually read (Lane pages/bytes per role, frontier steps, workspace bytes), that it agrees with
// the kernel's own diagnostics, that a budget stop is visible instead of hidden, and that the trace
// never confers any authority of its own.
const assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const results = [];
const test = async (name, run) => { await run(); results.push(name); };
const LANE_BUDGET = { maxPages: 1, maxBytes: 512, pageBytes: 256 };

(async () => {
  const x = await fixture({ mode: 'plugin_only' });
  try {
    const api = x.f.r.api;
    const options = { expectedScopeKey: x.scopeKey, queryInput: { queryText: QUOTE } };
    const exec = await api.executeMemoryGraphUnifiedQuery({ ...options });
    const tiny = await api.executeMemoryGraphUnifiedQuery({ ...options, laneBudget: LANE_BUDGET });
    const trace = exec.accessTrace;

    await test('N01: a query reports the shard/cache/Lane path it actually read', () => {
      assert.equal(trace.schema, 'libra.graph_access_trace.v1');
      assert.equal(trace.authority, 'descriptive_only');
      assert.equal(trace.generation, exec.generation);
      assert.equal(trace.indexDigest, exec.indexDigest);
      assert.ok(Number.isSafeInteger(trace.lane.pagesRead) && trace.lane.pagesRead > 0, 'the Lane must report the pages it read');
      assert.ok(trace.lane.bytesRead > 0 && trace.lane.maxBytes > 0);
      assert.ok(trace.lane.roleStats && Object.keys(trace.lane.roleStats).length >= 4, 'the trace must break the read down by Lane role');
      const servedRoles = Object.entries(trace.lane.roleStats).filter(([, stats]) => stats.pages > 0);
      assert.ok(servedRoles.length >= 1, 'at least one role served pages: ' + JSON.stringify(trace.lane.roleStats));
      for (const [, stats] of Object.entries(trace.lane.roleStats)) {
        assert.ok(Number.isSafeInteger(stats.pages) && stats.pages >= 0);
        assert.ok(Number.isSafeInteger(stats.bytes) && stats.bytes >= 0);
        assert.ok(Number.isSafeInteger(stats.requests) && stats.requests >= 0);
      }
      assert.ok(Number.isSafeInteger(trace.frontier.steps) && trace.frontier.steps >= 0);
      assert.equal(trace.workspace.exceeded, false);
      assert.ok(Array.isArray(trace.lane.unreadCursors));
    });

    await test('N01: the trace agrees with the kernel diagnostics it summarises', () => {
      const diagnostics = exec.diagnostics;
      assert.equal(trace.lane.pagesRead, diagnostics.lanePagesRead, 'pagesRead must match the kernel diagnostic');
      assert.equal(trace.lane.bytesRead, diagnostics.laneBytesRead, 'bytesRead must match the kernel diagnostic');
      assert.equal(trace.lane.maxBytes, diagnostics.laneMaxBytes, 'maxBytes must match the kernel diagnostic');
      assert.equal(trace.lane.cacheHits, diagnostics.laneCacheHits);
      assert.equal(trace.lane.coalescedRequests, diagnostics.laneCoalescedRequests);
      assert.equal(trace.workspace.l0WorkspaceBytes, diagnostics.l0WorkspaceBytes);
      assert.equal(trace.workspace.maxWorkspaceBytes, diagnostics.maxWorkspaceBytes);
      assert.equal(trace.frontier.steps, diagnostics.poppedFrontierSteps);
      assert.equal(trace.frontier.onDemandNeighborhoodAnchors, diagnostics.onDemandNeighborhoodAnchors);
      assert.equal(trace.coverage.complete, exec.queryComplete);
      assert.equal(trace.coverage.stopReason, exec.stopReason);
    });

    await test('N01 negative control: a budget stop is visible in the trace, with the outcome it caused', () => {
      assert.equal(exec.deliveryOutcome, 'complete');
      assert.equal(tiny.deliveryOutcome, 'partial', 'a stopped query must not be called complete');
      assert.equal(tiny.accessTrace.lane.complete, false);
      assert.ok(tiny.accessTrace.lane.stopReason.length > 0, 'the Lane must name why it stopped');
      assert.ok(/^lane_/.test(tiny.stopReason), 'the stop reason must name the Lane budget: ' + tiny.stopReason);
      assert.ok(tiny.accessTrace.lane.pagesRead < exec.accessTrace.lane.pagesRead,
        'the stopped query read fewer pages: ' + tiny.accessTrace.lane.pagesRead + ' < ' + exec.accessTrace.lane.pagesRead);
      assert.ok(tiny.accessTrace.lane.bytesRead < exec.accessTrace.lane.bytesRead);
      assert.equal(tiny.accessTrace.lane.maxBytes, LANE_BUDGET.maxBytes, 'the trace reports the budget it was given');
      assert.equal(tiny.accessTrace.coverage.complete, false);
    });

    await test('N01: the trace describes the read and grants nothing', async () => {
      assert.equal(exec.modelDispatchEligible === true, Boolean(exec.dispatchVerification?.modelDispatchEligible === true && exec.mode === 'unified'),
        'dispatch eligibility still comes from the separate dispatch verification, never from the trace');
      assert.equal(trace.authority, 'descriptive_only');
      assert.equal(Object.prototype.hasOwnProperty.call(trace, 'modelDispatchEligible'), false, 'the trace carries no dispatch flag');
      const recall = await api.previewUnifiedMemoryRecall({ queryText: QUOTE, unifiedEngineMode: 'unified' });
      const exposed = recall.diagnostics?.unifiedMemoryEngine?.accessTrace;
      assert.equal(exposed?.schema, 'libra.graph_access_trace.v1', 'the recall diagnostics expose the same trace');
      assert.equal(exposed.authority, 'descriptive_only');
    });
  } finally { await x.cleanup(); }

  console.log(JSON.stringify({ suite: 'libra_memory_graph_access_trace', passed: results.length, tests: results }));
})().catch(error => { console.error('ACCESS TRACE FAILED', error.code || '', error.message); process.exit(1); });
