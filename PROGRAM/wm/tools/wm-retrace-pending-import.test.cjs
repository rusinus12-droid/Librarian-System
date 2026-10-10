'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,identity}=require('./wm-host-gate-fixture.cjs');
const head=scope=>({protocol:'wm.snapshot-authority.v1',authorityId:'test-authority',storeId:'test-store',scope,epoch:'test-epoch',revision:'1',schema:'wm.canonical-raw.v1',generationId:'test-generation',sha256:'a'.repeat(64),utf8Bytes:1,tombstone:false});
test('basic pending import requires verified capability and stays unresolved across gate recreation',async()=>{
  const f=fixture(),targetIdentity=identity(),sourceIdentity=identity('source');
  const pendingToken=await f.gate.markTargetPending({transferId:'test-transfer',targetIdentity});assert.equal(pendingToken.ok,undefined);
  for(const operation of ['hydrate','inherit','cold_bootstrap','raw_append','save'])assert.equal((await f.gate.checkTarget({scope:targetIdentity.scope,targetIdentity,operation})).reason,'target_import_pending');
  assert.equal((await f.legacyWrite(targetIdentity,'copied native lore')).ok,false);assert.equal(f.state.memoryWrites.length,0);
  const reloaded=fixture({state:f.state});assert.equal((await reloaded.gate.checkTarget({scope:targetIdentity.scope,targetIdentity,operation:'hydrate'})).ok,false);
  assert.equal((await f.gate.checkTarget({scope:targetIdentity.scope,targetIdentity,operation:'import',importToken:{}})).ok,false);
  const authorized=await f.gate.authorizeImport({pendingToken,receipt:f.authorize('test-transfer',sourceIdentity,targetIdentity)});assert.equal(authorized.ok,true);
  assert.equal((await f.gate.checkTarget({scope:targetIdentity.scope,targetIdentity,operation:'import',importToken:authorized.importToken})).ok,true);
  const targetHead=head(targetIdentity.scope),receipt=f.releaseReceipt('test-transfer',targetIdentity,targetHead);
  assert.equal((await f.gate.releaseTarget({pendingToken,targetHead,receipt})).ok,true);
  assert.equal((await reloaded.gate.checkTarget({scope:targetIdentity.scope,targetIdentity,operation:'save'})).ok,true);
  assert.equal((await f.legacyWrite(targetIdentity,'normal native write')).ok,true);
});
