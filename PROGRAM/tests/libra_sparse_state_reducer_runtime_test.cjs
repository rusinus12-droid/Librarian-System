'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const startMarker = '/* LIBRA CANONICAL STATE PIPELINE V3 START */';
const endMarker = '/* LIBRA CANONICAL STATE PIPELINE V3 PURE CORE END */';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start + startMarker.length);
assert.ok(start >= 0 && end > start, 'canonical/state v3 pure-core markers are required');
const pureCore = source.slice(start, end + endMarker.length);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 900) => string(value).slice(0, limit);
const stableStringify = value => JSON.stringify(value, Object.keys(asObject(value)).sort());
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stableHash = value => digest(value).slice(0, 24);

const context = {
  Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Set, Map,
  structuredClone: globalThis.structuredClone,
  safeClone: clone, clone, asObject, isPlainObject,
  asArray, string, text: string, compact, digest, stableHash, stableStringify,
  STATE_OBSERVATION_SCHEMA: 'libra.state_observation.v2',
  ENTITY_REGISTRY_SCHEMA: 'libra.entity_registry.v2',
  CONTINUITY_STATE_SCHEMA: 'libra.continuity_state.v2',
  CONTINUITY_STATE_PROVENANCE_VERSION: 3,
  CONTINUITY_STATE_RELATION_DIMENSIONS: Object.freeze([
    'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
    'cooperation', 'authority', 'dependency', 'knowledge', 'other'
  ]),
  nowIso: () => '2026-09-01T00:00:00.000Z'
};
vm.createContext(context);
vm.runInContext(`${pureCore}\nthis.api = {
  buildCanonicalEntityRegistry,
  normalizeStateObservation,
  applyVerifiedStateObservation,
  statePipelinePatchRequiresVerifier,
  statePipelineFutureFieldEvidenceEligible
};`, context, { filename: 'libra-canonical-state-v3-pure-core.js', timeout: 2000 });
const api = context.api;

const registry = {
  schema: 'libra.entity_registry.v2',
  scopeKey: 'scope:test',
  entities: [
    { id: 'char_alice', type: 'person', name: 'Alice', aliases: ['A'], validated: true },
    { id: 'char_bob', type: 'person', name: 'Bob', aliases: [], validated: true }
  ],
  byId: {
    char_alice: { id: 'char_alice', type: 'person', name: 'Alice', aliases: ['A'], validated: true },
    char_bob: { id: 'char_bob', type: 'person', name: 'Bob', aliases: [], validated: true }
  },
  fingerprint: 'registry-v1',
  diagnostics: []
};

const previousProvenance = {
  memoryId: 'mem_000001', revision: 1, assertionId: 'ca_old',
  evidenceRefs: ['t5-a'], changedThroughTurn: 5
};
const baseHead = {
  schema: 'libra.continuity_state.v2',
  scopeKey: 'scope:test', worldlineId: 'main', status: 'ready', throughTurn: 5,
  characters: [{
    id: 'char_alice', name: 'Alice', aliases: ['A'],
    state: {
      gender: 'female', appearance: { hair: 'black', eyes: 'brown' }, location: 'room-a'
    },
    fieldEvidence: {
      gender: clone(previousProvenance), appearance: clone(previousProvenance),
      location: clone(previousProvenance)
    }
  }],
  relationships: [], world: [],
  narrative: { schema: 'libra.narrative_state.v1', arcs: [], threads: [], locks: [], momentum: '' },
  domainStatus: {
    characters: {
      reviewedThroughCanonical: { memoryId: 'mem_000001', revision: 1 },
      changedThroughCanonical: { memoryId: 'mem_000001', revision: 1 },
      reviewedThroughTurn: 5, changedThroughTurn: 5
    },
    relationships: {
      reviewedThroughCanonical: { memoryId: 'mem_000001', revision: 1 },
      changedThroughCanonical: { memoryId: 'mem_000001', revision: 1 },
      reviewedThroughTurn: 5, changedThroughTurn: 5
    }
  }
};

const basis = {
  scopeKey: 'scope:test', worldlineId: 'main', memoryId: 'mem_000006', revision: 2,
  turnRange: { start: 6, end: 10 }, sourceDigest: 'source-2', artifactDigest: 'artifact-2',
  headFingerprint: '', entityRegistryFingerprint: registry.fingerprint
};
const assertionCatalog = [
  { assertionId: 'ca_move', domain: 'character', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: 'Alice moved to room B.' }] },
  { assertionId: 'ca_clear', domain: 'character', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: 'Alice left the prior room.' }] }
];

