'use strict';
// Existing authenticated manager transport; trusted restore qualification only.
// Selection reopens a recovery-fenced file on restart. It never activates writers.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const B=require('./backup.cjs');
const {DatabaseSync}=require('node:sqlite');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
const fail=reason=>{throw Object.assign(Error(reason),{code:'WM_'+reason,statusCode:409});};
const validOperation=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v);
const selectionPath=dataDir=>path.join(dataDir,'config','wm-import-selection.json');
function targetPath(dataDir,operationId){if(!validOperation(operationId))fail('import_operation_invalid');return path.join(path.resolve(dataDir),'migrations','wm-imports',operationId,'wm.sqlite');}
function recordFor(dataDir,operationId){const file=targetPath(dataDir,operationId)+'.import-plan.json';if(!fs.existsSync(file))fail('import_plan_unknown');return JSON.parse(fs.readFileSync(file,'utf8'));}
function selectionRecord(dataDir,dataInstanceId){
 const file=selectionPath(dataDir);if(!fs.existsSync(file))return null;
 const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())fail('import_selection_invalid');
 const s=JSON.parse(fs.readFileSync(file,'utf8')), {digest,...body}=s;
 if(s.schema!=='wm.import-selection.v1'||s.dataInstanceId!==dataInstanceId||s.activation!==false||s.admission!=='recovery_required'||
   sha(B.stable(body))!==digest||s.targetPath!==targetPath(dataDir,s.plan?.operationId))fail('import_selection_invalid');
 const r=recordFor(dataDir,s.plan.operationId);
 if(r.phase!=='committed'||B.stable(r.plan)!==B.stable(s.plan)||B.stable(r.result?.receipt)!==B.stable(s.receipt))fail('import_selection_binding_invalid');
 return s;
}
function resolveWmImportSelection({dataDir,dataInstanceId,restoreEnabled=false}){
 const s=selectionRecord(dataDir,dataInstanceId);if(!s)return null;
 if(!restoreEnabled)fail('import_selection_provider_unqualified');
 // Import/adoption verified the entire immutable closure before initial use.
 // A selected runtime legitimately accumulates target-owned pin/snapshot rows;
 // never reinterpret it as an unused backup or relax the backup verifier.
 B.createWmBackupImport({targetPath:s.targetPath,importEnabled:true}).inspect({planId:s.plan.planId,operationId:s.plan.operationId,requestFingerprint:s.plan.requestFingerprint});
 require('./service.cjs').preflightExisting(s.targetPath,s.plan.targetIdentity);
 const db=new DatabaseSync(s.targetPath,{readOnly:true});
 try {
   const meta=key=>db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
   const a=JSON.parse(meta('restore-admission')||'null'),row=db.prepare('SELECT * FROM dataset_route WHERE singleton=1').get(),route=JSON.parse(row?.route_json||'null');
   const evidence=JSON.parse(meta('backup-evidence:cross-store-import:'+s.plan.planId)||'null');
   if(!a||a.planId!==s.plan.planId||a.operationId!==s.plan.operationId||a.incarnation!==s.plan.incarnation||a.historicalAuthority!==false||
      a.sourceComponentSha256!==s.plan.componentSha256||a.inventoryDigest!==s.receipt.inventoryDigest||
      (s.receipt.sourceInventoryDigest!==undefined ? a.sourceInventoryDigest!==s.plan.inventoryDigest||s.receipt.sourceInventoryDigest!==s.plan.inventoryDigest||evidence?.sourceInventoryDigest!==s.plan.inventoryDigest||evidence?.targetInventoryDigest!==s.receipt.inventoryDigest : a.inventoryDigest!==s.plan.inventoryDigest)||a.state!=='recovery_required'||
      !row||sha(row.route_json)!==row.route_sha256||route.state!=='recovery_required'||route.mode!=='server_only'||
      route.routeGeneration!==s.plan.targetIdentity.routeGeneration||route.datasetId!==s.plan.targetIdentity.datasetId||route.backendId!==s.plan.targetIdentity.backendId||
      meta('writer_epoch')!==s.plan.targetIdentity.writerEpoch||!evidence||sha(B.stable(evidence))!==a.rebaseEvidenceDigest||
      evidence.planId!==s.plan.planId||B.stable(evidence.targetIdentity)!==B.stable(s.plan.targetIdentity)||evidence.executionAuthority!==false)
      fail('import_selection_recovery_binding_invalid');
 }finally{db.close();}
 return {databasePath:s.targetPath,serverIdentity:clone(s.plan.targetIdentity),planId:s.plan.planId};
}
function createWmImportControl({dataDir,dataInstanceId,restoreEnabled=false,listBackups,service,canStart=()=>true,selection=null}){
 const root=path.resolve(dataDir);
 function enabled(){if(!restoreEnabled)fail('import_provider_unqualified');}
 function provider(operationId){return B.createWmBackupImport({targetPath:targetPath(root,operationId),importEnabled:restoreEnabled});}
 function identity(plan){return {planId:plan.planId,operationId:plan.operationId,requestFingerprint:plan.requestFingerprint};}
 function adoption(plan,phase){
   const saved=selectionRecord(root,dataInstanceId),current=service.status();
   let reason=null,state='not_selected';
   if(saved){state=selection?.planId===saved.plan.planId?'selected_recovery_required':'restart_required';reason=saved.plan.planId===plan.planId?'already_selected':'another_import_selected';}
   else if(!restoreEnabled)reason='import_provider_unqualified';
   else if(!current.available)reason='wm_current_authority_unavailable';
   else if(current.initialized&&!['recovery_required','fenced'].includes(current.dataset?.route?.state))reason='wm_current_authority_active';
   else if(!current.initialized&&fs.existsSync(path.join(root,'stores','wm','wm.sqlite')))reason='wm_current_authority_unverified';
   else if(phase!=='committed')reason='import_not_committed';
   return {allowed:!reason,reason,state,confirmation:'ADOPT '+plan.planId,restartRequired:state==='restart_required',activation:false};
 }
 function inspect(input){const v=provider(input.operationId).inspect(input);return {...v,adoption:adoption(v.plan,v.phase)};}
 function summary(){
   const dir=path.join(root,'migrations','wm-imports'),operations=[];
   if(restoreEnabled&&fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(validOperation).sort()){
     try{const r=recordFor(root,name);operations.push(inspect(identity(r.plan)));}
     catch(error){operations.push({operationId:name,phase:'unverified',reason:String(error.code||'import_state_unreadable'),activation:false});}
   }
   return {schema:'wm.import-control.v1',enabled:restoreEnabled,activation:false,nativeOwner:false,existingTargetReplacement:false,operations};
 }
 function exact(body,fields){B.assertPlainData(body);if(Object.keys(body).length!==fields.length||!fields.every(k=>Object.hasOwn(body,k)))fail('import_control_unknown_field');}
 async function handle(body){
   enabled();const command=body?.command;
   if(command==='prepare'){
     exact(body,['command','operationId','backupId']);if(!canStart())fail('maintenance_in_progress');
     const backup=listBackups().find(b=>b.id===body.backupId);
     if(!backup?.components?.wm||backup.coverage?.wm!=='included')fail('import_backup_component_required');
     const seed=sha(dataInstanceId+':'+body.operationId).slice(0,32);
     const p=provider(body.operationId).prepare({operationId:body.operationId,component:backup.components.wm,backupRoot:backup.path,targetDatasetId:'wm-import-dataset-'+seed,targetBackendId:'wm-import-server-'+seed});
     return inspect(identity(p));
   }
   const fields=['command','operationId','planId','requestFingerprint'];
   if(['apply','adopt'].includes(command))fields.push('confirmation');
   if(command==='recover')fields.push('confirmation','observationFingerprint');
   if(!['inspect','apply','recover','adopt'].includes(command))fail('import_control_action_invalid');exact(body,fields);
   const input={planId:body.planId,operationId:body.operationId,requestFingerprint:body.requestFingerprint};
   let view=inspect(input);const importer=provider(body.operationId);
   if(command==='inspect')return view;
   if(!canStart())fail('maintenance_in_progress');
   if(command==='apply'){
     importer.apply({planId:body.planId,confirmation:body.confirmation,requestFingerprint:body.requestFingerprint});return inspect(input);
   }
   if(command==='recover'){
     const result=importer.recover({...input,confirmation:body.confirmation,observationFingerprint:body.observationFingerprint});
     return {...result,adoption:adoption(result.plan,result.phase)};
   }
   if(body.confirmation!==view.adoption.confirmation)fail('import_adoption_confirmation_required');
   const prior=selectionRecord(root,dataInstanceId);
   if(prior){if(B.stable(prior.plan)!==B.stable(view.plan))fail('import_selection_conflict');return inspect(input);}
   if(!view.adoption.allowed)fail(view.adoption.reason);
   importer.verifyTarget(input);
   // Check admission again immediately before the one-time no-clobber selection.
   view=inspect(input);if(!view.adoption.allowed)fail(view.adoption.reason);
   const bodyRecord={schema:'wm.import-selection.v1',dataInstanceId,plan:view.plan,receipt:view.result.receipt,
     targetPath:view.plan.targetPath,admission:'recovery_required',activation:false};
   const value={...bodyRecord,digest:sha(B.stable(bodyRecord))},file=selectionPath(root),temp=file+'.prepared-'+view.plan.planId;
   fs.mkdirSync(path.dirname(file),{recursive:true});
   // Retain an exact pending config after interruption; a different config never wins.
   if(fs.existsSync(temp)){if(fs.readFileSync(temp,'utf8')!==B.stable(value))fail('import_selection_stage_conflict');}
   else{fs.writeFileSync(temp,B.stable(value),{flag:'wx',mode:0o600});const fd=fs.openSync(temp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
   fs.linkSync(temp,file);const fd=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   // No existing database is moved or rewritten. Block lazy creation/use until restart.
   service.suspendForImportAdoption();
   if(B.stable(selectionRecord(root,dataInstanceId))!==B.stable(value))fail('import_selection_readback_failed');
   return inspect(input);
 }
 return Object.freeze({summary,handle});
}
module.exports=Object.freeze({createWmImportControl,resolveWmImportSelection});
