'use strict';
// Stage 1 keeps history and the current view apart.
// History is built from canonical facts, so a repeated no-op commit must not move the Head's
// evidence pointer, a real change must repoint it, and an unresolvable identity must stay
// pending instead of being merged, guessed or propagated.
const assert = require('node:assert/strict');
const { fixture, advance, addFact, patchRecord, holderField, entityNamed } = require('./fixtures/libra_evidence_link_index_fixture.cjs');

const results = [];
const plain = value => JSON.parse(JSON.stringify(value));
const enabled = () => fixture({ args: { evidence_link_index_enabled: 'true' } });
async function test(name, fn) { const f = await enabled(); try { await fn(f); results.push(name); } finally { await f.r.cleanup(); } }
async function complete(f) { const result = await f.run(); assert.equal(result.completed, 1, JSON.stringify(result).slice(0, 600)); return result; }

(async () => {
  await test('a repeated no-op commit does not move the Head evidence pointer', async f => {
    await complete(f);
    const first = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(first.memories.length, 1);
    assert.deepEqual(plain(holderField(first).assertionIds), ['f11']);

    advance(f, 5);
    await complete(f);
    const second = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(second.memories.length, 2, 'the second batch is committed as its own memory');
    assert.equal(second.facts.length, 26, 'both memories are indexed as history');

    const holder = holderField(second);
    assert.equal(holder.memoryId, 'mem_000001', 'an unchanged value keeps the commit that actually changed it');
    assert.deepEqual(plain(holder.assertionIds), ['f11']);
    assert.deepEqual(plain(holder.evidenceRefs), ['t5-a']);
    assert.equal(holder.value, entityNamed(second, '민아').id);

    // History still holds every observation, including the re-observed one.
    const possessionKeys = second.links.entityPairs.filter(pair => pair.via === 'possession').map(pair => pair.memoryKey);
    assert.equal(possessionKeys.length, 6, 'both batches keep their own possession edges');
    assert.equal(new Set(possessionKeys).size, 2);
  });

  await test('a real value change repoints the Head and keeps the old value as history', async f => {
    await complete(f);
    advance(f, 5);
    await complete(f);
    const before = await f.r.api.getEvidenceLinkIndex({});
    const mina = entityNamed(before, '민아').id, jiho = entityNamed(before, '지호').id;
    assert.equal(holderField(before).value, mina);

    advance(f, 10);
    for (const fact of f.control.artifact.facts) if (fact.claimKind === 'possession') fact.values.holderRef = 'jiho';
    await complete(f);

    const after = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(after.memories.length, 3);
    const holder = holderField(after);
    assert.equal(holder.value, jiho, 'the current holder follows the newest real change');
    assert.equal(holder.memoryId, 'mem_000011', 'the current holder cites the newest batch (turns 11-15)');
    assert.deepEqual(plain(holder.assertionIds), ['f11']);
    assert.deepEqual(plain(holder.evidenceRefs), ['t15-a']);
    assert.equal(holder.temporalRole, 'current_sequence');

    // Both the historical holder and the current one remain as typed edges.
    const holders = after.links.entityPairs.filter(pair => pair.via === 'possession').map(pair => pair.to);
    assert.ok(holders.includes(mina), 'the previous holder stays in history');
    assert.ok(holders.includes(jiho), 'the new holder is recorded');
    // A superseded historical fact is never promoted into the current view.
    assert.equal(after.current.fields.some(field => field.entityId === holder.entityId && field.field === 'holderRef' && field.value === mina), false);
  });

  await test('a same-name second person is held pending, not merged or propagated', async f => {
    await complete(f);
    const baseline = await f.r.api.getEvidenceLinkIndex({});
    const key = entityNamed(baseline, '은빛 열쇠');
    assert.ok(baseline.links.entityPairs.some(pair => pair.from === key.id && pair.via === 'ownership'));

    // A second registry row claiming the same name and type makes the resolution ambiguous.
    patchRecord(f, 'libra.entity_registry.v2', {
      entities: [...f.getRecords('libra.entity_registry.v2')[0].value.entities,
        { id: 'ce_person_deadbeef', type: 'person', kind: 'person', name: '민아', aliases: [], validated: true, admission: 'integrated_evidence_checked', evidenceRefs: [], assertionIds: [] }]
    });

    // Not forced: the new registry row must invalidate the stored view on its own.
    const index = await f.r.api.getEvidenceLinkIndex({});
    const pending = plain(index.unresolved).filter(item => item.entity === 'mina');
    assert.deepEqual(pending, [{ entity: 'mina', reason: 'ambiguous_identity', memoryKey: index.memories[0].memoryKey }],
      'the ambiguous identity must be reported, not silently chosen');

    assert.equal(entityNamed(index, '민아'), null, 'an ambiguous identity is not registered');
    assert.equal(index.entities.some(entity => entity.id === 'ce_person_deadbeef'), false, 'the new row is not adopted');
    // No edge may be propagated from the ambiguity: the owner edge to 민아 is simply absent.
    assert.equal(index.links.entityPairs.some(pair => pair.to === 'ce_person_deadbeef'), false);
    assert.equal(index.links.entityPairs.some(pair => pair.from === key.id && pair.via === 'ownership'), false,
      'an unresolved subject reference must not become an edge');
    assert.equal(index.status.partial, false, 'a pending identity is reported separately from a partial index');
  });

  await test('a retired name reuses no previous mapping', async f => {
    await complete(f);
    const baseline = await f.r.api.getEvidenceLinkIndex({});
    const minaId = entityNamed(baseline, '민아').id;
    assert.equal(baseline.status.persisted, true, 'the pre-split view is stored');

    // This is the registry state the split flow leaves behind. The read below is deliberately
    // NOT forced: a retired name must invalidate the stored view by itself, or the split would
    // keep resolving from the previous mapping until something else happened to change.
    patchRecord(f, 'libra.entity_registry.v2', { splitRetiredNames: ['민아'] });
    const index = await f.r.api.getEvidenceLinkIndex({});

    assert.deepEqual(plain(index.unresolved).filter(item => item.entity === 'mina'),
      [{ entity: 'mina', reason: 'split_identity_requires_disambiguation', memoryKey: index.memories[0].memoryKey }]);
    assert.notEqual(index.signature, baseline.signature, 'the retired name changes the signature');
    assert.equal(index.entities.some(entity => entity.id === minaId), false, 'the retired mapping is not reused');
    assert.equal(index.entities.length, 9, 'only the retired identity drops out');
    assert.equal(index.links.entityPairs.some(pair => pair.to === minaId), false, 'no edge may point at the retired id');
  });

  await test('a resolved thread stays history while an open thread is current', async f => {
    await complete(f);
    const index = await f.r.api.getEvidenceLinkIndex({});
    const open = entityNamed(index, '공연 허가'), resolved = entityNamed(index, '약속');
    assert.ok(open && resolved);

    assert.deepEqual(plain(index.current.threads.map(thread => thread.entityId)), [open.id]);
    assert.equal(index.current.threads[0].status, 'open');
    // Both threads stay indexed as facts; only the unresolved one is the current view.
    const resolvedFacts = index.facts.filter(fact => fact.subjectId === resolved.id);
    const openFacts = index.facts.filter(fact => fact.subjectId === open.id);
    assert.deepEqual(plain(resolvedFacts).map(fact => fact.values.thread.status), ['resolved']);
    assert.deepEqual(plain(openFacts).map(fact => fact.values.thread.status), ['open']);
    assert.equal(index.current.threads.some(thread => thread.entityId === resolved.id), false,
      'a resolved thread must not appear as the current narrative state');
    // The thread node keeps its own summary and status instead of having participants inferred.
    assert.equal(plain(resolvedFacts[0].values).thread.summary, '오늘 열쇠 반환 약속');
    assert.equal(resolvedFacts[0].dimension, '');
  });

  await test('a correction fact keeps its own evidence instead of inheriting the original', async f => {
    await complete(f);
    advance(f, 5);
    addFact(f, 5, {
      tempFactId: 'f200', domain: 'world', subjectTempRef: 'key', claimKind: 'ownership',
      values: { ownerRef: 'jiho' }, text: '열쇠의 소유자는 지호로 정정되었다.',
      typedValueField: 'ownerRef', stateField: 'ownerRef'
    });
    await complete(f);

    const index = await f.r.api.getEvidenceLinkIndex({});
    const jiho = entityNamed(index, '지호').id;
    const owner = index.current.fields.find(field => field.entityId === entityNamed(index, '은빛 열쇠').id && field.field === 'ownerRef');
    assert.equal(owner.memoryId, 'mem_000006', 'the correction is the commit that changed the value');
    assert.deepEqual(plain(owner.assertionIds), ['f200']);
    assert.deepEqual(plain(owner.evidenceRefs), ['t10-a']);
    assert.equal(owner.value, jiho);
    // The original ownership observation remains as history and is not overwritten by the
    // correction: edges to both owners are present, in their own memories.
    const mina = entityNamed(index, '민아').id;
    const ownerEdges = plain(index.links.entityPairs.filter(pair => pair.via === 'ownership'));
    assert.ok(ownerEdges.some(pair => pair.to === mina), 'the original owner edge stays in history');
    assert.deepEqual([...new Set(ownerEdges.filter(pair => pair.to === jiho).map(pair => pair.memoryKey))],
      [index.memories.find(memory => memory.memoryId === 'mem_000006').memoryKey]);
    assert.equal(new Set(ownerEdges.map(pair => pair.memoryKey)).size, 2);
  });

  console.log(JSON.stringify({ suite: 'libra_evidence_link_index_revision_history', passed: results.length, tests: results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
