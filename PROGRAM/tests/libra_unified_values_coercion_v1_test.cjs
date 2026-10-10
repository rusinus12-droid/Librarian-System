'use strict';
const assert=require('node:assert/strict');
const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const results=[];
async function test(name,fn){try{await fn();results.push(name);}catch(e){console.error(`FAIL ${name}`);console.error(e);process.exitCode=1;}}
(async()=>{
  // Baseline canonical artifact (already correct flat values) must validate.
  await test('canonical flat values artifact still validates',async()=>{
    const f=await fixture({});
    try{
      const batch=[];for(let t=1;t<=5;t++){batch.push({turn:t,user:{text:f.chat.messages.find((_,i)=>i===t*2-2).data},assistant:{text:f.chat.messages.find((_,i)=>i===t*2-1).data}});}
      const validation=f.r.api.debugValidateUnifiedArtifact(f.control.artifact,batch);
      assert.equal(validation.ok,true,JSON.stringify(validation.issues||[]));
    }finally{await f.r.cleanup();}
  });

  // (i) The observed wrapper pattern: values {<claimKind>:{domain,field,value}} → must pass after normalization.
  await test('claimKind wrapper values are unwrapped and validate',async()=>{
    const f=await fixture({});
    try{
      const clone=f.clone(f.control.artifact);
      const batch=[];for(let t=1;t<=5;t++){batch.push({turn:t,user:{text:f.chat.messages.find((_,i)=>i===t*2-2).data},assistant:{text:f.chat.messages.find((_,i)=>i===t*2-1).data}});}
      const wrapped=JSON.parse(JSON.stringify(clone));
      for(const fact of wrapped.facts){
        const contract={event:'detail',location:'locationRef',character_state:'condition',knowledge:'knowledge',affiliation:'affiliation',scene_time:'sceneTime',relationship:'value',containment:'parentRef',management:'managerRef',ownership:'ownerRef',possession:'holderRef',placement:'containerRef',access:'access',rule:'rule',world_state:'condition',thread:'thread'}[fact.claimKind];
        const inner=fact.values[contract];
        fact.values={[fact.claimKind]:{domain:fact.domain,field:contract,value:inner}};
      }
      // simulate the prepare step through the run path: craft the provider to return the wrapped artifact
      f.control.artifact=wrapped;
      const r=await f.run();
      assert.equal(r.completed,1,JSON.stringify(r));
      const memory=f.getMemory();
      assert.ok(memory,'memory committed');
      assert.equal(memory.canonicalArtifact.facts[0].values[f.control.artifact.facts[0].claimKind],undefined,'wrapper key must not persist');
      assert.ok(Object.keys(memory.canonicalArtifact.facts[0].values).length===1);
      // the state head must have advanced (bindings normalized)
      assert.ok(f.getHead(),'state head built from normalized artifact');
    }finally{await f.r.cleanup();}
  });

  // (ii) Correct outputs pass with no changes.
  await test('correct artifact passes without normalization',async()=>{
    const f=await fixture({});
    try{
      const r=await f.run();
      assert.equal(r.completed,1);
      const memory=f.getMemory();
      assert.deepEqual(memory.canonicalArtifact,f.control.artifact,'artifact must be byte-identical (no normalization applied)');
      assert.equal(memory.canonicalArtifact.facts.length,f.control.artifact.facts.length);
    }finally{await f.r.cleanup();}
  });

  // (iii) Unrecoverable garbage values still rejected.
  await test('unfixable values shape is still rejected',async()=>{
    const f=await fixture({});
    try{
      const garbage=f.clone(f.control.artifact);
      garbage.facts[0].values={totally_wrong_field:'x'};
      garbage.stateBindings=garbage.stateBindings.filter(b=>b.factTempId!==garbage.facts[0].tempFactId);
      f.control.artifact=garbage;
      const r=await f.run();
      assert.equal(r.completed,1,'valid records must survive an unfixable fact');
      assert.equal(f.getMemory().canonicalArtifact.facts.length,garbage.facts.length-1);
      assert.ok(!f.getMemory().canonicalArtifact.facts.some(x=>x.tempFactId===garbage.facts[0].tempFactId));
      assert.equal(f.getMemory().pipeline.status,'partial');
    }finally{await f.r.cleanup();}
  });
  console.log(JSON.stringify({test:'libra_values_unwrap_coercion',passed:results.filter(x=>x).length,results}));
})().catch(e=>{console.error(e);process.exitCode=1});
