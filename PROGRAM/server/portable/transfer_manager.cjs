'use strict';
// RE:TRACE-only, bounded file transport. Every call is authenticated by the
// existing manager router AND by an unpredictable, instance-bound session key.
// Upload/inspection never touches live stores. Only confirmed restore delegates
// to the existing plan/restore engine, including backup, CAS and reset epochs.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const {LIMITS,sha256File}=require('./stream_archive.cjs');
const REPLACE_WARNING='기존에 사용하던 데이터가 있습니다. 복원 작업을 진행시 기존 데이터는 복원된 데이터로 대체됩니다. 데이터 폴더를 미리 보존하신 후 사용을 권장합니다. 복원을 시작하시겠습니까?';
const fail=(code,statusCode=409)=>{throw Object.assign(Error(code),{statusCode});};
module.exports=function createPortableTransfers({dataDir,dataInstanceId,namespaces,databaseSchemaVersion,serverVersion='0.4.1',protocol={major:1,minor:9},createBackup,listBackups,managerControl,targetState,canStart}){
 const root=path.join(dataDir,'runtime','portable-transfers'),sessions=new Map(),operations=new Map();let closed=false,workerBusy=false;
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 // No in-memory transfer/confirmation authority survives a process restart.
 // Never remove backups/manual here; verified imported backups remain usable.
 for(const e of fs.readdirSync(root,{withFileTypes:true}))if(/^pt-[a-f0-9]{32}$/.test(e.name))fs.rmSync(path.join(root,e.name),{recursive:true,force:true});
 const publicState=s=>({schema:'memory-suite.portable-transfer.v1',transferId:s.id,transferToken:s.token,dataInstanceId,
  kind:s.kind,status:s.status,phase:s.phase,bytes:s.bytes||0,totalBytes:s.totalBytes||0,processedBytes:s.processedBytes||0,
  expandedBytes:s.expandedBytes||0,sha256:s.sha256||'',filename:(s.archiveKind==='logical_migration'?'Librarian-Migration-':'Librarian-Server-Backup-')+s.id.slice(3,11)+'.zip',
  chunkBytes:LIMITS.chunkBytes,expiresAt:s.expiresAt,backupId:s.backupId||'',error:s.error||'',plan:s.plan||null,
  namespaces:s.namespaces||[],reconnectRequired:s.reconnectRequired===true,restored:s.restored===true,
  coverage:s.coverage||{legacyOwners:s.namespaces||[]},result:s.result||null,archiveKind:s.archiveKind||'',migration:s.archiveKind==='logical_migration',verificationScope:s.archiveKind==='logical_migration'?'logical_server_data_rebuilt_to_current_schema':'server_snapshot_only',policyReviewRequired:true});
 const auth=(principal,b)=>{
  const s=sessions.get(String(b.transferId||''));
  if(!s||s.owner!==principal.pluginId||typeof b.transferToken!=='string'||b.transferToken!==s.token||Date.now()>s.expiresAt)fail('portable_transfer_not_found',404);
  s.expiresAt=Math.min(s.createdAt+2*60*60*1000,Date.now()+20*60*1000);return s;
 };
 const space=async bytes=>{const st=await fsp.statfs(root);const free=Number(st.bavail)*Number(st.bsize);if(!Number.isFinite(free)||free<bytes+64*1024**2)fail('portable_insufficient_disk_space',507);};
 const allocate=async(principal,b,kind)=>{
  if(closed)fail('portable_server_closing',503);
  if(!/^[a-zA-Z0-9_-]{8,128}$/.test(String(b.operationId||'')))fail('portable_operation_id_required',400);
  const op=principal.pluginId+'\0'+b.operationId,prior=operations.get(op),intent=JSON.stringify({kind,size:b.size||0,mode:String(b.mode||'')});
  if(prior){const s=sessions.get(prior.id);if(prior.intent!==intent)fail('portable_operation_id_conflict');if(s)return {s,existing:true};fail('portable_transfer_expired',410);}
  if(sessions.size>=3)fail('portable_transfer_limit',429);
  if(operations.size>=256){for(const [k,v] of operations){if(!sessions.has(v.id)){operations.delete(k);if(operations.size<256)break;}}if(operations.size>=256)fail('portable_operation_limit',429);}
  const reserved=[...sessions.values()].filter(s=>s.kind==='upload'&&s.status==='receiving').reduce((v,s)=>v+s.totalBytes,0);
  if(kind==='upload'&&reserved+Number(b.size)>LIMITS.maxTotalBytes)fail('portable_reservation_limit',429);
  const id='pt-'+crypto.randomBytes(16).toString('hex'),dir=path.join(root,id);fs.mkdirSync(dir,{mode:0o700});
  const s={id,token:crypto.randomBytes(32).toString('base64url'),owner:principal.pluginId,kind,dir,file:path.join(dir,'archive.zip'),createdAt:Date.now(),expiresAt:Date.now()+20*60*1000,status:'preparing',phase:'preparing',bytes:0,totalBytes:Number(b.size)||0,tail:Promise.resolve()};
  sessions.set(id,s);operations.set(op,{id,intent});return {s,existing:false};
 };
 const serial=(s,fn)=>{const p=s.tail.catch(()=>{}).then(fn);s.tail=p;return p;};
 const runWorker=(s,action,params)=>new Promise((resolve,reject)=>{
  if(workerBusy)return reject(Object.assign(Error('portable_worker_busy'),{statusCode:409}));workerBusy=true;
  const worker=new Worker(path.join(__dirname,'transfer_worker.cjs'),{workerData:{action,params}});s.worker=worker;let settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);s.worker=null;workerBusy=false;error?reject(error):resolve(result);};
  const timer=setTimeout(()=>{void worker.terminate();finish(Error('portable_worker_timeout'));},15*60*1000);timer.unref();
  worker.on('message',m=>{if(m.type==='progress'){s.phase=m.phase;s.processedBytes=m.processedBytes;s.expandedBytes=m.totalBytes;}if(m.type==='result')finish(null,m.result);if(m.type==='error')finish(Object.assign(Error(m.code),{statusCode:m.statusCode}));});
  worker.on('error',e=>finish(e));worker.on('exit',code=>{if(!settled)finish(Error(s.status==='cancelled'?'portable_cancelled':'portable_worker_exit_'+code));});
 });
 const launch=(s,fn)=>{s.task=(async()=>{try{await fn();}catch(e){if(s.status!=='cancelled'){s.status='failed';s.phase='failed';s.error=String(e?.message||'portable_failed').slice(0,200);}}finally{if(s.status==='cancelled')await fsp.rm(s.dir,{recursive:true,force:true}).catch(()=>{});}})();};
 const cleanup=async s=>{if(s.status==='restoring')fail('portable_restore_cannot_cancel');s.status='cancelled';s.phase='cancelled';if(s.worker)await s.worker.terminate();await s.tail.catch(()=>{});if(s.handle){await s.handle.close().catch(()=>{});s.handle=null;}if(s.task)await s.task;await fsp.rm(s.dir,{recursive:true,force:true}).catch(()=>{});sessions.delete(s.id);};
 const sweep=setInterval(()=>{for(const s of sessions.values())if(Date.now()>s.expiresAt&&s.status!=='restoring')void cleanup(s).catch(()=>{});},60000);sweep.unref();
 const handle=async(principal,action,b={})=>{
  if(!principal?.roles?.includes('manager'))fail('retrace_manager_capability_required',403);
  if(closed)fail('portable_server_closing',503);
  if(!b||Array.isArray(b)||typeof b!=='object')fail('portable_body_invalid',400);
  if(action==='capabilities')return {schema:'memory-suite.portable-capabilities.v1',dataInstanceId,limits:LIMITS,format:'zip32',fullNamespaces:namespaces,replaceWarning:REPLACE_WARNING,defaultExportMode:'migration',exportModes:['migration','snapshot'],migrationSchema:'librarian.portable-migration.v1',
    includes:['five_namespace_logical_records','tombstones','scope_catalog','portable_server_settings','inactive_operation_history'],excludes:['risuai_chat_database','plugin_only_data','api_keys','runtime_tokens','signing_keys','process_locks','global_source_rules','active_old_approvals']};
  if(action==='export-start'){
   const mode=String(b.mode||'snapshot')==='migration'?'migration':'snapshot';
   const {s,existing}=await allocate(principal,{...b,mode},'export');if(existing)return publicState(s);s.archiveKind=mode==='migration'?'logical_migration':'server_snapshot';
   launch(s,async()=>{if(!canStart()||workerBusy)fail('portable_maintenance_busy');s.phase='snapshot';const result=await createBackup();if(s.status==='cancelled')return;if(result?.ok!==true||!result.result?.id)fail('portable_snapshot_unverified');s.backupId=result.result.id;
    const backup=listBackups().find(x=>x.id===s.backupId);if(!backup||namespaces.some(ns=>!backup.stores?.[ns]))fail('portable_snapshot_incomplete');
    await space(Object.values(backup.stores).reduce((n,x)=>n+Number(x.bytes||0),0));
    const packed=await runWorker(s,'export',{mode,backupDir:backup.path,archivePath:s.file,sourceDataDir:dataDir,serverVersion,protocol,databaseSchemaVersion});if(s.status==='cancelled')return;
    s.archiveKind=packed.archiveKind||s.archiveKind;s.totalBytes=packed.bytes;s.sha256=packed.sha256;s.expandedBytes=packed.expandedBytes;s.coverage=packed.coverage||{legacyOwners:namespaces.slice()};s.namespaces=namespaces.slice();s.status='ready';s.phase='ready';s.result={archiveKind:s.archiveKind,migrationSchema:packed.migrationSchema||'',coverage:s.coverage};
   });return publicState(s);
  }
  if(action==='upload-start'){
   if(!Number.isSafeInteger(b.size)||b.size<22||b.size>LIMITS.maxArchiveBytes)fail('portable_archive_size_limit',413);
   await space(b.size);const {s,existing}=await allocate(principal,b,'upload');if(!existing){s.handle=await fsp.open(s.file,'wx+',0o600);s.status='receiving';s.phase='upload';}return publicState(s);
  }
  const s=auth(principal,b);
  if(action==='status')return publicState(s);
  if(action==='cancel'){await cleanup(s);return {ok:true,status:'cancelled',dataInstanceId};}
  if(action==='upload-chunk')return serial(s,async()=>{
   if(s.kind!=='upload'||s.status!=='receiving')fail('portable_upload_not_receiving');
   if(!Number.isSafeInteger(b.offset)||b.offset<0||typeof b.base64!=='string'||b.base64.length>Math.ceil(LIMITS.chunkBytes/3)*4||!b.base64.length||b.base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64))fail('portable_chunk_invalid',400);
   const bytes=Buffer.from(b.base64,'base64');if(!bytes.length||bytes.length>LIMITS.chunkBytes||bytes.toString('base64')!==b.base64||b.offset+bytes.length>s.totalBytes)fail('portable_chunk_bounds',400);
   const hash=crypto.createHash('sha256').update(bytes).digest('hex');if(b.sha256&&b.sha256!==hash)fail('portable_chunk_digest',422);
   if(b.offset<s.bytes){if(b.offset+bytes.length>s.bytes)fail('portable_chunk_overlap');const old=Buffer.alloc(bytes.length);const r=await s.handle.read(old,0,old.length,b.offset);if(r.bytesRead!==old.length||!old.equals(bytes))fail('portable_chunk_conflict');return {ok:true,receivedBytes:s.bytes,sha256:hash,idempotent:true};}
   if(b.offset!==s.bytes)fail('portable_chunk_out_of_order');
   let n=0;while(n<bytes.length){const w=await s.handle.write(bytes,n,bytes.length-n,b.offset+n);if(!w.bytesWritten)fail('portable_chunk_short_write',500);n+=w.bytesWritten;}
   s.bytes+=bytes.length;return {ok:true,receivedBytes:s.bytes,sha256:hash};
  });
  if(action==='upload-finish')return serial(s,async()=>{
   if(s.kind!=='upload')fail('portable_kind_invalid');if(['inspecting','ready'].includes(s.status))return publicState(s);
   if(s.status!=='receiving'||s.bytes!==s.totalBytes)fail('portable_upload_incomplete');if(workerBusy||!canStart())fail('portable_maintenance_busy');
   await space(Math.min(LIMITS.maxTotalBytes,Math.max(s.totalBytes*3,64*1024**2)));
   if(b.sha256&&!/^[a-f0-9]{64}$/.test(b.sha256))fail('portable_archive_digest_invalid',400);
   await s.handle.sync();await s.handle.close();s.handle=null;
   // Reserve extraction space before the worker begins. inspectZip also enforces
   // actual inflated limits; a claimed total cannot make the worker unbounded.
   s.status='inspecting';s.phase='inspecting';
   launch(s,async()=>{const imported=await runWorker(s,'import',{archivePath:s.file,backupRootManual:path.join(dataDir,'backups','manual'),stagingRoot:path.join(s.dir,'staging'),expectedDatabaseSchemaVersion:databaseSchemaVersion,requiredNamespaces:namespaces,expectedArchiveSha256:b.sha256||null,serverVersion});
    if(s.status==='cancelled')return;s.archiveKind=imported.archiveKind||'server_snapshot';s.sha256=imported.sha256;s.backupId=imported.backupId;const legacyManifest=imported.manifest;s.coverage={legacyOwners:Object.keys(legacyManifest.stores)};s.namespaces=Object.keys(legacyManifest.stores);s.expandedBytes=imported.expandedBytes;
    if(namespaces.some(ns=>!legacyManifest.stores?.[ns])||!legacyManifest.scopeCatalog)fail('portable_full_snapshot_required');
    s.status='ready';s.phase='ready';s.result={verified:true,archiveKind:s.archiveKind,migration:s.archiveKind==='logical_migration',importedFromId:imported.manifest.importedFromId||'',sourceVersion:imported.manifest.migrationAux?.source?.serverVersion||imported.manifest.serverVersion};
   });return publicState(s);
  });
  if(action==='download-chunk')return serial(s,async()=>{
   if(s.kind!=='export'||s.status!=='ready')fail('portable_download_not_ready');if(!Number.isSafeInteger(b.offset)||b.offset<0||b.offset>=s.totalBytes)fail('portable_download_offset',400);
   const length=Math.min(LIMITS.chunkBytes,s.totalBytes-b.offset),buf=Buffer.alloc(length),fd=await fsp.open(s.file,'r');try{let n=0;while(n<length){const r=await fd.read(buf,n,length-n,b.offset+n);if(!r.bytesRead)fail('portable_download_truncated',500);n+=r.bytesRead;}}finally{await fd.close();}
   return {offset:b.offset,totalBytes:s.totalBytes,base64:buf.toString('base64'),sha256:crypto.createHash('sha256').update(buf).digest('hex')};
  });
  if(action==='restore-plan'){
   if(s.kind!=='upload'||s.status!=='ready')fail('portable_import_not_ready');if(namespaces.some(ns=>!s.namespaces.includes(ns)))fail('portable_full_snapshot_required');
   const before=targetState();const p=await managerControl.handle('restore-plan',{backupId:s.backupId,namespaces:s.namespaces});
   s.plan={...p,hasExistingData:before.hasExistingData,existingRecords:before.records,existingTombstones:before.tombstones,confirmation:'RESTORE '+p.planId,warning:before.hasExistingData?REPLACE_WARNING:'빈 서버에 백업된 다섯 플러그인의 서버 자료를 복원합니다. 복원을 시작하시겠습니까?',dataInstanceId};return s.plan;
  }
  if(action==='restore-execute'){
   const p=s.plan;if(!p||s.kind!=='upload'||s.status!=='ready'||b.planId!==p.planId||b.confirmation!==p.confirmation)fail('portable_restore_plan_required');
   if(p.hasExistingData&&b.replaceAcknowledged!==true)fail('portable_existing_data_confirmation_required');
   s.status='restoring';s.phase='restoring';s.reconnectRequired=true;s.plan=null;
   launch(s,async()=>{const result=await managerControl.handle('restore-execute',{operationId:'portable-'+s.id+'-'+p.planId,planId:p.planId,confirmation:p.confirmation});s.result=result;s.restored=result.restored===true;s.status='restored';s.phase='restored';});return publicState(s);
  }
  fail('portable_action_invalid',404);
 };
 return {handle,async close(){closed=true;clearInterval(sweep);for(const s of [...sessions.values()]){if(s.status==='restoring')await s.task;else await cleanup(s).catch(()=>{});}}};
};
module.exports.REPLACE_WARNING=REPLACE_WARNING;
