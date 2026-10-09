'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStore, createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const pluginStorage = createStore();
  const safeLocalStorage = createStore();
  await pluginStorage.setItem('memory_session_bridge:settings:v1', { primary: { key: 'retired-secret' } });
  await safeLocalStorage.setItem('memory_session_bridge:settings_local_backup:v1', { settings: { primary: { key: 'retired-backup' } } });
  await pluginStorage.setItem('unrelated:credential', 'must-survive');
  await safeLocalStorage.setItem('unrelated:local', 'must-survive');
  const runtime = await createHayakuRuntime({ autoRepair: false, loadRetrace: true, messages: [], pluginStorage, safeLocalStorage });
  try {
    assert.equal(runtime.retrace.version, releaseVersion('retrace'));
    const credentialPurge = await runtime.retrace._test.startLegacyProviderCredentialPurge();
    assert.equal(credentialPurge.ok, true, `credential purge failed: ${JSON.stringify(credentialPurge.failures || [])}`);
    const gate = await runtime.retrace._test.probeLiveHayakuOwner({ force: true, timeoutMs: 5000 });
    assert.equal(gate.ready, true, `HAYAKU owner gate failed: ${gate.reason || gate.error || ''}`);

    for (const removed of [
      'inspectColdStart', 'executeColdStart', 'reAdoptColdStart',
      'inspectIncrementalRecovery', 'executeIncrementalRecovery', 'reAdoptIncrementalRecovery',
      'runHayakuAutoRepairSweep', 'regenerateHayakuRecord',
      'loadSettings', 'saveSettings', 'listProviderModels', 'testProvider'
    ]) assert.equal(removed in runtime.retrace, false, `public API must be removed: ${removed}`);

    for (const removed of [
      'hayakuNativeRecoveryCapabilities', 'requestHayakuNativeRecoveryStatus',
      'hayakuNativeRepairSupported', 'hayakuNativeColdStartSupported',
      'delegateHayakuNativeRepair', 'delegateHayakuNativeColdStart',
      'analysisProgressSnapshot', 'analysisIsRunning', 'startBackgroundAnalysisTask',
      'callProfile', 'listProviderModels',
      'requestFlashbackIpc', 'requestHayakuIpc', 'requestLibraIpc', 'requestLiaIpc'
    ]) assert.equal(removed in runtime.retrace._test, false, `test API must be removed: ${removed}`);

    assert.equal(runtime.llmCalls.length, 0, 'loading/probing RE:TRACE never invokes a model');
    assert.equal(runtime.fetchCalls.length, 0, 'loading/probing RE:TRACE never invokes a provider fetch');
    assert.equal(await pluginStorage.getItem('memory_session_bridge:settings:v1'), null, 'exact retired pluginStorage credential key is purged');
    assert.equal(await safeLocalStorage.getItem('memory_session_bridge:settings_local_backup:v1'), null, 'exact retired local backup key is purged');
    assert.equal(await pluginStorage.getItem('unrelated:credential'), 'must-survive', 'unrelated pluginStorage data is preserved');
    assert.equal(await safeLocalStorage.getItem('unrelated:local'), 'must-survive', 'unrelated local data is preserved');

    const originalPluginSetItem = pluginStorage.setItem;
    const originalPluginRemoveItem = pluginStorage.removeItem;
    pluginStorage.setItem = undefined;
    pluginStorage.removeItem = undefined;
    const readOnlyAbsentPurge = await runtime.retrace._test.purgeLegacyProviderCredentials();
    pluginStorage.setItem = originalPluginSetItem;
    pluginStorage.removeItem = originalPluginRemoveItem;
    assert.equal(readOnlyAbsentPurge.pluginStorage, true, 'already-absent credential is verified without requiring a mutation API');

    const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'RETRACE.js'), 'utf8');
    for (const retired of [
      'data-tab="coldstart"', 'data-tab="provider"', 'delegateHayakuNativeRepair',
      'delegateHayakuNativeColdStart', 'native_repair_sweep', 'native_cold_start_start',
      'callProfile', 'DIRECT_PROVIDER_REGISTRY', 'regenerateHayakuRecord',
      'requestImmediateHayakuColdStartAdoption', 'requestImmediateHayakuIncrementalRecoveryAdoption',
      "'adopt_cold_start'", "'adopt_incremental_recovery'", "'sync_analysis_capsules'"
    ]) assert.equal(source.includes(retired), false, `retired analysis/provider implementation remains: ${retired}`);
    for (const retained of [
      'probeLiveHayakuOwner', 'adoptHayakuSessionHandoff', 'readHayakuSource',
      'readPendingColdStartCapsule', 'readPendingIncrementalRecoveryCapsule',
      'HAYAKU_IPC_ALLOWED_ACTIONS',
      'RETRACE_HAYAKU_IPC_ACTION_NOT_ALLOWED'
    ]) assert.equal(source.includes(retained), true, `required owner/legacy compatibility missing: ${retained}`);

    for (const removed of ['refreshHayaku', 'readHayakuViewerSource', 'backupHayakuLedger', 'deleteHayakuRecord']) {
      assert.equal(source.includes(removed), false, `retired standalone owner surface remains: ${removed}`);
    }

    const startupStart = source.lastIndexOf('await registerFlashbackIpc()');
    const startupEnd = source.indexOf('const unloadApi', startupStart);
    const startupSource = source.slice(startupStart, startupEnd);
    assert.equal(startupSource.includes('await purgeLegacyProviderCredentials'), false, 'credential purge never blocks core startup');
    assert.ok(
      source.lastIndexOf('startLegacyProviderCredentialPurge();') < startupStart,
      'credential purge starts before the first optional host registration await'
    );

    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'program-manifest.json'), 'utf8'));
    const ownership = manifest?.dataContract?.retraceHayakuNativeOwnerDeference || {};
    assert.equal(ownership.legacyCapsuleReadoptOnly, undefined, 'manifest removes stale RE:TRACE legacy readopt claim');
    assert.equal(ownership.legacyCapsulePassiveReadOnly, true, 'manifest declares passive legacy capsule reads');
    assert.equal(ownership.legacyCapsuleAdoptionOwner, 'hayaku', 'manifest assigns legacy capsule adoption only to HAYAKU');
    assert.equal(ownership.providerCredentialPurgeBounded, true, 'manifest declares bounded credential cleanup');
    assert.equal(ownership.providerCredentialPurgeBeforeOptionalRegistration, true, 'manifest declares cleanup independent from optional host registration');
    assert.equal(ownership.genericOwnerDispatchersExposed, false, 'manifest forbids production generic owner dispatchers');
    assert.equal(ownership.ownerIpcFixedActionAllowlists, true, 'manifest declares fixed owner IPC action allowlists');
    assert.equal(ownership.ownerIpcResponsesRequireAuthenticatedSender, true, 'manifest requires host-authenticated owner IPC responses');

    console.log('PASS retrace_hayaku_native_delegation_test (delegation surface removed)');
  } finally {
    await runtime.dispose();
  }

  const blockedUiPluginStorage = createStore();
  const blockedUiLocalStorage = createStore();
  await blockedUiPluginStorage.setItem('memory_session_bridge:settings:v1', { primary: { key: 'purge-before-ui' } });
  await blockedUiLocalStorage.setItem('memory_session_bridge:settings_local_backup:v1', { settings: { key: 'purge-before-ui' } });
  const blockedUiRuntime = await createHayakuRuntime({
    autoRepair: false,
    loadRetrace: true,
    messages: [],
    pluginStorage: blockedUiPluginStorage,
    safeLocalStorage: blockedUiLocalStorage,
    beforeRetraceLoad: host => {
      host.registerSetting = async () => await new Promise(() => {});
    }
  });
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await blockedUiPluginStorage.getItem('memory_session_bridge:settings:v1') == null
        && await blockedUiLocalStorage.getItem('memory_session_bridge:settings_local_backup:v1') == null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await blockedUiPluginStorage.getItem('memory_session_bridge:settings:v1'), null, 'automatic credential purge runs while UI registration is hung');
    assert.equal(await blockedUiLocalStorage.getItem('memory_session_bridge:settings_local_backup:v1'), null, 'automatic local credential purge runs while UI registration is hung');
  } finally {
    await blockedUiRuntime.dispose();
  }

  const stubbornPluginStorage = createStore();
  const stubbornLocalStorage = createStore();
  await stubbornPluginStorage.setItem('memory_session_bridge:settings:v1', { primary: { key: 'must-be-reported' } });
  await stubbornLocalStorage.setItem('memory_session_bridge:settings_local_backup:v1', { settings: { key: 'must-be-reported' } });
  stubbornPluginStorage.removeItem = async () => false;
  stubbornLocalStorage.removeItem = async () => false;
  const stubbornRuntime = await createHayakuRuntime({
    autoRepair: false,
    loadRetrace: true,
    messages: [],
    pluginStorage: stubbornPluginStorage,
    safeLocalStorage: stubbornLocalStorage
  });
  try {
    await stubbornRuntime.retrace._test.startLegacyProviderCredentialPurge();
    const failedPurge = await stubbornRuntime.retrace._test.purgeLegacyProviderCredentials();
    assert.equal(failedPurge.ok, false, 'credential purge fails closed when readback still contains credentials');
    assert.equal(failedPurge.pluginStorage, false, 'pluginStorage credential absence is not falsely claimed');
    assert.equal(failedPurge.verifiedAbsent, 0, 'local credential absence is not falsely claimed');
    assert.ok(failedPurge.failures.length >= 2, 'every unverified credential store is reported');
    assert.notEqual(await stubbornPluginStorage.getItem('memory_session_bridge:settings:v1'), null, 'failed pluginStorage removal remains detectable');
    assert.notEqual(await stubbornLocalStorage.getItem('memory_session_bridge:settings_local_backup:v1'), null, 'failed local removal remains detectable');

    stubbornRuntime.host.getLocalPluginStorage = async () => await new Promise(() => {});
    const boundedStartedAt = Date.now();
    const boundedPurge = await stubbornRuntime.retrace._test.purgeLegacyProviderCredentials();
    const boundedElapsedMs = Date.now() - boundedStartedAt;
    assert.ok(boundedElapsedMs < 2500, `hanging local storage discovery must be bounded, elapsed=${boundedElapsedMs}ms`);
    assert.ok(
      boundedPurge.failures.some(entry => entry.target === 'localStorageDiscovery' && entry.reason === 'LEGACY_PROVIDER_CREDENTIAL_PURGE_TIMEOUT'),
      'bounded purge reports local storage discovery timeout'
    );
  } finally {
    await stubbornRuntime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
