'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_EMBED_FP_TEST__ = {
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,
  MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null
};
`;
const exportIndex = code.lastIndexOf('\n})();');
if (exportIndex >= 0) code = code.slice(0, exportIndex) + exportSnippet + code.slice(exportIndex);
else code += exportSnippet;

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this._id = '';
    this.className = '';
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._innerHTML = '';
    this.textContent = '';
  }
  set id(v) { this._id = String(v || ''); if (this.ownerDocument) this.ownerDocument._register(this); }
  get id() { return this._id; }
  set innerHTML(v) { this._innerHTML = String(v || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id && this.ownerDocument) this.ownerDocument._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; if (this.ownerDocument && this.id) delete this.ownerDocument._ids[this.id]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}

class FakeDocument {
  constructor() {
    this._ids = Object.create(null);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }
  _register(el) { if (el && el.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(selector) {
    if (selector === 'head') return this.head;
    if (selector === 'body') return this.body;
    return null;
  }
}

function assertCase(assertions, name, ok, detail = null) {
  assertions.push({ name, ok: !!ok, detail });
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
  let fetchCalls = 0;
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return key === 'activity_dashboard' ? 'off' : undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); }
    },
    async getCharacter() { return null; },
    async registerSetting() {},
    async registerButton() {},
    async requestPluginPermission() { return false; },
    async onUnload() {}
  };
  const mockFetch = async () => {
    fetchCalls += 1;
    const n = fetchCalls;
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ embedding: [n, 0.25, 1] }] };
      },
      async text() {
        return JSON.stringify({ data: [{ embedding: [n, 0.25, 1] }] });
      }
    };
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    URL,
    Promise,
    globalThis: null,
    window: null,
    document,
    Risuai,
    risuai: Risuai,
    structuredClone: global.structuredClone,
    fetch: mockFetch,
    AbortController,
    performance: { now: () => Date.now() }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 50));

  const api = context.__LIBRA_EMBED_FP_TEST__ || {};
  const engine = api.MemoryEngine;
  const state = api.MemoryState;
  const assertions = [];

  assertCase(assertions, 'memory_engine_exported', !!engine && !!engine.EmbeddingEngine);
  assertCase(assertions, 'memory_state_exported', !!state);

  Object.assign(engine.CONFIG.embed, {
    enabled: true,
    provider: 'openai',
    url: 'http://mock.local/v1/embeddings',
    key: 'dummy-key',
    model: 'embed-a',
    timeout: 5000
  });
  engine.CONFIG.embeddingCacheMaxEntries = 128;
  engine.CONFIG.embeddingCacheMaxTextChars = 8000;

  const text = 'A sufficiently long embedding cache test sentence.';
  const first = await engine.EmbeddingEngine.getEmbedding(text, { source: 'unit_fp_first' });
  const second = await engine.EmbeddingEngine.getEmbedding(text, { source: 'unit_fp_second' });
  let debug = engine.EmbeddingEngine.getDebugSnapshot();
  assertCase(assertions, 'second_embedding_uses_cache', fetchCalls === 1 && debug.cacheHits >= 1 && Array.isArray(first) && Array.isArray(second), {
    fetchCalls,
    debug
  });

  const cache = state.embeddingCache;
  const key = cache?.cache ? Array.from(cache.cache.keys())[0] : '';
  cache.set(key, {
    schema: 'libra.embedding.cache.v1',
    fingerprint: { provider: 'openai', model: 'different-model', endpointHash: 'bad-endpoint', dim: 3 },
    dim: 3,
    vector: [9, 9, 9],
    cachedAt: Date.now()
  });
  const third = await engine.EmbeddingEngine.getEmbedding(text, { source: 'unit_fp_invalidated' });
  debug = engine.EmbeddingEngine.getDebugSnapshot();
  assertCase(assertions, 'fingerprint_mismatch_invalidates_cache', fetchCalls === 2 && debug.fingerprintInvalidations >= 1 && Array.isArray(third) && third[0] === 2, {
    fetchCalls,
    debug
  });

  cache.set(key, [0.5, 0.25, 0.125]);
  const beforeLegacyFetchCalls = fetchCalls;
  const legacy = await engine.EmbeddingEngine.getEmbedding(text, { source: 'unit_fp_legacy' });
  debug = engine.EmbeddingEngine.getDebugSnapshot();
  assertCase(assertions, 'legacy_vector_cache_remains_readable', fetchCalls === beforeLegacyFetchCalls && debug.legacyCacheHits >= 1 && Array.isArray(legacy) && legacy[0] === 0.5, {
    fetchCalls,
    debug
  });

  const fp3 = engine.EmbeddingEngine.getFingerprint([1, 2, 3]);
  const fp2 = engine.EmbeddingEngine.getFingerprint([1, 2]);
  const stats = engine.getCacheStats();
  assertCase(assertions, 'fingerprint_includes_dimension', fp3 !== fp2 && /:3$/.test(fp3) && /:2$/.test(fp2), { fp3, fp2 });
  assertCase(assertions, 'cache_stats_include_embedding_debug', stats?.embedding?.size >= 1 && stats?.embeddingDebug?.fingerprintInvalidations >= 1, stats);

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'embedding_fingerprint_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
