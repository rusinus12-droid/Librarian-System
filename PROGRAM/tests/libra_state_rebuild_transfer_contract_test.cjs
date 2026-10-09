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
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

const replayPersistence = between('const persistStateReplayHead = async', 'const replayDurableStateObservations = async');
assert.match(replayPersistence, /normalizeContinuityStateHead\(head, context\.scope, manifest, \{ requireCurrent: false \}\)/,
  'Head normalization must use the supplied target-chain manifest, never an empty-ref basis');
assert.match(replayPersistence, /continuityStateRefs\(manifest\)/);
assert.match(replayPersistence, /loadContinuityState\(context\.scope, manifest, \{ requireCurrent: true \}\)/,
  'durable readback must prove the same target-manifest basis');

const replayRefs = between('const statePipelineReplayRefs = manifest =>', 'const persistStateReplayHead = async');
assert.match(replayRefs, /manifest\?\.inheritedMemories/,
  'inherited predecessor canon is part of the state replay chain');

const envelopeVerification = between('const verifyCanonicalCommitEnvelope = async', 'const statePipelineHeadFingerprint =');
assert.match(envelopeVerification, /replayRef/,
  'archive relaxation is permitted only for an explicit replay ref, never a live commit');
assert.match(envelopeVerification, /statePipelineLogicalReplayBinding/);
const logicalBindingSource = between('const statePipelineLogicalReplayBinding =', 'const verifyCanonicalCommitEnvelope = async');
assert.match(logicalBindingSource, /archiveShared/);
assert.match(logicalBindingSource, /sourceSessionScopeKey/);
assert.match(logicalBindingSource, /physicalScopeKey/);
const logicalBindingContext = {
  asObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  string: value => String(value ?? '').trim(),
  digest: value => crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')
};
vm.createContext(logicalBindingContext);
vm.runInContext(`${logicalBindingSource}\nthis.bindReplayRef = statePipelineLogicalReplayBinding;`, logicalBindingContext);
const inheritedArtifact = { schema: 'libra.canonical_artifact.v3', chronology: [], characters: [] };
const inheritedDigest = logicalBindingContext.digest(inheritedArtifact);
const inheritedRef = {
  status: 'committed', key: 'archive:memory:1', memoryId: 'mem_archive_1', revision: 1,
  turnRange: { start: 1, end: 5 }, sourceDigest: 'source-archive', artifactDigest: inheritedDigest,
  inheritedSessionHistory: true, archiveShared: true, archiveId: 'archive-one', archiveCanonicalId: 'canonical-one',
  sourceSessionScopeKey: 'scope:source-provenance', worldlineId: 'source-main'
};
const inheritedMemory = {
  schema: 'libra.canonical_memory.v1', status: 'committed', scopeKey: 'archive:archive-one', worldlineId: 'source-main',
  archiveShared: true, archiveId: 'archive-one', archiveCanonicalId: 'canonical-one',
  archiveOriginScopeKey: 'scope:A-root',
  memoryId: inheritedRef.memoryId, revision: 1, turnRange: { start: 1, end: 5 },
  sourceDigest: inheritedRef.sourceDigest, artifactDigest: inheritedDigest, canonicalArtifact: inheritedArtifact
};
const inheritedBinding = logicalBindingContext.bindReplayRef({
  context: { scope: { scopeKey: 'scope:target' } }, ref: inheritedRef, memory: inheritedMemory, worldlineId: 'main'
});
assert.equal(inheritedBinding.ok, true,
  'a target logical ref may replay a byte-verified memory that remains physically owned by its shared archive');
