'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
// Current successor: private consumed-data provenance, public ResponseContext
// and the actual Classic final request boundary. Retired Writer/Planner/GRADIA
// provider generation and host insertion are intentionally not emulated.

const DETAIL = '도서관 전체는 정숙 구역';
const REQUEST = '도서관의 정숙 규칙을 고려해서 이어줘.';
const expose = source => {
  const core = '      debugReadActiveCompletedTurnReceipt: async turnValue => {';
  assert.ok(source.includes(core));
  source = source.replace(core, `      microProofProbe: token => ({ count: (consumedDataReadSets.get(token)?.proofs || []).filter(proof => !proof.kind).length, verify: () => assertConsumedDataCurrent(token) }),
      microResealContext: value => { value.contextDigest = digest(unifiedResponseContextBody(value)); return value; },
` + core);
  const api = "    debugBuildPairs(chat = {}, cacheKey = '')";
  assert.ok(source.includes(api));
  return source.replace(api, `    microProofProbe(token) { return LibraMemoryCore.microProofProbe(token); },
    microResealContext(value) { return LibraMemoryCore.microResealContext(value); },
` + api);
};
const blockOf = messages => messages.filter(row => row.role === 'system' &&
  String(row.content || '').includes('[LIBRA CLASSIC RECALL')).map(row => row.content).join('\n');
async function prepareClassic(f, query = REQUEST) {
  const calls = f.control.calls.length;
  const messages = await f.control.hooks.beforeRequest([{ role: 'user', content: query }], 'model');
  const context = f.r.api.getLastResponseContext();
  assert.equal(context.route, 'classic');
  assert.equal((await f.r.api.validateResponseContext(context)).current, true);
  assert.equal(f.control.calls.length, calls, 'actual Classic recall has no provider call');
  assert.ok(blockOf(messages), 'the actual request contains delivered evidence');
  return context;
}

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
    f.control.onCall = async () => { throw new Error('Classic must not invoke a drafting provider'); };
    const prepare = async () => {
      const prepared = await prepareClassic(f);
      const supplied = Object.values(prepared.values.canonicalLayers).flat().filter(row => row.kind === 'micro');
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
  f.control.onCall = async () => { throw new Error('Classic must not invoke a drafting provider'); };
  const envelope = await portable.exportCurrentScope();
  const target = { id: 'micro-inherited-target', chatId: 'micro-inherited-target', name: 'Target', message: [] };
  target.messages = target.message;
  f.character.chats.push(target); f.character.chatPage = 1;
  const host = f.r.context.risuai;
  host.getCurrentChatIndex = async () => 1;
  host.getChatFromIndex = async (_char, index) => f.character.chats[index];
  host.getChat = async () => target; host.getCurrentChat = async () => target;
  assert.equal((await portable.importAsPredecessorArchive(envelope)).ok, true);
  const prepared = await prepareClassic(f, withTwo
    ? '도서관의 정숙 규칙과 오늘 열쇠를 돌려주겠다는 약속을 참고해 이어줘.' : REQUEST);
  const micro = Object.values(prepared.values.canonicalLayers).flat().filter(row => row.kind === 'micro');
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
  try { prepared = await f.r.api.getResponseContext({ currentInput: '도서관 정문 상태를 반영해서 이어줘.' }); }
  finally { storage.keys = originalKeys; }
  const rawMicro = Object.values(prepared.values.canonicalLayers).flat().filter(row => row.kind === 'micro');
  assert.equal(rawMicro.length, 0, 'the raw Micro is actually absent from selected recall layers');
  const library = prepared.values.currentHead.world.find(row => row.name === '도서관');
  assert.equal(library.state.doorStatus, '열렸다', 'the real Micro-derived state is actually supplied');
  assert.equal((await f.r.api.validateResponseContext(prepared)).current, true);
  f.control.onCall = async () => { throw new Error('Classic must not invoke a drafting provider'); };
  return { prepared, active, decisionKey: library.fieldEvidence.doorStatus.decisionKey };
}

