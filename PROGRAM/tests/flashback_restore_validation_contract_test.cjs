'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

assert.equal(source.match(/^[\/][\/]@version\s+(\S+)/m)[1], source.match(/const PLUGIN_VERSION = ["']([^"']+)/)[1]);
assert.match(source, /validateRestore:\s*memorySuiteFlashbackValidateRestore/);
assert.match(source, /resolveRestoreDependencies:\s*memorySuiteFlashbackResolveRestoreDependencies/);
assert.match(source, /validatePluginStorageRestore:\s*validateFlashbackPluginStorageRestore/);
assert.match(source, /memory_suite_validate_plugin_storage_restore/);

const summary = between(
  'if (!includeRecords && !Array.isArray(options?.sourceTypes)) {',
  'const loaded = await loadScopeRecords(scope.scopeKey);'
);
assert.match(summary, /loadFlashbackArchiveManifestSummary\(archiveRef\)/);
assert.match(summary, /mergeFlashbackArchiveStats\(localStats, archiveSummary\.stats\)/);
assert.match(summary, /stats\.statsCoverage = archiveStatsIncluded \? 'complete' : 'partial'/);
assert.match(summary, /archiveStatsDeferred: false/);
assert.doesNotMatch(summary, /loadScopeRecordsRaw|loadFlashbackArchiveChain/);

const validator = between(
  'const validateFlashbackPluginStorageRestore = async (context = {}) => {',
  'const restoredLegacyCompactionRecord ='
);
assert.match(source, /typeof context\?\.readback === 'function'/);
assert.match(validator, /flashbackRestorePhysicalRead\(context, space, key\)/);
assert.match(validator, /scopeKeys\.manifest\(scopeKey\)/);
assert.match(validator, /scopeShardKeyForManifest/);
assert.match(validator, /storageShardChecksum\(records\)/);
assert.match(validator, /inspectFlashbackVectorPayloadMetadata/);
assert.match(validator, /flashbackArchiveMemberDigest/);
assert.match(validator, /verifiedFlashbackArchiveParent/);
assert.match(validator, /readOnly:\s*true/);
assert.doesNotMatch(validator, /setItem|removeItem|saveScope|saveAllRecords|deleteScope/);

const resolver = between(
  'const resolveFlashbackRestoreDependencies = async (context = {}) => {',
  '// Read-only owner validation for the shared SDK'
);
assert.match(resolver, /flashbackRestoreServerValue\(context, 'plugin', currentRow\.remoteKey\)/);
assert.match(resolver, /normalizeFlashbackArchiveRef\(currentManifest\.archiveRef\)/);
assert.match(resolver, /scopeKeys\.manifest\(cursor\.archiveScopeKey\)/);
assert.match(resolver, /scopeKeys\.commitShard\(cursor\.archiveScopeKey, commitId, shardIndex\)/);
assert.match(resolver, /FLASHBACK_VECTOR_STORAGE_PREFIX/);
assert.match(resolver, /verifiedFlashbackArchiveParent\(cursor, manifest\)/);
assert.match(resolver, /dependencies\.push\(\{ space, remoteKey, logicalKey \}\)/);
assert.match(resolver, /manifestOnly:\s*true/);
assert.doesNotMatch(resolver, /loadScopeRecords|decodeFlashbackShardEnvelope|setItem|removeItem|saveScope|deleteScope/);

const storageStatus = between(
  "} else if (action === 'memory_suite_storage_status') {",
  "} else if (action === 'memory_suite_validate_plugin_storage_restore') {"
);
assert.match(storageStatus, /getConnectionSettings\(\{ force: true \}\)/);
assert.match(storageStatus, /recoveryRequired/);
assert.match(storageStatus, /syncJob/);
assert.match(storageStatus, /scopeId/);
assert.match(storageStatus, /url/);

assert.match(source, /저장 기억 \(부분\)/);
assert.match(source, /토큰 추정 \(부분\)/);
assert.match(source, /부분 통계 · 아카이브 확인 필요/);

process.stdout.write('Flashback archive stats / physical restore validation contract: PASS\n');
