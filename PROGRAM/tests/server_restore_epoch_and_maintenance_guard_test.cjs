'use strict';
// A0 defence regression — restore epoch fencing (P01) + maintenance-window
// mutation guard (P02).
//
// These assert the FIX, not the defect. The reproduction probes in the design
// package assert the defect signature and must fail once the defect is gone;
// this file must pass after the fix and fail if either regression returns.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMemorySuiteServer } = require('../server/server.cjs');

async function jf(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

// ---------- P01: /v1/admin/restore must fence old clients ----------
async function testRestoreEpochFence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-epoch-'));
  const app = createMemorySuiteServer({ port: 0, dataDir, autoBackup: false, computeEnabled: false });
  try {
    const addr = await app.listen();
    const base = `http://127.0.0.1:${addr.port}`;
    const boot = async () => (await jf(`${base}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'libra' } })).body;

    const before = await boot();
    app.repositories.libra.mutate({ kind: 'set', space: 'plugin', key: 'libra.probe', value: 'snapshot', operationId: 'a0-epoch-src', expectedRevision: 0 });
    const backup = await app.createBackup('manual', 'a0-epoch');
    app.repositories.libra.mutate({ kind: 'set', space: 'plugin', key: 'libra.probe', value: 'later', operationId: 'a0-epoch-later', expectedRevision: 1 });

    const restore = await jf(`${base}/v1/admin/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}`, 'X-Memory-Suite-Admin': '1' },
      body: JSON.stringify({ backupId: backup.result.id, namespaces: ['libra'] })
    });
    assert.equal(restore.status, 200, 'restore should succeed');

    const after = await boot();
    assert.notDeepEqual(after.resetEpochs, before.resetEpochs, 'restore must advance reset epochs');
    assert.equal(after.resetEpochs.libra, (before.resetEpochs.libra || 0) + 1, 'libra epoch must advance by exactly one');

    // an old client presenting the pre-restore epoch header must be fenced out
    const stale = await jf(
      `${base}/v1/kv/get?namespace=libra&space=plugin&key=libra.probe`,
      { headers: { Authorization: `Bearer ${before.token}`, 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Reset-Epochs': JSON.stringify(before.resetEpochs) } }
    );
    assert.equal(stale.status, 409, 'old client must be told to reconnect');
    assert.equal(stale.body.error, 'MEMORY_SUITE_RESET_RECONNECT_REQUIRED', 'wrong fence error');

    // a fresh client on the new epoch still works
    const fresh = await jf(
      `${base}/v1/kv/get?namespace=libra&space=plugin&key=libra.probe`,
      { headers: { Authorization: `Bearer ${after.token}`, 'X-Memory-Suite-Plugin': 'libra', 'X-Memory-Suite-Reset-Epochs': JSON.stringify(after.resetEpochs) } }
    );
    assert.equal(fresh.status, 200, 'current client must still read');
    assert.equal(fresh.body.result.value, 'snapshot', 'restored value must be the backed-up one');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---------- P02: a write whose body completes during a backup must not commit ----------
async function testLateBodyDuringBackup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-late-'));
  const app = createMemorySuiteServer({ port: 0, dataDir, autoBackup: false, computeEnabled: false });
  let req;
  try {
    const addr = await app.listen();
    const base = `http://127.0.0.1:${addr.port}`;
    const boot = (await jf(`${base}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'libra' } })).body;

    const payload = JSON.stringify({ namespace: 'libra', space: 'plugin', key: 'libra.late', value: 'arrived-during-backup', operationId: 'a0-late-write', expectedRevision: 0 });

    let entered;
    const reachedHandler = new Promise(resolve => { entered = resolve; });
    app.server.on('request', r => { if (r.url === '/v1/kv/set') entered(); });

    const reply = new Promise((resolve, reject) => {
      req = http.request(`${base}/v1/kv/set`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${boot.token}`,
          'X-Memory-Suite-Plugin': 'libra',
          'X-Memory-Suite-Reset-Epochs': JSON.stringify(boot.resetEpochs)
        }
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(payload.slice(0, 1)); // header + first body byte only
    });

    await reachedHandler;
    const backupPromise = app.createBackup('manual', 'a0-late');
    const health = await jf(`${base}/health`);
    assert.equal(health.body.maintenanceMode, true, 'backup should be in maintenance while body is incomplete');

    req.end(payload.slice(1)); // rest of the body arrives mid-backup
    const mutation = await reply;
    await backupPromise;

    assert.equal(mutation.status, 503, 'a write completing during backup must be refused');
    assert.equal(mutation.body.ok, false, 'refused write must not report ok');
    const stored = app.repositories.libra.get('plugin', 'libra.late');
    assert.equal(stored.exists, false, 'refused write must not be committed into the snapshot window');
  } finally {
    req?.destroy();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// ---------- P02 negative: the manager's own maintenance batch is still allowed ----------
async function testManagerMaintenanceBatchAllowed() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-mgr-'));
  const app = createMemorySuiteServer({ port: 0, dataDir, autoBackup: false, computeEnabled: false });
  try {
    await app.listen();
    // Drive a maintenance-flagged conditional batch directly; it must NOT be gated
    // even while maintenance is active, because options.maintenance === true.
    const repo = app.repositories.hayaku;
    const result = repo.applyConditionalBatch(
      [{ kind: 'set', space: 'plugin', key: 'hayaku.mgr', value: 'maintenance-write', expectedRevision: 0 }],
      { maintenance: true, operationId: 'a0-mgr-batch' }
    );
    assert.ok(result, 'manager maintenance batch should return a receipt');
    const stored = repo.get('plugin', 'hayaku.mgr');
    assert.equal(stored.exists, true, 'manager maintenance write must commit');
    assert.equal(stored.value, 'maintenance-write', 'manager maintenance value must persist');
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  await testRestoreEpochFence();
  await testLateBodyDuringBackup();
  await testManagerMaintenanceBatchAllowed();
  console.log(JSON.stringify({ test: 'server_restore_epoch_and_maintenance_guard', cases: 3, result: 'pass' }));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
