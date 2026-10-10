'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const files=['sdk/MemorySuiteStorageClient.source.js','sdk/MemorySuiteStorageClient.libra.source.js',...['Flashback_Memory.js','HAYAKU_Locator_Continuity.js','LIBRA.js','LIA_Persona_Linker.js','RETRACE.js'].map(n=>'plugins/'+n)];
const scope={scopeId:'durable-scope',scopeKey:'durable-scope',available:true};
const key='__memory_suite_internal_scope_routes_v1__:libra';
const registry={schema:'memory-suite.scope-routing.v1',entries:{[scope.scopeId]:{...scope,mode:'server_only',updatedAt:1}},updatedAt:1};
const store=(kind,seed)=>({map:new Map(seed||[]),async getItem(k){if(kind==='read_throw')throw Error('read_fault');return this.map.get(k)??null;},async setItem(k,v){if(kind==='throw')throw Error('write_fault');if(!['false','noop','read_throw'].includes(kind))this.map.set(k,kind==='corrupt'?'corrupt':v);return kind==='false'?false:undefined;}});
(async()=>{let count=0;for(const file of files){
 let source=fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n').match(/\/\* LIBRARIAN SYSTEM STORAGE SDK v[^\n]+[\s\S]*?\n  return bridge;\n\n};/)[0];
 // Expose closure functions in memory only; all persistence logic is unmodified.
 source=source.replace('  return bridge;','  return {writeScopeRegistryLocal,loadScopeRegistry,readScopeMode,persistScopedMode};');
 for(const kind of ['false','noop','corrupt','throw','read_throw']){
  const plugin=store('false'),device=store(kind),ctx=vm.createContext({risuai:{pluginStorage:plugin,getLocalPluginStorage:async()=>device},console,setTimeout,clearTimeout,TextEncoder,crypto:globalThis.crypto});
  const make=vm.runInContext(source+'\ncreateMemorySuiteStorageBridge;',ctx),b=make({namespace:'libra'});
  await assert.rejects(()=>b.writeScopeRegistryLocal(registry),/scope_routing_storage_unavailable/);
  assert.notEqual((await b.readScopeMode(scope)).mode,'server_only');count++;
 }
 for(const [pk,dk] of [['ok','false'],['false','ok'],['ok','throw']]){
  const plugin=store(pk),device=store(dk),ctx=vm.createContext({risuai:{pluginStorage:plugin,getLocalPluginStorage:async()=>device},console,setTimeout,clearTimeout,TextEncoder,crypto:globalThis.crypto});
  const make=vm.runInContext(source+'\ncreateMemorySuiteStorageBridge;',ctx),b=make({namespace:'libra'});
  await b.writeScopeRegistryLocal(registry);assert.equal((await make({namespace:'libra'}).readScopeMode(scope)).mode,'server_only');count++;
 }
 // Concurrent mode changes must both survive in a new bridge instance.
 {
  const plugin=store('ok'),device=store('ok'),ctx=vm.createContext({risuai:{pluginStorage:plugin,getLocalPluginStorage:async()=>device},console,setTimeout,clearTimeout,TextEncoder,crypto:globalThis.crypto});
  const make=vm.runInContext(source+'\ncreateMemorySuiteStorageBridge;',ctx),b=make({namespace:'libra'});
  const a={scopeId:'concurrent-a',available:true},z={scopeId:'concurrent-z',available:true};
  await Promise.all([b.persistScopedMode('plugin_only',a),b.persistScopedMode('plugin_only',z)]);
  const fresh=make({namespace:'libra'});
  assert.equal((await fresh.readScopeMode(a)).explicit,true);assert.equal((await fresh.readScopeMode(z)).explicit,true);count++;
 }
 const plugin=store('false',[[key,JSON.stringify(registry)]]),device=store('false'),ctx=vm.createContext({risuai:{pluginStorage:plugin,getLocalPluginStorage:async()=>device},console,setTimeout,clearTimeout,TextEncoder,crypto:globalThis.crypto});
 const make=vm.runInContext(source+'\ncreateMemorySuiteStorageBridge;',ctx),b=make({namespace:'libra'});
 await assert.rejects(()=>b.persistScopedMode('plugin_only',scope),/scope_routing_storage_unavailable/);
 assert.equal((await b.readScopeMode(scope)).mode,'server_only');assert.equal((await make({namespace:'libra'}).readScopeMode(scope)).mode,'server_only');count++;
}console.log(JSON.stringify({test:'storage_scope_registry_durable_fault',passed:count,files:files.length,boundary:'source and installed SDK closures; false/noop/corrupt/throw/readback and fresh instance'}));})().catch(e=>{console.error(e);process.exitCode=1;});
