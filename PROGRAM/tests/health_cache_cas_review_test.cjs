'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const dir=process.env.HEALTH_REVIEW_TESTS||__dirname;
let source=fs.readFileSync(path.join(dir,'health_lia_retrace_wiring_test.cjs'),'utf8');source=source.slice(0,source.indexOf("for(const owner of ['LIA','RETRACE'])"))+'\nmodule.exports=fixture;';const sandbox={require,__dirname:dir,module:{exports:{}},structuredClone};vm.runInNewContext(source,sandbox);const fixture=sandbox.module.exports;
const cases={LIA:{
 store:f=>{f.context.cachedLivePersonaStore=structuredClone(f.cache)},
 container:f=>{f.cache.bindings={...f.cache.bindings}},
 equal_entry:f=>{f.cache.bindings[f.scopeKey]=structuredClone(f.cache.bindings[f.scopeKey])},
 in_place_entry:f=>{f.cache.bindings[f.scopeKey].liveState.push({review:'new cached data'})},
 completeness:f=>{f.context.cachedLivePersonaStoreComplete=false}
},RETRACE:{
 equal_preview:f=>{f.Runtime.lastPreview=structuredClone(f.Runtime.lastPreview)},
 equal_suite:f=>{f.Runtime.compatibilitySuite=structuredClone(f.Runtime.compatibilitySuite)},
 in_place_preview:f=>{f.Runtime.lastPreview.review='new preview content'},
 in_place_suite:f=>{f.Runtime.compatibilitySuite.review='new suite content'},
 checked_timestamp:f=>{f.Runtime.compatibilityCheckedAt++},
 acknowledged_timestamp:f=>{f.Runtime.compatibilityAcknowledgedAt++}
}};
const snapshot=f=>JSON.stringify({store:f.context.cachedLivePersonaStore,complete:f.context.cachedLivePersonaStoreComplete,preview:f.Runtime.lastPreview,suite:f.Runtime.compatibilitySuite,checked:f.Runtime.compatibilityCheckedAt,ack:f.Runtime.compatibilityAcknowledgedAt});
for(const [owner,changes] of Object.entries(cases))for(const [name,change] of Object.entries(changes))test(owner+': changed captured cache '+name+' must refuse without effects',async()=>{const f=fixture(owner),ticket=await f.health.preview();assert.equal(ticket.allowed,true);change(f);const before=snapshot(f);const result=await f.health.repair(ticket);assert.equal(snapshot(f),before,'a replacement/refill must survive an old permit');assert.equal(result.status,'blocked');assert.equal(result.writeIssued,false);assert.equal((await f.health.repair(ticket)).status,'blocked');});
