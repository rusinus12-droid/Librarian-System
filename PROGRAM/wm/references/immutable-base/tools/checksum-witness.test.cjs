'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./checksum-fixture.cjs');
const withParent=(f,run)=>{const x=f.r.context.__CHECKSUM_TEST__;return x.batch(f.snapshot,()=>{const units=x.enumerate(f.snapshot,f.policy,f.units.map(u=>u.identity));return run(units[0],units);});};
test('late secret accessor custom validator receives mutable parent and rejects',async()=>{
 const f=await fixture(4),m=f.r.api.IntegrityMetaManager,original=m.validateIntegrityMeta;let getters=0,calls=0,frozen=[];
 f.r.context.__CHECKSUM_TEST__.secret.getState().secrets.push({id:'getter',knownBy:['user'],status:'active',get content(){getters++;m.validateIntegrityMeta=(record,context)=>{calls++;frozen.push(Object.isFrozen(record));record.turnLog[0].worldSummary='LATE_MUTATION';return original(record,context);};return 'HIDDEN_NEEDLE';}});
 const out=f.finalize();assert.equal(out.ok,false);assert.match(out.protectedDrops[0].reason,/checksum_mismatch/);assert.deepEqual(frozen,[false]);assert.equal(calls,1);assert.ok(getters>0);
});
for(const kind of ['primitive','child','key','descriptor','prototype','array','accessor','proxy'])test('witness detects '+kind+' mutation and qualification does not invoke new code',async()=>{
 const f=await fixture(4),a=f.r.corpus.adapters.world;let effects=0;
 withParent(f,u=>{
  assert.equal(Object.isFrozen(u.parentRecord),false,'private derived records must retain mutable semantics');
  assert.equal(a.eligibility(u,f.snapshot).eligible,true);assert.equal(f.count(),1);
  const p=u.parentRecord;
  if(kind==='primitive')p.turnLog[0].worldSummary='CHANGED';
  if(kind==='child')p.turnLog[0]={...p.turnLog[0],worldSummary:'CHANGED'};
  if(kind==='key')p.changed='NEW';
  if(kind==='descriptor')Object.defineProperty(p,'consolidated',{enumerable:false});
  if(kind==='prototype')Object.setPrototypeOf(p,{extra:true});
  if(kind==='array')p.turnLog.push({turn:99,worldSummary:'CHANGED'});
  if(kind==='accessor')Object.defineProperty(p.turnLog[0],'worldSummary',{get(){effects++;return 'CHANGED';},enumerable:true,configurable:true});
  if(kind==='proxy')p.turnLog[0]=new Proxy({...p.turnLog[0],worldSummary:'CHANGED'},{ownKeys(t){effects++;return Reflect.ownKeys(t)},get(t,k){effects++;return t[k]},getOwnPropertyDescriptor(t,k){effects++;return Reflect.getOwnPropertyDescriptor(t,k)}});
  const expected=m=>f.r.api.IntegrityMetaManager.validateIntegrityMeta(m,{domain:'world',scopeKey:f.snapshot.scopeKey});
  effects=0;const direct=expected(p),directEffects=effects;f.reset();effects=0;
  const result=a.eligibility(u,f.snapshot);assert.equal(f.count(),1,'changed witness must compute a fresh checksum');assert.equal(result.eligible,direct.ok);assert.equal(effects,directEffects,'qualification must add zero getter or proxy invocations beyond original validation');
 });
});
test('observed mutation permanently revokes witness even after exact restore',async()=>{
 const f=await fixture(4),a=f.r.corpus.adapters.world;
 withParent(f,u=>{const p=u.parentRecord,old=p.turnLog[0].worldSummary;assert.equal(a.eligibility(u,f.snapshot).eligible,true);p.turnLog[0].worldSummary='CHANGED';assert.equal(a.eligibility(u,f.snapshot).eligible,false);p.turnLog[0].worldSummary=old;assert.equal(a.eligibility(u,f.snapshot).eligible,true);assert.equal(a.eligibility(u,f.snapshot).eligible,true);assert.equal(f.count(),4);});
});
test('override restoring itself cannot revive checksum after modifying the owned parent',async()=>{
 const f=await fixture(4),a=f.r.corpus.adapters.world,m=f.r.api.IntegrityMetaManager,original=m.validateIntegrityMeta;
 withParent(f,u=>{assert.equal(a.eligibility(u,f.snapshot).eligible,true);m.validateIntegrityMeta=(record,context)=>{m.validateIntegrityMeta=original;record.turnLog[0].worldSummary='OVERRIDE_MUTATION';return original(record,context);};assert.equal(a.eligibility(u,f.snapshot).eligible,false);assert.equal(a.eligibility(u,f.snapshot).eligible,false);assert.equal(f.count(),3);});
});
test('mutation before first checksum is detected without qualifying the new proxy child',async()=>{
 const f=await fixture(4),a=f.r.corpus.adapters.world;let effects=0;
 withParent(f,u=>{u.parentRecord.turnLog[0]=new Proxy({...u.parentRecord.turnLog[0],worldSummary:'PRE_FIRST_MUTATION'},{ownKeys(t){effects++;return Reflect.ownKeys(t)},get(t,k){effects++;return t[k]},getOwnPropertyDescriptor(t,k){effects++;return Reflect.getOwnPropertyDescriptor(t,k)}});
 const direct=f.r.api.IntegrityMetaManager.validateIntegrityMeta(u.parentRecord,{domain:'world',scopeKey:f.snapshot.scopeKey}),n=effects;effects=0;f.reset();assert.equal(a.eligibility(u,f.snapshot).eligible,direct.ok);assert.equal(effects,n);assert.equal(f.count(),1);});
});
test('witness metadata is immutable while original objects stay mutable',async()=>{
 const f=await fixture(4),w=f.r.context.__CHECKSUM_TEST__.witness,record=JSON.parse('{"child":{"value":1}}'),proof=w.capture(record);
 assert.equal(Object.isFrozen(proof),true);assert.equal(Object.isFrozen(proof.rows),true);assert.ok(proof.rows.every(r=>Object.isFrozen(r)&&Object.isFrozen(r.slots)));assert.equal(Object.isFrozen(record),false);assert.equal(Object.isFrozen(record.child),false);assert.equal(w.matches(proof),true);
});
test('budget exhaustion opts out without traversing later children or freezing input',async()=>{
 const f=await fixture(4),w=f.r.context.__CHECKSUM_TEST__.witness,record=JSON.parse('{"child":{"value":1}}');assert.equal(w.capture(record,{nodes:1,properties:1}),null);assert.equal(Object.isFrozen(record),false);assert.equal(w.matches(w.capture(record)),true);
});
test('over-node-cap canonical parent remains accepted through normal checksums',async()=>{
 const f=await fixture(4);f.entry.content=JSON.stringify(f.r.signed({...f.record,padding:Array.from({length:4096},(_,i)=>({n:i}))},'world','world_state'));
 const snapshot=f.r.snap({currentTurn:100}),units=f.r.corpus.enumerate(snapshot),com=f.c.compose({snapshot,policy:f.policy,baseline:[{key:'oversized',text:'UNCHANGED_OVERSIZED_INPUT',bindings:units,required:true}]});f.reset();
 const out=f.c.finalize({sections:com.sections,currentSnapshot:snapshot,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000},policy:f.policy});assert.equal(out.ok,true);assert.equal(out.directBlocks[0].text,'UNCHANGED_OVERSIZED_INPUT');assert.equal(f.count(),12);
});
test('native parser invocation cannot be replaced through its call property',async()=>{
 const f=await fixture(4),json=require('node:vm').runInContext('JSON',f.r.context),parse=json.parse;let intercepted=0;
 Object.defineProperty(parse,'call',{configurable:true,value(){intercepted++;return {forged:true};}});
 try{const out=f.finalize();assert.equal(out.ok,true);assert.equal(intercepted,0,'the actual native parser must run directly through a trusted intrinsic');}
 finally{delete parse.call;}
});
