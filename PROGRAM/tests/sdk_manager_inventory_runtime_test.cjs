'use strict';

// Exercise the complete SDK against the real server handler through the campaign's
// explicit in-process transport. No product method or inventory result is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMemorySuiteServer } = require('../server/server.cjs');

const sdkRoot = process.env.SDK_MANAGER_SOURCE_ROOT || path.join(__dirname, '../sdk');
const sdkFiles = ['MemorySuiteStorageClient.source.js', 'MemorySuiteStorageClient.libra.source.js'];
for (const name of sdkFiles) {
  test(name + ' manager inventory preserves the existing three-argument API', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-manager-inventory-'));
    const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: root, autoBackup: false, computeEnabled: false });
    const previous = globalThis.risuai;
    let manager;
    try {
      const address = await app.listen();
      const url = `http://127.0.0.1:${address.port}`;
      globalThis.risuai = { getArgument: async key => key === 'memory_suite_server_url' ? url : 'plugin_only', nativeFetch: fetch };
      const source = fs.readFileSync(path.join(sdkRoot, name), 'utf8');
      const factory = new Function(source + '\nreturn createMemorySuiteStorageBridge;')();
      manager = factory({ namespace: 'retrace', pluginId: 'flashback_hayaku_bridge', storagePolicy: 'manager_only', managementButton: false, keyPageSize: 50, getManyResponseBudgetBytes: 256 * 1024 });
      const repository = app.repositories.flashback;
      const values = [
        ['manager:ordinary', { value: 'ordinary' }],
        ['manager:large', { body: 'x'.repeat(300 * 1024) }],
        ['manager:deleted', { value: 'deleted' }],
        ['__proto__', { opaque: true }]
      ];
      const pageKeys = Array.from({ length: 101 }, (_, i) => 'manager:page:' + String(i).padStart(3, '0'));
      values.push(...pageKeys.map(key => [key, { page: key }]));
      values.forEach(([key, value], i) => repository.mutate({ kind: 'set', space: 'plugin', key, value, expectedRevision: 0, operationId: 'manager-seed-' + i }));
      repository.mutate({ kind: 'remove', space: 'plugin', key: 'manager:deleted', expectedRevision: 1, operationId: 'manager-remove-1' });
      await manager.managerConnection();
      await t.test('ordinary and opaque keys keep their values and accumulator prototype', async () => {
        const result = await manager.managerServerGetMany('flashback', 'plugin', ['manager:ordinary', '__proto__']);
        assert.equal(Object.getPrototypeOf(result.values), Object.prototype);
        assert.equal(Object.hasOwn(result.values, '__proto__'), true);
        assert.deepEqual(result.values.__proto__.value, { opaque: true });
        assert.deepEqual(result.values['manager:ordinary'].value, { value: 'ordinary' });
      });
      await t.test('oversized records retain the individual-read fallback', async () => {
        const result = await manager.managerServerGetMany('flashback', 'plugin', ['manager:large']);
        assert.deepEqual(result.oversizedKeys, ['manager:large']);
        assert.equal(result.values['manager:large'].value.body.length, 300 * 1024);
      });
      await t.test('missing keys retain absence without requiring writer inventory options', async () => {
        const result = await manager.managerServerGetMany('flashback', 'plugin', ['manager:missing']);
        assert.equal(result.values['manager:missing'].exists, false);
      });
      await t.test('paged keys preserve active records, tombstones, and completion', async () => {
        const result = await manager.managerServerKeys('flashback', 'plugin', 'manager:');
        assert.deepEqual([...result.keys].sort(), ['manager:large', 'manager:ordinary', ...pageKeys]);
        assert.deepEqual(result.tombstones, ['manager:deleted']);
        assert.equal(result.records.length, 104);
        assert.ok(result.page.pages >= 3);
        assert.equal(result.page.complete, true);
      });
    } finally {
      await manager?.dispose();
      globalThis.risuai = previous;
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
