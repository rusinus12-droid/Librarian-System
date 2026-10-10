'use strict';
const assert = require('node:assert/strict');
const {isDeepStrictEqual} = require('node:util');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});
const records = rows => rows.filter(row => row.value?.schema === 'libra.person_span_inventory.v1');
const heads = rows => rows.filter(row => row.value?.schema === 'libra.person_span_inventory_head.v1');
const receipts = rows => rows.filter(row => row.value?.schema === 'libra.completed_turn_receipt.v1');
const receiptHeads = rows => rows.filter(row => row.value?.schema === 'libra.completed_turn_head.v1');
const stores = fixture => ({local: localRows(fixture.local), remote: fixture.storedRows()});
const sourceRows = (snapshot, mode) => mode === 'server_only' ? snapshot.remote : snapshot.local;
const isMicroCall = call => /LIBRA MICRO SOURCE CONTRACT/.test(JSON.stringify(call));

// The unchanged fixture returns a Canonical artifact, which is invalid as a Micro
// envelope. This test retains deterministic known-only inventories plus the
// minimum_source_bound fallback. It does not test classified-person discovery.
// waitFor invokes predicates synchronously: never pass an async reader to it.
function inventoryIn(rows, active) {
  const receipt = active?.receipt;
  if (active?.status !== 'verified' || !active.receiptKey || !receipt?.revisionId
    || !receipt.scopeKey || !receipt.worldlineId || !receipt.sourceDigest) return false;
  const sameSource = value => value.scopeKey === receipt.scopeKey
    && value.worldlineId === receipt.worldlineId && value.sessionEpoch === receipt.sessionEpoch
    && value.turn === receipt.turn && value.sourceDigest === receipt.sourceDigest;
  const matchingHeads = heads(rows).filter(row => sameSource(row.value)
    && row.value.receiptRevisionId === receipt.revisionId);
  if (matchingHeads.length !== 1) return false;
  const head = matchingHeads[0];
  const matchingRecords = records(rows).filter(row => row.key === head.value.inventoryKey);
  if (matchingRecords.length !== 1) return false;
  const record = matchingRecords[0];
  if (!sameSource(record.value) || record.value.status !== 'known_mentions_only'
    || record.value.revisionId !== receipt.revisionId || record.value.receiptKey !== active.receiptKey
    || !head.value.inventoryRevisionId || !head.value.registryDigest
    || record.value.inventoryRevisionId !== head.value.inventoryRevisionId
    || record.value.registryDigest !== head.value.registryDigest) return false;
  return {record, head};
}
function inventoryReady(snapshot, mode, active) {
  const selected = inventoryIn(sourceRows(snapshot, mode), active);
  if (!selected) return false;
  if (mode === 'mirror') {
    const remote = inventoryIn(snapshot.remote, active);
    if (!remote || selected.record.key !== remote.record.key || selected.head.key !== remote.head.key
      || !isDeepStrictEqual(selected.record.value, remote.record.value)
      || !isDeepStrictEqual(selected.head.value, remote.head.value)) return false;
  }
  return selected;
}
function outputReady(state, active, marker) {
  const capture = state.lastOutputCapture, receipt = active?.receipt;
  return active?.status === 'verified' && !!receipt && !!active.receiptKey
    && capture?.receiptStatus === 'verified' && capture.scopeKey === receipt.scopeKey
    && capture.turn === receipt.turn && capture.receiptRevisionId === receipt.revisionId
    && capture.revision === marker.revision && (capture.duplicate === true) === marker.duplicate;
}
const queuesIdle = state => state.microQueuedJobs === 0 && state.microQueueScopes === 0
  && state.receiptCaptureJobs === 0 && state.receiptQueueScopes === 0;
