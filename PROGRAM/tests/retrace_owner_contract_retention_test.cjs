'use strict';
// Non-WM assertions retained from the former materialized-receipt/owner-mode tests.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../plugins/RETRACE.js'), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
};
function fixture() {
  const sandbox = {
    text: value => String(value ?? ''),
    stableHash64: value => crypto.createHash('sha256').update(String(value)).digest('hex'),
    HANDOFF_ACCEPTED_SCHEMAS: new Set(['memory-session-bridge-v1']),
    HANDOFF_JOURNAL_SCHEMA: 'memory-session-bridge-handoff-journal-v1',
    HANDOFF_STORAGE_MODES: ['plugin_only', 'server_only'],
    HANDOFF_STORAGE_DESTINATIONS: ['plugin_only', 'server_only', 'per_owner'],
    HANDOFF_STORAGE_POLICY_SCHEMA: 'memory-session-bridge-storage-policy-v1',
    MEMORY_SUITE_OWNER_GATE_SCHEMA: 'retrace.memory_suite_owner_storage_gate.v1',
    MEMORY_SUITE_OWNER_STATUS_ORDER: ['flashback', 'hayaku', 'libra', 'lia'],
    Date
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    globalThis.clone = (value, fallback = null) => { try { return JSON.parse(JSON.stringify(value)); } catch (_) { return fallback; } };
    globalThis.contextIdentity = value => ({chatId: value.chat?.id || ''});
    globalThis.getCurrentContext = async () => ({character, characterIndex: 0, chat: character.chats[0]});
    globalThis.saveCharacter = async value => { character = clone(value); };
  ` + section('  const sourcePreservationReceiptMatches =', '  const memorySuiteStorageReceiptMatches =')
    + section('  const sealNextSessionHandoffJournal =', '  const attachLegacyPendingHandoffStoragePolicy =')
    + section('  const memorySuiteOwnerStorageGateFromRows =', '  const inspectMemorySuiteOwnerStorageGate =')
    + section('  const handoffStoragePolicyFromGate =', '  const renderHandoffStorageGate =')
    + '\nglobalThis.api = {sourcePreservationReceiptMatches, sealNextSessionHandoffJournal, persistNextSessionHandoffJournal, memorySuiteOwnerStorageGateFromRows, handoffStoragePolicyFromGate};', sandbox);
  const into = value => { sandbox.json = JSON.stringify(value); return vm.runInContext('JSON.parse(json)', sandbox); };
  return {sandbox, api: sandbox.api, into};
}
test('core zero-copy preservation rejects a physical copy', () => {
  const {api, into} = fixture();
  const receipt = {handoffContract:'core-zero-copy',sourcePreserved:true,sourceMutationAllowed:false,sourceCompactionAllowed:false,sourceFingerprintBefore:'same',sourceFingerprintAfter:'same',physicalCopies:1};
  assert.equal(api.sourcePreservationReceiptMatches(into(receipt), into({handoffContract:'core-zero-copy'})), false);
  assert.equal(api.sourcePreservationReceiptMatches(into({...receipt, physicalCopies:0}), into({handoffContract:'core-zero-copy'})), true);
});
test('ordinary owner readiness preserves absent peers and per-owner modes', () => {
  const {api, into} = fixture();
  const rows = [{owner:'libra',installed:true,connected:true,supported:true,mode:'plugin_only'},{owner:'lia',installed:false}];
  const single = api.memorySuiteOwnerStorageGateFromRows(into(rows));
  assert.equal(single.ready, true);
  assert.equal(single.participantCount, 1);
  const mixedRows = ['flashback','hayaku','libra'].map(owner => ({owner,installed:true,connected:true,supported:true,mode:owner === 'hayaku' ? 'server_only' : 'plugin_only'}));
  const mixed = api.memorySuiteOwnerStorageGateFromRows(into(mixedRows), into({hayaku:{verified:true}}));
  assert.equal(mixed.ready, true);
  assert.equal(mixed.participantCount, 3);
  assert.equal(mixed.commonMode, 'per_owner');
  assert.deepEqual(JSON.parse(JSON.stringify(api.handoffStoragePolicyFromGate(mixed, 1).participants)), mixedRows.map(({owner, mode}) => ({owner, mode})));
});
test('ordinary completed handoff rejects owner-policy replacement', async () => {
  const {api, into, sandbox} = fixture();
  const policy = {schema:'memory-session-bridge-storage-policy-v1',mode:'plugin_only',participants:[{owner:'libra',mode:'plugin_only'}]};
  const journal = api.sealNextSessionHandoffJournal(into({schema:'memory-session-bridge-handoff-journal-v1',state:'completed',transferId:'transfer',sourceChatId:'source',targetChatId:'target',storageDestination:'plugin_only',storagePolicy:policy,ownerStatus:{libra:{required:true,verified:true}}}));
  sandbox.character = into({chats:[{id:'target',memorySessionBridge:{schema:'memory-session-bridge-v1',transferId:'transfer',sourceChatId:'source',targetChatId:'target',targetStorageMode:'plugin_only',targetStoragePolicy:policy,handoffJournal:journal}}]});
  await assert.rejects(api.persistNextSessionHandoffJournal('target','transfer',into({storagePolicy:{participants:[]}})), /handoff_owner_policy_immutable/);
  const samePolicy = {participants:[{mode:'plugin_only',owner:'libra'}],mode:'plugin_only',schema:policy.schema};
  const saved = await api.persistNextSessionHandoffJournal('target','transfer',into({storagePolicy:samePolicy}));
  assert.equal(saved.state, 'completed');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.storagePolicy)), samePolicy);
});

test('ordinary core-three mixed-mode session preserves owner target preparation', async () => {
  const prepared = [], modes = {flashback:'plugin_only',hayaku:'server_only',libra:'plugin_only'};
  const sandbox = {
    Date, text:value=>String(value??''), clone:value=>value===undefined?null:JSON.parse(JSON.stringify(value)),
    compact:value=>String(value??''), stableHash64:value=>crypto.createHash('sha256').update(String(value)).digest('hex'),
    Runtime:{handoffResumePromises:new Map(),memorySuitePeerServer:null}, warn:()=>{}, delay:async()=>{},
    uuid:(()=>{let n=0;return()=>['target','transfer'][n++]||'request-'+n;})(),
    HANDOFF_STORAGE_MODES:['plugin_only','server_only'], HANDOFF_STORAGE_DESTINATIONS:['plugin_only','server_only','per_owner'],
    HANDOFF_SCHEMA:'memory-session-bridge-v1', HANDOFF_ACCEPTED_SCHEMAS:new Set(['memory-session-bridge-v1']),
    HANDOFF_JOURNAL_SCHEMA:'memory-session-bridge-handoff-journal-v1', HANDOFF_STORAGE_POLICY_SCHEMA:'memory-session-bridge-storage-policy-v1',
    MEMORY_SUITE_OWNER_GATE_SCHEMA:'retrace.memory_suite_owner_storage_gate.v1', MEMORY_SUITE_OWNER_STATUS_ORDER:['flashback','hayaku','libra','lia'],
    FLASHBACK_PLUGIN_ID:'flashback_memory', HAYAKU_PLUGIN_ID:'hayaku_locator_continuity', LIBRA_PLUGIN_ID:'libra_memory', LIA_PLUGIN_ID:'lia_persona_linker',
    LIBRA_HANDOFF_RECEIPT_SCHEMA:'libra-receipt', FLASHBACK_REQUIRED_HANDOFF_CONTRACT:'core-zero-copy',
    RETRACE_PEER_COMPATIBILITY_SCHEMA:'core-compat', RETRACE_PEER_PROTOCOL_MAJOR:1,
    isLiaLivePersonaId:()=>false, withLegacyLibraWorldAdditionalExpectation:value=>value,
    MemorySuiteHostLineage:{normalize:value=>value||{},inspect:()=>({})}, memorySuiteModeLabel:value=>value,
    readLibraSource:async()=>({available:false,recordCount:0}), inspectCompatibilitySuite:async()=>({compatible:true}),
    prepareLibraSessionHandoff:async()=>{throw Error('absent_libra_called');}, libraLegacyWorldAdditionalMatches:()=>true,
    adoptLiaLivePersonaHandoff:async()=>({verified:true,durable:true}), liaAdoptionReceiptMatches:()=>true,
    adoptFlashbackSessionHandoff:async()=>({ok:true,verified:true,durable:true,sourcePreserved:true,records:0}),
    adoptHayakuSessionHandoff:async()=>({ok:true,verified:true,durable:true,records:0}), libraVerificationReceiptMatches:()=>true,
    requestLiaIpc:async()=>{throw Object.assign(Error('absent'),{code:'LIA_IPC_UNAVAILABLE'});},
    MemorySuiteStorageBridge:{managerServerIntegrity:async()=>({ok:true,result:'ok'})}
  };
  vm.createContext(sandbox);
  vm.runInContext('globalThis.clone=value=>value===undefined?null:JSON.parse(JSON.stringify(value));'
    + section('  const handoffHostValueFingerprint =','  const closeRetraceDialog =')
    + section('  const requestMemorySuiteOwnerStorageStatus =','  const renderHandoffStorageGate =')
    + '\nglobalThis.continueSession=continueToNextSession;', sandbox);
  const into = value => {sandbox.json=JSON.stringify(value);return vm.runInContext('JSON.parse(json)',sandbox);};
  sandbox.character=into({id:'character',chatPage:0,chats:[{id:'source',bindedPersona:'ordinary-persona',message:[{role:'user',data:'source untouched'}],note:'original'}]});
  vm.runInContext('globalThis.getCurrentContext=async()=>({character,characterIndex:0,chat:character.chats[character.chatPage]});globalThis.contextIdentity=value=>({characterId:value.character?.id||"",chatId:value.chat?.id||"",personaId:value.chat?.bindedPersona||""});',sandbox);
  sandbox.liveApi=()=>({getDatabase:async()=>({plugins:[]}),setCharacterToIndex:async(_index,value)=>{sandbox.character=into(value);return true;},getCharacterFromIndex:async()=>sandbox.character});
  sandbox.inspectTransition=async()=>{
    const context=await sandbox.getCurrentContext();
    return into({context,identity:sandbox.contextIdentity(context),flashback:{available:false,records:0,loadedRecords:0},hayaku:{available:false,scope:{}},libra:{available:false,pluginAvailable:false,recordCount:0},includeHayaku:false,includeLibra:false,pendingColdStart:{available:false},pendingIncrementalRecovery:{available:false},hayakuRecordCount:0});
  };
  for(const [owner,name] of Object.entries({flashback:'requestFlashbackIpc',hayaku:'requestHayakuIpc',libra:'requestLibraIpc'})) {
    sandbox[name]=async(action,payload)=>{
      if(action==='memory_suite_storage_status')return into({mode:modes[owner],status:{state:'ready'}});
      assert.equal(action,'memory_suite_prepare_handoff_target');prepared.push(owner);
      return into({schema:'memory-suite.target-storage-preparation.v1',owner,targetChatId:payload.targetChatId,transferId:payload.transferId,mode:modes[owner],verified:true});
    };
  }
  const sourceBefore=JSON.parse(JSON.stringify(sandbox.character.chats[0]));
  const result=await sandbox.continueSession(into({}));
  assert.equal(result.ok,true);
  assert.equal(result.storagePolicy.participantCount,3);
  assert.equal(result.storageDestination,'per_owner');
  assert.deepEqual(prepared,['flashback','hayaku','libra']);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.character.chats[1])),sourceBefore);
});
