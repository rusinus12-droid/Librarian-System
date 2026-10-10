'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{const f=await createFixture();let cases=0;
try{
 const t=f.api._test,sel=f.api._selectionTest;
 const cfg=t.normalizeSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'boundary-fixture',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,fallbackHashEmbedding:false,embeddingEnabled:true,contextualRecall:true,autoEpisodeIndex:false,episodeIndexEnabled:false,currentSceneTailEnabled:false,recallContextMessages:6});
 await t.saveEmbeddingKeyLocal('offline-fixture-key');await f.api.saveSettings(cfg);
 const requests=[];f.host.nativeFetch=async(url,init)=>{const body=JSON.parse(init.body),inputs=Array.isArray(body.input)?body.input:[body.input];requests.push(...inputs);return new Response(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
 f.currentChat.message=[{role:'user',chatId:'stored-u',data:'Start a journey.'},{role:'assistant',chatId:'stored-a',data:'The compass is stored in the cellar.'}];f.currentChat.messages=f.currentChat.message;
 await f.api.ingestLiveChatColdStart({scope:'current',canonical:true});const scope=await f.api.resolveCurrentScope();
 const before=JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records);
 const prepare=async(input,live,request)=>{requests.length=0;t.invalidateQueryEmbeddingCache();await sel.prepareFlashbackRecall(input,cfg,scope,{currentUser:input,liveMessages:live,messages:request});assert.equal(requests.length,1);return requests[0];};
 for(const [i,input] of ['계속.','Proceed.','続けて。','다음 장면으로.'].entries()){
  const scene='A silver compass moved to cellar '+i;
  const live=[{role:'user',chatId:'past-u-'+i,content:input},{role:'assistant',chatId:'past-a-'+i,content:scene}];
  const current={role:'user',chatId:'new-u-'+i,content:input};
  const appended=await prepare(input,live,[...live,current]);assert.ok(appended.includes(scene),'Repeated text from a new message cannot remove the completed pair');cases++;
  const changed=await prepare(input,[live[0],{...live[1],content:scene+' changed'}],[...live,current]);assert.ok(changed.includes(scene+' changed'),'Stable identity keeps live edits in the query');cases++;
  const pending=await prepare(input,[...live,current],[...live,current]);assert.ok(pending.includes(scene));assert.equal(pending.split('USER: '+input).length-1,1,'Current input is not duplicated in recent history');cases++;
  const reroll=await prepare(input,live,[live[0]]);assert.ok(!reroll.includes(scene),'Same user ID marks the rejected response boundary');cases++;
  const prefix=[{role:'user',content:'Earlier setup'},{role:'assistant',content:'Earlier complete history '+i}];
  const noIds=live.map(({chatId,...m})=>m),plainCurrent={role:'user',content:input};
  const legacyAppend=await prepare(input,[...prefix,...noIds],[...prefix,...noIds,plainCurrent]);assert.ok(legacyAppend.includes(scene));cases++;
  const legacyReroll=await prepare(input,[...prefix,...noIds],[...prefix,noIds[0]]);assert.ok(legacyReroll.includes('Earlier complete history'));assert.ok(!legacyReroll.includes(scene));cases++;
  const historyOnly=t.buildSceneContextQuery(input,live,cfg);assert.equal(historyOnly.messageCount,2);cases++;
 }
 assert.equal(JSON.stringify((await t.loadScopeRecords(scope.scopeKey)).records),before,'Context search preserves stored memories and vectors');
 requests.length=0;t.invalidateQueryEmbeddingCache();
 const outgoing=f.currentChat.message.map(m=>({role:m.role,chatId:m.chatId,content:m.data}));
 outgoing.push({role:'user',chatId:'hook-new-user',content:'Start a journey.'});
 const returned=await sel.beforeRequest(outgoing,'model');
 assert.ok(requests.some(input=>input.includes('The compass is stored in the cellar.')),'The live beforeRequest path retains completed context under repeated input');
 assert.ok(Array.isArray(returned));assert.equal((await f.api.debugState()).lastRecall.delivery.stage,'returned_to_hook');cases++;
 console.log(JSON.stringify({test:'flashback_context_boundary',passed:cases,realProviderCalls:0,storedRecordsUnchanged:true}));
}finally{await f.dispose();}})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
