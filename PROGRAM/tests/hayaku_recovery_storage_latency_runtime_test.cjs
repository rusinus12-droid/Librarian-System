'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createHayakuRuntime, createStore, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');
const { envelope } = require('./fixtures/shared_reanalysis_owner_fixture.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const prefix = 'hayaku.v2.recovery_vault.';
const summary = 'Alice opened the cedar chest and found a blue ribbon.';
const messages = () => [
  { role:'user', id:'u1', chatId:'u1', data:'Enter.' },
  { role:'assistant', id:'a1', chatId:'a1', data:hiddenPacketMessage('Alice entered.', createValidPacket({turn:1})) },
  { role:'user', id:'u2', chatId:'u2', data:'Open the chest.' },
  { role:'assistant', id:'a2', chatId:'a2', data:summary }
];

test('server-only repair waits for slow vault acknowledgements and exact readback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hayaku-vault-latency-'));
  const server = createMemorySuiteServer({host:'127.0.0.1', port:0, dataDir:dir, autoBackup:false});
  const address = await server.listen();
  const url = `http://127.0.0.1:${address.port}`;
  const delayedWrites = [];
  let delayedRead = false, runtime;
  try {
    runtime = await createHayakuRuntime({
      pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN,
      autoRepair:false, messages:messages(),
      arguments:{memory_suite_server_mode:'server_only', memory_suite_server_url:url},
      nativeFetch:async (target, init) => {
        const request = new URL(target);
        const response = await fetch(target, init);
        if (request.pathname === '/v1/kv/set') {
          const key = JSON.parse(init.body).key;
          if (key.startsWith(prefix)) {
            delayedWrites.push(key);
            // The server has committed; host/SDK acknowledgement is still pending.
            await pause(1700);
          }
        } else if (!delayedRead && delayedWrites.length && request.pathname === '/v1/kv/get'
            && request.searchParams.get('key')?.startsWith(prefix)) {
          delayedRead = true;
          await pause(1700);
        }
        return response;
      },
      llmResponder:async () => ({type:'success', result:JSON.stringify(envelope(summary))})
    });
    const scope = await runtime.hayaku._test.currentChatScope();
    const result = await runtime.hayaku._test.runNativeMissingTurnBatch({scopeKey:scope.key, targetTurns:[2]});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.packetCompleted, 1);
    assert.equal(runtime.llmCalls.length, 1, 'one model call after durable lease and evidence');
    assert.ok(delayedRead, 'exercise vault read latency too');
    assert.ok(delayedWrites.some(key => key.includes('::debt:')), 'real server shard write');
    assert.ok(delayedWrites.some(key => !key.includes('::debt:')), 'real server root publication');
    const ledger = await runtime.hayaku.ledger.inspect({includeRecords:true});
    assert.ok(ledger.records.some(row => row.recordState === 'active' && row.targetPairIndex === 2));
    await runtime.hayaku._test.runNativeMissingTurnBatch({scopeKey:scope.key, targetTurns:[2]});
    assert.equal(runtime.llmCalls.length, 1, 'repeat does not buy another generation');
  } finally {
    await runtime?.dispose();
    await server.close();
    fs.rmSync(dir, {recursive:true, force:true});
  }
});

test('an unacknowledged vault write stays bounded and never admits a model call', async () => {
  const store = createStore();
  const set = store.setItem.bind(store);
  store.setItem = async (key, value) => key.startsWith(prefix) ? new Promise(() => {}) : set(key, value);
  const runtime = await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN, pluginStorage:store, autoRepair:false, messages:messages()});
  try {
    const scope = await runtime.hayaku._test.currentChatScope();
    const result = await runtime.hayaku._test.runNativeMissingTurnBatch({scopeKey:scope.key, targetTurns:[2]});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'storage_write_timeout');
    assert.equal(result.stage, 'recovery_vault_write');
    assert.equal(runtime.llmCalls.length, 0);
    assert.equal(store.values.has(prefix + scope.key), false, 'unconfirmed graph is never published');
  } finally {
    await runtime.dispose();
  }
});

test('vault reads also allow the complete routed storage operation', async () => {
  const store = createStore(), get = store.getItem.bind(store);
  const scopeKey = 'latency-read';
  store.getItem = async key => {
    if (key === prefix + scopeKey) await pause(1700);
    return get(key);
  };
  const runtime = await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_TEST_PLUGIN, pluginStorage:store, autoRepair:false});
  try {
    await store.setItem(prefix + scopeKey, JSON.stringify(runtime.hayaku._test.emptyRecoveryVault(scopeKey)));
    const vault = await runtime.hayaku._test.loadRecoveryVault(scopeKey, {force:true});
    assert.equal(vault.scopeKey, scopeKey);
    assert.equal(runtime.llmCalls.length, 0);
  } finally {
    await runtime.dispose();
  }
});
