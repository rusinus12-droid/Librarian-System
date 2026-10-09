'use strict';
// Only locally created, DATA/reset-bound server backups can grant authority.
// Candidate hashes, client paths and imported backup claims are never proofs.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {pathToFileURL}=require('node:url');
const MAX_BACKUP_BYTES=32*1024**2,MAX_VALUE_BYTES=2*1024**2;
const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:409});};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const jsonSha=value=>sha(JSON.stringify(value));
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),0x01000193);return(h>>>0).toString(36)};
const parse=v=>{try{return typeof v==='string'?JSON.parse(v):v}catch(_){return null}};
const stamp=s=>[String(s.dev),String(s.ino),s.size,s.mtimeMs,s.ctimeMs].join(':');
function openRegular(file,limit){const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0);let fd;
 try{if(fs.lstatSync(file).isSymbolicLink())fail('REPAIR_PROOF_PATH_INVALID');fd=fs.openSync(file,flags);const stat=fs.fstatSync(fd);if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<1||stat.size>limit)fail('REPAIR_PROOF_SIZE_LIMIT');return {fd,stat};}
 catch(error){if(fd!==undefined)fs.closeSync(fd);throw error;}}
function bytesFromFd(fd,size,destFd){const hash=crypto.createHash('sha256'),chunk=Buffer.alloc(Math.min(65536,size));let offset=0;
 while(offset<size){const n=fs.readSync(fd,chunk,0,Math.min(chunk.length,size-offset),offset);if(!n)fail('REPAIR_PROOF_FILE_CHANGED');hash.update(chunk.subarray(0,n));if(destFd!==undefined){let wrote=0;while(wrote<n)wrote+=fs.writeSync(destFd,chunk,wrote,n-wrote,offset+wrote);}offset+=n;}
 return hash.digest('hex');}
