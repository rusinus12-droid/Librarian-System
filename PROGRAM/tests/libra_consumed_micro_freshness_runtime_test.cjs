'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const { choices, shadow, generated } = require('./fixtures/libra_consumer_test_support.cjs');

const DETAIL = '도서관 전체는 정숙 구역';
const REQUEST = '도서관의 정숙 규칙을 고려해서 이어줘.';
const BRIEF = '도서관 전체가 정숙 구역이라는 완료된 장면 근거를 고려한다. 민아는 현재 요청에 답하면서 조용한 행동을 선택할 수 있다. 다만 다음 사건이 이미 일어났다고 가정하지 않고 사용자의 선택을 남겨 둔다.';
const expose = source => source
  .replace('      debugApplyDraftPatchOperations: (draftValue, edits = []) =>',
    `      microRecoveryProofProbe: token => ({ count: consumedDataReadSets.get(token)?.proofs.length || 0, verify: () => assertConsumedDataCurrent(token) }),
      microRecoveryResealContext: value => { value.contextDigest = digest(unifiedResponseContextBody(value)); return value; },
      microRecoveryResealSnapshot: value => {
        const identity = clone(value.identity); delete identity.authorityDigest;
        value.authorityDigest = digest(stableReferenceJson({ identity, authorityProjection: value.manifest,
          requestProjection: value.requestManifest, worldline: value.worldline,
          transcriptProjection: value.transcript, stateAuthority: value.stateAuthority,
          directionProjection: value.narrativeDirection }));
        value.identity.authorityDigest = value.authorityDigest;
        value.identityDigest = digest(stableReferenceJson(value.identity));
        value.sealDigest = digest(stableReferenceJson(inputWriterDeliverySnapshotBody(value)));
        return value;
      },
      debugApplyDraftPatchOperations: (draftValue, edits = []) =>`)
  .replace('  const dispatchLibraInputWriterDelivery =',
    '  globalThis.__MICRO_RECOVERY_PROBE__ = token => LibraMemoryCore.microRecoveryProofProbe(token);\n  globalThis.__MICRO_RECOVERY_RESEAL_CONTEXT__ = value => LibraMemoryCore.microRecoveryResealContext(value);\n  globalThis.__MICRO_RECOVERY_RESEAL__ = value => LibraMemoryCore.microRecoveryResealSnapshot(value);\n  globalThis.__MICRO_RECOVERY_DELIVERY__ = (...args) => dispatchLibraInputWriterDelivery(...args);\n  const dispatchLibraInputWriterDelivery =');

async function withMicro(run, args = {}) {
  let listener;
  const f = await fixture({ transformSource: expose, args: { memory_suite_server_mode: 'plugin_only', ...args }, host: {
    // This fixture has no HTTP/server transport. All model output is synthetic.
    async nativeFetch() { throw new Error('offline_test_network_forbidden'); },
    async addRisuChatListener(_type, handler) { listener = handler; return true; }
  } });
  try {
    f.originalFixtureMessages = f.chat.message.slice();
    f.chat.message = f.chat.message.slice(0, 2); f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      const startOffset = input.assistant.text.indexOf(DETAIL);
      assert(startOffset >= 0, 'Micro must be grounded in actual captured assistant bytes');
      return { type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
        micro: { schema: 'libra.micro_memory.v1', ...input.binding, claims: [{
          changeKind: 'world', text: `${DETAIL}이다.`, actor: '', target: '도서관',
          temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
          evidence: { role: 'assistant', messageId: input.assistant.messageId,
            startOffset, endOffset: startOffset + DETAIL.length, exactQuote: DETAIL }
        }] }
      }) };
    };
    assert.equal(typeof listener, 'function');
    f.captureOutput = listener;
    listener({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 1, 15000);
    const active = await f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(active.status, 'verified');
    f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(choices('rp')) });
    const prepare = async () => {
      const prepared = await f.r.api.prepareInputWriterEvidence(REQUEST);
      const supplied = Object.values(prepared.evidencePacket.layers).flat().filter(row => row.kind === 'micro');
      assert(supplied.some(row => row.analysisRevisionId === active.record.analysisRevisionId), 'the actual consumed Micro is present');
      return prepared;
    };
    await run(f, active, prepare);
  } finally { await f.r.cleanup(); }
}

