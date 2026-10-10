'use strict';
const crypto=require('node:crypto');
module.exports=({repositories,backup,canStart,setMaintenance,advanceEpochs})=>{
 const plans=new Map();let busy=false;
 const fail=code=>{throw Object.assign(Error(code),{statusCode:409});};
 const inventory=scopeKey=>{
  const prefix='libra:v1:scope:'+scopeKey+':';
  // Only live rows are owned data to remove. A tombstone under an overlapping
  // sibling prefix must not become an exact-key fence for the deleted scope.
  const rows=['plugin','local'].flatMap(space=>repositories.libra.list(space,prefix).records)
   .filter(row=>!row.tombstone)
   .sort((a,b)=>(a.space+'\n'+a.key).localeCompare(b.space+'\n'+b.key));
  const storedValue=row=>{
   let value=repositories.libra.get(row.space,row.key).value;
   if(typeof value==='string'){
    try{value=JSON.parse(value);}catch{fail('owner_scope_delete_owner_unverified');}
   }
   return value;
  };
  const manifestBySpace=new Map(rows.filter(row=>row.key===prefix+'manifest')
   .map(row=>[row.space,storedValue(row)]));
  // Scope keys can contain ':'. A prefix match alone cannot distinguish the
  // requested owner from a live descendant scope with its own manifest.
  // Refuse the operation before taking a backup or writing any tombstones.
  if(rows.some(row=>row.key!==prefix+'manifest'&&row.key.endsWith(':manifest'))){
   fail('owner_scope_delete_overlapping_scope');
  }
  for(const row of rows){
   const value=storedValue(row);
   const claimedScopeKey=typeof value?.scopeKey==='string'?value.scopeKey
    :typeof value?.binding?.scopeKey==='string'?value.binding.scopeKey
    :typeof value?.scope?.scopeKey==='string'?value.scope.scopeKey:'';
   if(!claimedScopeKey){
    const manifest=manifestBySpace.get(row.space);
    const archiveRef=value?.schema==='libra.micro_handoff_archive.v1'
     &&manifest?.scopeKey===scopeKey
     &&Array.isArray(manifest.inheritedMicroArchives)
     &&manifest.inheritedMicroArchives.find(ref=>ref?.archiveKey===row.key
      &&ref?.archiveDigest===value.archiveDigest
      &&ref?.sourceScopeKey===value.sourceScopeKey);
    if(archiveRef)continue;
    fail('owner_scope_delete_owner_unverified');
   }
   if(claimedScopeKey!==scopeKey)fail(row.key.startsWith('libra:v1:scope:'+claimedScopeKey+':')
    ?'owner_scope_delete_overlapping_scope':'owner_scope_delete_owner_unverified');
  }
  return rows;
 };
 const digest=rows=>crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 return async(principal,action,body,requestScopeId)=>{
  if(principal?.namespace!=='libra')throw Object.assign(Error('owner_scope_delete_forbidden'),{statusCode:403});
  const scopeId=String(requestScopeId||'');
  if(!scopeId||scopeId.length>1200||/[\r\n\0]/.test(scopeId))fail('owner_scope_delete_scope_id_required');
  if(action==='plan'){
   const scopeKey=String(body.scopeKey||'');
   if(!scopeKey||scopeKey.length>512||/[\r\n\0]/.test(scopeKey))fail('owner_scope_delete_scope_invalid');
   if(repositories.libra.isOwnerScopeDeleted(scopeId))fail('owner_scope_already_deleted');
   const rows=inventory(scopeKey);if(rows.length>4096)fail('owner_scope_delete_item_limit');
   const plan={planId:crypto.randomUUID(),scopeId,scopeKey,namespace:'libra',count:rows.filter(r=>!r.tombstone).length,records:rows.length,fingerprint:digest(rows),expiresAt:Date.now()+120000};
   for(const [id,p] of plans)if(p.expiresAt<Date.now())plans.delete(id);
   plans.set(plan.planId,plan);return plan;
  }
  if(action!=='execute')fail('owner_scope_delete_action_invalid');
  const plan=plans.get(String(body.planId));
  if(!plan||plan.expiresAt<Date.now()||scopeId!==plan.scopeId||body.scopeKey!==plan.scopeKey||body.fingerprint!==plan.fingerprint)fail('owner_scope_delete_plan_stale');
  if(busy||!canStart())fail('owner_scope_delete_busy');
  busy=true;
  try{
   if(digest(inventory(plan.scopeKey))!==plan.fingerprint)fail('owner_scope_delete_scope_changed');
   const saved=await backup('manual','pre-owner-scope-delete');
   if(saved?.ok!==true||!saved.result?.id)fail('owner_scope_delete_backup_unverified');
   if(!canStart())fail('owner_scope_delete_busy');
   const rows=inventory(plan.scopeKey);
   if(digest(rows)!==plan.fingerprint||plan.expiresAt<Date.now())fail('owner_scope_delete_scope_changed');
   setMaintenance(true);
   try{
    // Fence already running clients before the atomic namespace transaction.
    advanceEpochs(['libra']);
    repositories.libra.applyConditionalBatch(rows.map(r=>({kind:'remove',space:r.space,key:r.key,expectedRevision:r.revision,expectedDigest:r.digest,expectedExists:!r.tombstone,expectedTombstone:r.tombstone})),{
     maintenance:true,operationId:'scope-delete:'+plan.planId,
     ownedScopeDeletion:{scopeId:plan.scopeId,scopeKey:plan.scopeKey,backupId:saved.result.id}
    });
    if(inventory(plan.scopeKey).some(r=>!r.tombstone)||!repositories.libra.isOwnerScopeDeleted(plan.scopeId))fail('owner_scope_delete_readback_failed');
    plans.delete(plan.planId);
    return {ok:true,durable:true,verified:true,scopeId:plan.scopeId,scopeKey:plan.scopeKey,deleted:plan.count,backupId:saved.result.id,reloadRequired:true};
   }finally{setMaintenance(false);}
  }finally{busy=false;}
 };
};
