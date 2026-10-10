'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const between = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const rollbackRuntimeSource = between(
  'const portableParsedRawValue =',
  'const portableStateTransferReceiptProjection ='
);
const captureSource = between(
  'const capturePortableStateDerivedRollback =',
  'const portableStateTransferReceiptProjection ='
);
const archiveImportSource = between(
  'const importPortableAsPredecessorArchive = async',
  'const importPortableAsNativeCopy = async'
);
const nativeCopySource = between(
  'const importPortableAsNativeCopy = async',
  'const deleteFailedRun = async'
);

assert.match(captureSource, /const knownWorldlineIds = new Set\(\['main'\]\)/,
  'main must always be part of the derived rollback namespace');
for (const evidence of [
  'worldlineMeta?.activeWorldlineId', 'worldlineKey', 'row.id', 'row.parentId',
  'ref?.logicalWorldlineId', 'ref?.worldlineId'
]) assert.ok(captureSource.includes(evidence), `known worldline evidence is missing: ${evidence}`);
assert.match(captureSource, /for \(const worldlineId of knownWorldlineIds\)/,
  'receipt capture must iterate every known worldline');
assert.match(captureSource, /key\.statePipelineReceipt\(scope, memoryId, revision, worldlineId\)/);
assert.match(captureSource, /for \(const domain of STATE_PIPELINE_DOMAINS\)/,
  'all four State domains must be captured for each worldline');
assert.match(captureSource, /key\.stateObservation\(scope, memoryId, revision, domain, worldlineId\)/);
for (const [label, block] of [['archive import', archiveImportSource], ['native copy', nativeCopySource]]) {
  const captureAt = block.indexOf('await capturePortableStateDerivedRollback');
  const rebuildAt = block.indexOf('await rebuildStateAfterCanonicalTransfer');
  assert.ok(captureAt >= 0 && rebuildAt > captureAt,
    `${label} must capture every derived key before the transfer rebuild can write it`);
  assert.ok(block.indexOf('await rollback.restore()', rebuildAt) > rebuildAt,
    `${label} failure handling must invoke physical rollback after rebuild work`);
}

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '').trim();
const compact = (value, limit = 500) => string(value).slice(0, limit);
const nowIso = () => '2026-09-02T12:00:00.000Z';
const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value ?? null))
  .digest('hex');
const PREFIX = 'libra:v1';
const STATE_PIPELINE_DOMAINS = Object.freeze(['character', 'relationship', 'world', 'narrative']);
const scope = { scopeKey: 'portable-rollback-p1' };
const base = `${PREFIX}:scope:${scope.scopeKey}`;
const worldlineSuffix = worldlineId => worldlineId === 'main' ? '' : `:worldline:${worldlineId}`;
const key = {
  portableImportJournal: (_scope, importId) => `${base}:portable-import-journal:${importId}`,
  continuityState: () => `${base}:continuity-state`,
  entityRegistry: () => `${base}:entity-registry`,
  stateCorrections: () => `${base}:state-corrections`,
  stateCorrectionMeta: () => `${base}:state-correction-meta`,
  stateCorrectionCommit: () => `${base}:state-correction-commit`,
  stateWorldlineMeta: () => `${base}:state-worldlines`,
  stateReplayCache: () => `${base}:state-replay-cache`,
  stateReplayErrors: () => `${base}:state-replay-errors`,
  manualStateDisposition: (_scope, memoryId, revision) => `${base}:manual:${memoryId}:r${revision}`,
  entityAdmission: (_scope, memoryId, revision) => `${base}:admission:${memoryId}:r${revision}`,
  statePipelineReceipt: (_scope, memoryId, revision, worldlineId = 'main') =>
    `${base}:receipt:${memoryId}:r${revision}${worldlineSuffix(worldlineId)}`,
  stateObservation: (_scope, memoryId, revision, domain, worldlineId = 'main') =>
    `${base}:observation:${memoryId}:r${revision}:${domain}${worldlineSuffix(worldlineId)}`
};
const entityAdmissionStorageKey = (scopeValue, memoryId, revision) =>
  key.entityAdmission(scopeValue, memoryId, revision);
const statePipelineReplayRefs = manifest => [
  ...asArray(manifest?.inheritedMemories), ...Object.values(asObject(manifest?.memories))
].filter(ref => ref?.status === 'committed' && ref?.key)
  .sort((left, right) => Number(left?.sessionEpoch || 0) - Number(right?.sessionEpoch || 0)
    || Number(left?.turnRange?.start || 0) - Number(right?.turnRange?.start || 0));

const raw = new Map();
const parseStoredJson = (value, storageKey = '', fallback = null) => {
  try { return typeof value === 'string' ? JSON.parse(value) : clone(value); }
  catch (error) { if (fallback !== null) return clone(fallback); throw new Error(`invalid_json:${storageKey}`); }
};
const storage = {
  async getJson(storageKey, fallback = null) {
    return raw.has(storageKey) ? parseStoredJson(raw.get(storageKey), storageKey, fallback) : clone(fallback);
  },
  async getStoredJson(storageKey, fallback = null) {
    return raw.has(storageKey) ? parseStoredJson(raw.get(storageKey), storageKey, fallback) : clone(fallback);
  },
  async setJson(storageKey, value) { raw.set(storageKey, JSON.stringify(value)); return true; },
  async remove(storageKey) { raw.delete(storageKey); return true; },
  async keys() { return [...raw.keys()]; }
};
const LibraProviderBridge = { storage: { async getItem(storageKey) { return raw.has(storageKey) ? raw.get(storageKey) : null; } } };
const fencedMemoryStorageSet = async (storageKey, serialized) => { raw.set(storageKey, serialized); return true; };
const clearPortableVectorCacheForStoredValue = async () => {};

