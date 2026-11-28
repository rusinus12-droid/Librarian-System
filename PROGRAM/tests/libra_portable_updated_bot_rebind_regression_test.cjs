'use strict';
// Regression tests for LIBRA updated-bot portable restore (`rebind_updated_bot`):
//   A) Non-contiguous canonical batches (T1-T5 diverged, T6-T10 matched) + trailing Micro turn (T11)
//      + diverged gap turn with Micro/pending receipt (T1) + legacy completedTurnRevisionIdLegacy
//      receipts + canonical/Micro chatId drift, across all 3 storage modes.
//   B) Micro-only updated-bot rebind (0 canonical batches, only verified Micro turns including
//      legacy completedTurnRevisionIdLegacy receipt).
//   C) Debug snapshot exposes `portableRestore` status alongside `portableBackup`.
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { retryHistoricalMicro } = require('./fixtures/libra_explicit_micro_retry.cjs');
const { waitFor } = require('./fixtures/libra_vm_harness.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];

const parse = value => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};

const transformSource = source => source.replace(
  'const completedTurnRevisionIdLegacy = pair =>',
  'globalThis.__libraTestHelpers = { digest, sourceDigest };\n    const completedTurnRevisionIdLegacy = pair =>'
);

const portableApi = async snapshot => {
  const context = snapshot.f.r.context;
  for (let i = 0; i < 500; i += 1) {
    if (context.__LIBRAPortableMemoryBackup) return context.__LIBRAPortableMemoryBackup;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA portable API did not appear');
};

const idle = async (operation, label, attempts = 40) => {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await operation(); } catch (error) {
      if (!/BUSY/.test(String(error?.code || error?.message || ''))) throw error;
      last = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`LIBRA stayed busy for ${label}: ${last?.code || last}`);
};

const localRows = snapshot => [...snapshot.local.entries()].map(([key, raw]) => ({ key, value: parse(raw) }));

async function writeStorageRecord(fx, mode, key, value) {
  const serialized = JSON.stringify(value);
  if (mode !== 'server_only') fx.local.set(key, serialized);
  if (mode !== 'plugin_only') await fx.mutate(key, value, 'set');
}

async function deleteStorageRecord(fx, mode, key) {
  if (mode !== 'server_only') fx.local.delete(key);
  if (mode !== 'plugin_only') {
    const res = await fx.send('GET', '/v1/kv/get?namespace=libra&space=plugin&key=' + encodeURIComponent(key));
    if (res?.result?.exists && !res?.result?.tombstone) {
      await fx.mutate(key, null, 'remove');
    }
  }
}

