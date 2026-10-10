'use strict';
// Narrow target-scope materialization over the existing WM store. No host chat,
// model, credential, source compaction, route cutover or generation deletion.
// Private integration callbacks never cross HTTP/IPC.
function createWmHandoffStore(x) {
  const {C,P,limits,transaction,meta,setMeta,sha,stable,fingerprint,fresh,head,route,epoch,store,stageState,stageItems,saveStage,verifyStage,migrationPayload,withWrite,installCopy,readCopy,putCompanion,inventoryDescriptor,verifyPendingProof}=x;
  const clone=v=>JSON.parse(JSON.stringify(v)),same=(a,b)=>stable(a)===stable(b),fail=r=>{throw Object.assign(Error(r),{code:'WM_'+r});};
  const identity=v=>v&&Object.keys(v).length===5&&['scope','characterId','chatId','personaId','resetGeneration'].every(k=>Object.hasOwn(v,k))&&['scope','characterId','chatId','personaId'].every(k=>typeof v[k]==='string'&&v[k])&&Number.isSafeInteger(v.resetGeneration)&&v.resetGeneration>=0&&v.scope===`char:${v.characterId}|chat:${v.chatId}|persona:${v.personaId}`;
  const common=['transferId','targetIdentity','operationId','requestFingerprint'];
  function input(method,value){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('handoff_input_invalid');const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(value);
    if(names.some(k=>typeof k!=='string'||!ds[k].enumerable||!Object.hasOwn(ds[k],'value')))fail('non_plain_data');
    const required=[...common,...{begin:['sourceIdentity','sourceHead','sourceRoute','targetRoute','sourceFingerprint','payloadDigest','snapshot','domains','expectedTargetHead','sourceItems','pendingReceipt'],chunk:['descriptor','offset','bytes','pendingReceipt'],stageStatus:['logicalId'],verify:[],materialize:['pendingReceipt'],readback:[],complete:['receipt','pendingReceipt'],status:[],abort:['pendingReceipt'],rollback:['expectedTargetHead','pendingReceipt']}[method]];
    x.keys(value,required);x.plain(Object.fromEntries(names.map(k=>[k,k==='bytes'?null:ds[k].value])));
    if(!identity(value.targetIdentity)||typeof value.transferId!=='string'||!/^[A-Za-z0-9:_-]{1,64}$/.test(value.transferId))fail('handoff_identity_invalid');
    if(method==='begin')x.request(value,required);
    if(method==='rollback'&&!C.validateHead(value.expectedTargetHead).ok)fail('handoff_rollback_invalid');
    return value;
  }
  const state=v=>{const s=stageState({operationId:v.operationId,requestFingerprint:v.requestFingerprint});if(s.kind!=='handoff'||s.transferId!==v.transferId||!same(s.targetIdentity,v.targetIdentity))fail('handoff_identity_conflict');return s;};
  function proof(v,s=v,phase='pending'){if(typeof verifyPendingProof!=='function'||verifyPendingProof(v.pendingReceipt,{transferId:s.transferId,sourceIdentity:s.sourceIdentity,targetIdentity:s.targetIdentity,sourceHead:s.sourceHead,sourceRoute:s.sourceRoute,payloadDigest:s.payloadDigest,phase})!==true)fail('handoff_pending_proof_unverified');}
  function sourceFingerprint(s){
    const current=head(s.sourceIdentity.scope);if(!same(current,s.sourceHead)||!same(route(),s.sourceRoute))fail('handoff_source_changed');
    for(const d of s.sourceItems){if(d.domain==='canonical'){if(d.originScope!==current.scope||d.sha256!==current.sha256||d.bytes!==current.utf8Bytes)fail('handoff_source_changed');}else if(!same(inventoryDescriptor(d.logicalId,limits.maxMigrationChunkBytes),d))fail('handoff_source_changed');}
    return fingerprint({sourceIdentity:s.sourceIdentity,sourceHead:s.sourceHead,sourceRoute:s.sourceRoute,items:s.sourceItems});
  }
  function domains(rows){return Object.fromEntries(C.DOMAINS.map(domain=>{const list=rows.filter(r=>r.descriptor.domain===domain).map(r=>r.descriptor).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));return [domain,{count:list.length,bytes:list.reduce((n,d)=>{if(n>Number.MAX_SAFE_INTEGER-d.bytes)fail('byte_total_overflow');return n+d.bytes;},0),digest:sha(Buffer.from('wm.handoff-domain.v1\n'+domain+'\n'+list.map(d=>stable(d)+'\n').join(''))),complete:true}];}));}
  function begin(v){
    proof(v);if(!identity(v.sourceIdentity)||!identity(v.targetIdentity)||v.sourceIdentity.scope===v.targetIdentity.scope||v.sourceIdentity.chatId===v.targetIdentity.chatId||v.expectedTargetHead!==null||v.sourceRoute.mode!=='server_only'||!same(v.sourceRoute,v.targetRoute)||!C.validateHead(v.sourceHead).ok||v.sourceHead.scope!==v.sourceIdentity.scope||!Array.isArray(v.sourceItems)||v.sourceItems.some(d=>!P.validateInventoryItem(d).ok))fail('handoff_begin_invalid');
    let s=transaction(()=>{
      const previous=meta('migration-stage:'+v.operationId);if(previous!==undefined){const old=state(v);if(!same({...v,pendingReceipt:null},{...old.beginInput,pendingReceipt:null}))fail('operation_identity_conflict');return old;}
      if(!same(route(),v.sourceRoute)||route().state!=='active'||!same(head(v.sourceIdentity.scope),v.sourceHead))fail('handoff_source_changed');
      if(head(v.targetIdentity.scope)||x.hasScopeHistory(v.targetIdentity.scope)||x.hasScopeInventory(v.targetIdentity.scope)||meta('handoff-target:'+sha(Buffer.from(v.targetIdentity.scope)))!==undefined)fail('handoff_target_not_fresh');
      if(v.sourceHead.authorityId!==x.authorityId||v.sourceHead.storeId!==x.storeId)fail('handoff_source_foreign');
      if(!C.validateDomainTotals(v.snapshot.domainCounts).ok||!C.validateDomainTotals(v.snapshot.domainBytes).ok||v.snapshot.complete!==true||v.snapshot.routeGeneration!==route().routeGeneration)fail('handoff_snapshot_invalid');
      let count=0,bytes=0;for(const d of C.DOMAINS){count+=v.snapshot.domainCounts[d];if(bytes>Number.MAX_SAFE_INTEGER-v.snapshot.domainBytes[d])fail('byte_total_overflow');bytes+=v.snapshot.domainBytes[d];}if(count>limits.maxMigrationItems||bytes>limits.maxMigrationBytes)fail('handoff_capacity');
      const next={...clone(v),kind:'handoff',beginInput:clone(v),copiedBytes:0,itemCount:0,state:'copying',targetFenceRoute:clone(route()),initialTargetHead:null,generationId:fresh('generation')};
      if(sourceFingerprint(next)!==v.sourceFingerprint)fail('handoff_source_fingerprint_mismatch');
      setMeta('handoff-target:'+sha(Buffer.from(v.targetIdentity.scope)),stable({operationId:v.operationId,transferId:v.transferId,targetIdentity:v.targetIdentity,state:'pending'}));saveStage(next);return next;
    });
    if(!s.initialTargetHead){const init={scope:s.targetIdentity.scope,operationId:s.operationId+':init',routeGeneration:s.sourceRoute.routeGeneration,writerEpoch:epoch(),expectedEmpty:true};init.requestFingerprint=fingerprint(init);
      const result=withWrite(s.operationId,()=>store.initializeScope(init));if(result.status!=='committed')return result;
      s=transaction(()=>{const next=state(v);next.initialTargetHead=clone(result.receipt.head);saveStage(next);return next;});}
    return {ok:true,initialTargetHead:clone(s.initialTargetHead),copiedBytes:s.copiedBytes};
  }
  function chunk(v){const s=transaction(()=>state(v));proof(v,s);if(s.state!=='copying')fail('handoff_stage_not_copying');return withWrite(s.operationId,()=>store.stageMigrationChunk({operationId:v.operationId,requestFingerprint:v.requestFingerprint,descriptor:v.descriptor,offset:v.offset,bytes:v.bytes}));}
  function stageStatus(v){return transaction(()=>{const s=state(v);return {...storelessStatus(s,v.logicalId),initialTargetHead:clone(s.initialTargetHead)};});}
  function storelessStatus(s,logicalId){const row=logicalId?stageItems(s).find(r=>r.descriptor.logicalId===logicalId):null;return {ok:true,state:s.state,copiedBytes:s.copiedBytes,offset:row?.offset||0,complete:!!row&&row.offset===row.descriptor.bytes};}
  function verify(v){return transaction(()=>{const s=state(v),verified=verifyStage(s);if(!same(domains(verified.rows),s.domains))fail('handoff_domain_mismatch');return {ok:true,domains:s.domains,payloadDigest:s.payloadDigest};});}
  function publicationStatus(s){if(!s.publication)return {status:'uncertain',operationId:s.transferId+':publish',requestFingerprint:'0'.repeat(64)};return store.status({operationId:s.publication.operationId,requestFingerprint:s.publication.requestFingerprint});}
  function materialize(v){let s=transaction(()=>state(v));proof(v,s);if(s.state==='aborted')fail('handoff_stage_aborted');if(s.publication){const existing=publicationStatus(s);if(existing.status==='committed'){transaction(()=>{const next=state(v);next.state='materialized';next.writtenHead=clone(existing.receipt.head);saveStage(next);});return existing;}if(existing.status==='conflict')return existing;}
    const verified=transaction(()=>{const next=state(v),items=verifyStage(next).rows;if(sourceFingerprint(next)!==next.sourceFingerprint)fail('handoff_source_changed');if(!same(head(next.targetIdentity.scope),next.initialTargetHead)||!same(domains(items),next.domains))fail('handoff_target_head_conflict');return items;});
    // Each unit gets separately owned chunk records. No source blob/reference is
    // substituted for these bytes, even when its hash already exists in this store.
    transaction(()=>{for(const row of verified){installCopy(row);if(row.descriptor.domain!=='canonical')putCompanion(row.descriptor);}setMeta('inventory_revision',fresh('inventory'));});
    const canonical=verified.filter(r=>r.descriptor.domain==='canonical');if(canonical.length!==1||canonical[0].descriptor.originScope!==s.targetIdentity.scope)fail('handoff_canonical_invalid');
    const d=canonical[0].descriptor,raw=d.disposition.tombstone?null:migrationPayload(canonical[0]).toString('utf8'),items=verified.filter(r=>r.descriptor.domain!=='canonical').map(r=>r.descriptor).sort((a,b)=>a.logicalId.localeCompare(b.logicalId));
    const manifest={schema:C.MANIFEST_SCHEMA,scope:s.targetIdentity.scope,generationId:s.generationId,canonical:{sha256:d.sha256,utf8Bytes:d.bytes},items,routeGeneration:s.sourceRoute.routeGeneration,writerEpoch:s.publication?.writerEpoch||epoch(),expectedHead:s.initialTargetHead,operationId:s.transferId+':publish'};manifest.manifestDigest=sha(Buffer.from(stable(manifest)));
    const input={operationId:manifest.operationId,operation:raw===null?'remove':'import',scope:manifest.scope,expectedHead:manifest.expectedHead,routeGeneration:manifest.routeGeneration,writerEpoch:manifest.writerEpoch,raw,manifest};input.requestFingerprint=fingerprint(input);
    s=transaction(()=>{const next=state(v);if(next.publication&&next.publication.requestFingerprint!==input.requestFingerprint)fail('operation_identity_conflict');next.publication={operationId:input.operationId,requestFingerprint:input.requestFingerprint,writerEpoch:input.writerEpoch};saveStage(next);return next;});
    const prepared=withWrite(s.operationId,()=>store.prepare(input));if(prepared.status)return prepared;
    const result=withWrite(s.operationId,()=>store.publish(prepared));transaction(()=>{const next=state(v);if(result.status==='committed'){next.state='materialized';next.writtenHead=clone(result.receipt.head);}saveStage(next);});return result;
  }
  function readback(v){return transaction(()=>{const s=state(v),verified=verifyStage(s);if(s.state!=='materialized'&&s.state!=='complete'||!s.writtenHead||!same(head(s.targetIdentity.scope),s.writtenHead))fail('handoff_readback_head_conflict');
      for(const row of verified.rows)readCopy(row.descriptor,0,0);const facts=domains(verified.rows);if(!same(facts,s.domains))fail('handoff_domain_mismatch');const after=sourceFingerprint(s);if(after!==s.sourceFingerprint)fail('handoff_source_changed');
      return {ok:true,verified:true,targetHead:clone(s.writtenHead),targetRoute:clone(route()),payloadDigest:s.payloadDigest,domains:facts,physicalCopies:verified.rows.length,sourceFingerprintAfter:after};});}
  function complete(v){const facts=readback(v);proof(v,transaction(()=>state(v)),'release');return transaction(()=>{const s=state(v);x.keys(v.receipt,C.DTO_KEYS.WmHandoffReceipt);if(v.receipt.schema!=='wm.handoff-materialized-receipt.v1'||v.receipt.transferId!==s.transferId||!same(v.receipt.sourceIdentity,s.sourceIdentity)||!same(v.receipt.targetIdentity,s.targetIdentity)||!same(v.receipt.sourceHead,s.sourceHead)||!same(v.receipt.sourceRoute,s.sourceRoute)||!same(v.receipt.targetRoute,facts.targetRoute)||v.receipt.sourceFingerprintBefore!==s.sourceFingerprint||v.receipt.sourceFingerprintAfter!==facts.sourceFingerprintAfter||v.receipt.sourcePreserved!==true||v.receipt.sourceMutated!==false||v.receipt.sourceCompacted!==false||v.receipt.copyMode!=='materialized'||v.receipt.physicalCopies!==facts.physicalCopies||v.receipt.readback?.verified!==true||!same(v.receipt.targetHead,facts.targetHead)||v.receipt.usable!==true||v.receipt.payloadDigest!==s.payloadDigest||!same(v.receipt.domains,facts.domains))fail('handoff_completion_invalid');s.state='complete';s.receipt=clone(v.receipt);saveStage(s);setMeta('handoff-target:'+sha(Buffer.from(s.targetIdentity.scope)),stable({operationId:s.operationId,transferId:s.transferId,targetIdentity:s.targetIdentity,state:'released'}));return {ok:true};});}
  function status(v){const s=transaction(()=>state(v));return publicationStatus(s);}
  function abort(v){return transaction(()=>{const s=state(v);proof(v,s);if(s.publication)fail('handoff_publication_status_required');s.state='aborted';saveStage(s);return {ok:true,reason:'staging_aborted_target_remains_pending'};});}
  function rollback(v){let s=transaction(()=>state(v));proof(v,s);const operationId=s.transferId+':rollback',fp=fingerprint({operationId,transferId:s.transferId,expectedTargetHead:v.expectedTargetHead});
    if(s.rollback){if(s.rollback.intentFingerprint!==fp)fail('operation_identity_conflict');return store.status(s.rollback.input);}
    if(!s.writtenHead||!same(v.expectedTargetHead,s.writtenHead)||!same(head(s.targetIdentity.scope),s.writtenHead))return {status:'conflict',operationId,requestFingerprint:fp,receipt:{reason:'recovery_required',targetPreserved:true}};
    const manifest={schema:C.MANIFEST_SCHEMA,scope:s.targetIdentity.scope,generationId:transaction(()=>fresh('generation')),canonical:{sha256:sha(Buffer.alloc(0)),utf8Bytes:0},items:[],routeGeneration:route().routeGeneration,writerEpoch:epoch(),expectedHead:s.writtenHead,operationId};manifest.manifestDigest=sha(Buffer.from(stable(manifest)));
    const input={operationId,operation:'remove',scope:manifest.scope,expectedHead:s.writtenHead,routeGeneration:manifest.routeGeneration,writerEpoch:manifest.writerEpoch,raw:null,manifest};input.requestFingerprint=fingerprint(input);
    transaction(()=>{s=state(v);s.rollback={intentFingerprint:fp,input:{operationId,requestFingerprint:input.requestFingerprint}};saveStage(s);setMeta('handoff-target:'+sha(Buffer.from(s.targetIdentity.scope)),stable({operationId:s.operationId,transferId:s.transferId,targetIdentity:s.targetIdentity,state:'pending'}));});
    const prepared=withWrite(s.operationId,()=>store.prepare(input));if(prepared.status)return prepared;return withWrite(s.operationId,()=>store.publish(prepared));
  }
  return Object.fromEntries(Object.entries({begin,chunk,stageStatus,verify,materialize,readback,complete,status,abort,rollback}).map(([method,fn])=>[method,value=>fn(input(method,value))]));
}
module.exports={createWmHandoffStore};
