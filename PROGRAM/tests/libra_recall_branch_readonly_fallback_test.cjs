'use strict';
// 2026-10-29 debug: recall aborted with "before_branch_reconcile after 6000ms" while a
// Micro/analysis job held the scope queue for ~90s. Executes the real wrapper and
// read-only view; only storage and digest helpers are controlled.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const start=source.indexOf('    const readOnlyBranchViewForRecall = async (context, pairs) => {');
const end=source.indexOf('    const verifyBatchStillCurrent = async ',start);
assert(start>0&&end>start,'unique real read-only branch region');
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture({queueBusy,queued}){
  const pairs=Array.from({length:12},(_,index)=>({turn:index+1,text:'t'+(index+1)}));
  const digestOf=batch=>batch.map(pair=>pair.text).join('|');
  const manifest={memories:{
    1:{status:'committed',turnRange:{start:1,end:5},sourceDigest:digestOf(pairs.slice(0,5))},
    6:{status:'committed',turnRange:{start:6,end:10},sourceDigest:'rerolled-earlier-branch'},
    11:{status:'committed',turnRange:{start:11,end:15},sourceDigest:'incomplete'}
  },branchGuard:{status:'bootstrap_pending',verifiedStarts:[]}};
  const writes=[];
  const context={setTimeout,clearTimeout,Runtime:{},state:{queues:new Map(queueBusy?[['scope-a',Promise.resolve()]]:[])},BATCH_SIZE:5,BRANCH_GUARD_READY:'ready',
    clone:plain,string:v=>String(v??''),asObject:v=>v&&typeof v==='object'?v:{},
    loadManifest:async()=>plain(manifest),completeBatchStarts:list=>Array.from({length:Math.floor(list.length/5)},(_,i)=>i*5+1),
    batchForStart:(list,s)=>list.slice(s-1,s+4),sourceDigest:digestOf,libraCanonicalSlotPreservationKind:async()=>false,
    normalizeBranchGuard:v=>({status:v?.status||'bootstrap_pending',verifiedStarts:[...(v?.verifiedStarts||[])]}),
    refreshCanonicalFrontiers:()=>({}),
    listRecallCurrentMemoryRefs:m=>Object.values(m.memories).filter(r=>r.status==='committed'&&m.branchGuard.verifiedStarts.includes(r.turnRange.start)),
    reconcileCanonicalBranchBeforeRecall:()=>queued(),buildPairs:()=>pairs,warn(){},saveManifest:async value=>writes.push(value)};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+'\nglobalThis.run=reconcileBranchForRecall;',context);
  return {context,pairs,manifest,writes};
}

test('a busy scope queue yields a digest-verified read-only view instead of a step timeout',async()=>{
  const f=fixture({queueBusy:true,queued:()=>new Promise(()=>{})});
  const startedAt=Date.now();
  const result=await f.context.run({scope:{scopeKey:'scope-a'}},{pairs:f.pairs});
  assert.ok(Date.now()-startedAt<3000,'returns well before the 6000ms recall gate');
  assert.equal(result.readOnly,true);
  assert.equal(result.withheld,2,'rerolled and incomplete batches are not recalled');
  assert.deepEqual(plain(result.manifest.branchGuard.verifiedStarts),[1]);
  assert.equal(result.manifest.memories[6].status,'inactive');
  assert.equal(f.manifest.memories[6].status,'committed','stored manifest is untouched');
  assert.equal(f.writes.length,0);
});

test('an idle queue still uses the persisted reconcile result',async()=>{
  const f=fixture({queueBusy:false,queued:async()=>({manifest:{memories:{}},changed:true})});
  const result=await f.context.run({scope:{scopeKey:'scope-a'}},{pairs:f.pairs});
  assert.equal(result.readOnly,undefined);assert.equal(result.changed,true);
});

test('a reconcile failure is still reported, not hidden by the fallback',async()=>{
  const f=fixture({queueBusy:true,queued:async()=>{throw new Error('branch_reconcile_scope_changed');}});
  await assert.rejects(f.context.run({scope:{scopeKey:'scope-a'}},{pairs:f.pairs}),/scope_changed/);
});
