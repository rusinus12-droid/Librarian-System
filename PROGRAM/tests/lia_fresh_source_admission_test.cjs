'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require(process.env.LIA_FIXTURE||'./fixtures/lia_native_runtime_fixture.cjs');
const min=process.env.LIA_TEST_MIN==='1';let compiled;
const expose=source=>{if(compiled)return compiled;source=source.replace('      getLiveSyncCaptureState:',`      auditCapture: async()=>{const ctx=await getLiveRuntimeContext();return livePersonaBatchRevisionSnapshot(ctx,collectCompletedTurnPairs(ctx.chat).slice(0,5));},
      auditCheck:()=>runManualLivePersonaAnalysis(),
      getLiveSyncCaptureState:`);compiled=min?require(process.env.LIA_TERSER).minify_sync(source,{compress:{defaults:true,unsafe:false,drop_console:true,passes:3},mangle:{toplevel:true,properties:false}}).code:source;return compiled;};
(async()=>{const rows=[];for(const failure of ['throw','null','undefined','character_unavailable','database_unavailable','current_index_unavailable','stable']){const f=await createFixture('official',{transformSource:expose});try{const snap=structuredClone(await f.runtime.auditCapture());let writes=0;const set=f.api.setDatabase;f.api.setDatabase=async(...args)=>{writes++;return set(...args);};
 if(failure==='throw')f.api.getChatFromIndex=async()=>{throw Error('unavailable');};
 if(failure==='null')f.api.getChatFromIndex=async()=>null;
 if(failure==='undefined')f.api.getChatFromIndex=undefined;
 if(failure==='character_unavailable')f.api.getCharacterFromIndex=async()=>null;
 if(failure==='database_unavailable')f.api.getDatabase=async()=>null;
 if(failure==='current_index_unavailable')f.api.getCurrentCharacterIndex=async()=>null;
 if(failure==='stable'){assert.equal((await f.runtime.debugVerifyLiveSyncBatch(snap)).ok,true);f.liveChat.message[9].data+=' EDIT';assert.equal((await f.runtime.debugVerifyLiveSyncBatch(snap)).reason,'batch_source_changed');}
 else {if(failure!=='current_index_unavailable'){f.liveChat.message[9].data+=' EDIT';const verified=await f.runtime.debugVerifyLiveSyncBatch(snap);assert.equal(verified.ok,false);assert.equal(verified.reason,'source_read_unavailable');}const checked=await f.runtime.auditCheck();assert.equal(checked.reason,'source_read_unavailable');assert.equal(writes,0);}
 rows.push({failure,passed:true});}catch(e){rows.push({failure,passed:false,error:e.message});process.exitCode=1;}finally{await f.dispose();}}
console.log(JSON.stringify({test:'lia_fresh_source_admission',mode:min?'Min':'Full',externalModelCalls:0,rows},null,2));})().catch(e=>{console.error(e);process.exitCode=1;});
