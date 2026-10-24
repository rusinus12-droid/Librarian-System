'use strict';

// Read only the HAYAKU producer's published ledger, selected packet bodies and
// explicitly referenced immutable archives. Never enumerate or replay receipts.
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const PLUGIN_ID = 'serial_gradation_agents_for_rp';
const CAPTURE_ROUTE = '/v1/hayaku/read-session/capture';
const CURRENT_ROUTE = '/v1/hayaku/read-session/current';
const MiB = 1024 ** 2;
const LIMITS = Object.freeze({ defaultCorpusBytes: 4 * MiB, maxCorpusBytes: 32 * MiB,
  manifestBytes: MiB, itemMetadataBytes: 64 * 1024, totalMetadataBytes: MiB,
  maxRefs: 4096, currentRequestBytes: 4 * MiB });
const DELTA_PREFIX = 'hayaku.v2.storage_reconciliation_journal.capture_delta::';
const ARCHIVE_PREFIX = 'hayaku.v2.shared_archive.';
const META_PREFIX = 'hayaku.v2.shared_archive_meta.';
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const int = value => Number.isSafeInteger(value) && value >= 0;
function stableHash64(value) {
  // Exact producer FNV-1a/64 over UTF-16 code units, including surrogate pairs.
  let high = 0xcbf29ce4, low = 0x84222325;
  for (let i = 0; i < value.length; i++) {
    low = (low ^ value.charCodeAt(i)) >>> 0;
    high = (Math.imul(high, 435) + (low << 8) + Math.floor(low * 435 / 0x100000000)) >>> 0;
    low = Math.imul(low, 435) >>> 0;
  }
  return 'h64' + ((BigInt(high) << 32n) | BigInt(low)).toString(36);
}
function scopeOf(value) {
  if (!object(value) || !['scopeKey', 'characterId', 'chatId'].every(key => text(value[key]))) fail('gradia_read_scope_invalid', 400);
  const scope = { scopeKey: value.scopeKey, characterId: value.characterId, chatId: value.chatId };
  if (scope.scopeKey !== 'chat_' + stableHash64(scope.characterId + '\n' + scope.chatId)) fail('gradia_read_scope_invalid', 400);
  return scope;
}
const ledgerKeyFor = scope => 'hayaku.v2.ledger.' + scope.scopeKey;
function corpusLimit(value) {
  if (value === undefined) return LIMITS.defaultCorpusBytes;
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.maxCorpusBytes) fail('gradia_read_corpus_limit_invalid', 400);
  return value;
}
function decode(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { fail('gradia_read_stored_json_invalid'); } }
  if (!object(value)) fail('gradia_read_stored_object_invalid');
  return value;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function metadataOf(repository, key) {
  const value = repository.getMetadata('plugin', key);
  return { namespace: 'hayaku', space: 'plugin', key, exists: value.exists, tombstone: value.tombstone,
    revision: value.revision, digest: value.digest, updatedAt: value.updatedAt, valueBytes: value.valueBytes };
}
function allowedKey(key, scope, index) {
  if (!text(key, 1200)) return false;
  if (index === 0) return key === ledgerKeyFor(scope);
  return key.startsWith(DELTA_PREFIX + scope.scopeKey + '::')
    || /^hayaku\.v2\.shared_archive(?:_meta)?\.[A-Za-z0-9_-]{1,128}$/.test(key);
}
function validMetadata(value, scope, index) {
  if (!object(value) || value.namespace !== 'hayaku' || value.space !== 'plugin' || !allowedKey(value.key, scope, index)) fail('gradia_read_dependencies_invalid', 400);
  if (index === 0 && value.exists === false) {
    if (value.tombstone !== false || value.revision !== 0 || value.digest !== '' || value.updatedAt !== 0 || value.valueBytes !== 0) {
      fail('gradia_read_dependencies_invalid', 400);
    }
    return { namespace: 'hayaku', space: 'plugin', key: value.key, exists: false, tombstone: false,
      revision: 0, digest: '', updatedAt: 0, valueBytes: 0 };
  }
  if (value.exists !== true || value.tombstone !== false || !int(value.revision) || value.revision < 1
    || !/^[a-f0-9]{64}$/.test(value.digest || '') || !int(value.updatedAt) || !int(value.valueBytes)) fail('gradia_read_dependencies_invalid', 400);
  return { namespace: 'hayaku', space: 'plugin', key: value.key, exists: true, tombstone: false,
    revision: value.revision, digest: value.digest, updatedAt: value.updatedAt, valueBytes: value.valueBytes };
}
function slotId(record) {
  const type = record.packetType || 'current_snapshot';
  if (record.inheritedSessionHistory === true || record.memoryClass === 'historical') return record.permanentHistoryId
    ? ['historical_permanent', record.permanentHistoryId, type].join('\x01')
    : ['historical', record.coldStartEpochId || record.inheritedFromScopeKey || 'session', number(record.historicalOrdinal), type].join('\x01');
  if (record.incrementalRecoveryId) return ['incremental_recovery', record.ownerTurnNodeId || record.ownerNodeId || `pair:${Math.max(1, number(record.targetPairIndex) || 1)}`, record.incrementalRecoveryId, type].join('\x01');
  if (record.ownerTurnNodeId || record.ownerNodeId) return ['node', record.ownerTurnNodeId || record.ownerNodeId, type].join('\x01');
  if (record.requestNonce) return ['pending', record.requestNonce, type].join('\x01');
  return ['pair', Math.max(1, number(record.targetPairIndex) || 1), record.userHash || record.userMessageIdHash || '', type].join('\x01');
}
const archiveIdFor = record => record.permanentHistoryId || record.archiveCanonicalId
  || stableHash64([record.inheritedFromScopeKey || '', slotId(record), record.hash || '', record.packetType || ''].join('\x01'));
