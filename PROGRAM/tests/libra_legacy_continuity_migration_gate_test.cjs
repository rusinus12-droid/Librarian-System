'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const between = (startText, endText) => {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `source block not found: ${startText} -> ${endText}`);
  return source.slice(start, end);
};

const helperSource = between(
  "const LEGACY_CONTINUITY_MODE_V2 = 'legacy_artifact_v2';",
  'const continuityDeltaFromStageObjectsLegacy0316 ='
);

const helperContext = {
  asObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  string: value => String(value ?? '').trim(),
  CANONICAL_MANUAL_AUTHORITY_SCHEMA: 'libra.canonical_manual_authority.v1',
  CANONICAL_ARTIFACT_SCHEMA: 'libra.canonical_artifact.v3',
  CANONICAL_ARTIFACT_LEGACY_SCHEMA: 'libra.canonical_artifact.v2',
  // T03/D02: the dispatch block reads the v5 schema constant, so the slice needs
  // it. It is the same value the plugin defines.
  UNIFIED_ARTIFACT_SCHEMA_V5: 'libra.canonical_artifact.v5'
};
vm.createContext(helperContext);
vm.runInContext(`${helperSource}
this.api = {
  modeForMemory: continuityLegacyModeForMemory,
  eligibleMemory: legacyContinuityEligibleMemory,
  notApplicable: legacyContinuityNotApplicableResult
};`, helperContext);

const { api } = helperContext;
const v3 = {
  memoryId: 'm-v3', revision: 1, artifactSchema: 'libra.canonical_artifact.v3',
  canonicalArtifact: { schema: 'libra.canonical_artifact.v3' }
};
const rawV2 = {
  memoryId: 'm-v2', revision: 1, artifactSchema: 'libra.canonical_artifact.v2',
  canonicalArtifact: { schema: 'libra.canonical_artifact.v2', state: {} }
};
const normalizedV2 = {
  memoryId: 'm-v2-normalized', revision: 2, artifactSchema: 'libra.canonical_artifact.v2',
  canonicalArtifact: { schema: 'libra.canonical_artifact.v3', legacySchema: 'libra.canonical_artifact.v2' }
};
const manual = {
  memoryId: 'm-manual', revision: 3,
  manualAuthority: { schema: 'libra.canonical_manual_authority.v1' }
};
const untyped = { memoryId: 'm-old', revision: 1 };
const unknown = { memoryId: 'm-unknown', revision: 1, artifactSchema: 'libra.canonical_artifact.v99' };
// T03/D02: a v5 artifact is a READABLE typed artifact, so it dispatches to the
// typed State Pipeline -- never to the legacy Continuity Delta, and never to
// `unsupported`.
const v5 = {
  memoryId: 'm-v5', revision: 1, artifactSchema: 'libra.canonical_artifact.v5',
  canonicalArtifact: { schema: 'libra.canonical_artifact.v5' }
};
const v5ArtifactOnly = { memoryId: 'm-v5b', revision: 1, canonicalArtifact: { schema: 'libra.canonical_artifact.v5' } };

assert.equal(api.modeForMemory(v3), 'state_pipeline_v3');
assert.equal(api.eligibleMemory(v3), false, 'typed v3 memory must never use legacy Continuity Delta');
assert.equal(api.modeForMemory(rawV2), 'legacy_artifact_v2');
assert.equal(api.eligibleMemory(rawV2), true, 'raw v2 stays migration-compatible');
assert.equal(api.modeForMemory(normalizedV2), 'legacy_artifact_v2');
assert.equal(api.eligibleMemory(normalizedV2), true, 'normalized v2 keeps its legacy identity');
assert.equal(api.modeForMemory(manual), 'state_pipeline_v3');
assert.equal(api.eligibleMemory(manual), false, 'manual canonical authority uses State Pipeline receipts, not legacy Delta');
assert.equal(api.modeForMemory(untyped), 'legacy_untyped');
assert.equal(api.eligibleMemory(untyped), true, 'pre-artifact legacy memory remains readable');
assert.equal(api.modeForMemory(v5), 'state_pipeline_v5');
assert.equal(api.eligibleMemory(v5), false, 'v5 is typed: it never uses the legacy Continuity Delta');
assert.equal(api.modeForMemory(v5ArtifactOnly), 'state_pipeline_v5',
  'the nested artifact schema alone is enough to route v5 to the typed path');
