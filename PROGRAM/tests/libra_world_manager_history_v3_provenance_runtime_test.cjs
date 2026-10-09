'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const requestedPlugin = process.argv[2] || process.env.LIBRA_TEST_PLUGIN;
const pluginPath = requestedPlugin
  ? path.resolve(requestedPlugin)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const startMarker = 'const WORLD_MANAGER_HISTORY_DEFAULT_LIMIT = 20;';
const endMarker = '    const normalizeWorldManagerCorrectionDomain = value => {';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start + startMarker.length);
assert.notEqual(start, -1, 'missing v3 World Manager History implementation marker');
assert.notEqual(end, -1, 'missing World Manager History implementation end marker');
const implementationSource = source.slice(start, end);
const replayRefsStartMarker = 'const statePipelineReplayRefs = manifest =>';
const replayRefsEndMarker = 'const persistStateReplayHead = async';
const replayRefsStart = source.indexOf(replayRefsStartMarker);
const replayRefsEnd = source.indexOf(replayRefsEndMarker, replayRefsStart + replayRefsStartMarker.length);
assert.ok(replayRefsStart >= 0 && replayRefsEnd > replayRefsStart, 'statePipelineReplayRefs must be locatable');
const replayRefsSource = source.slice(replayRefsStart, replayRefsEnd);
const threadTargetIndexMarker = 'const newUnifiedThreadTargetIndex = () =>';
const threadTargetIndexEndMarker = 'const appendUnifiedThreadTargets =';
const threadTargetIndexStart = source.indexOf(threadTargetIndexMarker);
const threadTargetIndexEnd = source.indexOf(threadTargetIndexEndMarker, threadTargetIndexStart + threadTargetIndexMarker.length);
assert.ok(threadTargetIndexStart >= 0 && threadTargetIndexEnd > threadTargetIndexStart,
  'newUnifiedThreadTargetIndex must be locatable');
const threadTargetIndexSource = source.slice(threadTargetIndexStart, threadTargetIndexEnd);
const cursorStartMarker = 'const statePipelineBasisCursor = basis =>';
const cursorEndMarker = 'const statePipelineCursorMatchesRef =';
const cursorStart = source.indexOf(cursorStartMarker);
const cursorEnd = source.indexOf(cursorEndMarker, cursorStart + cursorStartMarker.length);
assert.ok(cursorStart >= 0 && cursorEnd > cursorStart, 'statePipelineCursorForRef dependencies must be locatable');
const cursorSource = source.slice(cursorStart, cursorEnd);

const SCHEMA = Object.freeze({
  artifact: 'libra.canonical_artifact.v3',
  memory: 'libra.canonical_memory.v1',
  receipt: 'libra.state_pipeline_receipt.v1',
  observation: 'libra.state_observation.v2',
  verification: 'libra.state_verification.v1',
  admission: 'libra.entity_admission_receipt.v1'
});
const SCOPE = Object.freeze({ scopeKey: 'scope-v3', characterId: 'char-v3', chatId: 'chat-v3' });
const DOMAINS = Object.freeze(['character', 'relationship', 'world', 'narrative']);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asArray = value => Array.isArray(value) ? value : [];
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = value => String(value == null ? '' : value);
const compact = (value, limit = 1000) => string(value).replace(/\s+/g, ' ').trim().slice(0, limit);
const stableValue = value => Array.isArray(value)
  ? value.map(stableValue)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
    : value;
