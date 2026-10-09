'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');

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

  const preflight = context.LIBRA_AnalysisBudgetPreflight;
  const assertions = [];
  assertCase(assertions, 'preflight_api_exported', !!preflight && typeof preflight.preparePrompt === 'function');

  const short = preflight.preparePrompt({
    domain: 'entityExtraction',
    system: 'Return JSON only.',
    user: 'short current turn evidence',
    maxTokens: 6500,
    config: {}
  });
  assertCase(assertions, 'short_payload_stays_full', short.mode === 'full' && short.user === 'short current turn evidence', short);

  const mediumUser = 'A'.repeat(36000) + '\n[Required JSON]\n{"entities":[]}';
  const medium = preflight.preparePrompt({
    domain: 'entityExtraction',
    system: 'Return JSON only.',
    user: mediumUser,
    maxTokens: 6500,
    config: {}
  });
  assertCase(assertions, 'medium_payload_compacts', medium.mode === 'compact' && medium.user.length < mediumUser.length && /PREFLIGHT COMPACTED/.test(medium.user), {
    mode: medium.mode,
    originalUserChars: medium.originalUserChars,
    preparedUserChars: medium.preparedUserChars,
    maxTokens: medium.maxTokens
  });

  const hugeUser = 'B'.repeat(76000) + '\n[Required JSON]\n{"canonicalPacket":{},"entityExtraction":{},"maintenance":{}}';
  const huge = preflight.preparePrompt({
    domain: 'afterrequestUnifiedAnalysis',
    system: 'Return JSON only.',
    user: hugeUser,
    maxTokens: 20000,
    config: {}
  });
  assertCase(assertions, 'huge_payload_selects_chunked_profile', huge.mode === 'chunked' && huge.user.length < hugeUser.length && huge.maxTokens <= 9000, {
    mode: huge.mode,
    originalUserChars: huge.originalUserChars,
    preparedUserChars: huge.preparedUserChars,
    maxTokens: huge.maxTokens
  });

  const disabled = preflight.preparePrompt({
    domain: 'entityExtraction',
    system: 'Return JSON only.',
    user: hugeUser,
    maxTokens: 6500,
    config: { analysisPreflightEnabled: false }
  });
  assertCase(assertions, 'disabled_preflight_preserves_payload', disabled.mode === 'full' && disabled.user.length === hugeUser.length && disabled.reason === 'disabled', {
    mode: disabled.mode,
    reason: disabled.reason,
    preparedUserChars: disabled.preparedUserChars
  });

  const coldChunk = preflight.preparePrompt({
    domain: 'coldStartChunkSummary',
    system: 'Return JSON only.',
    user: 'C'.repeat(36000),
    maxTokens: 2200,
    config: {}
  });
  assertCase(assertions, 'cold_start_chunk_uses_compact_budget', coldChunk.mode === 'compact' && coldChunk.maxTokens <= 1800 && coldChunk.user.length <= 18000, {
    mode: coldChunk.mode,
    preparedUserChars: coldChunk.preparedUserChars,
    maxTokens: coldChunk.maxTokens
  });

  const coldFinal = preflight.preparePrompt({
    domain: 'coldStartFinalSynthesis',
    system: 'Return JSON only.',
    user: 'D'.repeat(60000),
    maxTokens: 4400,
    config: {}
  });
  assertCase(assertions, 'cold_start_final_uses_chunked_budget', coldFinal.mode === 'chunked' && coldFinal.maxTokens <= 1900 && coldFinal.user.length <= 14000, {
    mode: coldFinal.mode,
    preparedUserChars: coldFinal.preparedUserChars,
    maxTokens: coldFinal.maxTokens
  });

  const recorded = preflight.recordLengthFailure(
    { debug: false },
    'unit-length-failure',
    new Error('provider returned no text content (finishReason=length)'),
    coldFinal
  );
  const metrics = preflight.getMetrics();
  assertCase(assertions, 'length_failure_metric_recorded', recorded === true && metrics.lengthFailureCount >= 1 && metrics.lastLengthFailure?.label === 'unit-length-failure', metrics);

  const size = preflight.estimateAnalysisInputSize({ system: 'abcd', user: 'efgh' });
  assertCase(assertions, 'estimate_reports_chars_and_tokens', size.chars === 8 && size.estimatedTokens >= 2, size);

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'analysis_preflight_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
