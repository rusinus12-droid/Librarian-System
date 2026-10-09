'use strict';
// The old normal-case oracle expected an open head. That was incorrect: t5-a
// explicitly says the t2-a key-return promise was fulfilled. Gemma's omission
// of a thread fact is a separate extraction-quality result, not this code path.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {lineageFixture}=require('./fixtures/libra_unified_lineage_fixture.cjs');
const source=require('./fixtures/unified_vertical_source.json').sourceRows;
const raw=fs.readFileSync(path.join(__dirname,'fixtures','qwen_v2_canonical_normal.raw'),'utf8');
const artifact=JSON.parse(JSON.parse(raw).message.content);
const correctedOracle=require('./fixtures/canonical_thread_oracle_correction.json');
const chat={id:'same-batch-thread',chatId:'same-batch-thread',name:'synthetic thread replay',message:source.map(r=>({role:r.role,chatId:r.ref,data:r.text}))};
const digest=value=>{const body=typeof value==='string'?value:JSON.stringify(value??null);let h=2166136261;
  for(let i=0;i<body.length;i++){h^=body.charCodeAt(i);h=Math.imul(h,16777619);}h^=31;h=Math.imul(h,16777619);
  return `${(h>>>0).toString(16).padStart(8,'0')}:${body.length+1}`;};

async function replay(edit=()=>{},expected={}){
  const proposal=structuredClone(artifact);edit(proposal);
  const f=await fixture({snapshot:{chat}});
  try{
    f.control.onCall=()=>({type:'success',result:JSON.stringify(proposal)});
    const run=await f.run();
    const memory=f.getMemory(1),head=f.getHead();
    assert.equal(f.control.calls.length,1,'one fake provider response, no actual model');
    assert.equal(run.completed,1,JSON.stringify(run));
    assert.ok(memory?.canonicalArtifact,'actual canonical admission persisted');
    const facts=memory.canonicalArtifact.facts.filter(x=>x.claimKind==='thread');
    const threads=head?.narrative?.threads||[];
    const history=await f.r.api.getWorldManagerHistoryDetail({memoryId:memory.memoryId,revision:memory.revision});
    if(expected.status)assert.equal(facts.at(-1).values.thread.linkStatus,expected.status);
    if(expected.open!==undefined)assert.equal(threads.length,expected.open,JSON.stringify({facts,threads,pending:head.pending}));
    return {facts,threads,history,memory,values:[...f.r.values.entries()],chat:f.chat};
  }finally{await f.r.cleanup();}
}
async function malformedEvidence(edit){
  const proposal=structuredClone(artifact);edit(proposal);
  const f=await fixture({snapshot:{chat}});
  try{
    f.control.onCall=()=>({type:'success',result:JSON.stringify(proposal)});
    await f.run();
    const stored=f.getMemory(1)?.canonicalArtifact?.facts||[];
    assert.notEqual(stored.find(row=>row.tempFactId==='f13')?.values?.thread?.linkStatus,'accepted',
      'empty or unrecognised evidence cannot seal a same-batch target');
    assert.equal(f.control.calls.length,1);
  }finally{await f.r.cleanup();}
}

