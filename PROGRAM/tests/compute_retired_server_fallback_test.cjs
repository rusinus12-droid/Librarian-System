'use strict';
// Plugins released before the Compute retirement embed Compute SDK 0.3.8 in prefer_server mode.
// Against the retired server they must get every answer from their local executor, and the
// 410 COMPUTE_RETIRED answer must open their circuit instead of causing a retry storm.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createMemorySuiteServer } = require('../server/server.cjs');

const program = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8');
const context = { console: { warn() {}, log() {}, error() {} }, URL, AbortController, TextEncoder, Uint8Array, Uint32Array,
  setTimeout, clearTimeout, Promise, Map, Set, WeakMap, Object, Array, JSON, Date, Math, String, Number, Boolean };
context.globalThis = context;
vm.runInNewContext(`${source}\n;globalThis.__factory = createMemorySuiteComputeBridge;`, context, { timeout: 5000 });

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-retired-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
  const { port } = await app.listen();
  const routes = [];
  const bridges = [];
  try {
    for (const [namespace, pluginId, operation] of [['hayaku', 'hayaku_locator_continuity', 'hayaku.sparse-rrf-fusion.v1'],
      ['lia', 'lia_persona_linker', 'lia.world-lore-rerank.v2'], ['flashback', 'flashback_memory', 'flashback.memory-search.v1']]) {
      let localCalls = 0;
      const bridge = context.__factory({
        namespace, pluginId, pluginVersion: 'released-before-retirement',
        urlProvider: async () => `http://127.0.0.1:${port}`,
        modeProvider: async () => 'prefer_server', modeSetter: async () => true,
        fetch: async (url, init) => { routes.push(new URL(url).pathname); return await fetch(url, init); },
        operations: { [operation]: { algorithmFingerprint: 'released-fingerprint', local: async input => { localCalls += 1; return { doubled: input.value * 2 }; } } }
      });
      bridges.push(bridge);
      for (let value = 0; value < 25; value += 1) {
        const envelope = await bridge.execute({ operation, input: { value }, binding: {} });
        assert.equal(envelope.source, 'local');
        assert.equal(envelope.result.doubled, value * 2);
      }
      assert.equal(localCalls, 25, `${namespace}: every call answered locally`);
      assert.equal(bridge.status().state === 'disposed', false);
    }
    const computeRequests = routes.filter(route => route.startsWith('/v1/compute/'));
    assert.ok(computeRequests.length >= 1, 'the retired route is reached');
    // Each bridge opens its circuit after its default two failures: at most 2 bootstraps per plugin.
    assert.ok(computeRequests.length <= 6, `the circuit opens on 410: ${computeRequests.length} requests for 75 executes`);
    assert.ok(computeRequests.every(route => route === '/v1/compute/bootstrap'), 'no execute is attempted');
    console.log(JSON.stringify({ test: 'compute_retired_server_fallback', executes: 75, computeRequests: computeRequests.length, allLocal: true }));
  } finally {
    for (const bridge of bridges) await bridge.dispose();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
