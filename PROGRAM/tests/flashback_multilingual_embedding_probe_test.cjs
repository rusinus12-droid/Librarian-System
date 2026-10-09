'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, /const MULTILINGUAL_PROBE_MIN_MARGIN = 0\.05;/);
assert.match(source, /cacheMode: 'bypass'/, 'probe bypasses normal embedding caches');
assert.match(source, /const inspectMultilingualProbeCompatibility = async[\s\S]*await loadScopeRecords\(scope\.scopeKey\)/,
  'profile compatibility inspects the local plus immutable-archive record view');
assert.doesNotMatch(source, /runLLMModel[\s\S]{0,300}MULTILINGUAL_RECALL_PROBE_FIXTURES/,
  'multilingual probe does not use an LLM translation path');

const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while loading Flashback multilingual probe runtime.');
};

const createStore = () => {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const argumentValues = new Map([
  ['memory_suite_server_mode', 'plugin_only'],
  ['enable_gui', 'false'],
  ['embedding_key', 'test-secret-not-for-output']
]);
const networkCalls = [];
const vectorByText = new Map();
const currentChat = { id: 'multilingual-probe-chat', chatId: 'multilingual-probe-chat', name: 'Probe', message: [], messages: [] };
const character = { id: 'multilingual-probe-character', chaId: 'multilingual-probe-character', name: 'Probe', chats: [currentChat] };
const unloadHandlers = [];

const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) { return argumentValues.get(String(name || '')) || ''; },
  async getArg(name) { return await this.getArgument(name); },
  async setArgument(name, value) {
    const key = String(name || '');
    const clean = value == null ? '' : String(value);
    if (clean) argumentValues.set(key, clean);
    else argumentValues.delete(key);
    return true;
  },
  async nativeFetch(url, init = {}) {
    const body = JSON.parse(String(init.body || '{}'));
    const texts = Array.isArray(body.input) ? body.input : [body.input];
    networkCalls.push({ url: String(url), count: texts.length, headers: { ...(init.headers || {}) } });
    if (init.signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    const data = texts.map((input, index) => {
      const vector = vectorByText.get(String(input));
      if (!vector) throw new Error(`unexpected probe input at ${index}`);
      return { index, embedding: vector.slice() };
    });
    return { ok: true, status: 200, async json() { return { data }; } };
  },
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async removePluginChannelHandler() { return true; },
  async offPluginChannelMessage() { return true; },
  async postPluginChannelMessage() { return true; },
  async onUnload(handler) { unloadHandlers.push(handler); return true; },
  async registerSetting() { return true; },
  async registerButton() { return true; },
  async unregisterSetting() { return true; },
  async unregisterButton() { return true; },
  async unregisterUIPart() { return true; },
  async addRisuReplacer() { return true; },
  async removeRisuReplacer() { return true; },
  async addRisuScriptHandler() { return true; },
  async removeRisuScriptHandler() { return true; },
  async addRisuChatListener() { return true; },
  async removeRisuChatListener() { return true; },
  async getDatabase(fields) {
    const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
    if (!Array.isArray(fields)) return all;
    return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
  },
  async setDatabase() { return true; },
  async getCurrentCharacterIndex() { return 0; },
  async getCurrentChatIndex() { return 0; },
  async getCharacter() { return character; },
  async getCharacterFromIndex() { return character; },
  async getChat() { return currentChat; },
  async getCurrentChat() { return currentChat; },
  async getChatFromIndex() { return currentChat; },
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async getRootContainer() { return null; },
  async getPluginRoot() { return null; }
};

const activeTimeouts = new Set();
const activeIntervals = new Set();
const trackedSetTimeout = (handler, delay, ...args) => {
  let timer;
  timer = setTimeout((...inner) => { activeTimeouts.delete(timer); handler(...inner); }, delay, ...args);
  activeTimeouts.add(timer);
  return timer;
};
const trackedClearTimeout = timer => { activeTimeouts.delete(timer); clearTimeout(timer); };
const trackedSetInterval = (handler, delay, ...args) => {
  const timer = setInterval(handler, delay, ...args);
  activeIntervals.add(timer);
  return timer;
};
const trackedClearInterval = timer => { activeIntervals.delete(timer); clearInterval(timer); };
const context = vm.createContext({
  risuai: host,
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
  alert: () => {},
  prompt: () => null
});

const resultEnvelope = (settings, vectors, purpose, api) => ({
  vectors,
  provider: settings.embeddingProvider,
  model: settings.embeddingModel,
  dimensions: vectors[0]?.length || 0,
  profileId: api._test.embeddingProfileId(settings, vectors[0]?.length || 0),
  metadata: { requestCount: 1, batchCount: 1, purpose }
});

