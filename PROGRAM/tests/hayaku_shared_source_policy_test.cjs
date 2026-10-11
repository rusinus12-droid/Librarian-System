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
    assert.ok(before.sourceDigest);
    const beforeRows=t.hayakuReviewRows(initial.scope,initial.snapshot.conversationPairs[0]);
    assert.match(beforeRows[0].userText,/Alice signed the agreement/);

    await t.getHayakuSourceInput().setSourceRules(sourceRules);
    const afterPolicy=(await digestPair(runtime)).source.units[0];
    assert.notEqual(afterPolicy.sourceDigest,before.sourceDigest,'the selected source projection changes when the source-tag rule is saved');
    const priorEvidenceBytes=runtime.pluginStorage.values.get(initialLedger.records[0].sourceEvidenceRef.key);
    assert.ok(priorEvidenceBytes);
    assert.equal(JSON.parse(priorEvidenceBytes).rows[0].userRaw,runtime.chat.message[0].data,'prior complete U+A stays exact');
    const afterRows=(await digestPair(runtime));
    const selected=t.hayakuReviewRows(afterRows.scope,afterRows.snapshot.conversationPairs[0])[0];
    assert.doesNotMatch(selected.userText,/Translation:/,'the source-tag rule actually excludes text outside its wrapper');

    runtime.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope(OLD))}));
    await runtime.callBeforeRequest([{role:'user',content:'Continue.'}],'model');await runtime.callAfterRequest('');
    assert.equal(runtime.llmCalls.length,0,'projection edits never implicitly invoke reanalysis');
    const ticket=await runtime.hayaku.previewSourceEdits(['1']);assert.equal(ticket.allowed,true,JSON.stringify(ticket));
    const rebuilt=await runtime.hayaku.applySourceEdits(ticket);assert.equal(rebuilt.ok,true,JSON.stringify(rebuilt));assert.equal(runtime.llmCalls.length,1);
    assert.equal(runtime.pluginStorage.values.get(initialLedger.records[0].sourceEvidenceRef.key),priorEvidenceBytes);

    runtime.chat.message[0].data='<original>'+OLD+'</original>\nTranslation: unrelated translated wording.';
    const outside=(await digestPair(runtime)).source.units[0];
    assert.equal(outside.sourceDigest,afterPolicy.sourceDigest,'outside edits are ignored by the active source selection');
    const outsideRows=await digestPair(runtime);
    assert.notEqual(t.hayakuReviewRows(outsideRows.scope,outsideRows.snapshot.conversationPairs[0])[0].userRaw,JSON.parse(priorEvidenceBytes).rows[0].userRaw,'raw capture still observes excluded text');
    await runtime.callBeforeRequest([{role:'user',content:'Continue.'}],'model');await runtime.callAfterRequest('');
    assert.equal(runtime.llmCalls.length,1,'a source change outside the wrapper makes no model call');

    runtime.chat.message[0].data='<original>Alice did not sign the agreement.</original>\nTranslation: unrelated translated wording.';
    const inside=(await digestPair(runtime)).source.units[0];
    assert.notEqual(inside.sourceDigest,outside.sourceDigest,'edits inside the selected wrapper change the canonical source');

    runtime.setLlmResponder(async()=>({type:'success',result:JSON.stringify(envelope('Alice did not sign the agreement.'))}));
    await runtime.callBeforeRequest([{role:'user',content:'Continue.'}],'model');await runtime.callAfterRequest('');
    assert.equal(runtime.llmCalls.length,1,'inside edits require explicit reanalysis too');
    const next=await runtime.hayaku.previewSourceEdits(['1']);assert.equal(next.allowed,true,JSON.stringify(next));
    const applied=await runtime.hayaku.applySourceEdits(next);assert.equal(applied.ok,true,JSON.stringify(applied));assert.equal(runtime.llmCalls.length,2);
    console.log(JSON.stringify({test:'hayaku_shared_source_policy',passed:11}));
  }finally{await runtime.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