const mutateBody = (f, active) => {
  const changed = JSON.parse(f.r.values.get(active.recordKey));
  changed.claims[0].text = 'Changed body under the identical analysisRevisionId';
  f.r.values.set(active.recordKey, JSON.stringify(changed));
};
const invalid = async (f, context, pattern) => {
  const calls = f.control.calls.length;
  const result = await f.r.api.validateResponseContext(context);
  assert.equal(result.current, false, JSON.stringify(result));
  if (pattern) assert.match(result.reason, pattern);
  assert.equal(f.control.calls.length, calls, 'validation cannot spend a provider call');
  return result;
};

test('unchanged consumed Micro is delivered by Classic and a cloned context validates', async () => {
  await withMicro(async (f, active, prepare) => {
    const context = await prepare();
    assert.equal((await f.r.api.validateResponseContext(clone(context))).current, true);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).record.analysisRevisionId, active.record.analysisRevisionId);
    for (const api of ['prepareInputWriterEvidence', 'debugGenerateInputWriterChoices', 'debugValidateInputWriterDeliverySnapshot']) {
      assert.equal(typeof f.r.api[api], 'undefined', `${api} remains retired`);
    }
  });
});
for (const mutation of ['head_deleted', 'body_changed']) {
  test(`${mutation}: issued actual Classic context loses delivery authority`, async () => {
    await withMicro(async (f, active, prepare) => {
      const context = await prepare();
      if (mutation === 'head_deleted') f.r.values.delete(active.headKey); else mutateBody(f, active);
      await invalid(f, context, /CONSUMER_MICRO/);
    });
  });
}

test('unrelated Micro bytes do not invalidate the actually consumed record', async () => {
  await withMicro(async (f, active, prepare) => {
    const context = await prepare();
    f.r.values.set('unrelated:micro-memory:unused', JSON.stringify({ analysisRevisionId: 'irrelevant' }));
    assert.equal((await f.r.api.validateResponseContext(context)).current, true);
    assert.ok(f.r.values.has(active.recordKey));
  });
});

// Unlike the old synthetic drafting callback, these faults cross the shipped
// final injection boundary after its request-local context has been sealed.
for (const mutation of ['head_deleted', 'head_replaced', 'head_corrupt', 'head_read_error', 'receipt_changed', 'body_changed', 'scope_changed']) {
  test(`${mutation}: final actual Classic read leaves the host request unchanged`, async () => {
    await withMicro(async (f, active, prepare) => {
      const prior = await prepare();
      const storage = f.r.context.risuai.pluginStorage, originalGet = storage.getItem;
      let reached = false;
      storage.getItem = async key => {
        const current = f.r.api.getLastResponseContext();
        if (!reached && current?.route === 'classic' && current.requestId !== prior.requestId && key === active.recordKey) {
          reached = true;
          if (mutation === 'head_deleted') f.r.values.delete(active.headKey);
          else if (mutation === 'head_replaced') {
            const head = JSON.parse(f.r.values.get(active.headKey)); head.analysisRevisionId += ':replaced';
            f.r.values.set(active.headKey, JSON.stringify(head));
          } else if (mutation === 'head_corrupt') f.r.values.set(active.headKey, '{broken-json');
          else if (mutation === 'receipt_changed') {
            const receipt = JSON.parse(f.r.values.get(active.record.receiptKey)); receipt.unknownTamperedField = true;
            f.r.values.set(active.record.receiptKey, JSON.stringify(receipt));
          } else if (mutation === 'head_read_error') { /* fail the subsequent physical head read below */ }
          else if (mutation === 'body_changed') mutateBody(f, active);
          else { f.chat.id = 'different-chat'; f.chat.chatId = 'different-chat'; }
        }
        if (reached && mutation === 'head_read_error' && key === active.headKey) throw new Error('injected_final_micro_head_read_failure');
        return originalGet(key);
      };
      const input = [{ role: 'user', content: REQUEST }], calls = f.control.calls.length;
      try {
        const delivered = await f.control.hooks.beforeRequest(input, 'model');
        assert.equal(reached, true, 'fault crossed the final consumed Micro read');
        assert.deepEqual(clone(delivered), input, 'stale evidence cannot reach the response provider');
        assert.equal(f.control.calls.length, calls);
      } finally { storage.getItem = originalGet; }
    });
  });
}

