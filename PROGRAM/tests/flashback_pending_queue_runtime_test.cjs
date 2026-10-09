'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const source = index => ({ sourceType: 'response', sourceId: `queue-source-${index}`, sourceHash: `queue-hash-${index}`,
  origin: 'live_chat', role: 'turn_pair', turnIndex: index + 1, pairIndex: index + 1,
  text: `User:\nQuestion for item ${index}.\n\n---\n\nAssistant:\nThe answer for item ${index} mentions the quiet courtyard and the brass key.` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function setup(options = {}) {
  const h = await createFlashback(PROGRAM, { ...options, transformSource: script => {const anchor='  globalThis.__FlashbackMemory = publicApi;';assert.equal(script.split(anchor).length,2,'unique public publication anchor');return script.replace(anchor,
    '  globalThis.__queueCapture = { saveFinalizedChatCapture, loadRisuSnapshot, authoritativeFinalizedCandidate, schedulePendingEmbeddingWork };\n'+anchor)} });
  const cfg = h.api._test.normalizeSettings({ embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small', embeddingEnabled: true,
    embeddingUrl: 'https://provider.invalid/v1/embeddings', embeddingDimensions: 3, embeddingBatchSize: 1,
    embeddingMaxRetries: 0, embeddingAutoProcess: false, autoEpisodeIndex: false, progressiveReembedMaxRecords: 8, progressiveReembedMaxRequests: 8 });
  if (!options.pluginStorage) await h.api.saveSettings(cfg);
  const scope = await h.api.resolveCurrentScope(false);
  const read = async () => (await h.api._test.loadScopeRecords(scope.scopeKey)).records;
  const store = async sources => {
    const rows = await h.api._test.buildRecordsFromSources(sources, cfg, scope, { deferEmbedding: true });
    await h.api._test.saveAllRecords(rows, cfg, scope); return rows;
  };
  return { h, cfg, scope, read, store };
}
const success = init => ({ ok: true, status: 200, async json() { return { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } });
const queue = h => { assert.equal(typeof h.api.processPendingEmbeddingQueue, 'function'); return h.api.processPendingEmbeddingQueue; };

test('more than one failing front batch cannot starve a valid pending tail', async () => {
  const x = await setup();
  try {
    await x.store(Array.from({ length: 27 }, (_, index) => source(index)));
    const tail = (await x.read()).at(-1), tailIndex = Number(tail.sourceHash.match(/-(\d+)$/)[1]);
    let calls = 0; const counts = new Map();
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; const input = JSON.parse(init.body).input[0];
      const index = Number(input.match(/item (\d+)/)[1]); counts.set(index, (counts.get(index) || 0) + 1);
      if (index === tailIndex) return success(init);
      return { ok: true, status: 200, async json() { return { data: [{ index: 0, embedding: [0, 0, 0] }] }; } };
    };
    for (let pass = 0; pass < 4; pass++) {
      const before = calls;
      const result = await queue(x.h)({ maxSources: 8, maxRequests: 8 });
      assert(calls - before <= 8, 'per-item failure never resets the shared physical budget');
      assert.equal(result.physicalRequests, calls - before);
    }
    const records = await x.read();
    assert.equal(records.find(row => row.sourceHash === tail.sourceHash).embeddingReceipt.status, 'ready');
    assert.equal(calls, 27);
    assert([...counts.values()].every(count => count === 1));
    assert(records.filter(row => row.embeddingWork?.status === 'failed').length === 26);
    await queue(x.h)({ maxSources: 8, maxRequests: 8 });
    assert.equal(calls, 27, 'definite failures wait for explicit retry');
  } finally { await x.h.cleanup(); }
});

