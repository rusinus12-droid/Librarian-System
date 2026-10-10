'use strict';

// Regression for the orphaned pendingTask/sourceUnit expression in the real
// public preview path. Removing it must not weaken the independent admission
// and stale-source checks below. All data and host effects are local fixtures.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createHayakuRuntime,
  createValidPacket,
  hiddenPacketMessage
} = require('./fixtures/hayaku_runtime_harness.cjs');

const visible = 'Alice found a silver compass in the archive.';
const packet = createValidPacket({ turn: 1, subject: 'Alice', scene: 'archive', summary: visible });
const messages = (userText = 'Alice opens the archive.', extra = '') => [
  { role: 'user', id: 'recapture-u1', chatId: 'recapture-u1', data: userText },
  { role: 'assistant', id: 'recapture-a1', chatId: 'recapture-a1', data: hiddenPacketMessage(visible, packet) + extra }
];
const bytes = runtime => Array.from(runtime.pluginStorage.values, ([key, value]) => [key, String(value)])
  .sort(([a], [b]) => a.localeCompare(b));
const fixture = (chatId, rows = messages()) => createHayakuRuntime({
  chatId,
  messages: rows,
  pluginSourceFile: process.env.HAYAKU_TEST_PLUGIN,
  autoRepair: false,
  afterRequestAutoRepair: false,
  llmResponder: async () => { throw new Error('UNEXPECTED_MODEL_CALL'); },
  nativeFetch: async () => { throw new Error('UNEXPECTED_NETWORK_CALL'); }
});
const assertOffline = runtime => {
  assert.equal(runtime.llmCalls.length, 0, 'no model call');
  assert.equal(runtime.fetchCalls.length, 0, 'no network/provider call');
};

test('active native-ID packet turn previews without retired detector globals or writes', async () => {
  const runtime = await fixture('recapture-reference-active');
  try {
    const before = bytes(runtime);
    assert.equal('pendingTask' in runtime.context, false);
    assert.equal('sourceUnit' in runtime.context, false);
    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    assert.equal(preview.ok, true);
    assert.equal(preview.readOnly, true);
    assert.equal(preview.modelCalls, 0);
    assert.deepEqual(Array.from(preview.eligibleTurns), [1]);
    assert.equal(preview.turns[0].reason, '');
    assert.equal(preview.turns[0].packets[0].raw, JSON.stringify(packet));
    assert.deepEqual(bytes(runtime), before, 'preview leaves every persisted byte unchanged');
    assertOffline(runtime);
  } finally { await runtime.dispose(); }
});

test('stored packet from a different visible source stays ineligible after detector retirement', async () => {
  const runtime = await fixture('recapture-reference-source-conflict');
  try {
    const t = runtime.hayaku._test;
    const scope = await t.currentChatScope();
    const snapshot = t.authoritativeChatSnapshot(scope.chatMessages, scope);
    await t.reconcileObservedChatTopology(scope, snapshot, 'recapture_source_conflict_fixture', { prompt: false });
    const stored = await t.loadStorageLedger(scope, { hydrateArchive: false });
    assert.equal(stored.records.length, 1, 'the original source has a stored packet');
    runtime.setMessages(messages('Alice closes the archive instead.'));
    const before = bytes(runtime);
    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    assert.equal(preview.ok, true);
    assert.equal(preview.turns[0].eligible, false);
    assert.equal(preview.turns[0].reason, 'source_identity_conflict');
    assert.deepEqual(Array.from(preview.eligibleTurns), []);
    const result = await runtime.hayaku.ledger.manualRecapture.adopt({
      previewId: preview.previewId, selection: 'selected', turns: [1]
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'selected_turn_not_eligible');
    assert.deepEqual(bytes(runtime), before, 'rejected adoption preserves the approved ledger');
    assertOffline(runtime);
  } finally { await runtime.dispose(); }
});

test('invalid inline sibling keeps the entire turn ineligible', async () => {
  const runtime = await fixture('recapture-reference-invalid', messages(undefined,
    '\n<!-- HAYAKU_STATE_PACKET_START {"broken":true} HAYAKU_STATE_PACKET_END -->'));
  try {
    const before = bytes(runtime);
    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    assert.equal(preview.ok, true);
    assert.equal(preview.turns[0].eligible, false);
    assert.equal(preview.turns[0].reason, 'invalid_packet');
    assert.deepEqual(Array.from(preview.eligibleTurns), []);
    assert.deepEqual(bytes(runtime), before);
    assertOffline(runtime);
  } finally { await runtime.dispose(); }
});

test('fresh preview cannot authorize adoption after its native chat scope changes', async () => {
  const runtime = await fixture('recapture-reference-scope');
  try {
    const preview = await runtime.hayaku.ledger.manualRecapture.preview();
    assert.deepEqual(Array.from(preview.eligibleTurns), [1]);
    runtime.chat.id = runtime.chat.chatId = 'recapture-reference-another-scope';
    const before = bytes(runtime);
    const result = await runtime.hayaku.ledger.manualRecapture.adopt({ previewId: preview.previewId, selection: 'all' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'coverage_scope_changed');
    assert.deepEqual(bytes(runtime), before);
    assertOffline(runtime);
  } finally { await runtime.dispose(); }
});
