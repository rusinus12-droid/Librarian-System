'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const retrace = fs.readFileSync(path.join(root, 'plugins', 'RETRACE.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.cjs'), 'utf8');
const sdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteStorageClient.source.js'), 'utf8');
assert.equal((retrace.match(/const refreshServerScopeManagement =/g) || []).length, 1, 'one canonical server scope refresh path');
assert.equal((retrace.match(/const renderServerScopeManagement =/g) || []).length, 1, 'one canonical server scope render path');
assert.ok(!retrace.includes('deleteOrphanServerScope'), 'legacy duplicate orphan-only manager removed');
assert.ok(!retrace.includes('refreshServerScopeManager'), 'legacy duplicate scope manager removed');
for (const marker of [
  'data-tab="serverdata"', 'data-panel="serverdata"', 'serverDataBody', 'orphan_candidate',
  'referenced_ancestor', 'scopeManagerStableHostInventory', 'scopeManagerDeleteBlockedReason',
  'scopeManagerOwnerProof', 'handleServerScopeManagementClick', 'managerReplaceScopeIndex',
  'managerListScopes', 'managerSetScopePinned', 'data-server-scope-detail', 'data-server-scope-delete',
  'data-server-scope-select', 'data-server-scope-delete-selected', 'data-server-scope-pair',
  'scopeManagerSetRecoveryPairing', 'scopeManagerClearRecoveryPairing', 'scopeManagerCreatePlans',
  'MEMORY_SUITE_SCOPED_REMOTE_KEY_MARKER', 'scopeManagerScopedRemoteKeyInfo',
  'scopeManagerRecordsForLogicalKey', 'source.info.scoped'
]) assert.ok(retrace.includes(marker), `RE:TRACE marker ${marker}`);
assert.ok(retrace.includes('자동 삭제하지 않'));
assert.ok(retrace.includes('로컬 원본을 보존하며 필요한 경우 플러그인 단독 모드로 전환'));
assert.ok(retrace.includes('scopeManagerRunDeletion'));
assert.ok(!retrace.includes('실제 삭제하려면 같은 버튼을 다시 누르세요.'));
assert.ok(retrace.includes("const scopeManagerMutationFor = (member, kind = 'remove'"), 'logical deletion defaults to a server tombstone');
assert.ok(retrace.includes('stable_host_chat_scope_match'), 'HAYAKU/RE:TRACE scopes must match the stable current-character chat inventory, not only the selected chat');
assert.ok(retrace.includes('currentChatPresent'), 'orphan classification requires a non-empty host chat list containing the selected chat');
assert.ok(retrace.includes('stable_chat_inventory_twice'), 'recovery pairing requires a twice-stable live RisuAI chat inventory');
assert.ok(retrace.includes('current_chat_exact_target'), 'recovery pairing applies only to the currently open target chat');
assert.ok(!retrace.includes("scanErrors.hayaku = '활성 HAYAKU owner 없음 · namespace 검사 생략'"), 'read-only HAYAKU server indexing must not require a live owner');
assert.ok(retrace.includes('scopeManagerPrefetchRecord(namespace, record)'), 'scope scans prefetch only scanner metadata');
assert.ok(retrace.includes('Number(scope?.referenceCount || 0) > 0'), 'any incoming reference blocks deletion even when the source chat is still active');
assert.ok(retrace.includes('liaPersonaRequestProofV1'), 'LIA proof store must participate in scoped rewrites');
assert.ok(retrace.includes('liaPersonaLinkerLivePersonaSyncV1'), 'LIA legacy live-binding store must participate in scoped rewrites');
assert.ok(retrace.includes("if (scope?.pinned === true) return '사용자가 보존 상태로 고정한 스코프입니다.'"));
assert.deepEqual((retrace.match(/const MEMORY_SUITE_SCOPE_NAMESPACES = Object\.freeze\(\[([^\]]+)\]\)/) || [])[1]?.replace(/\s+/g, ''), "'flashback','hayaku','libra','lia','retrace'", 'scope manager uses exactly the five active namespaces');
for (const forbidden of ['scopeManagerScanGradia', 'requestGradiaIpc', 'readGradiaSource', 'includeGradia', 'gradiaSessionHandoff', 'serial_gradation_agents_for_rp']) {
  assert.ok(!retrace.includes(forbidden), `retired GRADIA compatibility removed: ${forbidden}`);
}
for (const marker of [
  'scope-pin.v1', 'scope_delete_pinned_scope_blocked', 'scope_delete_referenced_ancestor',
  'scope_delete_plugin_only_mode_proof_required', 'scope_delete_shared_members_require_set_rewrite',
  'deleted-scope-backup.v1', 'manager-owner-gate.v1', 'scope-recovery-pairing.v1', 'paired_recovery'
]) assert.ok(server.includes(marker), `server marker ${marker}`);
assert.ok(sdk.includes('LIBRARIAN SYSTEM STORAGE SDK v' + JSON.parse(fs.readFileSync(path.join(root,'program-manifest.json'),'utf8')).storageSdkVersion));
assert.ok(sdk.includes('managerSetScopePinned'));
assert.ok(sdk.includes('prepareServerScopeDeletion'));

assert.ok(retrace.includes('const SERVER_SCOPE_MANAGER_PAGE_SIZE = 60;'), 'scope manager caps one DOM page at 60 cards');
assert.ok(retrace.includes('const pageScopes = orderedScopes.slice(pageStart, pageEnd);'), 'scope manager renders only the active page');
assert.ok(retrace.includes('data-server-scope-page="prev"') && retrace.includes('data-server-scope-page="next"'), 'scope manager exposes bounded pagination controls');
assert.ok(retrace.includes('content-visibility:auto;contain-intrinsic-size:240px'), 'scope cards skip offscreen layout and paint work');
assert.ok(retrace.includes('serverScopeManagerPage: 0'), 'scope pagination state is explicit and resets on refresh');
process.stdout.write('retrace_scope_manager_contract_test: PASS\n');
