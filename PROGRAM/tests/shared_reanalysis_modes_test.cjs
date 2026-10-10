'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ownerFixture,envelope,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');
for(const owner of ['hayaku','flashback'])for(const mode of ['plugin_only','mirror','server_only'])test(owner+' '+mode+' uses the owner storage path for current-source replacement',async()=>{
 const server=createHandlerFixture();let f;
 try{
  f=await ownerFixture(owner,{transformSource:s=>s.replace('    globalThis.HAYAKU = exposedApi;','    globalThis.__modeBridge=MemorySuiteStorageBridge;\n    globalThis.HAYAKU = exposedApi;'),beforeSeed:async r=>{const bridge=r.context.__modeBridge;const actual=await bridge.getScopeMode();assert.equal(actual.mode,mode);console.log('MODE_ACTUAL '+owner+' '+mode+' '+actual.storagePhase);},arguments:{memory_suite_server_mode:mode,memory_suite_server_url:server.url},nativeFetch:server.nativeFetch});
  const before=await f.records();assert.ok(before.length,mode+' initial native records');
  const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,1);
  f.edit(NEW);f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const result=await f.api.reanalyzeSelectedRanges(inventory);assert.equal(result.ok,true,JSON.stringify(result));
  assert.ok((await f.records()).some(r=>JSON.stringify(r).includes(NEW)));assert.equal(f.calls(),owner==='hayaku'?1:0);
  if(mode==='plugin_only')assert.equal(server.trace.length,0);
  else {assert.ok(server.trace.some(row=>row.path.startsWith('/v1/')),'actual server routes reached: '+JSON.stringify(server.trace));
   const records=server.app.repositories[owner].list('plugin','').records;assert.ok(records.length,'actual server repository committed owner data');}
 }finally{await f?.dispose();await server.close();}
});