const stableReferenceJson = value => JSON.stringify(stableValue(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stableReferenceJson(value)).digest('hex');
const statePipelineReceiptDigest = value => {
  const payload = clone(asObject(value));
  delete payload.receiptDigest;
  return digest({ schema: SCHEMA.receipt, payload });
};
const statePipelineObservationDigest = value => {
  const payload = clone(asObject(value));
  delete payload.verification;
  delete payload.observationDigest;
  return digest({ schema: SCHEMA.observation, payload });
};
const statePipelineVerificationDigest = value => {
  const payload = clone(asObject(value));
  delete payload.verificationDigest;
  return digest({ schema: SCHEMA.verification, payload });
};
const entityAdmissionReceiptDigest = value => {
  const payload = clone(asObject(value));
  delete payload.receiptDigest;
  return digest({ schema: SCHEMA.admission, payload });
};
const sealedStatePipelineDomains = receipt => {
  const domains = asArray(receipt?.replayDomains).map(string).filter(domain => DOMAINS.includes(domain));
  return domains.length === asArray(receipt?.replayDomains).length && new Set(domains).size === domains.length
    ? [...domains].sort()
    : null;
};
const statePipelineAssertionsForDomain = (artifact, domain) => {
  if (domain === 'character') return asArray(artifact?.characters);
  if (domain === 'relationship') return asArray(artifact?.relationships);
  if (domain === 'world') return asArray(artifact?.world);
  if (domain === 'narrative') return [...asArray(artifact?.openThreads), ...asArray(artifact?.chronology)];
  return [];
};

const stateDerivedWorldlineSuffix = worldlineId => worldlineId === 'main' ? '' : `:worldline:${worldlineId}`;
const key = Object.freeze({
  continuityDelta: (_scope, memoryId, revision) => `delta:${memoryId}:r${revision}`,
  statePipelineReceipt: (_scope, memoryId, revision, worldlineId = 'main') => `receipt:${memoryId}:r${revision}${stateDerivedWorldlineSuffix(worldlineId)}`,
  stateObservation: (_scope, memoryId, revision, domain, worldlineId = 'main') => `observation:${memoryId}:r${revision}:${domain}${stateDerivedWorldlineSuffix(worldlineId)}`
});

const makeArtifact = ordinal => ({
  schema: SCHEMA.artifact,
  chronology: [{ assertionId: `ca-event-${ordinal}`, domain: 'event', event: `Event ${ordinal}`, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceRefs: [`t${ordinal}-a`] }],
  characters: [{ assertionId: `ca-character-${ordinal}`, domain: 'character', name: `Ada ${ordinal}`, fact: 'Moved to the archive', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceRefs: [`t${ordinal}-a`] }],
  relationships: [], world: [], openThreads: [], uncertainties: [], recallTerms: ['archive']
});

function makeObservation({ ref, artifact, worldlineId = 'main', ordinal }) {
  const basis = {
    scopeKey: SCOPE.scopeKey,
    worldlineId: 'main',
    logicalWorldlineId: worldlineId,
    memoryId: ref.memoryId,
    revision: ref.revision,
    sourceDigest: ref.sourceDigest,
    artifactSchema: SCHEMA.artifact,
    artifactDigest: ref.artifactDigest,
    turnRange: clone(ref.turnRange),
    headFingerprint: `head-${ordinal}`,
    entityRegistryFingerprint: `registry-${ordinal}`
  };
  const observation = {
    schema: SCHEMA.observation,
    domain: 'character',
    basis,
    reviews: [{ entityId: `char-${ordinal}`, outcome: 'changed', reviewedFields: ['location'], reason: 'direct assertion', assertionIds: [`ca-character-${ordinal}`] }],
    patches: [{ patchId: `patch-${ordinal}`, operation: 'upsert', entityId: `char-${ordinal}`, set: { location: 'Archive' }, clear: [], expectedRecordHash: 'old', expectedFieldHashes: { location: 'old-location' }, changeClass: 'transition', evidenceByField: { location: { assertionId: `ca-character-${ordinal}`, evidenceRefs: [`t${ordinal}-a`] } } }],
    diagnostics: []
  };
  observation.observationDigest = statePipelineObservationDigest(observation);
  observation.verification = {
    schema: SCHEMA.verification,
    domain: 'character',
    observationDigest: observation.observationDigest,
    decisions: [{ patchId: `patch-${ordinal}`, decision: 'approve' }],
    verificationDigest: ''
  };
  observation.verification.verificationDigest = statePipelineVerificationDigest(observation.verification);
  return observation;
}

function buildFixture(count = 2) {
  const memories = {};
  const store = new Map();
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    const start = (ordinal - 1) * 5 + 1;
    const ref = {
      memoryId: `memory-v3-${ordinal}`,
      revision: 1,
      sourceDigest: `source-v3-${ordinal}`,
      status: 'committed',
      key: `memory:memory-v3-${ordinal}:r1`,
      artifactSchema: SCHEMA.artifact,
      turnRange: { start, end: start + 4 },
      summary: `Summary ${ordinal}`,
      sessionEpoch: 0,
      worldlineId: 'main',
      updatedAt: `2026-09-01T00:0${ordinal}:00.000Z`
    };
    const artifact = makeArtifact(ordinal);
    ref.artifactDigest = digest(artifact);
    memories[String(start)] = clone(ref);
    const memory = {
      schema: SCHEMA.memory,
      memoryId: ref.memoryId,
      revision: ref.revision,
      sourceDigest: ref.sourceDigest,
      turnRange: clone(ref.turnRange),
      artifactSchema: SCHEMA.artifact,
      artifactDigest: ref.artifactDigest,
      canonicalArtifact: artifact,
      summary: ref.summary,
      text: `Canonical ${ordinal}`,
      status: 'committed'
    };
    store.set(ref.key, memory);
    const observation = makeObservation({ ref, artifact, ordinal });
    const observationKey = key.stateObservation(SCOPE, ref.memoryId, ref.revision, 'character', 'main');
    store.set(observationKey, observation);
    const admissionKey = `admission:${ref.memoryId}:r${ref.revision}`;
    const admission = {
      schema: SCHEMA.admission, mode: 'person_admission', stage: 'state_character_verifier',
      scopeKey: SCOPE.scopeKey, worldlineId: 'main', memoryId: ref.memoryId, revision: ref.revision,
      sourceDigest: ref.sourceDigest, artifactSchema: SCHEMA.artifact, artifactDigest: ref.artifactDigest,
      status: 'complete', decisions: [{ assertionId: `ca-character-${ordinal}`, decision: 'approve' }],
      approvedPersonAssertionIds: [`ca-character-${ordinal}`], completedAt: ref.updatedAt, receiptDigest: ''
    };
    admission.receiptDigest = entityAdmissionReceiptDigest(admission);
    store.set(admissionKey, admission);
    const receipt = {
      schema: SCHEMA.receipt,
      scopeKey: SCOPE.scopeKey,
      worldlineId: 'main',
      memoryId: ref.memoryId,
      revision: ref.revision,
      sourceDigest: ref.sourceDigest,
      artifactDigest: ref.artifactDigest,
      entityRegistryFingerprint: `registry-${ordinal}`,
      domainContractVersion: 1,
      replayDomains: ['character'],
      observationKeys: { character: observationKey },
      domains: [{
        domain: 'character', status: 'ready', changed: true, appliedPatches: 1, rejectedPatches: 0,
        observationDigest: observation.observationDigest,
        verificationDigest: observation.verification.verificationDigest,
        observer: { stage: 'state_character_observer' }, verifier: { stage: 'state_character_verifier' }
      }],
      entityAdmission: { receiptKey: admissionKey, status: 'complete', required: true, approvedPersonAssertionIds: [`ca-character-${ordinal}`] },
      observationDigests: { character: observation.observationDigest },
      verificationDigests: { character: observation.verification.verificationDigest },
      providerCalls: 3,
      status: 'complete', authority: 'target_canonical_chain', completedAt: ref.updatedAt, receiptDigest: ''
    };
    receipt.receiptDigest = statePipelineReceiptDigest(receipt);
    store.set(key.statePipelineReceipt(SCOPE, ref.memoryId, ref.revision, 'main'), receipt);
  }
  return {
    manifest: { schema: 'libra.manifest.v1', scopeKey: SCOPE.scopeKey, memories, inheritedMemories: [], frontiers: { observedTurn: count * 5 } },
    store
  };
}

