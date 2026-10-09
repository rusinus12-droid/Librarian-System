'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

const fact = '서연은 은색 열쇠를 소나무 상자에 보관했다.';
const alias = 'silver key';
const packet = (aliases = { en: [alias] }) => ({
  meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2,
    scene_id: 'old-scene', turn_anchor: fact,
    summary_memory: { id: 'owned-summary', summary: fact, recallAliases: aliases } },
  entity: { characters: [], relations: [], pov_memories: [], secrets: [] },
  world: { active_events: [{ id: 'sibling-event', summary: '돌담 아래 벽돌이 놓였다.' }] },
  narrative: { scene_deltas: [] }, planner: { continuity_locks: [], do_not_resolve_yet: [] }
});

(async () => {
  const h = await createHayakuRuntime({ autoRepair: false, afterRequestAutoRepair: false });
  try {
    const t = h.hayaku._test;
    const settings = { ...h.hayaku.settings(), hierarchicalEpisodeMemoryEnabled: false,
      graphClosureRecallEnabled: false, retrievalRecentContext: { topics: [] } };
    const makeStore = raw => {
      const store = t.emptyStore();
      t.ingestPacket(store, raw, 'alias-source', { messageIndex: 1 });
      t.rebuildIndex(store, { settings, deadlineAt: Date.now() + 10000 });
      store.context = {}; delete store._recallLatestPacket;
      return store;
    };
    const project = raw => t.localRecallRowsFromPacket({ raw, messageIndex: 1, sourcePairIndex: 1 }, 'alias-source');
    const deliver = async store => t.selectHayakuEvidencePlan(
      await t.searchIndexCompositeRecall(store, alias, settings), alias, settings, 14000);
    const raw = JSON.stringify(packet());
    const originalPacket = raw;
    const store = makeStore(raw);
    assert.ok(JSON.stringify(store.memory.summaries).includes(alias), 'fixture has a retained admitted alias');
    for (const [path, rows] of [['admitted-index', store.index], ['source-projection', project(raw)]]) {
      const summary = rows.find(row => row.category === 'summary_memory');
      const ranked = t.localRecallRank(rows, [alias]);
      assert.deepEqual(Array.from(ranked, row => row.id), [summary.id],
        `${path}: alias-only lexical search reaches only its original summary`);
      assert.ok(summary.publicText.includes(fact));
      assert.equal(summary.publicText.includes(alias), false, 'aliases are not established evidence text');
      const current = { ...store, index: rows, _recallSourceRows: rows, context: {} };
      const plan = await deliver(current);
      assert.ok(plan.text.includes(fact), `${path}: original fact reaches final evidence`);
      assert.equal(plan.text.includes(alias), false, 'final renderer must not emit retrieval-only aliases');
      assert.equal(plan.text.includes('돌담 아래 벽돌이 놓였다.'), false, 'public sibling cannot inherit summary alias');
      const before = JSON.stringify(rows);
      const zero = t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(current, alias, settings), alias, settings, 0);
      assert.equal(zero.text, '', 'alias match cannot bypass final budget');
      assert.equal(JSON.stringify(rows), before, 'search and rendering never mutate original rows');
      for (const field of ['sourceHash', 'sourceRevision', 'originalPointer']) {
        const changed = { ...summary, locator: { ...summary.locator, [field]: 'stale-binding' } };
        assert.equal(t.localRecallRank([changed], [alias]).length, 0, `stale ${field} cannot reuse alias metadata`);
      }
      const changedKey = { ...summary, recordKey: 'different-record' };
      assert.equal(t.localRecallRank([changedKey], [alias]).length, 0, 'alias ownership includes exact record key');
    }

    const restricted = packet({ en: [alias], ja: ['銀色の鍵'], zh: ['银色钥匙'] });
    restricted.entity.characters = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];
    restricted.entity.secrets = [{ id: 'secret', summary: '紫色の暗証番号', privacy: 'secret',
      ownerEntityId: 'alice', deniedToEntityIds: ['bob'] }];
    const sanitized = t.canonicalizePacketRecordForIngest(restricted, { sourceHash: 'alias-source' }).packet;
    assert.equal(sanitized.meta.summary_memory.recallAliases, undefined, 'fixture triggers existing fail-closed redaction');
    for (const rows of [project(JSON.stringify(restricted)), makeStore(JSON.stringify(restricted)).index]) {
      assert.equal(t.localRecallRank(rows, [alias]).filter(row => row.category === 'summary_memory').length, 0,
        'raw packet projection and admitted index cannot resurrect stripped cross-language aliases');
    }

    const privatePacket = packet();
    privatePacket.entity.characters = [{ id: 'owner', name: 'Alice' }];
    Object.assign(privatePacket.meta.summary_memory, { privacy: 'private', ownerEntityId: 'owner' });
    const privateStore = makeStore(JSON.stringify(privatePacket));
    assert.equal(t.localRecallCandidates(privateStore, alias, settings).filter(row => row.category === 'summary_memory').length, 0,
      'legacy wrapper lacking visibility cannot gain a private summary alias');
    privateStore._recallSourceRows = project(JSON.stringify(privatePacket));
    assert.equal(t.localRecallCandidates(privateStore, alias, settings).length, 0,
      'an alias never adds a private actor or grants access to a private summary');
    assert.equal((await deliver(privateStore)).text, '');

    // Same hash/address, new raw revision: an old document/projection cache must not retain an alias.
    const cached = makeStore(raw);
    const prepare = async (nextRaw, scope) => {
      await t.localRecallPrepareSources([{ raw: nextRaw, hash: 'alias-source', messageIndex: 1 }],
        cached, settings, scope, Date.now() + 10000);
      cached.context = {}; delete cached._recallLatestPacket;
      return t.localRecallRank(cached._recallSourceRows, [alias]).filter(row => row.category === 'summary_memory');
    };
    assert.equal((await prepare(raw, 'alias-scope')).length, 1);
    assert.equal((await prepare(JSON.stringify(packet({})), 'alias-scope')).length, 0,
      'reanalysis removing aliases invalidates cached alias-only matches');
    assert.equal((await prepare(raw, 'alias-scope')).length, 1);
    assert.equal((await prepare(JSON.stringify(restricted), 'alias-scope')).length, 0,
      'redaction on an existing address invalidates previously searchable aliases');
    assert.equal((await prepare(JSON.stringify(packet({})), 'another-worldline-scope')).length, 0,
      'another scope/worldline cannot inherit an old source alias');
    const beyondChunk = packet();
    // The summary appears first; the restricted row is beyond the 128-record projection budget.
    beyondChunk.world.world_rules = Array.from({ length: 130 }, (_, i) => ({ id: `rule-${i}`, summary: `규칙 ${i}` }));
    beyondChunk.entity.secrets = restricted.entity.secrets;
    const ordered = { meta: beyondChunk.meta, world: beyondChunk.world, entity: beyondChunk.entity,
      narrative: beyondChunk.narrative, planner: beyondChunk.planner };
    assert.equal((await prepare(JSON.stringify(ordered), 'chunk-boundary-scope')).length, 0,
      'restricted records outside a projection chunk still remove summary aliases');
    assert.equal(raw, originalPacket);
    assert.equal(h.llmCalls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    console.log('PASS sanitized summary alias ownership, original-text delivery, redaction, privacy, budget and cache invalidation');
  } finally { await h.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
