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
const section = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const neutralizeSource = section(
  'const scopeNeutralizeManualStateDispositionPatch =',
  'const manualStateDispositionPatchIsScopeNeutral ='
);
const prefixSource = section(
  'const statePipelineManifestForExactRefs =',
  'const saveCanonicalManualStateDisposition = async'
);
const normalizeCorrectionSource = section(
  'const stateCorrectionFieldHash =',
  'const stateCorrectionPreflight = async'
);
const materializerSource = section(
  'const loadManualStateDispositionAnchorHeads = async',
  'const assertManualStateDispositionAnchorCas = async'
);
const durableReplaySource = section(
  'const replayDurableStateObservations = async',
  'const rebuildStateFromCanonicalChain = async'
);
const receiptDependencySource = section(
  'const statePipelineObservationDigest =',
  'const runStateTrackingAfterCommit = async'
);

assert.doesNotMatch(materializerSource, /storage\.(?:setJson|remove)\s*\(/,
  'the historical prefix materializer must be read-only');
assert.doesNotMatch(materializerSource, /LibraProviderBridge|callTask\s*\(/,
  'the historical prefix materializer must not call a provider');
assert.doesNotMatch(materializerSource, /loadSettings\s*\(/,
  'historical replay must not load mutable GUI settings (loadSettings may migrate/write)');
assert.match(materializerSource, /persist:\s*false/,
  'durable observations must replay without persistence');
assert.doesNotMatch(materializerSource, /allowHeadFingerprintRebase:\s*true/,
  'historical replay must not bypass the sealed observation Head fingerprint');
assert.match(materializerSource, /sealedReceiptDomains:\s*true/,
  'the historical materializer must select receipt-sealed replay domains');
assert.match(durableReplaySource,
  /if \(sealedReceiptDomains\)[\s\S]{0,900}loadSealedStatePipelineReceipt/,
  'the sealed historical replay branch must validate the pipeline receipt before selecting domains');
assert.match(materializerSource, /const throughRefs = refs\.slice\(0, targetIndex \+ 1\)/,
  'successor canonicals must be excluded before any prefix replay');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 1000) => string(value).slice(0, limit);
const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
};
const stableReferenceJson = value => JSON.stringify(stableValue(value));
const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
  .digest('hex');
const canonicalStoredDigest = value => digest(stableReferenceJson(value ?? null));
const continuityStateNameKey = value => string(value).normalize('NFKC').toLocaleLowerCase();
const statePipelineObservationDigestFixture = observationValue => {
  const payload = clone(asObject(observationValue));
  delete payload.verification;
  delete payload.observationDigest;
  return digest({ schema: 'libra.state_observation.v2', payload });
};
const statePipelineVerificationDigestFixture = verificationValue => {
  const payload = clone(asObject(verificationValue));
  delete payload.verificationDigest;
  return digest({ schema: 'libra.state_verification.v1', payload });
};
const statePipelineReceiptDigestFixture = receiptValue => {
  const payload = clone(asObject(receiptValue));
  delete payload.receiptDigest;
  return digest({ schema: 'libra.state_pipeline_receipt.v1', payload });
};
const statePipelineBasisCursorFixture = basis => ({
  key: string(basis?.key || basis?.memoryKey || ''),
  memoryId: string(basis?.memoryId || ''), revision: Number(basis?.revision || 0),
  sourceDigest: string(basis?.sourceDigest || ''),
  manualStateDispositionDigest: string(basis?.manualStateDispositionDigest || ''),
  manualAuthorityHash: string(basis?.manualAuthorityHash || ''),
  artifactSchema: string(basis?.artifactSchema || ''), artifactDigest: string(basis?.artifactDigest || ''),
  worldlineId: string(basis?.worldlineId || 'main'),
  logicalWorldlineId: string(basis?.logicalWorldlineId || basis?.worldlineId || 'main'),
  turnRange: clone(asObject(basis?.turnRange)), sessionEpoch: Number(basis?.sessionEpoch || 0),
  inheritedSessionHistory: basis?.inheritedSessionHistory === true || basis?.inherited === true,
  archiveShared: basis?.archiveShared === true,
  archiveId: string(basis?.archiveId || ''), archiveCanonicalId: string(basis?.archiveCanonicalId || ''),
  handoffTransferId: string(basis?.handoffTransferId || ''),
  sourceSessionScopeKey: string(basis?.sourceSessionScopeKey || ''),
  nativeCopiedFromScopeKey: string(basis?.nativeCopiedFromScopeKey || '')
});
const statePipelineCursorForRefFixture = (ref, logicalWorldlineId = '') => statePipelineBasisCursorFixture({
  ...asObject(ref), key: ref?.key, logicalWorldlineId: logicalWorldlineId || ref?.worldlineId || 'main'
});

const schemas = {
  manifest: 'libra.manifest.v1',
  artifact: 'libra.canonical_artifact.v3',
  legacyArtifact: 'libra.canonical_artifact.v2',
  manualAuthority: 'libra.canonical_manual_authority.v1',
  manualReceipt: 'libra.manual_state_disposition_receipt.v1',
  continuity: 'libra.continuity_state.v2',
  registry: 'libra.entity_registry.v2',
  admission: 'libra.entity_admission_receipt.v1',
  observation: 'libra.state_observation.v2',
  pipelineReceipt: 'libra.state_pipeline_receipt.v1'
};

const makeArtifact = ({ assertionId, characterId, name }) => ({
  schema: schemas.artifact,
  chronology: [],
  characters: [{ assertionId, id: characterId, name, aliases: [] }],
  relationships: [],
  world: []
});

const makeAutomaticMemory = ({ memoryId, keyName, start, end, artifact, stateDelta }) => {
  const artifactDigest = digest(artifact);
  return {
    memory: {
      schema: 'libra.canonical_memory.v1', status: 'committed', scopeKey: 'scope:anchor-prefix',
      memoryId, revision: 1, sessionEpoch: 1, sourceDigest: `source:${memoryId}`,
      turnRange: { start, end }, canonicalArtifact: clone(artifact), artifactDigest,
      stateDelta: clone(stateDelta)
    },
    ref: {
      key: keyName, status: 'committed', memoryId, revision: 1, sessionEpoch: 1,
      sourceDigest: `source:${memoryId}`, turnRange: { start, end }, artifactDigest
    }
  };
};

const prior = makeAutomaticMemory({
  memoryId: 'mem_prior', keyName: 'memory:prior', start: 1, end: 5,
  artifact: makeArtifact({ assertionId: 'ca_alice', characterId: 'char_alice', name: 'Alice' }),
  stateDelta: {
    characters: [{ id: 'char_alice', name: 'Alice', set: { mood: 'calm', keeps: 'yes', restored: 'present' } }],
    narrative: { summary: 'prior narrative' }
  }
});
const target = makeAutomaticMemory({
  memoryId: 'mem_target', keyName: 'memory:target', start: 6, end: 10,
  artifact: makeArtifact({ assertionId: 'ca_target', characterId: 'char_target', name: 'Target' }),
  stateDelta: {
    characters: [
      { id: 'char_alice', name: 'Alice', set: { mood: 'focused' } },
      { id: 'char_target', name: 'Target', set: { mood: 'arrived' } }
    ],
    narrative: { summary: 'target narrative' }
  }
});
const successor = makeAutomaticMemory({
  memoryId: 'mem_successor', keyName: 'memory:successor', start: 11, end: 15,
  artifact: makeArtifact({ assertionId: 'ca_future', characterId: 'char_future', name: 'Future' }),
  stateDelta: {
    characters: [
      { id: 'char_alice', name: 'Alice', set: { mood: 'future' }, clear: ['keeps', 'restored'] },
      { id: 'char_future', name: 'Future', set: { mood: 'not yet' } }
    ],
    narrative: { summary: 'future narrative' }
  }
});

const baseManifest = {
  schema: schemas.manifest, scopeKey: 'scope:anchor-prefix', inheritedMemories: [],
  memories: { 1: clone(prior.ref), 6: clone(target.ref), 11: clone(successor.ref) }
};
const baseCandidate = {
  schema: 'libra.canonical_memory.v1', status: 'candidate', scopeKey: baseManifest.scopeKey,
  memoryId: 'mem_target_manual', revision: 2, sessionEpoch: 1, sourceDigest: target.ref.sourceDigest,
  turnRange: { start: 6, end: 10 },
  manualAuthority: {
    schema: schemas.manualAuthority, origin: 'user_edit', status: 'candidate',
    scopeKey: baseManifest.scopeKey, memoryId: 'mem_target_manual', revision: 2,
    sourceDigest: target.ref.sourceDigest, turnRange: { start: 6, end: 10 },
    contentHash: 'content', authorityHash: 'authority', parentKey: target.ref.key,
    parentRevision: target.ref.revision
  },
  editProvenance: {
    schema: schemas.manualAuthority, parentKey: target.ref.key, parentRevision: target.ref.revision,
    authorityHash: 'authority'
  }
};

const makeHarness = ({
  fault = '', manualTarget = false, legacyTarget = false, corrections = true,
  ambiguousTarget = false, parentMismatch = false
} = {}) => {
  const scope = { scopeKey: baseManifest.scopeKey };
  const manifest = clone(baseManifest);
  if (ambiguousTarget) manifest.inheritedMemories.push(clone(target.ref));
  const candidate = clone(baseCandidate);
  if (parentMismatch) {
    candidate.manualAuthority.parentKey = 'memory:wrong-parent';
    candidate.manualAuthority.parentRevision = 77;
    candidate.editProvenance.parentKey = 'memory:wrong-parent';
    candidate.editProvenance.parentRevision = 77;
  }
  const memories = {
    [prior.ref.key]: clone(prior.memory),
    [target.ref.key]: clone(target.memory),
    [successor.ref.key]: clone(successor.memory)
  };
  if (manualTarget) {
    const manualIntent = {
      mode: 'maintained_by_user', intentDigest: 'manual-intent-target', target: { domain: 'head', mode: 'profile_patch' }, patch: null
    };
    memories[target.ref.key] = {
      schema: 'libra.canonical_memory.v1', status: 'committed', scopeKey: scope.scopeKey,
      memoryId: target.memory.memoryId, revision: 1, sessionEpoch: 1, sourceDigest: target.memory.sourceDigest,
      turnRange: clone(target.memory.turnRange), manualAuthority: { schema: schemas.manualAuthority },
      manualStateDisposition: manualIntent
    };
    delete manifest.memories[6].artifactDigest;
    manifest.memories[6].manualStateDispositionDigest = manualIntent.intentDigest;
  }
  if (legacyTarget) {
    memories[target.ref.key].canonicalArtifact.schema = schemas.legacyArtifact;
    memories[target.ref.key].artifactSchema = schemas.legacyArtifact;
  }

  const key = {
    manifest: current => `manifest:${current.scopeKey}`,
    stateCorrections: current => `corrections:${current.scopeKey}`,
    stateCorrectionMeta: current => `correction-meta:${current.scopeKey}`,
    stateCorrectionCommit: current => `correction-commit:${current.scopeKey}`,
    stateWorldlineMeta: current => `worldline:${current.scopeKey}`,
    continuityState: current => `head:${current.scopeKey}`,
    entityRegistry: current => `registry:${current.scopeKey}`,
    manualStateDisposition: (current, memoryId, revision) => `manual:${current.scopeKey}:${memoryId}:r${revision}`,
    statePipelineReceipt: (current, memoryId, revision) => `pipeline:${current.scopeKey}:${memoryId}:r${revision}`,
    stateObservation: (current, memoryId, revision, domain) => `observation:${current.scopeKey}:${memoryId}:r${revision}:${domain}`,
    canonicalJob: (current, jobId) => `job:${current.scopeKey}:${jobId}`,
    canonicalVariantIndex: current => `variant-index:${current.scopeKey}`
  };
  const candidateKey = 'candidate:manual-target';
  const jobKey = 'job:manual-target';
  const correctionJournal = {
    schema: 'libra.state_corrections.v1', scopeKey: scope.scopeKey,
    records: corrections ? [
      {
        correctionId: 'correction_target_once', worldlineId: 'main',
        anchor: { throughTurn: 10, canonical: statePipelineCursorForRefFixture(target.ref, 'main') },
        basisVersion: 4,
        basisFingerprint: digest({ schema: 'libra.continuity_basis.v2', refs: [clone(prior.ref), clone(target.ref)] }), status: 'active',
        target: { domain: 'narrative' }, after: { narrative: { summary: 'target correction once' } }
      },
      {
        correctionId: 'correction_future_never', worldlineId: 'main',
        anchor: { throughTurn: 15, canonical: statePipelineCursorForRefFixture(successor.ref, 'main') },
        basisVersion: 4,
        basisFingerprint: digest({ schema: 'libra.continuity_basis.v2', refs: [clone(prior.ref), clone(target.ref), clone(successor.ref)] }), status: 'active',
        target: { domain: 'narrative' }, after: { narrative: { summary: 'future correction' } }
      }
    ] : []
  };
  const correctionMetaFor = journal => ({
    schema: 'libra.state_correction_meta.v1', scopeKey: scope.scopeKey,
    journalDigest: canonicalStoredDigest(journal), journalRevision: Number(journal?.revision || 0)
  });
  const correctionMeta = correctionMetaFor(correctionJournal);
  const correctionCommit = {
    schema: 'libra.state_correction_commit.v1', scopeKey: scope.scopeKey, status: 'committed',
    targetJournalDigest: correctionMeta.journalDigest, targetJournalRevision: correctionMeta.journalRevision
  };
  const raw = new Map([
    [key.manifest(scope), clone(manifest)],
    [key.stateCorrections(scope), clone(correctionJournal)],
    [key.stateCorrectionMeta(scope), clone(correctionMeta)],
    [key.stateCorrectionCommit(scope), clone(correctionCommit)],
    [key.stateWorldlineMeta(scope), { schema: 'libra.state_worldline_meta.v1', scopeKey: scope.scopeKey, activeWorldlineId: 'main' }],
    [key.continuityState(scope), {
      schema: schemas.continuity, scopeKey: scope.scopeKey, throughTurn: 15,
      characters: [{ id: 'char_alice', name: 'Alice', state: { mood: 'future' } }, { id: 'char_future', name: 'Future', state: { mood: 'not yet' } }],
      relationships: [], world: [], narrative: { summary: 'future narrative' }
    }],
    [key.entityRegistry(scope), { schema: schemas.registry, scopeKey: scope.scopeKey, entities: [{ id: 'char_future', name: 'Future' }] }],
    [candidateKey, clone(candidate)],
    [jobKey, { schema: 'libra.canonical_job.v1', jobId: 'job-manual-target', state: 'awaiting_choice' }],
    ...Object.entries(memories).map(([storageKey, value]) => [storageKey, clone(value)])
  ]);

  const installAutomaticSidecars = (memory, ref, registryEntities, previousTurn) => {
    const artifactDigest = digest(memory.canonicalArtifact);
    const admissionReceiptKey = `admission:${scope.scopeKey}:${memory.memoryId}:r${memory.revision}`;
    const approvedPersonAssertionIds = asArray(memory.canonicalArtifact?.characters).map(row => row.assertionId);
    raw.set(admissionReceiptKey, {
      schema: schemas.admission, status: 'complete', memoryId: memory.memoryId, artifactDigest,
      approvedPersonAssertionIds
    });
    const domainRows = ['character', 'narrative'].map(domain => ({ domain, status: 'ready' }));
    const observationKeys = {};
    const observationDigests = {};
    const verificationDigests = {};
    for (const domainRow of domainRows) {
      const domain = domainRow.domain;
      const observationKey = key.stateObservation(scope, memory.memoryId, memory.revision, domain);
      const observation = {
        schema: schemas.observation, scopeKey: scope.scopeKey, worldlineId: 'main',
        memoryId: memory.memoryId, revision: memory.revision, sourceDigest: memory.sourceDigest,
        artifactDigest, domain,
        basis: {
          ...statePipelineCursorForRefFixture(ref, 'main'), entityRegistryFingerprint: digest(registryEntities),
          headFingerprint: `headfp:${Number(previousTurn)}`
        },
        patches: [], reviews: [], diagnostics: [], observationDigest: ''
      };
      const observationDigest = statePipelineObservationDigestFixture(observation);
      observation.observationDigest = observationDigest;
      observation.verification = {
        schema: 'libra.state_verification.v1', domain, observationDigest,
        decisions: {}, receipt: { status: 'complete' }, verificationDigest: ''
      };
      const verificationDigest = statePipelineVerificationDigestFixture(observation.verification);
      observation.verification.verificationDigest = verificationDigest;
      observationKeys[domain] = observationKey;
      observationDigests[domain] = observationDigest;
      verificationDigests[domain] = verificationDigest;
      domainRow.observationDigest = observationDigest;
      domainRow.verificationDigest = verificationDigest;
      raw.set(observationKey, observation);
    }
    const pipelineReceipt = {
      schema: schemas.pipelineReceipt, scopeKey: scope.scopeKey, worldlineId: 'main',
      memoryId: memory.memoryId, revision: memory.revision, sourceDigest: memory.sourceDigest,
      artifactDigest, entityRegistryFingerprint: digest(registryEntities),
      domainContractVersion: 1, replayDomains: ['character', 'narrative'],
      status: 'complete', authority: 'target_canonical_chain', domains: domainRows,
      entityAdmission: {
        receiptKey: admissionReceiptKey, status: 'complete', required: true,
        approvedPersonAssertionIds
      },
      observationKeys, observationDigests, verificationDigests, receiptDigest: ''
    };
    pipelineReceipt.receiptDigest = statePipelineReceiptDigestFixture(pipelineReceipt);
    raw.set(key.statePipelineReceipt(scope, memory.memoryId, memory.revision), pipelineReceipt);
  };
  const aliceRegistry = [{ id: 'char_alice', name: 'Alice', aliases: [] }];
  const targetRegistry = [...aliceRegistry, { id: 'char_target', name: 'Target', aliases: [] }];
  const successorRegistry = [...targetRegistry, { id: 'char_future', name: 'Future', aliases: [] }];
  installAutomaticSidecars(memories[prior.ref.key], prior.ref, aliceRegistry, 0);
  if (!manualTarget && !legacyTarget) installAutomaticSidecars(memories[target.ref.key], target.ref, targetRegistry, 5);
  installAutomaticSidecars(memories[successor.ref.key], successor.ref, successorRegistry, 10);
  if (manualTarget) {
    raw.set(key.manualStateDisposition(scope, memories[target.ref.key].memoryId, memories[target.ref.key].revision), {
      schema: schemas.manualReceipt, valid: true, memoryId: memories[target.ref.key].memoryId,
      intentDigest: memories[target.ref.key].manualStateDisposition.intentDigest
    });
  }

  const targetAdmissionKey = `admission:${scope.scopeKey}:${target.memory.memoryId}:r1`;
  const targetPipelineKey = key.statePipelineReceipt(scope, target.memory.memoryId, 1);
  const targetObservationKey = key.stateObservation(scope, target.memory.memoryId, 1, 'character');
  const targetManualKey = key.manualStateDisposition(scope, target.memory.memoryId, 1);
  if (fault === 'admission_missing') raw.delete(targetAdmissionKey);
  if (fault === 'admission_tampered') raw.get(targetAdmissionKey).artifactDigest = 'tampered';
  if (fault === 'admission_failed_closed') raw.get(targetAdmissionKey).status = 'failed_closed';
  if (fault === 'pipeline_receipt_missing') raw.delete(targetPipelineKey);
  if (fault === 'pipeline_receipt_tampered') raw.get(targetPipelineKey).artifactDigest = 'tampered';
  if (fault === 'pipeline_scope_tampered') raw.get(targetPipelineKey).scopeKey = 'scope:forged';
  if (fault === 'pipeline_worldline_tampered') raw.get(targetPipelineKey).worldlineId = 'forged';
  if (fault === 'pipeline_memory_tampered') raw.get(targetPipelineKey).memoryId = 'mem_forged';
  if (fault === 'pipeline_revision_tampered') raw.get(targetPipelineKey).revision = 999;
  if (fault === 'pipeline_source_tampered') raw.get(targetPipelineKey).sourceDigest = 'source:forged';
  if (fault === 'pipeline_authority_tampered') raw.get(targetPipelineKey).authority = 'last_known_non_authoritative';
  if (fault === 'pipeline_domain_set_tampered') raw.get(targetPipelineKey).domains.push({ domain: 'world', status: 'ready' });
  if (fault === 'observation_missing') raw.delete(targetObservationKey);
  if (fault === 'observation_tampered') raw.get(targetObservationKey).artifactDigest = 'tampered';
  if (fault === 'manual_receipt_missing') raw.delete(targetManualKey);
  if (fault === 'manual_receipt_tampered') raw.get(targetManualKey).intentDigest = 'tampered';

  const metrics = {
    writes: [], providerCalls: 0, correctionApplications: new Map(), memoryReads: [], candidateReads: 0,
    headReads: 0, registryReads: 0, settingsReads: 0
  };
  const storage = {
    async getJson(storageKey, fallback = null) {
      const name = String(storageKey);
      if (name === candidateKey) metrics.candidateReads += 1;
      if (name === key.continuityState(scope)) metrics.headReads += 1;
      if (name === key.entityRegistry(scope)) metrics.registryReads += 1;
      return raw.has(name) ? clone(raw.get(name)) : clone(fallback);
    },
    async setJson(storageKey, value) {
      metrics.writes.push({ op: 'set', key: String(storageKey) });
      raw.set(String(storageKey), clone(value));
      return clone(value);
    },
    async remove(storageKey) {
      metrics.writes.push({ op: 'remove', key: String(storageKey) });
      raw.delete(String(storageKey));
    }
  };

  const statePipelineReplayRefs = value => [
    ...asArray(value?.inheritedMemories), ...Object.values(asObject(value?.memories))
  ].filter(ref => ref?.status === 'committed' && ref?.key)
    .sort((a, b) => Number(a?.turnRange?.start || 0) - Number(b?.turnRange?.start || 0));
  const continuityStateRefs = statePipelineReplayRefs;
  const emptyContinuityState = (currentScope, currentManifest) => ({
    schema: schemas.continuity, provenanceVersion: 4, scopeKey: currentScope.scopeKey, worldlineId: 'main',
    throughTurn: 0, characters: [], relationships: [], world: [], narrative: { summary: '', arcs: [], threads: [] },
    domainStatus: {
      characters: { status: 'ready', reviewedThroughTurn: 0, changedThroughTurn: 0 },
      narrative: { status: 'ready', reviewedThroughTurn: 0, changedThroughTurn: 0 }
    },
    basis: { refs: statePipelineReplayRefs(currentManifest).map(ref => ref.key) }, appliedCorrectionIds: []
  });
  const normalizeContinuityStateHead = value => {
    if (!value || !Array.isArray(value.characters)) return null;
    return {
      ...clone(value), relationships: asArray(value.relationships), world: asArray(value.world),
      narrative: { summary: '', arcs: [], threads: [], ...clone(asObject(value.narrative)) },
      domainStatus: clone(asObject(value.domainStatus)), appliedCorrectionIds: asArray(value.appliedCorrectionIds)
    };
  };
  const buildCanonicalEntityRegistry = (artifact, previous, options = {}) => {
    const byId = new Map(asArray(previous?.entities).map(row => [row.id, clone(row)]));
    const approved = new Set(asArray(options.approvedPersonAssertionIds));
    for (const row of asArray(artifact?.characters)) {
      if (!byId.has(row.id) && !approved.has(row.assertionId)) continue;
      byId.set(row.id, { id: row.id, name: row.name, aliases: asArray(row.aliases) });
    }
    const entities = Array.from(byId.values());
    return { schema: schemas.registry, scopeKey: options.scopeKey || previous?.scopeKey || '', entities, byId: Object.fromEntries(entities.map(row => [row.id, row])), fingerprint: digest(entities) };
  };
  const applyStateCorrectionsAtAnchor = (headValue, journal, anchorTurn) => {
    const next = clone(headValue);
    next.appliedCorrectionIds = asArray(next.appliedCorrectionIds);
    for (const record of asArray(journal?.records)) {
      if (record.status !== 'active' || Number(record?.anchor?.throughTurn || 0) !== Number(anchorTurn)) continue;
      if (next.appliedCorrectionIds.includes(record.correctionId)) continue;
      metrics.correctionApplications.set(record.correctionId, (metrics.correctionApplications.get(record.correctionId) || 0) + 1);
      next.appliedCorrectionIds.push(record.correctionId);
      if (record?.after?.narrative) next.narrative = { ...asObject(next.narrative), ...clone(record.after.narrative) };
    }
    return { head: next };
  };
  const applyDelta = (headValue, memory) => {
    const next = clone(headValue);
    for (const patch of asArray(memory?.stateDelta?.characters)) {
      let row = asArray(next.characters).find(item => item.id === patch.id);
      if (!row) {
        row = { id: patch.id, name: patch.name, aliases: [], state: {} };
        next.characters.push(row);
      }
      row.name = patch.name || row.name;
      row.state = { ...asObject(row.state), ...clone(asObject(patch.set)) };
      for (const field of asArray(patch.clear)) delete row.state[field];
    }
    if (memory?.stateDelta?.narrative) next.narrative = { ...asObject(next.narrative), ...clone(memory.stateDelta.narrative) };
    const cursor = { key: memory.memoryId, end: Number(memory?.turnRange?.end || 0) };
    for (const statusKey of ['characters', 'narrative']) {
      next.domainStatus[statusKey] = {
        ...asObject(next.domainStatus[statusKey]), status: 'ready', reviewedThroughCanonical: cursor,
        reviewedThroughTurn: Number(memory?.turnRange?.end || 0), changedThroughCanonical: cursor,
        changedThroughTurn: Number(memory?.turnRange?.end || 0)
      };
    }
    next.reviewedThroughCanonical = cursor;
    return next;
  };

  const context = {
    Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Map, Set,
    clone, asObject, asArray, string, compact, stableReferenceJson, digest, canonicalStoredDigest,
    continuityStateNameKey, storage, key,
    MANIFEST_SCHEMA: schemas.manifest,
    CANONICAL_ARTIFACT_SCHEMA: schemas.artifact,
    CANONICAL_ARTIFACT_LEGACY_SCHEMA: schemas.legacyArtifact,
    CANONICAL_MANUAL_AUTHORITY_SCHEMA: schemas.manualAuthority,
    CONTINUITY_STATE_SCHEMA: schemas.continuity,
    CONTINUITY_STATE_PROVENANCE_VERSION: 4,
    CONTINUITY_STATE_BASIS_SCHEMA: 'libra.continuity_basis.v2',
    ENTITY_REGISTRY_SCHEMA: schemas.registry,
    STATE_OBSERVATION_SCHEMA: schemas.observation,
    STATE_PIPELINE_RECEIPT_SCHEMA: schemas.pipelineReceipt,
    STATE_CORRECTION_EVENT_SCHEMA: 'libra.state_correction.v1',
    STATE_CORRECTION_PATCH_SCHEMA: 'libra.state_correction_patch.v2',
    CURRENT_NARRATIVE_STATE_SCHEMA: 'libra.narrative_current_state.v2',
    CONTINUITY_STATE_MAX_CHARACTERS: 96,
    CONTINUITY_STATE_MAX_RELATIONSHIPS: 192,
    CONTINUITY_STATE_MAX_WORLD_RECORDS: 128,
    STATE_PIPELINE_DOMAINS: ['character', 'narrative'],
    STATE_PIPELINE_DOMAIN_HEAD_KEYS: { character: 'characters', narrative: 'narrative' },
    CONTINUITY_STATE_RELATION_DIMENSIONS: ['ally', 'enemy', 'other'],
    statePipelineReplayRefs, continuityStateRefs,
    statePipelineBasisCursor: statePipelineBasisCursorFixture,
    statePipelineCursorForRef: statePipelineCursorForRefFixture,
    statePipelineCursorMatchesRef: (cursor, ref, worldlineId = '') =>
      digest(statePipelineBasisCursorFixture(cursor)) === digest(statePipelineCursorForRefFixture(ref, worldlineId)),
    statePipelineHeadFingerprint: head => `headfp:${Number(head?.throughTurn || 0)}`,
    continuityStateFingerprint: refs => digest({ schema: 'libra.continuity_basis.v2', refs: asArray(refs) }),
    loadStateWorldlineMeta: async () => clone(raw.get(key.stateWorldlineMeta(scope))),
    loadSettings: async () => {
      metrics.settingsReads += 1;
      throw new Error('load_settings_forbidden_in_read_only_prefix_materializer');
    },
    loadStateCorrectionJournal: async () => clone(raw.get(key.stateCorrections(scope))),
    stateCorrectionMetaFromJournal: (_currentScope, journal) => correctionMetaFor(journal),
    stateCorrectionMetaCommitCoherent: (meta, commit) => !!meta && !!commit && commit.status === 'committed'
      && Number(commit.targetJournalRevision) === Number(meta.journalRevision)
      && string(commit.targetJournalDigest) === string(meta.journalDigest),
    correctionBasisFingerprintForTurn: (_manifest, turn) => `basis:${Number(turn)}`,
    buildCanonicalEntityRegistry, emptyContinuityState, normalizeContinuityStateHead,
    continuityStateBasis: refs => ({ refs: asArray(refs).map(ref => ref.key), sourceFingerprint: digest(asArray(refs).map(ref => ref.key)) }),
    continuityEvidence: memory => ({ memoryId: memory.memoryId, revision: memory.revision }),
    applyStateCorrectionsAtAnchor,
    loadMemoryRef: async ref => {
      metrics.memoryReads.push(String(ref?.key || ''));
      return storage.getJson(ref?.key, null);
    },
    normalizeCanonicalArtifactForRead: value => value?.schema === schemas.artifact || value?.schema === schemas.legacyArtifact ? clone(value) : null,
    validateCanonicalManualAuthoritySeal: memory => {
      const authority = asObject(memory?.manualAuthority);
      if (authority.schema !== schemas.manualAuthority || authority.parentKey !== target.ref.key
        && authority.parentKey !== 'memory:wrong-parent') throw new Error('canonical_manual_authority_invalid');
      if (authority.sourceDigest !== memory?.sourceDigest || digest(authority.turnRange) !== digest(memory?.turnRange)) {
        throw new Error('canonical_manual_authority_invalid');
      }
      return clone(authority);
    },
    memoryRefForStart: (value, start) => statePipelineReplayRefs(value)
      .find(ref => Number(ref?.turnRange?.start || 0) === Number(start)) || null,
    canonicalVariantId: value => digest({ scopeKey: value?.scopeKey, key: value?.key, revision: value?.revision }).slice(0, 24),
    statePipelineLogicalReplayBinding: ({ ref, memory }) => ({ ok: ref?.memoryId === memory?.memoryId }),
    statePipelineManualReplayBinding: ({ ref, memory }) => ({ ok: ref?.memoryId === memory?.memoryId }),
    verifyStatePipelineArchiveMembership: async () => ({ ok: true }),
    statePipelinePersonAdmissionPacket: artifact => ({
      candidates: asArray(artifact?.characters).map(row => ({ assertionId: row.assertionId })),
      assertionIds: asArray(artifact?.characters).map(row => row.assertionId)
    }),
    entityAdmissionBasisFor: ({ memory, packet }) => ({ memoryId: memory.memoryId, artifactDigest: digest(memory.canonicalArtifact), assertionIds: clone(packet.assertionIds) }),
    entityAdmissionStorageKey: (currentScope, memoryId, revision) => `admission:${currentScope.scopeKey}:${memoryId}:r${revision}`,
    validateEntityAdmissionReceipt: (receipt, { basis }) => {
      const ok = receipt?.schema === schemas.admission && receipt?.memoryId === basis.memoryId && receipt?.artifactDigest === basis.artifactDigest
        && ['complete', 'not_required', 'failed_closed'].includes(receipt?.status);
      return {
        ok, status: ok ? receipt.status : '', reason: ok ? '' : 'entity_admission_receipt_invalid',
        approvedPersonAssertionIds: ok ? clone(receipt.approvedPersonAssertionIds) : []
      };
    },
    applyVerifiedStateObservation: (headValue, observation) => ({
      ok: true, head: applyDelta(headValue, memories[asArray(Object.keys(memories))
        .find(storageKey => memories[storageKey]?.memoryId === observation?.memoryId)]),
      changed: true, appliedPatches: [{}], rejectedPatches: [], diagnostics: []
    }),
    statePipelineAssertionsForDomain: () => [],
    persistStateReplayHead: async () => { throw new Error('persistent_replay_forbidden'); },
    validateManualStateDispositionReceipt: ({ receipt, memory }) => {
      const ok = receipt?.schema === schemas.manualReceipt && receipt?.valid === true && receipt?.memoryId === memory?.memoryId
        && receipt?.intentDigest === memory?.manualStateDisposition?.intentDigest;
      return { ok, reason: ok ? '' : 'manual_state_disposition_receipt_invalid', status: 'manual_maintained', intent: clone(memory?.manualStateDisposition), domains: ['character', 'narrative'] };
    },
    loadContinuityDelta: async (_currentScope, memory) => fault === 'legacy_delta_missing' && memory?.memoryId === target.memory.memoryId ? null : clone(memory?.stateDelta || null),
    updateContinuityStateAfterCommit: async ({ memory, baseHead }) => ({ head: applyDelta(baseHead, memory) }),
    validateManualStateDispositionIntent: ({ intent }) => clone(intent),
    resolveStateCorrectionIdentity: ({ rows, id, label }) => {
      const candidates = asArray(rows);
      if (id) return candidates.find(row => row.id === id) || null;
      const keyValue = continuityStateNameKey(label);
      const matches = candidates.filter(row => [row.name, ...asArray(row.aliases)].some(value => continuityStateNameKey(value) === keyValue));
      return matches.length === 1 ? matches[0] : null;
    },
    stateStoredValueDigest: value => digest(value),
    isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    statePipelineStableObject: stableValue,
    statePipelineSemanticValue: (_field, value) => stableValue(value),
    statePipelineSemanticEqual: (_field, left, right) => JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right)),
    continuityStateAliases: value => asArray(value).map(string).filter(Boolean),
    continuityEntityId: (scopeValue, kind, identity) => `cs_${kind}_${digest([scopeValue?.scopeKey || '', kind, continuityStateNameKey(identity)]).slice(0, 24)}`,
    normalizeContinuityStateSet: value => clone(asObject(value)),
    normalizeCurrentNarrativeState: value => ({
      schema: 'libra.narrative_current_state.v2', summary: string(value?.summary || ''), primaryArcId: string(value?.primaryArcId || ''),
      arcs: clone(asArray(value?.arcs)), threads: clone(asArray(value?.threads)), locks: clone(asArray(value?.locks)), momentum: clone(value?.momentum || ''),
      fieldEvidence: clone(asObject(value?.fieldEvidence)), clearedFieldEvidence: clone(asObject(value?.clearedFieldEvidence)),
      fieldCorrectionProvenance: clone(asObject(value?.fieldCorrectionProvenance)), clearedFieldCorrectionProvenance: clone(asObject(value?.clearedFieldCorrectionProvenance)),
      correctionProvenance: value?.correctionProvenance ? clone(value.correctionProvenance) : null
    }),
    __libraNarrativeNormalizePatch: value => ({ ok: true, patch: clone(value) }),
    __libraNarrativeApplyPatch: (current, patch) => ({ ...clone(asObject(current)), ...clone(asObject(patch)) }),
    stateCorrectionFailure: (code, message = code) => Object.assign(new Error(message), { code }),
    nowIso: () => '2026-09-01T04:00:00.000Z',
    LibraProviderBridge: { callTask: async () => { metrics.providerCalls += 1; throw new Error('provider_call_forbidden'); } }
  };
  Object.assign(context, require('./fixtures/librarian_production_bindings.cjs')(source));
  vm.createContext(context);
  vm.runInContext(`
${neutralizeSource}
${receiptDependencySource}
${durableReplaySource}
${prefixSource}
${normalizeCorrectionSource}
this.api = {
  loadManualStateDispositionAnchorHeads,
  assertManualStateDispositionAnchorCas,
  validateManualStateDispositionAgainstAnchor
};`, context, { filename: 'libra-manual-anchor-materializer-runtime.js', timeout: 5000 });
  return { api: context.api, context: { scope }, manifest, candidate, candidateKey, jobKey, raw, storage, key, metrics };
};