function buildHarness() {
  const fixture = buildFixture();
  const reads = [];
  let activeWorldlineId = 'main';
  const storage = {
    async getJson(storageKey, fallback) {
      reads.push(storageKey);
      return fixture.store.has(storageKey) ? clone(fixture.store.get(storageKey)) : fallback;
    }
  };
  const deps = {
    CANONICAL_ARTIFACT_SCHEMA: SCHEMA.artifact,
    CANONICAL_MANUAL_AUTHORITY_SCHEMA: 'libra.canonical_manual_authority.v1',
    CONTINUITY_DELTA_SCHEMA: 'libra.continuity_delta.v1',
    STATE_PIPELINE_RECEIPT_SCHEMA: SCHEMA.receipt,
    STATE_OBSERVATION_SCHEMA: SCHEMA.observation,
    ENTITY_ADMISSION_RECEIPT_SCHEMA: SCHEMA.admission,
    STATE_PIPELINE_DOMAINS: DOMAINS,
    clone, asArray, asObject, string, compact, stableReferenceJson, digest,
    statePipelineReceiptDigest, statePipelineObservationDigest, statePipelineVerificationDigest,
    entityAdmissionReceiptDigest, sealedStatePipelineDomains, statePipelineAssertionsForDomain,
    storage, key,
    resolveContext: async () => ({ scope: clone(SCOPE), chat: { messages: [] } }),
    buildPairs: () => [],
    loadManifest: async () => clone(fixture.manifest),
    loadStateWorldlineMeta: async (_scope, options = {}) => {
      assert.equal(options.strict, true);
      return {
        schema: 'libra.state_worldline_meta.v1', scopeKey: SCOPE.scopeKey, activeWorldlineId,
        worldlines: {
          main: { id: 'main', active: activeWorldlineId === 'main' },
          branch: { id: 'branch', parentId: 'main', forkTurn: 5, cutoffTurn: 5, active: activeWorldlineId === 'branch' }
        }
      };
    },
    loadMemoryRef: async ref => clone(fixture.store.get(ref.key) || null),
    stateCorrectionFailure: (code, message = code) => Object.assign(new Error(message), { code })
  };
  Object.assign(deps,require('./fixtures/librarian_production_bindings.cjs')(source));
  const names = Object.keys(deps);
  const factory = Function(...names, `'use strict';\n${cursorSource}\n${replayRefsSource}\n${threadTargetIndexSource}\n${implementationSource}\nreturn { listWorldManagerHistory, getWorldManagerHistoryDetail };`);
  const api = factory(...names.map(name => deps[name]));
  return { api, fixture, reads, setActiveWorldline(value) { activeWorldlineId = value; } };
}

