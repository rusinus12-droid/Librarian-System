'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = index => ({ sourceType: 'response', sourceId: `gui-source-${index}`, sourceHash: `gui-hash-${index}`,
  origin: 'live_chat', role: 'turn_pair', turnIndex: index + 1, pairIndex: index + 1,
  text: `User:\nWhere is item ${index}?\n\n---\n\nAssistant:\nItem ${index} is kept in the north cabinet with the brass key.` });
class Node {
  constructor(id = '') { this.id = id; this.dataset = {}; this.style = {}; this.innerHTML = ''; this.textContent = ''; this.disabled = false; this.listeners = new Map(); this.classList = { toggle() {}, add() {}, remove() {} }; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] || ''; }
  async click() { assert(this.listeners.has('click'), `${this.id} has an actual product click handler`); return this.listeners.get('click')({ target: this, preventDefault() {}, stopPropagation() {} }); }
}
function root() {
  const ids = ['embeddingWorkStatus', 'embeddingWorkRefreshBtn', 'embeddingWorkRunBtn', 'embeddingWorkRetryFailedBtn'];
  const node = new Node('root'); node.isConnected = true;
  node.nodes = new Map(ids.map(id => [id, new Node(id)]));
  node.querySelector = selector => selector.startsWith('#') ? node.nodes.get(selector.slice(1)) || null : null;
  node.querySelectorAll = selector => selector === 'button' ? [...node.nodes.values()].filter(value => value.id.endsWith('Btn')) : [];
  node.remove = () => { node.isConnected = false; };
  return node;
}
async function setup(run) {
  const h = await createFlashback(PROGRAM, { transformSource: script => script.replace('  globalThis.__FlashbackMemory = publicApi;',
    '  globalThis.__workGui = { mount(root) { guiRoot = root; guiMounted = true; guiVisible = true; Runtime.guiTab = "provider"; bindUiEvents(root); }, close() { return closeGui({ hideContainer: false }); } };\n  globalThis.__FlashbackMemory = publicApi;') });
  try {
    const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai', embeddingEnabled: true, embeddingAutoProcess: false,
      embeddingModel: 'text-embedding-3-small', embeddingDimensions: 3, embeddingUrl: 'https://provider.invalid/v1/embeddings', embeddingMaxRetries: 0, autoEpisodeIndex: false });
    await h.api.saveSettings(cfg); const scope = await h.api.resolveCurrentScope(false);
    const rows = await h.api._test.buildRecordsFromSources([source(0), source(1), source(2)], cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(rows, cfg, scope);
    let calls = 0;
    const provider = async (_url, init) => { calls++; return { ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } }; };
    h.host.nativeFetch = provider;
    await run({ h, cfg, scope, provider, calls: () => calls, read: async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records });
  } finally { await h.cleanup(); }
}
const mount = async h => { const r = root(); h.context.__workGui.mount(r); await r.nodes.get('embeddingWorkRefreshBtn').click(); return r; };

test('the actual provider UI renders durable job controls and read-only refresh reports raw pending groups', async () => {
  await setup(async ({ h, calls }) => {
    const html = await h.api._test.buildUiHtml();
    for (const id of ['embeddingWorkStatus', 'embeddingWorkRefreshBtn', 'embeddingWorkRunBtn', 'embeddingWorkRetryFailedBtn']) assert(html.includes(`id="${id}"`));
    const r = await mount(h), status = r.nodes.get('embeddingWorkStatus');
    assert.match(status.innerHTML, /대기[^0-9]*3/); assert.match(status.innerHTML, /준비[^0-9]*0/);
    assert.equal(calls(), 0); assert.equal(r.nodes.get('embeddingWorkRunBtn').disabled, false);
    assert.equal(r.nodes.get('embeddingWorkRetryFailedBtn').disabled, true);
  });
});

test('clicking the pending action uses the durable worker and refreshes verified readiness', async () => {
  await setup(async ({ h, calls, read }) => {
    const r = await mount(h); await r.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 3); assert((await read()).every(row => row.embeddingReceipt?.status === 'ready'));
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /준비[^0-9]*3/);
    assert.equal(r.nodes.get('embeddingWorkRunBtn').disabled, true);
  });
});

