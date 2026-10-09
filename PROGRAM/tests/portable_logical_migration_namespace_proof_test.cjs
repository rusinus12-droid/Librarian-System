'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const migration=require('../server/portable/logical_migration.cjs'),archive=require('../server/portable/stream_archive.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-namespace-proof-')),stage=path.join(root,'stage'),manual=path.join(root,'manual'),staging=path.join(root,'staging'),zip=path.join(root,'migration.zip');
 for(const dir of [stage,manual,path.join(stage,'namespaces'),path.join(stage,'history')])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(manual,'preserved.txt'),'PRESERVE_EXISTING_BACKUP_981');
 const members=[],namespaces={};
 const member=(file,kind,value)=>{const bytes=Buffer.from(value);fs.writeFileSync(path.join(stage,file),bytes);members.push({file,kind,bytes:bytes.length,sha256:sha(bytes)});};
 const catalog={schema:'memory-suite.scope-catalog.v1',updatedAt:123,namespaces:{}};
 for(const namespace of migration.NAMESPACES){
  const valueJson=JSON.stringify({schema:namespace==='hayaku'?'hayaku.recovery_vault.v1':'test.owner.v1',scopeKey:'closed-'+namespace,owner:namespace,text:'EXACT_OWNER_'+namespace,...(namespace==='hayaku'?{records:[{recordId:'retained',repairLease:null,backgroundDecision:'pending'}]}:{})});
  const row={space:'plugin',key:'retained-'+namespace,value_json:valueJson,deleted:0,revision:4,digest:sha(Buffer.from(valueJson)),updated_at:123};
  const vectorJson=JSON.stringify({scopeKey:'closed-'+namespace,rawRef:row.key,vector:[0.25,-0.5,0.75],profile:'retained-profile-v1'}),vectorRow={space:'local',key:'vector-'+namespace,value_json:vectorJson,deleted:0,revision:7,digest:sha(Buffer.from(vectorJson)),updated_at:125};
  const file='namespaces/'+namespace+'.jsonl',historyFile='history/'+namespace+'-operations.jsonl';
  member(file,'namespace_records',JSON.stringify(row)+'\n'+JSON.stringify(vectorRow)+'\n');member(historyFile,'inactive_operation_history',JSON.stringify({operation_id:'old-'+namespace,fingerprint:'retained-history-'+namespace,response_json:'{}',created_at:123,active:false})+'\n');
  namespaces[namespace]={records:2,tombstones:0,authorityClears:0,operations:1,file,historyFile};
  catalog.namespaces[namespace]=[{namespace,scopeId:'closed-'+namespace,members:[row,vectorRow].map(r=>({space:r.space,key:r.key,revision:r.revision,digest:r.digest,exists:true,tombstone:false}))}];
 }
 member('scope-catalog.json','scope_catalog',JSON.stringify(catalog));member('portable-metadata.json','portable_metadata',JSON.stringify({schema:'librarian.migration-metadata.v1',serverConfig:{schema:'memory-suite.server-config.portable.v1'}}));
 const manifest={schema:migration.MIGRATION_SCHEMA,formatVersion:1,targetContract:{databaseSchemaVersion:1,namespaces:migration.NAMESPACES.slice()},source:{backupId:'five-owner-fixture'},namespaces,members};
 const pack=async()=>{fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest));await archive.exportArchive({backupDir:stage,archivePath:zip});};
 const dispose=()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('migration-namespace-proof-'));fs.rmSync(root,{recursive:true,force:true});};
 return {root,stage,manual,staging,zip,manifest,pack,dispose};
}
for(const [name,change,error] of [
 ['foreign owner record stream',m=>{const old=m.namespaces.libra.file;m.namespaces.libra.file=m.namespaces.hayaku.file;m.namespaces.hayaku.file=old;},'migration_namespace_record_reference:hayaku'],
 ['foreign owner inactive history',m=>{const old=m.namespaces.libra.historyFile;m.namespaces.libra.historyFile=m.namespaces.hayaku.historyFile;m.namespaces.hayaku.historyFile=old;},'migration_namespace_history_reference:hayaku'],
 ['record reference outside extracted readset',(m,f)=>{m.namespaces.libra.file='../../outside.jsonl';fs.copyFileSync(path.join(f.stage,'namespaces/libra.jsonl'),path.join(f.root,'outside.jsonl'));},'migration_namespace_record_reference:libra'],
 ['record member with wrong declared role',m=>{m.members.find(x=>x.file==='namespaces/libra.jsonl').kind='portable_metadata';},'migration_namespace_record_reference:libra'],
 ['history member with wrong declared role',m=>{m.members.find(x=>x.file==='history/libra-operations.jsonl').kind='namespace_records';},'migration_namespace_history_reference:libra']
])test('logical import refuses '+name+' before backup publication',async()=>{
 const f=fixture();try{change(f.manifest,f);await f.pack();await assert.rejects(migration.importLogicalMigration({archivePath:f.zip,backupRootManual:f.manual,stagingRoot:f.staging}),e=>e.message===error);
  assert.deepEqual(fs.readdirSync(f.manual),['preserved.txt']);assert.equal(fs.readFileSync(path.join(f.manual,'preserved.txt'),'utf8'),'PRESERVE_EXISTING_BACKUP_981');assert.equal(fs.existsSync(f.staging),false);
 }finally{f.dispose();}
});
test('valid manifest imports each owner stream and inactive history under its own namespace',async()=>{
 const f=fixture();try{await f.pack();const imported=await migration.importLogicalMigration({archivePath:f.zip,backupRootManual:f.manual,stagingRoot:f.staging});
  const catalog=JSON.parse(fs.readFileSync(path.join(imported.backupDir,'scope-catalog.json'),'utf8'));
  for(const namespace of migration.NAMESPACES){const db=new DatabaseSync(path.join(imported.backupDir,namespace+'.sqlite'),{readOnly:true});try{const rows=db.prepare('SELECT * FROM kv').all();assert.equal(rows.length,2);const row=rows.find(r=>r.space==='plugin');assert.equal(row.key,'retained-'+namespace);assert.deepEqual(JSON.parse(row.value_json),{schema:namespace==='hayaku'?'hayaku.recovery_vault.v1':'test.owner.v1',scopeKey:'closed-'+namespace,owner:namespace,text:'EXACT_OWNER_'+namespace,...(namespace==='hayaku'?{records:[{recordId:'retained',repairLease:null,backgroundDecision:'pending'}]}:{})});assert.deepEqual(JSON.parse(rows.find(r=>r.space==='local').value_json),{scopeKey:'closed-'+namespace,rawRef:row.key,vector:[0.25,-0.5,0.75],profile:'retained-profile-v1'});for(const r of rows)assert.equal(catalog.namespaces[namespace][0].members.find(m=>m.space===r.space&&m.key===r.key).digest,r.digest);assert.equal(db.prepare('SELECT COUNT(*) n FROM operations').get().n,0);}finally{db.close();}
   assert.equal(JSON.parse(fs.readFileSync(path.join(imported.backupDir,'migration-history',namespace+'-operations.jsonl'),'utf8')).fingerprint,'retained-history-'+namespace);
  }
 }finally{f.dispose();}
});
