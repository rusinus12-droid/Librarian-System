'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer, createRecoverySafeModeServer, isRecoverySafeModeEligibleError } = require('../server/server.cjs');
const F = require('./fixtures/recovery_admission_fixture.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-recovery-safe-'));
  let app;
  try {
    const denied = path.join(root,'unreadable-authority');
    await F.prepare(denied, 'libra:recovery:denied');
    fs.writeFileSync(F.dbFile(denied), Buffer.from('not-a-sqlite-database-corruption'));
    const before = F.protectedSnapshot(denied);
    let refused;
    assert.throws(() => createMemorySuiteServer({dataDir:denied,port:0,autoBackup:false}), error => {
      refused = error;
      return error.code === 'AUTHORITY_QUARANTINED';
    });
    assert.equal(isRecoverySafeModeEligibleError(refused), false, 'unknown authority never becomes ordinary recovery');
    assert.throws(() => createRecoverySafeModeServer({dataDir:denied,port:0}, refused), {code:'AUTHORITY_QUARANTINED'});
    assert.deepEqual(F.protectedSnapshot(denied), before, 'both refusals preserve DATA and backup bytes');

    const dataDir = path.join(root,'readable-authority');
    const key = 'libra:recovery:test';
    const backup = await F.prepare(dataDir, key);
    const corruptedSha = F.corruptDataPage(dataDir);
    let startupError;
    assert.throws(() => createMemorySuiteServer({dataDir,port:0,autoBackup:false}), error => {
      startupError = error;
      return /database.*integrity|malformed/i.test(error.message) && isRecoverySafeModeEligibleError(error);
    });
    app = createRecoverySafeModeServer({host:'127.0.0.1',port:0,dataDir}, startupError);
    const address = await app.listen(), url = `http://127.0.0.1:${address.port}`;
    const health = await fetch(url+'/health').then(r=>r.json());
    assert.equal(health.recoveryMode,true);
    assert.equal(health.status,'recovery_only');
    const deniedRestore = await fetch(url+'/v1/admin/restore', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({backupId:backup.id,namespaces:['libra']})});
    assert.equal(deniedRestore.status,403, 'restore requires the admin capability');
    assert.equal(F.sha256(fs.readFileSync(F.dbFile(dataDir))), corruptedSha);
    const blockedRead = await fetch(url+'/v1/kv/get', {method:'POST',headers:{Authorization:'Bearer '+app.token,'X-Memory-Suite-Admin':'1'}});
    assert.equal(blockedRead.status,503, 'safe mode does not expose normal plugin routes');
    const plan = app.restorePlan(backup.id,['libra']);
    assert.equal(plan.scrub.ok,true);
    const restored = app.restoreBackup(backup.id,['libra']);
    assert.equal(restored.result.recoveryMode,true);
    assert.equal(restored.result.restartRequired,true);
    F.assertQuarantine(dataDir, restored.result, corruptedSha);
    assert.deepEqual(F.tree(backup.path), backup.bytes, 'verified backup is immutable');
    await app.close(); app = null;
    app = createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false,computeEnabled:false});
    await app.listen();
    assert.deepEqual(app.repositories.libra.get('plugin',key).value,{state:'backup'});
    process.stdout.write('recovery_safe_mode_test: PASS (unreadable authority refused; admitted page corruption restored with quarantine)\n');
  } finally { if(app)await app.close();fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(e=>{process.stderr.write(`recovery_safe_mode_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
