'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const retryBusy = async run => { for (let i = 0; ; i++) { try { return await run(); }
  catch (error) { if (!/BUSY/.test(error.code || error.message) || i >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } } };
(async () => {
  const results = [];
  for (const mode of ['plugin_only','server_only']) {
    const x = await fixture({ mode }); let f = x.f, api = f.r.api;
    const options = { expectedScopeKey: x.scopeKey };
    const records = schema => x.f.getRecords(schema);
    const change = async (key, value) => {
      if (x.server) await x.server.mutate(key, value);
      else x.f.r.values.set(key, JSON.stringify(value));
    };
    try {
      const source = await x.project(), writes0 = f.r.storageWrites.length, batches0 = x.server?.batches.length || 0;
      assert.equal((await api.getMemoryGraphDurablePage(options)).status, 'missing_generation');
      assert.equal(f.r.storageWrites.length, writes0); assert.equal(x.server?.batches.length || 0, batches0);
      const calls = f.control.calls.length, built = await api.buildMemoryGraphGeneration(options);
      assert.equal(built.status, 'published'); assert.equal(built.pageCount, 17);
      assert.deepEqual(plain(built.totals), { nodes: 48, edges: 81, bases: 27, units: 33 });
      assert.equal(built.publication, mode === 'server_only' ? 'conditional_root_cas' : 'runtime_ordered_root_last_readback_partial');
      assert.equal(built.ownerAtomicity, false); assert.equal(built.inventoryComplete, false); assert.equal(f.control.calls.length, calls);
      const root = records('libra.graph_root.v1')[0]; assert.ok(root);
      if (mode === 'plugin_only') assert.equal(f.r.storageWrites.at(-1).key, root.key, 'root is the final maintenance write');
      else {
        const finalBatch = x.server.batches.at(-1);
        assert.ok(finalBatch.mutations.some(row => row.key === root.key));
        assert.ok(finalBatch.conditions.length > 17, 'root CAS pins pages/manifest and current source keys');
      }
      const readWrites = f.r.storageWrites.length, readBatches = x.server?.batches.length || 0;
      const rows = []; let cursor = '', first, count = 0;
      do {
        const page = await api.getMemoryGraphDurablePage({ ...options, cursor }); first ||= page;
        assert.equal(page.status, 'verified'); assert.equal(page.durableGenerationVerified, true);
        assert.equal(page.modelDispatchEligible, false); assert.equal(page.byteBounded, false);
        assert.equal(page.cache.bytes.request, 0); assert.equal(page.cache.bytes.staging, 0); assert.equal(page.cache.pins, 0);
        rows.push(...plain(page.items)); cursor = page.nextCursor;
      } while (cursor && ++count < 30);
      assert.equal(cursor, ''); assert.deepEqual(rows, plain(source.units));
      assert.equal(f.r.storageWrites.length, readWrites); assert.equal(x.server?.batches.length || 0, readBatches);
      assert.equal(f.control.calls.length, calls);
      await assert.rejects(() => api.getMemoryGraphDurablePage({ ...options, graph: source }), /OPTIONS_INVALID/);
      await assert.rejects(() => api.getMemoryGraphDurablePage({ ...options, expectedScopeKey: 'foreign' }), /SCOPE_CHANGED/);
      await assert.rejects(() => api.getMemoryGraphDurablePage({ ...options, pool: 'nodes', cursor: first.nextCursor }), /CURSOR_INVALID/);
      f = await x.restart(); api = f.r.api;
      const restartWrites = f.r.storageWrites.length, restartBatches = x.server?.batches.length || 0;
      const restarted = await api.getMemoryGraphDurablePage(options);
      assert.equal(restarted.status, 'verified'); assert.equal(restarted.generation, built.generation);
      assert.deepEqual(plain(restarted.items), plain(first.items));
      assert.equal(f.control.calls.length, 0); assert.equal(f.r.storageWrites.length, restartWrites);
      assert.equal(x.server?.batches.length || 0, restartBatches);
      const pageRecord = records('libra.graph_durable_page.v1').find(row => row.value.pool === 'lore');
      // Lore has no pool of its own: select the units page containing a lore unit.
      const corrupt = pageRecord || records('libra.graph_durable_page.v1').find(row => row.value.pool === 'units'
        && JSON.parse(row.value.text).some(unit => unit.family === 'lore'));
      assert.ok(corrupt);
      await change(corrupt.key, { ...corrupt.value, text: '[]' });
      const brokenWrites = f.r.storageWrites.length, brokenBatches = x.server?.batches.length || 0;
      await assert.rejects(() => api.getMemoryGraphDurablePage({ ...options, pool: 'nodes' }), /PAGE_CORRUPT/);
      assert.equal(f.r.storageWrites.length, brokenWrites); assert.equal(x.server?.batches.length || 0, brokenBatches);
      await change(corrupt.key, corrupt.value);
      if (mode === 'server_only') {
        const latest = records('libra.graph_root.v1')[0], manifest = records('libra.graph_generation.v1').find(row => row.key === latest.value.manifestKey);
        assert.ok(manifest); let injected = false, winner;
        x.server.hooks.beforeBatch = async body => {
          if (injected || !body.mutations.some(row => row.key === latest.key)) return;
          injected = true;
          const other = { ...manifest.value, jobToken: 'independent-publisher' }, generation = fingerprint(JSON.stringify(other));
          const prefix = latest.value.manifestKey.slice(0, latest.value.manifestKey.lastIndexOf('generation:'));
          const manifestKey = prefix + 'generation:' + generation;
          await change(manifestKey, other);
          winner = { ...latest.value, generation, manifestKey, publicationToken: other.jobToken };
          await change(latest.key, winner);
        };
        try { await assert.rejects(() => api.buildMemoryGraphGeneration(options), error => error.status === 409 || /CONFLICT|CHANGED/.test(error.code || error.message)); }
        finally { x.server.hooks.beforeBatch = null; }
        assert.equal(injected, true); assert.deepEqual(records('libra.graph_root.v1')[0].value, winner);
        await assert.rejects(() => api.getMemoryGraphDurablePage({ ...options, cursor: first.nextCursor }), /CURSOR_STALE/);
        assert.equal((await api.getMemoryGraphDurablePage(options)).status, 'verified');
      } else {
        const old = records('libra.graph_root.v1')[0], oldRaw = f.r.values.get(old.key), memoryKey = (await f.getManifest()).memories['1'].key;
        const original = f.r.values.get(memoryKey), memory = JSON.parse(original); memory.summary = 'new source body'; f.r.values.set(memoryKey, JSON.stringify(memory));
        assert.equal((await api.getMemoryGraphDurablePage(options)).status, 'stale_generation');
        const backend = f.r.context.risuai.pluginStorage, set = backend.setItem;
        let release, start; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { start = resolve; });
        backend.setItem = async (key, value) => { if (key.includes(':memory-graph:v1:page:')) { start(); await gate; } return await set.call(backend, key, value); };
        const pending = api.buildMemoryGraphGeneration(options); await entered;
        api.cancelMemoryGraphGenerationBuild(); assert.equal(api.inspectMemoryGraphStore().activeBuild, true);
        await assert.rejects(() => api.buildMemoryGraphGeneration(options), /BUILD_BUSY/);
        release();
        try { await assert.rejects(() => pending, /CANCELLED|OWNER_CHANGED/); } finally { backend.setItem = set; }
        assert.equal(f.r.values.get(old.key), oldRaw); assert.equal(api.inspectMemoryGraphStore().activeBuild, false);
        f.r.values.set(memoryKey, original);
        const portable = f.r.context.__LIBRAPortableMemoryBackup, backup = await retryBusy(() => portable.exportCurrentScope());
        await retryBusy(() => portable.restoreCurrentScope(backup));
        const restoreWrites = f.r.storageWrites.length;
        assert.equal((await api.getMemoryGraphDurablePage(options)).status, 'stale_generation');
        assert.equal(f.r.storageWrites.length, restoreWrites, 'restored stale index is not rebuilt by the query');
      }
      results.push({ mode, persistedPages: built.pageCount, units: rows.length, restartVerified: true,
        queryWrites: 0, queryProviderCalls: 0, corruptionRejected: true,
        publicationRaceTested: mode === 'server_only', cancelledWriteBarrierTested: mode === 'plugin_only' });
    } finally { await x.cleanup(); }
  }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_store_registered_api', results,
    validation: 'synthetic_owner_hosts_with_real_storage_bridge', ownerAtomicity: false, unifiedRetrievalImplemented: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
