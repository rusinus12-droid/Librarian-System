'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),5000))]);}finally{clearTimeout(timer);}}
function expose(source){
  for(const [a,b] of [
    ['if (deepAuditDue) {','if (deepAuditDue && false) {'],
    ['await LibraMemoryCore.readySourceRules();','globalThis.__portableAuditCore=LibraMemoryCore;await LibraMemoryCore.readySourceRules();'],
    ['const scheduleDeepBranchAudit = (context, pairs, delayMs = BRANCH_DEEP_AUDIT_DELAY_MS) => {','const scheduleDeepBranchAudit = globalThis.__portableAuditSchedule = (context, pairs, delayMs = BRANCH_DEEP_AUDIT_DELAY_MS) => {'],
    ['const enqueue = (scopeKey, task, queues = state.queues) => {','const enqueue = globalThis.__portableAuditEnqueue = (scopeKey, task, queues = state.queues) => {']
  ]){assert.equal(source.split(a).length,2,'one visibility/fixture seam');source=source.replace(a,b);}
  return source;
}
async function prepared({holdMigration=false}={}){
  const timers=[],migrationTimers=[],originalCreate=vm.createContext;
  vm.createContext=function(sandbox,...args){
    const realSet=sandbox.setTimeout,realClear=sandbox.clearTimeout;
    sandbox.setTimeout=(callback,ms,...a)=>{
      if(holdMigration&&String(callback).includes('runAutomaticLegacyVectorMigration')){const t={callback,args:a,cleared:false,fired:false};migrationTimers.push(t);return t;}
      if(String(callback).includes('background_deep_audit')){const t={callback,args:a,cleared:false,fired:false};timers.push(t);return t;}
      return realSet(callback,ms,...a);
    };
    sandbox.clearTimeout=t=>{if(timers.includes(t)||migrationTimers.includes(t)){t.cleared=true;return;}return realClear(t);};
    return originalCreate.call(vm,sandbox,...args);
  };
  let f;try{f=await fixture({args:{state_enabled:true},transformSource:expose});}finally{vm.createContext=originalCreate;}
  assert.equal((await f.run()).completed,1);
  const core=f.r.context.__portableAuditCore,context=await core.resolveContext();
  await Promise.all([...core.state.queues.values()]);
  const portable=f.r.context.__LIBRAPortableMemoryBackup;
  const initialEnvelope=await portable.exportCurrentScope();
  const h={f,core,context,portable,timers,migrationTimers,initialEnvelope,store:f.r.context.risuai.pluginStorage};
  h.schedule=()=>f.r.context.__portableAuditSchedule(context,[],0);
  h.fire=()=>{const t=timers.find(t=>!t.cleared&&!t.fired);assert(t,'actual registered timer');t.fired=true;t.callback(...t.args);};
  h.drain=async()=>{await bounded(Promise.all([...core.state.branchAuditInFlight.values()]),'audit must settle');await Promise.all([...core.state.queues.values()]);assert.equal(core.state.branchAuditInFlight.size,0);assert.equal(core.state.queues.size,0);};
  h.scopeBytes=()=>JSON.stringify([...f.r.values].filter(([k])=>k.startsWith('libra:v1:scope:'+context.scope.scopeKey+':')).sort(([a],[b])=>a.localeCompare(b)));
  return h;
}
async function heldExport(h){
  const entered=defer(),release=defer(),keys=h.store.keys;let intercepted=false;
  h.store.keys=async function(...a){if(!intercepted){intercepted=true;entered.resolve();await release.promise;}return keys.apply(this,a);};
  const result=h.portable.exportCurrentScope();result.catch(()=>{});
  await bounded(entered.promise,'real export reaches physical storage enumeration');
  assert(h.core.state.portableMemoryActiveOperationId,'real portable owner acquired before the hold');
  return {result,release:()=>{release.resolve();h.store.keys=keys;}};
}

test('an already registered audit delivered during a real export does not write scoped bytes',async()=>{
  const h=await prepared();let held;
  try{
    assert.equal(h.schedule(),true);held=await heldExport(h);
    const before=h.scopeBytes(),calls=h.f.control.calls.length;
    h.f.chat.message[0].chatId='replacement-during-backup';h.fire();await h.drain();
    assert.equal(h.scopeBytes(),before,'timer must not reconcile or persist while portable ownership is held');
    assert.equal(h.f.control.calls.length,calls);
    assert.equal([...h.core.state.timers.keys()].filter(key=>key.startsWith('branch_audit:')).length,0,'declined audit callback does not install a retry timer');
    assert.equal(h.timers.filter(t=>!t.fired&&!t.cleared).length,0,'host has no pending audit callback');
    held.release();const envelope=await held.result;assert(envelope.records.length>0);
    assert.equal(h.core.state.portableMemoryActiveOperationId,'');
  }finally{held?.release();await held?.result.catch(()=>{});await h.f.r.cleanup();}
});

