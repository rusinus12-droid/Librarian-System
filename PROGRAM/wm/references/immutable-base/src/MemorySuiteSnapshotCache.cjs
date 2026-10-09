'use strict';
module.exports = (() => {
  const PROTOCOL = 'memory-suite.snapshot-cache.v1';
  const CAPABILITIES = Object.freeze(['atomic_expected_head_publish','immutable_verified_generations','durable_nonreusable_epochs','all_writer_ownership','healthy_head_certifies_generation','atomic_acquire_and_pin','reader_retention','commit_status_reconciliation','atomic_healthy_head_set_observation']);
  const ok = value => ({ok:true,value});
  const fail = reason => ({ok:false,reason});
  const bad = reason => {const error=new Error(reason);error.code=reason;throw error;};
  const own = (v,k) => Object.prototype.hasOwnProperty.call(v,k);
  // Capture native signal operations once. No instanceof check and no caller overrides.
  const signalProbe=new AbortController().signal;
  let signalPrototype=Object.getPrototypeOf(signalProbe),abortedDescriptor;
  while(signalPrototype&&!abortedDescriptor){abortedDescriptor=Object.getOwnPropertyDescriptor(signalPrototype,'aborted');signalPrototype=Object.getPrototypeOf(signalPrototype);}
  const readAborted=abortedDescriptor?.get,addAbortListener=signalProbe.addEventListener,removeAbortListener=signalProbe.removeEventListener;
  const signalAborted=signal=>readAborted.call(signal);
  const typedPrototype=Object.getPrototypeOf(Uint8Array.prototype);
  const typedByteLength=Object.getOwnPropertyDescriptor(typedPrototype,'byteLength').get;
  const typedLength=Object.getOwnPropertyDescriptor(typedPrototype,'length').get;
  function removeAbort(sub){
    if(sub.abortCell)sub.abortCell.sub=null;
    if(sub.signal){try{removeAbortListener.call(sub.signal,'abort',sub.onAbort);}catch{/* The detached cell no longer retains request data. */}}
  }
  function stable(value, limit=8192) {
    const seen=new Set(); let nodes=0,chars=0;
    function walk(v,depth) {
      if(depth>32 || ++nodes>2048) bad('invalid_identity');
      if(v===null || typeof v==='boolean') return v;
      if(typeof v==='number') {if(!Number.isFinite(v))bad('invalid_identity');return v;}
      if(typeof v==='string') {chars+=v.length;if(chars>limit)bad('invalid_identity');return v;}
      if(typeof v!=='object' || seen.has(v))bad('invalid_identity');
      if(!Array.isArray(v) && Object.getPrototypeOf(v)!==Object.prototype && Object.getPrototypeOf(v)!==null)bad('invalid_identity');
      if(Array.isArray(v)&&v.length>2048)bad('invalid_identity');
      const keys=Reflect.ownKeys(v);if(keys.some(k=>typeof k!=='string'||(!(Array.isArray(v)&&k==='length')&&Object.getOwnPropertyDescriptor(v,k)?.enumerable!==true)))bad('invalid_identity');
      if(Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i))))bad('invalid_identity');
      seen.add(v);const out=Array.isArray(v)?[]:Object.create(null);
      for(const k of Object.keys(v).sort()) {const d=Object.getOwnPropertyDescriptor(v,k);if(!d || !own(d,'value'))bad('invalid_identity');chars+=k.length;out[k]=walk(d.value,depth+1);}
      seen.delete(v);return out;
    }
    const result=JSON.stringify(walk(value,0));if(!result || result.length>limit)bad('invalid_identity');return result;
  }
  function freezeTree(value) {if(value&&typeof value==='object'){for(const v of Object.values(value))freezeTree(v);Object.freeze(value);}return value;}
  function immutable(value,maxBytes,maxNodes) {
    let bytes=0,nodes=0;const seen=new Set();
    const charge=n=>{bytes+=n;if(bytes>maxBytes)bad('resource_budget');};
    function copy(v,depth) {
      if(++nodes>maxNodes || depth>64)bad('resource_budget');
      if(v===null){charge(4);return null;}
      if(typeof v==='string'){charge(16+v.length*2);return v;}
      if(typeof v==='boolean'){charge(4);return v;}
      if(typeof v==='number'){if(!Number.isFinite(v))bad('unsupported_value');charge(8);return v;}
      if(typeof v!=='object'||seen.has(v))bad('unsupported_value');
      if(ArrayBuffer.isView(v)) {
        const types=[Float32Array,Float64Array,Uint8Array,Uint16Array,Uint32Array,Int8Array,Int16Array,Int32Array];
        const C=types.find(T=>Object.getPrototypeOf(v)===T.prototype);if(!C)bad('unsupported_value');
        const length=typedLength.call(v);charge(typedByteLength.call(v)+128);if(length>maxNodes-nodes)bad('resource_budget');nodes+=length;
        if(Reflect.ownKeys(v).some(k=>typeof k!=='string'||!/^\d+$/.test(k)))bad('unsupported_value');
        const data=new C(length);data.set(v);for(const n of data)if(!Number.isFinite(n))bad('unsupported_value');
        return Object.freeze({kind:C.name,length:data.length,byteLength:data.byteLength,at(index){if(!Number.isInteger(index))return undefined;return data[index<0?data.length+index:index];}});
      }
      if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)bad('unsupported_value');
      charge(Array.isArray(v)?24+v.length*8:32);if(Array.isArray(v)&&v.length>maxNodes-nodes)bad('resource_budget');
      const keys=Reflect.ownKeys(v);if(keys.some(k=>typeof k!=='string'||(!(Array.isArray(v)&&k==='length')&&Object.getOwnPropertyDescriptor(v,k)?.enumerable!==true)))bad('unsupported_value');
      if(Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i))))bad('unsupported_value');
      seen.add(v);const out=Array.isArray(v)?[]:(Object.getPrototypeOf(v)===null?Object.create(null):{});
      for(const k of Object.keys(v)){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!own(d,'value'))bad('unsupported_value');charge(k.length*2+16);Object.defineProperty(out,k,{value:copy(d.value,depth+1),enumerable:true,writable:false,configurable:false});}
      seen.delete(v);return Object.freeze(out);
    }
    return {value:copy(value,0),bytes};
  }
  function createSnapshotCache(options={}) {
    const limits={maxBytes:options.maxBytes,maxEntries:options.maxEntries??24,maxFlights:options.maxFlights??16,maxSubscribers:options.maxSubscribers??128,maxOwners:options.maxOwners??64,maxObservations:options.maxObservations??256,maxAuthorities:options.maxAuthorities??16,maxValueNodes:options.maxValueNodes??50000};
    for(const [k,v] of Object.entries(limits))if(!Number.isSafeInteger(v)||v<1)throw new TypeError('invalid_budget:'+k);
    const authTokens=new WeakMap(),ownerTokens=new WeakMap(),observationTokens=new WeakMap();
    const authorities=new Set(),owners=new Set(),observations=new Set(),jobs=new Set(),flights=new Map(),entries=new Map(),resident=new Set();
    let disposed=false,runtimeEpoch=0,serial=0,reservedBytes=0,retainedBytes=0,observationBytes=0,subscriberCount=0;
    const counters={hits:0,misses:0,loads:0,coalesced:0,evictions:0,rejections:0,invalidations:0,lateRejected:0,peakBytes:0};
    const total=()=>reservedBytes+retainedBytes+observationBytes;
    const peak=()=>{counters.peakBytes=Math.max(counters.peakBytes,total());};
    const matches=(x,s)=>x.namespace===s.namespace&&(s.scope===undefined||x.scope===s.scope);
    function freeEntry(e){if(e.refs===0&&!e.cached&&resident.delete(e)){retainedBytes-=e.bytes;e.value=null;e.witness=null;}}
    function uncache(e,invalid=false){if(entries.get(e.key)===e)entries.delete(e.key);e.cached=false;if(invalid)e.valid=false;freeEntry(e);}
    function room(bytes){if(bytes>limits.maxBytes)return false;for(const e of entries.values()){if(total()+bytes<=limits.maxBytes)break;if(e.refs===0){uncache(e);counters.evictions++;}}return total()+bytes<=limits.maxBytes;}
    function reject(reason){counters.rejections++;return fail(reason);}
    function registerAuthority(input) {
      if(disposed)return reject('disposed');if(authorities.size>=limits.maxAuthorities)return reject('resource_budget');
      try {
        const level=input?.level;if(!['C0','C1','C2'].includes(level))return reject('unsupported_capability');
        const descriptor=freezeTree(JSON.parse(stable(input.descriptor,4096)));
        for(const k of ['authorityId','storeId','routeId','bindingEpoch'])if(typeof descriptor[k]!=='string'||!descriptor[k]||descriptor[k].length>256)return reject('unsupported_capability');
        let qualification=null;
        if(level==='C2'){
          if(!Array.isArray(descriptor.capabilities)||CAPABILITIES.some(x=>!descriptor.capabilities.includes(x))||typeof input.observe!=='function')return reject('unsupported_capability');
          qualification=freezeTree(JSON.parse(stable(input.qualification,1024)));
          if(!['test-fixture','reviewed-provider'].includes(qualification.kind)||!qualification.reference||!qualification.version)return reject('unsupported_capability');
        }
        const token=Object.freeze({});const state={id:++serial,level,descriptor,qualification,observe:input.observe};authTokens.set(token,state);authorities.add(state);return ok(token);
      }catch{return reject('unsupported_capability');}
    }
    function openOwner(input){if(disposed)return reject('disposed');if(owners.size>=limits.maxOwners)return reject('resource_budget');if(!input||typeof input.namespace!=='string'||!input.namespace||input.namespace.length>256||typeof input.scope!=='string'||!input.scope||input.scope.length>1024)return reject('invalid_owner');const token=Object.freeze({}),state={id:++serial,namespace:input.namespace,scope:input.scope,epoch:0,active:true,observations:new Set(),subscribers:new Set(),borrows:new Set()};ownerTokens.set(token,state);owners.add(state);return ok(token);}
    function openObservation(token,input={}){
      const owner=ownerTokens.get(token);if(disposed)return reject('disposed');if(!owner?.active)return reject('invalid_owner');if(observations.size>=limits.maxObservations)return reject('resource_budget');
      if(!input||typeof input!=='object')return reject('invalid_observation');
      if(own(input,'raw')&&typeof input.raw!=='string')return reject('invalid_observation');const raw=own(input,'raw')?input.raw:null,bytes=raw===null?0:16+raw.length*2;if(!room(bytes))return reject('resource_budget');
      const result=Object.freeze({}),state={id:++serial,owner,epoch:owner.epoch,active:true,raw,bytes};observationTokens.set(result,state);owner.observations.add(state);observations.add(state);observationBytes+=bytes;peak();return ok(result);
    }
    function live(sub){return !disposed&&sub.owner.active&&sub.owner.epoch===sub.ownerEpoch&&!sub.cancelled&&(!sub.signal||!signalAborted(sub.signal))&&(!sub.observation||(sub.observation.active&&sub.observation.owner===sub.owner&&sub.observation.epoch===sub.owner.epoch));}
    function jobLive(job){return !disposed&&job.valid&&!job.cancelled&&job.runtimeEpoch===runtimeEpoch;}
    function detach(sub){sub.owner.subscribers.delete(sub);if(sub.job)sub.job.subscribers.delete(sub);}
    function maybeCancel(job){if(job&&!job.finished&&job.subscribers.size===0&&job.tasks>0){job.cancelled=true;job.controller.abort();if(flights.get(job.flightKey)===job)flights.delete(job.flightKey);}}
    function cancelSub(sub,reason){if(sub.borrow){sub.borrow.release();return;}if(sub.settled)return;sub.cancelled=true;sub.settled=true;detach(sub);removeAbort(sub);sub.resolve(fail(reason));maybeCancel(sub.job);}
    function closeObservationState(state){if(!state||!state.active)return;state.active=false;state.raw=null;observationBytes-=state.bytes;state.bytes=0;state.owner.observations.delete(state);observations.delete(state);for(const sub of [...state.owner.subscribers])if(sub.observation===state)cancelSub(sub,'invalid_observation');for(const b of [...state.owner.borrows])if(b.observation===state)b.release();}
    function closeObservation(token){const state=observationTokens.get(token);if(!state)return reject('invalid_observation');closeObservationState(state);return ok(null);}
    function closeOwnerState(owner){if(!owner||!owner.active)return;owner.active=false;owner.epoch++;for(const p of [...owner.observations])closeObservationState(p);for(const s of [...owner.subscribers])cancelSub(s,'cancelled');for(const b of [...owner.borrows])b.release();owners.delete(owner);}
    function closeOwner(token){const state=ownerTokens.get(token);if(!state)return reject('invalid_owner');closeOwnerState(state);return ok(null);}
    function invalidate(selector,reason='invalidated'){
      if(!selector||typeof selector.namespace!=='string')return reject('invalid_selector');counters.invalidations++;
      for(const job of jobs)if(matches(job,selector)){job.valid=false;job.controller.abort();if(flights.get(job.flightKey)===job)flights.delete(job.flightKey);for(const s of [...job.subscribers])cancelSub(s,reason);}
      for(const e of [...resident])if(matches(e,selector))uncache(e,true);
      for(const o of owners)if(matches(o,selector)){o.epoch++;for(const p of [...o.observations])closeObservationState(p);for(const b of [...o.borrows])b.release();for(const s of [...o.subscribers])cancelSub(s,reason);}
      return ok(null);
    }
    function dispose(){if(!disposed){disposed=true;runtimeEpoch++;for(const o of [...owners])closeOwnerState(o);for(const job of jobs){job.valid=false;job.controller.abort();}for(const e of [...resident])uncache(e,true);flights.clear();authorities.clear();}return ok({pendingJobs:jobs.size});}
    function validateSource(identity,authority,owner){
      const s=identity.source,h=s?.head,d=authority.descriptor;
      if(!s||!h||s.owner!==owner.namespace||s.scope!==owner.scope)return false;
      for(const k of ['authorityId','storeId','routeId','bindingEpoch'])if(s[k]!==d[k])return false;
      for(const k of ['protocol','schema','epoch','revision','generationId'])if(typeof h[k]!=='string'||!h[k]||h[k].length>256)return false;
      if(!/^[a-f0-9]{64}$/.test(h.sha256)||!Number.isSafeInteger(h.utf8Bytes)||h.utf8Bytes<0||h.tombstone!==false)return false;
      for(const k of ['segmentKind','segmentId','manifestRootDigest','contentRevision','contentDigest','codecVersion'])if(typeof identity[k]!=='string'||!identity[k])return false;
      return true;
    }
    function admit(job,e){
      if(!job.persistent||!jobLive(job)||!e.valid)return;
      const prior=entries.get(e.key);if(prior&&prior!==e)uncache(prior);
      if(!e.cached){while(entries.size>=limits.maxEntries){const candidate=[...entries.values()].find(x=>x.refs===0);if(!candidate)return;uncache(candidate);counters.evictions++;}e.cached=true;entries.set(e.key,e);}
      else {entries.delete(e.key);entries.set(e.key,e);}
    }
    function borrow(sub,e){
      e.refs++;let active=true;const state={observation:sub.observation,release(){if(!active)return ok(null);active=false;sub.owner.borrows.delete(state);removeAbort(sub);e.refs--;freeEntry(e);sub.borrow=null;return ok(null);}};
      const token=Object.freeze({get value(){if(!active||!e.valid||!live(sub))bad('invalid_borrow');return e.value;},release:state.release});sub.owner.borrows.add(state);sub.borrow=state;return token;
    }
    function finishJob(job){
      if(job.finished||!job.loadSettled||job.tasks!==0)return;job.finished=true;
      if(flights.get(job.flightKey)===job)flights.delete(job.flightKey);jobs.delete(job);
      if(job.entry){job.entry.refs--;freeEntry(job.entry);}if(job.reservation){reservedBytes-=job.reservation;job.reservation=0;}
      job.entry=null;job.witness=null;job.identity=null;job.load=null;job.resolveDone();
    }
    async function run(job){
      try{
        if(!jobLive(job))return fail('cancelled');
        if(job.entry)return ok(job.entry);
        counters.loads++;const r=await job.load({signal:job.controller.signal,maxBytes:job.reservation});
        if(!jobLive(job)){counters.lateRejected++;return fail('cancelled');}
        if(!r||r.ok!==true)return fail(typeof r?.reason==='string'?r.reason:'read_failed');
        const overhead=128+job.key.length*2+(job.witness===null?0:16+job.witness.length*2);
        const copy=immutable(r.value,job.reservation-overhead,limits.maxValueNodes),bytes=overhead+copy.bytes;
        if(bytes>job.reservation) return fail('resource_budget');
        const e={key:job.key,namespace:job.namespace,scope:job.scope,value:copy.value,bytes,witness:job.witness,refs:1,cached:false,valid:true};
        reservedBytes-=job.reservation;job.reservation=0;retainedBytes+=bytes;resident.add(e);job.entry=e;peak();return ok(e);
      }catch(error){return fail(['resource_budget','unsupported_value'].includes(error?.code)?error.code:'read_failed');}
      finally{job.loadSettled=true;}
    }
    async function deliver(sub,job){
      try {
        const r=await job.ready;if(sub.settled)return;
        if(!r.ok){sub.settled=true;sub.resolve(r);return;}
        if(!jobLive(job)||!live(sub)){sub.settled=true;sub.resolve(fail('cancelled'));return;}
        if(job.authority.level==='C2'){
          let observed;try{observed=await job.authority.observe(job.identity,{signal:job.controller.signal});}catch{observed=null;}
          if(sub.settled)return;
          if(!jobLive(job)||!live(sub)){sub.settled=true;sub.resolve(fail('cancelled'));return;}
          let equal=false;try{equal=observed?.ok===true&&observed.value?.healthy===true&&stable(observed.value.source)===job.sourceKey;}catch{}
          if(!equal){sub.settled=true;sub.resolve(fail('snapshot_changed'));return;}
        }
        // No await or provider/user callback between the final fences and admission/delivery.
        if(!jobLive(job)||!live(sub)){sub.settled=true;sub.resolve(fail('cancelled'));return;}
        const b=borrow(sub,r.value);admit(job,r.value);sub.settled=true;sub.resolve(ok(b));
      }finally{
        detach(sub);if(!sub.borrow)removeAbort(sub);subscriberCount--;job.tasks--;sub.job=null;finishJob(job);
      }
    }
    function getOrLoad(input){
      if(disposed)return Promise.resolve(reject('disposed'));
      const owner=ownerTokens.get(input?.owner),authority=authTokens.get(input?.authority);
      if(!owner?.active)return Promise.resolve(reject('invalid_owner'));if(!authority)return Promise.resolve(reject('unsupported_capability'));
      let observation=null,identity,key,sourceKey=null;
      const kind=input.kind??(authority.level==='C2'?'source':'observation');
      try{
        if(authority.level!=='C2'){
          observation=observationTokens.get(input.observation);
          if(!observation)return Promise.resolve(reject('unsupported_capability'));
          if(!observation.active||observation.owner!==owner||observation.epoch!==owner.epoch||(kind==='pure_projection'&&observation.raw===null))return Promise.resolve(reject('invalid_observation'));
          if(!['observation','pure_projection'].includes(kind))return Promise.resolve(reject('unsupported_capability'));
        }
        const identityKey=stable(input.identity);identity=freezeTree(JSON.parse(identityKey));
        if(kind==='pure_projection'&&(typeof identity.transformVersion!=='string'||!identity.transformVersion))return Promise.resolve(reject('invalid_identity'));
        if(authority.level==='C2'&&!validateSource(identity,authority,owner))return Promise.resolve(reject('invalid_identity'));
        if(authority.level==='C2')sourceKey=stable(identity.source);
        key=JSON.stringify([authority.id,owner.namespace,owner.scope,kind,identityKey]);
      }catch{return Promise.resolve(reject('invalid_identity'));}
      const reserve=input.reserveBytes;if(!Number.isSafeInteger(reserve)||reserve<1||typeof input.load!=='function')return Promise.resolve(reject('invalid_input'));
      const signal=input.signal;if(signal){try{if(typeof readAborted!=='function'||signalAborted(signal)!==false)return Promise.resolve(reject('cancelled'));}catch{return Promise.resolve(reject('invalid_input'));}}
      if(subscriberCount>=limits.maxSubscribers)return Promise.resolve(reject('resource_budget'));
      const persistent=authority.level==='C2'||kind==='pure_projection',witness=kind==='pure_projection'&&observation?observation.raw:null;
      const flightKey=key+(authority.level==='C2'?'':':observation:'+observation.id);let job=flights.get(flightKey);
      if(job&&(!jobLive(job)||job.finished))job=null;
      if(!job){
        if(jobs.size>=limits.maxFlights)return Promise.resolve(reject('resource_budget'));
        let entry=persistent?entries.get(key):null;if(entry&&(!entry.valid||entry.witness!==witness))entry=null;
        if(!entry&&(reserve<128+key.length*2+(witness===null?0:16+witness.length*2)||!room(reserve)))return Promise.resolve(reject('resource_budget'));
        if(entry){entry.refs++;counters.hits++;entries.delete(key);entries.set(key,entry);}else{reservedBytes+=reserve;counters.misses++;peak();}
        let resolveDone;const done=new Promise(r=>{resolveDone=r;});
        job={flightKey,key,namespace:owner.namespace,scope:owner.scope,authority,identity,sourceKey,witness,persistent,load:input.load,reservation:entry?0:reserve,entry,runtimeEpoch,valid:true,cancelled:false,controller:new AbortController(),subscribers:new Set(),tasks:0,loadSettled:false,finished:false,done,resolveDone};
        jobs.add(job);flights.set(flightKey,job);job.ready=Promise.resolve().then(()=>run(job));
      }else counters.coalesced++;
      return new Promise(resolve=>{
        const sub={owner,ownerEpoch:owner.epoch,observation,signal,job,resolve,settled:false,cancelled:false,borrow:null,onAbort:null};
        sub.abortCell={sub};const cell=sub.abortCell;sub.onAbort=()=>{if(cell.sub)cancelSub(cell.sub,'cancelled');};owner.subscribers.add(sub);job.subscribers.add(sub);job.tasks++;subscriberCount++;
        try{if(signal)addAbortListener.call(signal,'abort',sub.onAbort,{once:true});}catch{cancelSub(sub,'invalid_input');}
        void deliver(sub,job);
      });
    }
    function stats(){return Object.freeze({...counters,entries:entries.size,residentEntries:resident.size,jobs:jobs.size,subscribers:subscriberCount,owners:owners.size,observations:observations.size,authorities:authorities.size,reservedBytes,retainedBytes,observationBytes,totalBytes:total(),maxBytes:limits.maxBytes,estimatedControlBytes:owners.size*128+observations.size*96+jobs.size*256+subscriberCount*256+authorities.size*256,disposed});}
    async function drain(){await Promise.all([...jobs].map(j=>j.done));return ok({pendingJobs:jobs.size});}
    return Object.freeze({registerAuthority,openOwner,openObservation,closeObservation,getOrLoad,invalidate,closeOwner,dispose,drain,stats});
  }
  return Object.freeze({PROTOCOL,CAPABILITIES,createSnapshotCache});
})();
