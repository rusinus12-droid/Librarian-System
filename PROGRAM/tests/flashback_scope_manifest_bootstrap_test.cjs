'use strict';
// A chat that already had history when the plugin loaded has no stored Flashback memory. The
// manifest is the only root the read-only maintenance inspection can verify, and it used to be
// written only as part of a record commit, so such a scope could never be verified and never
// planned the turn sync that would fill it (scope_manifest_unverified -> inspection_incomplete ->
// no strategy, no counts, no action). HAYAKU/LIBRA publish their root when a scope is bound;
// Flashback now publishes it on the write-capable entry points (startup, deferred scope
// preparation) and keeps every ordinary read path write-free.
const assert = require('node:assert/strict');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const chat = { id: 'bootstrap-chat', name: 'Bootstrap', message: [
    { role: 'user', chatId: 'u1', data: '질문 1' }, { role: 'assistant', chatId: 'a1', data: '응답 1' },
    { role: 'user', chatId: 'u2', data: '질문 2' }, { role: 'assistant', chatId: 'a2', data: '응답 2' },
    { role: 'user', chatId: 'u3', data: '질문 3' }, { role: 'assistant', chatId: 'a3', data: '응답 3' }
  ] };
  const values = new Map();
  const pluginStorage = { values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); } };
  const f = await createFixture({ pluginStorage, chat });
  const results = [];
  try {
    const t = f.api._test;
    const scope = await f.api.resolveCurrentScope();
    assert.ok(Number(scope.chatMessageCount || 0) > 0, 'fixture chat carries history');
    const before = await t.loadScopeManifest(scope.scopeKey);
    assert.equal(before.manifestRawPresent, false, 'resolving a scope must not write storage');
    results.push('ordinary scope resolution stays write-free');

    const ready = await t.ensureInitialScopeManifest(scope, before);
    assert.equal(ready.written, true, 'the root is published for a chat that already has history');
    const root = await t.loadScopeManifest(scope.scopeKey);
    assert.equal(root.manifestRawPresent, true);
    assert.equal(root.schema, 'vector_rag_memory.scope_manifest.v2', 'the root must satisfy the inspection schema check');
    assert.equal(root.scopeKey, scope.scopeKey, 'the root must declare the live scope key');
    assert.equal(Number(root.count || 0), 0);
    assert.equal(Number(root.shardCount || 0), 0);
    assert.equal(Number(root.responseTurnCount || 0), 0);
    assert.equal(root.archiveRef, null, 'an empty root must not claim an archive');
    results.push('the published root is empty and verifiable');

    const replay = await t.ensureInitialScopeManifest(scope, root);
    assert.equal(replay.written, false);
    assert.equal(replay.reason, 'manifest_present');
    results.push('an existing manifest is never replaced');

    // A stored chat keeps its counts: the bootstrap must not reset a populated scope.
    const cfg = t.normalizeSettings({ embeddingProvider: 'hash', hashDimensions: 8, shardSize: 50 });
    const record = { id: 'raw-1', scopeKey: scope.scopeKey, sourceType: 'response', sourceId: 'turn:1',
      text: 'User:\n질문\n\n---\n\nAssistant:\n응답', title: 'Turn 1', pairIndex: 1, turnIndex: 1,
      vector: [1, 0, 0, 0, 0, 0, 0, 0], createdAt: Date.now(), updatedAt: Date.now() };
    await t.saveAllRecords([record], cfg, scope);
    const stored = await t.loadScopeManifest(scope.scopeKey);
    assert.ok(Number(stored.count || 0) > 0, 'fixture scope now has memory');
    const countsBefore = Number(stored.count || 0);
    const afterPopulated = await t.ensureInitialScopeManifest(scope, stored);
    assert.equal(afterPopulated.written, false);
    const unchanged = await t.loadScopeManifest(scope.scopeKey);
    assert.equal(Number(unchanged.count || 0), countsBefore);
    results.push('a populated scope is left untouched');

    // Archive-linked scopes must never get a fresh empty root injected.
    const archiveScope = { ...scope, scopeKey: scope.scopeKey + ':archive-probe' };
    const archiveOutcome = await t.ensureInitialScopeManifest(archiveScope, {
      manifestRawPresent: false,
      archiveRef: { archiveId: 'fb_probe', archiveScopeKey: 'flashback_archive_v1:fb_probe', generation: 1, depth: 1, deltaCount: 1, recordCount: 1, digest: 'x', responseTurnMax: 0 }
    });
    assert.equal(archiveOutcome.written, false);
    assert.equal(archiveOutcome.reason, 'archive_linked');
    results.push('archive-linked scopes are excluded from the empty root bootstrap');

    // An untouched chat stays unregistered and write-free.
    const unused = await t.ensureInitialScopeManifest({ ...scope, scopeKey: scope.scopeKey + ':unused', chatMessageCount: 0 }, null);
    assert.equal(unused.written, false);
    assert.equal(unused.reason, 'empty_chat');
    results.push('a chat without history is never given a root');

    // The real call path: a foreground request defers scope preparation; that task publishes.
    // It runs only for the active scope, so this needs its own untouched fixture.
    const deferredFixture = await createFixture({ chat });
    try {
      const dt = deferredFixture.api._test;
      const deferredScope = await deferredFixture.api.resolveCurrentScope();
      assert.equal((await dt.loadScopeManifest(deferredScope.scopeKey)).manifestRawPresent, false);
      dt.scheduleDeferredScopeStorageReady(deferredScope, await deferredFixture.api.loadSettings(), {});
      let published = null;
      for (let attempt = 0; attempt < 40 && !published; attempt += 1) {
        await sleep(25);
        const candidate = await dt.loadScopeManifest(deferredScope.scopeKey);
        if (candidate.manifestRawPresent === true) published = candidate;
      }
      assert.ok(published, 'the deferred scope preparation publishes the root');
      assert.equal(published.scopeKey, deferredScope.scopeKey);
      assert.equal(Number(published.count || 0), 0);
    } finally {
      await deferredFixture.dispose();
    }
    results.push('the deferred background path publishes the root');

    // A blocked inspection must still report what is waiting instead of an empty count panel -
    // but only from certified evidence: the live transcript, and a complete inventory that
    // holds no manifest for the scope.
    const liveOnly = t.maintenanceIncompleteCounts({ snapshot: { chat }, scope });
    assert.equal(liveOnly.liveTurns, 3, 'every complete U+A pair counts as a live turn');
    assert.equal(liveOnly.missingTurns, undefined, 'no stored/missing claim without a certified inventory');
    const certified = t.maintenanceIncompleteCounts({ snapshot: { chat }, scope,
      inspection: { inventoryComplete: true, manifestAbsent: true, scopeVerified: false } });
    assert.equal(certified.liveTurns, 3);
    assert.equal(certified.storedRecords, 0, 'a complete inventory without a manifest certifies zero stored records');
    assert.equal(certified.missingTurns, 3, 'and every live turn is reported as missing');
    assert.equal(certified.countsSource, 'certified_inventory_without_manifest');
    results.push('a blocked inspection reports certified live and missing turn counts');

    console.log(JSON.stringify({ test: 'flashback_scope_manifest_bootstrap', passed: results.length, results,
      boundary: 'full plugin in native runtime fixture; live RisuAI server mirror untested' }));
  } finally {
    await f.close?.();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
