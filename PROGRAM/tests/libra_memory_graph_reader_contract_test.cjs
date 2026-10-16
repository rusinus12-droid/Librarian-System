'use strict';
const assert = require('node:assert/strict');
const createIdentity = require('../tools/libra_memory_graph_identity.cjs');
const createReaders = require('../tools/libra_memory_graph_readers.cjs');
const { fixture: identityFixture, frame, fingerprint, clone } = require('./fixtures/libra_memory_graph_identity_fixture.cjs');
const results = [];
const test = (name, run) => { run(); results.push(name); };

function snapshot() {
  const records = clone(identityFixture().records), scope = frame.scopeKey;
  records.canonical.sourceDigest = 'canonical-source'; records.canonical.scopeKey = scope;
  const fact = records.canonical.canonicalArtifact.facts[0];
  records.micro.schema = 'libra.micro_memory.v1';
  const receipt = { scopeKey: scope, worldlineId: 'main', sessionEpoch: 0, turn: 6,
    revisionId: records.micro.sourceRevisionId, sourceDigest: records.micro.sourceDigest,
    assistant: { chatId: 't6-a', text: records.micro.claims[0].evidence.exactQuote } };
  const head = { schema: 'libra.micro_memory_head.v1', scopeKey: scope, worldlineId: 'main', sessionEpoch: 0, turn: 6,
    recordKey: 'micro', sourceRevisionId: records.micro.sourceRevisionId, sourceDigest: records.micro.sourceDigest,
    analysisRevisionId: records.micro.analysisRevisionId, analysisStatus: records.micro.analysisStatus };
  records.state.scopeKey = scope;
  records.state.world[0].fieldEvidence.ownerRef = { memoryId: records.canonical.memoryId, revision: 1,
    sourceDigest: records.canonical.sourceDigest, assertionIds: [fact.tempFactId] };
  const rendered = records.lore.content;
  const passage = { coordinateSpace: 'rendered', start: 0, end: rendered.length, excerpt: 'shortened excerpt',
    rawOffsetAvailable: false, rawOffsetUnavailableReason: 'cbs_rendered_text_only' };
  return {
    frame: clone(frame), registry: { key: 'registry', record: { schema: 'libra.entity_registry.v2', scopeKey: scope, fingerprint: 'registry-1',
      entities: [{ id: 'ce_person_mina', name: '민아', validated: true }, { id: 'ce_person_junho', name: '준호', validated: true },
        { id: 'ce_world_key', name: '은빛 열쇠', validated: true }] } },
    canonical: [{ key: 'canonical', ref: { memoryId: records.canonical.memoryId, revision: 1, sourceDigest: records.canonical.sourceDigest },
      record: records.canonical, entityRefs: { key: 'ce_world_key', mina: 'ce_person_mina' } }],
    claimContracts: { ownership: { domain: 'world', field: 'ownerRef', value: 'ownerRef' } },
    micro: [{ status: 'verified', recordKey: 'micro', receiptKey: records.micro.receiptKey, headKey: 'micro-head', head, receipt, record: records.micro }],
    state: { key: 'state', revision: 1, view: { head: records.state, authority: { current: true, pending: false } },
      correctionKey: 'corrections', corrections: { records: [] } },
    lore: { revision: 1, selectionBinding: {}, entries: [{ identity: 'lore-key', entry: records.lore, rendered,
      activation: { alwaysActive: true, hostSelected: null }, passages: [passage] }],
      index: { entries: [{ identity: 'lore-key', passages: [{ ...passage, mentions: [{ entityId: 'ce_person_mina' }] }] }],
        links: [{ identity: 'lore-key', entityId: 'ce_person_mina', via: 'name_reference', resolution: 'reference' }] } },
    inventory: { scope: 'synthetic_contract_page', inventoryComplete: false }, pending: {}
  };
}
const digestClaim = claim => fingerprint(JSON.stringify(claim));
const project = (value, options) => createReaders({ identity: createIdentity({ fingerprint }), digestClaim }).project(value, options);

