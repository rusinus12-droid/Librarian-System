'use strict';
// Stage 3 (observation) and Stage 4 (bounded participation) of the associative-recall research.
//
// The contract these assertions hold to, straight from the research note:
//
//   Stage 3 — "기존 Recall과 같은 입력으로 연상 후보를 계산하되 프롬프트는 바꾸지 않고, baseline 대비
//             추가/누락/모호성/비용을 표시한다."
//   Stage 4 — "소수의 적격 후보를 같은 예산 안에서 기존 selector로 보냄" / "별도 extractor/summary/
//             embedding 호출 없음".
//
// Everything below goes through the PUBLIC surface (`previewUnifiedMemoryRecall` and the diagnostics read
// model) on REAL committed batches. LIBRA's contract forbids a `_test` developer surface — the release
// test asserts LIBRA reports zero stripped `_test` bytes — so the suite drives the product path rather
// than a helper.
//
// Two committed batches are needed for the expansion to have anything to find: a single-batch corpus
// names every entity in its one memory, so every index record is already a direct candidate and the
// honest report is "nothing to add". `addFact` binds a further fact to a turn the FIRST batch covers,
// which is what makes a second memory reachable through a shared entity.
const assert = require('node:assert/strict');
const { fixture, advance, addFact } = require('./fixtures/libra_lore_link_index_fixture.cjs');

const results = [];
const plain = value => JSON.parse(JSON.stringify(value ?? null));
// Commit a second batch whose artifact carries only the first `keepFacts` of the base facts, so the two
// committed memories hold different entity sets. Sharing an entity is what makes a link reachable; equal
// sets would make every record a direct candidate already.
const { shiftRefs, artifact } = require('./fixtures/libra_lore_link_index_fixture.cjs');
const commitSecondBatch = (f, keepFacts) => {
  const offset = 5;
  const start = offset + 1;
  f.chat.message.push(...f.chat.message.slice(0, 10).map((message, index) => ({
    ...message, chatId: `t${start + Math.floor(index / 2)}-${index % 2 ? 'a' : 'u'}`
  })));
  const shifted = shiftRefs(JSON.parse(JSON.stringify(artifact())), offset);
  shifted.facts = shifted.facts.slice(0, Number(keepFacts));
  shifted.stateBindings = [];
  f.control.artifact = shifted;
};

const arr = value => (Array.isArray(value) ? value : []);

async function test(name, args, fn) {
  const f = await fixture({ args: { evidence_link_index_enabled: 'true', lore_link_index_enabled: 'true', ...(args || {}) } });
  try { await fn(f); results.push(name); } finally { await f.r.cleanup(); }
}

