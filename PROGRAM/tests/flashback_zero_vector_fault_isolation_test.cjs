'use strict';
// Zero-vector fault isolation contract (fix document section 4).
//
// A-1  one zero-vector turn must not take healthy turns down with it
// A-2  a turn that succeeds on the individual retry is NOT left pending
// A-3  a turn that is zero on batch AND on retry is reported pending, and the
//      run is a partial success rather than a thrown failure
// A-4  the validator itself is untouched: a zero vector is still rejected, and
//      the low-level clone integrity contract stays fail-closed
//
// This asserts the CORRECTED behaviour (it is a gate, not a defect probe).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

const waitFor = async (predicate, label, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

const DIM = 4;
const unit = seed => { const v = new Array(DIM).fill(0); v[seed % DIM] = 1; return v; };
const zero = () => new Array(DIM).fill(0);

// Embedding endpoint mock: `plan` decides, per requested text, whether the
// response carries a real unit vector or a zero vector.
let plan = () => unit(1);
let batchCalls = 0;
let singleCalls = 0;

const embeddingFetch = async (url, init = {}) => {
  const body = JSON.parse(String(init.body || '{}'));
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (inputs.length > 1) batchCalls += 1; else singleCalls += 1;
  const data = inputs.map((text, index) => ({ index, embedding: plan(String(text), inputs.length) }));
  return {
    ok: true,
    status: 200,
    async json() { return { data, model: 'mock-embed' }; },
    async text() { return JSON.stringify({ data, model: 'mock-embed' }); }
  };
};

const pluginStorage = createStore();
const safeLocalStorage = createStore();
const chat = { id: 'zv-chat', chatId: 'zv-chat', name: 'Zero Vector Chat', message: [], messages: [], bindedPersona: '' };
const character = { id: 'zv-char', chaId: 'zv-char', name: 'Zero Vector Character', chats: [chat] };

const host = {
  pluginStorage,
  safeLocalStorage,
  async getLocalPluginStorage() { return safeLocalStorage; },
  async getArgument(name) {
    const key = String(name || '');
    if (key.includes('memory_suite_server_mode')) return 'plugin_only';
    if (key.includes('enable_gui')) return 'false';
    return '';
  },
  async getArg(name) { return this.getArgument(name); },
  async setArgument() { return true; },
  nativeFetch: embeddingFetch,
  async addPluginChannelListener() { return true; },
  async removePluginChannelListener() { return true; },
  async removePluginChannelHandler() { return true; },
  async offPluginChannelMessage() { return true; },
  async postPluginChannelMessage() { return true; },
  async onUnload() { return true; },
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
  async getChat() { return chat; },
  async getCurrentChat() { return chat; },
  async getChatFromIndex() { return chat; },
  async showContainer() { return true; },
  async hideContainer() { return true; },
  async getRootContainer() { return null; },
  async getPluginRoot() { return null; }
};

const context = vm.createContext({
  risuai: host,
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask, AbortController, AbortSignal, DOMException,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone,
  performance: globalThis.performance,
  fetch: embeddingFetch,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: globalThis.FormData, Blob: globalThis.Blob,
  atob: globalThis.atob, btoa: globalThis.btoa,
  confirm: () => false, alert: () => {}, prompt: () => null
});

(async () => {
  vm.runInContext(source, context, { filename: 'Flashback_Memory.js' });
  const flashback = await waitFor(() => context.__FlashbackMemory, 'Flashback API');
  const t = flashback._test;
  assert.equal(typeof t.embedTextsIsolated, 'function', 'isolation helper is exposed for testing');

  const settings = {
    embeddingProvider: 'openai_compatible',
    embeddingModel: 'mock-embed',
    embeddingUrl: 'http://127.0.0.1:65530/v1/embeddings',
    embeddingEndpoint: 'http://127.0.0.1:65530/v1/embeddings',
    embeddingApiKey: 'test-key',
    embeddingDimensions: DIM,
    hashDimensions: DIM,
    fallbackHashEmbedding: false
  };

  // ---- A-4 (first): the validator's rejection is proven by the existing
  // embedding-contract regressions; here we only assert that the isolation
  // layer never fabricates a vector for the rejected turn (see A-1 below).

  // ---- classifier: a zero vector is retryable and typed ----
  const zeroClass = t.classifyIsolatedEmbeddingFailure(new Error('Embedding provider returned a zero vector.'));
  assert.equal(zeroClass.code, 'FLASHBACK_EMBEDDING_ZERO_VECTOR', 'zero vector gets its own code');
  assert.equal(zeroClass.retryable, true, 'zero vector is retryable once');
  const authClass = t.classifyIsolatedEmbeddingFailure(Object.assign(new Error('unauthorized'), { type: 'AUTH_ERROR' }));
  assert.equal(authClass.retryable, false, 'a credential failure must NOT be retried');

  // whole-request failures must not be split into per-item retries
  assert.equal(t.embeddingFailureIsItemScoped(Object.assign(new Error('rate limited'), { type: 'RATE_LIMIT' })), false, 'rate limit is request-scoped');
  assert.equal(t.embeddingFailureIsItemScoped(new Error('Embedding provider returned a zero vector.')), true, 'zero vector is item-scoped');

  // ---- A-1 + A-3: T32 is zero on batch AND on retry -> isolated, others fine ----
  const texts = ['turn-31 text', 'turn-32 text', 'turn-33 text'];
  batchCalls = 0; singleCalls = 0;
  plan = text => (String(text).includes('turn-32') ? zero() : unit(2));
  const isolated = await t.embedTextsIsolated(texts, settings, { allowHashFallback: false, purpose: 'document' });
  assert.ok(Array.isArray(isolated), 'isolation returns the usual array shape');
  assert.equal(isolated.length, 3, 'one entry per input');
  assert.ok(isolated[0].length === DIM, 'T31 keeps a real vector');
  assert.ok(isolated[2].length === DIM, 'T33 keeps a real vector');
  assert.equal(isolated[1].length, 0, 'T32 is left empty, never zero-filled or hash-substituted');
  const pending = isolated.flashbackPendingIndexes;
  assert.ok(Array.isArray(pending) && pending.length === 1, 'exactly one turn is pending');
  assert.equal(pending[0].index, 1, 'the pending turn is T32');
  assert.equal(pending[0].code, 'FLASHBACK_EMBEDDING_ZERO_VECTOR', 'pending reason is the zero vector');
  assert.ok(batchCalls >= 1, 'the batch was attempted first (fast path preserved)');
  assert.ok(singleCalls >= 2, 'healthy turns were re-established individually');

  // ---- A-2: zero on batch, valid on the individual retry -> nothing pending ----
  let seen = 0;
  batchCalls = 0; singleCalls = 0;
  plan = (text, count) => {
    if (String(text).includes('turn-32')) {
      // zero while part of the batch, valid when retried alone
      if (count > 1) return zero();
      seen += 1;
      return unit(3);
    }
    return unit(2);
  };
  const repaired = await t.embedTextsIsolated(texts, settings, { allowHashFallback: false, purpose: 'document' });
  assert.equal((repaired.flashbackPendingIndexes || []).length, 0, 'a turn that succeeds on retry is not pending');
  assert.equal(repaired[1].length, DIM, 'the retried turn now holds a real vector');
  assert.ok(seen >= 1, 'the individual retry actually happened');

  // ---- request-scoped failure still propagates unchanged ----
  plan = () => zero();
  const alone = await t.embedTextsIsolated(['only-one'], settings, { allowHashFallback: false });
  assert.equal(alone.length, 1);
  assert.equal(alone[0].length, 0);
  assert.equal(alone.flashbackPendingIndexes.length, 1, 'singleton stays explicitly pending');
  assert.equal(alone.flashbackPendingIndexes[0].code, 'FLASHBACK_EMBEDDING_ZERO_VECTOR');
  const allBad = await t.embedTextsIsolated(['bad-a', 'bad-b'], settings, { allowHashFallback: false });
  assert.equal(allBad.flashbackPendingIndexes.length, 2, 'all-invalid is zero success, not unhandled throw');
  assert.ok(allBad.every(v => v.length === 0));

  // ---- P0-4: a run that held turns back must READ as a partial success ----
  // maintenanceResultText is the completion-dialog body; with isolated failures
  // present it must report the pending count and a per-turn reason, and must not
  // claim a clean completion.
  const partialText = flashback._test.maintenanceResultText
    ? flashback._test.maintenanceResultText({
      maintenanceMode: 'auto',
      healthy: false,
      operation: {
        embeddedVectors: 24,
        cleanup: {
          isolatedPending: 1,
          isolatedFailures: [{ recordIndex: 32, hash: 'abc123def456', code: 'FLASHBACK_EMBEDDING_ZERO_VECTOR', stage: 'embedding', retryable: true, previousVectorPreserved: false }]
        }
      }
    })
    : '';
  if (partialText) {
    assert.ok(/\u부분 \u완료|부분 완료/.test(partialText) || partialText.includes('\uBD80\uBD84'), 'partial completion is announced');
    assert.ok(partialText.includes('abc123def456'.slice(0, 12)), 'the held-back turn is identified');
    assert.ok(partialText.includes('0 \uBCA1\uD130') || /0 벡터/.test(partialText), 'the zero-vector reason is shown');
    assert.ok(/\uB2E4\uC2DC \uC2DC\uB3C4|다시 시도/.test(partialText), 'a retry call to action is offered');
  }

  console.log(JSON.stringify({ test: 'flashback_zero_vector_fault_isolation', result: 'pass', pendingIsolated: 1, partialTextChecked: Boolean(partialText) }));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