async function rewriteMicroTurnToLegacy(fx, mode, scopeKey, turn, { overrideUserChatId = '' } = {}) {
  const { f } = fx;
  const { digest, sourceDigest } = f.r.context.__libraTestHelpers;
  const rows = mode === 'plugin_only' ? localRows(fx) : fx.storedRows();
  const prefix = `libra:v1:scope:${scopeKey}:`;
  const receiptHeadRow = rows.find(r => r.key.startsWith(`${prefix}source-receipt-head:`) && Number(r.value?.turn) === turn);
  const microHeadRow = rows.find(r => r.key.startsWith(`${prefix}micro-memory-head:`) && Number(r.value?.turn) === turn);
  assert.ok(receiptHeadRow, `T${turn}: source-receipt-head must exist`);
  assert.ok(microHeadRow, `T${turn}: micro-memory-head must exist`);

  const receiptHead = JSON.parse(JSON.stringify(receiptHeadRow.value));
  const microHead = JSON.parse(JSON.stringify(microHeadRow.value));
  const oldReceiptKey = receiptHead.receiptKey;
  const oldMicroKey = microHead.recordKey;
  const receipt = JSON.parse(JSON.stringify(rows.find(r => r.key === oldReceiptKey)?.value));
  const micro = JSON.parse(JSON.stringify(rows.find(r => r.key === oldMicroKey)?.value));
  const oldWorkKey = micro.workKey;
  const work = JSON.parse(JSON.stringify(rows.find(r => r.key === oldWorkKey)?.value));

  delete receipt.user.sanitizedTextDigests;
  delete receipt.assistant.sanitizedTextDigests;
  delete receipt.rawSourcePacket;
  delete receipt.rawPacketRef;
  if (overrideUserChatId) {
    receipt.user.chatId = overrideUserChatId;
    receipt.user.chatIds = [overrideUserChatId];
  }
  const legacyId = f.r.api.debugCompletedTurnRevisionId(receipt, { legacy: true });
  const sd = sourceDigest([receipt]);
  receipt.revisionId = legacyId;
  receipt.sourceDigest = sd;

  const wl = receipt.worldlineId;
  const ep = receipt.sessionEpoch;
  const newReceiptKey = `${prefix}source-receipt:${wl}:e${ep}:t${turn}:${legacyId}`;
  const newWorkKey = `${prefix}micro-work:${wl}:e${ep}:t${turn}:${legacyId}:${work.producerVersion}`;

  receiptHead.revisionId = legacyId;
  receiptHead.receiptKey = newReceiptKey;
  receiptHead.sourceDigest = sd;

  work.sourceRevisionId = legacyId;
  work.receiptKey = newReceiptKey;
  work.sourceDigest = sd;
  if (work.result?.rawPacketRef) delete work.result.rawPacketRef;
  if (work.result?.micro) {
    work.result.micro.sourceRevisionId = legacyId;
    work.result.micro.sourceDigest = sd;
  }
  if (work.result?.personInventory) {
    work.result.personInventory.revisionId = legacyId;
    work.result.personInventory.sourceDigest = sd;
    for (const span of work.result.personInventory.spans || []) {
      span.receiptKey = newReceiptKey;
      span.revisionId = legacyId;
      if (overrideUserChatId && span.role === 'user') span.messageId = overrideUserChatId;
    }
  }
  work.resultDigest = digest(work.result);

  micro.receiptKey = newReceiptKey;
  micro.workKey = newWorkKey;
  micro.sourceRevisionId = legacyId;
  micro.sourceDigest = sd;
  const body = { ...micro };
  delete body.analysisRevisionId;
  micro.analysisRevisionId = digest(body);
  const newMicroKey = `${prefix}micro-memory:${wl}:e${ep}:t${turn}:${legacyId}:${micro.analysisRevisionId}`;

  microHead.sourceRevisionId = legacyId;
  microHead.sourceDigest = sd;
  microHead.analysisRevisionId = micro.analysisRevisionId;
  microHead.recordKey = newMicroKey;
  microHead.workKey = newWorkKey;
  microHead.workDigest = digest(work);
  delete microHead.recallProjection;
  delete microHead.recallProjectionDigest;

  const obsoleteKeys = rows
    .filter(r => r.key.startsWith(`${prefix}person-span-inventory:${wl}:e${ep}:t${turn}:`)
      || r.key.startsWith(`${prefix}person-span-inventory-head:${wl}:e${ep}:t${turn}`)
      || r.key.startsWith(`${prefix}source-receipt-capture:${wl}:e${ep}:t${turn}:`)
      || r.key === oldReceiptKey
      || r.key === oldWorkKey
      || r.key === oldMicroKey)
    .map(r => r.key);
  for (const k of obsoleteKeys) await deleteStorageRecord(fx, mode, k);

  await writeStorageRecord(fx, mode, newReceiptKey, receipt);
  await writeStorageRecord(fx, mode, receiptHeadRow.key, receiptHead);
  await writeStorageRecord(fx, mode, newWorkKey, work);
  await writeStorageRecord(fx, mode, newMicroKey, micro);
  await writeStorageRecord(fx, mode, microHeadRow.key, microHead);
}

function moveToUpdatedBot(f, { divergeTurn1 = false } = {}) {
  f.character.id = 'unified-char-v2';
  f.character.chaId = 'unified-char-v2';
  f.character.name = '민아 (업데이트)';
  f.chat.id = 'unified-chat-moved';
  f.chat.chatId = 'unified-chat-moved';
  f.chat.name = 'Moved session';
  f.chat.message.forEach((message, index) => { message.chatId = `moved-${index}`; });
  if (divergeTurn1) {
    f.chat.message[1].data = `${f.chat.message[1].data} (diverged in updated bot)`;
  }
}

