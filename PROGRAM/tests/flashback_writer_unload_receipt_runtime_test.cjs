'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { test } = require('node:test');
const { createMemorySuiteServer, mockFetch } = require('./fixtures/flashback_in_memory_server_fixture.cjs');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');
const sourcePath = process.env.FLASHBACK_LIFECYCLE_SOURCE || path.resolve(__dirname, '../plugins/Flashback_Memory.js');
const source = fs.readFileSync(sourcePath, 'utf8')
  .replace('  globalThis.__FlashbackMemory = publicApi;', '  globalThis.__lifecycleFixture = { Runtime, scopeKeys, withScopeWriteLock, scheduleExternalRetirement, clearScheduledTimers };\n  globalThis.__FlashbackMemory = publicApi;')
  .replace('  const flashbackWriters = new Map();', '  const flashbackWriters = new Map(); globalThis.__writerFixture = { sessions: [], lifecycle };')
  .replace('      flashbackWriters.set(alias, session);', '      flashbackWriters.set(alias, session); globalThis.__writerFixture.sessions.push(session);');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-writer-unload-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dir, autoBackup: false });
  const address = await app.listen(), url = 'http://127.0.0.1:' + address.port, fixtures = [], events = [];
  let intercept, beforeRequest;
  async function create() {
    let f;
    const id = fixtures.length + 1;
    f = await createFixture({ source, exposeStorageBridge: true, arguments: { memory_suite_server_url: url, memory_suite_server_mode: 'mirror' },
      nativeFetch: async (u, init) => {
        if (String(u).startsWith('https://fixture.invalid/')) return { ok: true, status: 200, async json() { return {
          data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }; } };
        if (!String(u).endsWith('/writer')) return await mockFetch(u, init);
        const body = JSON.parse(init.body), event = { instance: id, url: String(u), ...body, unloaded: f?.context.__lifecycleFixture.Runtime.unloaded === true };
        events.push(event);
        if (beforeRequest) await beforeRequest(event, init);
        const response = await mockFetch(u, init); event.status = response.status;
        if (intercept) return await intercept(event, response, init) || response;
        return response;
      } });
    fixtures.push(f);
    const t = f.context.__lifecycleFixture;
    t.Runtime.nativeCopyObserver.running = false; t.clearScheduledTimers();
    await f.api.saveSettings({ ...await f.api.loadSettings(), embeddingProvider: 'openai_compat', embeddingModel: 'offline-writer-model',
      embeddingUrl: 'https://fixture.invalid/v1', embeddingDimensions: 3, embeddingEnabled: true, embeddingAutoProcess: false,
      embeddingMaxRetries: 0, episodeIndexEnabled: false });
    f.bridge = f.context.__fixtureStorageBridge;
    f.scope = await f.api.resolveCurrentScope(false);
    f.key = t.scopeKeys.manifest(f.scope.scopeKey);
    return f;
  }
  const rows = () => app.repositories.flashback.database.prepare('SELECT alias,epoch,owner,expires_at FROM flashback_writer_fences').all();
  return { app, url, create, events, rows, intercept: fn => { intercept = fn; }, beforeRequest: fn => { beforeRequest = fn; },
    close: async () => { for (const f of fixtures) await f.dispose(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('queued retirement never acquires or mutates after its runtime unloads', async () => {
  const x = await setup(), gate = deferred(), entered = deferred();
  try {
    const f = await x.create(), t = f.context.__lifecycleFixture;
    await f.api._test.saveAllRecords([{ id: 'retire-one', hash: 'retire-one', type: 'response', sourceType: 'response',
      text: 'The needle holds at the red mark.', vector: [1, 0, 0], dim: 3 }], await f.api.loadSettings(), f.scope);
    const holder = t.withScopeWriteLock(f.scope.scopeKey, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const retirement = f.api._test.retireExternalRecordsForScope(f.scope).then(value => ({ value }), error => ({ error }));
    await Promise.resolve();
    t.Runtime.unloaded = true;
    const before = plain([...f.pluginStorage.values]);
    const count = x.events.filter(e => e.action === 'acquire').length;
    gate.resolve(); await holder; await retirement;
    assert.equal(x.events.filter(e => e.action === 'acquire').length, count, 'FIFO retirement must not allocate another lease after unload');
    assert.deepEqual(plain([...f.pluginStorage.values]), before);
    assert(!x.rows().some(r => r.owner && r.expires_at > Date.now()));
  } finally { gate.resolve(); await x.close(); }
});

for (const boundary of ['disposed', 'url-changed']) {
  test('valid acquire receipt arriving after ' + boundary + ' is released on its pinned server', async () => {
    const x = await setup(), held = deferred(), release = deferred(); let calls = 0, blocked;
    try {
      const f = await x.create();
      x.intercept(async (event, response, init) => {
        if (!blocked && event.instance === 1 && event.action === 'acquire' && response.status === 200) {
          blocked = { event, receipt: (await response.clone().json()).result, init };
          held.resolve(); await release.promise;
        }
      });
      const operation = f.bridge.withFlashbackWriter(f.key, async () => { calls++; }, { forceServer: true }).then(() => null, error => error);
      await held.promise;
      const fresh = await x.create();
      await assert.rejects(fresh.bridge.withFlashbackWriter(fresh.key, async () => {}, { forceServer: true }), /FLASHBACK_WRITER_BUSY/);
      if (boundary === 'disposed') await f.bridge.dispose();
      else await f.host.setArgument('memory_suite_server_url', 'http://127.0.0.1:65533');
      release.resolve(); const failure = await operation; await f.bridge.whenFlashbackWritersIdle();
      if (process.env.FLASHBACK_WRITER_DEBUG) console.log({ boundary, failure: failure?.stack, sessions: f.context.__writerFixture.sessions.map(s => ({fence:s.fence,release:typeof s.release})), events:x.events, status:f.bridge.status() });
      assert(failure, 'stale acquisition must not run the writer callback'); assert.equal(calls, 0);
      assert.equal(x.events.filter(e => e.instance === 1 && e.action === 'acquire').length, 1, 'never retry an acquire whose issued receipt is known');
      assert(!x.rows().some(row => row.owner === blocked.receipt.owner && row.expires_at > Date.now()), 'late issued lease must be relinquished');
      const releases = x.events.filter(e => e.instance === 1 && e.action === 'release');
      assert.equal(releases.length, 1); assert.equal(releases[0].epoch, blocked.receipt.epoch); assert.equal(releases[0].url, x.url + '/v1/flashback/writer');
      await fresh.bridge.withFlashbackWriter(fresh.key, async () => { calls++; }, { forceServer: true });
      assert.equal(calls, 1, 'fresh runtime can write immediately without waiting for TTL');
    } finally { release.resolve(); await x.close(); }
  });
}

test('failed late-release cleanup stays unconfirmed and never runs the disposed writer', async () => {
  const x = await setup(), held = deferred(), release = deferred(); let blocked, calls = 0;
  try {
    const f = await x.create();
    x.intercept(async (event, response) => {
      if (!blocked && event.instance === 1 && event.action === 'acquire' && response.status === 200) {
        blocked = (await response.clone().json()).result; held.resolve(); await release.promise;
      }
      // The real in-memory release happened, but its acknowledgement was lost.
      if (event.instance === 1 && event.action === 'release') throw new Error('fixture release acknowledgement lost');
    });
    const operation = f.bridge.withFlashbackWriter(f.key, async () => { calls++; }, { forceServer: true }).then(() => null, error => error);
    await held.promise; await f.bridge.dispose(); release.resolve();
    assert(await operation); await f.bridge.whenFlashbackWritersIdle(); assert.equal(calls, 0);
    assert.equal(f.bridge.status().state, 'writer_release_unconfirmed');
    assert.equal(x.events.filter(e => e.instance === 1 && e.action === 'release').length, 1);
    assert(!x.rows().some(r => r.owner === blocked.owner));
    const fresh = await x.create(); await fresh.bridge.withFlashbackWriter(fresh.key, async () => { calls++; }, { forceServer: true });
    assert.equal(calls, 1);
  } finally { release.resolve(); await x.close(); }
});

test('stale cleanup cannot release a concurrently acquired fresh runtime fence', async () => {
  const x = await setup(), held = deferred(), release = deferred(), freshHeld = deferred(), freshRelease = deferred(); let blocked;
  try {
    const f = await x.create();
    x.intercept(async (event, response, init) => {
      if (!blocked && event.instance === 1 && event.action === 'acquire' && response.status === 200) {
        blocked = { event, receipt: (await response.clone().json()).result, init }; held.resolve(); await release.promise;
      }
    });
    const old = f.bridge.withFlashbackWriter(f.key, async () => assert.fail('disposed callback ran'), { forceServer: true }).then(() => null, error => error);
    await held.promise; await f.bridge.dispose();
    await mockFetch(blocked.event.url, { ...blocked.init, signal: undefined, body: JSON.stringify({ action: 'release', key: f.key, ...blocked.receipt }) });
    const fresh = await x.create();
    const current = fresh.bridge.withFlashbackWriter(fresh.key, async () => { freshHeld.resolve(); await freshRelease.promise; }, { forceServer: true });
    await freshHeld.promise;
    const freshFence = plain(x.rows().find(r => r.owner && r.owner !== blocked.receipt.owner)); assert(freshFence);
    release.resolve(); assert(await old); await f.bridge.whenFlashbackWritersIdle();
    assert.deepEqual(plain(x.rows().find(r => r.alias === freshFence.alias)), freshFence, 'exact epoch/owner guard preserves new owner');
    assert.equal(x.events.find(e => e.instance === 1 && e.action === 'release')?.status, 409);
    assert.equal(f.bridge.status().state, 'writer_release_unconfirmed');
    freshRelease.resolve(); await current;
  } finally { release.resolve(); freshRelease.resolve(); await x.close(); }
});

test('dispose after successful acquisition rejects an unfinished writer result and releases its lease', async () => {
  const x = await setup(), entered = deferred(), finish = deferred();
  try {
    const f = await x.create();
    const operation = f.bridge.withFlashbackWriter(f.key, async () => { entered.resolve(); await finish.promise; return 'not-current'; },
      { forceServer: true }).then(value => ({value}), error => ({error}));
    await entered.promise; await f.bridge.dispose(); finish.resolve();
    const result = await operation; await f.bridge.whenFlashbackWritersIdle();
    assert(result.error, 'disposed writer must not report current success');
    assert.equal(result.error.storageMutationIndeterminate, true);
    assert(!x.rows().some(row => row.owner && row.expires_at > Date.now()));
  } finally { finish.resolve(); await x.close(); }
});

test('unavailable cleanup transport is reported and cannot free or replace a lease without acknowledgement', async () => {
  const x = await setup(), held = deferred(), release = deferred(); let blocked;
  try {
    const f = await x.create();
    x.intercept(async (event, response) => {
      if (!blocked && event.instance === 1 && event.action === 'acquire' && response.status === 200) {
        blocked = (await response.clone().json()).result; held.resolve(); await release.promise;
      }
    });
    x.beforeRequest(async event => { if (event.instance === 1 && event.action === 'release') throw new Error('fixture cleanup unavailable'); });
    const operation = f.bridge.withFlashbackWriter(f.key, async () => assert.fail('disposed writer executed'), { forceServer: true }).then(() => null, error => error);
    await held.promise; await f.bridge.dispose(); release.resolve();
    assert(await operation); await f.bridge.whenFlashbackWritersIdle();
    assert.equal(f.bridge.status().state, 'writer_release_unconfirmed');
    assert(x.rows().some(row => row.owner === blocked.owner && row.epoch === blocked.epoch));
    const fresh = await x.create();
    await assert.rejects(fresh.bridge.withFlashbackWriter(fresh.key, async () => assert.fail('busy fence was bypassed'), { forceServer: true }), /FLASHBACK_WRITER_BUSY/);
  } finally { release.resolve(); await x.close(); }
});
