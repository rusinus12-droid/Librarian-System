'use strict';
// Synthetic normalized adapter inputs, not a registered retrieval/dispatch fixture.
const crypto = require('node:crypto');
const createIdentity = require('../../tools/libra_memory_graph_identity.cjs');
const fingerprint = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const frame = { owner: 'libra:fixture', scopeKey: 'chat:network', worldlineId: 'main', restoreEpoch: 7,
  view: { viewerId: 'main_request', asOf: 6 } };
const bound = (key, body, revision = 1, overrides = {}) => ({ ...clone(frame), revision,
  locator: { recordKey: key }, body: clone(body), ...overrides });
const stable = uuid => ({ kind: 'stable', ownerNamespace: 'libra', originScope: 'chat:network',
  objectUUID: uuid, birthIncarnation: 'owner-attested-fixture-birth' });
const legacy = (key, body, revision = 1, recordKind = 'fixture', restoreEpoch = 7) => ({
  kind: 'revision_bound', ownerNamespace: 'libra', originScope: 'chat:network', recordKind,
  recordKey: key, revision, restoreEpoch, snapshot: clone(body) });

function fixture() {
  const kernel = createIdentity({ fingerprint });
  const text = '민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
  const records = {
    canonical: { schema: 'libra.canonical_memory.v1', memoryId: 'canonical-1-5', revision: 1,
      turnRange: { start: 1, end: 5 }, canonicalArtifact: { schema: 'libra.canonical_artifact.v4',
        facts: [{ tempFactId: 'f-owner', domain: 'world', subjectTempRef: 'key', claimKind: 'ownership',
          values: { ownerRef: 'mina' }, text: '은빛 열쇠의 소유자는 민아다.', temporalRole: 'current_sequence',
          certainty: 'confirmed', evidenceSpans: [{ ref: 't2-a', quote: '은빛 열쇠의 소유자는 민아다.' }] }] } },
    micro: { schema: 'libra.micro_network_evidence.v1', scopeKey: frame.scopeKey, worldlineId: 'main',
      sessionEpoch: 0, turn: 6, receiptKey: 'receipt:t6:r1', sourceRevisionId: 'receipt-r1',
      sourceDigest: 'synthetic-receipt-digest', analysisRevisionId: 'analysis-r1', analysisStatus: 'verified',
      claims: [{ text, temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
        evidence: { role: 'assistant', messageId: 't6-a', startOffset: 0, endOffset: text.length, exactQuote: text } }] },
    state: { schema: 'libra.continuity_state.v2', status: 'ready', throughTurn: 6,
      world: [{ id: 'ce_world_key', state: { ownerRef: 'ce_person_mina', holderRef: 'ce_person_junho' },
        fieldEvidence: { ownerRef: { schema: 'libra.state_field_evidence.v1', memoryId: 'canonical-1-5', revision: 1,
          correctionId: 'correction-owner-6' }, holderRef: { schema: 'libra.micro_state_field_evidence.v1',
          receiptKey: 'receipt:t6:r1', sourceRevisionId: 'receipt-r1', analysisRevisionId: 'analysis-r1',
          role: 'assistant', messageId: 't6-a', startOffset: 0, endOffset: text.length, exactQuote: text, turn: 6 } } }] },
    correction: { schema: 'libra.state_correction.v1', correctionId: 'correction-owner-6',
      patches: [{ domain: 'world', targetId: 'ce_world_key', field: 'ownerRef', operation: 'set', value: 'ce_person_mina' }] },
    lore: { id: 'lore-key', sourceType: 'character', moduleKey: '', source: 'character', label: '열쇠 사용 규칙',
      content: '은빛 열쇠는 소유자 민아가 허락한 경우에만 사용할 수 있다.', alwaysActive: true }
  };
  const nodes = [], edges = [], sources = {}, meaning = {}, entities = {};
  const keep = value => { nodes.push(value); return value; };
  // Current reader records do not attest object birth incarnations. Keep all these sources partial.
  for (const [name, body] of Object.entries(records)) sources[name] = keep(kernel.source({
    identity: legacy(name, body, 1, body.schema || 'native_lore'), binding: bound(name, body) }));
  for (const [name, entityId] of [['mina', 'ce_person_mina'], ['junho', 'ce_person_junho'], ['key', 'ce_world_key']]) {
    const body = { id: entityId, name: name === 'mina' ? '민아' : name === 'junho' ? '준호' : '은빛 열쇠' };
    entities[name] = keep(kernel.entity({ identity: legacy('registry:' + entityId, body), binding: bound('registry:' + entityId, body) }));
  }
  const addMeaning = (name, family, kind, body, anchor) => meaning[name] = keep(kernel.meaning({
    source: sources[family], kind, identity: legacy(name, body), anchor, binding: bound(name, body) }));
  const fact = records.canonical.canonicalArtifact.facts[0];
  addMeaning('ownerFact', 'canonical', 'canonical_fact', fact, { factIndex: 0, typedMeaning: fact });
  addMeaning('transfer', 'micro', 'micro_claim', records.micro.claims[0], { claimIndex: 0, evidence: records.micro.claims[0].evidence });
  const world = records.state.world[0];
  for (const [name, field] of [['ownerState', 'ownerRef'], ['holderState', 'holderRef']]) addMeaning(name, 'state', 'state_field',
    { value: world.state[field], fieldEvidence: world.fieldEvidence[field] }, { domain: 'world', entityId: world.id, field });
  const passage = { locatorVersion: 'lore_reference_locator.v1', coordinateSpace: 'rendered',
    renderedHash: fingerprint(records.lore.content), rawHash: '', rawOffsetAvailable: false,
    rawOffsetUnavailableReason: 'cbs_rendered_text_only', start: 0, end: records.lore.content.length, excerpt: records.lore.content };
  addMeaning('rule', 'lore', 'lore_passage', passage, { passage, renderedBody: records.lore.content });
  const reason = (family, kind, body, anchor = {}) => kernel.basis({ source: sources[family], kind,
    identity: legacy('basis:' + family + ':' + kind, body), anchor, binding: bound('basis:' + family + ':' + kind, body) });
  const reasons = {
    canonical: reason('canonical', 'canonical_claim', fact, { factIndex: 0 }),
    micro: reason('micro', 'micro_span', records.micro.claims[0].evidence, { receiptKey: records.micro.receiptKey,
      sourceRevisionId: records.micro.sourceRevisionId, analysisRevisionId: records.micro.analysisRevisionId }),
    state: reason('state', 'state_field_evidence', world.fieldEvidence, { entityId: world.id }),
    correction: reason('correction', 'state_correction', records.correction, { correctionId: records.correction.correctionId }),
    lore: reason('lore', 'lore_passage', passage, { renderedBody: records.lore.content })
  };
  const connect = (from, to, predicate, basis, qualifier = {}) => {
    // Unknown source validity remains null; a query's asOf must not become an edge fact.
    const value = kernel.edge({ from, to, predicate, basis, qualifier, validTime: null,
      binding: bound('edge', { from: from.id, to: to.id, predicate, qualifier }) });
    edges.push(value); return value;
  };
  connect(meaning.ownerFact, sources.canonical, 'evidenced_by', reasons.canonical);
  connect(meaning.ownerFact, entities.key, 'subject_of', reasons.canonical);
  connect(meaning.ownerFact, entities.mina, 'target_of', reasons.canonical);
  connect(meaning.ownerFact, entities.mina, 'mentions', reasons.canonical);
  connect(meaning.transfer, sources.micro, 'evidenced_by', reasons.micro);
  connect(meaning.transfer, entities.key, 'subject_of', reasons.micro);
  connect(meaning.transfer, entities.junho, 'target_of', reasons.micro);
  connect(meaning.ownerState, meaning.ownerFact, 'derived_from', reasons.state, { field: 'ownerRef' });
  connect(meaning.ownerState, sources.correction, 'evidenced_by', reasons.correction, { field: 'ownerRef', role: 'user_corrected' });
  connect(meaning.holderState, meaning.transfer, 'derived_from', reasons.state, { field: 'holderRef' });
  for (const [node, target, field] of [[meaning.ownerState, entities.mina, 'ownerRef'], [meaning.holderState, entities.junho, 'holderRef']]) {
    connect(node, sources.state, 'evidenced_by', reasons.state, { field });
    connect(node, entities.key, 'subject_of', reasons.state, { field });
    connect(node, target, 'target_of', reasons.state, { field });
  }
  connect(meaning.rule, sources.lore, 'evidenced_by', reasons.lore);
  connect(meaning.rule, entities.key, 'applies_to', reasons.lore);
  connect(meaning.rule, entities.mina, 'mentions', reasons.lore);
  return { kernel, records, nodes, edges, sources, entities, meaning, reasons, passage, connect,
    scope: 'normalized_projection_only', retrievalImplemented: false, physicalProofVerified: false };
}
module.exports = { fixture, fingerprint, frame, bound, stable, legacy, clone };
