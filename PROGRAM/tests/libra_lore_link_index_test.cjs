'use strict';
// Stage 2 lore reference linking: the index must bind the ALLOWED lore corpus to the SAME verified
// entity identities the evidence link index uses, by explicit name/alias reference only.
//
// The contract (SUPERVISOR_CLOSURE_AND_STAGE2_CONTRACT.md §3) is what these assertions hold to, and each
// one is written so it would FAIL against the shortcut the research note forbids.
//
// A FIRST VERSION OF THIS SUITE PASSED VACUOUSLY. It used `libra_unified_runtime_fixture`, which seeds no
// lore at all, so `allowedLoreCount` was 0 and all nine assertions passed on empty arrays. The fixture now
// seeds a real lorebook through the surface the collector actually reads, and the first assertion below
// pins that down: if the corpus is ever empty again, the suite fails instead of reporting success.
const assert = require('node:assert/strict');
const { fixture, NAMED_ENTRY, UNKNOWN_ENTRY } = require('./fixtures/libra_lore_link_index_fixture.cjs');

const results = [];
// Only the lore-link opt-in is enabled; the Stage 1 index stays off so its own gate is not entangled.
const enabled = options => fixture({ ...options, args: { lore_link_index_enabled: 'true', ...options?.args } });
async function test(name, fn) { const f = await enabled(); try { await fn(f); results.push(name); } finally { await f.r.cleanup(); } }
// Values returned from the plugin VM carry that realm's prototypes; compare plain data.
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  await test('the fixture delivers a non-empty ALLOWED corpus (guards against a vacuous suite)', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const index = await f.r.api.getLoreLinkIndex({});
    assert.notEqual(index.available, false, `expected an index, got ${JSON.stringify(index)}`);
    assert.ok(Number(index.status.allowedLoreCount) >= 1,
      'the allowed corpus must be non-empty, otherwise every assertion below passes on empty arrays');
    assert.ok(Number(index.status.entityNameCount) >= 1, 'the registry must contribute matchable names');
  });

  await test('index links only entities the allowed lore actually names', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const callsBefore = f.control.calls.length;

    const index = await f.r.api.getLoreLinkIndex({});
    assert.equal(index.schema, 'libra.lore_link_index.v1');
    assert.equal(index.buildVersion, 'shared_person_boundary_v2');
    assert.equal(f.control.calls.length, callsBefore, 'building the lore link index must not call a provider');
    assert.equal(index.bodiesCopied, false);

    // The entry that names registered entities produced links; the one that names none produced none.
    // Entries are identified by the entry id inside `identity`, NOT by `label`: the host supplies the
    // COLLECTION label to every entry in a lorebook (measured: both of this fixture's entries carry
    // label "캐릭터 로어북"), so `label` cannot distinguish them.
    const named = index.entries.find(entry => String(entry.identity).includes(NAMED_ENTRY.id));
    assert.ok(named, `the naming entry must be indexed: ${JSON.stringify(index.entries.map(e => e.identity))}`);
    assert.ok(named.passages.some(passage => (passage.mentions || []).length > 0),
      'the naming entry must record at least one mention');
    assert.equal(index.entries.some(entry => String(entry.identity).includes(UNKNOWN_ENTRY.id)), false,
      'an entry naming no registered entity produces no index entry');
    assert.ok(index.links.length >= 1, 'the naming entry must produce at least one link');

    // Every link points at a registry identity and describes a NAMING, never a relation or an event.
    const registryIds = new Set(index.entities.map(entity => entity.id));
    for (const link of index.links) {
      assert.match(link.entityId, /^ce_(person|world)_[0-9a-f]{8}$/, 'links use registry ids, not consumer ids');
      assert.ok(registryIds.has(link.entityId), `link entity ${link.entityId} must be a registry entity`);
      assert.equal(link.via, 'name_reference', 'a link is a reference match, never an inferred relation');
      assert.ok(['reference', 'confirmed', 'held_ambiguous'].includes(link.resolution));
      assert.ok(!/caused|because|led_to|owns|holds|kills/i.test(link.via));
      assert.ok(link.passageCount >= 1, 'a link names the passage that carried the mention');
    }
    // The names it linked are the ones the lore text really contains.
    const linkedNames = new Set(index.links.map(link => link.entityName));
    for (const name of linkedNames) assert.ok(NAMED_ENTRY.content.includes(name), `${name} must appear in the lore text`);
  });

  await test('a passage naming too many entities is counted, not linked to each of them', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const index = await f.r.api.getLoreLinkIndex({});
    for (const entry of index.entries) {
      for (const passage of entry.passages) {
        // The locator must never claim a raw-template coordinate it cannot produce.
        assert.equal(passage.coordinateSpace, 'rendered');
        assert.equal(passage.rawOffsetAvailable, false);
        assert.equal(passage.rawOffsetUnavailableReason, 'cbs_rendered_text_only');
        assert.ok(Number.isInteger(passage.start) && Number.isInteger(passage.end));
        assert.ok(passage.renderedHash, 'the rendered text is identified by hash');
        if (passage.linked === false) {
          assert.equal(passage.reason, 'passage_entity_limit');
          assert.equal(passage.mentions, undefined, 'an over-limit passage carries no per-entity mentions');
        }
      }
    }
  });

  await test('the opt-in is off by default and costs nothing when disabled', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const g = await fixture();                       // same seeding, but the argument is never enabled
    try {
      await g.run();
      const callsBefore = g.control.calls.length;
      const disabled = await g.r.api.getLoreLinkIndex({});
      assert.equal(disabled.available, false);
      assert.equal(disabled.reason, 'lore_link_index_disabled');
      assert.equal(disabled.providerCalls, 0);
      assert.equal(g.control.calls.length, callsBefore, 'a disabled index calls nothing');
      assert.equal(g.getRecords('libra.lore_link_index.v1').length, 0, 'a disabled index writes no storage row');
    } finally { await g.r.cleanup(); }
  });

  await test('recall and canonical bytes are unchanged by building the index', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const memoryBefore = JSON.stringify(plain(f.getMemory()));
    const headBefore = JSON.stringify(plain(f.getHead()));
    const callsBefore = f.control.calls.length;

    const index = await f.r.api.getLoreLinkIndex({});
    assert.equal(index.schema, 'libra.lore_link_index.v1');
    assert.equal(f.control.calls.length, callsBefore);
    assert.equal(JSON.stringify(plain(f.getMemory())), memoryBefore, 'canonical memory bytes must not change');
    assert.equal(JSON.stringify(plain(f.getHead())), headBefore, 'Head bytes must not change');
  });

  await test('a removal survives a content change and is never auto-cleared', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const first = await f.r.api.getLoreLinkIndex({});
    assert.ok(first.links.length >= 1, 'this case needs at least one linkable reference');
    const target = first.links[0].linkKey;

    const removed = await f.r.api.setLoreLinkMapping({ linkKey: target, action: 'remove' });
    assert.ok(plain(removed.removals).includes(target), 'the removal is stored');
    const afterRemoval = await f.r.api.getLoreLinkIndex({ force: true });
    assert.equal(afterRemoval.links.some(link => link.linkKey === target), false, 'a removed link is not served');

    // Restoring is an explicit user action; it is the only thing that clears the exclusion.
    const restored = await f.r.api.setLoreLinkMapping({ linkKey: target, action: 'restore' });
    assert.equal(plain(restored.removals).includes(target), false, 'restore clears the exclusion');
    const afterRestore = await f.r.api.getLoreLinkIndex({ force: true });
    assert.equal(afterRestore.links.some(link => link.linkKey === target), true, 'the restored link is served again');
  });

  await test('mapping actions are validated and do not silently accept an unknown verb', async f => {
    await f.run();
    await assert.rejects(() => f.r.api.setLoreLinkMapping({ linkKey: 'a::b', action: 'delete' }),
      /lore_link_mapping_action_invalid/);
    await assert.rejects(() => f.r.api.setLoreLinkMapping({ action: 'remove' }),
      /lore_link_mapping_link_key_required/);
  });

  await test('ambiguous confirmation binds the explicitly selected current candidate and can be removed/restored', async f => {
    await f.run();
    // Introduce a real second owner of the rendered name through the live registry record.
    const registryRecord = f.getRecords('libra.entity_registry.v2')[0];
    assert.ok(registryRecord, 'the committed run must create the registry');
    const registry = plain(registryRecord.value);
    const keyEntity = registry.entities.find(entity => entity.name === '서재');
    const other = registry.entities.find(entity => entity.id !== keyEntity.id);
    other.aliases = [...(other.aliases || []), '서재'];
    f.r.values.set(registryRecord.key, JSON.stringify(registry));
    const before = await f.r.api.getLoreLinkIndex({ force: true });
    const held = before.ambiguous.find(row => row.name === '서재');
    assert.ok(held && held.candidates.length >= 2);
    const selected = held.candidates[1];
    const confirmed = await f.r.api.setLoreLinkMapping({
      expectedScopeKey: before.scopeKey, expectedMappingRevision: before.basis.mappingsDigest,
      linkKey: held.linkKey, candidateEntityId: selected, action: 'confirm'
    });
    const confirmedLinkKey = `${held.identity}::${selected}`;
    assert.ok(plain(confirmed.confirmed).some(row => row.linkKey === confirmedLinkKey && row.entityId === selected));
    const after = await f.r.api.getLoreLinkIndex({ force: true });
    assert.equal(after.links.find(row => row.linkKey === confirmedLinkKey)?.resolution, 'confirmed');
    assert.equal(after.links.find(row => row.linkKey === confirmedLinkKey)?.entityId, selected);
    await f.r.api.setLoreLinkMapping({ linkKey: confirmedLinkKey, action: 'remove' });
    assert.equal((await f.r.api.getLoreLinkIndex({ force: true })).links.some(row => row.linkKey === confirmedLinkKey), false);
    await f.r.api.setLoreLinkMapping({ linkKey: confirmedLinkKey, action: 'restore' });
    const restoredIndex = await f.r.api.getLoreLinkIndex({ force: true });
    assert.equal(restoredIndex.links.find(row => row.linkKey === confirmedLinkKey)?.resolution, 'held_ambiguous',
      'remove clears the explicit confirmation and restore returns to held pending a fresh decision');
    const mappingRecord = f.getRecords('libra.lore_link_mapping.v1')[0];
    assert.ok(mappingRecord);
    const conflictedMapping = plain(mappingRecord.value);
    conflictedMapping.confirmed = held.candidates.map(entityId => ({ linkKey: `${held.identity}::${entityId}`, entityId }));
    conflictedMapping.mappingDigest = 'deliberately_conflicting_fixture';
    f.r.values.set(mappingRecord.key, JSON.stringify(conflictedMapping));
    const conflictIndex = await f.r.api.getLoreLinkIndex({ force: true });
    for (const entityId of held.candidates) {
      assert.equal(conflictIndex.links.find(row => row.linkKey === `${held.identity}::${entityId}`)?.resolution, 'held_ambiguous',
        `conflicting legacy confirmations fail closed instead of enabling two paths: ${JSON.stringify({confirmed:conflictedMapping.confirmed,rows:conflictIndex.links.filter(row=>row.identity===held.identity),candidates:held.candidates})}`);
    }
    await f.r.api.setLoreLinkMapping({ expectedScopeKey: conflictIndex.scopeKey,
      expectedMappingRevision: conflictIndex.basis.mappingsDigest, linkKey: held.linkKey,
      candidateEntityId: held.candidates[0], action: 'confirm' });
    const repairedIndex = await f.r.api.getLoreLinkIndex({ force: true });
    assert.equal(repairedIndex.links.find(row => row.linkKey === `${held.identity}::${held.candidates[0]}`)?.resolution, 'confirmed');
    assert.equal(repairedIndex.links.find(row => row.linkKey === `${held.identity}::${held.candidates[1]}`)?.resolution, 'held_ambiguous');
  });

  await test('ambiguity is held with its candidates instead of picking one', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const index = await f.r.api.getLoreLinkIndex({});
    for (const row of index.ambiguous) {
      assert.ok(Array.isArray(row.candidates) && row.candidates.length >= 2,
        'an ambiguous mention names the candidates it could belong to');
      assert.ok(row.linkKey && row.entityId);
    }
    for (const link of index.links) {
      if (link.resolution !== 'held_ambiguous') continue;
      assert.ok(index.ambiguous.find(row => row.linkKey === link.linkKey), 'a held link appears in the ambiguous list');
    }
  });

  await test('the index is scope-checked like the other readers', async f => {
    await f.run();
    await assert.rejects(() => f.r.api.getLoreLinkIndex({ expectedScopeKey: 'not-this-scope' }),
      /CANONICAL_READER_SCOPE_CHANGED/);
  });

  console.log(JSON.stringify({ suite: 'libra_lore_link_index', passed: results.length, tests: results }, null, 1));
  console.log('libra_lore_link_index_test: PASS');
})().catch(error => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
