'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./checksum-fixture.cjs');
const root=path.resolve(__dirname,'..'),base=path.resolve(root,'../wm-native-cache-dispatch-repair-20261006T1221Z/dist/LIBRA World Manager Full.js');
async function probe(artifact,kind,uncachedReference=false){
 const f=await fixture(4,artifact),a=f.r.corpus.adapters.world,representation=a.representation,scope=f.snapshot.scopeKey;let armed=false,reads=0,done=false,record,observed,checksumGets=0;
 const snapshot={...f.snapshot};Object.defineProperty(snapshot,'scopeKey',{enumerable:true,get(){if(armed&&++reads===2){armed=false;if(kind==='context')record.turnLog[0].worldSummary='CONTEXT_GETTER_MUTATION';else{const original=record.meta.integrity.checksum;Object.defineProperty(record.meta.integrity,'checksum',{enumerable:true,configurable:true,get(){checksumGets++;record.turnLog[0].worldSummary='INTEGRITY_GETTER_MUTATION';return original;}});}}return scope;}});
 a.representation=(candidate,s,limits)=>{
  if(!done&&candidate.subtype==='state_turn'){done=true;record=candidate.parentRecord;const unit={scopeKey:scope,family:'world',locator:{family:'world',subtype:'state_turn',id:candidate.id},record:candidate.record,parentRecord:record,entry:candidate.entry};
   const checkedSnapshot=uncachedReference?Object.create(Object.getPrototypeOf(s),Object.getOwnPropertyDescriptors(s)):s;
   assert.equal(a.eligibility(unit,checkedSnapshot).eligible,true,'well-formed unit primes the actual parent checksum');armed=true;reads=0;observed=a.eligibility(unit,checkedSnapshot);}
  return representation(candidate,s,limits);
 };
 try{f.r.corpus.enumerate(snapshot);assert(done);assert.equal(reads,2);assert.equal(f.r.state.calls.length,0);return {observed:JSON.parse(JSON.stringify(observed)),checksumGets};}finally{a.representation=representation;}
}
for(const kind of ['context','integrity'])test('witness is rechecked at checksum use after '+kind+' callbacks',async()=>{
 const candidate=process.env.WM_CHECKSUM_DIST||root+'/dist/LIBRA World Manager Full.js',reference=await probe(base,kind,true),result=await probe(candidate,kind);assert.equal(reference.observed.eligible,false);assert.equal(reference.observed.reason,'integrity:checksum_mismatch');assert.deepEqual(result,reference);console.log('ORDER_PARITY '+JSON.stringify({kind,...result}));
});