test('incomplete source groups across a large prefix do not hide a complete tail or consume wire budget', async () => {
  const x = await setup();
  try {
    await x.store(Array.from({ length: 26 }, (_, index) => source(index)));
    const short = await x.read();
    const bad = short.slice(0, 25).map(row => {
      const record = { ...row, chunkCount: 2 };
      const hash = x.h.audit.MemorySuiteExecutionContract.hash;
      const revision = hash({ sourceId: record.sourceId, sourceHash: record.sourceHash, chunkIndex: record.chunkIndex,
        chunkCount: record.chunkCount, textDigest: hash(record.text) });
      const work = { ...record.embeddingWork, sourceRevision: revision };
      work.jobId = `fb_embed_${hash({ scopeKey: work.scopeKey, sourceRevision: revision, targetProfile: work.targetProfile, originScopeKey: work.originScopeKey })}`;
      return { ...record, embeddingWork: work };
    });
    await x.h.api._test.saveAllRecords([...bad, short[25]], x.cfg, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await queue(x.h)({ maxSources: 1, maxRequests: 1 });
    assert.equal(calls, 1); assert.equal(result.ready, 1); assert.equal(result.blockedSources, 25);
    assert.equal((await x.read()).find(row => row.sourceHash === short[25].sourceHash).embeddingReceipt.status, 'ready');
  } finally { await x.h.cleanup(); }
});

test('shared request exhaustion leaves later jobs unreserved', async () => {
  const x = await setup();
  try {
    await x.store(Array.from({ length: 9 }, (_, index) => source(index)));
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await queue(x.h)({ maxSources: 9, maxRequests: 3 });
    assert.equal(calls, 3); assert.equal(result.ready, 3); assert.equal(result.physicalRequests, 3);
    const pending = (await x.read()).filter(row => row.embeddingWork);
    assert.equal(pending.length, 6); assert(pending.every(row => row.embeddingWork.status === 'pending' && !row.embeddingWork.attempt));
  } finally { await x.h.cleanup(); }
});

test('a provisional or private pending source is never automatically submitted', async () => {
  const x = await setup();
  try {
    const rows = await x.store([source(0), source(1)]);
    rows[0].metadata.captureAuthority = { provisional: true, liveConfirmed: false };
    rows[1].privacyRestricted = true;
    await x.h.api._test.saveAllRecords(rows, x.cfg, x.scope);
    let calls = 0; x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const before = clone(await x.read());
    const result = await queue(x.h)();
    assert.equal(calls, 0); assert.equal(result.ready, 0);
    assert.deepEqual(clone(await x.read()), before);
  } finally { await x.h.cleanup(); }
});

test('an overlapping queue cannot submit the same source twice', async () => {
  const x = await setup(); const entered = deferred(), release = deferred(); let running;
  try {
    await x.store([source(0)]); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; entered.resolve(); await release.promise; return success(init); };
    running = queue(x.h)(); await entered.promise;
    const second = await queue(x.h)();
    assert.equal(second.reason, 'queue_running'); assert.equal(calls, 1);
    release.resolve(); assert.equal((await running).ready, 1);
  } finally { release.resolve(); if (running) await running; await x.h.cleanup(); }
});

test('a requested stale scope starts no job and makes no provider call', async () => {
  const x = await setup();
  try {
    await x.store([source(0)]); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await queue(x.h)({ scopeKey: 'former-scope' });
    assert.equal(calls, 0); assert.equal(result.ready, 0); assert.equal(result.reason, 'scope_changed');
  } finally { await x.h.cleanup(); }
});

test('an explicitly zero request budget starts no reservation', async () => {
  const x = await setup();
  try {
    await x.store([source(0)]); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    const result = await queue(x.h)({ maxRequests: 0 });
    assert.equal(calls, 0); assert.equal(result.physicalRequests, 0);
    assert.equal((await x.read())[0].embeddingWork.status, 'pending');
  } finally { await x.h.cleanup(); }
});

