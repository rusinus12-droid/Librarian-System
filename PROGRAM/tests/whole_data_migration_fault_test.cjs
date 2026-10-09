'use strict';
const assert = require('node:assert/strict');
const {fixture,create,clone,OWNERS}=require('./whole_data_migration_test.cjs');
const opts={operationId:'fault',targetMode:'server_only'};
const unchanged=f=>{assert.equal(f.state.authority.mode,'plugin_only');assert.equal(f.state.authority.revision,1)};
async function rejects(f,code){await assert.rejects(()=>f.run(opts),e=>e.code===code,code);unchanged(f)}
(async()=>{
 let count=0;
 {const f=fixture();delete f.provider.owners.lia;await rejects(f,'MIGRATION_OWNER_SET_INCOMPLETE');count++}
 {const f=fixture();f.provider.capabilities.sharedAuthorityReaders=false;await rejects(f,'MIGRATION_PROVIDER_UNAVAILABLE');count++}
 {const f=fixture();f.state.source.get('lia').push(clone(f.state.source.get('lia')[0]));await rejects(f,'MIGRATION_DUPLICATE_RECORD');count++}
 {const f=fixture();f.state.capacity=1;await rejects(f,'MIGRATION_CAPACITY_UNVERIFIED');assert.equal(f.state.stages.size,0);count++}
 {const f=fixture();f.state.source.set('lia',[]);const out=await f.run(opts);assert.equal(out.records,24);count++}
 {const f=fixture();let once=true;f.state.fault=async(p,row)=>{if(p==='journalAfter'&&once){once=false;throw Error('dropped ACK')}};assert.equal((await f.run(opts)).status,'committed');count++}
 {const f=fixture();f.state.fault=async p=>{if(p==='journalBefore')throw Error('no durability')};await rejects(f,'MIGRATION_JOURNAL_UNCERTAIN');assert.equal(f.state.stages.size,0);count++}
 {const f=fixture();let n=0;f.state.fault=async p=>{if(p==='stageBefore'&&++n===4)throw Error('stopped')};await assert.rejects(()=>f.run(opts),/stopped/);unchanged(f);f.state.fault=null;assert.equal((await f.run(opts)).status,'committed');assert.equal(f.state.stages.size,30);count++}
 {const f=fixture();f.state.fault=async p=>{if(p==='stageRead'){const [k,v]=f.state.stages.entries().next().value;f.state.stages.set(k,{...v,value:'corrupt'})}};await rejects(f,'MIGRATION_STAGE_READBACK_MISMATCH');count++}
 {const f=fixture();f.provider.owners.lia.ready=async()=>({owner:'lia',ready:false});await rejects(f,'MIGRATION_OWNER_NOT_READY');count++}
 {const f=fixture();const controller=new AbortController();f.state.fault=async p=>{if(p==='stageAfter')controller.abort()};assert.equal((await f.run({...opts,signal:controller.signal})).status,'cancelled');unchanged(f);assert.equal((await f.run(opts)).status,'cancelled');count++}
 {const f=fixture();f.state.fault=async p=>{if(p==='ready')f.state.source.get('retrace')[0].value.body='changed'};await assert.rejects(()=>f.run(opts),/SOURCE_CHANGED/);unchanged(f);count++}
 {const f=fixture();f.state.fault=async p=>{if(p==='commitAfter')throw Error('lost commit ACK')};assert.equal((await f.run(opts)).status,'committed');count++}
 {const f=fixture();let denyRead=false;f.state.fault=async p=>{if(p==='commitAfter'){denyRead=true;throw Error('lost ACK')};if(denyRead&&p==='authorityRead')throw Error('network')};await assert.rejects(()=>f.run(opts),e=>e.code==='MIGRATION_COMMIT_UNCERTAIN');f.state.fault=null;assert.equal((await f.run(opts)).status,'committed');assert.equal(f.state.calls.filter(x=>x==='commit').length,1);count++}
 {const f=fixture();await f.run(opts);await assert.rejects(()=>f.run({...opts,targetMode:'plugin_only'}),e=>e.code==='MIGRATION_OPERATION_ID_CONFLICT');count++}
 // Regression: an exact durable decision must reconcile even if another
 // successful migration advanced authority before the original caller restarts.
 {const f=fixture();let denyRead=false;f.state.fault=async p=>{if(p==='commitAfter'){denyRead=true;throw Error('lost ACK')};if(denyRead&&p==='authorityRead')throw Error('network')};await assert.rejects(()=>f.run(opts));f.state.fault=null;const committed=clone(f.state.authority);f.provider.readOperation=async()=>({state:'committed',authority:committed});f.state.authority={...committed,revision:3,operationId:'later',mode:'plugin_only',generation:'later'};assert.equal((await f.run(opts)).status,'committed');count++}
 {const f=fixture();f.state.authority.revision=Number.MAX_SAFE_INTEGER;await assert.rejects(()=>f.run(opts),e=>e.code==='MIGRATION_AUTHORITY_REVISION_EXHAUSTED');assert.equal(f.state.stages.size,0);count++}
 {const f=fixture();f.state.journals.set('fault',{schema:'memory-suite.whole-data-journal.v1',operationId:'fault',targetMode:'server_only',phase:'committed'});await assert.rejects(()=>f.run(opts),e=>e.code==='MIGRATION_JOURNAL_INVALID');count++}
 {const f=fixture();let committed=false;const original=f.provider.commitAuthority;f.provider.commitAuthority=async args=>{assert.equal(Object.keys(args.seals||{}).length,5,'atomic publication must be bound to five sealed generation receipts');committed=true;return original(args)};assert.equal((await f.run(opts)).status,'committed');assert.equal(committed,true);count++}
 console.log('PASS '+count+' migration failure, refusal, restart and unknown-ACK groups');
})().catch(e=>{console.error(e);process.exitCode=1});
