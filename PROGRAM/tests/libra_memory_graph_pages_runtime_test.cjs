'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const retryBusy = async run => { for (let i = 0; ; i++) { try { return await run(); }
  catch (error) { if (!/BUSY/.test(error.code || error.message) || i >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 100)); } } };
(async () => {
  const results = [];
  for (const mode of ['plugin_only','server_only']) {
    const x = await fixture({ mode }), { f } = x, api = f.r.api;
    try {
      assert.equal(api.inspectMemoryGraphPages().initialized, false, 'existing reader setup never starts the new page store');
      const options = { expectedScopeKey: x.scopeKey, pageBytes: 2500 };
      const read = extra => api.getMemoryGraphAccessPage({ ...options, ...extra });
      const calls = f.control.calls.length, writes = f.r.storageWrites.length, batches = x.server?.batches.length || 0;
      const source = await x.project();
      const ownerReadCount = () => x.server ? x.server.requests.filter(row => row.url.includes('/v1/kv/')).length : f.r.storageReads.length;
      const cold = await read(), reads = ownerReadCount(), warm = await read();
      assert.equal(cold.cacheHit, false); assert.equal(warm.cacheHit, true);
      assert.ok(ownerReadCount() > reads, 'a warm derived page does not suppress current owner reads');
      assert.equal(warm.generation, cold.generation); assert.deepEqual(plain(warm.items), plain(cold.items));
      assert.ok(cold.items.length && cold.nextCursor); assert.equal(cold.pool, 'units');
      assert.equal(cold.modelDispatchEligible, false); assert.equal(cold.byteBounded, false);
      assert.equal(cold.durableGenerationVerified, false); assert.equal(cold.readerValidation.actualHostQualified, false);
      const collected = []; let cursor = '', pages = 0;
      do {
        const page = await read({ cursor, pageBytes: 16384 }); pages++; collected.push(...plain(page.items)); cursor = page.nextCursor;
        assert.ok(page.items.length, JSON.stringify({ offset: page.offset, stopReason: page.stopReason, detail: page.budgetDetail })); assert.ok(page.serializedUtf8Bytes <= 16384);
        assert.equal(page.cache.bytes.request, 0); assert.equal(page.cache.bytes.staging, 0);
        assert.equal(page.cache.pins, 0); assert.equal(page.cache.activeRequests, 0);
        assert.ok(page.cache.bytes.resident <= page.cache.limits.residentBytes);
      } while (cursor && pages < 60);
      assert.equal(cursor, ''); assert.deepEqual(collected, plain(source.units), 'all four source families survive page traversal');
      for (const pool of ['nodes','edges','bases']) {
        const page = await read({ pool, pageBytes: 65536 }); assert.ok(page.items.length);
        assert.equal(page.pool, pool); assert.equal(page.generation, cold.generation);
      }
      await assert.rejects(() => read({ pool: 'edges', cursor: cold.nextCursor }), /CURSOR_INVALID/);
      await assert.rejects(() => read({ graph: source }), /OPTIONS_INVALID/);
      await assert.rejects(() => read({ expectedScopeKey: 'foreign' }), /SCOPE_CHANGED/);
      const small = await read({ pageBytes: 256 });
      assert.equal(small.stopReason, 'row_exceeds_page'); assert.equal(small.nextOffset, 0); assert.ok(small.nextCursor);
      const resized = await read({ pageBytes: 2500, cursor: small.nextCursor }); assert.deepEqual(plain(resized.items), plain(cold.items));
      assert.equal(f.control.calls.length, calls); assert.equal(f.r.storageWrites.length, writes);
      assert.equal(x.server?.batches.length || 0, batches);
      if (mode === 'plugin_only') {
        const values = f.r.values, key = (await f.getManifest()).memories['1'].key, original = values.get(key);
        try {
          const body = JSON.parse(original); body.summary = 'independent body edit with unchanged record key/revision'; values.set(key, JSON.stringify(body));
          await assert.rejects(() => read({ cursor: cold.nextCursor }), /CURSOR_INVALID/);
          const changed = await read(); assert.notEqual(changed.generation, cold.generation); assert.equal(changed.cacheHit, false);
        } finally { values.set(key, original); }
        const portable = f.r.context.__LIBRAPortableMemoryBackup;
        const backup = await retryBusy(() => portable.exportCurrentScope());
        await retryBusy(() => portable.restoreCurrentScope(backup));
        const invalidated = api.inspectMemoryGraphPages();
        assert.equal(invalidated.pages, 0); assert.equal(invalidated.bytes.resident, 0);
        await assert.rejects(() => read({ cursor: cold.nextCursor }), /CURSOR_INVALID/);
        const restored = await read(); assert.notEqual(restored.generation, cold.generation); assert.equal(restored.cacheHit, false);
      }
      const state = api.inspectMemoryGraphPages();
      assert.equal(state.sourceReaderWorkspaceAccounted, false); assert.equal(state.actualHeapBounded, false);
      results.push({ mode, units: collected.length, pages, warmCacheHit: true,
        projectionWrites: 0, projectionProviderCalls: 0, restoreBoundaryTested: mode === 'plugin_only' });
    } finally { await x.cleanup(); }
  }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_pages_registered_api', results,
    validation: 'synthetic_owner_hosts', durableStoreImplemented: false, unifiedRetrievalImplemented: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
