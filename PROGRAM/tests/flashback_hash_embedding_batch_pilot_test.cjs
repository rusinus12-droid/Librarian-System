'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { DEFINITIONS, executeOperation } = require('../server/compute/registry.cjs');
const { digestJson } = require('../server/compute/contracts.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'plugins', 'Flashback_Memory.js'), 'utf8');
const computeSdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8').trimEnd();

const localStart = source.indexOf('  const hashEmbeddingBatchLocal =');
const wrapperStart = source.indexOf('  const hashEmbeddingBatch =', localStart);
const nextFunctionStart = source.indexOf('  const tagEmbeddingVectors =', wrapperStart);
assert.ok(localStart >= 0, 'Flashback exposes the explicit local hash batch kernel');
assert.ok(wrapperStart > localStart, 'Flashback keeps the public hash batch wrapper after the local kernel');
assert.ok(nextFunctionStart > wrapperStart, 'Flashback hash batch wrapper has a bounded source section');

const localBlock = source.slice(localStart, wrapperStart);
const wrapperBlock = source.slice(wrapperStart, nextFunctionStart);
const bridgeBlock = source.slice(wrapperStart - 5000, wrapperStart);
assert.equal((source.match(/\/\* LIBRARIAN SYSTEM COMPUTE SDK v/g) || []).length, 1, 'Flashback embeds one explicit Compute SDK marker');
assert.equal(source.split(computeSdk).length - 1, 1, 'Flashback embeds the canonical Compute SDK source exactly once');
assert.doesNotMatch(source, /^\/\/@arg memory_suite_flashback_compute_mode\b/m);
assert.match(wrapperBlock, /getScopeExecutionPolicy\(/, 'Storage scope policy selects local or prefer_server');
assert.doesNotMatch(source, /memory_suite_compute_pairing|X-Memory-Suite-Compute-Pairing/);
assert.match(source, /return list\.length >= 8 \|\| chars >= 24000;/, 'worker threshold remains unchanged');
assert.match(localBlock, /if \(shouldUseWorkerForHashBatch\(list\)\)/, 'local kernel retains worker selection');
assert.match(localBlock, /runComputeWorker\('hashEmbeddingBatch', \{ texts: list, dimensions \}\)/, 'local kernel retains the browser worker operation');
assert.match(localBlock, /compute worker hash embedding failed; using main thread fallback/, 'local kernel retains the worker failure fallback');
assert.match(localBlock, /return list\.map\(item => hashEmbedding\(item, dimensions\)\);/, 'local kernel retains the main-thread calculation');
assert.match(bridgeBlock, /flashback\.hash-embedding-batch\.v1/, 'bridge registers the allowlisted Flashback operation');
assert.match(bridgeBlock, /0beced005ede9fec5b1ba181f740440daf47184ad321301bcb3fab9c2ff7b3ed/, 'bridge pins the server algorithm fingerprint');
assert.doesNotMatch(bridgeBlock, /capabilityProvider|MemorySuiteStorageBridge\.bootstrap/, 'compute bootstrap is independent of Storage');
assert.match(bridgeBlock, /local: flashbackHashComputeResult/, 'registered local executor wraps hashEmbeddingBatchLocal');
assert.match(bridgeBlock, /vector\.length !== dimensions[\s\S]*Number\.isFinite/, 'candidate validation checks vector width and finite values');
assert.match(wrapperBlock, /MemorySuiteComputeBridge\.execute\(/, 'wrapper delegates through the thin Compute bridge');
assert.match(wrapperBlock, /return envelope\.result\.vectors\.map\(vector => vector\.slice\(\)\);/, 'wrapper preserves the original mutable vectors-only return contract');
assert.doesNotMatch(wrapperBlock, /hashEmbeddingBatchLocal\(/, 'wrapper never starts a second ad-hoc local fallback');
assert.doesNotMatch(wrapperBlock, /runComputeWorker|nativeFetch|fetch\s*\(|backend/i, 'wrapper has no transport or worker implementation of its own');
assert.match(source, /await MemorySuiteComputeBridge\?\.dispose\?\.\(\)/, 'primary unload disposes the Compute bridge');
assert.match(source, /publicApi\._test\.hashEmbeddingBatchLocal = hashEmbeddingBatchLocal;/, 'local kernel is available to focused tests');
assert.match(source, /publicApi\._test\.hashEmbeddingBatch = hashEmbeddingBatch;/, 'wrapper is available to focused tests');

const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const createStore = () => {
  const values = new Map();
  return {
    async getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    async setItem(key, value) { values.set(String(key), value); return true; },
    async removeItem(key) { values.delete(String(key)); return true; },
    async keys() { return Array.from(values.keys()); }
  };
};

const createHarness = (pluginSource, options = {}) => {
  const listeners = new Map();
  const unloadHandlers = [];
  const networkCalls = [];
  const argumentValues = new Map([
    ['memory_suite_server_mode', String(options.storageMode || 'plugin_only')],
    ['memory_suite_server_url', String(options.serverUrl || 'http://127.0.0.1:47630')],
    ['enable_gui', 'false']
  ]);
  const pluginStorage = createStore();
  const safeLocalStorage = createStore();
  const chat = {
    id: 'hash-embedding-pilot-chat',
    chatId: 'hash-embedding-pilot-chat',
    name: 'Hash Embedding Pilot',
    message: [],
    messages: [],
    bindedPersona: ''
  };
  const character = { id: 'hash-embedding-pilot-character', name: 'Hash Embedding Pilot', chats: [chat] };
  const host = {
    pluginStorage,
    safeLocalStorage,
    async getLocalPluginStorage() { return safeLocalStorage; },
    async getArgument(name) {
      return argumentValues.get(String(name)) || '';
    },
    async getArg(name) { return await host.getArgument(name); },
    async setArgument(name, value) { argumentValues.set(String(name), String(value)); return true; },
    async nativeFetch(url, init = {}) {
      networkCalls.push({ url: String(url), method: String(init?.method || 'GET') });
      if (typeof options.nativeFetch === 'function') return await options.nativeFetch(url, init);
      throw new TypeError('fetch failed');
    },
    async addPluginChannelListener(channel, handler) {
      const key = String(channel);
      const handlers = listeners.get(key) || new Set();
      handlers.add(handler);
      listeners.set(key, handlers);
      return true;
    },
    async removePluginChannelListener(channel, handler) {
      listeners.get(String(channel))?.delete(handler);
      return true;
    },
    async postPluginChannelMessage() { return true; },
    async onUnload(handler) { unloadHandlers.push(handler); return true; },
    async requestPluginPermission() { return true; },
    async registerSetting() { return true; },
    async registerButton() { return true; },
    async unregisterSetting() { return true; },
    async unregisterButton() { return true; },
    async registerUIPart() { return true; },
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
    async getChat() { return chat; },
    async getCurrentChat() { return chat; },
    async getChatFromIndex() { return chat; },
    async showContainer() { return true; },
    async hideContainer() { return true; },
    async getRootContainer() { return null; },
    async getPluginRoot() { return null; }
  };

  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  const trackedSetTimeout = (handler, delay, ...args) => {
    let timer = null;
    timer = setTimeout((...inner) => {
      activeTimeouts.delete(timer);
      handler(...inner);
    }, delay, ...args);
    activeTimeouts.add(timer);
    return timer;
  };
  const trackedClearTimeout = timer => {
    activeTimeouts.delete(timer);
    clearTimeout(timer);
  };
  const trackedSetInterval = (handler, delay, ...args) => {
    const timer = setInterval(handler, delay, ...args);
    activeIntervals.add(timer);
    return timer;
  };
  const trackedClearInterval = timer => {
    activeIntervals.delete(timer);
    clearInterval(timer);
  };

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
  vm.runInContext(pluginSource, context, { filename: 'flashback-hash-embedding-pilot.js' });

  return {
    context,
    host,
    argumentValues,
    networkCalls,
    cleanup: async () => {
      for (const handler of unloadHandlers.slice().reverse()) {
        try { await handler(); } catch (_) {}
      }
      for (const timer of activeTimeouts) clearTimeout(timer);
      for (const timer of activeIntervals) clearInterval(timer);
    }
  };
};

const plainVectors = vectors => Array.from(vectors, vector => Array.from(vector));

const assertBatchParity = async (testApi, values, dimensions, label) => {
  const expected = values.map(value => Array.from(testApi.hashEmbedding(value, dimensions)));
  const local = plainVectors(await testApi.hashEmbeddingBatchLocal(values, dimensions));
  const wrapped = plainVectors(await testApi.hashEmbeddingBatch(values, dimensions));
  assert.deepEqual(local, expected, `${label}: local batch matches the pre-existing single-item calculation`);
  assert.deepEqual(wrapped, expected, `${label}: wrapper matches the pre-existing single-item calculation`);
  assert.deepEqual(wrapped, local, `${label}: wrapper and explicit local kernel are identical`);
  return local;
};

const hashOperation = DEFINITIONS['flashback.hash-embedding-batch.v1'];
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload)
});
const createMockComputeFetch = ({ executeDelayMs = 0, transformResult = null } = {}) => async (urlValue, init = {}) => {
  const url = new URL(String(urlValue));
  if (url.pathname === '/v1/compute/bootstrap') {
    assert.equal(init.headers['X-Memory-Suite-Compute-Pairing'], undefined);
    assert.equal(init.headers.Authorization, undefined);
    return jsonResponse({
      ok: true,
      schema: 'memory-suite.compute.bootstrap.v1',
      name: 'Librarian System Compute Mock',
      version: 'compute-mock',
      url: url.origin,
      token: 'compute-token',
      authorization: {
        schema: 'memory-suite.compute-authorization.v1',
        pluginId: 'flashback_memory',
        namespace: 'flashback',
        roles: ['compute']
      },
      capabilities: { 'compute.v1': true, 'compute-jobs.v1': true, 'compute-worker-pool.v1': true },
      limits: { maxExecuteDeadlineMs: 30000 },
      operations: [{ operation: hashOperation.operation, algorithmFingerprint: hashOperation.fingerprint, maxDeadlineMs: hashOperation.maxDeadlineMs }]
    });
  }
  if (url.pathname === '/v1/compute/execute') {
    const body = JSON.parse(init.body);
    if (executeDelayMs) await new Promise(resolve => setTimeout(resolve, executeDelayMs));
    const calculated = executeOperation(body.operation, body.input);
    const result = typeof transformResult === 'function' ? transformResult(calculated) : calculated;
    return jsonResponse({
      ok: true,
      schema: 'memory-suite.compute.execute-response.v1',
      result: {
        schema: 'memory-suite.compute.result.v1',
        jobId: `cmp_${'a'.repeat(24)}`,
        operationId: body.operationId,
        namespace: body.namespace,
        operation: body.operation,
        algorithmFingerprint: body.algorithmFingerprint,
        inputDigest: body.inputDigest,
        binding: body.binding,
        result,
        resultDigest: digestJson(result),
        timing: { queueMs: 0, workerMs: executeDelayMs, totalMs: executeDelayMs }
      }
    });
  }
  throw new Error(`unexpected_mock_compute_route:${url.pathname}`);
};
const repositoryDigests = app => Object.fromEntries(Object.entries(app.repositories).map(([name, repository]) => [
  name,
  crypto.createHash('sha256').update(fs.readFileSync(repository.filePath)).digest('hex')
]));

(async () => {
  {
    const harness = createHarness(source, { storageMode: 'plugin_only' });
    let testApi = null;
    try {
      const api = await waitFor(() => harness.context.__FlashbackMemory, 'Flashback API');
      testApi = api._test;
      assert.equal(typeof testApi.hashEmbedding, 'function', 'pre-existing single-item hash function is exposed');
      assert.equal(typeof testApi.hashEmbeddingBatchLocal, 'function', 'explicit local batch kernel is exposed');
      assert.equal(typeof testApi.hashEmbeddingBatch, 'function', 'batch wrapper is exposed');

      const mutableVectors = await testApi.hashEmbeddingBatch(['metadata compatibility'], 64);
      assert.equal(Object.isFrozen(mutableVectors), false, 'wrapper detaches the vectors array from the frozen compute envelope');
      assert.equal(Object.isFrozen(mutableVectors[0]), false, 'wrapper detaches each vector from the frozen compute envelope');
      Object.defineProperty(mutableVectors, 'flashbackPilotMetadata', { value: true, configurable: true });
      assert.equal(mutableVectors.flashbackPilotMetadata, true, 'existing embedding metadata can still be attached');

      const unicodeFixtures = [
        'Librarian System deterministic recall baseline',
        '서울의 밤과 오래된 기억을 다시 찾는다',
        '東京の記憶と回忆を照合する',
        'emoji 🚀 and combining e\u0301 versus é',
        ''
      ];
      for (const dimensions of [64, 127, 384]) {
        const vectors = await assertBatchParity(testApi, unicodeFixtures, dimensions, `unicode dimensions=${dimensions}`);
        assert.ok(vectors.every(vector => vector.length === dimensions), `dimensions=${dimensions}: output width is preserved`);
        assert.ok(vectors.slice(0, -1).every(vector => {
          const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
          return Math.abs(norm - 1) <= 1e-12;
        }), `dimensions=${dimensions}: non-empty Unicode fixtures remain normalized`);
        assert.ok(vectors.at(-1).every(value => value === 0), `dimensions=${dimensions}: empty text remains a zero vector`);
      }

      for (const [requested, expectedWidth] of [[1, 64], [4097, 4096], [Number.NaN, 384]]) {
        const [vector] = await assertBatchParity(testApi, ['dimension clamp fixture'], requested, `dimension clamp=${String(requested)}`);
        assert.equal(vector.length, expectedWidth, `dimension clamp=${String(requested)}: expected output width`);
      }

      assert.deepEqual(plainVectors(await testApi.hashEmbeddingBatchLocal([], 128)), [], 'local empty batch stays empty');
      assert.deepEqual(plainVectors(await testApi.hashEmbeddingBatch([], 128)), [], 'wrapper empty batch stays empty');
      assert.deepEqual(plainVectors(await testApi.hashEmbeddingBatchLocal('not-an-array', 128)), [], 'local non-array input stays empty');
      assert.deepEqual(plainVectors(await testApi.hashEmbeddingBatch('not-an-array', 128)), [], 'wrapper non-array input stays empty');

      const largeBatch = Array.from({ length: 12 }, (_, index) => (
        `대용량 배치 ${index} — deterministic memory recall 東京 回忆 ${'segment '.repeat(40 + index)}`
      ));
      const largeVectors = await assertBatchParity(testApi, largeBatch, 192, 'large batch worker-to-main fallback');
      assert.equal(largeVectors.length, largeBatch.length, 'large batch preserves item count');
      assert.ok(largeVectors.every(vector => vector.length === 192), 'large batch preserves requested dimensions');
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.equal(harness.networkCalls.length, 0, 'local mode and its background timer perform zero nativeFetch calls');
    } finally {
      await harness.cleanup();
      assert.equal(testApi?.memorySuiteComputeStatus()?.disposed, true, 'Flashback unload disposes the Compute bridge');
    }
  }

  {
    const harness = createHarness(source, { storageMode: 'mirror' });
    try {
      const testApi = (await waitFor(() => harness.context.__FlashbackMemory, 'offline Flashback API'))._test;
      const values = ['offline fallback one', '오프라인 로컬 폴백'];
      const expected = values.map(value => Array.from(testApi.hashEmbedding(value, 96)));
      const actual = plainVectors(await testApi.hashEmbeddingBatch(values, 96));
      assert.deepEqual(actual, expected, 'server-off prefer_server preserves the original vectors');
      const computeStatus = testApi.memorySuiteComputeStatus();
      assert.equal(computeStatus.counters.local, 1, 'server-off prefer_server invokes the registered local executor exactly once');
      assert.equal(computeStatus.counters.fallbacks, 1, 'server-off prefer_server records one local fallback');
      assert.equal(harness.networkCalls.length, 1, 'server-off prefer_server attempts only direct Compute bootstrap');
      assert.match(harness.networkCalls[0].url, /\/v1\/compute\/bootstrap$/);
    } finally {
      await harness.cleanup();
    }
  }

  for (const invalidCandidate of [
    {
      label: 'numeric-string vector value',
      transformResult(result) {
        const vectors = result.vectors.map(vector => vector.slice());
        vectors[0][0] = String(vectors[0][0]);
        return { ...result, vectors };
      }
    },
    {
      label: 'incorrect totalChars',
      transformResult(result) { return { ...result, totalChars: result.totalChars + 1 }; }
    },
    {
      label: 'abnormal non-unit vector norm',
      transformResult(result) {
        const vectors = result.vectors.map(vector => vector.slice());
        vectors[0][0] += 3;
        return { ...result, vectors };
      }
    }
  ]) {
    const harness = createHarness(source, {
      storageMode: 'mirror',
      nativeFetch: createMockComputeFetch({ transformResult: invalidCandidate.transformResult })
    });
    try {
      const testApi = (await waitFor(() => harness.context.__FlashbackMemory, `${invalidCandidate.label} Flashback API`))._test;
      const values = ['candidate validation fixture'];
      const expected = values.map(value => Array.from(testApi.hashEmbedding(value, 64)));
      const actual = plainVectors(await testApi.hashEmbeddingBatch(values, 64));
      assert.deepEqual(actual, expected, `${invalidCandidate.label}: invalid server candidate falls back to original local vectors`);
      const status = testApi.memorySuiteComputeStatus();
      assert.equal(status.counters.server, 0, `${invalidCandidate.label}: invalid server candidate is never adopted`);
      assert.equal(status.counters.local, 1, `${invalidCandidate.label}: local executor runs exactly once`);
      assert.equal(status.counters.fallbacks, 1, `${invalidCandidate.label}: fallback is recorded exactly once`);
    } finally {
      await harness.cleanup();
    }
  }

  {
    const tempRoot = path.resolve(os.tmpdir());
    const dataDir = fs.mkdtempSync(path.join(tempRoot, 'flashback-compute-pilot-'));
    assert.equal(path.dirname(dataDir), tempRoot);
    const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeWorkers: 2 });
    const address = await app.listen();
    const harness = createHarness(source, {
      storageMode: 'mirror',
      serverUrl: `http://127.0.0.1:${address.port}`,
      nativeFetch: async (url, init) => await fetch(url, init)
    });
    try {
      const testApi = (await waitFor(() => harness.context.__FlashbackMemory, 'server-backed Flashback API'))._test;
      const before = repositoryDigests(app);
      const values = ['real server pilot', '실제 워커 풀 연산'];
      const expected = values.map(value => Array.from(testApi.hashEmbedding(value, 64)));
      const actual = plainVectors(await testApi.hashEmbeddingBatch(values, 64));
      assert.deepEqual(actual, expected, 'actual server result preserves the pre-existing Flashback vectors');
      const status = testApi.memorySuiteComputeStatus();
      assert.equal(status.counters.server, 1, 'verified actual-server result is adopted');
      assert.equal(status.counters.local, 0, 'successful prefer_server does not run the local kernel');
      assert.deepEqual(repositoryDigests(app), before, 'actual compute never mutates canonical namespace databases');
    } finally {
      await harness.cleanup();
      await app.close();
      const resolved = path.resolve(dataDir);
      assert.equal(path.dirname(resolved), tempRoot, 'recursive cleanup remains confined to the OS temp directory');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  console.log('flashback hash embedding batch pilot test passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
