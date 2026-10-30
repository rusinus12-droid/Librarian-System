'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createMemorySuiteServer}=require('../server/server.cjs');
const transport=require('./helpers/inprocess-review-transport.cjs');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const REPLY='The blue ledger now rests on the upper cabinet shelf.';
const envelope=lineage=>{
  const packet=createValidPacket({turn:2,summary:REPLY});
  packet.meta.packet_type='current_snapshot'; packet.meta.turn_anchor=REPLY;
  packet.meta.lineage=Object.fromEntries(['parentTurnNodeId','logicalTurnId','requestNonce','identityVersion','lineageSchema','turnOwnerKey','generationAttemptId'].map(key=>[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),lineage[key]]));
  packet.meta.summary_memory={summary:REPLY,recallAnchors:[],recallAliases:{},canonicalAnchors:[],mentionedEntityNames:[],directEvidenceSnippets:[REPLY],related_refs:[],confidence:0.82};
  packet.entity={characters:[],relations:[],pov_memories:[],secrets:[]};
  packet.world={location:'',time:'',scene:'',weather:'',active_events:[],historical_events:[],world_rules:[],offscreen_threads:[],factions:[],regions:[]};
  packet.narrative={scene_phase:'',current_arc:'',pacing:'',conflict_traces:[],scene_deltas:[],theme_motifs:[],critical_dialogue:[]};
  packet.planner={continuity_locks:[],do_not_resolve_yet:[],consequence_ledger:[],payoff_tracker:[],open_invitations:[]};
  packet.importance={overall:0.72,reason:[REPLY]};
  return {schema:'hayaku.native_repair_output.v1',packet,grounding:[{path:'meta.summary_memory.summary',source:'target',evidence:[REPLY]}]};
};
for(const reconnect of [true,false])test(`startup server failure: reconnect=${reconnect}`,async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku-reconnect-')),app=createMemorySuiteServer({dataDir,autoBackup:false,port:0});
  let online=false,r;
  try{
    r=await createHayakuRuntime({pluginSourceFile:process.env.HAYAKU_RECONNECT_SOURCE,nativeFetch:(...args)=>online?transport(app)(...args):Promise.reject(Error('server_unavailable')),
      arguments:{memory_suite_server_mode:'server_only',memory_suite_server_url:'http://127.0.0.1:31991'},
      afterRequestAutoRepair:true,backgroundAutoRepair:false,autoRepair:false,
      messages:[{role:'user',chatId:'u1',data:'Where is the blue ledger?'},{role:'assistant',chatId:'a1',data:hiddenPacketMessage('The blue ledger is in the cabinet.',createValidPacket({turn:1,summary:'The blue ledger is in the cabinet.'}))},{role:'user',chatId:'u2',data:'Move the blue ledger to the upper shelf.'}],
      transformSource:s=>s.replace('const RisuCompat = (() => {','globalThis.__reconnectBridge=MemorySuiteStorageBridge;\nconst RisuCompat = (() => {').replace('Memory.pendingCaptures = [...Memory.pendingCaptures, entry].slice(-8);','globalThis.__reconnectPending=entry;\nMemory.pendingCaptures = [...Memory.pendingCaptures, entry].slice(-8);')});
    const scope=await r.hayaku._test.currentChatScope();
    await r.safeLocalStorage.setItem('__memory_suite_internal_scope_routes_v1__:hayaku',JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:'hayaku',pluginId:'hayaku_locator_continuity',legacyGlobalModeImported:true,entries:{[scope.key]:{scopeId:scope.key,scopeKey:scope.key,mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
    online=reconnect;
    const input=r.chat.message.map(m=>({role:m.role,chatId:m.chatId,content:m.data})),out=await r.callBeforeRequest(input);
    if(!reconnect){
      assert.equal(out.length,input.length);
      assert.equal(r.hayaku.lastDebug().lastBeforeRequest.reason,'readset_admission_refused');
      assert.equal(r.hayaku.lastDebug().lastBeforeRequest.error,'MEMORY_SUITE_SERVER_UNAVAILABLE');
      await r.callAfterRequest(REPLY,'model'); assert.equal(r.llmCalls.length,0); return;
    }
    assert.ok(out.length>input.length,'recovered server must admit recall on this request');
    const pending=r.context.__reconnectPending;assert.ok(pending?.lineage?.requestNonce,'real beforeRequest arms recovery');
    r.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(pending.lineage))}));
    const repaired=await r.callAfterRequest(REPLY,'model');
    const inspection=r.hayaku._test.packetCaptureInspectionFromText(repaired);
    assert.equal(inspection.validCount,1,JSON.stringify(pending.afterRequestRepair));
    assert.equal(inspection.packets[0].requestNonce,pending.lineage.requestNonce);
    assert.equal(r.llmCalls.length,1,'one bounded Other AX call');
    assert.equal(await r.callAfterRequest(repaired,'model'),repaired);
    assert.equal(r.llmCalls.length,1,'usable repair must never dispatch again');
    r.chat.message.push({role:'assistant',chatId:'a2',data:repaired});r.chat.messages=r.chat.message;
    await r.hayaku._test.processRisuChatOutputEvent({char:r.character,chat:r.chat,characterIndex:0,chatIndex:0,messageIndex:3});
    // The callback's durable receipt intentionally precedes canonical binding.
    // The next normal request verifies the committed host pair before recall.
    r.chat.message.push({role:'user',chatId:'u3',data:'Where is the blue ledger now?'});
    const nextInput=r.chat.message.map(m=>({role:m.role,chatId:m.chatId,content:m.data}));
    await r.callBeforeRequest(nextInput);
    let captured=null;
    for(let i=0;i<100&&!captured;i++){
      captured=(await r.hayaku.ledger.inspect({includeRecords:true})).records?.find(row=>row.recordState==='active'&&Number(row.targetPairIndex)===2);
      if(!captured)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(captured,'next request must bind the committed repair to its exact source pair');
    assert.equal(captured.packetAuthor,'after_request_repair');
    const row=app.repositories.hayaku.database.prepare('SELECT value_json FROM kv WHERE key=? AND deleted=0').get('hayaku.v2.ledger.'+scope.key);
    assert.ok(row,'real temporary SQLite contains the ledger');
    let durable=JSON.parse(row.value_json);if(typeof durable==='string')durable=JSON.parse(durable);
    assert.ok(JSON.stringify(durable).includes(pending.lineage.requestNonce),'physical ledger retains exact request lineage');
    assert.equal(r.llmCalls.length,1,'binding and readback must not invoke Other AX again');
  }finally{if(r)await r.dispose();await app.close();}
});
