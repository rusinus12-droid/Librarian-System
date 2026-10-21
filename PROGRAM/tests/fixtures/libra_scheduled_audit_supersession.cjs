'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const copy=value=>JSON.parse(JSON.stringify(value));
function register({test,prepared,deferred,within,until}){
 test('already queued audits retain physical validation and suppress only superseded unchanged timestamps',async()=>{
  const h=await prepared(),{f,core,context}=h,clock=vm.runInContext('Date',f.r.context),originalNow=clock.now;
  const originalMessages=copy(f.chat.message),store=f.r.context.risuai.pluginStorage,originalSet=store.setItem;
  const canonicalKey=f.getManifest().memories['1'].key,canonicalBytes=f.r.values.get(canonicalKey),calls=f.control.calls.length;
  const options={full:true,background:true,scheduleDeep:false};let tick=1800000000000;
  const setMessages=()=>{f.chat.message.splice(0,f.chat.message.length,...copy(originalMessages));};
  const full=extra=>core.reconcileCanonicalBranchBeforeRecall(context,{...options,...extra});
  const modes=['unchanged_same_clock','text_changed','native_identity_changed','rollback','append_tail','source_policy','host_fork','pending_replay','corrupt_body'];
  try{
   for(const mode of modes){
    setMessages();store.setItem=originalSet;f.r.values.set(canonicalKey,canonicalBytes);tick+=100;clock.now=()=>tick;
    await full();await until(()=>core.state.queues.size===0,'baseline full audit settles');
    let consumed=null;
    if(mode==='corrupt_body'){
     const delivered=await f.control.hooks.beforeRequest([{role:'user',content:'민아의 은빛 열쇠'}],'model');
     assert.ok(delivered.some(row=>row.role==='system'&&String(row.content||'').includes('[LIBRA CLASSIC RECALL')), 'actual Classic consumes canonical content before corruption');
     consumed=f.r.api.getLastResponseContext();
     assert(consumed.consumedDataToken);assert.equal((await f.r.api.validateResponseContext(consumed)).current,true);
    }
    const held=deferred(),entered=deferred();let before,afterFull,reads,failedWrites=0;
    const owner=f.r.context.__enqueueAuditTest(context.scope.scopeKey,async()=>{entered.resolve();await held.promise;});
    await entered.promise;
    if(mode==='pending_replay'){
     f.chat.message[0].chatId='supersession-pending-native';
     store.setItem=async function(key,value){if(!failedWrites&&String(key).endsWith(':continuity-state')&&JSON.parse(value)?.throughTurn===0){failedWrites++;throw Error('supersession_required_replay_failure');}return originalSet.call(this,key,value);};
    }
    const newer=full();
    const between=f.r.context.__enqueueAuditTest(context.scope.scopeKey,async()=>{
     afterFull=copy(f.getManifest());
     if(mode==='text_changed')f.chat.message[0].data+=' changed after newer full audit';
     if(mode==='native_identity_changed')f.chat.message[0].chatId='supersession-later-native';
     if(mode==='rollback')f.chat.message.splice(6);
     if(mode==='append_tail')f.chat.message.push({role:'user',chatId:'tail-u',data:'tail user'},{role:'assistant',chatId:'tail-a',data:'tail assistant'});
     if(mode==='source_policy')await f.r.api.setSourceEditRules({version:1,ignoredTags:['audit_policy_change'],unwrapTags:[],sourceTags:[],controls:[]});
     if(mode==='host_fork'){
      const manifestKey=[...f.r.values.keys()].find(key=>key.endsWith(':manifest'));
      const fork=JSON.parse(f.r.values.get(manifestKey));fork.worldlineMeta.parentWorldlineId='audit-parent-fork';fork.worldlineMeta.forkTurn=1;
      f.r.values.set(manifestKey,JSON.stringify(fork));
     }
     if(mode==='corrupt_body'){const damaged=JSON.parse(canonicalBytes);damaged.text+=' physical corruption';f.r.values.set(canonicalKey,JSON.stringify(damaged));}
     store.setItem=originalSet;reads=f.r.storageReads.length;before=f.r.storageWrites.length;tick++;
    });
    f.r.context.__auditTask=null;
    assert.equal(f.r.context.__scheduleAudit(context,[],0),true);
    await until(()=>f.r.context.__auditTask,'genuine timer delivered behind both owned operations');
    const task=f.r.context.__auditTask;
    assert.equal(core.state.branchAuditInFlight.size,1,'callback is already delivered and queued');
    held.resolve();await within(owner,'scope owner releases');const completed=await within(newer,'newer full audit completes');await between;
    assert.equal(await within(task,'queued audit completes'),true);
    await until(()=>core.state.queues.size===0,'all queued owners drained');
    const writes=f.r.storageWrites.slice(before).filter(row=>row.key.endsWith(':manifest'));
    const same=mode==='unchanged_same_clock'||mode==='corrupt_body';
    assert.equal(writes.length,same?0:1,mode+': only an unchanged successful supersession can suppress the timestamp write');
    assert.equal(f.getManifest().branchGuard.lastFullAuditAt,same?afterFull.branchGuard.lastFullAuditAt:tick,mode);
    assert.equal(f.r.api.getRuntime().lastBranchReconcile.reason,'background_deep_audit');
    if(mode!=='rollback'&&afterFull.memories['1'].status==='committed')assert(f.r.storageReads.slice(reads).includes(canonicalKey),mode+': actual physical canonical loader still ran');
    if(mode==='native_identity_changed'||mode==='rollback')assert.equal(f.getManifest().memories['1'].status,'inactive');
    if(mode==='pending_replay'){assert.equal(failedWrites,1);assert.equal(completed.continuityRebuildPending,true,'failed required replay cannot publish a successful receipt');}
    if(mode==='corrupt_body'){
     const result=await f.r.api.validateResponseContext(consumed);assert.equal(result.current,false);assert.match(result.reason,/UNIFIED_REPLAY_ARTIFACT_MISMATCH/,'actual retained unified replay guard still rejects corrupt physical bytes');
    }else assert.equal(f.r.values.get(canonicalKey),canonicalBytes,'audit never rewrites canonical bytes');
    assert.equal(core.state.branchAuditInFlight.size,0);assert.equal(f.r.context.__auditError,undefined);
   }
   setMessages();store.setItem=originalSet;f.r.values.set(canonicalKey,canonicalBytes);tick+=100;await full();
   // A periodic registration after the latest full completion has no newer
   // receipt, so it must retain the ordinary timestamp refresh.
   tick++;f.r.context.__auditTask=null;assert.equal(f.r.context.__scheduleAudit(context,[],0),true);
   await until(()=>f.r.context.__auditTask,'ordinary periodic audit admitted');assert.equal(await within(f.r.context.__auditTask,'periodic audit finishes'),true);
   assert.equal(f.getManifest().branchGuard.lastFullAuditAt,tick);
   tick++;await full({scheduledAudit:{receipt:null},supersededFullAudit:true,preserveAuditStamp:true});
   assert.equal(f.getManifest().branchGuard.lastFullAuditAt,tick,'public forged options cannot reach private scheduling argument');
   assert.equal(f.control.calls.length,calls,'audit controls never invoke a model');
   assert.equal(f.r.values.get(canonicalKey),canonicalBytes);
  }finally{clock.now=originalNow;store.setItem=originalSet;await f.r.cleanup();}
 });
}
module.exports={register};
