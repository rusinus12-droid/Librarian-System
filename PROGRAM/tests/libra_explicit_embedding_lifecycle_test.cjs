'use strict';
// Explicit range selection is read-only; execution is the one user action. No tracker ticket exists.
const currentSelection=async f=>{const inv=await f.r.api.listCanonicalBatchRanges();return {allowed:true,scopeKey:inv.scopeKey,mode:'source_edit',ranges:inv.ranges.filter(r=>r.startTurn===1)};};
const applySelection=async(f,selection)=>{try{return await f.r.api.startSelectedCanonicalBatches(selection);}catch(e){return {ok:false,reason:String(e.message||e)};}};

const assert=require('node:assert/strict');const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
const config={enabled:true,provider:'openai',url:'https://synthetic.invalid/v1/embeddings',model:'text-embedding-3-small',key:'synthetic-fixture-only',dimensions:256,maxRetries:0};
(async()=>{const results=[];for(const change of ['none','source','scope','revision']){const f=await fixture();let release,entered=false,returned=false;try{
 await f.r.api.saveEmbeddingSettings({...config,enabled:false});await f.run();const oldRef=f.getManifest().memories['1'],oldBytes=f.r.values.get(oldRef.key);
 await f.r.api.saveEmbeddingSettings(config);f.r.context.risuai.nativeFetch=async(url,init)=>{entered=true;await new Promise(r=>release=r);returned=true;const input=JSON.parse(init.body).input;return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:Array.from({length:256},(_,i)=>i===0?1:0)})),usage:{total_tokens:10}}),{status:200})};
 // Selection does not need a request-boundary tracker refresh. A real beforeRequest
 // would independently perform query embedding while the old canonical remains visible.
 f.chat.message[9].data+=' 추가 확인된 문장입니다.';
 const ticket=await currentSelection(f);assert.equal(ticket.allowed,true,JSON.stringify(ticket));assert.equal(entered,false,'preview did not embed');
 const result=await applySelection(f,ticket);assert.equal(result.ok,true,JSON.stringify(result));await waitFor(()=>entered);
 const ref={...f.getManifest().memories['1']},memory=f.getMemory();assert.equal(memory.embedding.status,'pending');assert.equal(ref.revision,2);assert.equal(f.r.values.get(oldRef.key),oldBytes,'prior canonical untouched');
 if(change==='source')f.chat.message[0].data+=' source changed while embedding waited';
 if(change==='scope'){f.chat.id='other-scope';f.chat.chatId='other-scope';}
 if(change==='revision'){const key=[...f.r.values.keys()].find(k=>k.endsWith(':manifest')&&k.startsWith('libra'));const manifest=JSON.parse(f.r.values.get(key));manifest.memories['1']={...oldRef};f.r.values.set(key,JSON.stringify(manifest));}
 release();await waitFor(()=>returned);await new Promise(r=>setTimeout(r,100));
 const stored=JSON.parse(f.r.values.get(ref.key));
 if(change==='none'){await waitFor(()=>JSON.parse(f.r.values.get(ref.key)).embedding.status==='ready');assert.equal(JSON.parse(f.r.values.get(ref.key)).embedding.dimensions,256)}
 else{assert.notEqual(stored.embedding.status,'ready','stale explicit vector must not publish after '+change);assert.equal(f.getRecords('libra.embedding_projection.v2').length,0)}
 assert.equal(stored.sourceDigest,memory.sourceDigest);assert.equal(stored.artifactDigest,memory.artifactDigest);
 results.push({change,from:'pending',to:JSON.parse(f.r.values.get(ref.key)).embedding.status,priorCanonicalPreserved:true});
 }finally{release?.();await f.r.cleanup()}}
 console.log(JSON.stringify({test:'libra_explicit_embedding_lifecycle',passed:results.length,results,network:'controlled in-process nativeFetch only'}));})().catch(e=>{console.error(e);process.exitCode=1});
