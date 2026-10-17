'use strict';
// Whole plugin, actual owner storage and public restore/repair. Provider traffic is synthetic.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const chat=()=>({message:[{role:'user',chatId:'u1',data:'Where is the brass key?'},{role:'assistant',chatId:'a1',data:'The brass key is under the blue sundial.'}]});
function allowRevisionYields(f) {
  const schedule=f.context.setTimeout;
  f.context.setTimeout=(callback,delay,...args)=>delay===0?setTimeout(callback,0,...args):schedule(callback,delay,...args);
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
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

test('corrupt embedding attempt registry becomes a storage warning instead of aborting attention',async()=>{
  const {f,t,scope}=await seed();try{
    const manifest=await t.loadScopeManifest(scope.scopeKey);
    await t.saveScopeManifest({...manifest,embeddingAttemptRegistry:{schema:'broken'}},scope);
    const before=JSON.stringify([...f.pluginStorage.values]);
    const state=await t.computeFlashbackAttention();
    assert.equal(state.kind,'storage_error');
    assert.equal(JSON.stringify([...f.pluginStorage.values]),before,'warning inspection remains read-only');
  }finally{await f.dispose();}
});

test('attention poll notices an edited response without a chat-index change',async()=>{
  const {f,t}=await seed();try{
    await t.stopFlashbackAttention();
    t.FlashbackAttention.started=true;
    t.FlashbackAttention.lastIndexes='';
    t.FlashbackAttention.lastRevision='';
    t.FlashbackAttention.refreshTimer=null;
    await t.pollFlashbackAttention();
    t.FlashbackAttention.refreshTimer=null;
    f.currentChat.message[1].data='The brass key is now inside the red tower.';
    await t.pollFlashbackAttention();
    assert.equal(t.FlashbackAttention.lastIndexes,'0:0','the chat identity did not change');
    assert.equal(t.FlashbackAttention.refreshTimer?.fixturePausedTimer,true,'source revision schedules a refresh');
    assert.equal((await t.computeFlashbackAttention()).kind,'source_changed');
  }finally{await f.dispose();}
});

test('attention poll keeps large-chat revision tracking outside the normalization cache',async()=>{
  const messages=Array.from({length:5000},(_,index)=>({
    role:index%2?'assistant':'user',chatId:`large-${index}`,data:`message ${index} ${'x'.repeat(80)}`
  }));
  const f=await createFixture({pauseScheduledTimers:true,chat:{id:'large-chat',chatId:'large-chat',message:messages,messages:[]}});
  const t=f.api._test;
  try{
    await t.stopFlashbackAttention();
    allowRevisionYields(f);
    t.FlashbackAttention.started=true;
    const before={...t.Runtime.liveChatRevisionCacheStats};
    await t.pollFlashbackAttention();
    t.FlashbackAttention.refreshTimer=null;
    await t.pollFlashbackAttention();
    assert.deepEqual({...t.Runtime.liveChatRevisionCacheStats},before,'polling does not populate or churn the full normalization cache');
    assert.equal(t.FlashbackAttention.refreshTimer,null,'an unchanged large chat does not schedule work');
    f.currentChat.message=structuredClone(f.currentChat.message);
    await t.pollFlashbackAttention();
    assert.equal(t.FlashbackAttention.refreshTimer,null,'equivalent host clones do not create a false revision');
    f.currentChat.message[4500].data='edited near the end of a large chat';
    await t.pollFlashbackAttention();
    assert.equal(t.FlashbackAttention.refreshTimer?.fixturePausedTimer,true,'an edit beyond the former 4096-entry limit is detected');
    assert.deepEqual({...t.Runtime.liveChatRevisionCacheStats},before,'edit detection remains isolated from normalized transcript storage');
  }finally{await f.dispose();}
});

test('attention revision retains only fingerprints and yields while scanning long messages',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  try{
    await t.stopFlashbackAttention();
    allowRevisionYields(f);
    f.currentChat.message[1].data='a'.repeat(4*1024*1024);
    t.FlashbackAttention.started=true;
    let responsive=false;
    const heartbeat=setTimeout(()=>{responsive=true;},0);
    try{await t.pollFlashbackAttention();}finally{clearTimeout(heartbeat);}
    assert.equal(responsive,true,'a large payload scan lets pending UI tasks run');
    const retained=JSON.stringify([...t.FlashbackAttention.revisionTracker.sources.values()]);
    assert.ok(retained.length<4096,'attention must not keep a second copy of the full source text');
    t.FlashbackAttention.refreshTimer=null;
    const old=f.currentChat.message[1].data;
    f.currentChat.message[1].data=old.slice(0,old.length/2)+'b'+old.slice(old.length/2+1);
    await t.pollFlashbackAttention();
    assert.equal(t.FlashbackAttention.refreshTimer?.fixturePausedTimer,true,'same-length edits in the middle are detected');
  }finally{await f.dispose();}
});

