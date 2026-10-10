'use strict';
const assert=require('node:assert/strict');
const {createLibraVmHarness,waitFor}=require('./fixtures/libra_vm_harness.cjs');
const {clone,parent,branch,character}=require('./fixtures/native_branch_fixture.cjs');
(async()=>{
 const source=parent('parent',5),char=character([source]);let current=source,calls=0,listener;
 source.message[1].data='Alice signed the agreement.';
 const host={addRisuChatListener:async(_kind,handler)=>{listener=handler;return true;},
 getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>char.chats.indexOf(current),
 getCharacter:async()=>clone(char),getCharacterFromIndex:async()=>clone(char),getChat:async()=>clone(current),getCurrentChat:async()=>clone(current),getChatFromIndex:async(_c,i)=>clone(char.chats[i]),
 getDatabase:async fields=>{const db={personas:[],selectedPersona:'',characters:[clone(char)],plugins:[]};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db},
 runLLMModel:async(options)=>{if(!JSON.stringify(options).includes('LIBRA STATE NARRATIVE OBSERVER'))calls++;const quote=source.message[1].data;return {type:'success',result:JSON.stringify(require('./fixtures/librarian_event_fixture.cjs')(quote,'t1-a'))}}};
 const r=await createLibraVmHarness({enable_character_ito:false,enable_world_ito:false,enable_plot_ito:false},host);
 try{
  const settings=await r.api.getLibraMemorySettings();await r.api.saveLibraMemorySettings({...settings,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,stateTrackingEnabled:false});
  // The branch-copy contract needs settled Micro evidence. Replay real completed-output
  // events for T1..T4; cold-start reconciliation alone has no durable no-call proof and
  // correctly leaves historical Micro analysis unknown until a manual retry.
  assert.equal(typeof listener,'function');
  const fullMessages=source.message;
  for(let turn=1;turn<=4;turn++){
   source.message=fullMessages.slice(0,turn*2);
   listener({char,chat:source,characterIndex:0,chatIndex:0,messageIndex:turn*2-1});
   await waitFor(()=>r.api.getCaptureBackendState().lastMicroPublication?.turn===turn,15000);
  }
  source.message=fullMessages;
  const job=await r.api.runManualColdStart();assert.equal(job.completed,1,JSON.stringify(job));await r.api.retryPendingUnifiedVectors();
  const key=[...r.values.keys()].find(k=>k.startsWith('libra')&&k.endsWith(':manifest'));const m=JSON.parse(r.values.get(key)),ref=m.memories['1'];const canon=r.values.get(ref.key),bytes=r.values.get(key),count=calls;
  // Parent progresses AFTER the fork. The old canonical remains eligible, no model call.
  source.message.push(...parent('extra',7).message.slice(10));
  current=branch(source,5,'valid-child');current.copiedFromChatId='stale-ancestor';char.chats.unshift(current);
  const adopted=await r.api.debugNativeChatCopy({force:true});
  assert.equal(adopted.result.ok,true,JSON.stringify(adopted));
  assert.equal(calls,count,'copy is non-generative');
  const proof=await r.api.getHostLineageStatus();assert.equal(proof.parentChatId,'parent');assert.equal(proof.commonPrefixPairs,5);
  const targets=[...r.values.entries()].filter(([k,v])=>k.endsWith(':manifest')&&k.startsWith('libra')).map(([k,v])=>JSON.parse(v));
  const target=targets.find(x=>x.chatId==='valid-child');assert.ok(target,JSON.stringify(targets.map(x=>x.chatId)));assert.equal(target.nativeChatCopy.durableVerified,true);assert.equal(Object.keys(target.memories).length,1);assert.equal(target.nativeChatCopy.hostLineage.parentChatId,'parent');
  assert.equal(r.values.get(ref.key),canon,'source canonical immutable');assert.equal(r.values.get(key),bytes,'source manifest unchanged');
  current=branch(source,4,'boundary-child');char.chats.unshift(current);const partial=await r.api.debugNativeChatCopy({force:true});
  // Branch contract as of 'e6d1ba22 Preserve Micro graph in native chat copies': a branch whose shared
  // prefix has no committed 5-turn Canonical batch is no longer refused when that prefix still carries
  // per-turn Micro evidence - the evidence is copied so the reader does not lose turns they already
  // wrote (see libra_micro_native_copy_precanonical_test for the same case at T1). The boundary that
  // still holds is CANONICAL: with expectedStartTurns empty there is no committed batch to inherit, so
  // the target must receive no Canonical memory. The previous revision of this suite asserted the copy
  // itself was refused; that assertion described the pre-Micro contract.
  assert.equal(partial.result?.ok,true,JSON.stringify(partial));
  assert.equal(Number((partial.result?.expectedStartTurns||[]).length),0,'the shared prefix has no committed Canonical batch');
  assert.equal(calls,count,'boundary copy is non-generative');
  const boundaryTargets=[...r.values.entries()].filter(([k,v])=>k.endsWith(':manifest')&&k.startsWith('libra')).map(([k,v])=>JSON.parse(v));
  const boundaryTarget=boundaryTargets.find(x=>x.chatId==='boundary-child');
  assert.ok(boundaryTarget,JSON.stringify(boundaryTargets.map(x=>x.chatId)));
  assert.equal(Object.keys(boundaryTarget.memories).length,0,'no Canonical memory is inherited without a committed batch');
  assert.ok(Number(partial.result?.verifiedMicroRecords||0)>0,'the per-turn Micro evidence is preserved');
  current=branch(source,5,'edited-child');current.message[1].data='Alice refused.';char.chats.unshift(current);const changed=await r.api.debugNativeChatCopy({force:true});assert.notEqual(changed.result?.ok,true,JSON.stringify(changed));
  assert.equal((await r.api.getHostLineageStatus()).status,'diverged');assert.equal(calls,count,'no auto reanalysis bypass on divergent source');
  assert.equal(r.values.get(ref.key),canon);console.log(JSON.stringify({test:'native_branch_libra_runtime',passed:9}));
 }finally{await r.cleanup()}
})().catch(e=>{console.error(e);process.exitCode=1});
