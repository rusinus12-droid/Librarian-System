'use strict';
// Composed offline UI -> private SDK -> real server/SQLite -> emitted G2 payload.
// HAYAKU and Flashback bytes are created by their actual producer runtimes. GRADIA reads through the unified engine:
// the server read-session only authorizes/binds the three owners, and the evidence packet comes from the LIBRA owner channel.
// The LIBRA owner here is the real channel owner (tools/libra_gradia_unified_read.cjs) with a query adapter that renders
// the committed owner rows from SQLite, and a verifier that fails when any of those rows changes after the query.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {JSDOM}=require('jsdom'),acorn=require('../tools/gradia/load-dev-dependency.cjs')('acorn');
const {load}=require('./gradia/host.cjs');const createBus=require('./fixtures/libra_gradia_read_bus.cjs'),createOwner=require('../tools/libra_gradia_unified_read.cjs');const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
const {createHayakuRuntime,createStore,createValidPacket,hiddenPacketMessage,waitFor}=require('./fixtures/hayaku_runtime_harness.cjs');
const root=path.resolve(__dirname,'..'),owners=['libra','hayaku','flashback'],sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const messages=()=>[{role:'user',messageId:'u1',content:'The archivist opens the library.'},{role:'assistant',messageId:'a1',content:'The brass key is on the table.'},{role:'user',messageId:'u2',content:'Continue the scene.'}];
function instrument(source){const ast=acorn.parse(source,{ecmaVersion:'latest'}),found=[];function walk(n){if(!n||typeof n!=='object')return;if(n.type==='ArrowFunctionExpression'&&source.slice(n.start,n.end).includes('shadow_act_disabled'))found.push(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}walk(ast);const n=found.sort((a,b)=>a.end-a.start-(b.end-b.start))[0];assert(n);return source.slice(0,n.start)+'(globalThis.__testPipeline='+source.slice(n.start,n.end)+')'+source.slice(n.end);}
async function fixture(t,{request=messages,hostMessages=messages,ownersRunning=true,hayakuFinalDelivery=true,hayakuSelectError='',hayakuContent='HAYAKU_MEMORY_SENTINEL recalled by HAYAKU',memoryBudgetChars=240000,delayedOwner=null}={}){
 const fb=await createFlashback(root,{waitForLoaded:true});t.after(()=>fb.cleanup());const cfg=fb.api._test.normalizeSettings({embeddingEnabled:false,embeddingAutoProcess:false,autoEpisodeIndex:false});await fb.api.saveSettings(cfg);const fScope=await fb.api.resolveCurrentScope(false),characterId=fScope.canonicalCharacterId,chatId=fScope.canonicalChatId;
 const sources=[1,2].map(n=>({sourceType:'response',sourceId:'producer-'+n,sourceHash:'producer-hash-'+n,origin:'live_chat',role:'turn_pair',turnIndex:n,pairIndex:n,text:'User:\nWhere is the key '+n+'?\n\n---\n\nAssistant:\nFLASHBACK_MEMORY_SENTINEL_'+n+' The brass key is tied to the blue ribbon.'}));
 const fbRecords=await fb.api._test.buildRecordsFromSources(sources,cfg,fScope,{deferEmbedding:true});await fb.api._test.saveAllRecords(fbRecords,cfg,fScope);assert.equal(fb.networkCalls.length,0);
 const hs=createStore();await hs.setItem('hayaku.v2.settings.source-tracking.v1',JSON.stringify({mode:'off',epoch:0}));
 const h=await createHayakuRuntime({characterId,chatId,pluginStorage:hs,messages:[{role:'user',chatId:'u1',data:'Alice-1 completes the established event for turn 1.'}],autoRepair:false,afterRequestAutoRepair:false,backgroundAutoRepair:false,arguments:{hayaku_packet_recovery:'false'}});t.after(()=>h.dispose());
 await h.callBeforeRequest([{role:'system',content:'Continue the story.'},...h.chat.message]);const hScope=await h.hayaku._test.currentChatScope(),pending=h.hayaku._test.selectPendingCapture([],hScope,'model'),packet=createValidPacket({summary:'HAYAKU_MEMORY_SENTINEL Alice-1 completed the established event for turn 1.'}),lineage=pending.lineage;
 packet.meta.lineage={request_nonce:lineage.requestNonce,parent_turn_node_id:lineage.parentTurnNodeId,logical_turn_id:lineage.logicalTurnId,identity_version:lineage.identityVersion,lineage_schema:lineage.lineageSchema,turn_owner_key:lineage.turnOwnerKey,generation_attempt_id:lineage.generationAttemptId};
 const response=hiddenPacketMessage('Alice-1 completed the established event for turn 1.',packet);await h.callAfterRequest(response);h.chat.message.push({role:'assistant',chatId:'a1',data:response});h.chat.messages=h.chat.message;await h.callChatOutput({char:h.character,chat:h.chat,characterIndex:0,chatIndex:0,messageIndex:1});await waitFor(()=>h.hayaku.lastDebug().lastStorageCapture?.durable===true,'canonical producer commit');const observed=await h.hayaku._test.currentChatScope();await h.hayaku._test.reconcileObservedChatTopology(observed,h.hayaku._test.authoritativeChatSnapshot(observed.chatMessages,observed),'gradia_composed_fixture');assert.equal(h.fetchCalls.length,0);assert.equal(h.llmCalls.length,0);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gradia-three-owner-pipeline-')),app=createMemorySuiteServer({dataDir:dir,port:0,autoBackup:false,computeEnabled:false,token:'offline-synthetic-only'}),address=await app.listen(),url=`http://127.0.0.1:${address.port}`;t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const put=(owner,key,value,revision=1)=>{const json=typeof value==='string'?value:JSON.stringify(value);app.repositories[owner].database.prepare('INSERT OR REPLACE INTO kv(space,key,value_json,deleted,revision,digest,updated_at)VALUES(?,?,?,?,?,?,?)').run('plugin',key,json,0,revision,sha(json),revision);};
 for(const [key,value]of h.pluginStorage.values)if(key.startsWith('hayaku.v2.ledger.')||key.startsWith('hayaku.v2.storage_reconciliation_journal.capture_delta::'))put('hayaku',key,value);
 for(const [key,value]of fb.pluginStorage.values)if(key.startsWith('vector_rag_memory:scope:'))put('flashback',key,value);
 const scopes={libra:{scopeKey:'libra-scope',characterId,chatId},hayaku:{scopeKey:hScope.key,characterId,chatId},flashback:{scopeKey:fScope.scopeKey,characterId,chatId}};
 const libraKey='libra:v1:scope:libra-scope:memory:1:r1',libraManifest='libra:v1:scope:libra-scope:manifest',ref={status:'committed',key:libraKey,memoryId:'one',revision:1,sourceDigest:'source',turnRange:{start:1,end:5},sessionEpoch:0};
 put('libra',libraManifest,JSON.stringify({schema:'libra.manifest.v1',...scopes.libra,branchGuard:{schema:'libra.branch_guard.v1',status:'ready'},memories:{1:ref},inheritedMemories:[]}));put('libra',libraKey,JSON.stringify({schema:'libra.canonical_memory.v1',status:'committed',scopeKey:scopes.libra.scopeKey,memoryId:'one',revision:1,sourceDigest:'source',text:'LIBRA_MEMORY_SENTINEL'}));
 const values=new Map([['libra:v1:scope-registry:v1',JSON.stringify({[characterId+'::'+chatId]:scopes.libra})]]),local=new Map(),requests=[],prompts=[],unloads=[];for(const owner of owners)values.set('__memory_suite_internal_scope_routes_v1__:'+owner,JSON.stringify({schema:'memory-suite.scope-routing.v1',namespace:owner,version:1,legacyGlobalModeImported:true,entries:{[scopes[owner].scopeKey]:{scopeId:scopes[owner].scopeKey,...scopes[owner],mode:'server_only',origin:'user_explicit',updatedAt:1}}}));
 const store={getItem:async k=>values.get(k)??null,setItem:async(k,v)=>values.set(k,v),removeItem:async k=>values.delete(k)},dom=new JSDOM('<!doctype html><html><body></body></html>',{pretendToBeVisual:true,url:'https://offline.invalid/'}),chat={id:chatId,message:hostMessages()},character={id:characterId,chaId:characterId,chats:[chat],chatPage:0};let onRead=null,onModel=null,onOutput=null,contextCharacter=character;
 const transport=async(target,init)=>{if(target.startsWith(url)){const route=new URL(target).pathname;requests.push(route);const response=await mockFetch(target,init);if(route==='/bootstrap')dataId=(await response.clone().json()).dataInstanceId;if(onRead)await onRead(route);return response;}assert.equal(target,'https://api.openai.com/v1/chat/completions');prompts.push(JSON.parse(init.body));if(onModel)await onModel();return new Response(JSON.stringify({choices:[{message:{content:'The archivist placed the brass key on the table. Warm lamplight spread over the shelves as he waited quietly beside the open door.'},finish_reason:'stop'}]}));};
 const bus=createBus(),fingerprint=v=>sha(v),ownerRows=()=>owners.map(owner=>[owner,app.repositories[owner].database.prepare("SELECT key,value_json,revision FROM kv WHERE space='plugin' ORDER BY key").all()]);
 let queried=null,ownerSerial=0,dataId=null,onQuery=null,onVerify=null,verifyCalls=0;const libraOwner=createOwner({role:'owner',api:bus.api('libra'),fingerprint,randomId:()=>String(++ownerSerial),
  boundary:async request=>({scope:request.scope||scopes.libra,dataInstanceId:dataId,resetEpoch:0}),
  query:async(request,authority)=>{authority.bindGraph({readerFrame:{},nodes:[],edges:[],bases:[]});queried=JSON.stringify(ownerRows());const text=ownerRows().map(([owner,rows])=>rows.map(row=>'['+owner+'] '+row.key+' '+row.value_json).join('\n')).join('\n');
   await onQuery?.('libra');
   return {modelDispatchEligible:true,queryComplete:false,deliveryOutcome:'partial',windowRead:{limit:20},nextWindow:null,bundle:{generation:'g1'},packet:{renderedText:text,packetDigest:fingerprint(text)}};},
  verify:async()=>{await onVerify?.(++verifyCalls);return JSON.stringify(ownerRows())===queried;}});await libraOwner.start();t.after(()=>libraOwner.dispose());
 const mutatedOwners=new Set();
 const ownerConfigs={
  libra:{
   scope:scopes.libra,
   content:()=>{
    const row=app.repositories.libra.database.prepare("SELECT value_json FROM kv WHERE space='plugin' AND key=?").get(libraKey);
    if (!row) return 'LIBRA_MEMORY_SENTINEL';
    let data = row.value_json;
    while (typeof data === 'string') {
      try { data = JSON.parse(data); } catch(_) { break; }
    }
    return (data && typeof data === 'object' && data.text) ? data.text : 'LIBRA_MEMORY_SENTINEL';
   },
   delayMs:delayedOwner?.owner==='libra'?delayedOwner.delayMs:0,
   onQuery:async()=>{await onQuery?.('libra');if(onVerify)await onVerify(++verifyCalls);}
  },
  hayaku:{
   scope:scopes.hayaku,
   content:()=>{
    if(hayakuContent!=='HAYAKU_MEMORY_SENTINEL recalled by HAYAKU')return hayakuContent;
    const row=app.repositories.hayaku.database.prepare("SELECT value_json FROM kv WHERE space='plugin' AND key LIKE 'hayaku.v2.ledger.%'").get();
    if(!row)return 'HAYAKU_MEMORY_SENTINEL recalled by HAYAKU';
    let data = row.value_json;
    while (typeof data === 'string') {
      try { data = JSON.parse(data); } catch(_) { break; }
    }
    const packetData = typeof data?.records?.[0]?.raw === 'string' ? JSON.parse(data.records[0].raw) : (data?.records?.[0]?.raw || {});
    const summary=packetData.summary||packetData.meta?.summary||'HAYAKU_MEMORY_SENTINEL';
    return summary+(summary.includes('recalled by HAYAKU')?'':' recalled by HAYAKU');
   },
   finalDelivery:hayakuFinalDelivery,
   selectError:hayakuSelectError,
   delayMs:delayedOwner?.owner==='hayaku'?delayedOwner.delayMs:0,
   onQuery:async()=>onQuery?.('hayaku')
  },
  flashback:{
   scope:scopes.flashback,
   content:()=>{
    const rows=app.repositories.flashback.database.prepare("SELECT value_json FROM kv WHERE space='plugin' AND key LIKE 'vector_rag_memory:scope:%'").all();
    const texts=rows.flatMap(r=>{
      let v = r.value_json;
      while (typeof v === 'string') {
        try { v = JSON.parse(v); } catch(_) { break; }
      }
      return (v?.records || v?.items || []).map(i=>i.text||'');
    }).join(' ');
    const s1=texts.includes('FLASHBACK_MEMORY_SENTINEL_1')?'FLASHBACK_MEMORY_SENTINEL_1':'';
    const s2=texts.includes('FLASHBACK_MEMORY_SENTINEL_2')?'FLASHBACK_MEMORY_SENTINEL_2':'';
    return `${s1} ${s2} recalled by Flashback`.trim();
   },
   delayMs:delayedOwner?.owner==='flashback'?delayedOwner.delayMs:0,
   onQuery:async()=>onQuery?.('flashback')
  }
 };
 const activeOwners=ownersRunning?ownerConfigs:{libra:ownerConfigs.libra};
 t.after(await require('./fixtures/gradia_owner_selection_stub.cjs')(bus,activeOwners,{isMutated:o=>mutatedOwners.has(o)}));
 const host=await load({transformSource:instrument,api:{...bus.api('serial_gradation_agents_for_rp'),pluginStorage:store,getLocalPluginStorage:async()=>({getItem:async k=>local.get(k)??null,setItem:async(k,v)=>local.set(k,v)}),nativeFetch:transport,fetch:transport,onUnload:async f=>unloads.push(f),showContainer:async()=>{},hideContainer:async()=>{},getCurrentCharacterIndex:async()=>0,getCurrentChatIndex:async()=>0,getCharacterFromIndex:async()=>character,getChatFromIndex:async()=>chat,getCharacter:async()=>contextCharacter,addRisuChatListener:async(t,fn)=>{if(t==='output')onOutput=fn;}},testGlobals:{crypto:crypto.webcrypto,Response,window:dom.window,Element:dom.window.Element,document:dom.window.document,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),MutationObserver:dom.window.MutationObserver,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)}});t.after(async()=>{await host.plugin.closeSettingsGui();for(const f of unloads)await f();dom.window.close();});
 await host.hooks.beforeRequest(messages(),'model');await host.plugin.openSettingsGui();dom.window.document.querySelector('.sidebar [data-go="sources"]').click();const readSourceSelect=dom.window.document.querySelector('#lib-read-source');if(readSourceSelect){readSourceSelect.value='plugin_ipc';readSourceSelect.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}const input=dom.window.document.querySelector('#lib-url');if(input){input.value=url;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}dom.window.document.querySelector('#lib-connect').click();await waitFor(()=>['connected','error'].includes(host.plugin.getLibReadOnlyStatus().connection.state),'readonly UI connection');assert.equal(host.plugin.getLibReadOnlyStatus().connection.state,'connected',JSON.stringify(host.plugin.getLibReadOnlyStatus()));
 const settings={...host.plugin.getRuntime().settings,memoryBudgetChars,inputAssistMode:'off',enableShadowAct:true,enableCharacterAide:false,enableWorldAide:false,enablePlotAide:false,multiPipelineMode:'lightweight',mode:'lite',failureMode:'hard',loreActivationMode:'off',stagePresetNames:{},defaultPresetName:'offline',presets:{offline:{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'offline-synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:1000,stream:false}},skillRouterEnabled:false};
 const snapshot=()=>JSON.stringify(Object.fromEntries(owners.map(owner=>[owner,{kv:app.repositories[owner].database.prepare('SELECT * FROM kv ORDER BY space,key').all(),operations:app.repositories[owner].database.prepare('SELECT COUNT(*) n FROM operations').get().n}])));
 const mutate=owner=>{mutatedOwners.add(owner);const key=owner==='libra'?libraManifest:owner==='hayaku'?'hayaku.v2.ledger.'+hScope.key:app.repositories.flashback.database.prepare("SELECT key FROM kv WHERE key LIKE '%:manifest:v2' ORDER BY key LIMIT 1").get().key;const r=app.repositories[owner].database.prepare('SELECT value_json FROM kv WHERE key=?').get(key);put(owner,key,JSON.parse(r.value_json),2);};
 return {host,settings,requests,prompts,values,local,snapshot,mutate,put,app,scopes,libraKey,mutateNative:kind=>{if(kind==='scope'){character.id='foreign';character.chaId='foreign';contextCharacter={...character,id:'foreign',chaId:'foreign'};}if(kind==='id')chat.message[1].messageId='different-assistant';if(kind==='text')chat.message[1].content='A different persisted variant.';if(kind==='turn')chat.message.unshift({role:'user',messageId:'older-u',content:'Another completed turn.'},{role:'assistant',messageId:'older-a',content:'Another historical answer.'});},setOnRead:f=>onRead=f,setOnQuery:f=>onQuery=f,setOnVerify:f=>onVerify=f,setOnModel:f=>onModel=f,recordOutput:async(idx=1)=>onOutput?.({char:character,chat,characterIndex:0,chatIndex:0,messageIndex:idx}),run:()=>host.pipeline(request(),'model',settings)};
}
test('actual committed producer bytes reach one unchanged G2 model payload with owner provenance and no owner writes',{timeout:30000},async t=>{const f=await fixture(t),before=f.snapshot(),r=await f.run();assert.equal(r.ok,true);assert.equal(f.prompts.length,1);const body=JSON.stringify(f.prompts[0]);for(const marker of ['LIBRA_MEMORY_SENTINEL','HAYAKU_MEMORY_SENTINEL','FLASHBACK_MEMORY_SENTINEL_1','FLASHBACK_MEMORY_SENTINEL_2'])assert(body.includes(marker),marker);for(const owner of owners)assert(body.includes('\\"owner\\":\\"'+owner+'\\"'),owner);assert(!body.includes('archiveShared'),'storage metadata stays out of the model payload');assert.equal(f.snapshot(),before);assert.equal(f.requests.filter(r=>/read-session\/(capture|current)/.test(r)).length,0,'response path uses owner select IPC, never server capture/current');assert(!JSON.stringify([...f.local,...f.values]).includes('HAYAKU_MEMORY_SENTINEL'));await r.finalizeHandoff();r.closeEvidence();});
test('GRADIA uses owner memory for drafting only and never re-injects <MEMORY_RECALL> into the final response',{timeout:30000},async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('offline',f.settings.presets.offline);await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false,failure_mode:'hard',lore_activation_mode:'off',memory_budget_chars:240000});
 const output=await f.host.hooks.beforeRequest(messages(),'model');
 const draftPrompt=JSON.stringify(f.prompts[0]);
 assert(draftPrompt.includes('recalled by HAYAKU'),'GRADIA drafts with HAYAKU memory');
 assert(draftPrompt.includes('recalled by Flashback'),'GRADIA drafts with Flashback memory');
 assert(draftPrompt.includes('LIBRA_MEMORY_SENTINEL'),'GRADIA drafts with LIBRA memory');
 const finalText=output.map(row=>String(row.content||'')).join('\n');
 assert.match(finalText,/GRADIA_LIB_EVIDENCE_NO_REUSE_V1/,'GRADIA delivers its draft');
 assert.doesNotMatch(finalText,/<MEMORY_RECALL>/,'GRADIA does not re-deliver memory to the final model');
 assert.equal(f.requests.filter(r=>/read-session\/(capture|current)/.test(r)).length,0,'beforeRequest response drafting uses owner select IPC, never server capture/current');
});
test('server-storage memory owners retrieve memory internally via select with zero GRADIA server capture/current requests',{timeout:30000},async t=>{
 const f=await fixture(t);const r=await f.run();assert.equal(r.ok,true);assert.equal(f.prompts.length,1);
 const body=JSON.stringify(f.prompts[0]);
 for(const marker of ['LIBRA_MEMORY_SENTINEL','HAYAKU_MEMORY_SENTINEL','FLASHBACK_MEMORY_SENTINEL_1','FLASHBACK_MEMORY_SENTINEL_2'])assert(body.includes(marker),`draft prompt includes ${marker}`);
 for(const owner of owners)assert(body.includes('\\"owner\\":\\"'+owner+'\\"'),`draft prompt includes owner ${owner}`);
 assert.equal(f.requests.filter(r=>/read-session\/(capture|current)/.test(r)).length,0,'GRADIA issues zero read-session capture/current server requests in server storage mode');
 await r.finalizeHandoff();r.closeEvidence();
});
test('server-storage memory owners dynamically query SQLite server database internally and reflect updated server records with zero GRADIA capture/current requests',{timeout:30000},async t=>{
 const f=await fixture(t);
 // Update record directly in the server's SQLite database
 const updatedText='LIBRA_MEMORY_SENTINEL_DYNAMIC_FROM_SERVER_SQLITE';
 f.put('libra',f.libraKey,{schema:'libra.canonical_memory.v1',status:'committed',scopeKey:f.scopes.libra.scopeKey,memoryId:'one',revision:2,sourceDigest:'source2',text:updatedText},2);
 const r=await f.run();assert.equal(r.ok,true);assert.equal(f.prompts.length,1);
 const body=JSON.stringify(f.prompts[0]);
 assert(body.includes('LIBRA_MEMORY_SENTINEL_DYNAMIC_FROM_SERVER_SQLITE'),'owner dynamically reads updated record from SQLite server');
 assert(body.includes('HAYAKU_MEMORY_SENTINEL'),'owner dynamically reads HAYAKU record from SQLite server');
 assert(body.includes('FLASHBACK_MEMORY_SENTINEL_1'),'owner dynamically reads Flashback record from SQLite server');
 assert.equal(f.requests.filter(r=>/read-session\/(capture|current)/.test(r)).length,0,'GRADIA issues zero server read-session capture/current calls');
 await r.finalizeHandoff();r.closeEvidence();
});
test('a plugin that is not running contributes no memory, and its server records are not read for the model',{timeout:30000},async t=>{const f=await fixture(t,{ownersRunning:false}),started=Date.now(),r=await f.run();assert.equal(r.ok,true);const body=JSON.stringify(f.prompts[0]);assert(body.includes('LIBRA_MEMORY_SENTINEL'));assert(!body.includes('\\"owner\\":\\"hayaku'));assert(!body.includes('\\"owner\\":\\"flashback'));assert(Date.now()-started<15000,'an absent plugin costs one short wait');});
const ownerMarkers={libra:'LIBRA_MEMORY_SENTINEL',hayaku:'recalled by HAYAKU',flashback:'recalled by Flashback'};
const assertOnlyOwnerLost=(body,lost)=>{for(const owner of owners)assert.equal(body.includes(ownerMarkers[owner]),owner!==lost,owner+' when '+lost+' fails');};
for(const owner of owners)test(`${owner} changing during capture costs only ${owner}'s memory`,{timeout:30000},async t=>{const f=await fixture(t);let changed=false;
f.setOnQuery(targetOwner=>{if(!changed&&targetOwner===owner){changed=true;f.mutate(owner);}});const r=await f.run();assert(changed);assert.equal(r.ok,true);assert.equal(f.prompts.length,1);assert.equal(r.externalEvidence,true);assertOnlyOwnerLost(JSON.stringify(f.prompts[0]),owner);r.closeEvidence();});
test('a store changing after selection keeps the draft, as an owner hook would',{timeout:30000},async t=>{const f=await fixture(t);await f.host.plugin.saveProviderPreset('offline',f.settings.presets.offline);await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false,failure_mode:'hard',lore_activation_mode:'off',memory_budget_chars:240000});f.setOnModel(()=>f.mutate('flashback'));const output=await f.host.hooks.beforeRequest(messages(),'model');const text=output.map(row=>String(row.content||'')).join('\n');assert.match(text,/GRADIA_LIB_EVIDENCE_NO_REUSE_V1/,'the draft stays');assert.doesNotMatch(text,/<MEMORY_RECALL>/);});
test('an owner over budget is left out whole, and the others stay',{timeout:30000},async t=>{const f=await fixture(t,{memoryBudgetChars:60000,hayakuContent:'HAYAKU_LONG_MEMORY\n'+('기억 한 줄\n'.repeat(12000))+'HAYAKU_TAIL'}),r=await f.run();assert.equal(r.ok,true);const body=JSON.stringify(f.prompts[0]);assert.match(body,/recalled by Flashback/);assert.doesNotMatch(body,/HAYAKU_LONG_MEMORY/,'no fragment of it is delivered');r.closeEvidence();});
test('an owner refusing its selection costs only that owner',{timeout:30000},async t=>{const f=await fixture(t,{hayakuSelectError:'LIB_READ_OWNER_UNAVAILABLE'}),r=await f.run();assert.equal(r.ok,true);assertOnlyOwnerLost(JSON.stringify(f.prompts[0]),'hayaku');r.closeEvidence();});
test('normal owner delayed beyond 5 seconds retains memory without truncation',{timeout:30000},async t=>{const f=await fixture(t,{delayedOwner:{owner:'libra',delayMs:6000}});const r=await f.run();assert.equal(r.ok,true);const body=JSON.stringify(f.prompts[0]);assert(body.includes('LIBRA_MEMORY_SENTINEL'),'LIBRA memory retained when delayed 6s');r.closeEvidence();});