const nextRegistry = clone(api.buildCanonicalEntityRegistry({
  characters: [{ name: 'Alice', aliases: ['A'], assertionId: 'ca_2', evidenceRefs: ['t10-a'] }],
  world: []
}, clone(registry), { scopeKey: 'scope:test' }));
assert.ok(nextRegistry.byId.char_alice, 'a repeated canonical entity must keep its stable registry id');
assert.ok(nextRegistry.byId.char_bob,
  'a previously validated registry entity omitted by this five-turn artifact must remain addressable');

const contaminatedNames = ['경영학', '게시물', '관계명', '앞에서', 'k-pop'];
const admissionArtifact = {
  chronology: [
    { actors: ['김서연'] },
    ...contaminatedNames.map((name, index) => ({
      event: `${name} 표현이 반복되었다.`, actors: [name], assertionId: `ca_noise_event_${index}`,
      evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: `${name} 표현이 반복되었다.` }]
    }))
  ],
  relationships: contaminatedNames.map((name, index) => ({
    subject: name, target: '김서연', relation: 'mentioned-near', assertionId: `ca_noise_relation_${index}`,
    evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: `${name}과 김서연이 같은 문장에 적혔다.` }]
  })),
  world: [],
  characters: [
    {
      name: '김서연', domain: 'character', certainty: 'confirmed', assertionId: 'ca_person_kim',
      evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: '김서연은 기록실에 들어왔다.' }]
    },
    ...contaminatedNames.map((name, index) => ({
      name, domain: 'character', certainty: 'confirmed', assertionId: `ca_noise_${index}`,
      evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: `${name} 항목이 문서에 적혀 있었다.` }]
    }))
  ]
};
const admissionRegistry = clone(api.buildCanonicalEntityRegistry(admissionArtifact, clone(registry), {
  scopeKey: 'scope:test', approvedPersonAssertionIds: ['ca_person_kim']
}));
assert.ok(admissionRegistry.byId.char_alice && admissionRegistry.byId.char_bob,
  'registry admission filtering must preserve every prior validated entity');
assert.ok(admissionRegistry.entities.some(row => row.type === 'person' && row.name === '김서연'),
  'a grounded named actor must be admitted as a person');
for (const contaminatedName of contaminatedNames) {
  assert.equal(admissionRegistry.entities.some(row => row.type === 'person' && row.name === contaminatedName), false,
    `${contaminatedName} must not contaminate the person registry`);
  assert.ok(admissionRegistry.diagnostics.some(row => row.name === contaminatedName && row.code === 'person_admission_semantic_category_rejected'),
    `${contaminatedName} must expose a person-admission rejection despite repeated actor/relationship anchors`);
}

const unseenNounArtifact = {
  chronology: [
    {
      event: '경제학과 박하린이 연구실 기록에 함께 적혔다.', actors: ['경제학', '박하린'],
      assertionId: 'ca_unseen_actor_anchor', evidenceRefs: ['t10-b'],
      evidenceSpans: [{ ref: 't10-b', quote: '경제학과 박하린이 연구실 기록에 함께 적혔다.' }]
    }
  ],
  relationships: [
    {
      subject: '경제학', target: '박하린', relation: 'listed-near', assertionId: 'ca_unseen_relation',
      evidenceRefs: ['t10-b'], evidenceSpans: [{ ref: 't10-b', quote: '경제학과 박하린이 함께 적혔다.' }]
    }
  ],
  world: [],
  characters: [
    {
      name: '경제학', domain: 'character', certainty: 'confirmed', assertionId: 'ca_unseen_economics',
      evidenceRefs: ['t10-b'], evidenceSpans: [{ ref: 't10-b', quote: '경제학과 박하린이 연구실 기록에 함께 적혔다.' }]
    },
    {
      name: '박하린', domain: 'character', certainty: 'confirmed', assertionId: 'ca_person_park',
      evidenceRefs: ['t10-b'], evidenceSpans: [{ ref: 't10-b', quote: '박하린이 연구실에 들어왔다.' }]
    }
  ]
};
const independentlyApprovedRegistry = clone(api.buildCanonicalEntityRegistry(unseenNounArtifact, clone(registry), {
  scopeKey: 'scope:test', approvedPersonAssertionIds: ['ca_person_park']
}));
assert.ok(independentlyApprovedRegistry.byId.char_alice && independentlyApprovedRegistry.byId.char_bob,
  'prior validated people remain trusted without requiring a new admission receipt');