async function prepareInherited(f, withTwo = false) {
  if (withTwo) {
    f.chat.message = f.originalFixtureMessages.slice(0, 4); f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      const quote = '오늘 돌려주겠다고 약속했다';
      const startOffset = input.assistant.text.indexOf(quote);
      assert(startOffset >= 0);
      return { type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
        micro: { schema: 'libra.micro_memory.v1', ...input.binding, claims: [{
          changeKind: 'event', text: `${quote}.`, actor: '', target: '열쇠', temporalRole: 'current',
          certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {
            role: 'assistant', messageId: input.assistant.messageId, startOffset,
            endOffset: startOffset + quote.length, exactQuote: quote
          }
        }] }
      }) };
    };
    f.captureOutput({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 3 });
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 2, 15000);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(2)).status, 'verified');
  }
  const portable = f.r.context.__LIBRAPortableMemoryBackup;
  f.chat.message = f.originalFixtureMessages; f.chat.messages = f.chat.message;
  f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
  assert.equal((await f.run()).completed, 1, 'portable archive requires one actual Canonical source');
  f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(choices('rp')) });
  const envelope = await portable.exportCurrentScope();
  const target = { id: 'micro-inherited-target', chatId: 'micro-inherited-target', name: 'Target', message: [] };
  target.messages = target.message;
  f.character.chats.push(target); f.character.chatPage = 1;
  const host = f.r.context.risuai;
  host.getCurrentChatIndex = async () => 1;
  host.getChatFromIndex = async (_char, index) => f.character.chats[index];
  host.getChat = async () => target; host.getCurrentChat = async () => target;
  assert.equal((await portable.importAsPredecessorArchive(envelope)).ok, true);
  const prepared = await f.r.api.prepareInputWriterEvidence(withTwo
    ? '도서관의 정숙 규칙과 오늘 열쇠를 돌려주겠다는 약속을 참고해 이어줘.' : REQUEST);
  const micro = Object.values(prepared.evidencePacket.layers).flat().filter(row => row.kind === 'micro');
  assert(micro.some(row => row.inheritedSessionHistory === true));
  const archives = f.getRecords('libra.micro_handoff_archive.v1');
  assert.equal(archives.length, 1);
  return { prepared, micro, archive: archives[0] };
}

async function prepareStateOnlyMicro(f) {
  f.chat.message = f.originalFixtureMessages; f.chat.messages = f.chat.message;
  f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
  assert.equal((await f.run()).completed, 1);
  f.chat.message.push({ role: 'user', chatId: 't6-u', data: '도서관 정문을 확인한다.' },
    { role: 'assistant', chatId: 't6-a', data: '도서관 정문이 열렸다.' });
  const quote = '도서관 정문이 열렸다';
  f.control.onCall = async args => {
    const input = JSON.parse(args[0].messages[1].content);
    const startOffset = input.assistant.text.indexOf(quote);
    assert(startOffset >= 0);
    return { type: 'success', result: JSON.stringify({
      schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
      micro: { schema: 'libra.micro_memory.v1', ...input.binding, claims: [{
        changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관', temporalRole: 'current',
        certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
        stateIntent: { domain: 'world', target: { entityName: '도서관' }, field: 'doorStatus', operation: 'set', value: '열렸다' },
        evidence: { role: 'assistant', messageId: input.assistant.messageId, startOffset,
          endOffset: startOffset + quote.length, exactQuote: quote }
      }] }
    }) };
  };
  f.captureOutput({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
  await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6
    && f.r.api.getCaptureBackendState().lastMicroPublication?.stateAdmission?.admitted >= 1, 15000);
  const active = await f.r.api.debugReadActiveMicroMemory(6);
  assert.equal(active.status, 'verified');
  const storage = f.r.context.risuai.pluginStorage, originalKeys = storage.keys;
  // A partial host catalog can omit recall rows while direct state reads still
  // succeed. Do not replace or stub the product recall/state engines.
  storage.keys = async () => (await originalKeys()).filter(key => !String(key).includes(':micro-memory-head:'));
  let prepared;
  try { prepared = await f.r.api.prepareInputWriterEvidence('도서관 정문 상태를 반영해서 이어줘.'); }
  finally { storage.keys = originalKeys; }
  const rawMicro = Object.values(prepared.evidencePacket.layers).flat().filter(row => row.kind === 'micro');
  assert.equal(rawMicro.length, 0, 'the raw Micro is actually absent from selected recall layers');
  const library = prepared.evidencePacket.continuity_state.world.find(row => row.name === '도서관');
  assert.equal(library.state.doorStatus, '열렸다', 'the real Micro-derived state is actually supplied');
  assert.match(prepared.evidencePacket.continuity_state_prompt, /열렸다/);
  f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(choices('rp')) });
  return { prepared, active, decisionKey: library.fieldEvidence.doorStatus.decisionKey };
}

