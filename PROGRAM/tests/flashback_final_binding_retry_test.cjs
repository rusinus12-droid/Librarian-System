'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {configure,syntheticFetch}=require('./helpers/unload_recall_contract_fixture.cjs');
const source=fs.readFileSync(process.env.FLASHBACK_TEST_PLUGIN||path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');
const boundary="const currentManifest = await withinHookDeadline(loadScopeManifest(scope.scopeKey),'recall binding');";
assert.ok(source.includes(boundary));
const instrumented=source.replace(boundary,boundary+`
  globalThis.__finalBindingReads=(globalThis.__finalBindingReads||0)+1;
  if(globalThis.__remainingBindingChanges>0){globalThis.__remainingBindingChanges--;currentManifest.commitId='controlled-concurrent-publication';}
`);
for(const persistent of [false,true])test(`final binding change ${persistent?'is reported after bounded retries':'retries a fresh preparation and delivers'}`,async()=>{
  const user='I inspect the gauge.',reply='The needle holds at the red mark and the spare valve hangs on the north wall hook.';
  const f=await createFixture({source:instrumented,nativeFetch:syntheticFetch,arguments:{hook_recall_timeout_ms:'15000'},
    chat:{message:[{role:'user',chatId:'u1',data:user},{role:'assistant',chatId:'a1',data:reply},
      {role:'user',chatId:'u-next',data:'I step into the corridor.'},{role:'assistant',chatId:'a-next',data:'The corridor is quiet.'}]}});
  try{
    await configure(f,'configured');
    await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
    await f.api.processPendingEmbeddingQueue({maxSources:8,maxRequests:8});
    const scope=await f.api.resolveCurrentScope();
    const stored=await f.api._test.loadScopeRecords(scope.scopeKey);
    assert.ok(stored.records.some(row=>row.vector?.length===3),'fixture must publish a real validated vector');
    f.context.__remainingBindingChanges=persistent?100:1;
    const out=await f.api._selectionTest.beforeRequest([
      {role:'user',chatId:'u1',content:user},{role:'assistant',chatId:'a1',content:reply},
      {role:'user',chatId:'u-next',content:'I step into the corridor.'},{role:'assistant',chatId:'a-next',content:'The corridor is quiet.'},
      {role:'user',chatId:'u2',content:'What did the gauge show, and where is the spare valve?'}
    ],'model');
    const state=await f.api.debugState();
    assert.ok(state.lastRecall,'every final rejection has a visible outcome');
    if(persistent){
      assert.equal(f.context.__finalBindingReads,3);
      assert.equal(state.lastRecall.reason,'FLASHBACK_RECALL_FINAL_BINDING_CHANGED');
      assert.equal(state.lastRecall.attempts,3);
      assert.equal(out.some(row=>row.flashbackDynamic),false);
      assert.ok(state.activityLog.some(row=>row.data?.reason==='FLASHBACK_RECALL_FINAL_BINDING_CHANGED'));
    }else{
      assert.equal(f.context.__finalBindingReads,2);
      assert.equal(state.lastRecall.delivery.stage,'returned_to_hook');
      assert.ok(out.some(row=>row.flashbackDynamic&&row.content.includes('needle holds at the red mark')),
        JSON.stringify({reason:state.lastRecall.reason,readiness:state.lastRecall.modelReadiness,selected:state.lastRecall.selected}));
    }
  }finally{await f.dispose();}
});
