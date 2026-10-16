'use strict';
// The Recovery Journal copy of a turn is no longer the text source while the
// visible chat holds the same turn: manual repair and raw passage recall read the
// live chat, and a changed turn still fails closed.
const assert = require('node:assert/strict');
const { createHayakuRuntime } = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data, time: Date.now() });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data, time: Date.now() });

(async () => {
  const assistantText = 'Mira hides the silver key under the loose floorboard by the stove.';
  const runtime = await createHayakuRuntime({ afterRequestAutoRepair: false, messages: [user('u1', 'Where does Mira hide the key?')] });
  try {
    const t = runtime.hayaku._test;
    const scope0 = await t.currentChatScope();
    const snapshot0 = t.authoritativeChatSnapshot(scope0.chatMessages, scope0);
    const lineage = t.issueRequestGenerationIdentity(scope0, t.requestLineageFor(scope0.chatMessages, snapshot0, scope0, { nodes: [] }));
    t.registerPendingCapture(scope0, lineage, 'model', snapshot0);
    await t.repairCurrentPacketInsideAfterRequest(assistantText, 'model');
    runtime.chat.message.push(assistant('a1', assistantText));
    runtime.chat.messages = runtime.chat.message;
    await t.processRisuChatOutputEvent({ char: runtime.character, chat: runtime.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    const scope = await t.currentChatScope();
    const vault = await t.loadRecoveryVault(scope.key, { force: true });
    assert.equal(vault.records.length, 1, 'missing turn is listed in the journal');
    const record = vault.records[0];

    // Replace the stored copy (hashes kept): repair evidence still comes from the visible chat.
    const stripped = { ...record, evidenceManifest: null, evidenceCompleteness: 'complete_inline',
      user: { ...record.user, text: 'stale copy', preview: 'stale copy' }, assistant: { ...record.assistant, text: 'stale copy', preview: 'stale copy' } };
    const evidence = await t.readVerifiedRecoveryEvidence(stripped, scope, null, { rehydrate: false });
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
    assert.equal(evidence.reason, 'recovery_evidence_live_chat');
    assert.equal(evidence.assistant, assistantText);
    assert.match(evidence.user, /Where does Mira hide the key/);

    // Raw passage recall returns the live text even without the stored copy.
    await t.writeRecoveryVaultDirect(scope.key, { ...vault, records: [stripped] }, 'test_strip_text');
    const recall = await t.searchRecoveryVaultRawPassages(scope, 'silver key floorboard', scope.chatMessages);
    assert.ok(recall.records.some(row => row.text === assistantText), JSON.stringify(recall.records));
    assert.ok(!recall.records.some(row => row.text === 'stale copy'), 'the stored copy is not recalled');

    // A changed turn fails closed instead of using either copy.
    runtime.chat.message[1].data = 'Mira keeps the key in her pocket.';
    const changedScope = await t.currentChatScope();
    const changed = await t.readVerifiedRecoveryEvidence(record, changedScope, null, { rehydrate: false });
    assert.equal(changed.ok, false);
    const changedRecall = await t.searchRecoveryVaultRawPassages(changedScope, 'silver key floorboard', changedScope.chatMessages);
    assert.ok(!changedRecall.records.some(row => row.text === assistantText), 'stale journal text is never recalled');
  } finally {
    await runtime.dispose();
  }
  console.log('PASS hayaku_journal_live_chat_source_test');
})().catch(error => { console.error(error); process.exit(1); });
