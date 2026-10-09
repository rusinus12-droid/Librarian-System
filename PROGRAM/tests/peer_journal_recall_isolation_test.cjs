'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
(async()=>{
 const f=await fixture({transformSource:s=>s
  .replace('      resolveContext, buildPairs,','      getLibraSourceEdits, resolveContext, buildPairs,')
  .replace('    getSourceEditSyncStatus: () =>','    auditCore: () => LibraMemoryCore,\n    getSourceEditSyncStatus: () =>')
  .replace('write:(scopeKey,body)=>storage.setJson(','write:(scopeKey,body)=>globalThis.auditRejectJournal ? false : storage.setJson(')});
 try {
  await f.r.api.runManualColdStart();
  const core=f.r.api.auditCore(),ctx=await core.resolveContext();
  const manifest=()=>[...f.r.values].filter(([k])=>k.endsWith(':manifest')).map(([,v])=>JSON.parse(v)).find(m=>m.memories);
  const old=manifest().memories['1'],bytes=f.r.values.get(old.key),calls=f.control.calls.length;
  assert.equal(old.status,'committed');
  f.r.context.auditRejectJournal=true;
  const consent=core.getLibraSourceEdits();
  await assert.rejects(consent.inspect({scopeKey:ctx.scope.scopeKey,units:[{key:'99',start:99,end:103,digest:'x',changed:true}]},{phase:"before",prompt:false}),/SOURCE_EDIT_JOURNAL_WRITE_REJECTED/);
  for(let i=0;i<2;i++)await core.reconcileCanonicalBranchBeforeRecall(ctx,{full:true});
  assert.equal(manifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(old.key),bytes);
  assert.equal(consent.canWrite(ctx.scope.scopeKey,1,old.sourceDigest),false);
  assert.equal(f.control.calls.length,calls);
  const damaged=manifest();damaged.memories['1'].status='inactive';damaged.memories['1'].inactiveReason='source_edit_identity_unverified';
  await core.reconcileCanonicalBranchBeforeRecall(ctx,{full:true,manifest:damaged});
  assert.equal(manifest().memories['1'].status,'committed','the original matching source can reactivate a previously misclassified ref');
  // A genuine edit still preserves the prior canonical, without granting a replacement.
  f.chat.message[1].data+=' A new source change.';
  await core.reconcileCanonicalBranchBeforeRecall(ctx,{full:true});
  assert.equal(manifest().memories['1'].status,'committed');
  assert.equal(f.r.values.get(old.key),bytes);
  assert.equal(consent.canWrite(ctx.scope.scopeKey,1,'unapproved'),false);
  console.log('PASS LIBRA journal write failure preserves canonical bytes/activation; fresh writes remain blocked');
 } finally {await f.r.cleanup();}
 const b=await createFlashback(path.resolve(__dirname,'..'),{transformSource:s=>s
  .replace('try { const snap=await flashbackSourceEditSnapshot(scopeBundle);','try { if(globalThis.auditFail)throw new Error(globalThis.auditFail); const snap=await flashbackSourceEditSnapshot(scopeBundle);')
  .replace('const reconciled = await withinHookDeadline(','globalThis.auditReachedRecallPreparation=true; const reconciled = await withinHookDeadline(')});
 try {
  const chat=await b.host.getChat();chat.message=[{role:'user',chatId:'u1',data:'Where is Alice?'},{role:'assistant',chatId:'a1',data:'Alice is in the office.'},{role:'user',chatId:'u2',data:'What next?'}];chat.messages=chat.message;
  for(const error of ['SOURCE_EDIT_JOURNAL_WRITE_REJECTED','SOURCE_EDIT_JOURNAL_READBACK_FAILED']) {
   b.context.auditFail=error;b.context.auditReachedRecallPreparation=false;
   await b.api._test.beforeRequest([{role:'user',content:'What next?'}],'model');
   assert.equal(b.context.auditReachedRecallPreparation,true);
  }
  b.context.auditFail='UNRELATED_SCOPE_FAILURE';b.context.auditReachedRecallPreparation=false;
  await b.api._test.beforeRequest([{role:'user',content:'What next?'}],'model');
  assert.equal(b.context.auditReachedRecallPreparation,false,'unrelated errors must retain the original failure path');
  console.log('PASS Flashback actual beforeRequest continues past journal errors; unrelated failure still stops preparation');
 } finally {await b.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
