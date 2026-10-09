/* WM HANDOFF RECEIPT SDK v1.0.0
 * Separate materialized receipt contract. This never changes zero-copy owner contracts.
 * Wire identity is only a binding; authenticated host metadata establishes the sender.
 */
const WmHandoffReceipt = (() => {
  'use strict';
  const OWNER='wm',PLUGIN_ID='libra_world_manager',SCHEMA='wm.handoff-materialized.v1';
  const REQUEST_CHANNEL='wm_handoff_request_v1',RESPONSE_CHANNEL='wm_handoff_response_v1';
  const METHODS=Object.freeze(['capabilities','prepareHandoff','adoptHandoff','verifyHandoff','abortPreparedHandoff','rollbackHandoff']);
  const DOMAINS=Object.freeze(['canonical','cold','raw','raw_history','lineage','orphan']);
  const plain=(value,seen=new Set())=>{
    if(value===null||typeof value==='string'||typeof value==='boolean')return true;
    if(typeof value==='number')return Number.isFinite(value);
    if(!value||typeof value!=='object'||seen.has(value))return false;
    const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null&&!(Array.isArray(value)&&proto===Array.prototype))return false;
    seen.add(value);const ds=Object.getOwnPropertyDescriptors(value);
    const result=Reflect.ownKeys(value).every(k=>typeof k==='string'&&(Array.isArray(value)&&k==='length'||ds[k].enumerable&&Object.hasOwn(ds[k],'value')&&plain(ds[k].value,seen)));
    seen.delete(value);return result;
  };
  const exact=(v,keys)=>plain(v)&&v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
  const same=(a,b)=>plain(a)&&plain(b)&&stable(a)===stable(b);
  const token=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
  const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const identity=v=>exact(v,['scope','characterId','chatId','personaId','resetGeneration'])&&['characterId','chatId','personaId'].every(k=>typeof v[k]==='string'&&v[k].length>0)&&count(v.resetGeneration)&&v.scope===`char:${v.characterId}|chat:${v.chatId}|persona:${v.personaId}`;
  const head=v=>exact(v,['protocol','authorityId','storeId','scope','epoch','revision','schema','generationId','sha256','utf8Bytes','tombstone'])&&v.protocol==='wm.snapshot-authority.v1'&&v.schema==='wm.canonical-raw.v1'&&['authorityId','storeId','epoch','revision','generationId'].every(k=>token(v[k]))&&typeof v.scope==='string'&&v.scope.length>0&&digest(v.sha256)&&count(v.utf8Bytes)&&typeof v.tombstone==='boolean';
  const route=v=>exact(v,['schema','mode','routeGeneration','datasetId','backendId','state'])&&v.schema==='wm.storage-route.v1'&&['plugin_only','server_only'].includes(v.mode)&&['routeGeneration','datasetId','backendId'].every(k=>token(v[k]))&&['active','fenced','recovery_required'].includes(v.state);
  const domains=v=>exact(v,DOMAINS)&&DOMAINS.every(k=>exact(v[k],['count','bytes','digest','complete'])&&count(v[k].count)&&count(v[k].bytes)&&digest(v[k].digest)&&v[k].complete===true);
  function preparedMatches(v,e){return exact(v,['transferId','payloadDigest','sourceIdentity','targetIdentity','sourceHead','sourceRoute','inventorySnapshotId','domains'])&&token(v.transferId)&&digest(v.payloadDigest)&&token(v.inventorySnapshotId)&&identity(v.sourceIdentity)&&identity(v.targetIdentity)&&head(v.sourceHead)&&route(v.sourceRoute)&&domains(v.domains)&&v.sourceHead.scope===v.sourceIdentity.scope&&v.sourceIdentity.chatId!==v.targetIdentity.chatId&&v.sourceRoute.state==='active'&&v.transferId===e.transferId&&same(v.sourceIdentity,e.sourceIdentity)&&same(v.targetIdentity,e.targetIdentity)&&same(v.sourceHead,e.sourceHead)&&same(v.sourceRoute,e.sourceRoute);}
  function matches(v,e){
    if(!exact(v,['schema','transferId','sourceIdentity','targetIdentity','sourceHead','sourceRoute','targetRoute','sourceFingerprintBefore','sourceFingerprintAfter','sourcePreserved','sourceMutated','sourceCompacted','copyMode','physicalCopies','targetHead','payloadDigest','domains','readback','usable'])||!plain(e))return false;
    return v.schema==='wm.handoff-materialized-receipt.v1'&&token(v.transferId)&&identity(v.sourceIdentity)&&identity(v.targetIdentity)&&v.sourceIdentity.chatId!==v.targetIdentity.chatId&&head(v.sourceHead)&&head(v.targetHead)&&v.sourceHead.scope===v.sourceIdentity.scope&&v.targetHead.scope===v.targetIdentity.scope&&route(v.sourceRoute)&&route(v.targetRoute)&&v.sourceRoute.state==='active'&&same(v.sourceRoute,v.targetRoute)&&digest(v.sourceFingerprintBefore)&&v.sourceFingerprintBefore===v.sourceFingerprintAfter&&v.sourcePreserved===true&&v.sourceMutated===false&&v.sourceCompacted===false&&v.copyMode==='materialized'&&Number.isSafeInteger(v.physicalCopies)&&v.physicalCopies>=1&&digest(v.payloadDigest)&&domains(v.domains)&&exact(v.readback,['verified','generationId','allDomainsComplete'])&&v.readback.verified===true&&v.readback.allDomainsComplete===true&&v.readback.generationId===v.targetHead.generationId&&v.usable===true&&v.transferId===e.transferId&&v.payloadDigest===e.payloadDigest&&same(v.sourceIdentity,e.sourceIdentity)&&same(v.targetIdentity,e.targetIdentity)&&same(v.sourceHead,e.sourceHead)&&same(v.sourceRoute,e.sourceRoute)&&(!e.domains||same(v.domains,e.domains))&&(!e.targetHead||same(v.targetHead,e.targetHead));
  }
  function evaluate(peer){const p=peer?.capabilities||peer;const errors=[];
    if(!plain(p)||p.schema!==SCHEMA||p.owner!==OWNER||p.pluginId!==PLUGIN_ID)errors.push('wm_contract_identity_mismatch');
    if(p?.sourceImmutable!==true||p?.materialized!==true||p?.durableReadback!==true||p?.idempotent!==true)errors.push('wm_contract_guarantees_missing');
    if(!Array.isArray(p?.modes)||!p.modes.length||p.modes.some(m=>!['plugin_only','server_only'].includes(m)))errors.push('wm_qualified_materializer_unavailable');
    return {ok:errors.length===0,reason:errors.join(','),errors};
  }
  const binding=payload=>({sourceIdentity:payload?.sourceIdentity||null,targetIdentity:payload?.targetIdentity||null,transferId:payload?.transferId||null});
  function frame(v,kind){const keys=['schema','kind','owner','pluginId','requestId','action','sourceIdentity','targetIdentity','transferId',...(kind==='request'?['payload']:['ok','result','reason'])];return exact(v,keys)&&v.schema===SCHEMA&&v.kind===kind&&v.owner===OWNER&&v.pluginId===PLUGIN_ID&&token(v.requestId)&&METHODS.includes(v.action)&&(v.sourceIdentity===null||identity(v.sourceIdentity))&&(v.targetIdentity===null||identity(v.targetIdentity))&&(v.transferId===null||token(v.transferId))&&(kind==='request'?plain(v.payload):typeof v.ok==='boolean'&&typeof v.reason==='string'&&plain(v.result));}
  const makeRequest=(requestId,action,payload,b= binding(payload))=>({schema:SCHEMA,kind:'request',owner:OWNER,pluginId:PLUGIN_ID,requestId,action,...b,payload});
  const responseMatches=(v,pending)=>frame(v,'response')&&v.requestId===pending.requestId&&v.action===pending.action&&same(binding(v),pending.binding);
  return Object.freeze({OWNER,PLUGIN_ID,SCHEMA,REQUEST_CHANNEL,RESPONSE_CHANNEL,METHODS,DOMAINS,plain,exact,same,identity,head,route,domains,preparedMatches,matches,evaluate,binding,frame,makeRequest,responseMatches});
})();
/* END WM HANDOFF RECEIPT SDK */
if(typeof module!=='undefined'&&module.exports)module.exports=WmHandoffReceipt;

