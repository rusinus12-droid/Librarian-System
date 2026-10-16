'use strict';
// Real registered plugin APIs and beforeRequest, with native owner-produced records.
// The host/provider remain fixtures; this does not qualify an actual RisuAI installation.
const assert = require('node:assert/strict');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');
const tests = [];
async function run(name, fn) { await fn(); tests.push(name); }
(async () => {
  for (const mode of ['plugin_only', 'server_only']) {
    await run(`${mode}: canonical evidence time, consumer envelopes, byte counters, final delivery and restart GC`, async () => {
      let legacyRescues = 0;
      const host = await fixture({ mode, hostOverrides: { recordLegacyRescue: () => { legacyRescues++; } },
        transformSource: source => {
          const anchor = 'const buildClassicCanonicalProvenanceRescue = async (scope, manifest, queryBundle = {}) => {';
          assert.ok(source.includes(anchor), 'the retired rescue builder must still exist for this negative control to mean anything');
          return source.replace(anchor, anchor + ' risuai.recordLegacyRescue();');
        } });
      try {
        let api = host.f.r.api;
        const graph = await host.project();
        const future = graph.units.find(u => u.family === 'canonical' && u.fact?.tempFactId === 'f11');
        const past = graph.units.find(u => u.family === 'canonical' && u.fact?.tempFactId === 'f8');
        assert.equal(future.fact.evidenceSpans[0].ref, 't5-a');
        assert.equal(future.turn, 5); assert.equal(past.turn, 3);
        const historical = await api.executeMemoryGraphUnifiedQuery({ expectedScopeKey: host.scopeKey,
          queryInput: { queryText: future.text, asOfTurn: 3 } });
        assert.equal(historical.bundle.items.some(item => item.nodeId === future.nodeId), false);
        assert.ok(historical.bundle.items.some(item => item.nodeId === past.nodeId), 'past facts in the same batch remain searchable');
        assert.ok(historical.bundle.items.filter(item => item.family === 'canonical').every(item => item.turn <= 3));
        for (const consumer of ['classic','planner','sga','input_writer','gui']) {
          const result = await api.executeMemoryGraphUnifiedQuery({ expectedScopeKey: host.scopeKey,
            queryInput: { queryText: QUOTE }, consumerPolicy: { consumer, maxCharacters: 4096 } });
          assert.equal(result.packet.consumerVerification.ok, true, consumer);
          assert.equal(result.modelDispatchEligible, ['classic', 'gui'].includes(consumer), consumer);
          const packet = result.packet, inventory = packet.byteInventory;
          assert.equal(inventory.counted.rendered_packet, Buffer.byteLength(packet.renderedText, 'utf8'));
          assert.equal(inventory.counted.bundle_body, result.bundle.items.reduce((n, item) => n + Buffer.byteLength(item.text, 'utf8'), 0));
          assert.equal(inventory.counted.l0_candidate_workspace, result.diagnostics.l0WorkspaceBytes);
          assert.equal(inventory.counted.lane_page_payload, result.diagnostics.laneBytesRead);
          assert.equal(inventory.budgets.lane_page_payload, result.diagnostics.laneMaxBytes);
          assert.equal(inventory.characterBudgets.rendered_packet, 4096);
          assert.equal(inventory.budgets.rendered_packet, null);
          assert.equal(inventory.byteBounded, false);
          if (consumer === 'planner' || consumer === 'sga') assert.ok(packet.renderedText.includes('@time_unknown'));
        }
        await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
        const original = [{ role: 'user', content: QUOTE }];
        const delivered = await host.f.control.hooks.beforeRequest(original, 'model');
        assert.equal(delivered.length, original.length + 1);
        assert.equal(legacyRescues, 0, 'unified does not execute the old provenance rescue ranking');
        const meta = api.getRuntime().lastMemoryInjectionMeta;
        assert.equal(meta.servedEngine, 'unified'); assert.equal(meta.finalVerification.status, 'verified');
        assert.equal(meta.finalVerification.modelDispatchEligible, true);
        assert.ok(delivered.some(message => /\[LIBRA_EVIDENCE consumer=classic/.test(message.content)));
        assert.ok(delivered.some(message => /\[micro:micro_candidate/.test(message.content)), 'Micro role survives the final consumer');
        assert.ok(delivered.some(message => /\[lore:/.test(message.content)), 'Lore is not relabelled canonical');
        // A retired selection is migrated to unified and disclosed, so the instrumented control now has to
        // observe ZERO rescues — the opposite of the retired behaviour it used to assert.
        await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'legacy' });
        const migratedDelivery = await host.f.control.hooks.beforeRequest(original, 'model');
        assert.equal(migratedDelivery.length, original.length + 1, 'a migrated request still delivers');
        assert.equal(legacyRescues, 0, 'the retired legacy ranking must not run even when it is selected');
        const migratedEngine = api.getLastMemoryRecall().diagnostics.memoryEngine;
        assert.equal(migratedEngine.mode, 'unified');
        assert.equal(migratedEngine.retiredSelection, 'legacy', 'the retirement is disclosed rather than silently ignored');
        await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
        await api.buildMemoryGraphGeneration({ expectedScopeKey: host.scopeKey, pageBytes: 16384 });
        const dry = await api.collectMemoryGraphGarbage({ expectedScopeKey: host.scopeKey, dryRun: true });
        assert.ok(dry.activeRoots > 0);
        // Pick an active page from the actual persisted root in both owner modes.
        const read = await api.getMemoryGraphDurablePage({ expectedScopeKey: host.scopeKey, pool: 'nodes' });
        assert.equal(read.status, 'verified');
        const prefix = `libra:v1:scope:${host.scopeKey}:memory-graph:v1:`;
        const local = host.f.r.values;
        let rootRaw;
        if (mode === 'plugin_only') rootRaw = local.get([...local.keys()].find(k => k.startsWith(prefix + 'root:')));
        let candidateKeys = [];
        if (rootRaw) {
          const root = JSON.parse(rootRaw), manifest = JSON.parse(local.get(root.manifestKey));
          candidateKeys = [manifest.pages.find(page => page.pool === 'nodes').key];
        }
        await host.restart(); api = host.f.r.api;
        const gc = await api.collectMemoryGraphGarbage({ expectedScopeKey: host.scopeKey, candidateKeys });
        assert.equal(gc.status, 'blocked_atomic_gc_unavailable');
        assert.ok(gc.activeRoots > 0, 'complete durable inventory is read after restart');
        assert.deepEqual(Array.from(gc.deletedKeys), []);
        assert.equal((await api.getMemoryGraphDurablePage({ expectedScopeKey: host.scopeKey, pool: 'nodes' })).status, 'verified');
      } finally { await host.cleanup(); }
    });
  }
  await run('final native consumer rejects a changed physical Micro after successful recall; newer requests retain publication', async () => {
    let boundary = async () => {};
    const host = await fixture({
      args: { classic_live_tail_enabled: 'true', live_context_enabled: 'true' },
      hostOverrides: { graphDeliveryBoundary: async () => boundary() },
      transformSource: source => source.replace('const authority = unifiedGraphDeliveryAuthority.get(execution);',
        'await risuai.graphDeliveryBoundary(); const authority = unifiedGraphDeliveryAuthority.get(execution);')
    });
    try {
      const api = host.f.r.api, original = [{ role: 'user', content: QUOTE }];
      await api.saveLibraMemorySettings({ unifiedMemoryEngineMode: 'unified' });
      const key = host.active.recordKey, raw = host.f.r.values.get(key);
      boundary = async () => {
        const value = JSON.parse(raw); value.claims[0].text += ' changed after selection';
        host.f.r.values.set(key, JSON.stringify(value));
      };
      const rejected = await host.f.control.hooks.beforeRequest(original, 'model');
      assert.equal(rejected.length, original.length);
      assert.equal(api.getRuntime().lastMemoryInjectionMeta.injected, false);
      assert.match(api.getRuntime().lastMemoryInjectionMeta.error, /BINDING_STALE|PHYSICAL_READSET_STALE|CORPUS_SOURCE_CHANGED/,
        'a physical source changed after selection must still be rejected, whatever the engine calls it');
      host.f.r.values.set(key, raw); boundary = async () => {};
      const healthy = await host.f.control.hooks.beforeRequest(original, 'model');
      assert.equal(healthy.length, 2);
      assert.ok(healthy.some(message => message.content.includes('[RECENT COMPLETED DIALOGUE]')));
      assert.equal(api.getLastMemoryRecall().delivery.liveTailInjected, true);
      let enter, release, seen = false;
      const entered = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      boundary = async () => { if (!seen) { seen = true; enter(); await gate; } };
      const older = host.f.control.hooks.beforeRequest(original, 'model'); await entered;
      const newer = await host.f.control.hooks.beforeRequest(original, 'model');
      assert.equal(newer.length, 2);
      const latestMeta = JSON.stringify(api.getRuntime().lastMemoryInjectionMeta);
      release(); assert.equal((await older).length, 1);
      assert.equal(JSON.stringify(api.getRuntime().lastMemoryInjectionMeta), latestMeta);
    } finally { await host.cleanup(); }
  });
  console.log(JSON.stringify({ suite: 'libra_memory_graph_patch_runtime', passed: tests.length, tests, actualHostQualified: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
