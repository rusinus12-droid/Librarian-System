'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const {microReply,lensReply,transformSource,select,createLens}=require('./fixtures/libra_reanalysis_kinds_fixture.cjs');
async function setup(turns=5){
  const f=await fixture({transformSource});f.chat.message.splice(turns*2);f.core=f.r.context.__reanalysisKindsCore;
  return f;
}
test('three inventories retain canonical five-turn boundaries and expose pre-canonical single-turn Micro',async()=>{
  const f=await setup(3);try{
    const valuesBefore=plain([...f.r.values]),calls=f.control.calls.length;
    assert.equal((await f.r.api.listReanalysisRanges()).ranges.length,0);
    const micro=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal(micro.kind,'micro');assert.equal(micro.ranges.length,3);assert.ok(micro.ranges.every(row=>row.start===row.end));
    const lens=await f.r.api.listReanalysisRanges({kind:'lens'});assert.equal(lens.lenses.length,0);assert.equal(lens.ranges.length,0);
    const sample=await f.core.readReanalysisTurn(micro,micro.ranges[1]);assert.equal(sample.user,f.chat.message[2].data);assert.equal(sample.assistant,f.chat.message[3].data);
    assert.equal(f.control.calls.length,calls);assert.deepEqual(plain([...f.r.values]),valuesBefore,'inventories and source inspection are read-only');
  }finally{await f.r.cleanup();}
});
test('explicit Micro creates and then actually replaces verified one-turn memory without canonical or lens calls',async()=>{
  const f=await setup(3);try{
    f.control.onCall=args=>microReply(args,'첫 미크로');
    let inventory=await f.r.api.listReanalysisRanges({kind:'micro'});
    let result=await f.r.api.reanalyzeSelectedRanges(select(inventory,'2'));assert.equal(result.ok,true,JSON.stringify(result));
    const prior=await f.r.api.debugReadActiveMicroMemory(2);assert.equal(prior.status,'verified');assert.equal(prior.record.claims[0].text,'첫 미크로');
    f.control.onCall=args=>microReply(args,'교체한 미크로');inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal(inventory.ranges[1].status,'saved');
    const calls=f.control.calls.length;result=await f.r.api.reanalyzeSelectedRanges(select(inventory,'2'));
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+1);
    const after=await f.r.api.debugReadActiveMicroMemory(2);assert.equal(after.status,'verified');assert.equal(after.record.claims[0].text,'교체한 미크로');assert.notEqual(after.head.analysisRevisionId,prior.head.analysisRevisionId);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'missing');assert.equal(f.getRecords('libra.canonical_memory.v1').length,0);assert.equal(f.getRecords('libra.lens_memory_record.v1').length,0);
    assert.equal(f.control.calls.every(args=>args[0].messages[0].content.includes('MICRO SOURCE CONTRACT')),true);
  }finally{await f.r.cleanup();}
});
test('published Micro stays readable while its replacement runs and survives a failed provider',async()=>{
  const f=await setup(1);let release;try{
    f.control.onCall=args=>microReply(args);let inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,true);
    const old=await f.r.api.debugReadActiveMicroMemory(1),bytes=f.r.values.get(old.headKey),workBytes=f.r.values.get(old.record.workKey);
    const gate=new Promise(resolve=>release=resolve);let started=false;
    f.control.onCall=async()=>{started=true;await gate;return {type:'error',result:'synthetic failure'};};
    inventory=await f.r.api.listReanalysisRanges({kind:'micro'});const execution=f.r.api.reanalyzeSelectedRanges(inventory);await waitFor(()=>started);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'verified');assert.equal(f.r.values.get(old.headKey),bytes);
    release();const result=await execution;assert.equal(result.ok,false);assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).head.analysisRevisionId,old.head.analysisRevisionId);assert.equal(f.r.values.get(old.record.workKey),workBytes);
  }finally{release?.();await f.r.cleanup();}
});
test('Micro partial success reports completed turns and leaves failed and unstarted turns untouched',async()=>{
  const f=await setup(3);try{
    f.control.onCall=args=>JSON.parse(args[0].messages.find(row=>row.role==='user').content).binding.turn===2?{type:'error',result:'turn two failed'}:microReply(args);
    const inventory=await f.r.api.listReanalysisRanges({kind:'micro'}),result=await f.r.api.reanalyzeSelectedRanges(inventory);
    assert.equal(result.ok,false);assert.equal(result.processed,1);assert.deepEqual(plain(result.results.map(row=>[row.key,row.ok])),[['1',true],['2',false]]);
    assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'verified');assert.equal((await f.r.api.debugReadActiveMicroMemory(2)).status,'missing');assert.equal((await f.r.api.debugReadActiveMicroMemory(3)).status,'missing');
  }finally{await f.r.cleanup();}
});
test('Micro publication failure restores the previous work and head',async()=>{
  const f=await setup(1);try{
    f.control.onCall=args=>microReply(args,'이전 기억');let inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,true);
    const old=await f.r.api.debugReadActiveMicroMemory(1),headBytes=f.r.values.get(old.headKey),workBytes=f.r.values.get(old.record.workKey),storage=f.r.context.risuai.pluginStorage,set=storage.setItem.bind(storage);
    let rejected=false;storage.setItem=async(key,value)=>{if(key===old.headKey&&!rejected){rejected=true;throw Error('synthetic head write failure');}return set(key,value);};
    f.control.onCall=args=>microReply(args,'교체 시도');inventory=await f.r.api.listReanalysisRanges({kind:'micro'});const result=await f.r.api.reanalyzeSelectedRanges(inventory);
    assert.equal(result.ok,false);assert.equal(rejected,true);assert.equal(f.r.values.get(old.headKey),headBytes);assert.equal(f.r.values.get(old.record.workKey),workBytes);assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'verified');
  }finally{await f.r.cleanup();}
});
test('Micro source changes after its work write preserve the previous publication and reject stale source',async()=>{
  const f=await setup(1);try{
    f.chat.message[1].data+='<drop>private</drop>';await f.r.api.setSourceEditRules({version:1,ignoredTags:['drop'],unwrapTags:[],sourceTags:[],controls:[]});
    f.control.onCall=args=>microReply(args,'이전 기억');let inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,true);
    const old=await f.r.api.debugReadActiveMicroMemory(1),headBytes=f.r.values.get(old.headKey),workBytes=f.r.values.get(old.record.workKey),storage=f.r.context.risuai.pluginStorage,set=storage.setItem.bind(storage);
    let changed=false;storage.setItem=async(key,value)=>{const result=await set(key,value);if(key===old.record.workKey&&!changed){changed=true;f.chat.message[1].data=f.chat.message[1].data.replace('private','changed');}return result;};
    f.control.onCall=args=>microReply(args,'교체 시도');inventory=await f.r.api.listReanalysisRanges({kind:'micro'});assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,false);
    assert.equal(changed,true);assert.equal(f.r.values.get(old.headKey),headBytes);assert.equal(f.r.values.get(old.record.workKey),workBytes);assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'stale_source');
    f.chat.message[1].data=f.chat.message[1].data.replace('changed','private');assert.equal((await f.r.api.debugReadActiveMicroMemory(1)).status,'verified');
  }finally{await f.r.cleanup();}
});
test('lens inventory retains exact stored ranges and adds only uncovered source ranges',async()=>{
  const f=await setup();try{
    const lens=await createLens(f);f.control.onCall=()=>lensReply(f);
    assert.equal((await f.r.api.runLensForRange({lensId:lens.lensId,startTurn:1,endTurn:2})).ok,true);
    const inventory=await f.r.api.listReanalysisRanges({kind:'lens',lensId:lens.lensId});assert.deepEqual(plain(inventory.ranges.map(row=>[row.start,row.end,row.status])),[[1,2,'saved'],[3,5,'missing']]);
    const sample=await f.core.readReanalysisTurn(inventory,inventory.ranges[0]);assert.match(sample.user,/\[T1\]/);assert.match(sample.assistant,/\[T2\]/);
    const before=await f.r.api.inspectScopeLenses(),calls=f.control.calls.length;f.control.onCall=()=>lensReply(f,1,'교체한 렌즈 기록');
    const result=await f.r.api.reanalyzeSelectedRanges(select(inventory,'1-2'));assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.control.calls.length,calls+1);
    const after=await f.r.api.inspectScopeLenses();assert.equal(after.memories.length,before.memories.length);assert.equal(after.memories[0].recordKey,before.memories[0].recordKey);assert.equal(after.memories[0].text,'교체한 렌즈 기록');
    assert.equal(f.getRecords('libra.micro_memory.v1').length,0);assert.equal(f.getRecords('libra.canonical_memory.v1').length,0);
  }finally{await f.r.cleanup();}
});
test('lens selection runs only the selected lens and rejects changed instructions before calls',async()=>{
  const f=await setup(1);try{
    const a=await createLens(f,'렌즈 A'),b=await createLens(f,'렌즈 B');f.control.onCall=()=>lensReply(f);
    let inventory=await f.r.api.listReanalysisRanges({kind:'lens',lensId:b.lensId});assert.equal((await f.r.api.reanalyzeSelectedRanges(inventory)).ok,true);
    const data=await f.r.api.inspectScopeLenses();assert.ok(data.memories.every(item=>item.lensId===b.lensId));assert.equal(data.lenses[a.lensId].recordCount,0);
    inventory=await f.r.api.listReanalysisRanges({kind:'lens',lensId:b.lensId});await f.r.api.updateLens(b.lensId,{instruction:{goal:'다른 관점'}});
    const calls=f.control.calls.length,result=await f.r.api.reanalyzeSelectedRanges(inventory);assert.equal(result.ok,false);assert.equal(f.control.calls.length,calls);
  }finally{await f.r.cleanup();}
});
for(const kind of ['micro','lens'])for(const mutation of ['raw','rules','identity'])test(kind+' discards a response after '+mutation+' changes during analysis',async()=>{
  const f=await setup(1);try{
    const lens=kind==='lens'?await createLens(f):null;f.chat.message[1].data+='<drop>private</drop>';await f.r.api.setSourceEditRules({version:1,ignoredTags:['drop'],unwrapTags:[],sourceTags:[],controls:[]});
    const inventory=await f.r.api.listReanalysisRanges({kind,lensId:lens?.lensId}),sample=await f.core.readReanalysisTurn(inventory,inventory.ranges[0]);
    const request={...inventory,reviewedSource:{key:inventory.ranges[0].key,rawDigest:sample.rawDigest,rulesKey:f.core.sourceReanalysisRulesKey()}};
    f.control.onCall=async args=>{
      const reply=kind==='micro'?microReply(args):lensReply(f);
      if(mutation==='raw')f.chat.message[1].data=f.chat.message[1].data.replace('private','changed');
      if(mutation==='rules')await f.r.api.setSourceEditRules({version:1,ignoredTags:['other'],unwrapTags:[],sourceTags:[],controls:[]});
      if(mutation==='identity')f.chat.message[1].chatId='replaced-source';
      return reply;
    };
    const result=await f.r.api.reanalyzeSelectedRanges(request);assert.equal(result.ok,false,JSON.stringify(result));
    assert.equal(f.getRecords('libra.micro_memory_head.v1').length,0);assert.equal((await f.r.api.inspectScopeLenses()).memories.length,0);
  }finally{await f.r.cleanup();}
});
