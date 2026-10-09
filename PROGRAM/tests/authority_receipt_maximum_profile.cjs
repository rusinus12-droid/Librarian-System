'use strict';
// Explicitly scheduled allocation profile. Never included by the *.test.cjs glob.
// Run ONE named mode per fresh process only with the parent's maximum-profile grant.
const mode=process.argv[2];
if(!['unicode','surrogate','exact','over'].includes(mode))throw Error('EXPLICIT_MAXIMUM_PROFILE_MODE_REQUIRED');
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const strictGuard=require('./fixtures/authority_strict_guard_probe.cjs').capture();
const {fixture,fresh,ownerApi}=require('./fixtures/authority_server_fixture.cjs');
const {createAuthorityCoordinator}=require('../server/authority/coordinator.cjs');
const LIMIT=134217728;

test('maximum_allocation_profile_'+mode,t=>{
 assert(strictGuard,'audited guard required for this explicit maximum profile');console.log(JSON.stringify(strictGuard.verify()));
 const f=fixture(t);f.activate();const repo=f.repositories.libra,id='maximum-retention-'+mode;
 if(mode==='unicode'||mode==='surrogate'){
  const fill=mode==='unicode'?'한':'\ud800';
  const mutations=Array.from({length:4096},(_,i)=>{const suffix=':'+String(i).padStart(4,'0');return fresh('libra:max:'+fill.repeat(4096-10-suffix.length)+suffix,i);});
  assert(mutations.every(m=>m.key.length===4096));
  const result=repo.applyConditionalBatch(mutations,{operationId:id}),receipt=f.readReceipt('libra',id);
  assert.equal(result.result.receipts.length,4096);assert.deepEqual(result.result.receipts.map(r=>r.key),mutations.map(m=>m.key));
  assert.equal(receipt.touchedSources.count,4096);assert(receipt.ordinaryResult.utf8Bytes<LIMIT);assert(receipt.ordinaryResult.utf8Bytes>(mode==='surrogate'?99000000:49000000));
  assert.deepEqual(f.readResult('libra',id),result);assert.deepEqual(repo.applyConditionalBatch(mutations,{operationId:id}),result);
  const retained=repo.database.prepare('SELECT LENGTH(CAST(response_json AS BLOB)) n FROM authority_write_results WHERE operation_id=?').get(id);
  assert.equal(retained.n,receipt.ordinaryResult.utf8Bytes);console.log(JSON.stringify({mode,resultBytes:retained.n,touches:receipt.touchedSources.count,compactBytes:Buffer.byteLength(JSON.stringify(receipt)),maxRssKiB:process.resourceUsage().maxRSS}));
 }else{
  const size=LIMIT+(mode==='over'?1:0),original='{"x":"'+'a'.repeat(size-8)+'"}';assert.equal(Buffer.byteLength(original),size);
  const input={generation:f.control.readWitness().generation,namespace:'libra',operationId:id,fingerprint:'a'.repeat(64),operationClass:'kv'};
  const coordinator=createAuthorityCoordinator({control:f.control,resolveOwnerStore:n=>f.owners[n]});
  const prepare=DatabaseSync.prototype.prepare;let unbounded=0;
  DatabaseSync.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);if(/FROM (?:operations|authority_write_results)\b/i.test(sql)){const get=stmt.get;stmt.get=function(...args){const row=get.apply(this,args);if(row&&Object.values(row).some(v=>typeof v==='string'&&Buffer.byteLength(v)>LIMIT)){unbounded++;throw Error('UNBOUNDED_RESULT_LOAD');}return row;};}return stmt;};
  const work=tx=>{tx.run('INSERT INTO kv VALUES(?,?,?,0,1,?,0)','plugin','libra:max:bound','0','b'.repeat(64));tx.run('INSERT INTO operations VALUES(?,?,?,0)',id,input.fingerprint,original);};
  try{
   if(mode==='over'){
    assert.throws(()=>coordinator.runMutation(input,work),/AUTHORITY_QUARANTINED/);assert.equal(f.control.readOperation(input).status,'aborted');
    for(const table of ['kv','operations','authority_write_receipts','authority_write_results','authority_write_touches'])assert.equal(repo.database.prepare('SELECT count(*) n FROM '+table).get().n,0);
   }else{
    const outcome=coordinator.runMutation(input,work);assert.equal(outcome.status,'committed');assert.equal(outcome.decision.receipt.ordinaryResult.utf8Bytes,LIMIT);
    const result=ownerApi.readOwnerOperationResult(f.owners.libra,input,{expectedReceipt:outcome.decision.receipt});assert.equal(result.x.length,LIMIT-8);
    assert.equal(repo.database.prepare('SELECT LENGTH(CAST(response_json AS BLOB)) n FROM authority_write_results').get().n,LIMIT);
   }
  }finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(unbounded,0);console.log(JSON.stringify({mode,originalBytes:size,unboundedScalarLoads:unbounded,maxRssKiB:process.resourceUsage().maxRSS}));
 }
});