function microSettled(state, active, marker) {
  return outputReady(state, active, marker) && queuesIdle(state)
    && state.lastMicroPublication?.turn === active.receipt.turn
    && state.lastMicroPublication?.revisionId === active.receipt.revisionId
    && state.lastMicroPublication?.status === 'verified';
}
async function captureReceipt(fixture, marker) {
  const active = plain(await fixture.f.r.api.debugReadActiveCompletedTurnReceipt(1));
  assert.equal(active.status, 'verified', 'the expected output has an authoritative active receipt');
  assert.ok(outputReady(fixture.f.r.api.getCaptureBackendState(), active, marker));
  assert.equal(active.receipt.assistant.text, fixture.f.chat.message[1].data);
  return active;
}
async function waitInventory(fixture, mode, active) {
  const ready = await waitFor(() => inventoryReady(stores(fixture), mode, active), 10000);
  const saved = plain(await fixture.f.r.api.debugReadPersonSpanInventory(active.receipt.turn));
  assert.equal(saved.status, 'verified', 'the receipt-bound inventory passes the production reader');
  assert.equal(saved.inventoryKey, ready.record.key);
  assert.equal(saved.headKey, ready.head.key);
  assert.deepEqual(saved.inventory, ready.record.value);
  assert.equal(saved.inventory.receiptKey, active.receiptKey);
  assert.equal(saved.inventory.sourceDigest, active.receipt.sourceDigest);
  return ready;
}
async function waitMicro(fixture, active, marker) {
  await waitFor(() => microSettled(fixture.f.r.api.getCaptureBackendState(), active, marker), 10000);
}
async function assertFallback(fixture, mode, active) {
  const micro = plain(await fixture.f.r.api.debugReadActiveMicroMemory(active.receipt.turn));
  assert.equal(micro.status, 'verified', 'fallback storage is verified, not successful semantic analysis');
  assert.equal(micro.record.analysisStatus, 'minimum_source_bound');
  assert.equal(micro.record.receiptKey, active.receiptKey);
  assert.equal(micro.record.sourceRevisionId, active.receipt.revisionId);
  assert.equal(micro.record.sourceDigest, active.receipt.sourceDigest);
  const work = sourceRows(stores(fixture), mode).filter(row => row.value?.schema === 'libra.micro_work.v1'
    && row.key === micro.record.workKey);
  assert.equal(work.length, 1);
  assert.equal(work[0].value.status, 'result_ready');
  assert.equal(work[0].value.receiptKey, active.receiptKey);
  assert.equal(work[0].value.sourceRevisionId, active.receipt.revisionId);
  assert.equal(work[0].value.result.reason, 'producer_schema_invalid');
  assert.equal(work[0].value.result.personInventory, null);
}

