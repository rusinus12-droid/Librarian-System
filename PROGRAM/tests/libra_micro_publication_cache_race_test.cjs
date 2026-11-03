'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const quote='민아가 은빛 열쇠를 준호에게 잠시 건넸다.';
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
