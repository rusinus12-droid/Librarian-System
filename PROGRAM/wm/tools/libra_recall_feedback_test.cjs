'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_RECALL_FEEDBACK_TEST__ = {
  RecallFeedbackManager: typeof RecallFeedbackManager !== 'undefined' ? RecallFeedbackManager : null,
  MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null,
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null
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

  const api = context.__LIBRA_RECALL_FEEDBACK_TEST__ || {};
  const manager = api.RecallFeedbackManager || context.LIBRA_RecallFeedbackManager;
  const state = api.MemoryState;
  const engine = api.MemoryEngine;
  const assertions = [];

  assertCase(assertions, 'recall_feedback_api_exported', !!manager && typeof manager.appendFeedback === 'function');
  assertCase(assertions, 'memory_state_exported', !!state && !!state.recentRecallInjectionByScope);
  assertCase(assertions, 'memory_engine_exported', !!engine && typeof engine.retrieveMemories === 'function');

  const snapshot = {
    scopeKey: 'scope-a',
    chatId: 'chat-a',
    requestType: 'model',
    requestSequence: 7,
    turn: 12,
    items: [
      {
        id: 'memory:promise',
        domain: 'memory',
        label: 'Ariel promise',
        preview: 'Ariel promised Dohyun to guard the moon seal.',
        terms: ['Ariel', 'Dohyun', 'moon seal', 'promise']
      },
      {
        id: 'memory:unused',
        domain: 'memory',
        label: 'unused clue',
        preview: 'The bronze key is hidden under the stairs.',
        terms: ['bronze key', 'stairs']
      },
      {
        id: 'entity:noah',
        domain: 'entity',
        label: 'Noah',
        preview: 'Noah is present in the observatory.',
        terms: ['Noah', 'observatory']
      }
    ]
  };
  const remembered = manager.rememberInjection(snapshot);
  const consumed = manager.consumeInjection('scope-a');
  assertCase(assertions, 'remember_and_consume_injection', remembered.changed === true && consumed?.items?.length === 3 && !state.recentRecallInjectionByScope.has('scope-a'), consumed);

  const response = 'Ariel reminds Dohyun about the moon seal, but Noah is not in the observatory tonight.';
  const record = manager.buildFeedbackRecord(consumed, response, { turn: 13, responseHash: 'resp-a' });
  const statuses = Object.fromEntries(record.items.map(item => [item.id, item.status]));
  assertCase(assertions, 'classifies_used_ignored_contradicted', statuses['memory:promise'] === 'used' && statuses['memory:unused'] === 'ignored' && statuses['entity:noah'] === 'contradicted', {
    statuses,
    counts: record.counts
  });

  const lore = [];
  const append = manager.appendFeedback(lore, consumed, response, { turn: 13, responseHash: 'resp-a' });
  const entry = lore.find(item => item.comment === 'lmai_recall_feedback');
  const parsed = entry ? JSON.parse(entry.content || '{}') : null;
  assertCase(assertions, 'feedback_entry_written', append.changed === true && parsed?.schema === 'libra.recall_feedback.v1' && parsed?.records?.length === 1, parsed);
  assertCase(assertions, 'feedback_entry_not_active_prompt', entry?.alwaysActive === false && entry?.comment !== 'lmai_memory', entry);

  manager.appendFeedback(lore, consumed, response, { turn: 13, responseHash: 'resp-a' });
  const deduped = JSON.parse(lore.find(item => item.comment === 'lmai_recall_feedback').content || '{}');
  assertCase(assertions, 'same_feedback_dedupes', deduped.records.length === 1, deduped);

  const listed = manager.list(lore, { limit: 5 });
  assertCase(assertions, 'feedback_list_reads_records', listed.length === 1 && listed[0].counts.used === 1 && listed[0].counts.contradicted === 1, listed);

  const scoringLore = [];
  const usedEntry = {
    key: 'memory:used',
    comment: 'lmai_memory',
    content: '[META:{"t":20,"ttl":-1,"imp":7,"sourceHash":"used-hash"}]\nAriel promised Dohyun to guard the moon seal near the observatory.\n',
    mode: 'normal'
  };
  const ignoredEntry = {
    key: 'memory:ignored',
    comment: 'lmai_memory',
    content: '[META:{"t":20,"ttl":-1,"imp":7,"sourceHash":"ignored-hash"}]\nDohyun studied the moon seal promise beside the observatory window.\n',
    mode: 'normal'
  };
  const scoringSnapshot = {
    scopeKey: 'scope-score',
    chatId: 'chat-a',
    requestType: 'model',
    requestSequence: 8,
    turn: 20,
    items: [
      {
        id: 'memory:used',
        domain: 'memory',
        label: 'Ariel promise',
        preview: 'Ariel promised Dohyun to guard the moon seal near the observatory.',
        terms: ['Ariel', 'promise']
      },
      {
        id: 'memory:ignored',
        domain: 'memory',
        label: 'observatory clue',
        preview: 'Dohyun studied the moon seal promise beside the observatory window.',
        terms: ['observatory', 'window']
      }
    ]
  };
  manager.appendFeedback(scoringLore, scoringSnapshot, 'Ariel keeps the promise and smiles.', { turn: 21, responseHash: 'resp-score' });
  scoringLore.push(usedEntry, ignoredEntry);
  engine.CONFIG.recallEmbeddingCandidateMax = 0;
  engine.CONFIG.hybridMemoryEngineEnabled = false;
  engine.CONFIG.hybridReadPathEnabled = false;
  engine.CONFIG.hmeAssociativeGraphEnabled = false;
  const recalled = await engine.retrieveMemories(
    'moon seal promise observatory',
    22,
    [usedEntry, ignoredEntry],
    { recallFeedbackLorebook: scoringLore },
    2
  );
  const recalledUsed = recalled.find(entry => entry.key === 'memory:used');
  const recalledIgnored = recalled.find(entry => entry.key === 'memory:ignored');
  const recallDebug = engine.getLastRetrievalDebug();
  assertCase(assertions, 'used_feedback_adds_soft_bonus', Number(recalledUsed?._recallFeedbackAdjustment || 0) > 0, {
    usedAdjustment: recalledUsed?._recallFeedbackAdjustment,
    recallDebug
  });
  assertCase(assertions, 'ignored_feedback_adds_soft_penalty', Number(recalledIgnored?._recallFeedbackAdjustment || 0) < 0, {
    ignoredAdjustment: recalledIgnored?._recallFeedbackAdjustment,
    recallDebug
  });
  assertCase(assertions, 'recall_feedback_debug_counts_adjusted_candidates', Number(recallDebug?.recallFeedback?.adjustedCandidates || 0) >= 2, recallDebug?.recallFeedback);

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'recall_feedback_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
