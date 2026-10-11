'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
for(const change of ['none','source_before_apply','source_during_model','scope','assistant_id','delete'])test('LIBRA current selected owner source guard '+change,async()=>{
 const f=await fixture();try{
  assert.equal((await f.run()).completed,1);
  const old=f.getManifest().memories['1'],bytes=f.r.values.get(old.key),calls=f.control.calls.length;
  f.chat.message[0].data+=' Explicit source revision.';
  const inventory=await f.r.api.listCanonicalBatchRanges(),selection={scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges};
  assert.equal(f.control.calls.length,calls,'inventory reads never dispatch a model');
  if(change==='source_before_apply')f.chat.message[0].data+=' Current source at execution.';
  if(change==='scope')f.chat.id=f.chat.chatId='other-chat';
  if(change==='assistant_id')f.chat.message[1].chatId='new-assistant';
  if(change==='delete')f.chat.message.splice(2,2);
  if(change==='source_during_model')f.control.onCall=async()=>{f.chat.message[0].data+=' Late revision.';return{type:'success',result:JSON.stringify(f.control.artifact)}};
  let result;try{result=await f.r.api.startSelectedCanonicalBatches(selection)}catch(error){result={ok:false,reason:error.message}}
  const succeeds=['none','source_before_apply'].includes(change);
  assert.equal(result.ok,succeeds,JSON.stringify(result));assert.equal(f.r.values.get(old.key),bytes,'prior canonical remains immutable');
  if(succeeds){assert.equal(f.control.calls.length,calls+1);assert.ok(f.getManifest().memories['1'].revision>old.revision);assert.equal(result.job.completed,1)}
  if(['scope','assistant_id','delete'].includes(change))assert.equal(f.control.calls.length,calls,'invalid selected identity refuses before provider dispatch');
  if(change==='source_during_model'){assert.equal(f.getManifest().memories['1'].key,old.key);assert.equal(f.getManifest().memories['1'].status,'committed')}
 }finally{await f.r.cleanup()}
});
for(const change of ['none','assistant_id','user_id','middle_delete','scope','corrupt_payload'])test('LIBRA independent recall and immutable source guard '+change,async()=>{
 const f=await fixture();try{
  assert.equal((await f.run()).completed,1);const settings=await f.r.api.getLibraMemorySettings();await f.r.api.saveLibraMemorySettings({...settings,autoAnalyze:false});
  const ref=f.getManifest().memories['1'],bytes=f.r.values.get(ref.key),calls=f.control.calls.length;
  if(change==='assistant_id')f.chat.message[1].chatId='different-a';if(change==='user_id')f.chat.message[0].chatId='different-u';
  if(change==='middle_delete')f.chat.message.splice(2,2);if(change==='scope')f.chat.id=f.chat.chatId='different-scope';
  if(change==='corrupt_payload'){const m=JSON.parse(bytes);m.text+=' CORRUPTED_INJECT';m.canonicalArtifact.facts[0].text='CORRUPTED_INJECT';m.artifactDigest='bad';f.r.values.set(ref.key,JSON.stringify(m))}
  const out=await f.control.hooks.beforeRequest([{role:'user',content:'은빛 열쇠 반환 약속을 회상한다.'}],'model');
  if(change==='none')assert.ok(out.some(m=>/은빛|열쇠/.test(String(m.content||''))&&String(m.content||'').includes('LIBRA')),'validated canonical evidence is delivered to the real request');
  else if(change==='corrupt_payload')assert.equal(out.some(m=>String(m.content||'').includes('CORRUPTED_INJECT')),false);
  else assert.equal(out.some(m=>String(m.content||'').includes('LIBRA')&&/은빛|열쇠/.test(String(m.content||''))),false);
  assert.equal(f.control.calls.length,calls);assert.equal(f.r.values.has(ref.key),true);
  assert.equal(typeof f.r.api.getSourceEditSyncStatus,'undefined');assert.equal([...f.r.values.keys()].some(k=>k.includes(':source-edit-consent:v1')),false);
 }finally{await f.r.cleanup()}
});
