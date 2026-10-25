'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
async function setup({twoBatches=false}={}){
  const f=await fixture({transformSource:source=>source.replace('const memoryStageEnabledForSettings =','globalThis.__sharedReanalysisCore=LibraMemoryCore;\n  const memoryStageEnabledForSettings =')});
  if(twoBatches){
    f.chat.message.push(...f.chat.message.slice().map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`})));
    f.control.onCall=async args=>{const value=artifact();if(JSON.stringify(args).includes('[t6-u]'))for(const row of [...value.entities,...value.facts])for(const span of row.evidenceSpans)span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>'t'+(+n+5));return {type:'success',result:JSON.stringify(value)};};
  }
  assert.equal((await f.run()).completed,twoBatches?2:1);await f.r.api.retryPendingUnifiedVectors();
  f.core=f.r.context.__sharedReanalysisCore;return f;
}
const select=(inventory,keys)=>({...inventory,ranges:inventory.ranges.filter(row=>keys.includes(row.key))});
async function reviewed(f){
  const inventory=await f.r.api.listReanalysisRanges(),range=inventory.ranges[0],sample=await f.core.readReanalysisTurn(inventory,range);
  return {...select(inventory,[range.key]),reviewedSource:{key:range.key,rawDigest:sample.rawDigest,rulesKey:f.core.sourceReanalysisRulesKey()}};
}
test('LIBRA lists stored turns with source inspection and keeps incomplete turns out of reanalysis',async()=>{
  const f=await setup();try{
    f.chat.message.push({role:'user',chatId:'pending-u',data:'Next question'},{role:'assistant',chatId:'pending-a',data:'Next answer'});
    const calls=f.control.calls.length,inventory=await f.r.api.listReanalysisRanges();
    assert.equal(inventory.ranges.length,5);assert.equal(inventory.pendingTurns,1);assert.ok(inventory.ranges.every(row=>row.batchStart===1&&row.batchEnd===5&&row.summary));
    const sample=await f.core.readReanalysisTurn(inventory,inventory.ranges[0]);assert.equal(sample.user,f.chat.message[0].data);assert.equal(sample.assistant,f.chat.message[1].data);assert.equal(f.control.calls.length,calls);
  }finally{await f.r.cleanup();}
});
test('several selected LIBRA turns in one batch trigger one 5-turn replacement',async()=>{
  const f=await setup();try{
    const old={...f.getManifest().memories['1']},bytes=f.r.values.get(old.key),calls=f.control.calls.length,inventory=await f.r.api.listReanalysisRanges();
    f.chat.message[0].data+=' Edited after opening.';
    const result=await f.r.api.reanalyzeSelectedRanges(select(inventory,['1','2','5']));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+1);assert.ok(f.getManifest().memories['1'].revision>old.revision);assert.equal(f.r.values.get(old.key),bytes);
  }finally{await f.r.cleanup();}
});
test('selected turns across two saved LIBRA batches replace each batch once',async()=>{
  const f=await setup({twoBatches:true});try{
    const calls=f.control.calls.length,inventory=await f.r.api.listReanalysisRanges(),old={...f.getManifest().memories['6']};
    const result=await f.r.api.reanalyzeSelectedRanges(select(inventory,['1','3','6','8']));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+2);assert.ok(f.getManifest().memories['6'].revision>old.revision);
  }finally{await f.r.cleanup();}
});
test('LIBRA accepts a reviewed single turn after saving future exclusion tags',async()=>{
  const f=await setup();try{
    f.chat.message[1].data+='<drop>Private module output.</drop>';
    const before=await f.r.api.listReanalysisRanges(),sample=await f.core.readReanalysisTurn(before,before.ranges[0]);
    await f.r.api.setSourceEditRules({version:1,ignoredTags:['drop'],unwrapTags:[],sourceTags:[],controls:[]});
    const fresh=await f.r.api.listReanalysisRanges(),calls=f.control.calls.length;
    const result=await f.r.api.reanalyzeSelectedRanges({...select(fresh,['1']),reviewedSource:{key:'1',rawDigest:sample.rawDigest,rulesKey:f.core.sourceReanalysisRulesKey()}});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+1);
    assert.equal(f.r.api.getSourceEditRules().ignoredTags.includes('drop'),true);assert.ok(f.chat.message[1].data.includes('Private module output.'));
  }finally{await f.r.cleanup();}
});
for(const change of ['selected_text','sibling_text','excluded_text','trailing_carrier','identity','rules'])test('LIBRA reviewed selection rejects '+change+' before invoking the model',async()=>{
  const f=await setup();try{
    f.chat.message[1].data+='<drop>Module output.</drop>';await f.r.api.setSourceEditRules({version:1,ignoredTags:['drop'],unwrapTags:[],sourceTags:[],controls:[]});
    const request=await reviewed(f),old={...f.getManifest().memories['1']},calls=f.control.calls.length;
    if(change==='selected_text')f.chat.message[1].data+=' Selected text changed.';
    if(change==='sibling_text')f.chat.message[5].data+=' Another turn changed.';
    if(change==='excluded_text')f.chat.message[1].data=f.chat.message[1].data.replace('Module output.','Different module output.');
    if(change==='trailing_carrier')f.chat.message.push({role:'assistant',chatId:'late-carrier',data:'<lb-xnai>{{inlay::new-image}}</lb-xnai>'});
    if(change==='identity')f.chat.message[1].chatId='other-message';
    if(change==='rules')await f.r.api.setSourceEditRules({version:1,ignoredTags:['other'],unwrapTags:[],sourceTags:[],controls:[]});
    const result=await f.r.api.reanalyzeSelectedRanges(request);assert.equal(result.ok,false);assert.equal(f.control.calls.length,calls);assert.equal(f.getManifest().memories['1'].key,old.key);
  }finally{await f.r.cleanup();}
});
test('reviewed raw mutation during LIBRA generation preserves the old canonical body',async()=>{
  const f=await setup();try{
    const request=await reviewed(f),old={...f.getManifest().memories['1']},bytes=f.r.values.get(old.key);
    f.control.onCall=()=>{f.chat.message[5].data+='<lb-xnai>{{inlay::late-image}}</lb-xnai>';return {type:'success',result:JSON.stringify(f.control.artifact)};};
    const result=await f.r.api.reanalyzeSelectedRanges(request);assert.equal(result.ok,false);assert.equal(f.getManifest().memories['1'].key,old.key);assert.equal(f.r.values.get(old.key),bytes);
  }finally{await f.r.cleanup();}
});