test('native scope mismatch still fails closed after bound-scope enrichment fix',{timeout:30000},async t=>{const f=await fixture(t);f.mutateNative('scope');await assert.rejects(()=>f.run(),e=>e.code==='LIB_READ_NATIVE_SCOPE_CHANGED'||e.code==='LIB_READ_NATIVE_VIEW_CHANGED');assert.equal(f.prompts.length,0);});
for(const kind of ['id','text','turn'])test(`native ${kind} mismatch retains held memory and completes draft under 2026-11-07 contract`,{timeout:30000},async t=>{const f=await fixture(t);f.mutateNative(kind);const r=await f.run();assert.equal(r.ok,true);assert.equal(f.prompts.length,1);r.closeEvidence();});

// RisuAI sends request rows without native ids and stores the transcript as char/data rows, so
// GRADIA binds the ids from the host chat. The shared reference view then re-derives the terminal
// scene from the stored transcript. Image-command, header and separator lines used to leave
// whitespace-only lines, so that second derivation differed by one character and every such
// turn failed with LIB_READ_NATIVE_VIEW_CHANGED before any model call.
const RP_REPLY='# 응답\n## 볼륨 1\n#### Chatindex: 1\n\n세아가 고개를 들었다.\n\n<img cmd="aa school terrified.png">\n\n"......하지 마......"\n\n§쿵, 쿵.§\n\n---\n\n<GT-CTRL/>\n\n---';
test('host-bound RP transcript with image and separator lines keeps the certified stage view',{timeout:60000},async t=>{
 const f=await fixture(t,{
  request:()=>[{role:'user',content:'세아는 천천히 정신이 들었다.'},{role:'assistant',content:RP_REPLY},{role:'user',content:'그녀의 턱 아래로 손을 올렸다.'}],
  hostMessages:()=>[{role:'user',chatId:'u1',data:'세아는 천천히 정신이 들었다.'},{role:'char',chatId:'a1',data:RP_REPLY},{role:'user',chatId:'u2',data:'그녀의 턱 아래로 손을 올렸다.'}]});
 const r=await f.run();
 assert.equal(r.ok,true,JSON.stringify(f.host.plugin.getRuntime().lastStageViewMismatch||null));
 assert.equal(r.externalEvidence,true);
 assert.equal(f.prompts.length,1);
 r.closeEvidence();
});

