'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const acorn=require('/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules/acorn');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const root=path.resolve(__dirname,'..'),dist=process.env.WM_CHECKSUM_DIST||root+'/dist/LIBRA World Manager Full.js';
const plain=x=>JSON.parse(JSON.stringify(x));
function instrument(code){
 const nodes=[],pending=[acorn.parse(code,{ecmaVersion:'latest'})];while(pending.length){const n=pending.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))pending.push(...v);else if(v&&typeof v==='object')pending.push(v);}
 const matches=nodes.filter(n=>n.type==='VariableDeclarator'&&n.id?.name==='computeRecordChecksum');assert.equal(matches.length,1);const body=matches[0].init.body;
 assert.notEqual(body.type,'BlockStatement');
 const validate=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='validateIntegrityMetaCore')||nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='validateIntegrityMeta');assert.equal(validate.init.body.type,'BlockStatement');
 const edits=[{at:body.start,text:'(globalThis.__CHECKSUM_OPS__.calls += record?.checksumBatchFixture === true ? 1 : 0,'},{at:body.end,text:')'},{at:validate.init.body.start+1,text:'globalThis.__CHECKSUM_OPS__.validations += record?.checksumBatchFixture === true ? 1 : 0;'}];
 for(const e of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,e.at)+e.text+code.slice(e.at);
 const at=code.lastIndexOf('})();');code=code.slice(0,at)+';globalThis.__CHECKSUM_TEST__={batch:typeof withTypedRecallValidationBatch==="function"?withTypedRecallValidationBatch:null,enumerate:enumerateTypedConsumerBindings,policy:buildProductionRecallConfiguration({embed:{enabled:false}}).policy,secret:SecretKnowledgeCore};'+code.slice(at);
 return 'globalThis.__CHECKSUM_OPS__={calls:0,validations:0};\n'+code;
}
async function fixture(n=12,artifact=dist){
 const r=await runtime(null,{dist:artifact,transformCode:instrument}),c=r.context.__QUEUE_TEST__.consumers;
 const record=r.signed({checksumBatchFixture:true,turnLog:Array.from({length:n},(_,i)=>({turn:i+1,worldSummary:'PUBLIC_WORLD_'+(i+1),notes:['owned parent row '+i]})),consolidated:[]},'world','world_state');
 const entry=r.entry('lmai_world_states','lmai_world_states::core',record);r.chat.localLore=[entry];
 const snapshot=r.snap({currentTurn:100}),units=r.corpus.enumerate(snapshot);assert.equal(units.length,n);
 const policy=r.context.__CHECKSUM_TEST__.policy,com=c.compose({snapshot,policy,baseline:[{key:'world-baseline',text:'PUBLIC_WORLD_BASELINE',bindings:units,required:true}]});
 const finalize=(currentSnapshot=snapshot,p=policy)=>c.finalize({sections:com.sections,currentSnapshot,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000},policy:p});
 const count=()=>r.context.__CHECKSUM_OPS__.calls,reset=()=>{r.context.__CHECKSUM_OPS__.calls=0;r.context.__CHECKSUM_OPS__.validations=0;};reset();
 return {r,c,record,entry,snapshot,units,policy,com,finalize,count,reset};
}
test('one checksum per private consumer validity batch, fresh final and verified checks',async()=>{
 const f=await fixture();const output=f.finalize();assert.equal(output.ok,true);assert.equal(output.directBlocks.length,1);assert.equal(output.directBlocks[0].text,'PUBLIC_WORLD_BASELINE');
 console.log('COUNTS '+JSON.stringify({phase:'finalize',bindings:12,actual:f.count(),expected:3,validationDecisions:f.r.context.__CHECKSUM_OPS__.validations}));assert.equal(f.r.context.__CHECKSUM_OPS__.validations,36);assert.equal(f.count(),3,'format-before, format-after and final each hash the same private aggregate once');
 f.reset();assert.equal(f.c.verified(output),true);assert.equal(f.count(),1,'later verified pass must hash afresh exactly once');
 f.reset();assert.equal(f.c.verified(output),true);assert.equal(f.count(),1,'independent repeated verified call cannot reuse acceptance or checksum');
 assert.equal(f.r.state.calls.length,0);
});


