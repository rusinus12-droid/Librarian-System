'use strict';
// Explicit offline server composition. This consumes prior qualification; it
// never prepares DATA, installs guards, enrolls an owner or qualifies a host.
const path=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const Routes=require('./route-lifecycle.cjs'),J=require('./observation-json.cjs');
const C=require('./contracts.cjs'),Core=require('./control-store.cjs'),Owner=require('./owner-store.cjs');
const CAPABILITIES=Object.freeze(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1','integrity.v1','server-namespace-read.v1','server-batch-read.v1','keys-pagination.v1','server-batch-read-budget.v1','interactive-storage-soft-cap.v1','conditional-batch.v1','flashback-writer-fence.v1','data-instance-binding.v1','core3-semantic-route.v1','libra-routed-backend-observation.v1']);
const AUTHORITY_ROUTES=new Set(['route/read','route/status','route/transition','libra/observe','libra/observe-closure','libra/read','libra/current','libra/usage','libra/release'].map(x=>'/v1/authority/'+x));
const ROUTES=new Set(['GET /health','GET /bootstrap','GET /v1/kv/get','GET /v1/kv/keys','GET /v1/integrity','POST /v1/kv/get-many','POST /v1/kv/set','POST /v1/kv/remove','POST /v1/kv/batch','POST /v1/flashback/writer','POST /v1/admin/integrity','POST /v1/shutdown']);
function unavailable(code='AUTHORITY_LIFECYCLE_UNAVAILABLE'){throw Object.assign(new Error(code),{code,statusCode:503});}
function openCore3ServerRuntime({dataDir,authorityProfile}){
 if(authorityProfile!==C.CORE3_AUTHORITY_PROFILE)unavailable('AUTHORITY_PROFILE_UNSUPPORTED');
 const root=path.resolve(dataDir),control=Core.openAuthorityStore({dataDir:root,authorityProfile});
 const repositories=Object.create(null),owners=Object.create(null);let closed=false,attached=false,initial,resetBytes,observer=null,transportAttached=false;
 const resetEvidence=()=>{const bytes=Core.readBoundedEvidenceFile(path.join(root,'config','namespace-reset.json'),1048576,{optional:true});return bytes===null?null:bytes.toString('base64');};
 const lifecycleEvidence=()=>{
  if(Core.readBoundedEvidenceFile(path.join(root,'migrations','restore-transaction.json'),1048576,{optional:true})!==null)unavailable();
  if(resetEvidence()!==resetBytes)unavailable('AUTHORITY_QUARANTINED');
 };
 const assertCurrent=({inTransaction=false}={})=>{
  try{
   if(closed)unavailable('AUTHORITY_CLOSED');
   const witness=Core.assertAuthorityStore(control,{dataDir:root});
   if(C.witnessProfile(witness).id!==C.CORE3_AUTHORITY_PROFILE)unavailable('AUTHORITY_PROFILE_MISMATCH');
   const receipt=control.readInitialQualification();
   if(!receipt)unavailable('INITIAL_QUALIFICATION_REQUIRED');
   if(initial&&C.canonical(receipt)!==C.canonical(initial))unavailable('AUTHORITY_QUARANTINED');
   if(witness.status!=='ready'&&!(inTransaction&&witness.status==='pending'))unavailable(witness.status==='pending'?'AUTHORITY_BUSY':'AUTHORITY_QUARANTINED');
   lifecycleEvidence();control.readRoutes();return witness;
  }catch(error){if(!error.statusCode)error.statusCode=503;throw error;}
 };
 const close=()=>{if(closed)return;closed=true;observer?.close();for(const repository of Object.values(repositories))repository.close();for(const store of Object.values(owners))store.close();control.close?.();};
 try{
  resetBytes=resetEvidence();
  const witness=assertCurrent();initial=control.readInitialQualification();
  if(witness.pendingIntent)unavailable('AUTHORITY_BUSY');
 }catch(error){close();throw error;}
 const api={
  createRepositories(factory){
   if(attached||closed)unavailable('AUTHORITY_CLOSED');
   try{
    for(const namespace of C.CORE3_OWNERS)repositories[namespace]=factory(namespace,control,{
     authorityAdmission:assertCurrent,protectedRuntime:true,registerOwner:store=>{owners[namespace]=store;}
    });
    // Replay checks the retained receipt and all real owner locks. FIRST is
    // explicitly refused, and no initialization/qualifier entrypoint is called.
    control.withExclusiveGate(permit=>{
     const context=Core.assertInitialQualificationContext(permit);
     if(context.branch!=='REPLAY'||context.authorityProfile!==C.CORE3_AUTHORITY_PROFILE||C.canonical(context.receipt)!==C.canonical(initial))unavailable('INITIAL_QUALIFICATION_REQUIRED');
     const stores=C.CORE3_OWNERS.map(n=>owners[n]);
     for(let i=0;i<stores.length;i++)if(Owner.preflightInitialOwner(stores[i],permit).namespace!==C.CORE3_OWNERS[i])unavailable('AUTHORITY_QUARANTINED');
     const locks=[];
     try{for(const store of stores)locks.push(Owner.lockOwnerForInitialQualification(store,permit));control.commitInitialQualification(permit,locks);}
     finally{for(const lock of locks.reverse())lock.end();}
    });
    for(const namespace of ['lia','retrace'])repositories[namespace]=factory(namespace,null,{retiredAuthorityControl:control,protectedRuntime:true});
    assertCurrent();attached=true;return repositories;
   }catch(error){close();if(!error.statusCode)error.statusCode=503;throw error;}
  },
  createAuthenticatedHandler({authenticate}){
   if(transportAttached||typeof authenticate!=='function'||!attached)unavailable();transportAttached=true;
   const coordinator=require('./coordinator.cjs').createAuthorityCoordinator({control,resolveOwnerStore:n=>owners[n]});
   observer=require('./observation.cjs').createAuthorityObserver({dataDir:root,control});
   const handles=new Map();
   const failure=(code,statusCode=403)=>{throw Object.assign(new Error(code),{code,statusCode});};
   return (request,pathname,body)=>{
    const principal=authenticate(request);if(!principal||principal.kind==='admin'||!C.CORE3_OWNERS.includes(principal.namespace)||!principal.roles?.includes('owner'))failure('AUTHORITY_OWNER_REQUIRED');
    const current=assertCurrent(),dataId=current.physicalBinding.dataInstanceId;
    if(request.headers['x-memory-suite-data-instance']!==dataId)failure('AUTHORITY_DATA_BINDING_REQUIRED',409);
    // Re-authenticate the actual request; never accept a body principal, issuer,
    // DATA proof or caller-supplied handle object as authentication.
    const issuer=createHash('sha256').update(String(request.headers.authorization)).digest('hex');
    const namespace=principal.namespace,action=pathname.slice('/v1/authority/'.length);
    try {
     if(action==='route/read'){J.exact(body,['scopeId','scopeKey']);return control.readRouteSelection({namespace,...body});}
     if(action==='route/status'){J.exact(body,['operationId']);return control.readRouteOperation(namespace,body.operationId);}
     if(action==='route/transition'){const input=Routes.request(namespace,body);return coordinator.transitionRoute(input);}
     if(namespace!=='libra')failure('AUTHORITY_OWNER_REQUIRED');
     if(action==='libra/observe'||action==='libra/observe-closure'){
      for(const [key,h] of handles)if(h.deadline<=Date.now()){try{observer.release(h.args);}catch{}handles.delete(key);}
      if(handles.size>=64)failure('RESOURCE_LIMIT',503);
      const captured=action==='libra/observe'?observer.observeRoutedCanonicalFacts(body):observer.observeRoutedSourceClosure(body);
      const token=randomBytes(32).toString('base64url');
      handles.set(token,{issuer,dataId,requestId:body.requestId,args:{handle:captured.handle,requestId:body.requestId},deadline:Date.now()+body.durationMs});
      return {handle:token,summary:captured.summary};
     }
     J.exact(body,['handle','requestId']);const h=typeof body.handle==='string'?handles.get(body.handle):null;
     if(!h||h.issuer!==issuer||h.dataId!==dataId||h.requestId!==body.requestId)failure('INVALID_OBSERVATION_HANDLE');
     if(action==='libra/read')return observer.readCaptured(h.args);
     if(action==='libra/current')return observer.assertCurrent(h.args);
     if(action==='libra/usage')return observer.getUsage(h.args);
     if(action==='libra/release')return observer.release(h.args);
     unavailable();
    }catch(error){if(!error.statusCode)error.statusCode=['AUTHORITY_ROUTE_CHANGED','OPERATION_CONFLICT','SOURCE_CHANGED','AUTHORITY_ROUTE_UNAVAILABLE'].includes(error.code)?409:503;throw error;}
   };
  },
  assertCurrent,
  assertRoute(method,pathname){
   assertCurrent();
   if((method==='POST'&&AUTHORITY_ROUTES.has(pathname))||method==='OPTIONS'||ROUTES.has(method+' '+pathname)||(method==='GET'&&/^\/v1\/operations\/(libra|hayaku|flashback)\/[A-Za-z0-9._:-]+$/.test(pathname)))return;
   unavailable();
  },
  status(){return Object.freeze({contract:'memory-suite.core3-server-runtime.v1',authorityProfile:C.CORE3_AUTHORITY_PROFILE,qualificationScope:'isolated-core3-server-candidate.v1',initialQualificationId:initial.qualificationId,owners:C.CORE3_OWNERS,retiredInventory:'read-only-or-ephemeral',bindingModel:'qualified-writer-observed-path.v1',qualifiedProductionProfiles:Object.freeze([]),actualHostQualified:false,allWriterOwnership:false,serverActivation:false,handoffActivation:false,nativeRouteModeAuthority:false,serverSemanticRouteAuthority:true,backendObservationTransport:true,fullCorpusAuthority:false});},
  capabilities:CAPABILITIES,
  namespaceState:Object.freeze({epochs:()=>({...assertCurrent().resetEpochs}),active:()=>false,
   allows(namespace,header){let supplied={};try{supplied=JSON.parse(header||'{}');}catch{}const epochs=assertCurrent().resetEpochs;return Number(supplied?.[namespace]||0)===Number(epochs[namespace]||0);},
   plan:()=>unavailable(),execute:async()=>unavailable(),advanceEpochs:()=>unavailable()}),
  unavailable,
  close
 };
 return Object.freeze(api);
}
module.exports={openCore3ServerRuntime};
