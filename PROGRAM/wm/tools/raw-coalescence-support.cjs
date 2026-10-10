'use strict';
const assert=require('node:assert/strict'),acorn=require('acorn'),path=require('node:path');
const {fixture:cacheFixture,plain,tick}=require('./wm-native-cache-support.cjs');
function instrument(code){
 const nodes=[],todo=[acorn.parse(code,{ecmaVersion:'latest'})],edits=[];
 while(todo.length){const n=todo.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))todo.push(...v);else if(v&&typeof v==='object')todo.push(v);}
 for(const [name,text] of [
  ['LatestTurnBaselineOwner','globalThis.__RAW_OWNER_VALUES__=()=>({beforeRaw:slot?.beforeRaw,postRaw:slot?.postRaw,scopeKey:slot?.scopeKey,resetGeneration:slot?.resetGeneration});'],
  ['LibraDataStorage','globalThis.__RAW_READ_PROOF__=()=>readonlyReadProof;']]){
  const found=nodes.filter(n=>n.type==='VariableDeclarator'&&n.id?.name===name);assert.equal(found.length,1,name);
  const ret=found[0].init.callee.body.body.findLast(n=>n.type==='ReturnStatement');assert.ok(ret,name+' return');edits.push({at:ret.start,text});
 }
 const close=code.lastIndexOf('})();');assert.ok(close>0);edits.push({at:close,text:';globalThis.__RAW_PRIVATE_TEST__={owner:LatestTurnBaselineOwner,lease:RuntimeStateLease,clear:clearNativeReadonlyFallback,bridge:VersionedCanonicalBridge};'});
 for(const e of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,e.at)+e.text+code.slice(e.at);
 return code;
}
function rawFor(scope,generation=0,length=568340,char='Ā'){
 const value={scopeKey:scope,resetGeneration:generation,entries:[{key:'lmai_memory::raw-sharing',comment:'lmai_memory',content:''}]};
 const empty=JSON.stringify(value);value.entries[0].content=char.repeat(length-empty.length);const raw=JSON.stringify(value);assert.equal(raw.length,length);return raw;
}
const copyRaw=raw=>Buffer.from(raw,'utf16le').toString('utf16le');
async function fixture(artifact){
 const f=await cacheFixture({artifact,transform:instrument});f.private=f.r.context.__RAW_PRIVATE_TEST__;return f;
}
function seed(f,{scope=f.scope,generation=0,postRaw=rawFor(scope,generation),beforeRaw=rawFor(scope,generation,440288,'Ă'),lease,state='capturing'}={}){
 const m=f.r.api.MemoryState;m._activeScopeKey=scope;m._activeChatId=f.r.chat.id;m.currentTurn=2;
 f.private.owner.invalidate('fixture_reset');
 const chat={message:[{role:'user',id:'raw-user',data:'fixture user'},{role:'assistant',id:'raw-assistant',data:'fixture assistant'}]};
 const token=f.private.owner.begin({proof:{ok:true,canonicalRaw:beforeRaw,scopeKey:scope,resetGeneration:generation},sourceReceipt:{state:'bound',canonicalScope:scope,resetGeneration:generation,userIds:['raw-user'],assistantIds:['raw-assistant']},canonicalMemoryId:'raw-memory',turn:2,chat,lease:lease||f.private.lease.capture(scope)});
 assert.ok(token,'real owner begin');const ticket=f.private.owner.beforeWrite(scope,token,beforeRaw);assert.ok(ticket,'real owner write ticket');
 assert.equal(f.private.owner.verifiedWrite(scope,ticket,postRaw),true);
 if(state==='ready'||state==='publishing')assert.equal(f.private.owner.complete(token,2),true);
 if(state==='publishing')f.private.owner.claimPublication(f.private.owner.take('raw-memory'));
 return {token,postRaw,beforeRaw};
}
async function store(f,raw){await f.native.compat.pluginStorage.setItem(f.key,raw);f.private.clear();f.physical.length=0;f.counts.total=0;f.counts.freezeVisits=0;f.counts.stages={};}
function gate(f){let release,arrive;const seen=new Promise(r=>arrive=r),held=new Promise(r=>release=r),get=f.r.storage.getItem;let armed=true;f.r.storage.getItem=async key=>{const raw=await get(key);if(armed&&key===f.key){armed=false;arrive();await held;}return raw;};return {seen,release,restore(){f.r.storage.getItem=get;}};}
function observation(f,result){return {result:plain(result),physical:f.physical.map(({key,bytes})=>({kind:key===f.key?'root':'chunk',bytes})),parses:f.counts.total,freezeVisits:f.counts.freezeVisits};}
module.exports={fixture,seed,store,gate,rawFor,copyRaw,plain,tick,observation,instrument};
