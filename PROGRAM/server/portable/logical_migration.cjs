'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const archive = require('./stream_archive.cjs');
const { classifyRecord, validateOwnerRecord, clearAuthority, finishGraph } = require('./migration_policy.cjs');
const { collectPersistentMetadata } = require('../core/migration_metadata.cjs');

const MIGRATION_SCHEMA = 'librarian.portable-migration.v1';
const MIGRATION_FORMAT_VERSION = 1;
const NAMESPACES = Object.freeze(['flashback','hayaku','libra','lia','retrace']);
const sha256Text = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const sha256FileSync = file => { const h=crypto.createHash('sha256');const fd=fs.openSync(file,'r'),b=Buffer.allocUnsafe(1024*1024);try{let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex'); };
const fail=(code,statusCode=422)=>{throw Object.assign(new Error(code),{statusCode});};

function createCurrentSchema(database, namespace, serverVersion='0.4.0') {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (
      space TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT,deleted INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,key));
    CREATE TABLE IF NOT EXISTS operations (
      operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_kv_space_key ON kv(space,key);
    CREATE INDEX IF NOT EXISTS idx_operations_created_at ON operations(created_at);
  `);
  const upsert=database.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  upsert.run('database_schema_version','1');upsert.run('namespace',namespace);upsert.run('server_version_last_opened',serverVersion);database.exec('PRAGMA user_version = 1;');
}

function backupManifest(backupDir) {
  const file=path.join(backupDir,'manifest.json');
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){fail('migration_snapshot_manifest_invalid');}
  if(value?.schema!=='memory-suite.backup.v1'||!value.stores)fail('migration_snapshot_manifest_invalid');
  return value;
}

function writeJsonLine(fd, value) { fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, 'utf8'); }
function addMember(stage, rel, kind, members) {
  const file=path.join(stage,rel),st=fs.statSync(file);members.push({file:rel,kind,bytes:st.size,sha256:sha256FileSync(file)});
}
function safeCatalog(value) {
  if(!value||value.schema!=='memory-suite.scope-catalog.v1'||!value.namespaces||Array.isArray(value.namespaces)||typeof value.namespaces!=='object')fail('migration_scope_catalog_invalid');
  return value;
}
function snapshotCatalog(source, snapshot) {
  const meta=snapshot.scopeCatalog;
  // Tracked snapshot producers always write this catalog and its full proof.
  // Missing metadata cannot certify an empty inventory or a legacy producer.
  if(!meta||typeof meta!=='object'||Array.isArray(meta)||meta.file!=='scope-catalog.json'||typeof meta.sha256!=='string'||!/^[a-f0-9]{64}$/.test(meta.sha256))fail('migration_snapshot_catalog_metadata');
  const file=path.resolve(source,meta.file);if(!file.startsWith(source+path.sep))fail('migration_snapshot_catalog_metadata');
  let bytes;try{bytes=fs.readFileSync(file);}catch(error){fail(error.code==='ENOENT'?'migration_snapshot_catalog_missing':'migration_snapshot_catalog_unreadable');}
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==meta.sha256)fail('migration_snapshot_catalog_digest');
  if(!Number.isSafeInteger(meta.bytes)||meta.bytes<0||bytes.length!==meta.bytes)fail('migration_snapshot_catalog_bytes');
  let catalog;try{catalog=JSON.parse(bytes.toString('utf8'));}catch(_){fail('migration_scope_catalog_invalid');}
  return safeCatalog(catalog);
}

async function exportLogicalMigration({backupDir,archivePath,sourceDataDir,serverVersion='0.4.0',protocol={major:1,minor:9},databaseSchemaVersion=1,onProgress=()=>{}}) {
  const source=path.resolve(backupDir),snapshot=backupManifest(source),stage=path.join(path.dirname(path.resolve(archivePath)),`.migration-stage-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(stage,'namespaces'),{recursive:true,mode:0o700});await fsp.mkdir(path.join(stage,'history'),{recursive:true,mode:0o700});
  const members=[],namespaceMeta={},recordState=Object.fromEntries(NAMESPACES.map(ns=>[ns,new Map()])),summary={namespaces:0,records:0,tombstones:0,authorityClears:0,blockers:[]};let processed=0;
  try{
    const catalog=snapshotCatalog(source,snapshot);
    for(const namespace of NAMESPACES){
      const meta=snapshot.stores?.[namespace];if(!meta?.file||!meta?.sha256)fail(`migration_snapshot_store_missing:${namespace}`);
      const dbPath=path.join(source,meta.file);if(!fs.existsSync(dbPath)||sha256FileSync(dbPath)!==meta.sha256)fail(`migration_snapshot_store_digest:${namespace}`);
      const db=new DatabaseSync(dbPath,{readOnly:true});const rel=`namespaces/${namespace}.jsonl`,fd=fs.openSync(path.join(stage,rel),'wx',0o600);const hrel=`history/${namespace}-operations.jsonl`,hfd=fs.openSync(path.join(stage,hrel),'wx',0o600);
      let records=0,tombstones=0,authorityClears=0,operations=0;
      try{
        const integ=String(db.prepare('PRAGMA integrity_check').get()?.integrity_check||'');if(integ!=='ok')fail(`migration_source_integrity:${namespace}:${integ}`);
        for(const row of db.prepare('SELECT space,key,value_json,deleted,revision,digest,updated_at FROM kv ORDER BY space,key').iterate()){
          const c=classifyRecord(namespace,row);if(!c.exportable){summary.blockers.push({namespace,key:String(row.key||'').slice(0,160),reason:c.reason});continue;}
          const valid=validateOwnerRecord(namespace,row,c.parsed);if(!valid.ok){summary.blockers.push({namespace,key:String(row.key||'').slice(0,160),reason:valid.reason});continue;}
          let valueJson=row.value_json,digest=String(row.digest||'');
          if(Number(row.deleted)!==1){
            if(sha256Text(valueJson)!==digest)fail(`migration_source_value_digest:${namespace}:${String(row.key).slice(0,80)}`);
            const cleared=clearAuthority(namespace,c.parsed);if(cleared.changed){valueJson=JSON.stringify(cleared.value);digest=sha256Text(valueJson);authorityClears+=cleared.notes.length;}
          }else{
            const expected=sha256Text(`tombstone:${namespace}:${row.space}:${row.key}:${row.revision}`);if(expected!==digest)fail(`migration_source_tombstone_digest:${namespace}:${String(row.key).slice(0,80)}`);tombstones+=1;
          }
          recordState[namespace].set(`${row.space}\u0000${row.key}`,{revision:Number(row.revision),digest,tombstone:Number(row.deleted)===1,updatedAt:Number(row.updated_at||0)});writeJsonLine(fd,{space:row.space,key:row.key,value_json:Number(row.deleted)===1?null:valueJson,deleted:Number(row.deleted)===1?1:0,revision:Number(row.revision),digest,updated_at:Number(row.updated_at||0)});records+=1;processed+=Buffer.byteLength(String(valueJson||''),'utf8');
          if(records%250===0)onProgress({phase:'migration-export',processedBytes:processed,totalBytes:0});
        }
        for(const op of db.prepare('SELECT operation_id,fingerprint,response_json,created_at FROM operations ORDER BY created_at,operation_id').iterate()){
          writeJsonLine(hfd,{operation_id:String(op.operation_id||''),fingerprint:String(op.fingerprint||''),response_json:String(op.response_json||''),created_at:Number(op.created_at||0),active:false});operations+=1;
        }
      }finally{fs.closeSync(fd);fs.closeSync(hfd);db.close();}
      addMember(stage,rel,'namespace_records',members);addMember(stage,hrel,'inactive_operation_history',members);
      namespaceMeta[namespace]={records,tombstones,authorityClears,operations,file:rel,historyFile:hrel};summary.namespaces+=1;summary.records+=records;summary.tombstones+=tombstones;summary.authorityClears+=authorityClears;
    }
    if(summary.blockers.length)fail(`migration_repair_required:${summary.blockers[0].namespace}:${summary.blockers[0].reason}`);
    // Authority clearing may change a stored JSON digest while preserving the
    // logical record revision. Keep scope-catalog member proofs coherent with
    // the migrated record rather than carrying a stale source digest.
    for(const namespace of NAMESPACES){for(const scope of Array.isArray(catalog.namespaces?.[namespace])?catalog.namespaces[namespace]:[]){for(const member of Array.isArray(scope?.members)?scope.members:[]){const state=recordState[namespace].get(`${member.space||'plugin'}\u0000${member.key||''}`);if(!state)continue;member.revision=state.revision;member.digest=state.digest;member.updatedAt=state.updatedAt;member.exists=!state.tombstone;member.tombstone=state.tombstone;}}}
    fs.writeFileSync(path.join(stage,'scope-catalog.json'),`${JSON.stringify(catalog,null,2)}\n`,{encoding:'utf8',mode:0o600});addMember(stage,'scope-catalog.json','scope_catalog',members);
    const aux=sourceDataDir?collectPersistentMetadata(sourceDataDir):{schema:'librarian.migration-metadata.v1',serverConfig:{schema:'memory-suite.server-config.portable.v1'}};
    fs.writeFileSync(path.join(stage,'portable-metadata.json'),`${JSON.stringify(aux,null,2)}\n`,{encoding:'utf8',mode:0o600});addMember(stage,'portable-metadata.json','portable_metadata',members);
    const createdAt=Date.now(),manifest={schema:MIGRATION_SCHEMA,formatVersion:MIGRATION_FORMAT_VERSION,createdAt:new Date(createdAt).toISOString(),createdAtMs:createdAt,source:{serverVersion:String(snapshot.serverVersion||serverVersion),databaseSchemaVersion:Number(snapshot.databaseSchemaVersion||databaseSchemaVersion),protocol:snapshot.protocol||protocol,backupId:String(snapshot.id||'')},targetContract:{databaseSchemaVersion:Number(databaseSchemaVersion),namespaces:NAMESPACES.slice()},namespaces:namespaceMeta,graph:finishGraph(summary),members};
    validateMigrationManifest(manifest);
    fs.writeFileSync(path.join(stage,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{encoding:'utf8',mode:0o600});
    const packed=await archive.exportArchive({backupDir:stage,archivePath,onProgress});return {...packed,archiveKind:'logical_migration',migrationSchema:MIGRATION_SCHEMA,summary};
  }finally{await fsp.rm(stage,{recursive:true,force:true}).catch(()=>{});}
}

async function peekArchiveManifest(archivePath) {
  const info=await archive.inspectZip(archivePath),roots=new Set(info.entries.map(e=>e.name.split('/')[0]));if(roots.size!==1)fail('migration_single_root_required');const root=[...roots][0],entry=info.entries.find(e=>e.name===`${root}/manifest.json`);if(!entry||entry.raw>archive.LIMITS.maxManifestBytes)fail('migration_manifest_missing');const chunks=[];await archive.extractEntry(archivePath,entry,new Writable({write(b,e,cb){chunks.push(b);cb();}}));let manifest;try{manifest=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(_){fail('migration_manifest_json');}return {info,root,manifest};
}

function validateMigrationManifest(manifest) {
  if(manifest?.schema!==MIGRATION_SCHEMA||Number(manifest.formatVersion)!==MIGRATION_FORMAT_VERSION)fail('migration_manifest_schema');
  if(!Array.isArray(manifest.members)||!Array.isArray(manifest.targetContract?.namespaces))fail('migration_manifest_members');
  if(NAMESPACES.some(ns=>!manifest.targetContract.namespaces.includes(ns)||!manifest.namespaces?.[ns]))fail('migration_full_namespaces_required');
  const seen=new Set();for(const m of manifest.members){if(!m||typeof m.file!=='string'||!m.file||typeof m.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(m.sha256)||!Number.isSafeInteger(m.bytes)||m.bytes<0)fail('migration_member_invalid');archive.safeName(m.file);const k=m.file.normalize('NFC').toLowerCase();if(seen.has(k))fail('migration_member_duplicate');seen.add(k);}
  // v1 names bind owner namespaces to their certified readset. A valid member
  // digest alone cannot authorize reading another owner's stream or history.
  const members=new Map(manifest.members.map(m=>[m.file,m]));
  for(const namespace of NAMESPACES){
    const meta=manifest.namespaces[namespace],file=`namespaces/${namespace}.jsonl`,historyFile=`history/${namespace}-operations.jsonl`;
    if(meta.file!==file||members.get(file)?.kind!=='namespace_records')fail(`migration_namespace_record_reference:${namespace}`);
    if(meta.historyFile!==historyFile||members.get(historyFile)?.kind!=='inactive_operation_history')fail(`migration_namespace_history_reference:${namespace}`);
  }
  return true;
}

async function extractLogicalArchive({archivePath,stagingRoot,expectedArchiveSha256=null,onProgress=()=>{}}){
  const sha=await archive.sha256File(archivePath);if(expectedArchiveSha256&&sha!==expectedArchiveSha256)fail('migration_archive_digest');const {info,root,manifest}=await peekArchiveManifest(archivePath);validateMigrationManifest(manifest);
  const entryMap=new Map(info.entries.map(e=>[e.name,e])),memberMap=new Map(manifest.members.map(m=>[m.file,m]));if(info.entries.filter(e=>!e.name.endsWith('/')).length!==manifest.members.length+1)fail('migration_unexpected_file');
  const id=`migration-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,dir=path.join(path.resolve(stagingRoot),id);await fsp.mkdir(dir,{recursive:true,mode:0o700});let processed=0;
  try{
    for(const [rel,meta] of memberMap){const e=entryMap.get(`${root}/${rel}`);if(!e)fail(`migration_member_missing:${rel}`);const out=path.resolve(dir,rel);if(!out.startsWith(dir+path.sep))fail('migration_path_escape');await fsp.mkdir(path.dirname(out),{recursive:true,mode:0o700});const r=await archive.extractEntry(archivePath,e,fs.createWriteStream(out,{flags:'wx',mode:0o600}),n=>{processed+=n;onProgress({phase:'migration-inspect',processedBytes:processed,totalBytes:info.expandedBytes});});if(r.sha256!==meta.sha256||r.bytes!==meta.bytes)fail(`migration_member_digest:${rel}`);}
    fs.writeFileSync(path.join(dir,'manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{encoding:'utf8',mode:0o600});return {dir,manifest,sha256:sha,bytes:info.bytes,expandedBytes:info.expandedBytes};
  }catch(e){await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});throw e;}
}

async function readJsonl(file, onRow) {
  const readline=require('node:readline');const input=fs.createReadStream(file,{encoding:'utf8',highWaterMark:256*1024}),rl=readline.createInterface({input,crlfDelay:Infinity});let index=0;
  for await(const line of rl){if(!line)continue;if(Buffer.byteLength(line,'utf8')>16*1024*1024)fail('migration_line_too_large');let row;try{row=JSON.parse(line);}catch(_){fail(`migration_jsonl_invalid:${index}`);}await onRow(row,index++);}return index;
}

async function importLogicalMigration({archivePath,backupRootManual,stagingRoot,expectedDatabaseSchemaVersion=1,requiredNamespaces=NAMESPACES,expectedArchiveSha256=null,serverVersion='0.4.0',onProgress=()=>{}}) {
  const extracted=await extractLogicalArchive({archivePath,stagingRoot,expectedArchiveSha256,onProgress});const {dir,manifest}=extracted;
  if(Number(manifest.targetContract.databaseSchemaVersion)!==Number(expectedDatabaseSchemaVersion))fail('migration_target_schema_incompatible');if(requiredNamespaces.some(ns=>!manifest.namespaces?.[ns]))fail('migration_full_namespaces_required');
  const createdAt=Date.now(),id=`${new Date(createdAt).toISOString().replace(/[:.]/g,'-')}_${crypto.randomBytes(8).toString('hex')}_migration`,temp=path.join(path.resolve(backupRootManual),`${id}.migration-temp`),dest=path.join(path.resolve(backupRootManual),id);await fsp.mkdir(temp,{recursive:true,mode:0o700});const stores={};let processed=0;
  try{
    for(const namespace of NAMESPACES){const dbPath=path.join(temp,`${namespace}.sqlite`),db=new DatabaseSync(dbPath);createCurrentSchema(db,namespace,serverVersion);const ins=db.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES (?,?,?,?,?,?,?)');const seen=new Set();let records=0,tombstones=0;
      try{db.exec('BEGIN IMMEDIATE');await readJsonl(path.join(dir,manifest.namespaces[namespace].file),async row=>{const parsed=Number(row.deleted)===1?null:(()=>{try{return JSON.parse(String(row.value_json));}catch(_){fail(`migration_value_json:${namespace}`);}})();const valid=validateOwnerRecord(namespace,row,parsed);if(!valid.ok)fail(`migration_record_invalid:${namespace}:${valid.reason}`);const k=`${row.space}\u0000${row.key}`;if(seen.has(k))fail(`migration_duplicate_key:${namespace}`);seen.add(k);let expected;if(Number(row.deleted)===1){expected=sha256Text(`tombstone:${namespace}:${row.space}:${row.key}:${row.revision}`);tombstones++;if(row.value_json!=null)fail(`migration_tombstone_value:${namespace}`);}else expected=sha256Text(String(row.value_json));if(expected!==row.digest)fail(`migration_record_digest:${namespace}`);ins.run(row.space,row.key,Number(row.deleted)===1?null:String(row.value_json),Number(row.deleted)===1?1:0,Number(row.revision),String(row.digest),Number(row.updated_at||0));records++;processed+=Buffer.byteLength(String(row.value_json||''),'utf8');if(records%250===0)onProgress({phase:'migration-rebuild',processedBytes:processed,totalBytes:extracted.expandedBytes});});db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch(_){}throw e;}finally{db.close();}
      const verify=new DatabaseSync(dbPath,{readOnly:true});try{const i=String(verify.prepare('PRAGMA integrity_check').get()?.integrity_check||'');if(i!=='ok')fail(`migration_rebuilt_integrity:${namespace}:${i}`);if(Number(verify.prepare('SELECT COUNT(*) AS c FROM kv').get()?.c||0)!==records)fail(`migration_rebuilt_count:${namespace}`);}finally{verify.close();}
      stores[namespace]={file:`${namespace}.sqlite`,sha256:sha256FileSync(dbPath),bytes:fs.statSync(dbPath).size,records,liveRecords:records-tombstones,tombstones};
    }
    const catalog=safeCatalog(JSON.parse(fs.readFileSync(path.join(dir,'scope-catalog.json'),'utf8'))),catalogFile=path.join(temp,'scope-catalog.json');fs.writeFileSync(catalogFile,`${JSON.stringify(catalog,null,2)}\n`,{encoding:'utf8',mode:0o600});
    const metadata=JSON.parse(fs.readFileSync(path.join(dir,'portable-metadata.json'),'utf8'));
    const historyDir=path.join(temp,'migration-history');await fsp.mkdir(historyDir,{recursive:true,mode:0o700});for(const namespace of NAMESPACES){const src=path.join(dir,manifest.namespaces[namespace].historyFile);if(fs.existsSync(src))await fsp.copyFile(src,path.join(historyDir,`${namespace}-operations.jsonl`));}
    const backup={schema:'memory-suite.backup.v1',id,kind:'manual',label:'logical-migration',createdAt:new Date(createdAt).toISOString(),createdAtMs:createdAt,serverVersion,protocol:{major:1,minor:9},databaseSchemaVersion:Number(expectedDatabaseSchemaVersion),scopeCatalog:{file:'scope-catalog.json',sha256:sha256FileSync(catalogFile),bytes:fs.statSync(catalogFile).size,source:'logical_migration'},stores,migrationAux:{schema:'librarian.migration-aux.v1',source:manifest.source,serverConfig:metadata.serverConfig||{},migrationSchema:MIGRATION_SCHEMA,importedArchiveSha256:extracted.sha256,historyDir:'migration-history'}};
    fs.writeFileSync(path.join(temp,'manifest.json'),`${JSON.stringify(backup,null,2)}\n`,{encoding:'utf8',mode:0o600});await fsp.mkdir(backupRootManual,{recursive:true,mode:0o700});await fsp.rename(temp,dest);return {ok:true,backupId:id,backupDir:dest,manifest:backup,verified:Object.fromEntries(NAMESPACES.map(ns=>[ns,{sha256:stores[ns].sha256,integrity:'ok'}])),sha256:extracted.sha256,bytes:extracted.bytes,expandedBytes:extracted.expandedBytes,archiveKind:'logical_migration'};
  }catch(e){await fsp.rm(temp,{recursive:true,force:true}).catch(()=>{});throw e;}finally{await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}

module.exports={MIGRATION_SCHEMA,MIGRATION_FORMAT_VERSION,NAMESPACES,createCurrentSchema,exportLogicalMigration,importLogicalMigration,peekArchiveManifest,validateMigrationManifest};
