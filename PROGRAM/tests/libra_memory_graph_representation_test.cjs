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

(async () => {
  const results = [];
  for (const t of tests) {
    await t.fn();
    results.push(t.name);
  }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_representation', passed: results.length, tests: results }));
})();
