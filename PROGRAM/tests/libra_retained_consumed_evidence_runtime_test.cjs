'use strict';
// Shared physical-consumption contracts migrated from retired Writer/Planner
// surfaces to the actual Classic hook and retained sealed response context.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const expose=source=>{
 const anchor='      getUnifiedStorageStatus,';assert(source.includes(anchor));
 return source.replace(anchor,`      retirementConsumedProbe: token => ({graph:typeof consumedDataReadSets.get(token)?.graphVerifier==='function',receipts:consumedDataReadSets.get(token)?.receiptReadSet?.refs?.length||0,verify:options=>assertConsumedDataCurrent(token,options)}),
      retirementResealContext: value => {value.contextDigest=digest(unifiedResponseContextBody(value));return value;},
      `+anchor).replace('    async getUnifiedStorageStatus() {',`    retirementConsumedProbe: token => LibraMemoryCore.retirementConsumedProbe(token),
    retirementResealContext: value => LibraMemoryCore.retirementResealContext(value),
    async getUnifiedStorageStatus() {`);
};
async function withMicro(run){
 let listener;const f=await fixture({transformSource:expose,host:{addRisuChatListener:async(_kind,handler)=>{listener=handler;return true;},nativeFetch:async()=>{throw Error('offline_test_network_forbidden');}}});
 try{
  f.originalMessages=f.chat.message.slice();f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
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
  assert(context?.consumedDataToken);const proof=f.r.api.retirementConsumedProbe(context.consumedDataToken);assert(proof.graph,'private graph packet verifier is retained for the consumed context');assert(proof.receipts>0,'receipt read set is retained for the consumed context');
  assert.equal((await f.r.api.validateResponseContext(context)).current,true);
  await run(f,active,context,proof);
  assert.equal(f.control.calls.length,calls,'validation never starts a retired helper retry');
 }finally{await f.r.cleanup();}
}
const invalid=async(f,context,pattern)=>{const checked=await f.r.api.validateResponseContext(context);assert.equal(checked.current,false);if(pattern)assert.match(checked.reason,pattern);return checked;};
test('unchanged cloned Classic consumed context remains physically current',()=>withMicro(async(f,_a,c)=>{assert.equal((await f.r.api.validateResponseContext(structuredClone(c))).current,true);}));
test('deleting consumed Micro head rejects its already captured Classic context',()=>withMicro(async(f,a,c)=>{f.r.values.delete(a.headKey);await invalid(f,c,/GRAPH_CORPUS_SOURCE_CHANGED/);}));
test('same analysis ID Micro body mutation rejects captured Classic evidence',()=>withMicro(async(f,a,c)=>{const v=JSON.parse(f.r.values.get(a.recordKey));v.claims[0].text='tampered same ID';f.r.values.set(a.recordKey,JSON.stringify(v));await invalid(f,c,/GRAPH_CORPUS_SOURCE_CHANGED/);}));
test('restoring exact consumed bytes restores currentness after rejected physical corruption',()=>withMicro(async(f,a,c)=>{const raw=f.r.values.get(a.recordKey),v=JSON.parse(raw);v.claims[0].text='corrupt';f.r.values.set(a.recordKey,JSON.stringify(v));await invalid(f,c);f.r.values.set(a.recordKey,raw);assert.equal((await f.r.api.validateResponseContext(c)).current,true);}));
test('unrelated unused Micro key does not invalidate consumed context',()=>withMicro(async(f,_a,c)=>{f.r.values.set('unrelated:unused-micro',JSON.stringify({analysisRevisionId:'irrelevant'}));assert.equal((await f.r.api.validateResponseContext(c)).current,true);}));
test('missing token cannot be replaced by caller verified flag and resealed digest',()=>withMicro(async(f,_a,c)=>{const copy=structuredClone(c);copy.consumedDataToken='';copy.verified=true;f.r.api.retirementResealContext(copy);await invalid(f,copy,/READSET_UNAVAILABLE/);}));
test('public layer edits cannot erase private physical consumption provenance',()=>withMicro(async(f,a,c)=>{const copy=structuredClone(c);copy.values.canonicalLayers={memory:[],entity:[],world:[],narrative:[]};copy.verified=true;f.r.api.retirementResealContext(copy);f.r.values.delete(a.headKey);await invalid(f,copy,/BINDING_CHANGED|MICRO/);}));
test('foreign same-scope token with recomputed public digest is rejected',()=>withMicro(async(f,_a,c)=>{const foreign=await f.r.api.getResponseContext({currentInput:'different captured packet'}),copy=structuredClone(c);assert.notEqual(foreign.consumedDataToken,c.consumedDataToken);copy.consumedDataToken=foreign.consumedDataToken;f.r.api.retirementResealContext(copy);await invalid(f,copy,/BINDING_CHANGED/);}));
test('consumed proof rechecks a mutation made after an awaited storage read',()=>withMicro(async(f,a,c)=>{const storage=f.r.context.risuai.pluginStorage,get=storage.getItem;let mutated=false;storage.getItem=async key=>{const result=await get(key);if(key===a.headKey&&!mutated){mutated=true;const v=JSON.parse(f.r.values.get(a.recordKey));v.claims[0].text='changed across awaited read';f.r.values.set(a.recordKey,JSON.stringify(v));}return result;};try{await invalid(f,c,/GRAPH_CORPUS_SOURCE_CHANGED/);assert(mutated,'fault reached actual physical validation');}finally{storage.getItem=get;}}));
test('stalled consumed physical read has a bounded rejection and no provider retry',()=>withMicro(async(f,a,c)=>{const storage=f.r.context.risuai.pluginStorage,get=storage.getItem;let reached=false;storage.getItem=async key=>{if(key===a.recordKey){reached=true;return new Promise(()=>{});}return get(key);};const start=performance.now();try{await invalid(f,c,/REVALIDATION_DEADLINE/);assert(reached);assert(performance.now()-start<3500);}finally{storage.getItem=get;}}));
test('past captured deadline rejects retained consumption without a model call',()=>withMicro(async(_f,_a,_c,p)=>{await assert.rejects(p.verify({deadlineAt:Date.now()-1}),/REVALIDATION_DEADLINE/);}));
test('currentness rejects an actual chat scope switch after capture',()=>withMicro(async(f,_a,c)=>{const next={message:f.chat.message,id:'retained-next-chat',chatId:'retained-next-chat'};f.character.chats.push(next);f.character.chatPage=1;f.r.context.risuai.getCurrentChatIndex=async()=>1;f.r.context.risuai.getChatFromIndex=async()=>next;f.r.context.risuai.getChat=async()=>next;f.r.context.risuai.getCurrentChat=async()=>next;await invalid(f,c,/SCOPE_CHANGED|AUTHORITY_CHANGED/);}));
test('same-scope logical worldline switch invalidates retained context',()=>withMicro(async(f,_a,c)=>{const changed=await f.r.api.setWorldManagerWorldline({worldlineId:'retained-evidence-fork',parentId:'main'});assert.equal(changed.ok,true);await invalid(f,c,/AUTHORITY_CHANGED|WORLDLINE_CHANGED/);}));
test('an unconsumed author note does not invalidate memory-only Classic evidence',()=>withMicro(async(f,_a,c)=>{assert.equal(c.values.authorNote,null);f.chat.note='unconsumed author note';assert.equal((await f.r.api.validateResponseContext(c)).current,true);}));
