'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),acorn=require('acorn');
const root=path.resolve(__dirname,'..'),base=JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).base;
const {runtime}=require(base+'/tools/libra_typed_recall_queue_test.cjs');
const {instrumentRefreshes,request}=require(base+'/tools/libra_owned_hydration_hook_support.cjs');
const dist=process.env.WM_VERSIONED_DIST||root+'/dist/LIBRA World Manager Full.js';
const plain=x=>JSON.parse(JSON.stringify(x)),tick=()=>new Promise(r=>setImmediate(r));
function instrument(code,config,transform){
 if(config!==undefined){const re=/mode:\s*['"]live['"],\s*global:\s*globalThis/g,m=code.match(re);assert.equal(m?.length,1);code=code.replace(m[0],m[0]+', nativeReadonlyDerivedCache: '+JSON.stringify(config));}
 code=instrumentRefreshes(code);
 const nodes=[],pending=[acorn.parse(code,{ecmaVersion:'latest'})];while(pending.length){const n=pending.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==='object')pending.push(v);}
 const parse=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='parseCanonicalReadonlyValue');assert.ok(parse,'existing canonical parser');
 const freeze=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='freezeReadProof');assert.ok(freeze);
 const at=parse.init.body.start+1;const edits=[{at,text:'globalThis.__NATIVE_PARSE_COUNTS__.total++;const stage=globalThis.__REFRESH_OBS__.serial;globalThis.__NATIVE_PARSE_COUNTS__.stages[stage]=(globalThis.__NATIVE_PARSE_COUNTS__.stages[stage]||0)+1;'}];if(freeze.init.body.type==='BlockStatement')edits.push({at:freeze.init.body.start+1,text:'globalThis.__NATIVE_PARSE_COUNTS__.freezeVisits++;'});else edits.push({at:freeze.init.body.start,text:'(globalThis.__NATIVE_PARSE_COUNTS__.freezeVisits++,'},{at:freeze.init.body.end,text:')'});for(const e of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,e.at)+e.text+code.slice(e.at);
 const end=code.lastIndexOf('})();');code=code.slice(0,end)+';globalThis.__NATIVE_CACHE_TEST__={cache:typeof WmNativeReadonlyDerivedCache!=="undefined"?WmNativeReadonlyDerivedCache:null,bridge:VersionedCanonicalBridge,compat:RisuCompat,context:resolveActiveChatContext,secret:SecretKnowledgeCore};'+code.slice(end);
 code=code.replace(/RisuCompat\.onUnload\(async/g,'((handler)=>(globalThis.__NATIVE_UNLOAD__=handler,RisuCompat.onUnload(handler)))(async');
 code='globalThis.__NATIVE_PARSE_COUNTS__={total:0,freezeVisits:0,stages:{}};\n'+code;
 return transform?transform(code):code;
}
async function fixture({config,transform,artifact=dist}={}){
 const io=[];const r=await runtime(null,{dist:artifact,admittedHost:true,io,transformCode:code=>instrument(code,config,transform)});
 r.chat.localLore=[];r.chat.message=Array.from({length:10},(_,i)=>[{role:'user',data:'A asks about the pendant '+i},{role:'assistant',data:'A replies in the city '+i}]).flat();r.api.MemoryEngine.CONFIG.injectionUnknownHostCapTokens=8000;r.api.MemoryEngine.CONFIG.injectionBudgetMaxTokens=16000;
 const native=r.context.__NATIVE_CACHE_TEST__,d=r.api.LibraDataStorage,scope=d.scopeKeyFor(r.char,r.chat),key=d.storageKeyFor(scope),raw=r.store.get(key),counts=r.context.__NATIVE_PARSE_COUNTS__;
 const physical=[];const get=r.storage.getItem;r.storage.getItem=async k=>{const stage=r.context.__REFRESH_OBS__;if(String(k).startsWith('LIBRA_DATA::')&&stage.depth){stage.physical++;if(stage.targetDepth)stage.targetPhysical++;}const value=await get(k);if(String(k).startsWith('LIBRA_DATA::'))physical.push({key:k,bytes:typeof value==='string'?Buffer.byteLength(value):0});return value;};
 io.length=0;counts.total=0;counts.freezeVisits=0;counts.stages={};return{r,d,scope,key,raw,cache:native.cache,native,counts,physical,io};
}
function cacheOf(f){assert.ok(f.cache,'native C0 shared adapter must exist without a provider or enable flag');assert.equal(f.cache.enabled,true);return f.cache;}
const read=(f,owner,scope=f.scope)=>f.d.readVerified(scope,{readonly:true,authorityRequest:owner});
function open(f,guard=()=>true){return cacheOf(f).openRequest({guard});}
async function hook(f){const result=await f.r.api.libraBeforeRequestReplacer(request(),'model');assert.equal(f.r.state.calls.length,0);return result;}
module.exports={fixture,cacheOf,read,open,hook,plain,tick,request,base,root,dist};
