'use strict';
// N01 last piece: a query reads a slice of the source window, and the slice the owner has not been
// asked for yet is reachable through a query when the caller passes that owner cursor.
//
// The measurements below are what this suite asserts (fixture, plugin_only synthetic host):
//   default window (limit 1)  -> turns 0..5, no turn-6 Micro memory, deliveryOutcome 'partial',
//                                an actionable next-window cursor mgm1:1
//   continued window (mgm1:5) -> turns 0..6 including the turn-6 Micro memory, deliveryOutcome
//                                'complete', no further cursor
// So the cursor walks *forward* through the family's own turn order; nothing here asserts a direction
// it did not measure. A forged cursor is refused instead of quietly returning the default window.
const assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const results = [];
const test = async (name, run) => { await run(); results.push(name); };
const turnStarts = result => [...new Set((result.memories || []).map(memory => Number(memory.memory?.turnRange?.start ?? -1)))].sort((a, b) => a - b);

(async () => {
  const x = await fixture({ mode: 'plugin_only' });
  try {
    const api = x.f.r.api;
    const base = { queryText: QUOTE, unifiedEngineMode: 'unified' };
    const page = await x.project({ limit: 5 });
    const ownerCursor = String(page.coverage?.inventory?.microNextCursor || '');
    assert.ok(/^mgm1:\d+:[0-9a-f]+:\d+$/.test(ownerCursor), 'the owner reports its own unread cursor: ' + ownerCursor);

    const first = await api.previewUnifiedMemoryRecall({ ...base, unifiedWindow: { limit: 1 } });
    const continued = await api.previewUnifiedMemoryRecall({ ...base, unifiedWindow: { limit: 1, microCursor: ownerCursor } });

    await test('N01: a query reports the source window it actually read', () => {
      assert.equal(first.windowRead.schema, 'libra.graph_query_window.v1');
      assert.equal(first.windowRead.limit, 1);
      assert.equal(first.windowRead.microCursor, '', 'the default query reads the default window');
      assert.equal(first.windowRead.projectionComplete, false, 'a window-bounded read must not claim a complete projection');
      assert.equal(first.windowRead.inventory.microRead, 0, 'the default window read no Micro turns');
      assert.equal(continued.windowRead.inventory.microRead, 1, 'the continued window read the slice the cursor pointed at');
      assert.equal(continued.windowRead.limit, 1);
      assert.equal(continued.windowRead.microCursor, ownerCursor, 'the continued query reports the cursor it was given');
      assert.equal(continued.windowRead.inventory.inventoryComplete, false, 'the owner inventory is not complete — carried through unchanged');
    });

    await test('N01: the slice outside the default window is found by query, and only with its cursor', () => {
      assert.equal(turnStarts(first).includes(6), false, 'the turn-6 Micro memory is outside the default window: ' + JSON.stringify(turnStarts(first)));
      assert.equal(turnStarts(continued).includes(6), true, 'continuing the enumeration reaches it: ' + JSON.stringify(turnStarts(continued)));
      assert.equal(continued.diagnostics.unifiedMemoryEngine.deliveryOutcome, 'complete');
      assert.equal(first.diagnostics.unifiedMemoryEngine.deliveryOutcome, 'partial', 'the default window cannot claim completeness');
    });

    await test('N01: the query hands back the cursor for the part it did not read', () => {
      assert.ok(first.nextWindow, 'a partial window must be actionable');
      assert.equal(first.nextWindow.schema, 'libra.graph_next_window.v1');
      assert.equal(first.nextWindow.reason, 'owner_reported_unread');
      assert.deepEqual([...first.nextWindow.families], ['micro']);
      assert.ok(/^mgm1:1:/.test(first.nextWindow.microCursor));
      assert.equal(continued.nextWindow, null, 'the continued window reaches the end of the reported family');
    });

    await test('N01 negative control: a forged or foreign cursor is refused, never silently replaced by the default window', async () => {
      const forgedSignature = ownerCursor.replace(/^(mgm1:\d+:)[0-9a-f]+(:\d+)$/, '$1' + '0'.repeat(8) + '$2');
      assert.notEqual(forgedSignature, ownerCursor);
      await assert.rejects(() => api.previewUnifiedMemoryRecall({ ...base, unifiedWindow: { limit: 1, microCursor: forgedSignature } }),
        error => /MICRO_CURSOR_INVALID/.test(error.code || error.message), 'a forged signature must be refused');
      await assert.rejects(() => api.previewUnifiedMemoryRecall({ ...base, unifiedWindow: { limit: 1, microCursor: 'mgm1:999:' + '0'.repeat(8) + ':392' } }),
        error => /CURSOR_INVALID/.test(error.code || error.message), 'an out-of-range offset must be refused');
      await assert.rejects(() => api.previewUnifiedMemoryRecall({ ...base, unifiedWindow: { limit: 51 } }),
        error => /OPTIONS_INVALID|LIMIT/.test(error.code || error.message), 'a window request outside the validated range is refused');
    });
  } finally { await x.cleanup(); }

  console.log(JSON.stringify({ suite: 'libra_memory_graph_query_window', passed: results.length, tests: results }));
})().catch(error => { console.error('QUERY WINDOW FAILED', error.code || '', error.message); process.exit(1); });
