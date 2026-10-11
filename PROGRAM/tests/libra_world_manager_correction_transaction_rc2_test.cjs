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

assert.ok(fs.existsSync(pluginPath), `LIBRA test source does not exist: ${pluginPath}`);
const source = fs.readFileSync(pluginPath, 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

// Load the production discriminator now read by both legacy correction entrypoints.
const unifiedEngineVersionSource = source.match(/const UNIFIED_ENGINE_VERSION\s*=\s*[^;]+;/)?.[0];
assert.ok(unifiedEngineVersionSource, 'production unified engine discriminator exists');
const unifiedArtifactSchemaSource = sourceSection('const UNIFIED_ARTIFACT_SCHEMA =', 'const UNIFIED_PATCH_SCHEMA =');

// The transaction records real completed-turn revision provenance. Load the
// deployed dependency even for an empty fixture batch, rather than a test copy.
const completedTurnRevisionSource = sourceSection('    const completedTurnRevisionId =', '    const completedTurnSourceRow =');
const microRefreshSource = sourceSection('    const refreshInheritedMicroStateAfterBasisWrite =', '    const rebuildCurrentStateForWorldline =');

const supportSource = sourceSection(
  'const stateCorrectionDefaultStore =',
  'const rebuildCurrentStateForWorldlineUnlocked ='
);
assert.doesNotMatch(source, /const saveContinuityOverrideLegacy = async/,
  'the retired duplicate continuity-override writer must stay removed');
const continuityOverrideSource = sourceSection(
  'const saveContinuityOverride = async',
  '/* Librarian System 0.3.14 · scope-native World Manager replay */'
);
assert.match(continuityOverrideSource, /await saveCanonicalManualStateDisposition\(\{ jobId, mode, patch, target \}\)/,
  'the public continuity override wrapper now saves the job-local manual state disposition');
assert.doesNotMatch(continuityOverrideSource, /enqueue\(/,
  'the job-local wrapper must not claim ownership of the legacy scope queue');
const replaySource = sourceSection(
  'const rebuildCurrentStateForWorldlineUnlocked =',
  'const rebuildCurrentStateForWorldline ='
);
const transactionSource = sourceSection(
  'const rollbackStateCorrectionMutation =',
  'const setStateWorldline ='
);
const appendSource = sourceSection(
  'const appendStateCorrection =',
  'const setStateCorrectionStatus ='
);
const statusSource = sourceSection(
  'const setStateCorrectionStatus =',
  'const setStateWorldline ='
);

const SCHEMAS = Object.freeze({
  correctionStore: 'libra.state.corrections.v2',
  correctionMeta: 'libra.state_correction_meta.v1',
  correctionCommit: 'libra.state_correction_commit.v1',
  correctionEvent: 'libra.state.correction.event.v2',
  worldlineMeta: 'libra.state.worldline.meta.v1',
  continuityOverride: 'libra.continuity.override.v1',
  replayError: 'libra.state.replay.error.v1',
  replayCache: 'libra.state.replay.cache.v1',
  continuityState: 'libra.continuity.state.v1',
  continuityBasis: 'libra.continuity_basis.v2'
});
const CONTINUITY_STATE_PROVENANCE_VERSION = 4;

const SCOPE_KEY = 'scope-a';
const ACTIVE_WORLDLINE = 'branch-a';
const SCOPE = Object.freeze({ scopeKey: SCOPE_KEY, chatId: 'chat-a' });
const KEYS = Object.freeze({
  corrections: `corrections:${SCOPE_KEY}`,
  correctionMeta: `correction-meta:${SCOPE_KEY}`,
  correctionCommit: `correction-commit:${SCOPE_KEY}`,
  overrides: `overrides:${SCOPE_KEY}`,
  head: `head:${SCOPE_KEY}`,
  cache: `cache:${SCOPE_KEY}`,
  errors: `errors:${SCOPE_KEY}`,
  worldline: `worldline:${SCOPE_KEY}`,
  manifest: `manifest:${SCOPE_KEY}`,
  memory: `memory:${SCOPE_KEY}:1-5`,
  delta: `delta:${SCOPE_KEY}:1-5`
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableReferenceJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  const text = typeof value === 'string' ? value : stableReferenceJson(value);
  return crypto.createHash('sha256').update(text).digest('hex');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function string(value) {
  return String(value == null ? '' : value);
}

function compact(value, limit = 1000) {
  return string(value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function continuityStateRefs(manifest) {
  return [
    ...asArray(manifest?.inheritedMemories),
    ...Object.values(asObject(manifest?.memories))
  ]
    .filter(ref => ref?.status === 'committed' && ref?.key)
    .map(ref => ({
      key: string(ref.key),
      deltaKey: string(ref.continuityDeltaKey || ref.deltaKey || ''),
      memoryId: string(ref.memoryId || ''),
      revision: Number(ref.revision || 0),
      sourceDigest: string(ref.sourceDigest || ''),
      sessionEpoch: Number(ref.sessionEpoch || 0),
      start: Number(ref?.turnRange?.start || 0),
      end: Number(ref?.turnRange?.end || 0),
      status: string(ref.status || '')
    }))
    .sort((left, right) => left.sessionEpoch - right.sessionEpoch || left.start - right.start);
}

function continuityStateFingerprint(refs) {
  return digest({ schema: SCHEMAS.continuityBasis, refs: asArray(refs) });
}

function continuityStateBasis(refsValue, extra = {}) {
  const refs = asArray(refsValue);
  return {
    schema: SCHEMAS.continuityBasis,
    fingerprintVersion: CONTINUITY_STATE_PROVENANCE_VERSION,
    sourceFingerprint: continuityStateFingerprint(refs),
    sourceCount: refs.length,
    ...clone(asObject(extra))
  };
}

function statePipelineReplayRefs(manifest) {
  return [
    ...asArray(manifest?.inheritedMemories),
    ...Object.values(asObject(manifest?.memories))
  ].filter(ref => ref?.status === 'committed' && ref?.key)
    .sort((left, right) => Number(left?.sessionEpoch || 0) - Number(right?.sessionEpoch || 0)
      || Number(left?.turnRange?.start || 0) - Number(right?.turnRange?.start || 0));
}
function statePipelineBasisCursor(basis) {
  return {
    key: string(basis?.key || basis?.memoryKey || ''),
    memoryId: string(basis?.memoryId || ''), revision: Number(basis?.revision || 0),
    sourceDigest: string(basis?.sourceDigest || ''),
    manualStateDispositionDigest: string(basis?.manualStateDispositionDigest || ''),
    manualAuthorityHash: string(basis?.manualAuthorityHash || ''),
    artifactSchema: string(basis?.artifactSchema || ''), artifactDigest: string(basis?.artifactDigest || ''),
    worldlineId: string(basis?.worldlineId || 'main'), logicalWorldlineId: string(basis?.logicalWorldlineId || basis?.worldlineId || 'main'),
    turnRange: clone(asObject(basis?.turnRange)), sessionEpoch: Number(basis?.sessionEpoch || 0),
    inheritedSessionHistory: basis?.inheritedSessionHistory === true || basis?.inherited === true,
    archiveShared: basis?.archiveShared === true,
    archiveId: string(basis?.archiveId || ''), archiveCanonicalId: string(basis?.archiveCanonicalId || ''),
    handoffTransferId: string(basis?.handoffTransferId || ''),
    sourceSessionScopeKey: string(basis?.sourceSessionScopeKey || ''), nativeCopiedFromScopeKey: string(basis?.nativeCopiedFromScopeKey || '')
  };
}
function statePipelineCursorForRef(ref, logicalWorldlineId = '') {
  return statePipelineBasisCursor({ ...asObject(ref), key: ref?.key, logicalWorldlineId: logicalWorldlineId || ref?.worldlineId || 'main' });
}
function statePipelineCursorMatchesRef(cursorValue, refValue, logicalWorldlineId = '') {
  return digest(statePipelineBasisCursor(cursorValue)) === digest(statePipelineCursorForRef(refValue, logicalWorldlineId));
}
function statePipelineManifestForExactRefs(manifest, refsValue) {
  const keys = new Set(asArray(refsValue).map(ref => string(ref?.key || '')).filter(Boolean));
  return {
    ...clone(manifest),
    inheritedMemories: asArray(manifest?.inheritedMemories).filter(ref => keys.has(string(ref?.key || ''))),
    memories: Object.fromEntries(Object.entries(asObject(manifest?.memories)).filter(([, ref]) => keys.has(string(ref?.key || ''))))
  };
}

function replayJournalDigest(store) {
  return digest(stableReferenceJson({
    scopeKey: string(store?.scopeKey || ''),
    records: asArray(store?.records),
    migratedLegacyOverrideIds: asArray(store?.migratedLegacyOverrideIds)
  }));
}

function replayFingerprint({ manifest, store, worldlineId, cutoffTurn }) {
  return digest(stableReferenceJson({
    schema: 'libra.state_replay.v2',
    fingerprintVersion: CONTINUITY_STATE_PROVENANCE_VERSION,
    worldlineId,
    cutoffTurn,
    refs: continuityStateRefs(manifest),
    corrections: asArray(store?.records).map(row => ({
      correctionId: row.correctionId,
      worldlineId: row.worldlineId,
      anchor: clone(row.anchor),
      basisFingerprint: row.basisFingerprint,
      basisVersion: Number(row.basisVersion || 0),
      target: clone(row.target),
      after: clone(row.after),
      compiledAfter: clone(row.compiledAfter),
      patchSchema: string(row.patchSchema || ''),
      policy: row.policy,
      status: row.status,
      suspensionReason: string(row.suspensionReason || ''),
      updatedAt: row.updatedAt
    })),
    branchGuard: clone(manifest?.branchGuard || {})
  }));
}

const MANIFEST = Object.freeze({
  schema: 'libra.manifest.fixture.v1',
  scopeKey: SCOPE_KEY,
  branchGuard: { branchId: 'fixture-branch', revision: 3 },
  inheritedMemories: [],
  memories: {
    first: {
      status: 'committed',
      key: KEYS.memory,
      continuityDeltaKey: KEYS.delta,
      memoryId: 'memory-1-5',
      revision: 2,
      sourceDigest: 'source-1-5',
      sessionEpoch: 1,
      turnRange: { start: 1, end: 5 }
    }
  }
});

const BASIS_FINGERPRINT = continuityStateFingerprint(continuityStateRefs(MANIFEST));

function makeHead() {
  return {
    schema: SCHEMAS.continuityState,
    scopeKey: SCOPE_KEY,
    worldlineId: ACTIVE_WORLDLINE,
    throughTurn: 5,
    basis: { sourceFingerprint: BASIS_FINGERPRINT, sourceCount: 1, replayFingerprint: 'baseline-replay' },
    reviewedThroughCanonical: statePipelineCursorForRef(MANIFEST.memories.first, ACTIVE_WORLDLINE),
    source: { key: KEYS.memory, turnRange: { start: 1, end: 5 } },
    characters: [
      { id: 'char-a', name: 'Ada', aliases: ['A'], state: { mood: 'calm' } },
      { id: 'char-b', name: 'Ben', aliases: ['B'], state: { mood: 'alert' } }
    ],
    relationships: [],
    world: [],
    narrative: { arcs: [], threads: [], locks: [], motifs: [], turningPoints: [] },
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function makeWorldlineMeta() {
  return {
    schema: SCHEMAS.worldlineMeta,
    scopeKey: SCOPE_KEY,
    activeWorldlineId: ACTIVE_WORLDLINE,
    revision: 7,
    worldlines: {
      main: { id: 'main', parentId: null, forkTurn: 0, cutoffTurn: null, active: false },
      [ACTIVE_WORLDLINE]: { id: ACTIVE_WORLDLINE, parentId: 'main', forkTurn: 5, cutoffTurn: null, active: true }
    },
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function makeJournal(records = []) {
  return {
    schema: SCHEMAS.correctionStore,
    scopeKey: SCOPE_KEY,
    revision: 4,
    records: clone(records),
    migratedLegacyOverrideIds: [],
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function makeCorrection(overrides = {}) {
  return {
    schema: SCHEMAS.correctionEvent,
    correctionId: 'correction-existing',
    scopeKey: SCOPE_KEY,
    worldlineId: ACTIVE_WORLDLINE,
    anchor: { throughTurn: 5 },
    basisFingerprint: BASIS_FINGERPRINT,
    basisVersion: CONTINUITY_STATE_PROVENANCE_VERSION,
    target: { domain: 'characters', mode: 'profile_patch' },
    before: null,
    after: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'steady' } }] },
    policy: 'point_in_time_override',
    status: 'active',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...clone(overrides)
  };
}

function makeInitialRaw(records = []) {
  return new Map([
    [KEYS.corrections, JSON.stringify(makeJournal(records))],
    [KEYS.head, JSON.stringify(makeHead())],
    [KEYS.cache, JSON.stringify({
      schema: SCHEMAS.replayCache,
      scopeKey: SCOPE_KEY,
      worldlineId: ACTIVE_WORLDLINE,
      fingerprint: 'baseline-replay',
      throughTurn: 5,
      appliedDeltas: 1,
      appliedCorrections: [],
      reason: 'fixture',
      updatedAt: '2026-08-31T00:00:00.000Z'
    })],
    [KEYS.worldline, JSON.stringify(makeWorldlineMeta())],
    [KEYS.manifest, JSON.stringify(MANIFEST)],
    [KEYS.memory, JSON.stringify({ schema: 'canonical-memory', memoryId: 'memory-1-5', text: 'immutable memory fixture' })],
    [KEYS.delta, JSON.stringify({ schema: 'canonical-delta', memoryId: 'memory-1-5', changes: [{ type: 'fixture' }] })]
  ]);
}

function makeStorage(raw, hooks, stats) {
  return {
    async getJson(storageKey, fallback = null) {
      stats.reads += 1;
      if (hooks.failNextGetKey === storageKey) {
        hooks.failNextGetKey = '';
        const error = new Error(`fixture baseline read failed: ${storageKey}`);
        error.code = 'FIXTURE_BASELINE_READ_FAILED';
        throw error;
      }
      if (!raw.has(storageKey)) return clone(fallback);
      return JSON.parse(raw.get(storageKey));
    },
    async setJson(storageKey, value) {
      if (storageKey === KEYS.corrections) stats.journalWrites += 1;
      if (storageKey === KEYS.head) stats.headWrites += 1;
      if (storageKey === KEYS.cache) stats.cacheWrites += 1;

      if (storageKey === KEYS.corrections && hooks.corruptNextJournalWrite) {
        hooks.corruptNextJournalWrite = false;
        const corrupted = clone(value);
        corrupted.records = asArray(corrupted.records).slice(0, -1);
        raw.set(storageKey, JSON.stringify(corrupted));
        return;
      }
      if (storageKey === KEYS.head && hooks.keepStaleOnNextHeadWrite) {
        hooks.keepStaleOnNextHeadWrite = false;
        return;
      }
      raw.set(storageKey, JSON.stringify(value));
    },
    async remove(storageKey) {
      stats.removeCalls += 1;
      raw.delete(storageKey);
    }
  };
}

function buildHarness({ records = [], hooks: hookValues = {}, rebuild = null, actualReplay = false } = {}) {
  const raw = makeInitialRaw(records);
  const hooks = {
    corruptNextJournalWrite: false,
    keepStaleOnNextHeadWrite: false,
    failNextGetKey: '',
    boundaryConflictOnSecondManifestLoad: false,
    externalHead: null,
    ...hookValues
  };
  const stats = {
    journalWrites: 0,
    headWrites: 0,
    cacheWrites: 0,
    replayCalls: 0,
    enqueueCalls: 0,
    idleChecks: 0,
    reads: 0,
    removeCalls: 0,
    manifestLoads: 0
  };
  const storage = makeStorage(raw, hooks, stats);
  const state = {
    disposed: false,
    deletingScopes: new Set(),
    lastContinuityState: makeHead(),
    snapshot: { scope: clone(SCOPE), continuityState: makeHead() }
  };
  let nowTick = 0;
  let idTick = 0;

  const context = {
    console,
    STATE_CORRECTION_STORE_SCHEMA: SCHEMAS.correctionStore,
    STATE_CORRECTION_META_SCHEMA: SCHEMAS.correctionMeta,
    STATE_CORRECTION_COMMIT_SCHEMA: SCHEMAS.correctionCommit,
    STATE_CORRECTION_EVENT_SCHEMA: SCHEMAS.correctionEvent,
    STATE_CORRECTION_PATCH_SCHEMA: 'libra.state_correction_patch.v2',
    CURRENT_NARRATIVE_STATE_SCHEMA: 'libra.narrative_current_state.v2',
    STATE_WORLDLINE_META_SCHEMA: SCHEMAS.worldlineMeta,
    CONTINUITY_OVERRIDE_SCHEMA: SCHEMAS.continuityOverride,
    STATE_REPLAY_ERROR_SCHEMA: SCHEMAS.replayError,
    STATE_REPLAY_CACHE_SCHEMA: SCHEMAS.replayCache,
    CONTINUITY_STATE_SCHEMA: SCHEMAS.continuityState,
    CONTINUITY_STATE_PROVENANCE_VERSION,
    CONTINUITY_STATE_BASIS_SCHEMA: SCHEMAS.continuityBasis,
    STATE_CORRECTION_STATUSES: ['active', 'disabled', 'deleted', 'superseded', 'suspended', 'dormant_after_rollback'],
    CONTINUITY_STATE_RELATION_DIMENSIONS: ['trust', 'affection', 'conflict', 'power', 'other'],
    CONTINUITY_STATE_MAX_CHARACTERS: 128,
    CONTINUITY_STATE_MAX_RELATIONSHIPS: 256,
    CONTINUITY_STATE_MAX_WORLD_RECORDS: 256,
    storage,
    key: {
      stateCorrections: () => KEYS.corrections,
      stateCorrectionMeta: () => KEYS.correctionMeta,
      stateCorrectionCommit: () => KEYS.correctionCommit,
      continuityOverrides: () => KEYS.overrides,
      continuityState: () => KEYS.head,
      entityRegistry: () => `registry:${SCOPE_KEY}`,
      stateReplayCache: () => KEYS.cache,
      stateReplayErrors: () => KEYS.errors,
      stateWorldlineMeta: () => KEYS.worldline
    },
    clone,
    asArray,
    asObject,
    isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    string,
    compact,
    stableReferenceJson,
    digest,
    statePipelineStableObject: stableValue,
    statePipelineSemanticValue: (_field, value) => stableValue(value),
    statePipelineSemanticEqual: (_field, left, right) => JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right)),
    normalizeCurrentNarrativeState: value => ({
      schema: 'libra.narrative_current_state.v2', summary: string(value?.summary || ''),
      primaryArcId: string(value?.primaryArcId || ''), arcs: clone(asArray(value?.arcs)),
      threads: clone(asArray(value?.threads)), locks: clone(asArray(value?.locks)),
      momentum: clone(value?.momentum || ''), fieldEvidence: clone(asObject(value?.fieldEvidence)),
      clearedFieldEvidence: clone(asObject(value?.clearedFieldEvidence)),
      fieldCorrectionProvenance: clone(asObject(value?.fieldCorrectionProvenance)),
      clearedFieldCorrectionProvenance: clone(asObject(value?.clearedFieldCorrectionProvenance)),
      correctionProvenance: value?.correctionProvenance ? clone(value.correctionProvenance) : null
    }),
    nowIso: () => `2026-08-31T00:00:${String(nowTick++).padStart(2, '0')}.000Z`,
    continuityStateRefs,
    continuityStateFingerprint,
    continuityStateBasis,
    statePipelineReplayRefs,
    statePipelineBasisCursor,
    statePipelineCursorForRef,
    statePipelineCursorMatchesRef,
    statePipelineManifestForExactRefs,
    continuityStateNameKey: name => compact(name, 180).toLocaleLowerCase(),
    continuityEntityId: (_scope, type, seed) => `${type}:${digest(seed).slice(0, 12)}`,
    normalizeContinuityStateSet: value => clone(asObject(value)),
    continuityStateAliases: value => asArray(value).map(string).filter(Boolean),
    __libraNarrativeNormalizePatch: value => {
      const patch = clone(asObject(value));
      const hasRows = ['arcs', 'threads', 'locks', 'motifs', 'turningPoints']
        .some(keyName => Array.isArray(patch[keyName]) && patch[keyName].length > 0);
      return hasRows ? { ok: true, patch } : { ok: false, reason: 'empty_narrative_patch' };
    },
    __libraNarrativeApplyPatch: (current, patch) => ({ ...clone(asObject(current)), ...clone(patch) }),
    resolveContext: async () => ({ scope: clone(SCOPE), chat: [] }),
    buildPairs: () => [],
    // This legacy transaction fixture has no inherited Micro graph. Its explicit
    // failure seam proves derived admission failure cannot undo the committed
    // correction; production refresh handles that result observationally.
    admitInheritedMicroStateClaims: async () => { throw Error('FIXTURE_INHERITED_MICRO_NOT_BOUND'); },
    loadManifest: async () => {
      stats.manifestLoads += 1;
      if (hooks.boundaryConflictOnSecondManifestLoad && stats.manifestLoads === 2) {
        raw.set(KEYS.head, JSON.stringify(hooks.externalHead || makeHead()));
        const changed = clone(MANIFEST);
        changed.branchGuard.revision = Number(changed.branchGuard.revision || 0) + 1;
        return changed;
      }
      return clone(MANIFEST);
    },
    loadMemoryRef: async () => JSON.parse(raw.get(KEYS.memory)),
    loadContinuityDelta: async () => JSON.parse(raw.get(KEYS.delta)),
    updateContinuityStateAfterCommit: async () => ({
      head: {
        ...makeHead(),
        characters: clone(makeHead().characters),
        updatedAt: '2026-08-31T00:00:30.000Z'
      }
    }),
    emptyContinuityState: () => ({
      schema: SCHEMAS.continuityState,
      scopeKey: SCOPE_KEY,
      worldlineId: ACTIVE_WORLDLINE,
      throughTurn: 0,
      basis: { sourceFingerprint: '', sourceCount: 0, replayFingerprint: '' },
      source: null,
      characters: [], relationships: [], world: [],
      narrative: { arcs: [], threads: [], locks: [], motifs: [], turningPoints: [] }
    }),
    id: prefix => `${prefix}-${++idTick}`,
    enqueue: async (_scopeKey, task) => {
      stats.enqueueCalls += 1;
      return await task();
    },
    assertPortableMemoryIdle: () => {
      stats.idleChecks += 1;
      return true;
    },
    state,
    sameSnapshotScope: (left, right) => string(left?.scopeKey) === string(right?.scopeKey),
    warn: () => {}
  };

  if (!actualReplay) {
    context.rebuildCurrentStateForWorldlineUnlocked = async options => {
      stats.replayCalls += 1;
      if (rebuild) return await rebuild({ options, raw, storage, state, stats });
      return { ok: false, code: 'FIXTURE_REPLAY_FAILED', error: 'fixture replay failed' };
    };
  }

  Object.assign(context, require('./fixtures/librarian_production_bindings.cjs')(source));
  vm.createContext(context);
  const exportsExpression = actualReplay
    ? 'globalThis.__testExports={rebuildCurrentStateForWorldlineUnlocked,loadStateCorrectionJournal,stateReplayBoundaryFingerprint};'
    : 'globalThis.__testExports={appendStateCorrection,setStateCorrectionStatus,loadStateCorrectionJournal,stateHeadHasCorrection,stateReplayBoundaryFingerprint};';
  const evaluatedSource = actualReplay
    ? `${unifiedArtifactSchemaSource}\n${supportSource}\n${replaySource}\n${exportsExpression}`
    : `${unifiedEngineVersionSource}\n${supportSource}\n${transactionSource}\n${exportsExpression}`;
  vm.runInContext(completedTurnRevisionSource + "\n" + (actualReplay ? "" : microRefreshSource) + "\n" + evaluatedSource, context, { filename: pluginPath });

  return { ...context.__testExports, raw, storage, state, stats, hooks };
}

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to reject');
}

function parsed(raw, storageKey) {
  return raw.has(storageKey) ? JSON.parse(raw.get(storageKey)) : null;
}

function canonicalRawSnapshot(raw) {
  return {
    manifest: raw.get(KEYS.manifest),
    memory: raw.get(KEYS.memory),
    delta: raw.get(KEYS.delta)
  };
}

async function testJournalSemanticMismatchRollsBack() {
  const harness = buildHarness({ hooks: { corruptNextJournalWrite: true } });
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const error = await caught(harness.appendStateCorrection({
    patch: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'focused' } }] },
    anchorTurn: 5,
    target: { domain: 'characters' }
  }));
  assert.equal(error.code, 'STATE_CORRECTION_TRANSACTION_FAILED');
  assert.equal(error.cause?.code, 'STATE_CORRECTION_JOURNAL_READBACK_FAILED');
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  assert.equal(harness.stats.replayCalls, 0);
}

async function testReplayFailureRollsBackAllMutableState() {
  const harness = buildHarness({ rebuild: async () => ({ ok: false, code: 'REPLAY_FIXTURE_REJECTED', error: 'fixture replay rejected' }) });
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const snapshotBefore = clone(harness.state.snapshot);
  const error = await caught(harness.appendStateCorrection({
    patch: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'focused' } }] },
    anchorTurn: 5,
    target: { domain: 'characters' }
  }));
  assert.equal(error.code, 'STATE_CORRECTION_TRANSACTION_FAILED');
  assert.equal(error.cause?.code, 'REPLAY_FIXTURE_REJECTED');
  assert.equal(harness.stats.replayCalls, 1);
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  assert.deepEqual(harness.state.snapshot, snapshotBefore);
}