test('audit registration during a real portable export is declined without queue work',async()=>{
  const h=await prepared();let held;
  try{
    held=await heldExport(h);const before=h.scopeBytes(),count=h.timers.length;
    assert.equal(h.schedule(),false,'portable ownership excludes new background audit admission');
    assert.equal(h.timers.length,count);assert.equal(h.core.state.queues.size,0);
    assert.equal(h.scopeBytes(),before);
  }finally{held?.release();await held?.result.catch(()=>{});await h.f.r.cleanup();}
});

test('release permits a fresh scheduled audit after the held-export callback was declined',async()=>{
  const h=await prepared();let held;
  try{
    assert.equal(h.schedule(),true);held=await heldExport(h);
    h.f.chat.message[0].chatId='replacement-after-backup';h.fire();await h.drain();
    assert.equal(h.f.getManifest().memories['1'].status,'committed','no audit write before portable release');
    held.release();await held.result;
    assert.equal(h.schedule(),true,'no stale timer or in-flight owner strands the future audit');h.fire();await h.drain();
    assert.equal(h.f.getManifest().memories['1'].status,'inactive');
    assert.equal(h.f.r.api.getRuntime().lastBranchReconcile.reason,'background_deep_audit');
    assert.equal(h.f.getHead().throughTurn,0);
  }finally{held?.release();await held?.result.catch(()=>{});await h.f.r.cleanup();}
});

test('an audit holding its physical manifest write excludes export until the tail settles',async()=>{
  const h=await prepared(),entered=defer(),release=defer(),set=h.store.setItem;let intercepted=false;
  try{
    h.store.setItem=async function(key,value){if(!intercepted&&String(key).endsWith(':manifest')&&JSON.parse(value)?.memories?.['1']?.status==='inactive'){intercepted=true;entered.resolve();await release.promise;}return set.call(this,key,value);};
    h.f.chat.message[0].chatId='replacement-before-backup';assert.equal(h.schedule(),true);h.fire();
    await bounded(entered.promise,'audit reaches physical manifest write');
    await assert.rejects(h.portable.exportCurrentScope(),e=>e.code==='LIBRA_WORLD_MANAGER_BUSY');
    assert.equal(h.f.getManifest().memories['1'].status,'committed','held physical write is not durable');
    release.resolve();await h.drain();assert.equal(h.f.getManifest().memories['1'].status,'inactive');
    assert((await h.portable.exportCurrentScope()).records.length>0);
  }finally{release.resolve();h.store.setItem=set;await h.drain();await h.f.r.cleanup();}
});

test('queued audit ownership prevents a portable operation barging before audit entry',async()=>{
  const h=await prepared(),entered=defer(),release=defer();let owner;
  try{
    owner=h.f.r.context.__portableAuditEnqueue(h.context.scope.scopeKey,async()=>{entered.resolve();await release.promise;});
    await entered.promise;h.f.chat.message[0].chatId='replacement-queued-audit';
    assert.equal(h.schedule(),true);h.fire();
    assert.equal(h.core.state.branchAuditInFlight.size,1,'real audit is admitted behind the existing scope owner');
    await assert.rejects(h.portable.exportCurrentScope(),e=>e.code==='LIBRA_WORLD_MANAGER_BUSY');
    assert.equal(h.core.state.portableMemoryActiveOperationId,'');
    release.resolve();await owner;await h.drain();
    assert.equal(h.f.getManifest().memories['1'].status,'inactive');
    assert((await h.portable.exportCurrentScope()).records.length>0);
  }finally{release.resolve();await owner;await h.drain();await h.f.r.cleanup();}
});

