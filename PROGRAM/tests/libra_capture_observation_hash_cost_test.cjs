'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
test('exact steady validation reuses observation hash after comparing all current raw rows',async()=>{
  const f=await fixture({transformSource(source){const anchor='    const branchContentHash = value => {';
    assert.ok(source.includes(anchor));return source.replace(anchor,anchor+" if(String(value).includes('\\u001e'))globalThis.__captureObservationHashes=(globalThis.__captureObservationHashes||0)+1;");}});
  try{
    let reads=0;const chat={id:'capture-observation-cost',message:[]};
    for(let t=1;t<=2000;t++)for(const role of ['user','assistant']){
      let raw=`Exact ${role} raw ${t}`;const row={role,chatId:`observation-${t}-${role[0]}`};
      Object.defineProperty(row,'data',{enumerable:true,get(){reads++;return raw;},set(value){raw=String(value);}});chat.message.push(row);
    }
    const first=f.r.api.debugBuildPairs(chat,'capture-observation-cost'),hash=f.r.api.getPairRevisionCacheDiagnostics().stats.lastObservationHash;
    reads=0;f.r.context.__captureObservationHashes=0;
    const warm=f.r.api.debugBuildPairs(chat,'capture-observation-cost');
    assert.deepEqual(warm,first);assert.ok(reads>=4000,'full current raw comparisons remain mandatory');
    assert.equal(f.r.context.__captureObservationHashes,0,'an identical exact sequence need not hash its observation string again');
    assert.equal(f.r.api.getPairRevisionCacheDiagnostics().stats.lastObservationHash,hash);
    chat.message[1].data='Unannounced early edit';
    const changed=f.r.api.debugBuildPairs(chat,'capture-observation-cost');assert.equal(changed[0].assistant.text,'Unannounced early edit');
    assert.equal(f.r.context.__captureObservationHashes,1);assert.notEqual(f.r.api.getPairRevisionCacheDiagnostics().stats.lastObservationHash,hash);
  }finally{await f.r.cleanup();}
});
