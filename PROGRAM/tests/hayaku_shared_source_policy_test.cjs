'use strict';
const assert=require('node:assert/strict');
const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');

const OLD='Alice signed the agreement.';
const packet=createValidPacket({turn:1,subject:'Alice',scene:'office',summary:OLD});
const sourceRules={version:1,sourceTags:[{open:'<original>',close:'</original>'}],ignoredTags:[],unwrapTags:[],controls:[]};
function envelope(summary){const p=createValidPacket({turn:1,subject:'Alice',scene:'office',summary});p.entity.characters=[{name:'Alice'}];p.planner.continuity_locks=[summary];const grounding=[];const walk=(v,path)=>{if(Array.isArray(v)){v.forEach((x,i)=>{if(x!=null&&(typeof x!=='string'||x.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[summary]})});return;}if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k);};for(const name of ['entity','world','narrative','planner'])walk(p[name],name);grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[summary]});return{schema:'hayaku.native_repair_output.v1',packet:p,grounding};}
const digestPair=async(runtime)=>{
  const t=runtime.hayaku._test,scope=await t.currentChatScope(),snapshot=t.authoritativeChatSnapshot(scope.chatMessages,scope);
  return {scope,snapshot,source:await t.hayakuSourceEditSnapshot(scope,snapshot)};
};

(async()=>{
  const runtime=await createHayakuRuntime({autoRepair:false,messages:[
    {role:'user',id:'u1',chatId:'u1',data:'<original>'+OLD+'</original>\nTranslation: Alice signed the agreement.'},
    {role:'assistant',id:'a1',chatId:'a1',data:hiddenPacketMessage(OLD,packet)}
  ]});
  try{
    const t=runtime.hayaku._test,initial=await digestPair(runtime);
    await t.reconcileObservedChatTopology(initial.scope,initial.snapshot,'policy_test_initial');
    const initialLedger=await runtime.hayaku.ledger.inspect({includeRecords:true});
    assert.ok(initialLedger.records[0]?.sourceEvidenceRef,'current owner record has validated raw source evidence');
    assert.ok(initialLedger.records[0]?.sourceRawDigest,'raw digest was persisted with that evidence');
    const before=(await digestPair(runtime)).source.units[0];
    assert.ok(before.rawDigest);assert.equal(initialLedger.records[0].sourceRawDigest,before.rawDigest);
    const beforeRows=t.hayakuReviewRows(initial.scope,initial.snapshot.conversationPairs[0]);
    assert.match(beforeRows[0].userText,/Alice signed the agreement/);

    await t.getHayakuSourceEdits().setSourceRules(sourceRules);
    const afterPolicy=(await digestPair(runtime)).source.units[0];
    assert.notEqual(afterPolicy.sourceDigest,before.sourceDigest,'the selected source projection changes when the source-tag rule is saved');
    assert.equal(afterPolicy.rawDigest,before.rawDigest,'a policy edit leaves the unprojected chat hash unchanged');
    assert.equal(afterPolicy.originalRawDigest,before.rawDigest,'the prior complete U+A evidence verifies raw identity');
    assert.equal(afterPolicy.policyUncertain,false);
    const afterRows=(await digestPair(runtime));
    const selected=t.hayakuReviewRows(afterRows.scope,afterRows.snapshot.conversationPairs[0])[0];
    assert.doesNotMatch(selected.userText,/Translation:/,'the source-tag rule actually excludes text outside its wrapper');

    runtime.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(OLD))}));
    await t.handleBeforeRequest([{role:'user',content:'Continue.'}],'model');t.getHayakuSourceEdits().afterRequest();
    assert.equal(runtime.llmCalls.length,1,'the new canonical projection is rebuilt automatically');
    assert.equal(runtime.hayaku.getSourceEditSyncStatus().tasks[0].state,'applied');

    runtime.chat.message[0].data='<original>'+OLD+'</original>\nTranslation: unrelated translated wording.';
    const outside=(await digestPair(runtime)).source.units[0];
    assert.equal(outside.sourceDigest,afterPolicy.sourceDigest,'outside edits are ignored by the active source selection');
    assert.equal(outside.changed,false);
    assert.notEqual(outside.rawDigest,afterPolicy.rawDigest,'raw tracking still observes excluded text without treating it as a source edit');
    await t.handleBeforeRequest([{role:'user',content:'Continue.'}],'model');t.getHayakuSourceEdits().afterRequest();
    assert.equal(runtime.llmCalls.length,1,'a source change outside the wrapper makes no model call');

    runtime.chat.message[0].data='<original>Alice did not sign the agreement.</original>\nTranslation: unrelated translated wording.';
    const inside=(await digestPair(runtime)).source.units[0];
    assert.notEqual(inside.sourceDigest,outside.sourceDigest,'edits inside the selected wrapper change the canonical source');
    assert.equal(inside.changed,true);
    runtime.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope('Alice did not sign the agreement.'))}));
    await t.handleBeforeRequest([{role:'user',content:'Continue.'}],'model');
    assert.equal(runtime.llmCalls.length,2,'an edit inside the selected source is automatically analyzed');
    assert.equal(runtime.hayaku.getSourceEditSyncStatus().tasks.at(-1).state,'applied');
    console.log(JSON.stringify({test:'hayaku_shared_source_policy',passed:11}));
  }finally{await runtime.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