test('failed-only retry excludes pending and uncertain sources and updates the exact failed group', async () => {
  await setup(async ({ h, provider, calls, read }) => {
    h.host.nativeFetch = async () => ({ ok: false, status: 401, async json() { return { error: { message: 'synthetic rejection' } }; } });
    await h.api.processPendingEmbeddingWork({ sourceHash: source(0).sourceHash });
    h.host.nativeFetch = async () => { throw Error('synthetic network failure'); };
    await h.api.processPendingEmbeddingWork({ sourceHash: source(1).sourceHash });
    const prior = clone(await read());
    h.host.nativeFetch = provider;
    const r = await mount(h);
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /실패[^0-9]*1/);
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /결과 확인[^0-9]*1/);
    await r.nodes.get('embeddingWorkRetryFailedBtn').click();
    assert.equal(calls(), 1);
    const rows = await read();
    assert.equal(rows.find(row => row.sourceHash === source(0).sourceHash).embeddingReceipt.status, 'ready');
    for (const index of [1, 2]) assert.deepEqual(clone(rows.find(row => row.sourceHash === source(index).sourceHash)), prior.find(row => row.sourceHash === source(index).sourceHash));
  });
});

test('repeated click while a provider is pending cannot start a second GUI operation', async () => {
  await setup(async ({ h, provider }) => {
    const r = await mount(h), entered = deferred(), release = deferred(); let first, calls = 0;
    h.host.nativeFetch = async (...args) => { calls++; entered.resolve(); await release.promise; return provider(...args); };
    try {
      first = r.nodes.get('embeddingWorkRunBtn').click(); await entered.promise;
      assert.equal(r.nodes.get('embeddingWorkRunBtn').disabled, true);
      assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /진행 중/);
      await r.nodes.get('embeddingWorkRunBtn').click(); assert.equal(calls, 1);
      release.resolve(); await first; assert.equal(calls, 3);
    } finally { release.resolve(); if (first) await first; }
  });
});

test('a stale displayed scope cannot launch work for the newly selected chat', async () => {
  await setup(async ({ h, calls, read }) => {
    const r = await mount(h), before = clone(await read());
    const character = await h.host.getCharacter();
    const chat = { id: 'gui-other-chat', chatId: 'gui-other-chat', message: [], messages: [] };
    character.chats.push(chat); character.chatPage = 1;
    h.host.getCurrentChatIndex = async () => 1; h.host.getCurrentChat = h.host.getChat = async () => chat;
    h.host.getChatFromIndex = async (_c, index) => character.chats[index];
    await r.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 0); assert.deepEqual(clone(await read()), before);
  });
});

test('a pending refresh cannot paint into a closed and reopened GUI', async () => {
  await setup(async ({ h }) => {
    const old = await mount(h), entered = deferred(), release = deferred(); let pending;
    const get = h.pluginStorage.getItem.bind(h.pluginStorage); let hold = true;
    h.pluginStorage.getItem = async key => { if (hold && String(key).endsWith(':manifest:v2')) { hold = false; entered.resolve(); await release.promise; } return get(key); };
    try {
      pending = old.nodes.get('embeddingWorkRefreshBtn').click(); await entered.promise;
      await h.context.__workGui.close();
      const next = root(); h.context.__workGui.mount(next);
      next.nodes.get('embeddingWorkStatus').innerHTML = 'new-view-marker';
      release.resolve(); await pending;
      assert.equal(next.nodes.get('embeddingWorkStatus').innerHTML, 'new-view-marker');
    } finally { release.resolve(); if (pending) await pending; }
  });
});

test('unconfigured status keeps both model actions disabled and preserves raw source', async () => {
  await setup(async ({ h, cfg, calls, read }) => {
    await h.api.saveSettings({ ...cfg, embeddingEnabled: false });
    const before = clone(await read()), r = await mount(h);
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /모델 미설정/);
    assert.equal(r.nodes.get('embeddingWorkRunBtn').disabled, true);
    assert.equal(r.nodes.get('embeddingWorkRetryFailedBtn').disabled, true);
    await r.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 0); assert.deepEqual(clone(await read()), before);
  });
});

