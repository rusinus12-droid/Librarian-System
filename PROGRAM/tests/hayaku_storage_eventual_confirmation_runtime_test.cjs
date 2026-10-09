'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() + 1 });

const createDelayedLedgerStore = (delayMs = 1700) => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      if (String(key).startsWith('hayaku.v2.ledger.')) await delay(delayMs);
      values.set(String(key), value);
      return true;
    },
    async removeItem(key) { values.delete(String(key)); return true; },
    async clear() { values.clear(); return true; },
    async key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
    async keys() { return Array.from(values.keys()); },
    async length() { return values.size; }
  };
};

const createReloadControlledLedgerStore = () => {
  const values = new Map();
  let firstLedgerWrite = true;
  let releaseFirstLedgerWrite = null;
  const firstLedgerGate = new Promise(resolve => { releaseFirstLedgerWrite = resolve; });
  return {
    values,
    releaseFirstLedgerWrite: () => releaseFirstLedgerWrite?.(),
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) {
      if (firstLedgerWrite && String(key).startsWith('hayaku.v2.ledger.')) {
        firstLedgerWrite = false;
        await firstLedgerGate;
      }
      values.set(String(key), value);
      return true;
    },
    async removeItem(key) { values.delete(String(key)); return true; },
    async clear() { values.clear(); return true; },
    async key(index) { return Array.from(values.keys())[Number(index)] ?? null; },
    async keys() { return Array.from(values.keys()); },
    async length() { return values.size; }
  };
};

