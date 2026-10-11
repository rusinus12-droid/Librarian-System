'use strict';
// Diagnostic-only observation: no new I/O, awaits, retries, timers or admission rules.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const sha=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const pin=value=>sha(JSON.stringify(value)??'undefined');
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(value)?value:null;
const refusal=value=>typeof value==='string'&&/^(?:LIB_READ|UNIFIED|HEALTH)_[A-Z_]{1,100}$/.test(value)?value:null;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
const metadata=value=>({keySha256:pin(value?.key),exists:value?.exists===true,tombstone:value?.tombstone===true,
 revision:Number.isSafeInteger(value?.revision)?value.revision:null,digest:hash(value?.digest),
 updatedAt:Number.isSafeInteger(value?.updatedAt)?value.updatedAt:null,valueBytes:Number.isSafeInteger(value?.valueBytes)?value.valueBytes:null});
const once=(source,before,after)=>{assert.equal(source.split(before).length,2,'diagnostic source seam occurs exactly once');return source.replace(before,after);};
function createReadBoundaryDiagnostic(){
 const events=[],pins={},captured=new Map();let phase='',sequence=0,dropped=0,observerErrors=0;
 const add=value=>{sequence++;if(events.length<64)events.push({sequence,...value});else dropped++;};
 const observe=(origin,value)=>{try{
  if(origin==='sdk.request'){
   phase=value.action;
   add({origin,action:token(value.action),scopeSha256:pin(value.body?.scope),
    evidenceRevision:hash(value.body?.evidenceRevision),readIdentitySha256:pin(value.body?.readIdentity),
    dataInstanceIdSha256:pin(value.body?.dataInstanceId),resetEpoch:value.body?.resetEpoch??null});
  }else if(origin==='sdk.response'){
   const result=value.payload?.result,proof=value.body;
   if(value.action==='capture')for(const dependency of (Array.isArray(result?.dependencies)?result.dependencies:[]).slice(0,16)){
    const row=metadata(dependency);captured.set(row.keySha256,row);
   }
   add({origin,action:token(value.action),schema:token(result?.schema),current:typeof result?.current==='boolean'?result.current:null,
    scopeSha256:pin(result?.scope),evidenceRevision:hash(result?.evidenceRevision),dataInstanceIdSha256:pin(result?.dataInstanceId),
    resetEpoch:result?.resetEpoch??null,outerDataInstanceMatches:value.payload?.dataInstanceId===value.connection.dataInstanceId,
    ...(value.action==='current'?{conditions:{schema:result?.schema==='memory-suite.libra-read-session-current.v1',current:result?.current===true,
     scope:JSON.stringify(result?.scope)===JSON.stringify(proof.scope),evidenceRevision:result?.evidenceRevision===proof.evidenceRevision,
     dataInstance:result?.dataInstanceId===value.connection.dataInstanceId,resetEpoch:result?.resetEpoch===value.epoch}}:
    {dependencyCount:Array.isArray(result?.dependencies)?result.dependencies.length:null,dependencies:[...captured.values()]})});
  }else if(origin==='repository.metadata'){
   const row=metadata(value),prior=captured.get(row.keySha256),changed=prior?Object.keys(row).filter(key=>row[key]!==prior[key]):null;
   add({origin,phase:token(phase),...row,...(phase==='current'?{captured:prior??null,changed}:{} )});
  }else if(origin==='sdk.reject'||origin==='consumer.assertCurrent.catch'){
   add({origin,code:refusal(value?.code),errorName:token(value?.name),messageCode:refusal(value?.message)});
  }
 }catch(_){observerErrors++;}};
 const sdkSource=source=>{
  pins.sdkSha256=sha(source);
  const start=source.indexOf('  const openLibraReadSession = async (scopeInput, readOptions = {}) => {');
  const end=source.indexOf('  const createLibraReadOnlyClient=',start);
  assert.ok(start>=0&&end>start,'real SDK read-session body found');
  let body=source.slice(start,end);
  body=once(body,"const reject = code => { throw Object.assign(new Error(code), {code}); };",
   "const reject = code => { globalThis.__composedReadDiagnostic('sdk.reject',{code}); throw Object.assign(new Error(code), {code}); };");
  body=once(body,'await assertRoute();let payload;',
   "await assertRoute();let payload;globalThis.__composedReadDiagnostic('sdk.request',{action,body});");
  body=once(body,'      await assertRoute();\n      if(payload?.dataInstanceId',
   "      globalThis.__composedReadDiagnostic('sdk.response',{action,body,payload,connection,epoch});\n      await assertRoute();\n      if(payload?.dataInstanceId");
  return source.slice(0,start)+body+source.slice(end);
 };
 const consumerSource=source=>{
  pins.gradiaSha256=sha(source);
  return once(source,"catch (error) { const code = /^LIB_READ_/.test(error?.code || '') ? error.code : 'LIB_READ_STALE'; stop(record, code); fail(code); }",
   "catch (error) { globalThis.__composedReadDiagnostic('consumer.assertCurrent.catch',{code:error?.code,name:error?.name,message:error?.message}); const code = /^LIB_READ_/.test(error?.code || '') ? error.code : 'LIB_READ_STALE'; stop(record, code); fail(code); }");
 };
 const observeRepository=repository=>{
  const original=repository.getMetadata;
  assert.equal(typeof original,'function','actual repository metadata reader exists');
  const wrapped=function(...args){const value=Reflect.apply(original,this,args);observe('repository.metadata',value);return value;};
  repository.getMetadata=wrapped;
  assert.equal(repository.getMetadata,wrapped,'metadata observer installed');
  return ()=>{if(repository.getMetadata===wrapped)repository.getMetadata=original;};
 };
 const report=(error,{libraSource,vectorDrain}={})=>({schema:'composed.read-boundary-diagnostic.v1',classification:'UNKNOWN_DIAGNOSTIC_ONLY',
  pins:{...pins,libraSha256:sha(libraSource)},error:{code:refusal(error?.code),name:token(error?.name)},
  vectorDrain:{ok:vectorDrain?.ok===true,attempted:vectorDrain?.attempted??null,completed:vectorDrain?.completed??null,
   results:(Array.isArray(vectorDrain?.results)?vectorDrain.results:[]).slice(0,4).map(row=>({status:token(row.status),
    diagnostic:{ok:row.diagnostic?.ok??null,reason:refusal(row.diagnostic?.reason)}}))},
  events,dropped,observerErrors});
 return {observe,sdkSource,consumerSource,observeRepository,report};
}
module.exports={createReadBoundaryDiagnostic};
