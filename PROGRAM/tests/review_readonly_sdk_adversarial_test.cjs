'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const scope={scopeKey:'scope-one',characterId:'character-one',chatId:'chat-one'},id='A'.repeat(32),url='http://127.0.0.1:47630';
function fixture(options={}){
 let calls=0,writes=0,current=true,onFetch=()=>{},replyPatch={},status=200;const values=new Map();
 const store={getItem:async k=>values.get(k)??null,setItem:async()=>{writes++;throw Error('write forbidden')},removeItem:async()=>{writes++;throw Error('write forbidden')}};
 const route={schema:'memory-suite.scope-routing.v1',namespace:'libra',version:1,legacyGlobalModeImported:true,entries:{'scope-one':{scopeId:'scope-one',scopeKey:'scope-one',mode:'server_only',origin:'user_explicit',updatedAt:1}}};
 const connection={url,requestedUrl:url,token:'synthetic-only',dataInstanceId:id,dataIdentityContract:'memory-suite.physical-data-identity.v1',dataIdentityCertified:true,resetEpochCertified:true,resetEpochs:{},capabilities:{'libra-read-session.v1':true}};
 const packet={schema:'memory-suite.libra-read-session.v1',scope,readOnly:true,complete:true,items:[{id:'memory-one',key:'libra:v1:scope:scope-one:memory:1',content:'Full memory',source:{revision:1,sourceDigest:'a'.repeat(64),turnRange:{start:1,end:5}}}],dependencies:[{space:'plugin',key:'libra:v1:scope:scope-one:manifest',exists:true,tombstone:false,revision:1,digest:'a'.repeat(64),valueBytes:20}],evidenceRevision:'b'.repeat(64),corpusBytes:11,maxCorpusBytes:4194304,dataInstanceId:id,resetEpoch:0,readIdentity:{scope,dataInstanceId:id,resetEpoch:0}};
 const host={pluginStorage:store,getLocalPluginStorage:async()=>store,getArgument:async name=>name.includes('url')?url:undefined,nativeFetch:async(u,init)=>{
  calls++;assert.ok(u===url+'/v1/libra/read-session/capture'||u===url+'/v1/libra/read-session/current');assert.equal(init.headers['X-Memory-Suite-Plugin'],'serial_gradation_agents_for_rp');assert.equal(init.headers.Authorization,'Bearer synthetic-only');assert.equal(init.method,'POST');await onFetch(u,init);
  const result=u.endsWith('/capture')?{...packet,...replyPatch}:{schema:'memory-suite.libra-read-session-current.v1',current,scope,evidenceRevision:packet.evidenceRevision,dataInstanceId:id,resetEpoch:0};
  return new Response(JSON.stringify(status===200?{ok:true,dataInstanceId:id,result}:{ok:false,error:'SENSITIVE_ERROR'}),{status});
 }};
 const box={connection,route,values};const context=vm.createContext({console,URL,Response,AbortController,TextEncoder,TextDecoder,setTimeout,clearTimeout,RisuAI:host,__fixture:box});
 const instrumented=source.replace('  const bridge = Object.freeze({',`Object.assign(dataBinding,{url:__fixture.connection.url,dataInstanceId:__fixture.connection.dataInstanceId,dataIdentityContract:__fixture.connection.dataIdentityContract,certified:true,generation:1,rejected:false}); state.config.url=__fixture.connection.url;state.bootstrap={value:__fixture.connection,baseUrl:__fixture.connection.url,at:1,pending:null}; __fixture.values.set(SCOPE_ROUTING_LOCAL_KEY,JSON.stringify(__fixture.route)); __fixture.state=state;__fixture.dataBinding=dataBinding;__fixture.routeKey=SCOPE_ROUTING_LOCAL_KEY;__fixture.resetChoiceKey=resetChoiceKey;\n  const bridge = Object.freeze({`);
 vm.runInContext(instrumented+';globalThis.factory=createMemorySuiteStorageBridge',context);
 const bridge=context.factory({namespace:'libra',pluginId:options.pluginId||'serial_gradation_agents_for_rp',managementButton:false,startupDiagnostics:false});
 return {bridge,box,packet,connection,values,route,host,counts:()=>({calls,writes}),setCurrent:v=>current=v,setReply:v=>replyPatch=v,setStatus:v=>status=v,setOnFetch:f=>onFetch=f};
}

test('independent: streamed overflow without content length is canceled with no fallback',async t=>{
 const f=fixture();t.after(()=>f.bridge.dispose());let canceled=false,reads=0,opaque=false;
 f.host.nativeFetch=async()=>({status:200,ok:true,headers:new Headers(),body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(9*1024*1024)}},cancel:async()=>{canceled=true},releaseLock(){}})},text:async()=>{opaque=true;return '{}'}});
 await assert.rejects(()=>f.bridge.createLibraReadOnlyClient().openReadSession(scope,{maxCorpusBytes:1}),e=>e.code==='LIB_READ_RESPONSE_BUDGET_EXCEEDED');assert.equal(canceled,true);assert.equal(reads,1);assert.equal(opaque,false);assert.equal(f.counts().writes,0);
});
test('independent: invalid UTF8 streamed response and changed URL fail closed',async t=>{
 const f=fixture();t.after(()=>f.bridge.dispose());f.host.nativeFetch=async()=>new Response(Uint8Array.from([0xc0,0x80]));await assert.rejects(()=>f.bridge.createLibraReadOnlyClient().openReadSession(scope),e=>e.code==='LIB_READ_UNAVAILABLE');
 const other=fixture();t.after(()=>other.bridge.dispose());const session=await other.bridge.createLibraReadOnlyClient().openReadSession(scope);other.host.getArgument=async()=> 'http://127.0.0.1:47631';await assert.rejects(()=>session.assertCurrent(),e=>/^LIB_READ_/.test(e.code));assert.equal(other.counts().calls,1);
});
test('independent: captured connection mutation invalidates synchronous dispatch fence',async t=>{
 for(const change of [f=>f.connection.token='changed',f=>f.connection.resetEpochs.libra=1,f=>f.box.dataBinding.generation++,f=>f.box.state.bootstrap.value={...f.connection}]){
 const f=fixture();t.after(()=>f.bridge.dispose());const session=await f.bridge.createLibraReadOnlyClient().openReadSession(scope);change(f);assert.throws(()=>session.assertCurrentSync(),e=>/^LIB_READ_/.test(e.code));assert.equal(f.counts().calls,1);
 }
});
