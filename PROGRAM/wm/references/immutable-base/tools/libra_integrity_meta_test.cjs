'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let code = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_INTEGRITY_TEST__ = {
  IntegrityMetaManager: typeof IntegrityMetaManager !== 'undefined' ? IntegrityMetaManager : null,
  EntityManager: typeof EntityManager !== 'undefined' ? EntityManager : null,
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,
  MemoryState: typeof MemoryState !== 'undefined' ? MemoryState : null,
  NarrativeTracker: typeof NarrativeTracker !== 'undefined' ? NarrativeTracker : null,
  WorldStateTracker: typeof WorldStateTracker !== 'undefined' ? WorldStateTracker : null,
  buildCanonicalTurnCommitGuard: typeof buildCanonicalTurnCommitGuard !== 'undefined' ? buildCanonicalTurnCommitGuard : null,
  reconcileCanonicalTurnCommitGuard: typeof reconcileCanonicalTurnCommitGuard !== 'undefined' ? reconcileCanonicalTurnCommitGuard : null,
  verifyCanonicalTurnCommitGuard: typeof verifyCanonicalTurnCommitGuard !== 'undefined' ? verifyCanonicalTurnCommitGuard : null,
  TurnRecordLedger: typeof TurnRecordLedger !== 'undefined' ? TurnRecordLedger : null,
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

