'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture:createNativeFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {ownerFixture,envelope,NEW}=require('./fixtures/shared_reanalysis_owner_fixture.cjs');
// This direct-fixture path must also wait for real startup recovery, not API export.
const createFixture=async options=>{
 const f=await createNativeFixture(options),deadline=Date.now()+15000;
 while(!f.api.uiStatus().registered.after){
  if(Date.now()>=deadline){await f.dispose();throw Error('FLASHBACK_FIXTURE_STARTUP_TIMEOUT');}
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 return f;
};
for(const ids of ['none','user_only','assistant_only'])test('Flashback legacy '+ids+' keeps its existing positional reanalysis policy',async()=>{
 const rows=[{role:'user',data:'Question'},{role:'assistant',data:'Alice waited at the gate.'}];
 if(ids==='user_only')rows[0].chatId='u1';if(ids==='assistant_only')rows[1].chatId='a1';
 const f=await createFixture({chat:{message:rows}});try{
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  f.currentChat.message[1].data=NEW;const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,1,'legacy source is selectable after an explicit current-source list refresh');
  const result=await f.api.reanalyzeSelectedRanges(inventory);assert.equal(result.ok,true,JSON.stringify(result));
  const scope=await f.api.resolveCurrentScope(),records=(await f.api.inspectMemoryLedger(scope,{includeRecords:true})).records;assert.ok(records.some(r=>r.text.includes(NEW)));
  const fresh=await f.api.listReanalysisRanges();f.currentChat.message[1].chatId='new-native-identity';assert.notEqual((await f.api.reanalyzeSelectedRanges(fresh)).ok,true,'changed identity is never treated as the original positional selection');
 }finally{await f.dispose();}
});
test('Flashback cannot downgrade a native stored source to positional proof by dropping its IDs',async()=>{
 const f=await ownerFixture('flashback');try{for(const m of f.chat.message){delete m.id;delete m.chatId;}assert.equal((await f.api.listReanalysisRanges()).ranges.length,0);}finally{await f.dispose();}
});
test('HAYAKU legacy positions remain selectable without granting stable-native identity',async()=>{
 const f=await ownerFixture('hayaku',{beforeSeed:async r=>{for(const m of r.chat.message){delete m.id;delete m.chatId;}}});try{
  f.edit(NEW);const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,1);f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));
  const result=await f.api.reanalyzeSelectedRanges(inventory);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.calls(),1);
 }finally{await f.dispose();}
});
for(const change of ['edit','swap'])test('Flashback legacy positional '+change+' after listing requires a refreshed selection',async()=>{
 const rows=[{role:'user',data:'First question'},{role:'assistant',data:'Alice waits.'},{role:'user',data:'Second question'},{role:'assistant',data:'Bob leaves.'}];
 const f=await createFixture({chat:{message:rows}});try{
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'hash',embeddingModel:'hash-v1',embeddingEnabled:true,autoEpisodeIndex:false});await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,2);
  if(change==='edit')f.currentChat.message[1].data+=' A later edit.';else f.currentChat.message=[...f.currentChat.message.slice(2),...f.currentChat.message.slice(0,2)];f.currentChat.messages=f.currentChat.message;
  const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:[inventory.ranges[0]]});assert.notEqual(result.ok,true,JSON.stringify(result));assert.match(result.reason,/LEGACY_REFRESH_REQUIRED/);
  const fresh=await f.api.listReanalysisRanges();assert.equal((await f.api.reanalyzeSelectedRanges({...fresh,ranges:[fresh.ranges[0]]})).ok,true,'explicit refresh accepts the current legacy source');
 }finally{await f.dispose();}
});
test('HAYAKU positional legacy pair swap after listing is rejected before Other Ax',async()=>{
 const f=await ownerFixture('hayaku',{beforeSeed:async r=>{for(const m of r.chat.message){delete m.id;delete m.chatId;}const {createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');r.chat.message.push({role:'user',data:'Second question'},{role:'assistant',data:hiddenPacketMessage('Bob leaves.',createValidPacket({turn:2,subject:'Bob',scene:'office',summary:'Bob leaves.'}))});}});
 try{const inventory=await f.api.listReanalysisRanges();assert.equal(inventory.ranges.length,2);f.chat.message=[...f.chat.message.slice(2),...f.chat.message.slice(0,2)];f.chat.messages=f.chat.message;
  const result=await f.api.reanalyzeSelectedRanges({...inventory,ranges:[inventory.ranges[0]]});assert.notEqual(result.ok,true);assert.equal(f.calls(),0);
 }finally{await f.dispose();}
});
test('HAYAKU legacy edit after listing explains the needed refresh and then succeeds',async()=>{
 const f=await ownerFixture('hayaku',{beforeSeed:async r=>{for(const m of r.chat.message){delete m.id;delete m.chatId;}}});try{
  const inventory=await f.api.listReanalysisRanges();f.edit(NEW);const blocked=await f.api.reanalyzeSelectedRanges(inventory);assert.equal(blocked.ok,false);assert.match(blocked.reason,/LEGACY_REFRESH_REQUIRED/);assert.equal(f.calls(),0);
  const fresh=await f.api.listReanalysisRanges();f.respond(async()=>({type:'success',result:JSON.stringify(envelope(NEW))}));assert.equal((await f.api.reanalyzeSelectedRanges(fresh)).ok,true);
 }finally{await f.dispose();}
});
