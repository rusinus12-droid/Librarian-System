'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer,mockFetch}=require('./fixtures/flashback_in_memory_server_fixture.cjs');
const program=path.resolve(__dirname,'..');
const {createFixture}=require(path.join(program,'tests/fixtures/flashback_native_runtime_fixture.cjs'));
const sourcePath=process.argv[2]||path.join(program,'plugins/Flashback_Memory.js');
let source=fs.readFileSync(sourcePath,'utf8').replace('  globalThis.__FlashbackMemory = publicApi;','  globalThis.__unloadRuntime=Runtime;\n  globalThis.__FlashbackMemory = publicApi;')
 .replace('  const flashbackWriters = new Map();','  const flashbackWriters = new Map(); globalThis.__unloadWriters={sessions:[],lifecycle};')
 .replace('      flashbackWriters.set(alias, session);','      flashbackWriters.set(alias, session); globalThis.__unloadWriters.sessions.push(session);');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{for(let i=0;i<300;i++){const v=await fn();if(v)return v;await delay(10);}throw Error('independent repro wait timed out');};
const USER='I check the gauge and step back.',REPLY='The needle holds at the red mark and the spare valve hangs on the north wall hook.',FACT='needle holds at the red mark';
const cfg={embeddingProvider:'openai_compat',embeddingModel:'offline-triage-model',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,embeddingEnabled:true,captureAfterRequest:true,episodeIndexEnabled:false,hookRecallTimeoutMs:5000,maxInjectionChars:4000};
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'followup-unload-'));const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:dir,autoBackup:false});const address=await app.listen();
 let old,fresh,hold=false,held=null,gateOpen,seen;const gate=new Promise(r=>gateOpen=r),releaseSeen=new Promise(r=>seen=r),events=[];let activeScope;
 const rows=()=>app.repositories.flashback.database.prepare('SELECT alias,epoch,owner,expires_at FROM flashback_writer_fences').all();
 const options={source,exposeStorageBridge:true,arguments:{memory_suite_server_mode:'mirror',memory_suite_server_url:'http://127.0.0.1:'+address.port}};
 const transport=(instance,getFixture)=>async(url,init)=>{
  if(String(url).startsWith('https://fixture.invalid/'))return {ok:true,status:200,async json(){return {data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))};}};
  let event=null;
  if(String(url).endsWith('/writer')){
   const body=JSON.parse(init.body);event={instance,action:body.action,owner:body.owner,epoch:body.epoch,unloaded:getFixture()?.context.__unloadRuntime?.unloaded===true};events.push(event);
   if(hold&&!held&&body.action==='release'){
    const stored=app.repositories.flashback.get('plugin',body.key);let manifest;try{manifest=JSON.parse(stored.value);}catch{}
    if(manifest?.count===1){
     const readback=await old.api._test.loadScopeRecords(activeScope.scopeKey);assert(readback.records.some(r=>r.text.includes(FACT)));
     held={owner:body.owner,epoch:body.epoch};seen();await gate;
    }
   }
  }
  try{const res=await mockFetch(url,init);if(event)event.status=res.status;return res;}catch(e){if(event)event.error=e.message;throw e;}
 };
 try{
  old=await createFixture({...options,nativeFetch:transport(1,()=>old)});await wait(()=>old.api.getCaptureBackendState().registered);
  await old.api.saveSettings({...await old.api.loadSettings(),...cfg});await old.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  await old.api._selectionTest.beforeRequest([{role:'user',chatId:'u1',content:USER}],'model');await delay(50);
  old.currentChat.message=[{role:'user',chatId:'u1',data:USER},{role:'assistant',chatId:'a1',data:REPLY}];old.currentChat.messages=old.currentChat.message;activeScope=await old.api.resolveCurrentScope();hold=true;
  await old.dispatchRisuChatEvent('output',{char:old.character,chat:old.currentChat,characterIndex:0,chatIndex:0,messageIndex:1});await releaseSeen;
  const shared={pluginStorage:old.pluginStorage,safeLocalStorage:old.host.safeLocalStorage,chat:structuredClone(old.currentChat)};
  const drainPromises=[...old.context.__unloadRuntime.chatOutputWorkerQueues.values(),...old.context.__unloadRuntime.externalRetirementInFlight.values()];
  const started=Date.now();const disposing=old.dispose();if(process.argv[3]==='drain'){await delay(40);gateOpen();}await disposing;const unloadElapsedMs=Date.now()-started;assert(old.context.__unloadRuntime.unloaded);
  fresh=await createFixture({...options,...shared,nativeFetch:transport(2,()=>fresh)});await fresh.api.saveSettings({...await fresh.api.loadSettings(),...cfg});
  await fresh.api._selectionTest.beforeRequest([{role:'user',chatId:'u8',content:'What did the gauge show, and where is the spare valve?'}],'model');gateOpen();
  await Promise.allSettled(drainPromises);
  await old.context.__fixtureStorageBridge.whenFlashbackWritersIdle();
  assert(!events.some(e=>e.instance===1&&e.action==='acquire'&&e.unloaded),'unloaded FIFO retirement must not acquire a new writer');
  assert(!rows().some(r=>r.owner&&r.expires_at>Date.now()),'old runtime must leave no live writer lease');
  let freshWrote=false;
  const key='vector_rag_memory:scope:'+ (await fresh.api._test.loadScopeManifest(activeScope)).storageHash+':manifest:v2';
  await fresh.context.__fixtureStorageBridge.withFlashbackWriter(key,async()=>{freshWrote=true;},{forceServer:true});
  assert(freshWrote);
  const readback=await fresh.api._test.loadScopeRecords(activeScope.scopeKey);
  assert(readback.records.some(r=>r.text.includes(FACT)),'committed output remains available to the new runtime');
  assert.equal(readback.manifest.missingShards,0);
  assert(events.some(e=>e.instance===1&&e.action==='release'&&e.owner===held.owner&&e.status===200));
  console.log('UNLOAD_RECOVERY_PASS '+JSON.stringify({sourcePath,mode:process.argv[3]||'timeout',unloadElapsedMs,configuredModel:cfg.embeddingModel,
    networkCalls:0,oldLateAcquisitions:0,oldLeaseReleased:true,freshWriterSucceeded:true,committedOutputPreserved:true,events},null,2));
 }finally{gateOpen();await old?.dispose();await fresh?.dispose();await app.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
