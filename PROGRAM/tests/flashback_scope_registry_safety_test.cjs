'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
};

const mergeSource = between('const registryTextValue =', 'const rememberScope =');
const mergeScopeRegistryMeta = new Function(
  'text',
  'keyHash',
  `${mergeSource}\nreturn mergeScopeRegistryMeta;`
)(value => String(value ?? ''), value => `hash:${value}`);

const existing = {
  scopeKey: 'scope:one',
  storageHash: 'stable-hash',
  characterName: 'Alice',
  chatTitle: 'Chapter 7',
  personaName: 'Narrator',
  characterId: 'char-1',
  chatId: 'chat-1',
  personaId: 'persona-1',
  charIndex: 2,
  chatIndex: 5,
  count: 140,
  tokenTotal: 9000,
  shardCount: 1,
  archiveCount: 133,
  guiSummaryVersion: 1,
  updatedAt: 1234
};

const unverified = mergeScopeRegistryMeta(existing, {
  scopeKey: 'scope:one',
  characterName: '',
  chatTitle: '',
  personaName: '',
  charIndex: -1,
  chatIndex: -1,
  count: 0,
  shardCount: 0
}, { count: 0, tokenTotal: 0, shardCount: 0, archiveCount: 0, updatedAt: 9999 }, 2000);

assert.equal(unverified.characterName, 'Alice', 'blank scope identity cannot erase a known name');
assert.equal(unverified.chatTitle, 'Chapter 7');
assert.equal(unverified.personaName, 'Narrator');
assert.equal(unverified.charIndex, 2);
assert.equal(unverified.chatIndex, 5);
assert.equal(unverified.count, 140, 'an unverified empty summary cannot erase record count');
assert.equal(unverified.tokenTotal, 9000);
assert.equal(unverified.shardCount, 1);
assert.equal(unverified.archiveCount, 133);
assert.equal(unverified.updatedAt, 1234, 'an unverified read cannot claim a new data update time');

const verifiedEmpty = mergeScopeRegistryMeta(existing, { scopeKey: 'scope:one' }, {
  manifestVerified: true,
  guiSummaryVersion: 1,
  count: 0,
  tokenTotal: 0,
  shardCount: 0,
  archiveCount: 0,
  updatedAt: 9999
}, 3000);
assert.equal(verifiedEmpty.count, 0, 'a verified manifest may authoritatively report an empty scope');
assert.equal(verifiedEmpty.tokenTotal, 0);
assert.equal(verifiedEmpty.updatedAt, 9999);
assert.equal(verifiedEmpty.characterName, 'Alice', 'verified summary updates still preserve nonempty identity metadata');
assert.equal(Object.hasOwn(verifiedEmpty, 'manifestVerified'), false, 'transient verification flags are not persisted');

const verificationSource = between('const SCOPE_STORAGE_VERIFICATION =', 'const registryTextValue =');
const Runtime = { guiStorageVerificationByScope: new Map() };
const verificationApi = new Function(
  'Runtime',
  'text',
  `${verificationSource}\nreturn { SCOPE_STORAGE_VERIFICATION, scopeStorageVerification, recordScopeStorageVerification };`
)(Runtime, value => String(value ?? ''));
const states = verificationApi.SCOPE_STORAGE_VERIFICATION;
let state = verificationApi.recordScopeStorageVerification('scope:ghost', states.REGISTRY_ONLY_CANDIDATE, { epoch: 1 });
assert.equal(state.status, states.REGISTRY_ONLY_CANDIDATE);
assert.equal(state.missingObservations, 1);
state = verificationApi.recordScopeStorageVerification('scope:ghost', states.REGISTRY_ONLY_CANDIDATE, { epoch: 1 });
assert.equal(state.missingObservations, 1, 'the same refresh epoch cannot count twice');
state = verificationApi.recordScopeStorageVerification('scope:ghost', states.REGISTRY_ONLY_CANDIDATE, { epoch: 2 });
assert.equal(state.status, states.REGISTRY_ONLY_VERIFIED);
assert.equal(state.missingObservations, 2);
state = verificationApi.recordScopeStorageVerification('scope:ghost', states.UNAVAILABLE, { epoch: 3, error: 'server offline' });
assert.equal(state.status, states.UNAVAILABLE);
assert.equal(state.missingObservations, 0, 'a connection failure breaks the consecutive-absence proof');