test('a stalled final consumed-data read is bounded and its late result cannot inject', async () => {
  await withMicro(async (f, active, prepare) => {
    const prior = await prepare(), storage = f.r.context.risuai.pluginStorage, originalGet = storage.getItem;
    let reached = false, release;
    const held = new Promise(resolve => { release = resolve; });
    storage.getItem = async key => {
      if (!reached && key === active.recordKey && f.r.api.getLastResponseContext()?.requestId !== prior.requestId) {
        reached = true; await held;
      }
      return originalGet(key);
    };
    const input = [{ role: 'user', content: REQUEST }], calls = f.control.calls.length, started = Date.now();
    try {
      const output = await f.control.hooks.beforeRequest(input, 'model');
      assert.equal(reached, true);
      assert.ok(Date.now() - started < 3000, 'final read has the current bounded recall deadline');
      assert.deepEqual(clone(output), input);
      assert.equal(f.control.calls.length, calls);
      release(); await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(clone(output), input, 'late read cannot mutate returned request');
    } finally { release(); storage.getItem = originalGet; }
  });
});

test('public layer edits and verified flags cannot erase private provenance', async () => {
  await withMicro(async (f, active, prepare) => {
    const context = clone(await prepare());
    f.r.values.delete(active.headKey);
    context.values.canonicalLayers = { memory: [], entity: [], world: [], narrative: [] };
    context.microAlreadyVerified = true;
    f.r.api.microResealContext(context);
    await invalid(f, context, /CONSUMER_DATA/);
  });
});
for (const mutation of ['missing_token', 'foreign_token', 'missing_readsets']) {
  test(`${mutation}: recomputing a public response seal cannot regain runtime authority`, async () => {
    await withMicro(async (f, active, prepare) => {
      const context = clone(await prepare()), originalSeal = context.contextDigest;
      assert.equal(f.r.api.microResealContext(context).contextDigest, originalSeal, 'probe recomputes the genuine digest');
      if (mutation === 'foreign_token') {
        const unrelated = await f.r.api.getResponseContext({ currentInput: 'Independent read-only context' });
        assert.notEqual(unrelated.consumedDataToken, context.consumedDataToken);
        context.consumedDataToken = unrelated.consumedDataToken;
        mutateBody(f, active);
      } else delete context.consumedDataToken;
      if (mutation === 'missing_readsets') { context.consumerReadSet = null; context.receiptReadSet = null; }
      f.r.api.microResealContext(context);
      await invalid(f, context, /CONSUMER_DATA/);
    });
  });
}

test('same-scope logical worldline switch invalidates a prepared current context', async () => {
  await withMicro(async (f, active, prepare) => {
    const context = await prepare();
    assert.equal((await f.r.api.setWorldManagerWorldline({ worldlineId: 'micro-fork', parentId: 'main' })).ok, true);
    await invalid(f, context);
  });
});

for (const mutation of ['archive_deleted', 'archive_body_changed', 'active_ref_removed']) {
  test(`${mutation}: inherited Micro authority binds physical bytes and active lineage`, async () => {
    await withMicro(async f => {
      const { prepared, archive } = await prepareInherited(f, true);
      assert.equal((await f.r.api.validateResponseContext(prepared)).current, true);
      if (mutation === 'archive_deleted') f.r.values.delete(archive.key);
      else if (mutation === 'archive_body_changed') {
        const changed = JSON.parse(f.r.values.get(archive.key));
        changed.records.find(row => row.value.schema === 'libra.micro_memory.v1').value.claims[0].text = 'Changed archived Micro';
        f.r.values.set(archive.key, JSON.stringify(changed));
      } else {
        const manifest = f.getRecords('libra.manifest.v1').find(row => row.value.scopeKey === prepared.scopeKey);
        assert.ok(manifest.value.inheritedMicroArchives.some(ref => ref.archiveKey === archive.key));
        manifest.value.inheritedMicroArchives = manifest.value.inheritedMicroArchives.filter(ref => ref.archiveKey !== archive.key);
        f.r.values.set(manifest.key, JSON.stringify(manifest.value));
        assert.ok(f.r.values.has(archive.key));
      }
      await invalid(f, prepared);
    });
  });
}

