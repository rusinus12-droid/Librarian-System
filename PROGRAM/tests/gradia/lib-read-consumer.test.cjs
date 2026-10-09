const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const acorn=require('../../tools/gradia/load-dev-dependency.cjs')('acorn');const {load}=require('./host.cjs');
const digest=async v=>crypto.createHash('sha256').update(v).digest('hex');const clone=v=>JSON.parse(JSON.stringify(v));
function captureFactory(source){
 const ast=acorn.parse(source,{ecmaVersion:'latest'});let target;
 function walk(n){if(!n||typeof n!=='object')return;if(n.type==='ArrowFunctionExpression'&&n.params[0]?.type==='AssignmentPattern'&&source.slice(n.start,n.end).includes("gradia.lib-read-consumer.v1"))target=n;for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v)}walk(ast);assert.ok(target,'read consumer factory exists');return source.slice(0,target.start)+'(globalThis.__testCreateLibReadConsumer='+source.slice(target.start,target.end)+')'+source.slice(target.end);
}
async function fixture(options={}){
 const host=await load({transformSource:captureFactory});const factory=host.createLibReadConsumer;assert.equal(typeof factory,'function');
 let boundary={mode:'server_only',modeGeneration:1,scope:{characterId:'char',chatId:'chat',branchId:'branch',personaId:'persona',worldlineRevision:'world1'},data:{instanceId:'DATA1',resetEpoch:'epoch1'},nativeRevision:'native1',currentInputHash:await digest('current'),recentTurnDigest:await digest('turns')};
 const request={requestId:'request1',currentInputHash:boundary.currentInputHash,recentTurnDigest:boundary.recentTurnDigest,query:'current',allowedOwners:['libra']};
 let calls=0,checks=0,lastRequest,lastSignal;const text='Owner memory';
 const receipt=async req=>({schema:'gradia.lib-read-receipt.v1',requestId:req.requestId,boundary:clone(boundary),evidenceRevision:'e1',completeness:'complete',truncated:false,items:[{id:'item1',owner:'libra',content:text,contentHash:await digest(text),authority:'owner_memory',eligibility:'eligible',source:{scope:clone(boundary.scope),sourceRevision:'rev1',turnIds:['u1','a1'],variantId:'variant1',handle:'owner-handle-1'}}]});
 const deps={getBoundary:async()=>clone(boundary),digest,recall:async(req,{signal})=>{calls++;lastRequest=req;lastSignal=signal;return options.recall?options.recall(req,receipt,signal):receipt(req)},assertCurrent:async()=>{checks++;return options.assertCurrent?options.assertCurrent():true},timeoutMs:options.timeoutMs||1000};
 const consumer=factory(deps);
 return {host,factory,consumer,request,setBoundary:v=>{boundary={...boundary,...v}},getBoundary:()=>boundary,getCalls:()=>calls,getChecks:()=>checks,getRequest:()=>lastRequest,getSignal:()=>lastSignal};
}
test('plugin-only and production-default consumers make zero provider attempts',async()=>{
 const f=await fixture();f.setBoundary({mode:'plugin_only'});const session=await f.consumer.beginRead(f.request);assert.equal(session.status,'disabled');assert.equal(await session.assertCurrent(),true);assert.equal(f.getCalls(),0);assert.equal(f.getChecks(),0);
 const production=f.factory();assert.equal((await production.beginRead({})).status,'disabled');assert.equal(production.getState().productionRemoteEnabled,false);assert.equal(f.host.getCalls(),0);
});
test('bounded valid evidence supports one recall and fresh draft handoff',async()=>{
 const f=await fixture();const s=await f.consumer.beginRead(f.request);assert.equal(s.status,'ready');const evidence=await s.getEvidence();assert.equal(evidence.items[0].content,'Owner memory');assert.equal(f.getCalls(),1);assert.equal(f.getRequest().budget.maxItems,8);assert.equal(f.getRequest().budget.maxBytes,8192);
 await s.bindDraft('SAFE_DRAFT');assert.equal(await s.finalizeDraft(),'SAFE_DRAFT');assert.ok(f.getChecks()>=3);assert.equal(f.host.getCalls(),0);assert.equal(f.consumer.getState().hasDraft,true);
});
test('mismatched receipts, partial evidence and invalid source handles fail closed',async()=>{
 for(const mutate of [r=>r.requestId='foreign',r=>r.boundary.scope.personaId='other',r=>r.boundary.data.instanceId='DATA2',r=>r.items[0].contentHash='0'.repeat(64),r=>r.items[0].source.scope.chatId='foreign',r=>r.items[0].source.variantId='',r=>r.items[0].owner='hayaku',r=>r.completeness='partial',r=>r.truncated=true]){
  const f=await fixture({recall:async(req,make)=>{const r=await make(req);mutate(r);return r}});await assert.rejects(()=>f.consumer.beginRead(f.request),e=>/^LIB_READ_/.test(e.code));assert.equal(f.consumer.getState().hasEvidence,false);
 }
});
test('scope and DATA changes after draft creation discard evidence and draft',async()=>{
 for(const mutate of [b=>({scope:{...b.scope,chatId:'changed'}}),b=>({scope:{...b.scope,branchId:'changed'}}),b=>({scope:{...b.scope,personaId:'changed'}}),b=>({scope:{...b.scope,worldlineRevision:'changed'}}),b=>({data:{...b.data,instanceId:'changed'}}),b=>({data:{...b.data,resetEpoch:'changed'}}),()=>({nativeRevision:'new-variant'}),()=>({currentInputHash:'0'.repeat(64)}),()=>({modeGeneration:2})]){
  const f=await fixture();const s=await f.consumer.beginRead(f.request);await s.bindDraft('MUST_DISCARD');f.setBoundary(mutate(f.getBoundary()));await assert.rejects(()=>s.finalizeDraft(),e=>e.code==='LIB_READ_BOUNDARY_CHANGED');assert.equal(f.consumer.getState().hasDraft,false);assert.equal(f.consumer.getState().hasEvidence,false);
 }
});
test('reverse switch aborts pending recall and late replies cannot resurrect evidence',async()=>{
 let release;const f=await fixture({recall:async(req,make)=>new Promise(resolve=>{release=async()=>resolve(await make(req))})});const pending=f.consumer.beginRead(f.request);while(!release)await new Promise(r=>setTimeout(r,0));
 f.setBoundary({mode:'plugin_only',modeGeneration:2});f.consumer.invalidate('LIB_READ_MODE_CHANGED');assert.equal(f.getSignal().aborted,true);await assert.rejects(()=>pending,e=>e.code==='LIB_READ_MODE_CHANGED');await release();await new Promise(r=>setTimeout(r,0));assert.equal(f.consumer.getState().hasEvidence,false);assert.equal((await f.consumer.beginRead(f.request)).status,'disabled');assert.equal(f.getCalls(),1);
});
test('permission denial never retries, falls back, or touches host transport',async()=>{
 const f=await fixture({recall:async()=>{throw Object.assign(new Error('Denied'),{code:'FORBIDDEN'})}});await assert.rejects(()=>f.consumer.beginRead(f.request),e=>e.code==='LIB_READ_UNAVAILABLE');assert.equal(f.getCalls(),1);assert.equal(f.host.getCalls(),0);assert.equal(f.consumer.getState().hasDraft,false);
});
test('missing identity, mode transition and budget overflow reject before use',async()=>{
 for(const patch of [{scope:{characterId:'char'}},{mode:'mirror'},{mode:'server_only',transition:true}]){const f=await fixture();f.setBoundary(patch);await assert.rejects(()=>f.consumer.beginRead(f.request),e=>/^LIB_READ_/.test(e.code));assert.equal(f.getCalls(),0)}
 const f=await fixture({recall:async(req,make)=>{const r=await make(req);r.items=Array.from({length:9},(_,i)=>({...r.items[0],id:'item'+i}));return r}});await assert.rejects(()=>f.consumer.beginRead(f.request),e=>e.code==='LIB_READ_BUDGET_EXCEEDED');
});
test('timeout and caller cancellation settle even if provider ignores AbortSignal',async()=>{
 const f=await fixture({timeoutMs:20,recall:()=>new Promise(()=>{})});await assert.rejects(()=>f.consumer.beginRead(f.request),e=>e.code==='LIB_READ_TIMEOUT');assert.equal(f.consumer.getState().hasEvidence,false);
 const other=await fixture({recall:()=>new Promise(()=>{})});const controller=new AbortController();const pending=other.consumer.beginRead({...other.request,signal:controller.signal});controller.abort();await assert.rejects(()=>pending,e=>e.code==='LIB_READ_CANCELED');
});
test('freshness failure after receipt prevents contaminated final draft',async()=>{
 let current=true;const f=await fixture({assertCurrent:()=>current});const s=await f.consumer.beginRead(f.request);await s.bindDraft('CONTAMINATED');current=false;await assert.rejects(()=>s.finalizeDraft(),e=>e.code==='LIB_READ_STALE');assert.equal(f.consumer.getState().hasDraft,false);
});
test('request snapshot is copied before the first awaited boundary lookup',async()=>{
 const f=await fixture();const pending=f.consumer.beginRead(f.request);f.request.query='MUTATED';f.request.allowedOwners[0]='hayaku';const session=await pending;assert.equal(session.status,'ready');assert.equal(f.getRequest().query,'current');assert.deepEqual(Array.from(f.getRequest().allowedOwners),['libra']);
});
test('oversized receipt metadata is rejected even with small text',async()=>{
 const f=await fixture({recall:async(req,make)=>{const r=await make(req);r.untrustedMetadata='x'.repeat(70000);return r}});await assert.rejects(()=>f.consumer.beginRead(f.request),e=>e.code==='LIB_READ_BUDGET_EXCEEDED');
});
test('superseded request and old session cannot supply evidence or drafts',async()=>{
 const f=await fixture();const old=await f.consumer.beginRead(f.request);await old.bindDraft('OLD');const fresh=await f.consumer.beginRead({...f.request,requestId:'request2'});await assert.rejects(()=>old.finalizeDraft(),e=>e.code==='LIB_READ_SUPERSEDED');assert.equal(fresh.status,'ready');assert.equal(f.consumer.getState().hasDraft,false);
});
test('receipt comparison does not hide prototype-named boundary fields',async()=>{
 const f=await fixture({recall:async(req,make)=>{const r=await make(req);Object.defineProperty(r.boundary,'__proto__',{value:{tampered:true},enumerable:true});return r}});await assert.rejects(()=>f.consumer.beginRead(f.request),e=>e.code==='LIB_READ_RECEIPT_MISMATCH');
});
test('invalidation during final freshness awaits cannot restore discarded draft state',async()=>{
 for(let delay=1;delay<=14;delay++){
  let checks=0,f;const later=n=>Promise.resolve().then(()=>n?later(n-1):f.consumer.invalidate('LIB_READ_MODE_CHANGED'));
  f=await fixture({assertCurrent:()=>{if(++checks===3)void later(delay);return true}});const s=await f.consumer.beginRead(f.request);
  try{await s.bindDraft('MUST_NOT_RESURRECT')}catch(e){assert.match(e.code,/^LIB_READ_/)}
  for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(f.consumer.getState().hasDraft,false,`microtask offset ${delay}`);assert.equal(f.consumer.getState().hasEvidence,false);
 }
});
