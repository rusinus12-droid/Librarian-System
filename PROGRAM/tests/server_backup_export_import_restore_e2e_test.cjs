'use strict';
// End-to-end portable backup: write DATA on server A, create a backup, export it
// to a single ZIP, carry that ZIP to a FRESH empty server B, import it (which
// yields a normal backupId), then restore via the standard engine. Server B must
// end up holding server A's data. This is the "back up here, restore on a blank
// server" flow — server-local, no browser file round-trip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemorySuiteServer, NAMESPACES } = require('../server/server.cjs');

const jsonFetch = async (url, init = {}) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload; try { payload = text ? JSON.parse(text) : {}; } catch (_) { throw new Error(`bad json ${response.status}: ${text.slice(0, 200)}`); }
  return { response, payload };
};
const sha256File = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const bootstrapPlugin = async baseUrl => {
  const b = await jsonFetch(`${baseUrl}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23' } });
  assert.equal(b.response.status, 200, 'plugin bootstrap ok');
  return b.payload.token;
};

async function main() {
  const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-export-A-'));
  const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-export-B-'));
  const carry = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-carry-'));
  const appA = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dataA, autoBackup: false });
  const addrA = await appA.listen();
  const urlA = `http://127.0.0.1:${addrA.port}`;
  const adminA = { Authorization: `Bearer ${appA.token}`, 'Content-Type': 'application/json', 'X-Memory-Suite-Admin': '1' };

  let appB, addrB, urlB;
  try {
    // 1) write one value per namespace on server A
    const tokenA = await bootstrapPlugin(urlA);
    const pluginA = { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json', 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23' };
    const setRes = await jsonFetch(`${urlA}/v1/kv/set`, { method: 'POST', headers: pluginA, body: JSON.stringify({ namespace: 'flashback', operationId: 'e2e_flashback_set_1', space: 'plugin', key: 'e2e-key', value: { marker: 'server-A-payload', n: 7 }, expectedRevision: 0 }) });
    assert.equal(setRes.response.status, 200, 'kv set ok on A: ' + JSON.stringify(setRes.payload).slice(0, 200));

    // 2) create a backup on A
    const created = await jsonFetch(`${urlA}/v1/admin/backups/create`, { method: 'POST', headers: adminA, body: JSON.stringify({ kind: 'manual', label: 'e2e' }) });
    assert.equal(created.response.status, 200, 'backup create ok');
    const backupId = created.payload.result.id;
    assert.ok(backupId, 'backup id returned');

    // 3) export the backup to a single ZIP
    const exported = await jsonFetch(`${urlA}/v1/admin/backups/export`, { method: 'POST', headers: adminA, body: JSON.stringify({ backupId }) });
    assert.equal(exported.response.status, 200, 'export ok');
    const archivePath = exported.payload.result.archivePath;
    assert.ok(fs.existsSync(archivePath), 'archive exists on disk');
    assert.equal(exported.payload.result.sha256.length, 64, 'archive sha256 reported');

    // 4) carry the ZIP to a location server B can read (simulate moving the file)
    const carriedZip = path.join(carry, 'backup.zip');
    fs.copyFileSync(archivePath, carriedZip);

    // 5) fresh empty server B on a separate dataDir
    appB = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dataB, autoBackup: false });
    addrB = await appB.listen();
    urlB = `http://127.0.0.1:${addrB.port}`;
    const adminB = { Authorization: `Bearer ${appB.token}`, 'Content-Type': 'application/json', 'X-Memory-Suite-Admin': '1' };

    // B starts empty: it has no backups
    const listBefore = await jsonFetch(`${urlB}/v1/admin/backups`, { method: 'GET', headers: adminB });
    assert.equal(listBefore.payload.result.length, 0, 'server B starts with no backups');

    // 6) import the carried ZIP on B -> yields a fresh backupId
    const imported = await jsonFetch(`${urlB}/v1/admin/backups/import`, { method: 'POST', headers: adminB, body: JSON.stringify({ archivePath: carriedZip }) });
    assert.equal(imported.response.status, 200, `import ok (got ${imported.response.status}: ${JSON.stringify(imported.payload).slice(0,200)})`);
    const importedId = imported.payload.result.backupId;
    assert.ok(importedId, 'imported backup id returned');
    assert.equal(imported.payload.result.importedFromId, backupId, 'provenance points at the original backup id');
    assert.equal(imported.payload.result.restoreHint.endpoint, '/v1/admin/restore', 'restore hint points at the standard engine');

    // the imported backup is now a normal, listable backup on B
    const listAfter = await jsonFetch(`${urlB}/v1/admin/backups`, { method: 'GET', headers: adminB });
    assert.ok(listAfter.payload.result.some(item => item.id === importedId), 'imported backup is listable on B');

    // 7) restore on B via the standard engine (epoch + journal + rollback)
    const restored = await jsonFetch(`${urlB}/v1/admin/restore`, { method: 'POST', headers: adminB, body: JSON.stringify({ backupId: importedId, namespaces: NAMESPACES }) });
    assert.equal(restored.response.status, 200, `restore ok (got ${restored.response.status}: ${JSON.stringify(restored.payload).slice(0,200)})`);

    // 8) server B must now SERVE server A's data. Re-bootstrap (restore advanced
    //    the epoch, so the pre-restore token is fenced) and read the value back.
    const bLive = path.join(dataB, 'stores', 'flashback', 'flashback.sqlite');
    assert.ok(fs.existsSync(bLive), 'server B flashback DB exists after restore');
    const tokenB = await bootstrapPlugin(urlB);
    const reboot = await jsonFetch(`${urlB}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23' } });
    assert.equal(reboot.payload.resetEpochs.flashback, 1, 'flashback epoch advanced by one after restore on B');
    const pluginB = { Authorization: `Bearer ${reboot.payload.token}`, 'X-Memory-Suite-Plugin': 'flashback_memory', 'X-Memory-Suite-Plugin-Version': '0.11.23', 'X-Memory-Suite-Reset-Epochs': JSON.stringify(reboot.payload.resetEpochs) };
    void tokenB;
    const got = await jsonFetch(`${urlB}/v1/kv/get?namespace=flashback&space=plugin&key=${encodeURIComponent('e2e-key')}`, { method: 'GET', headers: pluginB });
    assert.equal(got.response.status, 200, 'kv get ok on B after restore: ' + JSON.stringify(got.payload).slice(0, 200));
    assert.equal(got.payload.result.value.marker, 'server-A-payload', 'server B serves server A payload after restore');
    assert.equal(got.payload.result.value.n, 7, 'restored value is intact');

    console.log(JSON.stringify({ test: 'server_backup_export_import_restore_e2e', result: 'pass', backupId, importedId }));
  } finally {
    try { await appA.close?.(); } catch (_) {}
    try { await appB?.close?.(); } catch (_) {}
    for (const d of [dataA, dataB, carry]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
}

main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
