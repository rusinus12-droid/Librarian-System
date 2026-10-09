'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createHayakuRuntime}=require('./fixtures/hayaku_runtime_harness.cjs');
const tag='<lb-xnai id="scene-9" operation="first > revision" scene="9">{{inlay::dfb2caba-cc65-4585-808d-28815ff6aafe}}</lb-xnai>';
const base='Alice entered the archive.\n\n\n\nShe found a blue ribbon.';
let passed=0;const eq=(a,b,m)=>{assert.equal(a,b,m);passed++;};
(async()=>{
 const l=await createLibraVmHarness();try{
  const chat={id:'test',message:[{role:'user',chatId:'u',data:'Enter the archive.'},{role:'assistant',chatId:'a',data:base}]};
  const before=l.api.debugBuildPairs(chat,'illustration')[0].assistant.text;
  eq(before,base.replace(/\n{3,}/g,'\n\n'),'LIBRA retains the prior history sanitizer whitespace policy');
  for(const value of [tag,tag.replace('first > revision','second').replace('dfb2caba','00000000'),'<lb-xnai id="x"/>']){
   chat.message[1].data=base.slice(0,5)+value+base.slice(5);eq(l.api.debugBuildPairs(chat,'illustration')[0].assistant.text,before,'LIBRA carrier-only insertion keeps source text');
  }
  chat.message[1].data=base+'<lb-xnai>Alice left.</lb-xnai>';assert.ok(l.api.debugBuildPairs(chat,'illustration')[0].assistant.text.includes('Alice left.'));passed++;
 }finally{await l.cleanup();}
 const f=await createFixture();try{const t=f.api._test,before=t.flashbackSourceEditDigest({userText:'Enter.',assistantText:base});
  for(const value of [tag,tag.replace('first > revision','next'),'<lb-xnai/>'])eq(t.flashbackSourceEditDigest({userText:'Enter.',assistantText:base.slice(0,5)+value+base.slice(5)}),before,'Flashback carrier-only change ignored');
  assert.notEqual(t.flashbackSourceEditDigest({userText:'Enter.',assistantText:base+'<lb-xnai>Alice left.</lb-xnai>'}),before);passed++;
 }finally{await f.dispose();}
 const h=await createHayakuRuntime({autoRepair:false});try{const t=h.hayaku._test;
  for(const value of [tag,tag.replace('first > revision','next'),'<lb-xnai/>'])eq(t.stripIllustrationOnlyCarriers(base.slice(0,5)+value+base.slice(5)),base,'HAYAKU quote-aware carrier-only change ignored');
  eq(t.stripIllustrationOnlyCarriers('<lb-xnai>Alice left.</lb-xnai>'),'<lb-xnai>Alice left.</lb-xnai>','HAYAKU prose remains evidence');
 }finally{await h.dispose();}
 console.log(JSON.stringify({test:'illustration_three_owners_v526',passed}));
})().catch(e=>{console.error(e);process.exitCode=1});
