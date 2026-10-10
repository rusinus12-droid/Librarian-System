'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
const cases = [
  ['Flashback_Memory.js', releaseVersion('flashback'), 'flashback'],
  ['HAYAKU_Locator_Continuity.js', releaseVersion('hayaku'), 'hayaku'],
  ['LIBRA.js', releaseVersion('libra'), 'libra'],
  ['LIA_Persona_Linker.js', releaseVersion('lia'), 'lia'],
  ['RETRACE.js', releaseVersion('retrace'), 'retrace']
];

for (const [name, version, namespaceMarker] of cases) {
  const text = read(name);
  const versionMarkerIndex = text.indexOf('//@version ');
  const versionByteOffset = versionMarkerIndex < 0
    ? Number.POSITIVE_INFINITY
    : Buffer.byteLength(text.slice(0, versionMarkerIndex), 'utf8');
  assert.ok(versionByteOffset < 512,
    `${name} version declaration must be within the first 512 bytes (offset=${versionByteOffset})`);
  assert.match(text, new RegExp(`^//@version ${version.replace(/\./g, '\\.')}\\s*$`, 'm'), `${name} version`);
  assert.ok(text.includes(`PLUGIN_VERSION = '${version}'`) || text.includes(`PLUGIN_VERSION = "${version}"`), `${name} internal version`);
  assert.equal((text.match(releasePattern("LIBRARIAN SYSTEM STORAGE SDK v{storage}", "g")) || []).length, 1, `${name} canonical SDK count`);
  if (name === 'RETRACE.js') {
    assert.equal((text.match(/^\/\/@arg memory_suite_server_mode /gm) || []).length, 0, releaseText('RE:TRACE {retrace} has no own storage-mode arg'));
    assert.ok(text.includes('participation-aware and read-only'), releaseText('RE:TRACE {retrace} uses the dynamic read-only owner gate'));
  } else if (name === 'LIA_Persona_Linker.js') {
    assert.equal((text.match(/^\/\/@arg memory_suite_server_mode /gm) || []).length, 0, 'LIA has no active server-mode argument');
    assert.ok(/storagePolicy\s*:\s*['"]local_only['"]/.test(text), 'LIA uses its explicit local-only policy');
  } else {
    assert.equal((text.match(/^\/\/@arg memory_suite_server_mode /gm) || []).length, 1, `${name} server mode arg`);
  }
  assert.ok(text.includes('deletePluginStorageAfterServerVerification'), `${name} guarded pluginStorage delete`);
  assert.ok(text.includes('restorePluginStorage'), `${name} server-to-pluginStorage recovery`);
  assert.equal((text.match(/^\/\/@arg memory_suite_server_url /gm) || []).length, 1, `${name} server URL arg`);
  assert.equal((text.match(/^\/\/@arg memory_suite_bootstrap_key /gm) || []).length, 0, `${name} has no manual bootstrap key arg`);
  assert.equal((text.match(/^\/\/@arg .*compute.*(?:token|pairing|secret|key)/gmi) || []).length, 0, `${name} has no manual Compute credential arg`);
  assert.ok(!text.includes('data-mscx-key'), `${name} has no manual bootstrap key input`);
  if (!['RETRACE.js', 'LIA_Persona_Linker.js'].includes(name)) {
    assert.equal((text.match(/^\/\/@arg memory_suite_.*_compute_mode /gm) || []).length, 0, `${name} has no independent Compute mode selector`);
    assert.ok(text.includes('getScopeExecutionPolicy'), `${name} derives Compute from the scoped Storage mode`);
    assert.ok(text.includes('computeBridge:'), `${name} mounts Compute inside the Storage panel`);
    assert.ok(text.includes('/v1/compute/bootstrap'), `${name} performs automatic compute-only bootstrap`);
    assert.ok(!text.includes('X-Memory-Suite-Compute-Pairing'), `${name} never sends a pairing header`);
  }
  assert.ok(text.includes('mountConnectionPanel'), `${name} server connection panel SDK`);
  assert.ok(text.includes('연결 테스트'), `${name} server connection test label`);
  assert.match(text, new RegExp(`namespace\\s*:\\s*['\"]${namespaceMarker}['\"]`), `${name} namespace`);
  assert.ok(text.includes('currentScopeProvider:'), `${name} current scope provider`);
  assert.ok(text.includes('resolveKeyScope:'), `${name} key-to-scope mapper`);
  assert.ok(text.includes('SCOPE_ROUTING_LOCAL_KEY'), `${name} local routing registry`);
  assert.ok(text.includes('SCOPE_ROUTING_SERVER_KEY'), `${name} server routing registry`);
  assert.ok(text.includes('getDiagnostics'), `${name} server diagnostics client`);
  assert.ok(text.includes('memorySuite'), `${name} debug export includes Librarian System diagnostics`);
  assert.ok(text.includes('SCOPED_REMOTE_KEY_MARKER'), `${name} scoped remote key contract`);
  assert.ok(text.includes('MEMORY_SUITE_SERVER_URL_IN_USE'), `${name} global URL split guard`);
  assert.ok(text.includes('새 스코프의 기본값은 플러그인 단독'), `${name} new-scope default UI`);
  assert.ok(text.includes('MemorySuiteStorageBridge.dispose?.()'), `${name} unload disposes its storage bridge`);
  assert.ok(text.includes('requireRestoreValidation:true') || text.includes('requireRestoreValidation: true'), `${name} owner restore validator is fail-closed`);
  assert.ok(text.includes('resolveRestoreDependencies:'), `${name} explicitly resolves current-scope dependencies`);
  assert.ok(text.includes('validateRestore:'), `${name} validates restored owner semantics`);
}

const flashback = read('Flashback_Memory.js');
assert.ok(flashback.includes('const MEMORY_BRIDGE_IPC_MAX_RETRIES = 24;'), 'Flashback delayed IPC registration is bounded');
assert.ok(flashback.includes("pluginPrefixes: [`${PLUGIN_STORAGE_ID}:`]"));
assert.ok(flashback.includes("localPrefixes: [`${PLUGIN_STORAGE_ID}:`]"));
assert.match(flashback, /excludedContains:\s*\['embedding_secret'\s*,\s*'embedding-key'\s*,\s*'embedding_key'\]/);
assert.ok(flashback.includes('MemorySuiteStorageBridge.createPluginStorageProxy'));
assert.ok(flashback.includes('MemorySuiteStorageBridge.createLocalStorageProxy'));
assert.ok(flashback.includes("if (key === STORAGE.settings) return { kind: 'global' };"), 'Flashback UI/settings remain local and available when the server is offline');

const hayaku = read('HAYAKU_Locator_Continuity.js');
assert.ok(hayaku.includes('const MEMORY_BRIDGE_IPC_MAX_RETRIES = 24;'), 'HAYAKU delayed IPC registration is bounded');
assert.ok(hayaku.includes('attempt === 0 || attempt % 6 === 0'), 'HAYAKU host refresh is sampled instead of repeated on every retry');
assert.ok(hayaku.includes('STORAGE_LEDGER_KEY_PREFIX,'));
assert.ok(hayaku.includes('HAYAKU_ARCHIVE_KEY_PREFIX,'));
assert.ok(hayaku.includes('HAYAKU_ARCHIVE_META_KEY_PREFIX'));
assert.ok(hayaku.includes('Live-chat packets and pluginStorage coexist as a dual continuity ledger'));
assert.ok(hayaku.includes("const HAYAKU_RETRACE_COMPATIBILITY_BEACON_KEY = 'hayaku.v2.retrace_compatibility.v1'"));
const hayakuBridgeConfig = hayaku.slice(hayaku.indexOf("namespace: 'hayaku'"), hayaku.indexOf('const RisuCompat = (() =>'));
assert.ok(!hayakuBridgeConfig.includes('MEMORY_SESSION_BRIDGE_COLD_START_PREFIX'));
assert.ok(!hayakuBridgeConfig.includes('HAYAKU_RETRACE_COMPATIBILITY_BEACON_KEY'));
assert.ok(hayaku.includes("return { kind: 'global' };"), 'HAYAKU non-ledger UI/config data remains global/local');
assert.ok(hayaku.includes('memorySuiteHayakuValidatePhysicalArchive'), 'HAYAKU restore validates physical archive rows instead of hydrated runtime cache');
assert.ok(hayaku.includes("context.readback('plugin', cursor.storageKey)"), 'HAYAKU archive validation performs physical readback');

const libra = read('LIBRA.js');
assert.ok(libra.includes('const RETRACE_IPC_MAX_RETRIES = 24;'), 'LIBRA delayed IPC registration is bounded');
assert.ok(libra.includes('const MemorySuiteConfigStorageBridge = createMemorySuiteStorageBridge'));
assert.ok(libra.includes('STORAGE_PROVIDER_PRESETS_KEY'));
assert.match(libra, /pluginPrefixes\s*:\s*\['libra:v1:'\]/);
assert.match(libra, /localPrefixes\s*:\s*\['libra:v1:local-vector:'\]/);
assert.ok(libra.includes('const legacyPluginStorage = Object.freeze'));
assert.ok(libra.includes('const pluginStorage = MemorySuiteStorageBridge.createPluginStorageProxy(legacyPluginStorage)'));
assert.ok(libra.includes('MemorySuiteConfigStorageBridge.createPluginStorageProxy'));
assert.ok(libra.includes('scopeRouting:false'), 'LIBRA provider/runtime configuration is outside chat-scope routing');
assert.match(libra, /excludedContains:\s*\['provider-secrets'\s*,\s*'provider-config-secrets'\s*,\s*'backend-hosting-token'\s*,\s*'credential'\]/);
assert.ok(!libra.includes('libra.source_evidence_validation.v4'), 'retired natural-language evidence validator must stay removed');
assert.ok(!libra.includes('semantic_numeric_and_normalized_phrase_v2'), 'retired validator semantic profile must stay removed');
assert.ok(libra.includes("RECALL_CATALOG_BUILD_VERSION = 'validator_free_cjk_v3'"), 'CJK-aware validator-free recall catalog remains active');
assert.ok(libra.includes("PENDING_LIVE_BOUNDARY_ENTRY_SCHEMA = 'libra.pending_live_boundary.v1'"), 'crash-safe pending five-turn boundary marker remains active');
assert.ok(libra.includes('libra_restore_manifest_memory_dependency_missing'), 'LIBRA validates every manifest memory reference');
assert.ok(libra.includes('libra_restore_memory_digest_mismatch'), 'LIBRA validates canonical memory identity and digest');

const lia = read('LIA_Persona_Linker.js');
assert.ok(lia.includes('disposeRegistrationHandle(registeredUnloadRegistration)'), 'LIA removes its unload registration during hot reload');
for (const key of [
  'dynamicPersonaLorebookGeneratorResultVault',
  'liaPersonaLinkerWorldBlueprintVaultV1',
  'liaPersonaLinkerLivePersonaIndexV2',
  'liaPersonaVisualAssetStoreV1',
  'liaPersonaVisualAssetPresetStoreV1'
]) assert.ok(lia.includes(key), `LIA routed key ${key}`);
assert.match(lia, /pluginPrefixes:\s*\[LIVE_PERSONA_SCOPE_STORAGE_PREFIX\s*,\s*PERSONA_VISUAL_ASSET_BACKUP_PREFIX\]/);
assert.ok(lia.includes('liaPersonaIllustrationConfigV1'));
assert.ok(lia.includes('await api.setDatabase({ personas: nextPersonas });'), 'actual RisuAI Persona DB mutation must remain local');
assert.ok(!lia.slice(lia.indexOf("namespace: 'lia'"), lia.indexOf('async function waitForPluginStorage')).includes('personas'), 'RisuAI Persona objects must not be routed as server KV');
assert.ok(lia.includes("if (key === LLM_CONFIG_STORAGE_KEY || key === LOG_STORAGE_KEY) return { kind: 'global' };"), 'LIA connection/UI config remains local');
assert.ok(lia.includes('scopedContainer: true'), 'LIA index/proof containers are projected per scope');
assert.ok(lia.includes("error.code = 'LIA_STORAGE_JSON_INVALID'"), 'LIA bridge rejects malformed storage JSON instead of normalizing to an empty object');


const retrace = read('RETRACE.js');
assert.ok(retrace.includes('unregisterRetraceIpcListeners'), 'RE:TRACE removes tracked peer IPC listeners');
assert.ok(retrace.includes('Object.values(MemorySuitePeerServerBridges)'), 'RE:TRACE disposes peer storage bridges');
assert.match(retrace, /namespace\s*:\s*['"]retrace['"]/, 'RE:TRACE legacy namespace and manager identity');
assert.ok(retrace.includes('MemorySuitePeerServerBridges'), 'RE:TRACE must read peer server namespaces');
assert.ok(retrace.includes('inspectMemorySuitePeerServerData'), 'RE:TRACE must surface server-side peer data');
assert.ok(retrace.includes("memorySuiteStorageReceiptMatches"), 'RE:TRACE must validate server synchronization proof');
assert.ok(retrace.includes("COLD_START_PREFIX"), 'RE:TRACE cold-start state remains routed');
assert.ok(retrace.includes("HAYAKU_BACKUP_PREFIX"), 'RE:TRACE backup state remains routed');
assert.match(retrace, /excludedKeys:\s*\[LEGACY_PROVIDER_SETTINGS_KEY\s*,\s*LEGACY_PROVIDER_SETTINGS_LOCAL_BACKUP_KEY\]/, 'retired RE:TRACE provider keys remain permanently excluded from server transport');
assert.ok(retrace.includes('purgeLegacyProviderCredentials'), 'RE:TRACE purges only its exact retired provider credential keys');
for (const owner of ['FLASHBACK', 'HAYAKU', 'LIBRA', 'LIA']) {
  assert.ok(retrace.includes(`const ${owner}_IPC_ALLOWED_ACTIONS = new Set([`), `${owner} IPC uses a fixed action allowlist`);
}
const exportedTestApi = retrace.slice(retrace.indexOf('_test: {'), retrace.indexOf('globalThis.__RETRACE'));
for (const dispatcher of ['requestFlashbackIpc', 'requestHayakuIpc', 'requestLibraIpc', 'requestLiaIpc']) {
  assert.equal(exportedTestApi.includes(dispatcher), false, `production _test does not expose generic owner dispatcher: ${dispatcher}`);
}
for (const removed of [
  'readHayakuViewerSource', 'deleteHayakuRecord', 'backupHayakuLedger', 'listHayakuLedgerBackups',
  'data-tab="coldstart"', 'data-tab="provider"', 'callProfile', 'loadSettings', 'saveSettings',
  'DIRECT_PROVIDER_REGISTRY', 'inspectColdStart', 'executeColdStart', 'inspectIncrementalRecovery',
  'executeIncrementalRecovery', 'regenerateHayakuRecord', 'hayaku-regenerate-record',
  'delegateHayakuNativeRepair', 'delegateHayakuNativeColdStart', 'native_repair_sweep',
  'native_cold_start_start', 'analysisProgressSnapshot', 'runHayakuAutoRepairSweep',
  'requestImmediateHayakuColdStartAdoption', 'requestImmediateHayakuIncrementalRecoveryAdoption',
  "'adopt_cold_start'", "'adopt_incremental_recovery'", "'sync_analysis_capsules'"
]) assert.equal(retrace.includes(removed), false, `retired RE:TRACE analysis/provider surface must stay removed: ${removed}`);
for (const retained of [
  'probeLiveHayakuOwner', 'adoptHayakuSessionHandoff', 'readHayakuSource',
  'readPendingColdStartCapsule', 'readPendingIncrementalRecoveryCapsule',
  'verifyDurableHayakuIncrementalRecovery'
]) assert.ok(retrace.includes(retained), `RE:TRACE retained owner/handoff/legacy compatibility surface: ${retained}`);
assert.ok(retrace.includes("serverDataDetected"), 'RE:TRACE transition preview must record server data presence');
assert.ok(retrace.includes('data-tab="serverdata"'), 'RE:TRACE server data management tab');
assert.ok(retrace.includes('orphan_candidate'), 'RE:TRACE orphan candidate classification');
assert.ok(retrace.includes('referenced_ancestor'), 'RE:TRACE ancestor protection');
assert.ok(retrace.includes('handleServerScopeManagementClick'), 'RE:TRACE guarded scope deletion UI');
assert.ok(retrace.includes('scopeManagerOwnerProof'), 'RE:TRACE owner pluginStorage preservation proof');
assert.ok(retrace.includes('scopeManagerStableHostInventory'), 'RE:TRACE stable host inventory proof');
assert.ok(retrace.includes('scopeManagerScopedRemoteKeyInfo'), 'RE:TRACE understands 0.2.8 scope-suffixed records');
assert.ok(retrace.includes("scopeManagerMutationFor(member, 'remove')"), 'RE:TRACE deletion tombstones prevent stale resurrection');
assert.ok(retrace.includes('retrace.hayakuBackupCatalog.entry'), 'RE:TRACE expands backup catalog targets as explicit restore dependencies');
assert.ok(retrace.includes('retrace_restore_backup_checksum_invalid'), 'RE:TRACE validates backup ledger checksums');
assert.ok(retrace.includes('retrace_restore_catalog_target_identity_invalid'), 'RE:TRACE validates catalog target identity and checksum');
assert.ok(retrace.includes('memorySuiteOwnerStorageGateFromRows'), 'RE:TRACE derives a participant-aware storage gate');
assert.ok(retrace.includes('handoffStoragePolicyFromGate'), 'RE:TRACE snapshots participant identity for handoff');
assert.ok(retrace.includes('미설치·비활성으로 확인된 owner만 제외됩니다.'), 'RE:TRACE UI states only confirmed absent or disabled peers are excluded');
assert.ok(!retrace.includes('//@arg memory_suite_server_mode string'), 'RE:TRACE does not expose its own storage-mode selector');

assert.ok(flashback.includes('data-tab="server"'), 'Flashback server side tab');
assert.match(flashback, /class="nav-tabs"[^>]*role="tablist"[^>]*aria-label="Flashback 설정"/, 'Flashback exposes an accessible tablist');
for (const tab of ['overview', 'import', 'storage', 'provider', 'server', 'activity', 'advanced']) {
  assert.ok(flashback.includes(`id="tab-${tab}"`), `Flashback ${tab} tab has a stable id`);
  assert.ok(flashback.includes(`aria-controls="panel-${tab}"`), `Flashback ${tab} tab points to its panel`);
  assert.ok(flashback.includes(`id="panel-${tab}"`), `Flashback ${tab} panel has a stable id`);
  assert.ok(flashback.includes(`aria-labelledby="tab-${tab}"`), `Flashback ${tab} panel points back to its tab`);
}
assert.ok(flashback.includes("btn.setAttribute?.('aria-selected', isActive ? 'true' : 'false')"), 'Flashback synchronizes tab selection semantics');
assert.ok(flashback.includes("panel.setAttribute?.('aria-hidden', isActive ? 'false' : 'true')"), 'Flashback synchronizes panel visibility semantics');
assert.ok(flashback.includes("['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']"), 'Flashback supports keyboard tab navigation');
assert.ok(flashback.includes("box.setAttribute('role', 'dialog')"), 'Flashback custom dialogs expose dialog semantics');
assert.ok(flashback.includes("doc.addEventListener('keydown', onKey);"), 'Flashback dialog key handling remains active until cleanup');
assert.ok(!flashback.includes("doc.addEventListener('keydown', onKey, { once: true });"), 'Flashback dialog Escape handling is not consumed by the first unrelated key');
assert.ok(flashback.includes("previousFocus.isConnected !== false"), 'Flashback restores focus after dialog close');
assert.ok(hayaku.includes('data-hayaku-viewer-tab="server"'), 'HAYAKU server side tab');
assert.ok(libra.includes("Object.freeze({ id: 'ai', label: 'AI 연결'"), 'LIBRA registers AI Connections in the shared sidebar registry');
assert.ok(libra.includes("{ id: 'server', label: '서버 · 저장' }"), 'LIBRA registers Server and Storage inside the Settings hub');
require('./fixtures/current_ui_compute_contracts.cjs').checkNavigation(libra);
assert.ok(!lia.includes('["server", "저장·서버"]'), 'LIA active server settings route is retired');
assert.match(lia, /storagePolicy\s*:\s*['"]local_only['"]/, 'LIA keeps local-only storage and explicit legacy recovery');
assert.ok(retrace.includes('data-tab="serverconnection"'), 'RE:TRACE server connection side tab');

// Debug-export integration must be outside the shared SDK itself, in each plugin's real export path.
const flashbackDebugSlice = flashback.slice(flashback.indexOf('const exportDebugLogPayload = async'), flashback.indexOf('const exportDebugLogFile = async'));
assert.ok(flashbackDebugSlice.includes('MemorySuiteStorageBridge.getDiagnostics'), 'Flashback debug export fetches server diagnostics');
assert.ok(flashbackDebugSlice.includes('memorySuite'), 'Flashback debug export payload contains memorySuite');

const hayakuDebugSlice = hayaku.slice(hayaku.indexOf('const composeHayakuOperationDebugExport'), hayaku.indexOf('const showHayakuOperationDebugFallback'));
assert.ok(hayakuDebugSlice.includes('memorySuite = MemorySuiteStorageBridge.getCachedDiagnostics()'), 'HAYAKU debug compose includes cached diagnostics');
assert.ok(hayakuDebugSlice.includes('MemorySuiteStorageBridge.getDiagnostics'), 'HAYAKU async export refreshes diagnostics');

const libraRuntimeSlice = libra.slice(libra.indexOf('const runtimeForDisplay = () =>'), libra.indexOf('const buildDebugTab ='));
assert.ok(libraRuntimeSlice.includes('memorySuite: MemorySuiteStorageBridge.getCachedDiagnostics()'), 'LIBRA runtime debug payload contains memorySuite');
const libraDebugTabSlice = libra.slice(libra.indexOf('const buildDebugTab ='), libra.indexOf('const buildSettingsBody ='));
assert.ok(libraDebugTabSlice.includes('MemorySuiteStorageBridge.refreshDiagnostics'), 'LIBRA export refreshes server diagnostics before download/copy');


const liaSnapshotSlice = lia.slice(lia.indexOf('async function buildDebugExportSnapshot()'), lia.indexOf('async function refreshDebugExportSnapshot()'));
assert.ok(liaSnapshotSlice.includes('MemorySuiteStorageBridge.getDiagnostics'), 'LIA debug snapshot uses the local-policy diagnostics client');
const liaSyncPayloadSlice = lia.slice(lia.indexOf('function buildDebugExportPayloadSync()'), lia.indexOf('function debugPayloadTextSync()'));
assert.ok(liaSyncPayloadSlice.includes('memorySuite:'), 'LIA gesture-safe sync export contains cached server diagnostics');

const retraceDebugSlice = retrace.slice(retrace.indexOf('const buildRetraceDebugExport = async'), retrace.indexOf('const exportRetraceDebugLog = async'));
assert.ok(retraceDebugSlice.includes('MemorySuiteStorageBridge.managerGetDiagnostics'), 'RE:TRACE debug export fetches suite-wide manager diagnostics');
assert.ok(retraceDebugSlice.includes('memorySuite,'), 'RE:TRACE debug export payload contains memorySuite');

process.stdout.write('plugin_patch_contract_test: PASS\n');