test('a stopped attention poll cannot recreate its tracker or timers',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const entered=deferred(),release=deferred();
  try{
    await t.stopFlashbackAttention();
    t.FlashbackAttention.started=true;
    f.host.getChatFromIndex=async()=>{entered.resolve();await release.promise;return f.currentChat;};
    const pending=t.pollFlashbackAttention();
    await entered.promise;
    await t.stopFlashbackAttention();
    release.resolve();await pending;
    assert.equal(t.FlashbackAttention.revisionTracker,null,'a completed old host read cannot restore released revision data');
    assert.equal(t.FlashbackAttention.pollTimer,null,'stop leaves no polling timer');
    assert.equal(t.FlashbackAttention.refreshTimer,null,'stop leaves no refresh timer');
  }finally{release.resolve();await f.dispose();}
});

test('a stopped attention evaluation cannot publish an old warning',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const entered=deferred(),release=deferred();let registered=0;
  try{
    await t.stopFlashbackAttention();
    t.FlashbackAttention.started=true;
    f.host.getChatFromIndex=async()=>{entered.resolve();await release.promise;return f.currentChat;};
    f.host.registerButton=async()=>{registered++;return true;};
    const pending=t.refreshFlashbackAttention();
    await entered.promise;
    await t.stopFlashbackAttention();
    release.resolve();await pending;
    assert.equal(registered,0,'an evaluation from a stopped session cannot create a button');
    assert.equal(t.FlashbackAttention.state,null,'stopped attention keeps no actionable old state');
  }finally{release.resolve();await f.dispose();}
});

test('stopping attention drains an in-flight host button registration',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const entered=deferred(),release=deferred(),buttons=new Set();
  try{
    await t.stopFlashbackAttention();
    t.FlashbackAttention.started=true;
    f.host.registerButton=async spec=>{entered.resolve();await release.promise;buttons.add(spec.id);return true;};
    f.host.unregisterUIPart=async id=>{buttons.delete(id);return true;};
    const pending=t.refreshFlashbackAttention();
    await entered.promise;
    const stopped=t.stopFlashbackAttention();
    release.resolve();await Promise.all([pending,stopped]);
    assert.equal(buttons.size,0,'a late physical registration is removed before shutdown completes');
    assert.equal(t.FlashbackAttention.buttonSignature,'');
  }finally{release.resolve();await f.dispose();}
});

test('an old poll cannot overwrite or duplicate a restarted attention session',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const entered=deferred(),release=deferred();let reads=0;
  try{
    await t.stopFlashbackAttention();
    t.FlashbackAttention.started=true;
    const previousChat=structuredClone(f.currentChat);
    f.host.getChatFromIndex=async()=>{
      if(++reads===1){entered.resolve();await release.promise;return previousChat;}
      return f.currentChat;
    };
    const pending=t.pollFlashbackAttention();
    await entered.promise;
    await t.pollFlashbackAttention();
    assert.equal(reads,1,'only one poll can read the host in each session');
    await t.stopFlashbackAttention();
    f.currentChat.id='new-session-chat';f.currentChat.chatId=f.currentChat.id;
    t.startFlashbackAttention();
    await new Promise(setImmediate);
    const currentTracker=t.FlashbackAttention.revisionTracker,currentTimer=t.FlashbackAttention.pollTimer;
    assert.equal(currentTracker.cacheKey,'chat:new-session-chat');
    release.resolve();await pending;
    assert.equal(t.FlashbackAttention.revisionTracker,currentTracker,'old completion cannot replace the new tracker');
    assert.equal(t.FlashbackAttention.pollTimer,currentTimer,'old completion cannot install another polling loop');
  }finally{release.resolve();await f.dispose();}
});