test('an unchanged consumed Micro allows Input Writer generation and delivery validation', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, true, result.reason);
    assert.equal((await f.r.api.debugValidateInputWriterDeliverySnapshot(prepared.deliverySnapshot)).current, true);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).record.analysisRevisionId, active.record.analysisRevisionId);
  });
});

test('deleting an already consumed Micro head prevents a new provider submission', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    f.r.values.delete(active.headKey);
    const before = f.control.calls.length;
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false, 'a missing consumed Micro cannot authorize generation');
    assert.equal(f.control.calls.length, before, 'stale evidence is rejected before a model call');
  });
});

test('same-analysis-ID body tampering during provider wait rejects Input Writer results', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    f.control.onCall = async () => {
      const changed = JSON.parse(f.r.values.get(active.recordKey));
      changed.claims[0].text = 'Tampered content under the same analysis revision';
      f.r.values.set(active.recordKey, JSON.stringify(changed));
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false, 'same-ID changed body is not the consumed record');
    assert.notEqual(result.usable, true);
    assert.match(result.reason, /CONSUMER_MICRO_BODY_CHANGED/);
    assert.equal(result.stale, true, 'the UI result explicitly identifies stale evidence');
    assert.equal(result.choices.length, 0);
  });
});

test('same-ID consumed Micro tampering invalidates final Writer insertion before host mutation', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    assert.equal((await f.r.api.debugGenerateInputWriterChoices(prepared)).ok, true);
    const changed = JSON.parse(f.r.values.get(active.recordKey));
    changed.claims[0].text = 'Changed after candidate generation under unchanged analysis ID';
    f.r.values.set(active.recordKey, JSON.stringify(changed));
    let inserted = 0;
    const result = await f.r.context.__MICRO_RECOVERY_DELIVERY__({
      action: 'insert', content: 'User-selected candidate', snapshot: prepared.deliverySnapshot, cycleId: 'micro-final-insert'
    }, {
      validateSnapshot: snapshot => f.r.api.debugValidateInputWriterDeliverySnapshot(snapshot),
      insertText: async () => { inserted++; return { ok: true }; }
    });
    assert.equal(result.accepted, false);
    assert.equal(result.stale, true);
    assert.equal(inserted, 0);
  });
});

test('unrelated Micro keys do not invalidate the actually consumed evidence', async () => {
  await withMicro(async (f, _active, prepare) => {
    const prepared = await prepare();
    f.r.values.set('unrelated:micro-memory:unused', JSON.stringify({ schema: 'libra.micro_memory.v1', analysisRevisionId: 'irrelevant' }));
    assert.equal((await f.r.api.debugGenerateInputWriterChoices(prepared)).ok, true);
    assert.equal((await f.r.api.debugValidateInputWriterDeliverySnapshot(prepared.deliverySnapshot)).current, true);
  });
});

