'use strict';
// Shared physical-consumption contracts migrated from retired Writer/Planner
// surfaces to the actual Classic hook and retained sealed response context.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const expose=source=>{
 const anchor='      getUnifiedStorageStatus,';assert(source.includes(anchor));
 return source.replace(anchor,`      retirementCurrentContext: () => Runtime.lastResponseContext,
      retirementConsumedProbe: token => ({count:consumedDataReadSets.get(token)?.proofs.length||0,verify:options=>assertConsumedDataCurrent(token,options)}),
      retirementResealContext: value => {value.contextDigest=digest(unifiedResponseContextBody(value));return value;},
      `+anchor).replace('    async getUnifiedStorageStatus() {',`    retirementCurrentContext: () => LibraMemoryCore.retirementCurrentContext(),
    retirementConsumedProbe: token => LibraMemoryCore.retirementConsumedProbe(token),
    retirementResealContext: value => LibraMemoryCore.retirementResealContext(value),
    async getUnifiedStorageStatus() {`);
};
async function withMicro(run){
 let listener;const f=await fixture({transformSource:expose,host:{addRisuChatListener:async(_kind,handler)=>{listener=handler;return true;},nativeFetch:async()=>{throw Error('offline_test_network_forbidden');}}});
 try{
  f.originalMessages=f.chat.message.slice();f.originalFixtureMessages=f.originalMessages;f.captureOutput=listener;f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
  const detail="도서관 전체는 정숙 구역";assert(detail.length>0);
  f.control.onCall=async args=>{const input=JSON.parse(args[0].messages[1].content),start=input.assistant.text.indexOf(detail);assert(start>=0,'actual assistant source byte span');return{type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'world',text:detail,actor:'',target:"도서관",temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:start,endOffset:start+detail.length,exactQuote:detail}}]}})};};
  assert.equal(typeof listener,'function');listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});
  await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===1,15000);
  const active=await f.r.api.debugReadActiveMicroMemory(1);assert.equal(active.status,'verified');assert.equal(active.record.analysisStatus,'verified','actual retained analyzed claim fixture');assert(active.record.claims.length>0);
  const calls=f.control.calls.length;f.control.onCall=async()=>{throw Error('RETIRED_RESPONSE_MODEL_CALL');};
  const delivered=await f.control.hooks.beforeRequest([{role:'user',content:detail}],'model');
  assert(JSON.stringify(delivered).includes(detail),'actual Classic final delivery carries admitted Micro');
  assert.equal(f.control.calls.length,calls,'actual Classic makes no response provider submission');
  const context=f.r.api.getRuntime().lastResponseContext;
  assert(context?.consumedDataToken);const proof=f.r.api.retirementConsumedProbe(context.consumedDataToken);assert(proof.count>0,'private physical consumed proof is retained');
  assert.equal((await f.r.api.validateResponseContext(context)).current,true);
  await run(f,active,context,proof);

 }finally{await f.r.cleanup();}
}
const invalid=async(f,context,pattern)=>{const checked=await f.r.api.validateResponseContext(context);assert.equal(checked.current,false);if(pattern)assert.match(checked.reason,pattern);return checked;};

const REQUEST='도서관의 정숙 규칙을 고려해서 이어줘.';

