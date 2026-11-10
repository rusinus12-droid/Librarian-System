'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const quote='민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
const retryFixture=implementation=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
 const region=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i);return source.slice(i,j);};
 const stats={opened:0,closed:0,providerCalls:0,attempts:0,publishOnly:0};
 const context={state:{disposed:false},nativeReadFrames:new WeakMap(),nativeReadBudgets:new WeakMap(),setTimeout,
  openBackgroundReadFrame:async()=>{stats.opened++;return {assertCurrent:async()=>{},close(){stats.closed++;}};},
  produceMicroForTurnImpl:async(scope,w,e,t,r,options)=>implementation(options,stats),
 };
 vm.createContext(context);
 vm.runInContext(region('    const withBackgroundReadJob =','    const closeBackgroundReadFramesForWrite =')+
  region('    const produceMicroForTurn=','    const memoryReviewKey=')+'\nglobalThis.run=()=>produceMicroForTurn({scopeKey:"test"},"main",0,1,"revision");',context);
 return {stats,run:context.run};
};
test('an unpaid torn Micro preparation retries with a fresh frame and publishes once',async()=>{
 const f=retryFixture(async(options,s)=>{if(++s.attempts===1)throw Error('LIBRA_GRAPH_READER_BODY_CHANGED');options.onInvocationPrepared();s.providerCalls++;return {status:'verified'};});
 assert.equal((await f.run()).status,'verified');assert.equal(f.stats.attempts,2);assert.equal(f.stats.providerCalls,1);
 assert.equal(f.stats.opened,f.stats.closed);
});
test('a torn Micro after dispatch resumes only a durable publication without another model call',async()=>{
 const f=retryFixture(async(options,s)=>{s.attempts++;if(options.publishOnly){s.publishOnly++;return {status:'verified'};}options.onInvocationPrepared();s.providerCalls++;throw Error('LIBRA_GRAPH_READER_BODY_CHANGED');});
 assert.equal((await f.run()).status,'verified');assert.equal(f.stats.providerCalls,1);assert.equal(f.stats.publishOnly,1);
 assert.equal(f.stats.opened,f.stats.closed);
});
test('an unpersisted paid Micro result stays pending and does not spend another provider attempt',async()=>{
 const f=retryFixture(async(options,s)=>{if(options.publishOnly)return {status:'unknown',reason:'publish_result_not_ready'};options.onInvocationPrepared();s.providerCalls++;throw Error('LIBRA_GRAPH_READER_BODY_CHANGED');});
 const result=await f.run();assert.equal(result.status,'pending_reconciliation');assert.equal(result.reason,'micro_result_not_durably_ready');
 assert.equal(f.stats.providerCalls,1);assert.equal(f.stats.opened,f.stats.closed);
});
test('Micro identity corruption is never converted into a retry',async()=>{
 const f=retryFixture(async()=>{throw Error('LIBRA_MICRO_WORK_BINDING_INVALID');});
 await assert.rejects(f.run,/MICRO_WORK_BINDING_INVALID/);assert.equal(f.stats.opened,1);assert.equal(f.stats.closed,1);
});
for(const mode of ['server_only','mirror'])test(`${mode}: a torn unpaid preparation recovers through the real Micro producer with one provider call`,async t=>{
 let listener;
 const s=await serverFixture({mode,host:{addRisuChatListener:async(_kind,fn)=>{listener=fn;return true;}},transformSource:source=>source.replace(
  "const produceMicroForTurnImpl = async (scope, worldlineId, sessionEpoch, turn, expectedRevisionId = '', options={}) => {",
  "const produceMicroForTurnImpl = async (scope, worldlineId, sessionEpoch, turn, expectedRevisionId = '', options={}) => { if (globalThis.__tearMicroPreparation) { globalThis.__tearMicroPreparation=false; throw new Error('LIBRA_GRAPH_READER_BODY_CHANGED'); }")});
 t.after(()=>s.cleanup());const f=s.f;assert.equal((await f.run()).completed,1);
 f.r.context.__tearMicroPreparation=true;
 f.chat.message.push({role:'user',chatId:'t6-u',data:'열쇠는 누가 보관하지?'},{role:'assistant',chatId:'t6-a',data:quote});f.chat.messages=f.chat.message;
 let calls=0;
 f.control.onCall=async args=>{
  calls++;const input=JSON.parse(args[0].messages[1].content);
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
   micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'world',text:quote,actor:'민아',target:'은빛 열쇠',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
    evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
 };
 listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:f.chat.message.length-1});
 await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===6
  &&f.r.api.getCaptureBackendState().lastMicroPublication.status==='verified',30000);
 assert.equal(calls,1,'fresh preparation never doubles the paid analysis');
 assert.equal((await f.r.api.readActiveMicroMemoryForTurn(6)).status,'verified');
 const auto=f.r.api.debugRuntimeForDisplay().autoDurableIndex;
 assert.ok(auto?.scheduled||auto?.running||auto?.lastResult,'Micro publication also schedules the persistent index');
});

for(const mode of ['server_only','mirror'])test(`${mode}: source ABA at Micro commit cannot publish the cached candidate or Head`,async t=>{
 let listener;
 const s=await serverFixture({mode,host:{addRisuChatListener:async(_kind,fn)=>{listener=fn;return true;}},transformSource:source=>source
  .replace('    const persistMicroRevision = async','    const persistMicroRevisionImplementation = async')
  .replace('    const prepareMicroStageClaim =',`    const persistMicroRevision = async (...args) => {
      const out = await persistMicroRevisionImplementation(...args);
      (globalThis.__microPublishResults ||= []).push(out); return out;
    };
    const prepareMicroStageClaim =`)});
 t.after(()=>s.cleanup());const f=s.f;assert.equal((await f.run()).completed,1);
 f.r.context.__microPublishResults=[];
 let injected=false,recordKey,headKey;
 s.hooks.beforeBatch=async batch=>{
  const target=batch.mutations.find(m=>m.key.includes(':micro-memory-head:'));
  if(!target||injected)return;injected=true;headKey=target.key;
  recordKey=batch.mutations.find(m=>m.key.includes(':micro-memory:')).key;
  const source=batch.conditions.find(m=>m.key.includes(':source-receipt-head:'));assert.ok(source,'source revision must be a commit predicate');
  const row=s.storedRows().find(r=>r.key===source.key);assert.ok(row);
  // Restore the exact same value under a newer revision, after preparation.
  await s.mutate(row.key,{...row.value,externalABA:true});await s.mutate(row.key,row.value);
 };
 f.chat.message.push({role:'user',chatId:'t6-u',data:'열쇠는 누가 보관하지?'},{role:'assistant',chatId:'t6-a',data:quote});f.chat.messages=f.chat.message;
 f.control.onCall=async args=>{
  const input=JSON.parse(args[0].messages[1].content);
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},
   micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'world',text:quote,actor:'민아',target:'은빛 열쇠',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',
    evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
 };
 listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:f.chat.message.length-1});
 await waitFor(()=>f.r.context.__microPublishResults.length,30000);
 assert.ok(injected,'actual producer reached the atomic Micro publication');
 const out=f.r.context.__microPublishResults.at(-1);assert.equal(out.status,'stale_source');assert.equal(out.reason,'micro_publication_basis_changed');
 assert.ok(!s.storedRows().some(r=>r.key===headKey||r.key===recordKey),'rejected candidate and Head are both absent in SQLite');
 const restarted=await s.restart();assert.ok(restarted);assert.ok(!s.storedRows().some(r=>r.key===headKey||r.key===recordKey),'new bridge sees no partial publication');
});