test('restart skips an uncertain running source and can continue an unrelated pending source', async () => {
  const x = await setup(), entered = deferred(), release = deferred(); let pending, second;
  try {
    await x.store([source(0), source(1)]);
    x.h.host.nativeFetch = async (_url, init) => { entered.resolve(); await release.promise; return success(init); };
    pending = x.h.api.processPendingEmbeddingWork({ sourceHash: source(0).sourceHash }); await entered.promise;
    const original = clone((await x.read()).find(row => row.sourceHash === source(0).sourceHash));
    await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    let calls = 0;
    second.h.host.nativeFetch = async (_url, init) => {
      calls++; assert(JSON.parse(init.body).input[0].includes('item 1')); return success(init);
    };
    const result = await queue(second.h)();
    assert.equal(calls, 1); assert.equal(result.ready, 1); assert.equal(result.uncertainSources, 1);
    assert.deepEqual(clone((await second.read()).find(row => row.sourceHash === source(0).sourceHash)), original);
    release.resolve(); assert.equal((await pending).ok, false);
  } finally { release.resolve(); if (pending) await pending; await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('one pass deadline is not renewed for the next source', async () => {
  const x = await setup();
  try {
    await x.store([source(0), source(1)]); let calls = 0;
    x.h.context.__queueClock = Date.now();
    vm.runInContext('Date.now = () => globalThis.__queueClock;', x.h.context);
    x.h.host.nativeFetch = async (_url, init) => { calls++; x.h.context.__queueClock += 70; return success(init); };
    const result = await queue(x.h)({ timeoutMs: 45, maxRequests: 8 });
    assert.equal(calls, 1); assert.equal(result.ready, 0);
    const records = await x.read();
    assert.equal(records.find(row => row.sourceHash === source(1).sourceHash).embeddingWork.status, 'pending');
  } finally { await x.h.cleanup(); }
});

async function waitFor(predicate, message, timeoutMs = 7000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail(message);
}

test('real finalized capture returns after raw durability while its scheduled provider is still pending', async () => {
  const x = await setup(), entered = deferred(), release = deferred();
  try {
    await x.h.api.saveSettings({ ...x.cfg, embeddingEnabled: false });
    const user = 'I examine the north cabinet.';
    await x.h.api._test.beforeRequest([{ role: 'user', chatId: 'final-queue-u', content: user }], 'model');
    const pending = x.h.audit.Runtime.pendingTurns[0]; assert(pending);
    const chat = await x.h.host.getCurrentChat();
    chat.message = [{ role: 'user', chatId: 'final-queue-u', data: user },
      { role: 'assistant', chatId: 'final-queue-a', data: 'The brass key waits beside the blue lamp inside the cabinet.' }];
    chat.messages = chat.message;
    const cfg = await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true });
    const snapshot = await x.h.context.__queueCapture.loadRisuSnapshot(false);
    const candidate = x.h.context.__queueCapture.authoritativeFinalizedCandidate(x.h.api._test.normalizeStoredChatMessages(chat, x.scope.scopeKey), pending);
    assert(candidate);
    let calls = 0, captureReturned = false;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++; assert(captureReturned, 'provider work must start outside the capture return');
      const rows = await x.read(); assert(rows.length); assert(rows.every(row => row.embeddingWork?.status === 'running'));
      entered.resolve(); await release.promise; return success(init);
    };
    const saved = await x.h.context.__queueCapture.saveFinalizedChatCapture(pending, candidate, snapshot, cfg);
    captureReturned = true;
    assert.equal(saved, true); assert((await x.read()).some(row => row.text.includes('blue lamp')));
    await waitFor(() => calls > 0, 'final capture did not schedule its durable raw job');
    assert.equal(calls, 1); release.resolve();
    await waitFor(async () => (await x.read()).every(row => row.embeddingReceipt?.status === 'ready'), 'scheduled completion was not adopted');
  } finally { release.resolve(); await x.h.cleanup(); }
});

test('paused automatic work retains raw jobs until the actual next-request wake after resume', async () => {
  const x = await setup();
  try {
    await x.store([source(0)]); let documentCalls = 0;
    x.h.host.nativeFetch = async (_url, init) => { if (JSON.parse(init.body).input.some(text => text.includes('Assistant:'))) documentCalls++; return success(init); };
    await x.h.api._test.beforeRequest([{ role: 'user', content: 'Where is the brass key?' }], 'model');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(documentCalls, 0); assert.equal((await x.read())[0].embeddingWork.status, 'pending');
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true });
    await x.h.api._test.beforeRequest([{ role: 'user', content: 'What about that brass key now?' }], 'model');
    await waitFor(async () => (await x.read())[0].embeddingReceipt?.status === 'ready', 'next-request background wake did not resume pending work');
    assert.equal(documentCalls, 1);
  } finally { await x.h.cleanup(); }
});

