'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer, recoverInterruptedRestore, atomicWrite } = require('../server/server.cjs');
const crypto = require('node:crypto');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function main(){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ms-restore-journal-'));
  const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir,autoBackup:false});
  await app.listen();
  app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:journal:test',value:{state:'original'},operationId:'restore_journal_original_0001',expectedRevision:0});
  const backup=await app.createBackup('manual','journal-source');
  app.repositories.libra.mutate({kind:'set',space:'plugin',key:'libra:journal:test',value:{state:'current'},operationId:'restore_journal_current_0002',expectedRevision:1});
  await app.close();

  const current=path.join(dataDir,'stores','libra','libra.sqlite');
  const source=path.join(dataDir,'backups','manual',backup.result.id,'libra.sqlite');
  const rollback=`${current}.restore-rollback-crash`;
  const temp=`${current}.restore-temp-crash`;
  const currentSha=sha(current);
  fs.copyFileSync(source,temp);
  const stagedSha=sha(temp);
  atomicWrite(path.join(dataDir,'migrations','restore-transaction.json'), JSON.stringify({schema:'memory-suite.restore-transaction.v1',id:'crash-test',phase:'PREPARED',backupId:backup.result.id,items:[{namespace:'libra',currentPath:current,tempPath:temp,rollbackPath:rollback,hadCurrent:true,stagedSha256:stagedSha}],catalog:null},null,2)+'\n');
  fs.renameSync(current,rollback);
  fs.renameSync(temp,current);
  assert.notEqual(sha(current),currentSha);
  const recovered=recoverInterruptedRestore(dataDir);
  assert.equal(recovered.action,'rollback');
  assert.equal(sha(current),currentSha);
  assert.equal(fs.existsSync(rollback),false);
  assert.equal(fs.existsSync(path.join(dataDir,'migrations','restore-transaction.json')),false);

  // A transaction already marked COMMITTED keeps the installed data and only removes leftovers.
  const committedRollback=`${current}.restore-rollback-committed`;
  const committedTemp=`${current}.restore-temp-committed`;
  fs.copyFileSync(current,committedRollback);
  fs.copyFileSync(source,committedTemp);
  fs.rmSync(current);
  fs.renameSync(committedTemp,current);
  const committedSha=sha(current);
  atomicWrite(path.join(dataDir,'migrations','restore-transaction.json'), JSON.stringify({schema:'memory-suite.restore-transaction.v1',id:'commit-test',phase:'COMMITTED',backupId:backup.result.id,items:[{namespace:'libra',currentPath:current,tempPath:committedTemp,rollbackPath:committedRollback,hadCurrent:true,stagedSha256:committedSha}],catalog:null},null,2)+'\n');
  const committed=recoverInterruptedRestore(dataDir);
  assert.equal(committed.action,'commit_cleanup');
  assert.equal(sha(current),committedSha);
  assert.equal(fs.existsSync(committedRollback),false);
  fs.rmSync(dataDir,{recursive:true,force:true});
  process.stdout.write('restore_journal_crash_recovery_test: PASS\n');
}
main().catch(e=>{process.stderr.write(`restore_journal_crash_recovery_test: FAIL\n${e.stack||e}\n`);process.exitCode=1;});