async function testActualReplayRejectsStaleSameScopeHead() {
  const harness = buildHarness({ actualReplay: true, hooks: { keepStaleOnNextHeadWrite: true } });
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const snapshotBefore = clone(harness.state.snapshot);
  const result = await harness.rebuildCurrentStateForWorldlineUnlocked({
    context: { scope: clone(SCOPE), chat: [] },
    manifest: clone(MANIFEST),
    pairs: [],
    worldlineId: ACTIVE_WORLDLINE,
    persist: true,
    reason: 'stale-head-fixture'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATE_REPLAY_HEAD_READBACK_FAILED');
  assert.equal(result.restoredPrevious, true);
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  assert.deepEqual(harness.state.snapshot, snapshotBefore);
}

async function testSupersedingAppendFailureRestoresOriginal() {
  const existing = makeCorrection();
  const harness = buildHarness({ records: [existing] });
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const error = await caught(harness.appendStateCorrection({
    patch: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'focused' } }] },
    anchorTurn: 5,
    target: { domain: 'characters' },
    supersedes: existing.correctionId
  }));
  assert.equal(error.code, 'STATE_CORRECTION_TRANSACTION_FAILED');
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  const restored = parsed(harness.raw, KEYS.corrections).records;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, 'active');
  assert.equal('supersededBy' in restored[0], false);
}

