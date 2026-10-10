'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const source = index => ({ sourceType: 'response', sourceId: `recover-source-${index}`, sourceHash: `recover-hash-${index}`,
  origin: 'live_chat', role: 'turn_pair', turnIndex: index + 1, pairIndex: index + 1,
  text: `User:\nWhere is book ${index}?\n\n---\n\nAssistant:\nBook ${index} is on the western shelf beside a ceramic bowl.` });
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } });
const recoveryTransform = script => script.replace('  globalThis.__FlashbackMemory = publicApi;',
  '  globalThis.__recoveryAudit = { issue: (...args) => issueEmbeddingRecoveryOffer(...args), accept: (...args) => acceptEmbeddingRecoveryOffer(...args), mount(root) { guiRoot = root; guiMounted = true; guiVisible = true; Runtime.guiTab = "provider"; bindUiEvents(root); }, close() { return closeGui({ hideContainer: false }); } };\n  globalThis.__FlashbackMemory = publicApi;');
async function setup(count = 1, { uncertain = true } = {}) {
  const h = await createFlashback(PROGRAM, { transformSource: recoveryTransform });
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai_compat', embeddingModel: 'recover-model', embeddingDimensions: 3,
    embeddingUrl: 'https://provider.invalid/v1', embeddingEnabled: true, embeddingAutoProcess: false, embeddingMaxRetries: 0, autoEpisodeIndex: false });
  await h.api.saveSettings(cfg); const scope = await h.api.resolveCurrentScope(false);
  const rows = await h.api._test.buildRecordsFromSources(Array.from({ length: count }, (_, i) => source(i)), cfg, scope, { deferEmbedding: true });
  await h.api._test.saveAllRecords(rows, cfg, scope);
  if (uncertain) {
    h.host.nativeFetch = async () => { throw Error('synthetic unknown original result'); };
    for (let i = 0; i < count; i++) assert.equal((await h.api.processPendingEmbeddingWork({ sourceHash: source(i).sourceHash })).uncertain, true);
  }
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const manifest = () => h.api._test.loadScopeManifest(scope.scopeKey);
  const selection = i => ({ sourceHash: source(i).sourceHash, originScopeKey: scope.scopeKey });
  const offer = i => h.context.__recoveryAudit.issue(selection(i));
  const accept = (issued, i = 0) => h.context.__recoveryAudit.accept(issued.token, selection(i));
  return { h, cfg, scope, read, manifest, selection, offer, accept };
}

test('a pre-origin raw-work contract can reserve and complete under its validated original source', async () => {
  const x = await setup(1, { uncertain: false });
  try {
    const rows = clone(await x.read());
    for (const row of rows) {
      delete row.embeddingOriginScopeKey; delete row.embeddingWork.originScopeKey;
      row.embeddingWork.jobId = `fb_embed_${x.h.audit.MemorySuiteExecutionContract.hash({ scopeKey: row.scopeKey,
        sourceRevision: row.embeddingWork.sourceRevision, targetProfile: row.embeddingWork.targetProfile })}`;
    }
    await x.h.api._test.saveAllRecords(rows, x.cfg, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.h.api.processPendingEmbeddingWork(x.selection(0));
    assert.equal(result.ready, 1); assert.equal(calls, 1);
  } finally { await x.h.cleanup(); }
});

test('an accepted recovery publishes one successor and preserves unknown predecessor acknowledgement links before its wire', async () => {
  const x = await setup();
  try {
    const prior = (await x.read())[0].embeddingWork.attempt.id, issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const manifest = await x.manifest(), successor = (await x.read())[0].embeddingWork.attempt.id;
      assert.notEqual(successor, prior);
      const predecessor = manifest.embeddingAttemptRegistry.entries[prior], next = manifest.embeddingAttemptRegistry.entries[successor];
      assert.equal(next.state, 'submitted');
      assert(predecessor.recoveryAcknowledgements.some(ack => ack.successorAttemptId === successor && ack.id === next.recovery.acknowledgementId));
      return success(init);
    };
    const result = await x.accept(issued); assert.equal(result.ready, 1); assert.equal(calls, 1);
    assert((await x.manifest()).embeddingAttemptRegistry.entries[prior], 'unknown original result is retained after successor completion');
    assert.equal((await x.read())[0].embeddingReceipt.attemptId, result.attemptId);
    assert.equal((await x.accept(issued)).ready, 0); assert.equal(calls, 1, 'one private offer never authorizes a second successor');
  } finally { await x.h.cleanup(); }
});