test('stopping during a revision slice cancels the remainder of the scan',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const yielded=deferred();let resume;
  try{
    await t.stopFlashbackAttention();
    const schedule=f.context.setTimeout;
    f.context.setTimeout=(callback,delay,...args)=>{
      if(delay===0){resume=()=>callback(...args);yielded.resolve();return {fixturePausedTimer:true};}
      return schedule(callback,delay,...args);
    };
    f.currentChat.message[1].data='z'.repeat(4*1024*1024);
    t.FlashbackAttention.started=true;
    const pending=t.pollFlashbackAttention();
    await yielded.promise;
    await t.stopFlashbackAttention();
    resume();resume=null;await pending;
    assert.equal(t.FlashbackAttention.revisionTracker,null);
    assert.equal(t.FlashbackAttention.pollTimer,null);
  }finally{resume?.();await f.dispose();}
});

test('the public off setting clears attention and skips transcript polling until re-enabled',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test,buttons=new Set();
  try{
    await t.stopFlashbackAttention();t.FlashbackAttention.started=true;
    f.host.registerButton=async spec=>{buttons.add(spec.id);return true;};
    f.host.unregisterUIPart=async id=>{buttons.delete(id);return true;};
    assert.equal((await t.refreshFlashbackAttention()).kind,'cold_start');
    await t.pollFlashbackAttention();
    await f.api.saveSettings({...await f.api.loadSettings(),mode:'off'});
    let reads=0;
    f.host.getChatFromIndex=async()=>{reads++;return f.currentChat;};
    assert.equal((await t.refreshFlashbackAttention()).kind,'');
    assert.equal(buttons.size,0,'turning the engine off removes the existing warning');
    await t.pollFlashbackAttention();await t.pollFlashbackAttention();
    assert.equal(reads,0,'off mode does not fetch or hash the transcript');
    assert.equal(t.FlashbackAttention.revisionTracker,null);
    assert.equal(t.FlashbackAttention.pollTimer?.fixturePausedTimer,true,'a lightweight timer can notice re-enabling');
    await f.api.saveSettings({...await f.api.loadSettings(),mode:'normal'});
    await t.pollFlashbackAttention();
    assert.ok(reads>0);assert.ok(t.FlashbackAttention.revisionTracker);
    assert.equal((await t.refreshFlashbackAttention()).kind,'cold_start');
    assert.equal(buttons.size,1,'the same unchanged chat is inspected after re-enabling');
  }finally{await f.dispose();}
});

test('turning the engine off while the host registers a warning removes that late button',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const entered=deferred(),release=deferred(),buttons=new Set();
  try{
    await t.stopFlashbackAttention();t.FlashbackAttention.started=true;
    f.host.registerButton=async spec=>{entered.resolve();await release.promise;buttons.add(spec.id);return true;};
    f.host.unregisterUIPart=async id=>{buttons.delete(id);return true;};
    const pending=t.refreshFlashbackAttention();
    await entered.promise;
    await f.api.saveSettings({...await f.api.loadSettings(),mode:'off'});
    release.resolve();const state=await pending;
    assert.equal(state.kind,'');assert.equal(t.FlashbackAttention.state.kind,'');
    assert.equal(buttons.size,0,'an off-mode warning cannot survive a delayed host acknowledgement');
  }finally{release.resolve();await f.dispose();}
});

test('turning the engine off cancels a revision scan and preserves idle re-enable polling',async()=>{
  const f=await createFixture({pauseScheduledTimers:true,chat:chat()}),t=f.api._test;
  const yielded=deferred();let resume,held=false;
  try{
    await t.stopFlashbackAttention();const schedule=f.context.setTimeout;
    f.context.setTimeout=(callback,delay,...args)=>{
      if(delay===0&&!held){held=true;resume=()=>callback(...args);yielded.resolve();return {fixturePausedTimer:true};}
      if(delay===0)return setTimeout(callback,0,...args);
      return schedule(callback,delay,...args);
    };
    f.currentChat.message[1].data='z'.repeat(4*1024*1024);t.FlashbackAttention.started=true;
    const pending=t.pollFlashbackAttention();await yielded.promise;
    await f.api.saveSettings({...await f.api.loadSettings(),mode:'off'});
    resume();resume=null;await pending;
    assert.equal(t.FlashbackAttention.revisionTracker,null);
    assert.equal(t.FlashbackAttention.lastRevision,'');
    assert.equal(t.FlashbackAttention.pollTimer?.fixturePausedTimer,true);
  }finally{resume?.();await f.dispose();}
});
