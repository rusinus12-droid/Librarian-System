'use strict';

const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {exportLogicalMigration,NAMESPACES,createCurrentSchema}=require('../server/portable/logical_migration.cjs');
const {assertPersistentDataFilesystemInventory}=require('../server/portable/migration_data_policy.cjs');
const {assertNoAuthorityFilesystemEvidence,assertNoAuthorityDatabaseFile,assertNoAuthorityAncestry}=require('../server/authority/maintenance-admission.cjs');
const MAX_MAIN_BYTES=2*1024**3,MAX_TOTAL_BYTES=4*1024**3,COPY_CHUNK_BYTES=256*1024,FREE_RESERVE_BYTES=64*1024**2;
const refusal=reason=>Object.assign(Error('AUTHORITY_QUARANTINED: stopped source cannot be qualified; preserve DATA and retained inspection evidence.'),{code:'AUTHORITY_QUARANTINED',statusCode:503,reason});
const sha256File=file=>{const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),b=Buffer.allocUnsafe(1024*1024);try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');};
const parse=argv=>{const out={};for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--source-data-dir')out.source=argv[++i];else if(a==='--output')out.output=argv[++i];else if(a==='--server-version')out.version=argv[++i];else throw Error('portable_export_argument_invalid:'+a);}if(!out.source||!out.output)throw Error('usage: --source-data-dir <old DATA> --output <migration.zip>');return out;};
const readJson=(f,x=null)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch(_){return x;}};
const entry=file=>{try{const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink())throw refusal('source_file_type');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const stamp=s=>s?['dev','ino','mode','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':'):null;
function sourceClosure(source){const out={};for(const ns of NAMESPACES)for(const suffix of ['','-wal','-shm','-journal']){const file=path.join(source,'stores',ns,ns+'.sqlite'+suffix);out[file]=stamp(entry(file));}return out;}
function ensureStopped(source){
 const journal=path.join(source,'migrations','restore-transaction.json');if(fs.existsSync(journal))throw Error('source_restore_transaction_present_repair_before_export');
 for(const ns of NAMESPACES){const db=path.join(source,'stores',ns,`${ns}.sqlite`);for(const suffix of ['-wal','-shm','-journal']){const s=entry(db+suffix);if(s&&s.size>0n){if(suffix==='-journal')throw refusal('source_hot_journal');throw Error(`source_hot_${suffix.slice(1)}_detected:${ns}`);}}}
}
function copyMainBounded(source,dest,expected,budget){
 let input,output,primaryFailure=null;const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(COPY_CHUNK_BYTES);let bytes=0;
 try{
  input=fs.openSync(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
  const opened=fs.fstatSync(input,{bigint:true});if(!opened.isFile()||stamp(opened)!==stamp(expected))throw refusal('source_copy_identity_changed');
  output=fs.openSync(dest,'wx',0o600);
  while(true){const n=fs.readSync(input,buffer,0,buffer.length,null);if(!n)break;bytes+=n;budget.bytes+=n;if(bytes>MAX_MAIN_BYTES||budget.bytes>MAX_TOTAL_BYTES||BigInt(bytes)>expected.size)throw refusal('source_copy_byte_limit');hash.update(buffer.subarray(0,n));let written=0;while(written<n){const count=fs.writeSync(output,buffer,written,n-written);if(!count)throw refusal('source_copy_short_write');written+=count;}}
  if(BigInt(bytes)!==expected.size||stamp(fs.fstatSync(input,{bigint:true}))!==stamp(expected)||stamp(entry(source))!==stamp(expected))throw refusal('source_copy_changed');
  return{size:bytes,sha:hash.digest('hex')};
 }catch(e){primaryFailure=e;throw e;}finally{let closeFailed=false;for(const fd of [output,input])if(fd!==undefined){try{fs.closeSync(fd);}catch(_){closeFailed=true;}}if(closeFailed){if(primaryFailure?.code==='AUTHORITY_QUARANTINED')primaryFailure.closeFailed=true;else throw refusal('source_copy_close_failed');}}
}
function assertOutputAbsent(output){
 try{fs.lstatSync(output);}catch(e){if(e.code==='ENOENT')return;throw e;}
 throw Error('migration_output_exists');
}
function publishArchiveNoReplace(unpublished,output){
 assertOutputAbsent(output);
 try{fs.linkSync(unpublished,output);}catch(e){
  if(e.code==='EEXIST')throw Error('migration_output_exists');
  throw Object.assign(Error('AUTHORITY_QUARANTINED: Atomic no-overwrite archive publication is unavailable or could not be confirmed. The complete archive is retained; check the destination and use a hardlink-capable filesystem before retrying.'),{code:'AUTHORITY_QUARANTINED',statusCode:503,reason:'archive_publication_unavailable'});
 }
}
async function exportStopped(options){
 const source=path.resolve(options.source),output=path.resolve(options.output);
 if(output.startsWith(source+path.sep))throw Error('migration_output_must_be_outside_source_data');
 assertPersistentDataFilesystemInventory(source);ensureStopped(source);if(fs.existsSync(output))throw Error('migration_output_exists');assertNoAuthorityAncestry(output);
 const closure=sourceClosure(source),originals=new Map();let total=0;
 for(const ns of NAMESPACES){const file=path.join(source,'stores',ns,ns+'.sqlite'),s=entry(file);if(!s)continue;if(s.size>BigInt(MAX_MAIN_BYTES))throw refusal('source_main_byte_limit');total+=Number(s.size);if(total>MAX_TOTAL_BYTES)throw refusal('source_total_byte_limit');originals.set(ns,{file,stat:s});}
 const disk=await fsp.statfs(path.dirname(output));if(Number(disk.bavail)*Number(disk.bsize)<total+FREE_RESERVE_BYTES)throw refusal('source_copy_insufficient_space');
 const temp=await fsp.mkdtemp(path.join(path.dirname(output),'.librarian-stopped-export-')),backup=path.join(temp,'snapshot');let retain=false;
 try{
  await fsp.mkdir(backup,{recursive:true,mode:0o700});const before=new Map(),budget={bytes:0};
  // Copy first, then qualify the complete five-owner set. No source SQLite open.
  for(const ns of NAMESPACES){const src=originals.get(ns);if(src)before.set(src.file,copyMainBounded(src.file,path.join(backup,ns+'.sqlite'),src.stat,budget));}
  for(const ns of NAMESPACES)assertNoAuthorityDatabaseFile(path.join(backup,ns+'.sqlite'));
  for(const ns of NAMESPACES)if(!originals.has(ns)){const db=new DatabaseSync(path.join(backup,ns+'.sqlite'));try{createCurrentSchema(db,ns,options.version||'0.5.0');}finally{db.close();}}
  const stores={};
  for(const ns of NAMESPACES){const dest=path.join(backup,ns+'.sqlite'),db=new DatabaseSync(dest,{readOnly:true});try{const integrity=String(db.prepare('PRAGMA integrity_check').get()?.integrity_check||'');if(integrity!=='ok')throw Error(`source_database_integrity_failed:${ns}:${integrity}`);const count=Number(db.prepare('SELECT COUNT(*) AS c FROM kv').get()?.c||0),live=Number(db.prepare('SELECT COUNT(*) AS c FROM kv WHERE deleted=0').get()?.c||0),tomb=Number(db.prepare('SELECT COUNT(*) AS c FROM kv WHERE deleted=1').get()?.c||0);stores[ns]={file:`${ns}.sqlite`,sha256:'',bytes:fs.statSync(dest).size,records:count,liveRecords:live,tombstones:tomb};}finally{db.close();}stores[ns].sha256=sha256File(dest);}
  const scopeSrc=path.join(source,'config','scope-catalog.json'),scopeDest=path.join(backup,'scope-catalog.json'),catalog=fs.existsSync(scopeSrc)?readJson(scopeSrc,null):{schema:'memory-suite.scope-catalog.v1',updatedAt:0,namespaces:{}};if(!catalog||catalog.schema!=='memory-suite.scope-catalog.v1')throw Error('source_scope_catalog_invalid');fs.writeFileSync(scopeDest,JSON.stringify(catalog,null,2)+'\n');
  const layout=readJson(path.join(source,'data-layout.json'),{}),created=Date.now(),manifest={schema:'memory-suite.backup.v1',id:'offline-'+created,kind:'manual',label:'offline-logical-migration-source',createdAt:new Date(created).toISOString(),createdAtMs:created,serverVersion:String(layout.lastServerVersion||layout.lastProgramVersion||options.version||'legacy'),protocol:{major:1,minor:9},databaseSchemaVersion:1,scopeCatalog:{file:'scope-catalog.json',sha256:sha256File(scopeDest),bytes:fs.statSync(scopeDest).size,source:'offline'},stores};fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const verifyPublicationInputs=()=>{
   assertPersistentDataFilesystemInventory(source);
   try{ensureStopped(source);if(JSON.stringify(sourceClosure(source))!==JSON.stringify(closure))throw refusal('source_closure_changed');}catch(e){if(e.code==='AUTHORITY_QUARANTINED')throw e;throw refusal('source_closure_changed');}
   for(const[file,s]of before)if(!fs.existsSync(file)||fs.statSync(file).size!==s.size||sha256File(file)!==s.sha)throw Error('source_data_changed_during_export');
   assertNoAuthorityAncestry(output);
  };
  verifyPublicationInputs();
  const unpublished=path.join(temp,'unpublished.zip');
  const result=await exportLogicalMigration({backupDir:backup,archivePath:unpublished,sourceDataDir:source,serverVersion:options.version||'0.5.0',protocol:{major:1,minor:9},databaseSchemaVersion:1});
  // Packaging yields. Recheck AFTER it settles, then publish without an await
  // gap. Atomic hardlink creation cannot overwrite a competing output. This
  // is an observed-input check, not a writer fence or filesystem-wide CAS.
  try{verifyPublicationInputs();}catch(e){if(['AUTHORITY_LIFECYCLE_UNAVAILABLE','AUTHORITY_QUARANTINED'].includes(e.code))throw e;throw refusal('source_changed_during_packaging');}
  publishArchiveNoReplace(unpublished,output);
  return{...result,archivePath:output,readOnly:true,sourceDataDir:source};
 }catch(e){if(['AUTHORITY_LIFECYCLE_UNAVAILABLE','AUTHORITY_QUARANTINED'].includes(e.code)){retain=true;e.inspectionPath=temp;}throw e;}
 finally{if(!retain)await fsp.rm(temp,{recursive:true,force:true}).catch(()=>{});}
}
if(require.main===module){(async()=>{const args=parse(process.argv.slice(2)),result=await exportStopped(args);console.log('[LIBRARIAN SYSTEM] 클린 이관 ZIP 생성 완료');console.log('파일:',result.archivePath);console.log('크기:',result.bytes,'bytes');console.log('SHA-256:',result.sha256);console.log('원본 DATA는 수정하지 않았습니다.');})().catch(e=>{console.error('[LIBRARIAN SYSTEM] 이관 ZIP 생성 실패:',e.message);if(e.inspectionPath)console.error('검사 자료 보존:',e.inspectionPath);process.exitCode=1;});}
module.exports={exportStopped};
