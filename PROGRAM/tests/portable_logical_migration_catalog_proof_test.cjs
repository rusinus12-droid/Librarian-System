'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const migration=require('../server/portable/logical_migration.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-catalog-proof-'));
 const backup=path.join(root,'backup'),zip=path.join(root,'migration.zip');fs.mkdirSync(backup);
 const stores={},namespaces={};
 for(const namespace of migration.NAMESPACES){
  const file=namespace+'.sqlite',db=new DatabaseSync(path.join(backup,file));migration.createCurrentSchema(db,namespace);
  const value=namespace==='hayaku'?{schema:'hayaku.recovery_vault.v1',records:[{recordId:'retained',status:'repair_pending',repairLease:{leaseId:'old'},backgroundDecision:'approved'}]}:{schema:'test.owner.v1',scopeKey:'closed-'+namespace,text:'RAW_OWNER_\uD55C\uAD6D\uC5B4_\u65E5\u672C\u8A9E'};
  const key='retained-'+namespace,valueJson=JSON.stringify(value),digest=sha(valueJson),tombstone=sha('tombstone:'+namespace+':plugin:gone:2');
  db.prepare('INSERT INTO kv VALUES (?,?,?,?,?,?,?)').run('plugin',key,valueJson,0,3,digest,123);
  db.prepare('INSERT INTO kv VALUES (?,?,?,?,?,?,?)').run('plugin','gone',null,1,2,tombstone,124);
  const vectorJson=JSON.stringify({scopeKey:'closed-'+namespace,rawRef:key,vector:[0.25,-0.5,0.75],profile:'retained-profile-v1'}),vectorDigest=sha(vectorJson);
  db.prepare('INSERT INTO kv VALUES (?,?,?,?,?,?,?)').run('local','vector-'+namespace,vectorJson,0,7,vectorDigest,125);
  // A frozen backup is a standalone SQLite image, without live WAL state.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');db.close();
  const bytes=fs.readFileSync(path.join(backup,file));stores[namespace]={file,sha256:sha(bytes),bytes:bytes.length,records:3};
  namespaces[namespace]=[{namespace,scopeId:'closed-'+namespace,scopeKey:'closed-'+namespace,coverageComplete:true,members:[{space:'plugin',key,revision:3,digest,exists:true,tombstone:false,updatedAt:123},{space:'plugin',key:'gone',revision:2,digest:tombstone,exists:false,tombstone:true,updatedAt:124},{space:'local',key:'vector-'+namespace,revision:7,digest:vectorDigest,exists:true,tombstone:false,updatedAt:125}]}];
 }
 const catalog={schema:'memory-suite.scope-catalog.v1',updatedAt:123,namespaces};
 const catalogFile=path.join(backup,'scope-catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(catalog));
 const catalogBytes=fs.readFileSync(catalogFile),manifest={schema:'memory-suite.backup.v1',id:'source-closed-five',stores,scopeCatalog:{file:'scope-catalog.json',sha256:sha(catalogBytes),bytes:catalogBytes.length}};
 const manifestFile=path.join(backup,'manifest.json');const save=()=>fs.writeFileSync(manifestFile,JSON.stringify(manifest));save();
 const dispose=()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('migration-catalog-proof-'));fs.rmSync(root,{recursive:true,force:true});};
 return {root,backup,zip,catalogFile,catalog,manifest,save,dispose};
}
function sourceImage(dir){return Object.fromEntries(fs.readdirSync(dir).sort().map(name=>[name,sha(fs.readFileSync(path.join(dir,name)))]));}
for(const [name,change,error] of [
 ['missing advertised catalog',f=>fs.unlinkSync(f.catalogFile),'migration_snapshot_catalog_missing'],
 ['catalog bytes changed after snapshot',f=>{const c=JSON.parse(fs.readFileSync(f.catalogFile));c.namespaces.libra=[];fs.writeFileSync(f.catalogFile,JSON.stringify(c));},'migration_snapshot_catalog_digest'],
 ['catalog byte-count proof changed',f=>{f.manifest.scopeCatalog.bytes++;f.save();},'migration_snapshot_catalog_bytes'],
 ['incomplete advertised catalog proof',f=>{delete f.manifest.scopeCatalog.sha256;f.save();},'migration_snapshot_catalog_metadata'],
 ['omitted current catalog metadata',f=>{delete f.manifest.scopeCatalog;f.save();},'migration_snapshot_catalog_metadata'],
 ['null current catalog metadata',f=>{f.manifest.scopeCatalog=null;f.save();},'migration_snapshot_catalog_metadata'],
 ['numeric current catalog metadata',f=>{f.manifest.scopeCatalog=7;f.save();},'migration_snapshot_catalog_metadata'],
 ['string current catalog metadata',f=>{f.manifest.scopeCatalog='scope-catalog.json';f.save();},'migration_snapshot_catalog_metadata'],
 ['array current catalog metadata',f=>{f.manifest.scopeCatalog=[];f.save();},'migration_snapshot_catalog_metadata'],
 ['missing catalog byte-count proof',f=>{delete f.manifest.scopeCatalog.bytes;f.save();},'migration_snapshot_catalog_bytes'],
 ['noncanonical catalog file reference',f=>{fs.renameSync(f.catalogFile,path.join(f.backup,'other-catalog.json'));f.manifest.scopeCatalog.file='other-catalog.json';f.save();},'migration_snapshot_catalog_metadata']
])test('logical export refuses '+name+' without source/destination publication',async()=>{
 const f=fixture();try{change(f);const before=sourceImage(f.backup),sentinel=Buffer.from('PRESERVE_EXISTING_ARCHIVE_712');fs.writeFileSync(f.zip,sentinel);
  await assert.rejects(migration.exportLogicalMigration({backupDir:f.backup,archivePath:f.zip}),e=>e.message===error);
  assert.deepEqual(sourceImage(f.backup),before);assert.deepEqual(fs.readFileSync(f.zip),sentinel);
  assert.deepEqual(fs.readdirSync(f.root).sort(),['backup','migration.zip']);
 }finally{f.dispose();}
});
test('verified five-namespace catalog retains membership and transformed record proofs on actual import',async()=>{
 const f=fixture();try{const before=sourceImage(f.backup);await migration.exportLogicalMigration({backupDir:f.backup,archivePath:f.zip});
  const imported=await migration.importLogicalMigration({archivePath:f.zip,backupRootManual:path.join(f.root,'manual'),stagingRoot:path.join(f.root,'staging')});
  const catalog=JSON.parse(fs.readFileSync(path.join(imported.backupDir,'scope-catalog.json'),'utf8'));
  for(const namespace of migration.NAMESPACES){const scope=catalog.namespaces[namespace][0];assert.equal(scope.scopeId,'closed-'+namespace);assert.equal(scope.members.length,3);
   const db=new DatabaseSync(path.join(imported.backupDir,namespace+'.sqlite'),{readOnly:true});try{for(const member of scope.members){const row=db.prepare('SELECT * FROM kv WHERE space=? AND key=?').get(member.space,member.key);assert.equal(member.digest,row.digest);assert.equal(member.revision,row.revision);assert.equal(member.tombstone,Number(row.deleted)===1);}
    const value=JSON.parse(db.prepare('SELECT value_json FROM kv WHERE key=?').get('retained-'+namespace).value_json);
    assert.deepEqual(JSON.parse(db.prepare('SELECT value_json FROM kv WHERE space=? AND key=?').get('local','vector-'+namespace).value_json),{scopeKey:'closed-'+namespace,rawRef:'retained-'+namespace,vector:[0.25,-0.5,0.75],profile:'retained-profile-v1'});
    if(namespace==='hayaku'){assert.equal(value.records[0].repairLease,null);assert.equal(value.records[0].backgroundDecision,'pending');assert.notEqual(scope.members[0].digest,f.catalog.namespaces.hayaku[0].members[0].digest);}else assert.equal(value.text,'RAW_OWNER_\uD55C\uAD6D\uC5B4_\u65E5\u672C\u8A9E');
   }finally{db.close();}
  }assert.deepEqual(sourceImage(f.backup),before);
 }finally{f.dispose();}
});
test('versionless snapshot without catalog file or metadata refuses unknown inventory',async()=>{
 const f=fixture();try{delete f.manifest.scopeCatalog;f.save();fs.unlinkSync(f.catalogFile);const before=sourceImage(f.backup);
  await assert.rejects(migration.exportLogicalMigration({backupDir:f.backup,archivePath:f.zip}),e=>e.message==='migration_snapshot_catalog_metadata');
  assert.deepEqual(sourceImage(f.backup),before);assert.equal(fs.existsSync(f.zip),false);
 }finally{f.dispose();}
});
