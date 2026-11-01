'use strict';
const assert = require('node:assert/strict');
const { seedSnapshot, finalProofFixture, REQUEST, GRAPH_FACT } = require('./fixtures/libra_associative_final_proof_fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const input = () => [{ role: 'user', content: REQUEST }];
const results = [];
const blockOf = delivered => delivered.filter(row => row.role === 'system').map(row => row.content).join('\n');
const canonicalBytes = f => JSON.stringify([...f.r.values].filter(([key]) =>
  /:memory:\d+:r\d+$|:continuity-state$/.test(key)));

(async () => {
  const snapshot = await seedSnapshot();
  for (const graph of [false, true]) {
    const f = await finalProofFixture(snapshot, graph);
    try {
      const calls = f.control.calls.length, bytes = canonicalBytes(f);
      const delivered = await f.control.hooks.beforeRequest(input(), 'model');
      const viewer = plain(f.r.api.getLastMemoryRecallViewer());
      const recall = f.r.api.getRuntime().lastMemoryRecall;
      const selected = recall.memories.map(row => ({ id: row.id, associative: row.associative === true }));
      console.log(JSON.stringify({ graph, errorCode: viewer.errorCode || '', injectedMemories: viewer.injectedMemories, selectedCount: selected.length }));
      assert.deepEqual(plain(delivered.filter(row => row.role === 'user')), input(), 'the host user request persists');
      assert.equal(f.control.calls.length, calls, 'recall spends no drafting call');
      assert.equal(f.counts.document, 0, 'unchanged documents spend no embedding call');
      assert.equal(f.counts.query, 1, 'both paths spend only the normal query embedding');
      assert.equal(canonicalBytes(f), bytes, 'recall cannot change canonical memory or Head bytes');
      assert.equal(viewer.errorCode || '', '', 'unified memory graph retains private canonical provenance through final assembly');
      assert.ok(viewer.injectedMemories > 0, 'unified memory graph delivers unit evidence within the packing budget');
      assert.ok(blockOf(delivered).includes(GRAPH_FACT), 'the actual provider request includes the graph-projected fact');
      const injectedRows = viewer.rows.filter(row => row.injected);
      assert.equal(injectedRows.length, viewer.injectedMemories);
      for (const row of injectedRows) {
        assert.ok(row.memoryId, 'viewer row retains memoryId');
        assert.ok(blockOf(delivered).includes(row.selectedText), 'viewer text matches final provider bytes');
      }
      assert.equal(viewer.scopeKey, recall.scopeKey, 'final viewer retains the actual request scope');
      const context = f.r.api.getLastResponseContext();
      assert.equal((await f.r.api.validateResponseContext(plain(context))).current, true, 'public context clone retains runtime authority');
      results.push(graph ? 'graph ON unified memory graph delivery' : 'graph OFF unified memory graph baseline');
    } finally { await f.r.cleanup(); }
  }

  for (const mutation of ['body_changed', 'body_deleted', 'scope_changed']) {
    const f = await finalProofFixture(snapshot);
    try {
      await f.control.hooks.beforeRequest(input(), 'model');
      const prior = f.r.api.getLastResponseContext();
      assert.ok(prior?.requestId);
      const storage = f.r.context.risuai.pluginStorage, originalGet = storage.getItem;
      let reads = 0, reached = false;
      storage.getItem = async key => {
        if (key === f.graphRef.key) {
          reads += 1;
          if (!reached && reads >= 3) {
            reached = true;
            if (mutation === 'body_deleted') f.r.values.delete(key);
            else if (mutation === 'body_changed') {
              const body = JSON.parse(f.r.values.get(key));
              body.canonicalArtifact.facts[0].text = 'Tampered associative body under the identical memoryId and revision';
              f.r.values.set(key, JSON.stringify(body));
            } else { f.chat.id = 'wrong-scope'; f.chat.chatId = 'wrong-scope'; }
          }
        }
        return originalGet(key);
      };
      try {
        const calls = f.control.calls.length;
        const delivered = await f.control.hooks.beforeRequest(input(), 'model');
        assert.equal(reached, true, `${mutation} crosses the physical source-proof read`);
        assert.deepEqual(plain(delivered), input(), `${mutation} fails open with the original host request`);
        assert.equal(f.control.calls.length, calls);
        const viewer = f.r.api.getLastMemoryRecallViewer();
        assert.equal(viewer.injectedMemories, 0, 'rejected evidence is not reported as delivered');
        results.push(`${mutation} final physical read rejection`);
      } finally { storage.getItem = originalGet; }
    } finally { await f.r.cleanup(); }
  }
  console.log(JSON.stringify({ suite: 'libra_associative_final_proof', passed: results.length, tests: results }, null, 1));
  console.log('libra_associative_final_proof_test: PASS');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
