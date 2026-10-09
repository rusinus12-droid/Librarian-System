'use strict';
// Storage-only WM lifecycle. Runtime identity and options are trusted server configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {createWmStore,DEFAULT_LIMITS:STORE_LIMITS,SCHEMA_DDL} = require('./store.cjs');
const {createWmPins,DEFAULT_LIMITS:PIN_LIMITS} = require('./pins.cjs');
const C = require('../../sdk/WmStorageContracts.source.js');
const DEFAULT_LIMITS = Object.freeze({...STORE_LIMITS,...PIN_LIMITS,maxBodyBytes:96*1024*1024});
const fail = (reason,statusCode=503) => {throw Object.assign(Error(reason),{code:'WM_'+reason,statusCode});};
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? '['+value.map(stable).join(',')+']' : value && typeof value==='object' ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}' : JSON.stringify(value);
function identityValid(identity) {
 if(!identity || Object.getPrototypeOf(identity)!==Object.prototype)return false;
 const keys=['authorityId','storeId','datasetId','backendId','routeGeneration','writerEpoch'];
 const ds=Object.getOwnPropertyDescriptors(identity);
 return Reflect.ownKeys(identity).length===keys.length && keys.every(k=>ds[k]?.enumerable && Object.hasOwn(ds[k],'value') && typeof ds[k].value==='string' && /^[A-Za-z0-9:_-]{1,128}$/.test(ds[k].value));
}
function negotiateLimits(requested={}) {
 if(!requested || Object.getPrototypeOf(requested)!==Object.prototype)fail('limits_invalid',400);
 const ds=Object.getOwnPropertyDescriptors(requested),result={...DEFAULT_LIMITS};
 for(const key of Reflect.ownKeys(requested)) {
  const d=ds[key];
  if(typeof key!=='string'||!Object.hasOwn(result,key)||!d.enumerable||!Object.hasOwn(d,'value')||!Number.isSafeInteger(d.value)||d.value<=0)fail('limits_invalid',400);
  result[key]=d.value;
 }
 // The integrated legacy HTTP reader has a fixed 96-MiB encoded-body ceiling.
 // This is transport negotiation, independent of total canonical/inventory capacity.
 result.maxBodyBytes=Math.min(result.maxBodyBytes,DEFAULT_LIMITS.maxBodyBytes);
 result.maxCanonicalBytes=Math.min(result.maxCanonicalBytes,result.maxGenerationBytes);
 result.maxBatchItems=Math.min(result.maxBatchItems,result.maxInventoryBatchItems);
 result.maxBatchBytes=Math.min(result.maxBatchBytes,result.maxInventoryBatchBytes);
 result.maxChunkBytes=Math.min(result.maxChunkBytes,result.maxInventoryBatchBytes);
 return Object.freeze(result);
}
// Exact schema-v1 object contract, checked read-only before the constructor can run DDL.
// Comparing complete table SQL preserves STRICT, checks, keys, uniqueness and FKs,
// rather than accepting a same-name table with only some compatible columns.
const normalizeSql = sql => String(sql || '').replace(/CREATE (TABLE|TRIGGER) IF NOT EXISTS /g,'CREATE $1 ').replace(/\s+/g,' ').trim().replace(/;$/,'');
const REQUIRED_TABLES = Object.freeze(Array.from(SCHEMA_DDL.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)\([\s\S]*?\) STRICT;/g),match=>Object.freeze({type:'table',name:match[1],table:match[1],sql:normalizeSql(match[0])})));
const REQUIRED_TRIGGERS = Object.freeze([
 ...['blobs','inventory_items','generations','generation_items','inventory_snapshot_items'].flatMap(table=>['update','delete'].map(action=>({
  type:'trigger',name:table+'_immutable_'+action,table,
  sql:normalizeSql(`CREATE TRIGGER ${table}_immutable_${action} BEFORE ${action.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'wm_immutable'); END;`)
 }))),
 {type:'trigger',name:'operations_terminal_immutable',table:'operations',sql:normalizeSql("CREATE TRIGGER operations_terminal_immutable BEFORE UPDATE ON operations WHEN OLD.status IN ('committed','conflict') BEGIN SELECT RAISE(ABORT,'wm_immutable_receipt'); END;")},
 {type:'trigger',name:'operations_immutable_delete',table:'operations',sql:normalizeSql("CREATE TRIGGER operations_immutable_delete BEFORE DELETE ON operations BEGIN SELECT RAISE(ABORT,'wm_immutable_receipt'); END;")}
]);
function admitExistingSchema(db) {
 if(REQUIRED_TABLES.length!==11)fail('schema_unsupported');
 const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND (type='trigger' OR substr(name,1,7)<>'sqlite_')").all();
 const names=new Set([...REQUIRED_TABLES,...REQUIRED_TRIGGERS].map(value=>value.type+':'+value.name));
 if(objects.some(value=>!names.has(value.type+':'+value.name)))fail('schema_unsupported');
 for(const expected of [...REQUIRED_TABLES,...REQUIRED_TRIGGERS]) {
  const actual=objects.find(value=>value.type===expected.type&&value.name===expected.name);
  if(!actual||actual.tbl_name!==expected.table||normalizeSql(actual.sql)!==expected.sql)fail('schema_unsupported');
 }
}
// Probe an existing file without schema installation, boot rotation or legacy DATA conversion.
function preflightExisting(databasePath,identity) {
 const st=fs.lstatSync(databasePath);if(!st.isFile()||st.isSymbolicLink())fail('storage_unavailable');
 let db;
 try {
  db=new DatabaseSync(databasePath,{readOnly:true});
  if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')fail('storage_unavailable');
  admitExistingSchema(db);
  const schema=db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value;
  if(schema!=='wm.sqlite.v1')fail('schema_unsupported');
  const stored=db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value;
  if(stored!==stable(identity))fail('store_identity_mismatch');
 } finally {try{db?.close();}catch{}}
}
/**
 * @param {{dataDir:string,serverIdentity:Object,clock?:()=>number,limits?:Object}} options
 * No credential/grant is created. External fence verification is deliberately absent:
 * A2's durable same-store fence proofs work; external source receipts fail closed until B5.
 */
