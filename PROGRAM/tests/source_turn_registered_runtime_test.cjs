'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..'),program=process.env.SOURCE_TURN_TEST_PROGRAM||root;
const fixtures=process.env.LIB_TEST_BASE_PROGRAM||root;
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require(path.join(fixtures,'tests/fixtures/hayaku_runtime_harness.cjs'));
const {createFixture}=require(path.join(fixtures,'tests/fixtures/flashback_native_runtime_fixture.cjs'));
const {fixture}=require(path.join(fixtures,'tests/fixtures/libra_unified_runtime_fixture.cjs'));
const forbidden=async()=>{throw Error('OFFLINE_NETWORK_MODEL_FORBIDDEN');};
const plain=x=>JSON.parse(JSON.stringify(x));
test('registered HAY final hook keeps quota evidence and reports unresolved original mapping',async()=>{
 const messages=[];for(let turn=1;turn<=4;turn++){const summary='Aurora vault contains the amethyst spindle HAY_SOURCE_TURN_'+turn;const packet=createValidPacket({turn,summary,subject:'Archivist',scene:'archive'});messages.push({role:'user',chatId:'u'+turn,data:'Inspect Aurora vault '+turn},{role:'assistant',chatId:'a'+turn,data:hiddenPacketMessage(summary,packet)});}
 const h=await createHayakuRuntime({messages,pluginSourceFile:path.join(program,'plugins/HAYAKU_Locator_Continuity.js'),autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'},llmResponder:forbidden});
 try{const output=await h.callBeforeRequest([{role:'user',content:'What is in the Aurora vault?'}]);assert.ok(JSON.stringify(output).includes('HAY_SOURCE_TURN_'));const delivery=h.hayaku.lastDebug().lastRecallDelivery;assert.equal(delivery.temporalQuota.contract.counting,'unique_source_turns_after_evidence_dedupe');assert.equal(delivery.sourceTurnAccounting.basis,'final_emitted_evidence');assert.equal(delivery.sourceTurnAccounting.completeUniqueOriginalTurns,null);assert.equal(delivery.sourceTurnAccounting.knownUniqueOriginalTurns,0);assert.equal(delivery.sourceTurnAccounting.emittedUnits,delivery.fragments.length);assert.equal(h.llmCalls.length,0);assert.equal(h.fetchCalls.length,0);}finally{await h.dispose();}
});
test('registered Flashback capture restart and final hook publish original-turn receipt beside legacy records',async()=>{
 const source=fs.readFileSync(path.join(program,'plugins/Flashback_Memory.js'),'utf8');
 const user='I inspect the gauge.',reply='The needle holds at the red mark and the spare valve hangs on the north wall hook.';
 const chat={id:'source-turn-chat',chatId:'source-turn-chat',message:[{role:'user',chatId:'u1',data:user},{role:'assistant',chatId:'a1',data:reply}]};
 let f=await createFixture({source,chat}),saved;let syntheticVectorRequests=0;
 const configure=async f=>{f.host.nativeFetch=async(_url,init)=>{syntheticVectorRequests++;const data=JSON.parse(init.body),inputs=Array.isArray(data.input)?data.input:[data.input];return new Response(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
   await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'offline-fixture',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,embeddingEnabled:true,autoEpisodeIndex:false,episodeIndexEnabled:false,structuredStateEnabled:false,currentSceneTailEnabled:false});};
 try{await configure(f);await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});saved={pluginStorage:f.pluginStorage,safeLocalStorage:f.host.safeLocalStorage,chat:plain(f.currentChat)};}finally{await f.dispose();}
 f=await createFixture({source,...saved});
 try{await configure(f);const request=[{role:'user',chatId:'u2',content:'Remind me about the gauge reading and the spare valve.'}];await f.api._selectionTest.beforeRequest(request,'model');request[0].chatId='u3';const output=await f.api._selectionTest.beforeRequest(request,'model');assert.ok(JSON.stringify(output).includes('needle holds at the red mark'));const delivery=f.api._test.pendingCaptureRuntimeSnapshot().lastRecall.delivery;assert.ok(delivery.delivered>0);assert.equal(delivery.sourceTurnAccounting.basis,'final_emitted_evidence');assert.equal(delivery.sourceTurnAccounting.knownUniqueOriginalTurns,1);assert.equal(delivery.sourceTurnAccounting.completeUniqueOriginalTurns,1);assert.ok(delivery.pipeline.selectedRecords>=1);assert.ok(syntheticVectorRequests>0);}finally{await f.dispose();}
});
test('registered LIBRA final Classic hook publishes partial attribution after guards without changing canonical delivery',async()=>{
 const previous=process.env.LIBRA_TEST_PLUGIN;process.env.LIBRA_TEST_PLUGIN=path.join(program,'plugins/LIBRA.js');const f=await fixture({host:{nativeFetch:forbidden}});
 try{await f.run();const calls=f.control.calls.length;assert.ok(f.getMemory(1));const output=await f.control.hooks.beforeRequest([{role:'user',content:'민아와 은빛 열쇠의 소유 관계를 설명해 주세요.'}],'model');assert.ok(JSON.stringify(output).includes('LIBRA_CLASSIC_RECALL'));const runtime=f.r.api.getRuntime();const receipt=runtime.lastClassicInjectionMeta.sourceTurnAccounting;assert.equal(receipt.basis,'final_emitted_evidence');assert.equal(receipt.knownUniqueOriginalTurns,0);assert.equal(receipt.completeUniqueOriginalTurns,null);assert.ok(runtime.lastMemoryRecallViewer.injectedMemories>0);assert.deepEqual(plain(runtime.lastMemoryRecallViewer.sourceTurnAccounting),plain(receipt));assert.equal(f.control.calls.length,calls,'final recall makes no provider calls');}finally{await f.r.cleanup();if(previous===undefined)delete process.env.LIBRA_TEST_PLUGIN;else process.env.LIBRA_TEST_PLUGIN=previous;}
});
async function withEmptyLibra(transformSource,check){
 const previous=process.env.LIBRA_TEST_PLUGIN;process.env.LIBRA_TEST_PLUGIN=path.join(program,'plugins/LIBRA.js');
 const f=await fixture({host:{nativeFetch:forbidden},transformSource});
 try{const input=[{role:'user',content:'Continue.'}],output=await f.control.hooks.beforeRequest(input,'model'),runtime=f.r.api.getRuntime();
   assert.deepEqual(plain(output),input);assert.equal(f.control.calls.length,0);await check(f,runtime);
 }finally{await f.r.cleanup();if(previous===undefined)delete process.env.LIBRA_TEST_PLUGIN;else process.env.LIBRA_TEST_PLUGIN=previous;}
}
test('registered LIBRA confirmed empty publishes consistent complete-zero receipts with unchanged input',async()=>{
 await withEmptyLibra(undefined,(f,r)=>{
   assert.equal(r.lastClassicInjectionMeta.injected,false);
   const receipt=plain(r.lastClassicInjectionMeta.sourceTurnAccounting || null);
   assert.equal(receipt?.status,'complete');assert.equal(receipt?.completeUniqueOriginalTurns,0);assert.equal(receipt?.emittedUnits,0);
   for(const value of [r.lastMemoryInjectionMeta,r.lastMemoryRecallViewer,f.r.api.getLastMemoryRecall().delivery])assert.deepEqual(plain(value.sourceTurnAccounting),receipt);
 });
});
test('registered LIBRA unavailable Micro enumeration never reports a complete zero',async()=>{
 // The unified engine replaced the legacy activeMicroRecallCorpus step: Micro units are now
 // enumerated per turn by the graph projection (readActiveMicroMemory). Report every Micro
 // head as unavailable there; the projection records it as pending Micro evidence.
 const transform=source=>{const anchor='            () => readActiveMicroMemory(scope, worldlineId, 0, turn));';assert.equal(source.split(anchor).length,2,'exactly one unified Micro enumeration seam');return source.replace(anchor,"            () => { globalThis.__MICRO_ENUMERATION_UNAVAILABLE__=(globalThis.__MICRO_ENUMERATION_UNAVAILABLE__||0)+1; return {status:'unavailable',reason:'controlled_micro_index_unavailable'}; });");};
 await withEmptyLibra(transform,(f,r)=>{
   assert.ok(f.r.context.__MICRO_ENUMERATION_UNAVAILABLE__>0,'the unified Micro enumeration seam was reached');
   assert.equal(r.lastClassicInjectionMeta.injected,false);const receipt=r.lastClassicInjectionMeta.sourceTurnAccounting;
   assert.equal(receipt?.status,'unknown');assert.equal(receipt?.completeUniqueOriginalTurns,null);
   assert.deepEqual(plain(r.lastMemoryRecallViewer.sourceTurnAccounting),plain(receipt));
 });
});
test('registered LIBRA recall failure stays fail-open without a zero receipt',async()=>{
 const transform=source=>{const anchor='let result = await recall(context, queryBundle, guard);';assert.equal(source.split(anchor).length,2);return source.replace(anchor,"let result = await (async()=>{throw Error('CONTROLLED_RECALL_FAILURE');})();");};
 await withEmptyLibra(transform,(_f,r)=>{assert.equal(r.lastMemoryInjectionMeta.failOpen,true);assert.equal(r.lastMemoryInjectionMeta.sourceTurnAccounting,undefined);assert.equal(r.lastMemoryRecallViewer.sourceTurnAccounting,undefined);assert.equal(r.lastClassicInjectionMeta,null);});
});
test('registered LIBRA changed-scope boundary rejection never publishes an empty zero receipt',async()=>{
 // Observe the current owner-protected seam immediately before the real
 // boundary validation. Mutate the host chat itself; retain both product guards.
 const transform=source=>{
  const anchor="        if (responseBoundary) await runRecallStep(guard, 'unified_response_boundary', () => assertUnifiedResponseBoundary(responseBoundary), RECALL_STEP_BUDGET_MS);";
  assert.equal(source.split(anchor).length,2,'exactly one current pre-publication boundary seam');
  return source.replace(anchor,
   "        globalThis.__SOURCE_TURN_LATE_SCOPE_OBSERVED__=(globalThis.__SOURCE_TURN_LATE_SCOPE_OBSERVED__||0)+1;\n"+
   "        context.chat.id=context.chat.chatId='controlled-late-scope-change';\n"+anchor);
 };
 await withEmptyLibra(transform,(f,r)=>{
  assert.equal(f.r.context.__SOURCE_TURN_LATE_SCOPE_OBSERVED__,1,'late physical-scope observer reached exactly once');
  assert.equal(f.chat.id,'controlled-late-scope-change');assert.equal(f.chat.chatId,'controlled-late-scope-change');
  assert.equal(r.lastMemoryInjectionMeta.failOpen,true);assert.equal(r.lastMemoryInjectionMeta.sourceTurnAccounting,undefined);assert.equal(r.lastMemoryRecallViewer.sourceTurnAccounting,undefined);assert.equal(r.lastClassicInjectionMeta,null);
 });
});
