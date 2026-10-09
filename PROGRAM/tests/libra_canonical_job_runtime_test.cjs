'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const targetPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(targetPath, 'utf8');
const values = new Map();
let rejectSet = null;
let runLlmCalls = 0;
const storage = {
  async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
  async setItem(key, value) {
    const normalizedKey = String(key);
    if (typeof rejectSet === 'function' && rejectSet(normalizedKey, value) === true) return false;
    values.set(normalizedKey, value);
    return true;
  },
  async removeItem(key) { values.delete(String(key)); return true; },
  async keys() { return Array.from(values.keys()); }
};
const chat = { id: 'canonical-job-chat', chatId: 'canonical-job-chat', name: 'Canonical Job', message: [], bindedPersona: '' };
for (let turn = 1; turn <= 12; turn += 1) {
  chat.message.push({ role: 'user', data: `User ${turn}`, chatId: `u-${turn}` });
  chat.message.push({ role: 'assistant', data: `Assistant ${turn}`, chatId: `a-${turn}` });
}
chat.messages = chat.message;
const character = { id: 'canonical-job-character', name: 'Canonical Job', chatPage: 0, chats: [chat] };
const unloadHandlers = [];
const host = {
  pluginStorage: storage,
  safeLocalStorage: storage,
  async getLocalPluginStorage() { return storage; },
  async getArgument(name) {
    const key = String(name);
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    if (key.includes('enable_character_ito')) return 'true';
    if (key.includes('enable_plot_ito')) return 'true';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  async runLLMModel() { runLlmCalls += 1; throw new Error('synthetic provider failure'); },
  async nativeFetch() { throw new Error('runtime test has no server or provider'); },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; }, async unregisterSetting() { return true; },
  async registerButton() { return true; }, async unregisterButton() { return true; },
  async registerUIPart() { return true; }, async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; }, async removeRisuReplacer() { return true; },
  async addRisuChatListener() { return true; }, async removeRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }, async removeRisuScriptHandler() { return true; },
  async addPluginChannelListener() { return true; }, async removePluginChannelListener() { return true; },
  async postPluginChannelMessage() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; }, async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; }, async getCharacterFromIndex() { return character; },
  async getChat() { return chat; }, async getCurrentChat() { return chat; }, async getChatFromIndex() { return chat; },
  async showContainer() { return true; }, async hideContainer() { return true; }, async getRootContainer() { return null; }, async getPluginRoot() { return null; }
};

const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer); return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => { const timer = setInterval(handler, delay, ...args); activeIntervals.add(timer); return timer; };
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout,
  setInterval: trackedSetInterval, clearInterval: trackedClearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
  performance: globalThis.performance, fetch: globalThis.fetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA runtime load timed out');
};

const validEditedCanonical = [
  '# 종합 기억',
  '## 시간순 사건',
  '- 사용자가 검증한 사건을 기록한다.',
  '## 인물과 관계',
  '- 인물과 관계의 현재 상태를 기록한다.',
  '## 세계와 장면',
  '- 세계와 장면의 확정 상태를 기록한다.',
  '## 내러티브와 미해결 문제',
  '- 아직 해결되지 않은 문제를 기록한다.',
  '## 확정 사실과 불확실 정보',
  '- 확정 사실과 불확실 정보를 구분한다.',
  '## 회상 키워드',
  '- 수동 정본, 검증, 회상'
].join('\n');

