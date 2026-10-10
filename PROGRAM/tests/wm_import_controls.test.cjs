'use strict';
// Basic synthetic SQLite and extracted existing backup-panel flow only.
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const F=require('./helpers/wm-fixture.cjs'), B=require('../server/wm/backup.cjs');
const {createWmStore}=require('../server/wm/store.cjs'), {createWmPins}=require('../server/wm/pins.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.WM_BASIC_CHECKPOINT||os.tmpdir(),'wm-controls-basic-'));
 const store=createWmStore({databasePath:path.join(root,'source.sqlite'),identity:F.storeIdentity()});t.after(()=>store.close());
 const pins=createWmPins({store,bootId:'controls'});const head=store.initializeScope(F.initialization()).receipt.head;
 const input=F.storeWrite(head), prepared=store.prepare(input);store.publish(prepared);
 const backupRoot=path.join(root,'backup'), component=B.createWmBackup({store,pins,outputDir:backupRoot}).capture({backupId:'controls-backup'});
 const targetPath=path.join(root,'target/wm.sqlite'), importer=B.createWmBackupImport({targetPath,importEnabled:true});
 const plan=importer.prepare({operationId:'controls-import',component,backupRoot,targetDatasetId:'dataset-new',targetBackendId:'backend-new'});
 const exact={planId:plan.planId,operationId:plan.operationId,requestFingerprint:plan.requestFingerprint};
 return {root,store,backupRoot,component,targetPath,importer,plan,exact,input,prepared};
}
function record(f,change){const file=f.targetPath+'.import-plan.json';const r=JSON.parse(fs.readFileSync(file));change(r);fs.writeFileSync(file,JSON.stringify(r));return r;}
const apply=f=>f.importer.apply({planId:f.plan.planId,confirmation:f.plan.confirmation,requestFingerprint:f.plan.requestFingerprint});
function recover(f){const v=f.importer.inspect(f.exact);return f.importer.recover({...f.exact,confirmation:v.recovery.confirmation,observationFingerprint:v.recovery.observationFingerprint});}
test('same-ID explicit recovery preserves partial stage and prepares a fresh attempt without source mutation',t=>{
 const f=fixture(t);assert.equal(typeof f.importer.inspect,'function');assert.equal(typeof f.importer.recover,'function');
 const sourceHash=B.hashFile(path.join(f.backupRoot,f.component.file));
 const r=record(f,r=>{r.phase='staging';});fs.writeFileSync(r.stagePath,'interrupted copy bytes');
 const before=f.importer.inspect(f.exact);assert.equal(before.phase,'staging');
 assert.throws(()=>f.importer.recover({...f.exact,confirmation:'RECOVER wrong',observationFingerprint:before.recovery.observationFingerprint}),/confirmation/);
 const result=recover(f);assert.equal(result.phase,'prepared');assert.equal(result.plan.planId,f.plan.planId);
 assert.equal(fs.readFileSync(r.stagePath,'utf8'),'interrupted copy bytes');assert.equal(result.preservedStages.length,1);
 assert.equal(apply(f).status,'committed');assert.equal(B.hashFile(path.join(f.backupRoot,f.component.file)),sourceHash);
 assert.equal(f.importer.inspect(f.exact).plan.incarnation,f.plan.incarnation);
});
test('complete source-stage resumes rebase and unknown/live locks are never removed',t=>{
 const f=fixture(t);assert.equal(typeof f.importer.recover,'function');
 const r=record(f,r=>{r.phase='staging';});fs.copyFileSync(path.join(f.backupRoot,f.component.file),r.stagePath);
 fs.mkdirSync(f.targetPath+'.import-lock');
 const blocked=recover(f);assert.equal(blocked.recovery.blockedReason,'import_lock_owner_unverified');assert.equal(fs.existsSync(f.targetPath+'.import-lock'),true);
 // This fixture owns the empty synthetic lock. Removing it here is test setup, not production recovery.
 fs.rmdirSync(f.targetPath+'.import-lock');assert.equal(recover(f).phase,'staged');assert.equal(apply(f).status,'committed');
});
test('known dead-process lock is preserved and stale observations cannot authorize recovery',t=>{
 const f=fixture(t);assert.equal(typeof f.importer.inspect,'function');
 const r=record(f,r=>{r.phase='staging';});fs.writeFileSync(r.stagePath,'partial');
 // Capture the real lock format during a synchronous copy error; no process-kill qualification claim.
 const orig=fs.copyFileSync;let owner;
 record(f,r=>{r.phase='prepared';r.stageAttempt=1;r.stagePath=f.targetPath+'.import-stage-'+r.plan.planId+'-retry-1';});
 fs.copyFileSync=function(...args){owner=JSON.parse(fs.readFileSync(f.targetPath+'.import-lock/owner.json'));throw Error('synthetic copy interruption');};
 try{assert.throws(()=>apply(f),/synthetic copy interruption/);}finally{fs.copyFileSync=orig;}
 assert(owner);fs.mkdirSync(f.targetPath+'.import-lock');fs.writeFileSync(f.targetPath+'.import-lock/owner.json',JSON.stringify(owner));
 assert.equal(recover(f).recovery.blockedReason,'import_lock_owner_live');
 owner.pid=2147483647;fs.writeFileSync(f.targetPath+'.import-lock/owner.json',JSON.stringify(owner));
 const stale=f.importer.inspect(f.exact);fs.writeFileSync(f.targetPath+'.import-lock/owner.json',JSON.stringify({...owner,nonce:'changed'}));
 assert.throws(()=>f.importer.recover({...f.exact,confirmation:stale.recovery.confirmation,observationFingerprint:stale.recovery.observationFingerprint}),/observation_changed/);
 const recovered=recover(f);assert.equal(recovered.phase,'prepared');assert.equal(recovered.preservedLocks.length,1);
 assert.equal(fs.existsSync(recovered.preservedLocks[0].path+'/owner.json'),true);assert.equal(apply(f).status,'committed');
});
test('manager import adopts only a qualified inactive target and reopens recovery-fenced after restart',async t=>{
 const {createMemorySuiteServer}=require('../server/server.cjs');const root=fs.mkdtempSync(path.join(process.env.WM_BASIC_CHECKPOINT||os.tmpdir(),'wm-controls-server-'));
 const opts={token:'synthetic-only-no-persistent-credential',computeEnabled:false,autoBackup:false,wmBackupRestoreEnabled:true};
 const source=createMemorySuiteServer({...opts,dataDir:path.join(root,'source'),wmServerIdentity:F.storeIdentity()});t.after(()=>source.close());
 source.wmService.initializeScope(F.initialization());const capture=await source.createBackup('manual','controls-source'), backup=source.listBackups().find(x=>x.id===capture.result.id);
 const targetDir=path.join(root,'target');let target=createMemorySuiteServer({...opts,dataDir:targetDir});t.after(()=>target.close());
 assert.equal(typeof target.managerControl?.handle,'function');
 const destination=path.join(targetDir,'backups/manual',backup.id);fs.cpSync(backup.path,destination,{recursive:true,errorOnExist:true});
 const sourceHash=B.hashFile(path.join(backup.path,backup.components.wm.file));
 const call=(command,more={})=>target.managerControl.handle('wm-import',{command,...more});
 const view=await call('prepare',{operationId:'manager-import-basic',backupId:backup.id});const p=view.plan;
 assert.equal(view.phase,'prepared');assert.equal(fs.existsSync(p.targetPath),false);
 const exact={planId:p.planId,operationId:p.operationId,requestFingerprint:p.requestFingerprint};
 const done=await call('apply',{...exact,confirmation:p.confirmation});assert.equal(done.result.status,'committed');assert.equal(done.adoption.allowed,true);
 assert.equal((await source.managerControl.handle('wm-import',{command:'prepare',operationId:'source-import-basic',backupId:backup.id})).adoption.reason,'wm_current_authority_active');
 const sync=fs.fsyncSync,link=fs.linkSync;let selectionPublished=false;
 fs.linkSync=function(from,to){const value=link(from,to);if(String(to).endsWith('wm-import-selection.json'))selectionPublished=true;return value;};
 fs.fsyncSync=function(fd){if(selectionPublished)throw Error('synthetic selection acknowledgement loss');return sync(fd);};
 try{await assert.rejects(()=>call('adopt',{...exact,confirmation:done.adoption.confirmation}),/synthetic selection acknowledgement loss/);}finally{fs.fsyncSync=sync;fs.linkSync=link;}
 assert.equal(target.wmService.status().reason,'import_adoption_restart_required','published selection closes lazy old authority despite lost acknowledgement');
 const adopted=await call('adopt',{...exact,confirmation:done.adoption.confirmation});assert.equal(adopted.adoption.state,'restart_required');assert.equal(adopted.activation,false);
 assert.equal((await target.createBackup('manual','pending-selection')).result.coverage?.wm,'unsupported','pending selected WM must not be reported absent');
 assert.equal(target.wmService.status().reason,'import_adoption_restart_required');assert.throws(()=>target.wmService.initializeScope(F.initialization()),/import_adoption_restart_required/);
 await target.close();target=createMemorySuiteServer({...opts,dataDir:targetDir});
 const state=target.wmService.status();assert.equal(state.available,true);assert.equal(state.dataset.identity.storeId,p.targetIdentity.storeId);assert.equal(state.dataset.route.state,'recovery_required');
 assert.throws(()=>target.wmService.initializeScope(F.initialization('new-scope','new-operation')),/restore_recovery_required/);
 const reloaded=await call('inspect',exact);assert.equal(reloaded.adoption.state,'selected_recovery_required');assert.equal(reloaded.activation,false);
 assert.equal(B.hashFile(path.join(backup.path,backup.components.wm.file)),sourceHash);assert.equal(target.wmService.backupCapabilities().restoreEnabled,false);
 assert.throws(()=>require('../server/server.cjs').planOfflineRestore({dataDir:targetDir,backupId:backup.id,namespaces:['wm'],wmRestoreEnabled:true}),/wm_import_selected_same_store_restore_unsupported/);
 assert.equal((await target.createBackup('manual','selected-recovery')).result.coverage.wm,'included');
 await target.close();target=createMemorySuiteServer({...opts,dataDir:targetDir});assert.equal(target.wmService.status().dataset.route.state,'recovery_required');
 const closedDir=path.join(root,'closed'),closed=createMemorySuiteServer({...opts,dataDir:closedDir,wmBackupRestoreEnabled:false});t.after(()=>closed.close());
 await assert.rejects(()=>closed.managerControl.handle('wm-import',{command:'prepare',operationId:'not-qualified',backupId:backup.id}),/provider_unqualified/);
 assert.equal((await closed.managerControl.handle('status')).wmImport.enabled,false);
});
test('backup-panel controls keep exact pending IDs, cancel import/adoption, and show recovery identity',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
 assert(source.includes('const handleWmImportControl ='),'backup panel has explicit import controls');
 const a=source.indexOf('  const renderServerControl ='),b=source.indexOf('  const renderShell =',a);
 const nodes={};for(const id of ['#serverControlSummary','#serverControlBackups','#serverControlHistory','#serverControlResult','#serverControlWmImportStatus','#serverControlWmImportOperations'])nodes[id]={value:id==='#serverControlBackups'?'backup':'',textContent:'',innerHTML:'',disabled:false};
 const Runtime={busy:false,visible:true,serverControl:{status:{dataInstanceId:'server',wmImport:{enabled:true,operations:[]}},backups:[{id:'backup',coverage:{wm:'included'}}]},root:{querySelector:id=>nodes[id],querySelectorAll:()=>[]}};
 let accept=false;const calls=[];
 const plan={planId:'import-plan',operationId:'ui-import-operation',requestFingerprint:'abc',backupId:'backup',confirmation:'IMPORT import-plan',targetPath:'/synthetic/new.sqlite',targetIdentity:{authorityId:'new-authority',storeId:'new-store'},sourceStoreIdentity:{storeId:'source-store'},incarnation:'new-incarnation'};
 let view={plan,phase:'prepared',result:null,activation:false,adoption:{allowed:false,reason:'import_not_committed',state:'not_selected',confirmation:'ADOPT import-plan'},recovery:{confirmation:'RECOVER import-plan',observationFingerprint:'observed'}};
 const bridge={managerConnection:async()=>({}),getConnectionSettings:async()=>({url:'synthetic://server',mode:'plugin_only'}),serverBinding:()=>({dataInstanceId:'server',current:true}),managerControl:async(action,body)=>{
  calls.push({action,body});if(action==='wm-import'){
   if(body.command==='apply')view={...view,phase:'committed',result:{status:'committed'},adoption:{...view.adoption,allowed:true,reason:null}};
   if(body.command==='adopt')view={...view,adoption:{...view.adoption,allowed:false,state:'restart_required'}};
   Runtime.serverControl.status.wmImport.operations=[structuredClone(view)];return structuredClone(view);
  }if(action==='status')return Runtime.serverControl.status;if(action==='backups')return Runtime.serverControl.backups;if(action==='history')return [];
 }};
 const host={getCharacter:async()=>({id:'character'}),getChat:async()=>({id:'chat'})};
 const deps={Runtime,escapeHtml:String,scopeManagerArray:v=>Array.isArray(v)?v:[],scopeManagerFormatTime:String,scopeManagerFormatBytes:String,MEMORY_SUITE_NAMESPACE_LABELS:{},setBusy:v=>Runtime.busy=v,retraceConfirm:async()=>accept,MemorySuiteStorageBridge:bridge,liveApi:()=>host,contextIdentity:v=>({characterId:v.character?.id,chatId:v.chat?.id}),identityValue:String};
 const api=new Function(...Object.keys(deps),source.slice(a,b)+'\nreturn {handleServerControl,renderServerControl};')(...Object.values(deps));
 const click=action=>api.handleServerControl({target:{closest:()=>({disabled:false,getAttribute:()=>action})}});
 await click('wm-import-prepare');assert.equal(calls.filter(c=>c.body?.command==='prepare').length,1);
 await click('wm-import-apply');assert.equal(calls.filter(c=>c.body?.command==='apply').length,0,'cancel does not import');
 accept=true;await click('wm-import-apply');assert.deepEqual(calls.find(c=>c.body?.command==='apply').body,{command:'apply',planId:plan.planId,operationId:plan.operationId,requestFingerprint:plan.requestFingerprint,confirmation:plan.confirmation});
 assert(nodes['#serverControlWmImportStatus'].textContent.includes('new-store'));assert(nodes['#serverControlWmImportStatus'].textContent.includes('recovery_required'));
 accept=false;await click('wm-import-adopt');assert.equal(calls.filter(c=>c.body?.command==='adopt').length,0);
 accept=true;await click('wm-import-adopt');assert.equal(calls.filter(c=>c.body?.command==='adopt').length,1);assert(nodes['#serverControlWmImportStatus'].textContent.includes('restart_required'));
});
test('recovery never rebases a source-linked stage or overwrites an occupied target',t=>{
 const f=fixture(t),source=path.join(f.backupRoot,f.component.file),sourceHash=B.hashFile(source);
 const r=record(f,r=>{r.phase='staging';});fs.linkSync(source,r.stagePath);
 const result=recover(f);assert.equal(result.phase,'prepared');assert.equal(B.hashFile(source),sourceHash);assert.equal(B.hashFile(r.stagePath),sourceHash);
 fs.writeFileSync(f.targetPath,'unrelated existing target');
 assert.throws(()=>apply(f),/import_target_not_empty/);assert.equal(fs.readFileSync(f.targetPath,'utf8'),'unrelated existing target');
 assert.equal(B.hashFile(source),sourceHash);
});

test('explicit publication recovery reports the reconciled receipt after releasing its own lock',t=>{
 const f=fixture(t);const result=apply(f);record(f,r=>{r.phase='publishing';delete r.result;delete r.resultDigest;});
 const v=recover(f);assert.equal(v.phase,'committed');assert.deepEqual(v.result,result);assert.equal(v.recovery.blockedReason,null);assert.equal(fs.existsSync(f.targetPath+'.import-recovery-lock'),false);
});