// This adapter reads the actual Classic hook's sealed request context. It does
// not synthesize evidence, storage authority, admission or a consumed token.
async function prepareClassic(f,input){
 const count=f.control.calls.length;
 await f.control.hooks.beforeRequest([{role:'user',content:input}],'model');
 assert.equal(f.control.calls.length,count,'actual Classic performs no helper model submission');
 const context=f.r.api.retirementCurrentContext();assert(context?.consumedDataToken);
 const checked=await f.r.api.validateResponseContext(context);assert.equal(checked.current,true,JSON.stringify(checked));
 return {context,scope:{scopeKey:context.scopeKey},evidencePacket:{layers:context.values.canonicalLayers,consumed_data_token:context.consumedDataToken,continuity_state:context.values.currentHead,continuity_state_prompt:JSON.stringify(context.values.currentHead)}};
}
// State-only evidence belongs to the retained shared read-only response reader.
// Classic's memory-only packet does not supply continuity_state. Use the actual
// public state consumer instead of pretending Classic selected absent state.
async function prepareReadOnlyState(f,input){
 const count=f.control.calls.length,context=await f.r.api.getResponseContext({currentInput:input});
 assert.equal(f.control.calls.length,count);assert.equal(context.route,'read_only');
 assert.equal((await f.r.api.validateResponseContext(context)).current,true);
 assert(f.r.api.retirementConsumedProbe(context.consumedDataToken).count>0,'real state-only physical provenance retained');
 return {context,scope:{scopeKey:context.scopeKey},evidencePacket:{layers:context.values.canonicalLayers,consumed_data_token:context.consumedDataToken,continuity_state:context.values.currentHead,continuity_state_prompt:JSON.stringify(context.values.currentHead)}};
}
async function prepareInherited(f, withTwo = false) {
  if (withTwo) {
    f.chat.message = f.originalFixtureMessages.slice(0, 4); f.chat.messages = f.chat.message;
    f.control.onCall = async args => {
      const input = JSON.parse(args[0].messages[1].content);
      const quote = '오늘 돌려주겠다고 약속했다';
      const startOffset = input.assistant.text.indexOf(quote);
      assert(startOffset >= 0);
      return { type: 'success', result: JSON.stringify({
        schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
        micro: { schema: 'libra.micro_memory.v1', ...input.binding, claims: [{
          changeKind: 'event', text: `${quote}.`, actor: '', target: '열쇠', temporalRole: 'current',
          certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {
            role: 'assistant', messageId: input.assistant.messageId, startOffset,
            endOffset: startOffset + quote.length, exactQuote: quote
          }
        }] }
      }) };
    };
    f.captureOutput({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 3 });
    await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 2, 15000);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(2)).status, 'verified');
  }
  const portable = f.r.context.__LIBRAPortableMemoryBackup;
  f.chat.message = f.originalFixtureMessages; f.chat.messages = f.chat.message;
  f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
  assert.equal((await f.run()).completed, 1, 'portable archive requires one actual Canonical source');
  f.control.onCall = async () => {throw Error('RETIRED_HELPER_PROVIDER_SUBMISSION');};
  const envelope = await portable.exportCurrentScope();
  const target = { id: 'micro-inherited-target', chatId: 'micro-inherited-target', name: 'Target', message: [] };
  target.messages = target.message;
  f.character.chats.push(target); f.character.chatPage = 1;
  const host = f.r.context.risuai;
  host.getCurrentChatIndex = async () => 1;
  host.getChatFromIndex = async (_char, index) => f.character.chats[index];
  host.getChat = async () => target; host.getCurrentChat = async () => target;
  assert.equal((await portable.importAsPredecessorArchive(envelope)).ok, true);
  const prepared = await prepareClassic(f,withTwo
    ? '도서관의 정숙 규칙과 오늘 열쇠를 돌려주겠다는 약속을 참고해 이어줘.' : REQUEST);
  const micro = Object.values(prepared.evidencePacket.layers).flat().filter(row => row.kind === 'micro');
  assert(micro.some(row => row.inheritedSessionHistory === true));
  const archives = f.getRecords('libra.micro_handoff_archive.v1');
  assert.equal(archives.length, 1);
  return { prepared, micro, archive: archives[0] };
}
async function prepareStateOnlyMicro(f) {
  f.chat.message = f.originalFixtureMessages; f.chat.messages = f.chat.message;
  f.control.onCall = async () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
  assert.equal((await f.run()).completed, 1);
  f.chat.message.push({ role: 'user', chatId: 't6-u', data: '도서관 정문을 확인한다.' },
    { role: 'assistant', chatId: 't6-a', data: '도서관 정문이 열렸다.' });
  const quote = '도서관 정문이 열렸다';
  f.control.onCall = async args => {
    const input = JSON.parse(args[0].messages[1].content);
    const startOffset = input.assistant.text.indexOf(quote);
    assert(startOffset >= 0);
    return { type: 'success', result: JSON.stringify({
      schema: 'libra.micro_producer_envelope.v1', personCandidates: { spans: [], relations: [] },
      micro: { schema: 'libra.micro_memory.v1', ...input.binding, claims: [{
        changeKind: 'world', text: `${quote}.`, actor: '', target: '도서관', temporalRole: 'current',
        certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
        stateIntent: { domain: 'world', target: { entityName: '도서관' }, field: 'doorStatus', operation: 'set', value: '열렸다' },
        evidence: { role: 'assistant', messageId: input.assistant.messageId, startOffset,
          endOffset: startOffset + quote.length, exactQuote: quote }
      }] }
    }) };
  };
  f.captureOutput({ char: f.character, chat: f.chat, characterIndex: 0, chatIndex: 0, messageIndex: 11 });
  await waitFor(() => f.r.api.getCaptureBackendState().lastMicroPublication?.turn === 6
    && f.r.api.getCaptureBackendState().lastMicroPublication?.stateAdmission?.admitted >= 1, 15000);
  const active = await f.r.api.debugReadActiveMicroMemory(6);
  assert.equal(active.status, 'verified');
  const storage = f.r.context.risuai.pluginStorage, originalKeys = storage.keys;
  // A partial host catalog can omit recall rows while direct state reads still
  // succeed. Do not replace or stub the product recall/state engines.
  storage.keys = async () => (await originalKeys()).filter(key => !String(key).includes(':micro-memory-head:'));
  let prepared;
  try { prepared = await prepareReadOnlyState(f,'도서관 정문 상태를 반영해서 이어줘.'); }
  finally { storage.keys = originalKeys; }
  const rawMicro = Object.values(prepared.evidencePacket.layers).flat().filter(row => row.kind === 'micro');
  assert.equal(rawMicro.length, 0, 'the raw Micro is actually absent from selected recall layers');
  const library = prepared.evidencePacket.continuity_state.world.find(row => row.name === '도서관');
  assert.equal(library.state.doorStatus, '열렸다', 'the real Micro-derived state is actually supplied');
  assert.match(prepared.evidencePacket.continuity_state_prompt, /열렸다/);
  f.control.onCall = async () => {throw Error('RETIRED_HELPER_PROVIDER_SUBMISSION');};
  return { prepared, active, decisionKey: library.fieldEvidence.doorStatus.decisionKey };
}
test('inherited consumed Micro context rejects deletion of its physical archive',()=>withMicro(async f=>{
 const {prepared,archive}=await prepareInherited(f);f.r.values.delete(archive.key);await invalid(f,prepared.context,/MICRO.*ARCHIVE/);
}));
test('two inherited consumed Micro identities retain separate proofs and one physical archive read',()=>withMicro(async f=>{
 const {prepared,micro,archive}=await prepareInherited(f,true),used=[...new Set(micro.map(row=>row.analysisRevisionId))];assert.equal(used.length,2);
 const probe=f.r.api.retirementConsumedProbe(prepared.context.consumedDataToken);assert.equal(probe.count,2);
 const storage=f.r.context.risuai.pluginStorage,get=storage.getItem;let reads=0;storage.getItem=async key=>{if(key===archive.key)reads++;return get(key);};
 try{await probe.verify();}finally{storage.getItem=get;}assert.equal(reads,1);
 const changed=JSON.parse(f.r.values.get(archive.key)),first=changed.records.find(row=>row.value.schema==='libra.micro_memory.v1'&&row.value.analysisRevisionId===used[0]);assert(first);first.value.claims[0].text='changed physical archived claim';f.r.values.set(archive.key,JSON.stringify(changed));await assert.rejects(probe.verify(),/MICRO.*ARCHIVE/);
}));
test('removed inherited lineage rejects a consumed archive whose physical bytes still exist',()=>withMicro(async f=>{
 const {prepared,archive}=await prepareInherited(f,true),manifest=f.getRecords('libra.manifest.v1').find(row=>row.value.scopeKey===prepared.scope.scopeKey);assert(manifest.value.inheritedMicroArchives.some(ref=>ref.archiveKey===archive.key));manifest.value.inheritedMicroArchives=manifest.value.inheritedMicroArchives.filter(ref=>ref.archiveKey!==archive.key);f.r.values.set(manifest.key,JSON.stringify(manifest.value));assert(f.r.values.has(archive.key));await assert.rejects(f.r.api.retirementConsumedProbe(prepared.context.consumedDataToken).verify(),/CONSUMER_MICRO_ARCHIVE_UNBOUND/);
}));
test('state-only Micro mutation rejects currentness even when no raw Micro recall row was selected',()=>withMicro(async f=>{
 const {prepared,active}=await prepareStateOnlyMicro(f),changed=JSON.parse(f.r.values.get(active.recordKey));changed.claims[0].text='same-ID state-only tamper';f.r.values.set(active.recordKey,JSON.stringify(changed));await invalid(f,prepared.context,/CONSUMER_MICRO_BODY_CHANGED/);
}));
test('state-only consumed admission deletion rejects the captured Classic context',()=>withMicro(async f=>{
 const {prepared,decisionKey}=await prepareStateOnlyMicro(f);assert(decisionKey&&f.r.values.has(decisionKey));f.r.values.delete(decisionKey);await invalid(f,prepared.context,/CONSUMER_MICRO_STATE_DEPENDENCY_CHANGED/);
}));
test('unreferenced admission mutation preserves physically unchanged consumed state',()=>withMicro(async f=>{
 const {prepared,decisionKey}=await prepareStateOnlyMicro(f),unused=decisionKey+':unreferenced';f.r.values.set(unused,f.r.values.get(decisionKey));f.r.values.delete(unused);assert(f.r.values.has(decisionKey));assert.equal((await f.r.api.validateResponseContext(prepared.context)).current,true);
}));
test('inherited consumed state admission is rechecked after capture',()=>withMicro(async f=>{
 await prepareStateOnlyMicro(f);const envelope=await f.r.context.__LIBRAPortableMemoryBackup.exportCurrentScope(),target={id:'retained-state-inherited-target',chatId:'retained-state-inherited-target',message:[]};target.messages=target.message;f.character.chats.push(target);f.character.chatPage=1;
 const host=f.r.context.risuai;host.getCurrentChatIndex=async()=>1;host.getChatFromIndex=async(_c,index)=>f.character.chats[index];host.getChat=async()=>target;host.getCurrentChat=async()=>target;
 assert.equal((await f.r.context.__LIBRAPortableMemoryBackup.importAsPredecessorArchive(envelope)).ok,true);
 const prepared=await prepareReadOnlyState(f,'retained inherited current state'),library=prepared.evidencePacket.continuity_state.world.find(row=>row.state?.doorStatus),evidence=library?.fieldEvidence?.doorStatus;assert(evidence?.archiveKey);assert(evidence.decisionKey&&f.r.values.has(evidence.decisionKey));
 const changed=JSON.parse(f.r.values.get(evidence.decisionKey));changed.status='superseded';f.r.values.set(evidence.decisionKey,JSON.stringify(changed));await invalid(f,prepared.context,/CONSUMER_MICRO_STATE_DEPENDENCY_CHANGED/);
}));
