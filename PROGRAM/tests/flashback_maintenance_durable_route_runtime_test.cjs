'use strict';
const { dialogElements } = require('./fixtures/flashback_adopted_dialog.cjs');
const assert = require('node:assert/strict'), path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..'), clone = value => JSON.parse(JSON.stringify(value));
const source = i => ({ sourceType: 'response', sourceId: `maintenance-source-${i}`, sourceHash: `maintenance-hash-${i}`,
  origin: 'live_chat', role: 'turn_pair', turnIndex: i + 1, pairIndex: i + 1,
  text: `User:\nWhere is parcel ${i}?\n\n---\n\nAssistant:\nParcel ${i} remains in the eastern cabinet beside the marble clock.` });
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } });
async function setup(count = 2, { pending = false } = {}) {
  const h = await createFlashback(PROGRAM, { transformSource: script => script.replace('  globalThis.__FlashbackMemory = publicApi;',
    '  globalThis.__maintenanceGui = { mount(root) { guiRoot = root; guiMounted = true; guiVisible = true; Runtime.guiTab = "import"; bindUiEvents(root); } };\n  globalThis.__FlashbackMemory = publicApi;') });
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'maintenance-model', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0,
    embeddingBatchSize: 1, autoEpisodeIndex: false, episodeIndexEnabled: false });
  await h.api.saveSettings(cfg); const scope = await h.api.resolveCurrentScope(false);
  const records = await h.api._test.buildRecordsFromSources(Array.from({ length: count }, (_, i) => source(i)), cfg, scope, { deferEmbedding: true });
  if (!pending) for (const record of records) {
    delete record.embeddingWork;
    Object.assign(record, { vector: [0.25, 0.5, 0.75], dim: 3, embeddingDimensions: 3,
      provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3', embeddingProfileId: 'legacy-maintenance' });
  }
  await h.api._test.saveAllRecords(records, cfg, scope); await h.api._test.retireExternalRecordsForScope(scope.scopeKey);
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const manifest = () => h.api._test.loadScopeManifest(scope.scopeKey);
  const call = (entry, options = {}) => entry === 'captured' ? h.api._test.reembedCapturedTurnRecords(scope, source(0).sourceHash, 1, cfg, options)
    : entry === 'progressive' ? h.api.progressivelyReembedRecords(scope, cfg, options) : h.api.reembedAllRecords(scope, { settings: cfg, ...options });
  return { h, cfg, scope, read, manifest, call };
}
for (const entry of ['captured', 'progressive', 'all']) test(`${entry} API submits corpus input only after its durable reservation`, async () => {
  const x = await setup();
  try {
    let calls = 0, unreserved = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const records = await x.read(), registry = (await x.manifest()).embeddingAttemptRegistry;
      for (const input of JSON.parse(init.body).input) {
        const row = records.find(record => record.text === input);
        if (!row?.embeddingWork?.attempt || registry?.entries[row.embeddingWork.attempt.id]?.state !== 'submitted') unreserved++;
      }
      return success(init);
    };
    const result = await x.call(entry);
    assert.equal(unreserved, 0); assert.equal(calls, entry === 'captured' ? 1 : 2);
    assert.equal(result.reembedded, entry === 'captured' ? 1 : 2);
    assert.equal((await x.read()).filter(record => record.embeddingReceipt?.status === 'ready').length, result.reembedded);
    if (entry === 'captured') assert.equal((await x.read()).find(record => record.sourceHash === source(1).sourceHash).embeddingWork, undefined);
  } finally { await x.h.cleanup(); }
});
for (const entry of ['captured', 'progressive', 'all']) test(`${entry} API keeps an unknown attempt blocked without another acknowledgement`, async () => {
  const x = await setup(1, { pending: true });
  try {
    x.h.host.nativeFetch = async () => { throw Error('synthetic unknown outcome'); };
    await x.h.api.processPendingEmbeddingWork({ sourceHash: source(0).sourceHash });
    const before = clone(await x.read()); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.call(entry).catch(error => ({ reembedded: 0, reason: error.code }));
    assert.equal(calls, 0); assert.equal(result.reembedded, 0); assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});
for (const entry of ['progressive', 'all']) test(`${entry} API never renews an exhausted outer request ledger`, async () => {
  const x = await setup();
  try {
    const ledger = x.h.audit.MemorySuiteExecutionContract.createLedger({ maxRequests: 1 });
    const used = ledger.reserve('metadata'); ledger.settle(used, 'complete');
    const before = clone(await x.read()); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await x.call(entry, { operationLedger: ledger, maxRequests: 8 }).catch(() => null);
    assert.equal(calls, 0); assert.equal(ledger.snapshot().requestCount, 1); assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});
test('the direct queue accounts for prior metadata requests in a supplied shared ledger', async () => {
  const x = await setup(2, { pending: true });
  try {
    const ledger = x.h.audit.MemorySuiteExecutionContract.createLedger({ maxRequests: 2 });
    const used = ledger.reserve('metadata'); ledger.settle(used, 'complete');
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingQueue({ operationLedger: ledger, maxSources: 8, maxRequests: 8 });
    assert.equal(calls, 1); assert.equal(result.physicalRequests, 1); assert.equal(ledger.snapshot().requestCount, 2);
    assert.equal((await x.read()).filter(record => record.embeddingWork?.status === 'pending').length, 1);
  } finally { await x.h.cleanup(); }
});
test('a maintenance source validator revoked during provider await prevents adoption', async () => {
  const x = await setup(1); let current = true;
  try {
    const before = (await x.read())[0]; let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; current = false; return success(init); };
    const result = await x.call('all', { maintenanceSourceValidate: async () => {
      if (!current) throw Object.assign(Error('maintenance source changed'), { code: 'TEST_MAINTENANCE_SOURCE_CHANGED' });
    } }).catch(error => ({ reembedded: 0, reason: error.code }));
    assert.equal(calls, 1); assert.equal(result.reembedded, 0);
    assert.deepEqual(clone((await x.read())[0].vector), clone(before.vector));
  } finally { await x.h.cleanup(); }
});

class UiNode {
  constructor(doc, tag = 'div', id = '') {
    this.doc = doc; this.tagName = tag; this.id = id; this.children = []; this.dataset = {}; this.style = {};
    this.listeners = new Map(); this.disabled = false; this.isConnected = true; this.className = ''; this.textContent = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) {
    this.html = value;
    if (this.ownerRoot) {
      for (const key of [...this.ownerRoot.nodes.keys()]) if (key.startsWith('embeddingWorkRecover_')) this.ownerRoot.nodes.delete(key);
      for (const match of String(value).matchAll(/id="(embeddingWorkRecover_\d+)"/g)) this.ownerRoot.nodes.set(match[1], new UiNode(this.doc, 'button', match[1]));
    }
  }
  get innerHTML() { return this.html || ''; }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.isConnected = false; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] || ''; }
  focus() { this.doc.activeElement = this; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  async click() { assert(this.listeners.has('click'), `${this.id || this.className} has a product event handler`); return this.listeners.get('click')({ target: this, preventDefault() {}, stopPropagation() {} }); }
}
function makeDocument() {
  const doc = { listeners: new Map(), createElement(tag) { return new UiNode(doc, tag); },
    addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); } };
  doc.body = new UiNode(doc, 'body'); doc.head = new UiNode(doc, 'head'); doc.activeElement = doc.body;
  doc.all = () => { const out = []; const walk = node => { out.push(node); node.children.forEach(walk); }; walk(doc.body); walk(doc.head); return out; };
  doc.getElementById = id => doc.all().find(node => node.id === id) || null;
  doc.byClass = name => doc.all().find(node => node.className === name) || null;
  return doc;
}

