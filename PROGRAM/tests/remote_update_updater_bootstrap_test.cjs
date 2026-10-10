'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {installUpdaterIntoTarget}=require('../../UPDATER/core/updater-bootstrap.cjs');

(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'librarian updater bootstrap '));
  const source=path.join(temp,'source','UPDATER');
  const target=path.join(temp,'target');
  try{
    fs.mkdirSync(path.join(source,'core'),{recursive:true});
    fs.mkdirSync(path.join(source,'logs'),{recursive:true});
    fs.writeFileSync(path.join(source,'updater.cjs'),'NEW-UPDATER\n');
    fs.writeFileSync(path.join(source,'launch.sh'),'#!/bin/sh\necho NEW-LAUNCH\n'); fs.chmodSync(path.join(source,'launch.sh'),0o755);
    fs.writeFileSync(path.join(source,'core','engine.cjs'),'NEW-CORE\n');
    fs.writeFileSync(path.join(source,'logs','README.txt'),'STATIC\n');
    fs.mkdirSync(path.join(target,'UPDATER','logs'),{recursive:true});
    fs.writeFileSync(path.join(target,'UPDATER','updater.cjs'),'OLD-UPDATER\n');
    fs.writeFileSync(path.join(target,'UPDATER','update-state.json'),JSON.stringify({status:'complete',policy:'migration_required'}));
    fs.writeFileSync(path.join(target,'UPDATER','logs','latest.log'),'legacy log\n');

    const first=await installUpdaterIntoTarget({sourceUpdaterDir:source,targetRoot:target,logger:()=>{}});
    assert.equal(first.installed,true);
    assert.equal(fs.readFileSync(path.join(target,'UPDATER','updater.cjs'),'utf8'),'NEW-UPDATER\n');
    // Windows does not expose POSIX execute bits through stat; the durability
    // copy path applies chmod(sourceMode) on POSIX hosts. Assert there only.
    if(process.platform!=='win32')assert.ok((fs.statSync(path.join(target,'UPDATER','launch.sh')).mode & 0o111)!==0,'launch.sh executable bit preserved');
    assert.equal(fs.readFileSync(path.join(target,'UPDATER','core','engine.cjs'),'utf8'),'NEW-CORE\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target,'UPDATER','update-state.json'),'utf8')).status,'complete');
    assert.equal(fs.readFileSync(path.join(target,'UPDATER','logs','latest.log'),'utf8'),'legacy log\n');
    assert.equal(fs.readFileSync(path.join(target,'UPDATER','logs','README.txt'),'utf8'),'STATIC\n');
    assert.ok(first.rollbackUpdater && fs.existsSync(path.join(first.rollbackUpdater,'updater.cjs')));
    assert.equal(fs.readFileSync(path.join(first.rollbackUpdater,'updater.cjs'),'utf8'),'OLD-UPDATER\n');

    const second=await installUpdaterIntoTarget({sourceUpdaterDir:source,targetRoot:target,logger:()=>{}});
    assert.equal(second.installed,false);
    assert.equal(second.alreadyCurrent,true);
    console.log('remote_update_updater_bootstrap_test: PASS');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
