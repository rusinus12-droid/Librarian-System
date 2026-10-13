'use strict';

// Complete shipped plugin + registered host output/settings/beforeRequest
// callbacks. Only Risu's DOM/storage boundary and provider transport are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM, VirtualConsole } = require('jsdom');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact: canonicalArtifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const source = require('./fixtures/unified_vertical_source.json').sourceRows;
const DETAIL = '도서관 전체는 정숙 구역';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check(); if (value) return value;
    await delay(15);
  }
  throw new Error(`timeout:${label}`);
}
function records(values, schema) {
  return [...values].flatMap(([key, raw]) => {
    try { const value = JSON.parse(raw); return value?.schema === schema ? [{ key, raw, value }] : []; }
    catch { return []; }
  });
}
function envelope(options) {
  const input = JSON.parse(options.messages[1].content);
  const startOffset = input.assistant.text.indexOf(DETAIL);
  assert.ok(startOffset >= 0, 'mock claim binds to exact original assistant');
  return { type: 'success', result: JSON.stringify({ schema: 'libra.micro_producer_envelope.v1',
    personCandidates: { spans: [], relations: [] }, micro: { schema: 'libra.micro_memory.v1', ...input.binding,
      claims: [{ changeKind: 'world', text: `${DETAIL}이다.`, actor: '', target: '도서관',
        temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
        evidence: { role: 'assistant', messageId: input.assistant.messageId, startOffset,
          endOffset: startOffset + DETAIL.length, exactQuote: DETAIL } }] } }) };
}

