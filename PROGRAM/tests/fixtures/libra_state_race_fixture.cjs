'use strict';
// Execute the production pure/reducer/orchestrator blocks; host/storage/provider
// are explicit boundaries, not a reimplementation of state application.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../plugins/LIBRA.js'),'utf8');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 900) => string(value).slice(0, limit);
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
const stableHash = value => digest(value).slice(0, 24);

const createStateRaceFixture = async () => {
  const pureStart = source.indexOf('/* LIBRA CANONICAL STATE PIPELINE V3 START */');
  const pureEndMarker = '/* LIBRA CANONICAL STATE PIPELINE V3 PURE CORE END */';
  const pureEnd = source.indexOf(pureEndMarker, pureStart);
  const runtimeStart = source.indexOf('/* LIBRA CANONICAL STATE PIPELINE V3 RUNTIME START */');
  const runtimeEndMarker = '/* LIBRA CANONICAL STATE PIPELINE V3 RUNTIME END */';
  const runtimeEnd = source.indexOf(runtimeEndMarker, runtimeStart);
  assert.ok(pureStart >= 0 && pureEnd > pureStart && runtimeStart >= 0 && runtimeEnd > runtimeStart,
    'isolated state pipeline markers are required');
  const pureCore = source.slice(pureStart, pureEnd + pureEndMarker.length);
  const runtimeCore = source.slice(runtimeStart, runtimeEnd + runtimeEndMarker.length);

  const scope = { scopeKey: 'scope:test' };
  const contextValue = { scope };
  const memoryKey = 'memory:6:2';
  const artifact = {
    schema: 'libra.canonical_artifact.v3',
    chronology: [], relationships: [], uncertainties: [], recallTerms: [],
    openThreads: [{ assertionId: 'n1', thread: 'The locked door remains unresolved.', evidenceRefs: ['t10-a'], temporalRole: 'current_sequence' }],
    characters: [{ assertionId: 'c1', name: 'Alice', aliases: [], evidenceRefs: ['t10-a'], temporalRole: 'current_sequence', fact: 'Alice remains in the room.' }],
    world: [{ assertionId: 'w1', kind: 'location', name: 'Room', aliases: [], evidenceRefs: ['t10-a'], temporalRole: 'current_sequence', state: 'The lamp remains on.' }]
  };
  const artifactDigest = digest(artifact);
  const memory = {
    schema: 'libra.canonical_memory.v1', status: 'committed', scopeKey: scope.scopeKey,
    worldlineId: 'main', memoryId: 'mem_000006', revision: 2,
    turnRange: { start: 6, end: 10 }, sourceDigest: 'source-2', artifactDigest,
    canonicalArtifact: artifact
  };
  const activeRef = {
    status: 'committed', key: memoryKey, memoryId: memory.memoryId, revision: memory.revision,
    turnRange: clone(memory.turnRange), sourceDigest: memory.sourceDigest,
    worldlineId: memory.worldlineId, artifactDigest
  };
  const priorRef = {
    status: 'committed', key: 'memory:1:1', memoryId: 'mem_000001', revision: 1,
    turnRange: { start: 1, end: 5 }, sourceDigest: 'source-1', worldlineId: 'main', artifactDigest: 'artifact-1'
  };
  const manifest = { schema: 'libra.manifest.v1', memories: { 1: priorRef, 6: activeRef } };
  const keys = {
    manifest: current => `manifest:${current.scopeKey}`,
    entityRegistry: current => `registry:${current.scopeKey}`,
    stateObservation: (current, memoryId, revision, domain) => `observation:${current.scopeKey}:${memoryId}:${revision}:${domain}`,
    statePipelineReceipt: (current, memoryId, revision) => `receipt:${current.scopeKey}:${memoryId}:${revision}`,
    continuityState: current => `head:${current.scopeKey}`
  };
  const initialHead = {
    schema: 'libra.continuity_state.v2', scopeKey: scope.scopeKey, worldlineId: 'main',
    characters: [], relationships: [], world: [],
    narrative: { summary: '', arcs: [], threads: [], locks: [], momentum: '' },
    domainStatus: {
      characters: { reviewedThroughCanonical: clone(priorRef), reviewedThroughTurn: 5 },
      world: { reviewedThroughCanonical: clone(priorRef), reviewedThroughTurn: 5 },
      narrative: { reviewedThroughCanonical: clone(priorRef), reviewedThroughTurn: 5 }
    },
    status: 'ready'
  };
  const store = new Map([
    [memoryKey, clone(memory)],
    [keys.manifest(scope), clone(manifest)],
    [keys.continuityState(scope), clone(initialHead)]
  ]);
  const storage = {
    getJson: async (keyName, fallback = null) => store.has(keyName) ? clone(store.get(keyName)) : clone(fallback),
    setJson: async (keyName, value) => { store.set(keyName, clone(value)); }
  };
  const providerStages = [];
  const isolated = {
    Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Set, Map, Promise,
    structuredClone: globalThis.structuredClone,
    clone, safeClone: clone, asObject, asArray,
    isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    string, text: string, compact, digest, stableHash,
    nowIso: () => '2026-09-01T00:00:00.000Z',
    CANONICAL_COMMIT_SCHEMA: 'libra.canonical_commit.v1',
    CANONICAL_ARTIFACT_SCHEMA: 'libra.canonical_artifact.v3',
    CANONICAL_ARTIFACT_LEGACY_SCHEMA: 'libra.canonical_artifact.v2',
    MEMORY_SCHEMA: 'libra.canonical_memory.v1', MANIFEST_SCHEMA: 'libra.manifest.v1',
    ENTITY_REGISTRY_SCHEMA: 'libra.entity_registry.v2', STATE_OBSERVATION_SCHEMA: 'libra.state_observation.v2',
    STATE_PIPELINE_RECEIPT_SCHEMA: 'libra.state_pipeline_receipt.v1',
    CONTINUITY_STATE_SCHEMA: 'libra.continuity_state.v2',
    CONTINUITY_STATE_PROVENANCE_VERSION: 4,
    CONTINUITY_STATE_BASIS_SCHEMA: 'libra.continuity_basis.v2',
    CONTINUITY_STATE_RELATION_DIMENSIONS: Object.freeze([
      'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
      'cooperation', 'authority', 'dependency', 'knowledge', 'other'
    ]),
    STAGE_DEF_MAP: {}, storage, key: keys,
    loadStateWorldlineMeta: async () => ({ activeWorldlineId: 'main' }),
    memoryRefForStart: (manifestValue, startTurn) => clone(manifestValue?.memories?.[String(startTurn)] || null),
    normalizeCanonicalArtifactForRead: value => {
      const normalized = clone(value);
      if (normalized?.schema === 'libra.canonical_artifact.v2') {
        normalized.legacySchema = normalized.schema;
        normalized.schema = 'libra.canonical_artifact.v3';
        delete normalized.state;
      }
      return normalized;
    },
    loadSettings: async () => ({
      stateTracking: {
        enabled: true, reviewCandidateLimit: 64, outputBudget: 3200,
        domains: {
          character: { observerEnabled: true, verifierEnabled: false },
          relationship: { observerEnabled: false, verifierEnabled: false },
          world: { observerEnabled: true, verifierEnabled: false },
          narrative: { observerEnabled: true, verifierEnabled: false }
        }
      },
      statePromptOverrides: {}
    }),
    loadContinuityState: async current => storage.getJson(keys.continuityState(current), null),
    emptyContinuityState: current => ({
      schema: 'libra.continuity_state.v2', scopeKey: current.scopeKey, worldlineId: 'main',
      characters: [], relationships: [], world: [],
      narrative: { summary: '', arcs: [], threads: [], locks: [], momentum: '' },
      domainStatus: {}, status: 'empty'
    }),
    continuityStateRefs: () => [],
    continuityStateFingerprint: refs => digest({ schema: 'libra.continuity_basis.v2', refs: asArray(refs) }),
    continuityStateBasis: (refsValue, extra = {}) => {
      const refs = asArray(refsValue);
      return {
        schema: 'libra.continuity_basis.v2', fingerprintVersion: 4,
        sourceFingerprint: digest({ schema: 'libra.continuity_basis.v2', refs }), sourceCount: refs.length,
        ...clone(asObject(extra))
      };
    },
    continuityEvidence: memoryValue => ({ memoryId: memoryValue.memoryId, revision: memoryValue.revision }),
    normalizeCurrentNarrativeState: value => ({ summary: '', arcs: [], threads: [], locks: [], momentum: '', ...asObject(value) }),
    mergeCreativeDirectionText: (...parts) => parts.map(string).filter(Boolean).join('\n'),
    STATE_ENTITY_ADMISSION_PROMPT_STAGE_ID: 'state_entity_admission',
    compileStatePromptOverride: (stageId, override = {}) => ({
      primary: `[LIBRA RUNTIME LOCK · test]\nstage=${stageId}`,
      customBlock: override?.customPrompt ? `[USER ADDITIONAL STATE INSTRUCTION — LOWER PRIORITY]\n${override.customPrompt}` : '',
      reassertion: `[LIBRA RUNTIME LOCK REASSERTION · test]\nstage=${stageId}`,
      provenance: { schema: 'libra.prompt_profile_provenance.v1', domain: 'state', stage: stageId, owner: 'State', authority: 'derived_state_only' }
    }),
    // This isolated domain-failure test starts with an authorized canonical basis.
    // Native source-edit gating is exercised by source_edit_libra_dependency_test.cjs.
    assertLibraStateSourceEditPermission: async () => {},
    parseCanonicalArtifactJson: value => JSON.parse(value), recordStageTrace: () => {},
    createProviderOperationBudget: ({ operationKind = 'state', activeStages = [], parentOperationId = '' } = {}) => ({
      schema: 'libra.provider_operation_budget.v1', operationId: 'fixture-state-operation',
      operationKind, parentOperationId, activeStages: clone(activeStages), startedAt: Date.now(),
      maxWallMs: 180000, maxPhysicalCalls: 16, perStageMax: 2, maxCorrectiveAttemptsPerStage: 1,
      maxInputTokens: 270000, maxOutputTokens: 54000, maxReasoningTokens: 54000, maxTotalTokens: 378000,
      maxCostMicros: 0, reserveVisibleRepairTokens: 1200, reserveRepairCalls: 1,
      totalCalls: 0, stageCalls: {},
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      stageUsage: {}, retryLedger: {}, attempts: [], exhaustedReason: ''
    }),
    canonicalProviderBudgetSnapshot: budget => ({
      ...clone(budget), normalizedSchema: 'libra.provider_operation_budget.v1', elapsedMs: 0, usageEstimated: false
    }),
    LibraProviderBridge: {
      callTask: async stageId => {
        providerStages.push(stageId);
        if (stageId === 'state_character_observer') throw new Error('synthetic_character_provider_failure');
        if (stageId === 'state_world_observer') return {
          ok: true, provider: 'fixture', presetName: 'state-world', model: 'fixture-model',
          content: JSON.stringify({
            schema: 'libra.state_observation.v2', domain: 'world', basis: {},
            reviews: [{ entityId: '', outcome: 'maintained', reviewedFields: ['state'], assertionIds: ['w1'] }],
            patches: [], diagnostics: []
          })
        };
        if (stageId === 'state_narrative_observer') return {
          ok: true, provider: 'fixture', presetName: 'state-narrative', model: 'fixture-model',
          content: JSON.stringify({
            schema: 'libra.state_observation.v2', domain: 'narrative', basis: {},
            reviews: [{ entityId: '', outcome: 'changed', reviewedFields: ['status'], assertionIds: ['n1'] }],
            patches: [{
              patchId: 'narrative_unverified_high_risk', operation: 'upsert', entityId: '',
              set: { status: 'resolved' }, assertionIds: ['n1'], fieldAssertionIds: { status: ['n1'] }
            }], diagnostics: []
          })
        };
        throw new Error(`unexpected_provider_stage:${stageId}`);
      }
    },
    reconcileStateCorrectionStatuses: async () => ({ entries: [] }),
    applyStateCorrectionsAtAnchor: (head, _journal, anchorTurn) => {
      const next = clone(head);
      next.narrative = { summary: '', arcs: [], threads: [], locks: [], momentum: '', ...asObject(next.narrative) };
      const correctionId = 'corr_narrative_t10';
      const appliedIds = asArray(next.narrative.appliedCorrectionIds);
      if (Number(anchorTurn || 0) === 10 && !appliedIds.includes(correctionId)) {
        next.narrative.revision = Number(next.narrative.revision || 0) + 1;
        next.narrative.appliedCorrectionIds = [...appliedIds, correctionId];
        next.narrative.correctionProvenance = { correctionId };
      }
      return { head: next, applied: Number(anchorTurn || 0) === 10 ? [correctionId] : [] };
    }
  };
  isolated.callProviderWithOperationBudget = async (stageId, systemPrompt, userPrompt, options = {}) => {
    const budget = options.providerBudget;
    if (budget) {
      budget.totalCalls += 1;
      budget.stageCalls[stageId] = Number(budget.stageCalls[stageId] || 0) + 1;
    }
    return isolated.LibraProviderBridge.callTask(stageId, systemPrompt, userPrompt, options);
  };
  vm.createContext(isolated);
  vm.runInContext(`${pureCore}\n${runtimeCore}\nthis.stateApi = { buildCanonicalCommitEnvelope, runStateTrackingAfterCommit };`, isolated, {
    filename: 'libra-state-orchestrator-isolated.js', timeout: 3000
  });
  return {scope,contextValue,memoryKey,memory,manifest,keys,initialHead,store,storage,providerStages,isolated,stateApi:isolated.stateApi,clone};
};
module.exports={createStateRaceFixture};
