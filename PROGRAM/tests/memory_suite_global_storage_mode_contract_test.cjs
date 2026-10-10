'use strict';
// Current core3 contract: plugin-global choice and whole known inventory. Preserved consumers keep their pinned SDK.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,variants}=require('./storage_global_allchat_job_test.cjs');
(async()=>{for(const v of variants){const f=await fixture(v);try{
 const before=[...f.values];const initial=await f.bridge.getGlobalMode();assert.equal(initial.mode,'plugin_only');assert.deepEqual([...f.values],before,'load does not retire old routes');
 const preview=await f.bridge.previewGlobalMode('plugin_only');assert.equal(preview.discoveredScopes,3);assert.equal(preview.legacyOverrides,1);assert.deepEqual([...f.values],before);
 const result=await f.bridge.setGlobalMode('server_only');assert.equal(result.verifiedScopes,3);for(const id of ['A','B','C','NEW'])assert.equal((await f.bridge.getScopeMode({scopeId:id})).mode,'server_only');
 await f.bridge.clearGlobalMode();assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');for(const id of ['A','B','C'])assert.equal((await f.bridge.getScopeMode({scopeId:id})).explicit,false);
 console.log('PASS '+v[0]+' global choice, whole inventory, reset and inheritance');
}finally{await f.close();}}})().catch(e=>{console.error(e);process.exitCode=1;});
