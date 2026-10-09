'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'HAYAKU_Locator_Continuity.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); },
    async key(index) { return Array.from(values.keys())[index] ?? null; },
    async length() { return values.size; },
    async clear() { values.clear(); return true; }
  };
};

const createCandidate = summary => ({
  meta: {
    scene_id: 'scene-room',
    turn_anchor: summary,
    summary_memory: {
      summary,
      recallAnchors: ['문', '방'],
      recallAliases: { ko: [summary] },
      canonicalAnchors: ['event:room_change'],
      mentionedEntityNames: ['민수'],
      directEvidenceSnippets: [summary],
      related_refs: [],
      confidence: 0.82
    },
    confidence: 0.82
  },
  entity: { characters: [{ name: '민수' }], relations: [], pov_memories: [], secrets: [] },
  world: {
    location: '방', time: '현재', scene: '방 안', weather: '',
    active_events: [{ id: 'event:room_change', summary }], historical_events: [],
    world_rules: [], offscreen_threads: [], factions: [], regions: []
  },
  narrative: {
    scene_phase: '진행', current_arc: '방 탐색', pacing: 'normal', conflict_traces: [],
    scene_deltas: [{ id: 'delta:room', summary, confidence: 0.82, time_scope: 'current' }],
    theme_motifs: [], critical_dialogue: []
  },
  planner: { continuity_locks: [summary], do_not_resolve_yet: [], consequence_ledger: [], payoff_tracker: [], open_invitations: [] },
  importance: { overall: 0.62, reason: ['상태 변화'] }
});

const createRecoveryEnvelope = (packet, quote) => {
  const grounding = [];
  const walk = (value, base) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item != null && (typeof item !== 'string' || item.trim())) grounding.push({ path: `${base}[${index}]`, source: 'target', evidence: [quote] });
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, nested]) => walk(nested, base ? `${base}.${key}` : key));
  };
  for (const axis of ['entity', 'world', 'narrative', 'planner']) walk(packet[axis], axis);
  if (packet.meta?.summary_memory?.summary) grounding.push({ path: 'meta.summary_memory.summary', source: 'target', evidence: [quote] });
  return { schema: 'hayaku.native_repair_output.v1', packet, grounding };
};

const createRuntime = async (argumentOverrides = {}) => {
  const pluginStorage = createStore();
  const localStorage = createStore();
  const chat = { id: 'chat-native', chatId: 'chat-native', name: 'Native', message: [], messages: [] };
  const character = { id: 'char-native', chaId: 'char-native', name: 'Native', chats: [chat], chatPage: 0 };
  const unloadHandlers = [];
  const timeouts = new Set();
  const intervals = new Set();
  const llmCalls = [];
  const llmQueue = [];
  let outputListener = null;

  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...innerArgs) => {
      timeouts.delete(timer);
      handler(...innerArgs);
    }, delay, ...args);
    timeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = timer => { timeouts.delete(timer); clearTimeout(timer); };
  const trackedSetInterval = (handler, delay, ...args) => {
    const timer = setInterval(handler, delay, ...args);
    intervals.add(timer);
    return timer;
  };
  const trackedClearInterval = timer => { intervals.delete(timer); clearInterval(timer); };

  const host = {
    pluginStorage,
    safeLocalStorage: localStorage,
    async getLocalPluginStorage() { return localStorage; },
    async getArgument(name) {
      const key = String(name);
      if (Object.prototype.hasOwnProperty.call(argumentOverrides, key)) return String(argumentOverrides[key]);
      if (key.includes('memory_suite_server_mode')) return 'plugin_only';
      if (key === 'hayaku_native_auto_repair') return 'false';
      if (key === 'hayaku_enabled') return 'true';
      if (key === 'hayaku_enable_gui' || key.includes('enable_gui')) return 'false';
      if (key === 'hayaku_debug') return 'false';
      return '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument(name,value) { argumentOverrides[String(name)]=String(value);return true; },
    async requestPluginPermission() { return true; },
    async nativeFetch() { throw new Error('fixture_offline'); },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getChar() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChatFromIndex() { return chat; },
    async getDatabase() { return { characters: [character], plugins: [] }; },
    async addRisuReplacer() { return true; },
    async removeRisuReplacer() { return true; },
    async addRisuScriptHandler() { return true; },
    async removeRisuScriptHandler() { return true; },
    async addRisuChatListener(type, handler) { if (type === 'output') outputListener = handler; return true; },
    async removeRisuChatListener() { return true; },
    async registerBodyIntercepter() { return 'fixture-interceptor'; },
    async unregisterBodyIntercepter() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterUIPart() { return true; },
    async addPluginChannelListener() { return true; },
    async removePluginChannelListener() { return true; },
    async postPluginChannelMessage() { return true; },
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'node', saveMethod: 'local' }; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async runLLMModel(options) {
      llmCalls.push(structuredClone(options));
      if (!llmQueue.length) throw new Error('fixture_no_llm_response');
      const value = llmQueue.shift();
      if (value instanceof Error) throw value;
      if (typeof value === 'function') return await value(options);
      return { type: 'success', result: typeof value === 'string' ? value : JSON.stringify(value), finish_reason: 'stop' };
    }
  };

  const context = vm.createContext({
    risuai: host,
    Risuai: host,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    queueMicrotask,
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    performance: globalThis.performance,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    confirm: () => false,
    alert() {},
    prompt: () => null
  });

  vm.runInContext(source, context, { filename: 'HAYAKU_Locator_Continuity.js' });
  const api = await waitFor(() => context.HAYAKU, 'HAYAKU public API');

  const cleanup = async () => {
    for (const handler of unloadHandlers.reverse()) {
      try { await handler(); } catch (_) {}
    }
    for (const timer of timeouts) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
    timeouts.clear();
    intervals.clear();
  };

  return { api, test: api._test, host, context, chat, character, pluginStorage, localStorage, llmCalls, llmQueue, get outputListener() { return outputListener; }, cleanup };
};