assert.equal(inheritedBinding.targetScopeKey, 'scope:target');
assert.equal(inheritedBinding.physicalScopeKey, 'archive:archive-one');
for (const [name, refPatch, memoryPatch] of [
  ['archive id', { archiveId: 'archive-other' }, {}],
  ['canonical id', { archiveCanonicalId: 'canonical-other' }, {}],
  ['physical scope', {}, { scopeKey: 'archive:archive-other' }]
]) {
  const foreignBinding = logicalBindingContext.bindReplayRef({
    context: { scope: { scopeKey: 'scope:target' } }, ref: { ...inheritedRef, ...refPatch },
    memory: { ...inheritedMemory, ...memoryPatch }, worldlineId: 'main'
  });
  assert.equal(foreignBinding.ok, false, `an inherited ref cannot launder a mismatched ${name}`);
  assert.equal(foreignBinding.reason, 'logical_replay_physical_owner_mismatch');
}

const archiveMembershipSource = between('const verifyStatePipelineArchiveMembership = async', 'const verifyCanonicalCommitEnvelope = async');
assert.match(envelopeVerification, /await verifyStatePipelineArchiveMembership/);
assert.match(archiveMembershipSource, /lastSessionHandoff/);
assert.match(archiveMembershipSource, /portableImports/);
assert.match(archiveMembershipSource, /nativeChatCopy/);

const rebuild = between('const rebuildStateFromCanonicalChainUnlocked = async', '/* LIBRA CANONICAL STATE PIPELINE V3 RUNTIME END */');
assert.match(rebuild, /state_rebuild_(?:incomplete|chain_incomplete|result_incomplete)|state_pipeline_rebuild_incomplete/,
  'identity skips or an empty/partial Head must make v3 rebuild explicitly incomplete');
assert.doesNotMatch(rebuild, /return \{ ok: true, skipped: false[^\n]*warnings, results, providerCalls \};/,
  'a warning-only return must not claim an unconditionally successful rebuild');
