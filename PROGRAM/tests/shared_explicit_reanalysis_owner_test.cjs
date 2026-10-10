'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {ownerFixture,envelope,OLD,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
for(const owner of ['hayaku','flashback']){
 test(owner+' public selection includes unchanged stored turns and applies without an edit journal',async()=>{
  const f=await ownerFixture(owner);try{
   const reads=[],writes=[],get=f.store.getItem.bind(f.store),set=f.store.setItem.bind(f.store);f.store.getItem=async k=>{reads.push(k);return get(k)};f.store.setItem=async(k,v)=>{writes.push(k);return set(k,v)};
   const selection=await f.api.previewSourceEdits(['1']);assert.equal(selection.allowed,true,JSON.stringify(selection));
   f.respond(async()=>({type:'success',result:JSON.stringify(envelope(OLD))}));
   const result=await f.api.applySourceEdits(selection);assert.equal(result.ok,true,JSON.stringify(result));
   assert.equal(f.calls(),owner==='hayaku'?1:0);
   assert.equal([...reads,...writes].some(k=>/source-edit-consent|hayaku\.v2\.source-edit\./.test(k)),false,'no tracker storage is accessed');
  }finally{await f.dispose();}
 });
 test(owner+' reads current text on action after opening the list',async()=>{
  const f=await ownerFixture(owner);try{
   f.edit('Alice considered the agreement.');const selection=await f.api.previewSourceEdits(['1']);assert.equal(selection.allowed,true,JSON.stringify(selection));
   f.edit(NEW);f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
   const result=await f.api.applySourceEdits(selection);assert.equal(result.ok,true,JSON.stringify(result));
   assert.ok((await f.records()).some(r=>JSON.stringify(r).includes(NEW)));assert.equal(f.calls(),owner==='hayaku'?1:0);
  }finally{await f.dispose();}
 });
 test(owner+' refuses message identity replacement after selection without work',async()=>{
  const f=await ownerFixture(owner);try{
   f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);assert.equal(selection.allowed,true,JSON.stringify(selection));
   f.chat.message[1].id=f.chat.message[1].chatId='different';
   let result;try{result=await f.api.applySourceEdits(selection)}catch(e){result={ok:false,error:String(e)}}assert.notEqual(result.ok,true);assert.equal(f.calls(),0);
  }finally{await f.dispose();}
 });
 test(owner+' source contains input policy but no journal controller or tracking mode API',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../plugins',owner==='hayaku'?'HAYAKU_Locator_Continuity.js':'Flashback_Memory.js'),'utf8');
  assert.equal(/function createMemorySuiteSourceEditConsent|setSourceEditTrackingMode:|protectionOnly/.test(source),false);
  assert.match(source,/createMemorySuiteSourceInputPolicy/);
 });
}
for(const owner of ['hayaku','flashback']){
 for(const change of ['scope','deletion'])test(owner+' rejects '+change+' after listing and preserves existing data',async()=>{
  const f=await ownerFixture(owner);try{const before=JSON.stringify(await f.records()),selection=await f.api.previewSourceEdits(['1']);assert.equal(selection.allowed,true);
   if(change==='scope')f.chat.id=f.chat.chatId='another-chat';else f.chat.message.splice(1);
   let result;try{result=await f.api.applySourceEdits(selection)}catch(error){result={ok:false}}assert.notEqual(result.ok,true);assert.equal(f.calls(),0);
   assert.ok([...f.store.values.values()].some(v=>typeof v==='string'&&v.includes('Alice signed')));
  }finally{await f.dispose();}
 });
 test(owner+' settings and range reads retain approved memories and ignore corrupt legacy journal',async()=>{
  const f=await ownerFixture(owner);try{
   const initial=await f.api.listReanalysisRanges(),key=owner==='hayaku'?`hayaku.v2.source-edit.${initial.scopeKey}`:[...f.store.values.keys()].find(k=>k.endsWith(':manifest:v2')).replace(/:manifest:v2$/,':source-edit-consent:v1');
   f.store.values.set(key,'{corrupt legacy journal');const reads=[],get=f.store.getItem.bind(f.store);f.store.getItem=async k=>{reads.push(k);return get(k)};
   f.edit(NEW);await f.api.setSourceEditRules({version:1,ignoredTags:['decoration'],unwrapTags:[],sourceTags:[],controls:[]});
   await f.api.listReanalysisRanges();await f.api.previewSourceEdits(['1']);
   if(owner==='hayaku'){await f.r.callBeforeRequest([{role:'user',content:'What was established?'}],'model');await f.r.callAfterRequest('','model');
    const rows=await f.records();assert.ok(rows.some(r=>r.recordState==='active'&&JSON.stringify(r).includes(OLD)),JSON.stringify(rows.map(r=>({state:r.recordState,reason:r.divergenceReason}))));
    const recovery=await f.api._test.inspectRecoveryDebtsForNativeRepair();assert.equal(recovery.coverage?.missingTurns?.length??recovery.missingTurns?.length??0,0,'editing alone creates no missing-turn debt');
   }else{const rows=await f.records(),kept=f.api._test.applyRecallHardGates(rows,{scopeKey:initial.scopeKey});assert.ok(kept.some(r=>r.text.includes(OLD)));}
   assert.equal(reads.includes(key),false);assert.equal(f.store.values.get(key),'{corrupt legacy journal');assert.equal(f.calls(),0);
  }finally{await f.dispose();}
 });
}
test('hayaku retains prior packet on model failure',async()=>{const f=await ownerFixture('hayaku');try{
 const before=await f.records();f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);f.respond(async()=>({type:'fail',error:'synthetic provider failure'}));
 const result=await f.api.applySourceEdits(selection);assert.notEqual(result.ok,true);const after=await f.records();assert.ok(after.some(r=>r.recordState==='active'&&before.some(old=>old.hash===r.hash&&old.raw===r.raw)),JSON.stringify(after.map(r=>({state:r.recordState,hash:r.hash}))));
}finally{await f.dispose();}});
for(const change of ['text','identity','scope','deletion'])test('hayaku in-flight '+change+' is rejected before packet replacement',async()=>{const f=await ownerFixture('hayaku');try{
 const before=await f.records();f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);f.respond(async()=>{
  if(change==='text')f.edit(NEW+' A later meaningful change.');if(change==='identity')f.chat.message[1].chatId='late-replacement';if(change==='scope')f.chat.id=f.chat.chatId='late-chat';if(change==='deletion')f.chat.message.splice(1);
  return {type:'success',result:JSON.stringify(envelope(NEW))};});
 const result=await f.api.applySourceEdits(selection);assert.notEqual(result.ok,true);assert.ok([...f.store.values.values()].some(v=>typeof v==='string'&&v.includes(before[0].hash)));
}finally{await f.dispose();}});
test('hayaku tag-only edit during generation retains consumed immutable raw and succeeds',async()=>{const f=await ownerFixture('hayaku');try{
 f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);const consumed=f.chat.message[1].data;
 f.respond(async()=>{f.chat.message[1].data+='<lb-xnai>{{inlay::presentation-only}}</lb-xnai>';return {type:'success',result:JSON.stringify(envelope(NEW))};});
 const result=await f.api.applySourceEdits(selection);assert.equal(result.ok,true,JSON.stringify(result));
 const after=await f.records(),record=after.find(r=>r.recordState==='active'&&r.sourceEvidenceRef&&JSON.stringify(r).includes(NEW));assert.ok(record);
 const raw=JSON.parse(await f.store.getItem(record.sourceEvidenceRef.key));assert.equal(raw.rows[0].assistantRaw,consumed);
}finally{await f.dispose();}});
test('hayaku corrupted consumed immutable evidence refuses replacement',async()=>{const f=await ownerFixture('hayaku');try{
 f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);let corrupted=false;
 f.respond(async()=>{for(const [key,value]of f.store.values){if(!key.includes('source-evidence'))continue;let record;try{record=JSON.parse(value)}catch{continue}if(record.rows?.[0]?.assistantText===NEW){record.rows[0].assistantRaw+=' TAMPERED';f.store.values.set(key,JSON.stringify(record));corrupted=true;break;}}
  return {type:'success',result:JSON.stringify(envelope(NEW))};});
 const result=await f.api.applySourceEdits(selection);assert.equal(corrupted,true,'consumed raw is durable before provider dispatch');assert.notEqual(result.ok,true);
}finally{await f.dispose();}});
for(const change of ['text','identity','scope','deletion','tag'])test('flashback '+change+' during raw commit keeps transactional safety',async()=>{
 const f=await ownerFixture('flashback');try{
  const before=await f.records();f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);
  const set=f.store.setItem.bind(f.store);let hit=false;
  f.store.setItem=async(key,value)=>{const result=await set(key,value);
   if(!hit&&String(key).includes(':shard:')&&String(value).includes(NEW)){hit=true;
    if(change==='text')f.edit(NEW+' Late meaningful change.');if(change==='identity')f.chat.message[1].chatId='late-other';
    if(change==='scope')f.chat.id=f.chat.chatId='late-other';if(change==='deletion')f.chat.message.splice(1);
    if(change==='tag')f.chat.message[1].data+='<lb-xnai>{{inlay::only-image}}</lb-xnai>';
   }return result;};
  const result=await f.api.applySourceEdits(selection);assert.equal(hit,true,'mutation reached actual owner raw storage write');
  assert.equal(result.ok,change==='tag',JSON.stringify(result));assert.equal(f.calls(),0);
  if(change==='scope')f.chat.id=f.chat.chatId='flashback-host-chat';
  const after=await f.records();
  if(change!=='tag')assert.deepEqual(after.map(r=>[r.hash,r.text]),before.map(r=>[r.hash,r.text]));
  else assert.ok(after.some(r=>r.text.includes(NEW)));
 }finally{await f.dispose();}
});
test('flashback raw publication failure keeps prior canonical raw',async()=>{
 const f=await ownerFixture('flashback');try{const before=await f.records();f.edit(NEW);const selection=await f.api.previewSourceEdits(['1']);const set=f.store.setItem.bind(f.store);let hit=false;
 f.store.setItem=async(key,value)=>{if(!hit&&String(key).includes(':shard:')&&String(value).includes(NEW)){hit=true;return false;}return set(key,value)};
 const result=await f.api.applySourceEdits(selection);assert.equal(hit,true);assert.notEqual(result.ok,true);assert.deepEqual((await f.records()).map(r=>[r.hash,r.text]),before.map(r=>[r.hash,r.text]));
 }finally{await f.dispose();}
});
test('hayaku repeated same direct action shares one native execution',async()=>{const f=await ownerFixture('hayaku');try{
 f.edit(NEW);const inventory=await f.api.listReanalysisRanges(),selection={...inventory};let release,entered;
 const started=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>release=resolve);
 f.respond(async()=>{entered();await wait;return {type:'success',result:JSON.stringify(envelope(NEW))}});
 const first=f.api.reanalyzeSelectedRanges(selection);await started;const second=f.api.reanalyzeSelectedRanges(selection);release();
 assert.equal((await first).ok,true);assert.equal((await second).ok,true);assert.equal(f.calls(),1);
 }finally{await f.dispose();}
});
for(const owner of ['hayaku','flashback'])test(owner+' input policy edits are blocked during an ordinary active model request',async()=>{
 const f=await ownerFixture(owner);try{
  if(owner==='hayaku')await f.r.callBeforeRequest([{role:'user',content:'Continue.'}],'model');else await f.api._selectionTest.beforeRequest([{role:'user',content:'Continue.'}],'model');
  await assert.rejects(()=>f.api.setSourceEditRules({version:1,ignoredTags:['decoration'],unwrapTags:[],sourceTags:[],controls:[]}),/BUSY/);
  if(owner==='hayaku')await f.r.callAfterRequest('','model');else await f.api._selectionTest.afterRequest('','model');
 }finally{await f.dispose();}
});
for(const owner of ['hayaku','flashback'])test(owner+' selected first turn preserves the unselected later stored turn',async()=>{
 const f=await ownerFixture(owner);try{
  const later='Bob waited by the window.';let data=later;
  if(owner==='hayaku'){const {createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');data=hiddenPacketMessage(later,createValidPacket({turn:2,subject:'Bob',scene:'office',summary:later}));}
  f.chat.message.push({role:'user',chatId:'u2',data:'What does Bob do?'},{role:'assistant',chatId:'a2',data});f.chat.messages=f.chat.message;
  if(owner==='hayaku'){await f.r.callBeforeRequest([{role:'user',content:'Recall both turns.'}],'model');await f.r.callAfterRequest('','model');}
  else await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const before=await f.records(),old=before.find(r=>owner==='hayaku'?r.targetPairIndex===2:(r.responseTurnIndex||r.pairIndex||r.turnIndex)===2);assert.ok(old);
  const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,2);f.edit(NEW);f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});assert.equal(result.ok,true,JSON.stringify(result));
  const rows=await f.records(),same=rows.find(r=>r.hash===old.hash);assert.ok(same);assert.equal(same.raw||same.text,old.raw||old.text);
  assert.equal(owner==='hayaku'?same.recordState:(same.lifecycleStatus||'active'),'active',JSON.stringify({same,before:old}));assert.equal(f.calls(),owner==='hayaku'?1:0);
 }finally{await f.dispose();}
});
for(const owner of ['hayaku','flashback'])test(owner+' disabled owner refuses explicit reanalysis before work',async()=>{
 const f=await ownerFixture(owner);try{const inventory=await f.api.listReanalysisRanges();
  if(owner==='hayaku'){const result=await f.api.settingsControl.apply({hayaku_enabled:'false'});assert.equal(result.ok,true);assert.equal(f.api.settings().enabled,false);}
  else await f.api.saveSettings({...await f.api.loadSettings(),mode:'off'});
  f.respond(async()=>({type:'success',result:JSON.stringify(envelope(OLD))}));const result=await f.api.reanalyzeSelectedRanges(inventory);assert.notEqual(result.ok,true);assert.equal(f.calls(),0);
 }finally{await f.dispose();}
});
async function hayakuWithSuffix(){const f=await ownerFixture('hayaku');const {createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');const summary='Bob waited by the window.';f.chat.message.push({role:'user',chatId:'u2',data:'What does Bob do?'},{role:'assistant',chatId:'a2',data:hiddenPacketMessage(summary,createValidPacket({turn:2,subject:'Bob',scene:'office',summary}))});f.chat.messages=f.chat.message;await f.r.callBeforeRequest([{role:'user',content:'Recall.'}],'model');await f.r.callAfterRequest('','model');return f;}
test('failed selected replacement leaves every previously active suffix owner unchanged',async()=>{const f=await hayakuWithSuffix();try{
 const before=await f.records();f.edit(NEW);const inventory=await f.api.listReanalysisRanges();f.respond(async()=>({type:'fail',error:'synthetic failure'}));
 const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});assert.notEqual(result.ok,true);
 const after=await f.records();for(const record of before.filter(r=>r.recordState==='active')){const same=after.find(r=>r.recordId===record.recordId);assert.ok(same);assert.equal(same.recordState,'active');assert.equal(same.ownerTurnNodeId,record.ownerTurnNodeId);assert.equal(same.raw,record.raw);}
}finally{await f.dispose();}});
test('failed explicit regeneration cannot publish a newly pasted inline packet before model success',async()=>{const f=await ownerFixture('hayaku');try{
 const before=await f.records(),{createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
 f.chat.message[1].data=hiddenPacketMessage(NEW,createValidPacket({turn:1,subject:'Alice',scene:'office',summary:NEW}));const inventory=await f.api.listReanalysisRanges();f.respond(async()=>({type:'fail',error:'synthetic failure'}));
 const result=await f.api.reanalyzeSelectedRanges(inventory);assert.notEqual(result.ok,true);
 const after=await f.records();assert.deepEqual(after.filter(r=>r.recordState==='active').map(r=>[r.hash,r.raw]),before.filter(r=>r.recordState==='active').map(r=>[r.hash,r.raw]));
}finally{await f.dispose();}});
for(const change of ['raw','identity','inactive','other_branch'])test('unselected packet '+change+' never receives the explicit preservation rebind',async()=>{const f=await hayakuWithSuffix();try{
 const inspected=await f.api.ledger.inspect({includeRecords:true}),key=inspected.storageKey,old=inspected.records.find(r=>r.targetPairIndex===2&&r.recordState==='active');assert.ok(old);
 // Remove the inline carrier so the native importer cannot legitimately repair
 // the damaged packet from an independently valid host copy. Visible text is unchanged.
 f.chat.message[3].data='Bob waited by the window.';
 const corrupt=()=>{const value=JSON.parse(f.store.values.get(key)),row=value.records.find(r=>r.recordId===old.recordId);assert.ok(row);
  if(change==='raw')row.raw+=' CORRUPTED';if(change==='identity')row.userMessageIdHash='foreign-user';
  if(change==='inactive'){row.recordState='superseded';row.auditRetained=true;}
  if(change==='other_branch'){row.ownerTurnNodeId='foreign-branch';row.userMessageIdHash='foreign-user';row.assistantMessageIdHash='foreign-assistant';row.recordState='quarantined';row.auditRetained=true;}
  f.store.values.set(key,JSON.stringify(value));};
 if(change==='inactive'||change==='other_branch')corrupt();
 f.edit(NEW);const inventory=await f.api.listReanalysisRanges();f.respond(async()=>{if(change==='raw'||change==='identity')corrupt();return {type:'success',result:JSON.stringify(envelope(NEW))};});
 await f.api.reanalyzeSelectedRanges({...inventory,ranges:inventory.ranges.filter(r=>r.key==='1')});
 const after=(await f.records()).find(r=>r.recordId===old.recordId);assert.ok(!after||after.recordState!=='active',JSON.stringify(after));
}finally{await f.dispose();}});
test('successful explicit regeneration commits the staged current inline carrier only with native adoption',async()=>{const f=await ownerFixture('hayaku');try{
 const {createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');f.chat.message[1].data=hiddenPacketMessage(NEW,createValidPacket({turn:1,subject:'Alice',scene:'office',summary:NEW}));
 const inventory=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
 const result=await f.api.reanalyzeSelectedRanges(inventory);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.calls(),1);
 const active=(await f.records()).filter(r=>r.recordState==='active');assert.ok(active.some(r=>r.packetType==='recovery_snapshot'&&JSON.stringify(r).includes(NEW)));
}finally{await f.dispose();}});
