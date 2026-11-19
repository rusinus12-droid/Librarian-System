'use strict';
// 원문 태그 필터 원칙 (docs/SOURCE_TAG_FILTER_PRINCIPLE_20261119.md) for HAYAKU: adding or removing a
// source tag rule keeps every turn bound to its existing node and record. A reroll and a rollback
// are still detected; a message id alone never proves the same turn (hayakuSameTurnSource).
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const user = (id, data) => ({ role: 'user', chatId: id, id, data });
const assistant = (id, data) => ({ role: 'assistant', chatId: id, id, data });
const STATUS = '\n<status-window>HP 10 · 위치: 서고</status-window>';
const RULES = { version: 1, ignoredTags: ['img', 'lb-lazy', 'lb-stage', 'lb-stage-marker', 'lb-xnai', 'status-window', 'thoughts'], unwrapTags: [], sourceTags: [], controls: ['html-comment', 'lbdata'] };
const DEFAULTS = { ...RULES, ignoredTags: RULES.ignoredTags.filter(tag => tag !== 'status-window') };

(async () => {
  const packet1 = createValidPacket({ turn: 1, subject: 'Alice', scene: 'library', summary: 'Alice entered the library.' });
  const packet2 = createValidPacket({ turn: 2, subject: 'Alice', scene: 'hallway', summary: 'Alice walked down the hallway.' });
  const chat = (first = assistant('a1', hiddenPacketMessage('Alice entered the library.' + STATUS, packet1)), withTurn2 = true) => [
    user('u1', 'I enter the library.'), first,
    ...(withTurn2 ? [user('u2', 'I walk down the hallway.'), assistant('a2', hiddenPacketMessage('Alice walked down the hallway.' + STATUS, packet2))] : [])
  ];
  const runtime = await createHayakuRuntime({ autoRepair: false, messages: chat(), llmResponder: async () => { throw new Error('no model call expected'); } });
  try {
    const t = runtime.hayaku._test;
    const reconcile = async reason => {
      const scope = await t.currentChatScope();
      await t.reconcileObservedChatTopology(scope, t.authoritativeChatSnapshot(scope.chatMessages, scope), reason, { prompt: false });
      return t.loadStorageLedger(scope, { hydrateArchive: false });
    };
    const activeNode = (ledger, turn) => ledger.worldline?.nodes?.find(n => n.pairIndex === turn && n.status === 'active');
    const activeRecord = (ledger, turn) => ledger.records.find(r => Number(r.targetPairIndex) === turn && r.recordState === 'active');
    const bound = (ledger, turn) => { const node = activeNode(ledger, turn), record = activeRecord(ledger, turn); return node && record && record.ownerTurnNodeId === node.turnNodeId ? { node: node.turnNodeId, record: record.id || record.hash } : null; };

    const initial = await reconcile('initial');
    const before = [1, 2].map(turn => bound(initial, turn));
    assert.ok(before.every(Boolean), 'both turns are bound initially: ' + JSON.stringify(before));

    for (const [label, rules] of [['rule added', RULES], ['rule removed', DEFAULTS]]) {
      await runtime.hayaku.setSourceEditRules(rules);
      const ledger = await reconcile(label);
      assert.equal(ledger.logicalRecordCount, 2, label + ': no record is dropped');
      assert.deepEqual([1, 2].map(turn => bound(ledger, turn)), before, label + ': the same nodes and records stay bound');
    }

    // Reroll: a new reply message with its own packet. The turn gets a new node and the old
    // record does not follow it by position. (A cached reroll that keeps the chatId reaches
    // HAYAKU through the live packet capture with its request nonce, not through this path.)
    await runtime.hayaku.setSourceEditRules(RULES);
    await reconcile('rule added again');
    const rerolledPacket = createValidPacket({ turn: 1, subject: 'Alice', scene: 'grand_library', summary: 'Alice entered the grand library instead.' });
    const rerolledReply = assistant('a1-reroll', hiddenPacketMessage('Alice entered the grand library instead.' + STATUS, rerolledPacket));
    runtime.setMessages(chat(rerolledReply));
    const rerolled = await reconcile('reroll');
    assert.notEqual(activeNode(rerolled, 1)?.turnNodeId, before[0].node, 'a reroll is a new turn node');
    const oldRecord = rerolled.records.find(r => (r.id || r.hash) === before[0].record);
    assert.ok(!oldRecord || oldRecord.recordState !== 'active' || oldRecord.ownerTurnNodeId !== activeNode(rerolled, 1)?.turnNodeId,
      'the old reply record is not bound to the rerolled turn');

    // Rollback: turn 2 removed.
    runtime.setMessages(chat(rerolledReply, false));
    const rolledBack = await reconcile('rollback');
    assert.equal(activeNode(rolledBack, 2), undefined, 'a rolled-back turn has no active node');
    console.log('hayaku_source_filter_binding_test: ok');
  } finally { await runtime.dispose?.(); }
})().catch(error => { console.error(error); process.exit(1); });
