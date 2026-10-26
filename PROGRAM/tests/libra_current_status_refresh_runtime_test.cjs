'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {declaration}=require('./helpers/libra_navigation_contract.cjs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../plugins/LIBRA.js'),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;return {promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
function fixture(){
 const rows=Object.fromEntries(['storage','analysis','search'].map(id=>[id,{textContent:'',style:{}}]));
 const help={textContent:''},foot={querySelector:selector=>selector==='[data-current-status]'?rows.storage:selector==='.current-status-help'?help:rows[/="([^"]+)"/.exec(selector)?.[1]]};
 const app={querySelector:()=>foot},Runtime={},Gui={visible:true,openSerial:1,mockupApp:app};
 let snapshot={scope:{scopeKey:'A'}};const reads=[];
 const ctx={Runtime,Gui,Date,Boolean,Promise,bookCurrentStatus:{serial:0,subscribed:false},
  LibraMemoryCore:{peekSnapshot:()=>snapshot},libraEmbeddingStatusSummary:()=>({state:'ready'}),
  isLibraServerUnavailableError:error=>error?.code==='MEMORY_SUITE_SERVER_UNAVAILABLE',
  MemorySuiteStorageBridge:{getScopeMode:()=>{const read=deferred();reads.push(read);return read.promise;},getConnectionSettings:()=>{const read=deferred();reads.push(read);return read.promise;},subscribeSyncJob:()=>()=>{}}
 };vm.createContext(ctx);vm.runInContext(declaration(source,'syncBookCurrentStatus')+'\nthis.sync=syncBookCurrentStatus;',ctx);
 return {rows,app,Runtime,Gui,reads,sync:()=>ctx.sync(app),setScope:scopeKey=>{snapshot=scopeKey?{scope:{scopeKey}}:{};}};
}
(async()=>{
 const f=fixture();f.sync();f.reads.at(-1).resolve({mode:'server_only'});await flush();
 assert.equal(f.rows.storage.textContent,'저장: 서버 모드');
 f.sync();assert.equal(f.rows.storage.textContent,'저장: 서버 모드','same-context recheck must retain its observed mode');
 const old=f.reads.at(-1);f.sync();f.reads.at(-1).resolve({mode:'plugin_only'});await flush();old.reject(Error('old failure'));await flush();
 assert.equal(f.rows.storage.textContent,'저장: 플러그인 모드','late old error cannot replace current result');
 f.sync();f.reads.at(-1).reject(Object.assign(Error('superseded probe'),{code:'MEMORY_SUITE_CONNECTION_STALE'}));await flush();
 assert.equal(f.rows.storage.textContent,'저장: 플러그인 모드','supersession is not a disconnection');
 f.sync();f.reads.at(-1).reject(Object.assign(Error('offline'),{code:'MEMORY_SUITE_SERVER_UNAVAILABLE'}));await flush();
 assert.equal(f.rows.storage.textContent,'저장: 서버 연결 확인 필요','genuine current errors remain visible');
 f.setScope('B');f.sync();assert.equal(f.rows.storage.textContent,'저장: 확인 중','another chat needs its own result');
 f.reads.at(-1).resolve({mode:'server_only'});await flush();
 f.sync();const obsolete=f.reads.at(-1);f.setScope('C');obsolete.reject(Object.assign(Error('old scope offline'),{code:'MEMORY_SUITE_SERVER_UNAVAILABLE'}));await flush();
 assert.equal(f.rows.storage.textContent,'저장: 서버 모드','scope-changed error is discarded even before next render');
 f.Gui.openSerial++;f.sync();assert.equal(f.rows.storage.textContent,'저장: 확인 중','reopened GUI resets context');f.reads.at(-1).resolve({mode:'plugin_only'});await flush();
 f.setScope('');f.sync();f.reads.at(-1).resolve({global:{set:true,mode:'server_only'}});await flush();
 assert.equal(f.rows.storage.textContent,'전역 저장: 서버 모드');f.sync();assert.equal(f.rows.storage.textContent,'전역 저장: 서버 모드','global context refresh also retains its result');
 f.reads.at(-1).resolve({global:{set:true,mode:'plugin_only'}});await flush();assert.equal(f.rows.storage.textContent,'전역 저장: 플러그인 모드');
 console.log('PASS LIBRA sidebar: scoped/global pending refresh, stale success/failure, real failure, chat and GUI changes');
})().catch(error=>{console.error(error);process.exitCode=1;});
