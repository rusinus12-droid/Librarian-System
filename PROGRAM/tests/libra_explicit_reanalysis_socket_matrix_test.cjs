'use strict';
// Real socket integration. Not run in the strict offline functional lane.
const {test}=require('node:test'),assert=require('node:assert/strict');
const execute=async f=>{const inv=await f.r.api.listCanonicalBatchRanges();return f.r.api.startSelectedCanonicalBatches({scopeKey:inv.scopeKey,mode:'source_edit',ranges:inv.ranges.filter(r=>r.startTurn===1)});};
for(const mode of ['mirror','server_only'])test('explicit current-source replacement preserves old physical body in '+mode,async()=>{
 const {serverFixture}=require('./fixtures/libra_server_runtime_fixture.cjs');const fx=await serverFixture({mode}),f=fx.f;
 try{assert.equal((await f.run()).completed,1);await f.r.api.retryPendingUnifiedVectors();
  const before=fx.getManifest().memories['1'],bytes=fx.storedRows().find(r=>r.key===before.key).raw;
  f.chat.message[0].data+=' Explicit replacement edit.';
  const result=await execute(f);assert.equal(result.ok,true,JSON.stringify(result));
  const after=fx.getManifest().memories['1'];assert.equal(after.status,'committed');assert.ok(after.revision>before.revision);
  assert.equal(fx.storedRows().find(r=>r.key===before.key).raw,bytes);
  assert.equal(fx.storedRows().some(r=>r.key.includes(':source-edit-consent:')),false);
 }finally{await fx.cleanup();}
});