test('final snapshot validation rechecks Micro after supplemental state reads', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    const storage = f.r.context.risuai.pluginStorage;
    const originalGet = storage.getItem;
    let readConsumed = false, changed = false;
    storage.getItem = async key => {
      if (key === active.recordKey) readConsumed = true;
      if (readConsumed && !changed && String(key).endsWith(':manifest')) {
        const tampered = JSON.parse(f.r.values.get(active.recordKey));
        tampered.claims[0].text = 'Changed during the final supplemental state read';
        f.r.values.set(active.recordKey, JSON.stringify(tampered)); changed = true;
      }
      return originalGet(key);
    };
    try {
      const result = await f.r.api.debugValidateInputWriterDeliverySnapshot(prepared.deliverySnapshot);
      assert.equal(changed, true, 'fault reached a state read after the consumed Micro was checked');
      assert.equal(result.current, false);
      assert.match(result.reason, /CONSUMER_MICRO_BODY_CHANGED/);
    } finally { storage.getItem = originalGet; }
  });
});

test('Planner must not inject a result after the consumed Micro head disappears', async () => {
  await withMicro(async (f, active) => {
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'planner' });
    let consumed = false;
    f.control.onCall = async args => {
      assert.match(args[0].messages.map(row => row.content).join('\n'), /Turn Evidence \(Micro\)/);
      consumed = true;
      f.r.values.delete(active.headKey);
      return { type: 'success', result: BRIEF };
    };
    const request = [{ role: 'user', content: REQUEST }];
    const delivered = await f.control.hooks.beforeRequest(request, 'model');
    assert.equal(consumed, true);
    assert.equal(delivered.some(row => String(row.content || '').includes(BRIEF)), false);
    assert(delivered.some(row => row.content === REQUEST), 'main chat request continues');
  });
});

test('a valid 35-second logical Planner response is not rejected by the old search deadline', async () => {
  await withMicro(async (f) => {
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'planner' });
    const RealDate = Date;
    let offset = 0;
    f.r.context.Date = class extends RealDate { static now() { return RealDate.now() + offset; } };
    let consumed = false;
    f.control.onCall = async args => {
      assert.match(args[0].messages.map(row => row.content).join('\n'), /Turn Evidence \(Micro\)/);
      consumed = true; offset = 35000;
      return { type: 'success', result: BRIEF };
    };
    const delivered = await f.control.hooks.beforeRequest([{ role: 'user', content: REQUEST }], 'model');
    assert.equal(consumed, true);
    assert(delivered.some(row => String(row.content || '').includes(BRIEF)), 'valid provider result within consumer hard deadline is delivered');
  });
});

test('public layer edits and a verified flag cannot erase private consumed provenance', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    f.r.values.delete(active.headKey);
    prepared.evidencePacket.layers = { memory: [], entity: [], world: [], narrative: [] };
    prepared.evidencePacket.microAlreadyVerified = true;
    const calls = f.control.calls.length;
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false);
    assert.equal(f.control.calls.length, calls);
  });
});

test('a missing runtime token fails closed instead of trusting public verification fields', async () => {
  await withMicro(async (f, _active, prepare) => {
    const prepared = await prepare();
    delete prepared.evidencePacket.consumed_data_token;
    prepared.evidencePacket.microAlreadyVerified = true;
    const calls = f.control.calls.length;
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false);
    assert.match(result.reason, /CONSUMER_DATA_READSET_UNAVAILABLE/);
    assert.equal(f.control.calls.length, calls);
  });
});