async function testStatusFailureRestoresOriginalStatus() {
  const existing = makeCorrection();
  const harness = buildHarness({ records: [existing] });
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const error = await caught(harness.setStateCorrectionStatus(existing.correctionId, 'disabled'));
  assert.equal(error.code, 'STATE_CORRECTION_TRANSACTION_FAILED');
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  assert.equal(parsed(harness.raw, KEYS.corrections).records[0].status, 'active');
}

async function testCanonicalRawBoundaryAndStaticMutationSurface() {
  for (const forbidden of ['key.manifest(', 'key.memory(', 'key.continuityDelta(', 'key.delta(']) {
    assert.equal((appendSource + statusSource).includes(forbidden), false, `transaction path must not write canonical artifact via ${forbidden}`);
  }
  const harness = buildHarness();
  const before = canonicalRawSnapshot(harness.raw);
  await caught(harness.appendStateCorrection({
    patch: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'focused' } }] },
    anchorTurn: 5,
    target: { domain: 'characters' }
  }));
  assert.deepEqual(canonicalRawSnapshot(harness.raw), before);
}

async function testSuccessfulAppendIsAtomicAndUsesActiveNonMainWorldline() {
  const harness = buildHarness({
    rebuild: async ({ options, raw, storage }) => {
      const journal = parsed(raw, KEYS.corrections);
      const correction = journal.records.at(-1);
      const durableReplayFingerprint = replayFingerprint({
        manifest: MANIFEST,
        store: journal,
        worldlineId: options.worldlineId,
        cutoffTurn: null
      });
      const head = makeHead();
      head.characters = head.characters.map(character => character.id === 'char-a'
        ? {
            ...character,
            state: clone(correction.after.characters[0].state),
            certainty: 'user_corrected',
            correctionProvenance: {
              schema: SCHEMAS.correctionEvent,
              correctionId: correction.correctionId,
              anchor: clone(correction.anchor),
              createdAt: correction.createdAt,
              policy: correction.policy
            }
          }
        : character);
      head.basis.replayFingerprint = durableReplayFingerprint;
      head.updatedAt = '2026-08-31T00:00:45.000Z';
      await storage.setJson(KEYS.head, head);
      await storage.setJson(KEYS.cache, {
        schema: SCHEMAS.replayCache,
        scopeKey: SCOPE_KEY,
        worldlineId: options.worldlineId,
        fingerprint: head.basis.replayFingerprint,
        throughTurn: 5,
        appliedDeltas: 1,
        appliedCorrections: [correction.correctionId],
        reason: options.reason,
        updatedAt: head.updatedAt
      });
      return {
        ok: true,
        head: clone(head),
        worldlineId: options.worldlineId,
        appliedDeltas: 1,
        appliedCorrections: [correction.correctionId],
        replayFingerprint: head.basis.replayFingerprint,
        replayJournalDigest: replayJournalDigest(journal)
      };
    }
  });
  const canonicalBefore = canonicalRawSnapshot(harness.raw);
  const result = await harness.appendStateCorrection({
    patch: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'focused' } }] },
    anchorTurn: 5,
    target: { domain: 'characters' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.activeMicroStateAdmission.status, 'ready');
  assert.equal(result.inheritedMicroStateAdmission.status, 'pending_reconciliation');
  assert.equal(result.inheritedMicroStateAdmission.reason, 'FIXTURE_INHERITED_MICRO_NOT_BOUND');
  assert.equal(harness.stats.replayCalls, 1);
  assert.equal(harness.stats.enqueueCalls, 1);
  assert.equal(harness.stats.idleChecks, 1);
  assert.equal(result.worldlineId, ACTIVE_WORLDLINE);
  assert.equal(result.correction.worldlineId, ACTIVE_WORLDLINE);
  assert.deepEqual(result.replay.appliedCorrections, [result.correction.correctionId]);

  const durableJournal = parsed(harness.raw, KEYS.corrections);
  const durableCorrection = durableJournal.records.find(row => row.correctionId === result.correction.correctionId);
  assert.deepEqual(durableCorrection, result.correction);
  const durableHead = parsed(harness.raw, KEYS.head);
  assert.deepEqual(durableHead, result.head);
  assert.deepEqual(result.currentHead, result.head);
  assert.equal(durableHead.characters.find(row => row.id === 'char-a').correctionProvenance.correctionId, result.correction.correctionId);
  const durableCache = parsed(harness.raw, KEYS.cache);
  assert.deepEqual(durableCache.appliedCorrections, [result.correction.correctionId]);
  assert.equal(durableCache.worldlineId, ACTIVE_WORLDLINE);
  assert.deepEqual(canonicalRawSnapshot(harness.raw), canonicalBefore);
  assert.equal((appendSource.match(/rebuildCurrentStateForWorldlineUnlocked/g) || []).length, 1);
}

