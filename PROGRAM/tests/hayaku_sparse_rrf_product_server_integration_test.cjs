'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const normalize = value => JSON.parse(JSON.stringify(value));

async function main() {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'memory-suite-hayaku-product-'));
  assert.equal(path.dirname(dataDir), tempRoot);
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeWorkers: 2 });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const routes = [];
  const packet = createValidPacket({ turn: 1, subject: 'Alice', scene: 'royal-academy' });
  const messages = [
    { role: 'user', data: '금지된 기록보관소를 조사한다.', chatId: 'u-1' },
    { role: 'assistant', data: hiddenPacketMessage('Alice found the sealed archive.', packet), chatId: 'a-1' }
  ];
  let runtime = null;
  try {
    runtime = await createHayakuRuntime({
      autoRepair: false,
      messages,
      arguments: {
        memory_suite_server_mode: 'mirror',
        memory_suite_server_url: baseUrl
      },
      nativeFetch: async (url, init = {}) => {
        const pathname = new URL(String(url)).pathname;
        routes.push(pathname);
        return await fetch(url, init);
      }
    });
    const rows = [
      { axis: 'entity', category: 'character', publicRef: 'entity.character.alice', publicText: 'Alice remembers the archive.', score: 0.42, importance: 0.8, scoreBreakdown: { bm25fSignal: 0.84, identitySignal: 0.75, canonicalExactSignal: 0.31, associationSignal: 0.2, charNgramSignal: 0.5, lexicalCoverageSignal: 0.65, sparsePhraseSignal: 0.4 } },
      { axis: 'world', category: 'world_rule', publicRef: 'world.rule.magic', publicText: 'Magic is forbidden at the academy.', score: 0.5, importance: 0.9, scoreBreakdown: { bm25fSignal: 0.92, identitySignal: 0.12, canonicalExactSignal: 0.86, associationSignal: 0.3, charNgramSignal: 0.28, lexicalCoverageSignal: 0.71, sparsePhraseSignal: 0.69 } }
    ];
    const query = 'Alice와 아카데미의 금지된 마법 기록';
    // The Compute SDK is retired from HAYAKU: even with a server-backed (mirror) policy,
    // sparse RRF runs locally and no Compute route is called.
    const expected = normalize(runtime.hayaku._test.applyRrfFusion(rows));
    const cold = normalize(await runtime.hayaku._test.debugApplyRrfFusionWithCurrentOwner(rows, query));
    assert.deepEqual(cold, expected, 'the product entry point returns the local RRF rows');
    assert.equal(runtime.hayaku.compute.status().status, 'retired');
    runtime.setMessages([
      messages[0],
      { role: 'assistant', data: hiddenPacketMessage('The edited branch no longer contains the sealed archive.', packet), chatId: 'a-1' }
    ]);
    const changed = normalize(await runtime.hayaku._test.debugApplyRrfFusionWithCurrentOwner(rows, query));
    assert.deepEqual(changed, cold, 'visible transcript edit preserves deterministic RRF values');
    assert.equal(routes.filter(route => route.startsWith('/v1/compute/')).length, 0, 'no Compute route is called');
    assert.equal(routes.includes('/bootstrap'), true, 'mirror mode still verifies the shared Storage connection');
    process.stdout.write('hayaku_sparse_rrf_product_server_integration_test: PASS\n');
  } finally {
    try { await runtime?.dispose?.(); } catch (_) {}
    await app.close();
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), tempRoot);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`hayaku_sparse_rrf_product_server_integration_test: FAIL\n${error.stack || error}\n`);
  process.exitCode = 1;
});