const hydrationSource = between('const scheduleGuiStorageMetadataHydration =', 'const verifiedRegistrySummaryFromManifest =');
assert.ok(hydrationSource.indexOf('manifest.manifestRawPresent !== true') < hydrationSource.indexOf('await rememberScope'), 'manifest absence is handled before any registry write-through');
assert.match(hydrationSource, /transportUnavailable = true/);
assert.match(hydrationSource, /hydration paused after storage connection failure/);

const cleanupSource = between('const removeVerifiedRegistryOnlyScope =', 'const listScopeStorageStats =');
assert.match(cleanupSource, /missingObservations[^\n]+< 2/);
assert.match(cleanupSource, /const physicalKeys = await listScopeManagementPhysicalKeys\(key\)/);
assert.match(cleanupSource, /registry-only scope cleanup readback failed/);
assert.doesNotMatch(cleanupSource, /requireStorageRemove\(/, 'registry-only cleanup never removes canonical storage keys');

const renderSource = between('const renderStorageRows =', 'const nextRenderFrame =');
assert.doesNotMatch(renderSource, /\|\| 'Unknown'/);
assert.match(renderSource, /data-clean-registry-scope/);
assert.match(source, /id="repairScopeRegistryBtn"/);

const emptyServerShellSource = between('const emptyServerShellListingKeys =', 'const listScopeStorageStats =');
assert.match(emptyServerShellSource, /serverAbsenceChecks:\s*2/);
assert.match(emptyServerShellSource, /first\.fingerprint !== second\.fingerprint/);
assert.match(emptyServerShellSource, /FLASHBACK_EMPTY_SERVER_SHELL_PHYSICAL_DATA_PRESENT/);
assert.match(emptyServerShellSource, /empty server shell has local pluginStorage records/);
assert.match(emptyServerShellSource, /empty server shell has local vector records/);
assert.match(emptyServerShellSource, /empty server shell local registry cleanup readback failed/);
assert.match(emptyServerShellSource, /beforeMode\?\.mode === 'server_only'/);
assert.match(emptyServerShellSource, /the current Flashback scope cannot be removed/);

const retracePath = path.resolve(__dirname, '..', 'plugins', 'RETRACE.js');
const retrace = fs.readFileSync(retracePath, 'utf8');
const scanStart = retrace.indexOf('const scopeManagerScanFlashback =');
const scanEnd = retrace.indexOf('const scopeManagerScanHayaku =', scanStart);
assert.ok(scanStart >= 0 && scanEnd > scanStart, 'RE:TRACE Flashback scope scanner exists');
const scan = retrace.slice(scanStart, scanEnd);
assert.match(scan, /uniqueMembers\.length === 0/);
assert.match(scan, /emptyRegistryShellObservations >= 2/);
assert.match(scan, /kind: emptyRegistryShellCandidate \? 'registry_only_shell' : 'chat_memory'/);
assert.match(scan, /verified_empty_registry_shell_two_scans/);
assert.match(retrace, /const scopeManagerPairableKinds = new Set\(\['chat_memory', 'packet_ledger', 'canonical_memory', 'live_persona', 'analysis_recovery'\]\)/);
assert.match(retrace, /const scopeManagerPairable = scope => scopeManagerPairableKinds\.has\(scope\?\.kind\)/);
assert.match(retrace, /emptyRegistryShellVerified: scope\.descriptor\?\.emptyRegistryShellVerified === true/);

console.log('PASS flashback scope registry hydration and cleanup safety');
