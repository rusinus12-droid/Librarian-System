'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, waitFor } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const runtime = await createHayakuRuntime({ autoRepair: false, messages: [] });
  try {
    const requestChannel = 'hayaku_memory_bridge_request_v1';
    const responseChannel = 'hayaku_memory_bridge_response_v1';
    await waitFor(() => (runtime.host.listeners.get(requestChannel)?.size || 0) > 0, 'HAYAKU owner IPC listener');
    const responses = new Map();
    await runtime.host.addPluginChannelListener(responseChannel, message => {
      if (message?.requestId) responses.set(message.requestId, message);
    });
    let ordinal = 0;
    const request = async (action, payload = {}) => {
      const requestId = `owner-boundary-${++ordinal}`;
      await runtime.host.postPluginChannelMessage('hayaku_locator_continuity', requestChannel, {
        schema: 'hayaku-memory-bridge-ipc-v1',
        kind: 'request',
        requestId,
        action,
        payload
      });
      return await waitFor(() => responses.get(requestId), `HAYAKU IPC response ${action}`);
    };

    const capabilities = await request('capabilities');
    assert.equal(capabilities.ok, true);
    assert.equal(capabilities.result?.ipcCapabilities?.repairOwner, 'hayaku');
    assert.equal(capabilities.result?.ipcCapabilities?.recoveryMutationIpc, false);
    assert.equal(capabilities.result?.ipcCapabilities?.recoveryDebtLeaseIpc, false);
    assert.equal(capabilities.result?.ipcCapabilities?.legacyCapsuleAdoptionIpc, false);
    for (const retiredCapability of [
      'inspectRecoveryDebts', 'acquireRecoveryDebtLease', 'releaseRecoveryDebtLease',
      'nativeRepairSweep', 'nativeColdStartStart', 'nativeColdStartCancel',
      'recoveryDebtEventChannel'
    ]) assert.equal(retiredCapability in capabilities.result.ipcCapabilities, false, `retired capability remains: ${retiredCapability}`);

    for (const action of [
      'inspect_recovery_debts', 'acquire_recovery_debt_lease', 'release_recovery_debt_lease',
      'native_recovery_status', 'native_repair_sweep', 'native_cold_start_start',
      'native_cold_start_cancel', 'adopt_cold_start', 'adopt_incremental_recovery',
      'sync_analysis_capsules', 'memory_suite_set_mode'
    ]) {
      const response = await request(action, { force: true, includeEvidence: true });
      assert.equal(response.ok, false, `retired action must be rejected: ${action}`);
      assert.match(String(response.error || ''), /unsupported_hayaku_bridge_ipc_action/);
    }
    assert.equal(runtime.llmCalls.length, 0, 'retired owner IPC actions must not start Other Ax');
    assert.equal(runtime.fetchCalls.length, 0, 'retired owner IPC actions must not start provider fetch');

    const inspect = await request('inspect', { includeRecords: true });
    assert.equal(inspect.ok, true);
    assert.equal('bridgeSync' in (inspect.result || {}), false, 'read-only inspect must not expose mutation sync state');

    console.log('PASS hayaku_recovery_ipc_owner_boundary_test');
  } finally {
    await runtime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
