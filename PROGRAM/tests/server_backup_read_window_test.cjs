'use strict';
// A backup holds maintenance only to fence writes while a worker snapshots the
// databases. Owners must keep reading during that window; before this fix every
// read got 503 server_maintenance_in_progress and Flashback/HAYAKU lists failed.
// Real server on a temporary DATA dir; the backup worker is paused by a hook.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { test } = require('node:test');
const f = require('./fixtures/server_repair_fixture.cjs');
const Module = require('node:module');
// Same loader as the fixture, but the backup worker's events are held while a gate is set,
// so requests provably land inside the backup's maintenance window.
const loadServer = () => {
  const file = path.join(f.PROGRAM, 'server/server.cjs'), m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  const original = m.require.bind(m);
  m.require = id => {
    if (id !== 'node:worker_threads') return original(id);
    const w = require(id);
    return { ...w, Worker: class extends w.Worker {
      emit(event, ...args) {
        const gate = globalThis.__backupWorkerGate;
        if (!gate || !['message', 'error', 'exit'].includes(event)) return super.emit(event, ...args);
        gate.entered();
        // Node removes Worker listeners right after exit, so deliver to the listeners present now.
        const listeners = this.listeners(event);
        gate.queue = (gate.queue || Promise.resolve()).then(() => gate.released).then(() => { for (const listener of listeners) listener.apply(this, args); });
        return true;
      }
    } };
  };
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
};

const call = (port, token, method, route, body) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : '';
  const request = http.request({ host: '127.0.0.1', port, method, path: route, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    'x-memory-suite-plugin': 'flashback_memory', 'x-memory-suite-namespace': 'flashback'
  } }, response => {
    let data = ''; response.on('data', chunk => { data += chunk; });
    response.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) {} resolve({ status: response.statusCode, json }); });
  });
  request.on('error', reject); request.end(payload);
});

test('reads stay served while an automatic backup holds maintenance; writes stay fenced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-read-window-'));
  const app = loadServer().createMemorySuiteServer({ dataDir: dir, autoBackup: false, computeEnabled: false, token: 'synthetic-offline-token-0000000000000000' });
  const x = { app };
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  let entered;
  const inBackup = new Promise(resolve => { entered = resolve; });
  try {
    await new Promise(resolve => x.app.server.listen(0, '127.0.0.1', resolve));
    const port = x.app.server.address().port;
    const boot = await call(port, '', 'GET', '/bootstrap');
    assert.equal(boot.status, 200, JSON.stringify(boot.json));
    const token = boot.json.token || boot.json.result?.token;
    const ns = 'namespace=flashback&space=plugin';
    const seeded = await call(port, token, 'POST', '/v1/kv/set', { namespace: 'flashback', space: 'plugin', key: 'probe:key', value: { value: 1 }, operationId: 'read-window-seed-0001' });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
    assert.equal((await call(port, token, 'GET', `/v1/kv/get?${ns}&key=probe%3Akey`)).status, 200, 'baseline read');
    // Hold the real backup worker's result so the requests land inside the maintenance window.
    globalThis.__backupWorkerGate = { entered, released: paused };
    const backup = x.app.createBackup('auto', 'read-window');
    await Promise.race([inBackup, backup.then(v => { throw new Error('backup finished before the gate held it: ' + JSON.stringify(v).slice(0, 200)); })]);
    const read = await call(port, token, 'GET', `/v1/kv/get?${ns}&key=probe%3Akey`);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.deepEqual(read.json.result.value, { value: 1 }, 'the stored value is returned during the backup');
    assert.equal((await call(port, token, 'GET', `/v1/kv/keys?${ns}&prefix=probe`)).status, 200, 'key listing is a read');
    assert.equal((await call(port, token, 'POST', '/v1/kv/get-many', { namespace: 'flashback', space: 'plugin', keys: ['probe:key'] })).status, 200, 'batch read is a read');
    const write = await call(port, token, 'POST', '/v1/kv/set', { namespace: 'flashback', space: 'plugin', key: 'probe:key', value: { value: 2 }, operationId: 'read-window-during-0001' });
    assert.equal(write.status, 503, 'writes remain fenced while the snapshot is taken');
    assert.equal(write.json?.error, 'server_maintenance_in_progress');
    release();
    assert.equal((await backup).ok, true);
    globalThis.__backupWorkerGate = null;
    assert.equal((await call(port, token, 'POST', '/v1/kv/set', { namespace: 'flashback', space: 'plugin', key: 'probe:key', value: { value: 2 }, operationId: 'read-window-after-0001' })).status, 200, 'writes resume after the backup');
  } finally {
    release?.(); globalThis.__backupWorkerGate = null;
    x.app.server.closeAllConnections?.();
    await new Promise(resolve => x.app.server.close(() => resolve()));
    x.app.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
