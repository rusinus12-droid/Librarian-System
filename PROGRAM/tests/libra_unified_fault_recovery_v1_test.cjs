'use strict';
const assert=require('node:assert/strict');const {fixture,artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {classifyCall,countCalls}=require('./fixtures/libra_provider_call_kinds.cjs');
const results=[];const success=x=>({type:'success',result:JSON.stringify(x)});
const assertCanonicalCalls=(f,expected)=>{assert.equal(countCalls(f.control).canonical,expected,'Canonical extraction count');assert.equal(countCalls(f.control).other,0,'no unrelated provider call');};
const onCanonicalCall=(f,handler)=>{f.control.onCall=async args=>classifyCall(args)==='canonical'?handler(args):success(f.control.artifact);};
async function test(name,fn){const f=await fixture();try{await fn(f);results.push(name);}finally{await f.r.cleanup();}}
const parse=v=>{try{return JSON.parse(v);}catch{return {};}};
const wrapStorage=(f,fn)=>{const storage=f.r.context.risuai.pluginStorage,original=storage.setItem;storage.setItem=async(k,v)=>fn(String(k),v,()=>original(k,v));return()=>{storage.setItem=original;};};
const noActive=f=>!f.getRecords('libra.manifest.v1').some(r=>Object.values(r.value.memories || {}).some(m=>m.status==='committed'));
(async()=>{
 for(const kind of ['throw_head','noop_head','noop_registry'])await test(`${kind}: canonical survives; pending State retries locally with original transaction`,async f=>{
   let hit=0;const restore=wrapStorage(f,async(k,v,write)=>{const value=parse(v);const target=kind==='noop_registry'?'libra.entity_registry.v2':'libra.continuity_state.v2';if(value.schema===target && hit++===0){if(kind==='throw_head')throw new Error('injected_head_write_failure');return true;}return write();});
   const r=await f.run();restore();assert.equal(r.completed,1,JSON.stringify(r));assert.ok(hit>0);assert.ok(f.getMemory());const digest=f.getMemory().artifactDigest;
   assert.equal(f.getRecords('libra.unified_state_tx.v1').length,1);assert.equal(f.getRecords('libra.unified_basis_snapshot.v1').length,1);
   const callsBeforeRetry=f.control.calls.length;const retry=await f.r.api.retryPendingUnifiedState();assert.equal(retry.recovered,1,JSON.stringify(retry));assertCanonicalCalls(f,1);assert.equal(f.control.calls.length,callsBeforeRetry,'State retry must make no additional physical provider call');assert.equal(f.getMemory().artifactDigest,digest);assert.equal(f.getHead().status,'ready');assert.equal(f.getRecords('libra.unified_state_tx.v1').length,0);assert.equal(f.getRecords('libra.unified_basis_snapshot.v1').length,0);
 });
 await test('receipt readback interruption is recovered without second State or model run',async f=>{
   let hit=false;const restore=wrapStorage(f,async(k,v,write)=>{if(!hit&&parse(v).engineVersion===f.r.api.getLibrarianPolicy().engineVersion&&parse(v).schema==='libra.state_pipeline_receipt.v1'){hit=true;return true;}return write();});
   const r=await f.run();restore();assert.equal(r.completed,1);assert.equal(f.getHead().throughTurn,5);assert.equal(f.getRecords('libra.state_pipeline_receipt.v1').length,0);
   const head=JSON.stringify(f.getHead()),callsBeforeRetry=f.control.calls.length;const retry=await f.r.api.retryPendingUnifiedState();assert.equal(retry.recovered,1,JSON.stringify(retry));assert.equal(JSON.stringify(f.getHead()),head);assertCanonicalCalls(f,1);assert.equal(f.control.calls.length,callsBeforeRetry,'receipt recovery must make no additional physical provider call');
 });
 await test('source edit during provider cannot activate old analysis',async f=>{
   onCanonicalCall(f,async()=>{f.chat.message[0].data+=' 원문을 변경했다.';return success(f.control.artifact);});const r=await f.run();assert.equal(f.getMemory(),null,JSON.stringify(r));assertCanonicalCalls(f,1);assert.equal(f.getHead(),null);
 });
 for(const kind of ['head','registry'])await test(`${kind} changed during model call is preserved`,async f=>{
   let storageKey,inserted;
   onCanonicalCall(f,async()=>{const scope=f.getManifest().scopeKey;storageKey=`libra:v1:scope:${scope}:${kind==='head'?'continuity-state':'entity-registry:v2'}`;inserted=JSON.stringify({schema:kind==='head'?'libra.continuity_state.v2':'libra.entity_registry.v2',scopeKey:scope,userValue:'keep-external-edit',entities:[]});f.r.values.set(storageKey,inserted);return success(f.control.artifact);});
   const r=await f.run();assert.equal(f.getMemory(),null,JSON.stringify(r));assert.equal(f.r.values.get(storageKey),inserted);assertCanonicalCalls(f,1);
 });
 await test('chat identity changes during model call cannot write old current State',async f=>{
   onCanonicalCall(f,async()=>{f.chat.id='different-chat';f.chat.chatId='different-chat';return success(f.control.artifact);});await f.run();assert.ok(!f.getRecords('libra.continuity_state.v2').length);assertCanonicalCalls(f,1);assert.ok(!f.getRecords('libra.canonical_memory.v1').some(r=>r.value.status==='committed'));
 });
 await test('corrupted candidate readback never activates canonical',async f=>{
   let hit=false;const restore=wrapStorage(f,async(k,v,write)=>{const x=parse(v);if(!hit&&x.schema==='libra.canonical_memory.v1'&&x.status==='candidate'){hit=true;await write();f.r.values.set(k,JSON.stringify({...x,text:x.text+' corrupt candidate'}));return true;}return write();});
   const r=await f.run();restore();assert.ok(hit);assert.equal(f.getMemory(),null,JSON.stringify(r));assert.equal(f.getHead(),null);assertCanonicalCalls(f,1);
 });
 await test('source changed after canonical activation keeps canonical and blocks stale State retry',async f=>{
   let hit=false;const restore=wrapStorage(f,async(k,v,write)=>{if(!hit&&parse(v).schema==='libra.unified_state_tx.v1'){hit=true;f.chat.message[0].data+=' 뒤늦은 원문 변경';}return write();});
   const r=await f.run();restore();assert.equal(r.completed,1);const digest=f.getMemory().artifactDigest;assert.equal(f.getHead(),null);
   const callsBeforeRetry=f.control.calls.length;await f.r.api.retryPendingUnifiedState();assert.equal(f.getHead(),null);assert.equal(f.getMemory().artifactDigest,digest);assertCanonicalCalls(f,1);assert.equal(f.control.calls.length,callsBeforeRetry,'a stale State retry must make no additional physical provider call');
 });
 await test('verified local replay now works; manual prose edit still blocks before altering canonical',async f=>{
   await f.run();const head=JSON.stringify(f.getHead()),m=f.getMemory(),count=f.control.calls.length;
   let replay;try{replay=await f.r.api.rebuildWorldManagerState();}catch(e){replay={ok:false,error:e.message};}
   assert.equal(replay.ok,true,JSON.stringify({code:replay.code,error:replay.error}));assert.equal(replay.providerCalls,0);assert.equal(f.getHead().throughTurn,5);assert.equal(f.getMemory().artifactDigest,m.artifactDigest);assert.equal(f.control.calls.length,count);
   await assert.rejects(()=>f.r.api.createCanonicalEditDraft({startTurn:1}),/UNIFIED_PROSE_EDIT_UNSUPPORTED/);assert.equal(f.getRecords('libra.canonical_memory.v1').length,1);
 });
 await test('two consecutive canonical batches preserve stable IDs and reviewed/changed distinction',async f=>{
   const first=await f.run();assert.equal(first.completed,1);const original=f.getMemory(),h1=f.getHead();
   const extra=f.chat.message.slice(0,10).map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`}));f.chat.message.push(...extra);
   f.control.artifact=artifact();for(const x of [...f.control.artifact.entities,...f.control.artifact.facts])for(const e of x.evidenceSpans)e.ref=e.ref.replace(/^t(\d+)/,(_,n)=>`t${Number(n)+5}`);
   const second=await f.run();assert.equal(second.completed,1,JSON.stringify(second));assertCanonicalCalls(f,2);assert.equal(f.getMemory(6).artifactSchema,'libra.canonical_artifact.v4');const h2=f.getHead();assert.equal(h2.throughTurn,10);assert.equal(h2.characters.find(x=>x.name==='민아').id,h1.characters.find(x=>x.name==='민아').id);assert.equal(h2.domainStatus.characters.reviewedThroughTurn,10);assert.equal(h2.domainStatus.characters.changedThroughTurn,5);assert.equal(f.getMemory().artifactDigest,original.artifactDigest);
   assert.equal(f.getMemory(6).unifiedBasis.head,undefined);assert.equal(f.getRecords('libra.unified_basis_snapshot.v1').length,0);
 });
 console.log(JSON.stringify({test:'libra_unified_fault_recovery_v1',passed:results.length,results,guarantee:'single owner plugin_only fault injection, not multi-device atomic CAS'}));
})().catch(e=>{console.error(e);process.exitCode=1});
