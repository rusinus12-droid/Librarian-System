'use strict';

const assert = require('node:assert/strict');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() + 1 });

const waitForActiveBinding = async (runtime, timeoutMs = 12000) => {
  const started = Date.now();
  let ledger = null;
  while (Date.now() - started < timeoutMs) {
    ledger = await runtime.hayaku.ledger.inspect();
    if (ledger.records.some(record => record.recordState === 'active' && record.ownerTurnNodeId)
      && ledger.worldline.nodes.some(node => node.status === 'active')) return ledger;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return ledger;
};

(async () => {
  const userMessage = user('binding-u1', 'Alice opens the blue archive door.');
  const runtime = await createHayakuRuntime({ messages: [userMessage], autoRepair: false });
  try {
    const initialScope = await runtime.hayaku._test.currentChatScope();
    const initialSnapshot = runtime.hayaku._test.authoritativeChatSnapshot(initialScope.chatMessages, initialScope);
    const base = runtime.hayaku._test.requestLineageFor(
      initialScope.chatMessages,
      initialSnapshot,
      initialScope,
      { nodes: [] }
    );
    const lineage = runtime.hayaku._test.issueRequestGenerationIdentity(initialScope, base);
    const pending = runtime.hayaku._test.registerPendingCapture(initialScope, lineage, 'model', initialSnapshot);
    assert.ok(pending?.lineage?.requestNonce, 'fixture creates one exact pending generation');

    const packet = createValidPacket({
      turn: 1,
      subject: 'Alice',
      scene: 'blue-archive',
      summary: 'Alice opened the blue archive door.'
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
    const output = hiddenPacketMessage('Alice opened the blue archive door.', packet);
    runtime.setMessages([userMessage, assistant('binding-a1', output)]);

    const captured = await runtime.hayaku._test.processRisuChatOutputEvent({
      char: runtime.character,
      chat: runtime.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 1
    });
    assert.equal(captured.ok, true);
    assert.equal(captured.captured, 1);

    const pendingLedger = await runtime.hayaku.ledger.inspect();
    assert.equal(pendingLedger.records.length, 1);
    assert.equal(pendingLedger.records[0].recordState, 'unbound', 'capture is durable before final binding');
    assert.equal(runtime.hayaku.lastDebug().finalizedBindingMonitors, 1);

    const boundLedger = await waitForActiveBinding(runtime);
    assert.ok(boundLedger, 'ledger remains readable');
    assert.equal(boundLedger.records.length, 1);
    assert.equal(boundLedger.records[0].recordState, 'active', 'binding completes without another beforeRequest');
    assert.ok(boundLedger.records[0].ownerTurnNodeId, 'active packet owns an authoritative worldline node');
    assert.equal(boundLedger.worldline.nodes.filter(node => node.status === 'active').length, 1);
    assert.equal(runtime.hayaku.lastDebug().finalizedBindingMonitors, 0, 'completed monitor retires itself');
    assert.ok(runtime.hayaku._test.operationLogSnapshot().some(entry => entry.event === 'binding:completed'));

    process.stdout.write('hayaku_output_binding_autocomplete_runtime_test: PASS\n');
  } finally {
    await runtime.dispose();
  }

  const upgradeUserMessage = user('binding-upgrade-u1', 'Mina seals the silver observatory gate.');
  const previousRuntime = await createHayakuRuntime({ messages: [upgradeUserMessage], autoRepair: false });
  let upgradedRuntime = null;
  try {
    const scope = await previousRuntime.hayaku._test.currentChatScope();
    const snapshot = previousRuntime.hayaku._test.authoritativeChatSnapshot(scope.chatMessages, scope);
    const base = previousRuntime.hayaku._test.requestLineageFor(
      scope.chatMessages,
      snapshot,
      scope,
      { nodes: [] }
    );
    const lineage = previousRuntime.hayaku._test.issueRequestGenerationIdentity(scope, base);
    previousRuntime.hayaku._test.registerPendingCapture(scope, lineage, 'model', snapshot);
    const packet = createValidPacket({
      turn: 1,
      subject: 'Mina',
      scene: 'silver-observatory',
      summary: 'Mina sealed the silver observatory gate.'
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
    const output = hiddenPacketMessage('Mina sealed the silver observatory gate.', packet);
    const finalMessages = [upgradeUserMessage, assistant('binding-upgrade-a1', output)];
    previousRuntime.setMessages(finalMessages);
    const captured = await previousRuntime.hayaku._test.processRisuChatOutputEvent({
      char: previousRuntime.character,
      chat: previousRuntime.chat,
      characterIndex: 0,
      chatIndex: 0,
      messageIndex: 1
    });
    assert.equal(captured.captured, 1);
    assert.equal((await previousRuntime.hayaku.ledger.inspect()).records[0].recordState, 'unbound');

    const pluginStorage = previousRuntime.pluginStorage;
    const safeLocalStorage = previousRuntime.safeLocalStorage;
    await previousRuntime.dispose();
    upgradedRuntime = await createHayakuRuntime({
      messages: finalMessages,
      pluginStorage,
      safeLocalStorage,
      autoRepair: false
    });
    const repairedLedger = await waitForActiveBinding(upgradedRuntime, 5000);
    assert.equal(repairedLedger.records[0].recordState, 'active', 'startup repairs a safely matchable pre-upgrade unbound record');
    assert.ok(repairedLedger.records[0].ownerTurnNodeId, 'startup repair assigns the authoritative owner node');
    assert.equal(repairedLedger.worldline.nodes.filter(node => node.status === 'active').length, 1);

    process.stdout.write('hayaku_output_binding_upgrade_repair_runtime_test: PASS\n');
  } finally {
    if (upgradedRuntime) await upgradedRuntime.dispose();
    else await previousRuntime.dispose();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
