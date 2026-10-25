'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,quotes,seedRange}=require('./fixtures/hayaku_reanalysis_fixture.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');
const {envelope}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
for(const mode of ['plugin_only','mirror','server_only'])for(const kind of ['range','cold'])test(mode+' unified '+kind+' replacement preserves history and coverage across restart',async()=>{
 const server=createHandlerFixture();let f,restarted;
 try{
  f=await fixture({mode,server,cold:kind==='cold',turns:kind==='cold'?2:3});let record;
  if(kind==='cold'){
   let index=0;f.r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(quotes[index++]))}));assert.equal((await f.api.recovery.coldStart({resume:true})).ok,true);
   record=(await f.api.ledger.inspect({includeRecords:true})).records.find(row=>row.captureSource==='bridge_cold_start'&&f.api._test.storageRecordTurnRange(row).turnStart===1);
   f.r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(quotes[0]))}));
  }else record=await seedRange(f);
  const inventory=await f.api.listReanalysisRanges(),range=f.api._test.storageRecordTurnRange(record),calls=f.r.llmCalls.length;
  const selection={...inventory,ranges:inventory.ranges.filter(row=>row.start>=range.turnStart&&row.end<=range.turnEnd)};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.r.llmCalls.length-calls,range.turnEnd-range.turnStart+1);
  const options={messages:JSON.parse(JSON.stringify(f.r.chat.message)),autoRepair:false,afterRequestAutoRepair:false,pluginStorage:f.r.pluginStorage,safeLocalStorage:f.r.safeLocalStorage,nativeFetch:server.nativeFetch,arguments:{memory_suite_server_mode:mode,memory_suite_server_url:server.url}};
  await f.r.dispose();restarted=await createHayakuRuntime(options);
  const restored=await restarted.hayaku.ledger.inspect({includeRecords:true});assert.equal(restored.records.find(row=>row.recordId===record.recordId)?.recordState,'tombstoned');
  for(let turn=range.turnStart;turn<=range.turnEnd;turn++)assert.ok(restored.records.some(row=>row.targetPairIndex===turn&&row.recordState==='active'&&row.captureSource==='bridge_incremental_recovery'));
  const status=await restarted.hayaku.recovery.status({includeDebts:true,refreshDebts:true});for(let turn=1;turn<=(kind==='cold'?2:3);turn++)assert.ok(status.debt.coverage.coveredTurns.includes(turn),JSON.stringify(status.debt.coverage));
  assert.equal(restarted.llmCalls.length,0);if(mode==='plugin_only')assert.equal(server.trace.length,0);else assert.ok(server.trace.some(row=>row.path.startsWith('/v1/')));
 }finally{await restarted?.dispose();await f?.close();await server.close();}
});
