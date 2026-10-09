'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,hook,plain}=require('./wm-native-cache-support.cjs');
for(const fault of ['branch','rollout','secret','source'])test('default native cache preserves final physical refresh policy: '+fault,async()=>{
 const results=[];
 for(const config of [undefined,{enabled:false}]){const f=await fixture({config});let armed=false,changed=false;const get=f.r.storage.getItem;f.r.storage.getItem=async key=>{const stage=f.r.context.__REFRESH_OBS__;if(armed&&!changed&&stage.serial===3&&stage.targetDepth&&stage.targetReadSlot===2&&key===f.key){changed=true;if(fault==='branch')f.r.chat.branchId='native-final-new-branch';if(fault==='rollout')f.r.context.__QUEUE_TEST__.rollout.begin();if(fault==='secret')f.native.secret.getState().secrets.push({id:'native-final-secret',content:'민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.',knownBy:['user'],status:'active'});if(fault==='source')f.r.store.set(f.key,f.raw.replace('펜던트','변경된'));}return get(key);};
 assert.match(JSON.stringify(await hook(f)),/Historical reference;/);f.r.context.__REFRESH_OBS__.serial=0;armed=true;const before=f.cache?.stats().core?.hits||0,out=await hook(f);assert.equal(changed,true);if(config===undefined){assert.ok(f.cache.stats().core.hits>before);assert.equal(f.cache.stats().requestOwners,0);assert.equal(f.cache.stats().requestBorrows,0);}if(fault==='branch'||fault==='rollout')assert.doesNotMatch(JSON.stringify(out),/Historical reference;/);if(fault==='secret')assert.ok(!JSON.stringify(out).includes('민지가 현우에게 은색 펜던트를 맡기고 돌아오면 돌려달라고 약속했다.'));results.push(plain(out));
 }
 assert.deepEqual(results[0],results[1]);
});
