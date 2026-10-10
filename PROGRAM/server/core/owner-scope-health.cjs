'use strict';
// Read-only point-in-time inventory. The server does not interpret memory facts;
// the LIBRA owner classifies the returned bounded structural records.
const crypto=require('node:crypto');
module.exports=({getRepository,dataInstanceId,epochs,canRead})=>async(principal,body)=>{
 const fail=(message,statusCode)=>{throw Object.assign(Error(message),{statusCode});};
 if(principal?.namespace!=='libra'||!principal.roles?.includes('owner'))fail('owner_scope_health_forbidden',403);
 const scopeKey=body?.scopeKey;if(typeof scopeKey!=='string'||!scopeKey||scopeKey.length>512||/[\r\n\0]/.test(scopeKey))fail('owner_scope_health_scope_invalid',400);
 if(!canRead())fail('owner_scope_health_maintenance',503);
 const repository=getRepository();
 const prefix='libra:v1:scope:'+scopeKey+':',records=[],values=[],skipped=[];let bytes=0,complete=true;
 const selected=name=>['manifest','continuity-state','entity-registry:v2','state-corrections:v2','state-correction-meta:v1','state-correction-commit:v1','state-tracking-journal:v1','state-replay-errors:v1'].includes(name)||/^(?:entity-registry:v2:unified-(?:tx:|replay-tx:|vector-tx:|active:)|state-pipeline-receipt:)/.test(name);
 repository.database.exec('BEGIN');
 try{
  for(const space of ['plugin','local']){
   const page=repository.list(space,prefix,{paged:true,limit:4096,cursorKey:''});if(page.page?.hasMore)complete=false;
   for(const row of page.records){if(!row.key.startsWith(prefix))fail('owner_scope_health_prefix_mismatch',500);records.push({...row,name:row.key.slice(prefix.length)});}
  }
  records.sort((a,b)=>a.space.localeCompare(b.space)||a.key.localeCompare(b.key));
  for(const r of records){
   if(r.tombstone||!selected(r.name))continue;
   if(r.valueBytes>2*1024**2||bytes+r.valueBytes>8*1024**2){skipped.push({name:r.name,space:r.space,reason:'size_limit'});continue;}
   try{const value=repository.get(r.space,r.key);if(!value.exists||value.digest!==r.digest||value.revision!==r.revision)fail('owner_scope_health_snapshot_mismatch',500);bytes+=r.valueBytes;values.push({name:r.name,space:r.space,value:value.value});}
   catch(error){skipped.push({name:r.name,space:r.space,reason:'read_or_decode_failed'});}
  }
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
  return {schema:'libra.scope-health-snapshot.v1',scopeKey,dataInstanceId,epoch:epochs().libra,at:Date.now(),readOnly:true,
   complete:complete&&skipped.length===0,inventoryComplete:complete,liveRecords:records.filter(r=>!r.tombstone).length,tombstones:records.filter(r=>r.tombstone).length,
   fingerprint,records:records.map(({name,space,tombstone,revision,digest,valueBytes})=>({name,space,tombstone,revision,digest,valueBytes})),values,skipped};
 }finally{repository.database.exec('ROLLBACK');}
};