function selectedRecords(ledger) {
  const records = ledger.records, heads = ledger.slotHeads || [], tombstones = ledger.tombstones || [];
  if (!Array.isArray(records) || !Array.isArray(heads) || !Array.isArray(tombstones)) fail('gradia_read_ledger_schema_invalid');
  if (records.length > LIMITS.maxRefs || heads.length > LIMITS.maxRefs || tombstones.length > LIMITS.maxRefs) fail('gradia_read_reference_limit_exceeded', 413);
  if (records.some(record => !object(record) || !text(record.recordId, 196) || !text(record.hash, 96))) fail('gradia_read_memory_identity_mismatch');
  const byId = new Map(records.map(record => [record.recordId, record])), byHash = new Map(records.map(record => [record.hash, record]));
  if (byId.size !== records.length) fail('gradia_read_duplicate_memory_pointer');
  const eligible = heads.length ? heads.filter(head => ['active', 'historical'].includes(head?.state))
    .map(head => byId.get(head.selectedRecordId) || byHash.get(head.selectedVariantHash)).filter(Boolean)
    : records.filter(record => ['active', 'historical'].includes(record.recordState));
  const tombstonesBySlot = new Map(tombstones.filter(t => object(t) && t.active !== false && !number(t.restoredAt)).map(t => [t.slotId, t]));
  return [...new Map(eligible.filter(record => {
    if (record.permanentSessionHistory === true || record.deletionProtected === true || record.historicalProtection === 'permanent_session_history') return true;
    const tombstone = tombstonesBySlot.get(slotId(record));
    return !tombstone || (Boolean(tombstone.recordId || tombstone.variantHash) && tombstone.recordId !== record.recordId && tombstone.variantHash !== record.hash);
  }).map(record => [record.recordId, record])).values()];
}
function archivePointer(value) {
  if (!object(value) || value.schema !== 'hayaku.shared_archive_ref.v1' || !text(value.archiveId, 128)
    || !/^[A-Za-z0-9_-]+$/.test(value.archiveId) || value.storageKey !== ARCHIVE_PREFIX + value.archiveId
    || value.metaKey !== META_PREFIX + value.archiveId || !int(value.recordCount) || !int(value.deltaCount)
    || !int(value.generation) || value.generation < 1 || !int(value.depth) || value.depth < 1 || value.depth > 256
    || !text(value.digest, 96)) fail('gradia_read_archive_pointer_invalid');
  return value;
}
// A composed reader can only tighten this owner's existing raw-read ceiling.
function rawLimitOf(value, maxCorpusBytes) {
  const maximum = 7 * maxCorpusBytes + 2 * LIMITS.totalMetadataBytes;
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('gradia_read_storage_limit_invalid', 400);
  return value;
}
function createReadSession({ getRepository, dataInstanceId, epochs, canRead }) {
  const identity = scope => ({ scope: { ...scope }, dataInstanceId, resetEpoch: Number(epochs().hayaku || 0) });
  function readUnit(body) {
    if (!canRead()) fail('gradia_read_maintenance', 503);
    const repository = getRepository(), epoch = Number(epochs().hayaku || 0);
    repository.database.exec('BEGIN');
    try {
      const result = body(repository);
      if (!canRead() || Number(epochs().hayaku || 0) !== epoch) fail('gradia_read_maintenance', 503);
      return deepFreeze(result);
    } finally { repository.database.exec('ROLLBACK'); }
  }
  function capture(body) {
    const scope = scopeOf(body?.scope), maxCorpusBytes = corpusLimit(body?.maxCorpusBytes);
    const rawLimit = rawLimitOf(body?.maxRawBytes, maxCorpusBytes);
    return readUnit(repository => {
      const readIdentity = identity(scope), dependencies = [], cache = new Map();
      const rootKey = ledgerKeyFor(scope);
      const rootMetadata = metadataOf(repository, rootKey);
      if (!rootMetadata.exists || rootMetadata.tombstone) {
        const rootDeps = [rootMetadata];
        return { schema: 'memory-suite.hayaku-read-session.v1', readOnly: true, complete: true, scope, items: [], dependencies: rootDeps,
          evidenceRevision: hash(rootDeps), corpusBytes: 0, maxCorpusBytes, maxRawBytes: rawLimit, metadataBytes: 0, rawBytes: rootMetadata.valueBytes || 0, dataInstanceId, resetEpoch: readIdentity.resetEpoch, readIdentity };
      }
      let rawBytes = 0, decodedBytes = 0, metadataBytes = 0, corpusBytes = 0, recordCount = 0, packetRefs = 0;
      const chargedReceipts = new Set();
      // Inline packets live inside the ledger itself. Its body limit must be a
      // corpus limit plus metadata, rather than treating the corpus as metadata.
      const chargeMetadata = (value, perItem = false) => {
        const size = bytes(value); metadataBytes += size;
        if ((perItem && size > LIMITS.itemMetadataBytes) || metadataBytes > LIMITS.totalMetadataBytes) fail('gradia_read_metadata_budget_exceeded', 413);
      };
      const read = key => {
        if (cache.has(key)) return cache.get(key);
        if (dependencies.length > LIMITS.maxRefs || !allowedKey(key, scope, dependencies.length)) fail('gradia_read_memory_pointer_invalid');
        const metadata = metadataOf(repository, key);
        if (!metadata.exists || metadata.tombstone) fail('gradia_read_dependency_unavailable');
        if (!int(metadata.valueBytes) || metadata.valueBytes > rawLimit - rawBytes - decodedBytes) fail('gradia_read_storage_budget_exceeded', 413);
        let row;
        try { row = repository.get('plugin', key, { maxValueBytes: rawLimit - rawBytes - decodedBytes }); }
        catch (error) { fail(error?.statusCode === 413 ? 'gradia_read_storage_budget_exceeded' : 'gradia_read_dependency_decode_failed', error?.statusCode === 413 ? 413 : 409); }
        if (!row?.exists || row.tombstone || row.revision !== metadata.revision || row.digest !== metadata.digest) fail('gradia_read_dependency_changed');
        if (bytes(row.value) !== metadata.valueBytes || hash(row.value) !== metadata.digest) fail('gradia_read_dependency_digest_mismatch');
        rawBytes += metadata.valueBytes;
        const result = { parsed: decode(row.value), raw: typeof row.value === 'string' ? row.value : JSON.stringify(row.value), metadata };
        dependencies.push(metadata); cache.set(key, result); return result;
      };
      const head = read(ledgerKeyFor(scope)), ledger = head.parsed;
      if (!['hayaku_storage_ledger_v1', 'hayaku_storage_ledger_v2'].includes(ledger.version) || ledger.scopeKey !== scope.scopeKey
        || ledger.identity?.schema !== 'hayaku.scope_identity.v1' || !['scopeKey', 'characterId', 'chatId'].every(key => ledger.identity[key] === scope[key])) fail('gradia_read_manifest_scope_mismatch');
      chargeMetadata({ ...ledger, records: [] });
      const validateRecords = records => {
        if (!Array.isArray(records) || (recordCount += records.length) > LIMITS.maxRefs) fail('gradia_read_reference_limit_exceeded', 413);
        for (const record of records) { if (!object(record)) fail('gradia_read_memory_schema_invalid'); chargeMetadata({ ...record, raw: '' }, true); }
      };
      validateRecords(ledger.records);
      const packetOf = (record, ownerScope, archive = false) => {
        let raw = record.raw;
        if (!archive && record.captureRawRef != null) {
          const ref = record.captureRawRef;
          if (!object(ref) || ref.schema !== 'hayaku.capture_raw_delta.v1' || ref.scopeKey !== ownerScope
            || !text(ref.binding, 512) || !text(ref.digest, 96) || !text(ref.rawDigest, 96) || !int(ref.packetIndex)
            || ref.storageKey !== DELTA_PREFIX + ownerScope + '::' + ref.binding + '::' + ref.digest) fail('gradia_read_memory_pointer_invalid');
          const receipt = read(ref.storageKey);
          if (stableHash64(receipt.raw) !== ref.digest || receipt.parsed.schema !== ref.schema
            || receipt.parsed.scopeKey !== ownerScope || receipt.parsed.binding !== ref.binding) fail('gradia_read_memory_identity_mismatch');
          if (!chargedReceipts.has(ref.storageKey)) {
            const packets = receipt.parsed.packets;
            if (!Array.isArray(packets) || (packetRefs += packets.length) > LIMITS.maxRefs) fail('gradia_read_reference_limit_exceeded', 413);
            chargeMetadata({ ...receipt.parsed, packets: [] });
            for (const packet of packets) {
              if (!object(packet) || typeof packet.raw !== 'string') fail('gradia_read_memory_schema_invalid');
              chargeMetadata({ ...packet, raw: '' }, true);
            }
            chargedReceipts.add(ref.storageKey);
          }
          const packet = receipt.parsed.packets?.[ref.packetIndex];
          if (typeof packet?.raw !== 'string' || stableHash64(packet.raw) !== ref.rawDigest
            || (raw !== undefined && raw !== packet.raw)) fail('gradia_read_memory_identity_mismatch');
          raw = packet.raw;
        }
        if (typeof raw !== 'string' || !raw || raw.trim().length > 96000 || stableHash64(raw.trim()) !== record.hash) fail('gradia_read_memory_identity_mismatch');
        const parsed = decode(raw);
        if (parsed.meta?.schema !== 'hayaku_packet_v1' || Number(parsed.meta.packet_schema_rev) !== 2
          || !['meta', 'entity', 'world', 'narrative', 'planner', 'importance'].every(key => object(parsed[key]))) fail('gradia_read_memory_schema_invalid');
        const packetType = parsed.meta.packet_type || parsed.meta.packetType || 'current_snapshot';
        if (record.packetType && record.packetType !== packetType) fail('gradia_read_memory_identity_mismatch');
        return raw;
      };
      const rows = new Map();
      const append = (record, key, inherited, ownerScope) => {
        if (!text(record.recordId, 196) || !text(record.hash, 96)) fail('gradia_read_memory_identity_mismatch');
        const content = packetOf(record, ownerScope, key.startsWith(ARCHIVE_PREFIX)), id = archiveIdFor(record), previous = rows.get(id);
        if (!previous || number(record.capturedAt || record.inheritedAt) >= number(previous.record.capturedAt || previous.record.inheritedAt)) {
          corpusBytes += Buffer.byteLength(content, 'utf8') - (previous ? Buffer.byteLength(previous.content, 'utf8') : 0);
          rows.set(id, {record,key,inherited,ownerScope,content});
        }
      };
      if (ledger.archiveRef != null && ledger.archiveRef !== false && ledger.archiveRef !== '') {
        const first = archivePointer(ledger.archiveRef), seen = new Set(), layers = [];
        let cursor = first;
        while (cursor) {
          if (seen.has(cursor.storageKey) || layers.length >= 256) fail('gradia_read_archive_cycle');
          seen.add(cursor.storageKey);
          const stored = read(cursor.storageKey), meta = read(cursor.metaKey).parsed;
          let archive = stored.parsed;
          if (archive.schema === 'hayaku.shared_archive.gzip.v1') {
            if (archive.encoding !== 'gzip+base64' || archive.archiveSchema !== 'hayaku.shared_archive.v1' || archive.archiveId !== cursor.archiveId
              || !int(archive.rawChars) || typeof archive.data !== 'string' || !int(archive.compressedBytes)
              || archive.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(archive.data)) fail('gradia_read_archive_schema_invalid');
            const remaining = rawLimit - rawBytes - decodedBytes;
            if (archive.rawChars > remaining || remaining < 1) fail('gradia_read_storage_budget_exceeded', 413);
            const compressed = Buffer.from(archive.data, 'base64');
            if (compressed.length !== archive.compressedBytes) fail('gradia_read_archive_identity_mismatch');
            let raw;
            try { raw = gunzipSync(compressed, { maxOutputLength: remaining }).toString('utf8'); }
            catch (error) { fail(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'gradia_read_storage_budget_exceeded' : 'gradia_read_archive_decode_failed', error?.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 409); }
            if (raw.length !== archive.rawChars || stableHash64(raw) !== archive.rawHash) fail('gradia_read_archive_identity_mismatch');
            decodedBytes += Buffer.byteLength(raw, 'utf8');
            archive = decode(raw);
          }
          if (archive.schema !== 'hayaku.shared_archive.v1' || meta.schema !== 'hayaku.shared_archive_meta.v1'
            || archive.archiveId !== cursor.archiveId || meta.archiveId !== cursor.archiveId
            || ['generation','depth','deltaCount','recordCount','digest'].some(key => archive[key] !== cursor[key] || meta[key] !== cursor[key])) fail('gradia_read_archive_identity_mismatch');
          validateRecords(archive.records); chargeMetadata({ ...archive, records: [] }); chargeMetadata(meta);
          const ids = archive.records.map(archiveIdFor).sort(), digest = stableHash64(ids.join('\x01'));
          if (new Set(ids).size !== ids.length || ids.length !== cursor.deltaCount || archive.deltaDigest !== digest
            || meta.deltaDigest !== digest || !same([...meta.deltaMemberIds || []].sort(), ids)) fail('gradia_read_archive_identity_mismatch');
          const parents = [cursor.parentRef, archive.parentRef || archive.parentArchiveRef, meta.parentRef || meta.parentArchiveRef].filter(Boolean).map(archivePointer);
          if (parents.some(parent => !['archiveId','storageKey','metaKey','generation','depth','deltaCount','recordCount','digest'].every(key => parent[key] === parents[0][key]))) fail('gradia_read_archive_parent_mismatch');
          const parent = parents[0] || null;
          if (parent ? parent.depth + 1 !== cursor.depth || parent.generation + 1 !== cursor.generation || parent.recordCount + cursor.deltaCount !== cursor.recordCount
            : cursor.depth !== 1 || cursor.generation !== 1 || cursor.recordCount !== cursor.deltaCount) fail('gradia_read_archive_parent_mismatch');
          layers.push({archive,key:cursor.storageKey}); cursor = parent;
        }
        const archiveIds = new Set();
        for (const {archive,key} of layers.reverse()) for (const record of archive.records) {
          const id = archiveIdFor(record); if (archiveIds.has(id)) fail('gradia_read_duplicate_memory_pointer'); archiveIds.add(id);
          append(record,key,true,record.inheritedFromScopeKey || scope.scopeKey);
        }
        if (archiveIds.size !== first.recordCount || stableHash64([...archiveIds].sort().join('\x01')) !== first.digest) fail('gradia_read_archive_identity_mismatch');
      }
      for (const record of selectedRecords(ledger)) append(record,head.metadata.key,record.inheritedSessionHistory === true || record.memoryClass === 'historical',scope.scopeKey);
      if (corpusBytes > maxCorpusBytes) fail('gradia_read_corpus_budget_exceeded', 413);
      const items = [...rows.values()].map(({record,key,inherited,ownerScope,content}) => {
        const start = number(record.recoveryTurnStart || record.targetPairIndex), end = number(record.recoveryTurnEnd || record.targetPairIndex);
        return { id: record.recordId, key, content, source: {namespace:'hayaku',space:'plugin',scopeKey:ownerScope,
          memoryId:record.recordId,revision:cache.get(key).metadata.revision,sourceDigest:record.hash,
          turnRange:{start,end},sessionEpoch:0,inherited,archiveShared:key.startsWith(ARCHIVE_PREFIX)} };
      });
      return {schema:'memory-suite.hayaku-read-session.v1',readOnly:true,complete:true,scope,items,dependencies,
        evidenceRevision:hash(dependencies),corpusBytes,maxCorpusBytes,maxRawBytes:rawLimit,metadataBytes,rawBytes:rawBytes+decodedBytes,dataInstanceId,resetEpoch:readIdentity.resetEpoch,readIdentity};
    });
  }
  function current(body) {
    const scope = scopeOf(body?.scope);
    if (!object(body.readIdentity) || !same(scopeOf(body.readIdentity.scope), scope)) fail('gradia_read_scope_changed', 400);
    if (!Array.isArray(body.dependencies) || body.dependencies.length < 1 || body.dependencies.length > LIMITS.maxRefs + 1) fail('gradia_read_dependencies_invalid', 400);
    const dependencies = body.dependencies.map((value,index) => validMetadata(value,scope,index));
    if (new Set(dependencies.map(value=>value.key)).size !== dependencies.length || body.evidenceRevision !== hash(dependencies)) fail('gradia_read_evidence_revision_invalid',400);
    return readUnit(repository => {
      const expected = identity(scope);
      const matches = body.dataInstanceId === dataInstanceId && body.resetEpoch === expected.resetEpoch
        && body.readIdentity.dataInstanceId === dataInstanceId && body.readIdentity.resetEpoch === expected.resetEpoch;
      return {schema:'memory-suite.hayaku-read-session-current.v1',current:matches && dependencies.every(value=>same(value,metadataOf(repository,value.key))),
        scope,evidenceRevision:body.evidenceRevision,dataInstanceId,resetEpoch:expected.resetEpoch};
    });
  }
  return Object.freeze({capture,current});
}
module.exports = {PLUGIN_ID,CAPTURE_ROUTE,CURRENT_ROUTE,LIMITS,createReadSession};
