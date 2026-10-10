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
  querySelector(selector) { return this.ownerDocument ? this.ownerDocument._queryWithin(this, selector) : null; }
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
    return this._queryWithin({ children: [this.head, this.body] }, selector);
  }
  _queryWithin(root, selector) {
    const idMatch = String(selector || '').match(/^#(.+)$/);
    const stack = [...(root?.children || [])];
    while (stack.length) {
      const el = stack.shift();
      if (idMatch && el.id === idMatch[1]) return el;
      stack.push(...(el.children || []));
    }
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

  const guard = context.LIBRA_AnalysisResultGuard;
  const canonicalContract = context.LIBRA_CanonicalPacketContract;
  const quarantine = context.LIBRA_QuarantineManager;
  const assertions = [];

  assertCase(assertions, 'guard_api_exported', !!guard && typeof guard.isMergeAllowed === 'function');
  assertCase(assertions, 'canonical_contract_exported', !!canonicalContract && typeof canonicalContract.inspect === 'function');
  assertCase(assertions, 'quarantine_api_exported', !!quarantine && typeof quarantine.append === 'function');

  const evidenceRefs = [{ turn: 7, messageId: 'a-7', spanHash: 'hash-7', snippet: 'Assistant evidence confirms the event.', sourceKind: 'assistant' }];
  const validCanonicalV3 = {
    schema: 'libra.canonical_packet.v3',
    version: 3,
    meta: { turn: 7, sourceMessageIds: ['a-7'], summary_memory: { summary: 'Turn seven summary.', recall: 'turn seven' } },
    memory: { events: [{ operation: 'add', id: 'event-7', summary: 'A confirmed event occurred.', evidenceRefs, confidence: 0.9 }], facts: [], open_threads: [] },
    entity: { characters: [{ operation: 'add', name: 'A', evidenceRefs, quality: { confidence: 0.9 } }], relations: [], pov_memories: [], secrets: [], current_state: [] },
    world: { rules: [], places: [], organizations: [], social_rules: [], phenomena: [], systems: {}, physics: {}, exists: {}, active_events: [], offscreen_threads: [], state: {} },
    narrative: { scene_phase: 'continuation', conflict_traces: [], scene_deltas: [], theme_motifs: [], unresolved_threads: [] },
    guards: { continuity_locks: [], audit_cautions: [], overpromotion_risks: [], conflicts: [], uncertain: [] },
    importance: { overall: 0.6, reason: ['confirmed event'] }
  };
  const validContract = canonicalContract.inspect(validCanonicalV3, { requireCoreAxes: true });
  assertCase(assertions, 'canonical_v3_valid_packet_accepted', validContract.valid === true, validContract);

  const missingEvidence = structuredClone(validCanonicalV3);
  missingEvidence.memory.events[0].evidenceRefs = [];
  const missingEvidenceContract = canonicalContract.inspect(missingEvidence, { requireCoreAxes: true });
  assertCase(assertions, 'canonical_v3_missing_evidence_blocked', missingEvidenceContract.valid === false && missingEvidenceContract.errors.some(item => /evidenceRefs/.test(item)), missingEvidenceContract);

  const invalidOperation = structuredClone(validCanonicalV3);
  invalidOperation.entity.characters[0].operation = 'overwrite_everything';
  const invalidOperationContract = canonicalContract.inspect(invalidOperation, { requireCoreAxes: true });
  assertCase(assertions, 'canonical_v3_invalid_operation_blocked', invalidOperationContract.valid === false && invalidOperationContract.errors.some(item => /operation/.test(item)), invalidOperationContract);

  const wrongAxisType = structuredClone(validCanonicalV3);
  wrongAxisType.world.rules = { value: 'not an array' };
  const wrongAxisContract = canonicalContract.inspect(wrongAxisType, { requireCoreAxes: true });
  assertCase(assertions, 'canonical_v3_wrong_axis_type_blocked', wrongAxisContract.valid === false && wrongAxisContract.errors.some(item => /world\.rules/.test(item)), wrongAxisContract);

  const malformedCanonicalGuard = guard.isMergeAllowed({ success: true, canonicalPacket: missingEvidence }, { domain: 'canonical', operation: 'unit.invalid_canonical' });
  assertCase(assertions, 'guard_blocks_invalid_canonical_packet', malformedCanonicalGuard.allowed === false && /canonical_packet_invalid/.test(malformedCanonicalGuard.reason || ''), malformedCanonicalGuard);

  assertCase(assertions, 'prompt_uses_single_authoritative_packet', code.includes('Produce canonicalPacket only; LIBRA derives compatibility entity and maintenance views in code.'));
  assertCase(assertions, 'repair_prompt_distrusts_malformed_output', code.includes('The malformed output is untrusted syntax material, never factual evidence.'));

  const degraded = {
    success: true,
    degraded: true,
    fallbackReason: 'truncated_json',
    sourceMode: 'conversation',
    entities: [{ name: 'A' }],
    world: { exists: { currentScene: 'unsafe merge candidate' } },
    conversationText: 'A degraded result should be blocked before merge.'
  };
  const degradedGuard = guard.isMergeAllowed(degraded, { domain: 'entity', operation: 'unit.degraded' });
  assertCase(assertions, 'degraded_result_blocked', degradedGuard.allowed === false && /truncated_json/.test(degradedGuard.reason || ''), degradedGuard);

  const failedGuard = guard.isMergeAllowed({ success: false, fallbackReason: 'empty_response' }, { domain: 'entity', operation: 'unit.failed' });
  assertCase(assertions, 'success_false_blocked', failedGuard.allowed === false && /empty_response/.test(failedGuard.reason || ''), failedGuard);

  const fallbackReasonGuard = guard.isMergeAllowed({ success: true, fallbackReason: 'repair_used', entities: [{ name: 'B' }] }, { domain: 'entity', operation: 'unit.fallback_reason' });
  assertCase(assertions, 'fallback_reason_blocks_auto_merge', fallbackReasonGuard.allowed === false && /repair_used/.test(fallbackReasonGuard.reason || ''), fallbackReasonGuard);

  const validGuard = guard.isMergeAllowed({ success: true, entities: [{ name: 'A' }] }, { domain: 'entity', operation: 'unit.valid' });
  assertCase(assertions, 'valid_result_allowed', validGuard.allowed === true, validGuard);

  const manualGuard = guard.isMergeAllowed({ success: false, degraded: true, sourceMode: 'correction' }, { domain: 'entity', operation: 'unit.manual' });
  assertCase(assertions, 'manual_correction_allowed', manualGuard.allowed === true && manualGuard.status === 'trusted_manual', manualGuard);

  const lore = [];
  const appendResult = quarantine.append(lore, degraded, {
    guard: degradedGuard,
    domain: 'entity',
    operation: 'unit.degraded',
    sourceMode: 'conversation',
    turn: 7,
    turnKey: 'unit-turn'
  });
  const entry = lore.find(item => item.comment === 'lmai_analysis_quarantine');
  const parsed = entry ? JSON.parse(entry.content || '{}') : null;
  assertCase(assertions, 'quarantine_entry_written', !!appendResult.entry && !!entry && parsed?.schema === 'libra.analysis_quarantine.v1' && parsed?.entries?.length === 1, parsed);
  assertCase(assertions, 'quarantine_not_canonical_memory_entry', entry?.comment === 'lmai_analysis_quarantine' && entry?.alwaysActive === false && entry?.comment !== 'lmai_memory', entry);

  quarantine.append(lore, degraded, {
    guard: degradedGuard,
    domain: 'entity',
    operation: 'unit.degraded',
    sourceMode: 'conversation',
    turn: 7,
    turnKey: 'unit-turn'
  });
  const deduped = JSON.parse(lore.find(item => item.comment === 'lmai_analysis_quarantine').content || '{}');
  assertCase(assertions, 'quarantine_dedupes_same_failure', deduped.entries.length === 1, deduped);

  const listed = quarantine.list(lore, { status: 'blocked', domain: 'entity', limit: 10 });
  assertCase(assertions, 'quarantine_list_filters_entries', listed.length === 1 && listed[0].id === appendResult.entry.id, listed);

  const markResult = quarantine.markStatus(lore, appendResult.entry.id, 'reviewed', { note: 'checked by unit test', reviewer: 'test' });
  const reviewed = quarantine.getEntry(lore, appendResult.entry.id);
  assertCase(assertions, 'quarantine_mark_status_updates_entry', markResult.changed === true && reviewed?.status === 'reviewed' && reviewed?.reviewNote === 'checked by unit test', reviewed);

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'analysis_guard_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