async function assertPrewriteReject(options) {
  const harness = buildHarness();
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const canonicalBefore = canonicalRawSnapshot(harness.raw);
  const error = await caught(harness.appendStateCorrection({ anchorTurn: 5, ...options }));
  assert.equal(error.code, 'STATE_CORRECTION_PATCH_INVALID');
  assert.equal(harness.stats.journalWrites, 0);
  assert.equal(harness.stats.replayCalls, 0);
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  assert.deepEqual(canonicalRawSnapshot(harness.raw), canonicalBefore);
}

async function testTargetPatchMismatchRejectsBeforeWrite() {
  await assertPrewriteReject({
    target: { domain: 'characters' },
    patch: { world: [{ id: 'place-a', name: 'Atrium', state: { open: true } }] }
  });
}

async function testEmptyPatchRejectsBeforeWrite() {
  await assertPrewriteReject({ target: { domain: 'characters' }, patch: { characters: [] } });
}

async function testInvalidRelationshipRejectsBeforeWrite() {
  await assertPrewriteReject({
    target: { domain: 'relationships' },
    patch: { relationships: [{ subjectId: 'char-a', targetId: 'missing-character', dimension: 'trust', state: 'high' }] }
  });
}

async function testBaselineReadFailureIsNotConvertedToAbsenceOrRemove() {
  const harness = buildHarness({ hooks: { failNextGetKey: KEYS.head } });
  const before = rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]);
  const canonicalBefore = canonicalRawSnapshot(harness.raw);
  const error = await caught(harness.appendStateCorrection({
    patch: { characters: [{ id: 'char-a', name: 'Ada', state: { mood: 'focused' } }] },
    anchorTurn: 5,
    target: { domain: 'characters' }
  }));
  assert.equal(error.code, 'FIXTURE_BASELINE_READ_FAILED');
  assert.equal(harness.stats.removeCalls, 0);
  assert.equal(harness.stats.journalWrites, 0);
  assert.equal(harness.stats.replayCalls, 0);
  assert.deepEqual(rawSnapshot(harness.raw, [KEYS.corrections, KEYS.head, KEYS.cache]), before);
  assert.deepEqual(canonicalRawSnapshot(harness.raw), canonicalBefore);
}

