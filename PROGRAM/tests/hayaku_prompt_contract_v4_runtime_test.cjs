'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const source='Alice found a blue ribbon in the archive. Bob opened the door.';
const fixture=()=>createValidPacket({turn:1,subject:'Alice',summary:source});
const quote=(path,evidence=source)=>({path,source:'target',evidence:[evidence]});
(async()=>{
 const h=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the archive.'}]});
 try{
  const t=h.hayaku._test;
  const base=t.admitRegularPacket(fixture(),source);
  for(const rows of [[],[quote('meta.summary_memory.summary')]]){
   const p=fixture();p.meta.record_grounding=rows;
   const result=t.admitRegularPacket(p,source);
   assert.equal(result.ok,true);assert.equal(result.admission.rejected.length,0);
   assert.deepEqual(Array.from(result.admission.acceptedPaths),Array.from(base.admission.acceptedPaths));
   for(const axis of ['entity','world','narrative','planner'])assert.deepEqual(result.packet[axis],p[axis]);
   assert.equal(result.packet.meta.stateAuthority,p.meta.stateAuthority,'optional quotes cannot invent stronger authority');
  }
  const weak=fixture();weak.meta.stateAuthority=false;weak.meta.record_grounding=[quote('meta.summary_memory.summary')];
  assert.equal(t.admitRegularPacket(weak,source).packet.meta.stateAuthority,false);
  for(const kind of ['after_request_recovery','incremental_recovery','cold_start']){
   const p=fixture(),result=t.admitHayakuPacketRecords(p,kind,{turn:1,text:source},{groundingMode:'optional_items'},
     {schema:'hayaku.native_repair_output.v1',packet:p,grounding:[quote('meta.summary_memory.summary')]});
   assert(result.meta.record_admission.rejected.length>0,'native mandatory item evidence remains mandatory');
   assert.equal(result.meta.stateAuthority,false);
  }
  // Filtering record 0 must not move its bad quote onto surviving record 1.
  const p=fixture();p.entity.characters=[{name:'Alice'},{name:'Bob'}];
  p.meta.record_grounding=[quote('entity.characters[0]','Not in the response.'),quote('entity.characters[1]')];
  const first=t.admitRegularPacket(p,source);assert.equal(first.ok,true);
  assert.equal(first.packet.entity.characters.length,1);assert.equal(first.packet.entity.characters[0].name,'Bob');
  assert.equal(first.packet.meta.stateAuthority,false);
  const second=t.admitRegularPacket(first.packet,source);assert.equal(second.ok,true);
  assert.equal(second.packet.entity.characters.length,1,'retained record must survive physical readback');
  assert.equal(second.changed,false,'canonical evidence paths must remain stable on readback');
  const body=hiddenPacketMessage(source,first.packet),inspect=t.packetCaptureInspectionFromText(body);
  const captured=[...inspect.packets,...inspect.repairablePackets][0];assert(captured);
  assert.equal(captured.hash,t.historyPacketDiagnosticsFromBody(body)[0].hash);
  const noMemory=fixture();for(const axis of ['entity','world','narrative','planner'])noMemory[axis]={};noMemory.meta.summary_memory.summary='';
  assert.equal(t.admitRegularPacket(noMemory,source).ok,false,'blank content cannot fabricate memory completion');
  console.log('PASS optional regular quotes, native required coverage, authority, filtered path/readback stability');

  const settings={...h.hayaku.settings(),memoryLanguage:'ko',requestLineage:{logicalTurnId:'logical-fixture',requestNonce:'nonce-fixture',parentTurnNodeId:''},sceneBaton:{sceneId:'archive'}};
  const profiles=[t.buildPacketCoreStaticWriteInstruction(settings),t.buildPacketCoreCompactWriteInstruction(settings),t.buildPacketCoreCompactWriteInstruction(settings,{critical:true})];
  const routes={meta:['speaker_boundaries','overpromotion_risks'],entity:['characters','relations','pov_memories','secrets'],world:['active_events','historical_events','world_rules','offscreen_threads','factions','regions'],narrative:['conflict_traces','scene_deltas','theme_motifs','critical_dialogue'],planner:['continuity_locks','do_not_resolve_yet','consequence_ledger','payoff_tracker','open_invitations']};
  for(const prompt of profiles){
   // The collection list used to be printed as `axis[keys]`, which is the shape the model misread as
   // extra packet keys (measured: eight top-level keys -> native_repair_packet_top_level_invalid).
   // Every collection must still be listed and tied to its axis, in the shape that fixed it.
   for(const [axis,keys]of Object.entries(routes)){
    for(const key of keys)assert(prompt.includes(key),`${axis}.${key} must be listed`);
    assert(prompt.includes(`packet.${axis} holds ${keys.join(', ')}`)||prompt.includes(`${axis} holds ${keys.join(', ')}`),
      `${axis} collections must be tied to their axis`);
   }
   assert.match(prompt,/arrays of records/);assert.match(prompt,/summaries and descriptions in Korean/);
   assert.match(prompt,/quotes verbatim in their source language/);assert.match(prompt,/Escape embedded double quotes, backslashes and newlines/);
   assert.match(prompt,/omitted quotes do not invalidate other records/);assert.match(prompt,/For packet extraction only/);
   assert.match(prompt,/provider limits/);assert.match(prompt,/never invent a change or filler summary/);
   assert.equal((prompt.match(/summary alone/g)||[]).length,1);
  }
  assert.deepEqual(t.packetSchemaV2WriteInstruction({requestPressure:'extreme'}),t.packetSchemaV2WriteInstruction({requestPressure:'normal'}));
  const example=t.packetCompletedFormatExample();
  assert.equal(h.hayaku.packet.validate(example).ok,true);
  const admittedExample=t.admitRegularPacket(example,'The archive door is open.');assert.equal(admittedExample.ok,true);assert.equal(admittedExample.packet.meta.stateAuthority,false);
  const unicode='Alice said, “문이 열렸어.”\nBob answered: "Yes". The path is C:\\archive.';
  const multilingual=fixture();for(const axis of ['entity','world','narrative','planner'])multilingual[axis]={};
  multilingual.meta.summary_memory.summary='문이 열렸고 밥이 확인했다.';
  multilingual.meta.record_grounding=[quote('meta.summary_memory.summary',unicode)];
  multilingual.narrative.critical_dialogue=[{speaker:'Alice',text:'“문이 열렸어.”'}];
  const roundTrip=JSON.parse(JSON.stringify(multilingual));
  assert.equal(roundTrip.meta.record_grounding[0].evidence[0],unicode);
  assert.equal(t.admitRegularPacket(roundTrip,unicode).ok,true);
  assert.equal(t.buildPacketRuntimeSkeletonInstruction(settings).includes('Host-reported maxResponse'),false);
  const runtime=t.buildPacketRuntimeSkeletonInstruction({...settings,hostOutputBudget:{maxResponse:8192}});
  assert.match(runtime,/Host-reported maxResponse: 8192/);assert.match(runtime,/"parent_turn_node_id":""/);
  assert.equal((runtime.match(/summary alone/g)||[]).length,0);
  assert.equal((t.buildPacketTerminalCompletionSeal(settings).match(/summary alone/g)||[]).length,0);
  const stable=t.packetCacheStaticContract(settings);
  const other=t.packetCacheStaticContract({...settings,hostOutputBudget:{maxResponse:100},requestLineage:{requestNonce:'other'},sceneBaton:{sceneId:'other'}});
  assert.equal(stable.hash,other.hash,'runtime values cannot churn static prefix');
  const full=t.buildAtomicPacketCoreBudgetPlan({settings,capChars:20000,recallCapChars:0});
  const minimum=t.buildAtomicPacketCoreBudgetPlan({settings,capChars:full.atomicMinimumChars,recallCapChars:0});
  assert.equal(minimum.staticProfile,'p4-critical');assert.equal(minimum.active,true);
  // Same shape change as above: the collection list now ties each collection to its axis.
  assert.match(minimum.staticWrite,/world holds active_events/);assert.match(minimum.runtimeSkeletonInstruction,/nonce-fixture/);
  for(const mode of ['tail','inside_terminal_wrapper','before_required_footer']){
   const s={...settings,outputContract:{packetPlacement:{mode,openingTag:'<Answer>',closingTag:'</Answer>'}}};
   const tail=t.buildPacketTerminalCompletionSeal(s);assert.match(tail,/HAYAKU_STATE_PACKET_END/);
   const r=t.buildPacketRuntimeSkeletonInstruction(s);
   if(mode==='inside_terminal_wrapper'){assert.match(r,/immediately before <\/Answer>/);assert.match(tail,/FINAL CONTENT MUST END WITH: <\/Answer>/);}
   if(mode==='before_required_footer'){assert.match(r,/before the required hidden footer/);assert.match(tail,/FOOTER REMAINS THE FINAL CONTENT/);}
  }
  assert.match(t.buildPacketRuntimeSkeletonInstruction({...settings,requestLineage:{...settings.requestLineage,mode:'reroll',targetPairIndex:7}}),/REROLL T7: author from THIS/);
  for(const build of [t.buildPacketCoreStaticWriteInstruction,t.buildPacketCoreCompactWriteInstruction,t.buildPacketRuntimeSkeletonInstruction,t.buildPacketTerminalCompletionSeal])
   assert.equal(build({...settings,outputContract:{structuredData:{wholeResponse:true}}}),'');
  const actual=await t.handleBeforeRequest([{role:'system',content:'Continue the scene.'},{role:'user',chatId:'u1',data:'Open the archive.'}],'model');
  const actualText=actual.map(m=>m.content||m.data||'').join('\n');
  assert.match(actualText,/Host-reported maxResponse: 8192/);assert.match(actualText,/version="p4"/);
  assert.equal(h.llmCalls.length,0,'regular authoring injection adds no model call');
  console.log('PASS all prompt schemas, valid example, multilingual escapes, budgets, stable cache, slots/reroll, real beforeRequest injection');
 }finally{await h.dispose();}
 const persisted=fixture();persisted.entity.characters=[{name:'Alice'},{name:'Bob'}];
 persisted.meta.record_grounding=[quote('entity.characters[0]','Not in the response.'),quote('entity.characters[1]')];
 const original=hiddenPacketMessage(source,persisted);
 const live=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Open the archive.'},{role:'assistant',chatId:'a1',data:original}]});
 try{
  const t=live.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  for(let i=0;i<2;i++){
   await t.reconcileObservedChatTopology(scope,snapshot,'optional_quotes_readback',{prompt:false});
   const ledger=await t.loadStorageLedger(scope),rows=ledger.records.filter(r=>r.recordState==='active');
   assert.equal(rows.length,1);const packet=JSON.parse(rows[0].raw);
   assert.equal(packet.entity.characters.length,1);assert.equal(packet.entity.characters[0].name,'Bob');
   assert.equal(packet.meta.record_grounding[0].path,'entity.characters[0]');
   assert.equal(t.exactHayakuTurnCoverage(snapshot,ledger,scope.key).rows[0].state,'covered');
  }
  assert.equal(live.chat.message[1].data,original,'normal acceptance never rewrites the visible host response');
  assert.equal(live.llmCalls.length,0);
  console.log('PASS optional evidence filtering survives ledger save/readback/reconciliation without duplicate or extra model call');
 }finally{await live.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
