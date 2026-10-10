'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const fact = '서연은 은색 열쇠를 소나무 상자에 보관했다.';
const alias = 'silver key';
const packet = (summary, scene, aliases = {}) => ({
  meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2,
    scene_id: scene, turn_anchor: summary, summary_memory: { summary, recallAliases: aliases } },
  entity: { characters: [], relations: [], pov_memories: [], secrets: [] },
  world: { active_events: [{ summary }] }, narrative: { scene_deltas: [] },
  planner: { continuity_locks: [], do_not_resolve_yet: [] }
});
const storedCopy = storage => {
  const values = new Map(JSON.parse(JSON.stringify([...storage.values])));
  return { values, async getItem(k) { return values.get(String(k)) ?? null; },
    async setItem(k, v) { values.set(String(k), v); return true; },
    async removeItem(k) { return values.delete(String(k)); }, async clear() { values.clear(); },
    async key(i) { return [...values.keys()][Number(i)] ?? null; },
    async keys() { return [...values.keys()]; }, async length() { return values.size; } };
};
const ownedText = result => result.filter(row => /^hayaku-(?:runtime-context-v3|cache-static-v1)$/.test(row.memo || ''))
  .map(row => String(row.content || row.data || '')).join('\n');

(async () => {
  const history = [];
  for (let turn = 1; turn <= 12; turn++) {
    const summary = turn === 1 ? fact : `돌담 아래 벽돌이 놓였다. ${turn}`;
    history.push({ role: 'user', chatId: `u${turn}`, data: `장면 ${turn}` },
      { role: 'assistant', chatId: `a${turn}`, data: hiddenPacketMessage(summary,
        packet(summary, `scene-${turn}`, turn === 1 ? { en: [alias] } : {})) });
  }
  const query = { role: 'user', chatId: 'u13', data: alias };
  const messages = [...history, query];
  const request = () => [{ role: 'system', content: 'Continue the fictional story.' }, ...messages];
  const options = { autoRepair: false, afterRequestAutoRepair: false, messages,
    arguments: { hayaku_debug: 'true' }, ...(process.argv[2] ? { pluginSourceFile: process.argv[2] } : {}) };
  let h = await createHayakuRuntime(options);
  try {
    const initial = ownedText(await h.callBeforeRequest(request(), 'model'));
    assert.ok(initial.includes(fact), 'ordinary initial beforeRequest injects the alias-owned historical fact');
    const warm = ownedText(await h.callBeforeRequest(request(), 'model'));
    assert.ok(warm.includes(fact), 'same-VM warm request preserves aliases through the trusted source cache');
    const pluginStorage = storedCopy(h.pluginStorage), safeLocalStorage = storedCopy(h.safeLocalStorage);
    assert.ok(pluginStorage.values.size + safeLocalStorage.values.size > 0, 'fresh runtime receives serialized persisted state');
    assert.equal(JSON.stringify([...pluginStorage.values, ...safeLocalStorage.values]).includes('_recallSearchAliases'), false,
      'derived alias metadata is not persisted as canonical or duplicated storage data');
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
    await h.dispose();
    h = await createHayakuRuntime({ ...options, messages: JSON.parse(JSON.stringify(messages)), pluginStorage, safeLocalStorage });
    const resumed = ownedText(await h.callBeforeRequest(request(), 'model'));
    assert.ok(resumed.includes(fact), 'fresh VM rebuilds alias ownership in normal beforeRequest without reanalysis');
    const evidence = text => {
      const begin = text.indexOf('[SOURCE MEMORY RECORDS');
      const end = text.indexOf('[HAYAKU RUNTIME PACKET SHAPE]', begin);
      assert.ok(begin >= 0 && end > begin, 'compare the complete unmodified evidence block');
      return text.slice(begin, end);
    };
    assert.equal(evidence(resumed), evidence(initial),
      'restart preserves final evidence bytes; no evidence field or provenance is masked');
    assert.equal(evidence(warm), evidence(initial), 'warm projection-cache clone preserves exact evidence bytes');
    const rows = h.hayaku.lastDebug().requestStore._recallSourceRows;
    const aliases = rows.filter(row => row._recallSearchAliases?.values?.includes(alias));
    assert.equal(aliases.length, 1, 'normal cold load reconstructs one exact summary binding');
    assert.equal(aliases[0].category, 'summary_memory');
    assert.equal(aliases[0].locator.originalPointer, '/meta/summary_memory');
    assert.ok(aliases[0].locator.sourceRevision);

    const t = h.hayaku._test, settings = { ...h.hayaku.settings(), graphClosureRecallEnabled: false,
      hierarchicalEpisodeMemoryEnabled: false, retrievalRecentContext: { topics: [] } };
    const raw = JSON.stringify(packet(fact, 'legacy', { en: [alias] }));
    const legacy = t.emptyStore(); t.ingestPacket(legacy, raw, 'legacy-source', { messageIndex: 1 });
    const restored = JSON.parse(JSON.stringify(legacy));
    assert.ok(JSON.stringify(restored.memory.summaries).includes(alias), 'legacy wrapper roundtrip retains alias bytes');
    t.rebuildIndex(restored, { settings, deadlineAt: Date.now() + 10000 });
    await t.localRecallPrepareSources([{ raw, hash: 'legacy-source', messageIndex: 1 }], restored,
      settings, 'legacy-scope', Date.now() + 10000);
    restored.context = {}; delete restored._recallLatestPacket;
    assert.equal(t.localRecallRank(restored._recallSourceRows, [alias]).filter(row => row.category === 'summary_memory').length, 1,
      'normal source preparation restores legacy-wrapper recall without retaining object identity');
    assert.equal(h.llmCalls.length, 0); assert.equal(h.fetchCalls.length, 0);
    console.log('PASS normal beforeRequest fresh-VM restart, persisted-store and legacy-wrapper alias reconstruction; no model/network');
  } finally { await h.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
