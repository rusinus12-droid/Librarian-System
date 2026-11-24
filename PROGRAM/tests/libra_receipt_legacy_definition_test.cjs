'use strict';
// 영수증 관문 1 회귀: 필드(sanitizedTextDigests)가 늘어나기 전에 저장된 영수증이 "원문 변경"으로
// 오인되지 않고 채택되는지, 반대로 변조된 영수증은 계속 거부되는지 확인한다.
const { test } = require('node:test');
const assert = require('node:assert');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const CTX_BASE = { worldlineId: 'w1', sessionEpoch: 0, turn: 51 };

const currentPair = () => ({
  turn: 51,
  scopeKey: 'scope-1',
  sourceDigest: 'sd-current',
  user: { chatIds: ['u1'], text: '문을 연다.', rawPayloadDigests: ['r1'], sanitizedTextDigests: ['s1'] },
  assistant: { chatIds: ['a1'], text: '문이 열렸다.', rawPayloadDigests: ['r2'], sanitizedTextDigests: ['s2'] }
});

const legacyReceipt = (api, overrides = {}) => {
  const current = currentPair();
  const legacyId = api.debugCompletedTurnRevisionId(current, { legacy: true });
  return {
    schema: 'libra.completed_turn_receipt.v1',
    scopeKey: 'scope-1',
    worldlineId: 'w1',
    sessionEpoch: 0,
    turn: 51,
    revisionId: legacyId,
    sourceDigest: 'sd-current',
    user: { chatIds: ['u1'], text: '문을 연다.', rawPayloadDigests: ['r1'] },
    assistant: { chatIds: ['a1'], text: '문이 열렸다.', rawPayloadDigests: ['r2'] },
    ...overrides
  };
};

test('a receipt saved before sanitizedTextDigests existed is accepted under its own definition', async () => {
  const harness = await createLibraVmHarness({}, {});
  const api = harness.api;
  const current = currentPair();
  const currentId = api.debugCompletedTurnRevisionId(current);
  const legacyId = api.debugCompletedTurnRevisionId(current, { legacy: true });
  assert.notEqual(currentId, legacyId, 'the two definitions really differ, otherwise this test proves nothing');

  const gate = api.debugTextEquivalentReceiptGate(legacyReceipt(api), current, { ...CTX_BASE, revisionId: currentId });
  assert.equal(gate.ok, true, `legacy receipt must be accepted (${gate.reason})`);
  assert.equal(gate.reason, 'legacy_definition');
});

test('a receipt whose stored id matches the current definition still passes unchanged', async () => {
  const harness = await createLibraVmHarness({}, {});
  const api = harness.api;
  const current = currentPair();
  const currentId = api.debugCompletedTurnRevisionId(current);
  const receipt = {
    ...legacyReceipt(api),
    revisionId: currentId,
    user: { chatIds: ['u1'], text: '문을 연다.', rawPayloadDigests: ['r1'], sanitizedTextDigests: ['s1'] },
    assistant: { chatIds: ['a1'], text: '문이 열렸다.', rawPayloadDigests: ['r2'], sanitizedTextDigests: ['s2'] }
  };
  const gate = api.debugTextEquivalentReceiptGate(receipt, current, { ...CTX_BASE, revisionId: currentId });
  assert.equal(gate.ok, true);
  assert.equal(gate.reason, '', 'no legacy path is used when the record already carries the field set');
});

test('a tampered legacy receipt is still refused', async () => {
  const harness = await createLibraVmHarness({}, {});
  const api = harness.api;
  const current = currentPair();
  const currentId = api.debugCompletedTurnRevisionId(current);

  const otherMessages = legacyReceipt(api, {
    user: { chatIds: ['u9'], text: '문을 연다.', rawPayloadDigests: ['r1'] }
  });
  assert.equal(api.debugTextEquivalentReceiptGate(otherMessages, current, { ...CTX_BASE, revisionId: currentId }).ok, false,
    'a receipt describing different messages is not carried');

  const rewritten = legacyReceipt(api, { revisionId: 'deadbeef' });
  assert.equal(api.debugTextEquivalentReceiptGate(rewritten, current, { ...CTX_BASE, revisionId: currentId }).ok, false,
    'a receipt whose id matches neither definition is refused');

  const wrongTurn = legacyReceipt(api, { turn: 50 });
  assert.equal(api.debugTextEquivalentReceiptGate(wrongTurn, current, { ...CTX_BASE, revisionId: currentId }).ok, false,
    'a receipt for another turn is refused');
});