module.exports=({resolveBackupById,backupRoot,dataInstanceId,dataIdentityContract,epochs,readIdentity})=>({
 capture({backupId,binding,target,sourceRows}){
  let fd,manifestFd,tempDir,database;
  try{
   const assertPhysicalIdentity=()=>{if(typeof readIdentity!=='function')fail('REPAIR_STRONG_PROOF_REQUIRED');const physical=readIdentity();if(physical?.dataInstanceId!==dataInstanceId||physical?.dataIdentityContract!==dataIdentityContract)fail('REPAIR_PROOF_AUTHORITY_CHANGED');};
   assertPhysicalIdentity();
   if(typeof backupId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(backupId))fail('REPAIR_STRONG_PROOF_REQUIRED');
   if(typeof resolveBackupById!=='function')fail('REPAIR_STRONG_PROOF_REQUIRED');
   const backup=resolveBackupById(backupId),root=fs.realpathSync(backupRoot);
   if(backup?.id!==backupId)fail('REPAIR_BACKUP_AUTHORITY_INVALID');
   if(!backup||!['manual','auto'].includes(backup.kind)||Object.hasOwn(backup,'importedAt')||Object.hasOwn(backup,'importedFromId'))fail('REPAIR_BACKUP_AUTHORITY_INVALID');
   const dir=path.join(root,backup.kind,backupId);
   if(path.resolve(backup.path)!==dir||fs.realpathSync(dir)!==dir)fail('REPAIR_PROOF_PATH_INVALID');
   const manifestPath=path.join(dir,'manifest.json'),openedManifest=openRegular(manifestPath,128*1024);manifestFd=openedManifest.fd;
   const manifestBytes=Buffer.alloc(openedManifest.stat.size);if(fs.readSync(manifestFd,manifestBytes,0,manifestBytes.length,0)!==manifestBytes.length)fail('REPAIR_PROOF_FILE_CHANGED');
   const originalManifestSha=sha(manifestBytes),manifest=parse(manifestBytes.toString('utf8')),authority=manifest?.backupRepairAuthority;
   const currentEpochs=epochs();
   if(manifest?.schema!=='memory-suite.backup.v1'||manifest.id!==backupId||manifest.kind!==backup.kind||Object.hasOwn(manifest,'importedAt')||Object.hasOwn(manifest,'importedFromId')
     ||authority?.schema!=='memory-suite.backup-repair-authority.v1'||authority.dataInstanceId!==dataInstanceId||authority.dataInstanceId!==binding.dataInstanceId
     ||authority.dataIdentityContract!==dataIdentityContract||JSON.stringify(stable(authority.resetEpochs))!==JSON.stringify(stable(currentEpochs))
     ||Number(authority.resetEpochs?.flashback||0)!==binding.epoch)fail('REPAIR_BACKUP_AUTHORITY_INVALID');
   const meta=manifest.stores?.flashback;if(meta?.file!=='flashback.sqlite'||!/^[a-f0-9]{64}$/.test(meta.sha256||'')||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||meta.bytes>MAX_BACKUP_BYTES)fail('REPAIR_BACKUP_AUTHORITY_INVALID');
   const file=path.join(dir,'flashback.sqlite'),opened=openRegular(file,MAX_BACKUP_BYTES);fd=opened.fd;if(opened.stat.size!==meta.bytes)fail('REPAIR_PROOF_FILE_CHANGED');
   tempDir=fs.mkdtempSync(path.join(os.tmpdir(),'flashback-proof-'));const copy=path.join(tempDir,'snapshot.sqlite');let out;
   try{out=fs.openSync(copy,'wx',0o600);if(bytesFromFd(fd,opened.stat.size,out)!==meta.sha256)fail('REPAIR_PROOF_SHA_MISMATCH');fs.fsyncSync(out);}finally{if(out!==undefined)fs.closeSync(out);}
   if(stamp(fs.fstatSync(fd))!==stamp(opened.stat))fail('REPAIR_PROOF_FILE_CHANGED');
   database=new DatabaseSync(pathToFileURL(copy).href+'?mode=ro&immutable=1',{readOnly:true,allowExtension:false});database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
   if(database.prepare("SELECT type FROM sqlite_master WHERE name='kv'").get()?.type!=='table'||database.prepare('PRAGMA integrity_check(1)').get()?.integrity_check!=='ok')fail('REPAIR_BACKUP_DATABASE_INVALID');
   const read=(space,key)=>{const size=database.prepare('SELECT deleted,LENGTH(CAST(value_json AS BLOB)) AS n FROM kv WHERE space=? AND key=?').get(space,key);
    if(!size||size.deleted!==0||!Number.isSafeInteger(size.n)||size.n<1||size.n>MAX_VALUE_BYTES)fail('REPAIR_BACKUP_ROW_INVALID');
    const row=database.prepare('SELECT value_json,digest FROM kv WHERE space=? AND key=?').get(space,key);if(sha(row.value_json)!==row.digest)fail('REPAIR_BACKUP_ROW_DIGEST_INVALID');
    const value=parse(row.value_json);if(JSON.stringify(value)!==row.value_json)fail('REPAIR_BACKUP_ROW_INVALID');return {value,digest:row.digest};};
   if(!Array.isArray(sourceRows)||sourceRows.length<2||sourceRows.length>60)fail('REPAIR_BACKUP_SOURCE_INVALID');
   const prefix=`vector_rag_memory:scope:${hash(binding.scopeKey)}:`;
   for(const row of sourceRows){if(row.space!=='plugin'||!row.key.startsWith(prefix)||!row.expectedExists||!/^[a-f0-9]{64}$/.test(row.expectedDigest||''))fail('REPAIR_BACKUP_SOURCE_INVALID');if(read(row.space,row.key).digest!==row.expectedDigest)fail('REPAIR_BACKUP_SOURCE_CHANGED');}
   if(target.key!==`vector_rag_memory:local-vector-shard:v1:${hash(binding.scopeKey)}:${target.commitId}:${String(target.shardIndex).padStart(4,'0')}`)fail('REPAIR_BACKUP_TARGET_INVALID');
   const original=read('local',target.key),payload=parse(original.value);
   if(payload?.schema!=='flashback_memory.local_vector_shard.v1'||payload.scopeKey!==binding.scopeKey||payload.commitId!==target.commitId||payload.shardIndex!==target.shardIndex
    ||JSON.stringify(payload.items)!==JSON.stringify(target.items)||payload.floatCount!==target.floatCount||payload.itemCount!==target.items.length||payload.byteLength!==target.floatCount*4
    ||typeof payload.data!=='string'||payload.digest!==target.expectedDigest||hash(JSON.stringify({scopeKey:payload.scopeKey,commitId:payload.commitId,shardIndex:payload.shardIndex,items:payload.items,data:payload.data}))!==target.expectedDigest)fail('REPAIR_BACKUP_PAYLOAD_INVALID');
   const vectorBytes=Buffer.from(payload.data,'base64');if(vectorBytes.length!==payload.byteLength||vectorBytes.toString('base64')!==payload.data)fail('REPAIR_BACKUP_PAYLOAD_INVALID');
   for(const item of target.items){let nonzero=false;for(let i=item.offset;i<item.offset+item.length;i++){const v=vectorBytes.readFloatLE(i*4);if(!Number.isFinite(v))fail('REPAIR_BACKUP_PAYLOAD_INVALID');if(v!==0)nonzero=true;}if(!nonzero)fail('REPAIR_BACKUP_PAYLOAD_INVALID');}
   database.close();database=null;fs.rmSync(tempDir,{recursive:true,force:true});tempDir=null;
   let closed=false;
   const assertCurrent=()=>{assertPhysicalIdentity();if(closed||binding.dataInstanceId!==dataInstanceId||JSON.stringify(stable(epochs()))!==JSON.stringify(stable(authority.resetEpochs)))fail('REPAIR_PROOF_AUTHORITY_CHANGED');
    if(fs.lstatSync(file).isSymbolicLink()||fs.lstatSync(manifestPath).isSymbolicLink()||stamp(fs.statSync(file))!==stamp(opened.stat)||stamp(fs.fstatSync(fd))!==stamp(opened.stat)
      ||stamp(fs.statSync(manifestPath))!==stamp(openedManifest.stat)||stamp(fs.fstatSync(manifestFd))!==stamp(openedManifest.stat)
      ||bytesFromFd(fd,opened.stat.size)!==meta.sha256||bytesFromFd(manifestFd,openedManifest.stat.size)!==originalManifestSha)fail('REPAIR_PROOF_FILE_CHANGED');return true;};
   assertCurrent();
   const descriptor=Object.freeze({schema:'flashback.server-vector-proof.v1',backupId,backupSha256:meta.sha256,backupManifestSha256:originalManifestSha,
    payloadSha256:original.digest,vectorBytesSha256:sha(vectorBytes),sourceSha256:jsonSha(sourceRows.map(r=>[r.space,r.key,r.expectedDigest])),scopeKey:binding.scopeKey,targetKey:target.key,dataInstanceId,epoch:binding.epoch});
   // Ownership of both descriptors transfers to this returned proof.
   const retainedFd=fd,retainedManifestFd=manifestFd;
   return {descriptor,storedValue:original.value,assertCurrent,close:()=>{if(closed)return;closed=true;fs.closeSync(retainedFd);fs.closeSync(retainedManifestFd);}};
  }catch(error){if(database)database.close();if(tempDir)fs.rmSync(tempDir,{recursive:true,force:true});if(fd!==undefined)fs.closeSync(fd);if(manifestFd!==undefined)fs.closeSync(manifestFd);
   if(/^REPAIR_[A-Z_]+$/.test(error?.code||''))throw error;fail('REPAIR_STRONG_PROOF_UNAVAILABLE');}
 }
});
