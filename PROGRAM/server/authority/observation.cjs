'use strict';
// Private backend verifier. Routed transport keeps these branded handles private.
const {randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks');
const C=require('./contracts.cjs'),Core=require('./control-store.cjs'),IO=require('./observation-io.cjs'),J=require('./observation-json.cjs'),P=require('./libra-source-proof.cjs'),S=require('./libra-source-closure.cjs');
const HANDLES=new WeakMap(),MiB=J.MiB;
function ownedBytes(value,seen=new Set()){if(typeof value==='string')return Math.max(Buffer.byteLength(value),2*value.length);if(!value||typeof value!=='object')return 16;if(seen.has(value))return 0;seen.add(value);let bytes=256;for(const [key,v] of Object.entries(value))bytes+=2*key.length+ownedBytes(v,seen);return bytes;}
function request(input){J.exact(input,['namespace','requestId','scopeKey','starts','durationMs']);if(input.namespace!=='libra')C.fail('SOURCE_PROOF_UNAVAILABLE');C.identifier(input.requestId);P.scopeKeys(input.scopeKey);
 if(!Number.isSafeInteger(input.durationMs)||input.durationMs<1||input.durationMs>120000)C.fail('SOURCE_PROFILE_UNAVAILABLE');
 const a=input.starts;if(!Array.isArray(a)||a.length<1||a.length>IO.LIMITS.keys||Object.keys(a).length!==a.length||Object.getOwnPropertySymbols(a).length)C.fail('SOURCE_PROOF_UNAVAILABLE');
 const descriptors=Object.getOwnPropertyDescriptors(a);for(let i=0;i<a.length;i++)if(!descriptors[i]||!Object.hasOwn(descriptors[i],'value')||!Number.isSafeInteger(descriptors[i].value)||descriptors[i].value<1)C.fail('SOURCE_PROOF_UNAVAILABLE');
 const starts=Array.from(a);if(new Set(starts).size!==starts.length)C.fail('SOURCE_PROOF_UNAVAILABLE');return {namespace:'libra',requestId:input.requestId,scopeKey:input.scopeKey,starts,durationMs:input.durationMs};
}
function stableWitness(w){const {controlSequence,...rest}=w;return C.canonical(rest);}
function createAuthorityObserver(input){J.exact(input,['dataDir','control']);const reader=Core.openBackendObservationControlReader(input),issuerId=randomUUID(),issuerBrand=Object.freeze({}),active=new Set(),ledger={active:0,retained:0,peak:0};let closed=false,running=false;
 function retire(s,status){if(s.status!=='live')return;s.status=status;active.delete(s);ledger.retained-=s.retained;s.retained=0;s.view=null;s.facts=null;s.witness=null;s.scopeKey=null;}
 function state(args,{released=false}={}){J.exact(args,['handle','requestId']);const s=HANDLES.get(args.handle);if(!s||s.issuer!==issuerBrand||s.requestId!==args.requestId)C.fail('INVALID_OBSERVATION_HANDLE');
  if(!released){if(closed)C.fail('AUTHORITY_CLOSED');if(s.status!=='live')C.fail(s.status);if(performance.now()>=s.deadline){retire(s,'OBSERVATION_EXPIRED');C.fail('OBSERVATION_EXPIRED');}Core.assertBackendObservationControlReader(reader);}return s;
 }
 function interval({deadline,checkDeadline,counters,work,routeRequest=null}){
  for(let attempt=0;attempt<IO.LIMITS.attempts;attempt++){
   const budget=IO.createBudget({ledger,deadline,checkDeadline,counters});let session=null,keep=false;
   try{budget.check();counters.attempts++;budget.reserve(16*MiB);const w0=reader.readFresh(budget,routeRequest);session=IO.openOwnerSession(reader,budget);const proof=IO.assertOwnerSession(session).proof;
    if(proof.guardFingerprint!==w0.ownerGuardFingerprint||C.canonical(proof.ownerBinding)!==C.canonical(w0.ownerBinding))C.fail('AUTHORITY_QUARANTINED');
    const result=work(session,budget,w0);session.close();session=null;
    // The parser/session no longer owns source buffers or decoded record trees.
    // Retain only the resulting immutable-fact graph plus canonicalization room.
    budget.trim(ownedBytes(result)+2*MiB);const w1=reader.readFresh(budget,routeRequest);
    if(C.canonical(w0)!==C.canonical(w1))C.fail('AUTHORITY_BUSY');budget.check();keep=true;return {result,witness:w1,budget};
   }catch(error){if(error.code==='AUTHORITY_BUSY'||(!error.code&&/database is (?:locked|busy)/i.test(error.message))){if(attempt+1===IO.LIMITS.attempts)C.fail('AUTHORITY_BUSY');}else throw error;}
   finally{try{if(session)session.close();}finally{if(!keep)budget.finish();}}
  }C.fail('AUTHORITY_BUSY');
 }
 function capture(input,sourceClosure=false,routeRequest=null){if(closed)C.fail('AUTHORITY_CLOSED');if(running)C.fail('AUTHORITY_BUSY');for(const s of active)if(performance.now()>=s.deadline)retire(s,'OBSERVATION_EXPIRED');if(active.size>=IO.LIMITS.handles)C.fail('RESOURCE_LIMIT');const r=sourceClosure?S.request(input):request(input),started=performance.now(),deadline=started+r.durationMs,counters=IO.newCounters();running=true;let pending;
   try{pending=interval({deadline,checkDeadline:deadline,counters,routeRequest,work:(session)=>sourceClosure?S.captureSourceClosure(session,r):P.captureCanonicalFacts(session,r)});const {result:facts,witness,budget}=pending;
    if(routeRequest&&witness.routeSelection?.mode!=='server_only')C.fail('AUTHORITY_ROUTE_UNAVAILABLE');
    const closureEncoded=C.canonical(facts.closure),closureDigest=MHash(closureEncoded);counters.proofBytes=Buffer.byteLength(closureEncoded);if(counters.proofBytes>MiB)C.fail('RESOURCE_LIMIT');
    const contentDescriptor=facts.items.map(({itemId,key,profile,utf8Bytes,sha256})=>({... (sourceClosure?{itemId}:{}),key,profile,utf8Bytes,sha256}));counters.returnedNarrativeBytes=facts.closure.byteCounts.narrativeBytes;
    const summary={schema:routeRequest?'memory-suite.libra-routed-backend-observation.v1':'memory-suite.libra-backend-observation.v1',usage:'backend-verification-only',qualificationScope:witness.qualificationScope,authorityProfile:witness.authorityProfile,sourceCoverage:sourceClosure?S.PROFILE:'libra.plugin-kv.v1',bindingModel:P.BINDING,issuerId,requestId:r.requestId,observationId:randomUUID(),namespace:'libra',scopeKey:r.scopeKey,codec:sourceClosure?S.CODEC:P.CODEC,capturedAtMonotonicMs:started,deadlineAtMonotonicMs:deadline,captureWitness:witness,closureDigest,contentDescriptor,captureCounters:{...counters},routeAuthority:routeRequest?'server-semantic-settings.v1':'unavailable',...(routeRequest?{semanticModeEpoch:witness.routeSelection.semanticModeEpoch,routeDependencyDigest:witness.routeSelection.dependencyDigest}:{}),nativeAuthority:'unavailable',recallEligibility:'unqualified'};
    const summaryBytes=Buffer.byteLength(C.canonical(summary)),view=J.freeze({summary,...(sourceClosure?{receipt:facts.closure}:{}),items:facts.items});J.freeze(facts);budget.check();
    const retained=ownedBytes({view,facts});if(retained>budget.held)budget.reserve(retained-budget.held);budget.finish(retained);pending=null;
    const handle=Object.freeze({}),s={issuer:issuerBrand,requestId:r.requestId,scopeKey:r.scopeKey,deadline,status:'live',sourceClosure,routeRequest,retained,view,facts,witness,captureCounters:summary.captureCounters,currentnessCalls:0,currentness:IO.newCounters(),readCapturedCalls:0,uniqueBodyExportCount:0,uniqueExportedContentBytes:0,uniqueExportedMetadataBytes:summaryBytes,summaryExportCount:1};
    HANDLES.set(handle,s);active.add(s);return Object.freeze({handle,summary});
   }finally{if(pending)pending.budget.finish();running=false;}
  }
 const observer={
  observeCanonicalFacts(input){return capture(input);},
  observeSourceClosure(input){return capture(input,true);},
  observeRoutedCanonicalFacts(input){
   J.exact(input,['namespace','requestId','scopeId','scopeKey','starts','durationMs']);
   const {scopeId,...source}=input;require('./route-lifecycle.cjs').text(scopeId);
   return capture(source,false,{namespace:source.namespace,scopeId,scopeKey:source.scopeKey});
  },
  observeRoutedSourceClosure(input){
   J.exact(input,['namespace','requestId','scopeId','scopeKey','throughTurn','durationMs']);
   const {scopeId,...source}=input;require('./route-lifecycle.cjs').text(scopeId);
   return capture(source,true,{namespace:source.namespace,scopeId,scopeKey:source.scopeKey});
  },
  assertCurrent(args){const s=state(args);if(running)C.fail('AUTHORITY_BUSY');if(s.currentnessCalls>=IO.LIMITS.checks)C.fail('OBSERVATION_CHECK_LIMIT');s.currentnessCalls++;const checkDeadline=Math.min(s.deadline,performance.now()+5000);running=true;let pending;
   try{pending=interval({deadline:s.deadline,checkDeadline,counters:s.currentness,routeRequest:s.routeRequest,work:(session,budget,witness)=>{
     if(stableWitness(witness)!==stableWitness(s.witness))C.fail('SOURCE_CHANGED');
     if(!(s.sourceClosure?S.compareSourceClosure:P.compareLibraFactClosure)(session,{scopeKey:s.scopeKey,metadataClosure:s.facts.metadataClosure}))C.fail('SOURCE_CHANGED');return true;
    }});pending.budget.check();return Object.freeze({status:'current',checkedControlSequence:pending.witness.controlSequence});
   }catch(error){if(!['AUTHORITY_BUSY','OBSERVATION_CHECK_TIMEOUT','RESOURCE_LIMIT'].includes(error.code))retire(s,error.code||'SOURCE_PROOF_UNAVAILABLE');throw error;}
   finally{if(pending)pending.budget.finish();running=false;}
  },
  readCaptured(args){const s=state(args);s.readCapturedCalls++;if(!s.uniqueBodyExportCount){s.uniqueBodyExportCount=1;s.uniqueExportedContentBytes=s.captureCounters.returnedNarrativeBytes;if(s.sourceClosure)s.uniqueExportedMetadataBytes+=s.captureCounters.proofBytes;}return s.view;},
  getUsage(args){const s=state(args,{released:true});const reservation=32768;if(ledger.active+ledger.retained+reservation>IO.LIMITS.managedBytes)C.fail('RESOURCE_LIMIT');ledger.active+=reservation;ledger.peak=Math.max(ledger.peak,ledger.active+ledger.retained);try{const usage=J.freeze({status:s.status,captureCounters:s.captureCounters,currentnessCalls:s.currentnessCalls,currentnessAttempts:s.currentness.attempts,currentnessSourceRowEvents:s.currentness.sourceRowEvents,currentnessSourceMetadataBytes:s.currentness.sourceMetadataBytes,currentnessAuthorityRowEvents:s.currentness.authorityRowEvents,currentnessAuthorityMetadataBytes:s.currentness.authorityMetadataBytes,summaryExportCount:s.summaryExportCount,readCapturedCalls:s.readCapturedCalls,uniqueBodyExportCount:s.uniqueBodyExportCount,uniqueExportedContentBytes:s.uniqueExportedContentBytes,uniqueExportedMetadataBytes:s.uniqueExportedMetadataBytes,issuerRetainedCreditBytes:ledger.retained,issuerActiveCreditBytes:ledger.active,issuerPeakCreditBytes:ledger.peak});if(Buffer.byteLength(C.canonical(usage))>4096)C.fail('RESOURCE_LIMIT');return usage;}finally{ledger.active-=reservation;}},
  release(args){const s=state(args,{released:true});if(running)C.fail('AUTHORITY_BUSY');retire(s,'OBSERVATION_RELEASED');return Object.freeze({status:s.status});},
  captureCorpus(){C.fail('SOURCE_PROOF_UNAVAILABLE');},
  close(){if(running)C.fail('AUTHORITY_BUSY');if(closed)return;for(const s of active)retire(s,'AUTHORITY_CLOSED');reader.close();closed=true;}
 };return Object.freeze(observer);
}
function MHash(text){return require('./receipt-codec.cjs').hashUtf8(text);}
module.exports={createAuthorityObserver};
