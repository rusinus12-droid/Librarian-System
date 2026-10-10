'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

module.exports=function createManagerControl({dataDir,status,listBackups,createBackup,scrubBackups,planRestore,restore,canStart,fingerprint,advanceEpochs,extraHistory=()=>[],wmImportControl=null}){
 const file=path.join(dataDir,'migrations','manager-control.json');
 let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{operations:[]};
 const plans=new Map();let active=false;
 const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
 for(const row of state.operations)if(row.status==='running'){row.status='interrupted';row.error='server_restarted_check_result_before_retry';}
 save();
 const fail=(message,statusCode=409)=>{throw Object.assign(Error(message),{statusCode});};
 const publicBackups=()=>listBackups().map(b=>{const checked=state.operations.findLast(row=>row.action==='backup-check'&&row.status==='complete'&&row.result?.backupId===b.id);return {lastCheckAt:checked?.finishedAt,verifiedAtLastCheck:checked?.result?.verification?.ok,id:b.id,createdAt:b.createdAt,kind:b.kind,label:b.label,coverage:b.coverage||{legacyOwners:Object.keys(b.stores||{}),wm:'absent'},wm:b.components?.wm?{bytes:b.components.wm.bytes,snapshotId:b.components.wm.snapshotId,inventoryDigest:b.components.wm.inventoryDigest,domains:checked?.result?.verification?.results?.find(r=>r.backupId===b.id)?.wm?.domains||null}:null,stores:Object.fromEntries(Object.entries(b.stores||{}).map(([ns,s])=>[ns,{bytes:s.bytes,records:s.records}]))};});
 const backupIdentity=id=>JSON.stringify(listBackups().find(b=>b.id===id)||null);
 const run=async(action,body,task)=>{
   const id=String(body.operationId||'');if(!/^[a-zA-Z0-9_-]{8,160}$/.test(id))fail('control_operation_id_required',400);
   const intent=JSON.stringify({action,backupId:body.backupId,planId:body.planId});
   const prior=state.operations.find(r=>r.id===id);
   if(prior){if(prior.intent!==intent)fail('control_operation_id_conflict');if(prior.status==='complete')return prior.result;fail('control_operation_'+prior.status);}
   if(active||!canStart())fail('maintenance_in_progress');
   active=true;const row={id,action,intent,status:'running',startedAt:Date.now()};state.operations.push(row);
   try{save();const result=await task();row.status='complete';row.result=result;row.finishedAt=Date.now();save();return result;}
   catch(error){row.status='failed';row.error=String(error?.message||error);row.finishedAt=Date.now();save();throw error;}
   finally{active=false;}
 };
 return {async handle(action,body={}){
   if(action==='wm-import'){if(!wmImportControl)fail('wm_import_control_unavailable');if(active||!canStart())fail('maintenance_in_progress');active=true;try{return await wmImportControl.handle(body);}finally{active=false;}}
   if(action==='status')return {...status(),controlBusy:active};
   if(action==='backups')return publicBackups();
   if(action==='history')return [...state.operations.map(({intent,result,...row})=>({...row,backupId:result?.backupId||result?.result?.id,namespaces:result?.namespaces})),...extraHistory().filter(row=>!state.operations.some(op=>op.action===row.action&&op.status==='complete'&&op.result?.backupId===row.backupId&&row.action==='backup-create'))].sort((a,b)=>(b.finishedAt||b.startedAt||0)-(a.finishedAt||a.startedAt||0)).slice(0,100);
   if(action==='backup-create')return run(action,body,async()=>{const r=await createBackup();if(!r?.result?.id)fail('backup_result_unverified');return {backupId:r.result.id,coverage:r.result.coverage||{legacyOwners:Object.keys(r.result.stores||{}),wm:"absent"}};});
   if(action==='backup-check')return run(action,body,async()=>{if(!body.backupId||!listBackups().some(b=>b.id===body.backupId))fail('backup_not_found',404);const result=scrubBackups(body.backupId);return {backupId:body.backupId,verification:result};});
   if(action==='restore-plan'){
     if(active||!canStart())fail('maintenance_in_progress');
     if(!Array.isArray(body.namespaces)||!body.namespaces.length)fail('restore_namespace_required',400);
     const preview=planRestore(body.backupId,body.namespaces);
     if(preview.estimated?.spaceLikelySufficient===false)fail('restore_insufficient_space');
     for(const [id,p] of plans)if(p.expiresAt<Date.now())plans.delete(id);
     if(plans.size>=20)fail('restore_plan_limit');
     const id=crypto.randomUUID(),namespaces=preview.namespaces;
     const plan={id,backupId:preview.backupId,namespaces,expiresAt:Date.now()+120000,current:fingerprint(namespaces),backupIdentity:backupIdentity(preview.backupId),componentPlan:preview.schema==='memory-suite.restore-plan.v2'?preview:null};
     plans.set(id,plan);return {planId:id,backupId:plan.backupId,namespaces,expiresAt:plan.expiresAt,estimated:preview.estimated,backupCreatedAt:preview.backupCreatedAt,verified:preview.scrub?.ok===true,coverage:preview.coverage||{wm:'absent'},wm:preview.wm||null};
   }
   if(action==='restore-execute')return run(action,body,async()=>{
     const plan=plans.get(body.planId);if(!plan||Date.now()>=plan.expiresAt)fail('restore_plan_expired');
     if(body.confirmation!=='RESTORE '+plan.id)fail('restore_confirmation_required');
     if(plan.current!==fingerprint(plan.namespaces)||plan.backupIdentity!==backupIdentity(plan.backupId))fail('restore_plan_changed');
     plans.delete(plan.id);
     // restore() (server restoreBackup) is the single owner of restore-time
     // epoch advancement, so old clients are fenced there before the first
     // write. A failed restore still requires reconnection.
     const result=await restore(plan.backupId,plan.namespaces,plan.componentPlan?{componentPlan:plan.componentPlan,confirmation:plan.componentPlan.confirmation,expectedCurrentFingerprint:plan.componentPlan.expectedCurrentFingerprint}:{});
     if(result?.ok!==true)fail('restore_result_unverified');
     return {backupId:plan.backupId,namespaces:plan.namespaces,restored:true,reconnectRequired:true,coverage:result.result?.coverage||{wm:'absent'},wmAdmission:result.result?.wmAdmission||null,historicalAuthority:result.result?.historicalAuthority??null};
   });
   fail('control_action_not_found',404);
 }};
};