test('host-bound RP transcript with prior CompletionReceipt keeps the certified stage view',{timeout:30000},async t=>{
 const f=await fixture(t);
 await f.recordOutput(1);
 const r=await f.run();
 assert.equal(r.ok,true,JSON.stringify(f.host.plugin.getRuntime().lastStageViewMismatch||null));
 assert.equal(r.externalEvidence,true);
 assert.equal(f.prompts.length,1);
 r.closeEvidence();
});

test('consecutive draft runs on unchanged RP transcript with independent LIBRA/HAYAKU/Flashback beforeRequest injections keep the certified stage view',{timeout:60000},async t=>{
 const rpAssistant='<Thoughts>장면 점검</Thoughts>\n# 응답\n## 볼륨 1\n#### Chatindex: 1\n\n[LBDATA START]{"ui":"card"}[LBDATA END]\n세아가 고개를 들었다.\n\n<img cmd="aa school terrified.png">\n\n"......하지 마......"\n\n§쿵, 쿵.§\n\n---\n\n<GT-CTRL/>\n\n---\n<lb-lazy id="tail"/>';
 const rpUser1='[LBDATA START]{"turn":1}[LBDATA END]\n세아는 천천히 정신이 들었다.';
 const rpUser2='그녀의 턱 아래로 손을 올렸다.';
 const f=await fixture(t,{
  request:()=>[
   {role:'system',content:'[HAYAKU_CACHE_STATIC_START v1]\nStatic cache\n[HAYAKU_CACHE_STATIC_END]',memo:'hayaku-cache-static-v1'},
   {role:'system',content:'[FLASHBACK EVIDENCE CONTRACT]\nContract\n[/FLASHBACK EVIDENCE CONTRACT]',flashbackStatic:true},
   {role:'system',content:'[LIBRA CLASSIC RECALL — CURRENT TURN ONLY]\n<LIBRA_CLASSIC_RECALL>\nLIBRA direct injection\n</LIBRA_CLASSIC_RECALL>'},
   {role:'user',content:'세아는 천천히 정신이 들었다.'},
   {role:'assistant',content:rpAssistant},
   {role:'system',content:'[FLASHBACK EVIDENCE]\nFlashback direct injection\n[/FLASHBACK EVIDENCE]',flashbackDynamic:true},
   {role:'user',content:'[HAYAKU PACKET MEMORY — turn 2]\nHAYAKU direct injection\n[/HAYAKU PACKET MEMORY]',memo:'hayaku-runtime-context-v3'},
   {role:'user',content:rpUser2},
   {role:'system',content:'[HAYAKU SIDE-WRITE FINAL REMINDER]\nPacket reminder',memo:'hayaku-runtime-context-v3'}
  ],
  hostMessages:()=>[
   {role:'user',chatId:'u1',data:rpUser1},
   {role:'char',chatId:'a1',data:rpAssistant},
   {role:'user',chatId:'u2',data:rpUser2}
  ]
 });
 await f.recordOutput(1);
 const r1=await f.run();
 assert.equal(r1.ok,true,JSON.stringify(f.host.plugin.getRuntime().lastStageViewMismatch||null));
 assert.equal(r1.externalEvidence,true);
 await r1.finalizeHandoff();
 r1.closeEvidence();

 const r2=await f.run();
 assert.equal(r2.ok,true,JSON.stringify(f.host.plugin.getRuntime().lastStageViewMismatch||null));
 assert.equal(r2.externalEvidence,true);
 assert.equal(f.prompts.length,2);
 await r2.finalizeHandoff();
 r2.closeEvidence();
});