for (const entry of ['captured', 'progressive', 'all']) test(`${entry} API refuses a stale caller model configuration`, async () => {
  const x = await setup();
  try {
    await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'new-current-model' });
    const before = clone(await x.read()); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.call(entry)).reembedded, 0); assert.equal(calls, 0); assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});

test('a complete tail fits the record budget even after an oversized complete source group', async () => {
  const x = await setup(1, { pending: true });
  try {
    const cfg = x.h.api._test.normalizeSettings({ ...x.cfg, chunkChars: 400, chunkOverlap: 0 }); await x.h.api.saveSettings(cfg);
    const records = await x.h.api._test.buildRecordsFromSources([{ ...source(0), text: source(0).text.repeat(20) }, source(1)], cfg, x.scope, { deferEmbedding: true });
    assert(records.filter(record => record.sourceHash === source(0).sourceHash).length > 1);
    await x.h.api._test.saveAllRecords(records, cfg, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.progressivelyReembedRecords(x.scope, cfg, { maxRecords: 1, maxRequests: 1 });
    assert.equal(calls, 1); assert.equal(result.reembedded, 1);
    assert.equal((await x.read()).find(record => record.sourceHash === source(1).sourceHash).embeddingReceipt.status, 'ready');
    assert((await x.read()).filter(record => record.sourceHash === source(0).sourceHash).every(record => record.vector.length === 0));
  } finally { await x.h.cleanup(); }
});

test('full maintenance reports excluded archive mismatches without using its old unreserved provider route', async () => {
  const x = await setup(1);
  try {
    const archive = await x.h.api._test.createImmutableFlashbackHandoffArchive(x.scope.scopeKey, 1, x.cfg);
    await x.h.api._test.saveAllRecords([], x.cfg, x.scope);
    await x.h.api._test.saveScopeManifest({ ...await x.manifest(), archiveRef: archive.archiveRef }, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.call('all');
    assert.equal(calls, 0); assert.equal(result.archivePending, 1); assert.equal(result.archiveReason, 'archive_repair_unsupported');
    assert.equal(result.archivePendingMeaning, 'excluded_archive_records');
    assert.equal(result.archiveRecordsNeedingEmbedding, 1); assert.equal(result.pending, 0); assert.equal(result.pendingUnit, 'source_groups');
  } finally { await x.h.cleanup(); }
});

for (const mode of ['advanced', 'automatic']) test(`the registered ${mode} maintenance GUI handler uses submitted reservations for corpus requests`, async () => {
  const x = await setup();
  try {
    const chat = await x.h.host.getCurrentChat(); chat.message = [];
    for (let i = 0; i < 2; i++) chat.message.push({ role: 'user', chatId: `u-${i}`, data: `Where is parcel ${i}?` },
      { role: 'assistant', chatId: `a-${i}`, data: `Parcel ${i} remains in the eastern cabinet beside the marble clock.` });
    chat.messages = chat.message;
    const sources = x.h.api._test.collectLiveChatSourcesFromSnapshot({ character: await x.h.host.getCharacter(), chat, characterIndex: 0, chatIndex: 0 });
    const authoritative = await x.h.api._test.buildRecordsFromSources(sources, x.cfg, x.scope, { deferEmbedding: true });
    assert.equal(authoritative.length, 2);
    for (const record of authoritative) {
      if(mode==='advanced'&&record===authoritative[0])continue;
      delete record.embeddingWork;
      Object.assign(record, { vector: [0.25, 0.5, 0.75], dim: 3, embeddingDimensions: 3,
        provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3', embeddingProfileId: 'legacy-maintenance' });
    }
    await x.h.api._test.saveAllRecords(authoritative, x.cfg, x.scope);
    const doc = makeDocument(), root = new UiNode(doc, 'div', 'root'); root.nodes = new Map();
    for (const id of ['maintenanceRunBtn', 'maintenanceAutoBtn', 'maintenanceMode']) root.nodes.set(id, new UiNode(doc, id.endsWith('Btn') ? 'button' : 'select', id));
    root.nodes.get('maintenanceMode').value = 'reembed';
    root.querySelector = selector => selector.startsWith('#') ? root.nodes.get(selector.slice(1)) || null : null;
    root.querySelectorAll = selector => selector === 'button' ? [root.nodes.get('maintenanceRunBtn')] : [];
    doc.body.appendChild(root); x.h.context.document = doc; x.h.context.__maintenanceGui.mount(root);
    let corpusCalls = 0, probes = 0, unreserved = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      const inputs = JSON.parse(init.body).input;
      if (inputs.every(input => input.startsWith('Flashback maintenance embedding preflight '))) probes++;
      else {
        corpusCalls++; const rows = await x.read(), registry = (await x.manifest()).embeddingAttemptRegistry;
        for (const input of inputs) {
          const row = rows.find(record => record.text === input);
          if (!row?.embeddingWork?.attempt || registry?.entries[row.embeddingWork.attempt.id]?.state !== 'submitted') unreserved++;
        }
      }
      return success(init);
    };
    let done = false, error;
    const run = root.nodes.get(mode === 'advanced' ? 'maintenanceRunBtn' : 'maintenanceAutoBtn').click().then(() => { done = true; }, caught => { done = true; error = caught; });
    const dialogs = [], seen = new Set();
    for (let i = 0; i < 1000 && !done; i++) {
      const button = dialogElements(doc).ok;
      if (button && !seen.has(button)) { seen.add(button); dialogs.push(dialogElements(doc).message?.textContent || ''); await button.click(); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(done, 'the actual handler and its completion dialog settle'); await run; if (error) throw error;
    assert(dialogs.length >= 2); assert(!dialogs.some(message => message.startsWith('고급 기억 유지보수 실패:')), dialogs.join(' | ')); assert.equal(unreserved, 0); assert.equal(corpusCalls, mode==='advanced'?1:2); assert.equal(probes, 1);
    assert.equal((await x.read()).filter(record => record.embeddingReceipt?.status === 'ready').length, mode==='advanced'?1:2);
  } finally { await x.h.cleanup(); }
});

for (const priorRequests of [0, 1]) test(`a ${priorRequests ? 'partly used' : 'fresh'} shared ledger still enforces a two-request queue pass inside one source`, async () => {
  const x = await setup(1, { pending: true });
  try {
    const cfg = x.h.api._test.normalizeSettings({ ...x.cfg, chunkChars: 400, chunkOverlap: 0, embeddingBatchSize: 1 });
    await x.h.api.saveSettings(cfg);
    const text = Array.from({ length: 18 }, (_, i) => `${source(0).text} Unique source segment ${i} contains marker parcel-${i}.`).join('\n');
    const raw = await x.h.api._test.buildRecordsFromSources([{ ...source(0), text }], cfg, x.scope, { deferEmbedding: true });
    assert(raw.length > 2); await x.h.api._test.saveAllRecords(raw, cfg, x.scope);
    const ledger = x.h.audit.MemorySuiteExecutionContract.createLedger({ maxRequests: 10 });
    if (priorRequests) { const request = ledger.reserve('metadata'); ledger.settle(request, 'complete'); }
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingQueue({ operationLedger: ledger, maxRequests: 2, maxSources: 1 });
    assert.equal(calls, 2); assert.equal(result.physicalRequests, 2);
    assert.equal(ledger.snapshot().requestCount, priorRequests + 2); assert.equal(ledger.snapshot().pendingRequests, 0);
    assert.equal(result.ready, 0);
    assert((await x.read()).every(record => record.embeddingWork.status === 'failed' && record.vector.length === 0),
      'known completed partial batches and an unsubmitted next batch are a definite budget failure');
  } finally { await x.h.cleanup(); }
});
