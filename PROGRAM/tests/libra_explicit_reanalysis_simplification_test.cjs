'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const snapshot=f=>JSON.parse(JSON.stringify(f.getManifest().memories['1']));
async function initialized(options={}){const f=await fixture({...options,transformSource:source=>source.replace("const memoryStageEnabledForSettings =", "globalThis.__reanalysisCore=LibraMemoryCore;\n  const memoryStageEnabledForSettings =")});if(options.setup)await options.setup(f);assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();return f;}
const selection=async f=>{const inv=await f.r.api.listCanonicalBatchRanges();return {scopeKey:inv.scopeKey,mode:'source_edit',ranges:inv.ranges.filter(r=>r.startTurn===1)};};
const execute=async(f,s)=>f.r.api.startSelectedCanonicalBatches(s||await selection(f));

test('one explicit selection analyzes current edited source without a preview ticket',async()=>{const f=await initialized();try{
 const old=snapshot(f),bytes=f.r.values.get(old.key),calls=f.control.calls.length;
 f.chat.message[0].data+=' Current user edit.';
 const result=await execute(f);assert.equal(result.ok,true,JSON.stringify(result));
 const next=snapshot(f);assert.equal(next.status,'committed');assert.ok(next.revision>old.revision);assert.notEqual(next.sourceDigest,old.sourceDigest);
 assert.equal(f.r.values.get(old.key),bytes);assert.ok(f.control.calls.length>calls);
 assert.equal([...f.r.values.keys()].some(k=>k.includes(':source-edit-consent:')),false,'no tracking journal is created');
 }finally{await f.r.cleanup();}});

test('explicit selection can reanalyze any saved range, without a detected edit',async()=>{const f=await initialized();try{
 const old=snapshot(f),result=await execute(f);assert.equal(result.ok,true,JSON.stringify(result));assert.ok(snapshot(f).revision>old.revision);
 }finally{await f.r.cleanup();}});

test('editing after opening the range list uses current source on click',async()=>{const f=await initialized();try{
 const s=await selection(f),old=snapshot(f);f.chat.message[0].data+=' Edited after opening.';
 assert.equal((await execute(f,s)).ok,true);assert.notEqual(snapshot(f).sourceDigest,old.sourceDigest);
 }finally{await f.r.cleanup();}});

test('failed replacement preserves the prior committed ref and body',async()=>{const f=await initialized();try{
 const old=snapshot(f),bytes=f.r.values.get(old.key);f.chat.message[0].data+=' Edited text.';f.control.modelFails=true;
 let failed;try{failed=await execute(f);}catch(error){failed={ok:false,error:String(error)};}
 assert.notEqual(failed.ok,true);assert.deepEqual(snapshot(f),old);assert.equal(f.r.values.get(old.key),bytes);
 }finally{await f.r.cleanup();}});

test('read-only response keeps approved same-slot analysis after edits',async()=>{const f=await initialized();try{
 const old=snapshot(f);f.chat.message[0].data+=' Edited text.';
 const context=await f.r.context.__reanalysisCore.resolveContext();const pairs=f.r.context.__reanalysisCore.buildPairs(f.chat,context.scope.scopeKey);
 const view=await f.r.context.__reanalysisCore.buildReadOnlyResponseManifest(context,pairs,f.getManifest());
 assert.equal(view.manifest.memories['1'].status,'committed');assert.equal(view.manifest.memories['1'].key,old.key);
 }finally{await f.r.cleanup();}});

test('same-slot preservation does not admit changed message identity',async()=>{const f=await initialized();try{
 f.chat.message[1].chatId='another-assistant';const context=await f.r.context.__reanalysisCore.resolveContext();const pairs=f.r.context.__reanalysisCore.buildPairs(f.chat,context.scope.scopeKey);
 const view=await f.r.context.__reanalysisCore.buildReadOnlyResponseManifest(context,pairs,f.getManifest());assert.equal(view.manifest.memories['1'].status,'inactive');
 }finally{await f.r.cleanup();}});

test('identity change after selection is rejected before model work',async()=>{const f=await initialized();try{
 const s=await selection(f),calls=f.control.calls.length;f.chat.message[1].chatId='replacement-assistant';
 await assert.rejects(()=>execute(f,s),/identity|topology|scope/i);assert.equal(f.control.calls.length,calls);
 }finally{await f.r.cleanup();}});

