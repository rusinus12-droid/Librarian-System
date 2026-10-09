'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./libra_typed_recall_queue_test.cjs');
const {memoryEntry}=require('./libra_recall_test_runtime.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const cleanup=r=>{r.jobs.cancel(r.snap0.scopeKey);r.clock.timers.clear();};

async function setup(rows,dimension,{tailDistinct=false}={}){
  const r=await runtime(null,{dist:process.env.LIBRA_RECALL_TEST_DIST,transformCode(code){
    const i=code.lastIndexOf('})();');assert(i>0);
    return code.slice(0,i)+'\n;globalThis.__WINDOW_CAPACITY__={buildProductionRecallConfiguration};\n'+code.slice(i);
  }});
  r.chat.localLore=Array.from({length:rows},(_,i)=>({...memoryEntry(4,`Synthetic window row ${i}`),key:`lmai_memory::window-${i}`}));
  const cfg=r.context.__WINDOW_CAPACITY__.buildProductionRecallConfiguration({embed:{enabled:true,provider:'ollama',url:'http://127.0.0.1:9999',model:'window-capacity',modelRevision:'v1',dimension}});
  assert(cfg.provider);const p=cfg.provider,pol=clone(cfg.policy),snap=r.snap();
  const units=r.corpus.enumerate(snap,pol).filter(u=>r.corpus.adapters[u.family].eligibility(u,snap).eligible);
  assert.equal(units.length,rows);
  let providerCalls=0;
  r.host.nativeFetch=async(_url,init)=>{
    providerCalls++;
    const body=JSON.parse(init.body),input=String(body.input||'');
    let vector=Array(dimension).fill(.125);
    if(tailDistinct&&dimension===3){
      if(input.startsWith('QUERY:'))vector=[0,1,0];
      else if(input.includes(`Synthetic window row ${rows-1}`))vector=[0,1,0];
      else vector=[1,0,0];
    }
    return{ok:true,status:200,text:async()=>JSON.stringify({embeddings:[vector]})};
  };
  const fill=()=>r.jobs.backfill(snap,p,pol,{explicit:true,budget:pol.background});
  return Object.assign(r,{p,pol,snap0:snap,units,fill,providerCalls:()=>providerCalls});
}
async function fillAll(r,maxSlices=512){
  const reports=[];
  for(let i=0;i<maxSlices;i++){
    const x=await r.fill();reports.push(x);
    if(x.complete)return reports;
    assert.equal(x.canContinue,true,JSON.stringify(x));
  }
  assert.fail(`did not complete within ${maxSlices} slices`);
}
for(const [rows,dimension] of [[128,3],[75,4096]])test(`production expected window progresses ${rows} rows at ${dimension}D instead of whole-corpus refusal`,async()=>{
  const r=await setup(rows,dimension);try{
    const first=await r.fill();
    assert(first.calls>0,JSON.stringify(first));
    assert(first.written>0,JSON.stringify(first));
    assert.equal(first.complete,false);
    assert.equal(first.canContinue,true,JSON.stringify(first));
    assert(!first.diagnostics.some(d=>d.reason==='expected_bytes_bound'),JSON.stringify(first));
    const rest=first.complete?[first]:[first,...await fillAll(r,512)];
    assert(rest.at(-1).complete,true);
    assert.equal(r.providerCalls(),rows);
  }finally{cleanup(r);}
});

test('windowed semantic search includes a tail unit after bounded indexing',async()=>{
  const r=await setup(128,3,{tailDistinct:true});try{
    const reports=await fillAll(r,512);assert(reports.at(-1).complete);
    const before=r.providerCalls();
    const lane=await r.engine.search('QUERY:tail semantic target',r.snap0,r.p,{policy:r.pol,depth:4,maxScanUnits:256});
    assert.equal(r.providerCalls(),before+1,'query adds exactly one provider call');
    assert.equal(lane.status,'ready');
    assert.equal(lane.coverage.eligible,128);
    assert(lane.hits.some(h=>h.identity===r.units.at(-1).identity),JSON.stringify(lane));
  }finally{cleanup(r);}
});

test.after(()=>assert.deepEqual(globalThis.__finalDeliveryTransportAttempts||[],[]));