(async()=>{
  const same=await replay(()=>{},{status:'accepted',open:0});
  assert.equal(correctedOracle.correctHeadThreads,same.threads.length);
  assert.ok(source.find(r=>r.ref===correctedOracle.sourceRef).text.includes(correctedOracle.sourceQuote));
  assert.equal(same.facts.length,2,'v2 raw preserved both thread facts');
  assert.equal(same.facts[1].values.thread.lifecycleId,same.facts[0].values.thread.lifecycleId);
  assert.equal(JSON.stringify(same.history.semanticTimeline?.events?.filter(e=>e.threadLifecycleId===same.facts[0].values.thread.lifecycleId).map(e=>e.type)),JSON.stringify(['created','resolved']));
  const restarted=await fixture({snapshot:{chat:same.chat,values:same.values}});
  try{
    const rebuilt=await restarted.r.api.rebuildWorldManagerState();
    assert.equal(rebuilt.ok,true,JSON.stringify(rebuilt));
    assert.equal(restarted.control.calls.length,0,'cold projector replay never invokes the model');
    assert.equal(restarted.getHead().narrative.threads.length,0,'resolved head remains closed after restart');
  }finally{await restarted.r.cleanup();}
  for(const [label,mutate] of [
    ['stale_source',t=>{t.sourceDigest='00000000:1';}],
    ['other_scope',t=>{t.scopeKey='another-scope';}],
    ['other_worldline',t=>{t.worldlineId='other-branch';}],
    ['missing_prior',t=>{t.factId='absent_fact';}]
  ]){
    const values=new Map(same.values);
    const [manifestKey,manifestBytes]=[...values].find(([key,bytes])=>{try{return key.endsWith(':manifest')&&!!JSON.parse(bytes)?.memories?.['1'];}catch{return false;}})||[];
    assert.ok(manifestKey,`${label}: manifest exists`);
    const manifest=JSON.parse(manifestBytes),ref=manifest.memories['1'];
    const record=JSON.parse(values.get(ref.key));
    mutate(record.canonicalArtifact.facts.find(f=>f.tempFactId==='f13').values.thread.linkTarget);
    record.artifactDigest=digest(record.canonicalArtifact);ref.artifactDigest=record.artifactDigest;
    values.set(ref.key,JSON.stringify(record));values.set(manifestKey,JSON.stringify(manifest));
    const tampered=await fixture({snapshot:{chat,values:[...values]}});
    try{
      const rebuilt=await tampered.r.api.rebuildWorldManagerState();
      assert.equal(tampered.control.calls.length,0);
      if(label==='other_worldline')assert.equal(rebuilt.ok,false,'unsupported branch is rejected at artifact validation');
      else{assert.equal(rebuilt.ok,true,`${label}: stale semantic target is read without model`);
        assert.equal(tampered.getHead().narrative.threads.length,1,`${label}: no stale resolution adopted`);}
    }finally{await tampered.r.cleanup();}
  }
  const pending={status:'pending',open:1};
  await replay(a=>{a.facts.find(f=>f.tempFactId==='f13').values.thread.summary='A different promise to deliver a book.';},pending);
  await replay(a=>{a.facts.find(f=>f.tempFactId==='f13').values.thread.participants[1].personTempRef='p_junho';},pending);
  await replay(a=>{
    const original=a.entities.find(e=>e.tempId==='t_key_return');
    a.entities.push({...structuredClone(original),tempId:'t_different_key_return'});
    const closed=a.facts.find(f=>f.tempFactId==='f13');closed.subjectTempRef='t_different_key_return';
    closed.values.thread.linkCandidateAlias='t_different_key_return';
  },pending);
  await replay(a=>{const f=a.facts.find(f=>f.tempFactId==='f13');f.evidenceSpans=[{ref:'t1-a',quote:source.find(r=>r.ref==='t1-a').text}];},pending);
  await replay(a=>{a.facts.find(f=>f.tempFactId==='f13').values.thread.linkCandidateAlias='p_jiho';},pending);
  await replay(a=>{a.facts=a.facts.filter(f=>f.tempFactId!=='f6');},{status:'pending',open:0});
  await replay(a=>{a.facts=a.facts.filter(f=>f.tempFactId!=='f6');
    const value=a.facts.find(f=>f.tempFactId==='f13').values.thread;
    delete value.link;delete value.linkCandidateAlias;
  },{status:'new',open:0});
  await replay(a=>{const f=a.facts.find(f=>f.tempFactId==='f6');a.facts.splice(a.facts.indexOf(f)+1,0,{...structuredClone(f),tempFactId:'f6_duplicate'});},{status:'pending',open:2});
  await replay(a=>{
    const opening=a.facts.find(f=>f.tempFactId==='f6');
    const entity=a.entities.find(e=>e.tempId==='t_key_return');
    const future={ref:'t5-a',quote:source.find(r=>r.ref==='t5-a').text};
    opening.evidenceSpans.push(future);entity.evidenceSpans.push(future);
    const closure=a.facts.find(f=>f.tempFactId==='f13');
    closure.evidenceSpans=[{ref:'t4-a',quote:source.find(r=>r.ref==='t4-a').text}];
  },{status:'pending',open:1});
  await replay(a=>{
    const opening=a.facts.find(f=>f.tempFactId==='f6');
    const closure=a.facts.find(f=>f.tempFactId==='f13');
    closure.evidenceSpans.unshift(structuredClone(opening.evidenceSpans[0]));
  },{status:'accepted',open:0});
  await malformedEvidence(a=>{a.facts.find(f=>f.tempFactId==='f6').evidenceSpans=[];});
  await malformedEvidence(a=>{a.facts.find(f=>f.tempFactId==='f13').evidenceSpans=[{ref:'unknown',quote:'unknown'}];});
  const branched=await lineageFixture({snapshot:{chat}});
  try{
    branched.control.onCall=()=>({type:'success',result:JSON.stringify(artifact)});
    assert.equal((await branched.run()).completed,1);
    branched.branch(5,'same-batch-native-child');
    const copied=await branched.r.api.debugNativeChatCopy({force:true});
    assert.equal(copied.result?.ok,true,JSON.stringify(copied));
    assert.equal(branched.control.calls.length,1,'native branch copies sealed batch without model replay');
    assert.equal(branched.head(branched.current()).narrative.threads.length,0,'copied branch stays resolved');
    const rebuilt=await branched.r.api.rebuildWorldManagerState();
    assert.equal(rebuilt.ok,true,JSON.stringify(rebuilt));
    assert.equal(branched.head(branched.current()).narrative.threads.length,0,'branch replay retains closure');
    branched.select(branched.chat);
    branched.branch(3,'before-fulfillment-child');
    const cutoff=await branched.r.api.debugNativeChatCopy({force:true});
    assert.equal(cutoff.result?.ok,true,JSON.stringify(cutoff));
    assert.equal(Object.keys(branched.manifest(branched.current())?.memories||{}).length,0,
      'a branch cut before the completed batch cannot inherit its future resolution');
    assert.equal(branched.control.calls.length,1,'rollback-side copy never regenerates model output');
  }finally{await branched.r.cleanup();}
  console.log(JSON.stringify({test:'libra_same_batch_thread_replay',status:'pass',rawFacts:2,openHead:0,negativeCases:14,sharedEvidence:'accepted',standaloneResolved:'new_closed',restart:'closed_without_model',nativeBranch:'closed_without_model',preCompletionBranch:'future_not_inherited'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