const transferRebuild = between('const rebuildStateAfterCanonicalTransfer = async', '/* LIBRA CANONICAL STATE PIPELINE V3 RUNTIME END */');
assert.match(transferRebuild, /rebuildStateFromCanonicalChain\(/,
  'every transfer surface shares the same target canonical-chain rebuild authority');
assert.match(transferRebuild, /pending:/);
assert.match(transferRebuild, /row\?\.partial !== true/,
  'a partial durable replay row cannot count toward transfer rebuild completeness');

const handoff = between('const adoptSessionHandoff = async', 'const deleteCurrentScope = async');
assert.match(handoff, /rebuildStateAfterCanonicalTransfer\(/,
  'session handoff must derive Registry and Head from the adopted target chain');
assert.doesNotMatch(handoff, /rebaseContinuityStateHead\(handoffContinuityStateSeed/,
  'a source Head seed is not target-chain authority');
assert.match(handoff, /continuityRebuildPending/,
  'handoff receipts must expose incomplete state derivation');

const predecessorImport = between('const importPortableAsPredecessorArchive = async', 'const importPortableAsNativeCopy = async');
assert.match(predecessorImport, /rebuildStateAfterCanonicalTransfer\(/,
  'predecessor archive import must derive Registry and Head from target logical refs');
assert.doesNotMatch(predecessorImport, /rebaseContinuityStateHead\(bundle\.continuityState/,
  'portable source Head is not target-chain authority');

const nativeCopy = between('const importPortableAsNativeCopy = async', 'const deleteFailedRun = async');
assert.match(nativeCopy, /rebuildStateAfterCanonicalTransfer\(/,
  'native-copy reconstruction must derive Registry and Head from the copied target chain');
assert.doesNotMatch(nativeCopy, /rebaseContinuityStateHead\(bundle\.continuityState/,
  'native copy must not substitute a rebased source Head for target-chain replay');
assert.doesNotMatch(nativeCopy, /continuityRebuildPending:\s*false/,
  'an incomplete copy rebuild cannot advertise continuityRebuildPending:false');

const exerciseMultiHopArchiveRoute = async () => {
  const membershipContext = {
    asObject: logicalBindingContext.asObject,
    asArray: value => Array.isArray(value) ? value : [],
    string: logicalBindingContext.string,
    normalizeLibraArchiveRef: value => ({ ...(value || {}) }),
    readLibraSharedArchive: async () => ({ verified: true, memoryRefs: [{ ...inheritedRef }] })
  };
  vm.createContext(membershipContext);
  vm.runInContext(`${archiveMembershipSource}\nthis.verifyMembership = verifyStatePipelineArchiveMembership;`, membershipContext);
  const targetManifest = {
    scopeKey: 'scope:C-target',
    archiveRef: { archiveId: 'archive-one', digest: 'archive-digest' },
    lastSessionHandoff: {
      transferId: 'transfer-B-to-C', sourceScopeKey: 'scope:B-immediate', targetScopeKey: 'scope:C-target',
      archiveId: 'archive-one', archiveDigest: 'archive-digest'
    },
    portableImports: []
  };
  const multiHopRef = {
    ...inheritedRef, handoffTransferId: 'transfer-B-to-C', sourceSessionScopeKey: 'scope:B-immediate'
  };
  const multiHop = await membershipContext.verifyMembership({ manifest: targetManifest, ref: multiHopRef, memory: inheritedMemory });
  assert.equal(multiHop.ok, true,
    'A-owned archive canon may follow the authenticated immediate B-to-C route without pretending B is the physical owner');
  for (const [name, manifestPatch, refPatch] of [
    ['root-origin equality', { lastSessionHandoff: { ...targetManifest.lastSessionHandoff, sourceScopeKey: 'scope:A-root' } }, {}],
    ['forged transfer', {}, { handoffTransferId: 'transfer-forged' }],
    ['forged source', {}, { sourceSessionScopeKey: 'scope:forged-source' }]
  ]) {
    const manifestValue = { ...targetManifest, ...manifestPatch };
    const result = await membershipContext.verifyMembership({ manifest: manifestValue, ref: { ...multiHopRef, ...refPatch }, memory: inheritedMemory });
    assert.equal(result.ok, false, `${name} must not satisfy the target manifest transfer route`);
    assert.equal(result.reason, 'logical_replay_archive_transfer_unbound');
  }
};

const exercisePartialTransferRebuild = async () => {
  const context = {
    Object, Array, String, Number, Boolean, JSON, Set,
    clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
    asArray: value => Array.isArray(value) ? value : [],
    string: value => String(value ?? '').trim(),
    compact: (value, limit = 500) => String(value ?? '').trim().slice(0, limit),
    statePipelineReplayRefs: manifest => Object.values(manifest?.memories || {}),
    rebuildStateFromCanonicalChain: async () => ({
      ok: true, skipped: false, pending: false,
      results: [{ startTurn: 1, status: 'observation_replayed', partial: true }],
      warnings: [], providerCalls: 0, head: { status: 'partial' }, registry: { schema: 'fixture' }
    })
  };
  vm.createContext(context);
  vm.runInContext(`${between('const UNIFIED_ARTIFACT_SCHEMA =', 'const UNIFIED_PATCH_SCHEMA =')}\n${between('const unifiedRefIsReadableUnified =', 'const unifiedInheritedRef =')}\n${transferRebuild}\nthis.rebuildTransfer = rebuildStateAfterCanonicalTransfer;`, context);
  const result = await context.rebuildTransfer({
    context: { scope: { scopeKey: 'scope:partial-target' } },
    manifest: { memories: { 1: { status: 'committed', key: 'memory:1' } } },
    reason: 'partial-fixture'
  });
  assert.equal(result.ok, false,
    'an internally ok-looking rebuild with a partial domain row must fail the transfer completeness gate');
  assert.equal(result.pending, true);
  assert.equal(result.expectedRefs, 1);
  assert.equal(result.completedRefs, 0);
};

Promise.all([exerciseMultiHopArchiveRoute(), exercisePartialTransferRebuild()]).then(() => {
  process.stdout.write(`libra_state_rebuild_transfer_contract_test: PASS (${path.basename(sourcePath)})\n`);
}).catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