(async () => {
  // Direct ledger write: a 1.7s host acknowledgement must be indeterminate at
  // the 1.5s live-path boundary, then become durable through exact readback.
  {
    const pluginStorage = createDelayedLedgerStore(1700);
    const runtime = await createHayakuRuntime({
      messages: [user('eventual-u1', 'Alice records the blue key.')],
      pluginStorage,
      autoRepair: false
    });
    try {
      const scope = await runtime.hayaku._test.currentChatScope();
      const ledger = runtime.hayaku._test.emptyStorageLedger(scope);
      const result = await runtime.hayaku._test.writeStorageLedgerDirect(scope, ledger, 'captured');
      assert.equal(result.durable, false);
      assert.equal(result.storageState, 'indeterminate');
      assert.equal(result.reason, 'storage_write_timeout');
      assert.ok(result._eventual && typeof result._eventual.then === 'function', 'indeterminate write exposes internal eventual confirmation promise');
      const eventual = await result._eventual;
      assert.equal(eventual.durable, true);
      assert.equal(eventual.state, 'confirmed');
      assert.equal(eventual.reason, 'storage_write_eventually_confirmed');
      assert.equal(runtime.llmCalls.length, 0, 'storage confirmation never re-invokes Other Ax');
      const physical = [...pluginStorage.values.entries()].find(([key]) => key.startsWith('hayaku.v2.ledger.'));
      assert.ok(physical, 'ledger is physically stored after late acknowledgement');
      const debug = runtime.hayaku.lastDebug();
      assert.ok(debug.storageWriteReconciliation.stats.confirmed >= 1, 'eventual confirmation is visible in diagnostics');
      assert.ok(runtime.hayaku._test.operationLogSnapshot().some(entry => entry.event === 'storage:eventually_confirmed'));
    } finally {
      await runtime.dispose();
    }
  }

  // chat_output_v3 capture: slow storage acknowledgement is not a packet-analysis
  // failure and must not create Recovery Journal debt or trigger an LLM repair.
  {
    const pluginStorage = createDelayedLedgerStore(1700);
    const userMessage = user('eventual-chat-u1', 'Mina closes the silver gate.');
    const runtime = await createHayakuRuntime({ messages: [userMessage], pluginStorage, autoRepair: false });
    try {
      const scope = await runtime.hayaku._test.currentChatScope();
      const snapshot = runtime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
      const base = runtime.hayaku._test.requestLineageFor(scope.chatMessages, snapshot, scope, { nodes: [] });
      const lineage = runtime.hayaku._test.issueRequestGenerationIdentity(scope, base);
      runtime.hayaku._test.registerPendingCapture(scope, lineage, 'model', snapshot);

      const packet = createValidPacket({
        turn: 1,
        subject: 'Mina',
        scene: 'silver-gate',
        summary: 'Mina closed the silver gate.'
      });
      packet.meta.lineage = {
        parent_turn_node_id: lineage.parentTurnNodeId || '',
        logical_turn_id: lineage.logicalTurnId,
        request_nonce: lineage.requestNonce,
        identity_version: lineage.identityVersion,
        lineage_schema: lineage.lineageSchema,
        turn_owner_key: lineage.turnOwnerKey,
        generation_attempt_id: lineage.generationAttemptId
      };
      const output = hiddenPacketMessage('Mina closed the silver gate.', packet);
      runtime.setMessages([userMessage, assistant('eventual-chat-a1', output)]);

      const capture = await runtime.hayaku._test.processRisuChatOutputEvent({
        char: runtime.character,
        chat: runtime.chat,
        characterIndex: 0,
        chatIndex: 0,
        messageIndex: 1
      });
      assert.equal(capture.ok, true);
      assert.equal(capture.recoveryOnly, 0, 'slow acknowledgement does not create recovery-only debt');
      assert.equal(runtime.llmCalls.length, 0, 'slow storage path does not call Other Ax');
      const recoveryKeys = [...pluginStorage.values.keys()].filter(key => key.startsWith('hayaku.v2.recovery_vault.'));
      assert.deepEqual(recoveryKeys, [], 'no Recovery Journal entry is created for storage acknowledgement latency');
      const last = runtime.hayaku.lastDebug().lastStorageCapture;
      assert.equal(last.storageState, 'indeterminate');
      assert.equal(last.storageReconciliationPending, true);
      assert.equal(last.recoveryVaultReason, 'storage_acknowledgement_indeterminate');

      // Let the original fenced setItem finish; exact storage readback should be
      // enough for eventual confirmation without a second model call.
      await delay(600);
      assert.equal(runtime.llmCalls.length, 0);
      assert.ok(runtime.hayaku._test.operationLogSnapshot().some(entry => entry.event === 'storage:eventually_confirmed'));
    } finally {
      await runtime.dispose();
    }
  }

  // Reload boundary: the exact pending write metadata is durable before the
  // original slow ledger write settles. A fresh runtime can later confirm the
  // physical ledger and retire the journal without invoking Other Ax.
  {
    const pluginStorage = createReloadControlledLedgerStore();
    const runtime1 = await createHayakuRuntime({
      messages: [user('reload-u1', 'Juno seals the archive door.')],
      pluginStorage,
      autoRepair: false
    });
    let serializedHash = '';
    try {
      const scope = await runtime1.hayaku._test.currentChatScope();
      const ledger = runtime1.hayaku._test.emptyStorageLedger(scope);
      const result = await runtime1.hayaku._test.writeStorageLedgerDirect(scope, ledger, 'captured');
      assert.equal(result.storageState, 'indeterminate');
      serializedHash = String(result.reconciliationId || '').split(':').at(-1) || '';
      for (let attempt = 0; attempt < 50 && !pluginStorage.values.has('hayaku.v2.storage_reconciliation_journal'); attempt += 1) await delay(20);
      const journalRaw = pluginStorage.values.get('hayaku.v2.storage_reconciliation_journal');
      assert.ok(journalRaw, 'indeterminate write metadata is durably journaled before reload');
      const journal = JSON.parse(journalRaw);
      assert.equal(journal.schema, 'hayaku.storage_reconciliation_journal.v1');
      assert.equal(journal.entries.length, 1);
      assert.equal(journal.entries[0].scopeKey, scope.key);
      assert.equal(journal.entries[0].serializedHash, serializedHash);
      assert.equal(runtime1.llmCalls.length, 0);
    } finally {
      await runtime1.dispose();
    }

    const runtime2 = await createHayakuRuntime({
      messages: [user('reload-u1', 'Juno seals the archive door.')],
      pluginStorage,
      autoRepair: false
    });
    try {
      const scope2 = await runtime2.hayaku._test.currentChatScope();
      const before = await runtime2.hayaku._test.recoverStorageReconciliationJournal({ scopeKey: scope2.key, force: true });
      assert.equal(before.recovered, 0);
      assert.equal(before.pending, 1, 'fresh runtime preserves unresolved durable journal state');
      pluginStorage.releaseFirstLedgerWrite();
      for (let attempt = 0; attempt < 100 && ![...pluginStorage.values.keys()].some(key => key.startsWith('hayaku.v2.ledger.')); attempt += 1) await delay(20);
      const after = await runtime2.hayaku._test.recoverStorageReconciliationJournal({ scopeKey: scope2.key, force: true });
      assert.equal(after.recovered, 1, 'fresh runtime confirms the late physical ledger');
      const finalJournal = JSON.parse(pluginStorage.values.get('hayaku.v2.storage_reconciliation_journal'));
      assert.deepEqual(finalJournal.entries, [], 'confirmed reload reconciliation retires the durable journal entry');
      assert.equal(runtime2.llmCalls.length, 0, 'reload reconciliation never calls Other Ax');
      assert.ok(runtime2.hayaku._test.operationLogSnapshot().some(entry => entry.event === 'storage:journal_recovered'));
    } finally {
      await runtime2.dispose();
    }
  }

  process.stdout.write('hayaku_storage_eventual_confirmation_runtime_test: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
