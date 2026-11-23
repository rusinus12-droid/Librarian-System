'use strict';
const crypto=require('node:crypto');
const collectLocalVectorKeys=(node,out=new Set(),seen=new Set(),depth=0)=>{
 if(depth>8||node==null)return out;
 if(typeof node==='string'){if(node.startsWith('libra:v1:local-vector:'))out.add(node);return out;}
 if(typeof node!=='object'||seen.has(node))return out;
 seen.add(node);
 if(Array.isArray(node)){for(const item of node.slice(0,2048))collectLocalVectorKeys(item,out,seen,depth+1);return out;}
 for(const value of Object.values(node).slice(0,1200))collectLocalVectorKeys(value,out,seen,depth+1);
 return out;
};
module.exports=({repositories,backup,canStart,setMaintenance,advanceEpochs,getProtection,onDeleted})=>{
 const plans=new Map();let busy=false;
 const fail=code=>{throw Object.assign(Error(code),{statusCode:409});};
 const inventory=scopeKey=>{
  const prefix='libra:v1:scope:'+scopeKey+':';
  // Only live rows are owned data to remove. A tombstone under an overlapping
  // sibling prefix must not become an exact-key fence for the deleted scope.
  const pluginRows=repositories.libra.list('plugin',prefix).records
   .filter(row=>!row.tombstone);
  const storedValue=row=>{
   let value=repositories.libra.get(row.space,row.key).value;
   if(typeof value==='string'){
    try{value=JSON.parse(value);}catch{fail('owner_scope_delete_owner_unverified');}
   }
   return value;
  };
  const manifestBySpace=new Map(pluginRows.filter(row=>row.key===prefix+'manifest')
   .map(row=>[row.space,storedValue(row)]));
  // Scope keys can contain ':'. A prefix match alone cannot distinguish the
  // requested owner from a live descendant scope with its own manifest.
  // Refuse the operation before taking a backup or writing any tombstones.
  if(pluginRows.some(row=>row.key!==prefix+'manifest'&&row.key.endsWith(':manifest'))){
   fail('owner_scope_delete_overlapping_scope');
  }
  const ownedLocalVectorKeys=new Set();
  for(const row of pluginRows){
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
   if(/(?:^|:)(?:vector|predecessor-vector):/.test(row.key))collectLocalVectorKeys(value,ownedLocalVectorKeys);
  }
  const otherReferencedLocalKeys=new Set();
  if(ownedLocalVectorKeys.size>0){
   const allVectorRows=repositories.libra.list('plugin','libra:v1:scope:').records
    .filter(row=>!row.tombstone&&!row.key.startsWith(prefix)&&/(?:^|:)(?:vector|predecessor-vector):/.test(row.key));
   for(const row of allVectorRows){
    let value=repositories.libra.get(row.space,row.key).value;
    if(typeof value==='string'){try{value=JSON.parse(value);}catch{value=null;}}
    if(value&&typeof value==='object')collectLocalVectorKeys(value,otherReferencedLocalKeys);
   }
  }
  const localVectorRows=[];
  for(const localKey of ownedLocalVectorKeys){
   if(otherReferencedLocalKeys.has(localKey))continue;
   const entry=repositories.libra.get('local',localKey);
   if(entry?.exists&&!entry.tombstone){
    localVectorRows.push({space:'local',key:localKey,revision:entry.revision,digest:entry.digest,tombstone:false,updatedAt:entry.updatedAt});
   }
  }
  return [...pluginRows,...localVectorRows].sort((a,b)=>(a.space+'\n'+a.key).localeCompare(b.space+'\n'+b.key));
 };
 const assertNotReferencedAncestor=scopeKey=>{
  const protection=typeof getProtection==='function'?getProtection(scopeKey):null;
  if(protection?.pinned||protection?.referenceCount>0||protection?.classification==='referenced_ancestor'){
   fail('owner_scope_delete_referenced_ancestor');
  }
  const prefix='libra:v1:scope:'+scopeKey+':';
  const manifests=repositories.libra.list('plugin','libra:v1:scope:').records
   .filter(row=>!row.tombstone&&row.key!==prefix+'manifest'&&row.key.endsWith(':manifest'));
  for(const row of manifests){
   let manifest=repositories.libra.get(row.space,row.key).value;
   if(typeof manifest==='string'){try{manifest=JSON.parse(manifest);}catch{manifest=null;}}
   if(!manifest||typeof manifest!=='object')continue;
   if(manifest.scopeKey===scopeKey)continue;
   if(manifest?.archiveRef?.archiveScopeKey===scopeKey
    ||manifest.sourceScopeKey===scopeKey
    ||manifest.copiedFromScopeKey===scopeKey
    ||(Array.isArray(manifest.inheritedMicroArchives)&&manifest.inheritedMicroArchives.some(ref=>ref?.sourceScopeKey===scopeKey))){
    fail('owner_scope_delete_referenced_ancestor');
   }
  }
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
   assertNotReferencedAncestor(scopeKey);
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
   assertNotReferencedAncestor(plan.scopeKey);
   if(digest(inventory(plan.scopeKey))!==plan.fingerprint)fail('owner_scope_delete_scope_changed');
   const saved=await backup('manual','pre-owner-scope-delete');
   if(saved?.ok!==true||!saved.result?.id)fail('owner_scope_delete_backup_unverified');
   if(!canStart())fail('owner_scope_delete_busy');
   assertNotReferencedAncestor(plan.scopeKey);
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
    try{onDeleted?.(plan.scopeKey);}catch(_){}
    plans.delete(plan.planId);
    return {ok:true,durable:true,verified:true,scopeId:plan.scopeId,scopeKey:plan.scopeKey,deleted:plan.count,backupId:saved.result.id,reloadRequired:true};
   }finally{setMaintenance(false);}
  }finally{busy=false;}
 };
};
