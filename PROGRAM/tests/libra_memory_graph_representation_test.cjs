'use strict';
// N02 representation contract: what each family would embed and who produces it, how a representation
// is identified, how a unit without a usable vector still participates, and how coverage is reported
// without hiding what is missing. Every test can fail; the negative controls break one rule each.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const resolveTool = name => {
  const candidates = [path.join(__dirname, '..', 'tools', name), path.join(__dirname, name)];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return require(candidate);
  throw new Error('Cannot resolve tool module: ' + name);
};

const createRepresentation = resolveTool('libra_memory_graph_representation.cjs');
const representation = createRepresentation({ fingerprint: text => crypto.createHash('sha256').update(String(text)).digest('hex') });
const SOURCE_FILE = path.join(__dirname, '..', 'plugins', 'LIBRA.js');

const SPACE = { spaceId: 'owner-default', provider: 'openai', model: 'text-embedding-3-small', dimension: 1536, metric: 'cosine', taskPair: 'query/document', profileDigest: 'a'.repeat(64) };
const VIEW = { worldlineId: 'main', restoreEpoch: 0, asOfTurn: 12, viewerId: 'owner_reader' };

const pick = (value, fallback) => value !== undefined ? value : fallback;
const bound = (overrides = {}) => representation.representationId({
  family: pick(overrides.family, 'canonical'),
  unitKey: pick(overrides.unitKey, 'libra:v1:scope:s:memory:m1'),
  sourceBasis: pick(overrides.sourceBasis, 'rev-1'),
  textHash: pick(overrides.textHash, 'b'.repeat(64)),
  viewpoint: { ...VIEW, ...(overrides.viewpoint || {}) },
  space: { ...SPACE, ...(overrides.space || {}) }
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('N02: each family declares its representation unit or declares that it has none', () => {
  const declared = representation.declaredUnits();
  assert.deepEqual(declared.map(unit => unit.family), [...representation.SOURCE_FAMILIES]);
  assert.equal(declared.find(unit => unit.family === 'canonical').vectorToday, true);
  assert.equal(declared.find(unit => unit.family === 'canonical').producer, 'owner_projection');
  for (const family of ['micro', 'state', 'lore']) {
    const unit = declared.find(candidate => candidate.family === family);
    assert.equal(unit.vectorToday, false, family + ' has no vector producer today and must say so');
    assert.equal(unit.unit, 'none_declared');
    assert.ok(unit.textBasis.length > 10, family + ' must name the text it would embed');
    assert.ok(unit.note.length > 10);
  }
  // The shipped semantic bridge must agree with the declaration rather than invent coverage.
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  assert.ok(source.includes("vectorlessFamilies: ['micro','state','lore']"), 'the bridge must declare the vectorless families');
});

test('N02: a representation is identified by its tuple, not by a copied vector', () => {
  const id = bound();
  assert.equal(id.schema, 'libra.representation_id.v1');
  assert.match(id.representationId, /^[a-f0-9]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(id, 'vector'), false, 'the identity must not carry vector bytes');
  assert.deepEqual(id.viewpoint, { worldlineId: 'main', restoreEpoch: 0, asOfTurn: 12, viewerId: 'owner_reader' });
  assert.equal(id.space.dimension, 1536);
  assert.equal(bound().representationId, id.representationId, 'the identity is stable for the same tuple');
  for (const change of [{ textHash: 'c'.repeat(64) }, { sourceBasis: 'rev-2' }, { viewpoint: { asOfTurn: 13 } }, { space: { dimension: 1024 } }]) {
    assert.notEqual(bound(change).representationId, id.representationId, 'a changed ' + Object.keys(change)[0] + ' must change the identity');
  }
});

test('N02: identity refuses an incomplete binding', () => {
  assert.throws(() => bound({ family: 'archive' }), error => error.reason === 'family_unsupported');
  assert.throws(() => bound({ unitKey: '   ' }), error => error.reason === 'unit_key_required');
  assert.throws(() => bound({ textHash: '' }), error => error.reason === 'text_hash_required');
  assert.throws(() => bound({ space: { dimension: undefined } }), error => error.reason === 'space_binding_incomplete');
});

test('N02: a unit is classified into valid / missing / foreign space / out of view / stale basis', () => {
  const id = bound();
  assert.deepEqual(representation.classifyRepresentation({ representation: id, space: SPACE, viewpoint: VIEW }), { status: 'valid', reason: '' });
  assert.equal(representation.classifyRepresentation({ representation: null, space: SPACE, viewpoint: VIEW }).reason, 'representation_missing');
  assert.equal(representation.classifyRepresentation({ representation: id, space: { ...SPACE, model: 'other-model' }, viewpoint: VIEW }).status, 'foreign_space');
  assert.equal(representation.classifyRepresentation({ representation: id, space: { ...SPACE, dimension: 1024 }, viewpoint: VIEW }).status, 'foreign_space');
  assert.equal(representation.classifyRepresentation({ representation: id, space: SPACE, viewpoint: { ...VIEW, asOfTurn: 5 } }).reason, 'representation_outside_temporal_view');
  assert.equal(representation.classifyRepresentation({ representation: id, space: SPACE, viewpoint: { ...VIEW, worldlineId: 'other' } }).reason, 'representation_other_worldline');
  assert.equal(representation.classifyRepresentation({ representation: id, space: SPACE, viewpoint: { ...VIEW, restoreEpoch: 3 } }).reason, 'representation_other_restore_epoch');
  assert.equal(representation.classifyAgainstBasis(id, 'rev-999').reason, 'representation_basis_changed');
  assert.equal(representation.classifyAgainstBasis(id, 'rev-1').status, 'valid');
});

test('N02: a unit without a usable vector still participates through the same kernel', () => {
  const plan = representation.planRepresentationAccess({
    family: 'micro', space: SPACE, viewpoint: VIEW,
    units: [{ unitKey: 'micro:1' }, { unitKey: 'micro:2', representation: bound({ family: 'micro', unitKey: 'micro:2' }) }]
  });
  assert.equal(plan.declaration.vectorToday, false);
  assert.deepEqual([...plan.units[0].channels], ['lexical', 'entity', 'predicate', 'graph']);
  assert.deepEqual([...plan.units[1].channels], ['lexical', 'entity', 'predicate', 'graph'], 'a vector of a family whose producer is not declared is not used');
  assert.deepEqual([...plan.channels], ['vector', 'lexical', 'entity', 'predicate', 'graph'], 'there is one channel vocabulary');
  assert.equal(plan.separateDenseRanker, false);
  assert.equal(plan.heuristicMergeLayer, false);
  // Canonical units that are valid DO take the vector channel — negative control for the branch above.
  const canonicalPlan = representation.planRepresentationAccess({
    family: 'canonical', space: SPACE, viewpoint: VIEW,
    units: [{ unitKey: 'm1', representation: bound(), currentBasis: 'rev-1' }, { unitKey: 'm2', representation: bound({ unitKey: 'm2' }), currentBasis: 'rev-9' }]
  });
  assert.deepEqual([...canonicalPlan.units[0].channels], ['vector', 'lexical', 'entity', 'predicate', 'graph']);
  assert.equal(canonicalPlan.units[1].status, 'stale_basis');
  assert.deepEqual([...canonicalPlan.units[1].channels], ['lexical', 'entity', 'predicate', 'graph']);
});

test('N02 regression: task pair and profile changes are isolated even under the same space ID', () => {
  for (const changed of [{ taskPair: 'different-query/document' }, { profileDigest: 'c'.repeat(64) }, { taskPair: undefined }, { profileDigest: undefined }]) {
    const id = bound();
    const space = { ...SPACE, ...changed };
    assert.equal(representation.classifyRepresentation({ representation: id, space, viewpoint: VIEW }).status, 'foreign_space');
    const plan = representation.planRepresentationAccess({ family: 'canonical', space, viewpoint: VIEW,
      units: [{ unitKey: 'm1', representation: id, currentBasis: 'rev-1' }] });
    assert.equal(plan.coverage.foreignSpace, 1);
    assert.equal(plan.vectorCoverageComplete, false);
    assert.equal(plan.units[0].channels.includes('vector'), false);
  }
});

test('N02 regression: viewer changes or missing viewer binding cannot receive the vector channel', () => {
  for (const viewerId of ['another_reader', undefined, '']) {
    const viewpoint = { ...VIEW, viewerId };
    const verdict = representation.classifyRepresentation({ representation: bound(), space: SPACE, viewpoint });
    assert.equal(verdict.status, 'out_of_view');
    assert.equal(verdict.reason, 'representation_other_viewer');
    const plan = representation.planRepresentationAccess({ family: 'canonical', space: SPACE, viewpoint,
      units: [{ unitKey: 'm1', representation: bound() }] });
    assert.equal(plan.units[0].channels.includes('vector'), false);
    assert.equal(plan.vectorCoverageComplete, false);
  }
  assert.equal(representation.classifyRepresentation({ representation: bound(), space: SPACE, viewpoint: VIEW }).status, 'valid');
});

test('N02: coverage adds up and is never claimed complete while anything is missing', () => {
  const plan = representation.planRepresentationAccess({
    family: 'canonical', space: SPACE, viewpoint: VIEW,
    units: [
      { unitKey: 'ok', representation: bound({ unitKey: 'ok' }) },
      { unitKey: 'none' },
      { unitKey: 'space', representation: bound({ unitKey: 'space', space: { dimension: 1024 } }) },
      { unitKey: 'past', representation: bound({ unitKey: 'past', viewpoint: { asOfTurn: 99 } }) },
      { unitKey: 'stale', representation: bound({ unitKey: 'stale' }), currentBasis: 'rev-2' }
    ]
  });
  assert.deepEqual(plan.coverage, { valid: 1, missing: 1, foreignSpace: 1, outOfView: 1, staleBasis: 1 });
  const counted = Object.values(plan.coverage).reduce((sum, value) => sum + value, 0);
  assert.equal(counted, plan.unitCount, 'coverage must add up to the unit count');
  assert.equal(plan.vectorCoverageComplete, false);
  assert.equal(plan.byteBounded, false);
  const allValid = representation.planRepresentationAccess({ family: 'canonical', space: SPACE, viewpoint: VIEW, units: [{ unitKey: 'a', representation: bound({ unitKey: 'a' }) }] });
  assert.equal(allValid.vectorCoverageComplete, true, 'negative control: a fully valid plan does report completeness');
  const empty = representation.planRepresentationAccess({ family: 'state', space: SPACE, viewpoint: VIEW, units: [] });
  assert.equal(empty.vectorCoverageComplete, false, 'an empty family is not complete coverage');
});

test('N02: the contract describes, it does not produce', () => {
  const plan = representation.planRepresentationAccess({ family: 'canonical', space: SPACE, viewpoint: VIEW, units: [{ unitKey: 'a', representation: bound({ unitKey: 'a' }) }] });
  assert.equal(plan.jobsStarted, 0, 'no embedding job may start from a plan');
  assert.equal(plan.writes, 0, 'a plan must not write');
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'libra_memory_graph_representation.cjs'), 'utf8');
  for (const forbidden of ['embedTexts(', 'setJson(', 'storage.', 'queueMicrotask']) {
    assert.equal(source.includes(forbidden), false, 'the contract must not contain ' + forbidden);
  }
});

