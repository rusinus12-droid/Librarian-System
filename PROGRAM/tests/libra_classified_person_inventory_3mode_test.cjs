'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const localRows = values => [...values].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});
const rowsWith = (rows, schema) => rows.filter(row => row.value?.schema === schema);
const envelopeFor = (receipt, validMicro = true) => {
  const quote = receipt.assistant.text.slice(0, Math.min(50, receipt.assistant.text.length));
  return {type: 'success', result: JSON.stringify({
    schema: 'libra.micro_producer_envelope.v1',
    personCandidates: {spans: [{role: 'user', startOffset: 0, endOffset: 2,
      exactQuote: '민아', name: '민아', personType: 'person'}], relations: []},
    micro: {schema: 'libra.micro_memory.v1', scopeKey: receipt.scopeKey,
      worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
      turn: receipt.turn, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
      claims: validMicro ? [{changeKind: 'event', text: '한 턴의 장면', actor: '', target: '',
        temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
        stateChangeType: 'none', evidence: {role: 'assistant', messageId: receipt.assistant.chatId,
          startOffset: 0, endOffset: quote.length, exactQuote: quote}}] : []}
  })};
};
const relationEnvelopeFor = receipt => {
  const envelope = JSON.parse(envelopeFor(receipt).result);
  const text = receipt.user.text;
  const first = text.indexOf('민아'), second = text.indexOf('지호');
  assert.ok(first >= 0 && second >= 0);
  envelope.personCandidates = {
    spans: [
      {role: 'user', startOffset: first, endOffset: first + 2,
        exactQuote: '민아', name: '민아', personType: 'person'},
      {role: 'user', startOffset: second, endOffset: second + 2,
        exactQuote: '지호', name: '지호', personType: 'person'}
    ],
    relations: [{subjectCandidateIndex: 0, targetCandidateIndex: 1,
      evidence: {role: 'user', startOffset: 0, endOffset: text.length, exactQuote: text}}]
  };
  return {type: 'success', result: JSON.stringify(envelope)};
};

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
      const registryBefore = (mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local))
        .filter(row => row.key.endsWith(':entity-registry:v2')).map(row => row.value);
      f.control.onCall = async () => envelopeFor(
        (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt);
      const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
      listener(event);
      await waitFor(() => {
        const rows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
        const classified = rowsWith(rows, 'libra.person_span_inventory.v1')
          .find(row => row.value.status === 'classified_candidates');
        return classified && rowsWith(rows, 'libra.person_span_inventory_head.v1')[0]?.value.inventoryKey === classified.key;
      }, 15000);
      const active = await f.r.api.debugReadPersonSpanInventory(1);
      assert.equal(active.status, 'verified', `${mode}: classified inventory passes readback`);
      assert.equal(active.inventory.status, 'classified_candidates');
      const novel = active.inventory.spans.find(span => span.exactQuote === '민아');
      assert.ok(novel, `${mode}: source-bound person candidate survives`);
      assert.equal(novel.messageId, (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt.user.chatId);
      assert.equal(novel.resolution, 'unresolved_candidate', 'model mention is not identity approval');
      assert.deepEqual((mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local))
        .filter(row => row.key.endsWith(':entity-registry:v2')).map(row => row.value), registryBefore,
      'person discovery does not mutate the Entity Registry');
      assert.equal(f.control.calls.length, 1, 'Micro and novel-person discovery use one model job');
      const local = localRows(fixture.local), remote = fixture.storedRows();
      if (mode === 'mirror') {
        for (const schema of ['libra.person_span_inventory.v1', 'libra.person_span_inventory_head.v1']) {
          const classified = rowsWith(local, schema).find(row => schema.includes('_head')
            || row.value.status === 'classified_candidates');
          assert.deepEqual(classified.value, rowsWith(remote, schema).find(row => row.key === classified.key).value);
        }
      }
      listener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastOutputCapture?.duplicate === true, 10000);
      assert.equal((await f.r.api.debugReadPersonSpanInventory(1)).inventory.status,
        'classified_candidates', 'known-only duplicate publication cannot downgrade classified discovery');
      assert.equal(f.control.calls.length, 1, 'duplicate event does not repeat person discovery');
      const firstRevision = active.inventory.revisionId;
      f.chat.message[1].data += ' 편집된 완료 응답.';
      listener(event);
      await waitFor(() => {
        const rows = mode === 'server_only' ? fixture.storedRows() : localRows(fixture.local);
        const head = rowsWith(rows, 'libra.person_span_inventory_head.v1')[0]?.value;
        const record = rows.find(row => row.key === head?.inventoryKey)?.value;
        return record?.status === 'classified_candidates' && record.revisionId !== firstRevision;
      }, 15000);
      const edited = await f.r.api.debugReadPersonSpanInventory(1);
      assert.equal(edited.status, 'verified');
      assert.notEqual(edited.inventory.revisionId, firstRevision,
        `${mode}: edited source alone owns the active classified inventory`);
      assert.equal(f.control.calls.length, 2, 'edited source receives one new shared model job');
      console.log(`PASS durable classified person inventory in ${mode}`);
    } finally { await fixture.cleanup(); }
  }

  let listener;
  const partial = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { listener = handler; return true; }
  }});
  try {
    partial.f.chat.message = partial.f.chat.message.slice(0, 2);
    partial.f.chat.messages = partial.f.chat.message;
    partial.f.control.onCall = async () => envelopeFor(
      (await partial.f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt, false);
    listener({char: partial.f.character, chat: partial.f.chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => {
      const rows = localRows(partial.local);
      const classified = rowsWith(rows, 'libra.person_span_inventory.v1')
        .find(row => row.value.status === 'classified_candidates');
      return classified && rowsWith(rows, 'libra.person_span_inventory_head.v1')[0]?.value.inventoryKey === classified.key;
    }, 15000);
    assert.equal((await partial.f.r.api.debugReadPersonSpanInventory(1)).status, 'verified');
    assert.equal((await partial.f.r.api.debugReadActiveMicroMemory(1)).record.analysisStatus,
      'minimum_source_bound', 'invalid Micro candidate does not erase valid person discovery');
    console.log('PASS classified person discovery survives invalid Micro candidate');
  } finally { await partial.cleanup(); }

  for (const failedKeyKind of ['record', 'head']) {
    let faultListener;
    const faulty = await serverFixture({mode: 'mirror', host: {
      addRisuChatListener: async (_kind, handler) => { faultListener = handler; return true; }
    }});
    try {
      const {f} = faulty;
      f.chat.message = f.chat.message.slice(0, 2);
      f.chat.messages = f.chat.message;
      f.control.onCall = async () => envelopeFor(
        (await f.r.api.debugReadActiveCompletedTurnReceipt(1)).receipt);
      const originalSet = faulty.backend.setItem;
      let failLocal = true;
      faulty.backend.setItem = async (key, value) => {
        const classifiedRecord = failedKeyKind === 'record'
          && String(key).includes(':person-span-inventory:')
          && JSON.parse(value).status === 'classified_candidates';
        const classifiedHead = failedKeyKind === 'head'
          && String(key).includes(':person-span-inventory-head:')
          && localRows(faulty.local).find(row => row.key === JSON.parse(value).inventoryKey)
            ?.value.status === 'classified_candidates';
        if (failLocal && (classifiedRecord || classifiedHead)) {
          failLocal = false;
          throw new Error(`injected local classified inventory ${failedKeyKind} failure`);
        }
        return originalSet(key, value);
      };
      const event = {char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1};
      faultListener(event);
      await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.personInventoryStatus === 'pending_reconciliation', 15000);
      assert.equal(f.control.calls.length, 1);
      faultListener(event);
      await waitFor(() => {
        const rows = localRows(faulty.local);
        const head = rowsWith(rows, 'libra.person_span_inventory_head.v1')[0]?.value;
        return rows.find(row => row.key === head?.inventoryKey)?.value.status === 'classified_candidates';
      }, 15000);
      assert.equal((await f.r.api.debugReadPersonSpanInventory(1)).status, 'verified');
      assert.equal(f.control.calls.length, 1, 'storage-only repair reuses person discovery result');
      console.log(`PASS one-sided classified inventory ${failedKeyKind} repairs without model replay`);
    } finally { await faulty.cleanup(); }
  }

  let canonicalListener;
  const canonical = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { canonicalListener = handler; return true; }
  }});
  try {
    const {f} = canonical;
    const canonicalPrompts = [];
    f.control.onCall = async args => {
      if (JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT')) {
        const match = JSON.stringify(args).match(/\\\"turn\\\":(\d+)/);
        const turn = match ? Number(match[1]) : 1;
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(turn);
        return active.status === 'verified' ? envelopeFor(active.receipt) : {type:'error', result:'source_not_ready'};
      }
      canonicalPrompts.push(JSON.stringify(args));
      return {type: 'success', result: JSON.stringify(f.control.artifact)};
    };
    canonicalListener({char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await waitFor(() => {
      const rows = localRows(canonical.local);
      const classified = rowsWith(rows, 'libra.person_span_inventory.v1')
        .find(row => row.value.status === 'classified_candidates' && row.value.turn === 1);
      return classified && rowsWith(rows, 'libra.person_span_inventory_head.v1')
        .some(row => row.value.turn === 1 && row.value.inventoryKey === classified.key);
    }, 15000);
    assert.equal((await f.run()).completed, 1);
    assert.ok(canonicalPrompts.some(prompt => prompt.includes('SOURCE-BOUND PERSON CANDIDATES')
      && prompt.includes('unresolved_candidate')),
    'five-turn Canonical receives verified novel mentions even before Registry admission');
    console.log('PASS Canonical consumes classified source mentions without identity admission');
  } finally { await canonical.cleanup(); }

  let relationListener;
  const relation = await serverFixture({mode: 'plugin_only', host: {
    addRisuChatListener: async (_kind, handler) => { relationListener = handler; return true; }
  }});
  try {
    const {f} = relation;
    const canonicalPrompts = [];
    let deliveredT2 = false;
    f.control.onCall = async args => {
      if (JSON.stringify(args).includes('LIBRA MICRO SOURCE CONTRACT')) {
        const active = await f.r.api.debugReadActiveCompletedTurnReceipt(2);
        if (!deliveredT2 && active.status === 'verified') {
          deliveredT2 = true;
          return relationEnvelopeFor(active.receipt);
        }
        return {type: 'error', result: 'other_micro_unavailable'};
      }
      canonicalPrompts.push(JSON.stringify(args));
      return {type: 'success', result: JSON.stringify(f.control.artifact)};
    };
    relationListener({char: f.character, chat: f.chat,
      characterIndex: 0, chatIndex: 0, messageIndex: 3});
    await waitFor(() => {
      const rows = localRows(relation.local);
      const head = rowsWith(rows, 'libra.person_span_inventory_head.v1')
        .find(row => row.value.turn === 2)?.value;
      return rows.find(row => row.key === head?.inventoryKey)?.value.relations.length === 1;
    }, 15000);
    const classified = await f.r.api.debugReadPersonSpanInventory(2);
    assert.equal(classified.status, 'verified');
    assert.equal(classified.inventory.relations[0].status, 'candidate_only');
    assert.equal((await f.run()).completed, 1);
    assert.ok(canonicalPrompts.some(prompt => prompt.includes('SOURCE-BOUND PERSON CANDIDATES')
      && prompt.includes('relations') && prompt.includes('candidate_only')
      && prompt.includes('민아') && prompt.includes('지호')),
    'Canonical receives both source-bound relationship endpoints as candidates only');
    console.log('PASS Canonical receives source-bound relationship candidates with both endpoints');
  } finally { await relation.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
