'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const pluginPath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
assert.ok(fs.existsSync(pluginPath), `LIBRA source missing: ${pluginPath}`);
const source = fs.readFileSync(pluginPath, 'utf8');

const section = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const correctionSource = section(
  'const resolveStateCorrectionIdentity =',
  'const reconcileStateCorrectionStatuses ='
);
const normalizeSource = section(
  'const normalizeStateCorrectionPayload =',
  'const stateCorrectionPreflight ='
);

assert.match(correctionSource, /STATE_CORRECTION_PATCH_SCHEMA/,
  'state correction must compile a v2 sparse patch');
assert.match(correctionSource, /expectedRecordHash/,
  'state correction must bind record CAS');
assert.match(correctionSource, /expectedFieldHashes/,
  'state correction must bind field CAS');
assert.match(correctionSource, /fieldCorrectionProvenance/,
  'state correction must retain field-level user provenance');
assert.match(correctionSource, /clearedFieldCorrectionProvenance/,
  'state correction must retain explicit-clear provenance');
assert.doesNotMatch(correctionSource,
  /if \(compiled\.schema === STATE_CORRECTION_PATCH_SCHEMA[\s\S]{0,300}return applyLegacyCorrectionProfilePatch\(headValue, correction\);[\s\S]{0,300}return applyLegacyCorrectionProfilePatch\(headValue, correction\);/,
  'ordinary corrections must not fall through to an identity-minting full-profile applier');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 1000) => string(value).replace(/\s+/g, ' ').slice(0, limit);
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
};
const stableReferenceJson = value => JSON.stringify(stableValue(value));
const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : stableReferenceJson(value ?? null))
  .digest('hex');
const continuityStateNameKey = value => string(value).normalize('NFKC').toLocaleLowerCase();
const continuityStateAliases = value => Array.from(new Set(asArray(value).map(item => compact(item, 180)).filter(Boolean)));
const normalizeContinuityStateSet = value => clone(asObject(value));
const statePipelineStableObject = value => stableValue(value);
const statePipelineSemanticValue = (_field, value) => stableValue(value);
const statePipelineSemanticEqual = (_field, left, right) => stableReferenceJson(left) === stableReferenceJson(right);
const stateCorrectionFailure = (code, message = code) => Object.assign(new Error(message), { code });
const nowIso = () => '2026-09-02T01:00:00.000Z';
const continuityEntityId = (scope, kind, identity) => `legacy_${kind}_${digest([scope?.scopeKey || '', identity]).slice(0, 12)}`;

const normalizeCurrentNarrativeState = value => {
  const sourceValue = asObject(value);
  return {
    schema: 'libra.narrative_current_state.v2',
    summary: compact(sourceValue.summary || '', 8000),
    primaryArcId: compact(sourceValue.primaryArcId || '', 180),
    arcs: clone(asArray(sourceValue.arcs)),
    threads: clone(asArray(sourceValue.threads)),
    locks: clone(asArray(sourceValue.locks)),
    momentum: clone(sourceValue.momentum ?? ''),
    fieldEvidence: clone(asObject(sourceValue.fieldEvidence)),
    clearedFieldEvidence: clone(asObject(sourceValue.clearedFieldEvidence)),
    fieldCorrectionProvenance: clone(asObject(sourceValue.fieldCorrectionProvenance)),
    clearedFieldCorrectionProvenance: clone(asObject(sourceValue.clearedFieldCorrectionProvenance)),
    correctionProvenance: sourceValue.correctionProvenance ? clone(sourceValue.correctionProvenance) : null
  };
};

const __libraNarrativeNormalizePatch = value => {
  const raw = asObject(value);
  if (raw.schema && raw.schema !== 'libra.narrative_patch.v1') return { ok: false, reason: 'schema' };
  return { ok: true, patch: clone(raw) };
};
const applyNarrativeRows = (currentRows, patches, terminalStatus) => {
  const rows = clone(asArray(currentRows));
  for (const patch of asArray(patches)) {
    const id = string(patch?.id || '');
    const index = rows.findIndex(row => string(row?.id || '') === id);
    if (patch?.op === terminalStatus) {
      if (index >= 0) rows.splice(index, 1);
      continue;
    }
    if (index >= 0) rows[index] = { ...rows[index], ...clone(patch) };
    else if (id) rows.push(clone(patch));
  }
  return rows;
};
const __libraNarrativeApplyPatch = (currentValue, patchValue) => {
  const current = clone(asObject(currentValue));
  const patch = asObject(patchValue);
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, 'summary')) next.summary = patch.summary;
  if (Object.prototype.hasOwnProperty.call(patch, 'primaryArcId')) next.primaryArcId = patch.primaryArcId;
  if (Object.prototype.hasOwnProperty.call(patch, 'momentum')) next.momentum = clone(patch.momentum);
  if (patch.arcs) next.arcs = applyNarrativeRows(current.arcs, patch.arcs, 'close');
  if (patch.threads) next.threads = applyNarrativeRows(current.threads, patch.threads, 'resolve');
  if (patch.locks) next.locks = applyNarrativeRows(current.locks, patch.locks, 'release');
  // Legacy-only history collections intentionally remain outside Current Narrative normalization.
  if (patch.motifs) next.motifs = clone(patch.motifs);
  if (patch.turningPoints) next.turningPoints = clone(patch.turningPoints);
  return next;
};

