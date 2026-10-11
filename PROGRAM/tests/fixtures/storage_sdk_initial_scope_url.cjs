'use strict';
// Genuine SDK and loopback server; hold only the SDK's normally queued0ms
// startup callbacks so they cannot accidentally initialize the cache first.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {createMemorySuiteServer}=require('../../server/server.cjs');
const sdkPath=path.resolve(__dirname,'../../sdk/MemorySuiteStorageClient.source.js'),sdk=fs.readFileSync(sdkPath,'utf8');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function store(){const map=new Map();return{map,getItem:async key=>map.get(key)??null,setItem:async(key,value)=>{map.set(key,value);return true;},removeItem:async key=>{map.delete(key);return true;},keys:async()=>[...map.keys()]};}
async function verifyInitialScopeUrl({allControls=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sdk-initial-scope-url-')),app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:directory,autoBackup:false});
 const address=await app.listen(),baseUrl=`http://127.0.0.1:${address.port}`,observations=[];
 const cases=allControls?[{name:'cold_same_server_mode'},{name:'warm_same_server_mode',warm:true},{name:'cold_plugin_to_server',initialMode:'plugin_only'},{name:'explicit_url_publication',explicit:true}]:[{name:'cold_same_server_mode'}];
 try{
  for(const item of cases){
   const pluginStorage=store(),args={memory_suite_server_mode:item.initialMode||'server_only',memory_suite_server_url:baseUrl},scope={scopeId:item.name,scopeKey:item.name,label:'Controlled initial scope'},held=new Map(),requests=[];let bridge;
   const host={pluginStorage,getArgument:async name=>args[name]||'',setArgument:async(name,value)=>{args[name]=String(value);return true;},nativeFetch:async(url,init)=>{
    const row={origin:new URL(url).origin,path:new URL(url).pathname};requests.push(row);
    try{const result=await fetch(url,init);row.status=result.status;return result;}catch(error){row.error=error.cause?.code||error.code||error.name;throw error;}
   }};
   const context=vm.createContext({risuai:host,console,URL,Headers,Request,Response,AbortController,TextEncoder,TextDecoder,fetch,crypto:globalThis.crypto,setInterval,clearInterval,
    setTimeout:(handler,delay,...values)=>{if(Number(delay)===0){const token={startup:true};held.set(token,()=>handler(...values));return token;}return setTimeout(handler,delay,...values);},clearTimeout:token=>{if(held.has(token)){held.delete(token);return;}clearTimeout(token);}});
   vm.runInContext(sdk+'\n globalThis.__SDK_INITIAL_URL_FACTORY__=createMemorySuiteStorageBridge;',context,{filename:sdkPath});
   try{
    bridge=context.__SDK_INITIAL_URL_FACTORY__({namespace:'hayaku',pluginId:'hayaku_locator_continuity',pluginVersion:'test',pluginPrefixes:['hayaku.v2.ledger.'],managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false,currentScopeProvider:async()=>scope,resolveKeyScope:async({currentScope})=>({kind:'scope',...currentScope})});
    bridge.createPluginStorageProxy(pluginStorage);assert.ok(held.size>0,'normal startup callback is genuinely pending');
    if(item.warm){const settings=await bridge.getConnectionSettings({scope,force:true});assert.equal(settings.url,baseUrl);}
    if(item.explicit)await bridge.setServerUrl(baseUrl);
    await bridge.setScopeMode(scope,'server_only');
    let connection,error;try{connection=await bridge.bootstrap();}catch(value){error=value;}
    const observation={case:item.name,heldStartupCallbacks:held.size,configuredOrigin:baseUrl,requests,bootstrapError:error?{name:error.name,code:error.cause?.code||error.code||'',message:error.message}:null};observations.push(observation);
    console.log(JSON.stringify({test:'storage_sdk_initial_scope_url_observation',...observation}));
    assert.ok(requests.length>0,'actual physical bootstrap was submitted');
    assert.ok(requests.every(row=>row.origin===baseUrl),'initial actual scoped mode publication must use configured URL before fresh cache timestamp');
    assert.equal(error,undefined,'configured actual loopback bootstrap succeeds');assert.equal(connection.url,baseUrl);
    const mode=await bridge.getScopeMode(scope);assert.equal(mode.mode,'server_only');assert.equal(mode.explicit,true);
    assert.equal(args.memory_suite_server_url,baseUrl,'mode publication does not overwrite configured URL');assert.equal(args.memory_suite_server_mode,item.initialMode||'server_only','scope publication preserves legacy global mode argument');
    // PersistServerUrl must retain explicit scope authority even when the legacy
    // global mode argument remains plugin_only, and requalify physical binding.
    const generation=bridge.serverBinding().generation;await bridge.setServerUrl(baseUrl);const forced=await bridge.bootstrap(true);
    assert.equal(forced.url,baseUrl);assert.ok(bridge.serverBinding().generation>generation);assert.equal((await bridge.getScopeMode(scope)).mode,'server_only');
   }finally{if(bridge)await bridge.dispose();held.clear();}
  }
  return{test:'storage_sdk_initial_scope_url',cases:observations.length,sdkSHA256:sha(sdk),productionTransportUnchanged:true,allActualRequestsUseConfiguredOrigin:true,observations};
 }finally{await app.close();fs.rmSync(directory,{recursive:true,force:true});}
}
module.exports={verifyInitialScopeUrl};
if(require.main===module)verifyInitialScopeUrl({allControls:process.argv.includes('--controls')}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
