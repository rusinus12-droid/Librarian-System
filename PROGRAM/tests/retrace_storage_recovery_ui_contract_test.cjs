'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {retrace}\\s*$", "m"));

// Flashback owner-summary statistics remain needed for continuity inspection.
for (const marker of [
  'normalizeFlashbackStats',
  "source.tokenTotal ?? source.tokens"
]) assert.ok(source.includes(marker), `missing Flashback marker: ${marker}`);
assert.ok(!source.includes("source: 'flashback_plugin_storage'"), 'export source must not be hardcoded');

// Server manager must fail fast on an old server, batch reads, use bounded
// namespace concurrency, and render only after clearing terminal loading state.
for (const marker of [
  'assertServerScopeManagerCapabilities',
  "'server-batch-read.v1', 'scope-index.v1', 'scope-catalog.v1'",
  'MEMORY_SUITE_SCOPE_BATCH_MAX_BYTES',
  'managerServerGetMany(namespace, space, batch)',
  'MEMORY_SUITE_SCOPE_SCAN_CONCURRENCY = 2',
  'single-get-fallback',
  'Runtime.serverScopeManagerLoading = false;',
  'renderServerScopeManagement();'
]) assert.ok(source.includes(marker), `missing server manager marker: ${marker}`);
const finallyRender = /finally\s*\{\s*Runtime\.serverScopeManagerLoading = false;[\s\S]{0,400}?renderServerScopeManagement\(\);\s*\}/m;
assert.match(source, finallyRender, 'terminal server manager state renders after loading=false');

// Four-owner dynamic dashboard; RE:TRACE is a read-only control plane, not a storage-mode owner.
for (const owner of ['flashback', 'hayaku', 'libra', 'lia']) {
  assert.ok(source.includes(`requestMemorySuiteOwnerStorageStatus`), 'owner status requester exists');
  assert.ok(source.includes(`'${owner}'`), `${owner} dashboard participant`);
}
for (const marker of [
  "MEMORY_SUITE_OWNER_STATUS_ORDER = Object.freeze(['flashback', 'hayaku', 'libra', 'lia'])",
  "'memory_suite_storage_status'",
  'payload?.recoveryRequired ?? status.recoveryRequired',
  "row.recoveryGuard.required ? '복구 필요' : '정상'",
  'owner-storage-grid',
  'memorySuiteOwnerStorageGateFromRows',
  'participantOwners: participantSummary.map(item => item.owner)',
  '미설치·비활성으로 확인된 owner만 제외됩니다.',
  'RE:TRACE는 저장 모드를 소유하거나 변경하지 않습니다.'
]) assert.ok(source.includes(marker), `missing owner dashboard marker: ${marker}`);
assert.ok(!source.includes('고급 설정 · RE:TRACE 자체 복구 저장소'), releaseText('{retrace} keeps the retired RE:TRACE own storage-mode selector absent'));
assert.ok(!source.includes('retraceOwnStorageAdvancedPanel'), releaseText('{retrace} keeps the retired advanced own-mode panel absent'));

// Destination mode is derived from the active owner gate and pinned in the journal.
// Verification is read-only; it never asks peers to switch mode.
for (const marker of [
  'HANDOFF_STORAGE_POLICY_SCHEMA',
  'const targetStorageMode = sourceStorageGate.commonMode',
  'storageDestination: targetStorageMode',
  'pending_storage_configuration',
  'ensurePendingHandoffStorageConfiguration(loaded)',
  'requestOwnerHandoffStorageMode',
  "reason: actualMode === mode ? 'owner_mode_verified_read_only'",
  'RETRACE_HANDOFF_STORAGE_CONFIGURATION_PENDING',
  'RETRACE_OWNER_STORAGE_MODE_DRIFT',
  'sourceMutationAllowed: false',
  'sourceCompactionAllowed: false'
]) assert.ok(source.includes(marker), `missing handoff storage marker: ${marker}`);
assert.ok(!source.includes('name="handoffStorageDestination"'), 'manual next-session storage-mode radio is removed');
const requestModeStart = source.indexOf('const requestOwnerHandoffStorageMode = async');
const requestModeEnd = source.indexOf('const ensurePendingHandoffStorageConfiguration = async', requestModeStart);
assert.ok(requestModeStart >= 0 && requestModeEnd > requestModeStart, 'read-only owner mode verifier exists');
assert.doesNotMatch(source.slice(requestModeStart, requestModeEnd), /memory_suite_set_mode/, 'read-only verifier must not mutate peer storage mode');

process.stdout.write('retrace_storage_recovery_ui_contract_test: PASS\n');