(async () => {
  try {
    vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
    const api = await waitFor(() => context.__FlashbackMemory);
    assert.equal(api.version, source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)[1]);
    const inputs = api._test.multilingualEmbeddingProbeInputs();
    assert.equal(inputs.queries.length, 8, 'two fixtures provide four query languages each');
    assert.equal(inputs.documents.length, 16, 'positive and hard-negative documents are separated');
    assert.equal(new Set(inputs.queries.map(item => `${item.fixtureId}:${item.language}`)).size, 8);

    const fixtureBases = {
      hidden_object_location: { positive: [1, 0, 0, 0], negative: [0, 1, 0, 0] },
      relationship_promise_state: { positive: [0, 0, 1, 0], negative: [0, 0, 0, 1] }
    };
    for (const item of inputs.queries) vectorByText.set(`query-probe: ${item.text}`, fixtureBases[item.fixtureId].positive);
    for (const item of inputs.documents) vectorByText.set(`document-probe: ${item.text}`, fixtureBases[item.fixtureId][item.kind]);

    const settings = api._test.normalizeSettings({
      embeddingProvider: 'openai',
      embeddingEnabled: true,
      embeddingUrl: 'https://mock.example/v1',
      embeddingModel: 'mock-multilingual-embedding',
      embeddingDimensions: 4,
      embeddingBatchSize: 8,
      embeddingMaxRetries: 0,
      embeddingTimeoutMs: 5000,
      embeddingNormalize: true,
      embeddingQueryTask: 'query-task',
      embeddingDocumentTask: 'document-task',
      embeddingQueryPrefix: 'query-probe: ',
      embeddingDocumentPrefix: 'document-probe: ',
      fallbackHashEmbedding: false,
      gateHighCosine: 0.42
    });
    assert.notEqual(
      api._test.embeddingProfileId(settings, 4),
      api._test.embeddingProfileId({ ...settings, embeddingDocumentTask: 'changed-document-task' }, 4),
      'query/document task changes invalidate the vector profile'
    );

    const requestsBeforeUi = networkCalls.length;
    const guiHtml = await api._test.buildUiHtml();
    assert.equal(networkCalls.length, requestsBeforeUi, 'GUI render does not auto-run the multilingual provider probe');
    assert.equal((guiHtml.match(/id="multilingualProbeBtn"/g) || []).length, 1);
    assert.equal((guiHtml.match(/id="cancelMultilingualProbeBtn"/g) || []).length, 1);
    assert.equal((guiHtml.match(/id="multilingualProbeMaintenanceBtn"/g) || []).length, 1);
    assert.match(guiHtml, /사용자 대화는 사용하지 않습니다/);
    assert.match(guiHtml, /id="multilingualProbeBtn"[^>]*disabled/, 'hash default is explicitly outside the provider probe');

    const first = await api._test.runMultilingualEmbeddingProbe(settings);
    assert.equal(first.verified, true);
    assert.equal(first.status, 'verified');
    assert.equal(first.crossPassed, 24);
    assert.equal(first.crossTotal, 24);
    assert.equal(first.controlsPassed, 8);
    assert.equal(first.controlsTotal, 8);
    assert.equal(first.matrix.length, 16);
    assert.equal(first.requestCount, 3, 'query one batch plus document two batches');
    assert.deepEqual(networkCalls.slice(-3).map(call => call.count), [8, 8, 8]);
    assert.equal(api._test.multilingualProbeStateForSettings(settings, first), 'verified');
    assert.equal(api._test.multilingualProbeStateForSettings({ ...settings, embeddingModel: 'changed-model' }, first), 'stale');
    assert.equal(api._test.multilingualProbeStateForSettings({ ...settings, gateHighCosine: 0.5 }, first), 'stale');
    const compatibilityRecords = [
      { provider: first.provider, model: first.model, embeddingProfileId: first.profileId, vector: [1, 0, 0, 0] },
      { provider: first.provider, model: first.model, embeddingProfileId: 'foreign-profile', vector: [0, 1, 0, 0] },
      { archiveReferenceOnly: true }
    ];
    const recordsBeforeCompatibility = JSON.stringify(compatibilityRecords);
    const compatibilitySummary = api._test.summarizeMultilingualProbeCompatibility(compatibilityRecords, {}, settings, first);
    assert.deepEqual({
      total: compatibilitySummary.total,
      compatible: compatibilitySummary.compatible,
      reembedRequired: compatibilitySummary.reembedRequired,
      missingVector: compatibilitySummary.missingVector,
      localTotal: compatibilitySummary.localTotal,
      localCompatible: compatibilitySummary.localCompatible,
      archiveTotal: compatibilitySummary.archiveTotal,
      archiveCompatible: compatibilitySummary.archiveCompatible
    }, { total: 3, compatible: 1, reembedRequired: 2, missingVector: 1, localTotal: 2, localCompatible: 1, archiveTotal: 1, archiveCompatible: 0 });
    assert.equal(JSON.stringify(compatibilityRecords), recordsBeforeCompatibility, 'profile inspection is read-only');
    assert.equal(api._test.summarizeMultilingualProbeCompatibility(compatibilityRecords, { missingShards: 1 }, settings, first).integrityIssue, true);
    const renderedVerified = api._test.renderMultilingualProbeResults(settings, first);
    assert.match(renderedVerified, /multilingual-probe-table/);
    assert.match(renderedVerified, /교차 24\/24/);
    assert.match(renderedVerified, /요청 3회/);
    assert.match(renderedVerified, /실행 /);
    assert.doesNotMatch(renderedVerified, /빨간 열쇠|red key|赤い鍵|红色钥匙/);
    assert.doesNotMatch(JSON.stringify(first), /빨간 열쇠|red key|赤い鍵|红色钥匙/,
      'probe result contains scores and identifiers but no fixture text or vectors');

    const callsAfterFirst = networkCalls.length;
    const second = await api._test.runMultilingualEmbeddingProbe(settings);
    assert.equal(second.verified, true);
    assert.equal(networkCalls.length, callsAfterFirst + 3, 'manual rerun bypasses normal caches');
    const debugAfterProbe = await api.debugState();
    assert.equal(debugAfterProbe.performance.queryEmbeddingCache.size, 0, 'probe queries do not enter the normal recall cache');
    assert.equal(debugAfterProbe.performance.documentEmbeddingCache.size, 0, 'probe documents do not enter the normal record cache');

    const firstFixtureQueries = inputs.queries.filter(item => item.fixtureId === 'hidden_object_location');
    const firstFixtureDocuments = inputs.documents.filter(item => item.fixtureId === 'hidden_object_location');
    const asymmetricQueryByLanguage = {
      ko: [1, 0, 0, 0],
      en: [0.8, 0.6, 0, 0],
      ja: [0.6, 0.8, 0, 0],
      zh: [Math.SQRT1_2, Math.SQRT1_2, 0, 0]
    };
    const asymmetricDocumentByLanguage = {
      ko: [1, 0, 0, 0],
      en: [0.9, Math.sqrt(0.19), 0, 0],
      ja: [Math.sqrt(0.19), 0.9, 0, 0],
      zh: [Math.SQRT1_2, Math.SQRT1_2, 0, 0]
    };
    const asymmetricResult = api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, firstFixtureQueries.map(item => asymmetricQueryByLanguage[item.language]), 'query', api),
      documentResult: resultEnvelope(settings, firstFixtureDocuments.map(item => item.kind === 'positive'
        ? asymmetricDocumentByLanguage[item.language]
        : [0, 0, 1, 0]), 'document', api)
    });
    assert.equal(asymmetricResult.verified, true);
    const koToEn = asymmetricResult.directions.find(item => item.queryLanguage === 'ko' && item.documentLanguage === 'en');
    const enToKo = asymmetricResult.directions.find(item => item.queryLanguage === 'en' && item.documentLanguage === 'ko');
    assert.notEqual(koToEn.positiveCosine, enToKo.positiveCosine, 'opposite language directions are independently calculated');

    const lowQueryVectors = firstFixtureQueries.map(() => [1, 0, 0, 0]);
    const lowPositive = [0.3, Math.sqrt(0.91), 0, 0];
    const lowDocumentVectors = firstFixtureDocuments.map(item => item.kind === 'positive' ? lowPositive : [0, 0, 1, 0]);
    const lowResult = api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, lowDocumentVectors, 'document', api)
    });
    assert.equal(lowResult.verified, false);
    assert.equal(lowResult.status, 'threshold_not_met');
    assert.equal(lowResult.crossTotal, 12);
    assert.ok(lowResult.directions.every(item => item.gatePassed === false));

    const collisionDocumentVectors = firstFixtureDocuments.map(() => [1, 0, 0, 0]);
    const collisionResult = api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, collisionDocumentVectors, 'document', api)
    });
    assert.equal(collisionResult.verified, false);
    assert.ok(collisionResult.directions.every(item => item.gatePassed === true));
    assert.ok(collisionResult.directions.every(item => item.separationPassed === false));

    assert.throws(() => api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: { ...resultEnvelope(settings, lowDocumentVectors, 'document', api), model: 'foreign-model' }
    }), /provider\/model|profile/i, 'query/document profile mismatch fails closed');

    const invalidVectors = lowDocumentVectors.map(vector => vector.slice());
    invalidVectors[0][0] = Number.NaN;
    assert.throws(() => api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, invalidVectors, 'document', api)
    }), /non-finite|invalid dimension/i);

    const infiniteVectors = lowDocumentVectors.map(vector => vector.slice());
    infiniteVectors[0][0] = Number.POSITIVE_INFINITY;
    assert.throws(() => api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, infiniteVectors, 'document', api)
    }), /non-finite|invalid dimension/i);

    const zeroVectors = lowDocumentVectors.map(vector => vector.slice());
    zeroVectors[0] = [0, 0, 0, 0];
    assert.throws(() => api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, zeroVectors, 'document', api)
    }), /zero magnitude/i);

    const nonNormalizedVectors = lowDocumentVectors.map(vector => vector.map(value => value * 2));
    assert.throws(() => api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, nonNormalizedVectors, 'document', api)
    }), /not normalized/i);

    const wrongDimensionVectors = firstFixtureDocuments.map(() => [1, 0, 0]);
    assert.throws(() => api._test.evaluateMultilingualEmbeddingProbe({
      settings,
      inputs: { queries: firstFixtureQueries, documents: firstFixtureDocuments },
      queryResult: resultEnvelope(settings, lowQueryVectors, 'query', api),
      documentResult: resultEnvelope(settings, wrongDimensionVectors, 'document', api)
    }), /requires 4|dimension/i);

    const compatibility = await api._test.inspectMultilingualProbeCompatibility(settings, first);
    assert.equal(compatibility.total, 0);
    assert.equal(compatibility.reembedRequired, 0);
    assert.equal(compatibility.integrityIssue, false);

    const diagnostic = api._test.multilingualProbeDiagnosticSummary({ ...first, compatibility });
    const diagnosticJson = JSON.stringify(diagnostic);
    assert.equal(diagnostic.crossTotal, 24);
    assert.doesNotMatch(diagnosticJson, /test-secret-not-for-output|mock\.example|빨간 열쇠|red key/,
      'sanitized diagnostics exclude credentials, endpoint and fixture text');
    const redactedProbeError = api._test.sanitizeMultilingualProbeMessage('failed at https://mock.example/v1?api_key=test-secret-not-for-output');
    assert.doesNotMatch(redactedProbeError, /mock\.example|test-secret-not-for-output/);
    assert.match(redactedProbeError, /\[endpoint\]/);

    assert.equal(api._test.classifyEmbeddingError({ status: 401, message: 'request rejected' }).type, 'AUTH_ERROR');
    assert.equal(api._test.classifyEmbeddingError({ status: 429, message: 'request rejected' }).type, 'RATE_LIMIT');
    assert.equal(api._test.classifyEmbeddingError({ status: 503, message: 'request rejected' }).type, 'SERVER_ERROR');
    const abortError = new Error('request cancelled');
    abortError.name = 'AbortError';
    assert.equal(api._test.classifyEmbeddingError(abortError).type, 'ABORTED');

    const callsBeforeHash = networkCalls.length;
    await assert.rejects(
      api._test.runMultilingualEmbeddingProbe(api._test.normalizeSettings({ embeddingProvider: 'hash' })),
      error => error?.code === 'FLASHBACK_MULTILINGUAL_PROBE_NOT_APPLICABLE'
    );
    assert.equal(networkCalls.length, callsBeforeHash, 'hash provider is rejected without a probe call');

    const controller = new AbortController();
    controller.abort('test_cancel');
    await assert.rejects(
      api._test.runMultilingualEmbeddingProbe(settings, { signal: controller.signal }),
      error => error?.type === 'ABORTED' || error?.code === 'FLASHBACK_MULTILINGUAL_PROBE_CANCELLED'
    );

    process.stdout.write('flashback_multilingual_embedding_probe_test: PASS\n');
  } finally {
    for (const handler of unloadHandlers.reverse()) await Promise.resolve(handler()).catch(() => {});
    for (const timer of activeTimeouts) clearTimeout(timer);
    for (const timer of activeIntervals) clearInterval(timer);
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
