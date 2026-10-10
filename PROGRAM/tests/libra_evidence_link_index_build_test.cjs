'use strict';
// Stage 1 evidence link index: the index is a projection of committed canonical facts,
// the scope entity registry and the read-only Current State Head.
// It must contain every typed edge that the canonical facts actually declared, and no edge
// that was inferred (no clique, no transitivity, no dependsOn-as-causality).
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const results = [];
const enabled = options => fixture({ ...options, args: { evidence_link_index_enabled: 'true', ...options?.args } });
async function test(name, fn) { const f = await enabled(); try { await fn(f); results.push(name); } finally { await f.r.cleanup(); } }
// Values returned from the plugin VM carry that realm's prototypes; compare plain data.
const plain = value => JSON.parse(JSON.stringify(value));
const byName = (index, name) => index.entities.find(entity => entity.name === name);
const pairs = (index, from, via) => index.links.entityPairs.filter(pair => pair.from === from && pair.via === via);

(async () => {
  await test('index projects every declared reference as one typed edge', async f => {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const callsBefore = f.control.calls.length;

    const index = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(index.schema, 'libra.evidence_link_index.v1');
    assert.equal(f.control.calls.length, callsBefore, 'building the index must not call a provider');

    // Registered entities only: the ten the fixture's current facts reference.
    assert.equal(index.entities.length, 10, JSON.stringify(index.entities.map(e => e.name)));
    assert.equal(index.facts.length, 13);
    assert.equal(index.memories.length, 1);
    for (const entity of index.entities) assert.match(entity.id, /^ce_(person|world)_[0-9a-f]{8}$/);

    const mina = byName(index, '민아'), jiho = byName(index, '지호'), junho = byName(index, '준호');
    const lib = byName(index, '도서관'), study = byName(index, '서재'), hall = byName(index, '공연실');
    const org = byName(index, '기록회'), key = byName(index, '은빛 열쇠');

    // A location chain and a rule with its exception condition coexist as separate edges.
    assert.deepEqual(plain(pairs(index, study.id, 'containment').map(p => [p.to, p.field])), [[lib.id, 'parentRef']]);
    assert.deepEqual(plain(pairs(index, hall.id, 'containment').map(p => [p.to, p.field])), [[lib.id, 'parentRef']]);
    assert.deepEqual(plain(pairs(index, lib.id, 'management').map(p => [p.to, p.field])), [[org.id, 'managerRef']]);
    const ruleEdges = pairs(index, lib.id, 'rule').map(p => [p.to, p.field]).sort();
    assert.deepEqual(plain(ruleEdges), [[hall.id, 'locationTempRef'], [lib.id, 'scopeTempRef']].sort(),
      'the rule scope and its exception location are both kept, qualified by field');
    assert.deepEqual(plain(pairs(index, mina.id, 'location').map(p => [p.to, p.field])), [[study.id, 'locationRef']]);

    // Ownership and possession are different relations on the same object and must not merge.
    assert.deepEqual(plain(pairs(index, key.id, 'ownership').map(p => [p.to, p.field])), [[mina.id, 'ownerRef']]);
    const holders = pairs(index, key.id, 'possession').map(p => [p.to, p.field, p.revision]).sort();
    assert.deepEqual(plain(holders), [[jiho.id, 'holderRef', 1], [junho.id, 'holderRef', 1], [mina.id, 'holderRef', 1]].sort(),
      'every historical holder edge is preserved, not collapsed to the latest');

    // relationship carries its dimension instead of the bare value field.
    assert.deepEqual(plain(pairs(index, mina.id, 'relationship').map(p => [p.to, p.field])), [[jiho.id, 'trust']]);

    // Forbidden inferences stay absent.
    assert.equal(index.links.entityPairs.some(pair => pair.via === 'dependsOn'), false);
    assert.equal(index.links.entityPairs.some(pair => [jiho.id, junho.id].includes(pair.from) && [jiho.id, junho.id].includes(pair.to)),
      false, 'two people who both held an object must not become an edge to each other');
    assert.equal(index.links.entityPairs.some(pair => pair.to === mina.id && pair.from === mina.id), false, 'no self edge');

    for (const fact of index.facts) {
      assert.equal(fact.factKey, `${fact.memoryKey}:${fact.factId}`, 'the fact key stays anchored to its memory');
      assert.ok(fact.factKey.endsWith(`:${fact.factId}`), 'the original fact identifier is preserved');
      assert.ok(fact.evidenceRefs.length > 0, 'every fact keeps its evidence spans');
      assert.equal(Object.prototype.hasOwnProperty.call(fact, 'text'), false, 'canonical bodies are not copied');
    }
    assert.equal(new Set(plain(index.facts).map(fact => fact.factKey)).size, 13, 'fact keys are unique');

    // entityFacts and factMemory are consistent inverses of the fact list.
    for (const fact of index.facts) assert.equal(index.links.factMemory[fact.factKey], fact.memoryKey);
    for (const [entityId, factKeys] of Object.entries(plain(index.links.entityFacts))) {
      assert.ok(index.entities.some(entity => entity.id === entityId), `${entityId} must be a registered entity`);
      for (const factKey of factKeys) assert.ok(index.links.factMemory[factKey], `${factKey} must resolve to a memory`);
    }
    assert.equal(index.history.factKeys.length, 13);
    assert.deepEqual(plain(index.history.factKeys).sort(), plain(index.facts).map(fact => fact.factKey).sort());
    assert.ok(Array.isArray(index.history.supersededFactKeys));

    // The current view quotes the Head; history stays in the fact projection.
    assert.equal(index.current.fields.filter(field => field.entityId === key.id && field.field === 'ownerRef').length, 1);
    const holderFields = index.current.fields.filter(field => field.entityId === key.id && field.field === 'holderRef');
    assert.equal(holderFields.length, 1);
    assert.equal(holderFields[0].value, mina.id, 'the current holder is the last committed change, not the first');
    assert.deepEqual(plain(holderFields[0].assertionIds), ['f11']);
    assert.equal(index.current.threads.length, 1);
    assert.equal(index.current.threads[0].entityId, byName(index, '공연 허가').id);
    assert.equal(index.current.threads[0].status, 'open');
    assert.equal(index.status.complete, true, JSON.stringify(index.status));
    assert.equal(index.status.providerCalls, 0);
    assert.equal(index.status.llmCalls, 0);
  });

  await test('diagnostics are published without exposing the payload', async f => {
    await f.run();
    const index = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(index.status.providerCalls, 0);
    const diagnostics = f.r.api.getRuntime?.().lastEvidenceLinkIndexDiagnostics;
    assert.ok(diagnostics, 'the runtime diagnostics surface must be populated after a build');
    assert.equal(diagnostics.schema, 'libra.evidence_link_index.v1');
    assert.equal(diagnostics.entities, 10);
    assert.equal(diagnostics.facts, 13);
    assert.equal(diagnostics.providerCalls, 0);
    assert.equal(diagnostics.llmCalls, 0);
    assert.equal(diagnostics.complete, true);
  });

  console.log(JSON.stringify({ suite: 'libra_evidence_link_index_build', passed: results.length, tests: results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
