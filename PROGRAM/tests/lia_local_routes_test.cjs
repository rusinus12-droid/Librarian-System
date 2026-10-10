'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
const expose=source=>{const i=source.lastIndexOf('\n})();');return source.slice(0,i)+'\nglobalThis.__localTest={bridge:MemorySuiteStorageBridge,mount:mountLiaServerConnectionPanel};'+source.slice(i);};
(async()=>{const f=await createFixture('official',{transformSource:expose});try{
 const {bridge,mount}=f.context.__localTest;assert.equal(bridge.storagePolicy,'local_only');assert.equal(await bridge.getMode(),'plugin_only');
 let hostReads=0;const old=f.api.getDatabase;f.api.getDatabase=async(...args)=>{hostReads++;return old(...args);};await bridge.createPluginStorageProxy(f.api.pluginStorage).getItem('dynamicPersonaLorebookGeneratorResultVault');assert.equal(hostReads,0);
 const elements=new Map();const root={innerHTML:'',querySelector(selector){if(!elements.has(selector))elements.set(selector,{disabled:false,textContent:'',addEventListener(){}});return elements.get(selector);}};f.context.document={getElementById:()=>root};assert.equal(mount(),true);assert.match(root.innerHTML,/pluginStorage/);assert.match(root.innerHTML,/이전 서버/);assert.doesNotMatch(root.innerHTML,/type="radio"|mscx-|서버 단독|동기화 시작/);
 console.log('PASS LIA local-only routes and explicit legacy recovery panel without server-mode controls');
}finally{await f.dispose();}})().catch(e=>{console.error(e);process.exitCode=1});
