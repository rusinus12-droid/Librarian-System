'use strict';
const {createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {ownerFixture,envelope,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
const canon=rows=>JSON.parse(JSON.stringify(rows.filter(r=>(r.recordState||r.lifecycleStatus||'active')==='active').map(r=>[r.recordId||r.id,r.hash,r.raw||r.text,r.ownerTurnNodeId||r.turnNodeId])));
for(const owner of ['hayaku','flashback'])for(const phase of (owner==='hayaku'?['write','readback']:['write','readback','worldline','final_manifest']))for(const change of ['identity','text','scope','deletion','tag'])test(`${owner} ${phase} publication ${change} preserves guarded ownership`,async()=>{
 const f=await ownerFixture(owner);try{
  const before=canon(await f.records()),oldId=f.chat.id,oldChatId=f.chat.chatId;
  const key=owner==='hayaku'?(await f.api.ledger.inspect({includeRecords:true})).storageKey:[...f.store.values.keys()].find(k=>k.endsWith(':manifest:v2'));
  const oldRaw=f.store.values.get(key);f.edit(NEW);const consumed=f.chat.message[1].data;
  const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  let hit=false,published=false,writes=0;
  const mutate=()=>{hit=true;if(change==='identity')f.chat.message[1].id=f.chat.message[1].chatId='other-id';if(change==='text')f.edit(NEW+' Another fact.');if(change==='scope')f.chat.id=f.chat.chatId='other-chat';if(change==='deletion')f.chat.message.splice(1);if(change==='tag')f.chat.message[1].data+='<lb-xnai>{{inlay::visual}}</lb-xnai>';};
  const set=f.store.setItem.bind(f.store),get=f.store.getItem.bind(f.store);
  f.store.setItem=async(k,v)=>{if(k===key&&v!==oldRaw){writes++;published=true;}
   if(!hit&&((phase==='write'&&k===key&&v!==oldRaw)||(phase==='worldline'&&String(k).endsWith(':turn_worldline:v1'))||(phase==='final_manifest'&&k===key&&writes===2)))mutate();return set(k,v);};
  f.store.getItem=async k=>{const v=await get(k);if(!hit&&phase==='readback'&&published&&k===key)mutate();return v;};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true,'real publication boundary reached');assert.equal(result.ok,change==='tag',JSON.stringify(result));
  f.chat.id=oldId;f.chat.chatId=oldChatId;
  const after=await f.records();if(change!=='tag')assert.deepEqual(canon(after),before);else if(owner==='hayaku'){
   const r=after.find(r=>r.recordState==='active'&&r.sourceEvidenceRef);const raw=JSON.parse(await get(r.sourceEvidenceRef.key));assert.equal(raw.rows[0].assistantRaw,consumed);
  }else assert.ok(after.some(r=>r.text.includes(NEW)));
 }finally{await f.dispose();}
});
for(const owner of ['hayaku','flashback'])test(owner+' final publication foreign head is never rolled back',async()=>{
 const f=await ownerFixture(owner);try{
  const key=owner==='hayaku'?(await f.api.ledger.inspect({includeRecords:true})).storageKey:[...f.store.values.keys()].find(k=>k.endsWith(':manifest:v2'));
  const oldRaw=f.store.values.get(key);f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const set=f.store.setItem.bind(f.store);let foreign='',hit=false;
  f.store.setItem=async(k,v)=>{const r=await set(k,v);if(!hit&&k===key&&v!==oldRaw){hit=true;f.chat.message[1].id=f.chat.message[1].chatId='other-id';foreign=JSON.stringify({...JSON.parse(v),foreignWriterMarker:'owned-by-another-operation'});f.store.values.set(k,foreign);}return r;};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true);assert.equal(result.ok,false);assert.match(result.reason,/CONFLICT/);assert.equal(f.store.values.get(key),foreign);
 }finally{await f.dispose();}
});
for(const owner of ['hayaku','flashback'])for(const behavior of ['reject','lost_ack'])test(owner+' final publication '+behavior+' follows actual readback without duplicate commit',async()=>{
 const f=await ownerFixture(owner);try{
  const before=canon(await f.records());const key=owner==='hayaku'?(await f.api.ledger.inspect({includeRecords:true})).storageKey:[...f.store.values.keys()].find(k=>k.endsWith(':manifest:v2'));
  const oldRaw=f.store.values.get(key);f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const set=f.store.setItem.bind(f.store);let hit=false,count=0;
  f.store.setItem=async(k,v)=>{if(k===key&&v!==oldRaw){count++;if(!hit){hit=true;if(behavior==='lost_ack')await set(k,v);throw Error('synthetic publication '+behavior);}}return set(k,v);};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true);assert.equal(result.ok,behavior==='lost_ack',JSON.stringify(result));
  if(behavior==='reject')assert.deepEqual(canon(await f.records()),before);else assert.ok((await f.records()).some(r=>JSON.stringify(r).includes(NEW)));
  assert.equal(count,behavior==='lost_ack'&&owner==='flashback'?2:1);
 }finally{await f.dispose();}
});
for(const owner of ['hayaku','flashback'])for(const mode of ['mirror','server_only'])test(`${owner} ${mode} real server publication late identity restores previous canonical ownership`,async()=>{
 const {createHandlerFixture}=require('./fixtures/shared_reanalysis_handler_fixture.cjs');const server=createHandlerFixture();let f,armed=false,hit=false;
 try{
  const nativeFetch=async(input,options={})=>{const result=await server.nativeFetch(input,options);let body;try{body=JSON.parse(options.body)}catch{}
   const key=body?.key||body?.mutations?.[0]?.key||'';
   if(armed&&!hit&&String(options.method).toUpperCase()==='POST'&&(owner==='hayaku'?String(key).includes('hayaku.v2.ledger.'):String(key).endsWith(':manifest:v2'))){hit=true;f.chat.message[1].id=f.chat.message[1].chatId='late-server-identity';}
   return result;};
  f=await ownerFixture(owner,{arguments:{memory_suite_server_mode:mode,memory_suite_server_url:server.url},nativeFetch});
  const before=canon(await f.records());f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));armed=true;
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true,'actual server canonical publication');assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(canon(await f.records()),before);
 }finally{await f?.dispose();await server.close();}
});
test('hayaku identity change during the last consumed-evidence readback restores previous canonical ownership',async()=>{
 const f=await ownerFixture('hayaku');try{
  const before=canon(await f.records()),key=(await f.api.ledger.inspect({includeRecords:true})).storageKey;f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const get=f.store.getItem.bind(f.store),set=f.store.setItem.bind(f.store);let published=false,hit=false;
  f.store.setItem=async(k,v)=>{const r=await set(k,v);if(k===key&&String(v).includes(NEW))published=true;return r;};
  f.store.getItem=async k=>{const r=await get(k);if(published&&!hit&&String(k).includes('source-evidence')){hit=true;f.chat.message[1].id=f.chat.message[1].chatId='changed-during-last-evidence-read';}return r;};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true);assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(canon(await f.records()),before);
 }finally{await f.dispose();}
});
test('flashback identity change during the last worldline readback restores previous canonical ownership',async()=>{
 const f=await ownerFixture('flashback');try{
  const before=canon(await f.records()),key=[...f.store.values.keys()].find(k=>k.endsWith(':manifest:v2'));f.edit(NEW);const selection=await f.api.listReanalysisRanges();
  const get=f.store.getItem.bind(f.store),set=f.store.setItem.bind(f.store);let publications=0,reads=0,hit=false;
  f.store.setItem=async(k,v)=>{const r=await set(k,v);if(k===key)publications++;return r;};
  f.store.getItem=async k=>{const r=await get(k);if(publications===2&&String(k).endsWith(':turn_worldline:v1')&&++reads===2){hit=true;f.chat.message[1].id=f.chat.message[1].chatId='changed-during-last-worldline-read';}return r;};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true);assert.equal(result.ok,false,JSON.stringify(result));assert.deepEqual(canon(await f.records()),before);
 }finally{await f.dispose();}
});
for(const timing of ['before','inflight'])test('hayaku '+timing+' quarantined suffix is not revived by preservation rebind',async()=>{
 const f=await ownerFixture('hayaku');try{
  const text='Bob waited by the window.';
  f.chat.message.push({role:'user',chatId:'u2',data:'What does Bob do?'},{role:'assistant',chatId:'a2',data:hiddenPacketMessage(text,createValidPacket({turn:2,subject:'Bob',summary:text}))});f.chat.messages=f.chat.message;
  await f.r.callBeforeRequest([{role:'user',content:'Recall.'}],'model');await f.r.callAfterRequest('','model');
  const inspected=await f.api.ledger.inspect({includeRecords:true});const old=inspected.records.find(r=>r.targetPairIndex===2&&r.recordState==='active');assert.ok(old);f.chat.message[3].data=text;
  const deactivate=()=>{const data=JSON.parse(f.store.values.get(inspected.storageKey));const row=data.records.find(r=>r.recordId===old.recordId);row.recordState='quarantined';row.auditRetained=true;f.store.values.set(inspected.storageKey,JSON.stringify(data));};
  if(timing==='before')deactivate();f.edit(NEW);const listed=await f.api.listReanalysisRanges();
  f.respond(async()=>{if(timing==='inflight')deactivate();return{type:'success',result:JSON.stringify(envelope(NEW))}});
  const result=await f.api.reanalyzeSelectedRanges({...listed,ranges:listed.ranges.filter(r=>r.key==='1')});
  const row=(await f.records()).find(r=>r.recordId===old.recordId);
  console.log('REVIEW_SUFFIX_STATE '+JSON.stringify({timing,result:result.ok,state:row?.recordState,ownerChanged:row?.ownerTurnNodeId!==old.ownerTurnNodeId}));
  assert.notEqual(row?.recordState,'active');
 }finally{await f.dispose();}
});
test('hayaku delayed publication settles under the explicit guard without a stale automatic replay',async()=>{
 const f=await ownerFixture('hayaku',{transformSource:s=>s.replace('const HOST_API_CALL_TIMEOUT_MS = 1500;','const HOST_API_CALL_TIMEOUT_MS = 100;')});try{
  const before=canon(await f.records()),key=(await f.api.ledger.inspect({includeRecords:true})).storageKey;f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const set=f.store.setItem.bind(f.store);let hit=false,settled;const completion=new Promise(r=>settled=r);let count=0;
  f.store.setItem=async(k,v)=>{if(k===key&&String(v).includes(NEW)){count++;if(!hit){hit=true;await new Promise(r=>setTimeout(r,180));f.chat.message[1].id=f.chat.message[1].chatId='changed-during-pending-write';const result=await set(k,v);settled();return result;}}return set(k,v);};
  const result=await f.api.reanalyzeSelectedRanges(selection);await completion;console.log('DELAY_RESULT',JSON.stringify(result));assert.equal(hit,true);assert.equal(result.ok,false);assert.deepEqual(canon(await f.records()),before);assert.equal(count,1);
 }finally{await f.dispose();}
});
test('flashback delayed publication retains prior ownership until the timed-out original settles',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8').replace('const STORAGE_IO_TIMEOUT_MS = 60000;','const STORAGE_IO_TIMEOUT_MS = 100;');
 const f=await ownerFixture('flashback',{source});try{
  const before=canon(await f.records()),key=[...f.store.values.keys()].find(k=>k.endsWith(':manifest:v2'));f.edit(NEW);const selection=await f.api.listReanalysisRanges();
  const set=f.store.setItem.bind(f.store);let hit=false,settled;const completion=new Promise(r=>settled=r);let count=0;
  f.store.setItem=async(k,v)=>{if(k===key){count++;if(!hit){hit=true;await new Promise(r=>setTimeout(r,180));f.chat.message[1].id=f.chat.message[1].chatId='changed-during-pending-write';const result=await set(k,v);settled();return result;}}return set(k,v);};
  const result=await f.api.reanalyzeSelectedRanges(selection);await completion;console.log('DELAY_RESULT',JSON.stringify(result));assert.equal(hit,true);assert.equal(result.ok,false);assert.deepEqual(canon(await f.records()),before);assert.equal(count,2,'one original write and one exact-owner restoration');
 }finally{await f.dispose();}
});
test('hayaku supported same-key ABA cannot give a failed publication rollback ownership',async()=>{
 const f=await ownerFixture('hayaku',{transformSource:s=>s.replace('    globalThis.HAYAKU = exposedApi;','    globalThis.__publicationWrite=RisuCompat.setStorageItemOutcome;\n    globalThis.HAYAKU = exposedApi;')});try{
  const key=(await f.api.ledger.inspect({includeRecords:true})).storageKey;f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const set=f.store.setItem.bind(f.store);let hit=false,last='';
  f.store.setItem=async(k,v)=>{const r=await set(k,v);if(!hit&&k===key&&String(v).includes(NEW)){hit=true;f.chat.message[1].id=f.chat.message[1].chatId='changed-with-aba';last=v;
   await f.r.context.__publicationWrite(k,JSON.stringify({...JSON.parse(v),foreignWriterMarker:'intervening-write'}));await f.r.context.__publicationWrite(k,v);
  }return r;};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true);assert.equal(result.ok,false);assert.match(result.reason,/RESTORE_CONFLICT/);assert.equal(f.store.values.get(key),last);
 }finally{await f.dispose();}
});