(async () => {
  vm.runInContext(source, context, { filename: 'LIBRA-canonical-job-runtime.js' });
  const api = await waitFor(() => context.__LIBRA__);
  await api.getLibraProviderConfig();
  const result = await api.startManualCanonicalScan();
  assert.equal(api.getRuntime().settings.enableCharacterAide, true, 'state-only test domain is enabled');
  assert.equal(result.kind, 'manual_scan');
  assert.deepEqual(Array.from(result.targetStarts), [6], 'current-five action targets only the latest complete five-turn batch');
  assert.equal(result.total, 1);
  assert.equal(result.failed, 1, 'unconfigured provider fails exactly the targeted batch and remains recoverable');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].startTurn, 6);
  assert.doesNotMatch(result.failures[0].message || '', /\b(?:clone|string|asArray) is not defined\b/,
    'provider failure must not be replaced by an outer/private-helper ReferenceError');
  const finishedWork = api.getPipelineWorkStatus();
  assert.equal(finishedWork?.busy, false, 'failed canonical work must not leave the shared progress surface busy');

  const manifestKey = Array.from(values.keys()).find(key => key.endsWith(':manifest'));
  let failedRun = Array.from(values.entries())
    .filter(([key]) => key.includes(':run:'))
    .map(([, value]) => JSON.parse(value))
    .find(run => Number(run?.turnRange?.start || 0) === 6);
  // The new writer blocks a historical gap before a model job. Manual legacy edit tests below use a stored-record fixture from exact source inventory.
  if(!failedRun){const inventory=await api.listCanonicalBatchRanges();const range=inventory.ranges.find(x=>x.startTurn===6);const pairs=api.debugBuildPairs(chat);const manifest=JSON.parse(values.get(manifestKey));failedRun={scopeKey:manifest.scopeKey,runId:'historical_manual_fixture',turnRange:{start:6,end:10},sourceDigest:range.sourceDigest,sourcePairs:pairs.slice(5,10).map(p=>({turn:p.turn,userChatId:p.user.chatId,assistantChatId:p.assistant.chatId}))};}
  assert.ok(manifestKey && failedRun,'exact source identity for legacy manual-edit fixture');
  const scopePrefix = manifestKey.slice(0, -':manifest'.length);
  const memoryKey = `${scopePrefix}:memory:6:r1`;
  const memory = {
    schema: 'libra.canonical_memory.v1', memoryId: 'mem_000006', scopeKey: failedRun.scopeKey,
    branchId: failedRun.sourceDigest, turnRange: { start: 6, end: 10 }, sourcePairs: failedRun.sourcePairs,
    sourceDigest: failedRun.sourceDigest, revision: 1, status: 'committed',
    text: 'ORIGINAL CANONICAL MEMORY', summary: 'Original', recallKeys: [], importance: 0.5,
    sections: {}, anchors: {}, retrieval: { version: 'libra.retrieval_projection.v2' },
    embedding: { status: 'disabled', projectionVersion: 'libra.retrieval_projection.v2' },
    canonicalArtifact: { schema: 'stale.auto.artifact' }, artifactValidation: { ok: true },
    renderValidation: { ok: true, contentHash: 'stale' }, promptProvenance: { provider: 'stale' },
    pipeline: { stages: ['stale'] },
    runId: failedRun.runId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const manifest = JSON.parse(values.get(manifestKey));
  manifest.memories['6'] = {
    memoryId: memory.memoryId, key: memoryKey, revision: 1, sourceDigest: memory.sourceDigest,
    status: 'committed', turnRange: memory.turnRange, summary: memory.summary,
    embeddingStatus: 'disabled', sessionEpoch: 0, inheritedSessionHistory: false,
    createdAt: memory.createdAt, updatedAt: memory.updatedAt, history: []
  };
  manifest.inFlight = null;
  values.set(memoryKey, JSON.stringify(memory));
  values.set(manifestKey, JSON.stringify(manifest));
  const originalBytes = values.get(memoryKey);
  const retainedRevisionTwoKey = `${scopePrefix}:memory:6:r2`;
  values.set(retainedRevisionTwoKey, JSON.stringify({
    ...memory, revision: 2, status: 'inactive', text: 'RETAINED REVISION TWO',
    summary: 'Retained revision two', updatedAt: new Date().toISOString()
  }));

  const edit = await api.createCanonicalEditDraft({ memoryId: memory.memoryId, revision: 1 });
  assert.equal(edit.state, 'awaiting_edit');
  assert.equal(values.get(memoryKey), originalBytes, 'copy-on-write draft creation leaves the active memory byte-identical');
  assert.ok(edit.comparison.candidate.key.endsWith(':memory:6:r3'), 'revision allocation skips a retained unindexed physical r2 record');
  const visibleBeforeAdoption = await api.getCanonicalMemories();
  assert.equal(visibleBeforeAdoption.some(item => Number(item?.revision || 0) === 3), false, 'an unadopted candidate is absent from the canonical memory snapshot');
  const draftRecord = JSON.parse(values.get(edit.comparison.candidate.key));
  assert.equal(draftRecord.manualAuthority.schema, 'libra.canonical_manual_authority.v1');
  assert.equal(draftRecord.manualAuthority.status, 'draft');
  for (const field of ['canonicalArtifact', 'artifactValidation', 'renderValidation', 'promptProvenance', 'pipeline']) {
    assert.equal(Object.hasOwn(draftRecord, field), false, `draft does not inherit stale automatic receipt ${field}`);
  }
  await assert.rejects(
    () => api.saveCanonicalEditDraft({ candidateId: edit.candidateId, text: 'EDITED CANONICAL MEMORY' }),
    /canonical_edit_render_invalid/,
    'free-form text cannot bypass the canonical seven-section render contract'
  );
  assert.equal(values.get(manifestKey), JSON.stringify(manifest), 'invalid edit leaves the active manifest byte-identical');
  const savedEdit = await api.saveCanonicalEditDraft({ candidateId: edit.candidateId, text: validEditedCanonical });
  assert.equal(savedEdit.state, 'awaiting_choice');
  assert.equal(savedEdit.comparison.stateError, 'state_preview_deferred_until_canonical_commit',
    'candidate comparison must explicitly defer state-provider work until durable adoption');
  assert.equal(savedEdit.comparison.statePreviewStatus, 'deferred_until_commit');
  assert.equal(values.get(memoryKey), originalBytes, 'saving the draft never overwrites the active memory');
  const savedCandidateKey = savedEdit.comparison.candidate.key;
  const savedCandidate = JSON.parse(values.get(savedCandidateKey));
  assert.ok(savedCandidateKey.endsWith(':memory:6:r3'));
  assert.equal(savedCandidate.text, validEditedCanonical);
  assert.equal(savedCandidate.renderValidation.ok, true);
  assert.equal(savedCandidate.manualAuthority.schema, 'libra.canonical_manual_authority.v1');
  assert.equal(savedCandidate.manualAuthority.status, 'candidate');
  assert.equal(savedCandidate.manualAuthority.contentHash, savedCandidate.renderValidation.contentHash);
  assert.equal(savedCandidate.manualAuthority.authorityHash, savedEdit.comparison.candidate.manualAuthority.authorityHash);
  assert.equal(values.has(`${scopePrefix}:continuity-delta:${memory.memoryId}:r3`), false,
    'v3 manual candidate save must not create a legacy continuity delta');
  for (const field of ['canonicalArtifact', 'artifactValidation', 'promptProvenance', 'pipeline']) {
    assert.equal(Object.hasOwn(savedCandidate, field), false, `saved manual edit does not claim stale automatic receipt ${field}`);
  }
  const pendingVariants = await api.listCanonicalVariants({ startTurn: 6 });
  const pendingEdited = pendingVariants.variants.find(row => row.key === savedCandidateKey);
  assert.equal(pendingEdited.stateTrackingStatus, 'not_scheduled_candidate',
    'manual candidates explicitly record that state tracking is deferred until adoption');
  const variantIndexKey = `${scopePrefix}:canonical-variants:v1`;
  const beforeMissingDispositionCandidate = values.get(savedCandidateKey);
  const beforeMissingDispositionManifest = values.get(manifestKey);
  const beforeMissingDispositionIndex = values.get(variantIndexKey);
  const providerCallsBeforeMissingDisposition = runLlmCalls;
  await assert.rejects(
    () => api.resolveCanonicalCandidate({ jobId: savedEdit.jobId, decision: 'adopt' }),
    error => /canonical_manual_state_disposition_(?:invalid|required)/.test(String(error?.message || error)),
    'a manual canonical candidate without a durable state disposition must fail closed before pointer mutation'
  );
  assert.equal(values.get(savedCandidateKey), beforeMissingDispositionCandidate,
    'missing disposition leaves the candidate byte-identical');
  assert.equal(values.get(manifestKey), beforeMissingDispositionManifest,
    'missing disposition leaves the active manifest byte-identical');
  assert.equal(values.get(variantIndexKey), beforeMissingDispositionIndex,
    'missing disposition leaves the variant index byte-identical');
  assert.equal(runLlmCalls, providerCallsBeforeMissingDisposition,
    'missing disposition fails before any state provider submission');

  const maintainedDisposition = await api.saveCanonicalManualStateDisposition({
    jobId: savedEdit.jobId,
    mode: 'maintained_by_user'
  });
  assert.equal(maintainedDisposition.schema, 'libra.canonical_manual_state_disposition.v1');
  assert.equal(maintainedDisposition.mode, 'maintained_by_user');
  assert.equal(maintainedDisposition.candidateKey, savedCandidateKey);
  assert.equal(maintainedDisposition.patch, null, 'maintained-by-user cannot smuggle a state patch');
  const dispositionCandidate = JSON.parse(values.get(savedCandidateKey));
  const dispositionJob = JSON.parse(values.get(`${scopePrefix}:canonical-job:${savedEdit.jobId}`));
  assert.equal(dispositionCandidate.manualStateDisposition.intentDigest, maintainedDisposition.intentDigest,
    'manual disposition is durably bound to the candidate bytes');
  assert.equal(dispositionJob.manualStateDisposition.intentDigest, maintainedDisposition.intentDigest,
    'manual disposition is durably bound to the canonical job');
  assert.equal(dispositionCandidate.stateTrackingDisposition, 'manual_state_disposition_declared');
  assert.equal(runLlmCalls, providerCallsBeforeMissingDisposition,
    'saving maintained-by-user disposition performs no provider work');

  const beforeAtomicCandidate = values.get(savedCandidateKey);
  const beforeAtomicManifest = values.get(manifestKey);
  const beforeAtomicIndex = values.get(variantIndexKey);
  let rejectedIndexWrite = false;
  rejectSet = key => {
    if (!rejectedIndexWrite && key === variantIndexKey) { rejectedIndexWrite = true; return true; }
    return false;
  };
  let atomicFailure = null;
  try { await api.resolveCanonicalCandidate({ jobId: savedEdit.jobId, decision: 'adopt' }); }
  catch (error) { atomicFailure = error; }
  assert.ok(atomicFailure, 'a rejected index write must fail the pointer transaction');
  assert.match(String(atomicFailure?.code || atomicFailure?.message || atomicFailure), /(?:CANONICAL_ADOPTION_INDEX_READBACK_FAILED|canonical-variants:v1)/,
    `a failed pointer transaction must identify the rejected index write: ${atomicFailure?.stack || atomicFailure}`);
  rejectSet = null;
  assert.equal(values.get(savedCandidateKey), beforeAtomicCandidate, 'failed adoption restores candidate bytes');
  assert.equal(values.get(manifestKey), beforeAtomicManifest, 'failed adoption restores manifest bytes');
  assert.equal(values.get(variantIndexKey), beforeAtomicIndex, 'failed adoption restores variant index bytes');
  assert.equal(Array.from(values.keys()).some(key => key.includes(':canonical-adoption-transaction:')), false, 'completed rollback removes its transaction journal');
  let candidateWriteCount = 0;
  rejectSet = key => {
    if (key === savedCandidateKey) {
      candidateWriteCount += 1;
      return candidateWriteCount <= 2;
    }
    return false;
  };
  await assert.rejects(
    () => api.resolveCanonicalCandidate({ jobId: savedEdit.jobId, decision: 'adopt' }),
    error => error?.code === 'CANONICAL_ADOPTION_ROLLBACK_INCOMPLETE',
    'an interrupted target write plus failed rollback leaves a durable recovery journal'
  );
  rejectSet = null;
  const interruptedJournalKey = Array.from(values.keys()).find(key => key.includes(':canonical-adoption-transaction:'));
  assert.ok(interruptedJournalKey, 'rollback-incomplete adoption retains the transaction journal');
  assert.equal(JSON.parse(values.get(interruptedJournalKey)).state, 'rollback_incomplete');
  const interruptedJobKey = `${scopePrefix}:canonical-job:${savedEdit.jobId}`;
  assert.equal(JSON.parse(values.get(interruptedJobKey)).state, 'adopting', 'restart sees the job in its durable adopting phase');
  const adopted = await api.resumeCanonicalJob({ jobId: savedEdit.jobId });
  assert.equal(adopted.state, 'completed',
    'a durable maintained-by-user disposition completes its post-adoption state binding without a warning');
  let adoptedManifest = JSON.parse(values.get(manifestKey));
  assert.ok(adoptedManifest.memories['6'].key.endsWith(':memory:6:r3'), 'verified candidate becomes the active pointer');
  const adoptedCandidate = JSON.parse(values.get(savedCandidateKey));
  assert.equal(adoptedCandidate.manualAuthority.status, 'committed');
  assert.ok(adoptedCandidate.manualAuthority.adoptedAt);
  assert.equal(adoptedCandidate.stateTrackingDisposition, 'manual_state_disposition_declared');
  assert.equal(adoptedCandidate.manualStateDisposition.intentDigest, maintainedDisposition.intentDigest,
    'pointer adoption preserves the exact durable maintained-by-user intent');
  assert.equal(Object.hasOwn(adoptedCandidate, 'canonicalArtifact'), false,
    'manual adoption cannot reuse the stale parent artifact');
  assert.equal(runLlmCalls, providerCallsBeforeMissingDisposition,
    'maintained-by-user adoption advances derived state without a state provider submission');
  const dispositionReceiptKey = `${scopePrefix}:manual-state-disposition:${memory.memoryId}:r3`;
  const dispositionReceipt = JSON.parse(values.get(dispositionReceiptKey));
  assert.equal(dispositionReceipt.schema, 'libra.manual_state_disposition_receipt.v1');
  assert.equal(dispositionReceipt.status, 'manual_maintained');
  assert.equal(dispositionReceipt.intentDigest, maintainedDisposition.intentDigest);
  assert.ok(dispositionReceipt.basisFingerprint, 'manual disposition receipt binds the adopted canonical basis');
  const maintainedHead = JSON.parse(values.get(`${scopePrefix}:continuity-state`));
  assert.equal(maintainedHead.reviewedThroughCanonical.memoryId, memory.memoryId,
    'maintained-by-user advances the Current State Head canonical review cursor');
  assert.equal(maintainedHead.reviewedThroughCanonical.revision, 3);
  const adoptedManualRef = adoptedManifest.memories['6'];
  assert.equal(maintainedHead.reviewedThroughCanonical.key, adoptedManualRef.key,
    'manual replay cursor retains the exact active canonical storage key');
  assert.equal(maintainedHead.reviewedThroughCanonical.sourceDigest, adoptedManualRef.sourceDigest);
  assert.equal(maintainedHead.reviewedThroughCanonical.manualStateDispositionDigest, adoptedManualRef.manualStateDispositionDigest,
    'manual replay cursor binds the durable disposition digest rather than a truncated memory tuple');
  assert.equal(maintainedHead.reviewedThroughCanonical.manualAuthorityHash, adoptedManualRef.manualAuthorityHash,
    'manual replay cursor binds the durable user-authority seal');
  assert.equal(maintainedHead.reviewedThroughCanonical.logicalWorldlineId, adoptedManualRef.worldlineId || 'main');
  assert.deepEqual(maintainedHead.reviewedThroughCanonical.turnRange, adoptedManualRef.turnRange);
  assert.equal(Array.from(values.keys()).some(key => key.includes(':canonical-adoption-transaction:')), false, 'successful adoption cleans its transaction journal');
  let variants = await api.listCanonicalVariants({ startTurn: 6 });
  const originalVariant = variants.variants.find(row => row.key === memoryKey);
  const editedVariant = variants.variants.find(row => row.key.endsWith(':memory:6:r3'));
  assert.equal(originalVariant.status, 'superseded');
  assert.equal(editedVariant.status, 'active');

  const reselect = await api.selectCanonicalVariant({ variantId: originalVariant.variantId });
  assert.equal(reselect.state, 'awaiting_choice');
  const restored = await api.resolveCanonicalCandidate({ jobId: reselect.jobId, decision: 'adopt' });
  assert.ok(['completed', 'completed_with_warnings'].includes(restored.state));
  adoptedManifest = JSON.parse(values.get(manifestKey));
  assert.equal(adoptedManifest.memories['6'].key, memoryKey, 'past user version can be restored through the same verified pointer switch');
  assert.equal(values.get(memoryKey), originalBytes,
    'reselecting an already committed historical canonical variant must preserve its exact stored bytes');

  variants = await api.listCanonicalVariants({ startTurn: 6 });
  let inactiveEdited = variants.variants.find(row => row.key.endsWith(':memory:6:r3'));
  const historicalManualBytes = values.get(inactiveEdited.key);
  const historicalManual = await api.selectCanonicalVariant({ variantId: inactiveEdited.variantId });
  assert.equal(historicalManual.state, 'awaiting_choice');
  assert.equal(historicalManual.manualStateDisposition.intentDigest, maintainedDisposition.intentDigest,
    'a committed historical manual variant projects its durable disposition into the new job');
  assert.equal(historicalManual.comparison.manualStateDisposition.intentDigest, maintainedDisposition.intentDigest,
    'historical comparison carries the same disposition readback');
  assert.equal(historicalManual.comparison.manualStateDispositionLocked, true,
    'a committed historical manual disposition is immutable in the comparison surface');
  await assert.rejects(
    () => api.saveCanonicalManualStateDisposition({ jobId: historicalManual.jobId, mode: 'sparse_correction', patch: { narrative: { summary: 'forged rewrite' } } }),
    /canonical_manual_state_disposition_candidate_missing/,
    'the locked historical disposition cannot be rewritten through the candidate-only save API'
  );
  const readoptedManual = await api.resolveCanonicalCandidate({ jobId: historicalManual.jobId, decision: 'adopt' });
  assert.ok(['completed', 'completed_with_warnings'].includes(readoptedManual.state),
    'the projected locked disposition is sufficient to adopt the historical manual variant');
  assert.equal(values.get(inactiveEdited.key), historicalManualBytes,
    'historical manual adoption must not rewrite the committed canonical record bytes');

  variants = await api.listCanonicalVariants({ startTurn: 6 });
  const inactiveAutomatic = variants.variants.find(row => row.key === memoryKey);
  const restoreAutomaticAgain = await api.selectCanonicalVariant({ variantId: inactiveAutomatic.variantId });
  const restoredAutomaticAgain = await api.resolveCanonicalCandidate({ jobId: restoreAutomaticAgain.jobId, decision: 'adopt' });
  assert.ok(['completed', 'completed_with_warnings'].includes(restoredAutomaticAgain.state));
  assert.equal(values.get(memoryKey), originalBytes,
    'restoring the automatic historical variant also preserves its committed bytes');

  variants = await api.listCanonicalVariants({ startTurn: 6 });
  inactiveEdited = variants.variants.find(row => row.key.endsWith(':memory:6:r3'));
  const legacyManual = JSON.parse(values.get(inactiveEdited.key));
  delete legacyManual.manualStateDisposition;
  values.set(inactiveEdited.key, JSON.stringify(legacyManual));
  const jobsBeforeLegacyBlock = Array.from(values.keys()).filter(key => /:canonical-job:[^:]+$/.test(key)).sort();
  const jobHeadBeforeLegacyBlock = values.get(`${scopePrefix}:canonical-job-head:v1`);
  await assert.rejects(
    () => api.selectCanonicalVariant({ variantId: inactiveEdited.variantId }),
    /canonical_manual_variant_disposition_missing/,
    'a legacy manual variant without a durable disposition is rejected before a job is created'
  );
  assert.deepEqual(Array.from(values.keys()).filter(key => /:canonical-job:[^:]+$/.test(key)).sort(), jobsBeforeLegacyBlock,
    'missing historical disposition creates no canonical job record');
  assert.equal(values.get(`${scopePrefix}:canonical-job-head:v1`), jobHeadBeforeLegacyBlock,
    'missing historical disposition does not advance the durable job head');
  values.set(inactiveEdited.key, historicalManualBytes);

  await api.deleteCanonicalVariant({ variantId: inactiveEdited.variantId });
  variants = await api.listCanonicalVariants({ startTurn: 6 });
  assert.equal(variants.total, 1, 'explicit deletion removes only the inactive variant and its sidecars');
  await assert.rejects(() => api.deleteCanonicalVariant({ variantId: variants.variants[0].variantId }), /canonical_active_variant_delete_forbidden/);

  const jobKey = Array.from(values.keys()).find(key => key.endsWith(`:canonical-job:${result.jobId}`));
  assert.ok(jobKey, 'durable canonical job record exists');
  const persisted = JSON.parse(values.get(jobKey));
  persisted.state = 'running';
  persisted.phase = 'pipeline';
  persisted.finishedAt = '';
  values.set(jobKey, JSON.stringify(persisted));
  const readWhileRunning = await api.getCanonicalJobStatus({ jobId: result.jobId });
  assert.equal(readWhileRunning.state, 'running', 'ordinary status reads do not misclassify live work as startup interruption');
  persisted.state = 'completed_with_warnings';
  values.set(jobKey, JSON.stringify(persisted));

  const deleteRunId = 'run_delete_failure_11';
  const deleteRunKey = `${scopePrefix}:run:${deleteRunId}`;
  const deleteWorkKey = `${scopePrefix}:work:11`;
  const deleteJobId = 'canonical_job_delete_failure_11';
  const deleteJobKey = `${scopePrefix}:canonical-job:${deleteJobId}`;
  const deleteJobHeadKey = `${scopePrefix}:canonical-job-head:v1`;
  const deleteFailure = { startTurn: 11, endTurn: 15, message: 'synthetic provider failure', at: new Date().toISOString() };
  values.set(deleteRunKey, JSON.stringify({
    schema: 'libra.execution_run.v1', runId: deleteRunId, scopeKey: failedRun.scopeKey,
    memoryId: 'mem_000011', turnRange: { start: 11, end: 15 }, sourceDigest: 'delete-test', sourcePairs: [],
    status: 'failed', revision: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 1, stages: [], commit: { status: 'pending' }, embedding: { status: 'pending' }, errors: [{ stage: 'ariadne', message: 'synthetic provider failure' }]
  }));
  values.set(deleteWorkKey, JSON.stringify({ schema: 'libra.pipeline_work.v1', runId: deleteRunId, status: 'failed', turnRange: { start: 11, end: 15 } }));
  const deleteManifest = JSON.parse(values.get(manifestKey));
  deleteManifest.runIds = [deleteRunId, ...(deleteManifest.runIds || []).filter(id => id !== deleteRunId)];
  deleteManifest.inFlight = { startTurn: 11, endTurn: 15, runId: deleteRunId, stage: 'ariadne', status: 'failed', error: 'synthetic provider failure' };
  values.set(manifestKey, JSON.stringify(deleteManifest));
  const deleteJob = {
    schema: 'libra.canonical_job.v1', jobId: deleteJobId, scopeKey: failedRun.scopeKey,
    kind: 'manual_scan', state: 'completed_with_warnings', phase: 'complete', targetStarts: [11],
    total: 1, completed: 0, failed: 1, skipped: 0, currentStart: 11, currentStage: '',
    cancelRequested: false, cancellable: false, candidateId: '', comparison: null,
    message: '일부 배치가 실패했습니다.', failures: [deleteFailure],
    result: { failed: 1, processed: 0, failures: [deleteFailure] }, error: '',
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString()
  };
  values.set(deleteJobKey, JSON.stringify(deleteJob));
  values.set(deleteJobHeadKey, JSON.stringify({ schema: 'libra.canonical_job.v1', scopeKey: failedRun.scopeKey, jobId: deleteJobId, state: deleteJob.state, updatedAt: deleteJob.updatedAt }));
  await api.getCanonicalJobStatus({ jobId: deleteJobId });
  const activeMemoryBeforeDelete = values.get(memoryKey);
  const deletedRun = await api.deleteFailedMemoryRun({ runId: deleteRunId });
  assert.equal(deletedRun.deleted, true);
  assert.equal(deletedRun.recoveryEntryRemoved, true);
  assert.equal(values.has(deleteRunKey), false, 'failed run record is physically removed');
  assert.equal(values.has(deleteWorkKey), false, 'matching failed checkpoint is physically removed');
  const manifestAfterDelete = JSON.parse(values.get(manifestKey));
  assert.equal(manifestAfterDelete.runIds.includes(deleteRunId), false, 'manifest run index no longer references the deleted failure');
  assert.equal(manifestAfterDelete.inFlight, null, 'deleted failure is removed from failed-batch recovery inventory');
  const jobAfterDelete = JSON.parse(values.get(deleteJobKey));
  assert.equal(jobAfterDelete.failed, 0);
  assert.deepEqual(jobAfterDelete.failures, []);
  assert.equal(jobAfterDelete.state, 'completed');
  assert.equal(values.get(memoryKey), activeMemoryBeforeDelete, 'manual failure-record deletion never changes the active canonical memory');
  assert.equal((await api.deleteFailedMemoryRun({ runId: deleteRunId })).alreadyMissing, true, 'repeated explicit deletion is idempotent');

  for (let index = 0; index < 16; index += 1) {
    const jobId = `terminal_recent_${String(index).padStart(2, '0')}`;
    const updatedAt = `2099-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`;
    values.set(`${scopePrefix}:canonical-job:${jobId}`, JSON.stringify({
      schema: 'libra.canonical_job.v1', jobId, scopeKey: failedRun.scopeKey,
      kind: 'manual_scan', state: index % 2 ? 'completed_with_warnings' : 'completed',
      total: 1, completed: 1, failed: index % 2, skipped: 0, updatedAt, finishedAt: updatedAt
    }));
  }
  const interruptedJobId = 'interrupted_recovery_protected';
  values.set(`${scopePrefix}:canonical-job:${interruptedJobId}`, JSON.stringify({
    schema: 'libra.canonical_job.v1', jobId: interruptedJobId, scopeKey: failedRun.scopeKey,
    kind: 'manual_scan', state: 'interrupted', total: 1, completed: 0, failed: 0, skipped: 0,
    updatedAt: '2098-12-31T00:00:00.000Z'
  }));
  const recentJobs = await api.listCanonicalJobs({ page: 1, pageSize: 50 });
  const physicalJobs = Array.from(values.entries())
    .filter(([storageKey]) => storageKey.startsWith(`${scopePrefix}:canonical-job:`) && !storageKey.includes('::chunk:'))
    .map(([, raw]) => JSON.parse(raw));
  const terminalJobs = physicalJobs.filter(job => ['completed', 'completed_with_warnings', 'cancelled', 'failed', 'original_kept'].includes(job.state));
  assert.equal(terminalJobs.length, 12, 'durable terminal canonical-job history is physically capped at twelve records');
  assert.ok(recentJobs.jobs.some(job => job.jobId === interruptedJobId), 'an interrupted recovery job remains visible and durable');
  assert.equal(values.has(`${scopePrefix}:canonical-job:${interruptedJobId}`), true, 'retention never deletes unfinished recovery work');
  assert.equal(values.has(`${scopePrefix}:canonical-job:terminal_recent_15`), true, 'newest terminal job is retained');
  assert.equal(values.has(`${scopePrefix}:canonical-job:terminal_recent_00`), false, 'old terminal job is physically removed');

  for (const handler of unloadHandlers.slice().reverse()) { try { await handler(); } catch (_) {} }
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stdout.write('libra_canonical_job_runtime_test: PASS\n');
})().catch(error => {
  for (const timer of activeTimeouts) clearTimeout(timer);
  for (const timer of activeIntervals) clearInterval(timer);
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