test('real reader schema shapes preserve a nonempty four-family graph and recorded field derivation', () => {
  const graph = project(snapshot());
  for (const family of ['canonical', 'micro', 'state', 'lore']) assert.ok(graph.coverage.families[family].units > 0);
  const owner = graph.units.find(unit => unit.family === 'state' && unit.field === 'ownerRef');
  assert.ok(graph.edges.some(edge => edge.from === owner.nodeId && edge.predicate === 'derived_from'));
  assert.equal(graph.modelDispatchEligible, false);
});
test('duplicate canonical claim IDs do not become unique graph claims', () => {
  const value = snapshot(), fact = value.canonical[0].record.canonicalArtifact.facts[0];
  value.canonical[0].record.canonicalArtifact.facts.push(clone(fact));
  const graph = project(value);
  assert.equal(graph.coverage.families.canonical.units, 0);
  assert.ok(graph.coverage.families.canonical.reasons.includes('claim_schema_or_identity_ambiguous'));
});
test('legacy canonical schemas remain source-only excerpts with a record-coordinate basis', () => {
  const value = snapshot(); value.canonical[0].record.canonicalArtifact.schema = 'legacy'; value.canonical[0].record.text = 'legacy original';
  const graph = project(value), unit = graph.units.find(unit => unit.family === 'canonical');
  assert.equal(unit.authority, 'source_only'); assert.equal(unit.semanticRole, 'canonical_legacy_excerpt');
  assert.ok(graph.edges.some(edge => edge.from === unit.nodeId && edge.predicate === 'evidenced_by'
    && graph.bases.some(basis => basis.id === edge.basisId && basis.kind === 'source_excerpt')));
});
test('bad Micro quote, receipt revision or head binding never creates a Micro claim', () => {
  for (const mutate of [value => value.micro[0].record.claims[0].evidence.exactQuote = 'wrong',
    value => value.micro[0].receipt.revisionId = 'other', value => value.micro[0].head.scopeKey = 'other']) {
    const value = snapshot(); mutate(value); const graph = project(value);
    assert.equal(graph.coverage.families.micro.units, 0); assert.ok(graph.coverage.families.micro.reasons.length);
  }
});
test('minimum-source-bound Micro preserves its excerpt and cannot import supplied claims', () => {
  const value = snapshot(), row = value.micro[0], excerpt = clone(row.record.claims[0].evidence);
  row.record.analysisStatus = row.head.analysisStatus = 'minimum_source_bound'; row.record.claims = []; row.record.excerpt = excerpt;
  const graph = project(value), unit = graph.units.find(unit => unit.family === 'micro');
  assert.equal(unit.authority, 'source_only'); assert.equal(unit.text, excerpt.exactQuote);
  row.record.claims.push({ evidence: excerpt }); assert.equal(project(value).coverage.families.micro.units, 0);
});
test('missing State values stay missing, and present values without provenance stay unprovenanced', () => {
  const value = snapshot(), row = value.state.view.head.world[0];
  row.state.condition = 'unknown source';
  const graph = project(value), field = graph.units.find(unit => unit.family === 'state' && unit.field === 'condition');
  assert.equal(field.provenanceStatus, 'unknown'); assert.equal(field.semanticRole, 'state_unprovenanced');
  assert.equal(graph.edges.some(edge => edge.from === field.nodeId), false);
  delete row.state.condition;
  assert.equal(project(value).units.some(unit => unit.family === 'state' && unit.field === 'condition'), false);
});
test('a State pointer to another canonical revision does not create a derived edge', () => {
  const value = snapshot(); value.state.view.head.world[0].fieldEvidence.ownerRef.revision = 99;
  const graph = project(value), field = graph.units.find(unit => unit.family === 'state' && unit.field === 'ownerRef');
  assert.equal(graph.edges.some(edge => edge.from === field.nodeId && edge.predicate === 'derived_from'), false);
});
test('State Micro derivation selects the exact claim digest and refuses repeated or source-only occurrences', () => {
  const value = snapshot(), record = value.micro[0].record, claim = record.claims[0], row = value.state.view.head.world[0];
  record.claims.push({ ...clone(claim), text: 'another claim with the same source quote' });
  row.fieldEvidence.holderRef = { schema: 'libra.micro_state_field_evidence.v1', status: 'state_admitted',
    receiptKey: record.receiptKey, sourceRevisionId: record.sourceRevisionId, sourceDigest: record.sourceDigest,
    analysisRevisionId: record.analysisRevisionId, claimDigest: digestClaim(claim), ...clone(claim.evidence) };
  const derived = input => {
    const graph = project(input), field = graph.units.find(unit => unit.family === 'state' && unit.field === 'holderRef');
    return graph.edges.filter(edge => edge.from === field.nodeId && edge.predicate === 'derived_from')
      .map(edge => graph.units.find(unit => unit.nodeId === edge.to));
  };
  assert.equal(derived(value).length, 1); assert.equal(derived(value)[0].text, claim.text);
  const wrong = clone(value); wrong.state.view.head.world[0].fieldEvidence.holderRef.sourceDigest = 'other';
  assert.equal(derived(wrong).length, 0);
  const ambiguous = clone(value); ambiguous.micro[0].record.claims.push(clone(claim));
  assert.equal(derived(ambiguous).length, 0);
  record.analysisStatus = value.micro[0].head.analysisStatus = 'minimum_source_bound';
  record.excerpt = clone(claim.evidence); record.claims = [];
  assert.equal(derived(value).length, 0);
});
test('rendered lore text comes from its exact window, independently of abbreviated locator excerpts', () => {
  const value = snapshot(), graph = project(value), unit = graph.units.find(unit => unit.family === 'lore');
  assert.equal(unit.text, value.lore.entries[0].rendered); assert.notEqual(unit.text, unit.locator.excerpt);
  assert.equal(unit.representationCoverage.rawOffsetAvailable, false);
  value.lore.entries[0].passages[0].coordinateSpace = 'raw'; assert.equal(project(value).coverage.families.lore.units, 0);
});
test('removed, ambiguous and conflicting lore confirmations never acquire entity edges', () => {
  for (const links of [[], [{ identity: 'lore-key', entityId: 'ce_person_mina', via: 'name_reference', resolution: 'held_ambiguous' }]]) {
    const value = snapshot(); value.lore.index.links = links; value.lore.index.entries[0].passages[0].mentions[0].ambiguous = true;
    value.lore.index.entries[0].passages[0].mentions[0].confirmed = true;
    const graph = project(value), unit = graph.units.find(unit => unit.family === 'lore');
    assert.equal(graph.edges.some(edge => edge.from === unit.nodeId && edge.predicate === 'mentions'), false);
  }
});
test('cross-scope registry or State input rejects and count budget never claims byte boundedness', () => {
  for (const mutate of [value => value.registry.record.scopeKey = 'other', value => value.state.view.head.scopeKey = 'other']) {
    const value = snapshot(); mutate(value); assert.throws(() => project(value), /SCOPE_INVALID/);
  }
  const graph = project(snapshot(), { nodeLimit: 3 }); assert.ok(graph.nodes.length <= 3);
  assert.equal(graph.byteBounded, false); assert.equal(graph.coverage.projectionComplete, false);
});
console.log(JSON.stringify({ suite: 'libra_memory_graph_reader_contract', passed: results.length, tests: results,
  scope: 'synthetic_json_owner_reader_schema_contract', physicalProofVerified: false }));
