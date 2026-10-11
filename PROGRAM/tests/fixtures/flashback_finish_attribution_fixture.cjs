'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {AsyncLocalStorage}=require('node:async_hooks');
const {createFixture}=require('./flashback_native_runtime_fixture.cjs');
const PROGRAM=path.resolve(__dirname,'../..'),PLUGIN=process.env.FLASHBACK_APPEND_SOURCE||path.join(PROGRAM,'plugins/Flashback_Memory.js');
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
const turnMarker=(turn,variant='A')=>{let value=turn,letters='';for(let i=0;i<5;i++){letters=String.fromCharCode(97+value%26)+letters;value=Math.floor(value/26);}return 'Sigil'+letters+variant;};
const fixedVectorForTurn=turn=>{const bytes=crypto.createHash('sha256').update(turnMarker(turn)).digest();return Array.from({length:32},(_,i)=>(bytes[Math.floor(i/8)]>>(i%8))&1?1:-1);};
const fixtureVectorForQuery=input=>{const match=String(input).match(/sigil([a-z]{5})[a-z]/i);const turn=match?[...match[1].toLowerCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-97,0):1;return fixedVectorForTurn(turn);};
const turnMessages=(turn,variant='A')=>{
 const serial=String(turn).padStart(6,'0'),marker=turnMarker(turn,variant);
 return [{role:'user',chatId:'gold-u-'+serial,data:'Retrieve the sealed observatory log '+marker+'.'},
 {role:'assistant',chatId:'gold-a-'+serial,data:'The codeword '+marker+' identifies the brass ledger in locker '+serial+'. A copper compass and violet ribbon remain beside its sealed envelope.'}];
};
function diskStore(root,label,trace,phase=()=>null,readAttribution=()=>({}),beforeRead=null){
 const dir=path.join(root,label);fs.mkdirSync(dir,{recursive:true});
 const fileFor=k=>path.join(dir,hash(String(k))+'.json'),family=k=>String(k).includes('local-vector-shard')?'vector':String(k).includes(':shard:')?'rawShard':String(k).includes('turn_worldline')?'worldline':String(k).includes('manifest')?'manifest':'other';
 const store={fault:null,dir,async getItem(key){
  if(beforeRead)await beforeRead(key);
  const file=fileFor(key);let raw;try{raw=fs.readFileSync(file);}catch(e){if(e.code!=='ENOENT')throw e;trace.push({at:performance.now(),store:label,op:'get',family:family(key),key:String(key),bytes:0,physicalBytes:0,phase:phase(),...readAttribution(key)});return null;}
  const envelope=JSON.parse(raw.toString('utf8'));assert.equal(envelope.key,String(key));
  const v=envelope.value;trace.push({at:performance.now(),store:label,op:'get',family:family(key),key:String(key),bytes:Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v)),physicalBytes:raw.length,phase:phase(),...readAttribution(key)});return v;
 },async setItem(key,value){
  const action=store.fault?.('set',String(key),value);if(action==='throw')throw Error('INJECTED_WRITE_REFUSED');if(action==='false')return false;
  const clean=action==='corrupt'?'{corrupt':value,raw=Buffer.from(JSON.stringify({key:String(key),value:clean})),file=fileFor(key);
  if(action!=='noop'){const fd=fs.openSync(file,'w');try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  trace.push({at:performance.now(),store:label,op:'set',family:family(key),key:String(key),bytes:Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value)),physicalBytes:action==='noop'?0:raw.length});
  if(action==='write_throw')throw Error('INJECTED_ACK_LOST');return true;
 },async removeItem(key){try{fs.unlinkSync(fileFor(key));}catch(e){if(e.code!=='ENOENT')throw e;}trace.push({at:performance.now(),store:label,op:'remove',family:family(key),key:String(key),bytes:0,physicalBytes:0});return true;
 },fileFor,async keys(){return fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')).key);},
 get values(){return new Map(fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>{const e=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));return[e.key,e.value];}));}
 };return store;
}
function ioSummary(trace){
 const out={reads:0,writes:0,readBytes:0,writeBytes:0,physicalReadBytes:0,physicalWriteBytes:0,byFamily:{}};
 for(const e of trace){const b=out.byFamily[e.store+'/'+e.family]||={reads:0,writes:0,readBytes:0,writeBytes:0};
 if(e.op==='get'){out.reads++;out.readBytes+=e.bytes;out.physicalReadBytes+=e.physicalBytes;b.reads++;b.readBytes+=e.bytes;}
 if(e.op==='set'){out.writes++;out.writeBytes+=e.bytes;out.physicalWriteBytes+=e.physicalBytes;b.writes++;b.writeBytes+=e.bytes;}}
 return out;
}
async function createCostFixture(options={}){
 const root=options.root||fs.mkdtempSync(path.join(os.tmpdir(),'flashback-append-cost-')),trace=[];
 let runtimeContext=null;
 const finishOperations=new AsyncLocalStorage(),startupReads=new AsyncLocalStorage();let finishSequence=0;
 let startupTwoReadsResolve,finishCompletedResolve,finishStartedResolve;
 const finishStarted=new Promise(resolve=>finishStartedResolve=resolve);
 const startupTwoReads=new Promise(resolve=>startupTwoReadsResolve=resolve),finishCompleted=new Promise(resolve=>finishCompletedResolve=resolve);
 const beforeRead=options.realStartupOverlap?async key=>{const context=startupReads.getStore();if(!context||!String(key).includes(':shard:'))return;context.reads++;if(context.reads===3)await finishCompleted;}:null;
 const phase=()=>options.scopedFinishAttribution?finishOperations.getStore()?.phase||null:runtimeContext?.__appendCostStage||null;
 const captureReadStack=()=>{const previous=Error.stackTraceLimit;try{Error.stackTraceLimit=40;return new Error('physical raw read attribution').stack;}finally{Error.stackTraceLimit=previous;}};
 const readAttribution=key=>{if(startupReads.getStore()?.reads===2&&String(key).includes(':shard:'))startupTwoReadsResolve();return options.finishReadAttribution&&String(key).includes(':shard:')?{asyncPhase:finishOperations.getStore()?.phase||null,finishOperationId:finishOperations.getStore()?.id||null,legacyPhase:runtimeContext?.__appendCostStage||null,backgroundOrigin:startupReads.getStore()?.origin||null,backgroundReadOrdinal:startupReads.getStore()?.reads||null,readStack:captureReadStack()}:{};};
 const pluginStorage=options.pluginStorage||diskStore(root,'plugin',trace,phase,readAttribution,beforeRead),safeLocalStorage=options.safeLocalStorage||diskStore(root,'local',trace,phase,readAttribution,beforeRead);
 let source=fs.readFileSync(PLUGIN,'utf8').replace('const finishPublishedRawEmbedding = async','const finishPublishedRawEmbeddingImplementation = async')
 .replace('      const preparedBinding = flashbackRecallPreparations.get(recall)?.binding;','      await globalThis.__rawCowBeforeConsumer?.(recall);\n      const preparedBinding = flashbackRecallPreparations.get(recall)?.binding;')
 .replace('  const ingestSources = async','  const finishPublishedRawEmbedding = async (...args) => (globalThis.__appendCostRunFinish || (task => task()))(async () => { globalThis.__appendCostDurableAckAt=performance.now(); globalThis.__appendCostStage="finish"; globalThis.__appendCostFinishStarted?.(); globalThis.__appendCostPublication=args[4]; try { await globalThis.__appendCostBeforeFinish?.(...args); return await finishPublishedRawEmbeddingImplementation(...args); } finally { globalThis.__appendCostStage=null; globalThis.__appendCostFinishCompleted?.(); } });\n  const ingestSources = async')
 .replace('    const saveStartedAt = Date.now();','    globalThis.__rawCowWriterCalls?.push({ stack: new Error().stack, metadataOnly: saveOptions.metadataOnly === true, publicationSources: [...(saveOptions.publicationSourceHashes || [])], recordCount: records.length });\n    const saveStartedAt = Date.now();')
 .replace('    const prev = sharedScopeWriteLocks.get(key) || Promise.resolve();','    const __appendCostQueueAt=performance.now();\n    const prev = sharedScopeWriteLocks.get(key) || Promise.resolve();')
 .replace('    await prev.catch(() => {});','    await prev.catch(() => {});\n    if(globalThis.__appendCostTurnActive)(globalThis.__appendCostQueueWaits ||= []).push({scopeKey:key,waitMs:performance.now()-__appendCostQueueAt});')
 .replace('  globalThis.__FlashbackMemory = publicApi;',
 '  globalThis.__appendCost = { ingestSources, saveScopeRecords, loadScopeRecordsRaw, scopeKeys, storageShardChecksum, embeddingCheckpointDigest, cleanupListedScopeShardOrphans, flashbackRecallPreparations, finishPublishedRawEmbedding, Runtime };\n  globalThis.__FlashbackMemory = publicApi;');
 if(options.ownerDiagnostics){
  source=source.replace('    flashbackOwnerWriters += 1; flashbackOwnerEpoch += 1;', '    const debugOwnerId=(globalThis.__appendOwnerSeq=(globalThis.__appendOwnerSeq||0)+1);(globalThis.__appendOwnerEvents||=[]).push({id:debugOwnerId,event:"enter",stack:new Error().stack}); flashbackOwnerWriters += 1; flashbackOwnerEpoch += 1;')
    .replace('flashbackOwnerWriters-=1;', 'flashbackOwnerWriters-=1;(globalThis.__appendOwnerEvents||=[]).push({id:debugOwnerId,event:"exit"});')
    .replace('  globalThis.__appendCost = {', '  globalThis.__appendOwnerSnapshot=()=>({writers:flashbackOwnerWriters,lease:flashbackOwnerLease?{kind:flashbackOwnerLease.kind,ended:flashbackOwnerLease.ended,holds:flashbackOwnerLease.holds.size}:null,events:globalThis.__appendOwnerEvents||[]}); globalThis.__appendCost = {');
 }
 if(options.realStartupOverlap){
  const start=source.indexOf('  const restoreLegacyCompactedSourceScope = async');
  const end=source.indexOf('  const ',start+source.slice(start).indexOf('\n  };')+5);
  assert(start>=0&&end>start,'the real startup recovery function must exist');
  const original=source.slice(start,end);
  const body=original.replace('    const core = await withScopeWriteLock(scope.scopeKey, async () => {','    await globalThis.__appendCostWaitStartupBeforeLock?.();\n    const core = await withScopeWriteLock(scope.scopeKey, async () => {').replace('      const raw = await loadScopeRecordsRaw(scope.scopeKey);', '      const raw = await (globalThis.__appendCostObserveStartupRaw || (task => task()))(() => loadScopeRecordsRaw(scope.scopeKey));');
  assert.notEqual(body,original,'observe the original recovery reader without issuing extra I/O');
  source=source.slice(0,start)+body+source.slice(end);
 }
 if(options.finishReadAttribution)source=source.replace('    const hashes = new Set(requestedRecords.map(record => record.sourceHash));', '    globalThis.__appendCostPublicationPages?.(publication.pages);\n    const hashes = new Set(requestedRecords.map(record => record.sourceHash));');
 let providerCalls=0,mockQueryCalls=0;
 const f=await createFixture({source,pluginStorage,safeLocalStorage,chat:options.chat,arguments:{hook_recall_timeout_ms:'20000',...options.arguments},exposeStorageBridge:true,nativeFetch:async(url,init)=>{
  if(options.precomputedVectors&&String(url).startsWith('https://fixture.invalid/')){mockQueryCalls++;const input=JSON.parse(init.body).input;return{ok:true,status:200,async json(){return{data:(Array.isArray(input)?input:[input]).map((text,index)=>({index,embedding:fixtureVectorForQuery(text)}))};}};}
  providerCalls++;throw Error('NO_MODEL_PROVIDER_ALLOWED');
 }});
 runtimeContext=f.context;
 if(options.finishReadAttribution||options.scopedFinishAttribution){
  f.context.__appendCostRunFinish=task=>finishOperations.run({phase:'finish',id:++finishSequence},task);
  f.context.__appendCostPublicationPages=pages=>trace.push({op:'publication-pages',pageCount:pages.length,pageIndexes:pages.map(page=>page.index),serializedBytes:pages.map(page=>Buffer.byteLength(page.serialized)),finishOperationId:finishOperations.getStore()?.id||null});
 }
 if(options.realStartupOverlap){
  f.context.__appendCostFinishStarted=()=>finishStartedResolve();
  f.context.__appendCostWaitStartupBeforeLock=async()=>{assert.equal(finishOperations.getStore(),undefined,'scheduled startup callback is an independent async origin');const stack=captureReadStack();await finishStarted;trace.push({op:'startup-read-origin',origin:'scheduled restoreLegacyCompactedSourceScope before writer lock',stack});};
  f.context.__appendCostObserveStartupRaw=async task=>{
   assert.equal(finishOperations.getStore(),undefined,'real scheduled recovery originates outside the finish operation');
   trace.push({op:'startup-read-origin',origin:'restoreLegacyCompactedSourceScope',stack:captureReadStack()});
   return await startupReads.run({origin:'restoreLegacyCompactedSourceScope',reads:0},task);
  };
  f.context.__appendCostFinishCompleted=()=>finishCompletedResolve();
 }
 const waitForRealStartupRead=async()=>{
  let timer;try{await Promise.race([startupTwoReads,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('REAL_STARTUP_READ_OBSERVER_NOT_REACHED')),15000);})]);}finally{clearTimeout(timer);}
 };
 const readOutsideFinish=()=>finishOperations.exit(()=>Promise.resolve().then(()=>f.context.__appendCost.loadScopeRecordsRaw(scope.scopeKey)));
 if(options.beforeFinish)f.context.__appendCostBeforeFinish=(...args)=>options.beforeFinish({f,pluginStorage,safeLocalStorage,trace,readOutsideFinish,waitForRealStartupRead},...args);
 if(options.beforeConsumer)f.context.__rawCowBeforeConsumer=recall=>options.beforeConsumer({f,pluginStorage,safeLocalStorage,trace},recall);
 const cfg=f.api._test.normalizeSettings({embeddingEnabled:options.precomputedVectors===true,embeddingProvider:'openai_compat',embeddingModel:'cost-fixed-vector-v1',embeddingDimensions:32,embeddingUrl:'https://fixture.invalid/v1',embeddingAutoProcess:false,autoColdStart:false,autoEpisodeIndex:false,episodeIndexEnabled:false,autoCleanup:false,maxResponseItems:50000,hookRecallTimeoutMs:30000,...options.settings});
 await f.api.saveSettings(cfg);
 const t=f.api._test,scope=await f.api.resolveCurrentScope(false);
 const currentSources=()=>t.collectLiveChatSourcesFromSnapshot({character:f.character,chat:f.currentChat,characterIndex:0,chatIndex:0});
 const read=()=>t.loadScopeRecords(scope.scopeKey);
 const clearTrace=()=>{trace.length=0;};
 const seed=async n=>{
  f.currentChat.message=Array.from({length:n},(_,i)=>turnMessages(i+1)).flat();f.currentChat.messages=f.currentChat.message;
  const sources=currentSources();assert.equal(sources.length,n);
  const started=performance.now();const records=await t.buildRecordsFromSources(sources,cfg,scope,{deferEmbedding:true});
  if(options.precomputedVectors)for(const record of records){delete record.embeddingWork;delete record.embeddingReceipt;Object.assign(record,{vector:fixedVectorForTurn(t.finiteTurnIndex(record)),dim:32,embeddingDimensions:32,provider:cfg.embeddingProvider,embeddingProvider:cfg.embeddingProvider,model:cfg.embeddingModel,embeddingModel:cfg.embeddingModel,embeddingProfileId:t.embeddingProfileId(cfg,32)});}
  await t.saveAllRecords(records,cfg,scope);
  const loaded=await read();assert.equal(loaded.records.length,n);
  for(const s of sources)assert(loaded.records.some(r=>r.sourceHash===s.sourceHash&&r.text===s.text),'source exactness after seed');
  clearTrace();return{ms:performance.now()-started,sourceDigest:hash(sources.map(s=>[s.sourceId,s.sourceHash,s.text])),sources,records:loaded.records,manifest:loaded.manifest};
 };
 const append=async(turn,variant='A',mode='ingest')=>{
  f.currentChat.message.push(...turnMessages(turn,variant));f.currentChat.messages=f.currentChat.message;
  const sources=currentSources(),source=sources.at(-1);assert(source.text.includes(turnMarker(turn,variant)));
  clearTrace();const began=performance.now();f.context.__appendCostTurnActive=true;f.context.__appendCostQueueWaits=[];f.context.__appendCostDurableAckAt=null;let result;
  if(mode==='ingest')result=await f.context.__appendCost.ingestSources([source],cfg,scope,{deferEmbedding:true,replaceTurnPair:true,skipEpisodeRebuild:true});
  else {const handlers=await f.dispatchRisuChatEvent('output',{char:f.character,chat:f.currentChat,characterIndex:0,chatIndex:0,messageIndex:f.currentChat.message.length-1});assert.equal(handlers,1);
   const deadline=performance.now()+30000;for(;;){const state=f.api.getCaptureBackendState();if(state.lastOutputCapture?.saved){result=f.context.__appendCost.Runtime.lastCapture;break;}if(performance.now()>deadline)throw Error('CAPTURE_DURABLE_WAIT_TIMEOUT');await new Promise(r=>setTimeout(r,2));}}
  const ended=performance.now();f.context.__appendCostTurnActive=false;const events=trace.slice(),io=ioSummary(events);
  const loaded=await read(),actual=loaded.records.find(r=>r.text===source.text&&(mode==='output'||r.sourceHash===source.sourceHash));assert(actual,'append exact source survives physical reader');
  const durableAckMs=f.context.__appendCostDurableAckAt==null?null:f.context.__appendCostDurableAckAt-began;
  return{result:clone(result),durationMs:ended-began,source:clone(mode==='output'?actual:source),sourceSha256:hash(source.text),sourceUtf8Bytes:Buffer.byteLength(source.text),events,io,loaded,
   frontiers:{criticalPathMs:ended-began,durableRaw:'publication_verified',durableAckMs,writerQueueWaitMs:f.context.__appendCostQueueWaits.reduce((n,row)=>n+row.waitMs,0),writerQueueWaits:clone(f.context.__appendCostQueueWaits),
    memoryReady:'raw_only',rawPendingDecisionMs:ended-began,indexReady:'summary_catalog_at_raw_publication',summaryCatalogAckUpperBoundMs:durableAckMs,semanticMemoryReadyMs:null,embeddingIndexReadyMs:null,
    embeddingReady:false,analysisQueueWaitMs:null,backlogPendingNewRecords:Number(result?.embeddingPending||0)}};
 };
 return{f,t,cfg,scope,root,trace,waitForRealStartupRead,pluginStorage,safeLocalStorage,seed,append,read,currentSources,clearTrace,ioSummary,providerCalls:()=>providerCalls,mockQueryCalls:()=>mockQueryCalls,hash,clone,turnMessages,async dispose(){await f.dispose();}};
}
module.exports={createCostFixture,diskStore,ioSummary,turnMessages,turnMarker,fixedVectorForTurn,hash,clone};