/* Authenticated plugin-channel adapter. No private backend/provider is exported. */
const WmHandoffIpc = (() => {
  'use strict';
  const W=WmHandoffReceipt,RETRACE_ID='flashback_hayaku_bridge';
  async function register({api,methods,readStorageStatus}) {
    if(typeof api?.addPluginChannelListener!=='function'||typeof api?.postPluginChannelMessage!=='function'||W.METHODS.some(k=>typeof methods?.[k]!=='function'))throw Error('wm_ipc_unavailable');
    let disposed=false;
    const handler=async(message,metadata={})=>{
      if(disposed||metadata.sender!==RETRACE_ID||!W.frame(message,'request'))return;
      const b=W.binding(message),p=message.payload;
      if(message.action==='prepareHandoff'&&(!W.same(b,W.binding(p))||p.kind!=='next_session'))return;
      if(['adoptHandoff','verifyHandoff'].includes(message.action)&&(!W.same(b.targetIdentity,p.targetIdentity)||b.transferId!==p.transferId||!W.identity(b.sourceIdentity)))return;
      if(['abortPreparedHandoff','rollbackHandoff'].includes(message.action)&&b.transferId!==p.transferId)return;
      if(message.action==='adoptHandoff'&&p.pendingToken!==null)return;
      let result=null,ok=false,reason='';
      try {
        if(message.action==='capabilities')result={capabilities:await methods.capabilities(),storageStatus:typeof readStorageStatus==='function'?await readStorageStatus(p):{ready:false,reason:'wm_storage_status_unavailable'}};
        else result=await methods[message.action](p);
        if(!W.plain(result))throw Error('wm_ipc_result_invalid');
        if(result?.schema==='wm.handoff-materialized-receipt.v1'&&(!W.same(result.sourceIdentity,b.sourceIdentity)||!W.same(result.targetIdentity,b.targetIdentity)||result.transferId!==b.transferId))throw Error('wm_ipc_result_binding_mismatch');
        ok=true;
      } catch(error) {result=null;reason=/^[a-z0-9_]{1,128}$/.test(error?.message||'')?error.message:'wm_handoff_request_failed';}
      if(disposed)return;
      await api.postPluginChannelMessage(RETRACE_ID,W.RESPONSE_CHANNEL,{schema:W.SCHEMA,kind:'response',owner:W.OWNER,pluginId:W.PLUGIN_ID,requestId:message.requestId,action:message.action,...b,ok,result,reason});
    };
    const registration=await api.addPluginChannelListener(W.REQUEST_CHANNEL,handler);
    return async()=>{disposed=true;if(typeof registration==='function')await registration();else if(typeof registration?.dispose==='function')await registration.dispose();else if(typeof api.removePluginChannelListener==='function')await api.removePluginChannelListener(W.REQUEST_CHANNEL,handler);};
  }
  return Object.freeze({register});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=WmHandoffIpc;
