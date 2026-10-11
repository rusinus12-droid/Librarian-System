'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const sha=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const pin=value=>sha(JSON.stringify(value)??'undefined');
const decode=value=>typeof value==='string'?JSON.parse(value):value;
const once=(source,before,after)=>{assert.equal(source.split(before).length,2,'unique natural writer observation seam');return source.replace(before,after);};
function createNaturalManifestTrace(){
 const events=[],last=new Map(),proposals=new Map();let sequence=0,dropped=0,errors=0,sourceSha256='';
 const controlled=process.env.ROOT039_HOLD_NATURAL_AUDIT_UNTIL_CAPTURE!=='0';
 let heldCallback=null,delivered=false,resolveFired,resolveFinished,repositoryRef=null,auditActive=false;
 const auditCanonicalReads=new Set();
 const fired=new Promise(resolve=>{resolveFired=resolve;}),finished=new Promise(resolve=>{resolveFinished=resolve;});
 const add=value=>{sequence++;if(events.length<96)events.push({sequence,at:Date.now(),...value});else dropped++;};
 const diff=(before,after,path='',out=[])=>{
  if(JSON.stringify(before)===JSON.stringify(after)||out.length>=24)return out;
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
   for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
    const safe=/^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/.test(key)?key:'hash_'+pin(key).slice(0,12);
    diff(before[key],after[key],path?path+'.'+safe:safe,out);
   }
  }else out.push({path,beforeSha256:pin(before),afterSha256:pin(after)});
  return out;
 };
 const observe=(origin,value={})=>{try{
  const scopeSha256=pin(value.scopeKey||value.scope?.scopeKey);
  if(origin==='saveManifest'){
   const document=JSON.parse(JSON.stringify(value.manifest)),bodySha256=pin(document);
   const stack=String(value.stack||'').split('\n').filter(line=>line.includes('LIBRA-test-runtime.js:')).slice(0,8)
    .map(line=>line.trim().replace(/.*\bat /,'at '));
   const proposal={origin,scopeSha256,bodySha256,stack};proposals.set(bodySha256,proposal);add(proposal);
  }else {add({origin,scopeSha256,...(value.delayMs!==undefined?{delayMs:value.delayMs}:{}),
   ...(value.reason?{reason:value.reason}:{}),...(value.fullAudit!==undefined?{fullAudit:value.fullAudit,
    changed:value.changed,branchGuardChanged:value.branchGuardChanged,
    previousFullAuditAt:value.previousFullAuditAt,nextFullAuditAt:value.nextFullAuditAt}: {})});
   if(origin==='branch.queue.exit')resolveFinished();
  }
 }catch(_){errors++;}};
 const transform=source=>{
  sourceSha256=sha(source);
  source=once(source,'      await storage.setJson(manifestKey, manifest);\n      return manifest;',
   "      globalThis.risuai.__naturalManifestTrace('saveManifest',{scope,manifest,stack:new Error().stack});\n      await storage.setJson(manifestKey, manifest);\n      return manifest;");
  source=once(source,'      if (changed || branchGuardChanged) await saveManifest(context.scope, manifest);',
   "      globalThis.risuai.__naturalManifestTrace('branch.reconcile',{scope:context.scope,reason:options.reason,fullAudit,changed,branchGuardChanged,previousFullAuditAt:persistedGuard.lastFullAuditAt,nextFullAuditAt:lastFullAuditAt});\n      if (changed || branchGuardChanged) await saveManifest(context.scope, manifest);");
  const start=source.indexOf('    const scheduleDeepBranchAudit = ('),end=source.indexOf('\n    // Preservation is not replacement authority.',start);
  assert.ok(start>=0&&end>start);let body=source.slice(start,end);
  body=once(body,'        state.timers.delete(timerKey);',"        globalThis.risuai.__naturalManifestTrace('branch.timer.fire',{scopeKey});\n        state.timers.delete(timerKey);");
  body=once(body,'        const task = enqueue(scopeKey, async () => {',"        globalThis.risuai.__naturalManifestTrace('branch.queue.submit',{scopeKey});\n        const task = enqueue(scopeKey, async () => {\n          globalThis.risuai.__naturalManifestTrace('branch.queue.enter',{scopeKey});");
  body=once(body,'          return true;',"          globalThis.risuai.__naturalManifestTrace('branch.queue.exit',{scopeKey});\n          return true;");
  body=once(body,'      state.timers.set(timerKey, timer);',"      state.timers.set(timerKey, timer);\n      globalThis.risuai.__naturalManifestTrace('branch.timer.scheduled',{scopeKey,delayMs});");
  if(controlled)body=once(body,'const timer = setTimeout(() => {','const timer = globalThis.risuai.__naturalAuditTimer(setTimeout,() => {');
  return source.slice(0,start)+body+source.slice(end);
 };
 const observeRepository=repository=>{
  repositoryRef=repository;
  const restores=[];
  const get=repository.get;
  repository.get=function(...args){const result=Reflect.apply(get,this,args);if(auditActive&&args[0]==='plugin'&&/:memory:\d+:r\d+$/.test(args[1]))auditCanonicalReads.add(pin(args[1]));return result;};
  restores.push(()=>{repository.get=get;});
  for(const method of ['mutate','applyConditionalBatch']){
   const original=repository[method];assert.equal(typeof original,'function');
   const wrapper=function(...args){
    const result=Reflect.apply(original,this,args);
    try{
     const mutations=method==='mutate'?[args[0]]:args[0],receipt=result?.result||result;
     for(const mutation of mutations){
      if(mutation.kind!=='set'||mutation.space!=='plugin'||!mutation.key.endsWith(':manifest'))continue;
      const document=decode(mutation.value),bodySha256=pin(document),keySha256=pin(mutation.key);
      const admitted=method==='mutate'?receipt:receipt.receipts?.find(row=>row.key===mutation.key&&row.kind==='set');
      add({origin:'repository.manifest.committed',method,keySha256,bodySha256,
       revision:admitted?.revision,digest:admitted?.digest,committedAt:admitted?.committedAt,
       durable:receipt.durable,verified:receipt.verified,expectedRevision:mutation.expectedRevision??null,
       changedFields:last.has(keySha256)?diff(last.get(keySha256),document):[{path:'<initial>'}],
       matchedSaveManifest:proposals.has(bodySha256),saveStack:proposals.get(bodySha256)?.stack||[]});
      last.set(keySha256,JSON.parse(JSON.stringify(document)));
     }
    }catch(_){errors++;}
    return result;
   };
   repository[method]=wrapper;assert.equal(repository[method],wrapper);
   restores.push(()=>{if(repository[method]===wrapper)repository[method]=original;});
  }
  return ()=>restores.reverse().forEach(restore=>restore());
 };
 const schedule=(nativeSetTimeout,callback,delay)=>nativeSetTimeout(()=>{
  assert.equal(heldCallback,null,'one genuine branch timer captured');heldCallback=callback;
  add({origin:'control.native_timer_fired',delayMs:delay});resolveFired();
 },delay);
 const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NATURAL_AUDIT_CONTROL_BOUNDARY_NOT_REACHED')),5000);})]);}finally{clearTimeout(timer);}};
 const fetch=(url,init,transport)=>{
  if(!controlled||!url.endsWith('/v1/libra/read-session/capture')||delivered)return transport(url,init);
  return (async()=>{const response=await transport(url,init);assert.equal(response.status,200);await bounded(fired);
   const canonicalRows=()=>repositoryRef.database.prepare('SELECT key,value_json,revision FROM kv WHERE deleted=0 ORDER BY key').all().filter(row=>/:memory:\d+:r\d+$/.test(row.key));
   const before=canonicalRows();assert.ok(before.length>0,'actual committed canonical before timer delivery');
   delivered=true;auditActive=true;add({origin:'control.deliver_genuine_timer_after_capture'});heldCallback();await bounded(finished);auditActive=false;
   assert.equal(pin(canonicalRows()),pin(before),'genuine audit preserves physical canonical rows and revisions');
   assert.ok(auditCanonicalReads.size>0,'genuine audit still reaches the physical canonical loader');
   add({origin:'control.genuine_owner_queue_completed',canonicalBytesUnchanged:true,canonicalRows:before.length,canonicalPhysicalReads:auditCanonicalReads.size});return response;})();
 };
 const report=()=>({schema:'composed.natural-manifest-trace.v1',classification:controlled?'GENUINE_TIMER_DELIVERY_CONTROL':'NATURAL_WRITER_DIAGNOSTIC',sourceSha256,events,dropped,errors});
 return {observe,transform,observeRepository,report,schedule,fetch};
}
module.exports={createNaturalManifestTrace};