const context = {
  console, Map, Set, Promise, Object, Array, JSON,
  clone, asObject, asArray, string, compact, nowIso, digest, PREFIX,
  STATE_PIPELINE_DOMAINS, key, entityAdmissionStorageKey, statePipelineReplayRefs,
  storage, LibraProviderBridge, fencedMemoryStorageSet,
  clearPortableVectorCacheForStoredValue, parseStoredJson,
  resolveContext: async () => ({ scope }),
  LIBRA_SHARED_ARCHIVE_SCHEMA: 'unused', MEMORY_SCHEMA: 'unused', EMBEDDING_PROJECTION_SCHEMA: 'unused'
};
vm.createContext(context);
vm.runInContext(`${rollbackRuntimeSource}\nthis.api = { createPortableWriteRollback, capturePortableStateDerivedRollback };`,
  context, { filename: 'libra-portable-multiverse-derived-rollback-p1.js', timeout: 5000 });

(async () => {
  const memoryId = 'memory-p1';
  const revision = 3;
  const worldlineMeta = {
    schema: 'libra.state_worldline_meta.v1', activeWorldlineId: 'branch-child',
    worldlines: {
      main: { id: 'main', parentId: null },
      'branch-child': { id: 'branch-child', parentId: 'main' }
    }
  };
  const manifest = {
    memories: {
      1: {
        key: `${base}:memory:1:r${revision}`, status: 'committed', memoryId, revision,
        sessionEpoch: 0, turnRange: { start: 1, end: 5 },
        worldlineId: 'main', logicalWorldlineId: 'branch-child'
      }
    },
    inheritedMemories: []
  };
  const sharedKeys = [
    key.continuityState(scope), key.entityRegistry(scope), key.stateCorrections(scope),
    key.stateCorrectionMeta(scope), key.stateCorrectionCommit(scope), key.stateWorldlineMeta(scope),
    key.stateReplayCache(scope), key.stateReplayErrors(scope)
  ];
  const sidecarKeys = [
    key.manualStateDisposition(scope, memoryId, revision),
    key.entityAdmission(scope, memoryId, revision)
  ];
  const derivedKeys = [];
  for (const worldlineId of ['main', 'branch-child']) {
    derivedKeys.push(key.statePipelineReceipt(scope, memoryId, revision, worldlineId));
    for (const domain of STATE_PIPELINE_DOMAINS) {
      derivedKeys.push(key.stateObservation(scope, memoryId, revision, domain, worldlineId));
    }
  }
  const expectedKeys = [...sharedKeys, ...sidecarKeys, ...derivedKeys];
  const absentBeforeCapture = key.stateObservation(scope, memoryId, revision, 'narrative', 'branch-child');
  for (const [index, storageKey] of expectedKeys.entries()) {
    if (storageKey === absentBeforeCapture) continue;
    raw.set(storageKey, `{\n  "fixture": ${index},\n  "storageKey": ${JSON.stringify(storageKey)}\n}`);
  }
  raw.set(key.stateWorldlineMeta(scope), JSON.stringify(worldlineMeta, null, 2));
  const originalRaw = new Map(expectedKeys.map(storageKey => [storageKey, raw.has(storageKey) ? raw.get(storageKey) : null]));

  const rollback = await context.api.createPortableWriteRollback({
    scope, importId: 'import-p1', mode: 'reconstruct_native_copy'
  });
  await context.api.capturePortableStateDerivedRollback({ rollback, scope, manifest });

  const journalKey = key.portableImportJournal(scope, 'import-p1');
  const journal = await storage.getJson(journalKey, null);
  const captured = new Set(journal.entries.map(entry => entry.key));
  assert.equal(captured.size, expectedKeys.length, 'rollback journal must capture every expected key exactly once');
  for (const storageKey of expectedKeys) assert.ok(captured.has(storageKey), `rollback key missing: ${storageKey}`);
  for (const worldlineId of ['main', 'branch-child']) {
    assert.ok(captured.has(key.statePipelineReceipt(scope, memoryId, revision, worldlineId)),
      `${worldlineId} pipeline receipt is not protected`);
    for (const domain of STATE_PIPELINE_DOMAINS) {
      assert.ok(captured.has(key.stateObservation(scope, memoryId, revision, domain, worldlineId)),
        `${worldlineId}/${domain} observation is not protected`);
    }
  }

  for (const storageKey of expectedKeys) {
    await storage.setJson(storageKey, { schema: 'mutated_after_capture', storageKey });
  }
  let syntheticFailure = null;
  try { throw new Error('synthetic_state_transfer_failure'); }
  catch (error) {
    syntheticFailure = error;
    const rollbackErrors = await rollback.restore();
    assert.deepEqual(JSON.parse(JSON.stringify(rollbackErrors)), [],
      'physical rollback and its readback must complete without errors');
  }
  assert.match(syntheticFailure.message, /synthetic_state_transfer_failure/);

  for (const [storageKey, original] of originalRaw) {
    if (original === null) assert.equal(raw.has(storageKey), false, `new derived key was not removed: ${storageKey}`);
    else assert.equal(raw.get(storageKey), original, `exact raw rollback mismatch: ${storageKey}`);
  }
  assert.equal(raw.has(journalKey), false, 'a completely verified rollback must clean its journal');

  process.stdout.write('libra_portable_multiverse_derived_rollback_p1_test: PASS\n');
})().catch(error => {
  process.stderr.write(`libra_portable_multiverse_derived_rollback_p1_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
