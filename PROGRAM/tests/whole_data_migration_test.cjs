'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../sdk/MemorySuiteGlobalMigration.source.js');
const create = fs.existsSync(modulePath) ? new Function(fs.readFileSync(modulePath,'utf8')+'\nreturn createMemorySuiteGlobalMigration;')() : null;
const OWNERS=['libra','hayaku','flashback','lia','retrace'];
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
const same = require('node:util').isDeepStrictEqual;
function fixture(mode='plugin_only') {
 const state={authority:{schema:'memory-suite.whole-data-authority.v1',revision:1,mode,generation:'initial',operationId:null}, journals:new Map(), stages:new Map(), seals:new Map(), source:new Map(), fences:new Map(), calls:[], fault:null, capacity:1e8};
 for(const owner of OWNERS) state.source.set(owner, ['active','inactive','orphan','global','shared'].map((kind,i)=>({owner,space:i===4?'local':'plugin',key:`${owner}.${kind}`,scopeKind:kind==='active'||kind==='inactive'?'scope':kind,scopeId:kind==='active'||kind==='inactive'?kind:'',deleted:false,value:{body:owner+':'+kind}})).concat([{owner,space:'plugin',key:owner+'.deleted',scopeKind:'scope',scopeId:'inactive',deleted:true,value:null}]));
 const fail=async(point,payload)=>{if(state.fault)await state.fault(point,payload)};
 const adapters=Object.fromEntries(OWNERS.map(owner=>[owner,{
  async acquireFence({operationId,authority}) {const token=owner+':'+operationId; if(state.fences.has(owner))throw Error('BUSY'); const raw=JSON.stringify(state.source.get(owner)); state.fences.set(owner,{token,raw});return {token,async assertCurrent(){if(state.fences.get(owner)?.token!==token||JSON.stringify(state.source.get(owner))!==raw)throw Error('SOURCE_CHANGED')},async release(){if(state.fences.get(owner)?.token===token)state.fences.delete(owner)}}},
  async snapshot(){await fail('snapshot',owner);return {owner,complete:true,coverage:'all_owner_data_v1',snapshotToken:JSON.stringify(state.source.get(owner)),records:clone(state.source.get(owner))}},
  async ready({snapshotToken,generation,targetMode}){await fail('ready',owner);return {owner,ready:true,snapshotToken,generation,targetMode}}
 }]));
 const provider={contract:'memory-suite.whole-data-provider.v1',capabilities:{durableJournalCAS:true,completeOwnerSnapshots:true,immutableTargetGenerations:true,sealedTargetGenerations:true,atomicAuthorityWithSourceFences:true,sharedAuthorityReaders:true},owners:adapters,
  journal:{async read(id){await fail('journalRead',id);return clone(state.journals.get(id)??null)},async compareAndSet(id,revision,row){await fail('journalBefore',row);if((state.journals.get(id)?.revision??null)!==revision)return false;state.journals.set(id,clone(row));await fail('journalAfter',row);return true}},
  async readAuthority(){await fail('authorityRead');return clone(state.authority)},
  async capacity(){return {availableBytes:state.capacity,maxRecords:1e6}},
  async writeStagedRecord({generation,mode,record}){state.calls.push('stage');await fail('stageBefore',record);const key=JSON.stringify([mode,generation,record.owner,record.space,record.key]);const old=state.stages.get(key);if(!old&&state.seals.has(JSON.stringify([mode,generation,record.owner])))throw Error('SEALED');if(old&&!same(old,record))throw Error('IMMUTABLE_CONFLICT');state.stages.set(key,clone(record));await fail('stageAfter',record)},
  async readStagedGeneration({generation,mode,owner}){await fail('stageRead',owner);return {complete:true,records:clone([...state.stages].filter(([key])=>{const a=JSON.parse(key);return a[0]===mode&&a[1]===generation&&a[2]===owner}).map(([,row])=>row))}},
  async sealStagedGeneration({mode,generation,owner,snapshotToken,records}){const seal={owner,mode,generation,snapshotToken,sealToken:owner+':'+generation};state.seals.set(JSON.stringify([mode,generation,owner]),clone(seal));return seal},
  async commitAuthority({expected,next,fences}){state.calls.push('commit');await fail('commitBefore',next);for(const owner of OWNERS){const held=state.fences.get(owner);if(!held||held.token!==fences[owner]||held.raw!==JSON.stringify(state.source.get(owner)))throw Error('SOURCE_CHANGED')};if(!same(state.authority,expected))return false;state.authority=clone(next);await fail('commitAfter',next);return true}
 };
 return {state,provider,run:async args=>create(provider).migrate(args)};
}
async function main(){
 assert.equal(typeof create,'function','whole-data coordinator must exist');
 for(const from of ['plugin_only','server_only']){
  const f=fixture(from),original=clone([...f.state.source]),targetMode=from==='plugin_only'?'server_only':'plugin_only';
  const out=await f.run({operationId:'round-'+from,targetMode});
  assert.equal(out.status,'committed');assert.equal(out.records,30);assert.equal(out.owners,5);assert.equal(f.state.authority.mode,targetMode);assert.deepEqual([...f.state.source],original);
  for(const owner of OWNERS)assert.deepEqual((await f.provider.readStagedGeneration({mode:targetMode,generation:out.generation,owner})).records,f.state.source.get(owner));
  const repeated=await f.run({operationId:'round-'+from,targetMode});assert.equal(repeated.status,'committed');assert.equal(f.state.calls.filter(x=>x==='commit').length,1);
 }
 console.log('PASS five owners, both directions, inactive/orphan/shared/global/tombstones, preservation and idempotent restart');
 const f=fixture();f.provider.owners.lia.snapshot=async()=>({owner:'lia',complete:false,coverage:'all_owner_data_v1',snapshotToken:'partial',records:[]});
 await assert.rejects(()=>f.run({operationId:'partial',targetMode:'server_only'}),e=>e.code==='MIGRATION_INVENTORY_INCOMPLETE');assert.equal(f.state.authority.revision,1);assert.equal(f.state.stages.size,0);
 console.log('PASS incomplete owner blocks all staging and authority');
}
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1});
module.exports={fixture,OWNERS,clone,create};
