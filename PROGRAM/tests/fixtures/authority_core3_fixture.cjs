'use strict';
// Independent core3 fixture. Never creates retired physical owner stores.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {ensureDataInstanceIdentity}=require('../../server/core/data-instance-identity.cjs');
const OWNERS=Object.freeze(['libra','hayaku','flashback']);
const PROFILE='memory-suite.authority-profile.core3.v2';
function core3Fixture(t){
 const root=fs.mkdtempSync(path.join(process.env.LIB_CORE3_BASIC_CHECKPOINT||os.tmpdir(),'core3-basic-'));
 const dataDir=path.join(root,'DATA');fs.mkdirSync(dataDir);
 const physicalBinding={...ensureDataInstanceIdentity(dataDir),controlStoreId:crypto.randomUUID()};
 const ownerBindings={},databases={},handles=new Set();
 for(const namespace of OWNERS){
  const filePath=path.join(dataDir,'stores',namespace,namespace+'.sqlite');fs.mkdirSync(path.dirname(filePath),{recursive:true});
  const db=new DatabaseSync(filePath);databases[namespace]=db;handles.add(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE kv(space TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,key));
   CREATE TABLE operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);
   PRAGMA user_version=1;`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('namespace',namespace);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('database_schema_version','1');
  if(namespace==='libra')db.exec('CREATE TABLE libra_deleted_owner_scopes(scope_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,backup_id TEXT NOT NULL,deleted_at INTEGER NOT NULL); CREATE TABLE libra_deleted_owner_keys(space TEXT NOT NULL,key TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(space,key));');
  if(namespace==='flashback')db.exec('CREATE TABLE flashback_writer_fences(alias TEXT PRIMARY KEY,epoch INTEGER NOT NULL,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);');
  db.prepare('INSERT INTO kv VALUES(?,?,?,0,1,?,0)').run('plugin','seed',JSON.stringify(namespace),crypto.createHash('sha256').update(JSON.stringify(namespace)).digest('hex'));
  ownerBindings[namespace]={filePath,resetEpoch:0};
 }
 const f={root,dataDir,physicalBinding,ownerBindings,databases,authorityProfile:PROFILE,activationId:crypto.randomUUID(),
  track:value=>(handles.add(value),value),
  controlPath:path.join(dataDir,'stores','_authority','server-authority.sqlite'),markerPath:path.join(dataDir,'config','server-authority.json'),
  initialize(){return f.control=f.track(require('../../server/authority/control-store.cjs').initializeAuthorityStore(f));},
  bind(){const O=require('../../server/authority/owner-store.cjs');f.owners={};for(const namespace of OWNERS)f.owners[namespace]=f.track(O.bindOwnerStore({database:databases[namespace],namespace,...ownerBindings[namespace],physicalBinding}));return f;},
  qualify(extra={}){return require('../../server/authority/initial-qualification.cjs').createInitialOwnerQualifier({dataDir,control:f.control,authorityProfile:PROFILE,resolveOwnerStore:n=>f.owners[n],...extra}).qualifyInitialOwners();}
 };
 t.after(()=>{for(const h of [...handles].reverse())try{h.close();}catch{}fs.rmSync(root,{recursive:true,force:true});});return f;
}
module.exports={core3Fixture,OWNERS,PROFILE};
