'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
const hayaku = read('HAYAKU_Locator_Continuity.js');
const libra = read('LIBRA.js');
const lia = read('LIA_Persona_Linker.js');
const retrace = read('RETRACE.js');
const sdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');

for (const marker of ['ownerLegacyKeys', 'ownerLegacyRead', 'ownerLegacyWrite', 'ownerLegacyRemove']) {
  assert.ok(sdk.includes(marker), `Storage SDK owner maintenance primitive: ${marker}`);
}
assert.match(sdk, /if \(!matchesRoute\(normalizedSpace, logicalKey\)\) throw new Error\('memory_suite_owner_legacy_route_denied'\)/);
assert.match(sdk, /const written = await legacyWriteVerified/);
assert.match(sdk, /const removed = await legacyRemoveVerified/);
assert.match(sdk, /memory_suite_owner_legacy_write_failed/);
assert.match(sdk, /memory_suite_owner_legacy_remove_failed/);

for (const marker of [
  "schema: 'hayaku.scope_identity.v1'", 'characterId: compact(scope?.characterId',
  'hayakuLedgerIsPureEmptyShell', 'prepareVerifiedEmptyHayakuLedgerDeletion',
  'HAYAKU empty ledger changed during owner verification', "request.payload?.kind === 'empty_ledger_shell'"
]) assert.ok(hayaku.includes(marker), `HAYAKU orphan safety marker: ${marker}`);

const retraceHayakuStart = retrace.indexOf('const scopeManagerHayakuPureEmptyLedger =');
const retraceHayakuEnd = retrace.indexOf('const scopeManagerScanHayaku =', retraceHayakuStart);
assert.ok(retraceHayakuStart >= 0 && retraceHayakuEnd > retraceHayakuStart);
const pureEmptySource = retrace.slice(retraceHayakuStart, retraceHayakuEnd);
const pureEmpty = new Function(
  'scopeManagerObject', 'scopeManagerText', 'scopeManagerArray',
  `${pureEmptySource}\nreturn scopeManagerHayakuPureEmptyLedger;`
)(
  value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  value => String(value || '').trim(),
  value => Array.isArray(value) ? value : []
);
const emptyLedger = {
  scopeKey: 'chat_a', records: [], slotHeads: [], tombstones: [],
  worldline: { revision: 0, headTurnNodeId: '', nodes: [] }, migration: {}, coldStart: {}, incrementalRecovery: {},
  archiveRef: null, archiveOwner: false, archiveId: '', archiveGeneration: 0, archiveDigest: '', sessionHandoff: {}, portableImport: null
};
assert.equal(pureEmpty(emptyLedger, 'chat_a'), true, 'pure empty HAYAKU ledger is recognized');
assert.equal(pureEmpty({ ...emptyLedger, records: [{ recordId: 'memory' }] }, 'chat_a'), false, 'packet content is never an empty shell');
assert.equal(pureEmpty({ ...emptyLedger, migration: { complete: true } }, 'chat_a'), false, 'meaningful migration metadata is protected');
assert.equal(pureEmpty({ ...emptyLedger, archiveRef: { archiveId: 'a' } }, 'chat_a'), false, 'archive reference is protected');

for (const marker of [
  'prepareVerifiedLibraRegistryShellDeletion', 'two stable LIBRA registry-only observations are required',
  'LIBRA registry-only shell has physical server records', 'LIBRA local registry cleanup readback failed',
  "request.payload?.kind === 'registry_only_shell'"
]) assert.ok(libra.includes(marker), `LIBRA orphan safety marker: ${marker}`);

for (const marker of [
  'removePluginStorageItemChecked', 'live_persona_empty_index_remove',
  'LIA_LIVE_PERSONA_BINDING_ROLLBACK_INCOMPLETE', 'recoveredFromIndeterminateWrite',
  'persona_proof_write readback mismatch', 'prepareVerifiedLiaMetadataShellDeletion',
  'LIA metadata shell changed during owner verification', "'empty_index_shell'"
]) assert.ok(lia.includes(marker), `LIA orphan safety marker: ${marker}`);
assert.doesNotMatch(lia.slice(lia.indexOf('async function writeSplitLivePersonaStoreRaw'), lia.indexOf('async function migrateLegacyLivePersonaStore')), /catch \(_\) \{\}/,
  'split binding writes must not swallow shard deletion failures');

for (const marker of [
  'HAYAKU_SCOPE_RECORD_PREFIXES', "kind: 'registry_only_shell'", "'empty_ledger_shell'", "'metadata_only_ledger'", "'ledger_missing'",
  "'proof_only'", "'index_only'", "'index_proof_only'", "'empty_index_shell'", "'shard_only'",
  'metadataShellObservations', 'verified_empty_ledger_two_scans', 'verified_registry_only_shell_two_scans',
  'verified_metadata_shell_two_scans', 'scopeManagerPairableKinds'
]) assert.ok(retrace.includes(marker), `RE:TRACE peer scope marker: ${marker}`);
assert.match(retrace, /metadataShellVerified: scope\.descriptor\?\.metadataShellVerified === true/);
assert.match(retrace, /'shared_archive', 'metadata_only_ledger', 'ledger_missing', 'manifest_missing'/);

process.stdout.write('peer_orphan_scope_safety_test: PASS\n');
