'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/gradia_input_writer_unified_fixture.cjs');
const preset={provider:'openrouter',url:'https://openrouter.ai/api/v1/chat/completions',key:'synthetic-only',model:'fixture/unknown-model',context_window:0,max_tokens:4096,reasoning_preset:'off',stream:false,timeout_ms:5000};

test('provider context discovery preserves memory without a configured context or a model-name guess',{timeout:15000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',preset);
 f.controls.onMetadata=()=>{assert.equal(f.queries(),0);return {data:[{id:preset.model,context_length:128000}]};};
 const {pending}=await f.start();await f.select();
 const usage=f.host.plugin.getLibReadOnlyStatus().modelSelection;
 assert.equal(usage.contextSource,'catalog');assert.equal(usage.contextLimit,128000);
 assert.equal(f.controls.metadataRequests,1);assert.equal(f.queries(),1);
 assert(JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));
 assert.equal(await f.done(pending),true);assert.equal(f.copied.length,1);
});

for(const kind of ['missing','wrong-model','provider-error'])test('unknown context '+kind+' skips memory before capture and still delivers native choices',{timeout:15000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',preset);
 f.controls.onMetadata=()=>{if(kind==='provider-error')throw Error('metadata unavailable');return {data:kind==='wrong-model'?[{id:'different-model',context_length:1000000}]:[{id:preset.model}]};};
 const {pending}=await f.start();await f.choices();
 assert.equal(f.queries(),0);assert.equal(f.prompts.length,1);
 assert(!JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));
 assert.equal(f.host.plugin.getInputAssistSendStatus().memory.reason,'LIB_READ_MODEL_CONTEXT_UNAVAILABLE');
 assert(f.document.body.textContent.includes('기억 참고 생략'));
 await f.select();
 assert.equal(await f.done(pending),true);assert.equal(f.copied.length,1);
 assert.equal(f.host.plugin.getRuntime().inputAssistSend.memory.status,'unavailable');
 // The diagnostic names the boundary that failed, not the generic owner read.
 const diagnostic=f.host.plugin.getRuntime().lastInputWriterReadDiagnostic;
 assert.equal(diagnostic?.code,'LIB_READ_MODEL_CONTEXT_UNAVAILABLE');assert.equal(diagnostic?.stage,'model_context_preflight');
});

test('cancellation while discovering context cannot read memory or dispatch a late model call',{timeout:15000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',preset);
 let release,entered;const started=new Promise(r=>entered=r);
 f.controls.onMetadata=async()=>{entered();await new Promise(r=>release=r);return {data:[{id:preset.model,context_length:128000}]};};
 const {pending}=await f.start();await started;await f.host.plugin.cancelInputAssistSend();
 release();assert.equal(await pending,false);assert.equal(f.queries(),0);assert.equal(f.prompts.length,0);assert.equal(f.copied.length,0);
});

test('a slow metadata response is bounded and cannot attach late evidence to native choices',{timeout:10000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',preset);
 let release;f.controls.onMetadata=async()=>{await new Promise(r=>release=r);return {data:[{id:preset.model,context_length:128000}]};};
 const at=Date.now(),{pending}=await f.start();await f.choices();
 assert(Date.now()-at<6500);assert.equal(f.queries(),0);
 release();await new Promise(r=>setTimeout(r,30));assert.equal(f.queries(),0);assert.equal(f.prompts.length,1);
 assert.equal(f.host.plugin.getInputAssistSendStatus().memory.status,'unavailable');
 await f.select();assert.equal(await f.done(pending),true);
});

test('native scene changes during context discovery still block all generation and export',{timeout:15000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',preset);
 f.controls.onMetadata=()=>{f.chat.message.at(-1).data='The current scene was edited.';return {data:[{id:preset.model,context_length:128000}]};};
 const {pending}=await f.start();assert.equal(await pending,false);
 assert.equal(f.queries(),0);assert.equal(f.prompts.length,0);assert.equal(f.copied.length,0);
 assert.equal(f.host.plugin.getInputAssistSendStatus().reason,'LIB_READ_NATIVE_CHANGED');
});

test('explicit context preserves memory without any extra metadata request',{timeout:15000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',{...preset,context_window:128000});
 f.controls.onMetadata=()=>{throw Error('explicit context must not fetch metadata');};
 const {pending}=await f.start();await f.select();assert.equal(await f.done(pending),true);
 assert.equal(f.controls.metadataRequests||0,0);assert.equal(f.queries(),1);assert.equal(f.prompts.length,1);
});

test('regeneration refreshes an earlier omission notice when matching metadata becomes available',{timeout:15000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('writer',preset);
 f.controls.onMetadata=()=>({data:[{id:preset.model}]});
 const {pending}=await f.start();await f.choices();assert(f.document.body.textContent.includes('기억 참고 생략'));
 f.controls.onMetadata=()=>({data:[{id:preset.model,context_length:128000}]});
 await f.host.plugin.listProviderModels('writer',{force:true});
 f.button('3가지 선택지 다시 제안').click();
 await f.wait(()=>f.prompts.length===2&&f.document.querySelector('[data-input-choice-editor]')?.disabled===false,'regeneration');
 assert.equal(f.queries(),1);assert.equal(f.host.plugin.getInputAssistSendStatus().memory.status,'ready');
 assert(!f.document.body.textContent.includes('기억 참고 생략'));await f.select();assert.equal(await f.done(pending),true);
});

test('a pre-dispatch evidence policy failure closes logical telemetry and records zero provider attempts',{timeout:15000},async t=>{
 const f=await fixture(t);
 await f.host.plugin.saveProviderPreset('writer',{...preset,context_window:128000,extra_body_json:'{"unsupported":true}'});
 const {pending}=await f.start();assert.equal(await pending,false);
 const telemetry=f.host.plugin.getRuntime().callTelemetry;
 assert.equal(telemetry.providerAttempts,0);assert(telemetry.logicalCalls.length>0);
 assert(telemetry.logicalCalls.every(c=>c.status!=='running'&&c.completedAt>=c.startedAt));
 assert.equal(f.prompts.length,0);assert.equal(f.sent.length+f.copied.length,0);
});