test('a stalled consumed-data read is bounded and starts no model retry', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    const storage = f.r.context.risuai.pluginStorage, originalGet = storage.getItem;
    let release, reached = false;
    const blocked = new Promise(resolve => { release = resolve; });
    storage.getItem = async key => { if (key === active.recordKey) { reached = true; await blocked; } return originalGet(key); };
    const calls = f.control.calls.length, started = Date.now();
    try {
      const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
      assert.equal(reached, true);
      assert.equal(result.ok, false);
      assert.match(result.reason, /CONSUMER_DATA_REVALIDATION_DEADLINE/);
      assert(Date.now() - started < 2500);
      assert.equal(f.control.calls.length, calls);
    } finally { release(); storage.getItem = originalGet; }
  });
});

test('final send preparation cannot outlive a changed consumed Micro', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    let sends = 0, preparedSend = false;
    const result = await f.r.context.__MICRO_RECOVERY_DELIVERY__({
      action: 'send', content: 'Chosen input', snapshot: prepared.deliverySnapshot, cycleId: 'micro-final-send'
    }, {
      validateSnapshot: snapshot => f.r.api.debugValidateInputWriterDeliverySnapshot(snapshot),
      prepareSend: async () => {
        const changed = JSON.parse(f.r.values.get(active.recordKey));
        changed.claims[0].text = 'Changed during asynchronous send preparation';
        f.r.values.set(active.recordKey, JSON.stringify(changed)); preparedSend = true;
        return { ok: true };
      },
      sendChat: async () => { sends++; return true; }
    });
    assert.equal(preparedSend, true);
    assert.equal(result.accepted, false);
    assert.equal(sends, 0);
  });
});

test('a changed chat scope rejects a late Input Writer result', async () => {
  await withMicro(async (f, _active, prepare) => {
    const prepared = await prepare();
    f.control.onCall = async () => {
      f.chat.id = 'different-chat'; f.chat.chatId = 'different-chat';
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false);
    assert.notEqual(result.usable, true);
  });
});

test('inherited archive Micro is checked after provider wait against its physical archive', async () => {
  await withMicro(async (f) => {
    const { prepared, archive } = await prepareInherited(f);
    assert.equal((await f.r.api.debugValidateInputWriterDeliverySnapshot(prepared.deliverySnapshot)).current, true);
    f.control.onCall = async () => {
      f.r.values.delete(archive.key);
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false);
    assert.notEqual(result.usable, true);
    assert.match(result.reason, /MICRO.*ARCHIVE/);
  });
});

test('two consumed Micro records retain separate proofs with one archive read per validation', async () => {
  await withMicro(async f => {
    const { prepared, micro, archive } = await prepareInherited(f, true);
    const used = [...new Set(micro.map(row => row.analysisRevisionId))];
    assert.equal(used.length, 2, 'two distinct archived records actually reach the prompt');
    const probe = f.r.context.__MICRO_RECOVERY_PROBE__(prepared.evidencePacket.consumed_data_token);
    assert.equal(probe.count, 2, 'archive container identity must not collapse consumed record identities');
    const storage = f.r.context.risuai.pluginStorage, originalGet = storage.getItem;
    let archiveReads = 0;
    storage.getItem = async key => { if (key === archive.key) archiveReads++; return originalGet(key); };
    try { await probe.verify(); } finally { storage.getItem = originalGet; }
    assert.equal(archiveReads, 1, 'the full archive is validated once for both records');
    const changed = JSON.parse(f.r.values.get(archive.key));
    const first = changed.records.find(row => row.value.schema === 'libra.micro_memory.v1' && row.value.analysisRevisionId === used[0]);
    assert(first); first.value.claims[0].text = 'Changed first consumed archive record';
    f.r.values.set(archive.key, JSON.stringify(changed));
    await assert.rejects(() => probe.verify(), /MICRO.*ARCHIVE/);
  });
});