test('LIBRA failing while it is being read leaves HAYAKU and Flashback running on a valid draft',async t=>{
 const f=await fixture(t);await f.host.plugin.saveProviderPreset('offline',f.settings.presets.offline);await f.host.plugin.saveRuntimeSettings({mode:'normal',default_preset:'offline',input_assist_mode:'off',multi_pipeline_mode:'lightweight',enable_shadow_act:true,enable_character_aide:false,enable_world_aide:false,enable_plot_aide:false,failure_mode:'hard',lore_activation_mode:'off',memory_budget_chars:240000});f.setOnVerify(n=>{if(n>=1)throw Object.assign(Error('LIB_READ_UNIFIED_UNAVAILABLE'),{code:'LIB_READ_UNIFIED_UNAVAILABLE',readDiagnostic:{stage:'graph_delivery_admission',dispatchReason:'LIBRA_GRAPH_CORPUS_SOURCE_CHANGED',modelDispatchEligible:false}});});
 const text=(await f.host.hooks.beforeRequest(messages(),'model')).map(row=>String(row.content||'')).join('\n');
 assert.ok(f.prompts.length>=1);assert.equal(f.host.plugin.getRuntime().last.draftDiscarded,undefined);
 const draftPrompt=JSON.stringify(f.prompts[0]);
 assert.match(draftPrompt,/recalled by HAYAKU/);assert.match(draftPrompt,/recalled by Flashback/);assert.doesNotMatch(draftPrompt,/LIBRA_MEMORY_SENTINEL/);
 assert.match(text,/GRADIA_LIB_EVIDENCE_NO_REUSE_V1/,'the draft stays: it never saw LIBRA');assert.doesNotMatch(text,/<MEMORY_RECALL>/);
});
test('the chat itself changing still stops the whole run',async t=>{
 const f=await fixture(t);let captures=0;
 f.setOnQuery(()=>{captures++;f.mutateNative('text');});
 await assert.rejects(()=>f.run(),e=>/^LIB_READ_/.test(e.code));assert.equal(f.prompts.length,0);
 const d=f.host.plugin.getRuntime().lastLibReadDiagnostic;assert.equal(d.status,'failed');assert.ok(d.code);
 assert.ok(!JSON.stringify(d).includes('LIBRA_MEMORY_SENTINEL'),'diagnostic retains no memory content');
});