assert.ok(independentlyApprovedRegistry.entities.some(row => row.type === 'person' && row.name === '박하린'),
  'a genuinely named new person with an independent runtime admission approval must be admitted');
assert.equal(independentlyApprovedRegistry.entities.some(row => row.type === 'person' && row.name === '경제학'), false,
  'artifact self-certification cannot turn an unseen semantic noun into a person, even with exact spans and repeated actor/relationship use');
assert.ok(independentlyApprovedRegistry.diagnostics.some(row => row.name === '경제학'
  && /person_admission_(?:assertion_unapproved|independent_approval_missing|semantic_category_rejected)/.test(String(row.code || ''))),
  'the rejected unseen noun must expose the independent-admission boundary');

const apply = value => clone(api.applyVerifiedStateObservation(clone(baseHead), clone(value), clone(registry), {
  verifierDecisions: {}, evidence: {}, assertions: clone(assertionCatalog),
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));

const maintained = apply({
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{
    entityId: 'char_alice', outcome: 'maintained',
    reviewedFields: ['gender', 'appearance', 'location'], assertionIds: []
  }],
  patches: [], diagnostics: []
});
assert.equal(maintained.ok, true);
assert.equal(maintained.changed, false);
assert.equal(maintained.head.characters[0].state.gender, 'female');
assert.deepEqual(maintained.head.characters[0].state.appearance, { hair: 'black', eyes: 'brown' });
assert.equal(maintained.head.characters[0].state.location, 'room-a');
assert.deepEqual(maintained.head.characters[0].fieldEvidence, baseHead.characters[0].fieldEvidence,
  'an observation with no sparse patch must preserve every field and provenance byte-semantically');
assert.equal(maintained.head.domainStatus.characters.reviewedThroughCanonical.memoryId, 'mem_000006');
assert.equal(maintained.head.domainStatus.characters.reviewedThroughCanonical.revision, 2);
assert.equal(maintained.head.domainStatus.characters.reviewedThroughTurn, 10);
assert.deepEqual(maintained.head.domainStatus.characters.changedThroughCanonical, { memoryId: 'mem_000001', revision: 1 });
assert.equal(maintained.head.domainStatus.characters.changedThroughTurn, 5);

const repeated = apply({
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['location'], assertionIds: ['ca_repeat'] }],
  patches: [{
    operation: 'upsert', entityId: 'char_alice', set: { location: 'room-a' }, clear: [],
    changeClass: 'transition',
    evidenceByField: { location: { assertionId: 'ca_repeat', memoryId: basis.memoryId, revision: basis.revision, evidenceRefs: ['t10-a'] } }
  }],
  diagnostics: []
});
assert.equal(repeated.ok, true);
assert.equal(repeated.changed, false, 'normalized same-value output must be a no-op');
assert.equal(repeated.appliedPatches.length, 0);
assert.deepEqual(repeated.head.characters[0].fieldEvidence.location, previousProvenance,
  'same-value output must not drift provenance');
assert.equal(repeated.head.domainStatus.characters.reviewedThroughTurn, 10);
assert.equal(repeated.head.domainStatus.characters.changedThroughTurn, 5);

const moved = apply({
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['location'], assertionIds: ['ca_move'] }],
  patches: [{
    operation: 'upsert', entityId: 'char_alice', set: { location: 'room-b' }, clear: [],
    changeClass: 'transition',
    evidenceByField: { location: { assertionId: 'ca_move', memoryId: basis.memoryId, revision: basis.revision, evidenceRefs: ['t10-a'] } }
  }],
  diagnostics: []
});
assert.equal(moved.ok, true);
assert.equal(moved.changed, true);
assert.equal(moved.head.characters[0].state.location, 'room-b');
assert.equal(moved.head.characters[0].state.gender, 'female', 'omitted identity-locked fields must survive a location change');
assert.deepEqual(moved.head.characters[0].state.appearance, { hair: 'black', eyes: 'brown' },
  'omitted appearance must survive a location change');
assert.deepEqual(moved.head.characters[0].fieldEvidence.gender, previousProvenance);
assert.deepEqual(moved.head.characters[0].fieldEvidence.appearance, previousProvenance);
assert.equal(moved.head.fieldEvidence, undefined, 'evidence belongs to the changed record, not an unrelated root field');
assert.equal(moved.head.domainStatus.characters.changedThroughCanonical.memoryId, 'mem_000006');
assert.equal(moved.head.domainStatus.characters.changedThroughCanonical.revision, 2);
assert.equal(moved.head.domainStatus.characters.changedThroughTurn, 10);