test('a valid offer from another source cannot authorize recovery after public fields are substituted', async () => {
  const x = await setup(2);
  try {
    const issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const before = clone(await x.read()), history = clone((await x.manifest()).embeddingAttemptRegistry);
    const result = await x.accept({ ...issued, ...x.selection(1) }, 1);
    assert.equal(result.ready, 0); assert.equal(calls, 0);
    assert.deepEqual(clone(await x.read()), before); assert.deepEqual(clone((await x.manifest()).embeddingAttemptRegistry), history);
  } finally { await x.h.cleanup(); }
});

for (const changed of ['profile', 'credential', 'backend', 'source']) test(`a changed ${changed} invalidates an issued recovery offer without submission`, async () => {
  const x = await setup();
  try {
    const issued = await x.offer(0); let calls = 0;
    if (changed === 'profile') await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'other-model' });
    if (changed === 'credential') await x.h.api._test.saveEmbeddingCredential('changed-test-credential');
    if (changed === 'backend') x.h.argumentValues.set('memory_suite_server_url', 'https://different-storage.invalid');
    if (changed === 'source') {
      const rows = (await x.read()).map(record => ({ ...record, privacyRestricted: true }));
      await x.h.api._test.saveAllRecords(rows, x.cfg, x.scope);
    }
    const before = clone(await x.read());
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.accept(issued); assert.equal(result.ready, 0); assert.equal(calls, 0);
    assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});

test('a failed acknowledged successor still requires a fresh acknowledgement before another successor', async () => {
  const x = await setup();
  try {
    const issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async () => { calls++; return { ok: false, status: 400, async text() { return '{"error":"synthetic rejection"}'; } }; };
    await x.accept(issued); assert.equal(calls, 1);
    await x.h.api.processPendingEmbeddingQueue({ onlyFailed: true, retryFailed: true });
    assert.equal(calls, 1);
    const next = await x.offer(0);
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.accept(next)).ready, 1); assert.equal(calls, 2);
    const entries = Object.values((await x.manifest()).embeddingAttemptRegistry.entries);
    assert(entries.some(entry => entry.recoveryAcknowledgements?.length === 2));
  } finally { await x.h.cleanup(); }
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('a known active original request cannot receive an uncertainty-recovery offer', async () => {
  const x = await setup(1, { uncertain: false }), entered = deferred(), release = deferred(); let running;
  try {
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; entered.resolve(); await release.promise; return success(init); };
    running = x.h.api.processPendingEmbeddingWork(x.selection(0)); await entered.promise;
    await assert.rejects(() => x.offer(0), error => error.code === 'FLASHBACK_EMBEDDING_ATTEMPT_RUNNING');
    release.resolve(); assert.equal((await running).ready, 1); assert.equal(calls, 1);
  } finally { release.resolve(); if (running) await running; await x.h.cleanup(); }
});

test('a refused acknowledgement reservation consumes its offer without submitting or overwriting the old source', async () => {
  const x = await setup(); const original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage);
  try {
    const issued = await x.offer(0), before = clone(await x.read()); let rejected = 0, calls = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      if (String(key).endsWith(':manifest:v2') && Object.values(JSON.parse(value).embeddingAttemptRegistry?.entries || {}).some(entry => entry.recovery)) {
        rejected++; return false;
      }
      return original(key, value);
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    assert.equal((await x.accept(issued)).ready, 0); assert(rejected); assert.equal(calls, 0);
    x.h.pluginStorage.setItem = original;
    assert.deepEqual(clone(await x.read()), before);
    assert.equal((await x.accept(issued)).ready, 0); assert.equal(calls, 0);
  } finally { x.h.pluginStorage.setItem = original; await x.h.cleanup(); }
});

test('a removed acknowledgement link during the provider await prevents successor adoption', async () => {
  const x = await setup();
  try {
    const prior = (await x.read())[0].embeddingWork.attempt.id, issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const manifest = await x.manifest(), registry = clone(manifest.embeddingAttemptRegistry);
      delete registry.entries[prior].recoveryAcknowledgements;
      const { digest, ...body } = registry; registry.digest = x.h.audit.MemorySuiteExecutionContract.hash(body);
      await x.h.api._test.saveScopeManifest({ ...manifest, embeddingAttemptRegistry: registry }, x.scope);
      return success(init);
    };
    const result = await x.accept(issued);
    assert.equal(calls, 1); assert.equal(result.ready, 0); assert.equal(result.uncertain, true);
    assert.equal((await x.read())[0].vector.length, 0);
  } finally { await x.h.cleanup(); }
});

