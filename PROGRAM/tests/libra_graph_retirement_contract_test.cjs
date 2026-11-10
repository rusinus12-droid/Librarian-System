'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

test('retired graph APIs, server capabilities and lifecycle endpoint are absent', async t => {
  const x = await serverFixture({ mode: 'server_only' }); t.after(() => x.cleanup());
  for (const name of ['buildMemoryGraphCorpus','buildMemoryGraphGeneration','getMemoryGraphProjectionPage',
    'inspectMemoryGraphStructure','getMemoryGraphDurablePage','collectMemoryGraphGarbage','inspectMemoryNetwork']) {
    assert.equal(x.f.r.api[name], undefined, name);
    assert.equal(x.f.r.core[name], undefined, 'core ' + name);
  }
  const boot = await x.send('GET', '/bootstrap');
  const capabilities = Array.isArray(boot.capabilities) ? boot.capabilities : Object.keys(boot.capabilities || {});
  assert.equal(capabilities.some(name => name.startsWith('libra-graph-')), false);
  assert.equal((await x.send('POST', '/v1/libra/graph-lifecycle', { action: 'inventory', scopeKey: 'test' })).status, 404);
  assert.equal(typeof x.f.r.api.executeStateMemoryQuery, 'function');
  const plugin = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  for (const marker of ['buildAssociativeRecallPanel','buildDurableGraphPanel','acquireGraphStorageLease',
    'LIBRA MEMORY GRAPH','LIBRA_MEMORY_GRAPH','durableGraphBuildFailure']) assert.equal(plugin.includes(marker), false, marker);
});
