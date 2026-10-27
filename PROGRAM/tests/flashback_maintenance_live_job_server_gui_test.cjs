'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
const {createColdStartGuiDocument}=require('./fixtures/hayaku_cold_start_gui_dom_fixture.cjs');
const {until}=require('./fixtures/libra_gui_memory_dom_host.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
const pair=i=>[{role:'user',chatId:'u'+i,data:`Where is parcel ${i}?`},{role:'assistant',chatId:'a'+i,data:`Parcel ${i} remains in the eastern cabinet beside the marble clock.`}];
for(const scenario of ['pending_queue','missing_turn'])test(`real server ${scenario} GUI action reports live work and durable completion`,async()=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'fb-live-job-gui-')),app=createMemorySuiteServer({dataDir,autoBackup:false,port:0}),address=await app.listen();
 const entered=deferred(),release=deferred(),gui=createColdStartGuiDocument();let hold=false,corpusCalls=0,healthReads=0;
 const f=await createFixture({exposeStorageBridge:true,chat:{message:scenario==='pending_queue'?[...pair(1),...pair(2)]:pair(1)},
  arguments:{memory_suite_server_url:`http://127.0.0.1:${address.port}`,embedding_key:'synthetic-key'},nativeFetch:async(url,init)=>{
   if(String(url).startsWith('https://provider.invalid/')){
    const input=JSON.parse(init.body).input;if(input.some(text=>text.includes('Parcel'))){corpusCalls++;if(hold){entered.resolve();await release.promise;}}
    return new Response(JSON.stringify({data:input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});
   }
   if(String(url).endsWith('/v1/flashback/scope-health'))healthReads++;return mockFetch(url,init);
  }});
 try{
  Object.assign(f.context,{document:gui.document,window:gui.dom.window,Event:gui.dom.window.Event,KeyboardEvent:gui.dom.window.KeyboardEvent,
   HTMLElement:gui.dom.window.HTMLElement,MutationObserver:gui.dom.window.MutationObserver,getComputedStyle:gui.dom.window.getComputedStyle.bind(gui.dom.window)});
  await f.api.saveSettings({...await f.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'server-job',embeddingUrl:'https://provider.invalid/v1',embeddingDimensions:3,
   embeddingEnabled:true,embeddingAutoProcess:false,embeddingMaxRetries:0,embeddingBatchSize:1,episodeIndexEnabled:false,autoEpisodeIndex:false,autoColdStart:false});
  const scope=await f.api.resolveCurrentScope(false);await f.context.__fixtureStorageBridge.setScopeMode({scopeId:scope.scopeKey,scopeKey:scope.scopeKey},'server_only');
  await f.api.ingestLiveChatColdStart({scope:'current',canonical:true,deferEmbedding:true,skipEpisodeRebuild:true});
  if(scenario==='missing_turn'){assert.equal((await f.api.processPendingEmbeddingQueue()).ready,1);f.currentChat.message.push(...pair(2));}
  const initialCalls=corpusCalls;hold=true;await f.api.showUi();await gui.document.querySelector('[data-go="care"]').fire('click');
  await f.context.__fixtureStorageBridge.getConnectionSettings({scope,force:true});
  await until(()=>!gui.document.querySelector('#maintenanceInspectBtn').disabled,'inspection button enabled');
  gui.document.querySelector('#maintenanceInspectBtn').click();
  const modal=await until(()=>[...gui.document.querySelectorAll('.overlay.is-open .dialog')].find(node=>!node.closest('#flashbackMaintenanceJob')),'server diagnosis').catch(error=>{error.message+='; job='+gui.document.querySelector('#flashbackMaintenanceJob')?.textContent.slice(-1500)+'; healthReads='+healthReads;throw error});
  [...modal.querySelectorAll('button')].at(-1).click();await entered.promise;
  const popup=gui.document.querySelector('#flashbackMaintenanceJob');assert.equal(popup.hidden,false);assert.match(popup.querySelector('[data-job-pending]').textContent,/[1-9]\d*건/);
  assert.equal(popup.querySelector('#maintenanceJobCancelBtn').disabled,false);if(scenario==='missing_turn')assert.match(popup.querySelector('[data-job-history]').textContent,/원문.*동기화/);
  release.resolve();await until(()=>gui.document.querySelector('#flashbackMaintenanceJob [data-job-result]')?.hidden===false,'server recovery result',12000);
  const rows=(await f.api._test.loadScopeRecords(scope.scopeKey)).records;assert.equal(rows.length,2);assert(rows.every(row=>row.embeddingReceipt?.status==='ready'));
  assert.equal(corpusCalls-initialCalls,scenario==='pending_queue'?2:1);assert(healthReads>=6);assert.deepEqual(gui.errors,[]);
 }finally{release.resolve();await f.dispose();gui.dom.window.close();await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
});
