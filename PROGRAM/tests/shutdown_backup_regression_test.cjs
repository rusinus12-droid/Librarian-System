'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

async function json(url, init={}) {
  const r = await fetch(url, init); const t = await r.text(); return { r, p: t ? JSON.parse(t) : {} };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-shutdown-backup-'));
  const app = createMemorySuiteServer({ host:'127.0.0.1', port:0, dataDir, autoBackup:true });
  try {
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const boot = await json(`${base}/bootstrap`, { headers:{'X-Memory-Suite-Plugin':'libra','X-Memory-Suite-Plugin-Version':'1.0.98'} });
    assert.equal(boot.r.status, 200);
    const set = await json(`${base}/v1/kv/set`, { method:'POST', headers:{Authorization:`Bearer ${boot.p.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json'}, body:JSON.stringify({namespace:'libra',space:'plugin',key:'libra:shutdown:test',value:{ok:true},operationId:'shutdown_backup_test_000001'}) });
    assert.equal(set.r.status, 200);
    await app.close();
    const autoRoot = path.join(dataDir,'backups','auto');
    const dirs = fs.existsSync(autoRoot) ? fs.readdirSync(autoRoot) : [];
    assert.ok(dirs.length >= 1, 'shutdown must create an auto backup when dirty');
    const manifests = dirs.map(name => JSON.parse(fs.readFileSync(path.join(autoRoot,name,'manifest.json'),'utf8')));
    assert.ok(manifests.some(m => m.label === 'shutdown'), 'shutdown-labelled backup must exist');
    process.stdout.write('shutdown_backup_regression_test: PASS\n');
  } finally {
    try { await app.close(); } catch (_) {}
    fs.rmSync(dataDir,{recursive:true,force:true});
  }
}
main().catch(e=>{process.stderr.write(`shutdown_backup_regression_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
