'use strict';
// Actual RETRACE source sections in a synthetic plugin-channel host. No live DATA.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../../plugins/RETRACE.js'),'utf8');
const sdk=fs.readFileSync(path.join(__dirname,'../../sdk/WmHandoffReceipt.source.js'),'utf8');
const W=require('../../sdk/WmHandoffReceipt.source.js'),IPC=require('../../wm/src/parts/04l-retrace-ipc.js');
const section=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start);if(start<0||end<=start)throw Error('source_section_missing:'+a);return source.slice(start,end);};
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
function createVm({withLia=false}={}) {
 const sandbox={console,Date,setTimeout,clearTimeout,TextEncoder,TextDecoder,
  stableHash64:hash,Runtime:{wmHandoffSelected:true,wmIpcRegistered:false,wmIpcPending:new Map(),ipcListenerRegistrations:new Map(),handoffResumePromises:new Map(),memorySuitePeerServer:null},
  text:v=>String(v??''),compact:v=>String(v??''),clone:v=>v===undefined?null:JSON.parse(JSON.stringify(v)),uuid:(()=>{let i=0;return()=>['target','transfer'][i++]||'request-'+i})(),
  warn:()=>{},delay:async()=>{},MEMORY_SUITE_OWNER_STATUS_ORDER:['flashback','hayaku','libra','lia','wm'],HANDOFF_STORAGE_MODES:['plugin_only','server_only'],HANDOFF_STORAGE_DESTINATIONS:['plugin_only','server_only','per_owner'],
  MEMORY_SUITE_OWNER_GATE_SCHEMA:'retrace.memory_suite_owner_storage_gate.v1',HANDOFF_STORAGE_POLICY_SCHEMA:'memory-session-bridge-storage-policy-v1',HANDOFF_JOURNAL_SCHEMA:'memory-session-bridge-handoff-journal-v1',HANDOFF_SCHEMA:'memory-session-bridge-v1',HANDOFF_ACCEPTED_SCHEMAS:new Set(['memory-session-bridge-v1']),
  FLASHBACK_PLUGIN_ID:'flashback_memory',HAYAKU_PLUGIN_ID:'hayaku_locator_continuity',LIBRA_PLUGIN_ID:'libra_memory',LIA_PLUGIN_ID:'lia_persona_linker',LIBRA_HANDOFF_RECEIPT_SCHEMA:'libra-receipt',LIA_CHAT_HANDOFF_MARKER_SCHEMA:'lia.live_persona_handoff.marker.v1',LIA_LIVE_PERSONA_ID_PREFIX:'lia-live-persona',LIA_HANDOFF_RECEIPT_SCHEMA:'lia.live_persona_handoff.receipt.v1',FLASHBACK_REQUIRED_HANDOFF_CONTRACT:'core-zero-copy',RETRACE_PEER_COMPATIBILITY_SCHEMA:'core-compat',RETRACE_PEER_PROTOCOL_MAJOR:1,
  RETRACE_PEER_REQUIREMENTS:{libra:{handoffContract:'core-zero-copy'},lia:{handoffContract:'source_immutable_live_persona_fork_v1'}},retraceHealthRecovery:null,
  isLiaLivePersonaId:v=>String(v||'').startsWith('lia-live-'),withLegacyLibraWorldAdditionalExpectation:v=>v,
  MemorySuiteHostLineage:{normalize:v=>v||{},inspect:()=>({})},memorySuiteModeLabel:v=>v,
  readLibraSource:async()=>({available:false,recordCount:0}),inspectCompatibilitySuite:async()=>({compatible:true}),
  prepareLibraSessionHandoff:async()=>{throw Error('absent_libra_called');},libraLegacyWorldAdditionalMatches:()=>true,
  adoptLiaLivePersonaHandoff:async()=>({verified:true,durable:true}),liaAdoptionReceiptMatches:()=>true,
  adoptFlashbackSessionHandoff:async()=>({ok:true,verified:true,durable:true,sourcePreserved:true,records:0}),adoptHayakuSessionHandoff:async()=>({ok:true,verified:true,durable:true,records:0}),
  libraVerificationReceiptMatches:()=>true,requestFlashbackIpc:async()=>{throw Object.assign(Error('absent'),{code:'FLASHBACK_IPC_UNAVAILABLE'});},requestHayakuIpc:async()=>{throw Object.assign(Error('absent'),{code:'HAYAKU_IPC_UNAVAILABLE'});},requestLibraIpc:async()=>{throw Object.assign(Error('absent'),{code:'LIBRA_IPC_UNAVAILABLE'});},requestLiaIpc:async()=>{throw Object.assign(Error('absent'),{code:'LIA_IPC_UNAVAILABLE'});},
  MemorySuiteStorageBridge:{managerServerIntegrity:async()=>({ok:true,result:'ok'})}};
 vm.createContext(sandbox);vm.runInContext('globalThis.clone=v=>v===undefined?null:JSON.parse(JSON.stringify(v));',sandbox);vm.runInContext(sdk,sandbox);
 vm.runInContext(section('  const evaluateWmPeerCompatibility =','  const evaluatePeerCompatibility =')+
 section('  const sourcePreservationReceiptMatches =','  const memorySuiteStorageReceiptMatches =')+
 section('  const registerWmIpc =','  const registerFlashbackIpc =')+
 (withLia ? section('  const isLiaLivePersonaId =','  const probeLibraIpc =')+section('  const memorySuiteStorageReceiptMatches =','  const normalizedHayakuPacketMaxChars =') : '')+
 section('  const handoffHostValueFingerprint =','  const closeRetraceDialog =')+
 section('  const requestMemorySuiteOwnerStorageStatus =','  const renderHandoffStorageGate =')+
 '\nglobalThis.api={requestWmIpc,registerWmIpc,requestMemorySuiteOwnerStorageStatus,evaluateWmPeerCompatibility,wmMaterializedHandoffReceiptMatches,sourcePreservationReceiptMatches,requiredHandoffsVerified,sealNextSessionHandoffJournal,nextSessionHandoffJournalFromChat,persistNextSessionHandoffJournal,ensurePendingWmHandoff,ensurePendingHandoffStorageConfiguration,performPendingNextSessionHandoff,continueToNextSession,resumeNextSessionHandoff,memorySuiteOwnerStorageGateFromRows,handoffStoragePolicyFromGate};',sandbox);
 const into=v=>{sandbox.inputJson=JSON.stringify(v);return vm.runInContext('JSON.parse(inputJson)',sandbox);};
 return {sandbox,api:sandbox.api,into};
}
async function connect(t,fixture,{readbackIncomplete=false,withLia=false}={}) {
 const v=createVm({withLia}),{sandbox,into}=v,callbacks=new Map(),messages=[],events=[];
 sandbox.character=into({id:fixture.source.characterId,chatPage:0,chats:[{id:fixture.source.chatId,bindedPersona:fixture.source.personaId,message:[{role:'user',data:'source untouched'}],note:'original'}]});
 vm.runInContext('globalThis.getCurrentContext=async()=>({character,characterIndex:0,chat:character.chats[character.chatPage]});globalThis.contextIdentity=c=>({characterId:c.character?.id||"",chatId:c.chat?.id||"",personaId:c.chat?.bindedPersona||""});',sandbox);
 const retraceHost={getDatabase:async()=>({plugins:[{name:'libra_world_manager',enabled:true}]}),
  addPluginChannelListener:async(channel,handler)=>{callbacks.set('r:'+channel,handler);return()=>callbacks.delete('r:'+channel);},
  postPluginChannelMessage:async(_id,channel,message)=>{const wire=JSON.parse(JSON.stringify(message));messages.push(wire);await callbacks.get('w:'+channel)(wire,{sender:'flashback_hayaku_bridge'});},
  setCharacterToIndex:async(_index,value)=>{sandbox.character=into(value);events.push({kind:'host-save',active:value.chats[value.chatPage]?.id,pending:!!value.chats[0]?.memorySessionBridge?.handoffJournal});return true;},
  getCharacterFromIndex:async()=>sandbox.character};
 sandbox.liveApi=()=>retraceHost;
 sandbox.registerTrackedPluginChannelListener=async(_key,api,channel,handler)=>api.addPluginChannelListener(channel,handler);
 const wmHost={addPluginChannelListener:async(channel,handler)=>{callbacks.set('w:'+channel,handler);return()=>callbacks.delete('w:'+channel);},
  postPluginChannelMessage:async(_id,channel,message)=>{await callbacks.get('r:'+channel)(into(message),{sender:'libra_world_manager'});}};
 const methods=Object.fromEntries(W.METHODS.map(k=>[k,async input=>{events.push({kind:k});const result=await fixture.adapter[k](input);if(readbackIncomplete&&k==='verifyHandoff'&&result?.schema==='wm.handoff-materialized-receipt.v1'){const invalid=JSON.parse(JSON.stringify(result));invalid.domains.raw.complete=false;return invalid;}return result;}]));
 const dispose=await IPC.register({api:wmHost,methods,readStorageStatus:async input=>({schema:'wm.handoff-storage-status.v1',ready:true,mode:fixture.route.mode,route:fixture.route,sourceReady:input.includeSource===true,sourceIdentity:input.includeSource?fixture.source:null,sourceHead:input.includeSource?fixture.sourceHead:null,reason:''})});t.after(dispose);
 sandbox.inspectTransition=async()=>{
  const context=await sandbox.getCurrentContext(),wm=await v.api.requestMemorySuiteOwnerStorageStatus('wm',{includeSource:true});
  return into({context,identity:sandbox.contextIdentity(context),includeWm:true,wm,flashback:{available:false,records:0,loadedRecords:0},hayaku:{available:false,scope:{}},libra:{available:false,pluginAvailable:false,recordCount:0},includeHayaku:false,includeLibra:false,pendingColdStart:{available:false},pendingIncrementalRecovery:{available:false},hayakuRecordCount:0});
 };
 return {...v,callbacks,messages,events,retraceHost,wmHost};
}
module.exports={createVm,connect,source,sdk,W,section};
