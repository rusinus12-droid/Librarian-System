'use strict';
const assert=require('node:assert/strict');
const create=require('../tools/libra_memory_network.cjs');
const frame={owner:'test-owner',scopeKey:'scope',worldlineId:'main',authorityEpoch:1,activeSourceMapping:'1'};
const item=(id,vector=[1,0])=>({id,fingerprint:id,postings:{token:['common']},dependencies:[`source:${id}`],vector});
const make=()=>create({hash:s=>s.length}).createPagedIndex({pageSize:2});
const tests=[
 ['unprepared index does not certify complete coverage',async()=>{
  assert.equal(make().query({tokens:['common']}).complete,false);
 }],
 ['dirty posting exhaustion remains partial',async()=>{
  const index=make();index.reconcile({frame,revision:1,items:[item('a'),item('b')]});index.invalidateDependencies(['source:a']);
  const result=index.query({tokens:['common']});assert.deepEqual(result.ids,['b']);assert.equal(result.complete,false);assert.equal(result.pageExhausted,true);
 }],
 ['dirty dense access reports partial coverage',async()=>{
  const index=make();index.reconcile({frame,revision:1,items:[item('a'),item('b')]});index.invalidateDependencies(['source:a']);
  const result=index.scanDense([1,0]);assert.equal(result.vectorsScanned,1);assert.equal(result.complete,false);
 }],
 ['unrelated verified delta cannot erase outstanding dependency refresh',async()=>{
  const index=make();index.reconcile({frame,revision:1,items:[item('a'),item('b')]});index.invalidateDependencies(['source:a']);
  assert.throws(()=>index.reconcile({frame,revision:2,trustedRevision:true,fromRevision:1,verifiedChangedIDs:true,changedIDs:['b'],items:[item('b',[2,0])]}),/DIRTY_SNAPSHOT_REQUIRED/);
  assert.equal(index.inspect().coverage.status,'partial');
  index.reconcile({frame,revision:2,items:[item('a'),item('b',[2,0])]});
  assert.equal(index.inspect().coverage.status,'complete');assert.deepEqual(index.query({tokens:['common']}).ids,['a','b']);
 }],
 ['cancelled mutation requires a full snapshot before accepting deltas',async()=>{
  const index=make();index.reconcile({frame,revision:1,items:[item('old')]});let checkpoints=0;
  await assert.rejects(index.reconcilePaged({frame,revision:2,items:[item('a'),item('b'),item('c')]},{checkpoint:()=>{if(++checkpoints===3)throw new Error('cancelled');}}),/cancelled/);
  assert.equal(index.inspect().coverage.status,'partial');
  assert.throws(()=>index.reconcile({frame,revision:3,trustedRevision:true,fromRevision:1,verifiedChangedIDs:true,changedIDs:['other'],items:[item('other')]}),/DIRTY_SNAPSHOT_REQUIRED/);
  index.reconcile({frame,revision:3,items:[item('a'),item('b'),item('c')]});assert.equal(index.inspect().coverage.status,'complete');
 }],
 ['dense access preserves supplied double precision and detects sub-Float32 edits',async()=>{
  const index=make();index.reconcile({frame,revision:1,items:[item('a',[1,0])]});const before=index.inspect().io.metadataRows;
  const precise=1+2**-30;index.reconcile({frame,revision:2,items:[item('a',[precise,0])]});
  assert.equal(index.scanDense([1,0]).checksum,precise);assert.equal(index.inspect().io.metadataRows,before+1);
  assert.equal(index.inspect().bytes.packedVectors,2*2*8);
 }],
 ['paged reconciliation rejects overlapping writers and does not certify an in-flight snapshot',async()=>{
  const index=make();index.reconcile({frame,revision:1,items:[item('old')]});let resume,entered;
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>resume=resolve);
  let once=true;
  const pending=index.reconcilePaged({frame,revision:2,items:[item('a'),item('b'),item('c')]},{yieldPage:async()=>{if(once){once=false;entered();await gate;}}});
  await ready;
  try {
   assert.throws(()=>index.reconcile({frame,revision:3,items:[item('other')]}),/RECONCILIATION_BUSY/);
   await assert.rejects(index.reconcilePaged({frame,revision:3,items:[item('other')]}),/RECONCILIATION_BUSY/);
   assert.equal(index.query({tokens:['common']}).complete,false);
  } finally {resume();await pending;}
  assert.deepEqual(index.query({tokens:['common']}).ids,['a','b']);assert.equal(index.inspect().coverage.revision,2);
 }],
 ['dependency invalidation during a paged update cannot be overwritten by completion',async()=>{
  const index=make();let yields=0;
  await assert.rejects(index.reconcilePaged({frame,revision:1,items:[item('a'),item('b'),item('c')]},{yieldPage:async()=>{
   if(++yields===2)index.invalidateDependencies(['source:a']);
  }}),/RECONCILIATION_INVALIDATED/);
  assert.equal(index.inspect().coverage.status,'partial');assert.equal(index.query({tokens:['common']}).complete,false);
  index.reconcile({frame,revision:1,items:[item('b'),item('c')]});assert.equal(index.inspect().coverage.status,'complete');
 }]
];
(async()=>{let failed=0;for(const [name,test] of tests){try{await test();console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}\n${error.stack}`);}}assert.equal(failed,0,`${failed} index contract regressions`);console.log('libra_network_index_contract_test: PASS');})().catch(error=>{console.error(error.stack);process.exitCode=1;});
