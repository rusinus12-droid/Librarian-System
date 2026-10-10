'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_INTEGRITY_SCANNER_TEST__ = {
  IntegrityMetaManager: typeof IntegrityMetaManager !== 'undefined' ? IntegrityMetaManager : null,
  IntegrityScanner: typeof IntegrityScanner !== 'undefined' ? IntegrityScanner : null,
  QuarantineManager: typeof QuarantineManager !== 'undefined' ? QuarantineManager : null,
  EntityManager: typeof EntityManager !== 'undefined' ? EntityManager : null,
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

function entityEntry(name, extra = {}) {
  const entity = {
    name,
    id: String(name || '').toLowerCase(),
    appearance: { features: [] },
    personality: { traits: [] },
    speechStyle: {},
    background: {},
    status: {},
    meta: { created: 1, updated: 1, confidence: 0.5, source: 'unit' },
    ...extra
  };
  return {
    key: `entity::${name}`,
    comment: 'lmai_entity',
    content: JSON.stringify(entity, null, 2),
    mode: 'normal',
    insertorder: 50,
    alwaysActive: false
  };
}

function relationEntry(a, b, extra = {}) {
  const relation = {
    id: `${a}_${b}`,
    entityA: a,
    entityB: b,
    relationType: 'known',
    details: {},
    sentiments: {},
    meta: { created: 1, updated: 1, confidence: 0.5, source: 'unit' },
    ...extra
  };
  return {
    key: `relation::${a}::${b}`,
    comment: 'lmai_relation',
    content: JSON.stringify(relation, null, 2),
    mode: 'normal',
    insertorder: 60,
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

  const { IntegrityMetaManager, IntegrityScanner, QuarantineManager, MemoryState } = context.__LIBRA_INTEGRITY_SCANNER_TEST__ || {};
  const assertions = [];
  assertCase(assertions, 'scanner_api_exported', !!IntegrityScanner && typeof IntegrityScanner.scanBatch === 'function');
  assertCase(assertions, 'integrity_meta_api_available', !!IntegrityMetaManager && typeof IntegrityMetaManager.applyIntegrityMeta === 'function');
  assertCase(assertions, 'quarantine_accept_api_available', !!QuarantineManager && typeof QuarantineManager.prepareAcceptedPayload === 'function');

  MemoryState.currentTurn = 20;
  MemoryState._activeScopeKey = 'scan-scope';

  const signed = JSON.parse(entityEntry('Mira').content);
  IntegrityMetaManager.applyIntegrityMeta(signed, {
    domain: 'entity',
    recordSchema: 'libra.entity.record.v1',
    recordId: 'Mira',
    scopeKey: 'scan-scope',
    turn: 20,
    source: 'unit'
  });
  signed.appearance.features.push('tampered after signing');

  const lore = [
    { ...entityEntry('Mira'), content: JSON.stringify(signed, null, 2) },
    entityEntry('Mira'),
    entityEntry('Mira'),
    relationEntry('Mira', 'Ghost'),
    { key: 'broken-narrative', comment: 'lmai_narrative', content: '{"storylines":[', mode: 'normal', insertorder: 5, alwaysActive: false },
    { key: 'bad-quarantine', comment: 'lmai_analysis_quarantine', content: JSON.stringify({ schema: 'wrong.schema', entries: [{ id: 'q1', reason: 'unit' }, { id: 'q2', reason: 'unit' }] }), mode: 'normal', insertorder: 6, alwaysActive: false },
    {
      key: 'huge-memory',
      comment: 'lmai_memory',
      content: `[META:${JSON.stringify({ embeddingFingerprint: { schema: 'libra.embedding.fingerprint.v1', provider: 'openai', model: 'old-embedding-model', endpointHash: '', dim: 3, key: 'openai:old-embedding-model:default:3' } })}]\n${'x'.repeat(220)}`,
      mode: 'normal',
      insertorder: 100,
      alwaysActive: false
    }
  ];

  const firstBatch = IntegrityScanner.scanBatch(lore, {
    scopeKey: 'scan-scope',
    batchLimit: 2,
    maxMs: 1000,
    oversizedChars: 120,
    quarantineBacklogLimit: 1
  });
  assertCase(assertions, 'scan_cursor_yields_after_batch_limit', firstBatch.ok === true && firstBatch.done === false && firstBatch.nextIndex === 2 && firstBatch.stoppedReason === 'batch_limit', firstBatch);

  const secondBatch = IntegrityScanner.scanBatch(lore, {
    scopeKey: 'scan-scope',
    batchLimit: 20,
    maxMs: 1000,
    oversizedChars: 120,
    quarantineBacklogLimit: 1
  });
  const findings = IntegrityScanner.listFindings(lore, { limit: 50 });
  const byType = new Map(findings.map(item => [item.type, (findings.filter(f => f.type === item.type).length)]));

  assertCase(assertions, 'scan_completes_and_resets_cursor', secondBatch.ok === true && secondBatch.done === true && secondBatch.nextIndex === 0, secondBatch);
  assertCase(assertions, 'invalid_json_finding_created', byType.has('invalid_json'), findings.filter(item => item.type === 'invalid_json'));
  assertCase(assertions, 'checksum_mismatch_finding_created', byType.has('checksum_mismatch'), findings.filter(item => item.type === 'checksum_mismatch'));
  assertCase(assertions, 'schema_mismatch_finding_created', byType.has('schema_mismatch'), findings.filter(item => item.type === 'schema_mismatch'));
  assertCase(assertions, 'duplicate_entity_finding_created', byType.has('duplicate_entity'), findings.filter(item => item.type === 'duplicate_entity'));
  assertCase(assertions, 'orphan_relation_finding_created', byType.has('orphan_relation'), findings.filter(item => item.type === 'orphan_relation'));
  assertCase(assertions, 'oversized_record_finding_created', byType.has('oversized_record'), findings.filter(item => item.type === 'oversized_record'));
  assertCase(assertions, 'embedding_fingerprint_mismatch_finding_created', byType.has('embedding_fingerprint_mismatch'), findings.filter(item => item.type === 'embedding_fingerprint_mismatch'));
  assertCase(assertions, 'quarantine_backlog_finding_created', byType.has('quarantine_backlog'), findings.filter(item => item.type === 'quarantine_backlog'));
  assertCase(assertions, 'scan_state_entry_persisted', lore.some(entry => entry.comment === 'lmai_integrity_scan'), lore.find(entry => entry.comment === 'lmai_integrity_scan'));
  assertCase(assertions, 'scan_summary_counts_findings', secondBatch.summary?.total >= 8 && secondBatch.summary?.byType?.orphan_relation >= 1, secondBatch.summary);

  const quarantineLore = [];
  const appendResult = QuarantineManager.append(quarantineLore, {
    success: true,
    fallbackReason: 'manual_review_required',
    sourceMode: 'conversation',
    entities: [{ name: 'Noel', appearance: { features: ['silver hair'] } }],
    relations: [{ entityA: 'Mira', entityB: 'Noel', relationType: 'ally' }],
    world: { classification: { genre: 'fantasy' }, __genreSourceText: 'unit world evidence' },
    conflicts: []
  }, {
    guard: { allowed: false, status: 'blocked', reason: 'unit_review', domain: 'entity', operation: 'unit' },
    domain: 'entity',
    operation: 'unit',
    sourceMode: 'conversation',
    turn: 21,
    scopeKey: 'scan-scope'
  });
  const preparedAccepted = QuarantineManager.prepareAcceptedPayload(quarantineLore, appendResult.entry?.id, {
    operation: 'unit.accept',
    allowFallbackReasonMerge: true
  });
  assertCase(assertions, 'quarantine_payload_persisted_for_accept', !!appendResult.entry?.payload?.entities?.length, appendResult.entry);
  assertCase(assertions, 'quarantine_accept_prepares_payload_after_guard', preparedAccepted.ok === true && preparedAccepted.payload?.sourceMode === 'gui_manual_correction', preparedAccepted);

  const hardAppend = QuarantineManager.append(quarantineLore, {
    success: false,
    reason: 'schema_invalid',
    sourceMode: 'conversation',
    entities: [{ name: 'Broken' }]
  }, {
    guard: { allowed: false, status: 'blocked', reason: 'schema_invalid', domain: 'entity', operation: 'unit' },
    domain: 'entity',
    operation: 'unit',
    sourceMode: 'conversation',
    turn: 22,
    scopeKey: 'scan-scope'
  });
  const hardPrepared = QuarantineManager.prepareAcceptedPayload(quarantineLore, hardAppend.entry?.id, {
    operation: 'unit.accept',
    allowFallbackReasonMerge: true
  });
  assertCase(assertions, 'quarantine_accept_keeps_hard_invalid_blocked', hardPrepared.ok === false && hardPrepared.reason === 'guard_blocked', hardPrepared);

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'integrity_scanner_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
