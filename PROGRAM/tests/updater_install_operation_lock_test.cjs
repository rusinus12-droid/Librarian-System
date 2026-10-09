'use strict';
// Execute the inspected main control flow in a VM. Install action is a stub:
// no software is installed; it only probes whether another SQLite lock is free.
const os=require('node:os'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),Module=require('node:module');
const base=path.resolve(__dirname,'../../UPDATER');
const lockFile=path.join(base,'core/lock.cjs');const permitted=new Set(['node:fs','node:path','node:crypto','node:stream/promises','node:stream','node:async_hooks','node:sqlite']);
const load=Module._load,denied=[];Module._load=function(spec,parent,isMain){if(permitted.has(spec)||spec===lockFile)return load.call(this,spec,parent,isMain);denied.push(spec);throw Error('blocked_module:'+spec);};
global.fetch=()=>{denied.push('fetch');throw Error('blocked_fetch');};
const lock=require(lockFile);const {DatabaseSync}=require('node:sqlite');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lib-updater-lock-'));
let otherUpdaterLockAcquiredAtInstall=false,installCalls=0;
const stubs={
 './core/lock.cjs':lock,
 './runtime.cjs':{assertRuntime(){},validateRoot(){},detectPlatform:()=>process.platform},
 './core/program-only.cjs':{},'./core/migration-required.cjs':{},
 './core/journal.cjs':{readJournal:()=>null,isTerminal:j=>!j},
 './core/updater-bootstrap.cjs':{installUpdaterIntoTarget:async()=>{installCalls++;const db=new DatabaseSync(path.join(root,'UPDATER/operation-lock.sqlite'));try{db.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');otherUpdaterLockAcquiredAtInstall=true;db.exec('ROLLBACK');}catch(e){if(!/locked|busy/i.test(e.message))throw e;}finally{db.close();}return{installed:false,stub:true};}}
};
const mod={exports:{}};const req=spec=>{if(Object.hasOwn(stubs,spec))return stubs[spec];if(permitted.has(spec))return require(spec);denied.push(spec);throw Error('blocked_vm_module:'+spec);};
const context={module:mod,exports:mod.exports,require:req,__dirname:base,process,console:{log(){}},Buffer,URL,AbortController,setTimeout,clearTimeout,fetch:global.fetch};
vm.runInNewContext(fs.readFileSync(path.join(base,'updater.cjs'),'utf8'),context,{filename:path.join(base,'updater.cjs')});
(async()=>{await mod.exports.main(['--target-root',root,'--recover','--install-updater']);assert.equal(installCalls,1);assert.equal(otherUpdaterLockAcquiredAtInstall,false);assert.equal(denied.length,0);process.stdout.write(JSON.stringify({node:process.version,flow:'--recover --install-updater',installerStubCalls:installCalls,otherUpdaterLockAcquiredAtInstall,actualInstalls:0,networkOrModelAttempts:denied},null,2)+'\n');})().catch(e=>{console.error(e);process.exitCode=1;});
