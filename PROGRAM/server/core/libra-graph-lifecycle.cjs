'use strict';
// A durable, scope-wide reader/writer exclusion protocol. All predicates and
// mutations run in the repository's SQLite writer transaction, including core3.
const crypto=require('node:crypto');
const forestReferences=require('../../tools/libra_memory_graph_forest_refs.cjs');
module.exports=function createGraphLifecycle({namespace,get,getMetadata,list,applyConditionalBatch,now=Date.now}){
 const gcInventories=new Map();
 const fail=(code,statusCode=409)=>{throw Object.assign(new Error(code),{code,statusCode});};
 const scopeOf=key=>/^libra:v1:scope:(.+?):memory-graph:v1:/.exec(String(key||''))?.[1]||'';
 const controlKey=scope=>'libra:v1:scope:'+scope+':memory-graph-control:v1:root';
 const read=scope=>{
  const row=get('plugin',controlKey(scope));
  const value=row.exists?row.value:{schema:'libra.graph_lifecycle.v1',leases:[]};
  if(value?.schema!=='libra.graph_lifecycle.v1'||!Array.isArray(value.leases)||value.leases.length>32)fail('LIBRA_GRAPH_LIFECYCLE_CORRUPT');
  return {row,value};
 };
 const live=value=>value.leases.filter(lease=>Number.isSafeInteger(lease.expiresAt)&&lease.expiresAt>now());
 const requireLease=(scope,token,kind=null)=>{
  const current=live(read(scope).value).find(lease=>lease.token===token&&(!kind||lease.kind===kind));
  if(!current)fail('LIBRA_GRAPH_LEASE_EXPIRED');return current;
 };
 const expected=row=>({expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:row.exists,expectedTombstone:row.tombstone});
 // Projection v2 separates query rows from build-only windows. Trace both so
 // reclamation and root publication use the same transitive closure.
 const projectionReferences=(prefix,key,digest,onKey,missing='LIBRA_GRAPH_GC_REFERENCE_MISSING')=>{
  const seen=new Set(),namespace=prefix+'corpus:projection:';
  const keep=ref=>{
   if(!ref||!/^[a-f0-9]{64}$/.test(String(ref.digest||''))||ref.key!==namespace+ref.digest)fail('LIBRA_GRAPH_GC_REFERENCE_UNOWNED');
   if(!(getMetadata?getMetadata('plugin',ref.key):get('plugin',ref.key)).exists)fail(missing);
   onKey(ref.key);
  };
  const visit=(ref,schema)=>{
   keep(ref);if(seen.has(ref.key))return;seen.add(ref.key);if(seen.size>4096)fail('LIBRA_GRAPH_GC_REFERENCE_LIMIT');
   const row=get('plugin',ref.key,{maxValueBytes:8*1024*1024}),raw=typeof row.value==='string'?row.value:JSON.stringify(row.value);
   if(crypto.createHash('sha256').update(raw).digest('hex')!==ref.digest)fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
   let value;try{value=JSON.parse(raw);}catch(_){fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');}
   if(value?.schema==='libra.graph_corpus_projection.v1'&&schema==='libra.graph_corpus_projection.v2')return;
   if(value?.schema!==schema)fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
   if(schema==='libra.graph_corpus_projection_build.v1'){
    if(!Array.isArray(value.windows)||value.windows.length>128)fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
    for(const ref of value.windows)visit(ref,'libra.graph_corpus_projection_window.v1');return;
   }
   if(!value.parts||Object.keys(value.parts).sort().join(',')!=='bases,canonicalRows,edges,nodes,units')fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
   for(const part of Object.values(value.parts)){
    if(!Array.isArray(part.refs)||part.refs.length>4096)fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
    for(const ref of part.refs)keep(ref);
   }
   if(schema==='libra.graph_corpus_projection.v2')visit(value.build,'libra.graph_corpus_projection_build.v1');
  };
  visit({key,digest},'libra.graph_corpus_projection.v2');
 };
 const reachable=(scope,listing)=>{
  const prefix='libra:v1:scope:'+scope+':memory-graph:v1:',retained=new Set();
  const record=key=>{
   if(typeof key!=='string'||!key.startsWith(prefix))fail('LIBRA_GRAPH_GC_REFERENCE_UNOWNED');
   const row=get('plugin',key,{maxValueBytes:8*1024*1024});if(!row.exists)fail('LIBRA_GRAPH_GC_REFERENCE_MISSING');
   retained.add(key);let value;try{value=typeof row.value==='string'?JSON.parse(row.value):row.value;}catch(_){fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');}
   return {value,raw:row.value};
  };
   const forestSeen=new Set();
   const forestTrace=value=>{for(const ref of forestReferences(value,prefix+'corpus:')){
     if(forestSeen.has(ref.key))continue;forestSeen.add(ref.key);
     const saved=record(ref.key),raw=typeof saved.raw==='string'?saved.raw:JSON.stringify(saved.raw);
     if(crypto.createHash('sha256').update(raw).digest('hex')!==ref.digest)fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
     if(ref.type==='manifest')retainManifest(saved.value);else forestTrace(saved.value);
   }};
   const retainManifest=m=>{
   if(!Array.isArray(m.pages)&&!Array.isArray(m.refs))fail('LIBRA_GRAPH_GC_MANIFEST_UNSUPPORTED');
   for(const page of m.refs||m.pages){if(!page?.key?.startsWith(prefix))fail('LIBRA_GRAPH_GC_REFERENCE_UNOWNED');retained.add(page.key);}
   for(const key of [m.sourceProofs?.proofKey,m.sourceProofs?.projectionKey,m.semanticDirectory?.key])if(key){if(!key.startsWith(prefix))fail('LIBRA_GRAPH_GC_REFERENCE_UNOWNED');retained.add(key);}
   if(m.sourceProofs?.projectionKey)projectionReferences(prefix,m.sourceProofs.projectionKey,m.sourceProofs.projectionDigest,key=>retained.add(key));
    if(m.semanticDirectory?.key){const saved=record(m.semanticDirectory.key),directory=saved.value;
      if(crypto.createHash('sha256').update(typeof saved.raw==='string'?saved.raw:JSON.stringify(saved.raw)).digest('hex')!==m.semanticDirectory.digest||directory?.schema!=='libra.graph_semantic_directory.v1'||!Array.isArray(directory.entries))fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
      for(const entry of directory.entries)for(const page of entry.vectorPages||[]){if(!page.key?.startsWith(prefix+'corpus:vector:'))fail('LIBRA_GRAPH_GC_REFERENCE_UNOWNED');retained.add(page.key);}}
     forestTrace(m);
   };
  for(const key of listing.keys.filter(key=>key.startsWith(prefix+'root:')||key.startsWith(prefix+'corpus:root:')||key.startsWith(prefix+'semantic:root:'))){
   const root=record(key).value;
   if(!['libra.graph_root.v1','libra.graph_corpus.v1','libra.graph_corpus.v2','libra.graph_semantic_root.v1'].includes(root?.schema))fail('LIBRA_GRAPH_GC_ROOT_UNSUPPORTED');
   const manifest=record(root.manifestKey);
   if(crypto.createHash('sha256').update(typeof manifest.raw==='string'?manifest.raw:JSON.stringify(manifest.raw)).digest('hex')!==(root.digest||root.generation))fail('LIBRA_GRAPH_GC_REFERENCE_CORRUPT');
   retainManifest(manifest.value);
  }
  // Checkpoints are self-contained windowSlices, not references to index pages.
  for(const row of listing.records)if(row.key.startsWith(prefix+'corpus:checkpoint:')&&now()-row.updatedAt<86400000){retained.add(row.key);forestTrace(record(row.key).value);}
  return [...retained];
 };
 const command=input=>{
  if(namespace!=='libra')fail('LIBRA_GRAPH_NAMESPACE_REQUIRED',403);
  const {scopeKey,action,token}=input||{};
  if(typeof scopeKey!=='string'||!scopeKey||scopeKey.length>160||!/^[A-Za-z0-9_.:-]+$/.test(scopeKey))fail('LIBRA_GRAPH_SCOPE_INVALID',400);
  if(!['acquire','renew','release','assert','inventory','delete','yield'].includes(action))fail('LIBRA_GRAPH_LIFECYCLE_ACTION_INVALID',400);
  const prefix='libra:v1:scope:'+scopeKey+':memory-graph:v1:';
  const {row,value}=read(scopeKey),leases=live(value);
  for(const [key,entry]of gcInventories)if(entry.expiresAt<=now())gcInventories.delete(key);
  if(action==='yield'){
   const gc=leases.find(x=>x.kind==='gc');if(!gc)return {requested:false};
   const next=leases.map(x=>x.token===gc.token?{...x,yieldRequested:true}:x);
   applyConditionalBatch([{kind:'set',space:'plugin',key:controlKey(scopeKey),value:{...value,leases:next},...expected(row)}],
     {operationId:'graph-yield:'+crypto.randomUUID(),graphInternal:true});return {requested:true};
  }
  if(action==='acquire'||action==='renew'||action==='release'){
   let next=leases,lease=null;
   if(action==='acquire'){
    const kind=input.kind;if(!['build','read','gc'].includes(kind))fail('LIBRA_GRAPH_LEASE_KIND_INVALID',400);
    if(input.requestId!==undefined&&(typeof input.requestId!=='string'||!/^[A-Za-z0-9._:-]{8,240}$/.test(input.requestId)))fail('LIBRA_GRAPH_LEASE_REQUEST_INVALID',400);
    const prior=input.requestId&&leases.find(x=>x.requestId===input.requestId&&x.kind===kind);
    if(prior)return {schema:'libra.graph_lease.v1',scopeKey,...prior};
    if(leases.some(x=>x.kind==='gc')||kind==='gc'&&leases.length)fail('LIBRA_GRAPH_NAMESPACE_BUSY');
    if(leases.length>=32)fail('LIBRA_GRAPH_LEASE_LIMIT');
    lease={token:crypto.randomBytes(24).toString('hex'),kind,requestId:input.requestId||crypto.randomUUID(),expiresAt:now()+60000};next=[...leases,lease];
   }else{
    lease=leases.find(x=>x.token===token);
    if(!lease){if(action==='release')return {released:true};fail('LIBRA_GRAPH_LEASE_EXPIRED');}
    next=leases.filter(x=>x.token!==token);
    if(action==='renew'){lease={...lease,expiresAt:now()+60000};next.push(lease);}
   }
   applyConditionalBatch([{kind:'set',space:'plugin',key:controlKey(scopeKey),...expected(row),value:{schema:value.schema,leases:next}}],
    {operationId:'graph-lease:'+crypto.randomUUID(),graphInternal:true});
   if(action==='release')gcInventories.delete(token);
   return action==='release'?{released:true}:{schema:'libra.graph_lease.v1',scopeKey,...lease};
  }
  const lease=requireLease(scopeKey,token);
  if(action==='assert')return {current:true,...lease};
  if(lease.kind!=='gc')fail('LIBRA_GRAPH_GC_LEASE_REQUIRED',403);
  if(action==='inventory'){
   const listing=list('plugin',prefix,{liveOnly:true});
   if(listing.records.length>8192)fail('LIBRA_GRAPH_INVENTORY_LIMIT',413);
   const retainedKeys=reachable(scopeKey,listing);
   gcInventories.set(token,{scopeKey,expiresAt:lease.expiresAt,retained:new Set(retainedKeys),records:new Map(listing.records.map(r=>[r.key,r]))});
   return {keys:listing.keys,records:listing.records,retainedKeys,complete:true,fence:{schema:'libra.graph_namespace_fence.v1',scopeKey,token,expiresAt:lease.expiresAt}};
  }
  const candidate=input.candidate;
  if(!candidate||scopeOf(candidate.key)!==scopeKey||!/^libra:v1:scope:.+?:memory-graph:v1:(?:generation:|page:|corpus:(?:manifest:|page:|proof:|projection:|checkpoint:|semantic-directory:|vector:|forest:)|semantic:(?:page:|manifest:))/.test(candidate.key))fail('LIBRA_GRAPH_GC_KEY_UNOWNED',403);
  // A client cannot turn this endpoint into a source/root deletion API.
  const current=get('plugin',candidate.key);
  if(!current.exists||current.revision!==candidate.revision||current.digest!==candidate.digest)fail('LIBRA_GRAPH_GC_CANDIDATE_CHANGED');
  applyConditionalBatch([{kind:'remove',space:'plugin',key:candidate.key,...expected(current)}],{
   operationId:'graph-gc:'+crypto.randomUUID(),graphLease:{scopeKey,token},graphInternal:true,
   assertTransactionCurrent:()=>{
    requireLease(scopeKey,token,'gc');
    const inventory=gcInventories.get(token),record=inventory?.records.get(candidate.key);
    // GC excludes every publisher. Its captured immutable reachability set is
    // valid until this lease expires, so deletion need not rewalk the corpus
    // once for every orphan page.
    if(!inventory||inventory.scopeKey!==scopeKey||inventory.expiresAt<=now()||!record||record.revision!==candidate.revision||record.digest!==candidate.digest)fail('LIBRA_GRAPH_GC_CANDIDATE_CHANGED');
    if(inventory.retained.has(candidate.key))fail('LIBRA_GRAPH_GC_KEY_REACHABLE');
   }
  });
  return {deleted:true};
 };
 const assertWrite=(key,options={})=>{
  if(namespace!=='libra')return;
  // The server's existing approved maintenance transaction owns scope deletion
  // and restore/reset fencing. Public HTTP batches cannot set this option.
  if(options.maintenance===true)return;
  if(String(key).includes(':memory-graph-control:v1:')&&!options.graphInternal)fail('LIBRA_GRAPH_CONTROL_WRITE_FORBIDDEN',403);
  const scope=scopeOf(key);if(!scope)return;
  const leases=live(read(scope).value),gc=leases.find(x=>x.kind==='gc');
  if(gc&&options.graphLease?.token!==gc.token)fail('LIBRA_GRAPH_NAMESPACE_BUSY');
  // Publication by old/unregistered clients cannot race reclamation of their
  // uncommitted pages. Only a live durable build lease may publish a root.
  if(/:root:/.test(key)){
   if(!options.maintenance)requireLease(scope,options.graphLease?.token,'build');
   if(options.kind!=='set')return;
   let root;try{root=typeof options.value==='string'?JSON.parse(options.value):options.value;}catch(_){fail('LIBRA_GRAPH_ROOT_INVALID');}
   const prefix='libra:v1:scope:'+scope+':memory-graph:v1:';
   if(!root?.manifestKey?.startsWith(prefix))fail('LIBRA_GRAPH_ROOT_INVALID');
   const saved=get('plugin',root.manifestKey,{maxValueBytes:8*1024*1024});
   if(!saved.exists)fail('LIBRA_GRAPH_ROOT_REFERENCE_MISSING');
   const raw=typeof saved.value==='string'?saved.value:JSON.stringify(saved.value);
   if(crypto.createHash('sha256').update(raw).digest('hex')!==(root.digest||root.generation))fail('LIBRA_GRAPH_ROOT_INVALID');
   let manifest;try{manifest=JSON.parse(raw);}catch(_){fail('LIBRA_GRAPH_ROOT_INVALID');}
   const exists=key=>{if(typeof key!=='string'||!key.startsWith(prefix)||!(getMetadata?getMetadata('plugin',key):get('plugin',key,{maxValueBytes:8*1024*1024})).exists)fail('LIBRA_GRAPH_ROOT_REFERENCE_MISSING');};
   const seen=new Set();
   const validate=m=>{
   if(!Array.isArray(m.refs||m.pages))fail('LIBRA_GRAPH_ROOT_INVALID');
   for(const ref of m.refs||m.pages)exists(ref.key);
   for(const key of [m.sourceProofs?.proofKey,m.sourceProofs?.projectionKey,m.semanticDirectory?.key])if(key)exists(key);
   if(m.sourceProofs?.projectionKey)projectionReferences(prefix,m.sourceProofs.projectionKey,m.sourceProofs.projectionDigest,exists,'LIBRA_GRAPH_ROOT_REFERENCE_MISSING');
   if(m.semanticDirectory?.key){const stored=get('plugin',m.semanticDirectory.key).value,raw=typeof stored==='string'?stored:JSON.stringify(stored),dir=JSON.parse(raw);
     if(crypto.createHash('sha256').update(raw).digest('hex')!==m.semanticDirectory.digest)fail('LIBRA_GRAPH_ROOT_INVALID');
     for(const entry of dir.entries||[])for(const page of entry.vectorPages||[])exists(page.key);}
   const trace=value=>{for(const ref of forestReferences(value,prefix+'corpus:')){
     exists(ref.key);if(seen.has(ref.key))continue;seen.add(ref.key);if(seen.size>100000)fail('LIBRA_GRAPH_ROOT_REFERENCE_LIMIT');
     const stored=get('plugin',ref.key).value,raw=typeof stored==='string'?stored:JSON.stringify(stored);
     if(crypto.createHash('sha256').update(raw).digest('hex')!==ref.digest)fail('LIBRA_GRAPH_ROOT_INVALID');
     const child=JSON.parse(raw);if(ref.type==='manifest')validate(child);else trace(child);
   }};
   trace(m);
   };
   validate(manifest);
  }
 };
 return Object.freeze({command,assertWrite});
};
