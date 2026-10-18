'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');
const { executeOperation } = require('./fixtures/retired_compute_reference_kernels.cjs');
const fact = '서연은 은색 열쇠를 소나무 상자에 보관했다.';
const alias = 'silver key';
const makePacket = (count, aliases = true, lateSummary = false) => {
  const meta = { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2,
    summary_memory: { id: 'owned-summary', summary: fact, ...(aliases ? { recallAliases: { en: [alias], ja: ['銀色の鍵'] } } : {}) } };
  const world = { world_rules: Array.from({ length: count }, (_, i) => ({ id: `rule-${i}`, summary: `독립된 규칙 ${i}` })) };
  const entity = { characters: [], relations: [], pov_memories: [], secrets: [] };
  return lateSummary ? { world, entity, meta, narrative: {}, planner: {} } : { meta, world, entity, narrative: {}, planner: {} };
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-alias-work-'));
  let h;
  try {
    const source = fs.readFileSync(process.argv[2] || path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
    const needle = 'const canonicalizePacketRecordForIngest = (parsed = {}, sourceMeta = {}, store = {}) => {';
    assert.equal(source.split(needle).length, 2);
    const file = path.join(dir, 'instrumented.js');
    fs.writeFileSync(file, source.replace(needle, needle + '\n    globalThis.__aliasFullAdmissionCalls=(globalThis.__aliasFullAdmissionCalls||0)+1;'));
    h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false, pluginSourceFile: file });
    const t = h.hayaku._test, settings = { ...h.hayaku.settings(), hierarchicalEpisodeMemoryEnabled: false,
      graphClosureRecallEnabled: false, retrievalCurrentQuery: '', retrievalRecentContext: { topics: [] } };
    const matches = store => t.localRecallRank(store._recallSourceRows, [alias]).filter(row => row.category === 'summary_memory');
    const prepare = async (packet, store, scope, deadline = Date.now() + 10000) => {
      const raw = typeof packet === 'string' ? packet : JSON.stringify(packet);
      return t.localRecallPrepareSources([{ raw, hash: 'same-source', messageIndex: 1 }], store, settings, scope, deadline);
    };
    const counts = [];
    for (const aliases of [false, true]) {
      const store = { index: [], context: {} }, packet = makePacket(1000, aliases);
      const originalDate = h.context.Date; let reads = 0;
      h.context.Date = class extends Date { static now() { reads++; return 1000; } };
      try {
        const coverage = await prepare(packet, store, `count-${aliases}`, 2000);
        assert.equal(coverage.partialSourceCount, 1);
        assert.equal(store._recallSourceRows.length, 128, 'one call retains the existing 128-record chunk bound');
        assert.equal(matches(store).length, 0, 'no aliases are exposed before complete certification');
        counts.push(reads);
      } finally { if (originalDate === undefined) delete h.context.Date; else h.context.Date = originalDate; }
    }
    assert.equal(h.context.__aliasFullAdmissionCalls || 0, 0, 'source preparation must never run the full semantic canonicalizer');
    assert.ok(counts[1] <= counts[0] + 2, `alias work cannot add a full-record traversal: ${counts}`);

    const finish = async (packet, scope, restricted) => {
      const store = { index: [], context: {} }; let coverage;
      for (let pass = 0; pass < 8; pass++) {
        coverage = await prepare(packet, store, scope);
        assert.ok(coverage.processedThisRequest <= 1, 'one descriptor is advanced at most once per call');
        if (coverage.complete) break;
        assert.equal(matches(store).length, 0, 'an interrupted certification cannot publish aliases');
      }
      assert.equal(coverage.complete, true, 'the bounded passes finish this 513-or-fewer-record fixture');
      assert.equal(matches(store).length, restricted ? 0 : 1);
      const warm = await prepare(packet, store, scope);
      assert.equal(warm.processedThisRequest, 0, 'warm cache reuses the completed certificate');
      assert.equal(matches(store).length, restricted ? 0 : 1);
      return store;
    };
    await finish(makePacket(300, true, true), 'late-summary', false);
    await finish(makePacket(512), 'interrupted-resume', false);
    const variants = [
      { summary: '別の秘密', reveal_state: 'revealed', hidden_from: ['Bob'] },
      { summary: '別の秘密', revealed: true, holders: ['Alice'] },
      { summary: '別の秘密', revealState: 'hidden' }
    ];
    for (const [index, secret] of variants.entries()) {
      const packet = makePacket(300);
      packet.entity.secret_boundaries = [secret]; delete packet.entity.secrets;
      await finish(packet, `late-secret-${index}`, true);
    }
    const rootAlias = makePacket(300); rootAlias.hiddenKnowledge = [{ summary: '別の秘密' }];
    await finish(rootAlias, 'root-secret-alias', true);
    const revealed = makePacket(300); revealed.entity.secrets = [{ summary: '公開された記録', revealed: true }];
    await finish(revealed, 'revealed-secret-positive', false);

    const raw = JSON.stringify(makePacket(0)), store = t.emptyStore();
    t.ingestPacket(store, raw, 'same-source', { messageIndex: 1 });
    assert.ok(h.context.__aliasFullAdmissionCalls > 0, 'positive control proves the work counter observes ordinary admission');
    t.rebuildIndex(store, { settings, deadlineAt: Date.now() + 10000 });
    const storedBodies = Array.from(store.index, row => row.publicText);
    const empty = { meta: {}, entity: {}, world: {}, narrative: {}, planner: {} };
    for (let cycle = 0; cycle < 2; cycle++) {
      await prepare(raw, store, 'replace-empty'); assert.equal(matches(store).length, 1);
      for (let warm = 0; warm < 2; warm++) {
        const coverage = await prepare(empty, store, 'replace-empty');
        assert.equal(coverage.complete, true);
        assert.equal(matches(store).length, 0, 'zero-row replacement must retire the old stored alias');
        assert.deepEqual(Array.from(store.index, row => row.publicText), storedBodies, 'existing evidence rows are not deleted or rewritten');
      }
    }
    await prepare(raw, store, 'replace-empty');
    await prepare(JSON.stringify({ ...empty, marker: 'new-skipped-generation' }), store, 'replace-empty', 0);
    assert.equal(matches(store).length, 0, 'an unprepared replacement cannot inherit stored aliases');
    await prepare('{', store, 'replace-empty');
    assert.equal(matches(store).length, 0, 'a failed replacement cannot inherit stored aliases');

    const tiny = { index: [], context: {} }, began = performance.now(), before = h.context.__aliasFullAdmissionCalls;
    const tinyCoverage = await prepare(makePacket(512), tiny, 'tiny-budget', Date.now() + 5);
    const elapsedMs = performance.now() - began;
    assert.ok(tiny._recallSourceRows.length <= 128);
    assert.equal(h.context.__aliasFullAdmissionCalls, before);
    assert.equal(matches(tiny).length, 0);
    const oversized = makePacket(0);
    oversized.meta.summary_memory.recallAliases = { en: [alias + ' ' + 'x'.repeat(2000000)] };
    const originalOversized = JSON.stringify(oversized);
    const oversizedRows = t.localRecallRowsFromPacket({ raw: originalOversized, messageIndex: 1 }, 'oversized-alias');
    const oversizedSummary = oversizedRows.find(row => row.category === 'summary_memory');
    assert.ok(oversizedSummary._recallSearchAliases.values.every(value => value.length <= 700),
      'derived aliases use the existing compact-admission 700-unit string bound');
    assert.equal(oversizedSummary.publicText, 'summary: ' + fact, 'large alias never changes original evidence bytes');
    const input = { owner: 'hayaku', kind: 'lexical', corpus: { documents: oversizedRows.map(row => ({
      key: row.id, body: [row.publicText, ...(row._recallSearchAliases?.values || [])].join('\n') })) }, queries: [[alias], []] };
    assert.ok(input.corpus.documents.reduce((sum, row) => sum + row.body.length, 0) < 2000000);
    assert.equal(executeOperation('hayaku.memory-search.v1', input).rankings[0][0].key, 'owned-summary',
      'oversized raw alias still produces a valid bounded shared-kernel input');
    assert.equal(JSON.stringify(oversized), originalOversized);
    const multilingual = makePacket(0);
    multilingual.meta.summary_memory.recallAliases = Object.fromEntries(['ko', 'en', 'ja', 'zh'].map(language =>
      [language, Array.from({ length: 32 }, (_, i) => `${language}${i}`.padEnd(699, '界') + '😀' + '尾'.repeat(1000))]));
    const bounded = t.localRecallRowsFromPacket({ raw: JSON.stringify(multilingual), messageIndex: 1 }, 'multilingual-large')
      .find(row => row.category === 'summary_memory')._recallSearchAliases.values;
    assert.ok(bounded.length <= 64 && bounded.reduce((sum, value) => sum + value.length, 0) <= 44800);
    assert.ok(bounded.every(value => value.length <= 700 && !/[\uD800-\uDBFF]$/.test(value)),
      'all language aliases remain bounded without cutting a surrogate pair');
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
    console.log(JSON.stringify({ test: 'hayaku_alias_incremental_certificate', clockReads: counts,
      noFullCanonicalizerInProjection: true, lateSecretsFailClosed: true, emptyReplacementRetiresAlias: true,
      tinyBudgetDiagnostic: { requestedMs: 5, elapsedMs: Number(elapsedMs.toFixed(2)), rows: tiny._recallSourceRows.length,
        partialSourceCount: tinyCoverage.partialSourceCount }, modelCalls: 0, networkCalls: 0 }));
  } finally { await h?.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