function parseMeta(content) {
  const match = String(content || '').match(/\[META:(\{[\s\S]*?\})\]\s*/);
  return match ? JSON.parse(match[1]) : null;
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

  const {
    IntegrityMetaManager,
    EntityManager,
    MemoryEngine,
    MemoryState,
    NarrativeTracker,
    WorldStateTracker,
    buildCanonicalTurnCommitGuard,
    reconcileCanonicalTurnCommitGuard,
    verifyCanonicalTurnCommitGuard,
    TurnRecordLedger
  } = context.__LIBRA_INTEGRITY_TEST__ || {};
  const assertions = [];

  assertCase(assertions, 'integrity_api_exported', !!IntegrityMetaManager && typeof IntegrityMetaManager.validateIntegrityMeta === 'function');
  assertCase(assertions, 'internal_test_managers_available', !!EntityManager && !!MemoryEngine && !!NarrativeTracker && !!WorldStateTracker);

  MemoryState.currentTurn = 12;
  const fixtureChat = { id:'integrity-chat', bindedPersona:'integrity-persona', localLore:[] };
  const fixtureChar = { id:'integrity-char', chatPage:0, chats:[fixtureChat] };
  const admission = await context.LibraDataStorage.preparePersonaContext(fixtureChar, fixtureChat);
  assertCase(assertions, 'integrity_fixture_uses_admitted_target', admission.ok === true, admission);
  const fixtureScope = admission.runtimeScopeKey;
  MemoryState._activeScopeKey = fixtureScope;

  const lore = [];
  EntityManager.clearCache();
  EntityManager.updateEntity('Mira', {
    appearance: { features: ['silver hair'] },
    source: 'unit_test'
  }, lore);
  const unownedLoreBefore = JSON.stringify(lore), unownedCacheBefore = JSON.stringify([...EntityManager.getEntityCache()]);
  let unownedError = '';
  try { await EntityManager.saveToLorebook(null, { id:'integrity-chat' }, lore); }
  catch (error) { unownedError = error.message; }
  assertCase(assertions, 'unadmitted_integrity_target_cannot_mutate_lore_or_cache',
    unownedError === 'entity_persistence_target_unverified' && JSON.stringify(lore) === unownedLoreBefore
    && JSON.stringify([...EntityManager.getEntityCache()]) === unownedCacheBefore, unownedError);
  await EntityManager.saveToLorebook(fixtureChar, fixtureChat, lore);
  const entityEntry = lore.find(entry => entry.comment === 'lmai_entity');
  const entity = JSON.parse(entityEntry.content || '{}');
  const entityValidation = IntegrityMetaManager.validateIntegrityMeta(entity, { domain: 'entity', scopeKey:fixtureScope });
  assertCase(assertions, 'entity_record_integrity_written', entity?.meta?.integrity?.schema === 'libra.integrity_meta.v1' && entityValidation.ok === true, entity?.meta?.integrity);

  const tamperedEntity = JSON.parse(JSON.stringify(entity));
  tamperedEntity.appearance.features.push('tampered scar');
  const tamperValidation = IntegrityMetaManager.validateIntegrityMeta(tamperedEntity, { domain: 'entity', scopeKey:fixtureScope });
  assertCase(assertions, 'checksum_mismatch_detected', tamperValidation.ok === false && tamperValidation.reason === 'checksum_mismatch', tamperValidation);
  const scopeValidation = IntegrityMetaManager.validateIntegrityMeta(entity, { domain: 'entity', scopeKey: 'other-scope' });
  assertCase(assertions, 'scope_mismatch_detected', scopeValidation.ok === false && scopeValidation.reason === 'scope_mismatch', scopeValidation);

  EntityManager.clearCache();
  EntityManager.rebuildCache([{ ...entityEntry, content: JSON.stringify(tamperedEntity, null, 2) }]);
  assertCase(assertions, 'corrupted_entity_blocked_from_cache', !EntityManager.getEntityCache().has('Mira'), Array.from(EntityManager.getEntityCache().keys()));

  const legacyEntity = JSON.parse(JSON.stringify(entity));
  delete legacyEntity.meta.integrity;
  const legacyValidation = IntegrityMetaManager.validateIntegrityMeta(legacyEntity, { domain: 'entity', scopeKey:fixtureScope });
  EntityManager.rebuildCache([{ ...entityEntry, content: JSON.stringify(legacyEntity, null, 2) }]);
  assertCase(assertions, 'legacy_entity_without_integrity_still_loads', legacyValidation.ok === true && legacyValidation.legacy === true && EntityManager.getEntityCache().has('Mira'), legacyValidation);

  const relationLore = [];
  EntityManager.clearCache();
  EntityManager.updateEntity('Mira', { source: 'unit_test' }, relationLore);
  EntityManager.updateEntity('Noel', { source: 'unit_test' }, relationLore);
  EntityManager.updateRelation('Mira', 'Noel', { relationType: 'ally', source: 'unit_test' }, relationLore);
  await EntityManager.saveToLorebook(fixtureChar, fixtureChat, relationLore);
  const relation = JSON.parse(relationLore.find(entry => entry.comment === 'lmai_relation').content || '{}');
  const relationValidation = IntegrityMetaManager.validateIntegrityMeta(relation, { domain: 'relation', scopeKey:fixtureScope });
  assertCase(assertions, 'relation_record_integrity_written', relation?.meta?.integrity?.schema === 'libra.integrity_meta.v1' && relationValidation.ok === true, relation?.meta?.integrity);

  MemoryState._activeScopeKey = 'integrity-scope';
  const narrativeLore = [];
  NarrativeTracker.resetState({ storylines: [], turnLog: [], metaTurnLog: [], lastSummaryTurn: 0 });
  await NarrativeTracker.saveState(narrativeLore);
  const narrative = JSON.parse(narrativeLore.find(entry => entry.comment === 'lmai_narrative').content || '{}');
  assertCase(assertions, 'narrative_state_integrity_written', narrative?.meta?.integrity?.domain === 'narrative' && IntegrityMetaManager.validateIntegrityMeta(narrative, { domain: 'narrative', scopeKey: 'integrity-scope' }).ok === true, narrative?.meta?.integrity);

  const worldLore = [];
  WorldStateTracker.resetState({ turnLog: [], consolidated: [], lastConsolidationTurn: 0 });
  WorldStateTracker.recordState(12, { currentScene: 'silver orchard', currentLocation: 'tower' });
  await WorldStateTracker.saveState(worldLore);
  const world = JSON.parse(worldLore.find(entry => entry.comment === 'lmai_world_states').content || '{}');
  assertCase(assertions, 'world_state_integrity_written', world?.meta?.integrity?.domain === 'world' && IntegrityMetaManager.validateIntegrityMeta(world, { domain: 'world', scopeKey: 'integrity-scope' }).ok === true, world?.meta?.integrity);

  const memoryEntry = await MemoryEngine.prepareMemory(
    { content: 'Mira remembers the silver orchard promise.', importance: 8 },
    12,
    [],
    [],
    null,
    { id: 'integrity-chat' },
    'msg-1',
    { scopeKey: 'integrity-scope', sourceHash: 'memory-source-1' }
  );
  const memoryMeta = parseMeta(memoryEntry?.content || '');
  assertCase(assertions, 'memory_meta_integrity_written', memoryMeta?.integrity?.domain === 'memory' && memoryMeta?.integrity?.schema === 'libra.integrity_meta.v1', memoryMeta?.integrity);
  assertCase(assertions, 'signed_memory_passes_managed_filter', MemoryEngine.getManagedEntries([memoryEntry]).length === 1, MemoryEngine.getManagedEntries([memoryEntry]).map(entry => entry.key));
  const tamperedMemoryEntry = {
    ...memoryEntry,
    content: String(memoryEntry.content || '').replace('silver orchard promise', 'tampered orchard promise')
  };
  assertCase(assertions, 'tampered_memory_blocked_from_managed_filter', MemoryEngine.getManagedEntries([tamperedMemoryEntry]).length === 0, parseMeta(tamperedMemoryEntry.content || '')?.integrity);

  assertCase(
    assertions,
    'canonical_commit_guard_api_available',
    typeof buildCanonicalTurnCommitGuard === 'function'
      && typeof reconcileCanonicalTurnCommitGuard === 'function'
      && typeof verifyCanonicalTurnCommitGuard === 'function'
  );
  const guardMemory = await MemoryEngine.prepareMemory(
    { content: 'Turn thirteen canonical memory must survive a stale maintenance snapshot.', importance: 9, forceCreate: true },
    13,
    [],
    [],
    null,
    { id: 'integrity-chat' },
    'assistant-13',
    { scopeKey: 'integrity-scope', sourceHash: 'source-13', turnKey: 'turn-key-13', chatId: 'integrity-chat' }
  );
  const guardChat = {
    id: 'integrity-chat',
    localLore: [],
    message: [
      { role: 'user', data: 'continue', chatId: 'user-13' },
      { role: 'char', data: 'canonical result', chatId: 'assistant-13' }
    ]
  };
  const guardChar = { id: 'integrity-char', globalLore: [] };
  const guardTurnRecord = {
    turn: 13,
    turnKey: 'turn-key-13',
    sourceHash: 'source-13',
    aiHash: 'source-13',
    messageId: 'assistant-13',
    liveMessageIds: ['assistant-13'],
    userTurnKey: 'user-key-13',
    memoryKey: 'memory-key-13',
    reason: 'unit-test'
  };
  const commitGuard = buildCanonicalTurnCommitGuard({
    turn: 13,
    turnKey: 'turn-key-13',
    sourceHash: 'source-13',
    scopeKey: 'integrity-scope',
    chatId: 'integrity-chat',
    primaryMemoryKey: 'memory-key-13',
    memoryEntries: [guardMemory],
    turnRecord: guardTurnRecord,
  });
  const staleMaintenanceLore = [];
  const reconciliation = reconcileCanonicalTurnCommitGuard(staleMaintenanceLore, commitGuard, guardChar, guardChat, { reason: 'unit-test-stale-rebase' });
  const guardVerification = verifyCanonicalTurnCommitGuard(staleMaintenanceLore, commitGuard, guardChar, guardChat);
  const ledger = TurnRecordLedger.loadState(staleMaintenanceLore, guardChat, guardChar, { scopeKey: 'integrity-scope' });
  assertCase(assertions, 'stale_maintenance_snapshot_restores_canonical_memory', reconciliation.ok === true && reconciliation.restoredMemories === 1 && MemoryEngine.getManagedEntries(staleMaintenanceLore).length === 1, reconciliation);
  assertCase(assertions, 'stale_maintenance_snapshot_restores_turn_ledger', ledger.records.some(record => record.turnKey === 'turn-key-13'), ledger.records);
  assertCase(assertions, 'canonical_commit_invariant_verifies_after_rebase', guardVerification.ok === true, guardVerification);
  assertCase(assertions, 'rp_memory_rewrite_refreshes_integrity_contract', code.includes('rp_ltm.memory_integrity_refresh_failed') && code.includes("IntegrityMetaManager.annotateMemoryMeta(nextMeta, body"));

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'integrity_meta_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
