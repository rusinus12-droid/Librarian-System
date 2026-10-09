'use strict';
const crypto = require('node:crypto');
const MAX_ITEMS = 1000, MAX_VALUE_BYTES = 2 * 1024 ** 2, MAX_TOTAL_BYTES = 8 * 1024 ** 2;
const scopeHash = value => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(36);
};
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { statusCode }); };
// A bounded storage snapshot, not a health classifier or repair authorization.
// Never instantiate a repository here: the existing running server owns it.
module.exports = ({ getRepository, dataInstanceId, epochs, canRead }) => async (principal, body) => {
  if (principal?.namespace !== 'flashback' || !principal.roles?.includes('owner')) fail('HEALTH_OWNER_REQUIRED', 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['scopeKey','dataInstanceId','epoch','expectedFingerprint'].includes(key))) fail('HEALTH_REQUEST_INVALID', 400);
  const scopeKey = body.scopeKey;
  if (typeof scopeKey !== 'string' || !scopeKey || scopeKey !== scopeKey.trim() || scopeKey.length > 512 || /[\r\n\0]/.test(scopeKey)) fail('HEALTH_SCOPE_INVALID', 400);
  if (body.dataInstanceId !== dataInstanceId) fail('HEALTH_DATA_IDENTITY_CHANGED');
  const epoch = Number(epochs().flashback || 0);
  if (!Number.isSafeInteger(body.epoch) || body.epoch < 0 || body.epoch !== epoch) fail('HEALTH_RESET_CHANGED');
  if (body.expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(body.expectedFingerprint)) fail('HEALTH_FINGERPRINT_INVALID', 400);
  if (!canRead()) fail('HEALTH_MAINTENANCE', 503);
  const repository = getRepository();
  if (!repository?.database || typeof repository.list !== 'function' || typeof repository.get !== 'function') fail('HEALTH_STORAGE_UNAVAILABLE', 503);
  const alias = scopeHash(scopeKey), prefix = `vector_rag_memory:scope:${alias}:`, vectorPrefix = `vector_rag_memory:local-vector-shard:v1:${alias}:`;
  const records = [], values = [], skipped = [], inventory = [];
  let bytes = 0, inventoryComplete = true, scopeVerified = false;
  const selected = (space, name) => space === 'plugin'
    ? /^(?:manifest:v2(?::previous:v1)?|turn_worldline:v1|records:shard:[0-9]{4,6}|records:commit:[A-Za-z0-9_-]{1,160}:shard:[0-9]{4,6})$/.test(name)
    : /^[A-Za-z0-9_-]{1,160}:[0-9]{4,6}$/.test(name);
  repository.database.exec('BEGIN');
  try {
    for (const [space, ownedPrefix] of [['plugin',prefix],['local',vectorPrefix]]) {
      const page = repository.list(space, ownedPrefix, { paged:true, limit:MAX_ITEMS, cursorKey:'' });
      if (!page || !Array.isArray(page.records) || typeof page.page?.hasMore !== 'boolean') fail('HEALTH_INVENTORY_UNVERIFIED', 503);
      if (page.page.hasMore || page.records.length > MAX_ITEMS) inventoryComplete = false;
      for (const row of page.records.slice(0,MAX_ITEMS)) {
        if (typeof row.key !== 'string' || !row.key.startsWith(ownedPrefix)) fail('HEALTH_SCOPE_PREFIX_MISMATCH', 500);
        inventory.push([space,row.key,row.tombstone,row.revision,row.digest,row.valueBytes]);
        const name = row.key.slice(ownedPrefix.length);
        if (!selected(space,name)) { skipped.push({space,reason:'unsupported_scope_record'}); continue; }
        if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !/^[a-f0-9]{64}$/.test(row.digest)
            || !Number.isSafeInteger(row.valueBytes) || row.valueBytes < 0 || typeof row.tombstone !== 'boolean') fail('HEALTH_RECORD_METADATA_UNVERIFIED', 503);
        records.push({space,key:row.key,name,tombstone:row.tombstone,revision:row.revision,digest:row.digest,valueBytes:row.valueBytes});
      }
    }
    records.sort((a,b) => a.space.localeCompare(b.space) || a.key.localeCompare(b.key));
    const read = row => {
      if (row.valueBytes > MAX_VALUE_BYTES || bytes + row.valueBytes > MAX_TOTAL_BYTES) { skipped.push({space:row.space,name:row.name,reason:'size_limit'}); return null; }
      let result;
      try { result = repository.get(row.space,row.key); }
      catch (_) { skipped.push({space:row.space,name:row.name,reason:'read_or_decode_failed'}); return null; }
      if (!result?.exists || result.tombstone || result.revision !== row.revision || result.digest !== row.digest) {
        skipped.push({space:row.space,name:row.name,reason:'snapshot_mismatch'}); return null;
      }
      // Account for actual serialized bytes too; do not trust metadata alone.
      let size;
      try { size = Buffer.byteLength(JSON.stringify(result.value)); } catch (_) { size = Infinity; }
      if (size > MAX_VALUE_BYTES || bytes + size > MAX_TOTAL_BYTES) { skipped.push({space:row.space,name:row.name,reason:'size_limit'}); return null; }
      if (crypto.createHash('sha256').update(JSON.stringify(result.value)).digest('hex') !== row.digest) {
        skipped.push({space:row.space,name:row.name,reason:'value_digest_mismatch'}); return null;
      }
      bytes += size;
      let parsed;
      try { parsed = typeof result.value === 'string' ? JSON.parse(result.value) : result.value; } catch (_) {}
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.scopeKey !== scopeKey) {
        skipped.push({space:row.space,name:row.name,reason:'record_scope_unverified'}); return null;
      }
      return {space:row.space,key:row.key,name:row.name,value:result.value};
    };
    const manifestRow = records.find(row => row.space === 'plugin' && row.name === 'manifest:v2' && !row.tombstone);
    const manifestValue = manifestRow ? read(manifestRow) : null;
    let manifest;
    try { manifest = typeof manifestValue?.value === 'string' ? JSON.parse(manifestValue.value) : manifestValue?.value; } catch (_) {}
    scopeVerified = !!manifest && !Array.isArray(manifest) && manifest.schema === 'vector_rag_memory.scope_manifest.v2' && manifest.scopeKey === scopeKey;
    if (!scopeVerified) skipped.push({reason:'scope_manifest_unverified'});
    else {
      values.push(manifestValue);
      for (const row of records) if (!row.tombstone && row !== manifestRow) { const value = read(row); if (value) values.push(value); }
      if (!Number.isSafeInteger(manifest.shardCount) || manifest.shardCount < 0 || manifest.shardCount > MAX_ITEMS) skipped.push({reason:'active_shard_directory_unverified'});
      else {
        const directory = ['rawPageLayout','rawPageReferences','rawPageDirectoryDigest'].some(key => Object.hasOwn(manifest,key));
        for (let index = 0; index < manifest.shardCount; index++) {
          let key;
          if (directory) {
            const ref = manifest.rawPageReferences?.[index];
            if (manifest.rawPageLayout !== 'flashback.raw_pages.v1' || !Array.isArray(manifest.rawPageReferences)
                || manifest.rawPageReferences.length !== manifest.shardCount || ref?.scopeKey !== scopeKey
                || ref.payloadShardIndex !== index || !/^[A-Za-z0-9_-]{1,160}$/.test(ref.payloadCommitId || '')
                || ref.storageKey !== `${prefix}records:commit:${ref.payloadCommitId}:shard:${String(index).padStart(4,'0')}`) {
              skipped.push({reason:'active_shard_directory_unverified'}); break;
            }
            key = ref.storageKey;
          } else if (manifest.commitId && !/^[A-Za-z0-9_-]{1,160}$/.test(manifest.commitId)) {
            skipped.push({reason:'active_shard_directory_unverified'}); break;
          } else key = `${prefix}records:${manifest.commitId ? `commit:${manifest.commitId}:` : ''}shard:${String(index).padStart(4,'0')}`;
          if (!values.some(value => value.space === 'plugin' && value.key === key)) skipped.push({reason:'active_shard_missing',index});
        }
      }
      if (manifest.archiveRef != null && manifest.archiveRef !== '' && manifest.archiveRef !== false) skipped.push({reason:'archive_scope_excluded'});
    }
    if (!canRead() || Number(epochs().flashback || 0) !== epoch) fail('HEALTH_AUTHORITY_CHANGED');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({owner:'flashback',dataInstanceId,epoch,scopeKey,inventory,records,inventoryComplete,skipped})).digest('hex');
    if (body.expectedFingerprint && body.expectedFingerprint !== fingerprint) fail('HEALTH_SNAPSHOT_CHANGED');
    const complete = scopeVerified && inventoryComplete && skipped.length === 0;
    return {schema:'flashback.scope-health-snapshot.v1',owner:'flashback',scopeKey,scopeHash:alias,dataInstanceId,epoch,at:Date.now(),readOnly:true,
      coverage:'scope_records_only',status:complete?'snapshot_complete':'snapshot_incomplete',healthVerified:false,
      complete,inventoryComplete,scopeVerified,fingerprint,records:scopeVerified?records:[],values,skipped,
      limits:{maxItemsPerSpace:MAX_ITEMS,maxValueBytes:MAX_VALUE_BYTES,maxTotalValueBytes:MAX_TOTAL_BYTES},
      exclusions:['global_settings','credentials','other_scopes','host_currentness','physical_repair']};
  } finally { repository.database.exec('ROLLBACK'); }
};
