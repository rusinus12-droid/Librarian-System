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

const authoritySource = section(
  'const stripCanonicalAutomaticReceipts =',
  'const canonicalNextSlotRevision ='
);
const archiveSource = section(
  'const libraArchiveRefPointer =',
  'const inactiveHistoryEntryForRef ='
);
const memoryRefSource = section(
  'const memoryRefFromStoredMemory =',
  'const reactivateHistoricalRevision ='
);
const manualIntentSource = section(
  'const manualStateDispositionIntentProjection =',
  'const callStateObserver ='
);
const manualReplayBindingSource = section(
  'const statePipelineManualReplayBinding =',
  'const verifyCanonicalCommitEnvelope = async'
);
const rebuildSource = section(
  'const rebuildStateFromCanonicalChainUnlocked = async',
  '/* LIBRA CANONICAL STATE PIPELINE V3 RUNTIME END */'
);

assert.match(archiveSource, /validateManualCanonicalRefSeal\(\{ ref: sourceRef, memory: sourceMemory \}\)/,
  'archive creation must validate the exact source ref seals before writing');
assert.match(archiveSource, /rebindCanonicalManualAuthorityForCopy\(memory,[\s\S]*rebindManualStateDispositionIntent\(memory, \{ sourceMemory \}\)/,
  'archive creation must rebind authority first and disposition against the verified source second');
assert.match(archiveSource, /archiveRow\.recordDigest = libraArchiveRecordDigest\(archiveRow\)/,
  'archive refs must seal the rebound manual digests into the record digest');
assert.match(rebuildSource, /const manualCursor = statePipelineCursorForRef\(ref, worldlineId\)/,
  'manual replay must use the exact ref cursor, including authority/disposition seals');

const manualBranch = section(
  'if (memory?.manualAuthority?.schema === CANONICAL_MANUAL_AUTHORITY_SCHEMA && !memory?.canonicalArtifact) {',
  'const rawArtifactSchema ='
);
const bindingIndex = manualBranch.indexOf('const manualBinding = statePipelineManualReplayBinding');
const membershipIndex = manualBranch.indexOf('const manualArchiveMembership = await verifyStatePipelineArchiveMembership');
const invalidGuardIndex = manualBranch.indexOf('if (manualBinding.ok !== true || manualArchiveMembership.ok !== true)');
const dispositionIndex = manualBranch.indexOf('disposition = await ensureManualStateDispositionBinding');
assert.ok(bindingIndex >= 0 && membershipIndex > bindingIndex && invalidGuardIndex > membershipIndex && dispositionIndex > invalidGuardIndex,
  'logical binding and archive membership must fail closed before any manual disposition can create a correction');
assert.match(manualBranch.slice(invalidGuardIndex, dispositionIndex), /state_rebuild_manual_identity_mismatch[\s\S]*continue;/,
  'forged inherited manual records take the skip path before disposition replay');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const string = value => String(value ?? '').trim();
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
const stableHash = value => digest(value).slice(0, 24);
const raw = new Map();
const storage = {
  async getJson(key, fallback = null) {
    return raw.has(String(key)) ? clone(raw.get(String(key))) : clone(fallback);
  },
  async setJson(key, value) {
    raw.set(String(key), clone(value));
    return clone(value);
  },
  async remove(key) {
    raw.delete(String(key));
  },
  async keys() {
    return Array.from(raw.keys());
  }
};

const key = {
  manifest: scope => `manifest:${scope.scopeKey}`,
  archiveManifest: archiveId => `archive:${archiveId}:manifest`,
  archiveMemory: (archiveId, canonicalId, revision) => `archive:${archiveId}:memory:${canonicalId}:r${revision}`,
  archiveVector: (archiveId, canonicalId, revision, profileId) => `archive:${archiveId}:vector:${canonicalId}:r${revision}:${profileId}`,
  manualStateDisposition: (scope, memoryId, revision) => `manual-disposition:${scope.scopeKey}:${memoryId}:r${revision}`,
  statePipelineReceipt: (scope, memoryId, revision) => `state-receipt:${scope.scopeKey}:${memoryId}:r${revision}`
};

let correctionWrites = 0;
const context = {
  Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Set, Map,
  structuredClone: globalThis.structuredClone,
  safeClone: clone, clone, asObject, asArray, isPlainObject, string,
  stableReferenceJson, digest, stableHash,
  stableDraftHash: value => digest(value).slice(0, 32),
  nowIso: () => '2026-09-01T01:02:03.000Z',
  sourcePairs: value => clone(asArray(value)),
  memorySummary: value => string(value).slice(0, 80),
  memoryRefSessionEpoch: ref => Number(ref?.sessionEpoch || 0),
  continuityStateRefs: manifest => [
    ...asArray(manifest?.inheritedMemories), ...Object.values(asObject(manifest?.memories))
  ].filter(ref => ref?.status === 'committed' && ref?.key),
  listMemoryRefs: manifest => Object.values(asObject(manifest?.memories)),
  loadMemoryRef: async ref => storage.getJson(ref?.key, null),
  mapWithConcurrency: async (items, mapper) => Promise.all(asArray(items).map(mapper)),
  projectionHasVectorPayload: () => false,
  portableVectorSemanticFingerprint: value => digest(value),
  storage, key,
  MANIFEST_SCHEMA: 'libra.manifest.v1',
  LIBRA_SHARED_ARCHIVE_SCHEMA: 'libra.shared_archive.v2',
  LIBRA_SHARED_ARCHIVE_REF_SCHEMA: 'libra.shared_archive_ref.v2',
  LIBRA_SHARED_ARCHIVE_MAX_DEPTH: 16,
  CANONICAL_MANUAL_AUTHORITY_SCHEMA: 'libra.canonical_manual_authority.v1',
  CANONICAL_MANUAL_STATE_DISPOSITION_SCHEMA: 'libra.canonical_manual_state_disposition.v1',
  MANUAL_STATE_DISPOSITION_RECEIPT_SCHEMA: 'libra.manual_state_disposition_receipt.v1',
  CONTINUITY_STATE_PROVENANCE_VERSION: 4,
  STATE_CORRECTION_EVENT_SCHEMA: 'libra.state_correction_event.v1',
  RETRIEVAL_PROJECTION_VERSION: 'libra.retrieval_projection.v2',
  PREFIX: 'libra:v1',
  correctionBasisFingerprintForTurn: (manifest, turn) => digest({ manifest: clone(manifest), turn }),
  normalizeStateCorrectionPayload: ({ patch, target }) => ({ patch: clone(patch), target: clone(target) }),
  stateCorrectionDefaultStore: scope => ({ schema: 'libra.state_corrections.v1', scopeKey: scope.scopeKey, records: [] }),
  saveStateCorrectionJournal: async (_scope, journal) => {
    correctionWrites += 1;
    return clone(journal);
  }
};
vm.createContext(context);
vm.runInContext(`
${section('const UNIFIED_ARTIFACT_SCHEMA =', 'const UNIFIED_PATCH_SCHEMA =')}
${section('const unifiedRefIsReadableUnified =', 'const unifiedInheritedRef =')}
${section('const unifiedOriginIdentity =', 'const unifiedEvidenceRead =')}
${section('const rebindUnifiedTransferredMemory =', 'const unifiedCapsuleDigest =')}
${authoritySource}
${archiveSource}
${memoryRefSource}
${manualIntentSource}
${manualReplayBindingSource}
this.api = {
  createCanonicalManualAuthority,
  validateCanonicalManualAuthoritySeal,
  manualStateDispositionIntentDigest,
  validateManualStateDispositionIntent,
  validateManualCanonicalRefSeal,
  ensureManualStateDispositionBinding,
  ensureLibraSharedArchive,
  readLibraSharedArchive,
  libraArchiveRecordDigest,
  memoryRefFromStoredMemory,
  statePipelineManualReplayBinding,
  verifyStatePipelineArchiveMembership
};`, context, { filename: 'libra-manual-archive-transfer-runtime.js', timeout: 5000 });
const api = context.api;

const sourceScope = { scopeKey: 'scope:manual-source' };
const targetScope = { scopeKey: 'scope:manual-target' };
const sourceText = '# 종합 기억\n사용자가 직접 확정한 정본';
const sourceMemory = {
  schema: 'libra.canonical_memory.v1', status: 'committed',
  scopeKey: sourceScope.scopeKey, memoryId: 'mem_manual_0001', revision: 3,
  worldlineId: 'main', turnRange: { start: 1, end: 5 },
  sourceDigest: 'source-digest-manual-1', sourcePairs: [{ user: 'u1', assistant: 'a1' }],
  text: sourceText, summary: '사용자 정본', createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
  renderValidation: { ok: true, contentHash: digest(sourceText) },
  retrieval: { version: 'libra.retrieval_projection.v2' },
  embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' }
};
const sourceKey = 'memory:scope:manual-source:1:r3';
sourceMemory.manualAuthority = clone(api.createCanonicalManualAuthority({
  scope: sourceScope,
  parentRef: { key: 'memory:scope:manual-source:1:r2', revision: 2 },
  memory: sourceMemory,
  batch: sourceMemory.sourcePairs,
  text: sourceText,
  status: 'committed',
  createdAt: sourceMemory.createdAt
}));
sourceMemory.manualAuthority.adoptedAt = '2026-08-31T00:01:00.000Z';
const sourceIntent = {
  schema: 'libra.canonical_manual_state_disposition.v1', mode: 'maintained_by_user',
  jobId: 'job-manual-source', candidateId: 'variant-manual-source', candidateKey: sourceKey,
  memoryId: sourceMemory.memoryId, revision: sourceMemory.revision,
  sourceDigest: sourceMemory.sourceDigest,
  contentHash: sourceMemory.manualAuthority.contentHash,
  authorityHash: sourceMemory.manualAuthority.authorityHash,
  target: { domain: 'head', mode: 'profile_patch' }, patch: null,
  createdAt: '2026-08-31T00:00:30.000Z', intentDigest: ''
};
sourceIntent.intentDigest = api.manualStateDispositionIntentDigest(sourceIntent);
sourceMemory.manualStateDisposition = clone(sourceIntent);
sourceMemory.stateTrackingDisposition = 'manual_state_disposition_declared';

const sourceRef = clone(api.memoryRefFromStoredMemory(sourceMemory, sourceKey, [], sourceMemory.createdAt));
assert.equal(api.validateManualCanonicalRefSeal({ ref: sourceRef, memory: sourceMemory }).manual, true,
  'fixture begins with a fully verified source authority/disposition/ref seal');

const sourceManifest = {
  schema: 'libra.manifest.v1', scopeKey: sourceScope.scopeKey,
  branchGuard: { status: 'ready' }, archiveRef: null, inheritedMemories: [],
  memories: { 1: clone(sourceRef) }
};

(async () => {
  await storage.setJson(key.manifest(sourceScope), sourceManifest);
  await storage.setJson(sourceKey, sourceMemory);
  const archiveResult = clone(await api.ensureLibraSharedArchive(
    { scope: sourceScope }, sourceManifest, [sourceRef], [sourceMemory],
    { vectorResolver: async () => null }
  ));
  assert.equal(archiveResult.changed, true);
  assert.equal(archiveResult.memoryRefs.length, 1);
  const archiveRef = archiveResult.memoryRefs[0];
  const archivedMemory = clone(await storage.getJson(archiveRef.key, null));
  assert.ok(archivedMemory);
  assert.notEqual(archivedMemory.memoryId, sourceMemory.memoryId,
    'archive storage receives its own physical memory identity');
  assert.equal(archivedMemory.scopeKey, `archive:${archiveResult.archiveRef.archiveId}`);
  assert.equal(archivedMemory.manualAuthority.scopeKey, archivedMemory.scopeKey);
  assert.equal(archivedMemory.manualAuthority.memoryId, archivedMemory.memoryId,
    'manual authority is rebound to the archive memory identity');
  assert.equal(archivedMemory.manualAuthority.nativeCopySourceAuthorityHash, sourceMemory.manualAuthority.authorityHash);
  assert.notEqual(archivedMemory.manualAuthority.authorityHash, sourceMemory.manualAuthority.authorityHash);
  assert.equal(archivedMemory.manualStateDisposition.memoryId, archivedMemory.memoryId);
  assert.equal(archivedMemory.manualStateDisposition.authorityHash, archivedMemory.manualAuthority.authorityHash,
    'manual disposition is rebound after the new archive authority seal exists');
  assert.notEqual(archivedMemory.manualStateDisposition.intentDigest, sourceMemory.manualStateDisposition.intentDigest);
  assert.equal(api.validateCanonicalManualAuthoritySeal(archivedMemory, { allowedScopeKeys: [archivedMemory.scopeKey] }).authorityHash,
    archivedMemory.manualAuthority.authorityHash);
  assert.equal(api.validateManualStateDispositionIntent({ intent: archivedMemory.manualStateDisposition, memory: archivedMemory }).intentDigest,
    archivedMemory.manualStateDisposition.intentDigest);
  assert.equal(archiveRef.memoryId, archivedMemory.memoryId);
  assert.equal(archiveRef.manualAuthorityHash, archivedMemory.manualAuthority.authorityHash);
  assert.equal(archiveRef.manualStateDispositionDigest, archivedMemory.manualStateDisposition.intentDigest);
  assert.equal(archiveRef.recordDigest, api.libraArchiveRecordDigest(archiveRef),
    'record digest seals the exact rebound manual identity fields');
  const verifiedArchive = clone(await api.readLibraSharedArchive(archiveResult.archiveRef));
  assert.equal(verifiedArchive.verified, true);
  assert.equal(verifiedArchive.memoryRefs[0].recordDigest, archiveRef.recordDigest);
  const archiveManifestBeforeTamper = clone(await storage.getJson(archiveResult.archiveRef.manifestKey, null));
  const tamperedArchiveManifest = clone(archiveManifestBeforeTamper);
  tamperedArchiveManifest.memoryRefs[0].manualAuthorityHash = 'forged-stored-authority';
  await storage.setJson(archiveResult.archiveRef.manifestKey, tamperedArchiveManifest);
  const tamperedArchiveRead = clone(await api.readLibraSharedArchive(archiveResult.archiveRef));
  assert.equal(tamperedArchiveRead.verified, false,
    'a stored manual seal cannot be changed while retaining the original archive record digest');
  assert.equal(tamperedArchiveRead.reason, 'archive_record_digest_mismatch');
  await storage.setJson(archiveResult.archiveRef.manifestKey, archiveManifestBeforeTamper);
  assert.equal((await api.readLibraSharedArchive(archiveResult.archiveRef)).verified, true,
    'restoring the exact archived bytes restores membership verification');

  const transferId = 'portable-manual-transfer-1';
  const inheritedRef = {
    ...clone(archiveRef), inheritedSessionHistory: true, archiveShared: true,
    handoffTransferId: transferId, sourceSessionScopeKey: sourceScope.scopeKey
  };
  const targetManifest = {
    schema: 'libra.manifest.v1', scopeKey: targetScope.scopeKey,
    archiveRef: clone(archiveResult.archiveRef),
    inheritedMemories: [clone(inheritedRef)], memories: {},
    portableImports: [{
      importId: transferId, sourceScopeKey: sourceScope.scopeKey, targetScopeKey: targetScope.scopeKey,
      archiveId: archiveResult.archiveRef.archiveId, archiveDigest: archiveResult.archiveRef.digest,
      verified: true, durable: true
    }]
  };
  const logical = clone(api.statePipelineManualReplayBinding({
    context: { scope: targetScope }, ref: inheritedRef, memory: archivedMemory, worldlineId: 'main'
  }));
  assert.equal(logical.ok, true,
    'the physically archived manual canon is logically replayable only through the target ref');
  const membership = clone(await api.verifyStatePipelineArchiveMembership({
    manifest: targetManifest, ref: inheritedRef, memory: archivedMemory
  }));
  assert.equal(membership.ok, true,
    'verified archive membership and the authenticated portable route jointly authorize replay');

  for (const [name, refPatch, memoryPatch] of [
    ['archive id', { archiveId: 'forged-archive' }, {}],
    ['archive canonical id', { archiveCanonicalId: 'forged-canonical' }, {}],
    ['manual authority hash', { manualAuthorityHash: 'forged-authority' }, {}],
    ['manual disposition digest', { manualStateDispositionDigest: 'forged-disposition' }, {}],
    ['physical owner', {}, { scopeKey: 'archive:forged-owner' }]
  ]) {
    const forgedRef = { ...clone(inheritedRef), ...refPatch };
    const forgedMemory = { ...clone(archivedMemory), ...memoryPatch };
    assert.equal(api.statePipelineManualReplayBinding({
      context: { scope: targetScope }, ref: forgedRef, memory: forgedMemory, worldlineId: 'main'
    }).ok, false, `forged ${name} must fail manual logical binding`);
    if (Object.keys(refPatch).length) {
      const forgedMembership = clone(await api.verifyStatePipelineArchiveMembership({
        manifest: targetManifest, ref: forgedRef, memory: forgedMemory
      }));
      assert.equal(forgedMembership.ok, false, `forged ${name} must fail exact archive membership`);
    }
  }

  for (const [name, manifestValue, refValue] of [
    ['missing route', { ...targetManifest, portableImports: [] }, inheritedRef],
    ['forged transfer', targetManifest, { ...inheritedRef, handoffTransferId: 'forged-transfer' }],
    ['forged source', targetManifest, { ...inheritedRef, sourceSessionScopeKey: 'scope:forged-source' }]
  ]) {
    const result = clone(await api.verifyStatePipelineArchiveMembership({
      manifest: manifestValue, ref: refValue, memory: archivedMemory
    }));
    assert.equal(result.ok, false, `${name} cannot authorize inherited manual replay`);
    assert.equal(result.reason, 'logical_replay_archive_transfer_unbound');
  }

  const beforeForgedArchive = stableReferenceJson(Array.from(raw.entries()).sort(([a], [b]) => a.localeCompare(b)));
  const forgedSourceRef = { ...clone(sourceRef), manualAuthorityHash: 'forged-source-authority' };
  await assert.rejects(
    () => api.ensureLibraSharedArchive({ scope: sourceScope }, sourceManifest, [forgedSourceRef], [sourceMemory]),
    /canonical_manual_ref_seal_mismatch/,
    'a forged manual source ref is rejected before archive hydration'
  );
  assert.equal(stableReferenceJson(Array.from(raw.entries()).sort(([a], [b]) => a.localeCompare(b))), beforeForgedArchive,
    'rejected source seals leave archive storage byte-for-byte unchanged');

  const forgedDispositionMemory = clone(archivedMemory);
  forgedDispositionMemory.manualStateDisposition.patch = { narrative: { summary: 'forged correction' } };
  const head = { characters: [], relationships: [], world: [], narrative: { summary: 'unchanged' } };
  const headBefore = clone(head);
  const receiptKey = key.manualStateDisposition(targetScope, archivedMemory.memoryId, archivedMemory.revision);
  correctionWrites = 0;
  await assert.rejects(
    () => api.ensureManualStateDispositionBinding({
      context: { scope: targetScope }, manifest: targetManifest,
      memory: forgedDispositionMemory, ref: inheritedRef, worldlineId: 'main',
      head, correctionJournal: { records: [] }
    }),
    /canonical_manual_state_disposition_(?:identity_mismatch|maintained_patch_forbidden)/,
    'a forged disposition fails semantic validation before correction or receipt persistence'
  );
  assert.equal(correctionWrites, 0);
  assert.equal(await storage.getJson(receiptKey, null), null);
  assert.deepEqual(head, headBefore, 'forged disposition changes no Current State values');

  process.stdout.write(`libra_manual_archive_transfer_runtime_test: PASS (${path.basename(sourcePath)})\n`);
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
