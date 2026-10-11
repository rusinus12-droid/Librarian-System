'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn,spawnSync} = require('node:child_process');
const {createMemorySuiteServer} = require('../server/server.cjs');
const F = require('./fixtures/recovery_admission_fixture.cjs');
const serverPath = path.join(__dirname,'..','server','server.cjs');
const args = dataDir => [serverPath,'serve','--data-dir',dataDir,'--port','0','--no-auto-backup','--no-compute'];
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ms-recovery-main-'));
  let child, closed, app;
  try {
    const denied = path.join(root,'unreadable-authority');
    await F.prepare(denied,'libra:main:denied');
    fs.writeFileSync(F.dbFile(denied),Buffer.from('broken sqlite image'));
    const before = F.protectedSnapshot(denied);
    const rejected = spawnSync(process.execPath,args(denied),{encoding:'utf8',timeout:10000});
    assert.equal(rejected.error,undefined);
    assert.notEqual(rejected.status,0);
    assert.match(rejected.stderr,/AUTHORITY_QUARANTINED/);
    assert.doesNotMatch(rejected.stdout,/Recovery Safe Mode ready/);
    assert.deepEqual(F.protectedSnapshot(denied),before,'CLI refusal preserves protected DATA; diagnostics may record the failure');

    const dataDir = path.join(root,'readable-authority'), key = 'libra:main:recovery';
    const backup = await F.prepare(dataDir,key);
    const corruptedSha = F.corruptDataPage(dataDir);
    child = spawn(process.execPath,args(dataDir),{stdio:['ignore','pipe','pipe']});
    closed = new Promise(resolve=>child.once('close',resolve));
    let out='',err=''; child.stdout.on('data',c=>{out+=c;});child.stderr.on('data',c=>{err+=c;});
    const deadline=Date.now()+10000;let ready;
    while(Date.now()<deadline && child.exitCode === null) {
      ready=out.match(/Recovery Safe Mode ready at (http:\/\/[^\s]+)/);
      if(ready)break;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(ready,`recovery server did not start\nstdout=${out}\nstderr=${err}`);
    const health=await fetch(ready[1]+'/health').then(r=>r.json());
    assert.equal(health.recoveryMode,true);assert.equal(health.status,'recovery_only');
    assert.match(health.startupError,/database.*integrity|malformed/i);
    const token=fs.readFileSync(path.join(dataDir,'runtime-token.txt'),'utf8').trim();
    const response=await fetch(ready[1]+'/v1/admin/restore',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Memory-Suite-Admin':'1','Content-Type':'application/json'},body:JSON.stringify({backupId:backup.id,namespaces:['libra']})});
    const restored=await response.json();assert.equal(response.status,200,JSON.stringify(restored));
    assert.equal(restored.result.recoveryMode,true);assert.equal(restored.result.restartRequired,true);
    F.assertQuarantine(dataDir,restored.result,corruptedSha);
    assert.deepEqual(F.tree(backup.path),backup.bytes);
    child.kill('SIGTERM');await closed;child=null;
    app=createMemorySuiteServer({dataDir,port:0,autoBackup:false,computeEnabled:false});await app.listen();
    assert.deepEqual(app.repositories.libra.get('plugin',key).value,{state:'backup'});
    process.stdout.write('recovery_main_fallback_test: PASS (quarantine refusal and actual CLI recovery/restore/readback)\n');
  } finally {
    if(child){child.kill('SIGTERM');await closed;}
    if(app)await app.close();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(e=>{process.stderr.write(`recovery_main_fallback_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
