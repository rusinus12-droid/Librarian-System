'use strict';
// b6ef41aa 이후 작업 규모 프리셋은 모델 문맥 하나에서 예산을 계산한다. 같은 프리셋이라도
// 문맥이 작으면 참조·기억을 줄이고, 큰 문맥에서는 저장된 상한을 그대로 쓴다.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');

const budgetFor=(plugin,profile,context,maxTokens=16384)=>
  plugin.debugWorkScaleBudget(profile,{context_window:context,max_tokens:maxTokens,model:'test-model',provider:'custom'});

test('a tight context shrinks reference and memory to the shares it can afford',async()=>{
  const h=await load();
  const b=budgetFor(h.plugin,'balanced',32768);
  assert.equal(b.contextTokens,32768);
  assert.equal(b.outputReserve,11468,'completion reserve is capped at 35% of the context');
  assert.equal(b.margin,3277);
  assert.ok(b.referenceCap>9000&&b.referenceCap<14000,`reference cap ${b.referenceCap}`);
  assert.ok(b.memoryCap>3500&&b.memoryCap<6000,`memory cap ${b.memoryCap}`);
  const total=b.referenceCap+b.memoryCap;
  assert.ok(total+b.outputReserve+b.margin<=32768,`the shares must fit the context (${total})`);
});

test('each profile keeps its ordering and the stored caps return on a large context',async()=>{
  const h=await load();
  const tight=['fast','balanced','quality'].map(id=>budgetFor(h.plugin,id,32768));
  assert.ok(tight[0].referenceCap<tight[1].referenceCap&&tight[1].referenceCap<tight[2].referenceCap);
  assert.ok(tight[0].memoryCap<tight[1].memoryCap&&tight[1].memoryCap<tight[2].memoryCap);
  const roomy=['fast','balanced','quality'].map(id=>budgetFor(h.plugin,id,1000000));
  assert.deepEqual(roomy.map(b=>b.referenceCap),[24000,48000,96000],'large contexts keep the profile ceiling');
  assert.deepEqual(roomy.map(b=>b.memoryCap),[12000,24000,48000]);
});

test('an unknown context leaves the stored caps untouched',async()=>{
  const h=await load();
  const b=h.plugin.debugWorkScaleBudget('balanced',{context_window:0,max_tokens:16384,model:'',provider:'custom'});
  assert.equal(b.referenceChars,null);
  assert.equal(b.memoryChars,null);
  assert.equal(b.referenceCap,48000);
  assert.equal(b.memoryCap,24000);
});

test('english drafts count more characters per token than korean ones',async()=>{
  const h=await load();
  const korean=budgetFor(h.plugin,'balanced',32768);
  const english=h.plugin.debugWorkScaleBudget('balanced',{context_window:32768,max_tokens:16384,model:'test-model',provider:'custom'},{internalDraftLanguage:'english'});
  assert.ok(english.referenceCap>korean.referenceCap,'1.8 chars/token fits more text than 1.1');
});
