'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_HOT_INDEX_TEST__ = {
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

function memoryEntry(id, options = {}) {
  const turn = Number(options.turn || id || 1);
  const entity = options.entity || `Filler${id}`;
  const topic = options.topic || 'background-noise';
  const kind = options.kind || 'memory';
  const bucket = options.bucket || 'memory';
  const text = options.text || `${entity} keeps ordinary background note ${id}.`;
  const meta = {
    t: turn,
    ttl: -1,
    imp: Number(options.importance || 5),
    ent: [entity],
    tags: [topic],
    sourceHash: `hot-hash-${id}`,
    hme: { kind, primaryKind: kind, baseBucket: bucket }
  };
  const payload = {
    schema: 'libra.memory.payload.v1',
    turn,
    importance: Number(options.importance || 5),
    subject: entity,
    summary: text,
    topics: [topic],
    tags: [topic],
    hybridRow: { primaryKind: kind, kinds: [kind], baseBucket: bucket }
  };
  return {
    key: `hot-memory-${id}`,
    comment: 'lmai_memory',
    mode: 'normal',
    content: `[META:${JSON.stringify(meta)}]\n${JSON.stringify(payload)}\n`,
    insertorder: 10,
    alwaysActive: false
  };
}

(async () => {
  const document = new FakeDocument();
  const store = new Map();
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
    fetch: async () => { throw new Error('fetch not expected'); },
    AbortController,
    performance: { now: () => Date.now() }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 50));

  const api = context.__LIBRA_HOT_INDEX_TEST__ || {};
  const engine = api.MemoryEngine;
  const state = api.MemoryState;
  const assertions = [];

  assertCase(assertions, 'memory_engine_exported', !!engine && typeof engine.ensureHybridScopeIndex === 'function');

  Object.assign(engine.CONFIG, {
    debug: false,
    recallEmbeddingCandidateMax: 0,
    hybridMemoryEngineEnabled: true,
    hybridReadPathEnabled: true,
    hybridScopeIndexEnabled: true,
    hybridReadPathMaxRows: 10,
    hmeAssociativeGraphEnabled: false,
    coldArchiveHydrationEnabled: false
  });
  if (state) state._activeScopeKey = 'hot-index-scope';

  const lore = [];
  for (let i = 1; i <= 140; i += 1) lore.push(memoryEntry(i));
  lore.push(memoryEntry(900, {
    turn: 90,
    entity: 'Seraphina',
    topic: 'silver-orchard',
    kind: 'world',
    bucket: 'world',
    importance: 9,
    text: 'Seraphina guards the silver orchard rule and its moonlit vow.'
  }));
  lore.push(memoryEntry(901, {
    turn: 91,
    entity: 'Dohyun',
    topic: 'silver-orchard',
    kind: 'narrative',
    bucket: 'origin',
    importance: 8,
    text: 'Dohyun first heard the silver orchard vow from Seraphina.'
  }));

  const ensured = engine.ensureHybridScopeIndex(lore, { scopeKey: 'hot-index-scope', currentTurn: 150, force: true });
  const index = ensured?.index || null;
  const hotRows = (index?.rows || []).filter(row => row.hotIndexVersion >= 1);
  assertCase(assertions, 'hot_index_metadata_written', ensured?.ok === true && hotRows.length >= 2 && !!index?.inverted?.topic && !!index?.inverted?.entity && !!index?.inverted?.domain, {
    rowCount: index?.rowCount,
    topicBuckets: index?.inverted?.topic ? Object.keys(index.inverted.topic).length : 0,
    entityBuckets: index?.inverted?.entity ? Object.keys(index.inverted.entity).length : 0,
    domainBuckets: index?.inverted?.domain ? Object.keys(index.inverted.domain).length : 0
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assertCase(assertions, 'derived_index_uses_plugin_cache_not_lorebook',
    !lore.some(entry => ['lmai_hme_index', 'lmai_hme_graph_index'].includes(entry?.comment))
      && Array.from(store.keys()).some(key => key.includes('libra:v1:hme-derived:') && key.endsWith(':scope')),
    { loreDerivedRows: lore.filter(entry => /^lmai_hme_(?:index|graph_index)$/.test(entry?.comment || '')).length, storageKeys: Array.from(store.keys()) });

  const recalled = await engine.retrieveMemories(
    'Seraphina silver orchard world rule vow',
    150,
    lore.filter(entry => entry.comment === 'lmai_memory'),
    {
      focusNames: ['Seraphina'],
      directFocusNames: ['Seraphina'],
      recallFeedbackLorebook: lore
    },
    5
  );
  const debug = engine.getLastRetrievalDebug();
  const selectedKeys = recalled.map(entry => entry.key);
  assertCase(assertions, 'hot_index_preselects_bounded_candidates',
    debug?.hybridMemoryEngine?.scopeIndex?.mode === 'scope_index_preselect'
      && Number(debug.hybridMemoryEngine.scopeIndex.selectedRows || 0) <= 64
      && Number(debug.hybridMemoryEngine.scopeIndex.sourceCandidates || 0) >= 120,
    debug?.hybridMemoryEngine?.scopeIndex
  );
  assertCase(assertions, 'hot_index_uses_entity_topic_domain_hits',
    (debug?.hybridMemoryEngine?.scopeIndex?.topRows || []).some(row => Number(row.topicHits || 0) > 0)
      && (debug?.hybridMemoryEngine?.scopeIndex?.topRows || []).some(row => Number(row.domainHits || 0) > 0)
      && (debug?.hybridMemoryEngine?.scopeIndex?.topRows || []).some(row => Number(row.entityHits || 0) > 0)
      && selectedKeys.some(key => key === 'hot-memory-900' || key === 'hot-memory-901'),
    {
      selectedKeys,
      topRows: debug?.hybridMemoryEngine?.scopeIndex?.topRows
    }
  );

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'hot_index_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