async function runScenarioA(mode) {
  const fx = await serverFixture({ mode, transformSource });
  try {
    let { f } = fx;
    await f.r.api.runManualColdStart({});
    fiveMore(f);
    f.chat.message.push(
      { role: 'user', chatId: 't11-u', data: '열한 번째 사용자 질문: 서재의 기록은 아직 남아 있나요?' },
      { role: 'assistant', chatId: 't11-a', data: '민아가 열한 번째 대답에서 은빛 열쇠가 아직 책상 위에 있다고 확인해 주었다.' }
    );
    await f.r.api.runManualColdStart({});
    await retryHistoricalMicro(f, [1, 6]);
    await f.r.core.captureCommittedOutputEvent({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: f.chat.message.length - 1 });
    await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(11)).status === 'verified', 15000);

    const portable0 = await portableApi(fx);
    const probeEnvelope = await idle(() => portable0.exportCurrentScope(), `${mode} A: probe backup`);
    const sourceScopeKey = String(probeEnvelope.source.scopeKey);

    await rewriteMicroTurnToLegacy(fx, mode, sourceScopeKey, 6, { overrideUserChatId: 'legacy-micro-u6' });
    await rewriteMicroTurnToLegacy(fx, mode, sourceScopeKey, 11);

    const savedMessages = f.clone(f.chat.message);
    f = await fx.restart();
    f.chat.message = savedMessages;
    f.chat.messages = f.chat.message;
    const portable = await portableApi(fx);
    const envelope = await idle(() => portable.exportCurrentScope(), `${mode} A: legacy backup`);

    const authoritativeRows = () => mode === 'plugin_only' ? localRows(fx) : fx.storedRows();
    const sourceRowsBefore = new Map(authoritativeRows()
      .filter(row => row.key.includes(`:scope:${sourceScopeKey}:`))
      .map(row => [row.key, JSON.stringify(row.value)]));
    assert.ok(sourceRowsBefore.size > 0);

    moveToUpdatedBot(f, { divergeTurn1: true });

    const preview = await idle(() => portable.previewImport(envelope), `${mode} A: preview`);
    assert.deepEqual(Array.from(preview.matchedStarts), [], `${mode} A: contiguous starts empty because T1 diverged`);
    assert.deepEqual(Array.from(preview.rebindMatchedStarts), [6], `${mode} A: non-contiguous batch T6-T10 matches`);
    assert.ok(preview.rebindMatchedMicroTurns.includes(6), `${mode} A: legacy Micro T6 matches`);
    assert.ok(preview.rebindMatchedMicroTurns.includes(11), `${mode} A: trailing legacy Micro T11 matches`);
    assert.ok(!preview.rebindMatchedMicroTurns.includes(1), `${mode} A: diverged T1 is excluded`);
    assert.equal(preview.modes.rebind_updated_bot.available, true, `${mode} A: rebind_updated_bot is enabled`);

    const result = await idle(() => portable.rebindToUpdatedBot(envelope), `${mode} A: rebind`);
    assert.equal(result.ok, true, `${mode} A: rebind succeeds`);
    assert.equal(result.receipt.updatedBotRebind, true);
    assert.deepEqual(Array.from(result.copiedStarts), [6]);
    assert.equal(result.receipt.continuityRebuildPending, false, `${mode} A: non-contiguous state rebuild completed`);
    assert.equal(result.receipt.state, 'completed');

    const active1 = await f.r.api.debugReadActiveMicroMemory(1);
    const active6 = await f.r.api.debugReadActiveMicroMemory(6);
    const active11 = await f.r.api.debugReadActiveMicroMemory(11);
    assert.equal(active1.status, 'missing', `${mode} A: diverged T1 Micro is not copied`);
    assert.equal(active6.status, 'verified', `${mode} A: legacy T6 Micro is rebound and verified`);
    assert.equal(active11.status, 'verified', `${mode} A: trailing legacy T11 Micro is rebound and verified`);
    assert.equal(active6.head.scopeKey, String(preview.target.scopeKey));
    assert.equal(active11.head.scopeKey, String(preview.target.scopeKey));

    const previewAfter = await idle(() => portable.previewImport(envelope), `${mode} A: preview after`);
    assert.equal(previewAfter.alreadyImported, true, `${mode} A: readback passes for non-contiguous + trailing Micro`);

    const sourceRowsAfter = new Map(authoritativeRows()
      .filter(row => row.key.includes(`:scope:${sourceScopeKey}:`))
      .map(row => [row.key, JSON.stringify(row.value)]));
    assert.deepEqual([...sourceRowsAfter.entries()], [...sourceRowsBefore.entries()],
      `${mode} A: original bot scope remains untouched`);
  } finally {
    await fx.cleanup();
  }
}