test('restart preserves an unknown successor and does not reuse its old private offer', async () => {
  const x = await setup(); let second;
  try {
    const issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async () => { calls++; throw Error('synthetic successor unknown result'); };
    assert.equal((await x.accept(issued)).uncertain, true); assert.equal(calls, 1);
    const originalEntries = clone((await x.manifest()).embeddingAttemptRegistry.entries);
    await x.h.cleanup();
    second = await createFlashback(PROGRAM, { pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage, transformSource: recoveryTransform });
    second.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await second.api.processPendingEmbeddingQueue({ retryFailed: true });
    assert.equal((await second.context.__recoveryAudit.accept(issued.token, x.selection(0))).ready, 0);
    assert.equal(calls, 1);
    assert.deepEqual(clone((await second.api._test.loadScopeManifest(x.scope.scopeKey)).embeddingAttemptRegistry.entries), originalEntries);
  } finally { await x.h.cleanup(); if (second) await second.cleanup(); }
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
async function mountRecovery(x, doc = makeDocument()) {
  const root = new UiNode(doc, 'div', 'root'); root.nodes = new Map();
  for (const id of ['embeddingWorkStatus', 'embeddingWorkRefreshBtn', 'embeddingWorkRunBtn', 'embeddingWorkRetryFailedBtn']) {
    const node = new UiNode(doc, id.endsWith('Btn') ? 'button' : 'div', id); node.ownerRoot = root; root.nodes.set(id, node);
  }
  root.querySelector = selector => selector.startsWith('#') ? root.nodes.get(selector.slice(1)) || null : null;
  root.querySelectorAll = selector => selector === 'button' ? [...root.nodes.values()].filter(node => node.tagName === 'button') : [];
  doc.body.appendChild(root); x.h.context.document = doc; x.h.context.__recoveryAudit.mount(root);
  await root.nodes.get('embeddingWorkRefreshBtn').click();
  return { root, doc, button: () => root.nodes.get('embeddingWorkRecover_0') };
}
async function dialog(ui) {
  for (let i = 0; i < 200; i++) {
    if (ui.doc.byClass('vrmDialogOk')) return { ok: ui.doc.byClass('vrmDialogOk'), cancel: ui.doc.byClass('vrmDialogCancel'), message: ui.doc.byClass('vrmDialogMessage') };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('actual recovery confirmation dialog did not appear');
}
for (const choice of ['accept', 'cancel']) test(`the actual recovery dialog ${choice}s exactly the displayed uncertain source`, async () => {
  const x = await setup();
  try {
    const ui = await mountRecovery(x); assert(ui.button(), 'uncertain group exposes a concrete recovery choice');
    const before = clone(await x.read()), history = clone((await x.manifest()).embeddingAttemptRegistry); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const running = ui.button().click(), modal = await dialog(ui);
    assert.match(modal.message.textContent, /중복/); assert.match(modal.message.textContent, /비용/);
    await modal[choice === 'accept' ? 'ok' : 'cancel'].click(); await running;
    assert.equal(calls, choice === 'accept' ? 1 : 0);
    if (choice === 'cancel') { assert.deepEqual(clone(await x.read()), before); assert.deepEqual(clone((await x.manifest()).embeddingAttemptRegistry), history); }
    else assert.equal((await x.read())[0].embeddingReceipt.status, 'ready');
  } finally { await x.h.cleanup(); }
});
for (const changed of ['closed', 'profile', 'source']) test(`a ${changed} view while the recovery dialog is open cannot start the successor`, async () => {
  const x = await setup();
  try {
    const ui = await mountRecovery(x); assert(ui.button()); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const running = ui.button().click(), modal = await dialog(ui);
    if (changed === 'closed') await x.h.context.__recoveryAudit.close();
    if (changed === 'profile') await x.h.api.saveSettings({ ...x.cfg, embeddingModel: 'new-model-during-dialog' });
    if (changed === 'source') await x.h.api._test.saveAllRecords((await x.read()).map(record => ({ ...record, privacyRestricted: true })), x.cfg, x.scope);
    const before = clone(await x.read()); await modal.ok.click(); await running;
    assert.equal(calls, 0); assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});
test('a retained old recovery button cannot act after reopening the same scope', async () => {
  const x = await setup();
  try {
    const old = await mountRecovery(x); assert(old.button()); const oldButton = old.button();
    await x.h.context.__recoveryAudit.close(); const current = await mountRecovery(x); assert(current.button());
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const before = clone(await x.read()); await oldButton.click();
    assert.equal(calls, 0); assert.equal(old.doc.byClass('vrmDialogOk'), null); assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});

test('acknowledgement removal after the first batch prevents every later physical batch', async () => {
  const x = await setup(1, { uncertain: false });
  try {
    const cfg = x.h.api._test.normalizeSettings({ ...x.cfg, chunkChars: 400, chunkOverlap: 0, embeddingBatchSize: 1 });
    await x.h.api.saveSettings(cfg);
    const rows = await x.h.api._test.buildRecordsFromSources([{ ...source(0), text: source(0).text.repeat(18) }], cfg, x.scope, { deferEmbedding: true });
    assert(rows.length > 1); await x.h.api._test.saveAllRecords(rows, cfg, x.scope);
    x.h.host.nativeFetch = async () => { throw Error('synthetic unknown original first batch'); };
    await x.h.api.processPendingEmbeddingWork(x.selection(0));
    const prior = (await x.read())[0].embeddingWork.attempt.id, issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++;
      if (calls === 1) {
        const manifest = await x.manifest(), registry = clone(manifest.embeddingAttemptRegistry);
        delete registry.entries[prior].recoveryAcknowledgements;
        const { digest, ...body } = registry; registry.digest = x.h.audit.MemorySuiteExecutionContract.hash(body);
        await x.h.api._test.saveScopeManifest({ ...manifest, embeddingAttemptRegistry: registry }, x.scope);
      }
      return success(init);
    };
    const result = await x.accept(issued);
    assert.equal(calls, 1); assert.equal(result.ready, 0); assert.equal(result.uncertain, true);
    assert((await x.read()).every(record => record.vector.length === 0));
  } finally { await x.h.cleanup(); }
});

test('recovery of a detached old profile preserves the retained current vector until verified replacement', async () => {
  const x = await setup();
  try {
    const prior = (await x.read())[0].embeddingWork.attempt.id;
    const other = { ...x.cfg, embeddingModel: 'retained-other-model' }; await x.h.api.saveSettings(other);
    x.h.host.nativeFetch = async (_url, init) => success(init);
    assert.equal((await x.h.api.processPendingEmbeddingQueue()).ready, 1);
    const before = clone((await x.read())[0]); await x.h.api.saveSettings(x.cfg);
    const issued = await x.offer(0); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const [running] = await x.read();
      assert.deepEqual(clone(running.vector), before.vector); assert.equal(running.model, before.model);
      assert.deepEqual(clone(running.embeddingReceipt), before.embeddingReceipt);
      assert.equal(running.embeddingWork.schema, 'flashback.embedding_retained_work.v1');
      assert.equal(running.embeddingWork.status, 'running'); return success(init);
    };
    assert.equal((await x.accept(issued)).ready, 1); assert.equal(calls, 1);
    assert.equal((await x.read())[0].model, x.cfg.embeddingModel);
    assert((await x.manifest()).embeddingAttemptRegistry.entries[prior]);
  } finally { await x.h.cleanup(); }
});

test('acknowledgement capacity exhaustion preserves all history bytes and submits nothing', async () => {
  const x = await setup();
  try {
    const manifest = await x.manifest(), registry = clone(manifest.embeddingAttemptRegistry), entry = Object.values(registry.entries)[0];
    entry.recoveryAcknowledgements = Array.from({ length: 128 }, (_, index) => {
      const body = { schema: 'flashback.embedding_recovery_ack.v1', id: `old-ack-${index}`, successorAttemptId: `old-successor-${index}`,
        scopeKey: x.scope.scopeKey, originScopeKey: x.scope.scopeKey, sourceHash: entry.sourceHash, sourceSet: entry.sourceSet,
        profileFingerprint: entry.jobs[0].targetProfile.profileFingerprint, storageBinding: 'historical-binding', acknowledgedAt: index };
      return { ...body, digest: x.h.audit.MemorySuiteExecutionContract.hash(body) };
    });
    const { digest, ...body } = registry; registry.digest = x.h.audit.MemorySuiteExecutionContract.hash(body);
    await x.h.api._test.saveScopeManifest({ ...manifest, embeddingAttemptRegistry: registry }, x.scope);
    const issued = await x.offer(0), before = clone(await x.read()); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await x.accept(issued);
    assert.equal(result.ready, 0); assert.equal(result.reason, 'FLASHBACK_EMBEDDING_REGISTRY_CAPACITY'); assert.equal(calls, 0);
    assert.deepEqual(clone((await x.manifest()).embeddingAttemptRegistry), registry); assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});
