'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const C = require('./contracts.cjs');
const M = require('./receipt-codec.cjs');
const R = require('./receipt-retention.cjs');
const { assertControlPermit, readActivationState, fileIdentity, ownerFile, fatalUnsafeEnd, rollbackOrClose, closeOrFailStop, checkOwnerSchemaVersion, boundedCatalog, boundedText, boundedIntegerColumn, requireRealTables, assertInitialQualificationContext } = require('./control-store.cjs');
const STORES = new WeakMap();
const INITIAL_LOCKS = new WeakMap();
const CORE_TABLES = ['metadata','kv','operations'];
const AUTHORITY_TABLES = ['authority_owner_state','authority_write_receipts','authority_source_lifecycle','authority_write_results','authority_write_touches'];
const AUTHORITY_SQL = [
 `CREATE TABLE authority_owner_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),activation_id TEXT NOT NULL,generation TEXT NOT NULL,binding_json TEXT NOT NULL,guard_fingerprint TEXT NOT NULL,receipt_retention TEXT NOT NULL CHECK(receipt_retention='retain-all-v1'))`,
 `CREATE TABLE authority_write_receipts(generation TEXT NOT NULL,namespace TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(generation,namespace,operation_id))`,
 `CREATE TABLE authority_source_lifecycle(space TEXT NOT NULL,key TEXT NOT NULL,source_id TEXT NOT NULL,generation TEXT NOT NULL,version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),present INTEGER NOT NULL CHECK(present IN (0,1)),revision INTEGER,digest TEXT,PRIMARY KEY(space,key))`,
 ...R.DDL
];
function privateStore(store) { const state=STORES.get(store); if(!state)C.fail('INVALID_OWNER_STORE'); return state; }
function tablesFor(namespace) { return [...CORE_TABLES,...(namespace==='libra'?['libra_deleted_owner_scopes','libra_deleted_owner_keys']:[]),...(namespace==='flashback'?['flashback_writer_fences']:[]),...AUTHORITY_TABLES]; }
function triggersFor(namespace) {
 const sql=[];
 for(const table of tablesFor(namespace))for(const action of ['INSERT','UPDATE','DELETE'])sql.push(`CREATE TRIGGER authority_guard_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT authority_guard('${table}','${action}'); END`);
 sql.push("CREATE TRIGGER authority_observe_kv_insert AFTER INSERT ON kv BEGIN SELECT authority_observe(NEW.space,NEW.key); END");
 sql.push("CREATE TRIGGER authority_observe_kv_delete AFTER DELETE ON kv BEGIN SELECT authority_observe(OLD.space,OLD.key); END");
 sql.push("CREATE TRIGGER authority_observe_kv_update AFTER UPDATE ON kv BEGIN SELECT authority_observe(OLD.space,OLD.key); SELECT authority_observe(NEW.space,NEW.key) WHERE OLD.space<>NEW.space OR OLD.key<>NEW.key; END");
 for(const action of ['INSERT','UPDATE','DELETE']) {
  const refs=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
  sql.push(`CREATE TRIGGER authority_profile_kv_${action.toLowerCase()} BEFORE ${action} ON kv BEGIN `+refs.map(ref=>{
   const valid=R.keyValid.replace(/\b(space|key|revision|deleted|digest)\b/g,word=>ref+'.'+word);
   return `SELECT CASE WHEN ${valid} THEN 1 ELSE RAISE(ABORT,'AUTHORITY_WRITER_KEY_PROFILE_UNAVAILABLE') END; SELECT authority_profile(${ref}.space,${ref}.key);`;
  }).join(' ')+' END');
 }
 return sql;
}
const normalize=sql=>sql.replace(/\s+/g,' ').trim();
function schemaFingerprint(db) { return C.hash(boundedCatalog(db).map(r=>({...r,sql:normalize(r.sql)}))); }
function ensureBinding(s) {
 const activation=readActivationState({dataDir:s.dataDir});
 if(activation.status==='unavailable'||C.canonical(activation.marker.physicalBinding)!==C.canonical(s.physicalBinding)||C.canonical(activation.marker.ownerBindings[s.namespace])!==C.canonical(s.binding)||C.canonical(fileIdentity(s.filePath))!==C.canonical(s.binding.fileIdentity))C.fail('AUTHORITY_QUARANTINED');
 return activation.marker;
}
function registerFunctions(s) {
 s.db.function('authority_guard',(table,action)=>{
   const ctx=s.context;if(!ctx)C.fail('AUTHORITY_WRITE_DENIED');
   if(ctx.phase==='activation'){if(ctx.permit)assertControlPermit(ctx.permit);return 1;}
   assertControlPermit(ctx.permit,ctx.intent);
   if(ctx.phase==='receipt'&&['authority_write_receipts','authority_write_results','authority_write_touches'].includes(table)&&action==='INSERT')return 1;
   if(ctx.phase==='lifecycle'&&table==='authority_source_lifecycle'&&['INSERT','UPDATE'].includes(action))return 1;
   if(ctx.phase!=='body'||AUTHORITY_TABLES.includes(table)||table==='metadata')C.fail('AUTHORITY_WRITE_DENIED');
   const allowed={kv:['kv','operations'],batch:['kv','operations'],maintenance:['kv','operations','libra_deleted_owner_scopes','libra_deleted_owner_keys','flashback_writer_fences'],fence:['flashback_writer_fences','operations']}[ctx.intent.operationClass];
   if(!allowed?.includes(table))C.fail('AUTHORITY_WRITE_DENIED'); return 1;
 });
 s.db.function('authority_profile',(space,key)=>{M.assertWriterKey(space,key);return 1;});
 s.db.function('authority_observe',(space,key)=>{
   const ctx=s.context;if(!ctx)C.fail('AUTHORITY_WRITE_DENIED');
   if(ctx.phase==='activation'){if(ctx.permit)assertControlPermit(ctx.permit);return 1;}
   if(ctx.phase!=='body')C.fail('AUTHORITY_WRITE_DENIED');assertControlPermit(ctx.permit,ctx.intent);
   M.assertWriterKey(space,key);const id=C.canonical([space,key]),prior=ctx.touched.get(id);if(!prior){if(ctx.touched.size>=M.LIMITS.touchedKeys||ctx.touchCredits+M.LIMITS.touchRowBytes>M.LIMITS.touchedBytes)C.fail('RESOURCE_LIMIT');ctx.touchCredits+=M.LIMITS.touchRowBytes;}ctx.touched.set(id,{space,key,count:C.increment(prior?.count||0)});return 1;
 });
}
// Successful binding transfers transaction and close lifecycle ownership of the
// supplied DatabaseSync to this store. Use ownerStore.close(), not raw close or
// transaction control. Other legacy connections remain unprivileged. A failed
// bind does not begin a transaction; its caller must dispose of the input handle.
function bindOwnerStore({database,namespace,filePath,physicalBinding,resetEpoch}) {
 C.namespace(namespace);if(!(database instanceof DatabaseSync))C.fail('INVALID_OWNER_DATABASE');
 const actual=path.resolve(filePath),dataDir=path.resolve(path.dirname(actual),'..','..');
 if(actual!==ownerFile(dataDir,namespace))C.fail('AUTHORITY_QUARANTINED');
 const binding=C.physicalBinding(physicalBinding),marker=readActivationState({dataDir}).marker;
 if(!marker||C.canonical(marker.physicalBinding)!==C.canonical(binding))C.fail('AUTHORITY_QUARANTINED');
 C.profileNamespace(namespace,C.markerProfile(marker).id);
 const expected=marker.ownerBindings[namespace];
 if(expected.resetEpoch!==C.boundedInteger(resetEpoch)||C.canonical(expected.fileIdentity)!==C.canonical(fileIdentity(actual)))C.fail('AUTHORITY_QUARANTINED');
 const main=database.prepare('PRAGMA database_list').all().find(row=>row.name==='main');
 if(!main?.file||C.canonical(fileIdentity(main.file))!==C.canonical(expected.fileIdentity))C.fail('AUTHORITY_QUARANTINED');
 const version=checkOwnerSchemaVersion(database,{namespace,allowActivated:true});
 database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA recursive_triggers=ON;');
 let s; const store=Object.freeze({namespace,close(){if(s.context)C.fail('AUTHORITY_BUSY');s.retired=true;if(!s.closed){closeOrFailStop(s.db);s.closed=true;}}});s={db:database,namespace,filePath:actual,dataDir,physicalBinding:binding,binding:C.clone(expected),context:null,closed:false,retired:false};
 STORES.set(store,s);registerFunctions(s);if(version===C.OWNER_SCHEMA_VERSION)verifyOwnerGuards(store);return store;
}
function installOwnerGuards(store,{activationId,generation,controlPermit}) {
 const s=privateStore(store);usable(s);if(s.context)C.fail('NESTED_OWNER_TRANSACTION');const marker=ensureBinding(s);C.identifier(activationId);C.identifier(generation);
 let gate;if(controlPermit){const context=assertInitialQualificationContext(controlPermit);if(context.branch!=='FIRST')C.fail('AUTHORITY_UNAVAILABLE');preflightInitialOwner(store,controlPermit);gate=assertControlPermit(controlPermit);}
 if(activationId!==marker.activationId||generation!==marker.generation)C.fail('AUTHORITY_QUARANTINED');
 const version=checkOwnerSchemaVersion(s.db,{namespace:s.namespace,allowActivated:true});
 if(version===C.OWNER_SCHEMA_VERSION)return verifyOwnerGuards(store);
 const control=new DatabaseSync(path.join(s.dataDir,'stores','_authority','server-authority.sqlite'),{readOnly:true});
 try{if(control.prepare('SELECT status FROM authority_state').get()?.status!=='preparing')C.fail('AUTHORITY_UNAVAILABLE');}finally{closeOrFailStop(control);}
 const token=Object.freeze({});if(gate)gate.registerOwner(token);const ctx={phase:'activation',permit:controlPermit,gate,token,ended:false};s.context=ctx;
 try{
   s.db.exec('BEGIN IMMEDIATE');
   checkOwnerSchemaVersion(s.db,{namespace:s.namespace});
   if(controlPermit)validateLegacyProfile(s);
   R.preflightOwnerKeys(s.db);
   for(const table of tablesFor(s.namespace).filter(t=>!AUTHORITY_TABLES.includes(t)))if(!s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))C.fail('AUTHORITY_QUARANTINED');
   for(const sql of AUTHORITY_SQL)s.db.exec(sql);
   for(const sql of triggersFor(s.namespace))s.db.exec(sql);
   s.db.prepare("UPDATE metadata SET value=? WHERE key='database_schema_version'").run(String(C.OWNER_SCHEMA_VERSION));
   s.db.exec('PRAGMA user_version='+C.OWNER_SCHEMA_VERSION);
   if(s.namespace==='libra')R.preflightOwnerKeys(s.db,row=>{if(row.space==='plugin')s.db.prepare('INSERT INTO authority_source_lifecycle VALUES(?,?,?,?,?,?,?,?)').run(row.space,row.key,randomUUID(),generation,1,row.deleted?0:1,row.revision,row.digest);});
   s.db.prepare('INSERT INTO authority_owner_state VALUES(1,?,?,?,?,?)').run(activationId,generation,C.canonical({physicalBinding:s.physicalBinding,ownerBinding:s.binding}),schemaFingerprint(s.db),'retain-all-v1');
   if(gate)safeEnd(s,ctx,true);else{s.db.exec('COMMIT');ctx.ended=true;}
 }catch(error){if(gate)safeEnd(s,ctx,false);else if(!ctx.ended&&rollbackOrClose(s.db))s.closed=true;throw error;}
 finally{if(!gate)s.context=null;}
 return verifyOwnerGuards(store);
}
// Public close is terminal; only private safe-end closure may reopen for recovery.
function usable(s) { if(s.retired)C.fail('AUTHORITY_CLOSED');if(s.closed){ensureBinding(s);s.db=new DatabaseSync(s.filePath);s.db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA recursive_triggers=ON;');s.closed=false;registerFunctions(s);} }
function verifyOwnerGuards(store) {
 const s=privateStore(store);usable(s);const marker=ensureBinding(s);
 return verifyOwnerSnapshotState(s,marker);
}
function verifyOwnerReadSnapshot(session) {
 const state=require('./observation-io.cjs').assertOwnerSession(session);
 return verifyOwnerSnapshotState({...state,db:state.evidence},state.context.marker,{observation:true});
}
function verifyOwnerSnapshotState(s,marker,{observation=false}={}) {
 try{
  const catalog=boundedCatalog(s.db);requireRealTables(catalog,tablesFor(s.namespace));
  const columns=[boundedIntegerColumn('singleton'),boundedText('activation_id',240),boundedText('generation',240),boundedText('binding_json',1048576),boundedText('guard_fingerprint',64),boundedText('receipt_retention',32)].map(c=>c.replace('CASE WHEN ','CASE WHEN (SELECT COUNT(*) FROM authority_owner_state)=1 AND '));
  const rows=s.db.prepare(`SELECT ${columns.join(',')} FROM authority_owner_state LIMIT 2`).all();
  if(rows.length!==1||rows[0].singleton!==1)C.fail('AUTHORITY_QUARANTINED');const r=rows[0];
  if(!r||r.activation_id!==marker.activationId||r.generation!==marker.generation||r.binding_json!==C.canonical({physicalBinding:s.physicalBinding,ownerBinding:s.binding})||r.receipt_retention!=='retain-all-v1'||r.guard_fingerprint!==schemaFingerprint(s.db))C.fail('AUTHORITY_QUARANTINED');
  const triggers=catalog.filter(r=>r.type==='trigger'&&r.name.startsWith('authority_')).map(r=>normalize(r.sql)).sort();
  if(C.canonical(triggers)!==C.canonical(triggersFor(s.namespace).map(normalize).sort()))C.fail('AUTHORITY_QUARANTINED');
  for(const sql of AUTHORITY_SQL){const name=sql.match(/CREATE TABLE (\w+)/)[1];if(normalize(catalog.find(r=>r.name===name)?.sql||'')!==normalize(sql))C.fail('AUTHORITY_QUARANTINED');}
  if(s.db.prepare('PRAGMA user_version').get().user_version!==C.OWNER_SCHEMA_VERSION||s.db.prepare(`SELECT ${boundedText('value',16)} FROM metadata WHERE key='database_schema_version'`).get()?.value!==String(C.OWNER_SCHEMA_VERSION))C.fail('AUTHORITY_QUARANTINED');
  return {namespace:s.namespace,generation:r.generation,guardFingerprint:r.guard_fingerprint,physicalBinding:C.clone(s.physicalBinding),ownerBinding:C.clone(s.binding),lifecycleCoverage:s.namespace==='libra'?'libra.plugin-kv.v1':null};
 }catch(error){if(error.code==='AUTHORITY_QUARANTINED'||(observation&&['RESOURCE_LIMIT','OBSERVATION_EXPIRED','OBSERVATION_CHECK_TIMEOUT','SOURCE_PROFILE_UNAVAILABLE','AUTHORITY_BUSY'].includes(error.code)))throw error;C.fail('AUTHORITY_QUARANTINED');}
}
const LEGACY_TABLE_SQL={
 metadata:'CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
 kv:'CREATE TABLE kv(space TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,key))',
 operations:'CREATE TABLE operations(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL)',
 libra_deleted_owner_scopes:'CREATE TABLE libra_deleted_owner_scopes(scope_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,backup_id TEXT NOT NULL,deleted_at INTEGER NOT NULL)',
 libra_deleted_owner_keys:'CREATE TABLE libra_deleted_owner_keys(space TEXT NOT NULL,key TEXT NOT NULL,scope_id TEXT NOT NULL,PRIMARY KEY(space,key))',
 flashback_writer_fences:'CREATE TABLE flashback_writer_fences(alias TEXT PRIMARY KEY,epoch INTEGER NOT NULL,owner TEXT NOT NULL,expires_at INTEGER NOT NULL)'
};
function validateLegacyProfile(s,{activated=false}={}) {
 const catalog=boundedCatalog(s.db),tables=tablesFor(s.namespace).filter(n=>!AUTHORITY_TABLES.includes(n));requireRealTables(catalog,tables);
 const compact=sql=>sql.replace(/\s+/g,'').toLowerCase();
 for(const name of tables)if(compact(catalog.find(r=>r.name===name).sql)!==compact(LEGACY_TABLE_SQL[name]))C.fail('AUTHORITY_QUARANTINED');
 for(const row of catalog){if(activated&&((row.type==='table'&&AUTHORITY_TABLES.includes(row.name))||(row.type==='trigger'&&row.name.startsWith('authority_'))))continue;if(!(row.type==='table'&&tables.includes(row.name))&&!(row.type==='index'&&tables.includes(row.tbl_name)))C.fail('AUTHORITY_QUARANTINED');}
 R.preflightOwnerKeys(s.db);
}
function initialBaseline(s,context) {
 for(const table of ['authority_write_receipts','authority_write_results','authority_write_touches'])if(s.db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())C.fail('AUTHORITY_QUARANTINED');
 let count=0;R.preflightOwnerKeys(s.db,row=>{
  if(s.namespace!=='libra'||row.space!=='plugin')return;
  const stamp=R.readLifecycle(s.db,row.space,row.key);if(!stamp||stamp.generation!==context.generation||stamp.version!==1||stamp.present!==(row.deleted?0:1)||stamp.revision!==row.revision||stamp.digest!==row.digest)C.fail('AUTHORITY_QUARANTINED');C.identifier(stamp.source_id);count++;
 });
 if(s.db.prepare('SELECT count(*) AS n FROM authority_source_lifecycle').get().n!==count)C.fail('AUTHORITY_QUARANTINED');
}
function preflightInitialOwner(store,permit) {
 const context=assertInitialQualificationContext(permit),s=privateStore(store);usable(s);const marker=ensureBinding(s);
 if(marker.activationId!==context.activationId||marker.generation!==context.generation||C.canonical(s.physicalBinding)!==C.canonical(context.physicalBinding)||C.canonical(s.binding)!==C.canonical(context.ownerBindings[s.namespace]))C.fail('AUTHORITY_QUARANTINED');
 const version=checkOwnerSchemaVersion(s.db,{namespace:s.namespace,allowActivated:true});
 if(version===1){if(context.branch!=='FIRST')C.fail('AUTHORITY_QUARANTINED');validateLegacyProfile(s);}
 else {verifyOwnerGuards(store);validateLegacyProfile(s,{activated:true});if(context.branch==='FIRST')initialBaseline(s,context);}
 return {namespace:s.namespace,ownerSchema:version};
}
function lockOwnerForInitialQualification(store,permit) {
 const gate=assertControlPermit(permit),s=privateStore(store);usable(s);if(s.context)C.fail('NESTED_OWNER_TRANSACTION');preflightInitialOwner(store,permit);
 if(checkOwnerSchemaVersion(s.db,{namespace:s.namespace,allowActivated:true})!==3)C.fail('AUTHORITY_QUARANTINED');
 const token=Object.freeze({});gate.registerOwner(token);const ctx={phase:'qualification',permit,gate,token,ended:false};s.context=ctx;
 try {
  s.db.exec('BEGIN IMMEDIATE');preflightInitialOwner(store,permit);
  const lock=Object.freeze({end(){safeEnd(s,ctx,false);}});INITIAL_LOCKS.set(lock,{store,s,ctx,permit});return lock;
 } catch(error) {safeEnd(s,ctx,false);if(/busy|locked/i.test(error.message))C.fail('AUTHORITY_BUSY');throw error;}
}
function assertInitialOwnerLock(lock,permit) {
 const state=INITIAL_LOCKS.get(lock);if(!state||state.permit!==permit||state.ctx.ended||state.s.context!==state.ctx)C.fail('INVALID_INITIAL_OWNER_LOCK');
 assertControlPermit(permit);preflightInitialOwner(state.store,permit);const proof=verifyOwnerGuards(state.store);
 return {namespace:state.s.namespace,ownerBinding:proof.ownerBinding,ownerSchema:3,guardFingerprint:proof.guardFingerprint,receiptRetention:'retain-all-v1'};
}
function receiptFrom(s,key,{includeResult=false,expectedReceipt}={}) {
 try{
 const k=C.operationKey(key);if(k.namespace!==s.namespace)C.fail('AUTHORITY_QUARANTINED');
 const row=s.db.prepare(`SELECT ${R.boundedJsonColumn('receipt_json',M.LIMITS.compactReceiptBytes)},CASE WHEN typeof(fingerprint)='text' AND LENGTH(CAST(fingerprint AS BLOB))<=64 THEN fingerprint ELSE NULL END AS fingerprint FROM authority_write_receipts WHERE generation=? AND namespace=? AND operation_id=?`).get(k.generation,k.namespace,k.operationId);
 if(!row){if(R.hasRetainedEvidence(s.db,k))C.fail('AUTHORITY_QUARANTINED');return null;}
 M.scanResultJson(row.receipt_json,M.LIMITS.compactReceiptBytes);const receipt=JSON.parse(row.receipt_json);
 M.validateCompactReceipt(receipt,{operationKey:k,physicalBinding:s.physicalBinding,ownerBinding:s.binding});
 if(C.canonical(receipt)!==row.receipt_json||receipt.fingerprint!==row.fingerprint||(expectedReceipt&&C.canonical(expectedReceipt)!==row.receipt_json))C.fail('AUTHORITY_QUARANTINED');
 const result=R.verifyReceiptPayloads(s.db,receipt,{includeResult});return includeResult?{receipt,result}:receipt;
 }catch{C.fail('AUTHORITY_QUARANTINED');}
}
function readOwnerReceipt(store,key){verifyOwnerGuards(store);return receiptFrom(privateStore(store),key);}
function readOwnerOperationResult(store,key,{expectedReceipt}={}){
 verifyOwnerGuards(store);const s=privateStore(store),k=C.operationKey(key);if(!expectedReceipt)C.fail('AUTHORITY_QUARANTINED');
 // The supplied binding must also be the genuine durable committed decision.
 const control=new DatabaseSync(path.join(s.dataDir,'stores','_authority','server-authority.sqlite'),{readOnly:true});
 try{const row=control.prepare(`SELECT ${R.boundedJsonColumn('decision_json')} FROM authority_decisions JOIN write_intents USING(generation,namespace,operation_id) WHERE generation=? AND namespace=? AND operation_id=? AND status='committed'`).get(k.generation,k.namespace,k.operationId);if(!row)C.fail('AUTHORITY_QUARANTINED');const decision=R.parseControl(row.decision_json);if(decision.status!=='committed'||C.canonical(decision.receipt)!==C.canonical(expectedReceipt))C.fail('AUTHORITY_QUARANTINED');}finally{closeOrFailStop(control);}
 const verified=receiptFrom(s,k,{includeResult:true,expectedReceipt});if(!verified)C.fail('AUTHORITY_QUARANTINED');return verified.result;
}
function stampFrom(row){return {space:row.space,key:row.key,sourceId:row.source_id,generation:row.generation,version:row.version,present:!!row.present,revision:row.revision,digest:row.digest};}
function readSourceStamps(store,keys){
 verifyOwnerGuards(store);const s=privateStore(store);
 if(s.namespace!=='libra'||!Array.isArray(keys)||keys.length>8192)C.fail('SOURCE_PROOF_UNAVAILABLE');
 return keys.map(k=>{if(k?.space!=='plugin'||typeof k.key!=='string'||k.key.length>8192)C.fail('SOURCE_PROOF_UNAVAILABLE');const r=s.db.prepare('SELECT * FROM authority_source_lifecycle WHERE space=? AND key=?').get(k.space,k.key);if(!r)C.fail('SOURCE_PROOF_UNAVAILABLE');return stampFrom(r);});
}
function transactionFacade(s,ctx){
 const prepare=sql=>{
  if(s.context!==ctx||ctx.phase!=='body')C.fail('OWNER_TRANSACTION_ENDED');
  if(typeof sql!=='string'||sql.length>65536||/authority_(?:guard|observe)/i.test(sql))C.fail('INVALID_OWNER_SQL');
  // Trusted server bodies get one data statement, never transaction/schema control.
  const masked=sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|\/\*[\s\S]*?\*\/|--[^\r\n]*/g,' ');
  if(!/^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(masked)||/;\s*\S/.test(masked)||/\b(?:PRAGMA|ATTACH|DETACH)\b/i.test(masked))C.fail('INVALID_OWNER_SQL');
  assertControlPermit(ctx.permit,ctx.intent);return s.db.prepare(sql);
 };
 return Object.freeze({run(sql,...args){return prepare(sql).run(...args);},get(sql,...args){return prepare(sql).get(...args);},all(sql,...args){return prepare(sql).all(...args);}});
}
function startOwner(store,permit,intent){
 const s=privateStore(store),gate=assertControlPermit(permit,intent);verifyOwnerGuards(store);
 if(intent.namespace!==s.namespace||intent.generation!==gate.generation||C.canonical(intent.physicalBinding)!==C.canonical(s.physicalBinding)||C.canonical(intent.ownerBinding)!==C.canonical(s.binding))C.fail('AUTHORITY_QUARANTINED');
 if(s.context)C.fail('NESTED_OWNER_TRANSACTION');
 const token=Object.freeze({});gate.registerOwner(token);
 const ctx={phase:'locked',permit,intent,touched:new Map(),touchCredits:0,token,gate,ended:false};s.context=ctx;
 // Register before attempting BEGIN: an I/O wrapper may report failure after
 // SQLite acquired the lock. Failure still owes safe termination to the gate.
 try{s.db.exec('BEGIN IMMEDIATE');verifyOwnerGuards(store);assertControlPermit(permit,intent);return {s,ctx};}
 catch(error){safeEnd(s,ctx,false);if(/busy|locked/i.test(error.message))C.fail('AUTHORITY_BUSY');throw error;}
}
function safeEnd(s,ctx,commit){
 if(ctx.ended)return;
 if(commit){s.db.exec('COMMIT');ctx.ended=true;s.context=null;ctx.gate.endOwner(ctx.token);return;}
 if(rollbackOrClose(s.db))s.closed=true;
 ctx.ended=true;s.context=null;ctx.gate.endOwner(ctx.token);
}
function applyOwnerMutation(store,permit,intent,work){
 C.synchronous(work);const {s,ctx}=startOwner(store,permit,intent);
 try{
  if(receiptFrom(s,intent))C.fail('OWNER_RECEIPT_ALREADY_EXISTS');
  ctx.phase='body';C.noPromise(work(transactionFacade(s,ctx)));
  ctx.phase='receipt';const ordinaryResult=R.retainOrdinaryResult(s.db,intent),hasher=M.createTouchHasher(intent);let ordinal=0;
  for(const changed of ctx.touched.values()){
   if(s.namespace!=='libra'||changed.space!=='plugin')continue;
   ctx.phase='lifecycle';
   const previous=R.readLifecycle(s.db,changed.space,changed.key),row=s.db.prepare('SELECT deleted,revision,digest FROM kv WHERE space=? AND key=?').get(changed.space,changed.key);
   let version=previous?.version||0;for(let n=0;n<changed.count;n++)version=C.increment(version);
   s.db.prepare('INSERT INTO authority_source_lifecycle VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(space,key) DO UPDATE SET version=excluded.version,present=excluded.present,revision=excluded.revision,digest=excluded.digest').run(changed.space,changed.key,previous?.source_id||randomUUID(),intent.generation,version,row&&!row.deleted?1:0,row?.revision??null,row?.digest??null);
   const stamp=stampFrom(R.readLifecycle(s.db,changed.space,changed.key));
   hasher.update(ordinal,stamp);ctx.phase='receipt';R.retainTouch(s.db,intent,ordinal++,stamp);
  }
  const receipt={contract:C.OWNER_RECEIPT_CONTRACT,...C.operationKey(intent),fingerprint:intent.fingerprint,operationClass:intent.operationClass,controlSequence:intent.controlSequence,physicalBinding:C.clone(s.physicalBinding),ownerBinding:C.clone(s.binding),fenceEpoch:intent.fenceEpoch,ordinaryResult,touchedSources:{encoding:'owner-source-stamp-sequence.v1',...hasher.finish()}};
  M.validateCompactReceipt(receipt);ctx.phase='receipt';s.db.prepare('INSERT INTO authority_write_receipts VALUES(?,?,?,?,?)').run(intent.generation,intent.namespace,intent.operationId,intent.fingerprint,C.canonical(receipt));
  const beforeCommit=receiptFrom(s,intent);if(C.canonical(beforeCommit)!==C.canonical(receipt))C.fail('AUTHORITY_QUARANTINED');
  safeEnd(s,ctx,true);verifyOwnerGuards(store);
  const actual=receiptFrom(s,intent);if(C.canonical(actual)!==C.canonical(receipt))C.fail('AUTHORITY_QUARANTINED');return actual;
 }catch(error){safeEnd(s,ctx,false);throw error;}
}
function lockOwnerForRecovery(store,permit){
 const gate=assertControlPermit(permit),s=privateStore(store),w=readActivationState({dataDir:s.dataDir});
 // The gate supplies the pending row; no caller can substitute an absence claim.
 const control=new DatabaseSync(path.join(s.dataDir,'stores','_authority','server-authority.sqlite'),{readOnly:true});
 let intent;try{const row=control.prepare(`SELECT ${R.boundedJsonColumn('intent_json')} FROM write_intents WHERE status='pending'`).get();if(!row)C.fail('OPERATION_NOT_PENDING');intent=R.parseControl(row.intent_json);}finally{closeOrFailStop(control);}
 if(w.marker.generation!==gate.generation||intent.namespace!==s.namespace)C.fail('AUTHORITY_QUARANTINED');
 const pair=startOwner(store,permit,intent);let ended=false;
 return Object.freeze({readReceipt(key){if(ended)C.fail('OWNER_TRANSACTION_ENDED');if(C.canonical(C.operationKey(key))!==C.canonical(C.operationKey(intent)))C.fail('OPERATION_CONFLICT');verifyOwnerGuards(store);return receiptFrom(s,key);},end(){if(!ended){safeEnd(pair.s,pair.ctx,false);ended=true;}}});
}
module.exports={verifyOwnerReadSnapshot,bindOwnerStore,installOwnerGuards,verifyOwnerGuards,readOwnerReceipt,readOwnerOperationResult,readSourceStamps,applyOwnerMutation,lockOwnerForRecovery,preflightInitialOwner,lockOwnerForInitialQualification,assertInitialOwnerLock};