async function runScenarioB(mode) {
  const fx = await serverFixture({ mode, transformSource });
  try {
    let { f } = fx;
    // Keep only 3 pairs (< BATCH_SIZE=5) so there are 0 canonical batches.
    f.chat.message = f.chat.message.slice(0, 6);
    f.chat.messages = f.chat.message;
    await f.r.core.captureCommittedOutputEvent({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(1)).status === 'verified', 15000);
    await f.r.core.captureCommittedOutputEvent({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 3 });
    await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(2)).status === 'verified', 15000);
    await f.r.api.runManualColdStart({});

    const portable0 = await portableApi(fx);
    const probeEnvelope = await idle(() => portable0.exportCurrentScope(), `${mode} B: probe backup`);
    const sourceScopeKey = String(probeEnvelope.source.scopeKey);
    await rewriteMicroTurnToLegacy(fx, mode, sourceScopeKey, 1);

    const savedMessages = f.clone(f.chat.message);
    f = await fx.restart();
    f.chat.message = savedMessages;
    f.chat.messages = f.chat.message;
    const portable = await portableApi(fx);
    const envelope = await idle(() => portable.exportCurrentScope(), `${mode} B: micro-only backup`);
    assert.equal(envelope.lineage.batches.length, 0, `${mode} B: 0 canonical batches in backup`);

    moveToUpdatedBot(f);
    const preview = await idle(() => portable.previewImport(envelope), `${mode} B: preview`);
    assert.equal(preview.sourceMemories, 0);
    assert.deepEqual(Array.from(preview.rebindMatchedStarts), []);
    assert.ok(preview.rebindMatchedMicroTurns.includes(1));
    assert.ok(preview.rebindMatchedMicroTurns.includes(2));
    assert.equal(preview.modes.rebind_updated_bot.available, true, `${mode} B: Micro-only updated-bot rebind enabled`);

    const result = await idle(() => portable.rebindToUpdatedBot(envelope), `${mode} B: rebind`);
    assert.equal(result.ok, true, `${mode} B: Micro-only rebind succeeds`);
    assert.equal(result.receipt.updatedBotRebind, true);
    assert.deepEqual(Array.from(result.copiedStarts), []);
    assert.ok(result.receipt.microActiveRecords >= 2);

    const active1 = await f.r.api.debugReadActiveMicroMemory(1);
    const active2 = await f.r.api.debugReadActiveMicroMemory(2);
    assert.equal(active1.status, 'verified');
    assert.equal(active2.status, 'verified');

    const previewAfter = await idle(() => portable.previewImport(envelope), `${mode} B: preview after`);
    assert.equal(previewAfter.alreadyImported, true, `${mode} B: Micro-only readback succeeds`);

    // Scenario C: debugRuntimeForDisplay() exposes portableRestore alongside portableBackup
    const dbg = f.r.api.debugRuntimeForDisplay();
    assert.ok('portableBackup' in dbg, `${mode} C: portableBackup preserved`);
    assert.ok(dbg.portableRestore && typeof dbg.portableRestore === 'object', `${mode} C: portableRestore exposed`);
    assert.ok('lastRestore' in dbg.portableRestore);
    assert.ok('lastError' in dbg.portableRestore);
  } finally {
    await fx.cleanup();
  }
}

(async () => {
  for (const mode of MODES) {
    console.log('RUN regression', mode);
    await runScenarioA(mode);
    await runScenarioB(mode);
  }
  console.log('libra_portable_updated_bot_rebind_regression_test: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