const context = {
  Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Map, Set,
  clone, asObject, asArray, string, compact, isPlainObject, stableReferenceJson, digest,
  continuityStateNameKey, continuityStateAliases, normalizeContinuityStateSet,
  statePipelineStableObject, statePipelineSemanticValue, statePipelineSemanticEqual,
  stateCorrectionFailure, nowIso, continuityEntityId,
  normalizeCurrentNarrativeState, __libraNarrativeNormalizePatch, __libraNarrativeApplyPatch,
  STATE_CORRECTION_EVENT_SCHEMA: 'libra.state_correction.v1',
  STATE_CORRECTION_PATCH_SCHEMA: 'libra.state_correction_patch.v2',
  CURRENT_NARRATIVE_STATE_SCHEMA: 'libra.narrative_current_state.v2',
  CONTINUITY_STATE_RELATION_DIMENSIONS: [
      'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
    'cooperation', 'authority', 'dependency', 'knowledge', 'other'
  ],
  CONTINUITY_STATE_MAX_CHARACTERS: 96,
  CONTINUITY_STATE_MAX_RELATIONSHIPS: 192,
  CONTINUITY_STATE_MAX_WORLD_RECORDS: 128
};
Object.assign(context, require('./fixtures/librarian_production_bindings.cjs')(source));
  vm.createContext(context);
vm.runInContext(`
${correctionSource}
${normalizeSource}
this.api = {
  resolveStateCorrectionIdentity,
  compileStateCorrectionPatch,
  normalizeStateCorrectionPayload,
  applySparseStateCorrectionPatch,
  applyCorrectionProfilePatch,
  stateHeadCorrectionIds,
  stateHeadHasCorrection
};`, context, { filename: 'libra-state-correction-sparse-v2-runtime.js', timeout: 5000 });
const api = context.api;

const canonicalEvidence = label => ({ memoryId: `mem_${label}`, revision: 1, assertionId: `ca_${label}`, evidenceRefs: [`t_${label}`] });
const makeHead = () => ({
  schema: 'libra.continuity_state.v2',
  scopeKey: 'scope:sparse-v2', worldlineId: 'main', throughTurn: 10,
  characters: [
    {
      id: 'char_ada', name: 'Ada', aliases: ['A'],
      state: { mood: 'calm', location: 'hall', keeps: 'yes' },
      fieldEvidence: { mood: canonicalEvidence('mood'), location: canonicalEvidence('location'), keeps: canonicalEvidence('keeps') },
      clearedFieldEvidence: {}, certainty: 'confirmed'
    },
    { id: 'char_bea', name: 'Bea', aliases: [], state: { mood: 'quiet' }, fieldEvidence: {}, certainty: 'confirmed' }
  ],
  relationships: [
    {
      id: 'rel_ada_bea_trust', subjectId: 'char_ada', targetId: 'char_bea',
      subjectName: 'Ada', targetName: 'Bea', dimension: 'trust',
      state: { value: 'guarded', reason: 'new alliance' },
      fieldEvidence: { value: canonicalEvidence('trust') }, certainty: 'confirmed'
    }
  ],
  world: [
    {
      id: 'world_gate', kind: 'location', name: 'North Gate', aliases: ['Gate'],
      state: { open: false, guard: 'present' },
      fieldEvidence: { open: canonicalEvidence('open'), guard: canonicalEvidence('guard') }, certainty: 'confirmed'
    }
  ],
  narrative: normalizeCurrentNarrativeState({
    summary: 'The gate remains closed.', primaryArcId: 'arc_gate',
    arcs: [{ id: 'arc_gate', title: 'The Gate', status: 'active' }],
    threads: [{ id: 'thread_key', summary: 'Find the key', status: 'open' }],
    locks: [{ id: 'lock_truth', summary: 'The keeper is unknown', status: 'active' }],
    momentum: { direction: 'rising' },
    fieldEvidence: { summary: canonicalEvidence('narrative') }
  }),
  updatedAt: '2026-09-02T00:00:00.000Z'
});

const correction = (id, compiledAfter, after = {}) => ({
  schema: 'libra.state_correction.v1', correctionId: id, worldlineId: 'main',
  anchor: { throughTurn: 10 }, createdAt: `2026-09-02T00:0${id.length}:00.000Z`,
  policy: 'point_in_time_override', target: { domain: compiledAfter.domain }, after, compiledAfter
});