for (const [patchId, evidenceByField, expectedCode] of [
  ['missing_local_evidence', {}, 'state_field_evidence_missing:location'],
  ['invented_local_evidence', { location: { assertionId: 'invented_assertion' } }, 'state_field_evidence_unknown_assertion:location']
]) {
  const unbound = apply({
    schema: 'libra.state_observation.v2', domain: 'character', basis,
    reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['location'], assertionIds: [] }],
    patches: [{ patchId, operation: 'upsert', entityId: 'char_alice', set: { location: 'room-c' }, clear: [], evidenceByField }],
    diagnostics: []
  });
  assert.equal(unbound.changed, false, `${patchId} must not mutate a canonical-derived Head`);
  assert.equal(unbound.head.characters[0].state.location, 'room-a');
  assert.ok(unbound.rejectedPatches.some(item => item.patchId === patchId && item.code === expectedCode),
    `${patchId} must expose its local evidence binding failure`);
}

const emptyMissingEntity = apply({
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_bob', outcome: 'maintained', reviewedFields: [], assertionIds: [] }],
  patches: [{ patchId: 'empty_char', operation: 'upsert', entityId: 'char_bob', set: {}, clear: [] }],
  diagnostics: []
});
assert.equal(emptyMissingEntity.changed, false);
assert.equal(emptyMissingEntity.head.characters.some(row => row.id === 'char_bob'), false,
  'an empty patch must not materialize a missing entity record');

const emptyMissingRelationship = apply({
  schema: 'libra.state_observation.v2', domain: 'relationship', basis,
  reviews: [],
  patches: [{
    patchId: 'empty_relation', operation: 'upsert', subjectId: 'char_alice', targetId: 'char_bob',
    dimension: 'trust', set: {}, clear: []
  }],
  diagnostics: []
});
assert.equal(emptyMissingRelationship.changed, false);
assert.deepEqual(emptyMissingRelationship.head.relationships, [],
  'an empty patch must not materialize a relationship record');

for (const [patchId, concurrency] of [
  ['bad_record_hash', { expectedRecordHash: 'definitely-not-the-current-record-hash' }],
  ['bad_field_hash', { expectedFieldHashes: { location: 'definitely-not-the-current-field-hash' } }]
]) {
  const conflicted = apply({
    schema: 'libra.state_observation.v2', domain: 'character', basis,
    reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['location'], assertionIds: ['ca_conflict'] }],
    patches: [{
      patchId, operation: 'upsert', entityId: 'char_alice', set: { location: 'room-b' }, clear: [],
      ...concurrency
    }],
    diagnostics: []
  });
  assert.equal(conflicted.changed, false, `${patchId} must fail optimistic concurrency`);
  assert.equal(conflicted.head.characters[0].state.location, 'room-a');
  assert.ok(conflicted.rejectedPatches.some(item => item.patchId === patchId),
    `${patchId} must be visible in rejectedPatches`);
}

for (const highRiskPatch of [
  { patchId: 'unverified_clear', operation: 'clear_fields', entityId: 'char_alice', set: {}, clear: ['location'] },
  { patchId: 'unverified_close', operation: 'close', entityId: 'char_alice', set: {}, clear: [] },
  { patchId: 'unverified_identity', operation: 'upsert', entityId: 'char_alice', set: { gender: 'male' }, clear: [] }
]) {
  const rejected = apply({
    schema: 'libra.state_observation.v2', domain: 'character', basis,
    reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: [], assertionIds: [] }],
    patches: [highRiskPatch], diagnostics: []
  });
  assert.equal(rejected.changed, false, `${highRiskPatch.patchId} needs an explicit verifier approval`);
  assert.equal(rejected.head.characters[0].state.gender, 'female');
  assert.equal(rejected.head.characters[0].state.location, 'room-a');
  assert.ok(rejected.rejectedPatches.some(item => item.patchId === highRiskPatch.patchId));
}

