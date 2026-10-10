/* WM STORAGE CONTRACTS v1.0.0 — plain wire data and byte integrity only.
 * No storage, transport, activation, authority issuance, models or configuration writes.
 * Common DTO shape validation never verifies a principal, sender, fence or manager approval.
 */
/**
 * @typedef {{ok:boolean,reason?:string}} Validation
 * @typedef {'canonical'|'cold'|'raw'|'raw_history'|'lineage'|'orphan'} Domain
 * @typedef {{kind:'canonical'|'preserve_inert'|'derived'|'private'|'unknown',domain?:Domain}} Classification
 * @typedef {'plugin_only'|'server_only'} StorageMode
 * @typedef {{schema:'wm.storage-route.v1',mode:StorageMode,routeGeneration:string,datasetId:string,backendId:string,state:'active'|'fenced'|'recovery_required'}} Route
 * @typedef {{protocol:'wm.snapshot-authority.v1',authorityId:string,storeId:string,scope:string,epoch:string,revision:string,schema:'wm.canonical-raw.v1',generationId:string,sha256:string,utf8Bytes:number,tombstone:boolean}} Head
 * @typedef {{analysisEligible:false,replacementEligible:false}} ImportDisposition
 * @typedef {{domain:Domain,schema:string,logicalId:string,originScope:string,bytes:number,sha256:string,dependencies:string[],disposition:null|ImportDisposition}} Item
 * @typedef {{schema:'wm.generation-manifest.v1',scope:string,generationId:string,canonical:{sha256:string,utf8Bytes:number},items:Item[],routeGeneration:string,writerEpoch:string,expectedHead:Head,operationId:string,manifestDigest:string}} GenerationManifest
 * @typedef {{snapshotId:string,cursor:string|null,nextCursor:string|null,items:Item[],complete:boolean,errors:Array<{code:string,domain:Domain,logicalId?:string}>}} InventoryPage
 * @typedef {{status:'prepared'|'committed'|'conflict'|'uncertain'|'not_applied',operationId:string,requestFingerprint:string,receipt?:Object}} OperationStatus
 * @typedef {{schema:'wm.migration-receipt.v1',operationId:string,requestFingerprint:string,sourceRoute:Route,targetRoute:Route,inventoryDigest:string,domainCounts:Object<Domain,number>,domainBytes:Object<Domain,number>,sourcePreserved:boolean,cutoverStatus:string,verified:boolean}} MigrationReceipt
 * @typedef {{schema:'wm.handoff-materialized-receipt.v1',transferId:string,sourceIdentity:Object,targetIdentity:Object,sourceHead:Head,sourceRoute:Route,targetRoute:Route,sourceFingerprintBefore:string,sourceFingerprintAfter:string,sourcePreserved:boolean,sourceMutated:false,sourceCompacted:false,copyMode:'materialized',physicalCopies:number,targetHead:Head,payloadDigest:string,domains:Object<Domain,{count:number,bytes:number,digest:string,complete:boolean}>,readback:Object,usable:boolean}} WmHandoffReceipt
 * @typedef {{ok:boolean,reason?:string,uncertain?:boolean}} Result
 * @typedef {{role:string,pluginId:string,namespaces:string[],access:'read'|'write'|'manager'}} Principal
 * @typedef {{operationId:string,requestFingerprint:string,operation:string,scope:string,expectedHead:Head,routeGeneration:string,writerEpoch:string,raw:string|null,manifest:GenerationManifest}} WriteInput
 * @typedef {{operationId:string,requestFingerprint:string,routeGeneration:string,writerEpoch:string,expectedInventoryRevision:string,items:Array<{descriptor:Item,payload:Uint8Array}>}} InventoryWrite
 * @typedef {{operationId:string,requestFingerprint:string,expectedRoute:Route}} FenceInput
 * @typedef {{operationId:string,requestFingerprint:string,expectedRoute:Route,targetRoute:Route,sealedInventoryDigest:string,sourceFenceReceipt:Object}} ActivateInput
 * @typedef {{snapshotId:string,routeGeneration:string,inventoryDigest:string,complete:boolean,domainCounts:Object<Domain,number>,domainBytes:Object<Domain,number>}} InventorySnapshot
 * @typedef {InventorySnapshot} Snapshot
 * @typedef {{operationId:string,requestFingerprint:string,state:string,sourceRoute:Route,targetRoute:Route,inventoryDigest:string,domainCounts:Object<Domain,number>,domainBytes:Object<Domain,number>,copiedBytes:number,reason?:string,receipt?:MigrationReceipt}} MigrationState
 * @typedef {{previewFingerprint:string,sourceRoute:Route,targetMode:StorageMode,targetBackendId:string,domainCounts:Object<Domain,number>,domainBytes:Object<Domain,number>,requiredStagingBytes:number,sourcePreserved:true,targetHasExistingData:boolean,complete:boolean,canStart:boolean,blockers:string[]}} MigrationPreview
 * @typedef {{mode:StorageMode,routeGeneration:string,connection:'unknown'|'connected'|'disconnected',qualification:HostSupport,migration:MigrationState|null,lastBackup:BackupStatus,lastRestore:BackupStatus}} StorageView
 * @typedef {Object} HostSupport Owner-defined by B4; a plain object never qualifies a host.
 * @typedef {{state:'none'|'absent'|'verified'|'failed'|'unknown',id?:string,verifiedAt?:string,coverage?:Object}} BackupStatus
 * @typedef {{ok:boolean,backendId:string,protocol:string,limits:Object,reason?:string}} ConnectionResult
 * @typedef {{ok:boolean,reason?:string}} Compatibility
 * @typedef {{schema:string,requestId:string,action:string,owner:'wm',payload:Object}} Response
 * @typedef {{ok:boolean,coverage:Object,inventoryDigest:string,reason?:string}} BackupVerification
 * @typedef {{planId:string,operationId:string,backupId:string,expectedStoreIdentity:Object,expectedCurrentFingerprint:string,expiresAt:string,requiredBytes:number,verifiedInventoryDigest:string}} RestorePlan
 * @typedef {{encoding:'base64',data:string,offset:number,totalBytes:number,sha256:string}} WireChunk
 * @typedef {{preparedId:string,operationId:string,operation:string,scope:string,rawSha256:string,expectedHead:Head,head:Head,requestFingerprint:string}} Prepared
 */
