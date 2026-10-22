'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/gradia_input_writer_unified_fixture.cjs');
for(const config of [
 {provider:'openai',model:'gpt-5.6',url:'https://api.openai.com/v1/chat/completions',request_format:'chat_completions'},
 {provider:'openai',model:'gpt-5.6',url:'https://api.openai.com/v1',request_format:'responses'},
 {provider:'gemini',model:'gemini-3.6-flash',url:'https://generativelanguage.googleapis.com/v1beta'},
 {provider:'claude',model:'claude-opus-5',url:'https://api.anthropic.com/v1'},
 {provider:'ollama',model:'fixture-local-model',url:'http://127.0.0.1:11434'}
])test('configured '+config.provider+'/'+(config.request_format||'native')+' reads proposal evidence and delivers through its actual builder',{timeout:15000},async t=>{
 const f=await fixture(t);
 await f.host.plugin.saveProviderPreset('writer',{...config,key:'synthetic-only',context_window:262144,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:5000,stream:false});
 const {pending}=await f.start();await f.select();assert.equal(await f.done(pending),true);
 assert.equal(f.queries(),1);assert.equal(f.prompts.length,1);assert(JSON.stringify(f.prompts[0]).includes('WRITER_OWNER_EVIDENCE'));
 assert.equal(f.sent.length,1);assert(!JSON.stringify([...f.values,...f.local]).includes('WRITER_OWNER_EVIDENCE'));
});
test('an atomic owner bundle larger than 64KiB reaches a model request larger than 128000 bytes',{timeout:15000},async t=>{
 const f=await fixture(t);f.controls.evidenceText='BEGIN_LARGE_MEMORY '+('기억'.repeat(24000))+' END_LARGE_MEMORY';
 const {pending}=await f.start();await f.select();
 const measured=f.host.plugin.getLibReadOnlyStatus().modelSelection;assert.equal(measured.meterKind,'unicode-text-estimate-plus-framing');
 assert.equal(measured.serializedPayloadBytes,Buffer.byteLength(JSON.stringify(f.prompts[0])));assert(measured.renderedEvidenceBytes>65536);
 assert.equal(await f.done(pending),true);
 const serialized=JSON.stringify(f.prompts[0]);assert(Buffer.byteLength(f.controls.evidenceText)>65536);assert(Buffer.byteLength(serialized)>128000);
 assert(serialized.includes('BEGIN_LARGE_MEMORY'));assert(serialized.includes('END_LARGE_MEMORY'));assert.equal(f.queries(),1);
});
test('an atomic bundle that cannot fit the configured context never dispatches or exports a draft',{timeout:15000},async t=>{
 const f=await fixture(t);f.controls.evidenceText='MUST_REMAIN_ATOMIC '+('기억'.repeat(30000));
 await f.host.plugin.saveProviderPreset('writer',{provider:'openai',model:'gpt-5.6',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',context_window:16384,max_tokens:4096,reasoning_preset:'off',stream:false});
 const {pending}=await f.start();assert.equal(await pending,false);assert.equal(f.prompts.length,0);assert.equal(f.sent.length+f.copied.length,0);
 assert(!JSON.stringify(f.host.plugin.getRuntime()).includes('MUST_REMAIN_ATOMIC'));
});
test('a smaller context packs complete owner items and rechecks every contributing source',{timeout:15000},async t=>{
 const f=await fixture(t),owners=['libra','hayaku','flashback'];let current=true;
 const items=Array.from({length:12},(_,i)=>{const owner=owners[i%3];return {owner,id:'item-'+i,key:'key-'+i,content:'START_'+i+' '+('기'.repeat(2000))+' END_'+i,source:{namespace:owner,revision:1}};});
 f.host.plugin.bindLibReadOnlyClient({schema:'memory-suite.memory-read-client.v1',pluginId:'serial_gradation_agents_for_rp',openReadSession:async(_scope,o)=>({
  source:'unified_engine',snapshot:{schema:'memory-suite.memory-read-session.v1',complete:true,readOnly:true,scope:f.scope,owners,items,evidenceRevision:'a'.repeat(64),corpusBytes:items.reduce((n,x)=>n+Buffer.byteLength(x.content),0),maxCorpusBytes:o.maxCorpusBytes},
  engine:{purpose:'input_writer_proposal',proposal:o.proposal},assertCurrent:async()=>current,assertCurrentSync:()=>current})},{scope:f.scope,readSource:'unified_engine'});
 await f.host.plugin.saveProviderPreset('writer',{provider:'openai',model:'gpt-5.6',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',context_window:16384,max_tokens:4096,reasoning_preset:'off',stream:false});
 const {pending}=await f.start();await f.select();
 const sent=JSON.stringify(f.prompts[0]),included=items.filter(x=>sent.includes(x.content));
 assert(included.length>0&&included.length<items.length);for(const item of included)assert(sent.includes(item.content));
 const status=f.host.plugin.getLibReadOnlyStatus(),measured=status.modelSelection;assert.equal(measured.selectedItems,included.length);
 // The writer keeps HAYAKU/Flashback records within its record budget before the per-call context fit.
 const packed=included.length+measured.omittedItems;assert(packed<items.length,'record budget trims the packet');
 const recordChars=items.filter(x=>x.owner!=='libra'&&sent.includes(x.content)).reduce((n,x)=>n+x.content.length,0);assert(recordChars<=8000,String(recordChars));
 assert(measured.finalInputAllowance+measured.effectiveOutputReserve+measured.safetyMargin<=measured.contextLimit);
 current=false;f.button('바로 전송').click();await f.wait(()=>f.document.body.textContent.includes('검증 실패'),'source currentness');assert.equal(f.sent.length,0);
 await f.host.plugin.cancelInputAssistSend();assert.equal(await pending,false);
});
test('matching catalog context caps a larger manual context value',{timeout:15000},async t=>{
 const f=await fixture(t);
 await f.host.plugin.saveProviderPreset('writer',{provider:'openai',model:'gpt-5.6',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',context_window:262144,
  metadata_model_id:'gpt-5.6',catalog_context_window:16384,max_tokens:4096,reasoning_preset:'off',stream:false});
 const {pending}=await f.start();await f.select();assert.equal(f.host.plugin.getLibReadOnlyStatus().modelSelection.contextLimit,16384);assert.equal(await f.done(pending),true);
});