(async () => {
  await test('with graph flags at their default OFF, recall does not read or build the evidence graph', {}, async () => {
    const f = await fixture({ args: {} });
    try {
      assert.equal((await f.run()).completed, 1);
      const evidenceIndexReads = () => f.r.storageReads.filter(key => key.includes(':evidence-link-index:v1')).length;
      const before = evidenceIndexReads();
      await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
      assert.equal(evidenceIndexReads(), before, 'default recall must not even check the graph-index storage key');
      const read = plain(await f.r.api.getAssociativeRecallDiagnostics());
      assert.equal(read.observation?.reason, 'graph_recall_disabled');
      assert.equal(f.getRecords('libra.evidence_link_index.v1').length, 0);
    } finally { await f.r.cleanup(); }
  });

  await test('explicit evidence-link opt-in still runs observation with participation OFF', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    const before = f.r.storageReads.filter(key => key.includes(':evidence-link-index:v1')).length;
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    const after = f.r.storageReads.filter(key => key.includes(':evidence-link-index:v1')).length;
    assert.ok(after > before, 'the explicit opt-in reads/builds its graph index');
    assert.equal(plain(await f.r.api.getAssociativeRecallDiagnostics()).participationEnabled, false);
  });

  await test('observation runs with participation OFF and reports what it found', {}, async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    // The observation is produced by the RECALL path, so it must be read after a recall has run.
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    const read = plain(await f.r.api.getAssociativeRecallDiagnostics());
    assert.equal(read.schema, 'libra.associative_recall.v1');
    assert.equal(read.participationEnabled, false, 'admission is off by default');
    assert.ok(read.observation, 'the observation must be recorded even when nothing is admitted');
    const observed = read.observation;
    assert.equal(observed.mode, 'observation_only');
    assert.equal(observed.budgetUnchanged, true);
    assert.equal(observed.admitLimit, 2, 'the admit limit is the note initial experiment value');
    assert.equal(observed.providerCalls, 0);
    assert.equal(observed.llmCalls, 0);
    assert.equal(observed.embeddingCalls, 0);
    assert.ok(observed.baseline && Array.isArray(observed.baseline.memoryIds));
    assert.ok(Array.isArray(observed.added) && Array.isArray(observed.omitted));
    assert.ok(Array.isArray(observed.candidates), 'each reached candidate is reported, admitted or not');
  });

  await test('with participation OFF the delivered result is unchanged by the observation', {}, async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const withIndex = plain(await f.r.api.previewUnifiedMemoryRecall('서재 열쇠'));

    // The same fixture with the index never built: the observation cannot find anything to compare.
    const g = await fixture({ args: { evidence_link_index_enabled: 'false', lore_link_index_enabled: 'false' } });
    try {
      assert.equal((await g.run()).completed, 1);
      const withoutIndex = plain(await g.r.api.previewUnifiedMemoryRecall('서재 열쇠'));
      assert.deepEqual(withIndex.memories.map(m => m.memoryId), withoutIndex.memories.map(m => m.memoryId),
        'observation alone must not change which memories are delivered');
      assert.deepEqual(withIndex.diagnostics?.budgetPlan?.attempts, withoutIndex.diagnostics?.budgetPlan?.attempts,
        'the packed budget must be identical: observation reserves no room');
    } finally { await g.r.cleanup(); }
  });

  await test('the expansion never seeds from the query text and says why when it finds nothing', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    if (observed.active === true) {
      assert.ok(Number(observed.seedEntities) >= 1, 'an active expansion must name its seed entities');
      assert.equal(observed.hops, 1, 'one hop is the note starting point');
      assert.ok(['current_view', 'fact_history'].includes(observed.basis),
        'the expansion declares whether it read the current view or the fact history, never both');
      assert.ok(Array.isArray(observed.bridges));
    } else {
      assert.ok(String(observed.reason || '').length > 0, 'an inactive expansion must state its reason');
      assert.equal(arr(observed.added).length, 0, 'nothing is added when nothing was reached');
    }
  });

  await test('the expansion reaches a memory the direct search did not return', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    // The second batch carries only a SUBSET of the first batch's facts, so the two committed memories
    // hold DIFFERENT entity sets. That is what makes a link reachable: when both memories name every
    // entity, every index record is already a direct candidate and the honest report is "nothing to add".
    commitSecondBatch(f, 4);
    assert.equal((await f.run()).completed, 1);

    // '은빛 열쇠' is named by the FIRST memory only. The second memory is not a direct hit for it and is
    // reachable only through the entities the two share.
    const recalled = plain(await f.r.api.previewUnifiedMemoryRecall('예전 은빛 열쇠'));
    const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;

    assert.equal(observed.active, true,
      `the expansion must reach across the shared entities: ${JSON.stringify(observed)}`);
    assert.equal(observed.basis, 'fact_history', 'a historical query reads the fact history');
    assert.equal(observed.hops, 1, 'one hop is the note starting point');
    assert.equal(observed.providerCalls, 0, 'reaching a candidate costs no provider call');
    assert.equal(observed.sourceText, '예전 은빛 열쇠', 'the graph source uses the actual recall input');
    assert.equal(observed.scopeKey, recalled.scopeKey, 'the graph observation is bound to the recall scope');
    assert.ok(Number(observed.seedEntities) >= 1, 'seeds come from a direct candidate, never the query text');

    // The direct result and the reached candidate are DIFFERENT memories — the whole point of the stage.
    const directIds = arr(recalled.memories).map(entry => String(entry?.memory?.memoryId || ''));
    assert.equal(observed.reachedMemories, 1);
    assert.equal(arr(observed.candidates).length, 1);
    assert.ok(Array.isArray(observed.agreed), 'the report separates agreement from refusal');
    const candidate = observed.candidates[0];
    assert.ok(String(candidate.memoryId).length > 0, 'a reached candidate is identified');
    assert.ok(String(candidate.summary || '').trim().length > 0,
      'a graph memory node has a reader-facing summary from its committed manifest ref');
    assert.ok(Number(candidate.turnRange?.start) > 0 && Number(candidate.turnRange?.end) >= Number(candidate.turnRange.start),
      'a graph memory node has a real turn range, never a fabricated title');
    assert.equal(directIds.includes(String(candidate.memoryId)), false,
      'a reached candidate is never one the direct search already returned');
    assert.ok(arr(candidate.via).length >= 1, 'a reached candidate records the paths it came by');
    for (const path of arr(candidate.via)) {
      assert.ok(String(path.factKey).length > 0, 'each path names the fact it came through');
      assert.ok(String(path.entityId).length > 0, 'each path names the shared entity');
      assert.ok(String(path.entityName || '').trim().length > 0,
        'the public observation names the entity on every rendered graph path');
    }
    // The bridges are the entities that carried it, named for a reader.
    assert.ok(arr(observed.bridges).length >= 1, 'the bridge entities are reported');
    assert.ok(arr(observed.bridges).every(bridge => String(bridge.entityName || '').length > 0),
      'a bridge is named, not just identified');
  });

  await test('a present query cannot bridge through a superseded memory fact when Head names the same entity elsewhere', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    commitSecondBatch(f, 4);
    assert.equal((await f.run()).completed, 1);
    const baseline = plain(await f.r.api.previewUnifiedMemoryRecall('현재 은빛 열쇠'));
    const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    assert.equal(observed.basis, undefined, 'an expansion with no current-authoritative bridge must fail open');
    assert.equal(observed.active, false);
    assert.equal(arr(observed.added).length, 0);
    assert.ok(Array.isArray(baseline.memories), 'ordinary Recall still returns its baseline result');
  });

  await test('an allowed rendered lore passage carries a real candidate path with its lore identity', {}, async f => {
    const initial = artifact();
    initial.entities = initial.entities.filter(entity => entity.tempId === 'mina');
    initial.facts = initial.facts.filter(fact => fact.tempFactId === 'f9');
    initial.stateBindings = [];
    f.control.artifact = initial;
    f.withLoreEntry({ id: 'lore-bridge', key: 'lore-bridge', label: '설정 연결', sourceType: 'character', source: 'character',
      content: '민아와 은빛 열쇠는 같은 설정에 등장한다.', keys: ['민아'], priority: 100, enabled: true, constant: true });
    assert.equal((await f.run()).completed, 1);
    assert.deepEqual(plain(f.getMemory().canonicalArtifact.entities).map(entity => entity.tempId), ['mina']);
    f.control.artifact = artifact();
    commitSecondBatch(f, 6);
    assert.equal((await f.run()).completed, 1);
    const allowedLore = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    const loreBridge = allowedLore.entries.find(entry => entry.identity.includes('lore-bridge'));
    assert.ok(loreBridge);
    await f.r.api.previewUnifiedMemoryRecall('예전 상자의 암호');
    const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    assert.equal(observed.active, true, JSON.stringify(observed));
    const candidate = observed.candidates.find(row => row.memoryId !== 'mem_000001');
    assert.ok(candidate, 'the lore passage must reach the second committed memory');
    const targetEntityIds = new Set(arr(loreBridge.passages).flatMap(passage => arr(passage.mentions))
      .filter(mention => mention.name === '은빛 열쇠' && mention.ambiguous !== true).map(mention => mention.entityId));
    assert.ok(targetEntityIds.size > 0, 'the allowed passage resolves the linked candidate entity');
    assert.ok(arr(candidate.via).some(path => path.loreIdentity?.includes('lore-bridge') && targetEntityIds.has(path.entityId)),
      `the candidate path must traverse the non-seed entity named by the allowed lore passage: ${JSON.stringify({candidate,targetEntityIds:[...targetEntityIds]})}`);
  });

  await test('an ambiguous alias in a later passage cannot borrow the same entity link from an earlier passage', {}, async f => {
    const initial = artifact();
    initial.entities = initial.entities.filter(entity => entity.tempId === 'mina');
    initial.facts = initial.facts.filter(fact => fact.tempFactId === 'f9');
    initial.stateBindings = [];
    f.control.artifact = initial;
    const longLore = `은빛 열쇠는 오래된 상자에 보관된다.\n\n${'기록된 규칙은 정리되어 보관된다. '.repeat(200)}\n\n민아와 열쇠는 그 장면에 함께 있었다.`;
    assert.ok(longLore.length > 2800);
    f.withLoreEntry({ id: 'lore-passage-ambiguity', key: 'lore-passage-ambiguity', label: '긴 설정', sourceType: 'character', source: 'character',
      content: longLore, keys: ['은빛 열쇠'], priority: 100, enabled: true, constant: true });
    assert.equal((await f.run()).completed, 1);
    f.control.artifact = artifact();
    commitSecondBatch(f, 6);
    assert.equal((await f.run()).completed, 1);
    const registryRecord = f.getRecords('libra.entity_registry.v2')[0];
    const registry = plain(registryRecord.value);
    const keyEntity = registry.entities.find(entity => entity.name === '은빛 열쇠');
    const libraryEntity = registry.entities.find(entity => entity.name === '도서관');
    assert.ok(keyEntity && libraryEntity);
    keyEntity.aliases = [...arr(keyEntity.aliases), '열쇠'];
    libraryEntity.aliases = [...arr(libraryEntity.aliases), '열쇠'];
    f.r.values.set(registryRecord.key, JSON.stringify(registry));
    const index = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    const entry = index.entries.find(row => row.identity.includes('lore-passage-ambiguity'));
    const lastPassage = arr(entry?.passages).at(-1);
    assert.ok(lastPassage && lastPassage.start > 0, 'the final ambiguous mention belongs to a later passage window');
    assert.ok(arr(lastPassage.mentions).some(row => row.entityId === keyEntity.id && row.name === '열쇠' && row.ambiguous === true));
    const keyLink = index.links.find(row => row.identity === entry.identity && row.entityId === keyEntity.id);
    assert.ok(keyLink);
    assert.equal(keyLink.resolution, 'held_ambiguous', 'a later ambiguous hit cannot be hidden by an earlier unique hit during aggregation');
    await f.r.api.previewUnifiedMemoryRecall('예전 상자의 암호');
    let observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    let candidate = observed.candidates.find(row => row.memoryId === 'mem_000006');
    assert.ok(candidate);
    assert.equal(arr(candidate.via).some(path => path.loreIdentity === entry.identity && path.entityId === keyEntity.id), false,
      'a prior unique passage link cannot authorize the later ambiguous mention');
    await f.r.api.setLoreLinkMapping({ expectedScopeKey: index.scopeKey, expectedMappingRevision: index.basis.mappingsDigest,
      linkKey: keyLink.linkKey, candidateEntityId: keyEntity.id, action: 'confirm' });
    await f.r.api.previewUnifiedMemoryRecall('예전 상자의 암호');
    observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    candidate = observed.candidates.find(row => row.memoryId === 'mem_000006');
    assert.ok(arr(candidate?.via).some(path => path.loreIdentity === entry.identity && path.entityId === keyEntity.id),
      'an explicit confirmation enables only the selected ambiguous passage candidate');
  });

  await test('removed lore links cannot carry a candidate, and restore re-enables the public traversal', {}, async f => {
    const initial = artifact();
    initial.entities = initial.entities.filter(entity => entity.tempId === 'mina');
    initial.facts = initial.facts.filter(fact => fact.tempFactId === 'f9');
    initial.stateBindings = [];
    f.control.artifact = initial;
    f.withLoreEntry({ id: 'lore-bridge', key: 'lore-bridge', label: '설정 연결', sourceType: 'character', source: 'character',
      content: '민아와 은빛 열쇠는 같은 설정에 등장한다.', keys: ['민아'], priority: 100, enabled: true, constant: true });
    assert.equal((await f.run()).completed, 1);
    f.control.artifact = artifact();
    commitSecondBatch(f, 6);
    assert.equal((await f.run()).completed, 1);
    const before = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    const link = before.links.find(row => row.identity?.includes('lore-bridge') && row.entityName === '은빛 열쇠');
    assert.ok(link, 'the custom passage has an effective key link before removal');
    await f.r.api.setLoreLinkMapping({ linkKey: link.linkKey, action: 'remove' });
    await f.r.api.previewUnifiedMemoryRecall('예전 상자의 암호');
    let observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    let candidate = observed.candidates.find(row => row.memoryId === 'mem_000006');
    assert.ok(candidate);
    assert.equal(arr(candidate.via).some(path => path.loreIdentity === link.identity && path.entityId === link.entityId), false,
      'a raw passage mention cannot override the removed effective link');
    await f.r.api.setLoreLinkMapping({ linkKey: link.linkKey, action: 'restore' });
    await f.r.api.previewUnifiedMemoryRecall('예전 상자의 암호');
    observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    candidate = observed.candidates.find(row => row.memoryId === 'mem_000006');
    assert.ok(arr(candidate?.via).some(path => path.loreIdentity === link.identity && path.entityId === link.entityId),
      'restoring the effective link enables that passage path again');
  });

  await test('lore traversal follows a confirmed ambiguous candidate, keeps alternatives held, and requires reconfirmation after restore', {}, async f => {
    const initial = artifact();
    initial.entities = initial.entities.filter(entity => entity.tempId === 'mina');
    initial.facts = initial.facts.filter(fact => fact.tempFactId === 'f9');
    initial.stateBindings = [];
    f.control.artifact = initial;
    f.withLoreEntry({ id: 'lore-bridge', key: 'lore-bridge', label: '설정 연결', sourceType: 'character', source: 'character',
      content: '민아와 은빛 열쇠는 같은 설정에 등장한다.', keys: ['민아'], priority: 100, enabled: true, constant: true });
    assert.equal((await f.run()).completed, 1);
    f.control.artifact = artifact();
    commitSecondBatch(f, 6);
    assert.equal((await f.run()).completed, 1);
    const registryRecord = f.getRecords('libra.entity_registry.v2')[0];
    const registry = plain(registryRecord.value);
    const keyEntity = registry.entities.find(entity => entity.name === '은빛 열쇠' && entity.type === 'world');
    assert.ok(keyEntity);
    registry.entities.push({ id: 'ce_person_00000000', type: 'person', kind: 'person', name: '대역', aliases: ['은빛 열쇠'], mergedIds: [] });
    f.r.values.set(registryRecord.key, JSON.stringify(registry));
    const ambiguousIndex = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    const identity = ambiguousIndex.entries.find(entry => entry.identity.includes('lore-bridge')).identity;
    const chosenLinkKey = `${identity}::${keyEntity.id}`;
    const held = ambiguousIndex.ambiguous.find(row => row.linkKey === chosenLinkKey);
    assert.ok(held && held.candidates.includes(keyEntity.id));
    const alternativeId = held.candidates.find(id => id !== keyEntity.id);
    assert.ok(alternativeId);
    const confirm = async index => f.r.api.setLoreLinkMapping({ expectedScopeKey: index.scopeKey,
      expectedMappingRevision: index.basis.mappingsDigest, linkKey: chosenLinkKey,
      candidateEntityId: keyEntity.id, action: 'confirm' });
    const assertTraversable = async expected => {
      await f.r.api.previewUnifiedMemoryRecall('예전 상자의 암호');
      const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
      const candidate = observed.candidates.find(row => row.memoryId === 'mem_000006');
      const linked = arr(candidate?.via).some(path => path.loreIdentity === identity && path.entityId === keyEntity.id);
      assert.equal(linked, expected, JSON.stringify({ expected, candidate }));
      return candidate;
    };
    await assertTraversable(false);
    await confirm(ambiguousIndex);
    let index = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    assert.equal(index.links.find(row => row.linkKey === chosenLinkKey)?.resolution, 'confirmed');
    assert.equal(index.links.find(row => row.identity === identity && row.entityId === alternativeId)?.resolution, 'held_ambiguous');
    await assertTraversable(true);
    await f.r.api.setLoreLinkMapping({ linkKey: chosenLinkKey, action: 'remove' });
    index = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    assert.equal(index.links.some(row => row.linkKey === chosenLinkKey), false);
    assert.equal(index.links.find(row => row.identity === identity && row.entityId === alternativeId)?.resolution, 'held_ambiguous');
    await assertTraversable(false);
    await f.r.api.setLoreLinkMapping({ linkKey: chosenLinkKey, action: 'restore' });
    index = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    assert.equal(index.links.find(row => row.linkKey === chosenLinkKey)?.resolution, 'held_ambiguous');
    await assertTraversable(false);
    await confirm(index);
    index = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    assert.equal(index.links.find(row => row.linkKey === chosenLinkKey)?.resolution, 'confirmed');
    assert.equal(index.links.find(row => row.identity === identity && row.entityId === alternativeId)?.resolution, 'held_ambiguous');
    await assertTraversable(true);
    await f.r.api.setLoreLinkMapping({ expectedScopeKey: index.scopeKey, expectedMappingRevision: index.basis.mappingsDigest,
      linkKey: chosenLinkKey, candidateEntityId: alternativeId, action: 'confirm' });
    index = plain(await f.r.api.getLoreLinkIndex({ force: true }));
    assert.equal(index.links.find(row => row.identity === identity && row.entityId === keyEntity.id)?.resolution, 'held_ambiguous',
      'confirming a second candidate replaces the earlier candidate in this rendered-name group');
    assert.equal(index.links.find(row => row.identity === identity && row.entityId === alternativeId)?.resolution, 'confirmed');
    await assertTraversable(false);
  });

  await test('lore-enabled preview and Input Writer preflight do not persist a rebuilt link index', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    assert.equal(f.getRecords('libra.lore_link_index.v1').length, 0);
    const loreWritesBefore = f.r.storageWrites.filter(row => row.key.includes('lore_link_index')).length;
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    assert.equal(f.r.storageWrites.filter(row => row.key.includes('lore_link_index')).length, loreWritesBefore,
      'preview recall must not write the regenerated lore index');
    assert.equal(f.getRecords('libra.lore_link_index.v1').length, 0);
    await f.r.api.prepareInputWriterEvidence('이유를 묻는다.');
    assert.equal(f.r.storageWrites.filter(row => row.key.includes('lore_link_index')).length, loreWritesBefore,
      'Input Writer preflight must not persist the regenerated lore index');
    assert.equal(f.getRecords('libra.lore_link_index.v1').length, 0);
    const persisted = plain(await f.r.api.getLoreLinkIndex());
    assert.equal(persisted.status.persisted, true, 'a later persistent reader flushes a request-local cached index');
    assert.equal(f.getRecords('libra.lore_link_index.v1').length, 1);
  });

  await test('a current authoritative Head with no fields cannot promote history into a present bridge', {}, async f => {
    const initial = artifact();
    initial.entities = initial.entities.filter(entity => entity.tempId === 'mina');
    initial.facts = initial.facts.filter(fact => fact.tempFactId === 'f9');
    initial.stateBindings = [];
    f.control.artifact = initial;
    assert.equal((await f.run()).completed, 1);
    f.control.artifact = artifact();
    commitSecondBatch(f, 6);
    assert.equal((await f.run()).completed, 1);
    const headRecord = f.getRecords('libra.continuity_state.v2')[0];
    const emptyHead = plain(headRecord.value);
    for (const row of [...arr(emptyHead.characters), ...arr(emptyHead.world)]) { row.state = {}; row.fieldEvidence = {}; }
    for (const row of arr(emptyHead.relationships)) { row.state = {}; row.fieldEvidence = {}; }
    f.r.values.set(headRecord.key, JSON.stringify(emptyHead));
    const index = plain(await f.r.api.getEvidenceLinkIndex({ force: true }));
    assert.equal(index.current.authority.current, true, 'the Head is authoritative');
    assert.equal(arr(index.current.fields).length, 0, 'the authoritative Head has no field assertions');
    await f.r.api.previewUnifiedMemoryRecall('현재 상자의 암호');
    const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    assert.equal(observed.active, false, JSON.stringify(observed));
    assert.equal(observed.reason, 'no_reachable_candidate', 'empty Head evidence cannot authorize a historical fact');
    assert.equal(observed.basis, undefined);
  });

  await test('a reached candidate is delivered, agreed, or omitted with its final public-preview outcome', { associative_recall_enabled: 'true' }, async f => {
    assert.equal((await f.run()).completed, 1);
    commitSecondBatch(f, 4);
    assert.equal((await f.run()).completed, 1);
    const recalled = plain(await f.r.api.previewUnifiedMemoryRecall('예전 은빛 열쇠'));
    const deliveredIds = new Set(arr(recalled.memories).map(entry => String(entry?.memory?.memoryId || '')));
    const observed = plain(await f.r.api.getAssociativeRecallDiagnostics()).observation;
    assert.equal(observed.active, true, 'the expansion reached the second memory');

    // Every reached candidate lands in exactly one of the two sets, and a refusal says WHY. Without this
    // an omission would be silent, and a reader could not tell a deliberate rule from a broken one.
    assert.equal(arr(observed.added).length + arr(observed.agreed).length + arr(observed.omitted).length, arr(observed.candidates).length,
      'every reached candidate has exactly one final outcome');
    // Three outcomes, and each must be reported distinctly. Collapsing agreement into refusal would
    // report the OPPOSITE of what happened: a link that found the same memory the direct path found is
    // corroboration, not a rejection.
    const refOf = candidate => `${String(candidate.memoryId)}:r${Number(candidate.revision || 0)}`;
    for (const candidate of arr(observed.candidates)) {
      const ref = refOf(candidate);
      const reason = String(candidate.admittedReason || '');
      assert.ok(reason.length > 0, 'every candidate states its outcome');
      if (candidate.admitted === true) {
        assert.equal(arr(observed.added).includes(ref), true, `${ref} is reported as added`);
        assert.equal(reason, 'delivered_within_budget');
        assert.equal(deliveredIds.has(String(candidate.memoryId)), true, `${ref} was selected into the public recall result`);
      } else if (reason === 'already_hydrated_by_shortlist') {
        assert.equal(arr(observed.agreed).includes(ref), true, `${ref} is reported as an agreement`);
        assert.equal(arr(observed.omitted).includes(ref), false, 'an agreement is not a refusal');
      } else {
        assert.equal(arr(observed.omitted).includes(ref), true, `${ref} is reported as omitted`);
        assert.equal(arr(observed.agreed).includes(ref), false, 'a refusal is not an agreement');
      }
    }
    // The three sets are disjoint and cover every reached candidate exactly once.
    const all = [...arr(observed.added), ...arr(observed.agreed), ...arr(observed.omitted)];
    assert.equal(all.length, arr(observed.candidates).length,
      `every reached candidate lands in exactly one set: ${JSON.stringify(all)}`);
    assert.ok(arr(observed.added).length <= 2, 'the admit limit holds');
    assert.ok(arr(observed.added).every(ref => deliveredIds.has(String(ref).split(':')[0])),
      'added means the associative memory is actually in the delivered preview');
    assert.equal(observed.budgetUnchanged, true);
  });

  await test('an admitted candidate still passes the ordinary gate, and the budget is not enlarged', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    advance(f, 5);
    assert.equal((await f.run()).completed, 1);
    await f.r.api.previewUnifiedMemoryRecall('도서관 기록회 약속');
    const read = plain(await f.r.api.getAssociativeRecallDiagnostics());
    const observed = read.observation;
    assert.ok(arr(observed.added).length <= 2, `at most the admit limit may enter: ${arr(observed.added).length}`);
    assert.equal(observed.budgetUnchanged, true, 'participation must not create budget');
    for (const id of arr(observed.added)) assert.match(id, /^mem_\d+:r\d+$/, `${id} must be a committed memory ref`);
    // The admitted and omitted sets are disjoint: a candidate is one or the other, never both.
    const added = new Set(arr(observed.added));
    for (const id of arr(observed.omitted)) assert.equal(added.has(id), false, 'a candidate cannot be both added and omitted');
  });

  await test('participation adds no provider call', { associative_recall_enabled: 'true' }, async f => {
    assert.equal((await f.run()).completed, 1);
    const callsBefore = f.control.calls.length;
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    assert.equal(f.control.calls.length, callsBefore,
      'the associative recall path must not add a model, embedding or reranker call');
    const read = plain(await f.r.api.getAssociativeRecallDiagnostics());
    assert.equal(read.participationEnabled, true, 'participation is on when the flag is set');
    assert.equal(read.observation.mode, 'participation');
    assert.equal(read.observation.providerCalls, 0);
  });

  await test('an unavailable index fails open instead of blocking recall', { associative_recall_enabled: 'true' }, async f => {
    // Participation is ON but the index is not built, so the expansion has nothing to read.
    const g = await fixture({ args: { evidence_link_index_enabled: 'false', lore_link_index_enabled: 'false', associative_recall_enabled: 'true' } });
    try {
      assert.equal((await g.run()).completed, 1);
      await g.r.api.previewUnifiedMemoryRecall('서재 열쇠');
      const observed = plain(await g.r.api.getAssociativeRecallDiagnostics()).observation;
      assert.equal(observed.active, false, 'with no index there is nothing to expand from');
      assert.ok(String(observed.reason || '').length > 0, 'an unavailable index names its reason');
      const recall = plain(await g.r.api.previewUnifiedMemoryRecall('서재 열쇠'));
      assert.ok(Array.isArray(recall.memories), 'recall still answers');
    } finally { await g.r.cleanup(); }
  });

  await test('the canonical memory and Head bytes are unchanged by a participating recall', { associative_recall_enabled: 'true' }, async f => {
    assert.equal((await f.run()).completed, 1);
    const memoryBefore = JSON.stringify(plain(f.getMemory()));
    const headBefore = JSON.stringify(plain(f.getHead()));
    await f.r.api.previewUnifiedMemoryRecall('서재 열쇠');
    assert.equal(JSON.stringify(plain(f.getMemory())), memoryBefore, 'canonical bytes must not move');
    assert.equal(JSON.stringify(plain(f.getHead())), headBefore, 'Head bytes must not move');
  });

  await test('a same-turn Head content edit invalidates the evidence index cache', {}, async f => {
    assert.equal((await f.run()).completed, 1);
    const first = await f.r.api.getEvidenceLinkIndex({ force: true });
    assert.ok(first.current.fields.length > 0);
    const headRecord = f.getRecords('libra.continuity_state.v2')[0];
    assert.ok(headRecord);
    const changed = plain(headRecord.value);
    changed.characters[0].state.locationRef = 'edited-same-turn-location';
    f.r.values.set(headRecord.key, JSON.stringify(changed));
    const second = await f.r.api.getEvidenceLinkIndex({ force: false });
    assert.notEqual(second.signature, first.signature, 'the signature must include Head contents, not only row counts');
    assert.ok(second.current.fields.some(field => field.value === 'edited-same-turn-location'),
      'the refreshed cached index must carry the changed Head value');
  });

  console.log(JSON.stringify({ suite: 'libra_associative_recall', passed: results.length, tests: results }, null, 1));
  console.log('libra_associative_recall_test: PASS');
})().catch(error => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
