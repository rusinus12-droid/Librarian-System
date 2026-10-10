'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

module.exports=({repository,listBackups,scrubBackup,canStart,onCommitted})=>{
 const plans=new Map();
 const fail=(code,statusCode=409)=>{throw Object.assign(new Error(code),{statusCode});};
 const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
 const digest=value=>{
  const body=typeof value==='string'?value:JSON.stringify(value??null);
  let hash=2166136261;
  for(let index=0;index<body.length;index++){
   hash^=body.charCodeAt(index);hash=Math.imul(hash,16777619);
  }
  hash^=31;hash=Math.imul(hash,16777619);
  return `${(hash>>>0).toString(16).padStart(8,'0')}:${body.length+1}`;
 };
 const parseStored=value=>{
  try{return typeof value==='string'?JSON.parse(value):value;}
  catch{fail('libra_native_archive_repair_record_invalid');}
 };
 const requiredText=(value,max=1200)=>{
  const result=String(value||'');
  if(!result||result.length>max||/[\r\n\0]/.test(result))fail('libra_native_archive_repair_input_invalid',400);
  return result;
 };
 const readBackupRecord=(database,key)=>{
  const row=database.prepare('SELECT value_json,deleted FROM kv WHERE space=? AND key=?').get('plugin',key);
  if(!row||row.deleted!==0||typeof row.value_json!=='string')fail('libra_native_archive_repair_backup_row_missing');
  let stored;
  try{stored=JSON.parse(row.value_json);}catch{fail('libra_native_archive_repair_backup_row_invalid');}
  return {stored,document:parseStored(stored)};
 };
 const matchingRef=(manifest,key)=>{
  const refs=Array.isArray(manifest?.inheritedMicroArchives)?manifest.inheritedMicroArchives:[];
  const matches=refs.filter(ref=>ref?.schema==='libra.micro_handoff_archive_ref.v1'&&ref.archiveKey===key);
  return matches.length===1?matches[0]:null;
 };
 const probe=({backupId,targetScopeKey,targetArchiveKey}={})=>{
  if(!canStart())fail('libra_native_archive_repair_busy');
  const backupKey=requiredText(backupId,512),scopeKey=requiredText(targetScopeKey,700);
  const archiveKey=requiredText(targetArchiveKey,4096);
  const prefix=`libra:v1:scope:${scopeKey}:`;
  if(!archiveKey.startsWith(prefix+'micro-handoff-archive:'))fail('libra_native_archive_repair_target_invalid');
  const manifestKey=prefix+'manifest';
  const manifestRow=repository.get('plugin',manifestKey);
  if(!manifestRow.exists)fail('libra_native_archive_repair_target_manifest_missing');
  const manifest=parseStored(manifestRow.value);
  const receipt=manifest?.nativeChatCopy;
  if(manifest?.schema!=='libra.manifest.v1'||manifest.scopeKey!==scopeKey
   ||receipt?.schema!=='libra.native_chat_copy.v2'||receipt.targetScopeKey!==scopeKey
   ||receipt.complete!==true||receipt.durableVerified!==true){
   fail('libra_native_archive_repair_target_identity_invalid');
  }
  const sourceScopeKey=requiredText(receipt.sourceScopeKey,700);
  const targetRef=matchingRef(manifest,archiveKey);
  if(!targetRef||targetRef.nativeCopiedFromScopeKey!==sourceScopeKey
   ||!targetRef.archiveDigest||!targetRef.sourceScopeKey){
   fail('libra_native_archive_repair_target_ref_invalid');
  }
  const currentArchive=repository.get('plugin',archiveKey);
  if(currentArchive.exists)fail('libra_native_archive_repair_target_not_missing');
  const deleted=repository.database.prepare(
   'SELECT scope_id FROM libra_deleted_owner_scopes WHERE scope_key=? AND backup_id=?'
  ).all(sourceScopeKey,backupKey);
  if(deleted.length!==1)fail('libra_native_archive_repair_deletion_proof_missing');
  const backup=listBackups().find(row=>row.id===backupKey);
  if(!backup||backup.kind!=='manual'||backup.label!=='pre-owner-scope-delete'
   ||backup.stores?.libra?.file!=='libra.sqlite'){
   fail('libra_native_archive_repair_backup_invalid');
  }
  const scrub=scrubBackup(backup,['libra']);
  if(scrub.ok!==true||scrub.stores?.libra?.ok!==true)fail('libra_native_archive_repair_backup_unverified');
  const database=new DatabaseSync(path.join(backup.path,'libra.sqlite'),{readOnly:true});
  let backupManifest,backupArchive;
  try{
   backupManifest=readBackupRecord(database,manifestKey).document;
   backupArchive=readBackupRecord(database,archiveKey);
  }finally{database.close();}
  const oldReceipt=backupManifest?.nativeChatCopy;
  const oldRef=matchingRef(backupManifest,archiveKey);
  if(backupManifest?.schema!=='libra.manifest.v1'||backupManifest.scopeKey!==scopeKey
   ||oldReceipt?.schema!=='libra.native_chat_copy.v2'
   ||oldReceipt.sourceScopeKey!==sourceScopeKey||oldReceipt.targetScopeKey!==scopeKey
   ||oldRef?.archiveDigest!==targetRef.archiveDigest
   ||oldRef?.sourceScopeKey!==targetRef.sourceScopeKey
   ||oldRef?.nativeCopiedFromScopeKey!==sourceScopeKey){
   fail('libra_native_archive_repair_backup_binding_invalid');
  }
  const archive=backupArchive.document;
  const {archiveDigest,...archiveCore}=archive&&typeof archive==='object'?archive:{};
  if(archive?.schema!=='libra.micro_handoff_archive.v1'
   ||archive.sourceScopeKey!==targetRef.sourceScopeKey
   ||archiveDigest!==targetRef.archiveDigest
   ||!Array.isArray(archive.records)
   ||archive.recordCount!==archive.records.length
   ||archive.recordsDigest!==digest(archive.records.map(row=>({key:row.key,valueDigest:digest(row.value)})))
   ||archiveDigest!==digest(archiveCore)){
   fail('libra_native_archive_repair_backup_archive_invalid');
  }
  const basis={backupId:backupKey,backupSha256:backup.stores.libra.sha256,
   deletedScopeId:deleted[0].scope_id,sourceScopeKey,targetScopeKey:scopeKey,
   targetArchiveKey:archiveKey,targetManifestRevision:manifestRow.revision,
   targetManifestDigest:manifestRow.digest,missingRevision:currentArchive.revision,
   missingDigest:currentArchive.digest,missingTombstone:currentArchive.tombstone,
   archiveSha256:sha(JSON.stringify(backupArchive.stored)),archiveDigest};
  return {...basis,manifestKey,storedArchive:backupArchive.stored,
   fingerprint:sha(JSON.stringify(basis))};
 };
 const plan=body=>{
  const verified=probe(body);
  for(const [id,row] of plans)if(row.expiresAt<Date.now())plans.delete(id);
  if(plans.size>=32)fail('libra_native_archive_repair_plan_limit');
  const planId=crypto.randomUUID(),expiresAt=Date.now()+120000;
  const basis={...verified};delete basis.storedArchive;
  plans.set(planId,{...basis,expiresAt});
  return {schema:'libra.native_archive_backup_repair_plan.v1',planId,
   fingerprint:verified.fingerprint,expiresAt,backupId:verified.backupId,
   sourceScopeKey:verified.sourceScopeKey,targetScopeKey:verified.targetScopeKey,
   archiveKey:verified.targetArchiveKey,archiveDigest:verified.archiveDigest,
   nativeCopyCompleteness:'pending_revalidation'};
 };
 const execute=body=>{
  const entry=plans.get(String(body?.planId||''));
  if(!entry||entry.expiresAt<Date.now()||entry.fingerprint!==body?.fingerprint){
   fail('libra_native_archive_repair_plan_stale');
  }
  if(entry.result)return entry.result;
  const fresh=probe(entry);
  if(fresh.fingerprint!==entry.fingerprint)fail('libra_native_archive_repair_source_changed');
  repository.applyConditionalBatch([
   {kind:'check',space:'plugin',key:entry.manifestKey,expectedRevision:entry.targetManifestRevision,
    expectedDigest:entry.targetManifestDigest,expectedExists:true,expectedTombstone:false},
   {kind:'set',space:'plugin',key:entry.targetArchiveKey,value:fresh.storedArchive,
    expectedRevision:entry.missingRevision,expectedDigest:entry.missingDigest,
    expectedExists:false,expectedTombstone:entry.missingTombstone}
  ],{operationId:`libra-native-archive-repair:${body.planId}`});
  onCommitted();
  const readback=repository.get('plugin',entry.targetArchiveKey);
  const currentManifest=repository.get('plugin',entry.manifestKey);
  if(!readback.exists||readback.value!==fresh.storedArchive
   ||currentManifest.revision!==entry.targetManifestRevision
   ||currentManifest.digest!==entry.targetManifestDigest){
   fail('libra_native_archive_repair_readback_failed');
  }
  const result={schema:'libra.native_archive_backup_repair_receipt.v1',ok:true,
   durable:true,physicalReadback:true,reloadRequired:true,backupId:entry.backupId,
   sourceScopeKey:entry.sourceScopeKey,targetScopeKey:entry.targetScopeKey,
   archiveKey:entry.targetArchiveKey,archiveDigest:entry.archiveDigest,
   nativeCopyCompleteness:'pending_revalidation'};
  entry.result=result;
  return result;
 };
 return {plan,execute};
};
