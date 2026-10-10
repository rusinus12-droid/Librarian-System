'use strict';

// Request-local read evidence over Flashback's published owner manifests. This
// does not hydrate vectors, repair storage, recall, or certify host currentness.
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const PLUGIN_ID = 'serial_gradation_agents_for_rp';
const CAPTURE_ROUTE = '/v1/flashback/read-session/capture';
const CURRENT_ROUTE = '/v1/flashback/read-session/current';
const MiB = 1024 ** 2;
const LIMITS = Object.freeze({ defaultCorpusBytes: 4 * MiB, maxCorpusBytes: 32 * MiB,
  manifestBytes: MiB, itemMetadataBytes: 64 * 1024, totalMetadataBytes: MiB,
  maxRefs: 4096, currentRequestBytes: 4 * MiB, maxArchiveDepth: 256 });
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bytes = value => Buffer.byteLength(value, 'utf8');
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const validText = (value, max = 512) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\0\r\n]/.test(value);
const integer = (value, max = LIMITS.maxRefs) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const validCommit = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const digest64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
// Flashback hashes UTF-16 code units, not UTF-8 bytes.
function keyHash(value) {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 0x01000193);
  return (result >>> 0).toString(36);
}
function stable(value, depth = 0) {
  if (depth > 32) fail('gradia_read_metadata_depth_exceeded', 413);
  if (Array.isArray(value)) return `[${value.map(v => stable(v, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function scopeOf(value) {
  if (!object(value) || !['scopeKey', 'characterId', 'chatId'].every(key => validText(value[key]))
    || value.scopeKey !== `char:${keyHash(value.characterId)}|chat:${keyHash(value.chatId)}`) fail('gradia_read_scope_invalid', 400);
  return { scopeKey: value.scopeKey, characterId: value.characterId, chatId: value.chatId };
}
function corpusLimit(value) {
  if (value === undefined) return LIMITS.defaultCorpusBytes;
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.maxCorpusBytes) fail('gradia_read_corpus_limit_invalid', 400);
  return value;
}
const prefixFor = scopeKey => `vector_rag_memory:scope:${keyHash(scopeKey)}:`;
const manifestKeyFor = scopeKey => `${prefixFor(scopeKey)}manifest:v2`;
const shardKeyFor = (scopeKey, commitId, index) => `${prefixFor(scopeKey)}records:${commitId ? `commit:${commitId}:` : ''}shard:${String(index).padStart(4, '0')}`;
const allowedKey = key => validText(key, 1200) && /^vector_rag_memory:scope:[a-z0-9]+:(?:manifest:v2|records:(?:commit:[A-Za-z0-9_-]{1,160}:)?shard:[0-9]{4})$/.test(key);
function decode(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { fail('gradia_read_stored_json_invalid'); }
  }
  if (!object(value)) fail('gradia_read_stored_object_invalid');
  return value;
}
function metadataOf(repository, key) {
  const value = repository.getMetadata('plugin', key);
  return { namespace: 'flashback', space: 'plugin', key, exists: value.exists, tombstone: value.tombstone,
    revision: value.revision, digest: value.digest, updatedAt: value.updatedAt, valueBytes: value.valueBytes };
}
function validateDependency(value, index, scope) {
  if (!object(value) || value.namespace !== 'flashback' || value.space !== 'plugin'
    || (index === 0 ? value.key !== manifestKeyFor(scope.scopeKey) : !allowedKey(value.key))
    || value.exists !== true || value.tombstone !== false
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !digest64(value.digest)
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !Number.isSafeInteger(value.valueBytes) || value.valueBytes < 0) fail('gradia_read_dependencies_invalid', 400);
  return { namespace: 'flashback', space: 'plugin', key: value.key, exists: true, tombstone: false,
    revision: value.revision, digest: value.digest, updatedAt: value.updatedAt, valueBytes: value.valueBytes };
}
const sourceType = record => {
  const type = String(record.sourceType || record.type || 'unknown').trim();
  return type === 'chat_turn' ? 'response' : type;
};
function retained(record) {
  const origin = String(record.origin || '').trim().toLowerCase();
  return record.autoStatic !== true && origin !== 'manual_gui'
    && !String(record.sourceId || '').trim().toLowerCase().startsWith('manual:')
    && !(Array.isArray(record.tags) && record.tags.some(tag => String(tag).trim().toLowerCase() === 'manual'))
    && (sourceType(record) === 'response' || (sourceType(record) === 'episode_index'
      && (record.autoEpisode === true || String(record.origin || '').startsWith('episode_index'))));
}
function inheritedHistory(record) {
  return record.permanentSessionHistory === true || record.inheritedSessionHistory === true
    || String(record.historicalProtection || '').trim() === 'permanent_session_history'
    || Boolean(String(record.inheritedFromScopeKey || record.clonedFromScopeKey || '').trim());
}
function recordIdentity(record) {
  return String(record.permanentHistoryId || '').trim() || keyHash(JSON.stringify([
    String(record.sourceHash || ''), String(record.sourceId || ''), sourceType(record),
    number(record.turnIndex || record.pairIndex), number(record.chunkIndex), String(record.text || '')
  ], null, 2));
}
const timeOf = record => Date.parse(record.updatedAt || record.createdAt || '') || 0;
const sortKey = row => `${row.record.sourceType || ''}:${row.record.createdAt || ''}:${row.record.id || ''}`;
function mergeRecords(...lists) {
  const byId = new Map();
  for (const row of lists.flat()) {
    const id = recordIdentity(row.record), previous = byId.get(id);
    if (!previous || timeOf(row.record) >= timeOf(previous.record)) byId.set(id, row);
  }
  return [...byId.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}
function archivePointer(value) {
  if (!object(value) || value.schema !== 'flashback_memory.archive_ref.v1'
    || !validText(value.archiveId, 160) || !/^[A-Za-z0-9_-]+$/.test(value.archiveId)
    || value.archiveScopeKey !== `flashback_archive_v1:${value.archiveId}`
    || !integer(value.generation, LIMITS.maxArchiveDepth) || value.generation < 1
    || !integer(value.depth, LIMITS.maxArchiveDepth) || value.depth < 1
    || !integer(value.deltaCount) || !integer(value.recordCount)
    || !validText(value.digest, 64)) fail('gradia_read_archive_pointer_invalid');
  return { archiveId: value.archiveId, archiveScopeKey: value.archiveScopeKey,
    generation: value.generation, depth: value.depth, deltaCount: value.deltaCount,
    recordCount: value.recordCount, digest: value.digest };
}
// A composed reader can only tighten this owner's existing raw-read ceiling.
function rawLimitOf(value, maxCorpusBytes) {
  const maximum = 7 * maxCorpusBytes + 2 * LIMITS.totalMetadataBytes;
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('gradia_read_storage_limit_invalid', 400);
  return value;
}
function createReadSession({ getRepository, dataInstanceId, epochs, canRead }) {
  const identity = scope => ({ scope: { ...scope }, dataInstanceId, resetEpoch: Number(epochs().flashback || 0) });
  function readUnit(body) {
    if (!canRead()) fail('gradia_read_maintenance', 503);
    const repository = getRepository(), epoch = Number(epochs().flashback || 0);
    repository.database.exec('BEGIN');
    try {
      const result = body(repository);
      if (!canRead()) fail('gradia_read_maintenance', 503);
      if (Number(epochs().flashback || 0) !== epoch) fail('gradia_read_reset_changed');
      return deepFreeze(result);
    } finally { repository.database.exec('ROLLBACK'); }
  }
  function capture(body) {
    const scope = scopeOf(body?.scope), maxCorpusBytes = corpusLimit(body?.maxCorpusBytes);
    const rawLimit = rawLimitOf(body?.maxRawBytes, maxCorpusBytes);
    return readUnit(repository => {
      const readIdentity = identity(scope), dependencies = [], seen = new Set();
      let rawBytes = 0, metadataBytes = 0, recordCount = 0;
      // A repository value can wrap JSON in one additional string; NUL costs
      // seven bytes there. Gzip expansion is separately bounded before parsing.
      const chargeMetadata = (value, perItem = false) => {
        let size;
        try { size = bytes(JSON.stringify(value)); } catch (_) { fail('gradia_read_metadata_invalid'); }
        metadataBytes += size;
        if ((perItem && size > LIMITS.itemMetadataBytes) || metadataBytes > LIMITS.totalMetadataBytes) fail('gradia_read_metadata_budget_exceeded', 413);
      };
      const read = (key, limit) => {
        if (!allowedKey(key)) fail('gradia_read_memory_pointer_invalid');
        if (seen.has(key)) fail('gradia_read_duplicate_dependency');
        if (dependencies.length >= LIMITS.maxRefs + 1) fail('gradia_read_reference_limit_exceeded', 413);
        const metadata = metadataOf(repository, key);
        if (!metadata.exists || metadata.tombstone) fail('gradia_read_dependency_unavailable');
        const bound = Math.min(limit, rawLimit - rawBytes);
        if (!Number.isSafeInteger(metadata.valueBytes) || metadata.valueBytes < 0 || metadata.valueBytes > bound) fail('gradia_read_storage_budget_exceeded', 413);
        let row;
        try { row = repository.get('plugin', key, { maxValueBytes: bound }); }
        catch (error) { fail(error?.statusCode === 413 ? 'gradia_read_storage_budget_exceeded' : 'gradia_read_dependency_decode_failed', error?.statusCode === 413 ? 413 : 409); }
        if (!row?.exists || row.tombstone || row.revision !== metadata.revision || row.digest !== metadata.digest) fail('gradia_read_dependency_changed');
        // Check actual bytes as well as metadata; this is read evidence, not a
        // producer commit label being mistaken for current content authority.
        const serialized = JSON.stringify(row.value);
        if (bytes(serialized) !== metadata.valueBytes || sha(serialized) !== metadata.digest) fail('gradia_read_dependency_digest_mismatch');
        rawBytes += metadata.valueBytes;
        seen.add(key); dependencies.push(metadata);
        return row.value;
      };
      const load = (scopeKey, isCurrent = false) => {
        const manifest = decode(read(manifestKeyFor(scopeKey), Math.min(LIMITS.manifestBytes, 2 * (LIMITS.totalMetadataBytes - metadataBytes))));
        chargeMetadata(manifest);
        if (manifest.schema !== 'vector_rag_memory.scope_manifest.v2' || manifest.scopeKey !== scopeKey
          || (manifest.storageHash && manifest.storageHash !== keyHash(scopeKey))) fail('gradia_read_manifest_scope_mismatch');
        if (isCurrent && ((manifest.canonicalCharacterId || manifest.characterId) !== scope.characterId
          || (manifest.canonicalChatId || manifest.chatId) !== scope.chatId
          || (manifest.canonicalScopeId && manifest.canonicalScopeId !== scope.scopeKey)
          || manifest.archiveOwner === true)) fail('gradia_read_manifest_scope_mismatch');
        if (!integer(manifest.count) || !integer(manifest.shardCount)) fail('gradia_read_reference_limit_exceeded', 413);
        if (manifest.count + recordCount > LIMITS.maxRefs) fail('gradia_read_reference_limit_exceeded', 413);
        if (manifest.commitId && !validCommit(manifest.commitId)) fail('gradia_read_commit_invalid');
        const directory = ['rawPageLayout', 'rawPageReferences', 'rawPageDirectoryDigest'].some(key => own(manifest, key));
        if (directory) {
          if (manifest.rawPageLayout !== 'flashback.raw_pages.v1' || !Array.isArray(manifest.rawPageReferences)
            || manifest.rawPageReferences.length !== manifest.shardCount || !digest64(manifest.rawPageDirectoryDigest)) fail('gradia_read_raw_page_directory_invalid');
          let count = 0;
          for (let i = 0; i < manifest.shardCount; i++) {
            const ref = manifest.rawPageReferences[i];
            if (!object(ref) || ref.scopeKey !== scopeKey || ref.payloadShardIndex !== i || !validCommit(ref.payloadCommitId)
              || ref.storageKey !== shardKeyFor(scopeKey, ref.payloadCommitId, i) || !integer(ref.recordCount)
              || !digest64(ref.serializedValueDigest)) fail('gradia_read_raw_page_directory_invalid');
            count += ref.recordCount;
          }
          if (count !== manifest.count || sha(stable(manifest.rawPageReferences)) !== manifest.rawPageDirectoryDigest) fail('gradia_read_raw_page_directory_invalid');
        }
        const records = [];
        let loadedCount = 0;
        for (let i = 0; i < manifest.shardCount; i++) {
          const ref = directory ? manifest.rawPageReferences[i] : null;
          const commitId = ref?.payloadCommitId || manifest.commitId || '';
          const key = shardKeyFor(scopeKey, commitId, i);
          const remaining = rawLimit - rawBytes;
          const raw = read(key, remaining);
          if (ref && (typeof raw !== 'string' || sha(stable(raw)) !== ref.serializedValueDigest)) fail('gradia_read_raw_page_digest_invalid');
          let envelope = decode(raw);
          if (envelope.schema === 'flashback_memory.archive_shard_gzip.v1') {
            if (!scopeKey.startsWith('flashback_archive_v1:') || envelope.encoding !== 'gzip+base64'
              || envelope.scopeKey !== scopeKey || envelope.commitId !== commitId || envelope.shard !== i
              || typeof envelope.data !== 'string' || (envelope.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope.data))) fail('gradia_read_archive_encoding_invalid');
            const decodeLimit = Math.min(remaining, rawLimit - rawBytes);
            if (decodeLimit < 1 || !Number.isSafeInteger(envelope.rawChars) || envelope.rawChars < 1 || envelope.rawChars > decodeLimit) fail('gradia_read_storage_budget_exceeded', 413);
            const compressed = Buffer.from(envelope.data, 'base64');
            if (compressed.length !== envelope.compressedBytes) fail('gradia_read_archive_encoding_invalid');
            let decoded;
            try { decoded = gunzipSync(compressed, { maxOutputLength: decodeLimit }).toString('utf8'); }
            catch (error) { fail(error.code === 'ERR_BUFFER_TOO_LARGE' ? 'gradia_read_storage_budget_exceeded' : 'gradia_read_archive_decode_failed', error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 409); }
            rawBytes += bytes(decoded);
            if (rawBytes > rawLimit) fail('gradia_read_storage_budget_exceeded', 413);
            if (decoded.length !== envelope.rawChars || keyHash(decoded) !== envelope.rawHash) fail('gradia_read_archive_digest_invalid');
            chargeMetadata({ ...envelope, data: '' }, true);
            envelope = decode(decoded);
          }
          const rows = envelope.records;
          if (envelope.version !== 2 || envelope.scopeKey !== scopeKey || (envelope.commitId || '') !== commitId
            || envelope.shard !== i || !Array.isArray(rows) || !rows.every(object)
            || envelope.checksum !== keyHash(JSON.stringify(rows, null, 2))) fail('gradia_read_shard_invalid');
          const summary = Array.isArray(manifest.shardSummaries)
            ? manifest.shardSummaries.find((row, index) => Number(row?.shardIndex ?? index) === i) : null;
          if ((ref && rows.length !== ref.recordCount) || (summary && rows.length !== Number(summary.recordCount))) fail('gradia_read_shard_count_mismatch');
          chargeMetadata({ ...envelope, records: [] }, true);
          for (const record of rows) {
            if (++recordCount > LIMITS.maxRefs) fail('gradia_read_reference_limit_exceeded', 413);
            loadedCount++;
            if (record.scopeKey !== scopeKey || typeof record.text !== 'string') fail('gradia_read_memory_scope_mismatch');
            chargeMetadata({ ...record, text: '' }, true);
            if (retained(record)) records.push({ record, key, scopeKey, commitId, inherited: !isCurrent || inheritedHistory(record), archiveShared: !isCurrent });
          }
        }
        if (loadedCount !== manifest.count) fail('gradia_read_shard_count_mismatch');
        return { manifest, records };
      };
      const local = load(scope.scopeKey, true), layers = [], archiveScopes = new Set();
      let cursor = local.manifest.archiveRef;
      const archivePresent = cursor != null && cursor !== '' && cursor !== false;
      const head = archivePresent ? archivePointer(cursor) : null;
      while (archivePresent && cursor) {
        const pointer = archivePointer(cursor);
        if (layers.length >= LIMITS.maxArchiveDepth || archiveScopes.has(pointer.archiveScopeKey)) fail('gradia_read_archive_cycle_or_depth');
        archiveScopes.add(pointer.archiveScopeKey);
        const layer = load(pointer.archiveScopeKey), manifest = layer.manifest;
        if (manifest.archiveOwner !== true || manifest.archiveId !== pointer.archiveId
          || manifest.archiveGeneration !== pointer.generation
          || (manifest.archiveRecordCount ?? manifest.count) !== pointer.recordCount
          || manifest.archiveDigest !== pointer.digest || layer.records.length !== pointer.deltaCount) fail('gradia_read_archive_identity_mismatch');
        const cursorParentRaw = cursor.parentRef || cursor.parentArchiveRef;
        const cursorParent = cursorParentRaw ? archivePointer(cursorParentRaw) : null;
        const manifestParentPresent = own(manifest, 'parentArchiveRef') && manifest.parentArchiveRef != null;
        const manifestParent = manifestParentPresent ? archivePointer(manifest.parentArchiveRef) : null;
        if (cursorParent && (!manifestParent || !same(cursorParent, manifestParent))) fail('gradia_read_archive_parent_mismatch');
        const parent = cursorParent || manifestParent;
        if (!parent) {
          if (pointer.depth !== 1 || pointer.generation !== 1 || pointer.recordCount !== pointer.deltaCount) fail('gradia_read_archive_parent_required');
        } else if (parent.depth + 1 !== pointer.depth || parent.generation + 1 !== pointer.generation
          || (manifest.archiveVectorOverlay === true ? parent.recordCount !== pointer.recordCount : parent.recordCount + pointer.deltaCount !== pointer.recordCount)) fail('gradia_read_archive_parent_mismatch');
        layers.push(layer);
        cursor = parent ? { schema: 'flashback_memory.archive_ref.v1', ...parent } : null;
      }
      const archiveRecords = mergeRecords(...layers.reverse().map(layer => layer.records));
      if (head && (archiveRecords.length !== head.recordCount
        || keyHash(archiveRecords.map(row => recordIdentity(row.record)).sort().join('\u0001')) !== head.digest)) fail('gradia_read_archive_digest_mismatch');
      const selected = mergeRecords(archiveRecords, local.records), items = [];
      let corpusBytes = 0;
      for (const row of selected) {
        const record = row.record, id = String(record.id || record.hash || recordIdentity(record));
        if (!validText(id, 1200)) fail('gradia_read_memory_id_invalid');
        corpusBytes += bytes(record.text);
        if (corpusBytes > maxCorpusBytes) fail('gradia_read_corpus_budget_exceeded', 413);
        const turn = number(record.turnIndex || record.pairIndex);
        items.push({ id, key: row.key, content: record.text, source: {
          namespace: 'flashback', space: 'plugin', scopeKey: row.scopeKey, memoryId: id,
          revision: number(record.revision), sourceDigest: String(record.sourceHash || ''),
          turnRange: { start: turn, end: turn }, sessionEpoch: number(record.sessionEpoch),
          inherited: row.inherited, archiveShared: row.archiveShared, commitId: row.commitId,
          sourceType: sourceType(record), chunkIndex: number(record.chunkIndex)
        } });
      }
      return { schema: 'memory-suite.flashback-read-session.v1', readOnly: true, complete: true, scope, items, dependencies,
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
      return { schema: 'memory-suite.flashback-read-session-current.v1', current, scope,
        evidenceRevision: body.evidenceRevision, dataInstanceId, resetEpoch: expected.resetEpoch };
    });
  }
  return Object.freeze({ capture, current });
}
module.exports = { PLUGIN_ID, CAPTURE_ROUTE, CURRENT_ROUTE, LIMITS, createReadSession };