test('removing an active inherited lineage ref rejects a still-present consumed archive', async () => {
  await withMicro(async f => {
    const { prepared, archive } = await prepareInherited(f, true);
    const manifest = f.getRecords('libra.manifest.v1').find(row => row.value.scopeKey === prepared.scope.scopeKey);
    assert(manifest.value.inheritedMicroArchives.some(ref => ref.archiveKey === archive.key));
    manifest.value.inheritedMicroArchives = manifest.value.inheritedMicroArchives.filter(ref => ref.archiveKey !== archive.key);
    f.r.values.set(manifest.key, JSON.stringify(manifest.value));
    assert(f.r.values.has(archive.key), 'physical bytes remain; only active lineage changed');
    await assert.rejects(() => f.r.context.__MICRO_RECOVERY_PROBE__(prepared.evidencePacket.consumed_data_token).verify(), /CONSUMER_MICRO_ARCHIVE_UNBOUND/);
  });
});

test('consumer hard deadline still rejects an over-budget logical provider response', async () => {
  await withMicro(async (f) => {
    await f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'planner' });
    const RealDate = Date; let offset = 0, called = false;
    f.r.context.Date = class extends RealDate { static now() { return RealDate.now() + offset; } };
    f.control.onCall = async () => { called = true; offset = 10000; return { type: 'success', result: BRIEF }; };
    const delivered = await f.control.hooks.beforeRequest([{ role: 'user', content: REQUEST }], 'model');
    assert.equal(called, true);
    assert.equal(delivered.some(row => String(row.content || '').includes(BRIEF)), false);
    assert(delivered.some(row => row.content === REQUEST));
  }, { response_consumer_policy: JSON.stringify({ schema: 'libra.response_consumer_policy.v1', operationTimeoutMs: 5000 }) });
});

test('a same-scope logical worldline switch invalidates the prepared Writer snapshot', async () => {
  await withMicro(async (f, _active, prepare) => {
    const prepared = await prepare();
    const changed = await f.r.api.setWorldManagerWorldline({ worldlineId: 'micro-recovery-fork', parentId: 'main' });
    assert.equal(changed.ok, true);
    const checked = await f.r.api.debugValidateInputWriterDeliverySnapshot(prepared.deliverySnapshot);
    assert.equal(checked.current, false);
  });
});