const EMPTY_MIGRATION_MARKER='libra:v1:local-vector-migration:48b4e542';
const hashValues=values=>crypto.createHash('sha256').update(JSON.stringify([...values].sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
const withoutEmptyMarker=values=>new Map([...values].filter(([key])=>key!==EMPTY_MIGRATION_MARKER));

test('only the exact empty nonarchive migration marker may differ; portable records and all other storage stay exact',async()=>{
  const h=await prepared({holdMigration:true});let held;
  try{
    assert.equal(h.f.r.values.has(EMPTY_MIGRATION_MARKER),false,'real startup migration is held before publishing its marker');
    // The independent 750 ms startup world-additional cleanup publishes its own
    // marker; let it settle first so the snapshot below cannot race it.
    await bounded((async()=>{while(!h.f.r.values.has('libra:v1:migration:remove-world-additional:v1'))await new Promise(r=>setTimeout(r,5));})(),'startup world-additional cleanup settles');
    const before=new Map(h.f.r.values),readIndex=h.f.r.storageReads.length;
    held=await heldExport(h);
    const timer=h.migrationTimers.find(t=>!t.cleared&&!t.fired);assert(timer,'actual host-registered migration callback');timer.fired=true;timer.callback(...timer.args);
    await bounded((async()=>{while(!h.f.r.values.has(EMPTY_MIGRATION_MARKER))await new Promise(r=>setTimeout(r,5));})(),'real empty migration publishes marker');
    assert(h.portable.status().operationId,'marker was published during actual export ownership');
    held.release();const envelope=await held.result;
    const marker=h.f.r.values.get(EMPTY_MIGRATION_MARKER),expected={schema:'libra.embedding_vector_migration_marker.v1',pluginVersion:require('./fixtures/release_versions.cjs').releaseVersion('libra'),targetSignature:'ec2917fe:1349',providerProfileId:'mep_a4ccc727f9674d23',reason:'embedding_startup_probe',scanned:0,candidates:0,migrated:0,alreadyCurrent:0,missingPayload:0,incompatibleSpace:0,failures:0,bytesPromoted:0,complete:true,errors:[],interrupted:false};
    const {startedAt,finishedAt,...body}=JSON.parse(JSON.stringify(marker));
    assert.deepEqual(body,expected,'exception is the exact empty completion payload, not a migration prefix');assert(Number.isFinite(Date.parse(startedAt)));assert(Number.isFinite(Date.parse(finishedAt)));
    const changed=[...new Set([...before.keys(),...h.f.r.values.keys()])].filter(k=>JSON.stringify(before.get(k))!==JSON.stringify(h.f.r.values.get(k)));
    assert.deepEqual(changed,[EMPTY_MIGRATION_MARKER]);
    assert.equal(hashValues(withoutEmptyMarker(h.f.r.values)),hashValues(withoutEmptyMarker(before)),'every other host key, including scoped memory, remains exact');
    assert(!envelope.records.some(r=>r.key===EMPTY_MIGRATION_MARKER));assert(!envelope.inventory.dependencyKeys.includes(EMPTY_MIGRATION_MARKER));
    const archiveBefore=new Map(envelope.records.map(row=>[row.key,before.get(row.key)])),archiveAfter=new Map(envelope.records.map(row=>[row.key,row.value]));
    assert.equal(hashValues(archiveAfter),hashValues(archiveBefore),'every exact archived payload equals the storage snapshot taken immediately before the held export');
    const archiveKeys=new Set(envelope.records.map(row=>row.key));
    for(const key of before.keys())if(key.startsWith('libra:v1:scope:'+h.context.scope.scopeKey+':'))assert(archiveKeys.has(key),'all fixture scoped records are included: '+key);
    assert.equal(envelope.inventory.recordCount,envelope.records.length);
    const proof={markerKey:EMPTY_MIGRATION_MARKER,marker,changedKeys:changed,markerWasPhysicallyRead:h.f.r.storageReads.slice(readIndex).includes(EMPTY_MIGRATION_MARKER),physicalReadset:h.f.r.storageReads.slice(readIndex),markerInArchive:false,markerInDependencies:false,allOtherStorageSHA256:hashValues(withoutEmptyMarker(before)),recordsBeforeSHA256:hashValues(archiveBefore),recordsAfterSHA256:hashValues(archiveAfter),beforeArchiveRecords:[...archiveBefore],afterEnvelope:envelope};
    if(process.env.PORTABLE_MARKER_PROOF_OUT)fs.writeFileSync(process.env.PORTABLE_MARKER_PROOF_OUT,JSON.stringify(proof,null,2)+'\n');
  }finally{held?.release();await held?.result.catch(()=>{});await h.f.r.cleanup();}
});
