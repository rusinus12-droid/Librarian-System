'use strict';
// A committed server write is confirmed, not reported failed, when (1) its response is
// lost at the network level (the outage circuit is open) or (2) another writer commits
// between the write and its readback; (3) a bridge with a cached mode registry follows
// another bridge's mode switch. Both shared Storage SDK variants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const memoryStore = () => {
  const map = new Map();
  return { async getItem(key) { return map.has(key) ? map.get(key) : null; }, async setItem(key, value) { map.set(key, value); return true; },
    async removeItem(key) { map.delete(key); return true; }, async keys() { return [...map.keys()]; } };
};
const scopeA = { scopeId: 'scope-a', scopeKey: 'scope-a', label: 'Scope A', aliases: ['a'] };

async function run(file) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-suite-confirm-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const { port } = await app.listen();
  const args = { memory_suite_server_mode: '', memory_suite_server_url: `http://127.0.0.1:${port}` };
  const calls = [];
  let after = null;
  const previous = globalThis.risuai;
  globalThis.risuai = {
    async getArgument(name) { return args[name] || ''; },
    async setArgument(name, value) { args[name] = String(value); return true; },
    async nativeFetch(url, init) {
      const call = { method: init?.method || 'GET', path: new URL(url).pathname, body: init?.body };
      calls.push(call);
      const response = await fetch(url, init);
      return after ? await after(call, response) : response;
    }
  };
  try {
    const createBridge = new Function(`${fs.readFileSync(path.join(__dirname, '..', 'sdk', file), 'utf8')}\nreturn createMemorySuiteStorageBridge;`)();
    const bridge = () => createBridge({ namespace: 'libra', pluginId: 'libra', pluginVersion: '1.0.98', pluginPrefixes: ['scope:'],
      managementButton: false, migrationDelayMs: 100000, currentScopeProvider: async () => scopeA,
      resolveKeyScope: async ({ key }) => key.startsWith('scope:a:') ? { kind: 'scope', ...scopeA } : { kind: 'global' } });
    const shared = memoryStore();
    const a = bridge(), b = bridge();
    const pa = a.createPluginStorageProxy(shared), pb = b.createPluginStorageProxy(shared);
    await a.setMode('server_only');
    await pb.getItem('scope:a:warm');
    assert.equal(await b.getMode(), 'server_only');

    // (1) The server commits; the response is lost as a network failure.
    after = async (call, response) => {
      if (call.method !== 'POST' || call.path !== '/v1/kv/set') return response;
      after = null; await response.text(); throw new TypeError('fetch failed');
    };
    const start = calls.length;
    assert.equal(await pa.setItem('scope:a:lost', { v: 1 }), true, file + ': a committed write behind a lost response is confirmed');
    assert.ok(calls.slice(start).some(call => call.path.startsWith('/v1/operations/')), file + ': the operation lookup reaches the server');
    assert.equal((await a.serverGet('plugin', 'scope:a:lost')).revision, 1);

    // (2) B commits between A's write and A's readback.
    after = async (call, response) => {
      if (call.method !== 'POST' || call.path !== '/v1/kv/set' || JSON.parse(call.body).value?.who !== 'A') return response;
      after = null; const text = await response.text();
      await pb.setItem('scope:a:race', { who: 'B' });
      return new Response(text, { status: response.status, headers: response.headers });
    };
    assert.equal(await pa.setItem('scope:a:race', { who: 'A' }), true, file + ': a write superseded by another writer is still confirmed');
    const stored = await a.serverGet('plugin', 'scope:a:race');
    assert.deepEqual([stored.revision, stored.value], [2, { who: 'B' }], file + ': the later writer is kept, nothing is rewritten');

    // (3) A third bridge loaded its registry before the switch; it follows within the TTL.
    const c = bridge(), pc = c.createPluginStorageProxy(shared);
    await pc.getItem("scope:a:warm");
    await a.setMode("plugin_only");
    await a.setMode("server_only");
    await new Promise(resolve => setTimeout(resolve, 2100));
    await pc.setItem("scope:a:switched", { who: "C" });
    assert.deepEqual((await a.serverGet("plugin", "scope:a:switched")).value, { who: "C" }, file + ": a cached registry revalidates and routes to the server");
    c.dispose?.();
    a.dispose?.(); b.dispose?.();
  } finally {
    globalThis.risuai = previous;
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  for (const file of ['MemorySuiteStorageClient.source.js', 'MemorySuiteStorageClient.libra.source.js']) {
    await run(file);
    console.log('PASS ' + file + ': lost-response and superseded writes are confirmed');
  }
})().catch(error => { console.error(error); process.exit(1); });