test('two consumed inherited Micro identities retain separate proofs with one archive read', async () => {
  await withMicro(async f => {
    const { prepared, micro, archive } = await prepareInherited(f, true);
    assert.equal(new Set(micro.map(row => row.analysisRevisionId)).size, 2);
    const probe = f.r.api.microProofProbe(prepared.consumedDataToken);
    assert.equal(probe.count, 2);
    const storage = f.r.context.risuai.pluginStorage, originalGet = storage.getItem;
    let archiveReads = 0;
    storage.getItem = async key => { if (key === archive.key) archiveReads++; return originalGet(key); };
    try { await probe.verify(); } finally { storage.getItem = originalGet; }
    assert.equal(archiveReads, 1);
    const changed = JSON.parse(f.r.values.get(archive.key));
    changed.records.find(row => row.value.schema === 'libra.micro_memory.v1').value.claims[0].text = 'Changed first consumed identity';
    f.r.values.set(archive.key, JSON.stringify(changed));
    await assert.rejects(() => probe.verify(), /MICRO.*ARCHIVE/);
  });
});

for (const mutation of ['body_changed', 'decision_deleted', 'unreferenced_decision']) {
  test(`${mutation}: state-only Micro provenance is validated without a selected recall row`, async () => {
    await withMicro(async f => {
      const { prepared, active, decisionKey } = await prepareStateOnlyMicro(f);
      assert.ok(decisionKey && f.r.values.has(decisionKey));
      if (mutation === 'body_changed') mutateBody(f, active);
      else if (mutation === 'decision_deleted') f.r.values.delete(decisionKey);
      else {
        const unused = decisionKey + ':unused';
        f.r.values.set(unused, f.r.values.get(decisionKey)); f.r.values.delete(unused);
      }
      if (mutation === 'unreferenced_decision') assert.equal((await f.r.api.validateResponseContext(prepared)).current, true);
      else await invalid(f, prepared, /CONSUMER_MICRO/);
    });
  });
}

test('inherited state admission revocation invalidates a read-only state context', async () => {
  await withMicro(async f => {
    await prepareStateOnlyMicro(f);
    const portable = f.r.context.__LIBRAPortableMemoryBackup;
    const envelope = await portable.exportCurrentScope();
    const target = { id: 'state-inherited-target', chatId: 'state-inherited-target', name: 'Target', message: [] };
    target.messages = target.message; f.character.chats.push(target); f.character.chatPage = 1;
    const host = f.r.context.risuai;
    host.getCurrentChatIndex = async () => 1; host.getChatFromIndex = async (_char, index) => f.character.chats[index];
    host.getChat = async () => target; host.getCurrentChat = async () => target;
    assert.equal((await portable.importAsPredecessorArchive(envelope)).ok, true);
    const prepared = await f.r.api.getResponseContext({ currentInput: '도서관 정문 상태' });
    const library = prepared.values.currentHead.world.find(row => row.name === '도서관');
    assert.equal(library.state.doorStatus, '열렸다');
    const evidence = library.fieldEvidence.doorStatus;
    assert.ok(evidence.archiveKey && evidence.decisionKey);
    assert.equal((await f.r.api.validateResponseContext(prepared)).current, true);
    const changed = JSON.parse(f.r.values.get(evidence.decisionKey)); changed.status = 'superseded';
    f.r.values.set(evidence.decisionKey, JSON.stringify(changed));
    await invalid(f, prepared, /CONSUMER_MICRO_STATE_DEPENDENCY_CHANGED/);
  });
});