// A full-profile editor payload is compiled into changed fields + explicit clears only.
{
  const head = makeHead();
  const normalized = api.normalizeStateCorrectionPayload({
    patch: { characters: [{ id: 'char_ada', name: 'Ada', aliases: ['A'], state: { mood: 'focused', keeps: 'yes' } }] },
    target: { domain: 'characters', mode: 'profile_patch' }, head, anchorTurn: 10
  });
  assert.equal(normalized.compiledPatch.schema, 'libra.state_correction_patch.v2');
  assert.equal(normalized.compiledPatch.patches.length, 1);
  const patch = normalized.compiledPatch.patches[0];
  assert.deepEqual(clone(patch.set), { mood: 'focused' });
  assert.deepEqual(clone(patch.clear), ['location']);
  assert.ok(patch.expectedRecordHash);
  assert.ok(patch.expectedFieldHashes['state.mood']);
  assert.ok(patch.expectedFieldHashes['state.location']);
  assert.equal(Object.prototype.hasOwnProperty.call(patch.set, 'keeps'), false, 'unchanged fields must not be rewritten');

  const applied = api.applyCorrectionProfilePatch(head, correction('corr_profile', normalized.compiledPatch, normalized.patch));
  const ada = applied.characters.find(row => row.id === 'char_ada');
  assert.equal(ada.state.mood, 'focused');
  assert.equal(Object.prototype.hasOwnProperty.call(ada.state, 'location'), false);
  assert.equal(ada.state.keeps, 'yes');
  assert.deepEqual(clone(ada.fieldEvidence), clone(head.characters[0].fieldEvidence), 'canonical evidence must remain canonical');
  assert.equal(ada.fieldCorrectionProvenance.mood.correctionId, 'corr_profile');
  assert.equal(ada.clearedFieldCorrectionProvenance.location.correctionId, 'corr_profile');
  assert.equal(api.stateHeadHasCorrection(applied, 'corr_profile', 'characters'), true);
}

// The public/internal sparse form preserves omitted fields and clears only declared fields.
{
  const head = makeHead();
  const normalized = api.normalizeStateCorrectionPayload({
    patch: { characters: [{ id: 'char_ada', set: { mood: 'alert' }, clear: ['location'] }] },
    target: { domain: 'characters', mode: 'profile_patch' }, head, anchorTurn: 10
  });
  const patch = normalized.compiledPatch.patches[0];
  assert.deepEqual(clone(patch.set), { mood: 'alert' });
  assert.deepEqual(clone(patch.clear), ['location']);
  const applied = api.applyCorrectionProfilePatch(head, correction('corr_sparse', normalized.compiledPatch, normalized.patch));
  assert.equal(applied.characters[0].state.keeps, 'yes', 'sparse omission must preserve unrelated fields');
}

// Unknown identities and new relationships must fail before a correction can enter the journal.
{
  const head = makeHead();
  assert.throws(() => api.normalizeStateCorrectionPayload({
    patch: { characters: [{ id: 'char_missing', state: { mood: 'invented' } }] },
    target: { domain: 'characters' }, head, anchorTurn: 10
  }), error => error?.code === 'STATE_CORRECTION_PATCH_INVALID');
  assert.throws(() => api.normalizeStateCorrectionPayload({
    patch: { relationships: [{ subjectId: 'char_ada', targetId: 'char_missing', dimension: 'trust', state: 'invented' }] },
    target: { domain: 'relationships' }, head, anchorTurn: 10
  }), error => error?.code === 'STATE_CORRECTION_PATCH_INVALID');
}

// Relationship identity is immutable; only its current directional state may change.
{
  const head = makeHead();
  const normalized = api.normalizeStateCorrectionPayload({
    patch: { relationships: [{
      id: 'rel_ada_bea_trust', subjectId: 'char_ada', targetId: 'char_bea',
      dimension: 'trust', set: { value: 'trusted' }, clear: ['reason']
    }] },
    target: { domain: 'relationships' }, head, anchorTurn: 10
  });
  const applied = api.applyCorrectionProfilePatch(head, correction('corr_relation', normalized.compiledPatch, normalized.patch));
  assert.deepEqual(clone(applied.relationships[0].state), { value: 'trusted' });
  assert.equal(applied.relationships[0].fieldCorrectionProvenance.value.correctionId, 'corr_relation');
  assert.equal(applied.relationships[0].clearedFieldCorrectionProvenance.reason.correctionId, 'corr_relation');

  assert.throws(() => api.normalizeStateCorrectionPayload({
    patch: { relationships: [{
      id: 'rel_ada_bea_trust', subjectId: 'char_bea', targetId: 'char_ada', dimension: 'trust', state: 'reversed'
    }] },
    target: { domain: 'relationships' }, head, anchorTurn: 10
  }), error => error?.code === 'STATE_CORRECTION_RELATION_IDENTITY_CHANGE_FORBIDDEN');
}