test('N01-e & N02: multi-family representation admission isolates semantic_access Lane role to admitted units while vectorless units participate via lexical/graph channels', () => {
  const createPages = resolveTool('libra_memory_graph_pages.cjs');
  const createIndex = resolveTool('libra_memory_graph_index.cjs');
  const createLane = resolveTool('libra_memory_graph_lane.cjs');
  const createQuery = resolveTool('libra_memory_graph_query.cjs');
  const fingerprint = text => crypto.createHash('sha256').update(String(text)).digest('hex');

  const pages = createPages({ fingerprint });
  const index = createIndex({ pages, fingerprint });
  const lane = createLane({ pages, index });
  const query = createQuery({ pages, index, lane, fingerprint });

  const graph = {
    schema: 'libra.memory_graph_projection.v1',
    readerFrame: { owner: 'test', scopeKey: 'scope' },
    nodes: [
      { id: 'canon-node', layer: 'source', bindingId: 'b-canon' },
      { id: 'canon-unit-node', layer: 'meaning', sourceId: 'canon-node', bindingId: 'b-cu' },
      { id: 'micro-node', layer: 'meaning', sourceId: null, bindingId: 'b-micro' },
      { id: 'state-node', layer: 'meaning', sourceId: null, bindingId: 'b-state' }
    ],
    units: [
      { nodeId: 'canon-unit-node', family: 'canonical', recordKey: 'rec-canon', text: 'quantum computer core' },
      { nodeId: 'micro-node', family: 'micro', recordKey: 'rec-micro', text: 'laser crystal aligned' },
      { nodeId: 'state-node', family: 'state', recordKey: 'rec-state', text: 'reactor power online' }
    ],
    edges: [
      { id: 'e1', from: 'canon-unit-node', to: 'canon-node', predicate: 'evidenced_by' }
    ]
  };

  const compiled = index.compile(graph, { partition: 'p', generation: '1'.repeat(64) });
  const frame = query.sealQueryFrame({
    owner: 'test',
    scopeKey: 'scope',
    worldlineId: 'main',
    queryText: 'quantum laser reactor',
    semanticSpace: { spaceId: 's1', provider: 'p1', model: 'm1', dimension: 2, metric: 'cosine' },
    queryEmbedding: [1, 0],
    documentRepresentations: {
      'canon-node': { nodeId: 'canon-node', bindingId: 'b-canon', spaceId: 's1', provider: 'p1', model: 'm1', dimension: 2, vector: [1, 0] },
      'micro-node': { nodeId: 'micro-node', bindingId: 'b-micro', spaceId: 's1', provider: 'p1', model: 'm1', dimension: 2, vector: [1, 0] }
    },
    representationDecisions: {
      'canon-unit-node': { status: 'valid', reason: '' },
      'micro-node': { status: 'valid', reason: '' },
      'state-node': { status: 'missing', reason: 'no_representation_producer_declared' }
    }
  });

  const view = query.openView(graph, compiled, frame);
  const result = query.retrieve(view);
  assert.equal(result.complete, true);

  // Lane role stats: semantic_access is strictly 2 (for canon and micro), 0 for state
  const roleStats = result.diagnostics.laneRoleStats;
  assert.equal(roleStats.semantic_access.requests, 2, 'semantic_access must only be enqueued for admitted units');
  assert.equal(roleStats.query_anchor_access.requests, 3, 'all tokens must be queried via lexical query_anchor_access');

  // Verify candidate semantic statuses and inclusion of vectorless state unit
  const canonCand = result.candidates.find(c => c.nodeId === 'canon-unit-node');
  const microCand = result.candidates.find(c => c.nodeId === 'micro-node');
  const stateCand = result.candidates.find(c => c.nodeId === 'state-node');

  assert.ok(canonCand, 'canonical candidate must be retrieved');
  assert.ok(microCand, 'admitted micro candidate must be retrieved');
  assert.equal(microCand.semanticFeatureStatus, 'available_vector_space', 'admitted micro unit receives vector space feature');
  assert.ok(microCand.score > 0.3, 'micro candidate score benefits from semantic vector match');

  assert.ok(stateCand, 'vectorless state candidate must still participate in single frontier');
  assert.equal(stateCand.semanticFeatureStatus, 'incompatible_isolated', 'state unit is isolated from vector channel');
  assert.ok(stateCand.score > 0, 'state unit receives non-zero score from lexical/graph match');

  // Semantic diagnostics verify exact counts and gating reasons
  const semDiag = result.diagnostics.semanticDiagnostics;
  assert.equal(semDiag.planDecisionCount, 3);
  assert.equal(semDiag.planGatedCount, 1);
  assert.equal(semDiag.planGatedReasons.no_representation_producer_declared, 1);
  assert.equal(semDiag.compatibleCount, 2);
  assert.equal(semDiag.incompatibleIsolatedCount, 1);
  assert.equal(semDiag.backgroundEmbeddingStarted, false);
});

test('N01-e: representation decisions and diagnostics faithfully preserve gated reasons and coverage in unified query', () => {
  const plugin = fs.readFileSync(SOURCE_FILE, 'utf8');
  const repDecisionsIdx = plugin.indexOf('const decisions = {};');
  assert.ok(repDecisionsIdx > 0, 'LIBRA.js must build representation decisions');
  const chunk = plugin.slice(repDecisionsIdx, repDecisionsIdx + 600);
  assert.ok(chunk.indexOf('if (admitted[nodeId])') < chunk.indexOf("if (string(unit.family) !== 'canonical')"),
    'admitted representations must be verified before declaring non-canonical families as missing');
});

(async () => {
  const results = [];
  for (const t of tests) {
    await t.fn();
    results.push(t.name);
  }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_representation', passed: results.length, tests: results }));
})();
