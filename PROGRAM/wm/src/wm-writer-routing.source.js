/* B3 functional writer integration. Injected router only; no transport or host activation. */
const WmWriterRouting = (() => {
  'use strict';
  const C=typeof WmStorageContracts!=='undefined'?WmStorageContracts:require('./wm-storage-contracts.source.js');
  const utf8=v=>new TextEncoder().encode(v),clone=v=>JSON.parse(JSON.stringify(v)),fail=reason=>({ok:false,reason});
  async function createWmWriterRuntime({router,historyProfile=null}={}) {
    if(historyProfile!==null&&historyProfile!=='server-pinned-roots-v2')throw Error('history_profile_invalid');
    if(!router)return Object.freeze({enabled:false,serverMode:false});
    const probe=await router.openRequest();if(!probe)throw Error('wm_route_unavailable');
    if(historyProfile){const supported=await router.enableHistoryProfile({handle:probe,profile:historyProfile});if(!supported?.ok){await router.closeRequest(probe);throw Error(supported?.reason||'history_profile_unsupported');}}
    const selected=await router.readRoute({handle:probe}),closed=await router.closeRequest(probe);if(!selected?.ok||!closed?.ok)throw Error('wm_route_unavailable');
    const serverMode=selected.route.mode==='server_only',sources=new WeakMap(),sessions=new Map(),owners=new Set(),cleanup=new Set(),finals=new Set(),requestReads=new Map(),latest=new Map(),pending=new Map(),rawRecords=new Map(),attempts=new Map();
    async function openRequest(){const handle=await router.openRequest();if(handle)owners.add(handle);return handle;}
    async function closeRequest(handle,retainForFinal=false){if(!retainForFinal)requestReads.delete(handle);owners.delete(handle);for(const [scope,owner]of sessions)if(owner===handle)sessions.delete(scope);const result=await router.closeRequest(handle);if(result.ok)cleanup.delete(handle);else cleanup.add(handle);return result;}
    async function read(scope,owner=null){
      if(owner&&finals.has(owner)){const cached=requestReads.get(owner)?.get(scope);if(!cached)return fail('authority_final_scope_changed');const fresh=await currentSource(scope,cached.head);return fresh.ok?cached:fresh;}
      if(!owner){owner=sessions.get(scope);if(!owner){owner=await openRequest();sessions.set(scope,owner);}}
      if(!owner)return fail('wm_route_unavailable');const result=await router.readCanonical({handle:owner,scope});if(!result?.ok)return result;
      const sourceToken=Object.freeze({});sources.set(sourceToken,{handle:owner,scope,head:result.head,routerSource:result.sourceToken,raw:result.raw});latest.set(scope,sourceToken);const observed={...result,sourceToken};let reads=requestReads.get(owner);if(!reads){reads=new Map();requestReads.set(owner,reads);}reads.set(scope,observed);return observed;
    }
    function validateSource(scope,token){const source=sources.get(token);return source&&source.scope===scope&&owners.has(source.handle)?{ok:true,head:source.head}:fail('authority_write_token_required');}
    const sameHead=(a,b)=>a&&b&&C.HEAD_KEYS.every(k=>a[k]===b[k]);
    const matches=(a,b)=>{const x=sources.get(a),y=sources.get(b);return !!x&&!!y&&x.scope===y.scope&&sameHead(x.head,y.head);};
    async function requireFresh(scope,token){const valid=validateSource(scope,token);if(!valid.ok)return valid;return router.current(sources.get(token).handle);}
    async function inventoryWrite(handle,items,operationId){
      const state=await router.readInventoryState({handle});if(!state.ok)return state;
      const record={operationId,routeGeneration:state.routeGeneration,writerEpoch:state.writerEpoch,expectedInventoryRevision:state.inventoryRevision,items};
      const encoded=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return globalThis.btoa?globalThis.btoa(text):Buffer.from(bytes).toString('base64');};
      record.requestFingerprint=await C.fingerprintRequest({...record,items:items.map(i=>({descriptor:i.descriptor,payload:{encoding:'base64',data:encoded(i.payload)}}))});
      return router.appendRaw({handle,record});
    }
    async function descriptor(domain,schema,scope,raw,dependencies=[],logicalId=null,disposition=null){const bytes=utf8(raw),sha256=await C.hashBytes(bytes);return {item:{domain,schema,logicalId:logicalId||domain+'-'+sha256,originScope:scope,bytes:bytes.length,sha256,dependencies,disposition},bytes};}
    async function stageForScope(scope,rows,expectedSource){
      const token=expectedSource||latest.get(scope),fresh=await requireFresh(scope,token);if(!fresh.ok)return fresh;
      const source=sources.get(token),owned=rows.map(row=>({descriptor:clone(row.item),payload:new Uint8Array(row.bytes)}));
      const intent=await C.fingerprintRequest({scope,head:source.head,items:owned.map(i=>i.descriptor)});
      let attempt=attempts.get(intent);if(!attempt){attempt={operationId:'wm-dependency-'+globalThis.crypto.randomUUID(),input:null};attempts.set(intent,attempt);}
      // Unknown outcomes retain the original request fingerprint and inventory revision.
      let result;
      if(attempt.input)result=await router.appendRaw({handle:source.handle,record:attempt.input});
      else {const state=await router.readInventoryState({handle:source.handle});if(!state.ok)return state;const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return globalThis.btoa?globalThis.btoa(text):Buffer.from(bytes).toString('base64');};
        attempt.input={operationId:attempt.operationId,routeGeneration:state.routeGeneration,writerEpoch:state.writerEpoch,expectedInventoryRevision:state.inventoryRevision,items:owned};attempt.input.requestFingerprint=await C.fingerprintRequest({...attempt.input,items:owned.map(i=>({descriptor:i.descriptor,payload:{encoding:'base64',data:encode(i.payload)}}))});result=await router.appendRaw({handle:source.handle,record:attempt.input});}
      if(result?.status!=='committed')return {...fail(result?.reason||result?.status||'dependency_unconfirmed'),uncertain:result?.status==='uncertain',operationId:attempt.operationId,requestFingerprint:attempt.input.requestFingerprint};
      let staged=pending.get(scope);if(!staged||!sameHead(staged.head,source.head)){staged={head:source.head,rows:new Map()};pending.set(scope,staged);}for(const row of rows)staged.rows.set(row.item.logicalId,row);
      return {ok:true,verified:true,items:rows.map(x=>clone(x.item)),operationId:attempt.operationId};
    }
    function safeCanonical(raw){
      if(raw===null)return true;let envelope;try{envelope=JSON.parse(raw);}catch{return false;}
      if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||!Array.isArray(envelope.entries))return false;
      const forbidden=['apiKey','authHeaders','connectionToken','sourceCapture','privateModelJobCapture','modelJobCapture','pendingJobs','pendingApproval','requestLease','analysisLease','analysisAdmission','analysisReservation','wal'];
      const metadataSafe=value=>!value||typeof value!=='object'||!Object.keys(value).some(key=>forbidden.includes(key))&&Object.values(value).every(item=>metadataSafe(item));
      if(!metadataSafe({...envelope,entries:undefined}))return false;
      for(const entry of envelope.entries){if(!metadataSafe({...entry,content:undefined}))return false;if(['wm.private-config.v1','wm.execution-capture.v1','wm.execution-state.v1'].includes(entry.schema))return false;}
      return true;
    }
    async function commit(scope,token,raw,operation='normal'){
      if(!safeCanonical(raw))return fail('canonical_runtime_payload_unsupported');
      const valid=validateSource(scope,token);if(!valid.ok)return valid;const source=sources.get(token);
      let intent=await C.fingerprintRequest({scope,head:source.head,rawSha256:await C.hashBytes(utf8(raw??'')),operation});
      let roots=historyProfile==='server-pinned-roots-v2'?[]:null;
      if(raw!==null){const row=JSON.parse(raw).entries.find(row=>row?.comment==='lmai_extension_history');if(row){let root;try{root=JSON.parse(row.content);}catch{return fail('history_manifest_invalid');}if(historyProfile!=='server-pinned-roots-v2'||root.profile!==historyProfile||root.scope!==scope)return fail('history_server_dependency_roots_unsupported');roots=[...new Set(['head','records','pending','legacyRoot'].map(k=>root[k]).filter(Boolean))];}}
      if(roots===null&&historyProfile==='server-pinned-roots-v2'&&source.raw!==null){try{if(JSON.parse(source.raw).entries.some(row=>row?.comment==='lmai_extension_history'))roots=[];}catch{return fail('canonical_runtime_payload_unsupported');}}
      let companionRoots=[];
      if(roots!==null){const staged=sameHead(pending.get(scope)?.head,source.head)?[...pending.get(scope).rows.values()].map(row=>row.item).sort((a,b)=>a.logicalId.localeCompare(b.logicalId)):[];if(staged.length>32)return fail('root_manifest_limit');companionRoots=staged.map(d=>d.logicalId);intent=await C.fingerprintRequest({scope,head:source.head,rawSha256:await C.hashBytes(utf8(raw??'')),operation,companionRoots:staged});}
      let context=attempts.get('canonical:'+intent);if(!context){
        if(roots!==null){const recovery=await router.reconcileHistoryWrite({handle:source.handle,scope,raw,operation,operationId:'wm-roots-'+intent,expectedHead:source.head,dependencyRoots:operation==='remove'?[]:[...new Set([...roots,...companionRoots])].sort(),hasNewCompanions:companionRoots.length>0});if(recovery?.ok===false)return recovery;if(recovery?.found){const out=recovery.result;if(out.status==='committed'){pending.delete(scope);await closeRequest(source.handle);return {ok:true,head:out.receipt.head,operationId:out.operationId,verified:true,reconciled:true};}return {ok:false,reason:out.status||'history_recovery_unconfirmed',uncertain:out.status==='uncertain',operationId:out.operationId,requestFingerprint:out.requestFingerprint};}}
        const fresh=await requireFresh(scope,token);if(!fresh.ok)return fresh;
        context=await router.beginWrite({handle:source.handle,scope,operation,expectedSource:source.routerSource,...roots?{dependencyRoots:roots,operationId:'wm-roots-'+intent}:{}});if(context?.ok===false)return context;attempts.set('canonical:'+intent,context);
        for(const row of (sameHead(pending.get(scope)?.head,source.head)?pending.get(scope).rows.values():[])){const staged=await router.stageDependency({writeContext:context,item:row.item,bytes:row.bytes});if(!staged.ok){await router.abortWrite(context);attempts.delete('canonical:'+intent);return staged;}}
      }
      const result=await router.commitWrite({writeContext:context,raw});
      if(result?.status==='committed'||result?.ok===true){pending.delete(scope);attempts.delete('canonical:'+intent);await closeRequest(source.handle);return {ok:true,head:result.receipt?.head||null,operationId:result.operationId,verified:true};}
      return {ok:false,reason:result?.reason||result?.status||'commit_unconfirmed',uncertain:result?.status==='uncertain'||result?.uncertain===true,operationId:result?.operationId,requestFingerprint:result?.requestFingerprint};
    }
    async function openHistoryOwner(scope,expectedSource=null){
      if(historyProfile!=='server-pinned-roots-v2')throw Error('history_server_dependency_roots_unsupported');
      let token=expectedSource||latest.get(scope);if(!validateSource(scope,token).ok){if(expectedSource)throw Error('source_token_required');const fresh=await read(scope);if(!fresh.ok)throw Error(fresh.reason);token=fresh.sourceToken;}
      const source=sources.get(token),owner=await router.openHistoryOwner({handle:source.handle,scope,sourceToken:source.routerSource});if(owner?.ok===false)throw Error(owner.reason);return owner;
    }
    async function readText(scope,logicalId){const source=latest.get(scope)|| (await read(scope)).sourceToken,bound=sources.get(source);if(!bound)return fail('source_token_required');let offset=0,parts=[];do{const chunk=await router.readCompanion({handle:bound.handle,lease:bound.routerSource,logicalId,offset,maxBytes:262144});if(!chunk?.bytes)return fail(chunk?.reason||'companion_unavailable');parts.push(chunk.bytes);offset=chunk.nextOffset;}while(offset!==null);const size=parts.reduce((n,x)=>n+x.length,0),bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return {ok:true,raw:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};}
    async function appendObserved(record){
      const scope=record.canonicalScope||record.scopeKey;let token=latest.get(scope);if(!validateSource(scope,token).ok){const fresh=await read(scope);if(!fresh.ok)return fresh;token=fresh.sourceToken;}
      // Only immutable identity/text and historical facts enter memory payload.
      const fields=['version','kind','recordId','recordKey','requestId','scopeKey','runtimeScopeKey','canonicalScope','characterId','characterIndex','chatId','chatIndex','requestSequence','requestType','resetGeneration','userText','assistantText','responseHash','rawHash','userBytes','assistantBytes','captureSource','observedAt'];
      const safe=Object.fromEntries(fields.filter(k=>Object.hasOwn(record,k)).map(k=>[k,record[k]]));
      const logicalId='raw-'+await C.hashBytes(utf8(JSON.stringify(safe)));const row=await descriptor('raw','wm.raw-turn.v1',scope,JSON.stringify(safe),[],logicalId,{analysisEligible:false,replacementEligible:false});
      const result=await stageForScope(scope,[row],token);if(!result.ok)return result;
      const live={...record,wmLogicalId:logicalId,wmCanonicalScope:scope};rawRecords.set(record.recordKey,live);return {ok:true,verified:true,recordId:record.recordId,recordKey:record.recordKey,scopeKey:scope,record:live};
    }
    const readRecord=handle=>{const record=rawRecords.get(handle?.recordKey);return record&&record.scopeKey===handle.scopeKey&&(!handle.recordId||record.recordId===handle.recordId)?{ok:true,record}:fail('server_raw_live_receipt_unavailable');};
    async function markStatus(handle,patch,options={}){
      const found=readRecord(handle);if(!found.ok)return found;const current=found.record;
      const immutable=['version','kind','recordId','recordKey','requestId','scopeKey','runtimeScopeKey','canonicalScope','characterId','characterIndex','chatId','chatIndex','requestSequence','requestType','resetGeneration','userText','assistantText','responseHash','rawHash','userBytes','assistantBytes','captureSource','observedAt','wmLogicalId','wmCanonicalScope'];
      if(immutable.some(k=>Object.hasOwn(patch,k)&&patch[k]!==current[k]))return fail('immutable_raw_receipt');
      if(options.expectedPendingParkToken!==undefined&&String(current.pendingParkToken||'')!==String(options.expectedPendingParkToken))return fail('pending_park_token_changed');
      if(options.requireUncommitted===true&&(current.status!=='observed'||['done','committed','terminal','discarded'].includes(current.analysisStatus)))return fail('pending_park_receipt_changed');
      if(current.analysisStatus==='terminal'||['done','committed'].includes(current.analysisStatus)&&patch.analysisStatus&&!['done','committed','skipped','terminal','discarded'].includes(patch.analysisStatus))return {ok:true,verified:true,unchanged:true,record:current};
      if(options.claimAnalysisAttempt===true){if(Number(current.resetGeneration)!==Number(options.resetGeneration))return fail('analysis_receipt_generation_changed');const attempt=Number(patch.analysisRecoveryAttempt||0);if(attempt>Number(options.maxRecoveryAttempts||0)||(Number(current.analysisStartedAt||current.analysisFinishedAt||0)>0&&attempt<=Number(current.analysisRecoveryAttempt||0)))return {ok:true,verified:true,unchanged:true,record:current};}
      let source=latest.get(current.wmCanonicalScope);if(!validateSource(current.wmCanonicalScope,source).ok){const fresh=await read(current.wmCanonicalScope);if(!fresh.ok)return fresh;source=fresh.sourceToken;}

      if(options.isCurrent&&options.isCurrent()!==true)return fail('raw_lifecycle_owner_changed');
      if(options.expectedResetGeneration!==undefined&&options.expectedResetGeneration!==current.resetGeneration)return fail('analysis_receipt_generation_changed');
      if(options.analysisAdmissionGuard&&options.analysisAdmissionGuard(current)!==true)return fail('analysis_admission_guard_rejected');
      const allowed=['status','analysisStatus','analysisFinishedAt','analysisCommittedAt','analysisTurn','lastFinalizedTurn','finalizedTurn'];
      const facts=Object.fromEntries(allowed.filter(k=>Object.hasOwn(patch,k)).map(k=>[k,patch[k]]));
      if(Object.entries(facts).some(([key,value])=>['status','analysisStatus'].includes(key)?!['observed','pending','queued','running','deferred','replaying','awaiting_host_anchor','done','committed','skipped','terminal','discarded','interrupted'].includes(value):!Number.isSafeInteger(value)||value<0))return fail('raw_history_invalid');
      const history={schema:'wm.raw-history.v1',originScope:current.wmCanonicalScope,rawId:current.wmLogicalId,status:['done','committed','skipped','terminal','discarded'].includes(patch.analysisStatus||patch.status)?String(patch.analysisStatus||patch.status):'interrupted',observedAt:Date.now(),observations:facts};
      const row=await descriptor('raw_history','wm.raw-history.v1',current.wmCanonicalScope,JSON.stringify(history),[current.wmLogicalId],null,{analysisEligible:false,replacementEligible:false});
      const result=await stageForScope(current.wmCanonicalScope,[row],source);if(!result.ok)return result;const next={...current,...patch};rawRecords.set(handle.recordKey,next);return {ok:true,verified:true,record:next};
    }
    async function putWorldline(scope,state,options={}){const token=options.expectedSource||latest.get(scope),fresh=await requireFresh(scope,token);if(!fresh.ok)return fresh;const row=await descriptor('lineage','libra_turn_worldline_v1',scope,JSON.stringify(state));const staged=await stageForScope(scope,[row],token);if(!staged.ok)return staged;return commit(scope,token,sources.get(token).raw,'verified');}
    async function findCompanion(scope,schema,id=null){
      let token=latest.get(scope);if(!validateSource(scope,token).ok){const fresh=await read(scope);if(!fresh.ok)return fresh;token=fresh.sourceToken;}
      const source=sources.get(token);
      if(historyProfile==='server-pinned-roots-v2'){let cursor=null,best=null;do{const page=await router.findCompanions({handle:source.handle,scope,sourceToken:source.routerSource,schema,cursor});if(!page.ok)return page;for(const item of page.items){const text=await readText(scope,item.logicalId);if(!text.ok)return text;let value;try{value=JSON.parse(text.raw);}catch{return fail('companion_invalid');}if(id&&value.id!==id)continue;const rank=Number(value.updatedAt||value.revision||value.createdAt||0);if(!best||rank>best.rank)best={raw:text.raw,rank};}cursor=page.nextCursor;}while(cursor!==null);return {ok:true,raw:best?.raw||null};}
      const found=await router.readBundleItems({handle:source.handle,scope,sourceToken:source.routerSource});if(!found.ok)return found;
      let best=null;for(const item of found.items.filter(i=>i.schema===schema)){const text=await readText(scope,item.logicalId);if(!text.ok)return text;let value;try{value=JSON.parse(text.raw);}catch{return fail('companion_invalid');}if(id&&value.id!==id)continue;if(!best||Number(value.updatedAt||value.revision||value.createdAt||0)>best.rank)best={raw:text.raw,rank:Number(value.updatedAt||value.revision||value.createdAt||0)};}
      return {ok:true,raw:best?.raw||null};
    }
    async function currentSource(scope,head){const handle=await openRequest();try{const result=await router.readCanonical({handle,scope});return result.ok&&sameHead(result.head,head)?{ok:true}:fail('authority_source_changed');}finally{await closeRequest(handle);}}
    async function dispose(){for(const handle of new Set([...owners,...cleanup]))await closeRequest(handle);pending.clear();rawRecords.clear();finals.clear();requestReads.clear();}
    return Object.freeze({enabled:serverMode,serverMode,historyProfile,openHistoryOwner,router,openRequest,closeRequest,read,validateSource,matches,sameHead,requireFresh,commit,readText,findCompanion,descriptor,stageForScope,appendObserved,readRecord,markStatus,putWorldline,latestSource:scope=>latest.get(scope)||null,
      initializeScope:async({scope,operationId,expectedEmpty})=>{const handle=await openRequest();try{return await router.initializeScope({handle,scope,operationId,expectedEmpty});}finally{await closeRequest(handle);}},
      finalObservation:async handle=>{const result=await router.current(handle);const closed=await closeRequest(handle,true);if(result.ok&&closed.ok)finals.add(handle);else requestReads.delete(handle);return result.ok?closed:result;},finishRequest:handle=>{finals.delete(handle);requestReads.delete(handle);},currentSource,dispose,diagnostics:()=>({requestOwners:owners.size,requestOwnedBytes:0,retainedBytes:0}),isCleaned:handle=>!owners.has(handle)&&!cleanup.has(handle),
      qualifications:Object.freeze({all_writer_ownership:false,serverActivation:false,nativeAtomic:false})});
  }
  return Object.freeze({createWmWriterRuntime});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WmWriterRouting;
