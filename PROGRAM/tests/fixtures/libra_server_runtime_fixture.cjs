'use strict';
// Real deployed LIBRA + its real storage bridge + local HTTP/SQLite.
// Only the RisuAI UI/LLM boundary is controlled; no replacement memory engine.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer}=require('../../server/server.cjs');
const {fixture,artifact}=require('./libra_unified_runtime_fixture.cjs');
async function serverFixture(options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'libra-product-server-'));
 const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});
 const address=await app.listen(),url=`http://127.0.0.1:${address.port}`,batches=[],requests=[];
 const local=new Map([['libra:v1:scope-registry:v1',JSON.stringify({'unified-char::unified-chat':{scopeKey:'seventh-server-scope',characterId:'unified-char',chatId:'unified-chat',source:'preexisting_explicit_user_scope'}})]]);
 const backend={getItem:async k=>local.get(k)??null,setItem:async(k,v)=>{local.set(k,v);return true;},removeItem:async k=>{local.delete(k);return true;},keys:async()=>[...local.keys()]};
 const hooks={beforeBatch:null,afterBatch:null,externalFetch:null,beforeServerRequest:null};let f;
 const boot=await fetch(url+'/bootstrap',{headers:{'X-Memory-Suite-Plugin':'libra'}}).then(r=>r.json());
 const send=async(method,route,body)=>{const r=await fetch(url+route,{method,headers:{Authorization:`Bearer ${boot.token}`,'X-Memory-Suite-Plugin':'libra','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};};
 const storedRows=()=>app.repositories.libra.database.prepare('SELECT key,value_json,revision FROM kv WHERE deleted=0').all().map(row=>{const raw=JSON.parse(row.value_json);let value=raw;try{value=JSON.parse(raw);}catch{}return {key:row.key,raw,value,revision:row.revision};});
 const getRecords=schema=>storedRows().filter(row=>row.value?.schema===schema);
 const getManifest=()=>storedRows().find(row=>row.key.endsWith(':manifest'))?.value;
 const getMemory=(start=1)=>{const ref=getManifest()?.memories?.[String(start)];return ref?storedRows().find(row=>row.key===ref.key)?.value:null;};
 const getHead=()=>getRecords('libra.continuity_state.v2')[0]?.value;
 const mutate=async(key,value,kind='set')=>{
  const row=(await send('GET','/v1/kv/get?namespace=libra&space=plugin&key='+encodeURIComponent(key))).result;
  const mutation={key,space:'plugin',kind,expectedExists:row.exists,expectedTombstone:row.tombstone,expectedRevision:row.revision,expectedDigest:row.digest,...(kind==='set'?{value:JSON.stringify(value)}:{})};
  const r=await send('POST','/v1/kv/batch',{namespace:'libra',operationId:'external_'+Date.now()+'_'+Math.random().toString(36).slice(2),mutations:[mutation]});if(r.status!==200)throw Error(JSON.stringify(r));return r;
 };
 const start=async()=>{
  const x=await fixture({snapshot:options.snapshot,transformSource:options.transformSource,contextGlobals:options.contextGlobals,args:{memory_suite_server_mode:options.mode||'server_only',memory_suite_server_url:url,...options.args},host:{...options.host,pluginStorage:backend,safeLocalStorage:backend,getLocalPluginStorage:async()=>backend,nativeFetch:async(u,i)=>{
   requests.push({url:u,method:i?.method});if(!u.startsWith(url+'/')&&hooks.externalFetch)return await hooks.externalFetch(u,i);await hooks.beforeServerRequest?.(u,i);let body;
   if(u.endsWith('/v1/kv/batch')){body=JSON.parse(i.body);batches.push(body);await hooks.beforeBatch?.(body);}
   const r=await fetch(u,i);if(body)await hooks.afterBatch?.(body,r);return r;
  }}});
  x.getRecords=getRecords;x.getManifest=getManifest;x.getMemory=getMemory;x.getHead=getHead;return x;
 };
 try{f=await start();}catch(e){await app.close();fs.rmSync(dir,{recursive:true,force:true});throw e;}
 return {f,app,dir,url,local,backend,batches,requests,hooks,send,mutate,storedRows,getRecords,getManifest,getMemory,getHead,
  async restart(){await f.r.cleanup();f=await start();this.f=f;return f;},
  async cleanup(){await f?.r.cleanup();await app.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
function fiveMore(f){const extra=f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`}));f.chat.message.push(...extra);f.control.artifact=artifact();for(const x of [...f.control.artifact.entities,...f.control.artifact.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,n)=>`t${Number(n)+5}`);}

// An allowed lorebook, installed through the surface `collectRisuLorebookCandidates` actually reads.
// The single-mode Stage 2 suite learned this the hard way: it once passed on an EMPTY corpus, because
// `libra_unified_runtime_fixture` seeds no lore and every assertion held on empty arrays. The mode-parity
// suite needs the same non-empty corpus for the same reason, so the injection lives here rather than
// being re-derived per suite.
//
// `character.lorebook` is the confirmed source; `chat.localLore`, `chat.globalLore`, `chat.lorebook`,
// `character.loreSettings.lorebook` and `chat.data.characterBook.entries` were all measured to leave
// `allowedLoreCount` at 0.
const LORE_NAMED_ENTRY = Object.freeze({
  id: 'entry-named', name: '서재의 열쇠', label: '서재의 열쇠',
  content: '민아가 서재에서 은빛 열쇠를 찾았다. 도서관 기록회가 그 열쇠를 보관한다.',
  sourceType: 'character', source: 'character', keys: ['서재'], priority: 100,
  enabled: true, constant: true, selective: false, excludeRecursion: false, preventRecursion: false
});
const LORE_UNKNOWN_ENTRY = Object.freeze({
  id: 'entry-unknown', name: '등록되지 않은 것', label: '등록되지 않은 것',
  content: '여기에는 카탈로그에 없는 낯선 이름 하나가 적혀 있다.',
  sourceType: 'character', source: 'character', keys: ['기록'], priority: 100,
  enabled: true, constant: true, selective: false, excludeRecursion: false, preventRecursion: false
});
const withLorebook = f => { f.character.lorebook = [LORE_NAMED_ENTRY, LORE_UNKNOWN_ENTRY]; return f; };

module.exports={serverFixture,fiveMore,LORE_NAMED_ENTRY,LORE_UNKNOWN_ENTRY,withLorebook};