for(const fault of ['schema','checksum','scope','domain','same-id','inactive','rollback','exclusion','worldline'])test('fresh consumer gates reject '+fault,async()=>{
 const f=await fixture(4);let p=f.policy,record=plain(f.record),snapshot;
 if(fault==='schema')record.meta.integrity.schema='unknown-schema';
 if(fault==='checksum')record.meta.integrity.checksum='corrupt';
 if(fault==='scope')record.meta.integrity.scopeKey='foreign-scope';
 if(fault==='domain')record.meta.integrity.domain='narrative';
 if(fault==='same-id')record.turnLog[0].worldSummary='CHANGED_SAME_ID';
 if(fault==='inactive')record.turnLog[0].active=false;
 if(fault==='rollback')record.turnLog[0].rollbackTombstone=true;
 if(['inactive','rollback'].includes(fault))record=f.r.signed(record,'world','world_state');
 f.entry.content=JSON.stringify(record);
 if(fault==='exclusion')p={...p,exclusions:{identities:[f.units[0].identity]}};
 if(fault==='worldline')snapshot=f.r.snap({currentTurn:100,worldlineState:{scopeKey:f.snapshot.worldlineScopeKey,nodes:[]},ephemeralDriftExclusion:{scopeKey:f.snapshot.worldlineScopeKey,turns:[1]}});
 else snapshot=f.r.snap({currentTurn:100});
 if(fault==='worldline')assert.equal(f.r.corpus.adapters.world.eligibility(f.units[0],snapshot).reason,'worldline');
 const output=f.finalize(snapshot,p);assert.equal(output.ok,false);assert.equal(output.directBlocks.length,0);assert.equal(output.protectedDrops.length,1);console.log('REJECT '+fault+' '+output.protectedDrops[0].reason);assert.equal(f.r.state.calls.length,0);
});
test('same snapshot public mutable parents recompute and reject later same-ID mutation',async()=>{
 const f=await fixture(4),u=f.units[0],a=f.r.corpus.adapters.world;f.reset();
 assert.equal(Object.isFrozen(u.parentRecord),false,'public enumerate must retain mutable record contract');
 assert.equal(a.eligibility(u,f.snapshot).eligible,true);u.parentRecord.turnLog[0].worldSummary='MUTATED';
 assert.equal(a.eligibility(u,f.snapshot).eligible,false);assert.equal(f.count(),2);
});
test('custom validator executes for every binding and is never memoized',async()=>{
 const f=await fixture(4),manager=f.r.api.IntegrityMetaManager,original=manager.validateIntegrityMeta;let calls=0;
 manager.validateIntegrityMeta=(...args)=>{calls++;return original(...args);};
 try{const o=f.finalize();assert.equal(o.ok,true);assert.equal(calls,12);assert.equal(f.count(),12);}
 finally{manager.validateIntegrityMeta=original;}
});
test('validator accessor stays on uncached route without trust-getter probes',async()=>{
 const f=await fixture(4),manager=f.r.api.IntegrityMetaManager,descriptor=Object.getOwnPropertyDescriptor(manager,'validateIntegrityMeta');let gets=0;
 Object.defineProperty(manager,'validateIntegrityMeta',{configurable:true,get(){gets++;return descriptor.value;}});
 try{const o=f.finalize();assert.equal(o.ok,true);assert.equal(gets,12);assert.equal(f.count(),12);}
 finally{Object.defineProperty(manager,'validateIntegrityMeta',descriptor);}
});
test('custom eligibility can mutate parent and subsequent checks reject rather than reuse',async()=>{
 const f=await fixture(4),a=f.r.corpus.adapters.world,original=a.eligibility;let seen=0;
 a.eligibility=(unit,...args)=>{seen++;if(seen===2)unit.parentRecord.turnLog[0].worldSummary='CUSTOM_MUTATION';return original(unit,...args);};
 try{const o=f.finalize();assert.equal(o.ok,false);assert.match(o.protectedDrops[0].reason,/checksum/);assert.equal(f.count(),2);}
 finally{a.eligibility=original;}
});
test('unissued frozen accessor snapshot cannot enter private checksum route',async()=>{
 const f=await fixture(4),snapshot={...f.snapshot};let reads=0;
 Object.defineProperty(snapshot,'canonicalLore',{get(){reads++;return f.snapshot.canonicalLore;}});Object.freeze(snapshot);
 const o=f.finalize(snapshot);assert.equal(o.ok,true);assert.equal(f.count(),12);assert.ok(reads>0);
});
test('later final pass source mutation rejects the previously formatted block',async()=>{
 const f=await fixture(4);let pass=0;
 const o=f.finalize(()=>{if(++pass===3){const record=plain(f.record);record.meta.integrity.checksum='LATE_CORRUPTION';f.entry.content=JSON.stringify(record);}return f.r.snap({currentTurn:100});});
 assert.equal(pass,3);assert.equal(o.ok,false);assert.equal(o.directBlocks.length,0);assert.match(o.protectedDrops[0].reason,/checksum/);
});
test('verified check after await rereads source and cancellation, retaining no acceptance',async()=>{
 const f=await fixture(4);let active=true;
 const com=f.c.compose({snapshot:f.snapshot,policy:f.policy,requestGuard:()=>active,baseline:[{key:'world-baseline',text:'PUBLIC_WORLD_BASELINE',bindings:f.units,required:true}]});
 const o=f.c.finalize({sections:com.sections,currentSnapshot:()=>f.r.snap({currentTurn:100}),budget:{maxTokens:20000,maxChars:80000},policy:f.policy});assert.equal(o.ok,true);
 f.reset();await Promise.resolve();assert.equal(f.c.verified(o),true);assert.equal(f.count(),1);
 f.entry.content=JSON.stringify({...f.record,turnLog:[{...f.record.turnLog[0],worldSummary:'POST_AWAIT_CHANGE'},...f.record.turnLog.slice(1)]});
 f.reset();await Promise.resolve();assert.equal(f.c.verified(o),false);assert.equal(f.count(),1);
 active=false;f.reset();assert.equal(f.c.verified(o),false);assert.equal(f.count(),0);
});
test('reentrant private validity uses an independent scope and restores outer checksum batch',async()=>{
 const f=await fixture(4),x=f.r.context.__CHECKSUM_TEST__;assert.equal(typeof x.batch,'function');
 const check=units=>units.forEach(u=>assert.equal(f.r.corpus.adapters.world.eligibility(u,f.snapshot).eligible,true));
 f.reset();x.batch(f.snapshot,()=>{const units=x.enumerate(f.snapshot,f.policy,f.units.map(u=>u.identity));check(units);assert.equal(f.count(),1);
  x.batch(f.snapshot,()=>check(x.enumerate(f.snapshot,f.policy,f.units.map(u=>u.identity))));assert.equal(f.count(),2);check(units);assert.equal(f.count(),2);
 });
 assert.equal(f.r.corpus.adapters.world.eligibility(f.units[0],f.snapshot).eligible,true);assert.equal(f.count(),3,'public check after scope gets no retained checksum');
});
test('batch clears synchronously on throw and before asynchronous continuation',async()=>{
 const f=await fixture(4),x=f.r.context.__CHECKSUM_TEST__;let units;
 const run=()=>{units=x.enumerate(f.snapshot,f.policy,f.units.map(u=>u.identity));assert.equal(f.r.corpus.adapters.world.eligibility(units[0],f.snapshot).eligible,true);};
 f.reset();assert.throws(()=>x.batch(f.snapshot,()=>{run();throw Error('test-abort');}),/test-abort/);
 assert.equal(f.r.corpus.adapters.world.eligibility(units[0],f.snapshot).eligible,true);assert.equal(f.count(),2);
 f.reset();await x.batch(f.snapshot,async()=>{run();await Promise.resolve();assert.equal(f.r.corpus.adapters.world.eligibility(units[0],f.snapshot).eligible,true);});assert.equal(f.count(),2);
});
test('exact opaque consumer outputs match the unchanged repaired base',async()=>{
 const candidate=await fixture(4),base=await fixture(4,path.join(JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).base,'dist/LIBRA World Manager Full.js'));
 const a=candidate.finalize(),b=base.finalize();assert.deepEqual(plain(a),plain(b));assert.equal(candidate.c.verified(a),base.c.verified(b));
});
module.exports={fixture,instrument,plain};
test('external policy accessor cannot expose frozen records to a newly installed custom validator',async()=>{
 const f=await fixture(4),manager=f.r.api.IntegrityMetaManager,original=manager.validateIntegrityMeta;let reads=0,calls=0;
 const policy={...f.policy};Object.defineProperty(policy,'exclusions',{get(){reads++;manager.validateIntegrityMeta=(record,context)=>{calls++;record.turnLog[0].worldSummary='ACCESSOR_MUTATION';return original(record,context);};return {};}});
 try{const o=f.finalize(f.snapshot,policy);assert.equal(o.ok,false);assert.match(o.protectedDrops[0].reason,/checksum/);assert.equal(reads,1);assert.equal(calls,1);}
 finally{manager.validateIntegrityMeta=original;}
});