const WmStorageContracts = (() => {
  'use strict';
  const VERSION = '1.0.0', OWNER = 'wm', PLUGIN_ID = 'libra_world_manager';
  const PROTOCOL = 'wm.snapshot-authority.v1', CANONICAL_SCHEMA = 'wm.canonical-raw.v1';
  const ROUTE_SCHEMA = 'wm.storage-route.v1', MANIFEST_SCHEMA = 'wm.generation-manifest.v1', ROOT_MANIFEST_SCHEMA = 'wm.generation-roots.v2';
  const DEFAULT_CHUNK_BYTES = 256 * 1024, DEFAULT_PAGE_ITEMS = 128;
  const freezeList = values => Object.freeze(values);
  const DOMAINS = freezeList(['canonical','cold','raw','raw_history','lineage','orphan']);
  const HEAD_KEYS = freezeList(['protocol','authorityId','storeId','scope','epoch','revision','schema','generationId','sha256','utf8Bytes','tombstone']);
  const WRITER_OPERATIONS = freezeList(['normal','verified','reset','remove','import','restore','branch','migration','sync','recovery']);
  const DTO_KEYS = Object.freeze(Object.fromEntries(Object.entries({
    Head:HEAD_KEYS, Route:['schema','mode','routeGeneration','datasetId','backendId','state'],
    Item:['domain','schema','logicalId','originScope','bytes','sha256','dependencies','disposition'],
    GenerationManifest:['schema','scope','generationId','canonical','items','routeGeneration','writerEpoch','expectedHead','operationId','manifestDigest'],
    InventoryPage:['snapshotId','cursor','nextCursor','items','complete','errors'],
    OperationStatus:['status','operationId','requestFingerprint','receipt'],
    MigrationReceipt:['schema','operationId','requestFingerprint','sourceRoute','targetRoute','inventoryDigest','domainCounts','domainBytes','sourcePreserved','cutoverStatus','verified'],
    WmHandoffReceipt:['schema','transferId','sourceIdentity','targetIdentity','sourceHead','sourceRoute','targetRoute','sourceFingerprintBefore','sourceFingerprintAfter','sourcePreserved','sourceMutated','sourceCompacted','copyMode','physicalCopies','targetHead','payloadDigest','domains','readback','usable'],
    Result:['ok','reason','uncertain'], Principal:['role','pluginId','namespaces','access'],
    WriteInput:['operationId','requestFingerprint','operation','scope','expectedHead','routeGeneration','writerEpoch','raw','manifest'],
    InventoryWrite:['operationId','requestFingerprint','routeGeneration','writerEpoch','expectedInventoryRevision','items'],
    FenceInput:['operationId','requestFingerprint','expectedRoute'],
    ActivateInput:['operationId','requestFingerprint','expectedRoute','targetRoute','sealedInventoryDigest','sourceFenceReceipt'],
    InventorySnapshot:['snapshotId','routeGeneration','inventoryDigest','complete','domainCounts','domainBytes'],
    MigrationState:['operationId','requestFingerprint','state','sourceRoute','targetRoute','inventoryDigest','domainCounts','domainBytes','copiedBytes','reason','receipt'],
    MigrationPreview:['previewFingerprint','sourceRoute','targetMode','targetBackendId','domainCounts','domainBytes','requiredStagingBytes','sourcePreserved','targetHasExistingData','complete','canStart','blockers'],
    StorageView:['mode','routeGeneration','connection','qualification','migration','lastBackup','lastRestore'],
    BackupStatus:['state','id','verifiedAt','coverage'], ConnectionResult:['ok','backendId','protocol','limits','reason'],
    Compatibility:['ok','reason'], Response:['schema','requestId','action','owner','payload'],
    BackupVerification:['ok','coverage','inventoryDigest','reason'],
    RestorePlan:['planId','operationId','backupId','expectedStoreIdentity','expectedCurrentFingerprint','expiresAt','requiredBytes','verifiedInventoryDigest'],
    WireChunk:['encoding','data','offset','totalBytes','sha256'],
    Prepared:['preparedId','operationId','operation','scope','rawSha256','expectedHead','head','requestFingerprint']
  }).map(([name,keys])=>[name,freezeList(keys)])));
  const fail = reason => ({ok:false,reason}), ok = () => ({ok:true});
  const wellFormed = value => {
    for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;
  };
  const string = v => typeof v==='string' && wellFormed(v);
  const token = v => string(v) && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
  const digest = v => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
  const count = v => Number.isSafeInteger(v) && v>=0;
  const scope = v => string(v) && v.length>0 && new TextEncoder().encode(v).length<=1024;
  // Accept plain objects/arrays from another realm, while rejecting custom prototypes.
  const nativePrototype = (prototype,name) => {
    if(!prototype)return false;
    const descriptor=Object.getOwnPropertyDescriptor(prototype,'constructor');
    const ctor=descriptor && descriptor.value;
    return typeof ctor==='function' && Function.prototype.toString.call(ctor)==='function '+name+'() { [native code] }' && ctor.prototype===prototype;
  };
  const isRecord = value => value!==null && typeof value==='object' && !Array.isArray(value);
  const plain = value => {
    const active=new Set();
    const visit=v=>{
      if(v===null || typeof v==='boolean')return;
      if(typeof v==='string'){if(!wellFormed(v))throw Error('non_plain_data');return;}
      if(typeof v==='number'){if(!Number.isFinite(v))throw Error('non_plain_data');return;}
      if(typeof v!=='object' || active.has(v))throw Error('non_plain_data');
      const array=Array.isArray(v), prototype=Object.getPrototypeOf(v);
      if(array ? !nativePrototype(prototype,'Array') : prototype!==null && (!nativePrototype(prototype,'Object') || Object.getPrototypeOf(prototype)!==null))throw Error('non_plain_data');
      active.add(v);const keys=Reflect.ownKeys(v),ds=Object.getOwnPropertyDescriptors(v);
      if(keys.some(k=>typeof k!=='string'))throw Error('non_plain_data');
      if(array && (keys.length!==v.length+1 || !Object.hasOwn(ds.length,'value')))throw Error('non_plain_data');
      for(const key of keys){const d=ds[key];if(array && key==='length')continue;
        if(!Object.hasOwn(d,'value') || !d.enumerable || ['__proto__','constructor','prototype'].includes(key) || !wellFormed(key) || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=v.length))throw Error('non_plain_data');
        visit(d.value);
      }
      active.delete(v);
    };
    try{visit(value);return true;}catch(_){return false;}
  };
  const keys = (value,required,optional=[]) => isRecord(value) && required.every(k=>Object.hasOwn(value,k)) && Object.keys(value).every(k=>required.includes(k)||optional.includes(k));
  const stable = value => Array.isArray(value) ? '['+value.map(stable).join(',')+']' : isRecord(value) ? '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}' : JSON.stringify(value);
  const omit = (value,name) => isRecord(value) ? Object.fromEntries(Object.keys(value).filter(k=>k!==name).map(k=>[k,value[k]])) : value;
  const utf8 = value => new TextEncoder().encode(value);
  // Reused verbatim from sdk/MemorySuitePortableTransfer.source.js sha256Stream.
  // SHA integrity is not a signature, authenticated identity or durable-operation proof.
  const sha256Stream = () => {
    const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),tail=new Uint8Array(64),w=new Uint32Array(64);let used=0,total=0,done=false;
    const r=(x,n)=>(x>>>n)|(x<<(32-n));
    const block=(b,off)=>{for(let i=0;i<16;i++){const j=off+4*i;w[i]=(b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3];}for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0;}
      let [a,bv,c,d,e,f,g,v]=h;for(let i=0;i<64;i++){const t1=(v+(r(e,6)^r(e,11)^r(e,25))+((e&f)^((~e)&g))+K[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&bv)^(a&c)^(bv&c)))>>>0;v=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bv;bv=a;a=(t1+t2)>>>0;}[a,bv,c,d,e,f,g,v].forEach((v,i)=>h[i]=(h[i]+v)>>>0);
    };
    const update=bytes=>{if(done)throw Error('portable_hash_finalized');total+=bytes.length;let i=0;if(used){const n=Math.min(64-used,bytes.length);tail.set(bytes.subarray(0,n),used);used+=n;i=n;if(used===64){block(tail,0);used=0;}}for(;i+64<=bytes.length;i+=64)block(bytes,i);if(i<bytes.length){tail.set(bytes.subarray(i));used=bytes.length-i;}};
    const hex=()=>{if(done)throw Error('portable_hash_finalized');done=true;const end=new Uint8Array(used<56?64:128);end.set(tail.subarray(0,used));end[used]=128;const view=new DataView(end.buffer);view.setUint32(end.length-8,Math.floor(total/0x20000000));view.setUint32(end.length-4,(total*8)>>>0);for(let i=0;i<end.length;i+=64)block(end,i);return Array.from(h,v=>v.toString(16).padStart(8,'0')).join('');};
    return {update,hex};
  };
  const hashSync = bytes => {const hash=sha256Stream();hash.update(bytes);return hash.hex();};
  const canonicalHash = (value,excluded) => hashSync(utf8(stable(omit(value,excluded))));
  // Capture TypedArray intrinsics once, as in MemorySuiteSnapshotCache. These read
  // internal slots across realms without consulting caller-shadowed tags/metadata.
  const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayTag=Object.getOwnPropertyDescriptor(typedArrayPrototype,Symbol.toStringTag).get;
  const typedArrayByteLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength').get;
  const typedArraySet=typedArrayPrototype.set;
  /** @param {Uint8Array} bytes @returns {Promise<string>} */
  const hashBytes = async bytes => {
    let owned;
    try {
      if(typedArrayTag.call(bytes)!=='Uint8Array')throw Error('invalid_bytes');
      // Uint8Array and Buffer have one byte per element. Native set reads actual
      // typed-array slots, not source length/offset/buffer accessors or iterators.
      owned=new Uint8Array(typedArrayByteLength.call(bytes));
      typedArraySet.call(owned,bytes);
    } catch(_) { throw Error('invalid_bytes'); }
    // The exact intrinsic byte view is owned before the asynchronous crypto boundary.
    if(globalThis.crypto && globalThis.crypto.subtle){const hash=await globalThis.crypto.subtle.digest('SHA-256',owned);return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
    if(typeof require==='function')return require('node:crypto').createHash('sha256').update(owned).digest('hex');
    throw Error('sha256_unavailable');
  };
  /** Canonical sorted-key UTF-8 JSON; array order is binding. Excludes only this digest field. */
  const manifestDigest = async value => {if(!plain(value))throw Error('non_plain_data');return hashBytes(utf8(stable(omit(value,'manifestDigest'))));};
  /** Exact operation intent; excludes only top-level requestFingerprint, never user text. */
  const fingerprintRequest = async value => {if(!plain(value))throw Error('non_plain_data');return hashBytes(utf8(stable(omit(value,'requestFingerprint'))));};
  const headCheck = value => {
    if(!keys(value,HEAD_KEYS))return fail('head_invalid');
    if(value.protocol!==PROTOCOL || value.schema!==CANONICAL_SCHEMA || !scope(value.scope) || !['authorityId','storeId','epoch','revision','generationId'].every(k=>token(value[k])) || !digest(value.sha256) || !count(value.utf8Bytes) || typeof value.tombstone!=='boolean' || value.tombstone && (value.utf8Bytes!==0 || value.sha256!==hashSync(new Uint8Array(0))))return fail('head_invalid');
    return ok();
  };
  const validateHead = value => plain(value) ? headCheck(value) : fail('non_plain_data');
  /** @returns {Validation} */
  const validateRoute = value => {
    if(!plain(value))return fail('non_plain_data');
    if(!keys(value,DTO_KEYS.Route))return fail('route_invalid');
    if(value.schema!==ROUTE_SCHEMA || !['plugin_only','server_only'].includes(value.mode) || !['routeGeneration','datasetId','backendId'].every(k=>token(value[k])) || !['active','fenced','recovery_required'].includes(value.state))return fail('route_invalid');
    return ok();
  };
  const ITEM_SCHEMA_DOMAINS = Object.freeze({
    'wm.dependency-root.v1':'cold',
    'wm.extension-history-page.v1':'cold','wm.cold-shard.v1':'cold','wm.cold-manifest.v1':'cold','wm.raw-turn.v1':'raw',
    'wm.raw-history.v1':'raw_history','wm.lineage.v1':'lineage','wm.orphan.v1':'orphan',
    // Actual legacy schema identities are source-grounded; unsupported record forms remain unknown.
    'libra.cold_archive.v1':'cold','libra.persistent_memory_shard.v1':'cold','libra.persistent_memory_manifest.v1':'cold',
    'libra_turn_worldline_v1':'lineage','libra.host.worldline.meta.v1':'lineage'
  });
  const itemCheck = value => {
    if(!keys(value,DTO_KEYS.Item))return fail('item_invalid');
    if(!Object.hasOwn(ITEM_SCHEMA_DOMAINS,value.schema))return fail('unknown_schema');
    if(value.domain==='canonical' || ITEM_SCHEMA_DOMAINS[value.schema]!==value.domain || !token(value.logicalId) || !scope(value.originScope) || !count(value.bytes) || !digest(value.sha256) || !Array.isArray(value.dependencies) || !value.dependencies.every(token) || new Set(value.dependencies).size!==value.dependencies.length)return fail('item_invalid');
    if(value.disposition!==null && (!keys(value.disposition,['analysisEligible','replacementEligible']) || value.disposition.analysisEligible!==false || value.disposition.replacementEligible!==false))return fail('disposition_invalid');
    return ok();
  };
  const validateItem = value => plain(value) ? itemCheck(value) : fail('non_plain_data');
  /** @returns {Validation} Checks descriptor closure and manifest digest; payload readback is separate. */
  const validateManifest = value => {
    if(!plain(value))return fail('non_plain_data');
    if(value.schema===ROOT_MANIFEST_SCHEMA)return validateRootManifest(value);
    if(!keys(value,DTO_KEYS.GenerationManifest))return fail('unknown_field');
    if(value.schema!==MANIFEST_SCHEMA)return fail('unknown_schema');
    if(!scope(value.scope) || !['generationId','routeGeneration','writerEpoch','operationId'].every(k=>token(value[k])) || !digest(value.manifestDigest) || !keys(value.canonical,['sha256','utf8Bytes']) || !digest(value.canonical.sha256) || !count(value.canonical.utf8Bytes) || !Array.isArray(value.items))return fail('manifest_invalid');
    const head=headCheck(value.expectedHead);if(!head.ok)return head;
    if(value.expectedHead.scope!==value.scope)return fail('scope_mismatch');
    let total=value.canonical.utf8Bytes;const ids=new Map();
    for(const item of value.items){const checked=itemCheck(item);if(!checked.ok)return checked;
      if(ids.has(item.logicalId))return fail('duplicate_logical_id');ids.set(item.logicalId,item);
      if(item.originScope!==value.scope && (!['raw','raw_history','lineage'].includes(item.domain) || item.disposition===null))return fail('scope_mismatch');
      if(total>Number.MAX_SAFE_INTEGER-item.bytes)return fail('byte_total_overflow');total+=item.bytes;
    }
    for(const item of value.items)for(const dep of item.dependencies)if(!ids.has(dep))return fail('dependency_missing');
    // Iterative closure DFS avoids recursion proportional to inventory size.
    const visited=new Set(), active=new Set();
    for(const id of ids.keys()){
      if(visited.has(id))continue;const stack=[[id,false]];
      while(stack.length){const [next,exit]=stack.pop();if(exit){active.delete(next);visited.add(next);continue;}
        if(active.has(next))return fail('dependency_cycle');if(visited.has(next))continue;active.add(next);stack.push([next,true]);
        for(const dep of ids.get(next).dependencies)stack.push([dep,false]);
      }
    }
    if(canonicalHash(value,'manifestDigest')!==value.manifestDigest)return fail('manifest_digest_mismatch');
    return ok();
  };
  // V2 is opt-in and never reinterprets a v1 full-closure items array.
  const validateRootManifest = value => {
    if(!plain(value))return fail('non_plain_data');
    const fields=DTO_KEYS.GenerationManifest.filter(k=>k!=='items').concat(['dependencyRoots','baseGenerationId']);
    if(!keys(value,fields)||value.schema!==ROOT_MANIFEST_SCHEMA)return fail('root_manifest_invalid');
    if(!scope(value.scope)||!['generationId','routeGeneration','writerEpoch','operationId'].every(k=>token(value[k]))||!digest(value.manifestDigest)||!keys(value.canonical,['sha256','utf8Bytes'])||!digest(value.canonical.sha256)||!count(value.canonical.utf8Bytes)||!headCheck(value.expectedHead).ok||value.expectedHead.scope!==value.scope)return fail('root_manifest_invalid');
    if(value.baseGenerationId!==null&&value.baseGenerationId!==value.expectedHead.generationId)return fail('root_base_conflict');
    if(!Array.isArray(value.dependencyRoots)||value.dependencyRoots.length>32||!value.dependencyRoots.every(token)||new Set(value.dependencyRoots).size!==value.dependencyRoots.length||utf8(stable(value)).length>16384)return fail('root_manifest_limit');
    return canonicalHash(value,'manifestDigest')===value.manifestDigest?ok():fail('manifest_digest_mismatch');
  };
  /** validateOperation validates WriteInput for prepare; no state, principal or execution rights. */
  const validateOperation = value => {
    if(!plain(value))return fail('non_plain_data');
    if(!keys(value,DTO_KEYS.WriteInput))return fail('unknown_field');
    if(!['operationId','routeGeneration','writerEpoch'].every(k=>token(value[k])) || !digest(value.requestFingerprint) || !WRITER_OPERATIONS.includes(value.operation) || !scope(value.scope) || !headCheck(value.expectedHead).ok || (value.operation==='remove' ? value.raw!==null : !string(value.raw)))return fail('operation_invalid');
    if(value.expectedHead.scope!==value.scope || value.manifest && value.manifest.scope!==value.scope)return fail('scope_mismatch');
    const valid=validateManifest(value.manifest);if(!valid.ok)return valid;
    if(value.operationId!==value.manifest.operationId || value.routeGeneration!==value.manifest.routeGeneration || value.writerEpoch!==value.manifest.writerEpoch || HEAD_KEYS.some(k=>value.expectedHead[k]!==value.manifest.expectedHead[k]))return fail('operation_manifest_mismatch');
    const bytes=utf8(value.raw===null?'':value.raw);
    if(bytes.length!==value.manifest.canonical.utf8Bytes || hashSync(bytes)!==value.manifest.canonical.sha256)return fail('raw_digest_mismatch');
    if(canonicalHash(value,'requestFingerprint')!==value.requestFingerprint)return fail('request_fingerprint_mismatch');
    return ok();
  };
  /** Shape only. not_applied requires proof from authoritative durable storage outside this module. */
  const validateOperationStatus = value => {
    if(!plain(value))return fail('non_plain_data');
    if(!keys(value,['status','operationId','requestFingerprint'],['receipt']) || !['prepared','committed','conflict','uncertain','not_applied'].includes(value.status) || !token(value.operationId) || !digest(value.requestFingerprint) || Object.hasOwn(value,'receipt') && !isRecord(value.receipt))return fail('operation_status_invalid');
    return ok();
  };
  const validateDomainTotals = value => {
    if(!plain(value))return fail('non_plain_data');
    return keys(value,DOMAINS) && DOMAINS.every(domain=>count(value[domain])) ? ok() : fail('domain_totals_invalid');
  };
  // Explicit field maps, never prefix or secret-word filtering. Classification does not copy,
  // sanitize or delete anything. unknown MUST block completeness in the inventory adapter.
  const RECORD_FIELDS = Object.freeze(Object.fromEntries(Object.entries({
    'wm.extension-history-page.v1':['schema','scope','logicalId','raw','dependencies'],
    'wm.dependency-root.v1':['schema','scope','generationId','manifestDigest','kind','dependencies'],
    'wm.cold-shard.v1':['schema','scope','logicalId','raw'],
    'wm.cold-manifest.v1':['schema','scope','logicalId','shards'],
    'wm.raw-turn.v1':['schema','originScope','logicalId','raw','provenance'],
    'wm.raw-history.v1':['schema','originScope','logicalId','rawId','status','observedAt'],
    'wm.lineage.v1':['schema','scope','parentScope','continuationOf'],
    'wm.orphan.v1':['schema','originScope','logicalId','raw'],
    'wm.derived-cache.v1':['schema','scope','entries'],
    'wm.private-config.v1':['schema','apiKey','authHeaders','connectionToken'],
    'wm.execution-capture.v1':['schema','jobId','capture'],
    'wm.execution-state.v1':['schema','jobId','state','lease','approval','wal']
  }).map(([name,fields])=>[name,freezeList(fields)])));
  const stringList = value => Array.isArray(value) && value.every(string);
  const legacySecrets = value => {
    if(!keys(value,['version','scopeKey','chatId','secrets']) || value.version!==1 || !scope(value.scopeKey) || !string(value.chatId) || !Array.isArray(value.secrets))return false;
    const secretKeys=['id','title','content','about','owner','knownBy','sensitivity','status','source','evidenceLog'];
    return value.secrets.every(secret=>keys(secret,secretKeys) && ['id','title','content','owner','sensitivity','status','source'].every(k=>string(secret[k])) && stringList(secret.about) && stringList(secret.knownBy) && Array.isArray(secret.evidenceLog) && secret.evidenceLog.every(e=>keys(e,['turn','viewerId','source','note','at']) && count(e.turn) && count(e.at) && ['viewerId','source','note'].every(k=>string(e[k]))));
  };
  const recordCheck = (schema,value) => {
    if(!keys(value,['schema'],RECORD_FIELDS[schema].filter(k=>k!=='schema')) || value.schema!==schema)return false;
    switch(schema){
      case 'wm.extension-history-page.v1':return keys(value,RECORD_FIELDS[schema])&&scope(value.scope)&&/^eh-[a-f0-9]{64}$/.test(value.logicalId)&&string(value.raw)&&Array.isArray(value.dependencies)&&value.dependencies.every(token)&&new Set(value.dependencies).size===value.dependencies.length;
      case 'wm.dependency-root.v1':return keys(value,RECORD_FIELDS[schema])&&scope(value.scope)&&token(value.generationId)&&digest(value.manifestDigest)&&['generation','legacy-bridge'].includes(value.kind)&&Array.isArray(value.dependencies)&&value.dependencies.length<=128&&value.dependencies.every(token)&&new Set(value.dependencies).size===value.dependencies.length;
      case 'wm.cold-shard.v1':return keys(value,RECORD_FIELDS[schema]) && scope(value.scope) && token(value.logicalId) && string(value.raw);
      case 'wm.cold-manifest.v1':return keys(value,RECORD_FIELDS[schema]) && scope(value.scope) && token(value.logicalId) && stringList(value.shards);
      case 'wm.raw-turn.v1':return keys(value,RECORD_FIELDS[schema]) && scope(value.originScope) && token(value.logicalId) && string(value.raw) && keys(value.provenance,['sourceId','observedAt']) && string(value.provenance.sourceId) && count(value.provenance.observedAt);
      case 'wm.raw-history.v1':return keys(value,RECORD_FIELDS[schema]) && scope(value.originScope) && token(value.logicalId) && token(value.rawId) && ['completed','failed','cancelled','interrupted','unknown'].includes(value.status) && count(value.observedAt);
      case 'wm.lineage.v1':return keys(value,RECORD_FIELDS[schema]) && scope(value.scope) && (value.parentScope===null || scope(value.parentScope)) && (value.continuationOf===null || scope(value.continuationOf));
      case 'wm.orphan.v1':return keys(value,RECORD_FIELDS[schema]) && scope(value.originScope) && token(value.logicalId) && string(value.raw);
      case 'wm.derived-cache.v1':return scope(value.scope) && Array.isArray(value.entries);
      case 'wm.private-config.v1':return true;
      case 'wm.execution-capture.v1':return token(value.jobId) && isRecord(value.capture);
      case 'wm.execution-state.v1':return token(value.jobId) && string(value.state);
      default:return false;
    }
  };
  /** @param {{key:string,schema:string|null,value:*}} record @returns {Classification} */
  const classifyOwnedRecord = record => {
    if(!plain(record) || !keys(record,['key','schema','value']) || !string(record.key))return {kind:'unknown'};
    const {key,schema,value}=record;
    if(schema===CANONICAL_SCHEMA && string(value))return {kind:'canonical',domain:'canonical'};
    // The existing story-secret state has a version field, no invented persisted schema.
    if(key==='lmai_secret_knowledge' && schema===null && legacySecrets(value))return {kind:'canonical',domain:'canonical'};
    if(!Object.hasOwn(RECORD_FIELDS,schema) || !recordCheck(schema,value))return {kind:'unknown'};
    if(['wm.private-config.v1','wm.execution-capture.v1'].includes(schema))return {kind:'private'};
    if(schema==='wm.derived-cache.v1')return {kind:'derived'};
    if(schema==='wm.execution-state.v1')return {kind:'preserve_inert'}; // NOT an exportable execution authority.
    if(schema==='wm.raw-history.v1')return {kind:'preserve_inert',domain:'raw_history'};
    return {kind:'canonical',domain:ITEM_SCHEMA_DOMAINS[schema]};
  };
  return Object.freeze({VERSION,OWNER,PLUGIN_ID,PROTOCOL,CANONICAL_SCHEMA,ROUTE_SCHEMA,MANIFEST_SCHEMA,ROOT_MANIFEST_SCHEMA,DEFAULT_CHUNK_BYTES,DEFAULT_PAGE_ITEMS,DOMAINS,HEAD_KEYS,WRITER_OPERATIONS,DTO_KEYS,ITEM_SCHEMA_DOMAINS,RECORD_FIELDS,validateHead,validateRoute,validateItem,validateManifest,validateRootManifest,validateOperation,validateOperationStatus,validateDomainTotals,fingerprintRequest,hashBytes,manifestDigest,classifyOwnedRecord});
})();
if(typeof module!=='undefined' && module.exports)module.exports=WmStorageContracts;
