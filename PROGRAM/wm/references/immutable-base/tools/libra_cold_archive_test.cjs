'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let baseCode = fs.readFileSync(path.join(ROOT, 'dist', 'LIBRA World Manager Full.js'), 'utf8');
const exportSnippet = `
;globalThis.__LIBRA_COLD_ARCHIVE_TEST__ = {
  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,
  ColdArchiveManager: typeof ColdArchiveManager !== 'undefined' ? ColdArchiveManager : null
};
`;
const exportIndex = baseCode.lastIndexOf('\n})();');
if (exportIndex >= 0) baseCode = baseCode.slice(0, exportIndex) + exportSnippet + baseCode.slice(exportIndex);
else baseCode += exportSnippet;

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

function memoryEntry(id, turn, ttl, importance, text) {
  const meta = {
    t: turn,
    ttl,
    imp: importance,
    ent: ['Ariel', 'Dohyun'],
    m_id: `msg-${id}`,
    sourceMessageIds: [`msg-${id}`],
    sourceHash: `hash-${id}`
  };
  const payload = {
    schema: 'libra.memory.payload.v1',
    turn,
    importance,
    subject: id % 2 ? 'Ariel' : 'Dohyun',
    summary: text,
    topics: ['trust', 'moon-seal']
  };
  return {
    key: `unit-memory-${id}`,
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
  const localStore = new Map();
  const Risuai = {
    apiVersion: '3.0',
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'unit', saveMethod: 'mock' }; },
    async getArgument(key) { return key === 'activity_dashboard' ? 'off' : undefined; },
    pluginStorage: {
      async getItem(k) { return store.has(k) ? store.get(k) : null; },
      async setItem(k, v) { store.set(k, String(v)); },
      async removeItem(k) { store.delete(k); }
    },
    async getLocalPluginStorage() {
      return {
        async getItem(k) { return localStore.has(k) ? localStore.get(k) : null; },
        async setItem(k, v) { localStore.set(k, String(v)); },
        async removeItem(k) { localStore.delete(k); },
        async get(k) { return localStore.has(k) ? localStore.get(k) : null; },
        async set(k, v) { localStore.set(k, String(v)); },
        delete(k) { return localStore.delete(k); }
      };
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
  vm.runInContext(baseCode + exportSnippet, context, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 50));

  const api = context.__LIBRA_COLD_ARCHIVE_TEST__ || {};
  const engine = api.MemoryEngine;
  const archive = api.ColdArchiveManager || context.LIBRA_ColdArchiveManager;
  const assertions = [];

  assertCase(assertions, 'memory_engine_exported', !!engine && typeof engine.incrementalGC === 'function');
  assertCase(assertions, 'cold_archive_api_exported', !!archive && typeof archive.archivePrunedMemoryEntries === 'function');

  Object.assign(engine.CONFIG, {
    debug: false,
    gcBatchSize: 8,
    maxLimit: 200,
    threshold: 6,
    recallEmbeddingCandidateMax: 0,
    hybridMemoryEngineEnabled: false,
    hybridReadPathEnabled: false,
    hmeAssociativeGraphEnabled: false,
    coldArchiveHydrationEnabled: true,
    rpLongTermMemoryEnabled: false
  });

  const lore = [
    memoryEntry(1, 1, 1, 2, 'Ariel promised Dohyun to guard the moon seal after the ritual.'),
    memoryEntry(2, 1, 1, 2, 'Dohyun noticed Ariel hiding fear behind a calm expression.'),
    memoryEntry(3, 90, -1, 9, 'A permanent anchor should survive this GC pass.')
  ];
  const result = await engine.incrementalGC(lore, 99);
  const archiveEntry = result.entries.find(item => item.comment === 'lmai_cold_archive');
  const archiveState = archiveEntry ? JSON.parse(archiveEntry.content || '{}') : null;
  const remainingMemories = result.entries.filter(item => item.comment === 'lmai_memory');
  const shard = archiveState?.shards?.[0] || null;

  assertCase(assertions, 'gc_deleted_expired_hot_memories', result.deleted === 2 && remainingMemories.length === 1, {
    deleted: result.deleted,
    remaining: remainingMemories.length,
    archiveFailed: result.archiveFailed
  });
  assertCase(assertions, 'gc_reports_archived_count', result.archived === 2 && !!result.archiveShardId, result);
  assertCase(assertions, 'archive_state_written', archiveState?.schema === 'libra.cold_archive.v1' && archiveState?.shards?.length === 1, archiveState);
  assertCase(assertions, 'archive_preserves_turn_range_and_sources', shard?.turnRange?.from === 1 && shard?.turnRange?.to === 1 && shard?.sourceIds?.includes('msg-1') && shard?.sourceIds?.includes('msg-2'), shard);
  assertCase(assertions, 'archive_preserves_compact_items', shard?.items?.length === 2 && /moon seal|Ariel/i.test(JSON.stringify(shard.items)), shard?.items);
  assertCase(assertions, 'archive_entry_not_prompt_active_memory', archiveEntry?.alwaysActive === false && archiveEntry?.comment !== 'lmai_memory', archiveEntry);

  const hydratedRecall = await engine.retrieveMemories(
    'Ariel moon seal ritual promise',
    99,
    remainingMemories,
    { recallFeedbackLorebook: result.entries },
    5
  );
  const hydratedDebug = engine.getLastRetrievalDebug();
  assertCase(assertions, 'cold_archive_hydrates_relevant_recall_candidate',
    hydratedRecall.some(entry => entry?._coldArchiveHydrated === true || String(entry?.key || '').startsWith('cold:'))
      && Number(hydratedDebug?.coldArchiveHydration?.hydratedEntries || 0) > 0,
    {
      hydratedKeys: hydratedRecall.map(entry => entry.key),
      coldArchiveHydration: hydratedDebug?.coldArchiveHydration
    }
  );

  await engine.retrieveMemories(
    'bronze staircase unrelated clue',
    99,
    remainingMemories,
    { recallFeedbackLorebook: result.entries },
    5
  );
  const unrelatedDebug = engine.getLastRetrievalDebug();
  assertCase(assertions, 'cold_archive_skips_unrelated_query',
    Number(unrelatedDebug?.coldArchiveHydration?.hydratedEntries || 0) === 0,
    unrelatedDebug?.coldArchiveHydration
  );

  const directLore = [];
  const directContext = { reason: 'unit_direct', scopeKey: 'unit-scope', chatId: 'unit-chat' };
  const direct = await archive.archivePrunedMemoryEntries(directLore, [memoryEntry(4, 4, 1, 3, 'A compact direct archive write works.')], directContext);
  assertCase(assertions, 'direct_archive_write_ok', direct.ok === true && directLore.some(item => item.comment === 'lmai_cold_archive'), direct);

  Object.assign(engine.CONFIG, {
    debug: false,
    gcBatchSize: 8,
    maxLimit: 20,
    threshold: 6,
    rpLongTermMemoryEnabled: false
  });
  const capLore = Array.from({ length: 25 }, (_, index) => memoryEntry(100 + index, 20 + index, -1, 2, `Overflow memory ${index + 1} should be archived before cap pruning.`));
  const capResult = await engine.incrementalGC(capLore, 99);
  const capArchiveEntry = capResult.entries.find(item => item.comment === 'lmai_cold_archive');
  const capArchiveState = capArchiveEntry ? JSON.parse(capArchiveEntry.content || '{}') : null;
  const capShard = capArchiveState?.shards?.[0] || null;
  assertCase(assertions, 'cap_pressure_prune_archives_first', capResult.deleted === 5 && capResult.archived === 5 && capResult.entries.filter(item => item.comment === 'lmai_memory').length === 20, {
    deleted: capResult.deleted,
    archived: capResult.archived,
    remaining: capResult.entries.filter(item => item.comment === 'lmai_memory').length,
    archiveFailed: capResult.archiveFailed
  });
  assertCase(assertions, 'cap_pressure_archive_reason_recorded', capShard?.reason === 'memory_cap_pressure' && capShard?.items?.length === 5, capShard);

  const originalArchivePruned = archive.archivePrunedMemoryEntries;
  archive.archivePrunedMemoryEntries = async () => ({ ok: false, changed: false, reason: 'forced_archive_failure', ackedIds: [] });
  const failLore = [memoryEntry(500, 1, 1, 2, 'This memory must survive when cold archive writing fails.')];
  const failResult = await engine.incrementalGC(failLore, 99);
  archive.archivePrunedMemoryEntries = originalArchivePruned;
  assertCase(assertions, 'archive_failure_blocks_hot_delete', failResult.archiveFailed === true && failResult.deleted === 0 && failResult.entries.filter(item => item.comment === 'lmai_memory').length === 1, failResult);

  const manifest = await archive.readPersistentManifest(directContext);
  const firstPersistentMeta = manifest?.shards?.[0] || null;
  const firstPersistentShard = firstPersistentMeta ? await archive.readPersistentShard(firstPersistentMeta.id, directContext) : null;
  assertCase(assertions, 'persistent_archive_uses_namespaced_keys',
    Array.from(localStore.keys()).some(key => /^libra:v1:[^:]+:archive:manifest$/.test(key))
      && Array.from(localStore.keys()).every(key => !/^clear$/i.test(key)),
    Array.from(localStore.keys())
  );
  assertCase(assertions, 'persistent_shard_keeps_full_raw_entry',
    firstPersistentShard?.schema === 'libra.persistent_memory_shard.v1'
      && firstPersistentShard?.records?.[0]?.entry?.content === memoryEntry(4, 4, 1, 3, 'A compact direct archive write works.').content,
    firstPersistentShard
  );
  assertCase(assertions, 'wal_removed_after_successful_commit',
    !Array.from(localStore.keys()).some(key => key.endsWith(':archive:wal') && key.includes(archive.persistentKeys(directContext).namespace)),
    Array.from(localStore.keys()).filter(key => key.includes(archive.persistentKeys(directContext).namespace))
  );

  const largeLore = [];
  const largeEntries = Array.from({ length: 30 }, (_, index) => memoryEntry(
    700 + index,
    100 + index,
    1,
    3,
    `Large archive item ${index} ` + 'evidence '.repeat(1400)
  ));
  const largeContext = { reason: 'unit_large_batch', scopeKey: 'large-scope', chatId: 'large-chat' };
  const largeResult = await archive.archivePrunedMemoryEntries(largeLore, largeEntries, largeContext);
  const largeManifest = await archive.readPersistentManifest(largeContext);
  const largePersistentCount = (largeManifest?.shards || []).reduce((sum, item) => sum + Number(item?.entryCount || 0), 0);
  const largePreviewStateEntry = largeLore.find(item => item.comment === 'lmai_cold_archive');
  const largePreviewState = largePreviewStateEntry ? JSON.parse(largePreviewStateEntry.content || '{}') : null;
  assertCase(assertions, 'archive_handles_more_than_24_without_loss',
    largeResult.ok === true
      && largeResult.ackedIds.length === 30
      && largePersistentCount === 30
      && (largePreviewState?.shards?.length || 0) >= 2,
    {
      acked: largeResult.ackedIds.length,
      persistentCount: largePersistentCount,
      persistentShards: largeManifest?.shards?.length || 0,
      previewShards: largePreviewState?.shards?.length || 0
    }
  );

  Object.assign(engine.CONFIG, {
    debug: false,
    gcBatchSize: 8,
    maxLimit: 200,
    threshold: 6,
    rpLongTermMemoryEnabled: false
  });
  const partialLore = [
    memoryEntry(800, 1, 1, 2, 'First partial ACK memory.'),
    memoryEntry(801, 1, 1, 2, 'Second partial ACK memory.')
  ];
  archive.archivePrunedMemoryEntries = async (_lore, candidates) => ({
    ok: true,
    partial: true,
    reason: 'forced_partial_ack',
    ackedIds: [String(candidates?.[0]?.key || '')],
    shards: []
  });
  const partialResult = await engine.incrementalGC(partialLore, 99);
  archive.archivePrunedMemoryEntries = originalArchivePruned;
  assertCase(assertions, 'partial_ack_deletes_only_verified_entry',
    partialResult.deleted === 1
      && partialResult.archivePartial === true
      && partialResult.entries.filter(item => item.comment === 'lmai_memory').length === 1
      && partialResult.entries.some(item => item.key === 'unit-memory-801'),
    partialResult
  );

  const output = { ok: assertions.every(item => item.ok), assertions };
  const outPath = path.join(ROOT, 'test-output', 'cold_archive_result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
