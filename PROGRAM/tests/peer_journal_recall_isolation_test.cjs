'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
// Automatic consent journals are retired. Exercise isolation of the current local
// SourceInput preference failure from canonical activation and actual recall.
// Keep Node alive through awaited owner jobs; the official root deadline is unchanged.
const pendingRoot=setInterval(()=>{},1000);
(async()=>{
 const f=await fixture({transformSource:s=>s.replace('    async getEmbeddingSettings() {','    auditCore: () => LibraMemoryCore,\n    async getEmbeddingSettings() {')});
 try {
  await f.r.api.runManualColdStart();
  const core=f.r.api.auditCore(),ctx=await core.resolveContext();
  const manifest=()=>[...f.r.values].filter(([k])=>k.endsWith(':manifest')).map(([,v])=>JSON.parse(v)).find(m=>m.memories);
  const old=manifest().memories['1'],bytes=f.r.values.get(old.key),calls=f.control.calls.length;
  assert.equal(old.status,'committed');
  const store=f.r.context.risuai.pluginStorage,write=store.setItem;
  store.setItem=async(k,v)=>String(k).includes(':settings:source-tracking:')?true:write(k,v);
  const rules=JSON.stringify(f.r.api.getSourceEditRules());
  await assert.rejects(f.r.api.setSourceEditIgnoredTags(['external-note']),/SOURCE_INPUT_(?:WRITE_REJECTED|READBACK_FAILED)/);
  assert.equal(JSON.stringify(f.r.api.getSourceEditRules()),rules,'failed preferences never change active projection');
  for(let i=0;i<2;i++)await core.reconcileCanonicalBranchBeforeRecall(ctx,{full:true});
  assert.equal(manifest().memories['1'].status,'committed');assert.equal(f.r.values.get(old.key),bytes);assert.equal(f.control.calls.length,calls);
  const damaged=manifest();damaged.memories['1'].status='inactive';damaged.memories['1'].inactiveReason='source_edit_identity_unverified';
  await core.reconcileCanonicalBranchBeforeRecall(ctx,{full:true,manifest:damaged});
  assert.equal(manifest().memories['1'].status,'committed','matching original source reactivates previously misclassified ref');
  f.chat.message[1].data+=' A new source change.';
  await core.reconcileCanonicalBranchBeforeRecall(ctx,{full:true});
  assert.equal(manifest().memories['1'].status,'committed');assert.equal(f.r.values.get(old.key),bytes);
  assert.equal(f.control.calls.length,calls,'direct source edit and failed preferences do not grant implicit replacement');
  store.setItem=write;
  const inventory=await f.r.api.listCanonicalBatchRanges();const result=await f.r.api.startSelectedCanonicalBatches({scopeKey:inventory.scopeKey,mode:'source_edit',ranges:inventory.ranges.filter(r=>r.startTurn===1)});
  assert.equal(result.ok,true,JSON.stringify(result));assert.notEqual(manifest().memories['1'].key,old.key);assert.equal(f.r.values.get(old.key),bytes);
  console.log('PASS LIBRA current preference failure preserves canonical activation/bytes; explicit selected replacement remains available');
 } finally {await f.r.cleanup();}
 const b=await createFlashback(path.resolve(__dirname,'..'),{transformSource:s=>s
  .replace("const scopeBundle = await withinHookDeadline(resolveCurrentScopeIdentityBundle(false), 'beforeRequest scope identity');","if(globalThis.auditScopeFail)throw Error('UNRELATED_SCOPE_FAILURE'); const scopeBundle = await withinHookDeadline(resolveCurrentScopeIdentityBundle(false), 'beforeRequest scope identity');")
  .replace('beforeRequest, pendingCaptureRuntimeSnapshot:', 'beforeRequest, afterRequest, pendingCaptureRuntimeSnapshot:')
  .replace('const reconciled = await withinHookDeadline(','globalThis.auditReachedRecallPreparation=true; const reconciled = await withinHookDeadline(')});
 try {
  const chat=await b.host.getChat();chat.message=[{role:'user',chatId:'u1',data:'Where is Alice?'},{role:'assistant',chatId:'a1',data:'Alice is in the office.'}];chat.messages=chat.message;
  let modelRequests=0;b.host.nativeFetch=async(_url,init)=>{modelRequests++;const body=JSON.parse(init.body),inputs=Array.isArray(body.input)?body.input:[body.input];return new Response(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200});};
  await b.api.saveSettings({...await b.api.loadSettings(),embeddingProvider:'openai_compat',embeddingModel:'offline-fixture',embeddingUrl:'https://fixture.invalid/v1',embeddingDimensions:3,embeddingMaxRetries:0,embeddingEnabled:true,autoEpisodeIndex:false,episodeIndexEnabled:false,structuredStateEnabled:false,currentSceneTailEnabled:false});await b.api.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await b.api.resolveCurrentScope(),old=await b.api._test.loadScopeRecords(scope.scopeKey);
  const stores=[b.pluginStorage,b.safeLocalStorage],writes=stores.map(s=>s.setItem);
  for(const [i,s]of stores.entries())s.setItem=async(k,v)=>String(k)==='flashback.settings.source-tracking.v1'?true:writes[i](k,v);
  await assert.rejects(b.api.setSourceEditIgnoredTags(['external-note']),/SOURCE_INPUT_(?:WRITE_REJECTED|READBACK_FAILED)/);
  b.context.auditReachedRecallPreparation=false;
  const out=await b.api._test.beforeRequest([{role:'user',content:'Where is Alice in the office?'}],'model');
  assert.equal(b.context.auditReachedRecallPreparation,true,'failed local preference readback does not block actual recall preparation');
  assert.ok(JSON.stringify(out).includes('Alice is in the office.'),'actual registered hook delivers durable raw memory: '+JSON.stringify({out,recall:b.audit.Runtime.lastRecall}));assert.ok(modelRequests>0,'current configured embedding provider actually runs');
  assert.equal(JSON.stringify((await b.api._test.loadScopeRecords(scope.scopeKey)).records),JSON.stringify(old.records),'recall preserves current raw records');
  await b.api._test.afterRequest('','model');
  b.context.auditScopeFail=true;b.context.auditReachedRecallPreparation=false;
  await b.api._test.beforeRequest([{role:'user',content:'What next?'}],'model');
  assert.equal(b.context.auditReachedRecallPreparation,false,'unrelated scope failure retains original failure path');
  for(const [i,s]of stores.entries())s.setItem=writes[i];
  console.log('PASS Flashback actual recall survives local preference failure; unrelated current scope error stops preparation');
 } finally {await b.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearInterval(pendingRoot));
