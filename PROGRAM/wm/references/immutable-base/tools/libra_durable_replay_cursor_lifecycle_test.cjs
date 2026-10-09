'use strict';
const assert = require('node:assert/strict');
const {runtime, flush} = require('./libra_typed_recall_queue_test.cjs');
async function make() {
 const r = await runtime(undefined, {admittedHost:true, transformCode(code) {
  const seam=/await RisuCompat\.addReplacer\((['"])afterRequest\1,\s*libraAfterRequestReplacer\)/;
  assert(seam.test(code));
  return code.replace(seam, match => '('+match+',globalThis.__CURSOR_TEST__={ledger:DurableTurnLedger,replay:scheduleDurableTurnReplay,cursors:durableReplayCursors,inflight:durableReplayInFlight,queue:afterRequestWorkerQueue})');
 }});
 delete r.chat.msgs; r.chat.message=[{role:'user',data:'I open the stone gate.',chatId:'user-1'}]; r.chat.localLore=[];
 r.api.MemoryEngine.CONFIG.useLLM=false; r.api.MemoryEngine.CONFIG.embeddingEnabled=false;
 const scope=r.api.LibraDataStorage.scopeKeyFor(r.char,r.chat);
 r.store.set(r.api.LibraDataStorage.storageKeyFor(scope),JSON.stringify({scopeKey:scope,entries:[]}));
 r.test=r.context.__CURSOR_TEST__;
 r.before=async()=>{await r.api.libraBeforeRequestReplacer([{role:'user',content:'I open the stone gate.'}],'model');return [...r.api.MemoryState.afterRequestOriginsByType.values()].flat().at(-1);};
 return r;
}
async function settle(r){for(let i=0;i<8;i++)await r.advance(500);await flush();}
async function seed(r, count) {
 const target=await r.before();
 for(let i=0;i<count;i++) {
  const h=await r.test.ledger.appendObserved({origin:target,recordId:'stale-'+i,assistantText:'Missing canonical evidence '+i+'.'});
  assert(h.ok);assert((await r.test.ledger.markStatus(h,{status:'committed',analysisStatus:'failed',analysisRecoveryAttempt:0,analysisStartedAt:0,analysisFinishedAt:0})).ok);
 }
 await settle(r); return target;
}
(async()=>{
 const r=await make(), target=await seed(r,40), ledger=r.test.ledger;
 assert.equal(r.test.cursors.get(target.scopeKey).cursor.offset,8);
 await r.before();await settle(r);assert.equal(r.test.cursors.get(target.scopeKey).cursor.offset,16);
 // Same stable journal with changed reset generation/branch identity starts a
 // separate cursor context; old evidence never inherits an advanced position.
 r.test.replay({...target,resetGeneration:1});assert.equal(r.test.cursors.has(target.scopeKey),false);await settle(r);
 assert.equal(r.test.cursors.get(target.scopeKey).cursor.offset,8);
 r.test.replay({...target,resetGeneration:1,runtimeScopeKey:'different-branch'});assert.equal(r.test.cursors.has(target.scopeKey),false);await settle(r);
 const beforeFailure = r.test.cursors.get(target.scopeKey).cursor.offset;
 // An unreadable sealed page must retain the last verified cursor rather than
 // rewind to the oldest failed prefix; after repair the next trigger resumes.
 const get=r.storage.getItem, pageKey=ledger.indexKey(target.scopeKey)+'::page::1';
 r.storage.getItem=async key=>{if(key===pageKey)throw new Error('synthetic transient page read');return get(key);};
 r.test.replay({...target,resetGeneration:1,runtimeScopeKey:'different-branch'});await settle(r);
 assert.equal(r.test.cursors.get(target.scopeKey).cursor.offset,beforeFailure);
 assert.equal(r.test.inflight.has(target.scopeKey),false);
 r.storage.getItem=get;
 r.test.replay({...target,resetGeneration:1,runtimeScopeKey:'different-branch'});await settle(r);
 assert(r.test.cursors.get(target.scopeKey).cursor.offset > beforeFailure);
 r.context.__LIBRA_WORLD_MAKER_RUNTIME_EPOCH__ += 1;r.test.replay(target);await settle(r);
 assert.equal(r.test.cursors.has(target.scopeKey),false,'invalid runtime drops saved cursor without admission');
 // A new runtime intentionally has no durable cursor. Provider authority is
 // still the existing durable attempt reservation, not this traversal cache.
 const fresh=await make();assert.equal(fresh.test.cursors.size,0);
 assert.equal(r.state.calls.length,0);assert.equal(fresh.state.calls.length,0);
 console.log('PASS next-trigger fairness, reset/branch context isolation, transient-page resume and runtime invalidation');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
