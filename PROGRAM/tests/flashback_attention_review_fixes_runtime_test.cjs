'use strict';
// Whole plugin, actual owner storage and public restore/repair. Provider traffic is synthetic.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const chat=()=>({message:[{role:'user',chatId:'u1',data:'Where is the brass key?'},{role:'assistant',chatId:'a1',data:'The brass key is under the blue sundial.'}]});
async function seed({ingest=true,source,embedding=false,nativeFetch}={}) {
  const f=await createFixture({pauseScheduledTimers:true,chat:chat(),source,nativeFetch});
  const cfg=await f.api.loadSettings();cfg.embeddingEnabled=embedding;
  cfg.episodeIndexEnabled=false;cfg.autoEpisodeIndex=false;cfg.episodeHierarchyEnabled=false;
  await f.api.saveSettings(cfg);
  if(ingest)await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
  return {f,t:f.api._test,cfg,scope:await f.api.resolveCurrentScope(true)};
}
test('public archive restore preserves logical coverage and attention inspection writes nothing',async()=>{
  const {f,t}=await seed();try{
    const backup=await f.context.__FlashbackPortableMemoryBackup.exportCurrentScope();
    f.currentChat.id='restored-chat';f.currentChat.chatId='restored-chat';
    assert.equal((await f.context.__FlashbackPortableMemoryBackup.restoreCurrentScope(backup,{mode:'chat_migration_archive'})).ok,true);
    const scope=await f.api.resolveCurrentScope(true);
    await t.retireExternalRecordsForScope(scope.scopeKey);
    const logical=await t.loadScopeRecords(scope.scopeKey);
    assert.equal(logical.manifest.localCount,0);assert.equal(logical.manifest.archiveCount,1);
    const before=JSON.stringify([...f.pluginStorage.values]);
    const state=await t.computeFlashbackAttention();
    assert.equal(state.kind,'','inherited archive turn is already saved');
    assert.equal(JSON.stringify([...f.pluginStorage.values]),before,'inspection performs no writes or repairs');
  }finally{await f.dispose();}
});
test('archive coverage still reports a truly new missing turn',async()=>{
  const {f,t,cfg,scope}=await seed();try{
    const archive=await t.createImmutableFlashbackHandoffArchive(scope.scopeKey,1,cfg);
    await t.saveAllRecords([],cfg,scope);
    await t.saveScopeManifest({...await t.loadScopeManifest(scope.scopeKey),archiveRef:archive.archiveRef},scope);
    f.currentChat.message.push({role:'user',chatId:'u2',data:'Who guards the tower?'},{role:'assistant',chatId:'a2',data:'Rowan guards the tower.'});
    const state=await t.computeFlashbackAttention();
    assert.equal(state.kind,'missing_turns');assert.equal(state.count,1);
  }finally{await f.dispose();}
});
test('foreign and resolved queue/query diagnostics cannot create a vector failure',async()=>{
  const {f,t,scope}=await seed();try{
    await f.api.saveSettings({...await f.api.loadSettings(),embeddingEnabled:true});
    t.Runtime.lastEmbeddingQueue={scopeKey:scope.scopeKey,generation:t.Runtime.embeddingGeneration,ok:false,failed:2,uncertain:true,reason:'queue_failed'};
    t.Runtime.lastEmbedError='old query error';
    f.currentChat.id='healthy-empty-chat';f.currentChat.chatId='healthy-empty-chat';f.currentChat.message=[];f.currentChat.messages=[];
    const newScope=await f.api.resolveCurrentScope(true);
    assert.notEqual(newScope.scopeKey,scope.scopeKey);
    assert.equal((await t.computeFlashbackAttention()).kind,'','the old chat failure is not this chat');
    t.Runtime.lastEmbeddingQueue={...t.Runtime.lastEmbeddingQueue,scopeKey:newScope.scopeKey};
    assert.equal((await t.computeFlashbackAttention()).kind,'','even a current-scope diagnostic needs unresolved durable work');
  }finally{await f.dispose();}
});
test('actual durable provider failure is shown and survives a fresh plugin runtime',async()=>{
  let calls=0;
  const f=await createFixture({pauseScheduledTimers:true,chat:chat(),nativeFetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:'synthetic auth failure'}}),{status:401});}});
  try{
    const cfg={...await f.api.loadSettings(),embeddingEnabled:true,embeddingProvider:'openai_compat',embeddingUrl:'https://synthetic.invalid/v1',embeddingModel:'synthetic-model',embeddingKey:'synthetic-key',embeddingDimensions:3,embeddingMaxRetries:0,embeddingAutoProcess:false,episodeIndexEnabled:false,autoEpisodeIndex:false};
    await f.api.saveSettings(cfg);
    await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
    const scope=await f.api.resolveCurrentScope(true);
    await f.api.processPendingEmbeddingQueue({scopeKey:scope.scopeKey,maxRequests:1});
    assert.equal(calls,1,'the only submitted provider request is synthetic');
    const state=await f.api._test.computeFlashbackAttention();
    assert.equal(state.kind,'embedding_failed');assert.equal(state.count,1);
    const next=await createFixture({pauseScheduledTimers:true,chat:chat(),pluginStorage:f.pluginStorage,safeLocalStorage:f.host.safeLocalStorage});
    try{assert.equal((await next.api._test.computeFlashbackAttention()).kind,'embedding_failed','failure is durable, not dependent on last queue history');}
    finally{await next.dispose();}
  }finally{await f.dispose();}
});
test('capture failure clears only after the exact live source is durably recovered',async()=>{
  const {f,t,scope}=await seed({ingest:false});try{
    t.Runtime.lastChatOutputCapture={scopeKey:scope.scopeKey,pairIndex:1,status:'failed',saved:false};
    assert.equal((await t.computeFlashbackAttention()).kind,'capture_failed','unrecovered source still warns');
    await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
    assert.equal((await t.computeFlashbackAttention()).kind,'','the saved exact source resolves the failure');
    assert.equal(t.Runtime.lastChatOutputCapture.saved,false,'read inspection does not erase diagnostic history');
    f.currentChat.message[1].data='The brass key is now inside the red tower.';
    assert.notEqual((await t.computeFlashbackAttention()).kind,'','a changed source is not considered recovered by the old record');
    t.Runtime.lastChatOutputCapture.bodyHash='obsolete-revision';
    assert.equal((await t.computeFlashbackAttention()).kind,'source_changed','an old revision error cannot establish failure of a new revision');
  }finally{await f.dispose();}
});
test('an error in another pair cannot override a different missing source',async()=>{
  const {f,t,scope}=await seed();try{
    t.Runtime.lastChatOutputCapture={scopeKey:scope.scopeKey,pairIndex:1,status:'failed',saved:false};
    f.currentChat.message.push({role:'user',chatId:'u2',data:'Who guards the tower?'},{role:'assistant',chatId:'a2',data:'Rowan guards the tower.'});
    const state=await t.computeFlashbackAttention();
    assert.equal(state.kind,'missing_turns');assert.equal(state.count,1);
    t.Runtime.lastCapture={skipped:true,scopeKey:'foreign-chat',pairIndex:2,reason:'finalized_capture_save_rejected'};
    assert.equal((await t.computeFlashbackAttention()).kind,'missing_turns','foreign capture diagnostics do not override this chat');
  }finally{await f.dispose();}
});
test('edited live text and archived revisions are offered for synchronization',async()=>{
  const {f,t,cfg,scope}=await seed();try{
    f.currentChat.message[1].data='The brass key is now inside the red tower.';
    assert.equal((await t.computeFlashbackAttention()).kind,'source_changed');
    assert.match((await t.computeFlashbackAttention()).name,/원문 동기화 1턴/);
    const archive=await t.createImmutableFlashbackHandoffArchive(scope.scopeKey,1,cfg);
    await t.saveAllRecords([],cfg,scope);
    await t.saveScopeManifest({...await t.loadScopeManifest(scope.scopeKey),archiveRef:archive.archiveRef},scope);
    assert.equal((await t.computeFlashbackAttention()).kind,'source_changed','archived old text is also checked against the current revision');
  }finally{await f.dispose();}
});
test('only a current-scope in-flight target suppresses a missing or changed source',async()=>{
  const {f,t,scope}=await seed();try{
    f.currentChat.message[1].data='The brass key is now inside the red tower.';
    t.Runtime.pendingTurns=[{pendingId:'pending',scope:{scopeKey:scope.scopeKey},pairIndex:1}];
    assert.equal((await t.computeFlashbackAttention()).kind,'');
    t.Runtime.pendingTurns[0].scope.scopeKey='other-chat';
    assert.equal((await t.computeFlashbackAttention()).kind,'source_changed');
    t.Runtime.pendingTurns=[];
  }finally{await f.dispose();}
});