const approvedClear = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['location'], assertionIds: ['ca_clear'] }],
  patches: [{
    patchId: 'approved_clear', operation: 'clear_fields', entityId: 'char_alice',
    set: {}, clear: ['location'], verificationRequired: true,
    evidenceByField: { location: { assertionId: 'ca_clear', memoryId: basis.memoryId, revision: basis.revision } }
  }],
  diagnostics: []
}, clone(registry), {
  verifierDecisions: { approved_clear: 'approve' }, evidence: {}, assertions: clone(assertionCatalog),
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));
assert.equal(approvedClear.ok, true);
assert.equal(approvedClear.changed, true);
assert.equal(Object.prototype.hasOwnProperty.call(approvedClear.head.characters[0].state, 'location'), false);
assert.equal(Object.prototype.hasOwnProperty.call(approvedClear.head.characters[0].fieldEvidence, 'location'), false);
assert.equal(approvedClear.head.characters[0].state.gender, 'female');
assert.deepEqual(approvedClear.head.characters[0].state.appearance, { hair: 'black', eyes: 'brown' },
  'an approved sparse clear may change only its named target field');
assert.deepEqual(approvedClear.head.characters[0].fieldEvidence.gender, previousProvenance);
assert.deepEqual(approvedClear.head.characters[0].fieldEvidence.appearance, previousProvenance);

const invalidRelationship = apply({
  schema: 'libra.state_observation.v2', domain: 'relationship', basis,
  reviews: [{ entityId: 'rel_unknown', outcome: 'changed', reviewedFields: ['state'], assertionIds: ['ra_invalid'] }],
  patches: [{
    operation: 'upsert', entityId: 'rel_unknown', subjectId: 'char_alice', targetId: 'char_missing',
    dimension: 'trust', set: { state: 'trusted' }, clear: [], changeClass: 'newly_established',
    evidenceByField: { state: { assertionId: 'ra_invalid', memoryId: basis.memoryId, revision: basis.revision, evidenceRefs: ['t10-a'] } }
  }],
  diagnostics: []
});
assert.equal(invalidRelationship.ok, true);
assert.equal(invalidRelationship.changed, false);
assert.deepEqual(invalidRelationship.head.relationships, []);
assert.equal(invalidRelationship.appliedPatches.length, 0);
assert.ok(invalidRelationship.rejectedPatches.length >= 1,
  'a relation with an unverified endpoint must be rejected rather than creating a placeholder person');

for (const field of [
  'goals', 'current_goal', 'activeObjectives', 'knowledgeBoundary', 'emotional_state',
  'motivation', 'currentIntentions', 'desires', 'personalityTraits', 'behavioural_patterns',
  'enduringPatterns', 'preferences', 'boundaries', 'consentState',
  '현재 목표', '지식 경계', '현재 감정', '동기', '의도', '성향', '행동 패턴', '선호', '경계', '동의 상태'
]) {
  assert.equal(api.statePipelinePatchRequiresVerifier('character', {
    operation: 'upsert', set: { [field]: 'candidate' }
  }), true, `${field} must route through the existing Character Verifier`);
}
assert.equal(api.statePipelinePatchRequiresVerifier('character', {
  operation: 'upsert', set: { location: 'room-b' }
}), false, 'a low-risk location patch must not add a verifier call');

const goalPatch = {
  patchId: 'future_goal', operation: 'upsert', entityId: 'char_alice', set: { goals: ['find Bob'] }, clear: [],
  evidenceByField: { goals: { assertionId: 'ca_goal' } }
};
const confirmedGoalAssertion = {
  assertionId: 'ca_goal', domain: 'character', temporalRole: 'current_sequence', certainty: 'confirmed',
  evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: 'Alice decided to find Bob.' }]
};
assert.equal(api.statePipelineFutureFieldEvidenceEligible(goalPatch, 'goals', [confirmedGoalAssertion]), true);
assert.equal(api.statePipelineFutureFieldEvidenceEligible(goalPatch, 'goals', [{
  ...confirmedGoalAssertion, temporalRole: 'reported', certainty: 'uncertain'
}]), false, 'reported or uncertain assertions cannot authorize a future-shaping field');

const approvedGoal = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['goals'], assertionIds: ['ca_goal'] }],
  patches: [goalPatch], diagnostics: []
}, clone(registry), {
  verifierDecisions: { future_goal: 'approve' }, assertions: [confirmedGoalAssertion],
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));
assert.equal(approvedGoal.changed, true);
assert.deepEqual(approvedGoal.head.characters[0].state.goals, ['find Bob']);

const ineligibleGoal = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['goals'], assertionIds: ['ca_goal'] }],
  patches: [goalPatch], diagnostics: []
}, clone(registry), {
  verifierDecisions: { future_goal: 'approve' }, assertions: [{ ...confirmedGoalAssertion, temporalRole: 'reported' }],
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));
assert.equal(ineligibleGoal.changed, false);
assert.ok(ineligibleGoal.rejectedPatches.some(item => item.code === 'state_future_field_evidence_ineligible:goals'));