test('state-only Micro body mutation invalidates a provider result even without a recalled Micro row', async () => {
  await withMicro(async f => {
    const { prepared, active } = await prepareStateOnlyMicro(f);
    let providerReturned = false;
    f.control.onCall = async () => {
      const changed = JSON.parse(f.r.values.get(active.recordKey));
      changed.claims[0].text = 'Mutated state-only Micro under unchanged analysis ID';
      f.r.values.set(active.recordKey, JSON.stringify(changed));
      providerReturned = true;
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(providerReturned, true, 'the mutation occurred during the provider await');
    assert.equal(result.ok, false);
    assert.match(result.reason, /CONSUMER_MICRO_BODY_CHANGED/);
  });
});

test('state-only admission decision mutation invalidates a provider result', async () => {
  await withMicro(async f => {
    const { prepared, decisionKey } = await prepareStateOnlyMicro(f);
    assert(decisionKey && f.r.values.has(decisionKey));
    let providerReturned = false;
    f.control.onCall = async () => {
      f.r.values.delete(decisionKey);
      providerReturned = true;
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(providerReturned, true, 'the used decision was revoked during the provider await');
    assert.equal(result.ok, false);
    assert.match(result.reason, /CONSUMER_MICRO_STATE_DEPENDENCY_CHANGED/);
  });
});

test('an unreferenced admission-record change does not invalidate consumed state', async () => {
  await withMicro(async f => {
    const { prepared, decisionKey } = await prepareStateOnlyMicro(f);
    const unusedKey = `${decisionKey}:unreferenced-basis`;
    f.r.values.set(unusedKey, f.r.values.get(decisionKey));
    let providerReturned = false;
    f.control.onCall = async () => {
      f.r.values.delete(unusedKey); providerReturned = true;
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(providerReturned, true);
    assert.equal(result.ok, true, result.reason);
    assert(f.r.values.has(decisionKey), 'the actual consumed admission remains unchanged');
  });
});


test('inherited state admission is rechecked after provider await', async () => {
  await withMicro(async f => {
    await prepareStateOnlyMicro(f);
    const portable = f.r.context.__LIBRAPortableMemoryBackup;
    const envelope = await portable.exportCurrentScope();
    const target = { id: 'state-inherited-target', chatId: 'state-inherited-target', name: 'Target', message: [] };
    target.messages = target.message;
    f.character.chats.push(target); f.character.chatPage = 1;
    const host = f.r.context.risuai;
    host.getCurrentChatIndex = async () => 1;
    host.getChatFromIndex = async (_char, index) => f.character.chats[index];
    host.getChat = async () => target; host.getCurrentChat = async () => target;
    assert.equal((await portable.importAsPredecessorArchive(envelope)).ok, true);
    const prepared = await f.r.api.prepareInputWriterEvidence('도서관 정문 상태를 반영해서 이어줘.');
    const library = prepared.evidencePacket.continuity_state.world.find(row => row.name === '도서관');
    assert.equal(library.state.doorStatus, '열렸다', 'inherited state actually reaches the consumer');
    const evidence = library.fieldEvidence.doorStatus;
    assert(evidence.archiveKey, 'the supplied state is from the inherited Micro archive');
    assert(evidence.decisionKey && f.r.values.has(evidence.decisionKey));
    assert.equal((await f.r.api.debugGenerateInputWriterChoices(prepared)).ok, true, 'unchanged inherited state is valid');
    let providerReturned = false;
    f.control.onCall = async () => {
      const changed = JSON.parse(f.r.values.get(evidence.decisionKey));
      changed.status = 'superseded';
      f.r.values.set(evidence.decisionKey, JSON.stringify(changed));
      providerReturned = true;
      return { type: 'success', result: JSON.stringify(choices('rp')) };
    };
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(providerReturned, true);
    assert.equal(result.ok, false);
    assert.match(result.reason, /CONSUMER_MICRO_STATE_DEPENDENCY_CHANGED/);
  });
});


for (const mutate of [false, true]) {
  test(`GRADIA ${mutate ? 'rejects a changed' : 'delivers an unchanged'} consumed Micro after provider await`, async () => {
    await withMicro(async (f, active) => {
      await f.r.api.saveLibraProviderConfig({ responseFamily: 'gradia',
        enableSgaShadow: true, enableSgaCharacterAide: false, enableSgaWorldAide: false, enableSgaPlotAide: false,
        sgaSemanticValidationEnabled: false, targetDraftMinChars: 100, targetDraftMaxChars: 1000 });
      let providerReturned = false;
      f.control.onCall = async args => {
        const options = args[0];
        assert(JSON.stringify(options.messages).includes(DETAIL), 'actual GRADIA prompt consumes the Micro evidence');
        if (mutate) {
          const changed = JSON.parse(f.r.values.get(active.recordKey));
          changed.claims[0].text = 'Micro changed during GRADIA provider await';
          f.r.values.set(active.recordKey, JSON.stringify(changed));
        }
        providerReturned = true;
        const output = JSON.stringify(options.messages).includes('Return the bounded private analysis JSON now.')
          ? generated(options) : shadow(BRIEF);
        return { type: 'success', result: JSON.stringify(output) };
      };
      const delivered = await f.control.hooks.beforeRequest([{ role: 'user', content: REQUEST }], 'model');
      assert.equal(providerReturned, true);
      assert.equal(delivered.some(row => String(row.content || '').includes(BRIEF)), !mutate);
      assert(delivered.some(row => row.content === REQUEST));
    });
  });
}


test('a different same-scope token cannot replace the prepared consumed evidence', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    const unrelatedContext = await f.r.api.getResponseContext({ currentInput: '별도 상태 확인' });
    assert(unrelatedContext.consumedDataToken);
    assert.notEqual(unrelatedContext.consumedDataToken, prepared.evidencePacket.consumed_data_token);
    prepared.evidencePacket.consumed_data_token = unrelatedContext.consumedDataToken;
    const changed = JSON.parse(f.r.values.get(active.recordKey));
    changed.claims[0].text = 'Changed Micro must not be hidden by an unrelated valid token';
    f.r.values.set(active.recordKey, JSON.stringify(changed));
    const before = f.control.calls.length;
    const result = await f.r.api.debugGenerateInputWriterChoices(prepared);
    assert.equal(result.ok, false);
    assert.equal(f.control.calls.length, before, 'mismatched provenance must reject before provider submission');
  });
});


