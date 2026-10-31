'use strict';
// A server-mode repair of one missing turn used to download the same scope manifest
// ~170 times and rewrite the whole scope registry after every commit. Over a slow
// host transport that made a one-turn repair take minutes. The run now holds one
// writer fence (reads inside it are cached) and writes the registry once.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const pair=(i,long=false)=>[{role:'user',chatId:'u'+i,data:`Where is parcel ${i}?`},
  {role:'assistant',chatId:'a'+i,data:Array.from({length:long?60:3},(_,n)=>`Parcel ${i} item ${n} remains inside the eastern cabinet beside clock ${n}.`).join(' ')}];

test('server missing-turn repair stays within a bounded number of storage round trips',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-read-budget-')),app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
  let counting=false;const reads=new Map(),writes=new Map(),routes=new Map();
  const bump=(map,key)=>map.set(key,(map.get(key)||0)+1);
  const f=await createFixture({source:fs.readFileSync(require.resolve('../plugins/Flashback_Memory.js'),'utf8'),exposeStorageBridge:true,
    chat:{message:[...pair(1),...pair(2),...pair(3)]},
    arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`,embedding_key:'synthetic-key'},
    nativeFetch:async(url,init)=>{
      const u=String(url);
      if(u.startsWith('https://provider.invalid/'))return new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
      if(counting){
        const route=u.replace(/^https?:\/\/[^/]+/,'').replace(/\?.*/,'');bump(routes,`${init?.method||'GET'} ${route}`);
        const key=u.match(/\/v1\/kv\/get\?.*key=([^&]+)/);
        if(key)bump(reads,decodeURIComponent(key[1]).replace(/:scope:[^:]+:/,':scope:*:').replace(/:commit:[^:]+:/,':commit:*:'));
        if(route==='/v1/kv/set'&&init?.body)bump(writes,String(JSON.parse(init.body).key||''));
      }
      return mockFetch(url,init);
    }});
  try{
    const cfg={...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'read-budget',embeddingUrl:'https://provider.invalid/v1',embeddingDimensions:3,
      embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingBatchSize:8,episodeIndexEnabled:true,autoEpisodeIndex:true,autoColdStart:false};
    await f.api.saveSettings(cfg);const scope=await f.api.resolveCurrentScope(false);
    await f.context.__fixtureStorageBridge.setScopeMode({scopeId:scope.scopeKey,scopeKey:scope.scopeKey},'server_only');
    await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
    f.currentChat.message.push(...pair(4,true));
    const plan=await f.api.inspectMemoryMaintenance();
    assert.equal(plan.automatic.strategy,'server_turn_sync');
    counting=true;
    const result=await f.api.runMemoryMaintenance('auto',{preflight:plan});
    counting=false;
    assert.equal(result.healthy,true);assert.equal(result.after.embeddingWorkIncompleteRecords,0);
    const manifestReads=reads.get('vector_rag_memory:scope:*:manifest:v2')||0;
    const registryReads=reads.get('vector_rag_memory:scope_registry:v2')||0;
    const registryWrites=writes.get('vector_rag_memory:scope_registry:v2')||0;
    const fenceRequests=routes.get('POST /v1/flashback/writer')||0;
    // Measured before the change: 171 manifest reads, 30 registry reads, 12 registry
    // writes, 20+ fence requests for this same scenario.
    assert(manifestReads<=30,`manifest reads ${manifestReads}`);
    assert(registryReads<=6,`registry reads ${registryReads}`);
    assert(registryWrites<=2,`registry writes ${registryWrites}`);
    assert(fenceRequests<=4,`fence requests ${fenceRequests}`);
    // The deferred registry write still lands: the listing reflects the repaired scope.
    const row=await f.context.__fixtureStorageBridge.serverGet('plugin','vector_rag_memory:scope_registry:v2'),raw=row?.exists===true?row.value:row;
    const registry=typeof raw==='string'?JSON.parse(raw):raw,manifest=await f.api._test.loadScopeManifest(scope);
    const entry=registry.scopes.find(item=>item.scopeKey===scope.scopeKey);
    assert(entry,'scope listed');assert.equal(entry.commitId,manifest.commitId,'registry reflects the final commit');
  }finally{await f.dispose();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});