test('one owned root checksum cannot memoize cross-domain acceptance within the batch',async()=>{
 const f=await fixture(4),x=f.r.context.__CHECKSUM_TEST__;
 f.reset();x.batch(f.snapshot,()=>{const units=x.enumerate(f.snapshot,f.policy,f.units.map(u=>u.identity)),u=units[0];
 assert.equal(f.r.corpus.adapters.world.eligibility(u,f.snapshot).eligible,true);
 assert.equal(f.r.corpus.adapters.narrative.eligibility(u,f.snapshot).reason,'integrity:domain_mismatch');
 assert.equal(f.count(),1);assert.equal(f.r.context.__CHECKSUM_OPS__.validations,2);
 });
});

for(const family of ['narrative','world-node'])test('private '+family+' aggregate checksum is shared only within each validity pass',async()=>{
 const f=await fixture(4);let record,comment,key,domain;
 if(family==='narrative'){domain='narrative';comment='lmai_narrative';key='lmai_narrative::core';record={checksumBatchFixture:true,storylines:Array.from({length:4},(_,i)=>({id:'story-'+i,name:'Story '+i,turns:[i+1],currentContext:'PUBLIC_STORY_'+i}))};}
 else{domain='world';comment='lmai_world_graph';key='lmai_world_graph::core';record={checksumBatchFixture:true,nodes:Array.from({length:4},(_,i)=>['node-'+i,{id:'node-'+i,name:'World '+i,parent:null,rules:{custom:{publicRule:'RULE_'+i}},meta:{created:i+1}}])};}
 f.r.chat.localLore=[f.r.entry(comment,key,f.r.signed(record,domain,'parent'))];const snapshot=f.r.snap({currentTurn:100}),units=f.r.corpus.enumerate(snapshot);assert.equal(units.length,4);
 const com=f.c.compose({snapshot,policy:f.policy,baseline:[{key:'test',text:'PUBLIC_BASELINE',bindings:units,required:true}]});f.reset();
 const o=f.c.finalize({sections:com.sections,currentSnapshot:snapshot,mode:'hybrid',budget:{maxTokens:20000,maxChars:80000},policy:f.policy});assert.equal(o.ok,true);assert.equal(f.count(),3);assert.equal(f.r.context.__CHECKSUM_OPS__.validations,12);
 f.reset();assert.equal(f.c.verified(o),true);assert.equal(f.count(),1);
});