test('tag-only source mutation during explicit generation does not refuse replacement',async()=>{const f=await initialized();try{
 f.chat.message[0].data+=' Edited text.';const old=snapshot(f);let changed=false;
 f.control.onCall=()=>{if(!changed){changed=true;f.chat.message[1].data+='<lb-xnai>{{inlay::image-only}}</lb-xnai>';}
 return {type:'success',result:JSON.stringify(f.control.artifact)};};
 const result=await execute(f);assert.equal(result.ok,true,JSON.stringify(result));assert.ok(snapshot(f).revision>old.revision);
 }finally{await f.r.cleanup();}});

test('source tracking code and settings are absent, optional input rules remain',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
 assert.equal(/function createMemorySuiteSourceEditConsent|sourceEditRequestSerial|suppressLibraSourceEditImpactForRequest|SOURCE_EDIT_SELECTION_PREVIEW_REQUIRED/.test(source),false);
 assert.equal(/setSourceEditTrackingMode|mountSourceEditTrackingControls/.test(source),false);
 assert.match(source,/setSourceEditRules/,'existing optional rule setter remains compatible');
});

for(const change of ['text','identity','scope','rollback'])test('explicit generation rejects '+change+' changes without replacing prior memory',async()=>{
 const f=await initialized();try{
  const old=snapshot(f),bytes=f.r.values.get(old.key);f.chat.message[0].data+=' Selected edit.';
  f.control.onCall=()=>{if(change==='text')f.chat.message[0].data+=' Late meaningful edit.';
   if(change==='identity')f.chat.message[1].chatId='other-a';if(change==='scope')f.chat.id=f.chat.chatId='another-chat';
   if(change==='rollback')f.chat.message.splice(6);return {type:'success',result:JSON.stringify(f.control.artifact)};};
  const result=await execute(f);assert.notEqual(result.ok,true);assert.equal(f.r.values.get(old.key),bytes);
  const oldManifest=[...f.r.values].filter(([k])=>k.endsWith(':manifest')).map(([,raw])=>JSON.parse(raw)).find(m=>m.memories?.['1']?.key===old.key);
  assert.ok(oldManifest,'previous body reference remains present');
 }finally{await f.r.cleanup();}
});

test('old tracking journal is neither read nor rewritten and requests do not analyze edits',async()=>{const f=await initialized();try{
 const old=snapshot(f),calls=f.control.calls.length,scopeKey=f.getManifest().scopeKey,key=`libra:v1:scope:${scopeKey}:source-edit-consent:v1`;
 const journal='{"schema":"legacy-corrupt-tracker","tasks":{"1":{"state":"failed"}}}';f.r.values.set(key,journal);
 f.chat.message[0].data+=' Current edit.';f.r.storageReads.length=0;
 await f.control.hooks.beforeRequest([{role:'user',content:'Who has the key?'}],'model');
 await f.control.hooks.afterRequest('', 'model');await selection(f);
 assert.equal(f.control.calls.length,calls);assert.equal(f.r.values.get(key),journal);
 assert.equal(f.r.storageReads.includes(key),false);assert.equal(snapshot(f).key,old.key);assert.equal(snapshot(f).status,'committed');
 }finally{await f.r.cleanup();}});

test('actual raw-capture publication during a tag-only edit retains the original consumed immutable provenance',async()=>{
 let listener;const f=await initialized({host:{addRisuChatListener:async(k,fn)=>{if(k==='output')listener=fn;return true;}},
  setup:f=>{f.chat.message.splice(9,0,{role:'assistant',chatId:'tag-only-carrier',data:'<lb-stage-marker>ORIGINAL_CARRIER</lb-stage-marker>'});}});
 try{const old=snapshot(f),oldBytes=f.r.values.get(old.key);f.chat.message[0].data+=' Selected edit.';
  const {waitFor}=require('./fixtures/libra_vm_harness.cjs');let consumedRefs=null,changed=false,newRef=null;
  f.control.onCall=async args=>{
   const match=String(args[0].messages[1].content).match(/\[VERIFIED ORIGINAL PACKET REFS\]\n([^\n]+)/);assert.ok(match);consumedRefs=JSON.parse(match[1]);
   assert.equal(changed,false);changed=true;f.chat.message[9].data='<lb-stage-marker>TAG_ONLY_CHANGED</lb-stage-marker>';
   listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:10});
   await waitFor(()=>f.r.api.getCaptureBackendState().lastOutputCapture?.rawDurable===true,10000);
   const current=await f.r.api.debugReadActiveRawPacket(5);assert.equal(current.status,'verified');newRef=current.rawPacketRef;
   assert.notEqual(newRef.packetDigest,consumedRefs[4].packetDigest);
   return {type:'success',result:JSON.stringify(f.control.artifact)};
  };
  const result=await execute(f);assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(f.getMemory().rawPacketRefs,consumedRefs,'committed analysis keeps precisely the refs the model consumed');
  assert.equal(f.r.values.get(old.key),oldBytes);assert.ok(snapshot(f).revision>old.revision);
 }finally{await f.r.cleanup();}
});