test('explicit indeterminate readback cannot replay through the general recovery journal',async()=>{
 const f=await ownerFixture('hayaku');try{
  const key=(await f.api.ledger.inspect({includeRecords:true})).storageKey,old=f.store.values.get(key);f.edit(NEW);const selection=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const set=f.store.setItem.bind(f.store),get=f.store.getItem.bind(f.store);let published=false,hidden=false,writes=0,journal=false;
  f.store.setItem=async(k,v)=>{if(k===key&&String(v).includes(NEW)){writes++;published=true;}if(published&&String(k).includes('storage_reconciliation')){journal=true;f.chat.message[1].id=f.chat.message[1].chatId='changed-before-general-replay';f.store.values.set(key,old);}return set(k,v);};
  f.store.getItem=async k=>{const value=await get(k);if(k===key&&published&&!hidden){hidden=true;return null;}return value;};
  const result=await f.api.reanalyzeSelectedRanges(selection);await new Promise(r=>setTimeout(r,100));
  console.log('READBACK_REPLAY',JSON.stringify({result,writes,journal}));assert.equal(hidden,true);assert.equal(result.ok,false);assert.equal(journal,false,'manual uncertainty cannot enter unguarded generic replay');assert.equal(writes,1);
 }finally{await f.dispose();}
});
test('hayaku multi-turn late publication identity failure keeps all prior canonical selections',async()=>{
 const f=await ownerFixture('hayaku');try{
  const later='Alice waited by the window.',edited='Alice left the window.';
  const packet=createValidPacket({turn:2,subject:'Alice',scene:'office',summary:later});
  f.chat.message.push({role:'user',id:'u2',chatId:'u2',data:'What does Alice do next?'},{role:'assistant',id:'a2',chatId:'a2',data:hiddenPacketMessage(later,packet)});f.chat.messages=f.chat.message;
  await f.r.callBeforeRequest([{role:'user',content:'Recall both turns.'}],'model');await f.r.callAfterRequest('','model');
  const originalSecond=(await f.records()).find(r=>r.targetPairIndex===2&&r.recordState==='active');assert.ok(originalSecond);
  f.edit(NEW);f.chat.message[3].data=hiddenPacketMessage(edited,packet);const selection=await f.api.listReanalysisRanges();assert.equal(selection.ranges.length,2);
  let calls=0;f.respond(async()=>{const e=envelope(++calls===1?NEW:edited);if(calls===2)e.packet.world.time='turn-2';return{type:'success',result:JSON.stringify(e)};});
  const key=(await f.api.ledger.inspect({includeRecords:true})).storageKey,set=f.store.setItem.bind(f.store);let hit=false,priorSecond;
  f.store.setItem=async(k,v)=>{if(!hit&&k===key){const candidate=JSON.parse(v);if(candidate.records.some(r=>r.targetPairIndex===2&&r.recordState==='active'&&r.raw?.includes(edited))){hit=true;priorSecond=JSON.parse(f.store.values.get(k)).records.find(r=>r.recordId===originalSecond.recordId);f.chat.message[3].id=f.chat.message[3].chatId='late-second-selection';}}return set(k,v);};
  const result=await f.api.reanalyzeSelectedRanges(selection);assert.equal(hit,true);assert.equal(result.ok,false);const after=await f.records();
  assert.ok(after.some(r=>r.targetPairIndex===1&&r.recordState==='active'&&!r.raw.includes(NEW)),'a multi-turn batch has no partial publication');
  const second=after.find(r=>r.recordId===priorSecond.recordId);const proof=r=>({recordId:r.recordId,hash:r.hash,owner:r.ownerTurnNodeId,state:r.recordState,audit:r.auditRetained,userId:r.userMessageIdHash,assistantId:r.assistantMessageIdHash});
  console.log('PARTIAL_BATCH_PROOF',JSON.stringify({before:proof(originalSecond),beforeSecondPublication:proof(priorSecond),after:proof(second)}));
  assert.equal(priorSecond.recordState,'active','pending selected canon must remain active until its own replacement succeeds');assert.equal(second.recordState,'active');assert.equal(second.ownerTurnNodeId,priorSecond.ownerTurnNodeId);assert.equal(second.hash,priorSecond.hash);
 }finally{await f.dispose();}
});
async function multiFixture(){
 const f=await ownerFixture('hayaku'),later='Alice waited by the window.',edited='Alice left the window.';
 const packet=createValidPacket({turn:2,subject:'Alice',scene:'office',summary:later});
 f.chat.message.push({role:'user',id:'u2',chatId:'u2',data:'What does Alice do next?'},{role:'assistant',id:'a2',chatId:'a2',data:hiddenPacketMessage(later,packet)});f.chat.messages=f.chat.message;
 await f.r.callBeforeRequest([{role:'user',content:'Recall both turns.'}],'model');await f.r.callAfterRequest('','model');
 const old=canon(await f.records());f.edit(NEW);f.chat.message[3].data=hiddenPacketMessage(edited,packet);
 return {...f,old,later,edited,selection:await f.api.listReanalysisRanges()};
}
for(const change of ['model_failure','identity','tag','success','foreign_head'])test('hayaku atomic multi-turn '+change+' uses one guarded publication',async()=>{
 const f=await multiFixture();try{
  const key=(await f.api.ledger.inspect({includeRecords:true})).storageKey,raws=[f.chat.message[1].data,f.chat.message[3].data];let calls=0,publications=0,foreign='';
  f.respond(async()=>{calls++;if(change==='model_failure'&&calls>=2)return{type:'fail',error:'second candidate failed'};if(calls===2){if(change==='identity')f.chat.message[3].id=f.chat.message[3].chatId='late-second';if(change==='tag')f.chat.message[3].data+='<lb-xnai>{{inlay::visual}}</lb-xnai>';}
   const e=envelope(calls===1?NEW:f.edited);if(calls===2)e.packet.world.time='turn-2';return{type:'success',result:JSON.stringify(e)};});
  const set=f.store.setItem.bind(f.store);f.store.setItem=async(k,v)=>{const r=await set(k,v);if(k===key&&String(v).includes(NEW)){publications++;if(change==='foreign_head'&&!foreign){f.chat.message[1].id=f.chat.message[1].chatId='late-foreign';foreign=JSON.stringify({...JSON.parse(v),foreignWriterMarker:'after-batch-publication'});f.store.values.set(k,foreign);}}return r;};
  const result=await f.api.reanalyzeSelectedRanges(f.selection);const success=['tag','success'].includes(change);assert.equal(result.ok,success,JSON.stringify(result));if(change==='model_failure')assert.ok(calls>=2);else assert.equal(calls,2);
  if(change==='foreign_head'){assert.match(result.reason,/CONFLICT/);assert.equal(f.store.values.get(key),foreign);}else if(!success){assert.deepEqual(canon(await f.records()),f.old);assert.equal(publications,0,'no selected canon is published before every candidate and identity is valid');}
  else {assert.equal(publications,1,'one native ledger publication for the complete explicit batch');const rows=(await f.records()).filter(r=>r.recordState==='active');assert.equal(rows.length,2);for(const r of rows){const raw=JSON.parse(await f.store.getItem(r.sourceEvidenceRef.key));assert.equal(raw.rows[0].assistantRaw,raws[r.targetPairIndex-1]);}}
 }finally{await f.dispose();}
});
for(const suffixState of ['active','quarantined'])test('hayaku multi-turn batch preserves the unselected '+suffixState+' suffix policy',async()=>{
 const f=await multiFixture();try{
  const later='Bob waited by the doorway.';f.chat.message.push({role:'user',id:'u3',chatId:'u3',data:'What does Bob do?'},{role:'assistant',id:'a3',chatId:'a3',data:hiddenPacketMessage(later,createValidPacket({turn:3,subject:'Bob',summary:later}))});
  // Seed suffix using the native transport before admitting the explicit batch.
  await f.r.callBeforeRequest([{role:'user',content:'Recall.'}],'model');await f.r.callAfterRequest('','model');
  const before=await f.records(),suffix=before.find(r=>r.targetPairIndex===3&&r.recordState==='active');assert.ok(suffix);f.chat.message[5].data=later;
  const inventory=await f.api.listReanalysisRanges();let calls=0;f.respond(async()=>{if(calls===0&&suffixState==='quarantined'){const key=(await f.api.ledger.inspect({includeRecords:true})).storageKey,data=JSON.parse(f.store.values.get(key));const row=data.records.find(r=>r.recordId===suffix.recordId);row.recordState='quarantined';row.auditRetained=true;f.store.values.set(key,JSON.stringify(data));}const e=envelope(++calls===1?NEW:f.edited);return{type:'success',result:JSON.stringify(e)};});
  const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key!=='3')});assert.equal(result.ok,true,JSON.stringify(result));
  const kept=(await f.records()).find(r=>r.recordId===suffix.recordId);if(suffixState==='active')assert.equal(kept.recordState,'active');else assert.notEqual(kept.recordState,'active');assert.equal(kept.raw,suffix.raw);
 }finally{await f.dispose();}
});
test('hayaku a failed later operation cannot roll back a separate committed selection',async()=>{
 const f=await multiFixture();try{
  f.chat.message[3].data=hiddenPacketMessage(f.later,createValidPacket({turn:2,subject:'Alice',scene:'office',summary:f.later}));
  let inventory=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  assert.equal((await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')})).ok,true);
  const committed=canon(await f.records());f.chat.message[3].data=hiddenPacketMessage(f.edited,createValidPacket({turn:2,subject:'Alice',scene:'office',summary:f.later}));inventory=await f.api.listReanalysisRanges();
  f.respond(async()=>({type:'success',result:JSON.stringify(envelope(f.edited))}));const key=(await f.api.ledger.inspect({includeRecords:true})).storageKey,set=f.store.setItem.bind(f.store);let hit=false;
  f.store.setItem=async(k,v)=>{if(!hit&&k===key&&JSON.parse(v).records.some(r=>r.targetPairIndex===2&&r.recordState==='active'&&r.raw.includes(f.edited))){hit=true;f.chat.message[3].id=f.chat.message[3].chatId='later-operation-drift';}return set(k,v);};
  const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='2')});assert.equal(hit,true);assert.equal(result.ok,false);assert.deepEqual(canon(await f.records()),committed);
 }finally{await f.dispose();}
});
test('hayaku atomic multi-turn interrupted staging cannot bypass its source guard through the ordinary choice API',async()=>{
 const f=await multiFixture();try{
  let calls=0;f.respond(async()=>({type:'success',result:JSON.stringify(envelope(++calls===1?NEW:f.edited))}));
  const set=f.store.setItem.bind(f.store);let staged='';
  f.store.setItem=async(k,v)=>{const r=await set(k,v);let run;try{run=JSON.parse(v)}catch{}
   if(!staged&&run?.replacementRecordIds?.length&&run?.chunks?.length===2&&run.state==='adopting'&&run.chunks.every(c=>c.status==='verified')){staged=run.runId;f.chat.message[3].id=f.chat.message[3].chatId='changed-at-staging';}return r;};
  const result=await f.api.reanalyzeSelectedRanges(f.selection);assert.ok(staged);assert.equal(result.ok,false);assert.deepEqual(canon(await f.records()),f.old);
  f.chat.message[3].id=f.chat.message[3].chatId='a2';const ordinary=await f.api.recovery.resolveRegenerationChoice('adopt_regenerated',{runId:staged});assert.equal(ordinary.ok,false);assert.equal(ordinary.reason,'regeneration_candidate_not_waiting');assert.deepEqual(canon(await f.records()),f.old);
 }finally{await f.dispose();}
});
test('hayaku atomic multi-turn fresh explicit retry cannot reuse a previous partial model result',async()=>{
 const f=await multiFixture();try{
  let calls=0;f.respond(async()=>{calls++;return calls===1?{type:'success',result:JSON.stringify(envelope(NEW))}:{type:'fail',error:'second stage failed'};});
  const first=await f.api.reanalyzeSelectedRanges(f.selection);assert.equal(first.ok,false);assert.deepEqual(canon(await f.records()),f.old);
  let retryCalls=0;f.respond(async()=>({type:'success',result:JSON.stringify(envelope(++retryCalls===1?NEW:f.edited))}));
  const result=await f.api.reanalyzeSelectedRanges(await f.api.listReanalysisRanges());assert.equal(result.ok,true,JSON.stringify(result));assert.equal(retryCalls,2);
 }finally{await f.dispose();}
});