// Finite, synchronous witnesses exercise the exact polling predicates using
// detached snapshots of a real ready fixture. No storage is seeded or corrupted.
// Every negative has the same turn's rows available; merely any row cannot pass.
function readinessWitnesses(fixture, mode, active, marker) {
  const snapshot = plain(stores(fixture));
  const state = plain(fixture.f.r.api.getCaptureBackendState());
  assert.ok(inventoryReady(snapshot, mode, active), `${mode}: inventory readiness positive witness`);
  assert.ok(microSettled(state, active, marker), `${mode}: drained Micro positive witness`);
  assert.equal(inventoryReady({local: [], remote: []}, mode, active), false, 'empty rows are not ready');
  for (const field of ['revisionId', 'scopeKey', 'worldlineId', 'sourceDigest', 'sessionEpoch', 'turn']) {
    const wrong = plain(active);
    wrong.receipt[field] = typeof wrong.receipt[field] === 'number'
      ? wrong.receipt[field] + 1 : `${wrong.receipt[field]}:wrong`;
    assert.equal(inventoryReady(snapshot, mode, wrong), false, `wrong expected ${field} is rejected`);
  }
  const wrongKey = {...active, receiptKey: `${active.receiptKey}:wrong`};
  assert.equal(inventoryReady(snapshot, mode, wrongKey), false, 'wrong expected receipt key is rejected');
  for (const [kind, field] of [
    ['head', 'receiptRevisionId'], ['head', 'scopeKey'], ['head', 'inventoryKey'],
    ['head', 'sourceDigest'], ['head', 'inventoryRevisionId'], ['head', 'registryDigest'],
    ['record', 'revisionId'], ['record', 'scopeKey'], ['record', 'receiptKey'],
    ['record', 'sourceDigest'], ['record', 'inventoryRevisionId'], ['record', 'registryDigest']
  ]) {
    const wrong = plain(snapshot);
    const selected = inventoryReady(wrong, mode, active);
    selected[kind].value[field] += ':wrong';
    assert.equal(inventoryReady(wrong, mode, active), false, `wrong ${kind}.${field} is rejected`);
  }
  if (mode === 'mirror') {
    const selected = inventoryReady(snapshot, mode, active);
    for (const key of [selected.record.key, selected.head.key]) {
      const wrong = plain(snapshot);
      wrong.remote = wrong.remote.filter(row => row.key !== key);
      assert.equal(inventoryReady(wrong, mode, active), false, 'missing remote copy is not ready');
    }
    const mismatched = plain(snapshot);
    inventoryIn(mismatched.remote, active).record.value.spans.push({unexpected: true});
    assert.equal(inventoryReady(mismatched, mode, active), false, 'unequal mirror payload is not ready');
  }
  for (const field of ['microQueuedJobs', 'microQueueScopes', 'receiptCaptureJobs', 'receiptQueueScopes']) {
    assert.equal(microSettled({...state, [field]: 1}, active, marker), false, `${field} must actually drain`);
  }
  for (const [field, value] of [['revisionId', 'wrong-revision'], ['turn', 99], ['status', 'pending']]) {
    const wrong = plain(state);
    wrong.lastMicroPublication[field] = value;
    assert.equal(microSettled(wrong, active, marker), false, `wrong Micro ${field} is rejected`);
  }
  for (const [field, value] of [['scopeKey', 'wrong-scope'], ['receiptRevisionId', 'wrong-revision'],
    ['revision', marker.revision + 1], ['duplicate', !marker.duplicate], ['receiptStatus', 'pending_reconciliation']]) {
    const wrong = plain(state);
    wrong.lastOutputCapture[field] = value;
    assert.equal(microSettled(wrong, active, marker), false, `wrong output ${field} is rejected`);
  }
  assert.ok(inventoryReady(snapshot, mode, active), 'negative witnesses leave the positive snapshot intact');
  assert.ok(microSettled(state, active, marker), 'negative witnesses leave the drained snapshot intact');
}

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
      const firstMarker = {revision: 1, duplicate: false};
      listener(event);
      // W01: receipt acknowledgement is independent of eventual inventory preparation.
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
      // A01: corrected diagnostic plus the separate durable/readback positive below.
      assert.equal(f.r.api.getCaptureBackendState().lastOutputCapture?.inventoryStatus, 'deferred',
        `${mode}: receipt acknowledgement defers inventory to the Micro queue`);
      const active = await captureReceipt(fixture, firstMarker);
      const first = await waitInventory(fixture, mode, active);
      // W02: the exact revision must publish and the admitted job must finish.
      await waitMicro(fixture, active, firstMarker);
      const {local, remote} = stores(fixture);
      const source = mode === 'server_only' ? remote : local;
      assert.equal(records(source).length, 1, `${mode}: known-person inventory is a durable revision`); // A02
      assert.equal(heads(source).length, 1, `${mode}: active inventory head is durable`); // A03
      assert.equal(receipts(source).length, 1, `${mode}: one source receipt revision`);
      assert.equal(receiptHeads(source).length, 1, `${mode}: one active source head`);
      if (mode === 'mirror') {
        assert.deepEqual(records(local)[0].value, records(remote)[0].value, 'mirror transports one inventory value'); // A04
        assert.deepEqual(heads(local)[0].value, heads(remote)[0].value); // A05
      }
      const inventory = records(source)[0].value, head = heads(source)[0].value;
      assert.equal(inventory.status, 'known_mentions_only'); // A06
      assert.equal(head.inventoryKey, records(source)[0].key); // A07
      assert.equal(head.receiptRevisionId, inventory.revisionId); // A08
      assert.equal(inventory.scopeKey, head.scopeKey); // A09
      assert.equal(inventory.user?.text, undefined, 'inventory does not duplicate full U+A source'); // A10
      assert.equal(f.control.calls.length, 1, 'deterministic inventory adds no call to the one fresh-output Micro attempt'); // A11
      assert.match(JSON.stringify(f.control.calls[0]), /LIBRA MICRO SOURCE CONTRACT/); // A12
      await assertFallback(fixture, mode, active);
      readinessWitnesses(fixture, mode, active, firstMarker);
      const firstRecord = plain(first.record), firstHead = plain(first.head);
      const firstReceipt = plain(receipts(source)[0]);

      listener(event);
      const duplicateMarker = {revision: 1, duplicate: true};
      // W03: the fresh duplicate marker is set after its Micro job is scheduled.
      await waitFor(() => outputReady(f.r.api.getCaptureBackendState(), active, duplicateMarker), 10000);
      const duplicate = await waitInventory(fixture, mode, active);
      await waitMicro(fixture, active, duplicateMarker);
      assert.equal(records(sourceRows(stores(fixture), mode)).length, 1,
        `${mode}: duplicate callback reuses the same inventory revision`); // A13
      assert.equal(heads(sourceRows(stores(fixture), mode)).length, 1);
      assert.equal(receipts(sourceRows(stores(fixture), mode)).length, 1);
      assert.deepEqual(duplicate.record.value, firstRecord.value);
      assert.equal(duplicate.record.key, firstRecord.key);
      assert.deepEqual(duplicate.head.value, firstHead.value);
      assert.equal(duplicate.head.key, firstHead.key);
      assert.equal(f.control.calls.length, 1, 'a settled duplicate adds no Micro call');
      readinessWitnesses(fixture, mode, active, duplicateMarker);

      f.chat.message[1].data += ' 후속 수정.';
      listener(event);
      // W04: output revision2, a new receipt revision, then its inventory and Micro drain.
      await waitFor(() => {
        const capture = f.r.api.getCaptureBackendState().lastOutputCapture;
        return capture?.revision === 2 && capture.receiptStatus === 'verified'
          && capture.scopeKey === active.receipt.scopeKey && capture.turn === 1
          && !!capture.receiptRevisionId && capture.receiptRevisionId !== active.receipt.revisionId;
      }, 10000);
      const editedMarker = {revision: 2, duplicate: false};
      const edited = await captureReceipt(fixture, editedMarker);
      const second = await waitInventory(fixture, mode, edited);
      await waitMicro(fixture, edited, editedMarker);
      const revised = sourceRows(stores(fixture), mode);
      assert.equal(records(revised).length, 2, `${mode}: source edit keeps the historical inventory`); // A14
      assert.equal(heads(revised).length, 1); // A15
      assert.notEqual(heads(revised)[0].value.receiptRevisionId, head.receiptRevisionId,
        `${mode}: only the edited source inventory is active`); // A16
      assert.equal(receipts(revised).length, 2, 'the original and edited source receipts survive');
      assert.equal(receiptHeads(revised).length, 1);
      assert.deepEqual(records(revised).find(row => row.key === firstRecord.key)?.value, firstRecord.value);
      assert.deepEqual(receipts(revised).find(row => row.key === firstReceipt.key)?.value, firstReceipt.value);
      assert.notEqual(second.record.key, firstRecord.key);
      assert.equal(second.head.value.receiptRevisionId, edited.receipt.revisionId);
      assert.equal(second.head.value.inventoryKey, second.record.key);
      assert.equal(inventoryReady(stores(fixture), mode, active), false, 'the prior revision is historical, not active');
      assert.equal(f.control.calls.length, 2, 'exactly one Micro attempt per distinct official source revision');
      assert.ok(f.control.calls.every(isMicroCall));
      await assertFallback(fixture, mode, edited);
      readinessWitnesses(fixture, mode, edited, editedMarker);
      if (mode === 'mirror') {
        assert.equal(records(fixture.storedRows()).length, 2);
        assert.equal(heads(fixture.storedRows()).length, 1);
        assert.deepEqual(records(fixture.storedRows()).find(row => row.key === firstRecord.key)?.value, firstRecord.value);
      }
      console.log(`PASS source-bound known-only person inventory and fallback in ${mode}`);
    } finally { await fixture.cleanup(); }
  }

  const batch = await serverFixture({mode:'mirror'});
  try {
    assert.equal((await batch.f.run()).completed, 1, 'T5 Canonical remains independent of inventory publication'); // A17
    // Reconciliation awaits known inventories and schedules historical Micro checks
    // before run returns. Drain those checks; do not fabricate fresh-output plans.
    await waitFor(() => queuesIdle(batch.f.r.api.getCaptureBackendState()), 10000);
    const {local, remote} = stores(batch);
    assert.equal(records(local).length, 5, 'batch reconcile publishes one inventory per completed pair'); // A18
    assert.equal(heads(local).length, 5, 'each completed pair has one active inventory head'); // A19
    assert.deepEqual(records(local).map(row => row.value.turn).sort(), [1, 2, 3, 4, 5]); // A20
    assert.equal(records(remote).length, 5);
    assert.equal(heads(remote).length, 5);
    for (const head of heads(local)) {
      const record = records(local).find(row => row.key === head.value.inventoryKey);
      assert.ok(record, `T${head.value.turn}: active head resolves a persisted inventory`); // A21
      assert.deepEqual(record.value, records(remote).find(row => row.key === record.key)?.value,
        `T${head.value.turn}: mirror copies contain the same inventory`); // A22
      assert.deepEqual(head.value, heads(remote).find(row => row.key === head.key)?.value);
      const active = plain(await batch.f.r.api.debugReadActiveCompletedTurnReceipt(head.value.turn));
      assert.equal(active.status, 'verified');
      const ready = inventoryReady({local, remote}, 'mirror', active);
      assert.ok(ready, `T${head.value.turn}: both known copies bind to that exact active receipt`);
      assert.equal(ready.record.key, record.key);
      assert.equal(local.filter(row => row.value?.schema === 'libra.micro_work.v1'
        && row.value.receiptKey === active.receiptKey).length, 0, 'historical reconcile has no automatic work plan');
      assert.equal(remote.filter(row => row.value?.schema === 'libra.micro_work.v1'
        && row.value.receiptKey === active.receiptKey).length, 0);
    }
    // Canonical can advance the registry after preparation; do not require the old
    // known inventory to validate against the new registry. Source/copy binding stays exact.
    assert.equal(batch.f.control.calls.filter(isMicroCall).length, 0, 'batch-only receipts cannot start Micro calls');
    assert.equal(batch.f.control.calls.length, 1, 'the completed batch makes only its Canonical call');
    assert.match(JSON.stringify(batch.f.control.calls[0]), /LIBRA LONG-TERM MEMORY EXTRACTION/);
    console.log('PASS batch reconcile publishes five source-bound known inventories in mirror without Micro calls');
  } finally { await batch.cleanup(); }

  let listener;
  const partial = await serverFixture({mode:'mirror', host:{
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  const originalSet = partial.backend.setItem;
  let failLocal = true, faultHits = 0, rejectedCopy = null;
  try {
    partial.f.chat.message = partial.f.chat.message.slice(0, 2);
    partial.f.chat.messages = partial.f.chat.message;
    partial.backend.setItem = async (key, value) => {
      let parsed;
      try { parsed = JSON.parse(value); } catch { parsed = null; }
      if (failLocal && String(key).includes(':person-span-inventory:')
        && parsed?.schema === 'libra.person_span_inventory.v1' && parsed.status === 'known_mentions_only') {
        failLocal = false;
        faultHits += 1;
        rejectedCopy = {key: String(key), value: parsed};
        throw new Error('injected local inventory copy failure');
      }
      return await originalSet(key, value);
    };
    const event = {char:partial.f.character, chat:partial.f.chat, characterIndex:0, chatIndex:0, messageIndex:1};
    listener(event);
    // W05: observe the actual known-record fault, not an obsolete receipt diagnostic.
    await waitFor(() => faultHits === 1
      && partial.f.r.api.getCaptureBackendState().lastOutputCapture?.receiptStatus === 'verified', 10000);
    const active = await captureReceipt(partial, {revision: 1, duplicate: false});
    await waitMicro(partial, active, {revision: 1, duplicate: false});
    assert.equal(partial.f.r.api.getCaptureBackendState().lastOutputCapture.inventoryStatus, 'deferred');
    assert.equal(faultHits, 1);
    assert.equal(failLocal, false);
    assert.equal(records(partial.storedRows()).length, 1, 'server retains its one-sided immutable inventory'); // A23
    assert.equal(heads(partial.storedRows()).length, 0, 'no head is published before both copies pass readback'); // A24
    assert.equal(records(localRows(partial.local)).length, 0); // A25
    assert.equal(heads(localRows(partial.local)).length, 0);
    const survivor = plain(records(partial.storedRows())[0]);
    assert.equal(survivor.key, rejectedCopy.key);
    assert.deepEqual(survivor.value, rejectedCopy.value);
    assert.equal(survivor.value.receiptKey, active.receiptKey);
    assert.equal(survivor.value.revisionId, active.receipt.revisionId);
    assert.equal(survivor.value.sourceDigest, active.receipt.sourceDigest);
    assert.equal(survivor.value.status, 'known_mentions_only');
    assert.equal(inventoryReady(stores(partial), 'mirror', active), false, 'a one-sided record with no heads is not ready');
    const absent = plain(await partial.f.r.api.debugReadPersonSpanInventory(1));
    assert.equal(absent.status, 'missing');
    assert.equal(absent.reason, 'inventory_head_absent');
    await assertFallback(partial, 'mirror', active);
    assert.equal(partial.f.control.calls.length, 1, 'the failed optional inventory does not block the first Micro attempt');
    partial.backend.setItem = originalSet;

    listener(event);
    const duplicateMarker = {revision: 1, duplicate: true};
    // W06: require this duplicate receipt, followed by real exact-copy repair.
    await waitFor(() => outputReady(partial.f.r.api.getCaptureBackendState(), active, duplicateMarker), 10000);
    const repaired = await waitInventory(partial, 'mirror', active);
    // W07: the old turn1 publication is insufficient while the duplicate job is queued.
    await waitMicro(partial, active, duplicateMarker);
    assert.deepEqual(records(localRows(partial.local))[0].value, records(partial.storedRows())[0].value); // A26
    assert.deepEqual(heads(localRows(partial.local))[0].value, heads(partial.storedRows())[0].value); // A27
    for (const rows of [localRows(partial.local), partial.storedRows()]) {
      assert.equal(records(rows).length, 1);
      assert.equal(heads(rows).length, 1);
      assert.equal(records(rows)[0].key, survivor.key);
      assert.deepEqual(records(rows)[0].value, survivor.value);
    }
    assert.equal(repaired.record.key, survivor.key);
    assert.equal(faultHits, 1, 'repair never repeats the one-shot injection');
    readinessWitnesses(partial, 'mirror', active, duplicateMarker);
    assert.equal(partial.f.control.calls.length, 1, 'inventory repair does not add a second Micro call'); // A28
    console.log('PASS one-sided mirror known inventory repairs by duplicate without another Micro call');
  } finally {
    partial.backend.setItem = originalSet;
    await partial.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
