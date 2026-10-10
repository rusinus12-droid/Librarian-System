'use strict';
// Faults and no-network traps exist only in test fixtures. Production has no knobs.
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
function installTraps(){
 const deny=()=>{if(process.env.LIBRA_NETWORK_AUDIT)fs.appendFileSync(process.env.LIBRA_NETWORK_AUDIT,JSON.stringify({kind:'TEST_NETWORK_OR_MODEL_FORBIDDEN',pid:process.pid})+'\n');throw new Error('TEST_NETWORK_OR_MODEL_FORBIDDEN');};global.__authorityModelCall=deny;
 if(process.env.LIBRA_NETWORK_AUDIT&&process.env.NODE_OPTIONS?.includes('/no-network.cjs'))return;global.fetch=deny;global.WebSocket=deny;
 for(const [name,methods] of [['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:dns',['lookup','resolve']]]){const mod=require(name);for(const method of methods)mod[method]=deny;}
}
function installFaults({point,mode='throw',releaseFile}={}){
 const original={exec:DatabaseSync.prototype.exec,prepare:DatabaseSync.prototype.prepare,close:DatabaseSync.prototype.close};let fired=false,controlCommits=0,openIterator;
 const kind=db=>{const file=original.prepare.call(db,'PRAGMA database_list').all().find(x=>x.name==='main')?.file||'';return file.endsWith('server-authority.sqlite')?'control':'owner';};
 function hit(name){if(fired||point!==name)return;fired=true;if(mode==='kill')process.kill(process.pid,'SIGKILL');if(mode==='pause'){process.send?.({event:'paused',point});const end=Date.now()+30000;while(!fs.existsSync(releaseFile)){if(Date.now()>end)process.exit(71);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}return;}throw Object.assign(new Error('TEST_SQLITE_FAILURE'),{code:name==='disk_full'?'SQLITE_FULL':'SQLITE_IOERR'});}
 DatabaseSync.prototype.exec=function(sql){
  const k=kind(this),text=String(sql).trim().toUpperCase();
  if(k==='control'&&text==='BEGIN IMMEDIATE')hit('before_control_begin');
  if(k==='control'&&text==='COMMIT'){controlCommits++;if(controlCommits===1)hit('before_intent_commit');if(controlCommits===2)hit('control_commit_error_before');}
  if(k==='owner'&&text==='COMMIT'){if(['unsafe_end','unfinalized_close'].includes(point)){openIterator=original.prepare.call(this,'SELECT * FROM kv').iterate();openIterator.next();throw Object.assign(new Error('TEST_SQLITE_COMMIT_FAILURE'),{code:'SQLITE_IOERR'});}hit('owner_commit_error');}
  if(k==='control'&&text==='ROLLBACK'&&point==='unsafe_control_begin')throw Object.assign(new Error('TEST_CONTROL_ROLLBACK_FAILURE'),{code:'SQLITE_IOERR'});
  if(k==='owner'&&text==='ROLLBACK'&&['unsafe_end','unfinalized_close'].includes(point))throw Object.assign(new Error('TEST_SQLITE_ROLLBACK_FAILURE'),{code:'SQLITE_IOERR'});
  const result=original.exec.call(this,sql);
  if(k==='control'&&text==='COMMIT'){if(controlCommits===1)hit('after_intent_commit');if(controlCommits===2){hit('after_control_commit');hit('control_commit_error_after');}}
  if(k==='control'&&text==='BEGIN')hit('after_observer_begin');
  if(k==='control'&&text==='BEGIN IMMEDIATE'){if(point==='unsafe_control_begin')throw Object.assign(new Error('TEST_CONTROL_BEGIN_FAILURE'),{code:'SQLITE_IOERR'});hit('after_control_begin');}
  if(k==='owner'&&text==='BEGIN IMMEDIATE')hit('after_owner_begin');
  if(k==='owner'&&text==='COMMIT'){hit('after_owner_commit');hit('owner_commit_error_after');}
  return result;
 };
 DatabaseSync.prototype.prepare=function(sql){const stmt=original.prepare.call(this,sql),k=kind(this),raw=stmt.run;
  stmt.run=function(...args){if(k==='owner'&&/^INSERT INTO authority_write_results/i.test(sql))hit('before_retained_result');if(k==='owner'&&/^INSERT INTO authority_write_receipts/i.test(sql)){hit('before_compact_receipt');hit('disk_full');hit('io_error');}const result=raw.apply(this,args);if(k==='owner'&&/^INSERT INTO kv/i.test(sql))hit('after_source_dml');if(k==='owner'&&/^INSERT INTO authority_write_results/i.test(sql))hit('after_retained_result');if(k==='owner'&&/^INSERT INTO authority_write_touches/i.test(sql))hit('after_retained_touch');if(k==='owner'&&/^INSERT INTO authority_write_receipts/i.test(sql))hit('after_receipt');if(k==='control'&&/^UPDATE write_intents SET status/i.test(sql))hit('after_finalization_sql');return result;};return stmt;};
 DatabaseSync.prototype.close=function(){if(point==='unsafe_control_begin'&&kind(this)==='control')throw Object.assign(new Error('TEST_CONTROL_CLOSE_BUSY'),{code:'SQLITE_BUSY'});if(point==='unsafe_end'&&kind(this)==='owner')throw Object.assign(new Error('TEST_SQLITE_CLOSE_BUSY'),{code:'SQLITE_BUSY'});return original.close.call(this);};
 return()=>{for(const [name,method] of Object.entries(original))DatabaseSync.prototype[name]=method;};
}
module.exports={installFaults,installTraps};
