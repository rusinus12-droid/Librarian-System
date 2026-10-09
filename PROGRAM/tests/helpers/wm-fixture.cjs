'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sdkPath = path.resolve(__dirname, '../../sdk/WmStorageContracts.source.js');
const vendorPath = path.resolve(__dirname, '../../wm/src/wm-storage-contracts.source.js');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);
const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
const seal = value => ({...value, manifestDigest:sha(Buffer.from(stable(omit(value,'manifestDigest'))))});
const fingerprint = value => sha(Buffer.from(stable(omit(value,'requestFingerprint'))));
const clone = value => JSON.parse(JSON.stringify(value));
const raw = '비밀\r\n🌍 lmai_secret_knowledge is story data';
const head = (scope = 'scope-a') => ({protocol:'wm.snapshot-authority.v1',authorityId:'authority-a',storeId:'store-a',scope,epoch:'epoch-a',revision:'revision-0',schema:'wm.canonical-raw.v1',generationId:'generation-0',sha256:sha(Buffer.alloc(0)),utf8Bytes:0,tombstone:true});
const route = () => ({schema:'wm.storage-route.v1',mode:'plugin_only',routeGeneration:'route-1',datasetId:'dataset-a',backendId:'native-a',state:'active'});
const item = (domain = 'raw', id = 'raw-1', dependencies = []) => ({domain,schema:{raw:'wm.raw-turn.v1',cold:'wm.cold-shard.v1',raw_history:'wm.raw-history.v1',lineage:'wm.lineage.v1',orphan:'wm.orphan.v1'}[domain],logicalId:id,originScope:'scope-a',bytes:3,sha256:sha(Buffer.from('abc')),dependencies,disposition:null});
const manifest = () => seal({schema:'wm.generation-manifest.v1',scope:'scope-a',generationId:'generation-1',canonical:{sha256:sha(Buffer.from(raw)),utf8Bytes:Buffer.byteLength(raw)},items:[item()],routeGeneration:'route-1',writerEpoch:'epoch-a',expectedHead:head(),operationId:'operation-1'});
const write = () => {const v={operationId:'operation-1',operation:'normal',scope:'scope-a',expectedHead:head(),routeGeneration:'route-1',writerEpoch:'epoch-a',raw,manifest:manifest()};return {...v,requestFingerprint:fingerprint(v)};};
const storySecret = () => ({key:'lmai_secret_knowledge',schema:null,value:{version:1,scopeKey:'scope-a',chatId:'chat-a',secrets:[{id:'sk_1',title:'Hidden name',content:'비밀\r\n🌍 secret token password are story words',about:['Alice'],owner:'user',knownBy:['user'],sensitivity:'normal',status:'active',source:'explicit-tag',evidenceLog:[{turn:1,viewerId:'user',source:'story',note:'password is a plot device',at:1}]}]}});
// Missing production exports become assertion failures in RED, never module-path/toolchain errors.
const load = () => fs.existsSync(sdkPath) ? require(sdkPath) : Object.freeze({});
module.exports = {sdkPath,vendorPath,sha,stable,seal,fingerprint,clone,raw,head,route,item,manifest,write,storySecret,load};

// A2 synthetic SQLite helpers. Fault injection and direct mutation stay test-only.
const storePath = path.resolve(__dirname, '../../server/wm/store.cjs');
const loadStore = () => fs.existsSync(storePath) ? require(storePath) : Object.freeze({});
const storeIdentity = () => ({authorityId:'authority-a',storeId:'store-a',datasetId:'dataset-a',backendId:'server-a',routeGeneration:'route-1',writerEpoch:'epoch-a'});
const storeRoute = () => ({schema:'wm.storage-route.v1',mode:'server_only',routeGeneration:'route-1',datasetId:'dataset-a',backendId:'server-a',state:'active'});
const signed = value => ({...value,requestFingerprint:fingerprint(value)});
const initialization = (scope='scope-a',operationId='initialize-1',writerEpoch='epoch-a',routeGeneration='route-1') => signed({scope,operationId,routeGeneration,writerEpoch,expectedEmpty:true});
const storeWrite = (expectedHead,{operationId='write-1',generationId='generation-1',operation='normal',raw:canonical=raw,items=[],writerEpoch=expectedHead.epoch,routeGeneration='route-1'}={}) => {
 const m=seal({schema:'wm.generation-manifest.v1',scope:expectedHead.scope,generationId,canonical:{sha256:sha(Buffer.from(canonical===null?'':canonical)),utf8Bytes:Buffer.byteLength(canonical===null?'':canonical)},items,routeGeneration,writerEpoch,expectedHead,operationId});
 return signed({operationId,operation,scope:expectedHead.scope,expectedHead,routeGeneration,writerEpoch,raw:canonical,manifest:m});
};
// Inventory fingerprints bind descriptor order and exact payload bytes using {encoding:'base64',data}.
const inventoryWrite = ({operationId='inventory-1',writerEpoch='epoch-a',routeGeneration='route-1',expectedInventoryRevision='inventory-0',items=[]}={}) => {
 const v={operationId,writerEpoch,routeGeneration,expectedInventoryRevision,items};
 const wire={...v,items:items.map(x=>({descriptor:x.descriptor,payload:{encoding:'base64',data:Buffer.from(x.payload).toString('base64')}}))};
 return {...v,requestFingerprint:fingerprint(wire)};
};
function sqliteRead(databasePath,sql,...args){const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(databasePath,{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}}
function sqliteMutate(databasePath,work){const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(databasePath);try{return work(db);}finally{db.close();}}
function faultSqlite({sqlPattern,phase='before',kind='crash'},work){
 const {DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.exec;let hit=false;
 DatabaseSync.prototype.exec=function(sql){
  if(!hit && sqlPattern.test(sql)){hit=true;if(phase==='after')original.call(this,sql);if(kind==='crash')this.close();const e=Error(kind==='disk_full'?'injected_SQLITE_FULL':'injected_crash');e.code=kind==='disk_full'?'SQLITE_FULL':'SQLITE_IOERR';throw e;}
  return original.call(this,sql);
 };
 try{const result=work();return {result,hit};}finally{DatabaseSync.prototype.exec=original;}
}
module.exports = {...module.exports,storePath,loadStore,storeIdentity,storeRoute,signed,initialization,storeWrite,inventoryWrite,sqliteRead,sqliteMutate,faultSqlite};
function limitSqlitePages(work){const {DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.exec;let pages;DatabaseSync.prototype.exec=function(sql){if(pages===undefined && sql==='BEGIN IMMEDIATE'){pages=this.prepare('PRAGMA page_count').get().page_count;original.call(this,'PRAGMA max_page_count='+pages);}return original.call(this,sql);};try{return {result:work(),pages};}finally{DatabaseSync.prototype.exec=original;}}
module.exports.limitSqlitePages=limitSqlitePages;
function inspectSqlitePragmas(work){const {DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.exec;let pragmas;DatabaseSync.prototype.exec=function(sql){const r=original.call(this,sql);if(sql.includes('PRAGMA journal_mode=WAL'))pragmas={journalMode:this.prepare('PRAGMA journal_mode').get().journal_mode,synchronous:this.prepare('PRAGMA synchronous').get().synchronous,foreignKeys:this.prepare('PRAGMA foreign_keys').get().foreign_keys};return r;};try{return {result:work(),pragmas};}finally{DatabaseSync.prototype.exec=original;}}
module.exports.inspectSqlitePragmas=inspectSqlitePragmas;