const mapDigest = raw => canonicalStoredDigest(Array.from(raw.entries()).sort(([a], [b]) => a.localeCompare(b)));

(async () => {
  const baseline = makeHarness();
  const baselineBytes = mapDigest(baseline.raw);
  const heads = clone(await baseline.api.loadManualStateDispositionAnchorHeads({
    context: baseline.context, manifest: clone(baseline.manifest), memory: clone(baseline.candidate)
  }));
  const alice = heads.throughOriginalTargetHead.characters.find(row => row.id === 'char_alice');
  assert.equal(alice?.state?.mood, 'focused', 'target value must replace the prior value');
  assert.equal(alice?.state?.keeps, 'yes', 'a field omitted at the target must preserve the prior value');
  assert.equal(alice?.state?.restored, 'present', 'a field cleared only by a successor must be restored in the historical prefix');
  assert.ok(heads.throughOriginalTargetHead.characters.some(row => row.id === 'char_target'),
    'an entity admitted by the target batch belongs to the target prefix Head');
  assert.ok(!heads.throughOriginalTargetHead.characters.some(row => row.id === 'char_future'),
    'a successor-only entity must not leak into the target prefix Head');
  assert.equal(heads.throughOriginalTargetHead.narrative.summary, 'target correction once',
    'the target correction must overlay the target narrative');
  assert.equal(heads.throughOriginalTargetHead.narrative?.correctionProvenance?.correctionId, 'correction_target_once',
    'the target correction must be bound to the materialized narrative exactly at its anchor');
  assert.notEqual(heads.throughOriginalTargetHead.narrative?.correctionProvenance?.correctionId, 'correction_future_never',
    'a future correction must remain excluded');
  assert.deepEqual(baseline.metrics.memoryReads, ['memory:prior', 'memory:target'],
    'the successor canonical must not even be loaded');
  assert.equal(baseline.metrics.headReads, 0, 'the latest durable Head must not seed the historical prefix');
  assert.equal(baseline.metrics.registryReads, 0, 'the latest durable Entity Registry must not seed the historical prefix');
  assert.equal(baseline.metrics.settingsReads, 0, 'read-only prefix replay must not load or migrate GUI settings');
  assert.equal(baseline.metrics.providerCalls, 0);
  assert.deepEqual(baseline.metrics.writes, []);
  assert.equal(mapDigest(baseline.raw), baselineBytes, 'read-only materialization must leave every durable record byte-equivalent');

  const binding = makeHarness({ corrections: false });
  binding.raw.set(binding.candidateKey, clone(binding.candidate));
  const targetIntent = {
    mode: 'sparse_correction', candidateKey: binding.candidateKey,
    target: { domain: 'characters', mode: 'profile_patch' },
    patch: { characters: [{ name: 'Target', state: { mood: 'user corrected' } }] }
  };
  const accepted = clone(await binding.api.validateManualStateDispositionAgainstAnchor({
    context: binding.context, manifest: clone(binding.manifest), memory: clone(binding.candidate), intent: clone(targetIntent)
  }));
  assert.equal(accepted.mode, 'sparse_correction', 'a target-batch entity must remain eligible at its own historical anchor');
  let futureError = null;
  try {
    await binding.api.validateManualStateDispositionAgainstAnchor({
      context: binding.context, manifest: clone(binding.manifest), memory: clone(binding.candidate),
      intent: {
        ...clone(targetIntent),
        patch: { characters: [{ name: 'Future', state: { mood: 'must reject' } }] }
      }
    });
  } catch (error) { futureError = error; }
  assert.match(String(futureError?.message || futureError), /canonical_manual_state_disposition_character_name_unbound/,
    'a successor-only entity must fail before candidate/job persistence');
  assert.deepEqual(binding.metrics.writes, []);
  assert.equal(binding.metrics.settingsReads, 0);
  assert.equal(binding.metrics.providerCalls, 0);

  const ambiguous = makeHarness({ corrections: false, ambiguousTarget: true });
  let ambiguousError = null;
  try {
    await ambiguous.api.loadManualStateDispositionAnchorHeads({
      context: ambiguous.context, manifest: clone(ambiguous.manifest), memory: clone(ambiguous.candidate)
    });
  } catch (error) { ambiguousError = error; }
  assert.match(String(ambiguousError?.message || ambiguousError),
    /canonical_manual_state_disposition_parent_ref_ambiguous/,
    'two refs matching the sealed manual parent must fail closed as ambiguous');
  assert.deepEqual(ambiguous.metrics.writes, []);
  assert.equal(ambiguous.metrics.providerCalls, 0);

  const parentMismatch = makeHarness({ corrections: false, parentMismatch: true });
  let parentMismatchError = null;
  try {
    await parentMismatch.api.loadManualStateDispositionAnchorHeads({
      context: parentMismatch.context, manifest: clone(parentMismatch.manifest), memory: clone(parentMismatch.candidate)
    });
  } catch (error) { parentMismatchError = error; }
  assert.match(String(parentMismatchError?.message || parentMismatchError),
    /canonical_manual_state_disposition_parent_(?:no_longer_active|ref_missing)/,
    'session/start coincidence must not retarget a candidate whose exact sealed parent differs');
  assert.deepEqual(parentMismatch.metrics.writes, []);
  assert.equal(parentMismatch.metrics.providerCalls, 0);

  const dependencyTamperCases = [
    {
      kind: 'memory',
      mutate: harness => { harness.raw.get(target.ref.key).sourceDigest = 'source:tampered-after-materialize'; }
    },
    {
      kind: 'entity_admission_receipt',
      mutate: harness => { harness.raw.get(`admission:${baseManifest.scopeKey}:${target.memory.memoryId}:r1`).artifactDigest = 'tampered-after-materialize'; }
    },
    {
      kind: 'state_pipeline_receipt',
      mutate: harness => { harness.raw.get(harness.key.statePipelineReceipt(harness.context.scope, target.memory.memoryId, 1)).authority = 'last_known_non_authoritative'; }
    },
    {
      kind: 'state_observation',
      mutate: harness => { harness.raw.get(harness.key.stateObservation(harness.context.scope, target.memory.memoryId, 1, 'character')).observationDigest = 'tampered-after-materialize'; }
    }
  ];
  for (const fixture of dependencyTamperCases) {
    const harness = makeHarness({ corrections: false });
    const materialized = await harness.api.loadManualStateDispositionAnchorHeads({
      context: harness.context, manifest: clone(harness.manifest), memory: clone(harness.candidate)
    });
    fixture.mutate(harness);
    let dependencyError = null;
    try {
      await harness.api.assertManualStateDispositionAnchorCas({ context: harness.context, cas: materialized.cas });
    } catch (error) { dependencyError = error; }
    assert.match(String(dependencyError?.message || dependencyError),
      /canonical_manual_state_disposition_anchor_dependency_changed/,
      `${fixture.kind} consumed during materialization must participate in the final CAS`);
    assert.deepEqual(harness.metrics.writes, []);
    assert.equal(harness.metrics.providerCalls, 0);
  }

  const failureCases = [
    { fault: 'admission_missing', expected: /prefix_admission_invalid/ },
    { fault: 'admission_tampered', expected: /prefix_admission_invalid/ },
    { fault: 'admission_failed_closed', expected: /prefix_admission_invalid:.*(?:nonterminal|failed_closed)/ },
    { fault: 'pipeline_receipt_missing', expected: /prefix_observation_invalid/ },
    { fault: 'pipeline_receipt_tampered', expected: /prefix_observation_invalid/ },
    { fault: 'pipeline_scope_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'pipeline_worldline_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'pipeline_memory_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'pipeline_revision_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'pipeline_source_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'pipeline_authority_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'pipeline_domain_set_tampered', expected: /prefix_(?:pipeline_receipt|observation)_invalid/ },
    { fault: 'observation_missing', expected: /prefix_observation_invalid/ },
    { fault: 'observation_tampered', expected: /prefix_observation_invalid/ },
    { fault: 'manual_receipt_missing', manualTarget: true, expected: /prefix_manual_receipt_invalid/ },
    { fault: 'manual_receipt_tampered', manualTarget: true, expected: /prefix_manual_receipt_invalid/ },
    { fault: 'legacy_delta_missing', legacyTarget: true, expected: /prefix_legacy_delta_missing/ }
  ];
  for (const fixture of failureCases) {
    const harness = makeHarness(fixture);
    const before = mapDigest(harness.raw);
    let error = null;
    try {
      await harness.api.validateManualStateDispositionAgainstAnchor({
        context: harness.context, manifest: clone(harness.manifest), memory: clone(harness.candidate),
        intent: {
          mode: 'sparse_correction', candidateKey: harness.candidateKey,
          target: { domain: 'characters', mode: 'profile_patch' },
          patch: { characters: [{ name: 'Alice', state: { mood: 'unchanged fixture' } }] }
        }
      });
    } catch (caught) { error = caught; }
    assert.match(String(error?.message || error), fixture.expected, `${fixture.fault} must fail closed at prefix replay`);
    assert.equal(harness.metrics.candidateReads, 0, `${fixture.fault} must fail before candidate readback/mutation`);
    assert.deepEqual(harness.metrics.writes, [], `${fixture.fault} must not write candidate/job/Head/Registry/journal records`);
    assert.equal(harness.metrics.settingsReads, 0, `${fixture.fault} must not load/migrate GUI settings`);
    assert.equal(harness.metrics.providerCalls, 0, `${fixture.fault} must make zero provider calls`);
    assert.equal(mapDigest(harness.raw), before, `${fixture.fault} must leave all durable records byte-equivalent`);
  }

  process.stdout.write(`libra_manual_anchor_materializer_runtime_test: PASS (${path.basename(sourcePath)})\n`);
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
