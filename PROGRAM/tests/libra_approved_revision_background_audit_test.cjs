'use strict';const{test}=require('node:test'),assert=require('node:assert/strict');const{fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
// Explicit range selection is read-only; execution is the one user action. No tracker ticket exists.
const currentSelection=async f=>{const inv=await f.r.api.listCanonicalBatchRanges();return {allowed:true,scopeKey:inv.scopeKey,mode:'source_edit',ranges:inv.ranges.filter(r=>r.startTurn===1)};};
const applySelection=async(f,selection)=>{try{return await f.r.api.startSelectedCanonicalBatches(selection);}catch(e){return {ok:false,reason:String(e.message||e)};}};

// Isolate fixture bootstrap timers, then invoke the real scheduler/callback.
const expose=source=>{const replace=(a,b)=>{assert.equal(source.split(a).length,2,a);source=source.replace(a,b)};
 replace('if (deepAuditDue) {','if (deepAuditDue && globalThis.__reviewAllowAutomaticAudit) {');
 replace('await LibraMemoryCore.readySourceRules();','globalThis.__reviewCore=LibraMemoryCore;await LibraMemoryCore.readySourceRules();');
 const proofName='libraCanonicalSlotPreservationKind';
 replace('const '+proofName+' = async', 'const '+proofName+' = globalThis.__reviewPreservation = async');
 replace('const scheduleDeepBranchAudit = (context, pairs, delayMs = BRANCH_DEEP_AUDIT_DELAY_MS) => {','const scheduleDeepBranchAudit = globalThis.__reviewSchedule = (context, pairs, delayMs = BRANCH_DEEP_AUDIT_DELAY_MS) => {');
 replace('const task = enqueue(scopeKey, async () => {\n          const liveContext','const task = enqueue(scopeKey, async () => {globalThis.__reviewAuditEntered=true;\n          const liveContext');
 replace("pairs: livePairs, full: true, background: true, scheduleDeep: false, reason: 'background_deep_audit'\n          });","pairs: livePairs, full: true, background: true, scheduleDeep: false, reason: 'background_deep_audit'\n          });globalThis.__reviewAuditCompleted=(globalThis.__reviewAuditCompleted||0)+1;");
 replace("warn('LIBRA background branch audit failed', error);","globalThis.__reviewAuditError=String(error?.stack||error);warn('LIBRA background branch audit failed', error);");return source;};
for(const action of ['same_ids_old_text','changed_native_id','rollback'])test((action==='same_ids_old_text'?'scheduled audit ':'direct full/background guard ')+action,async()=>{const f=await fixture({transformSource:expose});try{assert.equal((await f.run()).completed,1);const first=f.getManifest().memories['1'],original=f.chat.message[0].data;f.chat.message[0].data+=' Explicit revision B.';const ticket=await currentSelection(f);assert.equal(ticket.allowed,true);assert.equal((await applySelection(f,ticket)).ok,true);const approved=f.getManifest().memories['1'],approvedBytes=f.r.values.get(approved.key),calls=f.control.calls.length;assert.notEqual(approved.key,first.key);const core=f.r.context.__reviewCore;for(const[k,t]of core.state.timers){if(String(k).startsWith('branch_audit:')){f.r.context.clearTimeout(t);core.state.timers.delete(k)}}
 if(action==='same_ids_old_text')f.chat.message[0].data=original;if(action==='changed_native_id')f.chat.message[0].chatId='replacement-user';if(action==='rollback')f.chat.message.splice(6);
 if(action==='same_ids_old_text'){const count=f.r.context.__reviewAuditCompleted||0;assert.equal(f.r.context.__reviewSchedule(await core.resolveContext(),[],0),true);const until=Date.now()+8000;while((f.r.context.__reviewAuditCompleted||0)===count&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(f.r.context.__reviewAuditCompleted,count+1,'actual scheduled callback completed')}else{await core.reconcileCanonicalBranchBeforeRecall(await core.resolveContext(),{full:true,background:true,scheduleDeep:false,reason:'review_native_identity_guard'})}const after=f.getManifest().memories['1'];if(action==='same_ids_old_text'){assert.equal(after.key,approved.key);assert.equal(after.status,'committed')}else assert.notEqual(after.status,'committed');assert.equal(f.r.values.get(approved.key),approvedBytes);assert.equal(f.control.calls.length,calls,'audit cannot run a model');}finally{await f.r.cleanup()}});

for (const kind of ['native','legacy','merged_legacy','duplicate','changed_native_id']) test('preservation ownership classification '+kind,async()=>{
 const f=await fixture({transformSource:expose});try{
  if(kind==='legacy')for(const message of f.chat.message)delete message.chatId;
  if(kind==='duplicate')f.chat.message[2].chatId=f.chat.message[0].chatId;
  if(kind==='merged_legacy')f.chat.message.splice(1,0,{role:'user',data:'Additional user text without native identity.'});
  assert.equal((await f.run()).completed,1);
  const core=f.r.context.__reviewCore,ref=f.getManifest().memories['1'],bytes=f.r.values.get(ref.key),calls=f.control.calls.length;
  if(kind==='changed_native_id')f.chat.message[0].chatId='replacement-user';
  const context=await core.resolveContext(),pairs=core.buildPairs(f.chat);
  if(kind==='merged_legacy')assert.equal(pairs[0].user.identityStable,false,'merged segment cannot borrow the first message native proof');
  const proof=await f.r.context.__reviewPreservation(context,ref,pairs,null);
  assert.equal(proof,kind==='native'?'native_identity_verified':kind==='changed_native_id'?false:'legacy_identity_unknown');
  if(kind!=='changed_native_id'){
   f.chat.message[0].data+=' Text edit without a topology event.';
   const result=await core.reconcileCanonicalBranchBeforeRecall(await core.resolveContext(),{full:true,background:true,scheduleDeep:false});
   assert.equal(f.getManifest().memories['1'].key,ref.key);assert.equal(f.getManifest().memories['1'].status,'committed');
   assert.equal(result.preservedSourceOwnership[0].kind,proof);assert.equal(result.checkedBatches,0,'preservation does not fingerprint historical text');
  }
  assert.equal(f.r.values.get(ref.key),bytes);assert.equal(f.control.calls.length,calls);
 }finally{await f.r.cleanup()}
});
for(const mode of ['native','legacy','source_before_apply','source_during_model','scope','changed_native_id'])test('explicit historical source reversion '+mode,async()=>{
 const f=await fixture({transformSource:expose});try{
  if(mode==='legacy')for(const message of f.chat.message)delete message.chatId;
  assert.equal((await f.run()).completed,1);
  const first=f.getManifest().memories['1'],original=f.chat.message[0].data;
  f.chat.message[0].data+=' Explicit revision B.';
  const firstTicket=await currentSelection(f);assert.equal(firstTicket.allowed,true);
  assert.equal((await applySelection(f,firstTicket)).ok,true);
  const approved=f.getManifest().memories['1'],bytes=f.r.values.get(approved.key),calls=f.control.calls.length;
  f.chat.message[0].data=original;
  const core=f.r.context.__reviewCore;
  const audit=await core.reconcileCanonicalBranchBeforeRecall(await core.resolveContext(),{full:true,background:true,scheduleDeep:false});
  assert.equal(f.getManifest().memories['1'].key,approved.key);assert.deepEqual(Array.from(audit.reactivated),[]);
  const ticket=await currentSelection(f);assert.equal(ticket.allowed,true,'historical source text is a fresh manual replacement candidate');
  assert.equal(f.control.calls.length,calls,'preview has no model');
  if(mode==='source_before_apply')f.chat.message[0].data+=' New edit after preview.';
  if(mode==='scope')f.chat.id=f.chat.chatId='different-chat';
  if(mode==='changed_native_id')f.chat.message[0].chatId='different-user';
  if(mode==='source_during_model')f.control.onCall=async()=>{f.chat.message[0].data+=' Late edit during model.';return{type:'success',result:JSON.stringify(f.control.artifact)}};
  const result=await applySelection(f,ticket),success=['native','legacy','source_before_apply'].includes(mode);
  assert.equal(result.ok,success,JSON.stringify(result));assert.equal(f.r.values.get(approved.key),bytes);
  if(success){const after=f.getManifest().memories['1'];assert.ok(after.revision>approved.revision);assert.notEqual(after.key,first.key);if(mode!=='source_before_apply')assert.equal(after.sourceDigest,first.sourceDigest);assert.equal(f.control.calls.length,calls+1);assert.equal((await applySelection(f,ticket)).ok,true,'a new explicit click may intentionally reanalyze the same range again')}
  else {assert.equal(f.getManifest().memories['1'].key,approved.key);assert.equal(f.control.calls.length,calls+(mode==='source_during_model'?1:0))}
 }finally{await f.r.cleanup()}
});
