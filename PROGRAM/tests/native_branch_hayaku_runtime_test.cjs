'use strict';
const assert=require('node:assert/strict');const {createHayakuRuntime,createValidPacket,hiddenPacketMessage}=require('./fixtures/hayaku_runtime_harness.cjs');
const {clone,branch}=require('./fixtures/native_branch_fixture.cjs');
(async()=>{
 const messages=[];for(let i=1;i<=7;i++)messages.push({role:'user',chatId:'u'+i,data:'User '+i},{role:'char',chatId:'a'+i,data:hiddenPacketMessage('Alice waited '+i+'.',createValidPacket({turn:i,subject:'Alice',scene:'office',summary:'Alice waited '+i+'.'}))});
 const f=await createHayakuRuntime({autoRepair:false,messages,chatId:'hayaku-parent',loadRetrace:true});try{
 const t=f.hayaku._test,scope=await t.currentChatScope();await t.reconcileObservedChatTopology(scope,t.authoritativeChatSnapshot(scope.chatMessages,scope),'native_branch_parent_fixture');
 const sourceKeys=new Map(f.pluginStorage.values);const p=clone(f.chat),b=branch(p,5,'hayaku-child');b.copiedFromChatId='stale-grandparent';Object.assign(f.chat,b);f.chat.messages=f.chat.message;f.character.chats=[f.chat,p];
 const target=await t.currentChatScope();assert.equal(target.hostLineage.inheritanceEligible,true,JSON.stringify(target.hostLineage));assert.equal(target.copiedFromChatId,p.id);assert.equal(t.isVerifiedNativeChatCopyScope(target),true);
 const snapshot=t.authoritativeChatSnapshot(target.chatMessages,target);assert.equal(snapshot.conversationPairs.length,5,'branch comment is not a response');
 await t.reconcileObservedChatTopology(target,snapshot,'native_branch_child_fixture');
 const ledger=await f.hayaku.ledger.inspect({includeRecords:true});assert.ok(ledger.records.length>0,'grounded copied packets available in child');
 const proof=await f.hayaku.getHostLineageStatus();assert.equal(proof.commonPrefixPairs,5);assert.equal(proof.parentChatId,p.id);
 assert.equal(f.llmCalls.length,0,'native packet copy does not call a model');
 // A user-ended branch marker is not a synthesized assistant response.
 const u=clone(p);u.id=u.chatId='user-ended';u.message=u.message.slice(0,9);u.message.push({role:'char',isComment:true,disabled:true,chatId:'m-u',data:`{{specialcomment::branchedfrom::${p.id}::P::u5::}}`});Object.assign(f.chat,u);f.chat.messages=f.chat.message;f.character.chats=[f.chat,p];
 const us=await t.currentChatScope();assert.equal(t.authoritativeChatSnapshot(us.chatMessages,us).conversationPairs.length,4);
 // Parent edit cannot be silently adopted by a future refresh.
 p.message[1].data+=' changed';const divergent=await t.currentChatScope();assert.equal(divergent.hostLineage.inheritanceEligible,false);assert.equal(t.isVerifiedNativeChatCopyScope(divergent),false);
 console.log(JSON.stringify({test:'native_branch_hayaku_runtime',passed:7}));
 }finally{await f.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1});
