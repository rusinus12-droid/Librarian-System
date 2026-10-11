'use strict';
// Current explicit reanalysis transaction replaces selected raw U+A, preserves
// unaffected turns and inactive source history, and refuses failed publication.
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/flashback_native_runtime_fixture.cjs');
(async()=>{
 const f=await createFixture({chat:{message:[{role:'user',chatId:'u1',data:'Enter the archive.'},{role:'assistant',chatId:'a1',data:'Alice signed the agreement.'},{role:'user',chatId:'u2',data:'Look for a ribbon.'},{role:'assistant',chatId:'a2',data:'Alice found a blue ribbon.'}]}});
 try{
  const a=f.api,t=a._test;await a.ingestLiveChatColdStart({scope:'current',canonical:true});
  const scope=await a.resolveCurrentScope(),cfg=await a.loadSettings();
  const original=await t.loadScopeRecords(scope.scopeKey);assert.equal(original.records.length,2);
  const replace=async key=>{const ticket=await a.previewSourceEdits([key]);assert.equal(ticket.allowed,true,JSON.stringify(ticket));return a.applySourceEdits(ticket)};
  f.currentChat.message[1].data='Alice did not sign the agreement. <img src=x onerror="attack()">';
  const applied=await replace('1');assert.equal(applied.ok,true,JSON.stringify(applied));assert.equal(applied.rawSaved,true);assert.equal(applied.remoteEmbeddingQueued,false);
  let stored=await t.loadScopeRecords(scope.scopeKey);
  assert.ok(stored.records.some(r=>r.text.includes('did not sign')));
  assert.equal(stored.records.some(r=>r.text.includes('Alice signed')),false);
  assert.ok(stored.records.some(r=>r.text.includes('blue ribbon')));
  const history=(await t.loadTurnWorldline(scope.scopeKey)).retiredRecords;
  assert.ok(history.some(r=>r.text.includes('Alice signed')));
  const diff=t.flashbackSourceDiff('Alice signed the agreement.',f.currentChat.message[1].data);
  assert.match(diff.after,/<mark/);assert.doesNotMatch(diff.after,/<img/);assert.match(diff.after,/&lt;img/);
  // Exact finalized U+A, with its native IDs, confirms provisional capture.
  const provisional=stored.records.map(r=>Number(r.turnIndex||r.pairIndex)===2?{...r,metadata:{...r.metadata,captureAuthority:{provisional:true,liveConfirmed:false}}}:r);
  await t.saveAllRecords(provisional,cfg,scope);
  const sync=()=>t.synchronizeFlashbackTurnWorldline(scope,t.liveChatStateFromNormalized(t.normalizeStoredChatMessages(f.currentChat,scope.scopeKey)),cfg,{forceReconcile:true});
  await sync();stored=await t.loadScopeRecords(scope.scopeKey);
  assert.ok(stored.records.filter(r=>Number(r.turnIndex||r.pairIndex)===2).every(r=>r.metadata.captureAuthority.liveConfirmed===true));
  f.currentChat.message[3].data='Alice found a green ribbon.';
  assert.equal((await replace('2')).ok,true);
  assert.ok((await t.loadScopeRecords(scope.scopeKey)).records.some(r=>r.text.includes('green ribbon')));
  // No successful result may be inferred from a failed worldline receipt.
  const beforeFault=await t.loadScopeRecords(scope.scopeKey);
  f.currentChat.message[1].data='Alice postponed the agreement.';
  const set=f.pluginStorage.setItem.bind(f.pluginStorage);let fail=true;
  f.pluginStorage.setItem=async(k,v)=>{if(fail&&String(k).endsWith(':turn_worldline:v1')){fail=false;throw Error('fixture failed worldline commit')}return set(k,v)};
  const failed=await replace('1');assert.equal(failed.ok,false);assert.ok(failed.reason);assert.equal(fail,false);
  const afterFault=await t.loadScopeRecords(scope.scopeKey);
  assert.ok(afterFault.records.some(r=>r.text.includes('did not sign')),'failed replacement preserves prior active source');
  assert.equal(afterFault.records.some(r=>r.text.includes('postponed')),false,'failed replacement is never active');
  assert.equal(afterFault.records.length,beforeFault.records.length);
  assert.equal(f.currentChat.message[1].data,'Alice postponed the agreement.','failure cannot revert host source');
  console.log('flashback_source_diff_transaction_v130_test: PASS (explicit raw replacement; source/history/rollback preserved)');
 }finally{await f.dispose()}
})().catch(e=>{console.error(e);process.exitCode=1});