// Narrative corrections are current-only: direct partial input preserves other current fields,
// and legacy history-only motifs/turningPoints cannot become a second narrative history.
{
  const head = makeHead();
  const normalized = api.normalizeStateCorrectionPayload({
    patch: { narrative: { summary: 'The gate begins to open.' } },
    target: { domain: 'narrative', mode: 'narrative_patch' }, head, anchorTurn: 10
  });
  const patch = normalized.compiledPatch.patches[0];
  assert.deepEqual(Array.from(Object.keys(patch.set)), ['summary']);
  const applied = api.applyCorrectionProfilePatch(head, correction('corr_narrative', normalized.compiledPatch, normalized.patch));
  assert.equal(applied.narrative.summary, 'The gate begins to open.');
  assert.deepEqual(clone(applied.narrative.arcs), clone(head.narrative.arcs));
  assert.deepEqual(clone(applied.narrative.threads), clone(head.narrative.threads));
  assert.deepEqual(clone(applied.narrative.locks), clone(head.narrative.locks));
  assert.equal(applied.narrative.fieldCorrectionProvenance.summary.correctionId, 'corr_narrative');
  assert.equal(Object.prototype.hasOwnProperty.call(applied.narrative, 'motifs'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(applied.narrative, 'turningPoints'), false);

  assert.throws(() => api.normalizeStateCorrectionPayload({
    patch: { narrative: {
      schema: 'libra.narrative_patch.v1',
      motifs: [{ op: 'upsert', id: 'motif_history', summary: 'must not persist' }],
      turningPoints: [{ op: 'upsert', id: 'turn_history', summary: 'must not persist' }]
    } },
    target: { domain: 'narrative', mode: 'narrative_patch' }, head, anchorTurn: 10
  }), error => error?.code === 'STATE_CORRECTION_NO_CHANGE');
}

// CAS rejects stale rows and multiple corrections retain independent field provenance.
{
  const head = makeHead();
  const firstNormalized = api.normalizeStateCorrectionPayload({
    patch: { characters: [{ id: 'char_ada', set: { mood: 'focused' } }] },
    target: { domain: 'characters' }, head, anchorTurn: 10
  });
  const stale = makeHead();
  stale.characters[0].state.location = 'courtyard';
  assert.throws(() => api.applyCorrectionProfilePatch(stale, correction('corr_stale', firstNormalized.compiledPatch, firstNormalized.patch)),
    error => error?.code === 'STATE_CORRECTION_STALE_RECORD');

  const first = api.applyCorrectionProfilePatch(head, correction('corr_first', firstNormalized.compiledPatch, firstNormalized.patch));
  const secondNormalized = api.normalizeStateCorrectionPayload({
    patch: { characters: [{ id: 'char_ada', set: { location: 'courtyard' } }] },
    target: { domain: 'characters' }, head: first, anchorTurn: 10
  });
  const second = api.applyCorrectionProfilePatch(first, correction('corr_second', secondNormalized.compiledPatch, secondNormalized.patch));
  const ada = second.characters.find(row => row.id === 'char_ada');
  assert.equal(ada.fieldCorrectionProvenance.mood.correctionId, 'corr_first');
  assert.equal(ada.fieldCorrectionProvenance.location.correctionId, 'corr_second');
  assert.deepEqual(Array.from(api.stateHeadCorrectionIds(second)).sort(), ['corr_first', 'corr_second']);
}

// An old ordinary correction without compiledAfter is safely compiled against existing identities;
// it may not fall back to the legacy identity-minting applier.
{
  const head = makeHead();
  const migrated = api.applyCorrectionProfilePatch(head, {
    correctionId: 'corr_legacy_safe', anchor: { throughTurn: 10 }, policy: 'point_in_time_override',
    target: { domain: 'characters' }, after: { characters: [{ id: 'char_ada', set: { mood: 'legacy-safe' } }] }
  });
  assert.equal(migrated.characters.find(row => row.id === 'char_ada').state.mood, 'legacy-safe');
  assert.throws(() => api.applyCorrectionProfilePatch(head, {
    correctionId: 'corr_legacy_invent', anchor: { throughTurn: 10 }, policy: 'point_in_time_override',
    target: { domain: 'characters' }, after: { characters: [{ name: 'Invented', state: { mood: 'new' } }] }
  }), error => error?.code === 'STATE_CORRECTION_PATCH_INVALID');
}

console.log(`libra_state_correction_sparse_v2_runtime_test: PASS (${path.basename(pluginPath)})`);
