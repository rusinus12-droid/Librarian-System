'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {fixture,policy}=require('./libra_typed_graph_discovery_test.cjs');
const {graphKeyFor,assertOnlyTypedGraphWrite}=require('./fixtures/typed-graph-storage-contract.cjs');
test('only the exact scope typed graph key may change; mutation controls fail',async()=>{
 const r=await fixture('memory'),snapshot=r.snap(),key=graphKeyFor(snapshot),foreign='libra:v1:hme-derived:another-scope:typed-graph';
 r.store.set(foreign,'FOREIGN-UNCHANGED');r.store.set(key.replace(/:typed-graph$/,':graph'),'CLASSIC-UNCHANGED');
 r.store.set(key.replace(/:typed-graph$/,':scope'),'INDEX-UNCHANGED');
 const before=new Map(r.store);await r.dual.retrieve('ORBITSEED',snapshot,null,policy());
 const units=r.corpus.enumerate(snapshot);assertOnlyTypedGraphWrite(before,r.store,snapshot,units);
 for(const target of [foreign,key.replace(/:typed-graph$/,':graph'),key.replace(/:typed-graph$/,':scope'),r.api.LibraDataStorage.storageKeyFor(r.char,r.chat)]){
  const changed=new Map(r.store);changed.set(target,'INJECTED-MUTATION');
  assert.throws(()=>assertOnlyTypedGraphWrite(before,changed,snapshot,units),/all other keys/);
 }
 for(const target of [foreign,key.replace(/:typed-graph$/,':graph')]){
  const changed=new Map(r.store);changed.delete(target);
  assert.throws(()=>assertOnlyTypedGraphWrite(before,changed,snapshot,units),/all other keys/);
 }
 const prefixFiltered=store=>JSON.stringify([...store].filter(([k])=>!k.startsWith('libra:v1:hme-derived:')));
 const historicallyMissed=new Map(r.store);historicallyMissed.set(foreign,'MUTATION-MASKED-BY-PREFIX');
 assert.equal(prefixFiltered(historicallyMissed),prefixFiltered(before),'former prefix-wide predicate demonstrably masks foreign mutation');
 for(const mutate of [saved=>{saved.binding.scopeKey='foreign'},saved=>{saved.binding.resetGeneration++},saved=>{saved.graph.nodes[0].contentHash='forged-source'}]){
  const wrongBinding=new Map(r.store),saved=JSON.parse(wrongBinding.get(key));mutate(saved);
  const {checksum,...payload}=saved;saved.checksum='sha256:'+crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  wrongBinding.set(key,JSON.stringify(saved));assert.throws(()=>assertOnlyTypedGraphWrite(before,wrongBinding,snapshot,units));
 }
 assert.equal(r.state.calls.length,0);
});
