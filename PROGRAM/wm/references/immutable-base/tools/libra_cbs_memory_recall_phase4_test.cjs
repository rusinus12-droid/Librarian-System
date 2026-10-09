'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const closeIndex = code.lastIndexOf('\n})();');
if (closeIndex < 0) throw new Error('plugin IIFE close not found');
code = code.slice(0, closeIndex) + `
;globalThis.__LIBRA_PHASE4_TEST__ = {
  CBSEngine: typeof CBSEngine !== 'undefined' ? CBSEngine : null,
  RisuCbsStandalone: typeof RisuCbsStandalone !== 'undefined' ? RisuCbsStandalone : null,
  CompactMemoryCodec: typeof CompactMemoryCodec !== 'undefined' ? CompactMemoryCodec : null,
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null
};
` + code.slice(closeIndex);

class FakeElement {
  constructor(tag, doc) { this.tagName = String(tag || 'div').toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null; this._id = ''; this.style = {}; this.listeners = {}; this.attributes = {}; this.textContent = ''; this._innerHTML = ''; }
  set id(value) { this._id = String(value || ''); this.ownerDocument?._register(this); }
  get id() { return this._id; }
  set innerHTML(value) { this._innerHTML = String(value || ''); }
  get innerHTML() { return this._innerHTML; }
  appendChild(el) { if (!el) return el; el.parentNode = this; this.children.push(el); if (el.id) this.ownerDocument?._register(el); return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelector() { return null; }
}

class FakeDocument {
  constructor() { this._ids = Object.create(null); this.head = new FakeElement('head', this); this.body = new FakeElement('body', this); }
  _register(el) { if (el?.id) this._ids[el.id] = el; }
  createElement(tag) { return new FakeElement(tag, this); }
  getElementById(id) { return this._ids[String(id || '')] || null; }
  querySelector(selector) { return selector === 'head' ? this.head : (selector === 'body' ? this.body : null); }
}

const assertions = [];
const assertCase = (name, ok, detail = null) => assertions.push({ name, ok: !!ok, detail });

const rawMemory = (turn, text) => ({
  key: `legacy-${turn}`,
  comment: 'lmai_memory',
  mode: 'normal',
  content: `[META:${JSON.stringify({ t: turn, imp: 7, ent: ['Ariel'] })}]\n[USER]The user asks about the silver gate.\n[AI]${text}`,
  insertorder: 10,
  alwaysActive: false
});

(async () => {
  const document = new FakeDocument();
  const storage = new Map();
  let chatStore = { id: 'cbs-chat', message: [], scriptstate: { $affection: '3' } };
  let charStore = null;
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return key === 'activity_dashboard' ? 'off' : undefined; },
    pluginStorage: {
      async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      async setItem(key, value) { storage.set(key, String(value)); },
      async removeItem(key) { storage.delete(key); }
    },
    async getCharacter() { return structuredClone(charStore); },
    async getDatabase() { return { username: 'Reader', personas: [] }; },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getChatFromIndex() { return structuredClone(chatStore); },
    async setChatToIndex(_characterIndex, _chatIndex, next) { chatStore = structuredClone(next); },
    async registerSetting() {},
    async registerButton() {},
    async requestPluginPermission() { return false; },
    async onUnload() {}
  };
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, String, Boolean, Array, Object, RegExp, Error, URL, Promise,
    TextEncoder, TextDecoder, AbortController,
    performance: { now: () => Date.now() },
    structuredClone: global.structuredClone,
    fetch: async () => { throw new Error('fetch not expected'); },
    document, Risuai, risuai: Risuai,
    globalThis: null, window: null
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 60));

  const { CBSEngine: cbs, RisuCbsStandalone: standalone, CompactMemoryCodec: codec, MemoryEngine: memory } = context.__LIBRA_PHASE4_TEST__ || {};
  assertCase('phase4_apis_exported', !!cbs && !!standalone && !!codec && !!memory);
  if (!cbs || !standalone || !codec || !memory) throw new Error('phase4 APIs unavailable');
  memory.CONFIG.cbsEnabled = true;

  const runtime = standalone.buildRisuCbsRuntime({
    characterName: 'Alice', userName: 'Reader', characterDescription: 'Mage',
    chatVariables: { affection: '3' }, globalVariables: { weather: 'rain' }, toggleVariables: { mature: '1' }
  });
  const evaluated = await cbs.evaluate('<char> {{getvar::affection}} {{getglobalvar::weather}} {{#if {{? $affection>=3}}}}HIGH{{/if}} {{#when::mature::tis::1}}ON{{:else}}OFF{{/when}}', runtime);
  assertCase('cbs_parity_variables_blocks', evaluated.text === 'Alice 3 rain HIGH ON', evaluated);

  const each = await cbs.evaluate('{{#each ["a","b"] as item}}({{slot::item}}){{/each}} {{upper::libra}} {{unknown::{{char}}}} {{random::1::2}}', runtime);
  assertCase('cbs_arrays_unknown_and_nondeterministic_preserved', each.text === '(a)(b) LIBRA {{unknown::Alice}} {{random::1::2}}', each);

  const missing = await cbs.evaluate('{{getglobalvar::missing}} {{getglobalvar::missing}}', runtime);
  assertCase('cbs_missing_global_is_diagnostic_not_failure', missing.text === 'null null' && missing.diagnostics.filter(item => item.code === 'RISU_CBS_MISSING_GLOBAL').length === 1, missing);

  const candidateSource = '{{getvar::affection}} {{getglobalvar::weather}} {{#when::mature::tis::1}}yes{{/when}}';
  const candidates = cbs.collectCandidates([candidateSource]);
  assertCase('cbs_candidate_collection', candidates.chatVariableKeys.includes('affection') && candidates.globalVariableKeys.includes('weather') && candidates.toggleKeys.includes('mature'), candidates);
  assertCase('cbs_bridge_uses_libra_namespaced_keys', cbs.bridgeKeys.manifest === 'libra_cbs_candidates_v1' && cbs.bridgeKeys.snapshot === 'libra_cbs_snapshot_v1', cbs.bridgeKeys);

  const bridgeSource = 'Sky={{getglobalvar::weather}} / {{#when::mature::tis::1}}enabled{{/when}}';
  charStore = { id: 'cbs-char', name: 'Alice', chats: [chatStore], globalLore: [{ key: 'weather', comment: 'weather', content: bridgeSource }] };
  const firstBridge = await cbs.prepareBridge([bridgeSource], { characterIndex: 0, chatIndex: 0, chat: chatStore });
  assertCase('cbs_bridge_never_writes_manifest_on_unsupported_host', firstBridge.status === 'native_unavailable' && firstBridge.manifestWritten === false && !chatStore.scriptstate.$libra_cbs_candidates_v1, firstBridge);
  chatStore.scriptstate.$libra_cbs_snapshot_v1 = JSON.stringify({
    version: 1, createdAt: Date.now(), phase: 'input', characterIndex: 0, chatIndex: 0,
    manifestFingerprint: firstBridge.manifest.fingerprint,
    chatVariables: { affection: '3' }, globalVariables: { weather: 'snow' }, toggleVariables: { mature: '1' },
    persona: { name: 'Reader', description: 'Observer' }, character: { name: 'Alice', description: 'Mage' }
  });
  const readyBridge = await cbs.prepareBridge([bridgeSource], { characterIndex: 0, chatIndex: 0, chat: chatStore });
  assertCase('cbs_bridge_validates_fresh_snapshot', readyBridge.status === 'native_unavailable' && readyBridge.validation?.ok === true, readyBridge);

  const loreResolved = await cbs.resolveCharacterLoreEntries({
    characterIndex: 0, chatIndex: 0, chat: chatStore,
    char: charStore,
    db: { username: 'Reader', personas: [] }
  });
  assertCase('cbs_character_lore_pre_resolve_uses_bridge', loreResolved.bridge.status === 'native_unavailable' && loreResolved.entries[0]?.content === 'Sky=snow / enabled', loreResolved);

  const legacy = rawMemory(1, 'Ariel opened the silver gate and promised to return.');
  const compactV1 = {
    key: 'compact-v1', comment: 'lmai_memory', mode: 'normal', insertorder: 10, alwaysActive: false,
    content: `[META:${JSON.stringify({ t: 2, imp: 8 })}]\n${JSON.stringify({ schema: 'libra.memory.compact_turn.v1', version: 1, turn: 2, importance: 8, summary: 'Ariel sealed the silver gate.', anchors: [], snippets: [], tags: ['silver-gate'], mentionedEntityNames: ['Ariel'] })}`
  };
  const audit = memory.auditMemorySchema([legacy, compactV1]);
  assertCase('memory_schema_audit_is_non_mutating', audit.dryRun === true && audit.wouldChange === true && audit.stats.legacyRaw === 1 && audit.stats.compactV1 === 1 && codec.parsePayloadFromEntry(legacy) === null, audit);
  const migrated = memory.migrateMemorySchema([legacy, compactV1]);
  const migratedPayloads = migrated.entries.map(entry => codec.parsePayloadFromEntry(entry));
  assertCase('memory_schema_bulk_migration_to_v3', migrated.changed === true && migrated.stats.migrated === 2 && migratedPayloads.every(payload => payload?.schema === codec.BUNDLE_SCHEMA && payload?.recordSchema === codec.RECORD_SCHEMA), migrated);
  assertCase('memory_schema_support_reports_v1_v2_v3_read', memory.getMemorySchemaSupport().legacyRawRead === true
    && memory.getMemorySchemaSupport().writeSchema === codec.BUNDLE_SCHEMA
    && memory.getMemorySchemaSupport().readSchemas.includes(codec.LEDGER_SCHEMA), memory.getMemorySchemaSupport());
  const userEvidencePayload = codec.buildTurnPayload('I promise Ariel that I will guard the silver gate.', 'Ariel nodded and handed over the gate key.', { turn: 3, sourceHash: 'turn-3' });
  assertCase('v3_user_evidence_is_non_executable_and_not_canon_fact', userEvidencePayload?.userEvidence?.length > 0
    && userEvidencePayload.userEvidence.every(item => item.epistemicStatus === 'user_asserted' && item.authority === 'evidence_only' && item.executable === false)
    && userEvidencePayload.records.some(record => record.epistemic?.status === 'user_asserted' && record.epistemic?.authority === 'evidence_only')
    && !userEvidencePayload.facts.some(fact => /I promise Ariel/i.test(fact.text || '')), userEvidencePayload);
  const v2Export = memory.exportMemorySchemaV2(migrated.entries);
  assertCase('v3_can_export_v2_for_rollback', v2Export.stats.exported === 2
    && v2Export.entries.map(entry => codec.parsePayloadFromEntry(entry)).every(payload => payload?.schema === codec.LEDGER_SCHEMA), v2Export.stats);

  const recallEntries = Array.from({ length: 18 }, (_, index) => rawMemory(index + 10, `Ariel silver gate continuity record ${index + 1} with a deliberately detailed consequence and recurring promise.`));
  const packed = memory.formatMemories(recallEntries, 'Ariel silver gate promise', { maxTokens: 220, maxItems: 18, maxPerBucket: 6 });
  const packedTokens = memory.TokenizerEngine.estimateTokens(packed, 'simple');
  assertCase('recall_injection_respects_dedicated_token_budget', packedTokens <= 220 && packed.includes('LIBRA recall bundle compacted') && packed.includes('Ariel'), { packedTokens, packed });

  Object.assign(memory.CONFIG, {
    threshold: 1,
    simThreshold: 0.05,
    recallEmbeddingCandidateMax: 0,
    hybridMemoryEngineEnabled: false,
    hybridReadPathEnabled: false,
    hmeAssociativeGraphEnabled: false,
    coldArchiveHydrationEnabled: false
  });
  const mmrTexts = [
    'Ariel entrusted the silver gate key to Dohyun after the moon ritual.',
    'After the moon ritual, Ariel gave Dohyun the silver gate key for safekeeping.',
    'Dohyun received the silver gate key from Ariel when the moon ritual ended.',
    'The northern beacon went dark in the storm and isolated the harbor.',
    'Mira discovered a hidden route map beneath the old chapel floor.',
    'A broken observatory lens revealed a new constellation above the capital.'
  ];
  const mmrEntries = mmrTexts.map((text, index) => {
    const payload = codec.buildTurnPayload('', text, { turn: index + 10, importance: 7, sourceHash: `mmr-${index}` });
    return {
      key: `mmr-${index}`,
      comment: 'lmai_memory',
      mode: 'normal',
      insertorder: 10,
      alwaysActive: false,
      content: `[META:${JSON.stringify({ t: index + 10, ttl: -1, imp: 7, sourceHash: `mmr-${index}` })}]\n${codec.serialize(payload)}\n`
    };
  });
  const mmrSelected = await memory.retrieveMemories('silver gate ritual northern beacon chapel map constellation', 30, mmrEntries, {}, 4);
  const mmrDisplay = mmrSelected.map(entry => codec.buildDisplayTextFromEntry(entry, 400));
  const silverCount = mmrDisplay.filter(text => /silver gate/i.test(text)).length;
  assertCase('recall_mmr_reduces_semantic_duplicates', mmrSelected.length === 4
    && silverCount <= 2
    && mmrDisplay.some(text => /northern beacon/i.test(text))
    && mmrDisplay.some(text => /chapel/i.test(text)), { keys: mmrSelected.map(entry => entry.key), silverCount, mmrDisplay });

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'cbs_memory_recall_phase4_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