(async () => {
  const harness = buildHarness();
  const page = await harness.api.listWorldManagerHistory({ domain: 'characters', limit: 1 });
  assert.equal(page.schema, 'libra.world_manager_history_page.v2');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].recordMode, 'state_pipeline_v3');
  assert.equal(page.items[0].statePipelineStatus, 'complete');
  assert.equal(page.items[0].stateAuthority, 'target_canonical_chain');
  assert.equal(page.items[0].domains.characters.applied, 1);
  assert.equal(page.items[0].domains.narrative.status, 'empty');
  assert.equal(page.worldlineId, 'main');
  assert.ok(page.nextCursor);
  assert.equal(harness.reads.filter(keyValue => keyValue.startsWith('receipt:')).length, 1, 'metadata page must read one receipt');
  assert.equal(harness.reads.some(keyValue => keyValue.startsWith('observation:')), false, 'metadata page must not read observations');
  assert.equal(harness.reads.some(keyValue => keyValue.startsWith('memory:')), false, 'metadata page must not read canonical body');

  harness.reads.length = 0;
  const item = page.items[0];
  const detail = await harness.api.getWorldManagerHistoryDetail({ memoryId: item.memoryId, revision: item.revision, worldlineId: 'main' });
  assert.equal(detail.schema, 'libra.world_manager_history_detail.v2');
  assert.equal(detail.recordMode, 'state_pipeline_v3');
  assert.equal(detail.delta, undefined);
  assert.equal(detail.provenance.mode, 'state_pipeline_v3');
  assert.equal(detail.provenance.statePipeline.receipt.status, 'complete');
  assert.equal(detail.provenance.domains.character.reviews.length, 1);
  assert.equal(detail.provenance.domains.character.patches.length, 1);
  assert.equal(detail.provenance.domains.character.canonicalAssertions[0].assertionId, 'ca-character-2');
  assert.equal(detail.provenance.entityAdmission.approvedPersonAssertionIds[0], 'ca-character-2');
  assert.equal(harness.reads.filter(keyValue => keyValue.startsWith('receipt:')).length, 1);
  assert.equal(harness.reads.filter(keyValue => keyValue.startsWith('observation:')).length, 1);
  assert.equal(harness.reads.filter(keyValue => keyValue.startsWith('admission:')).length, 1);

  const observationKey = key.stateObservation(SCOPE, item.memoryId, item.revision, 'character', 'main');
  const original = clone(harness.fixture.store.get(observationKey));
  harness.fixture.store.set(observationKey, { ...original, reviews: [] });
  let tampered = null;
  try { await harness.api.getWorldManagerHistoryDetail({ memoryId: item.memoryId, revision: item.revision, worldlineId: 'main' }); }
  catch (error) { tampered = error; }
  assert.equal(tampered?.code, 'WORLD_MANAGER_HISTORY_OBSERVATION_INVALID');
  harness.fixture.store.set(observationKey, original);

  harness.setActiveWorldline('branch');
  let staleCursor = null;
  try { await harness.api.listWorldManagerHistory({ domain: 'characters', limit: 1, cursor: page.nextCursor }); }
  catch (error) { staleCursor = error; }
  assert.equal(staleCursor?.code, 'WORLD_MANAGER_HISTORY_CURSOR_INVALID', 'cursor must bind the active logical State Worldline');

  const branchPage = await harness.api.listWorldManagerHistory({ domain: 'characters', limit: 20, worldlineId: 'branch' });
  assert.equal(branchPage.worldlineId, 'branch');
  assert.equal(branchPage.cutoffTurn, 5, 'History page must expose the logical State Worldline cutoff');
  assert.equal(branchPage.items.length, 1, 'History must hide canonical refs after the rollback cutoff');
  assert.equal(branchPage.items[0].memoryId, 'memory-v3-1');
  let futureDetail = null;
  try { await harness.api.getWorldManagerHistoryDetail({ memoryId: 'memory-v3-2', revision: 1, worldlineId: 'branch' }); }
  catch (error) { futureDetail = error; }
  assert.equal(futureDetail?.code, 'WORLD_MANAGER_HISTORY_NOT_FOUND', 'detail lookup must not bypass the Worldline cutoff');

  process.stdout.write('libra_world_manager_history_v3_provenance_runtime_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