const legacyGoal = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['goals'], assertionIds: ['ca_goal'] }],
  patches: [goalPatch], diagnostics: []
}, clone(registry), {
  verifierDecisions: {}, assertions: [confirmedGoalAssertion], requireAssertionEvidence: true,
  now: '2026-09-01T00:00:00.000Z', replay: true
}));
assert.equal(legacyGoal.changed, false);
assert.ok(legacyGoal.rejectedPatches.some(item => item.code === 'legacy_unverified_future_field'));

const isolatedFutureFailure = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'character', basis,
  reviews: [{ entityId: 'char_alice', outcome: 'changed', reviewedFields: ['goals', 'location'], assertionIds: ['ca_goal', 'ca_move'] }],
  patches: [goalPatch, {
    patchId: 'safe_location', operation: 'upsert', entityId: 'char_alice', set: { location: 'room-b' }, clear: [],
    evidenceByField: { location: { assertionId: 'ca_move' } }
  }], diagnostics: []
}, clone(registry), {
  verifierDecisions: {}, assertions: [confirmedGoalAssertion, ...assertionCatalog],
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));
assert.equal(isolatedFutureFailure.changed, true);
assert.equal(isolatedFutureFailure.head.characters[0].state.location, 'room-b',
  'a rejected future-shaping patch must not discard a separate low-risk state change');
assert.equal(Object.prototype.hasOwnProperty.call(isolatedFutureFailure.head.characters[0].state, 'goals'), false);
assert.equal(isolatedFutureFailure.atomicRejected, false);
assert.ok(isolatedFutureFailure.rejectedPatches.some(item => item.patchId === 'future_goal' && item.localFailClosed === true));

const attractionAssertion = {
  assertionId: 'ra_attraction', domain: 'relationship', temporalRole: 'current_sequence', certainty: 'confirmed',
  evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: 'Alice explicitly said she was attracted to Bob.' }]
};
const attraction = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'relationship', basis,
  reviews: [{ entityId: '', outcome: 'changed', reviewedFields: ['state'], assertionIds: ['ra_attraction'] }],
  patches: [{
    patchId: 'relationship_attraction', operation: 'upsert', subjectId: 'char_alice', targetId: 'char_bob',
    dimension: 'attraction', set: { state: 'explicit attraction' }, clear: [],
    evidenceByField: { state: { assertionId: 'ra_attraction' } }
  }], diagnostics: []
}, clone(registry), {
  verifierDecisions: { relationship_attraction: 'approve' }, assertions: [attractionAssertion],
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));
assert.equal(attraction.changed, true);
assert.equal(attraction.head.relationships.length, 1);
assert.equal(attraction.head.relationships[0].dimension, 'attraction');
assert.equal(attraction.head.relationships[0].subjectId, 'char_alice');
assert.equal(attraction.head.relationships[0].targetId, 'char_bob');
assert.equal(attraction.head.relationships.some(row => row.subjectId === 'char_bob' && row.targetId === 'char_alice'), false,
  'directional attraction must not manufacture reciprocity');

const quantifiedAttraction = clone(api.applyVerifiedStateObservation(clone(baseHead), {
  schema: 'libra.state_observation.v2', domain: 'relationship', basis,
  reviews: [{ entityId: '', outcome: 'changed', reviewedFields: ['state'], assertionIds: ['ra_attraction'] }],
  patches: [{
    patchId: 'relationship_attraction_score', operation: 'upsert', subjectId: 'char_alice', targetId: 'char_bob',
    dimension: 'attraction', set: { state: 'explicit attraction', score: 0.8 }, clear: [],
    evidenceByField: { state: { assertionId: 'ra_attraction' }, score: { assertionId: 'ra_attraction' } }
  }], diagnostics: []
}, clone(registry), {
  verifierDecisions: { relationship_attraction_score: 'approve' }, assertions: [attractionAssertion],
  requireAssertionEvidence: true, now: '2026-09-01T00:00:00.000Z'
}));
assert.equal(quantifiedAttraction.changed, false);
assert.equal(quantifiedAttraction.atomicRejected, true);
assert.ok(quantifiedAttraction.rejectedPatches.some(item =>
  item.patchId === 'relationship_attraction_score' && item.code === 'relationship_quantitative_state_forbidden'));

process.stdout.write(`libra_sparse_state_reducer_runtime_test: PASS (${path.basename(sourcePath)})\n`);