(async () => {
  const runtime = await createRuntime();
  try {
    const { api, test, context, chat, llmCalls, llmQueue } = runtime;
    assert.equal(api.version, releaseVersion('hayaku'));

    // Normal startup and idle topology observation must never invoke Other Ax.
    await wait(80);
    assert.equal(llmCalls.length, 0, 'normal/idle HAYAKU path remains no-LLM');

    // OFF THE SCREEN keeps the startup API proxy. Reproduce RisuAI hiding its
    // sandbox globals after initialization and require native recovery to retain
    // the same captured runLLMModel transport instead of reporting it missing.
    delete context.risuai;
    delete context.Risuai;
    const capturedApiStatus = await api.recovery.status();
    assert.equal(capturedApiStatus.available, true);
    assert.equal(capturedApiStatus.runLLMModelAvailable, true, 'captured startup API survives hidden global aliases');
    assert.equal(capturedApiStatus.transport?.apiSource, 'captured_startup_api');

    // The Recovery UI probe is explicit, session-only, and reuses the exact
    // Other Ax transport contract. Opening HAYAKU or reading probe status must
    // not call a model; one click submits exactly one physical provider call.
    assert.equal(api.capabilities.nativeOtherAxCallProbeV1, true);
    const probeStatusBefore = api.recovery.auxiliaryModel.status();
    assert.equal(probeStatusBefore.schema, 'hayaku.otherax_call_probe.v1');
    assert.equal(probeStatusBefore.available, true);
    assert.equal(probeStatusBefore.apiSource, 'captured_startup_api');
    assert.equal(probeStatusBefore.last, null);
    assert.equal(llmCalls.length, 0, 'probe status is read-only and makes no call');
    const storageBeforeProbe = JSON.stringify(Array.from(runtime.pluginStorage.values.entries()));
    llmQueue.push('HAYAKU OK');
    const successfulProbe = await api.recovery.auxiliaryModel.testCall();
    assert.equal(successfulProbe.ok, true);
    assert.equal(successfulProbe.status, 'complete');
    assert.equal(successfulProbe.submitted, true);
    assert.equal(successfulProbe.sessionOnly, true);
    assert.equal(successfulProbe.writesCanonicalMemory, false);
    assert.equal(successfulProbe.writesPacketLedger, false);
    assert.equal(successfulProbe.responsePreview, 'HAYAKU OK');
    assert.equal(llmCalls.length, 1, 'explicit probe submits exactly one physical call');
    assert.equal(llmCalls[0].mode, 'otherAx');
    assert.equal(llmCalls[0].allowPlugins, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(llmCalls[0], 'staticModel'));
    assert.match(llmCalls[0].messages[0].content, /connectivity probe/i);
    assert.equal(JSON.stringify(Array.from(runtime.pluginStorage.values.entries())), storageBeforeProbe, 'probe does not mutate durable HAYAKU storage');

    let releasePendingProbe;
    llmQueue.push(() => new Promise(resolve => { releasePendingProbe = resolve; }));
    const beforePendingProbeCalls = llmCalls.length;
    const pendingProbePromise = api.recovery.auxiliaryModel.testCall();
    await waitFor(() => llmCalls.length === beforePendingProbeCalls + 1 && typeof releasePendingProbe === 'function', 'pending auxiliary probe');
    const duplicateProbe = await api.recovery.auxiliaryModel.testCall();
    assert.equal(duplicateProbe.status, 'busy');
    assert.equal(duplicateProbe.submitted, false);
    const blockedRepair = await api.recovery.repairNow({ reason: 'probe_overlap_test' });
    assert.equal(blockedRepair.skipped, true);
    assert.equal(blockedRepair.reason, 'auxiliary_probe_in_progress');
    assert.equal(llmCalls.length, beforePendingProbeCalls + 1, 'probe and recovery calls cannot overlap');
    releasePendingProbe({ type: 'success', result: 'HAYAKU OK AGAIN' });
    const pendingProbe = await pendingProbePromise;
    assert.equal(pendingProbe.ok, true);

    llmQueue.push(new Error('probe provider offline'));
    const beforeFailedProbeCalls = llmCalls.length;
    const failedProbe = await api.recovery.auxiliaryModel.testCall();
    assert.equal(failedProbe.ok, false);
    assert.equal(failedProbe.status, 'failed');
    assert.equal(failedProbe.submitted, true);
    assert.match(failedProbe.error?.message || '', /probe provider offline/);
    assert.equal(llmCalls.length - beforeFailedProbeCalls, 1, 'failed probe has no synthetic retry');
    assert.equal(JSON.stringify(Array.from(runtime.pluginStorage.values.entries())), storageBeforeProbe, 'failed probe also remains session-only');

    // Exact message revision cache: unchanged rows reuse the same projection,
    // edits replace only the changed Assistant, and rollback prunes removed rows.
    chat.message = [
      { role: 'user', chatId: 'u-cache', data: '문을 연다.' },
      { role: 'assistant', chatId: 'a-cache', data: '문이 열렸다.' },
      { role: 'user', chatId: 'u-tail', data: '안으로 들어간다.' }
    ];
    const scopeKey = 'cache-scope';
    const user1 = test.messageRevisionProjection(chat.message[0], 0, scopeKey, { diagnostics: false });
    const assistant1 = test.messageRevisionProjection(chat.message[1], 1, scopeKey, { diagnostics: true });
    const assistant2 = test.messageRevisionProjection(chat.message[1], 1, scopeKey, { diagnostics: true });
    assert.equal(assistant2, assistant1, 'unchanged Assistant diagnostics are reused');
    const observation1 = test.exactChatRevisionObservation({ key: scopeKey, chatMessages: chat.message });
    const observation2 = test.exactChatRevisionObservation({ key: scopeKey, chatMessages: chat.message });
    assert.equal(observation2.signature, observation1.signature, 'unchanged exact transcript fingerprint is stable');

    chat.message[1].data = '문이 완전히 열렸다.';
    const assistant3 = test.messageRevisionProjection(chat.message[1], 1, scopeKey, { diagnostics: true });
    assert.notEqual(assistant3, assistant1, 'edited Assistant is recalculated');
    assert.notEqual(assistant3.signature, assistant1.signature, 'edited Assistant gets a new exact signature');
    const observation3 = test.exactChatRevisionObservation({ key: scopeKey, chatMessages: chat.message });
    assert.notEqual(observation3.signature, observation1.signature, 'edit changes exact transcript fingerprint');

    assert.equal(test.invalidateMessageRevisionCache(scopeKey, { indices: [1] }), 1, 'targeted invalidation removes one Assistant');
    const user2 = test.messageRevisionProjection(chat.message[0], 0, scopeKey, { diagnostics: false });
    const assistant4 = test.messageRevisionProjection(chat.message[1], 1, scopeKey, { diagnostics: true });
    assert.equal(user2, user1, 'unrelated User cache entry survives targeted invalidation');
    assert.notEqual(assistant4, assistant3, 'targeted Assistant entry is rebuilt');

    test.exactChatRevisionObservation({ key: scopeKey, chatMessages: chat.message });
    chat.message = chat.message.slice(0, 2);
    test.exactChatRevisionObservation({ key: scopeKey, chatMessages: chat.message });
    assert.equal(test.invalidateMessageRevisionCache(scopeKey, { indices: [2] }), 0, 'rollback observation prunes removed message cache entries');

    assert.deepEqual(Array.from(test.expectedCapturePacketTypes({ recoveryRequired: true })), ['current_snapshot'], 'RP response capture expects current_snapshot only');

    // Malformed output ends this request. A separate explicit generation is allowed.
    // Retired extra-call settings cannot silently add paid requests.
    context.risuai=runtime.host;
    assert.equal((await api.settingsControl.apply({hayaku_recovery_extra_calls:'1'})).ok,true);
    const repairScopeKey = (await test.currentChatScope()).key;
    const repairCandidate = createCandidate('민수가 방 안으로 들어갔다.');
    llmQueue.push('not-json', createRecoveryEnvelope(repairCandidate, '민수가 방 안으로 들어갔다.'));
    const beforeRepairAttemptCalls = llmCalls.length;
    const generate = () => test.executeNativeAnalysisAttempt('incremental_recovery', {
        turn: 2,
        startTurn: 2,
        endTurn: 2,
        targetPairIndex: 2,
        text: '[Turn 2]\n[User attempt]\n안으로 들어간다.\n\n[Assistant outcome]\n민수가 방 안으로 들어갔다.',
        chunkHash: 'fixture-chunk-2'
      }, {
        scopeKey: repairScopeKey,
        sourceEvidenceHash: 'fixture-evidence-2',
        repairTarget: { debtId: 'fixture-debt-2', scopeKey: repairScopeKey, pairIndex: 2, sourceEvidenceHash: 'fixture-evidence-2' }
      });
    let failure;try{await generate();}catch(error){failure=error;}
    assert(failure,'malformed output must fail');assert.equal(failure.failedAnalysisDurable,true);
    assert.equal(llmCalls.length-beforeRepairAttemptCalls,1,'retired extra-call setting cannot launch an automatic retry');
    const reviewArtifact=await test.readFailedAnalysisArtifact(repairScopeKey,failure.failedAnalysisId);
    assert.equal(reviewArtifact.durable,true);assert.equal(reviewArtifact.payload.attempts.length,1);
    const corrected=await generate();assert.equal(corrected.ok,true);assert.equal(corrected.groundingReceipt.verified,true);
    assert.equal(llmCalls.length-beforeRepairAttemptCalls,2,'a separate explicit generation gets one request');
    for(const call of llmCalls.slice(beforeRepairAttemptCalls)){assert.equal(call.mode,'otherAx');assert.equal(call.allowPlugins,true);assert(!Object.hasOwn(call,'staticModel'));}

    // Transport/provider failure must not launch a duplicate paid request.
    llmQueue.push(new Error('provider offline'));
    const beforeTransportCalls = llmCalls.length;
    await assert.rejects(
      test.executeNativeAnalysisAttempt('incremental_recovery', {
        turn: 3,
        startTurn: 3,
        endTurn: 3,
        targetPairIndex: 3,
        text: '[Turn 3]\n[User attempt]\n살핀다.\n\n[Assistant outcome]\n방을 살폈다.',
        chunkHash: 'fixture-chunk-3'
      }, { scopeKey: repairScopeKey, sourceEvidenceHash: 'fixture-evidence-3', repairTarget: { debtId: 'fixture-debt-3', scopeKey: repairScopeKey, pairIndex: 3 } }),
      /provider offline/
    );
    assert.equal(llmCalls.length - beforeTransportCalls, 1, 'transport failure performs no immediate duplicate retry');

    // End-to-end missing-turn recovery. Turn 1 has a valid current packet, Turn 2
    // has none. HAYAKU must materialize debt, call Other Ax in the background,
    // adopt the exact historical target, read it back, and discharge the debt.
    const currentPacket = api.packet.normalize(createCandidate('민수가 문을 열었다.'));
    currentPacket.meta.schema = 'hayaku_packet_v1';
    currentPacket.meta.packet_type = 'current_snapshot';
    currentPacket.meta.packet_schema_rev = 2;
    assert.equal(api.packet.validate(currentPacket).ok, true, 'fixture current packet is valid');
    const currentBlock = `<!-- HAYAKU_STATE_PACKET_START ${JSON.stringify(currentPacket)} HAYAKU_STATE_PACKET_END -->`;
    chat.message = [
      { role: 'user', chatId: 'u1', data: '문을 연다.', time: 1 },
      { role: 'assistant', chatId: 'a1', data: `문이 열렸다.\n\n${currentBlock}`, time: 2 },
      { role: 'user', chatId: 'u2', data: '안으로 들어간다.', time: 3 },
      { role: 'assistant', chatId: 'a2', data: '민수가 방 안으로 들어갔다.', time: 4 },
      { role: 'user', chatId: 'u3', data: '주위를 살핀다.', time: 5 }
    ];
    const scan = await test.scanCurrentChatForNativeRecoveryDebts({ reason: 'runtime_test' });
    assert.equal(scan.ok, true);
    assert.ok(scan.saved >= 1 || scan.existing >= 1, 'missing turn is materialized into Recovery Vault');
    const debtBefore = await test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: false, limit: 8 });
    assert.ok(debtBefore.debts.some(debt => Number(debt.pairIndex) === 2), 'exact missing turn debt exists');

    llmQueue.push(createRecoveryEnvelope(repairCandidate, '민수가 방 안으로 들어갔다.'));
    const beforeSweepCalls = llmCalls.length;
    const sweep = await test.runNativeRepairSweep({ force: true, reason: 'runtime_test' });
    assert.equal(sweep.ok, true);
    assert.equal(sweep.repaired, true);
    assert.equal(llmCalls.length - beforeSweepCalls, 1, 'one debt uses one successful Other Ax call');
    assert.equal(sweep.adoption?.verified, true, 'repair adoption is semantically verified');
    assert.equal(sweep.adoption?.durable, true, 'repair adoption passes durable readback');

    const inspection = await api.ledger.inspect({ includeRecords: true });
    const recovered = inspection.records.find(record => (
      record.packetType === 'recovery_snapshot'
      && Number(record.targetPairIndex) === 2
      && record.recordState === 'active'
    ));
    assert.ok(recovered, 'internal compatibility recovery record fills exact past turn');
    const debtAfter = await test.inspectRecoveryDebtsForNativeRepair({ includeEvidence: false, limit: 8 });
    assert.equal(debtAfter.debts.some(debt => Number(debt.pairIndex) === 2), false, 'verified repair discharges Recovery Vault debt');
  } finally {
    await runtime.cleanup();
  }

  // Manual Cold Start runs in a separate clean HAYAKU instance. A second resume
  // over identical evidence must reuse all verified checkpoints with zero LLM calls.
  const coldRuntime = await createRuntime();
  try {
    const { api, chat, llmCalls, llmQueue } = coldRuntime;
    chat.message = [
      { role: 'user', chatId: 'cold-u1', data: '문을 연다.' },
      { role: 'assistant', chatId: 'cold-a1', data: '문이 열렸다.' },
      { role: 'user', chatId: 'cold-u2', data: '방 안으로 들어간다.' },
      { role: 'assistant', chatId: 'cold-a2', data: '민수가 방 안으로 들어갔다.' }
    ];
    llmQueue.push(createRecoveryEnvelope(createCandidate('문이 열렸다.'),'문이 열렸다.'),createRecoveryEnvelope(createCandidate('민수가 방 안으로 들어갔다.'),'민수가 방 안으로 들어갔다.'));
    const coldStart = await api.recovery.coldStart({ resume: true });
    assert.equal(coldStart.ok, true);
    assert.equal(coldStart.completed, true);
    assert.equal(coldStart.packets, 2);
    assert.equal(coldStart.adoption?.verified, true);
    assert.equal(coldStart.adoption?.durable, true);
    assert.equal(llmCalls.length, 2, 'two completed U+A turns produce two Cold Start calls');
    assert.ok(llmCalls.every(call => call.mode === 'otherAx' && call.allowPlugins === true));

    const beforeResumeCalls = llmCalls.length;
    const resumed = await api.recovery.coldStart({ resume: true, allowExisting: true });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.reusedChunks, 2, 'verified Cold Start checkpoints are reused');
    assert.equal(llmCalls.length, beforeResumeCalls, 'checkpoint resume performs zero new LLM calls');
    const inspection = await api.ledger.inspect({ includeRecords: true });
    assert.ok(inspection.records.some(record => record.captureSource === 'bridge_cold_start'), 'Cold Start is adopted into HAYAKU ledger');
  } finally {
    await coldRuntime.cleanup();
  }

  const blockedPluginRuntime = await createRuntime({ risuai_aux_allow_plugins: 'false' });
  try {
    blockedPluginRuntime.llmQueue.push('HAYAKU STANDARD OK');
    const probe = await blockedPluginRuntime.api.recovery.auxiliaryModel.testCall();
    assert.equal(probe.ok, true);
    assert.equal(blockedPluginRuntime.llmCalls.length, 1);
    assert.equal(blockedPluginRuntime.llmCalls[0].allowPlugins, false, 'an explicit false setting continues to block plugin-provided models');
  } finally {
    await blockedPluginRuntime.cleanup();
  }

  console.log('PASS hayaku_native_otherax_runtime_test');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

