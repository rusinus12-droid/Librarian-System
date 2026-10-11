'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const micro = args => {
  const input = JSON.parse(args[0].messages[1].content), quote = input.assistant.text;
  return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
    personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1', ...input.binding,
      claims: [{changeKind: 'event', text: quote, actor: '', target: '', temporalRole: 'current',
        certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
        evidence: {role: 'assistant', messageId: input.assistant.messageId,
          startOffset: 0, endOffset: quote.length, exactQuote: quote}}]}})};
};
const source = () => [{role: 'user', chatId: 'repair-u', data: 'Where is the key?'},
  {role: 'assistant', chatId: 'repair-a', data: 'Mara stored the brass key.'},
  {role: 'assistant', chatId: 'repair-carrier', data: '<lb-stage-marker>RAW_ORIGINAL_한글😀</lb-stage-marker>'},
  {role: 'assistant', chatId: 'repair-last', data: 'The shelf stays dry.'}];
async function fixture() {
  let listener;
  const fx = await serverFixture({mode: 'mirror', snapshot: {chat: {id: 'unified-chat', chatId: 'unified-chat',
    name: 'Capture mirror recovery', message: source()}}, host: {
      addRisuChatListener: async (kind, handler) => {if (kind === 'output') listener = handler; return true;}
    }});
  // Exclude the independent bulk startup migration from these producer controls.
  // The registered producer, SDK owner admission, per-key transport and physical
  // HTTP/SQLite reads/writes all remain real. The retained lifecycle root runs
  // with the ordinary migration path, too.
  fx.hooks.beforeServerRequest = async url => {
    if (new URL(url).pathname === '/v1/kv/keys') throw Error('fixture bulk enumeration unavailable');
  };
  fx.f.control.onCall = async args => micro(args);
  fx.emit = () => listener({char: fx.f.character, chat: fx.f.chat,
    characterIndex: 0, chatIndex: 0, messageIndex: 3});
  return fx;
}
const capture = fx => fx.getRecords('libra.completed_turn_capture.v1')[0];
async function splitFixture() {
  const fx = await fixture(), originalSet = fx.backend.setItem;
  let first = true;
  fx.captureWrites = [];
  fx.backend.setItem = async (key, value) => {
    if (String(key).includes(':source-receipt-capture:')) {
      fx.captureWrites.push({key, value});
      if (first) {first = false; throw Error('fixture local capture copy failure');}
    }
    return originalSet(key, value);
  };
  try {
    fx.emit();
    await waitFor(() => fx.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'pending_reconciliation', 10000);
    const active = await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(active.status, 'verified');
    await waitFor(() => fx.f.r.api.getCaptureBackendState().lastMicroPublication?.revisionId === active.receipt.revisionId
      && fx.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    await fx.f.r.api.getReceiptRecoveryStatus();
    assert.equal(fx.captureWrites.length, 1);
    assert.equal(fx.f.control.calls.length, 0);
    fx.active = active;
    fx.originalReceipt = fx.local.get(active.receiptKey);
    fx.originalHead = fx.local.get(active.headKey);
    fx.originalCapture = capture(fx);
    assert.ok(fx.originalCapture);
    assert.equal(fx.local.has(fx.originalCapture.key), false);
    return fx;
  } catch (error) {await fx.cleanup(); throw error;}
}
async function duplicate(fx) {
  const prior = fx.f.r.api.getCaptureBackendState().lastOutputCapture.at;
  fx.emit();
  return waitFor(() => {
    const row = fx.f.r.api.getCaptureBackendState().lastOutputCapture;
    return row?.at !== prior && row?.duplicate === true && row;
  }, 10000);
}
const assertReceiptUntouched = fx => {
  assert.equal(fx.local.get(fx.active.receiptKey), fx.originalReceipt);
  assert.equal(fx.storedRows().find(row => row.key === fx.active.receiptKey)?.raw, fx.originalReceipt);
  assert.equal(fx.local.get(fx.active.headKey), fx.originalHead);
  assert.equal(fx.storedRows().find(row => row.key === fx.active.headKey)?.raw, fx.originalHead);
};

test('official duplicate repairs exact capture bytes including two retired raw variants without another analysis', async () => {
  const fx = await fixture();
  try {
    fx.emit();
    await waitFor(() => fx.f.r.api.getCaptureBackendState().lastMicroPublication?.status === 'verified'
      && fx.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    fx.active = await fx.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    fx.originalReceipt = fx.local.get(fx.active.receiptKey);
    fx.originalHead = fx.local.get(fx.active.headKey);
    for (const id of [1, 2]) {
      const before = fx.f.r.api.getCaptureBackendState().lastOutputCapture.rawVariantId;
      fx.f.chat.message[2].data = `<lb-stage-marker>RETIRED_VARIANT_${id}_한글😀</lb-stage-marker>`;
      fx.emit();
      await waitFor(() => fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable === true
        && fx.f.r.api.getCaptureBackendState().lastOutputCapture?.rawVariantId !== before, 10000);
    }
    const preserved = capture(fx), bytes = preserved.raw, writes = [], originalSet = fx.backend.setItem;
    assert.equal(Object.keys(preserved.value.rawSourceVariants).length, 2);
    assert.equal(preserved.value.rawVariantRefs.length, 3);
    fx.local.delete(preserved.key);
    fx.backend.setItem = async (key, value) => {
      if (key === preserved.key) writes.push(value);
      return originalSet(key, value);
    };
    const repaired = await duplicate(fx);
    assert.equal(repaired.captureStatus, 'verified');
    assert.equal(repaired.rawDurable, true);
    assert.ok(writes.length > 0, 'the actual producer transports the missing copy');
    assert.ok(writes.every(value => value === bytes), 'repair transports the complete existing record byte-for-byte');
    assert.equal(fx.local.get(preserved.key), bytes);
    assert.equal(capture(fx).raw, bytes);
    assertReceiptUntouched(fx);
    assert.equal((await fx.f.r.api.debugReadActiveRawPacket(1)).status, 'verified');
    await waitFor(() => fx.f.r.api.getCaptureBackendState().microQueuedJobs === 0, 10000);
    assert.equal(fx.f.control.calls.length, 1, 'completed analysis is never repeated by repair');
  } finally {await fx.cleanup();}
});

for (const refusal of ['wrong_binding', 'unknown_schema', 'value_mismatch', 'local_only_tombstone']) {
  test(`official duplicate refuses ${refusal} capture without rewriting either copy or invoking a provider`, async () => {
    const fx = await splitFixture();
    try {
      const original = fx.originalCapture;
      if (refusal === 'wrong_binding') await fx.mutate(original.key, {...original.value, sourceDigest: 'foreign-source'});
      if (refusal === 'unknown_schema') await fx.mutate(original.key, {...original.value, schema: 'unknown.capture.v1'});
      if (refusal === 'value_mismatch') fx.local.set(original.key, JSON.stringify({...original.value, captureSource: 'completed_pair_reconcile'}));
      if (refusal === 'local_only_tombstone') {
        fx.local.set(original.key, original.raw);
        await fx.mutate(original.key, null, 'remove');
      }
      const localBefore = fx.local.get(original.key), remoteBefore = fx.storedRows().find(row => row.key === original.key)?.raw;
      const result = await duplicate(fx);
      assert.equal(result.captureStatus, 'pending_reconciliation');
      assert.equal(result.rawDurable, false);
      assert.equal(fx.captureWrites.length, 1, 'refused producer never attempts capture transport');
      assert.equal(fx.local.get(original.key), localBefore);
      assert.equal(fx.storedRows().find(row => row.key === original.key)?.raw, remoteBefore);
      assertReceiptUntouched(fx);
      assert.equal(fx.f.control.calls.length, 0);
    } finally {await fx.cleanup();}
  });
}

for (const sourceChangeRead of [2, 4]) test(`source change during capture read ${sourceChangeRead} rejects repair before its physical copy`, async () => {
  const fx = await splitFixture();
  try {
    let inspected = 0, changed = false;
    const baseHook = fx.hooks.beforeServerRequest;
    fx.hooks.beforeServerRequest = async (url, init) => {
      await baseHook(url, init);
      if (new URL(url).searchParams.get('key') === fx.originalCapture.key && ++inspected === sourceChangeRead) {
        changed = true;
        fx.f.chat.message[1].data += ' A different source revision.';
      }
    };
    const result = await duplicate(fx);
    assert.equal(changed, true, 'source changes after recovery boundary capture and before copy admission');
    assert.equal(result.rawDurable, false);
    assert.equal(result.captureStatus, 'pending_reconciliation');
    assert.equal(fx.captureWrites.length, 1);
    assert.equal(fx.local.has(fx.originalCapture.key), false);
    assert.equal(fx.storedRows().find(row => row.key === fx.originalCapture.key)?.raw, fx.originalCapture.raw);
    assertReceiptUntouched(fx);
    assert.equal(fx.f.control.calls.length, 0);
  } finally {await fx.cleanup();}
});

test('a local capture arriving during the SDK remote read is retained instead of overwritten by repair', async () => {
  const fx = await splitFixture();
  try {
    const original = fx.originalCapture, packet = JSON.parse(fx.originalReceipt).rawSourcePacket;
    const appeared = JSON.stringify({...original.value,
      rawSourceVariants: {[packet.packetDigest]: packet},
      rawVariantRefs: [...original.value.rawVariantRefs, {...original.value.rawPacketRef,
        storageKey: original.key, field: 'rawSourceVariants.' + packet.packetDigest}]});
    let inspected = 0, arrived = false;
    const baseHook = fx.hooks.beforeServerRequest;
    fx.hooks.beforeServerRequest = async (url, init) => {
      await baseHook(url, init);
      if (new URL(url).searchParams.get('key') === original.key && ++inspected === 3) {
        arrived = true;
        fx.local.set(original.key, appeared);
      }
    };
    const result = await duplicate(fx);
    assert.equal(arrived, true, 'late capture arrives after the producer absence check, during SDK remote fetch');
    assert.equal(result.captureStatus, 'pending_reconciliation');
    assert.equal(result.rawDurable, false);
    assert.equal(fx.captureWrites.length, 1, 'producer never writes over the newly arrived record');
    assert.equal(fx.local.get(original.key), appeared, 'all concurrent raw variants and refs remain intact');
    assert.equal(fx.storedRows().find(row => row.key === original.key)?.raw, original.raw);
    assertReceiptUntouched(fx);
    assert.equal(fx.f.control.calls.length, 0);
  } finally {await fx.cleanup();}
});

test('failed physical repair readback remains pending and provider-silent', async () => {
  const fx = await splitFixture();
  try {
    const set = fx.backend.setItem;
    fx.backend.setItem = async (key, value) => {
      if (key === fx.originalCapture.key) {fx.captureWrites.push({key, value}); return true;}
      return set(key, value);
    };
    const result = await duplicate(fx);
    assert.equal(result.rawDurable, false);
    assert.equal(result.captureStatus, 'pending_reconciliation');
    assert.ok(fx.captureWrites.length > 1, 'registered producer attempts repair through real SDK owner copy');
    assert.equal(fx.local.has(fx.originalCapture.key), false, 'lying storage ACK never establishes durability');
    assert.equal(fx.storedRows().find(row => row.key === fx.originalCapture.key)?.raw, fx.originalCapture.raw);
    assertReceiptUntouched(fx);
    assert.equal(fx.f.control.calls.length, 0);
  } finally {await fx.cleanup();}
});