async function testBoundaryConflictPreservesExternalHeadAndReportsIncompleteRollback() {
  const externalHead = makeHead();
  externalHead.characters[0].state = { mood: 'externally-updated' };
  externalHead.basis.replayFingerprint = 'external-replay-fingerprint';
  externalHead.updatedAt = '2026-08-31T00:01:30.000Z';
  const harness = buildHarness({
    actualReplay: true,
    hooks: {
      boundaryConflictOnSecondManifestLoad: true,
      externalHead
    }
  });
  const journalBefore = harness.raw.get(KEYS.corrections);
  const cacheBefore = harness.raw.get(KEYS.cache);
  const result = await harness.rebuildCurrentStateForWorldlineUnlocked({
    context: { scope: clone(SCOPE), chat: [] },
    manifest: clone(MANIFEST),
    pairs: [],
    worldlineId: ACTIVE_WORLDLINE,
    persist: true,
    reason: 'external-head-boundary-conflict'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATE_CORRECTION_ROLLBACK_INCOMPLETE');
  assert.equal(result.rollbackIncomplete, true);
  assert.equal(result.restoredPrevious, false);
  assert.equal(harness.raw.get(KEYS.head), JSON.stringify(externalHead));
  assert.equal(harness.raw.get(KEYS.corrections), journalBefore);
  assert.equal(harness.raw.get(KEYS.cache), cacheBefore);
  assert.equal(harness.stats.manifestLoads, 2);
  assert.equal(harness.stats.headWrites, 1, 'rollback must not overwrite the conflicting external Head');
}

function rawSnapshot(raw, keys) {
  return Object.fromEntries(keys.map(storageKey => [storageKey, raw.get(storageKey)]));
}

const tests = [
  ['journal semantic mismatch rejects and restores journal', testJournalSemanticMismatchRollsBack],
  ['replay ok:false rejects and restores journal/head/cache/snapshot', testReplayFailureRollsBackAllMutableState],
  ['same-scope stale/no-op head is rejected by actual replay readback', testActualReplayRejectsStaleSameScopeHead],
  ['superseding append failure restores original record', testSupersedingAppendFailureRestoresOriginal],
  ['set-status failure restores original status', testStatusFailureRestoresOriginalStatus],
  ['canonical memory/manifest/delta raw boundary remains immutable', testCanonicalRawBoundaryAndStaticMutationSurface],
  ['successful append replays exactly once with durable active-worldline provenance', testSuccessfulAppendIsAtomicAndUsesActiveNonMainWorldline],
  ['target/patch mismatch is rejected before journal write', testTargetPatchMismatchRejectsBeforeWrite],
  ['empty target patch is rejected before journal write', testEmptyPatchRejectsBeforeWrite],
  ['invalid relationship is rejected before journal write', testInvalidRelationshipRejectsBeforeWrite],
  ['baseline read failure is surfaced without absence/remove conversion', testBaselineReadFailureIsNotConvertedToAbsenceOrRemove],
  ['boundary conflict preserves external Head and reports rollback-incomplete', testBoundaryConflictPreservesExternalHeadAndReportsIncompleteRollback]
];

(async () => {
  const failures = [];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`FAIL ${name}`);
      console.error(error?.stack || error);
    }
  }
  console.log(`source: ${pluginPath}`);
  console.log(`result: ${tests.length - failures.length}/${tests.length} passed`);
  if (failures.length) process.exitCode = 1;
})();
