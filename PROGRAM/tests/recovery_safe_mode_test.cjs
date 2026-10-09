'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer, createRecoverySafeModeServer } = require('../server/server.cjs');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-recovery-safe-'));
  let normal = createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  await normal.listen();
  normal.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:recovery:test',value:{state:'backup'},operationId:'recovery_safe_source_0001',expectedRevision:0});
  const backup = await normal.createBackup('manual','recovery-safe-source');
  await normal.close();
  const dbPath = path.join(dataDir,'stores','libra','libra.sqlite');
  fs.writeFileSync(dbPath, Buffer.from('not-a-sqlite-database-corruption'));
  assert.throws(()=>createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false}), /database|sqlite|malformed|file is not a database/i);

  const recovery = createRecoverySafeModeServer({host:'127.0.0.1',port:0,dataDir}, new Error('database disk image is malformed'));
  const address = await recovery.listen();
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then(r=>r.json());
    assert.equal(health.recoveryMode,true);
    assert.equal(health.status,'recovery_only');
    const plan = recovery.restorePlan(backup.result.id,['libra']);
    assert.equal(plan.scrub.ok,true);
    const restored = recovery.restoreBackup(backup.result.id,['libra']);
    assert.equal(restored.result.recoveryMode,true);
    assert.equal(restored.result.quarantineId.length > 0,true);
  } finally { await recovery.close(); }

  normal = createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  await normal.listen();
  try {
    assert.deepEqual(normal.repositories.libra.get('plugin','libra:recovery:test').value,{state:'backup'});
    process.stdout.write('recovery_safe_mode_test: PASS\n');
  } finally { await normal.close(); fs.rmSync(dataDir,{recursive:true,force:true}); }
}
main().catch(e=>{process.stderr.write(`recovery_safe_mode_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