test('startup resumes durable pending jobs when automatic work is enabled', async () => {
  const x = await setup(); let second;
  try {
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true });
    await x.store([source(0)]); await x.h.cleanup();
    second = await setup({ pluginStorage: x.h.pluginStorage, safeLocalStorage: x.h.safeLocalStorage });
    let calls = 0; second.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    await waitFor(async () => (await second.read())[0].embeddingReceipt?.status === 'ready', 'startup did not resume pending work', 8000);
    assert.equal(calls, 1);
  } finally { await x.h.cleanup(); if (second) await second.h.cleanup(); }
});

test('source privacy revoked during the provider await cannot adopt model output', async () => {
  const x = await setup();
  try {
    await x.store([source(0)]); let calls = 0;
    const beforeText=(await x.read())[0].text;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++;const rows=await x.read();
      await x.h.api._test.saveAllRecords(rows.map(row=>({...row,privacyRestricted:true})),x.cfg,x.scope);
      return success(init);
    };
    const result = await queue(x.h)();
    assert.equal(calls, 1); assert.equal(result.ready, 0);
    const row=(await x.read())[0];assert.equal(row.vector.length,0);assert.notEqual(row.embeddingReceipt?.status,'ready');assert.equal(row.text,beforeText);assert.equal(row.privacyRestricted,true);
  } finally { await x.h.cleanup(); }
});

test('a later source made private by an earlier job is rechecked before submission', async () => {
  const x = await setup();
  try {
    await x.store([source(0), source(1)]); let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      calls++;
      if (calls === 1) {
        const rows = await x.read();
        await x.h.api._test.saveAllRecords(rows.map(row => row.sourceHash === source(1).sourceHash ? { ...row, privacyRestricted: true } : row), x.cfg, x.scope);
      }
      return success(init);
    };
    await queue(x.h)();
    assert.equal(calls, 1);
    assert.equal((await x.read()).find(row => row.sourceHash === source(1).sourceHash).vector.length, 0);
  } finally { await x.h.cleanup(); }
});

test('scheduled discovery waits while the actual beforeRequest query is in progress', async () => {
  const x = await setup(), entered = deferred(), release = deferred(); let request;
  try {
    await x.store([source(0)]);
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true });
    let documentCalls = 0;
    x.h.host.nativeFetch = async (_url, init) => {
      const document = JSON.parse(init.body).input.some(text => text.includes('Assistant:'));
      if (document) documentCalls++;
      else { entered.resolve(); await release.promise; }
      return success(init);
    };
    assert(x.h.context.__queueCapture.schedulePendingEmbeddingWork(x.scope.scopeKey, { reason: 'test-existing-background-wake' }));
    request = x.h.api._test.beforeRequest([{ role: 'user', content: 'Where is the brass key?' }], 'model');
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(documentCalls, 0, 'scheduled embedding must not compete with the active request');
    release.resolve(); await request;
    await waitFor(async () => (await x.read())[0].embeddingReceipt?.status === 'ready', 'background work did not resume after request return');
    assert.equal(documentCalls, 1);
  } finally { release.resolve(); if (request) await request; await x.h.cleanup(); }
});

test('pausing automatic work during a provider call stops subsequent jobs in that pass', async () => {
  const x = await setup();
  try {
    await x.store([source(0), source(1)]);
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true });
    let calls = 0;
    x.h.host.nativeFetch = async (_url, init) => { calls++; await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: false }); return success(init); };
    x.h.context.__queueCapture.schedulePendingEmbeddingWork(x.scope.scopeKey);
    await waitFor(async () => (await x.read()).some(row => row.embeddingReceipt?.status === 'ready'), 'first in-flight job did not finish');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(calls, 1);
    assert.equal((await x.read()).find(row => row.sourceHash === source(1).sourceHash).embeddingWork.status, 'pending');
  } finally { await x.h.cleanup(); }
});

