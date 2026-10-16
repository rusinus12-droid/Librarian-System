'use strict';
const assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  const results = [];
  for (const mode of ['plugin_only', 'server_only']) {
    const x = await fixture({ mode }), { f } = x;
    try {
      const writes = f.r.storageWrites.length, calls = f.control.calls.length;
      const mutations = x.server?.batches.length || 0;
      const activeBefore = JSON.stringify(await f.r.api.debugReadActiveMicroMemory(6));
      const headBefore = JSON.stringify(await f.getHead());
      const graph = await x.project();
      for (const family of ['canonical', 'micro', 'state', 'lore']) assert.ok(graph.coverage.families[family].units > 0, `${mode}: ${family} must be nonempty`);
      assert.equal(graph.requestLocalReadOnly, true);
      assert.equal(graph.modelDispatchEligible, false);
      assert.equal(graph.readerValidation.storedSelectedBodiesRechecked, true);
      assert.equal(graph.readerValidation.actualHostQualified, false);
      assert.equal(graph.coverage.inventory.inventoryComplete, false);
      assert.equal(graph.byteBounded, false);
      assert.equal(f.control.calls.length, calls);
      assert.equal(f.r.storageWrites.length, writes);
      assert.equal(x.server?.batches.length || 0, mutations, 'no server mutation batch');
      assert.equal(JSON.stringify(await f.r.api.debugReadActiveMicroMemory(6)), activeBefore);
      assert.equal(JSON.stringify(await f.getHead()), headBefore);
      const ids = new Set(graph.nodes.map(node => node.id));
      for (const edge of graph.edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); }
      const micro = graph.units.find(unit => unit.family === 'micro');
      assert.equal(micro.semanticRole, 'micro_candidate'); assert.equal(micro.sourceSpan.exactQuote, QUOTE);
      assert.ok(graph.edges.some(edge => edge.from === micro.nodeId && edge.predicate === 'target_of'));
      const state = graph.units.find(unit => unit.family === 'state' && unit.field === 'ownerRef');
      assert.ok(state); assert.ok(state.headThroughTurn >= 5);
      assert.ok(graph.edges.some(edge => edge.from === state.nodeId && edge.predicate === 'derived_from'));
      for (const lore of graph.units.filter(unit => unit.family === 'lore')) {
        assert.equal(lore.semanticRole, 'background_setting');
        assert.equal(lore.locator.coordinateSpace, 'rendered'); assert.equal(lore.locator.rawOffsetAvailable, false);
        assert.equal(lore.activation.hostSelected, null, 'standalone reader cannot invent request host selection');
      }
      assert.ok(graph.units.filter(unit => unit.family === 'lore').length >= 2, 'lore with no named entity remains independently discoverable');
      assert.ok(graph.edges.some(edge => graph.units.some(unit => unit.family === 'lore' && unit.nodeId === edge.from) && edge.predicate === 'mentions'));
      await assert.rejects(() => x.project({ expectedScopeKey: 'foreign-scope' }), /SCOPE_CHANGED/);
      await assert.rejects(() => x.project({ records: [{ forged: true }] }), /OPTIONS_INVALID/);
      const limited = await x.project({ nodeLimit: 12 });
      assert.ok(limited.nodes.length <= 12); assert.equal(limited.coverage.projectionComplete, false);
      assert.ok(Object.values(limited.coverage.families).some(family => family.reasons.includes('node_work_budget')));
      const page = await x.project({ limit: 1 });
      assert.ok(page.coverage.inventory.microNextCursor);
      assert.ok(page.coverage.families.micro.reasons.includes('micro_pages_unread'));
      const next = await x.project({ limit: 1, microCursor: page.coverage.inventory.microNextCursor });
      assert.notEqual(next.coverage.inventory.microNextCursor, page.coverage.inventory.microNextCursor);
      if (mode === 'plugin_only') {
        const target = (await f.getHead()).world.find(row => row.name === '은빛 열쇠');
        assert.ok(target);
        const correction = await f.r.api.addWorldManagerCorrection({ anchorTurn: 5, target: { domain: 'world' },
          patch: { world: [{ id: target.id, set: { condition: '잠김' } }] } });
        assert.equal(correction.ok, true);
        const corrected = await x.project();
        const value = corrected.units.find(unit => unit.family === 'state' && unit.entityId === target.id && unit.field === 'condition');
        assert.equal(value.value, '잠김'); assert.equal(value.semanticRole, 'user_corrected');
        assert.ok(corrected.edges.some(edge => edge.from === value.nodeId && edge.predicate === 'evidenced_by'
          && corrected.bases.some(basis => basis.id === edge.basisId && basis.kind === 'state_correction')));
        assert.equal(corrected.edges.some(edge => edge.from === value.nodeId && edge.predicate === 'derived_from'), false);
        assert.equal((await f.r.api.addWorldManagerCorrection({ anchorTurn: 5, target: { domain: 'world' },
          patch: { world: [{ id: target.id, clear: ['condition'] }] } })).ok, true);
        const cleared = await x.project();
        const clear = cleared.units.find(unit => unit.family === 'state' && unit.entityId === target.id && unit.field === 'condition');
        assert.equal(clear.availability, 'clear'); assert.equal(clear.value, null);
        assert.equal(clear.semanticRole, 'user_corrected');
        const key = (await f.getManifest()).memories['1'].key, values = f.r.values;
        const get = values.get, original = get.call(values, key); let visits = 0;
        try {
          values.get = function(storageKey) {
            if (storageKey === key && ++visits === 2) {
              const body = JSON.parse(get.call(this, key)); body.summary = 'changed during graph read'; this.set(key, JSON.stringify(body));
            }
            return get.call(this, storageKey);
          };
          await assert.rejects(() => x.project(), /BODY_CHANGED/);
          assert.ok(visits >= 2, 'the real physical body was independently re-read');
        } finally { values.get = get; values.set(key, original); }
        const routeKey = '__memory_suite_internal_scope_routes_v1__:libra', route = values.get(routeKey), beforeBlocked = f.r.storageWrites.length;
        try { values.delete(routeKey); await assert.rejects(() => x.project(), /READ_ROUTE_MODE_UNAVAILABLE/); }
        finally { values.set(routeKey, route); }
        assert.equal(f.r.storageWrites.length, beforeBlocked, 'missing route refuses without initializing storage');
      }
      const changed = [...f.chat.message]; f.chat.message.push({ role: 'user', chatId: 't7-u', data: 'new' }, { role: 'assistant', chatId: 't7-a', data: 'new' });
      f.chat.messages = f.chat.message;
      await assert.rejects(() => x.project({ limit: 1, microCursor: page.coverage.inventory.microNextCursor }), /CURSOR_INVALID/);
      f.chat.message = changed; f.chat.messages = changed;
      results.push({ mode, nodes: graph.nodes.length, edges: graph.edges.length,
        units: Object.fromEntries(Object.entries(graph.coverage.families).map(([family, value]) => [family, value.units])),
        projectionWrites: 0, projectionProviderCalls: 0 });
    } finally { await x.cleanup(); }
  }
  const minimum = await fixture({ minimum: true });
  try {
    const graph = await minimum.project(), sourceOnly = graph.units.filter(unit => unit.family === 'micro');
    assert.equal(sourceOnly.length, 1); assert.equal(sourceOnly[0].semanticRole, 'source_only');
    assert.equal(sourceOnly[0].authority, 'source_only'); assert.equal(sourceOnly[0].text.length, 500);
    assert.equal(sourceOnly[0].sourceSpan.endOffset, 500);
    assert.ok(graph.nodes.some(node => node.id === sourceOnly[0].nodeId && node.kind === 'source_excerpt'));
    results.push({ mode: 'plugin_only', sourceOnlyCharacters: 500, factPromotion: false });
  } finally { await minimum.cleanup(); }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_owner_readers', results,
    validation: 'registered_owner_reader_api_on_synthetic_hosts', unifiedRetrievalImplemented: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
