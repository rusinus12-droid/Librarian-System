'use strict';

// Request-local logical evidence over existing LIBRA storage. This is not an
// owner authority certificate, physical-ABA observer, recall engine or cache.
const crypto = require('node:crypto');
const PLUGIN_ID = 'serial_gradation_agents_for_rp';
const CAPTURE_ROUTE = '/v1/libra/read-session/capture';
const CURRENT_ROUTE = '/v1/libra/read-session/current';
const MiB = 1024 ** 2;
const LIMITS = Object.freeze({ defaultCorpusBytes: 4 * MiB, maxCorpusBytes: 32 * MiB,
  manifestBytes: MiB, itemMetadataBytes: 64 * 1024, totalMetadataBytes: MiB,
  maxRefs: 4096, currentRequestBytes: 4 * MiB });
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
function validText(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}
function scopeOf(value) {
  if (!object(value) || !['scopeKey', 'characterId', 'chatId'].every(key => validText(value[key]))) fail('gradia_read_scope_invalid', 400);
  return { scopeKey: value.scopeKey, characterId: value.characterId, chatId: value.chatId };
}
function corpusLimit(value) {
  if (value === undefined) return LIMITS.defaultCorpusBytes;
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.maxCorpusBytes) fail('gradia_read_corpus_limit_invalid', 400);
  return value;
}
const manifestKeyFor = scope => `libra:v1:scope:${scope.scopeKey}:manifest`;
function memoryLocation(key) {
  if (!validText(key, 1200)) return null;
  const scoped = /^libra:v1:scope:(.+):memory:([0-9]+):r([0-9]+)$/.exec(key);
  if (scoped) return { kind: 'scope', scopeKey: scoped[1] };
  const predecessor = /^libra:v1:scope:(.+):predecessor:([^:]+):([0-9]{5,}):([^:]+):r([0-9]+)$/.exec(key);
  if (predecessor) return { kind: 'predecessor', scopeKey: predecessor[1] };
  const archive = /^libra:v1:shared-archive:([^:]+):memory:([^:]+):r([0-9]+)$/.exec(key);
  return archive ? { kind: 'archive', scopeKey: `archive:${archive[1]}` } : null;
}
function decode(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { fail('gradia_read_stored_json_invalid'); }
  }
  if (!object(value)) fail('gradia_read_stored_object_invalid');
  return value;
}
function metadataOf(repository, key) {
  const value = repository.getMetadata('plugin', key);
  return { namespace: 'libra', space: 'plugin', key, exists: value.exists, tombstone: value.tombstone,
    revision: value.revision, digest: value.digest, updatedAt: value.updatedAt, valueBytes: value.valueBytes };
}
function boundedRead(repository, metadata, maxValueBytes) {
  if (!metadata.exists || metadata.tombstone) fail('gradia_read_dependency_unavailable');
  if (metadata.valueBytes > maxValueBytes) fail('gradia_read_storage_budget_exceeded', 413);
  let row;
  try { row = repository.get('plugin', metadata.key, { maxValueBytes }); }
  catch (error) {
    if (error?.statusCode === 413) fail('gradia_read_storage_budget_exceeded', 413);
    fail('gradia_read_dependency_decode_failed');
  }
  if (!row.exists || row.tombstone || row.revision !== metadata.revision || row.digest !== metadata.digest) fail('gradia_read_dependency_changed');
  return decode(row.value);
}
function selectedRefs(manifest) {
  const inherited = Array.isArray(manifest.inheritedMemories) ? manifest.inheritedMemories : [];
  const current = object(manifest.memories) ? Object.values(manifest.memories) : [];
  if (inherited.length + current.length > LIMITS.maxRefs) fail('gradia_read_reference_limit_exceeded', 413);
  const guard = object(manifest.branchGuard) ? manifest.branchGuard : {};
  const ready = guard.schema === 'libra.branch_guard.v1' && guard.status === 'ready';
  // Match LIBRA normalizeBranchGuard + listRecallMemoryRefs exactly: absent or
  // unknown guard schema remains pending, and only five-turn starts verify.
  const verified = new Set((Array.isArray(guard.verifiedStarts) ? guard.verifiedStarts : [])
    .map(value => Math.max(0, Number(value || 0) || 0))
    .filter(value => value > 0 && (value - 1) % 5 === 0));
  const rows = [
    ...inherited.filter(ref => ref?.status === 'committed').map(ref => ({ ref, inherited: true })),
    ...current.filter(ref => ref?.status === 'committed' && (ready || verified.has(Number(ref?.turnRange?.start || 0))))
      .map(ref => ({ ref, inherited: false }))
  ];
  const epoch = ref => Number.isFinite(Number(ref?.sessionEpoch)) ? Number(ref.sessionEpoch) : 0;
  return rows.sort((a, b) => epoch(a.ref) - epoch(b.ref)
    || Number(a.ref?.turnRange?.start || 0) - Number(b.ref?.turnRange?.start || 0)
    || Number(a.ref?.turnRange?.end || 0) - Number(b.ref?.turnRange?.end || 0)
    || Number(a.ref?.revision || 0) - Number(b.ref?.revision || 0));
}
function validateDependency(value, index, scope) {
  if (!object(value) || value.namespace !== 'libra' || value.space !== 'plugin'
    || (index === 0 ? value.key !== manifestKeyFor(scope) : !memoryLocation(value.key))) fail('gradia_read_dependencies_invalid', 400);
  if (index === 0 && value.exists === false) {
    if (value.tombstone !== false || value.revision !== 0 || value.digest !== '' || value.updatedAt !== 0 || value.valueBytes !== 0) {
      fail('gradia_read_dependencies_invalid', 400);
    }
    return { namespace: 'libra', space: 'plugin', key: value.key, exists: false, tombstone: false,
      revision: 0, digest: '', updatedAt: 0, valueBytes: 0 };
  }
  if (value.exists !== true || value.tombstone !== false
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !Number.isSafeInteger(value.valueBytes) || value.valueBytes < 0) fail('gradia_read_dependencies_invalid', 400);
  return { namespace: 'libra', space: 'plugin', key: value.key, exists: true, tombstone: false,
    revision: value.revision, digest: value.digest, updatedAt: value.updatedAt, valueBytes: value.valueBytes };
}
// A composed reader can only tighten this owner's existing raw-read ceiling.
function rawLimitOf(value, maxCorpusBytes) {
  const maximum = 7 * maxCorpusBytes + 2 * LIMITS.totalMetadataBytes;
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('gradia_read_storage_limit_invalid', 400);
  return value;
}
function createReadSession({ getRepository, dataInstanceId, epochs, canRead }) {
  const identity = scope => ({ scope: { ...scope }, dataInstanceId, resetEpoch: Number(epochs().libra || 0) });
  function readUnit(body) {
    if (!canRead()) fail('gradia_read_maintenance', 503);
    const repository = getRepository();
    repository.database.exec('BEGIN');
    try {
      const result = body(repository);
      if (!canRead()) fail('gradia_read_maintenance', 503);
      return deepFreeze(result);
    } finally { repository.database.exec('ROLLBACK'); }
  }
  function capture(body) {
    const scope = scopeOf(body?.scope), maxCorpusBytes = corpusLimit(body?.maxCorpusBytes);
    const rawLimit = rawLimitOf(body?.maxRawBytes, maxCorpusBytes);
    return readUnit(repository => {
      const readIdentity = identity(scope), manifestMetadata = metadataOf(repository, manifestKeyFor(scope));
      if (!manifestMetadata.exists || manifestMetadata.tombstone) {
        const dependencies = [manifestMetadata];
        return { schema: 'memory-suite.libra-read-session.v1', readOnly: true, complete: true, scope, items: [], dependencies,
          evidenceRevision: hash(dependencies), corpusBytes: 0, maxCorpusBytes, maxRawBytes: rawLimit, metadataBytes: 0, rawBytes: manifestMetadata.valueBytes || 0, dataInstanceId,
          resetEpoch: readIdentity.resetEpoch, readIdentity };
      }
      const manifest = boundedRead(repository, manifestMetadata, Math.min(LIMITS.manifestBytes, rawLimit));
      if (manifest.schema !== 'libra.manifest.v1' || !['scopeKey', 'characterId', 'chatId'].every(key => manifest[key] === scope[key])) fail('gradia_read_manifest_scope_mismatch');
      const refs = selectedRefs(manifest), dependencies = [manifestMetadata], items = [], seen = new Set();
      let corpusBytes = 0, metadataBytes = 0, rawBytes = manifestMetadata.valueBytes;
      // Stored plugin values may wrap LIBRA JSON in one additional JSON string.
      // NUL costs seven raw bytes (\\u0000) there, versus six on the final wire.
      for (const { ref, inherited } of refs) {
        const location = memoryLocation(ref.key);
        if (!location || (!inherited && (location.kind !== 'scope' || location.scopeKey !== scope.scopeKey))) fail('gradia_read_memory_pointer_invalid');
        if (seen.has(ref.key)) fail('gradia_read_duplicate_memory_pointer');
        seen.add(ref.key);
        const metadata = metadataOf(repository, ref.key);
        const allowedRaw = Math.min(7 * (maxCorpusBytes - corpusBytes) + LIMITS.itemMetadataBytes, rawLimit - rawBytes);
        const stored = boundedRead(repository, metadata, allowedRaw);
        rawBytes += metadata.valueBytes;
        if ((ref.memoryId && String(ref.memoryId) !== String(stored.memoryId || stored.id || ''))
          || (Number(ref.revision || 0) > 0 && Number(ref.revision) !== Number(stored.revision || 0))
          || (ref.sourceDigest && String(ref.sourceDigest) !== String(stored.sourceDigest))) fail('gradia_read_memory_identity_mismatch');
        if (stored.schema !== 'libra.canonical_memory.v1' || stored.status !== 'committed') fail('gradia_read_memory_schema_invalid');
        if (stored.scopeKey !== location.scopeKey) fail('gradia_read_memory_scope_mismatch');
        if (typeof stored.text !== 'string') fail('gradia_read_memory_text_missing');
        const content = stored.text;
        corpusBytes += Buffer.byteLength(content, 'utf8');
        if (corpusBytes > maxCorpusBytes) fail('gradia_read_corpus_budget_exceeded', 413);
        const auxiliaryBytes = Buffer.byteLength(JSON.stringify({ ...stored, text: '' }), 'utf8');
        metadataBytes += auxiliaryBytes;
        if (auxiliaryBytes > LIMITS.itemMetadataBytes || metadataBytes > LIMITS.totalMetadataBytes) fail('gradia_read_metadata_budget_exceeded', 413);
        const id = String(stored.memoryId || stored.id || ref.key);
        if (!validText(id, 1200)) fail('gradia_read_memory_id_invalid');
        const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
        const source = { namespace: 'libra', space: 'plugin', scopeKey: location.scopeKey,
          memoryId: id, revision: number(stored.revision), sourceDigest: String(stored.sourceDigest || ''),
          turnRange: { start: number(ref.turnRange?.start), end: number(ref.turnRange?.end) },
          sessionEpoch: number(ref.sessionEpoch), inherited, archiveShared: ref.archiveShared === true };
        dependencies.push(metadata); items.push({ id, key: ref.key, content, source });
      }
      return { schema: 'memory-suite.libra-read-session.v1', readOnly: true, complete: true, scope, items, dependencies,
        evidenceRevision: hash(dependencies), corpusBytes, maxCorpusBytes, maxRawBytes: rawLimit, metadataBytes, rawBytes, dataInstanceId,
        resetEpoch: readIdentity.resetEpoch, readIdentity };
    });
  }
  function current(body) {
    const scope = scopeOf(body?.scope);
    if (!object(body.readIdentity) || !same(scopeOf(body.readIdentity.scope), scope)) fail('gradia_read_scope_changed', 400);
    if (!Array.isArray(body.dependencies) || body.dependencies.length < 1 || body.dependencies.length > LIMITS.maxRefs + 1) fail('gradia_read_dependencies_invalid', 400);
    const dependencies = body.dependencies.map((value, index) => validateDependency(value, index, scope));
    if (new Set(dependencies.map(value => value.key)).size !== dependencies.length || body.evidenceRevision !== hash(dependencies)) fail('gradia_read_evidence_revision_invalid', 400);
    return readUnit(repository => {
      const expected = identity(scope);
      const bindingMatches = body.dataInstanceId === expected.dataInstanceId && body.resetEpoch === expected.resetEpoch
        && body.readIdentity.dataInstanceId === expected.dataInstanceId && body.readIdentity.resetEpoch === expected.resetEpoch;
      const current = bindingMatches && dependencies.every(value => same(value, metadataOf(repository, value.key)));
      return { schema: 'memory-suite.libra-read-session-current.v1', current, scope,
        evidenceRevision: body.evidenceRevision, dataInstanceId, resetEpoch: expected.resetEpoch };
    });
  }
  return Object.freeze({ capture, current });
}
module.exports = { PLUGIN_ID, CAPTURE_ROUTE, CURRENT_ROUTE, LIMITS, createReadSession };