function createWmService({pagedHistoryEnabled=false,dataDir,serverIdentity,clock=Date.now,limits={},verifySourceFenceReceipt,migrationActivationEnabled=false,verifyHandoffFence,handoffActivationEnabled=false,backupRestoreEnabled=false,databasePath:configuredDatabasePath}={}) {
 if(typeof pagedHistoryEnabled!=='boolean')fail('service_options_invalid',400);
 if(typeof backupRestoreEnabled!=='boolean')fail('service_options_invalid',400);
 if(verifyHandoffFence!==undefined&&typeof verifyHandoffFence!=='function'||typeof handoffActivationEnabled!=='boolean'||verifySourceFenceReceipt!==undefined&&typeof verifySourceFenceReceipt!=='function'||typeof migrationActivationEnabled!=='boolean')fail('service_options_invalid',400);
 if(typeof dataDir!=='string'||!dataDir||!identityValid(serverIdentity)||typeof clock!=='function')fail('service_options_invalid',400);
 const identity=Object.freeze(clone(serverIdentity)),capacity=negotiateLimits(limits);
 const root=path.resolve(dataDir),databasePath=configuredDatabasePath?path.resolve(configuredDatabasePath):path.join(root,'stores','wm','wm.sqlite');
 if(configuredDatabasePath && (!databasePath.startsWith(root+path.sep)||!fs.existsSync(databasePath)))fail('import_selected_path_invalid');
 let store,pins,unavailable='',closed=false,openingRestore=false;
 const checkPath=()=>{
  for(const directory of [root,path.join(root,'stores'),path.join(root,'stores','wm')]){
   try{const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())fail('storage_unavailable');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
 };
 const markUnavailable=()=>{try{store?.close();}catch{}store=undefined;pins=undefined;unavailable='storage_unavailable';};
 const pendingImportSelection=()=>{if(!configuredDatabasePath&&fs.existsSync(path.join(root,'config','wm-import-selection.json'))){try{store?.close();}catch{}store=undefined;pins=undefined;unavailable='import_adoption_restart_required';}};
 function open() {
  pendingImportSelection();
  if(closed)fail('service_closed');if(unavailable)fail(unavailable);
  if(store)return;
  try {
   checkPath();const suiteJournal=path.join(root,'migrations','restore-transaction.json');if(fs.existsSync(suiteJournal)){const j=JSON.parse(fs.readFileSync(suiteJournal,'utf8'));if(j.schema==='memory-suite.restore-transaction.v2'&&j.phase!=='COMMITTED'&&!openingRestore)fail('restore_recovery_required');}const restoreJournal=databasePath+'.restore-journal.json';if(fs.existsSync(restoreJournal)&&JSON.parse(fs.readFileSync(restoreJournal,'utf8')).phase!=='COMMITTED')fail('restore_recovery_required');if(fs.existsSync(databasePath))preflightExisting(databasePath,identity);
   store=createWmStore({databasePath,identity,clock,verifySourceFenceReceipt,verifyHandoffFence,limits:Object.fromEntries(Object.keys(STORE_LIMITS).map(k=>[k,capacity[k]]))});
   store.readDatasetState();
   pins=createWmPins({store,clock,bootId:'boot-'+crypto.randomUUID(),limits:Object.fromEntries(Object.keys(PIN_LIMITS).map(k=>[k,capacity[k]]))});
  }catch(e){markUnavailable();fail(unavailable);}
 }
 try{checkPath();if(fs.existsSync(databasePath))open();}catch{markUnavailable();}
 const capabilities=Object.freeze({schema:'wm.service-capabilities.v1',owner:'wm',protocol:C.PROTOCOL,backendId:identity.backendId,limits:capacity,storage:true,inventory:Object.freeze({chunkReads:true,put:'complete_payload_only',partialChunkUpload:false,migrationStaging:true}),externalFenceVerification:typeof verifySourceFenceReceipt==='function'});
 function state() {
  pendingImportSelection();
  if(!closed&&!unavailable&&store){try{return store.readDatasetState();}catch{markUnavailable();}}
  return null;
 }
 const status=()=>{
  const dataset=state();return {schema:'wm.service-status.v1',available:!closed&&!unavailable,initialized:!!store,closed,...unavailable?{reason:unavailable}:{},...dataset?{dataset}:{}};
 };
 function invoke(target,method,...args) {
  open();try{return (target==='pins'?pins:store)[method](...args);}catch(e){
   // A2 preparation deliberately returns a sanitized reason-only uncertainty error.
   // Keep its durable identity even when this connection must be abandoned.
   if(e.message==='storage_uncertain' && typeof e.operationId==='string' && typeof e.requestFingerprint==='string') {
    markUnavailable();e.code='WM_storage_uncertain';e.statusCode=503;throw e;
   }
   if(!e.code?.startsWith('WM_')||/integrity|storage_unavailable|store_closed/.test(e.code)){markUnavailable();fail(unavailable);}
   throw e;
  }
 }
 return Object.freeze({
  capabilities:()=>capabilities,status,
  manual:(action,input)=>invoke("store","manual",action,input),
  backupCapabilities:()=>({schema:'wm.backup-capabilities.v1',capture:true,restoreEnabled:backupRestoreEnabled,crossPhysicalRestore:false,restoreAdmission:'recovery_required'}),
  captureBackup:({backupId,outputDir})=>{open();return require('./backup.cjs').createWmBackup({store,pins,outputDir}).capture({backupId});},
  backupFingerprint:()=>{open();return require('./backup.cjs').createWmBackup({store,pins}).currentFingerprint();},
  prepareBackupRestore:v=>{open();return require('./backup.cjs').createWmBackup({store,pins,outputDir:v.backupRoot,restoreEnabled:backupRestoreEnabled}).prepareRestore({operationId:v.operationId,component:v.component,expectedStoreIdentity:v.expectedStoreIdentity});},
  applyBackupRestore:v=>{open();return require('./backup.cjs').createWmBackup({store,pins,outputDir:v.backupRoot,restoreEnabled:backupRestoreEnabled,onRestoreInstalled:()=>{store=undefined;pins=undefined;open();}}).applyRestore({planId:v.planId,confirmation:v.confirmation,expectedCurrentFingerprint:v.expectedCurrentFingerprint});},
  fenceForBackupRestore:v=>{if(!backupRestoreEnabled)fail('restore_provider_unqualified');open();return require('./backup.cjs').createWmBackup({store,pins,restoreEnabled:backupRestoreEnabled}).fenceRestore(v);},
  suspendForBackupRestore:()=>{if(!backupRestoreEnabled)fail('restore_provider_unqualified');try{store?.close();}finally{store=undefined;pins=undefined;}},
  resumeAfterBackupRestore:()=>{if(!backupRestoreEnabled)fail('restore_provider_unqualified');openingRestore=true;try{open();return state();}finally{openingRestore=false;}},
  suspendForImportAdoption:()=>{try{store?.close();}finally{store=undefined;pins=undefined;unavailable='import_adoption_restart_required';}},
  handoffCapabilities:()=>({schema:'wm.handoff-server-capabilities.v1',enabled:handoffActivationEnabled&&typeof verifyHandoffFence==='function',limits:capacity}),
  handoff:(method,v)=>{const methods={begin:'beginHandoffStage',chunk:'stageHandoffChunk',stageStatus:'handoffStageStatus',verifyStage:'verifyHandoffStage',materialize:'materializeHandoffStage',readback:'verifyHandoffReadback',complete:'completeHandoff',status:'handoffStatus',abort:'abortHandoffStage',rollback:'rollbackHandoff'};
    if(!Object.hasOwn(methods,method))fail('handoff_method_invalid',400);if(!handoffActivationEnabled||typeof verifyHandoffFence!=='function')fail('handoff_activation_disabled');return invoke('store',methods[method],v);},
  initializeScope:v=>invoke('store','initializeScope',v),
  historyState:()=>{if(!pagedHistoryEnabled)fail('history_profile_disabled');const dataset=invoke('store','readLifecycleState');return {schema:'wm.service-status.v1',available:true,initialized:true,closed:false,dataset};},
  historyCapabilities:()=>({schema:'wm.paged-history-capabilities.v2',profile:'server-pinned-roots-v2',enabled:pagedHistoryEnabled,pageBytes:65536,rootCount:32,stageTtlMs:300000,runtimeActivation:false}),
  beginPageStage:v=>{if(!pagedHistoryEnabled)fail('history_profile_disabled');return invoke('store','beginPageStage',v);},
  renewPageStage:v=>{if(!pagedHistoryEnabled)fail('history_profile_disabled');return invoke('store','renewPageStage',v);},
  stagePage:v=>{if(!pagedHistoryEnabled)fail('history_profile_disabled');return invoke('store','stagePage',v);},
  readStagedPage:v=>{if(!pagedHistoryEnabled)fail('history_profile_disabled');return invoke('store','readStagedPage',v);},
  findCompanions:v=>invoke('pins','findCompanions',v),
  readRootManifest:v=>invoke('pins','readRootManifest',v),readClosurePage:v=>invoke('pins','readClosurePage',v),
  prepare:v=>{if(v.manifest?.schema===C.ROOT_MANIFEST_SCHEMA&&!pagedHistoryEnabled)fail('history_profile_disabled');return invoke('store','prepare',v);},publish:v=>invoke('store','publish',v),operationStatus:v=>invoke('store','status',v),
  acquire:scope=>invoke('pins','acquire',scope),readGeneration:lease=>invoke('pins','readGeneration',lease),head:(scope,lease)=>invoke('pins','head',scope,lease),release:lease=>invoke('pins','release',lease),
  observeHeads:(scopes,options)=>invoke('pins','observeHeads',scopes,options),readCompanion:v=>invoke('pins','readCompanion',v),
  openInventory:v=>invoke('pins','openInventory',v),readInventoryPage:v=>invoke('pins','readInventoryPage',v),readInventoryChunk:v=>invoke('pins','readInventoryChunk',v),closeInventory:id=>invoke('pins','closeInventory',id),
  inspectMigrationDestination:()=>({...invoke('store','inspectMigrationDestination'),activationEnabled:migrationActivationEnabled}),
  beginMigrationStage:v=>{if(!migrationActivationEnabled)fail('migration_activation_disabled');return invoke('store','beginMigrationStage',v);},
  stageMigrationChunk:v=>invoke('store','stageMigrationChunk',v),migrationStageStatus:v=>invoke('store','migrationStageStatus',v),verifyMigrationStage:v=>invoke('store','verifyMigrationStage',v),materializeMigrationStage:v=>invoke('store','materializeMigrationStage',v),verifyMigrationReadback:v=>invoke('store','verifyMigrationReadback',v),
  putInventoryItems:v=>invoke('store','putInventoryItems',v),fenceDataset:v=>invoke('store','fenceDataset',v),activateDataset:v=>invoke('store','activateDataset',v),
  close(){if(closed)return;closed=true;try{store?.close();}catch{}pins=undefined;}
 });
}
module.exports=Object.freeze({createWmService,DEFAULT_LIMITS,admitExistingSchema,preflightExisting});