assert.equal(api.modeForMemory(unknown), 'unsupported_artifact');
assert.equal(api.eligibleMemory(unknown), false, 'unknown typed artifacts fail closed');
assert.equal(api.notApplicable(v3).reason, 'legacy_continuity_not_applicable_v3');

const ioSource = between('const saveContinuityDelta = async', 'const updateContinuityStateAfterCommit = async');
const rawStore = new Map();
let reads = 0;
let writes = 0;
const ioContext = {
  ...helperContext,
  ...helperContext.api,
  legacyContinuityEligibleMemory: api.eligibleMemory,
  continuityLegacyModeForMemory: api.modeForMemory,
  CONTINUITY_DELTA_SCHEMA: 'libra.continuity_delta.v1',
  clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
  continuityDeltaFromStageObjects: memory => ({
    schema: 'libra.continuity_delta.v1', memoryId: memory.memoryId,
    revision: memory.revision, sourceDigest: memory.sourceDigest || ''
  }),
  key: { continuityDelta: (_scope, memoryId, revision) => `delta:${memoryId}:${revision}` },
  storage: {
    async setJson(key, value) { writes += 1; rawStore.set(key, JSON.parse(JSON.stringify(value))); },
    async getJson(key, fallback) { reads += 1; return rawStore.has(key) ? JSON.parse(JSON.stringify(rawStore.get(key))) : fallback; }
  }
};
vm.createContext(ioContext);
vm.runInContext(`${ioSource}
this.saveContinuityDelta = saveContinuityDelta;
this.loadContinuityDelta = loadContinuityDelta;`, ioContext);

(async () => {
  await assert.rejects(
    () => ioContext.saveContinuityDelta({}, v3, { memoryId: v3.memoryId, revision: v3.revision }),
    error => error?.code === 'LEGACY_CONTINUITY_NOT_APPLICABLE_V3'
  );
  assert.equal(writes, 0, 'v3 rejection must happen before storage mutation');
  const readsBeforeV3Load = reads;
  assert.equal(await ioContext.loadContinuityDelta({}, v3), null);
  assert.equal(reads, readsBeforeV3Load, 'v3 load must not probe legacy storage');

  const saved = await ioContext.saveContinuityDelta({}, rawV2, {
    memoryId: rawV2.memoryId, revision: rawV2.revision, sourceDigest: 'digest-v2'
  });
  assert.equal(saved.delta.authority, 'legacy_migration_only');
  assert.equal(saved.delta.legacyMode, 'legacy_artifact_v2');
  assert.equal((await ioContext.loadContinuityDelta({}, rawV2)).memoryId, rawV2.memoryId);

  const untypedSaved = await ioContext.saveContinuityDelta({}, untyped, {
    memoryId: untyped.memoryId, revision: untyped.revision, sourceDigest: 'digest-old'
  });
  assert.equal(untypedSaved.delta.legacyMode, 'legacy_untyped');

  const updater = between('const updateContinuityStateAfterCommit = async', 'const continuityStatePromptBlock =');
  assert.match(updater, /if \(!legacyContinuityEligibleMemory\(memory\)\) return legacyContinuityNotApplicableResult\(memory\);/);
  // The state rebuild body now lives in `rebuildStateFromCanonicalChainUnlocked`,
  // with `rebuildStateFromCanonicalChain` as the per-scope locking wrapper (the
  // same Unlocked/wrapper pair as rebuildCurrentStateForWorldline). The guard must
  // live in the body, so the slice spans the wrapper through the transfer function.
  const rebuild = between('const rebuildStateFromCanonicalChainUnlocked = async', 'const rebuildStateAfterCanonicalTransfer = async');
  assert.match(rebuild, /rawArtifactSchema === CANONICAL_ARTIFACT_LEGACY_SCHEMA[\s\S]*loadContinuityDelta/,
    'v2 artifacts may replay only an already durable legacy delta');
  assert.doesNotMatch(rebuild, /rebuildMissingContinuityDelta|callContinuityDeltaProvider/,
    'state rebuild must not recreate retired legacy deltas with a hidden provider call');
  const portable = between('const portableImportBundle = input =>', 'const samePortableCharacter =');
  assert.match(portable, /const deltaForMemory = memory => legacyContinuityEligibleMemory\(memory\)/);
  const copy = between('const importPortableAsNativeCopy = async', 'const deleteFailedRun = async');
  assert.match(copy, /const sourceDelta = bundle\.deltaForMemory\(sourceMemory\);/);

  console.log('libra_legacy_continuity_migration_gate_test: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
