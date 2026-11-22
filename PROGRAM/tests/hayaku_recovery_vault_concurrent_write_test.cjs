'use strict';

const assert = require('node:assert/strict');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

(async () => {
  const store = createStore();
  const baseGet = store.getItem.bind(store);
  const baseSet = store.setItem.bind(store);
  store.getItem = async (key) => {
    if (String(key).startsWith('hayaku.v2.recovery_vault.')) {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return baseGet(key);
  };
  store.setItem = async (key, value) => {
    if (String(key).startsWith('hayaku.v2.recovery_vault.')) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return baseSet(key, value);
  };

  let runtime;
  try {
    runtime = await createHayakuRuntime({
      pluginStorage: store,
      autoRepair: false,
      messages: [
        { role: 'user', id: 'u1', data: 'Enter.' },
        { role: 'assistant', id: 'a1', data: hiddenPacketMessage('Alice enters.', createValidPacket()) },
        { role: 'user', id: 'u2', data: 'Open.' },
        { role: 'assistant', id: 'a2', data: 'The door opens and a blue bird flies out.' }
      ]
    });

    const scope = await runtime.hayaku._test.currentChatScope();
    assert.ok(scope?.key, 'scope key should exist');

    const recordA = {
      scopeKey: scope.key,
      recordId: `${scope.key}:2:a`,
      pairIndex: 2,
      worldlineOrdinal: 2,
      status: 'deterministic_fallback',
      worldlineStatus: 'active',
      user: { text: 'Open.' },
      assistant: { text: 'The door opens and a blue bird flies out.' }
    };
    const recordB = {
      ...recordA,
      recordId: `${scope.key}:2:b`,
      updatedAt: Date.now() + 10
    };

    const [resA, resB] = await Promise.all([
      runtime.hayaku._test.writeRecoveryVaultDirect(scope.key, { scopeKey: scope.key, records: [recordA] }, 'concurrent_a'),
      runtime.hayaku._test.writeRecoveryVaultDirect(scope.key, { scopeKey: scope.key, records: [recordB] }, 'concurrent_b')
    ]);

    assert.equal(resA.durable, true, 'first concurrent write should succeed durably without readback mismatch');
    assert.equal(resB.durable, true, 'second concurrent write should succeed durably without readback mismatch');
    assert.equal(resA.saved, true);
    assert.equal(resB.saved, true);

    console.log('hayaku_recovery_vault_concurrent_write_test: PASS');
  } finally {
    await runtime?.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