test('incomplete groups are reported as blocked while complete raw groups can proceed', async () => {
  await setup(async ({ h, cfg, scope, calls, read }) => {
    const rows = await read(), row = rows.find(item => item.sourceHash === source(0).sourceHash);
    row.chunkCount = 2;
    const hash = h.audit.MemorySuiteExecutionContract.hash;
    row.embeddingWork.sourceRevision = hash({ sourceId: row.sourceId, sourceHash: row.sourceHash,
      chunkIndex: row.chunkIndex, chunkCount: row.chunkCount, textDigest: hash(row.text) });
    row.embeddingWork.jobId = `fb_embed_${hash({ scopeKey: row.embeddingWork.scopeKey, sourceRevision: row.embeddingWork.sourceRevision, targetProfile: row.embeddingWork.targetProfile, originScopeKey: row.embeddingWork.originScopeKey })}`;
    await h.api._test.saveAllRecords(rows, cfg, scope);
    const before = clone(row), r = await mount(h);
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /차단[^0-9]*1/);
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /대기[^0-9]*2/);
    await r.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 2);
    assert.deepEqual(clone((await read()).find(item => item.sourceHash === source(0).sourceHash)), before);
  });
});

test('background completion updates the visible provider job card without another user refresh', async () => {
  await setup(async ({ h, cfg }) => {
    const r = await mount(h);
    await h.api.saveSettings({ ...cfg, embeddingAutoProcess: true });
    await h.api._test.beforeRequest([{ role: 'user', content: 'Where is the north cabinet?' }], 'model');
    const end = Date.now() + 4000;
    while (Date.now() < end && !/준비[^0-9]*3/.test(r.nodes.get('embeddingWorkStatus').innerHTML)) await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /준비[^0-9]*3/);
  });
});

for (const changed of ['profile', 'backend']) test(`a changed ${changed} invalidates the displayed action before any model call`, async () => {
  await setup(async ({ h, cfg, calls, read }) => {
    const r = await mount(h), before = clone(await read());
    if (changed === 'profile') await h.api.saveSettings({ ...cfg, embeddingModel: 'new-model-after-view' });
    else h.argumentValues.set('memory_suite_server_url', 'https://changed-storage.invalid');
    await r.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 0);
    assert.deepEqual(clone(await read()), before);
  });
});

for (const state of ['closed', 'detached', 'reopened']) test(`a ${state} old action cannot start model work even in the same scope`, async () => {
  await setup(async ({ h, calls, read }) => {
    const old = await mount(h), before = clone(await read());
    const set = h.pluginStorage.setItem.bind(h.pluginStorage); let workWrites = 0;
    h.pluginStorage.setItem = async (key, value) => {
      if (String(key).endsWith(':manifest:v2') || String(key).includes(':shard:')) workWrites++;
      return set(key, value);
    };
    if (state === 'detached') old.remove();
    else {
      await h.context.__workGui.close();
      if (state === 'reopened') h.context.__workGui.mount(root());
    }
    await old.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 0); assert.equal(workWrites, 0);
    assert.deepEqual(clone(await read()), before);
  });
});

test('the actual pending action enables legacy migration and displays verified model readiness', async () => {
  await setup(async ({ h, cfg, scope, calls, read }) => {
    const legacy = (await read()).map(record => {
      const row = { ...record, vector: [0.2, 0.3, 0.4], vectorRef: null, dim: 3,
        provider: 'hash', model: 'hash-3', embeddingProvider: 'hash', embeddingModel: 'hash-3',
        embeddingDimensions: 3, embeddingProfileId: 'legacy-fixture' };
      delete row.embeddingWork; return row;
    });
    await h.api._test.saveAllRecords(legacy, cfg, scope);
    const r = await mount(h);
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /이전 필요[^0-9]*3/);
    assert.equal(r.nodes.get('embeddingWorkRunBtn').disabled, false);
    await r.nodes.get('embeddingWorkRunBtn').click();
    assert.equal(calls(), 3); assert((await read()).every(record => record.embeddingReceipt?.status === 'ready'));
    assert.match(r.nodes.get('embeddingWorkStatus').innerHTML, /준비[^0-9]*3/);
  });
});