test('automatic continuation reaches a valid tail across several failed front passes', async () => {
  const x = await setup();
  try {
    await x.store(Array.from({ length: 10 }, (_, index) => source(index)));
    const tail = (await x.read()).at(-1), tailIndex = Number(tail.sourceHash.match(/-(\d+)$/)[1]);
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true, progressiveReembedMaxRecords: 3, progressiveReembedMaxRequests: 3 });
    const counts = new Map();
    x.h.host.nativeFetch = async (_url, init) => {
      const index = Number(JSON.parse(init.body).input[0].match(/item (\d+)/)[1]);
      counts.set(index, (counts.get(index) || 0) + 1);
      return index === tailIndex ? success(init) : { ok: true, status: 200, async json() { return { data: [{ index: 0, embedding: [0, 0, 0] }] }; } };
    };
    x.h.context.__queueCapture.schedulePendingEmbeddingWork(x.scope.scopeKey);
    await waitFor(async () => (await x.read()).find(row => row.sourceHash === tail.sourceHash).embeddingReceipt?.status === 'ready', 'automatic passes never reached the valid tail');
    assert.equal(counts.size, 10); assert([...counts.values()].every(value => value === 1));
    assert(x.h.audit.Runtime.lastEmbeddingQueue.physicalRequests <= 3);
  } finally { await x.h.cleanup(); }
});

test('an uncertain provider outcome stops automatic continuation without resubmitting the source', async () => {
  const x = await setup();
  try {
    await x.store([source(0), source(1)]);
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true });
    let calls = 0; x.h.host.nativeFetch = async () => { calls++; throw Error('synthetic network failure'); };
    x.h.context.__queueCapture.schedulePendingEmbeddingWork(x.scope.scopeKey);
    await waitFor(async () => (await x.read()).some(row => row.embeddingWork.status === 'uncertain'), 'provider uncertainty was not retained');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(calls, 1);
    const rows = await x.read();
    assert.equal(rows.find(row => row.sourceHash === source(1).sourceHash).embeddingWork.status, 'pending');
    assert.equal(x.h.audit.Runtime.lastEmbeddingQueue.ok, false);
  } finally { await x.h.cleanup(); }
});

for (const option of ['maxSources', 'maxRequests']) test(`zero ${option} reports disabled without scanning the source inventory`, async () => {
  const x = await setup();
  try {
    await x.store([source(0)]);
    let reads = 0, calls = 0;
    const get = x.h.pluginStorage.getItem.bind(x.h.pluginStorage);
    x.h.pluginStorage.getItem = async key => { if (String(key).endsWith(':manifest:v2') || String(key).includes(':shard:')) reads++; return get(key); };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await queue(x.h)({ [option]: 0 });
      assert.equal(result.ok, false); assert.equal(result.reason, 'budget_disabled');
    }
    assert.equal(calls, 0); assert.equal(reads, 0);
  } finally { await x.h.cleanup(); }
});

test('a failed reservation stops background continuation instead of rescanning an unchanged front', async () => {
  const x = await setup(); let original;
  try {
    await x.store(Array.from({ length: 9 }, (_, index) => source(index)));
    const before = clone(await x.read());
    await x.h.api.saveSettings({ ...x.cfg, embeddingAutoProcess: true, progressiveReembedMaxRecords: 2 });
    original = x.h.pluginStorage.setItem.bind(x.h.pluginStorage);
    let writes = 0, calls = 0;
    x.h.pluginStorage.setItem = async (key, value) => {
      if (String(key).includes(':shard:')) { writes++; return false; }
      return original(key, value);
    };
    x.h.host.nativeFetch = async (_url, init) => { calls++; return success(init); };
    x.h.context.__queueCapture.schedulePendingEmbeddingWork(x.scope.scopeKey);
    await waitFor(() => x.h.audit.Runtime.lastEmbeddingQueue, 'failed queue pass did not settle');
    const settledWrites = writes; assert(settledWrites > 0);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(writes, settledWrites, 'no-progress failure must not schedule repeated full scans/writes');
    assert.equal(calls, 0); assert.equal(x.h.audit.Runtime.lastEmbeddingQueue.ok, false);
    x.h.pluginStorage.setItem = original;
    assert.deepEqual(clone(await x.read()), before);
  } finally { if (original) x.h.pluginStorage.setItem = original; await x.h.cleanup(); }
});
