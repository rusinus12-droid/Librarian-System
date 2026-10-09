'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {clone,parent,branch}=require('./fixtures/native_branch_fixture.cjs');
(async()=>{
 const f=await createFixture();try{
 const t=f.api._test,p=parent('fb-parent',8);Object.assign(f.currentChat,p);f.character.chats=[f.currentChat];
 const snapshot=chat=>({character:clone(f.character),chat:clone(chat),db:{personas:[],selectedPersona:''},chatInfo:{characterIndex:0,chatIndex:0}});
 const from=t.resolveScopeFromSnapshot(snapshot(f.currentChat));const cfg=t.normalizeSettings({embeddingProvider:'hash',hashDimensions:8,shardSize:50});
 const records=[];for(let i=1;i<=8;i++){
 const r=t.cleanRecordForMemory({id:'record-'+i,sourceType:'response',sourceId:`${p.id}:turn:${i}`,text:`User:\nUser ${i}\n\n---\n\nAssistant:\nAssistant ${i}`,title:'Turn '+i,scopeKey:from.scopeKey,pairIndex:i,turnIndex:i,tags:[],tokenCount:8,tokens:8,vector:[1,0,0,0,0,0,0,0],dim:8,provider:'hash',model:'hash-8',embeddingProvider:'hash',embeddingModel:'hash-8',embeddingDimensions:8,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lifecycleStatus:'active',sourceHash:'turn-'+i},from,{authoritativeSource:true}).record;
 assert.ok(r);records.push(r);
 }
 await t.saveAllRecords(records,cfg,from);await t.retireExternalRecordsForScope(from);const before=JSON.stringify(await t.loadScopeRecords(from));const sourceCommit=(await t.loadScopeManifest(from)).commitId;
 const parentSnapshot=clone(f.currentChat);const child=branch(parentSnapshot,5,'fb-child');child.copiedFromChatId='wrong-grandparent';Object.assign(f.currentChat,child);f.character.chats=[f.currentChat,parentSnapshot];
 const to=t.resolveScopeFromSnapshot(snapshot(f.currentChat));assert.equal(to.copiedFromChatId,'fb-parent');
 assert.equal(t.normalizeStoredChatMessages(f.currentChat,to.scopeKey).length,10,'native comment excluded from pair records');
 const copied=await t.cloneScopeStorage(from,to,cfg,{mode:'chat_copy_live',reason:'native_branch_test'});assert.equal(copied.ok,true,JSON.stringify(copied));
 const loaded=await t.loadScopeRecords(to);assert.equal(loaded.records.length,5,JSON.stringify(loaded.records.map(r=>({turn:r.pairIndex,text:r.text}))));assert.ok(loaded.records.every(r=>r.pairIndex<=5));
 const manifest=await t.loadScopeManifest(to);assert.equal(manifest.copyAdoptedComplete,true);assert.equal(manifest.nativeBranchCopy.rawSourceVerified,true);assert.equal(manifest.nativeBranchCopy.verifiedPrefixPairs,5);assert.equal(manifest.episodeCount,0);
 assert.equal((await t.loadScopeManifest(from)).commitId,sourceCommit);assert.equal(JSON.stringify(await t.loadScopeRecords(from)),before,'parent storage remains identical');
 // Select sibling while copy is awaiting storage. No complete target manifest may be activated.
 const race=branch(parentSnapshot,5,'fb-race');Object.assign(f.currentChat,race);f.character.chats=[f.currentChat,parentSnapshot];const raceScope=t.resolveScopeFromSnapshot(snapshot(f.currentChat));
 const originalSet=f.pluginStorage.setItem.bind(f.pluginStorage);let faultTriggered=false;
 f.pluginStorage.setItem=async(k,v)=>{const done=await originalSet(k,v);if(!faultTriggered&&String(k).includes('shard')&&String(v).includes('fb-race')){faultTriggered=true;f.currentChat.message[1].data+=' edited while copy';}return done;};
 // Trigger at a definite source read boundary after the initial host proof instead of relying on storage key shape.
 const originalGet=f.host.getCharacterFromIndex;let reads=0;
 f.host.getCharacter=f.host.getCharacterFromIndex=async(...args)=>{reads++;if(reads===2)f.currentChat.message[1].data+=' late edit';return clone(await originalGet.apply(f.host,args))};
 await assert.rejects(()=>t.cloneScopeStorage(from,raceScope,cfg,{mode:'chat_copy_live'}),/native_branch/);
 assert.notEqual((await t.loadScopeManifest(raceScope)).copyAdoptedComplete,true);assert.equal((await t.loadScopeManifest(from)).commitId,sourceCommit);
 console.log(JSON.stringify({test:'native_branch_flashback_runtime',passed:8}));
 }finally{await f.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1});
