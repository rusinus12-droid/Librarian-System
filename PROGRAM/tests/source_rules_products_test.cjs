'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const rules={ignoredTags:['@html-comment'],unwrapTags:['wrapper'],sourceTags:['original']};
const empty={ignoredTags:[],unwrapTags:[],sourceTags:[]};
async function transitions(api,message,snapshot,initial){
 const raw=message.data;message.data='번역문\n<original>\n'+raw+'\n</original>';let s=await snapshot();assert.equal(s.units[0].sourceDigest,initial.units[0].sourceDigest,'first wrapping preserves stored digest');
 message.data='재번역문\n<original>\n'+raw+'\n</original>';assert.equal((await snapshot()).units[0].sourceDigest,initial.units[0].sourceDigest);
 message.data='<original><wrapper>'+raw+'</wrapper></original>';assert.equal((await snapshot()).units[0].sourceDigest,initial.units[0].sourceDigest);
 message.data='<original>'+raw+' 실제 원문 변경</original>';assert.notEqual((await snapshot()).units[0].sourceDigest,initial.units[0].sourceDigest);
 message.data=raw;await api.setSourceEditRules(empty);const base=await snapshot();message.data=raw+'<hayaku_packet_contract>control</hayaku_packet_contract><!-- HAYAKU_STATE_PACKET_START {} HAYAKU_STATE_PACKET_END -->[FLASHBACK EVIDENCE]control[/FLASHBACK EVIDENCE]';assert.equal((await snapshot()).units[0].sourceDigest,base.units[0].sourceDigest,'internal envelopes stay excluded with empty external rules');message.data=raw+'<Thoughts>changed</Thoughts><img src="changed"><!-- changed -->';assert.notEqual((await snapshot()).units[0].sourceDigest,base.units[0].sourceDigest,'all empty retains default-control edits');
 await api.setSourceEditRules({ignoredTags:['thoughts','img','@html-comment'],sourceTags:[],unwrapTags:[]});const restored=await snapshot();const decorated=message.data;message.data=raw;assert.equal((await snapshot()).units[0].sourceDigest,restored.units[0].sourceDigest,'explicit defaults can be restored with warm caches');message.data=decorated;
 assert.ok(message.data.includes('changed'),'host raw remains unchanged');
}
(async()=>{
 const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');const f=await fixture();try{
 assert.equal((await f.run()).completed,1);const legacy=await f.r.api.listCanonicalBatchRanges().then(x=>({units:x.ranges.map(r=>({...r,sourceDigest:r.sourceDigest}))}));await f.r.api.setSourceEditRules(rules);assert.equal((await f.r.api.listCanonicalBatchRanges().then(x=>({units:x.ranges.map(r=>({...r,sourceDigest:r.sourceDigest}))}))).units[0].sourceDigest,legacy.units[0].sourceDigest);await transitions(f.r.api,f.chat.message[9],()=>f.r.api.listCanonicalBatchRanges().then(x=>({units:x.ranges.map(r=>({...r,sourceDigest:r.sourceDigest}))})),await f.r.api.listCanonicalBatchRanges().then(x=>({units:x.ranges.map(r=>({...r,sourceDigest:r.sourceDigest}))})));console.log('PASS LIBRA stored memory + source-rule transitions');
 }finally{await f.r.cleanup();}
 const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');const h=await createHayakuRuntime({autoRepair:false,messages:[{role:'user',chatId:'u1',data:'Question'},{role:'assistant',chatId:'a1',data:hiddenPacketMessage('Alice waited.',createValidPacket({turn:1,subject:'Alice',scene:'office',summary:'Alice waited.'}))}]});try{
 await h.hayaku.setSourceEditRules(rules);const t=h.hayaku._test,scope=await t.currentChatScope();await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'rule_test');await transitions(h.hayaku,h.chat.message[1],()=>t.hayakuSourceEditSnapshot(),await t.hayakuSourceEditSnapshot());console.log('PASS HAYAKU ledger + source-rule transitions');
 }finally{await h.dispose();}
 const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');const source=fs.readFileSync(path.join(__dirname,'../plugins/Flashback_Memory.js'),'utf8');const b=await createFixture({source});try{
 await b.api.setSourceEditRules(rules);b.currentChat.message=[{role:'user',chatId:'u1',data:'Question'},{role:'assistant',chatId:'a1',data:'Alice waited.'}];b.currentChat.messages=b.currentChat.message;await b.api.saveSettings({...await b.api.loadSettings(),embeddingEnabled:false,autoEpisodeIndex:false});await b.api.ingestLiveChatColdStart({scope:'current',canonical:true});await transitions(b.api,b.currentChat.message[1],()=>b.api._test.flashbackSourceEditSnapshot(),await b.api._test.flashbackSourceEditSnapshot());console.log('PASS Flashback persisted text + source-rule transitions');
 }finally{await b.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
