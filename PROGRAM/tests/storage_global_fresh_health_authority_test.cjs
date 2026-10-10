'use strict';
// Whole SDK public read-only health API. No source transforms, requests or writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.LIB_TEST_PROGRAM_ROOT||path.resolve(__dirname,'..');
const variants=[['hayaku','MemorySuiteStorageClient.source.js'],['flashback','MemorySuiteStorageClient.source.js'],['libra','MemorySuiteStorageClient.libra.source.js']];
function fixture([namespace,file]){
 const key=namespace+'.A',routeKey='__memory_suite_internal_scope_routes_v1__:'+namespace,jobKey='__memory_suite_internal_sync_job_v1__:'+namespace;
 const values=new Map([[key,'exact native bytes']]),device=new Map();let writes=0,wires=0,mode='plugin_only',hook=()=>{};
 const store=map=>({async getItem(k){const value=map.get(k)??null;await hook(k);return value;},async setItem(){writes++;throw Error('forbidden write');},async removeItem(){writes++;throw Error('forbidden delete');},async keys(){throw Error('health must not enumerate');}});
 const host={pluginStorage:store(values),safeLocalStorage:store(device),async getArgument(){return mode;},async setArgument(){writes++;throw Error('forbidden argument write');},async nativeFetch(){wires++;throw Error('forbidden network');}};
 host.getLocalPluginStorage=async()=>host.safeLocalStorage;
 const context=vm.createContext({risuai:host,console,URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,TextEncoder,TextDecoder,crypto:globalThis.crypto});
 vm.runInContext(fs.readFileSync(path.join(root,'sdk',file),'utf8')+';globalThis.factory=createMemorySuiteStorageBridge',context);
 const bridge=context.factory({namespace,pluginId:namespace,pluginPrefixes:[namespace+'.'],localPrefixes:[namespace+'.'],scopeRouting:true,currentScopeProvider:async()=>({scopeId:'A',scopeKey:'A'}),managementButton:false,startupDiagnostics:false,autoMigratePlugin:false,autoMigrateLocal:false});
 const route=mode=>JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace,legacyGlobalModeImported:true,entries:{A:{scopeId:'A',mode,origin:'user_explicit'}}});
 return {bridge,host,values,device,key,routeKey,jobKey,route,setMode:v=>{mode=v;},setHook:f=>{hook=f;},read:()=>bridge.inspectLocalHealthSnapshot({scopeId:'A',scopeKey:'A'},key,{strictPhysical:true}),close:async()=>{await bridge.dispose();assert.equal(writes,0);assert.equal(wires,0);}};
}
(async()=>{const results=[];for(const variant of variants){const namespace=variant[0];const run=async(name,fn)=>{const f=fixture(variant);try{await fn(f);results.push({namespace,name,status:'PASS'});}catch(error){results.push({namespace,name,status:'FAIL',error:String(error.stack||error)});}finally{await f.close();}};
 for(const value of ['plugin_only','local','',null])await run('fresh readable '+String(value),async f=>{f.setMode(value);const before=JSON.stringify([...f.values]);const r=await f.read();assert.equal(r.mode,'plugin_only');assert.equal(r.raw,'exact native bytes');assert.equal(JSON.stringify([...f.values]),before);assert.equal(f.device.size,0);assert.equal((await f.read()).binding,r.binding);});
 for(const value of ['server_only','mirror','bogus',{},false])await run('strict blocked '+String(value),async f=>{f.setMode(value);await assert.rejects(f.read,/HEALTH_(LOCAL_MODE_REQUIRED|ROUTE_UNVERIFIED)/);});
 await run('missing reader blocked',async f=>{delete f.host.getArgument;await assert.rejects(f.read,/HEALTH_ROUTE_(UNVERIFIED|UNINITIALIZED)/);});
 await run('failed reader blocked',async f=>{f.host.getArgument=async()=>{throw Error('private read error');};await assert.rejects(f.read,e=>/^HEALTH_ROUTE_/.test(e.message)&&!e.message.includes('private'));});
 await run('mode changes during physical read blocked',async f=>{f.setHook(k=>{if(k===f.key)f.setMode('server_only');});await assert.rejects(f.read,/HEALTH_(LOCAL_MODE_REQUIRED|ROUTE_CHANGED)/);});
 await run('route changes during physical read blocked',async f=>{f.setHook(k=>{if(k===f.key)f.device.set(f.routeKey,f.route('server_only'));});await assert.rejects(f.read,/HEALTH_ROUTE_CHANGED/);});
 await run('pending journal blocked',async f=>{f.values.set(f.jobKey,JSON.stringify({kind:'global_mode',status:'paused'}));await assert.rejects(f.read,/HEALTH_STORAGE_TRANSITION_UNVERIFIED/);});
 await run('malformed route remains blocked',async f=>{f.values.set(f.routeKey,'{malformed');await assert.rejects(f.read,/HEALTH_ROUTE_UNVERIFIED/);});
 await run('reset remains blocked',async f=>{f.values.set('memory_suite_reset_choice.v2.'+namespace,'pending');await assert.rejects(f.read,/HEALTH_RESET_REVIEW_REQUIRED/);});
 await run('late reset blocked',async f=>{f.setHook(k=>{if(k===f.key)f.values.set('memory_suite_reset_choice.v2.'+namespace,'pending');});await assert.rejects(f.read,/HEALTH_RESET_REVIEW_REQUIRED/);});
 await run('late journal blocked',async f=>{f.setHook(k=>{if(k===f.key)f.values.set(f.jobKey,'pending');});await assert.rejects(f.read,/HEALTH_STORAGE_TRANSITION_UNVERIFIED/);});
 await run('malformed import marker blocked',async f=>{f.values.set(f.routeKey,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace,legacyGlobalModeImported:'false',entries:{}}));await assert.rejects(f.read,/HEALTH_ROUTE_UNVERIFIED/);});
 await run('wrong namespace blocked',async f=>{f.values.set(f.routeKey,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'foreign',entries:{}}));await assert.rejects(f.read,/HEALTH_ROUTE_UNVERIFIED/);});
 await run('empty to explicit local changes witness',async f=>{f.setMode('');const before=await f.read();f.setMode('plugin_only');assert.notEqual((await f.read()).binding,before.binding);});
 await run('device store replacement during read blocked',async f=>{f.setHook(k=>{if(k===f.key)f.host.safeLocalStorage={getItem:async()=>null,setItem:async()=>true};});await assert.rejects(f.read,/HEALTH_ROUTE_CHANGED/);});
 await run('persisted local does not require legacy read',async f=>{f.values.set(f.routeKey,f.route('plugin_only'));delete f.host.getArgument;assert.equal((await f.read()).raw,'exact native bytes');});
 }for(const row of results)console.log(JSON.stringify(row));console.log(JSON.stringify({cases:results.length,passed:results.filter(r=>r.status==='PASS').length}));if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