test('an abandoned durable running attempt remains visible as uncertain',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat(),nativeFetch:async()=>new Response(JSON.stringify({error:{message:'synthetic auth failure'}}),{status:401})});
  try{
    const cfg={...await f.api.loadSettings(),embeddingEnabled:true,embeddingProvider:'openai_compat',embeddingUrl:'https://synthetic.invalid/v1',embeddingModel:'synthetic-model',embeddingKey:'synthetic-key',embeddingDimensions:3,embeddingMaxRetries:0,embeddingAutoProcess:false,episodeIndexEnabled:false,autoEpisodeIndex:false};
    await f.api.saveSettings(cfg);
    await f.api.ingestLiveChatColdStart({scope:'current',skipEpisodeRebuild:true,skipGuiRefresh:true});
    const scope=await f.api.resolveCurrentScope(true),t=f.api._test;
    await f.api.processPendingEmbeddingQueue({scopeKey:scope.scopeKey,maxRequests:1});
    const loaded=await t.loadScopeRecords(scope.scopeKey);
    const running=loaded.records.map(record=>({...record,embeddingWork:{...record.embeddingWork,status:'running'}}));
    await t.saveAllRecords(running,cfg,scope);
    assert.equal((await t.computeFlashbackAttention()).kind,'embedding_uncertain','lost runtime reservation still requires acknowledgement');
  }finally{await f.dispose();}
});

test('attention inspection does not switch the active runtime scope',async()=>{
  const {f,t,scope}=await seed();try{
    f.currentChat.id='other-empty-chat';f.currentChat.chatId=f.currentChat.id;f.currentChat.message=[];f.currentChat.messages=[];
    const state=await t.computeFlashbackAttention();
    assert.notEqual(state.scopeKey,scope.scopeKey);
    assert.equal(state.kind,'');
    assert.equal(t.Runtime.currentScope.scopeKey,scope.scopeKey,'read inspection cannot abort work by applying a different scope');
  }finally{await f.dispose();}
});
