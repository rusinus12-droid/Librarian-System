'use strict';
// N01: the maintenance build can continue the owner enumeration from the unread cursors the last
// published generation reported — the half that makes old memories outside the recent window
// reachable at all. Runs against the shipped registered API in the synthetic host.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const results = [];
const test = async (name, run) => { await run(); results.push(name); };

(async () => {
  const x = await fixture({ mode: 'plugin_only' });
  try {
    // The window request is part of the generation identity, so build and read use the same options.
    // limit 1 forces the window to stop early, so the owner reports the slice it has not been asked for.
    const options = { expectedScopeKey: x.scopeKey, limit: 1 };
    const first = await x.f.r.api.buildMemoryGraphGeneration({ ...options });
    assert.equal(first.status, 'published');
    assert.ok(first.nextWindow, 'a window that stops early must publish an actionable next-window request');
    assert.equal(first.nextWindow.schema, 'libra.graph_next_window.v1');
    assert.equal(first.nextWindow.reason, 'owner_reported_unread');
    assert.ok(first.nextWindow.microCursor.startsWith('mgm1:'), 'the owner cursor is published verbatim');
    assert.deepEqual([...first.nextWindow.families], ['micro']);
    assert.equal(first.sourceInventory.merged.coverage, 'partial');

    await test('N01: the published generation hands back the unread cursor it could not cover', async () => {
      const read = await x.f.r.api.getMemoryGraphDurablePage({ ...options, pool: 'units' });
      assert.equal(read.status, 'verified');
      assert.equal(read.nextWindow.generation, first.generation);
      assert.equal(read.nextWindow.microCursor, first.nextWindow.microCursor);
      assert.equal(JSON.stringify(read.sourceInventory.merged.ownerCursors), JSON.stringify(first.sourceInventory.merged.ownerCursors));
    });

    await test('N01: the next maintenance build continues from that cursor and records it', async () => {
      const second = await x.f.r.api.buildMemoryGraphGeneration({ ...options, continueFromPublished: true });
      assert.equal(second.status, 'published');
      assert.ok(second.continuedFrom, 'a continued build must record what it continued from');
      assert.equal(second.continuedFrom.generation, first.generation);
      assert.equal(second.continuedFrom.microCursor, first.nextWindow.microCursor);
      assert.equal(second.continuedFrom.canonicalCursor, first.nextWindow.canonicalCursor);
      assert.notEqual(second.generation, first.generation, 'continuing must publish a new generation');
      assert.equal(second.sourceInventoryDeltaBasis, 'previous_window');
      for (const delta of second.sourceInventoryDeltas) {
        if (delta.skipped) continue;
        assert.equal(delta.removed.length, 0, delta.family + ' must not claim a cross-window deletion');
        assert.equal(delta.windowChanged, true);
      }
      assert.ok(second.sourceInventory.merged.families.length === 4, 'the continued window still covers four families');
    });
  } finally { await x.cleanup(); }

  await test('N01 negative control: continuing without a published generation is refused, and the option is validated', async () => {
    const fresh = await fixture({ mode: 'plugin_only' });
    try {
      await assert.rejects(() => fresh.f.r.api.buildMemoryGraphGeneration({ expectedScopeKey: fresh.scopeKey, continueFromPublished: true }),
        error => /CONTINUE_UNAVAILABLE/.test(error.code || error.message), 'nothing published yet, so there is nothing to continue from');
      await assert.rejects(() => fresh.f.r.api.buildMemoryGraphGeneration({ expectedScopeKey: fresh.scopeKey, continueFromPublished: 'yes' }),
        error => /OPTIONS_INVALID/.test(error.code || error.message), 'the flag is a boolean, not a string');
    } finally { await fresh.cleanup(); }
  });

  console.log(JSON.stringify({ suite: 'libra_memory_graph_continuation', passed: results.length, tests: results }));
})().catch(error => { console.error('CONTINUATION FAILED', error.code || '', error.message); process.exit(1); });
