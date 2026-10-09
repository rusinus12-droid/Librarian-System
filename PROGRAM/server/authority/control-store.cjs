'use strict';
// Internal prerequisite only. Ordinary startup/read paths must never initialize it.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readDataInstanceIdentity } = require('../core/data-instance-identity.cjs');
const C = require('./contracts.cjs');
const R = require('./receipt-retention.cjs');
const Routes = require('./route-lifecycle.cjs');
const PERMITS = new WeakMap();
const STORES = new WeakMap();
const OBSERVATION_READERS = new WeakMap();
const SQL = [
 `CREATE TABLE authority_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),activation_id TEXT NOT NULL,physical_json TEXT NOT NULL,generation TEXT NOT NULL,control_sequence INTEGER NOT NULL CHECK(control_sequence BETWEEN 0 AND 9007199254740991),status TEXT NOT NULL CHECK(status IN ('preparing','ready','lifecycle_pending','quarantined')))`,
 `CREATE TABLE write_intents(generation TEXT NOT NULL,namespace TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,operation_class TEXT NOT NULL,control_sequence INTEGER NOT NULL,intent_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','committed','aborted')),PRIMARY KEY(generation,namespace,operation_id))`,
 `CREATE UNIQUE INDEX singleton_pending_intent ON write_intents(status) WHERE status='pending'`,
 `CREATE TABLE authority_decisions(generation TEXT NOT NULL,namespace TEXT NOT NULL,operation_id TEXT NOT NULL,decision_json TEXT NOT NULL,PRIMARY KEY(generation,namespace,operation_id))`,
 `CREATE TABLE owner_fences(namespace TEXT PRIMARY KEY,binding_json TEXT NOT NULL,reset_epoch INTEGER NOT NULL CHECK(reset_epoch BETWEEN 0 AND 9007199254740991),fence_epoch INTEGER NOT NULL CHECK(fence_epoch BETWEEN 1 AND 9007199254740991))`,
 `CREATE TABLE authority_routes(namespace TEXT NOT NULL,scope_id TEXT NOT NULL,scope_key TEXT NOT NULL,mode TEXT NOT NULL,mode_epoch INTEGER NOT NULL CHECK(mode_epoch BETWEEN 1 AND 9007199254740991),override_kind TEXT NOT NULL,dependency_digest TEXT NOT NULL,transition_json TEXT,PRIMARY KEY(namespace,scope_id))`,
 `CREATE TABLE lifecycle_operations(operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,journal_json TEXT NOT NULL)`
];
function schemaSql(profile) {
  if(profile.schemaVersion===1)return SQL;
  return [SQL[0].replace('CHECK(schema_version=1)',"CHECK(schema_version=2),authority_profile TEXT NOT NULL CHECK(authority_profile='"+profile.id+"')"),...SQL.slice(1)];
}
const profileFields=profile=>profile.schemaVersion===1?{}:{authorityProfile:profile.id};
const paths = dataDir => ({ dataDir:path.resolve(dataDir), file:path.join(path.resolve(dataDir),'stores','_authority','server-authority.sqlite'), marker:path.join(path.resolve(dataDir),'config','server-authority.json') });
const normalize = sql => sql.replace(/\s+/g,' ').trim();
function quarantine() { C.fail('AUTHORITY_QUARANTINED'); }
function fileIdentity(file) {
  const stat = fs.lstatSync(file, { bigint:true }); if (!stat.isFile() || stat.isSymbolicLink()) quarantine();
  let real = fs.realpathSync.native(file); if (process.platform === 'win32') real = real.toLowerCase();
  return { device:String(stat.dev), inode:String(stat.ino), pathHash:createHash('sha256').update(real).digest('hex') };
}
// Fixed internal metadata projections: invalid payloads never leave SQLite.
function boundedText(column, maximum) {
  if (!/^[a-z_]+$/.test(column) || !Number.isSafeInteger(maximum)) quarantine();
  return `CASE WHEN typeof(${column})='text' AND LENGTH(CAST(${column} AS BLOB))<=${maximum} THEN ${column} ELSE NULL END AS ${column}`;
}
function boundedIntegerColumn(column) {
  return `CASE WHEN typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991 THEN ${column} ELSE NULL END AS ${column}`;
}
function boundedCatalog(db) {
  const valid = "typeof(type)='text' AND LENGTH(CAST(type AS BLOB))<=16 AND typeof(name)='text' AND LENGTH(CAST(name AS BLOB))<=240 AND typeof(tbl_name)='text' AND LENGTH(CAST(tbl_name AS BLOB))<=240 AND typeof(sql)='text' AND LENGTH(CAST(sql AS BLOB))<=1048576";
  const rows = db.prepare(`WITH entries AS (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'), totals AS (SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH(CAST(sql AS BLOB))),0) AS bytes,COALESCE(SUM(LENGTH(CAST(type AS BLOB))+LENGTH(CAST(name AS BLOB))+LENGTH(CAST(tbl_name AS BLOB))),0) AS names,COALESCE(MIN(CASE WHEN ${valid} THEN 1 ELSE 0 END),1) AS good FROM entries) SELECT n,CASE WHEN n<=256 AND bytes<=1048576 AND names<=131072 AND good=1 THEN 1 ELSE 0 END AS valid,${['type','name','tbl_name','sql'].map(k=>`CASE WHEN n<=256 AND bytes<=1048576 AND names<=131072 AND good=1 THEN ${k} ELSE NULL END AS ${k}`).join(',')} FROM entries CROSS JOIN totals ORDER BY type,name LIMIT 257`).all();
  if (rows.length>256 || rows.some(r=>r.valid!==1 || r.n!==rows.length)) quarantine();
  return rows.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql}));
}
function requireRealTables(catalog,names) {
  for (const name of names) { const row=catalog.find(r=>r.name===name); if(!row || row.type!=='table' || !/^CREATE\s+TABLE\s/i.test(row.sql)) quarantine(); }
}
function readBoundedEvidenceFile(file,maximum,{optional=false}={}) {
  let before;
  try { before=fs.lstatSync(file,{bigint:true}); } catch(error) { if(optional&&error.code==='ENOENT')return null; quarantine(); }
  const regular=s=>s.isFile()&&!s.isSymbolicLink()&&s.size<=BigInt(maximum);
  const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
  if(!regular(before))quarantine();let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const opened=fs.fstatSync(fd,{bigint:true});if(!regular(opened)||!same(before,opened))quarantine();
    const bytes=Buffer.alloc(maximum+1);let used=0;
    while(used<bytes.length){const n=fs.readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}
    const after=fs.fstatSync(fd,{bigint:true}),current=fs.lstatSync(file,{bigint:true});
    if(used>maximum||!regular(after)||!regular(current)||!same(opened,after)||!same(after,current))quarantine();
    return bytes.subarray(0,used);
  } catch { quarantine(); } finally { if(fd!==undefined)try{fs.closeSync(fd);}catch{quarantine();} }
}
function verifyPhysical(dataDir, binding) {
  const actual = readDataInstanceIdentity(dataDir);
  if (actual.dataInstanceId !== binding.dataInstanceId || actual.dataIdentityContract !== binding.dataIdentityContract) quarantine();
}
function ownerFile(dataDir, name) { C.namespace(name); return path.join(path.resolve(dataDir),'stores',name,name + '.sqlite'); }
function readActivationState({ dataDir }) {
  const p = paths(dataDir), hasMarker = fs.existsSync(p.marker), hasStore = fs.existsSync(p.file);
  if (!hasMarker && !hasStore) return { status:'unavailable' };
  if (!hasMarker || !hasStore) quarantine();
  try {
    const m = JSON.parse(readBoundedEvidenceFile(p.marker,65536).toString('utf8'));
    C.canonical(m);
    const profile=C.markerProfile(m);
    if (m.phase !== 'prepared') quarantine();
    C.identifier(m.activationId); C.identifier(m.generation); C.physicalBinding(m.physicalBinding);
    verifyPhysical(p.dataDir,m.physicalBinding);
    if (C.canonical(fileIdentity(p.file)) !== C.canonical(m.controlFileIdentity)) quarantine();
    if (C.canonical(Object.keys(m.ownerBindings).sort()) !== C.canonical([...profile.owners].sort())) quarantine();
    for (const n of profile.owners) {
      C.boundedInteger(m.ownerBindings[n].resetEpoch);
      if (C.canonical(fileIdentity(ownerFile(p.dataDir,n))) !== C.canonical(m.ownerBindings[n].fileIdentity)) quarantine();
    }
    return { status:'preparing', marker:m };
  } catch { quarantine(); }
}
function durableMarker(file, marker, exclusive) {
  const target = exclusive ? file : file + '.next-' + randomUUID();
  const fd = fs.openSync(target,'wx',0o600);
  try { fs.writeFileSync(fd,C.canonical(marker) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(target,file);
  const dir = fs.openSync(path.dirname(file),'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function configure(db) { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;'); }
// No Node-version-dependent transaction-state API is needed. Even a failed
// BEGIN may have acquired a transaction: its owner owes this termination proof.
function closeOrFailStop(db) { try { db.close(); } catch { fatalUnsafeEnd(); } }
function rollbackOrClose(db) {
  try { db.exec('ROLLBACK'); return false; }
  catch { closeOrFailStop(db); return true; }
}
function checkOwnerSchemaVersion(db, { namespace, allowActivated = false } = {}) {
  try {
    requireRealTables(boundedCatalog(db),['metadata','kv','operations']);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const declared = db.prepare(`SELECT ${boundedText('value',16)} FROM metadata WHERE key='database_schema_version'`).get()?.value;
    if (declared !== String(version) || (version !== 1 && !(allowActivated && version === C.OWNER_SCHEMA_VERSION))) quarantine();
    if (namespace && db.prepare(`SELECT ${boundedText('value',9)} FROM metadata WHERE key='namespace'`).get()?.value !== namespace) quarantine();
    const installed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_owner_state'").get();
    if (installed !== (version === C.OWNER_SCHEMA_VERSION)) quarantine();
    if(version===1&&db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'authority_%' LIMIT 1").get())quarantine();
    return version;
  } catch { quarantine(); }
}

function checkSchema(db,profile) {
  const rows = boundedCatalog(db);
  if (C.canonical(rows.map(r=>normalize(r.sql)).sort()) !== C.canonical(schemaSql(profile).map(normalize).sort())) quarantine();
  if (db.prepare('PRAGMA user_version').get().user_version !== profile.schemaVersion || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') quarantine();
}
function initializeAuthorityStore({ dataDir, activationId, physicalBinding, ownerBindings, authorityProfile }) {
  const profile=C.authorityProfile(authorityProfile);
  C.identifier(activationId); const binding = C.physicalBinding(physicalBinding), p = paths(dataDir);
  verifyPhysical(p.dataDir,binding);
  if (fs.existsSync(p.marker) || fs.existsSync(p.file)) {
    const state = readActivationState({ dataDir });
    if(C.markerProfile(state.marker).id!==profile.id)C.fail('AUTHORITY_PROFILE_MISMATCH');
    if (state.marker.activationId !== activationId || C.canonical(state.marker.physicalBinding) !== C.canonical(binding)) quarantine();
    return openAuthorityStore({ dataDir, physicalBinding:binding });
  }
  if (!ownerBindings || C.canonical(Object.keys(ownerBindings).sort()) !== C.canonical([...profile.owners].sort())) C.fail('INVALID_OWNER_BINDINGS');
  const checked = {};
  for (const n of profile.owners) {
    const b = ownerBindings[n], expected = ownerFile(p.dataDir,n);
    if (path.resolve(b.filePath) !== expected) quarantine();
    checked[n] = { fileIdentity:fileIdentity(expected), resetEpoch:C.boundedInteger(b.resetEpoch) };
    const db = new DatabaseSync(expected,{readOnly:true});
    try { checkOwnerSchemaVersion(db, { namespace:n }); R.preflightOwnerKeys(db); } finally { closeOrFailStop(db); }
  }
  fs.mkdirSync(path.dirname(p.file),{recursive:true}); fs.mkdirSync(path.dirname(p.marker),{recursive:true});
  const m = { schema:profile.marker,...profileFields(profile),phase:'initializing',activationId,physicalBinding:binding,generation:randomUUID(),ownerBindings:checked };
  durableMarker(p.marker,m,true);
  const db = new DatabaseSync(p.file); let endedByClose = false;
  try {
    configure(db); db.exec('BEGIN IMMEDIATE');
    for (const sql of schemaSql(profile)) db.exec(sql);
    db.exec('PRAGMA user_version='+profile.schemaVersion);
    if(profile.schemaVersion===1)db.prepare('INSERT INTO authority_state VALUES(1,1,?,?,?,?,?)').run(activationId,C.canonical(binding),m.generation,0,'preparing');
    else db.prepare('INSERT INTO authority_state VALUES(1,2,?,?,?,?,?,?)').run(profile.id,activationId,C.canonical(binding),m.generation,0,'preparing');
    for (const n of profile.owners) db.prepare('INSERT INTO owner_fences VALUES(?,?,?,1)').run(n,C.canonical(checked[n]),checked[n].resetEpoch);
    db.exec('COMMIT');
  } catch (error) { endedByClose = rollbackOrClose(db); throw error; }
  finally { if (!endedByClose) closeOrFailStop(db); }
  m.controlFileIdentity = fileIdentity(p.file); m.phase = 'prepared'; durableMarker(p.marker,m,false);
  return openAuthorityStore({ dataDir, physicalBinding:binding });
}
function assertControlPermit(permit, expected) {
  const state = PERMITS.get(permit);
  if (!state || !state.active) C.fail('INVALID_CONTROL_PERMIT');
  state.verify();
  if (expected) {
    C.profileNamespace(expected.namespace,state.profile.id);
    const key = C.operationKey(expected), row = state.db.prepare(`SELECT ${R.boundedJsonColumn('intent_json')},status FROM write_intents WHERE generation=? AND namespace=? AND operation_id=?`).get(key.generation,key.namespace,key.operationId);
    if (!row || row.status !== 'pending' || C.canonical(R.parseControl(row.intent_json)) !== C.canonical(expected)) C.fail('OPERATION_NOT_PENDING');
  }
  return state.access;
}
function assertInitialQualificationContext(permit) {
  assertControlPermit(permit);const state=PERMITS.get(permit);
  if(!state.initial)state.initial=state.initialContext();
  return C.clone(state.initial);
}
function initialResetEvidence(dataDir,ownerBindings,profile) {
  try {
    try { fs.lstatSync(path.join(dataDir,'migrations','restore-transaction.json'));quarantine(); } catch(error) { if(error.code!=='ENOENT')throw error; }
    const bytes=readBoundedEvidenceFile(path.join(dataDir,'config','namespace-reset.json'),1048576,{optional:true});
    const raw=bytes===null?null:JSON.parse(bytes.toString('utf8'));if(bytes!==null){C.canonical(raw);if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.pending!=null)quarantine();if(raw.epochs!==undefined&&(!raw.epochs||typeof raw.epochs!=='object'||Array.isArray(raw.epochs)))quarantine();}
    const epochs={};for(const n of profile.owners){epochs[n]=raw?.epochs&&Object.hasOwn(raw.epochs,n)?raw.epochs[n]:0;C.boundedInteger(epochs[n]);if(epochs[n]!==ownerBindings[n].resetEpoch)quarantine();}
    return C.hash({present:bytes!==null,epochs,pending:null,rawSha256:bytes===null?null:createHash('sha256').update(bytes).digest('hex')});
  } catch { quarantine(); }
}
// Internal identity check: shape-compatible callbacks cannot stand in for a store.
function assertAuthorityStore(store, { dataDir } = {}) {
  const state = STORES.get(store);
  if (!state) C.fail('INVALID_AUTHORITY_STORE');
  state.verify();
  if (dataDir !== undefined && path.resolve(dataDir) !== state.dataDir) quarantine();
  return store.readWitness();
}
function fatalUnsafeEnd() { try { fs.writeSync(2,'AUTHORITY_UNSAFE_TRANSACTION_END\n'); } finally { process.exit(70); } }
function openAuthorityStore({ dataDir, physicalBinding, authorityProfile }) {
  const expectedProfile=authorityProfile===undefined?null:C.authorityProfile(authorityProfile);
  const activation = readActivationState({ dataDir }); if (activation.status === 'unavailable') return Object.freeze({ status:'unavailable' });
  const m = activation.marker, p = paths(dataDir),profile=C.markerProfile(m);
  if(expectedProfile&&expectedProfile.id!==profile.id)C.fail('AUTHORITY_PROFILE_MISMATCH');
  if (physicalBinding && C.canonical(C.physicalBinding(physicalBinding)) !== C.canonical(m.physicalBinding)) quarantine();
  let writer, reader, closed = false, active = false;
  const incarnation = randomUUID();
  const verify = () => {
    if (closed) C.fail('AUTHORITY_CLOSED');
    const current = readActivationState({ dataDir });
    if (C.canonical(current.marker) !== C.canonical(m)) quarantine();
  };
  const newReader = () => {
    const db = new DatabaseSync(p.file,{readOnly:true});
    try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;'); return db; }
    catch (error) { closeOrFailStop(db); throw error; }
  };
  try { writer = new DatabaseSync(p.file); configure(writer); checkSchema(writer,profile); reader = newReader(); }
  catch (error) { if (writer) closeOrFailStop(writer); if (reader) closeOrFailStop(reader); quarantine(); }
  const read = work => {
    verify();
    try { reader.exec('BEGIN'); checkSchema(reader,profile); return work(reader); }
    finally { if (rollbackOrClose(reader)) reader = newReader(); }
  };
  const stateRow = db => {
    const columns=[...['singleton','schema_version','control_sequence'].map(boundedIntegerColumn),boundedText('activation_id',240),boundedText('generation',240),boundedText('physical_json',1048576),boundedText('status',32),...(profile.schemaVersion===1?[]:[boundedText('authority_profile',240)])].map(c=>c.replace('CASE WHEN ','CASE WHEN (SELECT COUNT(*) FROM authority_state)=1 AND '));
    const rows = db.prepare(`SELECT ${columns.join(',')} FROM authority_state LIMIT 2`).all();
    if(rows.length!==1)quarantine();const r=rows[0];
    if(r.singleton!==1||r.schema_version!==profile.schemaVersion||(profile.schemaVersion!==1&&r.authority_profile!==profile.id)||!['preparing','ready','lifecycle_pending','quarantined'].includes(r.status)||!Number.isSafeInteger(r.control_sequence)||r.control_sequence<0)quarantine();
    if (!r || r.activation_id !== m.activationId || r.generation !== m.generation || r.physical_json !== C.canonical(m.physicalBinding)) quarantine();
    return r;
  };
  const readFences = (db,{observation=false}={}) => {
    try {
    const rows=db.prepare(`SELECT ${boundedText('namespace',9)},${boundedText('binding_json',1048576)},${boundedIntegerColumn('reset_epoch')},${boundedIntegerColumn('fence_epoch')} FROM owner_fences ORDER BY namespace LIMIT ${profile.owners.length+1}`).all();
    if(rows.length!==profile.owners.length)quarantine();const names=new Set();
    for(const f of rows){C.profileNamespace(f.namespace,profile.id);if(names.has(f.namespace)||typeof f.binding_json!=='string')quarantine();names.add(f.namespace);C.boundedInteger(f.reset_epoch);C.boundedInteger(f.fence_epoch,1);if(f.reset_epoch!==m.ownerBindings[f.namespace].resetEpoch||C.canonical(JSON.parse(f.binding_json))!==C.canonical(m.ownerBindings[f.namespace]))quarantine();}
    return rows;
    } catch(error) { if(observation&&['RESOURCE_LIMIT','OBSERVATION_EXPIRED','OBSERVATION_CHECK_TIMEOUT','AUTHORITY_BUSY'].includes(error.code))throw error;quarantine(); }
  };
  const lookup = (db,key) => {
    C.profileNamespace(key?.namespace,profile.id);
    const k = C.operationKey(key), row = db.prepare(`SELECT ${R.boundedJsonColumn('intent_json')},status FROM write_intents WHERE generation=? AND namespace=? AND operation_id=?`).get(k.generation,k.namespace,k.operationId);
    if (!row) return null;
    const result = { ...R.parseControl(row.intent_json), status:row.status };
    if (row.status !== 'pending') {
      const d = db.prepare(`SELECT ${R.boundedJsonColumn('decision_json')} FROM authority_decisions WHERE generation=? AND namespace=? AND operation_id=?`).get(k.generation,k.namespace,k.operationId);
      if (!d) quarantine(); result.decision = R.parseControl(d.decision_json);
    }
    return result;
  };
  const qualificationId='initial-qualification:'+C.hash({activationId:m.activationId,generation:m.generation,...profileFields(profile)});
  const coverage=Object.fromEntries(profile.owners.map(n=>[n,n==='libra'?'libra.plugin-kv.v1':null]));
  const readInitial = (db,{observation=false}={}) => {
    try {
    const header=stateRow(db);readFences(db,{observation});
    if(profile.schemaVersion===1&&!observation&&db.prepare('SELECT 1 FROM lifecycle_operations WHERE operation_id<>? LIMIT 1').get(qualificationId))quarantine();
    const rows=db.prepare(`SELECT ${boundedText('operation_id',240)},${boundedText('kind',32)},${boundedText('status',32)},${boundedText('journal_json',65536)} FROM lifecycle_operations WHERE operation_id=? LIMIT 2`).all(qualificationId);
    if(!rows.length){if(header.status==='ready')C.fail('INITIAL_QUALIFICATION_REQUIRED');if(header.status!=='preparing'||header.control_sequence!==0)quarantine();return null;}
    if(rows.length!==1||!(header.status==='ready'||(observation&&header.status==='lifecycle_pending'))||header.control_sequence<1)quarantine();
    const row=rows[0];if(row.operation_id!==qualificationId||row.kind!=='initial_owner_qualification'||row.status!=='committed'||typeof row.journal_json!=='string')quarantine();
    let r;try{r=JSON.parse(row.journal_json);if(C.canonical(r)!==row.journal_json)quarantine();}catch{quarantine();}
    if(!r||typeof r!=='object'||Array.isArray(r))quarantine();
    if(r.contract!==profile.qualificationContract||(profile.schemaVersion!==1&&r.authorityProfile!==profile.id)||r.qualificationId!==qualificationId||r.activationId!==m.activationId||r.generation!==m.generation||C.canonical(r.physicalBinding)!==C.canonical(m.physicalBinding)||r.controlSequence!==1||r.qualificationScope!==profile.qualificationScope||C.canonical(r.sourceCoverage)!==C.canonical(coverage)||!Array.isArray(r.ownerProofs)||r.ownerProofs.length!==profile.owners.length||!/^[a-f0-9]{64}$/.test(r.resetStateDigest||''))quarantine();
    if(C.canonical(Object.keys(r).sort())!==C.canonical(['contract','qualificationId','activationId','generation','physicalBinding','controlSequence','qualificationScope','sourceCoverage','ownerProofs','resetStateDigest',...Object.keys(profileFields(profile))].sort()))quarantine();
    for(let i=0;i<profile.owners.length;i++){const proof=r.ownerProofs[i],n=profile.owners[i];if(!proof||proof.namespace!==n||proof.ownerSchema!==3||proof.receiptRetention!=='retain-all-v1'||!(/^[a-f0-9]{64}$/).test(proof.guardFingerprint)||C.canonical(proof.ownerBinding)!==C.canonical(m.ownerBindings[n])||C.canonical(Object.keys(proof).sort())!==C.canonical(['namespace','ownerBinding','ownerSchema','guardFingerprint','receiptRetention'].sort()))quarantine();}
    return r;
    }catch(error){if(error.code==='INITIAL_QUALIFICATION_REQUIRED'||(observation&&['RESOURCE_LIMIT','OBSERVATION_EXPIRED','OBSERVATION_CHECK_TIMEOUT'].includes(error.code)))throw error;if(/locked|busy/i.test(error.message))C.fail('AUTHORITY_BUSY');quarantine();}
  };
  // Validate the retained semantic-setting chain and its exact current projection.
  // Bound aggregate storage before materializing journal or route rows.
  const readRoutes = (db,initial=readInitial(db)) => {
    if(profile.id!==C.CORE3_AUTHORITY_PROFILE)C.fail('AUTHORITY_PROFILE_UNSUPPORTED');
    if(!initial)C.fail('INITIAL_QUALIFICATION_REQUIRED');
    const count=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(LENGTH(CAST(journal_json AS BLOB))),0) AS bytes FROM lifecycle_operations WHERE operation_id<>?').get(qualificationId);
    if(count.n>Routes.LIMITS.receipts||count.bytes>Routes.LIMITS.totalBytes)C.fail('RESOURCE_LIMIT');
    const rows=db.prepare(`SELECT ${boundedText('operation_id',240)},${boundedText('kind',32)},${boundedText('status',32)},${boundedText('journal_json',Routes.LIMITS.receiptBytes)} FROM lifecycle_operations WHERE operation_id<>? LIMIT ${Routes.LIMITS.receipts+1}`).all(qualificationId);
    const header=stateRow(db),retained=[];
    for(const row of rows){
      if(row.kind!==Routes.KIND||row.status!=='committed'||typeof row.journal_json!=='string')quarantine();
      let r;try{r=JSON.parse(row.journal_json);if(C.canonical(r)!==row.journal_json)quarantine();Routes.receipt(r,{marker:m,initial,controlSequence:header.control_sequence});if(row.operation_id!==r.operationId)quarantine();}catch{quarantine();}retained.push(r);
    }
    retained.sort((a,b)=>a.controlSequence-b.controlSequence);const projected=new Map();let sequence=1;
    for(const r of retained){if(r.controlSequence<=sequence)quarantine();sequence=r.controlSequence;const key=C.canonical([r.route.namespace,r.route.scopeId]),previous=projected.get(key)||null;if(C.canonical(previous)!==C.canonical(r.request.expectedRoute))quarantine();projected.set(key,r.route);}
    const total=db.prepare('SELECT COUNT(*) AS n FROM authority_routes').get().n;if(total>Routes.LIMITS.routes)C.fail('RESOURCE_LIMIT');
    const actual=db.prepare(`SELECT ${['namespace','scope_id','scope_key','mode','override_kind','dependency_digest','transition_json'].map(k=>boundedText(k,k==='namespace'?9:k==='transition_json'?65536:2800)).join(',')},${boundedIntegerColumn('mode_epoch')} FROM authority_routes LIMIT ${Routes.LIMITS.routes+1}`).all();
    if(actual.length!==projected.size)quarantine();const result=[];
    for(const row of actual){let r;try{r=Routes.fromRow(row);}catch{quarantine();}if(C.canonical(projected.get(C.canonical([r.namespace,r.scopeId]))||null)!==C.canonical(r))quarantine();result.push(r);}
    return {routes:result,receipts:retained};
  };
  const initialContext = () => {
    const row=stateRow(writer),receipt=readInitial(writer);readFences(writer);
    if(profile.id===C.CORE3_AUTHORITY_PROFILE){if(receipt)readRoutes(writer,receipt);}
    else if(writer.prepare('SELECT 1 FROM authority_routes LIMIT 1').get()||writer.prepare('SELECT 1 FROM lifecycle_operations WHERE operation_id<>? LIMIT 1').get(qualificationId))quarantine();
    if(receipt){if(writer.prepare("SELECT 1 FROM write_intents WHERE status='pending' LIMIT 1").get())C.fail('AUTHORITY_BUSY');}
    else {for(const table of ['write_intents','authority_decisions','authority_routes','lifecycle_operations'])if(writer.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())quarantine();}
    const resetStateDigest=initialResetEvidence(p.dataDir,m.ownerBindings,profile);
    if(receipt&&receipt.resetStateDigest!==resetStateDigest)quarantine();
    return {branch:receipt?'REPLAY':'FIRST',authorityProfile:profile.id,activationId:m.activationId,generation:m.generation,physicalBinding:C.clone(m.physicalBinding),ownerBindings:C.clone(m.ownerBindings),resetStateDigest,receipt};
  };
  const nextSequence = () => { const next = C.increment(stateRow(writer).control_sequence); writer.prepare('UPDATE authority_state SET control_sequence=? WHERE singleton=1').run(next); return next; };
  const api = {
    readWitness({ namespace, scopeId } = {}) {
      return read(db => {
        const s = stateRow(db), pending = db.prepare(`SELECT ${R.boundedJsonColumn('intent_json')} FROM write_intents WHERE status='pending'`).get();
        const fences = readFences(db);
        const resetEpochs = {}; for (const f of fences) resetEpochs[f.namespace] = f.reset_epoch;
        let route = null;
        if (namespace !== undefined || scopeId !== undefined) {
          C.profileNamespace(namespace,profile.id); C.identifier(scopeId);
          const r = db.prepare('SELECT * FROM authority_routes WHERE namespace=? AND scope_id=?').get(namespace,scopeId);
          if (r) route = { namespace:r.namespace,scopeId:r.scope_id,scopeKey:r.scope_key,mode:r.mode,modeEpoch:r.mode_epoch,overrideKind:r.override_kind,dependencyDigest:r.dependency_digest,transition:r.transition_json?JSON.parse(r.transition_json):null };
        }
        return { contract:profile.contract,...profileFields(profile),status:s.status==='ready'&&pending?'pending':s.status,physicalBinding:C.clone(m.physicalBinding),generation:s.generation,providerIncarnation:incarnation,controlSequence:s.control_sequence,resetEpochs,route,pendingIntent:pending?R.parseControl(pending.intent_json):null };
      });
    },
    readOperation(key) { return read(db=>lookup(db,key)); },
    readInitialQualification() { return read(db=>readInitial(db)); },
    readRoutes() { return read(db=>readRoutes(db).routes); },
    readRouteOperation(namespace,operationId) { C.profileNamespace(namespace,profile.id);C.identifier(operationId);return read(db=>{const receipt=readRoutes(db).receipts.find(r=>r.operationId===operationId&&r.route.namespace===namespace);return receipt?{status:'committed',receipt:C.clone(receipt)}:{status:'uncertain',operationId};}); },
    readRouteSelection({namespace,scopeId,scopeKey}) { return read(db=>Routes.effective(readRoutes(db).routes,namespace,scopeId,scopeKey)); },
    commitRouteTransition(permit,input,ownerLocks) {
      const state=PERMITS.get(permit);if(!state||state.control!==api)C.fail('INVALID_CONTROL_PERMIT');assertControlPermit(permit);
      if(profile.id!==C.CORE3_AUTHORITY_PROFILE)C.fail('AUTHORITY_PROFILE_UNSUPPORTED');
      const value=Routes.request(input.namespace,{operationId:input.operationId,expectedRoute:input.expectedRoute,target:input.target}),initial=readInitial(writer),history=readRoutes(writer,initial);
      const prior=history.receipts.find(r=>r.operationId===value.operationId);
      if(prior){if(prior.fingerprint!==C.hash(value))C.fail('OPERATION_CONFLICT');return C.clone(prior);}
      if(value.operationId===qualificationId)C.fail('OPERATION_CONFLICT');
      if(stateRow(writer).status!=='ready'||writer.prepare("SELECT 1 FROM write_intents WHERE status='pending' LIMIT 1").get())C.fail('AUTHORITY_BUSY');
      if(!Array.isArray(ownerLocks)||ownerLocks.length!==profile.owners.length)C.fail('INVALID_INITIAL_OWNER_LOCK');
      const locks=Array.from(ownerLocks),verifier=require('./owner-store.cjs').assertInitialOwnerLock,proofs=locks.map(lock=>verifier(lock,permit));
      if(C.canonical(proofs)!==C.canonical(initial.ownerProofs))quarantine();
      const actual=history.routes.find(r=>r.namespace===value.namespace&&r.scopeId===value.target.scopeId)||null;
      if(C.canonical(actual)!==C.canonical(value.expectedRoute))C.fail('AUTHORITY_ROUTE_CHANGED');
      if(!actual&&history.routes.length>=Routes.LIMITS.routes)C.fail('RESOURCE_LIMIT');
      if(history.receipts.length>=Routes.LIMITS.receipts)C.fail('RESOURCE_LIMIT');
      for(const lock of locks)verifier(lock,permit);
      const route=Routes.next(value),receipt={schema:Routes.RECEIPT,operationId:value.operationId,fingerprint:C.hash(value),authorityProfile:profile.id,physicalBinding:C.clone(m.physicalBinding),generation:m.generation,controlSequence:nextSequence(),initialQualificationId:qualificationId,ownerProofs:proofs,request:value,route,nativeAuthority:'unavailable',recallEligibility:'unqualified'};
      const encoded=C.canonical(receipt);if(Buffer.byteLength(encoded)>Routes.LIMITS.receiptBytes)C.fail('RESOURCE_LIMIT');
      writer.prepare('INSERT INTO authority_routes VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(namespace,scope_id) DO UPDATE SET scope_key=excluded.scope_key,mode=excluded.mode,mode_epoch=excluded.mode_epoch,override_kind=excluded.override_kind,dependency_digest=excluded.dependency_digest,transition_json=NULL').run(route.namespace,route.scopeId,route.scopeKey,route.mode,route.modeEpoch,route.overrideKind,route.dependencyDigest);
      writer.prepare('INSERT INTO lifecycle_operations VALUES(?,?,?,?)').run(value.operationId,Routes.KIND,'committed',encoded);
      return receipt;
    },
    commitInitialQualification(permit,ownerLocks) {
      const state=PERMITS.get(permit);if(!state||state.control!==api)C.fail('INVALID_CONTROL_PERMIT');
      const context=assertInitialQualificationContext(permit);
      if(!Array.isArray(ownerLocks)||ownerLocks.length!==profile.owners.length)C.fail('INVALID_INITIAL_OWNER_LOCK');
      // Snapshot caller-controlled array access before measuring ANY lock.
      const locks=Array.from(ownerLocks);
      const verifier=require('./owner-store.cjs').assertInitialOwnerLock;
      const proofs=locks.map(lock=>verifier(lock,permit));
      if(C.canonical(proofs.map(p=>p.namespace))!==C.canonical(profile.owners))C.fail('INVALID_INITIAL_OWNER_LOCK');
      if(initialResetEvidence(p.dataDir,m.ownerBindings,profile)!==context.resetStateDigest)quarantine();
      // Recheck after all supplied input has been consumed. No caller code runs
      // between this final validation and the two fixed publication statements.
      for(const lock of locks)verifier(lock,permit);
      const current=initialContext();if(C.canonical(current)!==C.canonical(context))quarantine();
      if(context.branch==='REPLAY'){if(C.canonical(context.receipt.ownerProofs)!==C.canonical(proofs))quarantine();return C.clone(context.receipt);}
      const receipt={contract:profile.qualificationContract,...profileFields(profile),qualificationId,activationId:m.activationId,generation:m.generation,physicalBinding:C.clone(m.physicalBinding),controlSequence:1,qualificationScope:profile.qualificationScope,ownerProofs:proofs,resetStateDigest:context.resetStateDigest,sourceCoverage:coverage};
      const encoded=C.canonical(receipt);if(Buffer.byteLength(encoded)>65536)C.fail('RESOURCE_LIMIT');
      writer.prepare('INSERT INTO lifecycle_operations VALUES(?,?,?,?)').run(qualificationId,'initial_owner_qualification','committed',encoded);
      const changed=writer.prepare("UPDATE authority_state SET status='ready',control_sequence=1 WHERE singleton=1 AND status='preparing' AND control_sequence=0").run();if(changed.changes!==1)quarantine();
      return receipt;
    },
    withExclusiveGate(work) {
      C.synchronous(work); verify(); if (active) C.fail('NESTED_CONTROL_GATE');
      // Own the attempt before BEGIN, including an error reported after success.
      active = true; const owners = new Set(), permit = Object.freeze({});
      const access = Object.freeze({
        authorityProfile:profile.id,physicalBinding:C.clone(m.physicalBinding),generation:m.generation,ownerBindings:C.clone(m.ownerBindings),
        readOperation:key=>lookup(writer,key),
        registerOwner(token) { if (!active || !PERMITS.get(permit)?.active) C.fail('INVALID_CONTROL_PERMIT'); owners.add(token); },
        endOwner(token) { owners.delete(token); }
      });
      PERMITS.set(permit,{active:false,profile,db:writer,verify,access,control:api,initialContext,initial:null});
      try {
        writer.exec('BEGIN IMMEDIATE'); PERMITS.get(permit).active=true;
        checkSchema(writer,profile); stateRow(writer);
        const result = C.noPromise(work(permit));
        if (owners.size) fatalUnsafeEnd();
        writer.exec('COMMIT'); return result;
      } catch (error) {
        if (owners.size) fatalUnsafeEnd();
        if (rollbackOrClose(writer)) { writer=new DatabaseSync(p.file); configure(writer); checkSchema(writer,profile); }
        if (/locked|busy/i.test(error.message)) C.fail('AUTHORITY_BUSY');
        throw error;
      } finally { PERMITS.get(permit).active=false; active=false; }
    },
    publishIntent(input) {
      C.profileNamespace(input?.namespace,profile.id);
      const value = C.intent(input);
      return api.withExclusiveGate(permit=>{
        const prior = lookup(writer,value);
        if (prior) { if (prior.fingerprint !== value.fingerprint || prior.operationClass !== value.operationClass || C.canonical(prior.expectedRoute??null) !== C.canonical(value.expectedRoute??null)) C.fail('OPERATION_CONFLICT'); const {status,decision,...stored}=prior; return status==='pending'?stored:prior; }
        const state=stateRow(writer);
        if (state.status !== 'ready') C.fail('AUTHORITY_UNAVAILABLE');
        if (state.generation !== value.generation) C.fail('AUTHORITY_GENERATION_CHANGED');
        if (writer.prepare("SELECT 1 FROM write_intents WHERE status='pending'").get() || writer.prepare("SELECT 1 FROM lifecycle_operations WHERE status='pending'").get()) C.fail('AUTHORITY_BUSY');
        if (value.expectedRoute) {
          const r=value.expectedRoute,row=writer.prepare('SELECT * FROM authority_routes WHERE namespace=? AND scope_id=?').get(value.namespace,C.identifier(r.scopeId));
          if (!row || row.transition_json || row.mode_epoch!==r.modeEpoch || row.scope_key!==r.scopeKey || row.mode!==r.mode || row.dependency_digest!==r.dependencyDigest) C.fail('AUTHORITY_ROUTE_CHANGED');
        }
        const fence=readFences(writer).find(f=>f.namespace===value.namespace);
        if (!fence || C.canonical(JSON.parse(fence.binding_json))!==C.canonical(m.ownerBindings[value.namespace])) quarantine();
        const stored={...value,controlSequence:nextSequence(),physicalBinding:C.clone(m.physicalBinding),ownerBinding:JSON.parse(fence.binding_json),fenceEpoch:fence.fence_epoch};
        writer.prepare('INSERT INTO write_intents VALUES(?,?,?,?,?,?,?,?)').run(value.generation,value.namespace,value.operationId,value.fingerprint,value.operationClass,stored.controlSequence,C.canonical(stored),'pending');
        return stored;
      });
    },
    finalizeIntent(permit,intent,decision) {
      assertControlPermit(permit,intent); if (!['committed','aborted'].includes(decision?.status)) C.fail('INVALID_AUTHORITY_DECISION');
      const value=C.clone(decision); nextSequence();
      writer.prepare('INSERT INTO authority_decisions VALUES(?,?,?,?)').run(intent.generation,intent.namespace,intent.operationId,C.canonical(value));
      writer.prepare('UPDATE write_intents SET status=? WHERE generation=? AND namespace=? AND operation_id=?').run(value.status,intent.generation,intent.namespace,intent.operationId);
      return lookup(writer,intent);
    },
    close() { if (active) C.fail('AUTHORITY_BUSY'); if (!closed) { closeOrFailStop(writer); closeOrFailStop(reader); closed=true; } }
  };
  try { api.readWitness(); STORES.set(api,{dataDir:p.dataDir,verify,assertLive(){if(closed)C.fail('AUTHORITY_CLOSED');},marker:m,profile,incarnation,stateRow,readFences,readInitial,readRoutes,checkSchema}); return Object.freeze(api); } catch (error) { api.close(); throw error; }
}

// Brand-only admission. This deliberately does not call assertAuthorityStore,
// readWitness, the existing reader, or any writer/binder/qualifier method.
function openBackendObservationControlReader({control,dataDir}) {
 const state=STORES.get(control);if(!state)C.fail('INVALID_AUTHORITY_STORE');state.assertLive();
 if(path.resolve(dataDir)!==state.dataDir)quarantine();let closed=false;
 const context=Object.freeze({dataDir:state.dataDir,marker:require('./observation-json.cjs').freeze(C.clone(state.marker)),profile:state.profile,assertLive(){if(closed)C.fail('AUTHORITY_CLOSED');state.assertLive();}});
 const reader=Object.freeze({readFresh(budget,routeRequest=null){
  context.assertLive();const IO=require('./observation-io.cjs');IO.assertBudget(budget);
  const resetBefore=IO.bindingEvidence(context,budget),session=IO.begin(paths(dataDir).file,budget);let witness;
  try {
   const db=IO.evidenceDatabase(session.db,budget);state.checkSchema(db,state.profile);
   const header=state.stateRow(db),fences=state.readFences(db,{observation:true}),receipt=state.readInitial(db,{observation:true});
   if(!receipt)C.fail('INITIAL_QUALIFICATION_REQUIRED');
   if(receipt.resetStateDigest!==resetBefore)quarantine();
   const lifecyclePredicate=state.profile.id===C.CORE3_AUTHORITY_PROFILE?"status='pending' OR (operation_id<>? AND (kind<>'semantic_route_v1' OR status<>'committed'))":"status='pending' OR operation_id<>?";
   const pending=db.prepare("SELECT EXISTS(SELECT 1 FROM write_intents WHERE status='pending') AS pending_write,EXISTS(SELECT 1 FROM lifecycle_operations WHERE "+lifecyclePredicate+") AS pending_lifecycle").get(receipt.qualificationId);
   if(header.status==='lifecycle_pending'||pending.pending_lifecycle)C.fail('SOURCE_PROOF_UNAVAILABLE');
   if(header.status!=='ready')quarantine();if(pending.pending_write)C.fail('AUTHORITY_BUSY');
   const routeSelection=routeRequest?Routes.effective(state.readRoutes(db,receipt).routes,routeRequest.namespace,routeRequest.scopeId,routeRequest.scopeKey):null;
   const m=state.marker,f=fences.find(row=>row.namespace==='libra'),proof=receipt.ownerProofs.find(row=>row.namespace==='libra');
   witness={authorityContract:state.profile.contract,authorityProfile:state.profile.id,qualificationScope:state.profile.qualificationScope,bindingModel:'qualified-writer-observed-path.v1',activationId:m.activationId,initialQualificationId:receipt.qualificationId,initialReceiptDigest:C.hash(receipt),physicalBinding:C.clone(m.physicalBinding),controlFileIdentity:C.clone(m.controlFileIdentity),generation:m.generation,providerIncarnation:state.incarnation,controlSequence:header.control_sequence,status:'ready',pendingWrite:false,pendingLifecycle:false,resetStateDigest:resetBefore,resetEpochs:Object.fromEntries(fences.map(row=>[row.namespace,row.reset_epoch])),ownerBinding:C.clone(m.ownerBindings.libra),ownerFenceEpoch:f.fence_epoch,ownerGuardFingerprint:proof.guardFingerprint,ownerSchema:3,...(routeRequest?{routeSelection}: {})};
  } finally {IO.end(session);}
  if(IO.bindingEvidence(context,budget)!==resetBefore)quarantine();context.assertLive();budget.check();return witness;
 },close(){closed=true;}});
 OBSERVATION_READERS.set(reader,context);return reader;
}
function assertBackendObservationControlReader(reader){const state=OBSERVATION_READERS.get(reader);if(!state)C.fail('INVALID_AUTHORITY_STORE');state.assertLive();return state;}

module.exports = { openBackendObservationControlReader,assertBackendObservationControlReader, readActivationState,initializeAuthorityStore,openAuthorityStore,assertAuthorityStore,assertControlPermit,fileIdentity,verifyPhysical,ownerFile,fatalUnsafeEnd,rollbackOrClose,closeOrFailStop,checkOwnerSchemaVersion,boundedText,boundedIntegerColumn,boundedCatalog,requireRealTables,readBoundedEvidenceFile,assertInitialQualificationContext };
