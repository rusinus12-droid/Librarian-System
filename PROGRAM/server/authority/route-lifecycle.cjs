'use strict';
// Server semantic settings only. This contract never certifies native mutation,
// migration completeness, host writer exclusion or recall eligibility.
const C=require('./contracts.cjs'),J=require('./observation-json.cjs');
const SCHEMA='memory-suite.authority-route.v1',RECEIPT='memory-suite.authority-route-receipt.v1',KIND='semantic_route_v1',GLOBAL='__memory_suite_global__';
const LIMITS=Object.freeze({routes:8192,receipts:16384,receiptBytes:32768,totalBytes:16*1048576});
function text(value){if(typeof value!=='string'||!value.length||value.length>700||/[\x00-\x1f\x7f]/.test(value))C.fail('INVALID_AUTHORITY_ROUTE');J.unicode(value);return value;}
function target(value){J.exact(value,['scopeId','scopeKey','mode','overrideKind']);const v=C.clone(value);text(v.scopeId);text(v.scopeKey);if(!['plugin_only','server_only'].includes(v.mode)||!['explicit','inherited','global','removed'].includes(v.overrideKind))C.fail('INVALID_AUTHORITY_ROUTE');if((v.overrideKind==='global'||v.scopeId===GLOBAL)&&(v.scopeId!==GLOBAL||v.scopeKey!==GLOBAL||!['global','removed'].includes(v.overrideKind)))C.fail('INVALID_AUTHORITY_ROUTE');return v;}
function route(value){J.exact(value,['schema','namespace','scopeId','scopeKey','mode','modeEpoch','overrideKind','dependencyDigest','transition']);if(value.schema!==SCHEMA||value.transition!==null)C.fail('INVALID_AUTHORITY_ROUTE');C.profileNamespace(value.namespace,C.CORE3_AUTHORITY_PROFILE);target(Object.fromEntries(['scopeId','scopeKey','mode','overrideKind'].map(k=>[k,value[k]])));C.boundedInteger(value.modeEpoch,1);if(value.dependencyDigest!==digest(value))C.fail('INVALID_AUTHORITY_ROUTE');return C.clone(value);}
function digest(value){return C.hash(Object.fromEntries(['namespace','scopeId','scopeKey','mode','overrideKind'].map(k=>[k,value[k]])));}
function request(namespace,input){C.profileNamespace(namespace,C.CORE3_AUTHORITY_PROFILE);J.exact(input,['operationId','expectedRoute','target']);const t=target(input.target);C.identifier(input.operationId);const previous=input.expectedRoute===null?null:route(input.expectedRoute);if(previous&&(previous.namespace!==namespace||previous.scopeId!==t.scopeId||previous.scopeKey!==t.scopeKey))C.fail('INVALID_AUTHORITY_ROUTE');return {namespace,operationId:input.operationId,expectedRoute:previous,target:t};}
function next(v){const result={schema:SCHEMA,namespace:v.namespace,...v.target,modeEpoch:v.expectedRoute?C.increment(v.expectedRoute.modeEpoch):1,dependencyDigest:'',transition:null};result.dependencyDigest=digest(result);return route(result);}
function fromRow(r){return route({schema:SCHEMA,namespace:r.namespace,scopeId:r.scope_id,scopeKey:r.scope_key,mode:r.mode,modeEpoch:r.mode_epoch,overrideKind:r.override_kind,dependencyDigest:r.dependency_digest,transition:r.transition_json===null?null:JSON.parse(r.transition_json)});}
function receipt(value,{marker,initial,controlSequence}){
 J.exact(value,['schema','operationId','fingerprint','authorityProfile','physicalBinding','generation','controlSequence','initialQualificationId','ownerProofs','request','route','nativeAuthority','recallEligibility']);
 if(value.schema!==RECEIPT||value.authorityProfile!==C.CORE3_AUTHORITY_PROFILE||value.generation!==marker.generation||C.canonical(value.physicalBinding)!==C.canonical(marker.physicalBinding)||value.initialQualificationId!==initial.qualificationId||C.canonical(value.ownerProofs)!==C.canonical(initial.ownerProofs)||value.nativeAuthority!=='unavailable'||value.recallEligibility!=='unqualified')C.fail('AUTHORITY_QUARANTINED');
 const req=value.request;J.exact(req,['namespace','operationId','expectedRoute','target']);const normalized=request(req.namespace,{operationId:req.operationId,expectedRoute:req.expectedRoute,target:req.target});
 if(value.operationId!==req.operationId||value.fingerprint!==C.hash(normalized)||C.canonical(value.route)!==C.canonical(next(normalized))||!Number.isSafeInteger(value.controlSequence)||value.controlSequence<2||value.controlSequence>controlSequence)C.fail('AUTHORITY_QUARANTINED');
 return value;
}
function effective(routes,namespace,scopeId,scopeKey){
 C.profileNamespace(namespace,C.CORE3_AUTHORITY_PROFILE);text(scopeId);text(scopeKey);
 const own=routes.find(r=>r.namespace===namespace&&r.scopeId===scopeId)||null,global=routes.find(r=>r.namespace===namespace&&r.scopeId===GLOBAL)||null;
 if(own&&own.scopeKey!==scopeKey)C.fail('AUTHORITY_ROUTE_CHANGED');
 let chosen=own&&own.overrideKind==='explicit'?own:global&&global.overrideKind==='global'?global:own&&own.overrideKind==='inherited'?own:null;
 if(scopeId===GLOBAL)chosen=global?.overrideKind==='global'?global:null;
 const dependencies={own,global:own?.overrideKind==='explicit'?null:global};
 return {schema:'memory-suite.authority-route-selection.v1',namespace,scopeId,scopeKey,route:chosen,mode:chosen?.mode||null,semanticModeEpoch:chosen?.modeEpoch??null,dependencyDigest:C.hash(dependencies),dependencies};
}
module.exports={SCHEMA,RECEIPT,KIND,GLOBAL,LIMITS,text,target,route,digest,request,next,fromRow,receipt,effective};
