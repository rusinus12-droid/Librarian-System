'use strict';
// The retired RE:TRACE viewer must not come back as a second raw-page reader.
// Physical raw-page behavior remains covered by flashback_raw_page_reference_runtime_test.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const p=path.resolve(__dirname,'..');
const {createCostFixture}=require('./fixtures/flashback_append_cost_fixture.cjs');
(async()=>{const x=await createCostFixture({precomputedVectors:true});
try{
 const before=await x.seed(65);
 vm.runInContext(fs.readFileSync(path.join(p,'plugins/RETRACE.js'),'utf8'),x.f.context,{filename:'RETRACE.js'});
 for(let i=0;i<100&&!x.f.context.__RETRACE;i++)await new Promise(r=>setTimeout(r,20));
 const api=x.f.context.__RETRACE;assert(api);
 assert.equal(api.readFlashbackViewer,undefined,'retired cross-owner raw-page viewer is not callable');
 assert.equal(typeof api.inspectTransition,'function','next-session inspection remains');
 const preserved=await x.read();
 assert.equal(preserved.records.length,before.records.length);
 assert.deepEqual(x.clone(preserved.records),x.clone(before.records),'loading RE:TRACE preserves the owner raw pages');
 await x.append(66);const owner=await x.read();
 assert.equal(owner.records.length,66);assert.equal(owner.manifest.missingShards,0);assert.equal(x.providerCalls(),0);
 console.log('retrace_flashback_raw_page_cow_test: PASS (viewer retired; owner raw pages preserved)');
}finally{await x.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
