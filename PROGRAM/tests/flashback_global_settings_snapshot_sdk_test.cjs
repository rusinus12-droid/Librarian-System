'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../sdk/MemorySuiteStorageClient.source.js'),'utf8');
const key='vector_rag_memory:settings:v2';
function fixture(){let writes=0,network=0,reads=0,classifierCalls=0,kind='global',onRead=()=>{},onClassify=()=>{};const values=new Map([[key,JSON.stringify({version:6,overrides:{embeddingProvider:'hash'}})]]);
 const store={getItem:async k=>{assert.equal(k,key,'no corpus or credential-key read');reads++;await onRead();return values.get(k)??null},setItem:async()=>{writes++;throw Error('write forbidden')},removeItem:async()=>{writes++;throw Error('write forbidden')}};
 const host={pluginStorage:store,getArgument:async()=>{throw Error('settings helper does not read arguments')},nativeFetch:async()=>{network++;throw Error('no server settings authority')}};
 const context=vm.createContext({RisuAI:host,console,URL,TextEncoder,AbortController,setTimeout,clearTimeout});
 vm.runInContext(source.replace('  const bridge = Object.freeze({','  globalThis.__settingsFixture={dataBinding,lifecycle};\n  const bridge = Object.freeze({')+';globalThis.factory=createMemorySuiteStorageBridge;',context);
 const bridge=context.factory({namespace:'flashback',pluginId:'flashback-memory',managementButton:false,startupDiagnostics:false,preResolveKeyScope:true,pluginPrefixes:['vector_rag_memory:'],resolveKeyScope:async input=>{classifierCalls++;assert.equal(input.key,key);assert.equal(input.space,'plugin');await onClassify();return{kind}}});
 return{bridge,context,host,store,values,raw:context.__settingsFixture,counts:()=>({writes,network,reads,classifierCalls}),setKind:v=>kind=v,setOnRead:fn=>onRead=fn,setOnClassify:fn=>onClassify=fn};
}
(async()=>{const groups=[];
 {const f=fixture();try{assert.equal(typeof f.bridge.inspectFlashbackGlobalSettingsSnapshot,'function','exact host-global reader must exist');const out=await f.bridge.inspectFlashbackGlobalSettingsSnapshot();assert.equal(out.mode,'plugin_only');assert.equal(out.authority,'host_global');assert.equal(out.raw,f.values.get(key));await out.assertCurrent();assert.equal(f.counts().writes,0);assert.equal(f.counts().network,0);groups.push('exact_global_host_value_no_network');}finally{f.bridge.dispose()}}
 {const f=fixture();try{f.values.delete(key);const out=await f.bridge.inspectFlashbackGlobalSettingsSnapshot();assert.equal(out.raw,null);await out.assertCurrent();groups.push('certified_host_absence');}finally{f.bridge.dispose()}}
 {const f=fixture();try{const out=await f.bridge.inspectFlashbackGlobalSettingsSnapshot();f.values.set(key,'changed');await assert.rejects(()=>out.assertCurrent(),/HEALTH_SETTINGS_CHANGED/);groups.push('value_currentness');}finally{f.bridge.dispose()}}
 for(const kind of ['scope','shared','unknown']){const f=fixture();try{f.setKind(kind);await assert.rejects(()=>f.bridge.inspectFlashbackGlobalSettingsSnapshot(),/HEALTH_SETTINGS_AUTHORITY_UNVERIFIED/);assert.equal(f.counts().reads,0)}finally{f.bridge.dispose()}}groups.push('actual_classifier_required');
 {const f=fixture();try{f.setOnRead(()=>f.setKind('shared'));await assert.rejects(()=>f.bridge.inspectFlashbackGlobalSettingsSnapshot());groups.push('classifier_change_during_read');}finally{f.bridge.dispose()}}
 {const f=fixture();try{f.setOnRead(()=>f.raw.dataBinding.generation++);await assert.rejects(()=>f.bridge.inspectFlashbackGlobalSettingsSnapshot());groups.push('generation_change_during_read');}finally{f.bridge.dispose()}}
 {const f=fixture();try{f.setOnRead(()=>{f.host.pluginStorage={...f.store}});await assert.rejects(()=>f.bridge.inspectFlashbackGlobalSettingsSnapshot());groups.push('physical_store_change');}finally{f.bridge.dispose()}}
 {const f=fixture();try{f.setOnRead(()=>{throw Error('SECRET_ERROR_SENTINEL')});await assert.rejects(()=>f.bridge.inspectFlashbackGlobalSettingsSnapshot(),e=>/^HEALTH_/.test(e.message)&&!JSON.stringify(e).includes('SECRET_ERROR_SENTINEL'));groups.push('sanitized_errors');}finally{f.bridge.dispose()}}
 {const f=fixture();try{f.values.set(key,'x'.repeat(2*1024**2+1));await assert.rejects(()=>f.bridge.inspectFlashbackGlobalSettingsSnapshot(),/HEALTH_SETTINGS_SIZE_LIMIT/);groups.push('bounded_local_value');}finally{f.bridge.dispose()}}
 {const f=fixture();try{const value={version:1,settings:{embeddingProvider:'hash'}};f.values.set(key,value);const out=await f.bridge.inspectFlashbackGlobalSettingsSnapshot();out.raw.settings.embeddingProvider='forged';assert.equal(f.values.get(key).settings.embeddingProvider,'hash');await out.assertCurrent();groups.push('clone_does_not_mutate_store_or_private_witness');}finally{f.bridge.dispose()}}
 console.log(JSON.stringify({test:'flashback_global_settings_snapshot_sdk',passed:groups,liveRequests:0}));
})().catch(error=>{console.error(error);process.exitCode=1});
