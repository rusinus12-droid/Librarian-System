'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { createFlashback } = require('./fixtures/embedding_contract_harness.cjs');
const { awaitScopeRetirement } = require('./fixtures/flashback_retirement_lifecycle.cjs');
const PROGRAM = path.resolve(__dirname, '..');
const ARTIFACTS = process.env.FLASHBACK_DIAGNOSTIC_ARTIFACTS;
const QUERY = 'Where is the brass key in the north library cabinet?';
const SOURCE = { sourceType: 'response', sourceId: 'diagnostic-source', sourceHash: 'diagnostic-hash', origin: 'live_chat', role: 'turn_pair', turnIndex: 1, pairIndex: 1,
  text: 'User:\nWhere is the brass key?\n\n---\n\nAssistant:\nThe brass key is inside the north library cabinet, tied with a blue ribbon.' };
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise, ms = 5000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('diagnostic artifact boundary did not settle')), ms); })]); } finally { clearTimeout(timer); } }
function storeFrom(values) { const map = new Map(values.map(([key,value]) => [key, typeof value === 'string' ? value : structuredClone(value)]));return { values: map, async getItem(key){return map.has(String(key))?map.get(String(key)):null;},async setItem(key,value){map.set(String(key),value);return true;},async removeItem(key){map.delete(String(key));return true;},async keys(){return [...map.keys()];}}; }
async function seed() {
  const f = await createFlashback(PROGRAM, { waitForLoaded: true });
  try {
    const cfg = f.api._test.normalizeSettings({ embeddingEnabled: true, embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-small', embeddingDimensions: 3,
      embeddingUrl: 'https://provider.invalid/v1/embeddings', embeddingMaxRetries: 0, autoEpisodeIndex: false, contextualRecall: false, currentSceneTailEnabled: false, minScore: 0 });
    await f.api.saveSettings(cfg);const scope = await f.api.resolveCurrentScope(false);
    f.host.nativeFetch = async (_url,init) => ({ok:true,status:200,async json(){return {data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))};}});
    const raw = await f.api._test.buildRecordsFromSources([SOURCE], cfg, scope, {deferEmbedding:true});await f.api._test.saveAllRecords(raw,cfg,scope);
    assert.equal((await f.api.processPendingEmbeddingWork({sourceHash:SOURCE.sourceHash})).ready,1);
    await f.api._test.loadScopeRecords(scope.scopeKey);await awaitScopeRetirement(f.audit.Runtime,scope.scopeKey);
    return {cfg,scope,plugin:[...f.pluginStorage.values],local:[...f.safeLocalStorage.values]};
  } finally { await f.cleanup(); }
}
let prepared;
async function consumer(variant) {
  prepared ||= await seed();
  const program = variant==='source'?PROGRAM:path.join(ARTIFACTS,variant);
  const plugin=path.join(program,'plugins/Flashback_Memory.js');const bytes=fs.readFileSync(plugin);const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const f=await createFlashback(program,{exactSource:true,waitForLoaded:true,pluginStorage:storeFrom(prepared.plugin),safeLocalStorage:storeFrom(prepared.local)});
  assert.equal(f.audit,undefined,'exact consumer has no injected fixture exports');
  if(variant!=='source')assert.equal(f.api._test,undefined,'shipping artifact has no private test surface');
  const scope=await f.api.resolveCurrentScope(false);assert.equal(scope.scopeKey,prepared.scope.scopeKey);
  let calls=0;f.host.nativeFetch=async(_url,init)=>{calls++;return {ok:true,status:200,async json(){return {data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0,0]}))};}};};
  return Object.assign(f,{scope,cfg:prepared.cfg,variant,pluginHash:hash,calls:()=>calls,portable:f.context.__FlashbackPortableMemoryBackup});
}
for(const variant of ['source','Full','Min']) {
 const options={skip:variant!=='source'&&!ARTIFACTS,timeout:20000};
 test(`${variant} exact portable owner rejects duplicate and resumes sidecar roundtrip`,options,async()=>{
  const f=await consumer(variant);const entered=deferred(),release=deferred();let first;
  const keys=f.pluginStorage.keys.bind(f.pluginStorage);let blocked=false;
  f.pluginStorage.keys=async()=>{if(!blocked){blocked=true;entered.resolve();await release.promise;}return keys();};
  try{
   first=f.portable.exportCurrentScope();await within(entered.promise);const id=f.portable.status().operationId;assert(id);
   await assert.rejects(()=>f.portable.exportCurrentScope(),error=>error?.code==='FLASHBACK_PORTABLE_MEMORY_BUSY');
   assert.equal(f.portable.status().operationId,id,'rejected duplicate retains first ownership');release.resolve();const envelope=await within(first);
   assert.equal(f.portable.status().busy,false);assert.equal(f.portable.status().operationId,'');assert.equal(envelope.localVectorSidecars.length,1);
   const sidecar=envelope.localVectorSidecars[0];await f.safeLocalStorage.removeItem(sidecar.key);const result=await within(f.portable.restoreCurrentScope(envelope));
   assert.equal(result.ok,true);assert.equal(result.vectorSidecars,1);assert.deepEqual(plain(await f.safeLocalStorage.getItem(sidecar.key)),plain(sidecar.value));
   const successor=await within(f.portable.exportCurrentScope());assert.equal(successor.inventory.localVectorSidecarCount,1);assert.equal(f.calls(),0);
   console.log(JSON.stringify({variant,sha256:f.pluginHash,case:'portable',restored:true}));
  }finally{release.resolve();if(first)await first.catch(()=>{});await f.cleanup();}
 });
 test(`${variant} exact final-read model change retains safe changed diagnostic`,options,async()=>{
  const f=await consumer(variant);let queryFinished=false,changed=false;const provider=f.host.nativeFetch;
  f.host.nativeFetch=async(...args)=>{const reply=await provider(...args);queryFinished=true;return reply;};const get=f.pluginStorage.getItem.bind(f.pluginStorage);
  f.pluginStorage.getItem=async key=>{const raw=await get(key);if(queryFinished&&!changed&&String(key).includes(':shard:')){changed=true;await f.api.saveSettings({...f.cfg,embeddingModel:'changed-final-model'});}return raw;};
  try{const result=await f.api.recallRecords(QUERY,f.cfg,f.scope,{currentPairIndex:10});assert(changed);assert.equal(result.records.length,0);assert.equal(result.currentStateFacts?.length||0,0);assert.ok(result.modelReadiness,'model change has explicit diagnostic');assert.equal(result.modelReadiness.status,'changed');assert.equal(result.modelReadiness.ready,false);assert.match(result.fallbackWarning,/원문은 보관/);console.log(JSON.stringify({variant,sha256:f.pluginHash,case:'profile',safe:true}));}finally{await f.cleanup();}
 });
 test(`${variant} exact isolated HTTP503 retains model diagnostic without memory`,options,async()=>{
  const f=await consumer(variant);let calls=0;f.host.nativeFetch=async()=>{calls++;return {ok:false,status:503,async json(){return {error:{message:'synthetic isolated artifact failure'}};}};};
  try{const output=await f.api.uiStatus().registered.before([{role:'user',content:QUERY}],'model');assert.equal(calls,1);assert(!JSON.stringify(output).includes('blue ribbon'));const state=(await f.api.debugState()).lastRecall;assert.equal(state.modelReadiness.status,'query_failed');assert.equal(state.modelReadiness.ready,false);assert.match(state.fallbackWarning,/원문은 보관/);console.log(JSON.stringify({variant,sha256:f.pluginHash,case:'503-isolated',safe:true}));}finally{await f.cleanup();}
 });
 test(`${variant} exact retirement plus HTTP503 preserves cancellation precedence`,options,async()=>{
  const f=await consumer(variant);const key=[...f.pluginStorage.values.keys()].find(k=>k.includes(':scope:')&&k.endsWith(':manifest:v2'));const raw=f.pluginStorage.values.get(key);const manifest=typeof raw==='string'?JSON.parse(raw):structuredClone(raw);manifest.externalRetirementVersion=0;f.pluginStorage.values.set(key,typeof raw==='string'?JSON.stringify(manifest):manifest);
  const entered=deferred(),releaseWrite=deferred(),submitted=deferred(),releaseProvider=deferred(),writeDone=deferred();let blocked=false,calls=0,pending;const set=f.pluginStorage.setItem.bind(f.pluginStorage);
  f.pluginStorage.setItem=async(k,v)=>{let value;try{value=typeof v==='string'?JSON.parse(v):v;}catch{}if(!blocked&&k===key&&value?.externalRetirementVersion>0){blocked=true;entered.resolve();await releaseWrite.promise;const result=await set(k,v);writeDone.resolve();return result;}return set(k,v);};
  f.host.nativeFetch=async()=>{calls++;submitted.resolve();await releaseProvider.promise;return {ok:false,status:503,async json(){return {error:{message:'synthetic overlapping artifact failure'}};}};};
  try{pending=f.api.uiStatus().registered.before([{role:'user',content:QUERY}],'model');await within(Promise.all([entered.promise,submitted.promise]));releaseWrite.resolve();await within(writeDone.promise);releaseProvider.resolve();const output=await within(pending);assert.equal(calls,1);assert(!JSON.stringify(output).includes('blue ribbon'));const state=(await f.api.debugState()).lastRecall;assert.equal(state.reason,'FLASHBACK_RECALL_EXPIRED');assert.equal(state.skipped,true);console.log(JSON.stringify({variant,sha256:f.pluginHash,case:'503-overlap',expired:true}));}finally{releaseWrite.resolve();releaseProvider.resolve();if(pending)await pending.catch(()=>{});await f.cleanup();}
 });
}