test('a cloned Writer snapshot remains valid but a foreign token with recomputed public digests does not', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    const snapshot = JSON.parse(JSON.stringify(prepared.deliverySnapshot));
    const reseal = f.r.context.__MICRO_RECOVERY_RESEAL__;
    const originalSeal = snapshot.sealDigest;
    assert.equal(reseal(snapshot).sealDigest, originalSeal, 'test recomputation exactly reproduces the issued public seal');
    assert.equal((await f.r.api.debugValidateInputWriterDeliverySnapshot(snapshot)).current, true);
    const unrelated = await f.r.api.getResponseContext({ currentInput: '별도 상태 확인' });
    snapshot.consumedDataToken = unrelated.consumedDataToken;
    snapshot.identity.consumedDataToken = unrelated.consumedDataToken;
    reseal(snapshot);
    const changed = JSON.parse(f.r.values.get(active.recordKey));
    changed.claims[0].text = 'Changed Micro must not authorize final insertion through another snapshot token';
    f.r.values.set(active.recordKey, JSON.stringify(changed));
    const checked = await f.r.api.debugValidateInputWriterDeliverySnapshot(snapshot);
    assert.equal(checked.current, false);
  });
});


test('response context rejects a foreign token even when its public digest is recomputed', async () => {
  await withMicro(async (f, active, prepare) => {
    const prepared = await prepare();
    const snapshot = JSON.parse(JSON.stringify(prepared.evidencePacket.response_context));
    assert.equal((await f.r.api.validateResponseContext(snapshot)).current, true);
    const unrelated = await f.r.api.getResponseContext({ currentInput: '별도 상태 확인' });
    snapshot.consumedDataToken = unrelated.consumedDataToken;
    f.r.context.__MICRO_RECOVERY_RESEAL_CONTEXT__(snapshot);
    const changed = JSON.parse(f.r.values.get(active.recordKey));
    changed.claims[0].text = 'Changed Micro must not be hidden by a resealed foreign context token';
    f.r.values.set(active.recordKey, JSON.stringify(changed));
    assert.equal((await f.r.api.validateResponseContext(snapshot)).current, false);
  });
});


for (const kind of ['response context', 'Writer snapshot']) {
  test(`removing provenance and recomputing the public ${kind} seal cannot regain delivery authority`, async () => {
    await withMicro(async (f, _active, prepare) => {
      const prepared = await prepare();
      if (kind === 'response context') {
        const context = JSON.parse(JSON.stringify(await f.r.api.getResponseContext({ currentInput: '상태 확인' })));
        delete context.consumedDataToken;
        f.r.context.__MICRO_RECOVERY_RESEAL_CONTEXT__(context);
        assert.equal((await f.r.api.validateResponseContext(context)).current, false, 'issued read-only context requires runtime provenance');
      } else {
        const snapshot = JSON.parse(JSON.stringify(prepared.deliverySnapshot));
        delete snapshot.consumedDataToken; delete snapshot.identity.consumedDataToken;
        snapshot.consumerReadSet = null; delete snapshot.identity.consumerReadSetDigest;
        f.r.context.__MICRO_RECOVERY_RESEAL__(snapshot);
        assert.equal((await f.r.api.debugValidateInputWriterDeliverySnapshot(snapshot)).current, false,
          'removing the read set cannot turn an issued Writer snapshot into a legacy trusted snapshot');
      }
    });
  });
}
