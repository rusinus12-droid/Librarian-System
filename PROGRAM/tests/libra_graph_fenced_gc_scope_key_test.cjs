'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const createStore=require('../tools/libra_memory_graph_store.cjs');
const createPages=require('../tools/libra_memory_graph_pages.cjs');
const fingerprint=text=>crypto.createHash('sha256').update(text).digest('hex');
for(const scopeKey of ['simple','7747bb57_1:0','char:1fgdgah|chat:s7tnad'])test(`fenced graph GC recognizes exact derived keys in scope ${scopeKey}`,async()=>{
 const prefix='libra:v1:scope:'+scopeKey+':memory-graph:v1:';
 const orphanSuffixes=['generation:old','page:nodes:old','corpus:manifest:old','corpus:page:directory:old',
   'corpus:proof:old','corpus:projection:old','corpus:checkpoint:old','corpus:semantic-directory:old',
   'corpus:vector:old','semantic:page:old','semantic:manifest:old'];
 const orphanKeys=orphanSuffixes.map(s=>prefix+s),retained=[prefix+'page:nodes:live'];
 const protectedKeys=[prefix+'root:live',prefix+'corpus:root:live',prefix+'unknown:foreign',
   'libra:v1:scope:foreign:memory-graph:v1:page:nodes:old','libra:v1:scope:'+scopeKey+':memory:1:r1',...retained];
 const values=new Set([...orphanKeys,...protectedKeys]),fence={schema:'libra.graph_namespace_fence.v1'};
 const owner={check(){},listKeys:async()=>[...values],
   captureGCInventory:async()=>({complete:true,keys:[...values],retainedKeys:retained,fence}),
   deleteConditional:async input=>{assert.equal(input.fence,fence);return values.delete(input.key);}};
 const store=createStore({pages:createPages({fingerprint}),fingerprint});
 const dry=await store.collectGarbage({owner,scopeKey,dryRun:true});
 assert.deepEqual(dry.candidateKeys,orphanKeys);assert.equal(dry.deletedKeys.length,0);
 const limited=await store.collectGarbage({owner,scopeKey,candidateKeys:[orphanKeys[0],...protectedKeys]});
 assert.deepEqual(limited.deletedKeys,[orphanKeys[0]]);
 const result=await store.collectGarbage({owner,scopeKey});
 assert.deepEqual(result.deletedKeys,orphanKeys.slice(1));
 assert.deepEqual([...values],protectedKeys,'roots, reachable pages, owner memory and other scopes survive');
});