test('ordinary live scan does not analyze or mark a failed reanalysis for an edited committed slot',async()=>{const f=await initialized();try{
 const old=snapshot(f),calls=f.control.calls.length;f.chat.message[0].data+=' Plain source edit.';
 const result=await f.r.context.__reanalysisCore.scan({mode:'live'});
 assert.equal(result.processed,0,JSON.stringify(result));assert.equal(result.failed,0,JSON.stringify(result));
 assert.equal(f.control.calls.length,calls);assert.deepEqual(snapshot(f),old);
 }finally{await f.r.cleanup();}});

test('successful canonical replacement reports success when derived state needs retry',async()=>{const f=await initialized();try{
 const old=snapshot(f);f.chat.message[0].data+=' Explicit update.';
 const storage=f.r.context.risuai.pluginStorage,set=storage.setItem;let hit=false;
 storage.setItem=async(k,v)=>{let value;try{value=JSON.parse(v);}catch{}if(!hit&&value?.schema==='libra.continuity_state.v2'){hit=true;return true;}return set(k,v);};
 const result=await execute(f);assert.equal(hit,true);assert.ok(snapshot(f).revision>old.revision,'canonical replacement committed');
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.job.state,'completed_with_warnings');
 }finally{await f.r.cleanup();}});

test('selecting an earlier range leaves the unselected later canonical body and revision untouched',async()=>{
 const {artifact}=require('./fixtures/libra_unified_runtime_fixture.cjs');const f=await fixture();
 try{
  f.chat.message.push(...f.chat.message.slice().map((m,i)=>({...m,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`})));
  f.control.onCall=async args=>{const a=artifact();if(JSON.stringify(args).includes('[t6-u]'))for(const row of [...a.entities,...a.facts])for(const span of row.evidenceSpans)span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>'t'+(+n+5));return {type:'success',result:JSON.stringify(a)};};
  assert.equal((await f.run()).completed,2);await f.r.api.retryPendingUnifiedVectors();
  const later={...f.getManifest().memories['6']},bytes=f.r.values.get(later.key),calls=f.control.calls.length;
  f.chat.message[0].data+=' Edited first batch only.';const result=await execute(f);assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.control.calls.length,calls+1);assert.equal(f.getManifest().memories['6'].revision,later.revision);assert.equal(f.r.values.get(later.key),bytes);
 }finally{await f.r.cleanup();}
});

for(const phase of ['before_provider','provider_return','candidate_write'])test('immutable consumed raw corruption is refused at '+phase,async()=>{
 const f=await initialized();try{
  const old=snapshot(f),bytes=f.r.values.get(old.key);f.chat.message[0].data+=' Explicit edit.';let corrupted=false;
  const corrupt=()=>{const candidates=[...f.r.values].filter(([k])=>k.includes(':source-receipt:')).map(([k,v])=>[k,JSON.parse(v)]);
   const [key,record]=candidates.find(([,value])=>value.turn===5);record.rawSourcePacket.assistant.segments[0].rawValue+=' TAMPERED';f.r.values.set(key,JSON.stringify(record));corrupted=true;};
  if(phase==='before_provider')corrupt();
  if(phase==='provider_return')f.control.onCall=()=>{corrupt();return {type:'success',result:JSON.stringify(f.control.artifact)};};
  if(phase==='candidate_write'){const storage=f.r.context.risuai.pluginStorage,set=storage.setItem;storage.setItem=async(k,v)=>{const result=await set(k,v);let value;try{value=JSON.parse(v);}catch{}if(!corrupted&&value?.schema==='libra.canonical_memory.v1'&&value.status==='candidate')corrupt();return result;};}
  const result=await execute(f);assert.equal(corrupted,true);assert.notEqual(result.ok,true);assert.equal(snapshot(f).key,old.key);assert.equal(f.r.values.get(old.key),bytes);
 }finally{await f.r.cleanup();}
});
