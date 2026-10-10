'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});
const records = rows => rows.filter(row => row.value?.schema === 'libra.person_span_inventory.v1');
const heads = rows => rows.filter(row => row.value?.schema === 'libra.person_span_inventory_head.v1');

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    let listener;
    const fixture = await serverFixture({mode, host: {
      addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
    }});
    try {
      const {f} = fixture;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      const event = {char:f.character, chat:f.chat, characterIndex:0, chatIndex:0, messageIndex:1};
      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
      assert.equal(f.r.api.getCaptureBackendState().lastOutputCapture?.inventoryStatus, 'verified',
        `${mode}: receipt producer also publishes the deterministic inventory`);
      const local = localRows(fixture.local), remote = fixture.storedRows();
      const source = mode === 'server_only' ? remote : local;
      assert.equal(records(source).length, 1, `${mode}: known-person inventory is a durable revision`);
      assert.equal(heads(source).length, 1, `${mode}: active inventory head is durable`);
      if (mode === 'mirror') {
        assert.deepEqual(records(local)[0].value, records(remote)[0].value, 'mirror transports one inventory value');
        assert.deepEqual(heads(local)[0].value, heads(remote)[0].value);
      }
      const inventory = records(source)[0].value, head = heads(source)[0].value;
      assert.equal(inventory.status, 'known_mentions_only');
      assert.equal(head.inventoryKey, records(source)[0].key);
      assert.equal(head.receiptRevisionId, inventory.revisionId);
      assert.equal(inventory.scopeKey, head.scopeKey);
      assert.equal(inventory.user?.text, undefined, 'inventory does not duplicate full U+A source');
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
      assert.equal(f.control.calls.length, 1, 'inventory and Micro share one producer call');
      assert.match(JSON.stringify(f.control.calls[0]), /LIBRA MICRO SOURCE CONTRACT/);

      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
        && f.r.api.getCaptureBackendState().lastOutputCapture?.inventoryStatus === 'verified', 10000);
      assert.equal(records(mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local)).length, 1,
        `${mode}: duplicate callback reuses the same inventory revision`);

      f.chat.message[1].data += ' 후속 수정.';
      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.revision === 2
        && f.r.api.getCaptureBackendState().lastOutputCapture?.inventoryStatus === 'verified', 10000);
      const revised = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
      assert.equal(records(revised).length, 2, `${mode}: source edit keeps the historical inventory`);
      assert.equal(heads(revised).length, 1);
      assert.notEqual(heads(revised)[0].value.receiptRevisionId, head.receiptRevisionId,
        `${mode}: only the edited source inventory is active`);
      console.log(`PASS source-bound person inventory in ${mode}`);
    } finally { await fixture.cleanup(); }
  }

  const batch = await serverFixture({mode:'mirror'});
  try {
    assert.equal((await batch.f.run()).completed, 1, 'T5 Canonical remains independent of inventory publication');
    const local = localRows(batch.local), remote = batch.storedRows();
    assert.equal(records(local).length, 5, 'batch reconcile publishes one inventory per completed pair');
    assert.equal(heads(local).length, 5, 'each completed pair has one active inventory head');
    assert.deepEqual(records(local).map(row => row.value.turn).sort(), [1, 2, 3, 4, 5]);
    for (const head of heads(local)) {
      const record = records(local).find(row => row.key === head.value.inventoryKey);
      assert.ok(record, `T${head.value.turn}: active head resolves a persisted inventory`);
      assert.deepEqual(record.value, records(remote).find(row => row.key === record.key)?.value,
        `T${head.value.turn}: mirror copies contain the same inventory`);
    }
    console.log('PASS batch reconcile publishes five source-bound inventories in mirror');
  } finally { await batch.cleanup(); }

  let listener;
  const partial = await serverFixture({mode:'mirror', host:{
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  try {
    partial.f.chat.message = partial.f.chat.message.slice(0, 2);
    partial.f.chat.messages = partial.f.chat.message;
    const originalSet = partial.backend.setItem;
    let failLocal = true;
    partial.backend.setItem = async (key, value) => {
      if (failLocal && String(key).includes(':person-span-inventory:')) {
        failLocal = false;
        throw new Error('injected local inventory copy failure');
      }
      return await originalSet(key, value);
    };
    const event = {char:partial.f.character, chat:partial.f.chat, characterIndex:0, chatIndex:0, messageIndex:1};
    listener(event);
    await waitFor(() => partial.f.r.api.getCaptureBackendState().lastOutputCapture?.inventoryStatus === 'pending_reconciliation', 10000);
    assert.equal(records(partial.storedRows()).length, 1, 'server retains its one-sided immutable inventory');
    assert.equal(heads(partial.storedRows()).length, 0, 'no head is published before both copies pass readback');
    assert.equal(records(localRows(partial.local)).length, 0);
    listener(event);
    await waitFor(() => partial.f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true
      && partial.f.r.api.getCaptureBackendState().lastOutputCapture?.inventoryStatus === 'verified', 10000);
    assert.deepEqual(records(localRows(partial.local))[0].value, records(partial.storedRows())[0].value);
    assert.deepEqual(heads(localRows(partial.local))[0].value, heads(partial.storedRows())[0].value);
    await waitFor(() => partial.f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 10000);
    assert.equal(partial.f.control.calls.length, 1, 'inventory repair does not add a second Micro call');
    console.log('PASS one-sided mirror person inventory repairs without analysis');
  } finally { await partial.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