(async () => {
  let output, setting;
  const options = { mode: 'plugin_only', args: { enable_gui: 'true', input_writer_enabled: 'false' }, host: {
    addRisuChatListener: async (_kind, callback) => { output = callback; return true; },
    registerSetting: async (_name, callback) => { setting = callback; return { id: 'libra-settings' }; },
    registerButton: async descriptor => ({ id: descriptor.id }),
    showContainer: async () => true, hideContainer: async () => true,
    getColorScheme: async () => 'dark'
  } };
  const x = await serverFixture(options);
  const evidence = { schema: 'libra.public-receipt-recovery-flow.v1',
    boundary: 'Windows Node VM + JSDOM + mock Risu provider; not native Risu/browser/model acceptance', cases: [] };
  let dom, release;
  const domErrors = [];
  const physicalReads = [];
  const get = x.backend.getItem;
  x.backend.getItem = async key => { physicalReads.push(key); return get(key); };
  const rawAttempts = [], backoffs = [];
  let failRaw = true;
  const set = x.backend.setItem;
  x.backend.setItem = async (key, value) => {
    if (key.includes(':source-receipt:')) {
      rawAttempts.push({ key, sha256: sha(value), stored: !failRaw });
      if (failRaw) return false;
    }
    return set(key, value);
  };
  async function realmDom() {
    if (dom) dom.window.close();
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => { if (error.type !== 'css-parsing') domErrors.push(error.message); });
    dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/', virtualConsole, pretendToBeVisual: true });
    dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    Object.assign(x.f.r.context, { document: dom.window.document, window: dom.window,
      navigator: { language: 'ko-KR' }, MutationObserver: dom.window.MutationObserver, requestAnimationFrame: callback => setTimeout(callback, 0),
      cancelAnimationFrame: clearTimeout, confirm: () => true });
    const timer = x.f.r.context.setTimeout;
    x.f.r.context.setTimeout = (callback, ms, ...args) => {
      if (ms === 1000 || ms === 3000) { backoffs.push(ms); return timer(callback, 0, ...args); }
      return timer(callback, ms, ...args);
    };
    await waitFor(() => typeof setting === 'function' && typeof output === 'function', 'actual host registrations');
    await setting();
    await waitFor(() => dom.window.document.querySelector('[data-receipt-recovery-scope]'), 'mounted public home recovery panel');
  }
  async function refreshDesk() {
    const button = [...dom.window.document.querySelectorAll('[data-receipt-recovery-scope] button')]
      .find(row => row.textContent === '상태 새로고침');
    assert.ok(button, 'actual desk status refresh exists');
    button.click();
    await delay(40);
  }
  async function card(kind, status) {
    await refreshDesk();
    return await waitFor(() => dom.window.document.querySelector(
      kind === 'receipt' ? `[data-receipt-turn="1"][data-receipt-status="${status}"]`
        : `[data-micro-turn="1"][data-micro-status="${status}"]`), `public ${kind} ${status} card`);
  }
  async function approveRecovery(kind) {
    const callsBefore=x.f.control.calls.length;
    const overlay=await waitFor(()=>dom.window.document.querySelector(`#dlg-recover.is-open[data-recovery-kind="${kind}"]`),'actual recovery approval dialog');
    const execute=await waitFor(()=>{const node=overlay.querySelector('[data-recovery-execute]');return node&&!node.disabled?node:null;},'scope-qualified recovery execution');
    assert.equal(x.f.control.calls.length,callsBefore,'opening approval cannot submit analysis');
    assert.ok(overlay.dataset.recoveryScope,'actual captured recovery scope');
    assert.equal(overlay.dataset.recoveryTarget,overlay.querySelector('#rb-bound').value,'execution binds selected actual receipt/Micro identity');
    execute.click();
  }
  async function closeRecoveryResult() {
    const job=await waitFor(()=>{const node=dom.window.document.querySelector('#job-recover');return node&&!node.querySelector('[data-job-result]').hidden?node:null;},'actual recovery result readback');
    const confirm=[...job.querySelectorAll('.dialog__actions button')].find(node=>node.textContent==='확인');assert.ok(confirm);confirm.click();
    const overlay=dom.window.document.querySelector('#dlg-recover');if(overlay){await waitFor(()=>overlay.querySelector('[data-recovery-execute]').hidden,'approved action completion');const close=[...overlay.querySelectorAll('.dialog__actions button')].find(node=>node.textContent==='닫기');assert.ok(close);close.click();}
  }
  async function restart() {
    const file = path.join(x.dir, 'public-host-snapshot.json');
    fs.writeFileSync(file, JSON.stringify({ chat: x.f.chat, values: [...x.local] }));
    options.snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    await x.f.r.api.closeSettingsGui();
    x.local.clear();
    for (const [key, value] of options.snapshot.values) x.local.set(key, value);
    await x.restart();
    await x.f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    await realmDom();
  }
  try {
    x.f.chat.message = x.f.chat.message.slice(0, 2); x.f.chat.messages = x.f.chat.message;
    await x.f.r.api.saveLibraMemorySettings({ ...(await x.f.r.api.getLibraMemorySettings()), autoAnalyze: false });
    await x.f.r.api.saveLibraProviderConfig({ responseFamily: 'libra', libraResponseMode: 'classic' });
    await realmDom();
    const originalHostChat = JSON.stringify(x.f.chat);
    const eventStarted = performance.now();
    const returned = output({ char: x.f.character, chat: x.f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 1 });
    const outputHandlerMs = performance.now() - eventStarted;
    assert.equal(returned, undefined, 'actual output callback dispatches work without waiting');
    const failedJob = await waitFor(async () => (await x.f.r.api.getReceiptRecoveryStatus()).receiptJobs.find(row => row.status === 'failed'), 'raw retries exhausted');
    assert.equal(failedJob.attempts, 3);
    assert.equal(failedJob.reason, 'attempts_exhausted');
    assert.equal(rawAttempts.length, 3, 'original-inclusive raw write retry budget');
    assert.equal(records(x.local, 'libra.completed_turn_receipt.v1').length, 0, 'failed writes produced no raw copy');
    assert.equal(x.f.control.calls.length, 0, 'raw storage failure never submitted analysis');
    assert.equal((await x.f.r.api.getReceiptRecoveryStatus()).microJobs.length, 0, 'raw failure is not a Micro failure');
    const rawFailureCard = await card('receipt', 'failed');
    assert.ok(rawFailureCard.textContent.includes('저장 실패'));
    assert.equal(JSON.stringify(x.f.chat), originalHostChat, 'failure did not rewrite original chat');
    evidence.cases.push({ name: 'official-output-raw-failure-public-home', jobId: failedJob.jobId,
      attempts: 3, providerCalls: 0, outputHandlerMs, displayedStorageFailure: true });

    await restart();
    const persistedFailure = (await x.f.r.api.getReceiptRecoveryStatus()).receiptJobs[0];
    assert.equal(persistedFailure.jobId, failedJob.jobId, 'fresh realm reads the same durable job');
    assert.equal(persistedFailure.status, 'failed');
    assert.equal(persistedFailure.attempts, 3);
    assert.equal(x.f.control.calls.length, 0, 'restart/status is provider-free');
    failRaw = false;
    const recheck = (await card('receipt', 'failed')).querySelector('button');
    assert.equal(recheck.textContent, '저장 다시 확인');
    recheck.click();await approveRecovery('receipt');
    const recovered = await waitFor(async () => (await x.f.r.api.getReceiptRecoveryStatus()).receiptJobs.find(row => row.status === 'verified'), 'public raw recheck');
    await closeRecoveryResult();assert.equal(recovered.cycle, 2); assert.equal(recovered.cycleHistory[0].attempts, 3);
    assert.equal(x.f.control.calls.length, 0, 'public storage recheck cannot call analysis');
    const raw = records(x.local, 'libra.completed_turn_receipt.v1');
    assert.equal(raw.length, 1, 'one successful original raw copy');
    const originalRaw = raw[0];
    assert.equal(originalRaw.value.user.text, source[0].text); assert.equal(originalRaw.value.assistant.text, source[1].text);
    assert.equal(originalRaw.value.turn, 1); assert.equal(originalRaw.value.completionProvenance, 'validated_completed_pair');
    assert.equal(originalRaw.value.user.chatId, source[0].ref); assert.equal(originalRaw.value.assistant.chatId, source[1].ref);
    assert.equal(originalRaw.value.sourceDigest, recovered.identity.sourceDigest);
    assert.equal(originalRaw.value.revisionId, recovered.identity.revisionId);
    const originalWork = records(x.local, 'libra.micro_work.v1')[0];
    assert.ok(originalWork); assert.equal(originalWork.value.phase, 'planned');
    assert.equal(originalWork.value.receiptKey, originalRaw.key);
    assert.equal(originalWork.value.sourceDigest, originalRaw.value.sourceDigest);
    assert.equal(originalWork.value.physicalAttemptsUsed, 0);
    const freshRaw = await x.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(freshRaw.status, 'verified');
    assert.equal(freshRaw.receiptKey, originalRaw.key); assert.equal(JSON.stringify(freshRaw.receipt), originalRaw.raw);
    evidence.cases.push({ name: 'restart-public-raw-recheck', receiptKey: originalRaw.key,
      sourceDigest: originalRaw.value.sourceDigest, revisionId: originalRaw.value.revisionId,
      sha256: sha(originalRaw.raw), cycle: recovered.cycle, priorAttempts: 3, rawCopies: 1, providerCalls: 0 });

    x.f.control.modelFails = true;
    let microStage = (await x.f.r.api.getReceiptRecoveryStatus()).microJobs[0];
    const firstAnalysisButton = (await card('micro', microStage.status)).querySelector('button');
    assert.ok(firstAnalysisButton.textContent.includes('Micro 분석'));
    firstAnalysisButton.click();await approveRecovery('micro');
    try {
      const result = await waitFor(async () => {
        const stage = (await x.f.r.api.getReceiptRecoveryStatus()).microJobs[0];
        const publication = x.f.r.api.getCaptureBackendState().lastMicroPublication;
        return stage?.status === 'failed' || publication?.reason === 'micro_plan_unproven'
          ? { stage, publication } : false;
      }, 'separate explicit analysis failure');
      assert.equal(result.stage.status, 'failed', JSON.stringify(result));
    } catch (error) {
      throw new Error(error.message + ':' + JSON.stringify({ status: await x.f.r.api.getReceiptRecoveryStatus(),
        calls: x.f.control.calls.length, gui: dom.window.document.querySelector('[data-receipt-recovery-scope]')?.textContent }));
    }
    const failedAnalysisCalls = x.f.control.calls.length;
    assert.ok(failedAnalysisCalls >= 1 && failedAnalysisCalls <= 2, 'bounded physical mock provider retries');
    assert.equal(x.local.get(originalRaw.key), originalRaw.raw, 'analysis failure left original raw byte exact');
    await closeRecoveryResult();const analysisCard = await card('micro', 'failed');
    assert.ok(analysisCard.textContent.includes('분석 실패'));
    assert.ok(analysisCard.textContent.includes('모델 호출 비용'));
    assert.equal((await x.f.r.api.getReceiptRecoveryStatus()).receiptJobs[0].status, 'verified');
    evidence.cases.push({ name: 'public-separate-analysis-failure', physicalMockCalls: failedAnalysisCalls,
      displayedAnalysisFailure: true, rawUnchanged: true });

    x.f.control.modelFails = false;
    // The actual manual-action debounce coalesces double-clicks for 1.5s.
    // Wait for a distinct user retry; do not bypass that shipped fence.
    await delay(1550);
    const entered = deferred(); release = deferred();
    x.f.control.onCall = async args => { entered.resolve(); await release.promise; return envelope(args[0]); };
    analysisCard.querySelector('button').click();await approveRecovery('micro');
    await entered.promise;
    assert.equal(x.f.control.calls.length, failedAnalysisCalls + 1);
    const pendingStage = (await x.f.r.api.getReceiptRecoveryStatus()).microJobs[0];
    assert.equal(pendingStage.status, 'running', 'held provider has an active analysis job');
    await card('micro', 'running');
    const requestStarted = performance.now();
    let hookFinished = false;
    const pendingInput = x.f.control.hooks.beforeRequest([{ role: 'user', content: '도서관 이용 규칙을 기억해서 이어줘.' }], 'model')
      .then(value => { hookFinished = true; return value; });
    const input = await Promise.race([pendingInput, delay(2000).then(() => { throw new Error('registered chat hook waited for held background provider'); })]);
    const beforeRequestMs = performance.now() - requestStarted;
    assert.equal(hookFinished, true); assert.ok(Array.isArray(input));
    assert.equal((await x.f.r.api.getReceiptRecoveryStatus()).microJobs[0].status, 'running', 'chat returned while analysis remained pending');
    release.resolve();
    await waitFor(async () => (await x.f.r.api.getReceiptRecoveryStatus()).microJobs.find(row => row.status === 'succeeded'), 'public Micro retry committed');
    await closeRecoveryResult();const micro = await x.f.r.api.debugReadActiveMicroMemory(1);
    assert.equal(micro.status, 'verified');
    assert.ok(micro.record.claims.some(claim => claim.evidence.exactQuote === DETAIL));
    assert.equal(micro.record.sourceRevisionId, originalRaw.value.revisionId);
    assert.equal(micro.record.sourceDigest, originalRaw.value.sourceDigest);
    for (const claim of micro.record.claims) {
      assert.equal(claim.evidence.messageId, originalRaw.value.assistant.chatId);
      assert.equal(originalRaw.value.assistant.text.slice(claim.evidence.startOffset, claim.evidence.endOffset), claim.evidence.exactQuote);
    }
    const microWork = JSON.parse(x.local.get(originalWork.key));
    assert.equal(microWork.logicalAttempts, 3, 'old unknown + explicit failure + explicit success remain distinct');
    assert.equal(microWork.attemptHistory.length, 3);
    assert.equal(microWork.attemptHistory[0].attemptId, originalWork.value.attemptId);
    assert.equal(microWork.attemptHistory[0].status, 'unknown');
    assert.equal(microWork.attemptHistory[0].physicalAttemptsUncertain, true);
    assert.equal(microWork.attemptHistory[0].physicalAttemptsUsed, 2);
    assert.equal(microWork.attemptHistory[1].status, 'failed');
    assert.equal(microWork.attemptHistory[2].status, 'succeeded');
    assert.equal(microWork.attemptHistory[2].physicalAttemptsUsed, 1);
    assert.equal(x.local.get(originalRaw.key), originalRaw.raw, 'analysis retry retained original raw copy');
    evidence.cases.push({ name: 'public-held-analysis-retry-chat-nonblocking', heldStatus: pendingStage.status,
      beforeRequestMs, commandObservationBoundMs: 2000, retryPhysicalMockCalls: 1, sourceBoundQuote: DETAIL,
      workKey: originalWork.key, attemptHistory: microWork.attemptHistory.map(row => ({
        status: row.status, physicalAttemptsUsed: row.physicalAttemptsUsed,
        physicalAttemptsUncertain: row.physicalAttemptsUncertain === true })) });

    // The public cold-start command consumes the same completed dialogue. It is
    // explicit; no seed of canonical memory/manifest/head/receipt is performed.
    x.f.chat.message = source.map(row => ({ role: row.role, chatId: row.ref, data: row.text }));
    x.f.chat.messages = x.f.chat.message;
    const callsBeforeCanonical = x.f.control.calls.length;
    x.f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(canonicalArtifact()) });
    const cold = await x.f.r.api.runManualColdStart();
    const completedJob = await waitFor(async () => {
      const job = await x.f.r.api.getCanonicalJobStatus({ jobId: cold?.jobId });
      return job && ['completed', 'failed', 'cancelled'].includes(job.state) ? job : false;
    }, 'public canonical cold-start terminal');
    assert.equal(completedJob.state, 'completed', JSON.stringify(completedJob));
    assert.equal(x.f.control.calls.length, callsBeforeCanonical + 1, 'one explicit canonical provider invocation');
    const canonicalProviderInput = JSON.stringify(x.f.control.calls.at(-1));
    for (const row of source) assert.ok(canonicalProviderInput.includes(row.text), `Canonical provider received exact source:${row.ref}`);
    const manifestRow = [...x.local].find(([key]) => key.endsWith(':manifest'));
    assert.ok(manifestRow, 'actual producer published manifest');
    const manifest = JSON.parse(manifestRow[1]);
    const reference = manifest.memories['1']; assert.ok(reference?.key, 'manifest points to T1-T5 Canonical');
    const memoryRaw = x.local.get(reference.key), memory = JSON.parse(memoryRaw);
    assert.equal(memory.turnRange.start, 1); assert.equal(memory.turnRange.end, 5);
    assert.equal(reference.sourceDigest, memory.sourceDigest);
    assert.deepEqual(memory.turnRange, reference.turnRange);
    assert.equal(x.f.chat.message[0].data, originalRaw.value.user.text);
    assert.equal(x.f.chat.message[1].data, originalRaw.value.assistant.text);
    assert.equal(x.local.get(originalRaw.key), originalRaw.raw, 'Canonical did not rewrite recovered T1 raw');
    assert.equal(records(x.local, 'libra.completed_turn_receipt.v1').filter(row => row.value.turn === 1).length, 1);
    const memories = records(x.local, memory.schema).filter(row => row.value.memoryId === memory.memoryId && row.value.revision === memory.revision);
    assert.equal(memories.length, 1, 'one Canonical copy for exact identity');
    const receipts = await x.f.r.api.listExecutionReceipts({ kind: 'memory' });
    const receipt = receipts.items.find(row => row.status === 'complete' && row.memoryId === memory.memoryId && row.revision === memory.revision);
    assert.ok(receipt?.durable, 'published Canonical has a durable complete execution receipt');
    assert.ok(manifest.runIds.includes(receipt.id), 'manifest references the committed run receipt');
    const runKey = `libra:v1:scope:${originalRaw.value.scopeKey}:run:${receipt.id}`;
    const runRaw = x.local.get(runKey); assert.ok(runRaw, 'execution receipt is physically stored');
    const run = JSON.parse(runRaw);
    assert.deepEqual(run.turnRange, memory.turnRange);
    assert.equal(run.memoryId, memory.memoryId); assert.equal(run.revision, memory.revision);
    assert.equal(run.commit.memoryKey, reference.key); assert.equal(run.commit.revision, memory.revision);
    assert.equal(run.sourceDigest, memory.sourceDigest);
    assert.deepEqual(run.sourcePairs, source.filter(row => row.role === 'user').map((row, index) => ({
      turn: index + 1, userChatId: row.ref, assistantChatId: source[index * 2 + 1].ref })));
    const frozen = new Map([[originalRaw.key, originalRaw.raw], manifestRow, [reference.key, memoryRaw],
      [runKey, runRaw], [originalWork.key, x.local.get(originalWork.key)]]);
    evidence.cases.push({ name: 'public-canonical-publication', memoryKey: reference.key,
      memoryId: memory.memoryId, revision: memory.revision, turnRange: memory.turnRange,
      sourceDigest: memory.sourceDigest, memorySha256: sha(memoryRaw), manifestSha256: sha(manifestRow[1]),
      executionReceiptId: receipt.id, executionReceiptKey: runKey, executionReceiptSha256: sha(runRaw),
      completeExecutionReceipt: true });

    const freshReadStart = physicalReads.length;
    await restart();
    for (const [key, value] of frozen) assert.equal(x.local.get(key), value, `fresh physical host snapshot exact:${key}`);
    const detail = await x.f.r.api.getCanonicalMemoryDetail({ key: reference.key, memoryId: memory.memoryId, revision: memory.revision });
    const expectedDetail = { ...memory, key: reference.key, detailLoaded: true };
    assert.equal(JSON.stringify(detail), JSON.stringify(expectedDetail), 'fresh owner reader returns exact Canonical fields');
    const freshReceipt = await x.f.r.api.getExecutionReceiptDetail({ kind: 'memory', id: receipt.id });
    assert.equal(freshReceipt.status, 'complete'); assert.equal(freshReceipt.durable, true);
    assert.equal(JSON.stringify(freshReceipt.payload), runRaw, 'fresh owner execution reader returns exact durable receipt');
    const finalRaw = await x.f.r.api.debugReadActiveCompletedTurnReceipt(1);
    assert.equal(finalRaw.status, 'verified'); assert.equal(JSON.stringify(finalRaw.receipt), originalRaw.raw);
    assert.equal((await x.f.r.api.debugReadActiveMicroMemory(1)).status, 'verified');
    const freshPhysicalKeys = new Set(physicalReads.slice(freshReadStart));
    for (const [key] of frozen) assert.ok(freshPhysicalKeys.has(key), `fresh realm reads exact durable key:${key}`);
    x.f.control.onCall = () => { throw new Error('unexpected provider on final Classic consumer'); };
    const final = await x.f.control.hooks.beforeRequest([{ role: 'user', content: '열쇠는 지금 누가 가지고 있고 약속은 어떻게 되었지?' }], 'model');
    const finalText = final.map(row => String(row.content || '')).join('\n');
    const viewer = x.f.r.api.getLastMemoryRecallViewer();
    assert.ok(viewer.rows.some(row => row.kind === 'canonical' || row.memoryId === memory.memoryId), 'registered final injection consumes actual Canonical');
    assert.ok(finalText.includes('열쇠'), 'final registered injection contains Canonical grounded detail');
    assert.equal(viewer.rows.filter(row => row.kind === 'micro' && Number(row.turn) <= 5).length, 0, 'already consumed T1 Micro is not duplicated as Canonical evidence');
    assert.equal(x.f.control.calls.length, 0, 'fresh final Classic injection uses no provider');
    const succeededCard = await card('micro', 'succeeded');
    assert.equal(succeededCard.querySelector('button'), null, 'completed analysis exposes no duplicate retry action');
    for (const [key, value] of frozen) assert.equal(x.local.get(key), value, 'final consumer does not rewrite frozen source/Canonical');
    assert.equal(x.requests.filter(row => !row.url.startsWith(x.url + '/')).length, 0, 'all recorded transport is isolated local server');
    assert.deepEqual(domErrors, [], 'actual registered GUI has no runtime DOM errors');
    evidence.cases.push({ name: 'fresh-owner-final-registered-injection', canonicalConsumed: true,
      duplicateConsumedMicro: 0, rawCopies: 1, providerCalls: 0, finalSha256: sha(finalText),
      physicalFreshReads: [...frozen.keys()], storageReloadedFromFile: true, exactExecutionReceipt: true });
    evidence.result = 'PASS'; evidence.backoffDelays = backoffs;
    if (process.env.LIBRA_PUBLIC_FLOW_EVIDENCE) fs.writeFileSync(process.env.LIBRA_PUBLIC_FLOW_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { release?.resolve(); await x.f.r.api.closeSettingsGui(); dom?.window.close(); await x.cleanup(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
