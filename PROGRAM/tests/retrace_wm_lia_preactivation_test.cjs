 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('../wm/tools/wm-handoff-fixture.cjs');
const {connect}=require('./helpers/retrace-wm-fixture.cjs');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');
async function setup(t,{readbackIncomplete=false,loseLiaAck=false,missingCapability=false}={}) {
 const sourceIdentity={scope:'char:lia-char|chat:lia-chat|persona:lia-live-persona::fixture',characterId:'lia-char',chatId:'lia-chat',personaId:'lia-live-persona::fixture',resetGeneration:0};
 const f=await fixture(t,{sourceIdentity}),v=await connect(t,f,{withLia:true,readbackIncomplete});
 const handlers=new Map(),responses=new Map();let seq=0,lost=false;
 const lia=await createFixture('official',{configureApi(api,{db}){
   api.getCharacter=api.getCharacterFromIndex=async()=>v.sandbox.character;
   api.getCurrentChatIndex=async()=>v.sandbox.character.chatPage;
   api.getChat=api.getCurrentChat=async()=>v.sandbox.character.chats[v.sandbox.character.chatPage];
   api.getChatFromIndex=async(_c,i)=>v.sandbox.character.chats[i];
   api.setChatToIndex=async(_c,i,next)=>{v.events.push({kind:'lia-bind',active:v.sandbox.character.chats[v.sandbox.character.chatPage].id});v.sandbox.character.chats[i]=v.into(next);return true;};
   api.addPluginChannelListener=async(channel,handler)=>{handlers.set(channel,handler);return true;};
   api.postPluginChannelMessage=async(_id,_channel,response)=>responses.set(response.requestId,JSON.parse(JSON.stringify(response)));
 }});t.after(()=>lia.dispose());
 const channel='lia_persona_handoff_request_v1';
 v.sandbox.requestLiaIpc=async(action,payload)=>{
   v.events.push({kind:'lia:'+action,active:v.sandbox.character.chats[v.sandbox.character.chatPage].id});
   const requestId='lia-test-'+(++seq);
   await handlers.get(channel)({schema:'lia-persona-handoff-ipc-v1',kind:'request',requestId,action,payload:JSON.parse(JSON.stringify(payload))},{sender:'flashback_hayaku_bridge'});
   const response=responses.get(requestId);assert(response,'LIA responded');
   if(!response.ok)throw Error(response.error);
   if(action==='prepare_chat_handoff'&&loseLiaAck&&!lost){lost=true;throw Error('synthetic_lia_ack_lost');}
   if(action==='capabilities'&&missingCapability)delete response.result.capabilities.targetPersonaPreactivation;
   return v.into(response.result);
 };
 // Requirement string is read from the actual LIA capability rather than a fake success.
 const caps=await v.sandbox.requestLiaIpc('capabilities',{});
 v.sandbox.RETRACE_PEER_REQUIREMENTS.lia.handoffContract=caps.handoff.contract;
 return {f,v,lia,handlers,responses};
}
test('WM + real LIA owner prepares inactive persona, materializes final scope, verifies and only then activates',async t=>{
 const {f,v,lia}=await setup(t);
 const modes={flashback:'plugin_only',hayaku:'server_only',libra:'plugin_only'},preparedOwners=[];
 for(const [owner,name] of Object.entries({flashback:'requestFlashbackIpc',hayaku:'requestHayakuIpc',libra:'requestLibraIpc'}))v.sandbox[name]=async(action,payload)=>{
  if(action==='memory_suite_storage_status')return v.into({mode:modes[owner],status:{state:'ready'}});
  assert.equal(action,'memory_suite_prepare_handoff_target');preparedOwners.push(owner);
  return v.into({schema:'memory-suite.target-storage-preparation.v1',owner,targetChatId:payload.targetChatId,transferId:payload.transferId,mode:modes[owner],verified:true});
 };
 const sourceIndex=JSON.parse(lia.values.get('liaPersonaLinkerLivePersonaIndexV2')).entries['char:lia-char|chat:lia-chat'];
 const sourceShard=lia.values.get(sourceIndex.storageKey);
 const source=JSON.stringify(v.sandbox.character.chats[0]),wmBefore=f.sourceObservation();
 const originalPersona=JSON.stringify(lia.db.personas.find(p=>p.id===f.source.personaId));
 const result=await v.api.continueToNextSession(v.into({includeWm:true}));
 assert.equal(result.ok,true);assert.equal(result.storagePolicy.participantCount,5);assert.equal(result.storageDestination,'per_owner');assert.deepEqual(preparedOwners,['flashback','hayaku','libra']);assert.equal(result.liaVerified,true);assert.equal(result.wmVerified,true);
 const target=v.sandbox.character.chats.find(c=>c.id===result.targetChatId),wm=target.memorySessionBridge.handoffJournal.wmHandoff;
 assert.equal(wm.targetIdentity.personaId,target.bindedPersona);assert.notEqual(target.bindedPersona,f.source.personaId);assert.equal(wm.targetPersonaPending,false);
 const kinds=v.events.map(e=>e.kind),bind=kinds.indexOf('lia-bind'),prepare=kinds.indexOf('prepareHandoff');
 const activate=v.events.findIndex(e=>e.kind==='host-save'&&e.active===target.id);
 assert(bind>=0&&bind<prepare&&prepare<activate);assert(v.events.slice(0,activate).every(e=>!e.active||e.active===f.source.chatId));
 assert(v.events.slice(prepare,activate).some(e=>e.kind==='lia:verify_chat_handoff'));
 assert.equal(JSON.stringify(v.sandbox.character.chats.find(c=>c.id===f.source.chatId)),source);
 assert.equal(JSON.stringify(lia.db.personas.find(p=>p.id===f.source.personaId)),originalPersona);assert.deepEqual(f.sourceObservation(),wmBefore);
 assert.equal(v.messages.find(m=>m.action==='prepareHandoff').payload.targetIdentity.personaId,target.bindedPersona);
 assert.equal(v.messages.find(m=>m.action==='adoptHandoff').payload.pendingToken,null);
 assert.equal(lia.values.get(sourceIndex.storageKey),sourceShard);assert.deepEqual(JSON.parse(lia.values.get('liaPersonaLinkerLivePersonaIndexV2')).entries['char:lia-char|chat:lia-chat'],sourceIndex);
 const drift=JSON.parse(JSON.stringify(wm));drift.targetIdentity.personaId='different';
 await assert.rejects(v.api.persistNextSessionHandoffJournal(target.id,result.transferId,v.into({wmHandoff:drift})),/wm_handoff_binding_immutable/);
});
test('lost LIA acknowledgement retains same target and fork, then resumes without another persona',async t=>{
 const {v,lia}=await setup(t,{loseLiaAck:true});
 await assert.rejects(v.api.continueToNextSession(v.into({includeWm:true})),/synthetic_lia_ack_lost/);
 const target=v.sandbox.character.chats[0],bridge=target.memorySessionBridge,persona=target.bindedPersona,count=lia.db.personas.length;
 assert.equal(v.sandbox.character.chats[v.sandbox.character.chatPage].id,'lia-chat');assert.equal(bridge.handoffJournal.wmHandoff.targetIdentity,null);
 assert.equal(v.messages.filter(m=>m.action==='prepareHandoff').length,0);
 const result=await v.api.resumeNextSessionHandoff(v.into({targetChatId:target.id,transferId:bridge.transferId}));
 assert.equal(result.ok,true);assert.equal(lia.db.personas.length,count);assert.equal(v.sandbox.character.chats[0].bindedPersona,persona);assert.equal(v.sandbox.character.chats.length,2);
});
test('incomplete WM readback retains verified persona and source selection; drift blocks resume',async t=>{
 const {v,lia}=await setup(t,{readbackIncomplete:true});const result=await v.api.continueToNextSession(v.into({includeWm:true}));
 assert.equal(result.ok,false);assert.equal(v.sandbox.character.chats[v.sandbox.character.chatPage].id,'lia-chat');
 const target=v.sandbox.character.chats[0],before=v.messages.length,count=lia.db.personas.length;
 target.bindedPersona='manual-other';
 await assert.rejects(v.api.resumeNextSessionHandoff(v.into({targetChatId:target.id,transferId:result.transferId})),/lia_preactivation_binding_changed/);
 assert.equal(lia.db.personas.length,count);assert.equal(v.sandbox.character.chats[v.sandbox.character.chatPage].id,'lia-chat');
 assert.equal(v.messages.slice(before).filter(m=>m.action==='adoptHandoff').length,0);
});
test('older LIA without preactivation capability blocks before creating any target',async t=>{
 const {v}=await setup(t,{missingCapability:true});await assert.rejects(v.api.continueToNextSession(v.into({includeWm:true})),/lia_target_persona_preactivation_unavailable/);
 assert.equal(v.sandbox.character.chats.length,1);assert.equal(v.events.filter(e=>e.kind==='lia-bind').length,0);
});
test('authenticated LIA owner rejects forged sender and rejects an active target before a fork',async t=>{
 const {v,lia,handlers,responses}=await setup(t,{loseLiaAck:true});
 const request={schema:'lia-persona-handoff-ipc-v1',kind:'request',requestId:'spoof',action:'prepare_chat_handoff',payload:{}};
 await handlers.get('lia_persona_handoff_request_v1')(request,{sender:'someone_else'});assert.equal(responses.has('spoof'),false);
 await assert.rejects(v.api.continueToNextSession(v.into({includeWm:true})),/synthetic_lia_ack_lost/);
 const target=v.sandbox.character.chats[0],bridge=target.memorySessionBridge,count=lia.db.personas.length;v.sandbox.character.chatPage=0;
 await assert.rejects(v.sandbox.requestLiaIpc('prepare_chat_handoff',{sourceChatId:'lia-chat',targetChatId:target.id,transferId:bridge.transferId,sourceLivePersonaId:'lia-live-persona::fixture'}),/preactivation_context_mismatch/);
 assert.equal(lia.db.personas.length,count);assert.equal(v.messages.filter(m=>m.action==='prepareHandoff').length,0);
});
