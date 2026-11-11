'use strict';
// Owner adapter checks and selected mode changes through an in-process server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {fixture,installedSdkVariants} = require('./storage_global_allchat_job_test.cjs');
const text = value => String(value ?? '');
const hash32 = value => { let h = 0x811c9dc5; for (const c of text(value).split('')) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193); return h >>> 0; };
const keyHash = value => hash32(value).toString(36);
const stableHash64 = value => { let h = 0xcbf29ce484222325n; for (const c of text(value).split('')) h = BigInt.asUintN(64, (h ^ BigInt(c.charCodeAt(0))) * 0x100000001b3n); return `h64${h.toString(36)}`; };
const stableDraftHash = value => hash32(text(value).toLowerCase().replace(/[\s.,!?…。，、！？:;'"“”‘’()[\]{}<>#*_=`~|\\/—–-]+/g, '')).toString(16).padStart(8,'0');
const names = { libra: ['LIBRA.js','Libra'], flashback: ['Flashback_Memory.js','Flashback'], hayaku: ['HAYAKU_Locator_Continuity.js','Hayaku'] };
const adapters = {};
for (const [owner, [file, title]] of Object.entries(names)) {
  const source = fs.readFileSync(path.join(__dirname,'..','plugins',file),'utf8');
  const start = source.indexOf(`// BEGIN ${title.toUpperCase()} GLOBAL DISCOVERY ADAPTER`);
  const end = source.indexOf(`// END ${title.toUpperCase()} GLOBAL DISCOVERY ADAPTER`, start);
  assert.ok(start >= 0 && end > start, `${owner}: read-only global adapter exists`);
  assert.match(source, new RegExp(`discoverGlobalScopes:\\s*memorySuite${title}DiscoverGlobalScopes`));
  const sandbox = {TextEncoder,TextDecoder,Response,DecompressionStream,atob,Uint8Array,crypto:globalThis.crypto,keyHash,stableHash:keyHash,stableHash64,stableDraftHash,
    STORAGE_RECONCILIATION_JOURNAL_KEY:'hayaku.v2.storage_reconciliation_journal'};
  vm.createContext(sandbox);
  adapters[owner] = vm.runInContext(`${source.slice(start,end)}\nmemorySuite${title}DiscoverGlobalScopes`, sandbox);
}
const libraSource = fs.readFileSync(path.join(__dirname,'..','plugins','LIBRA.js'),'utf8');
const libraResolver = vm.runInNewContext(libraSource.slice(libraSource.indexOf('function memorySuiteLibraMergeScopeRegistry('),
  libraSource.indexOf('const memorySuiteLibraRestoreObject'))+'\nmemorySuiteLibraResolveKeyScope');
const variantFor = owner => installedSdkVariants.find(([namespace])=>namespace===owner);
const row = (key,value,extra={}) => ({location:'plugin',space:'plugin',key,logicalKey:key,deleted:false,value:typeof value === 'string'?value:JSON.stringify(value),revision:1,digest:'fixture',...extra});
const host = n => ({characterId:`character_${n}`,chatId:`chat_${n}`,characterName:`Character ${n}`,chatTitle:`Chat ${n}`,characterIndex:n,chatIndex:0});
const identity = (owner,n) => owner==='libra'?`legacy_index_${n}`:owner==='flashback'?`char:${keyHash(host(n).characterId)}|chat:${keyHash(host(n).chatId)}`:`chat_${stableHash64(`${host(n).characterId}\n${host(n).chatId}`)}`;
const root = (owner,n,extra={}) => {
 const scopeKey = identity(owner,n),h=host(n);
 if(owner==='libra')return row(`libra:v1:scope:${scopeKey}:manifest`,{schema:'libra.manifest.v1',scopeKey,characterId:h.characterId,chatId:h.chatId,memories:{},inheritedMemories:[],...extra});
 if(owner==='flashback')return row(`vector_rag_memory:scope:${keyHash(scopeKey)}:manifest:v2`,{schema:'vector_rag_memory.scope_manifest.v2',version:2,scopeKey,storageHash:keyHash(scopeKey),characterId:h.characterId,chatId:h.chatId,canonicalCharacterId:h.characterId,canonicalChatId:h.chatId,canonicalScopeId:scopeKey,shardCount:0,count:0,shardSummaries:[],...extra});
 return row(`hayaku.v2.ledger.${scopeKey}`,{version:'hayaku_storage_ledger_v2',scopeKey,identity:{schema:'hayaku.scope_identity.v1',scopeKey,characterId:h.characterId,chatId:h.chatId},records:[],slotHeads:[],tombstones:[],...extra});
};
const clone = x => JSON.parse(JSON.stringify(x));
const freeze = x => {if(x&&typeof x==='object'){Object.freeze(x);Object.values(x).forEach(freeze);}return x;};
let checks = 0;
const inspect = async (owner, data={}) => {
 const input=freeze({hostScopes:[],registries:[],records:[],...clone(data)}),before=JSON.stringify(input);
 const result=await adapters[owner](input);
 assert.equal(JSON.stringify(input),before,`${owner}: input is not mutated`);
 assert.ok(Array.isArray(result.scopes)&&Array.isArray(result.records)&&Array.isArray(result.blockers));
 assert.equal(result.completeKnownScopes,result.blockers.length===0);
 for(const r of result.records)assert.ok(['scope','shared','control','artifact'].includes(r.classification),`${owner}: record classified ${r.logicalKey}`);
 checks++;return result;
};
const ok = r => assert.equal(r.completeKnownScopes,true,JSON.stringify(r.blockers));
const blocked = (r,pattern) => {assert.equal(r.completeKnownScopes,false);assert.ok(r.blockers.some(x=>pattern.test(String(x.code||x))),JSON.stringify(r.blockers));};
(async()=>{
 for(const owner of Object.keys(adapters)){
  let r=await inspect(owner,{hostScopes:[host(1),host(2)]});ok(r);assert.equal(r.scopes.length,2);
  r=await inspect(owner,{hostScopes:[host(1)],records:[root(owner,1),root(owner,2)]});ok(r);assert.equal(r.scopes.length,2);assert.ok(r.scopes.find(s=>s.scopeId===identity(owner,2)).detached);
  r=await inspect(owner,{records:Array.from({length:337},(_,i)=>root(owner,i))});ok(r);assert.equal(r.scopes.length,337,`${owner}: no 240/320 catalog cap`);
  const remote=root(owner,3);remote.location='server';r=await inspect(owner,{records:[remote]});ok(r);assert.equal(r.records[0].scopeId,identity(owner,3));
  const bad=root(owner,1);bad.value='{malformed';r=await inspect(owner,{records:[bad]});blocked(r,/malformed|invalid/);
  const unknown=owner==='libra'?'libra:v1:unknown':owner==='flashback'?'vector_rag_memory:scope:unknown:records:shard:0000':'hayaku.v2.ledger.unknown';
  r=await inspect(owner,{hostScopes:[host(1)],records:[row(unknown,{unknown:true})]});blocked(r,/unknown|identity|invalid|unresolved/);assert.ok(r.records.every(x=>!x.scopeId||x.scopeId!==r.scopes[0]?.scopeId));
  r=await inspect(owner,{records:[root(owner,1)],registries:[{entries:{bad:{scopeId:identity(owner,1),characterId:'conflict',chatId:'conflict',aliases:[]}}}]});blocked(r,/identity.*conflict|collision/);
  const secret=owner==='libra'?'libra:v1:provider-secrets':owner==='flashback'?'vector_rag_memory:embedding_secret:v2':'__memory_suite_owner_token_v1__:hayaku';
  r=await inspect(owner,{records:[row(secret,'NOT_JSON_CREDENTIAL')]});ok(r);assert.equal(r.records[0].classification,'control');assert.deepEqual(Array.from(r.records[0].dependencyScopeIds),[]);
  const rootRow=root(owner,1),artifact=row(`${rootRow.key}::chunk:v1:x:0`,'piece',{artifact:true,artifactOwnerKey:rootRow.key});
  r=await inspect(owner,{records:[rootRow,artifact]});ok(r);assert.equal(r.records[1].classification,'artifact');assert.equal(r.records[1].scopeId,identity(owner,1));
  r=await inspect(owner,{records:[artifact]});blocked(r,/artifact.*missing|dependency.*missing/);
  const deleted={...root(owner,1),deleted:true,value:null};r=await inspect(owner,{records:[deleted],registries:[{entries:{a:{scopeId:identity(owner,1),scopeKey:identity(owner,1),aliases:owner==='flashback'?[keyHash(identity(owner,1))]:[],...host(1)}}}]});ok(r);assert.equal(r.records[0].deleted,true);
  const dep=owner==='libra'?'libra:v1:shared-archive:missing:manifest':owner==='flashback'?'vector_rag_memory:scope:missing:manifest:v2':'hayaku.v2.shared_archive.missing';
  const rr=root(owner,1,{dependencyKeys:[dep]});r=await inspect(owner,{records:[rr]});blocked(r,/dependency.*missing/);
 }
 // Native registries must be parsed raw and uncapped, never through UI readers.
 const libraRegistry={};for(let i=0;i<337;i++)libraRegistry[`${host(i).characterId}::${host(i).chatId}`]={scopeKey:identity('libra',i),...host(i)};
 let r=await inspect('libra',{records:[row('libra:v1:scope-registry:v1',libraRegistry)]});ok(r);assert.equal(r.scopes.length,337);
 {
  const key='libra:v1:scope-registry:v1';
  const initial=libraRegistry['character_0::chat_0'], device=libraRegistry['character_1::chat_1'], remote=libraRegistry['character_2::chat_2'];
  const first={'character_0::chat_0':initial}, deviceOnly={'character_1::chat_1':device}, serverOnly={'character_2::chat_2':remote};
  const catalog={characters:[0,1,2].map(n=>({chaId:host(n).characterId,chats:[{id:host(n).chatId}]}))};
  const values=new Map([[key,JSON.stringify({...first,...deviceOnly})]]);
  const f=await fixture(variantFor('libra'),{values,catalog,current:identity('libra',0),adapter:adapters.libra,
    bridgeOptions:{pluginPrefixes:['libra:v1:'],resolveKeyScope:libraResolver}});
  const repo=f.app.repositories.libra;
  const setServer=(value,id)=>repo.mutate({kind:'set',space:'plugin',key,value:JSON.stringify(value),operationId:id});
  try {
   setServer({...first,...serverOnly},'registry_legacy_server');
   await f.bridge.setGlobalMode('server_only');
   const expected={...first,...deviceOnly,...serverOnly};
   assert.deepEqual(JSON.parse(repo.get('plugin',key).value),expected);
   const journalKey='__memory_suite_internal_sync_job_v1__:libra';
   const journal=JSON.parse(values.get(journalKey));delete journal.fastReplicas;
   values.set(journalKey,JSON.stringify(journal));await f.bridge.dispose();
   const cold=await fixture(variantFor('libra'),{app:f.app,values,catalog,current:identity('libra',0),adapter:adapters.libra,
     bridgeOptions:{pluginPrefixes:['libra:v1:'],resolveKeyScope:libraResolver}});
   try {
    assert.equal((await cold.bridge.setGlobalMode('plugin_only')).mode,'plugin_only');
    assert.deepEqual(JSON.parse(values.get(key)),expected);
   } finally { await cold.close(); }
   const route=await libraResolver({key});
   assert.equal(route.mergeModeTransferValue(JSON.stringify(first),JSON.stringify({'character_0::chat_0':{...initial,scopeKey:'different'}})),null);
  } finally { await f.close(); }
 }
 {
  const key='libra:v1:scope-registry:v1', identityKey='character_0::chat_0';
  const device={scopeKey:identity('libra',0),...host(0)}, server={...device,scopeKey:'server_alternate_scope'};
  const deviceManifest=root('libra',0);
  const remoteManifest='libra:v1:scope:'+server.scopeKey+':manifest';
  const remoteManifestValue=JSON.stringify({...JSON.parse(deviceManifest.value),scopeKey:server.scopeKey});
  const localOnly={'character_1::chat_1':libraRegistry['character_1::chat_1']};
  const serverOnly={'character_2::chat_2':libraRegistry['character_2::chat_2']};
  const catalog={characters:[0,1].map(n=>({chaId:host(n).characterId,chats:[{id:host(n).chatId}]}))};
  const values=new Map([[key,JSON.stringify({[identityKey]:device,...localOnly})],[deviceManifest.key,deviceManifest.value]]);
  const f=await fixture(variantFor('libra'),{values,catalog,current:device.scopeKey,adapter:adapters.libra,
    bridgeOptions:{pluginPrefixes:['libra:v1:'],resolveKeyScope:libraResolver}});
  const repo=f.app.repositories.libra;
  try {
   await f.bridge.setGlobalMode('server_only');
   repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',deviceManifest.key);
   repo.mutate({kind:'set',space:'plugin',key:remoteManifest,value:remoteManifestValue,operationId:'alternate_libra_manifest'});
   repo.mutate({kind:'set',space:'plugin',key,value:JSON.stringify({[identityKey]:server,...serverOnly}),operationId:'alternate_libra_registry'});
   await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),e=>{
    assert.equal(e.details?.review?.key,key,JSON.stringify(e.details));
    return e.details.registryConflicts?.some(binding=>binding.plugin===device.scopeKey&&binding.server===server.scopeKey);
   });
   const failed=f.bridge.getSyncJob();
   assert.equal((await f.bridge.retryGlobalModeFailure(failed.jobId,'server')).mode,'plugin_only');
   assert.deepEqual(JSON.parse(values.get(key)),{[identityKey]:server,...localOnly,...serverOnly});
   assert.equal(values.get(deviceManifest.key),deviceManifest.value);
   assert.equal(values.get(remoteManifest),remoteManifestValue);
   assert.equal(JSON.parse(values.get(f.registryKey)).entries[device.scopeKey].registryAlternateFor,server.scopeKey);
   const next=await f.bridge.previewGlobalMode('server_only');
   assert.equal(next.completeKnownScopes,true,JSON.stringify(next.blockers));
  } finally { await f.close(); }
 }
 r=await inspect('flashback',{records:[row('vector_rag_memory:scope_registry:v2',{version:2,scopes:Array.from({length:337},(_,i)=>({scopeKey:identity('flashback',i),...host(i)}))})]});ok(r);assert.equal(r.scopes.length,337);
 r=await inspect('flashback',{records:[row('vector_rag_memory:scope_registry:v2',{version:2,scopes:[{}]})]});blocked(r,/registry.*invalid|identity.*invalid/);
 // Existing LIBRA legacy index identities survive host enumeration unchanged.
 r=await inspect('libra',{hostScopes:[host(7)],records:[root('libra',7)]});ok(r);assert.deepEqual(Array.from(r.scopes,s=>s.scopeId),[identity('libra',7)]);
 // Hash collisions cannot silently join two Flashback physical stores.
 const f=root('flashback',1),v=JSON.parse(f.value);v.storageHash='wrong';f.value=JSON.stringify(v);
 r=await inspect('flashback',{records:[f]});blocked(r,/hash|identity/);
 // A committed Flashback manifest's implicit shard edge is mandatory.
 r=await inspect('flashback',{records:[root('flashback',1,{shardCount:1,count:1})]});blocked(r,/dependency.*missing/);
 // Native verified previous manifests retain their exact envelope and full recovery closure.
 const previous = manifest => row(manifest.key+':previous:v1',{schema:'flashback.previous_manifest.v1',scopeKey:JSON.parse(manifest.value).scopeKey,raw:manifest.value,digest:keyHash(manifest.value)});
 const previousEmpty=previous(root('flashback',1));
 r=await inspect('flashback',{records:[root('flashback',1),previousEmpty]});ok(r);assert.equal(r.records[1].classification,'scope');assert.equal(r.records[1].scopeId,identity('flashback',1));assert.equal(r.records[1].value,previousEmpty.value);assert.equal(Object.hasOwn(r.records[1],'logicalValue'),false);
 r=await inspect('flashback',{records:[{...previousEmpty,location:'server'}]});ok(r);assert.equal(r.scopes.length,1);assert.equal(r.scopes[0].scopeId,identity('flashback',1));assert.equal(r.scopes[0].detached,true);
 for(const mutate of [v=>{v.digest='wrong';},v=>{v.scopeKey=identity('flashback',2);},v=>{v.raw='{malformed';v.digest=keyHash(v.raw);},v=>{const inner=JSON.parse(v.raw);inner.scopeKey=identity('flashback',2);v.raw=JSON.stringify(inner);v.digest=keyHash(v.raw);},v=>{v.schema='flashback.previous_manifest.v99';}]) {
  const badPrevious=clone(previousEmpty),outer=JSON.parse(badPrevious.value);mutate(outer);badPrevious.value=JSON.stringify(outer);
  r=await inspect('flashback',{records:[root('flashback',1),badPrevious]});blocked(r,/previous.*invalid|identity/);
 }
 const previousPopulated=previous(root('flashback',1,{commitId:'retained',count:1,shardCount:1})),previousShard=`vector_rag_memory:scope:${keyHash(identity('flashback',1))}:records:commit:retained:shard:0000`;
 r=await inspect('flashback',{records:[root('flashback',1),previousPopulated]});blocked(r,/dependency.*missing/);
 r=await inspect('flashback',{records:[root('flashback',1),previousPopulated,row(previousShard,{scopeKey:identity('flashback',1),records:[]})]});ok(r);assert.ok(r.records[1].dependencyKeys.includes(previousShard));
 const previousArchiveScope='flashback_archive_v1:retained',previousArchiveKey=`vector_rag_memory:scope:${keyHash(previousArchiveScope)}:manifest:v2`;
 const previousArchive=previous(root('flashback',1,{archiveRef:{archiveId:'retained',archiveScopeKey:previousArchiveScope}}));
 r=await inspect('flashback',{records:[root('flashback',1),previousArchive]});blocked(r,/dependency.*missing/);
 r=await inspect('flashback',{records:[root('flashback',1),previousArchive,row(previousArchiveKey,{schema:'vector_rag_memory.scope_manifest.v2',scopeKey:previousArchiveScope,archiveId:'retained',archiveOwner:true,count:0,shardCount:0,shardSummaries:[]})]});ok(r);assert.ok(r.records[2].dependencyScopeIds.includes(identity('flashback',1)));
 r=await inspect('flashback',{records:[root('flashback',1),{...previousEmpty,location:'server',deleted:true,value:null,scopeId:identity('flashback',1)}]});ok(r);assert.equal(r.records[1].classification,'scope');
 // Legacy persona scopes remain distinct and are not reassigned to the host.
 const legacy=`${identity('flashback',1)}|persona:old`,lf=root('flashback',1);lf.key=lf.logicalKey=`vector_rag_memory:scope:${keyHash(legacy)}:manifest:v2`;lf.value=JSON.stringify({...JSON.parse(lf.value),scopeKey:legacy,storageHash:keyHash(legacy)});
 r=await inspect('flashback',{hostScopes:[host(1)],records:[lf]});ok(r);assert.ok(r.scopes.some(s=>s.scopeId===legacy));
 // Missing HAYAKU hashed evidence manifests always block, even for a known scope.
 const hk=identity('hayaku',1);
 r=await inspect('hayaku',{records:[root('hayaku',1),row('hayaku.v2.recovery_evidence_chunk.orphan::user::0',{schema:'hayaku.recovery_evidence_chunk.v1',scopeKey:hk,recordId:'record',role:'user',ordinal:0,body:'text'})]});blocked(r,/evidence.*missing|evidence.*invalid/);
 // LIBRA archive dependency closure includes immutable memory and local vector payload.
 const archive='libra:v1:shared-archive:archive:manifest',memory='libra:v1:shared-archive:archive:memory:one:r1',vector='libra:v1:shared-archive:archive:vector:one:r1:p',local='libra:v1:local-vector:payload';
 r=await inspect('libra',{records:[root('libra',1,{archiveRef:{archiveId:'archive',manifestKey:archive}}),row(archive,{schema:'libra.shared_archive.v1',archiveId:'archive',memoryRefs:[{key:memory,vectorKey:vector,status:'committed'}]}),row(memory,{schema:'libra.canonical_memory.v1',memoryId:'one'}),row(vector,{localVectorRef:{localKey:local}}),row(local,{data:[1,2]},{space:'local',location:'device'})]});ok(r);for(const rec of r.records.slice(1))assert.ok(rec.dependencyScopeIds.includes(identity('libra',1)));
 r=await inspect('libra',{records:[row('libra:v1:local-vector:unowned',{data:[1]})]});blocked(r,/ownership|unresolved/);

 // HAYAKU evidence hashes, canonical chunk membership and full role payloads.
 const evidence=(scopeKey)=>{
  const bodies={user:'user evidence',assistant:'assistant evidence'},recordId='evidence-record';
  const base=stableHash64([scopeKey,recordId,stableHash64(bodies.user),stableHash64(bodies.assistant)].join('\u0001'));
  const mk='hayaku.v2.recovery_evidence_manifest.'+base,roles={},chunks=[];
  for(const role of ['user','assistant']){const body=bodies[role],key=`hayaku.v2.recovery_evidence_chunk.${base}::${role}::0`,bytes=Buffer.byteLength(body),hash=stableHash64(body);
   const d={key,ordinal:0,chars:body.length,bytes,hash};roles[role]={chars:body.length,bytes,hash,canonicalHash:'canonical',chunkCount:1,chunkKeys:[key],chunks:[d]};
   chunks.push(row(key,{schema:'hayaku.recovery_evidence_chunk.v1',scopeKey,recordId,role,ordinal:0,body,bodyChars:body.length,bodyBytes:bytes,bodyHash:hash}));}
  const m={schema:'hayaku.recovery_evidence_manifest.v1',version:1,pluginVersion:'test',scopeKey,recordId,debtId:recordId,pairIndex:1,userCanonicalHash:'canonical',assistantCanonicalHash:'canonical',evidenceHash:stableHash64([roles.user.hash,roles.assistant.hash].join('\u0001')),roles};
  m.manifestHash=stableHash64(JSON.stringify(m));return [row(mk,m),...chunks];
 };
 const evidenceRows=evidence(hk);r=await inspect('hayaku',{records:[root('hayaku',1),...evidenceRows]});ok(r);assert.ok(r.records.slice(1).every(x=>x.scopeId===hk));
 const tampered=clone(evidenceRows);const chunk=JSON.parse(tampered[1].value);chunk.body+=' changed';tampered[1].value=JSON.stringify(chunk);
 r=await inspect('hayaku',{records:[root('hayaku',1),...tampered]});blocked(r,/evidence.*invalid|evidence.*digest/);
 r=await inspect('hayaku',{records:[root('hayaku',1),evidenceRows[0],evidenceRows[1]]});blocked(r,/evidence.*missing|dependency.*missing/);
 // Compressed HAYAKU archive bodies expose parent closure without touching caches.
 const ha='hayaku.v2.shared_archive.archive',hm='hayaku.v2.shared_archive_meta.archive';
 const haBody=JSON.stringify({schema:'hayaku.shared_archive.v1',archiveId:'archive',records:[]});
 const gzip={schema:'hayaku.shared_archive.gzip.v1',archiveId:'archive',encoding:'gzip+base64',rawChars:haBody.length,rawHash:stableHash64(haBody),data:zlib.gzipSync(haBody).toString('base64')};
 r=await inspect('hayaku',{records:[root('hayaku',1,{archiveRef:{archiveId:'archive',storageKey:ha,metaKey:hm}}),row(ha,gzip),row(hm,{schema:'hayaku.shared_archive_meta.v1',archiveId:'archive'})]});ok(r);assert.ok(r.records[1].dependencyScopeIds.includes(hk));
 // Chunked LIBRA roots are inspected logically, with physical values unchanged.
 const large={...JSON.parse(root('libra',1).value),padding:'x'.repeat(524288)},body=JSON.stringify(large),base=root('libra',1).key,chunkKeys=[`${base}::chunk:v1:stamp:0000`,`${base}::chunk:v1:stamp:0001`];
 const envelope={__libraChunkedStorageV1:true,schemaVersion:1,key:base,length:body.length,chunks:chunkKeys};
 r=await inspect('libra',{records:[row(base,envelope),...chunkKeys.map((k,i)=>row(k,body.slice(i*524288,(i+1)*524288),{artifact:true,artifactOwnerKey:base}))]});ok(r);assert.equal(r.records[0].value,JSON.stringify(envelope));assert.equal(r.records[0].logicalValue,body);
 r=await inspect('libra',{records:[row(base,envelope),row(chunkKeys[0],body.slice(0,524288),{artifact:true,artifactOwnerKey:base})]});blocked(r,/chunk.*missing|dependency.*missing/);

 const vectorScope=identity('libra',1),vectorKey=`libra:v1:scope:${vectorScope}:vector:old:r1:profile`;
 const localVectorKey='libra:v1:local-vector:'+stableDraftHash(vectorKey);
 const vectorPayload={schema:'libra.local_vector_payload.v1',localKey:localVectorKey,storageKey:vectorKey,vectorHash:'vector-proof',data:'AACAPw=='};
 const deviceVector=row(localVectorKey,vectorPayload,{location:'device',space:'local'});
 const serverVector=payload=>row(vectorKey,{schema:'libra.embedding_projection.v2',scopeKey:vectorScope,
  localVectorRef:{localKey:localVectorKey,storageKey:vectorKey,vectorHash:'vector-proof'},vectorPayloadPortable:!!payload,
  ...(payload?{portableVectorPayload:payload}:{})},{location:'server'});
 r=await inspect('libra',{records:[root('libra',1),deviceVector]});ok(r);
 assert.equal(r.records[1].classification,'shared','ordinary forward transfer still owns the sidecar');
 assert.equal(r.records[1].retainDeviceCacheAfterReset,true,'an unreferenced device vector is harmless');
 r=await inspect('libra',{records:[root('libra',1),deviceVector,serverVector(vectorPayload)]});ok(r);
 assert.equal(r.records[1].retainDeviceCacheAfterReset,true,'a portable server vector does not require the cache');
 const serverCache={...deviceVector,location:'server'};
 r=await inspect('libra',{records:[root('libra',1),deviceVector,serverVector(vectorPayload),serverCache]});ok(r);
 assert.equal(r.records[3].retainDeviceCacheAfterReset,true,'the matching server cache is also independent');
 assert.equal(r.records[3].vectorCacheStorageKey,vectorKey);
 r=await inspect('libra',{records:[root('libra',1),deviceVector,serverVector(null),serverCache]});ok(r);
 assert.equal(r.records[3].retainDeviceCacheAfterReset,undefined,'a required server sidecar cannot be treated as a cache');
 const explicitCacheDependency=serverVector(vectorPayload);
 explicitCacheDependency.value=JSON.stringify({...JSON.parse(explicitCacheDependency.value),dependencyKey:localVectorKey});
 r=await inspect('libra',{records:[root('libra',1),deviceVector,explicitCacheDependency,serverCache]});ok(r);
 assert.equal(r.records[3].retainDeviceCacheAfterReset,undefined,'an explicit cache dependency remains required');
 r=await inspect('libra',{records:[root('libra',1),deviceVector,serverVector(null)]});blocked(r,/dependency_missing/);
 assert.equal(r.records[1].retainDeviceCacheAfterReset,undefined,'a required legacy sidecar is not exempted');
 r=await inspect('libra',{records:[root('libra',1),deviceVector,serverVector({...vectorPayload,data:''})]});
 assert.equal(r.records[1].retainDeviceCacheAfterReset,undefined,'a portable marker without bytes does not exempt a required sidecar');

 for(const owner of Object.keys(adapters)) {
  r=await inspect(owner,{records:[root(owner,1,{archiveRef:'corrupt pointer'})]});blocked(r,/archive.*invalid/);
 }
 r=await inspect('hayaku',{records:[root('hayaku',1),row('hayaku.v2.recovery_evidence_manifest.deleted',null,{location:'server',deleted:true,scopeId:hk})]});ok(r);assert.equal(r.records[1].classification,'scope');assert.ok(r.records[1].dependencyScopeIds.includes(hk));

 const microKey='libra:v1:micro-handoff-archive:transfer',inlineKey=`libra:v1:scope:${identity('libra',1)}:micro-memory:main:e0:t1:r1:a1`;
 r=await inspect('libra',{records:[root('libra',1,{inheritedMicroArchives:[{archiveKey:microKey,sourceScopeKey:identity('libra',1)}]}),row(microKey,{schema:'libra.micro_handoff_archive.v1',sourceScopeKey:identity('libra',1),records:[{key:inlineKey,value:{schema:'libra.micro_memory.v1',scopeKey:identity('libra',1),claims:[]}}]})]});ok(r);
 r=await inspect('flashback',{records:[row('vector_rag_memory:scope_registry:v2',{version:2,scopes:[{scopeKey:identity('flashback',1),storageHash:'wrong',...host(1)}]})]});blocked(r,/hash|identity/);
 r=await inspect('hayaku',{records:[root('hayaku',1),row(`hayaku.v2.failed_analysis_chunk.${hk}::failure::0`,{schema:'hayaku.failed_analysis_chunk.v1',scopeKey:hk,failureId:'failure',ordinal:0,body:'payload',bodyHash:stableHash64('payload')})]});blocked(r,/manifest.*missing|dependency.*missing/);

 const la='libra:v1:shared-archive:cycleA:manifest',lb='libra:v1:shared-archive:cycleB:manifest';
 r=await inspect('libra',{records:[root('libra',1,{archiveRef:{archiveId:'cycleA',manifestKey:la}}),row(la,{schema:'libra.shared_archive.v1',archiveId:'cycleA',memoryRefs:[],parentRef:{archiveId:'cycleB',manifestKey:lb}}),row(lb,{schema:'libra.shared_archive.v1',archiveId:'cycleB',memoryRefs:[],parentRef:{archiveId:'cycleA',manifestKey:la}})]});blocked(r,/archive.*cycle/);
 r=await inspect('libra',{records:[root('libra',1,{archiveRef:{archiveId:'not-an-archive',manifestKey:root('libra',1).key}})]});blocked(r,/archive.*invalid/);

 for(const owner of Object.keys(adapters)) {
  const active={scopeId:identity(owner,1),scopeKey:identity(owner,1),...host(1)},removed={scopeId:identity(owner,2),scopeKey:identity(owner,2),...host(2),removed:true};
  r=await inspect(owner,{registries:[{entries:{__memory_suite_global__:{scopeId:'__memory_suite_global__',global:true},[active.scopeId]:active,[removed.scopeId]:removed}}]});ok(r);assert.deepEqual(Array.from(r.scopes,s=>s.scopeId),[active.scopeId]);
  r=await inspect(owner,{records:[root(owner,2)],registries:[{entries:{[removed.scopeId]:removed}}]});ok(r);assert.deepEqual(Array.from(r.scopes,s=>s.scopeId),[removed.scopeId]);
 }
 r=await inspect('libra',{records:[row(base,envelope),...chunkKeys.map((k,i)=>row(k,body.slice(i*524288,(i+1)*524288),{artifact:true,artifactOwnerKey:base,logicalKey:base}))]});ok(r);assert.equal(r.records[0].logicalValue,body);
 r=await inspect('flashback',{hostScopes:[host(1)]});ok(r);assert.equal(r.scopes[0].canonicalScopeId,identity('flashback',1));
 r=await inspect('libra',{records:[row('libra:v1:migration:remove-world-additional:v1',{completed:true})]});ok(r);assert.equal(r.records[0].classification,'control');

 // Real legacy forms from the mode-switch diagnostics, with synthetic identities.
 {
  const libraHost=host(1),nativeIdentity=libraHost.characterId+':'+libraHost.chatId;
  const libraScope=identity=>stableDraftHash(identity+'|'+libraHost.characterId+'|'+libraHost.chatId)+'_'+identity;
  const manifestAt=scopeKey=>row(`libra:v1:scope:${scopeKey}:manifest`,{...JSON.parse(root('libra',1).value),scopeKey});
  const oldScope=libraScope('1:0'),newScope=libraScope(nativeIdentity);
  const oldGraph=row(`libra:v1:scope:${oldScope}:memory-graph:v1:corpus:page:adjacency:retired`,'retired payload',{location:'server'});
  const oldGraphRoot=row(`libra:v1:scope:${oldScope}:memory-graph-control:v1:root`,{},{location:'server'});
  const placeState=row(`libra:v1:scope:${oldScope}:continuity-state`,{scopeKey:oldScope,world:[{state:{parentRef:'place'},fieldEvidence:{parentRef:{schema:'field-evidence'}}}]});
  const absentKey=`libra:v1:scope:${oldScope}:state-worldline-meta:v1`;
  const memoryWithRead=exists=>row(`libra:v1:scope:${oldScope}:memory:1:r1`,{schema:'libra.canonical_memory.v1',scopeKey:oldScope,
   unifiedBasis:{serverReadSet:{schema:'memory-suite.storage.read-set.v1',records:[{scopeId:oldScope,key:absentKey,remoteKey:absentKey,exists}]}}});
  const cancelledJob=state=>row(`libra:v1:scope:${oldScope}:canonical-job:job`,{schema:'libra.canonical_job.v1',scopeKey:oldScope,state,comparison:{candidate:{key:`libra:v1:scope:${oldScope}:memory:1:r2`}}});
  r=await inspect('libra',{hostScopes:[libraHost],records:[manifestAt(oldScope),manifestAt(newScope),oldGraph,oldGraphRoot,placeState,memoryWithRead(false),cancelledJob('cancelled')]});
  ok(r);assert.equal(r.scopes.length,2);assert.equal(r.records[2].classification,'control');assert.equal(r.records[3].classification,'control');
  r=await inspect('libra',{records:[manifestAt(oldScope),manifestAt('unverified-alias')]});blocked(r,/identity_conflict/);
  r=await inspect('libra',{records:[manifestAt(oldScope),memoryWithRead(true),cancelledJob('awaiting_edit')]});
  blocked(r,/dependency_missing/);assert.equal(r.blockers.filter(x=>x.code==='libra_global_dependency_missing').length,2);

  const archiveId='portable',archiveScope='archive:'+archiveId;
  const archiveKey=`libra:v1:shared-archive:${archiveId}:manifest`;
  const archiveBodyKey=`libra:v1:shared-archive:${archiveId}:memory:m:r1`;
  const vectorKey=`libra:v1:scope:${archiveScope}:vector:m:r1:profile`;
  const vectorSidecarKey='libra:v1:local-vector:'+stableDraftHash(vectorKey);
  const pointer={key:archiveBodyKey,memoryId:'m',revision:1,sourceDigest:'proof',status:'committed',vectorKey:'libra:v1:shared-archive:portable:vector:m:r1:old'};
  const sidecar={schema:'libra.local_vector_payload.v1',storageKey:vectorKey,localKey:vectorSidecarKey,vectorHash:'vector-proof',byteLength:4,data:'AACAPw=='};
  const archiveRows=[
   root('libra',1,{archiveRef:{archiveId,manifestKey:archiveKey}}),
   row(archiveKey,{schema:'libra.shared_archive.v1',archiveId,memoryRefs:[pointer]}),
   row(archiveBodyKey,{schema:'libra.canonical_memory.v1',archiveId,archiveCanonicalId:'m',scopeKey:archiveScope,memoryId:'m',revision:1,sourceDigest:'proof',status:'committed',embedding:{vectorKey}}),
   row(vectorSidecarKey,sidecar,{space:'local',location:'device'})
  ];
  const projection=memoryId=>row(vectorKey,{schema:'libra.embedding_projection.v2',scopeKey:archiveScope,memoryId,revision:1,
   vectorPayloadPortable:true,portableVectorPayload:sidecar,localVectorRef:sidecar},{location:'server'});
  r=await inspect('libra',{records:[...archiveRows,projection('m')]});ok(r);assert.ok(r.records[3].dependencyScopeIds.includes(identity('libra',1)));
  r=await inspect('libra',{records:[...archiveRows,projection('wrong-memory')]});blocked(r,/dependency_missing/);

  const flashScope=identity('flashback',1);
  const flashRouting=characterId=>[{entries:{[flashScope]:{scopeId:flashScope,characterId,chatId:host(1).chatId}}}];
  const flashNative=root('flashback',1,{characterId:'historical-character-id'});
  r=await inspect('flashback',{hostScopes:[host(1)],registries:flashRouting(host(1).characterId),records:[flashNative]});
  ok(r);assert.equal(r.scopes[0].characterId,host(1).characterId);
  r=await inspect('flashback',{registries:flashRouting('unverified-character-id'),records:[flashNative]});blocked(r,/identity_conflict/);

  const digest=stableHash64('retained-record');
  const hayakuArchiveId='hy_'+stableHash64(['',hk,1,digest,digest].join('\u0001')).slice(0,28);
  const hayakuArchiveKey='hayaku.v2.shared_archive.'+hayakuArchiveId,hayakuMetaKey='hayaku.v2.shared_archive_meta.'+hayakuArchiveId;
  const layer={archiveId:hayakuArchiveId,generation:1,depth:1,deltaCount:1,deltaDigest:digest,recordCount:1,digest,parentRef:null};
  const hayakuArchive=scope=>row(hayakuArchiveKey,{...layer,schema:'hayaku.shared_archive.v1',records:[{inheritedViaScopeKey:scope,archiveCanonicalId:'retained-record'}]});
  const hayakuMeta=row(hayakuMetaKey,{...layer,schema:'hayaku.shared_archive_meta.v1',storageKey:hayakuArchiveKey,metaKey:hayakuMetaKey,deltaMemberIds:['retained-record']});
  r=await inspect('hayaku',{records:[root('hayaku',1),hayakuArchive(hk),hayakuMeta]});ok(r);
  assert.ok(r.records.slice(1).every(entry=>entry.dependencyScopeIds.includes(hk)&&entry.retainLocalArchive===true));
  const originals=[root('hayaku',1),hayakuArchive(hk),hayakuMeta];
  const f=await fixture(variantFor('hayaku'),{values:new Map(originals.map(entry=>[entry.key,entry.value])),
    catalog:{characters:[{chaId:host(1).characterId,chats:[{id:host(1).chatId}]}]},current:hk,adapter:adapters.hayaku});
  try {
   await f.bridge.setGlobalMode('server_only');
   const repo=f.app.repositories.hayaku;
   const remove=repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?');
   remove.run('plugin',hayakuArchiveKey);remove.run('plugin',hayakuMetaKey);
   const active=root('hayaku',1,{archiveRef:{archiveId:hayakuArchiveId,storageKey:hayakuArchiveKey,metaKey:hayakuMetaKey}});
   repo.mutate({kind:'set',space:'plugin',key:active.key,value:active.value,operationId:'active_archive_reference'});
   await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),error=>error.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE'
     &&error.details.blockers.some(row=>row.code==='hayaku_global_dependency_missing'));
   assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
   repo.mutate({kind:'set',space:'plugin',key:active.key,value:originals[0].value,operationId:'drop_archive_reference'});
   assert.equal((await f.bridge.setGlobalMode('plugin_only')).mode,'plugin_only');
   for(const entry of originals.slice(1))assert.equal(f.values.get(entry.key),entry.value);
   assert.equal(repo.get('plugin',hayakuArchiveKey).exists,false);
   await f.bridge.setGlobalMode('server_only');
   repo.mutate({kind:'set',space:'plugin',key:active.key,value:active.value,operationId:'referenced_archive_repair'});
   remove.run('plugin',hayakuArchiveKey);remove.run('plugin',hayakuMetaKey);
   await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),e=>e.details?.review?.kind==='restore');
   const firstRepair=f.bridge.getSyncJob();
   await assert.rejects(()=>f.bridge.retryGlobalModeFailure(firstRepair.jobId,'restore'),
     e=>e.details?.review?.kind==='restore'&&e.details.review.key!==firstRepair.errorDetails.review.key);
   const secondRepair=f.bridge.getSyncJob();
   assert.equal((await f.bridge.retryGlobalModeFailure(secondRepair.jobId,'restore')).mode,'plugin_only');
   for(const entry of originals.slice(1))assert.equal(repo.get('plugin',entry.key).value,entry.value);
  } finally { await f.close(); }
  r=await inspect('hayaku',{records:[root('hayaku',1),root('hayaku',2),hayakuArchive(identity('hayaku',2)),hayakuMeta]});blocked(r,/shared_ownership_unresolved/);
 }

 for(const [suffix,schema] of [['unified-migration:v1','libra.unified_migration.v1'],['planner-narrative-direction:v1','libra.planner_narrative_direction.v1'],['story-arc-migration:v1','libra.story_arc_migration.v1'],['embedding-metadata-migration:v1','libra.embedding_metadata_migration_journal.v1']]) {
  r=await inspect('libra',{records:[root('libra',1),row(`libra:v1:scope:${identity('libra',1)}:${suffix}`,{schema,scopeKey:identity('libra',1),rows:[]})]});ok(r);assert.equal(r.records[1].classification,'scope');
 }
 const archiveEvidence='libra:v1:scope:archive:archive:source-evidence:v1:evidence';
 r=await inspect('libra',{records:[root('libra',1,{archiveRef:{archiveId:'archive',manifestKey:archive}}),row(archive,{schema:'libra.shared_archive.v1',archiveId:'archive',memoryRefs:[{key:memory,status:'committed'}]}),row(memory,{schema:'libra.canonical_memory.v1',memoryId:'one',scopeKey:'archive:archive',sourceEvidenceRef:{key:archiveEvidence}}),row(archiveEvidence,{schema:'memory-suite.source-evidence.v1',owner:'libra',binding:{scopeKey:'archive:archive'},payloadDigest:'fixture'})]});ok(r);assert.equal(r.scopes.length,1);assert.equal(r.records[3].classification,'shared');assert.ok(r.records[3].dependencyScopeIds.includes(identity('libra',1)));
 // Real storage families reported by users must not disappear from the inventory.
 const projectionScope=identity('libra',1);
 const projectionKeys=['state-projection','state-projection-cache:index','state-projection-cache:cac4bb9b:457'];
 r=await inspect('libra',{records:[root('libra',1),...projectionKeys.map(suffix=>row(`libra:v1:scope:${projectionScope}:${suffix}`,{scopeKey:projectionScope,derived:true}))]});ok(r);
 assert.ok(r.records.every(rec=>rec.scopeId===projectionScope));
 const legacyArchiveVector='libra:v1:scope:archive:archive:vector:arc_cd285af8:6282:r2:lep_ftk24b';
 const archiveInputs=[root('libra',1,{archiveRef:{archiveId:'archive',manifestKey:archive}}),row(archive,{schema:'libra.shared_archive.v1',archiveId:'archive',memoryRefs:[{key:memory}]}),row(memory,{schema:'libra.canonical_memory.v1',embedding:{vectorKey:legacyArchiveVector}}),row(legacyArchiveVector,{scopeKey:'archive:archive',data:[1,2]})];
 r=await inspect('libra',{records:archiveInputs});ok(r);assert.equal(r.scopes.length,1);assert.ok(r.records[3].dependencyScopeIds.includes(projectionScope));
 const wrongArchive=clone(archiveInputs);wrongArchive[3].value=JSON.stringify({scopeKey:'archive:other'});
 r=await inspect('libra',{records:wrongArchive});blocked(r,/archive_vector_identity/);
 r=await inspect('libra',{records:[archiveInputs[3]]});blocked(r,/ownership/);
 const removedMemory=`libra:v1:scope:${projectionScope}:memory:5:r1`,removedVector=`libra:v1:scope:${projectionScope}:vector:old:r1:p`;
 const run=row(`libra:v1:scope:${projectionScope}:run:run_msmzudpk_362ndub`,{schema:'libra.execution_run.v1',scopeKey:projectionScope,status:'complete',commit:{status:'committed',memoryKey:removedMemory},embedding:{vectorKey:removedVector}});
 r=await inspect('libra',{records:[root('libra',1),run]});ok(r);assert.equal(r.records[1].value,run.value);
 r=await inspect('libra',{records:[root('libra',1,{memories:{old:{key:removedMemory}}}),run]});blocked(r,/dependency_missing/);
 const packageRow=row('libra:v1:handoff:8f03ce61-8a52-47df-bb19-595ca155fc98',{schema:'libra.session_handoff.package.v1',source:{scope:{scopeKey:projectionScope}},archiveRef:{archiveId:'archive',manifestKey:archive},memoryRefs:[{key:memory}],continuityStateSeed:{provenance:{memoryKey:removedMemory}},storyArcSeed:{sources:[{key:removedMemory}]}});
 r=await inspect('libra',{records:[...archiveInputs,packageRow]});ok(r);
 r=await inspect('libra',{records:[root('libra',1),packageRow]});blocked(r,/dependency_missing/);
 // Required Flashback shards still block and name exactly what is absent.
 const missingShard=`vector_rag_memory:scope:${keyHash(identity('flashback',1))}:records:commit:missing:shard:0000`;
 r=await inspect('flashback',{records:[root('flashback',1,{commitId:'missing',shardCount:1,count:1})]});blocked(r,/dependency_missing/);assert.ok(r.blockers.some(x=>x.detail===missingShard));assert.equal(r.blockers.find(x=>x.detail===missingShard).manifestState.commitId,'missing');assert.deepEqual(Array.from(r.blockers.find(x=>x.detail===missingShard).manifestState.observedShardKeys),[]);
 const invalidRegistry=row('vector_rag_memory:scope_registry:v2',{version:2,scopes:[{scopeKey:identity('flashback',1),storageHash:'stale',chatBody:'never print this'}]});
 r=await inspect('flashback',{records:[invalidRegistry]});blocked(r,/native_registry_identity_invalid/);assert.ok(r.blockers[0].detail.includes('stale'));assert.ok(!JSON.stringify(r.blockers).includes('never print this'));
 // Stale archive index vector hints must follow the verified canonical memory,
 // including indexes embedded in handoff packages and recipient manifests.
 const archiveId='la_021fd569',archiveKey=`libra:v1:shared-archive:${archiveId}:manifest`;
 const canonicalId='cd285af8:6282',memoryKey=`libra:v1:shared-archive:${archiveId}:memory:${canonicalId}:r2`;
 const staleVector=`libra:v1:shared-archive:${archiveId}:vector:${canonicalId}:r2:lep_9by1h4`;
 const retainedVector=`libra:v1:scope:archive:${archiveId}:vector:arc_cd285af8:6282:r2:lep_ftk24b`;
 const indexedRef={key:memoryKey,memoryId:'arc_cd285af8:6282',revision:2,status:'committed',vectorKey:staleVector,sourceDigest:'source'};
 const indexedMemory={schema:'libra.canonical_memory.v1',memoryId:indexedRef.memoryId,revision:2,sourceDigest:'source',scopeKey:`archive:${archiveId}`,archiveId,archiveCanonicalId:canonicalId,embedding:{status:'ready',vectorKey:retainedVector}};
 const pointer={archiveId,manifestKey:archiveKey};
 const staleIndexInputs=[root('libra',1,{archiveRef:pointer,inheritedMemories:[indexedRef]}),row(archiveKey,{schema:'libra.shared_archive.v1',archiveId,memoryRefs:[indexedRef]}),row(memoryKey,indexedMemory),row(retainedVector,{scopeKey:`archive:${archiveId}`,memoryId:indexedRef.memoryId,revision:2,data:[1,2]}),row('libra:v1:handoff:stale-vector-index',{schema:'libra.session_handoff.package.v1',sourceScopeKey:projectionScope,archiveRef:pointer,memoryRefs:[indexedRef]})];
 r=await inspect('libra',{records:staleIndexInputs});ok(r);assert.equal(r.scopes.length,1);
 for(let i=0;i<staleIndexInputs.length;i++)assert.equal(r.records[i].value,staleIndexInputs[i].value,'archive/index bytes and digests are preserved');
 for(const index of [0,1,4])assert.ok(r.records[index].dependencyKeys.includes(retainedVector));
 r=await inspect('libra',{records:staleIndexInputs.filter(x=>x.key!==retainedVector)});blocked(r,/dependency_missing/);
 const foreignMemory=clone(staleIndexInputs);foreignMemory[2].value=JSON.stringify({...indexedMemory,sourceDigest:'foreign'});
 r=await inspect('libra',{records:foreignMemory});blocked(r,/dependency_missing/);
 const missingMemory=staleIndexInputs.filter(x=>x.key!==memoryKey);
 r=await inspect('libra',{records:missingMemory});blocked(r,/dependency_missing/);
 // Quarantine cleanup clears the canonical pointer but historical indexes keep
 // their old vectorKey. A proved pending memory can migrate without that vector.
 const pendingArchiveInputs=clone(staleIndexInputs).filter(x=>x.key!==retainedVector);
 pendingArchiveInputs[2].value=JSON.stringify({...indexedMemory,status:'committed',embedding:{status:'rebuild_required',vectorKey:'',vectorCount:0}});
 for(const index of [0,1,3]) {
  const value=JSON.parse(pendingArchiveInputs[index].value);
  const refs=index===0?value.inheritedMemories:value.memoryRefs;
  for(const ref of refs){ref.embeddingStatus='rebuild_required';ref.vectorCount=0;}
  pendingArchiveInputs[index].value=JSON.stringify(value);
 }
 r=await inspect('libra',{records:pendingArchiveInputs});ok(r);
 for(let i=0;i<pendingArchiveInputs.length;i++)assert.equal(r.records[i].value,pendingArchiveInputs[i].value,'pending archive bytes are retained');
 assert.ok(r.records.every(rec=>!rec.dependencyKeys.includes(staleVector)),'retired vectors are not required for proved pending archives');
 const retryArchiveInputs=clone(pendingArchiveInputs),retryMemory=JSON.parse(retryArchiveInputs[2].value);
 retryMemory.embedding.status='retry_pending';retryArchiveInputs[2].value=JSON.stringify(retryMemory);
 r=await inspect('libra',{records:retryArchiveInputs});ok(r);
 for(const status of [undefined,'failed']) {
  const inputs=clone(pendingArchiveInputs),memory=JSON.parse(inputs[2].value);memory.status=status;inputs[2].value=JSON.stringify(memory);
  r=await inspect('libra',{records:inputs});blocked(r,/dependency_missing/);
 }
 const presentHistorical=[...pendingArchiveInputs,row(staleVector,{scopeKey:`archive:${archiveId}`,memoryId:indexedRef.memoryId,revision:2})];
 r=await inspect('libra',{records:presentHistorical});ok(r);assert.ok(r.records[0].dependencyKeys.includes(staleVector),'still-present historical vector is retained');
 for(const embedding of [{status:'ready',vectorKey:'',vectorCount:0},{status:'rebuild_required',vectorCount:0},{status:'rebuild_required',vectorKey:'',vectorCount:1},null]) {
  const inputs=clone(pendingArchiveInputs);inputs[2].value=JSON.stringify({...indexedMemory,status:'committed',embedding});
  r=await inspect('libra',{records:inputs});blocked(r,/dependency_missing/);
 }
 for(const patch of [{memoryId:'foreign'},{sourceDigest:'foreign'},{archiveCanonicalId:'foreign'},{scopeKey:'archive:foreign'},{revision:99}]) {
  const inputs=clone(pendingArchiveInputs);inputs[2].value=JSON.stringify({...JSON.parse(inputs[2].value),...patch});
  r=await inspect('libra',{records:inputs});blocked(r,/dependency_missing/);
 }
 r=await inspect('libra',{records:pendingArchiveInputs.map(x=>x.key===memoryKey?{...x,location:'server'}:x)});blocked(r,/dependency_missing/);
 // Canonical variant indexes retain the vector profile from their creation.
 // Re-embedding changes the verified memory body, not every historical index.
 const variantScope=identity('libra',1),variantMemoryKey=`libra:v1:scope:${variantScope}:memory:1:r1`;
 const variantOldVector=`libra:v1:scope:${variantScope}:vector:mem_000011:r1:lep_ftk24b`;
 const variantCurrentVector=`libra:v1:scope:${variantScope}:vector:mem_000011:r1:current-profile`;
 const variantRef={key:variantMemoryKey,memoryId:'mem_000011',revision:1,sourceDigest:'variant-proof',vectorKey:variantOldVector,deltaStatus:'missing_legacy'};
 const variantMemory={schema:'libra.canonical_memory.v1',scopeKey:variantScope,memoryId:variantRef.memoryId,revision:1,sourceDigest:variantRef.sourceDigest,turnRange:{start:1,end:5},embedding:{status:'ready',vectorKey:variantCurrentVector}};
 const variantInputs=[root('libra',1),row(`libra:v1:scope:${variantScope}:canonical-variants:v1`,{schema:'libra.canonical_variant_index.v1',scopeKey:variantScope,slots:{1:{variants:[variantRef]}}}),row(variantMemoryKey,variantMemory),row(variantCurrentVector,{scopeKey:variantScope,memoryId:variantRef.memoryId,revision:1})];
 r=await inspect('libra',{records:variantInputs});ok(r);assert.ok(r.records[1].dependencyKeys.includes(variantCurrentVector));
 for(let i=0;i<variantInputs.length;i++)assert.equal(r.records[i].value,variantInputs[i].value,'variant and memory bytes are preserved');
 r=await inspect('libra',{records:[...variantInputs,row(variantOldVector,{scopeKey:variantScope})]});ok(r);assert.ok(r.records[1].dependencyKeys.includes(variantOldVector),'existing historical vectors are retained too');
 r=await inspect('libra',{records:variantInputs.filter(x=>x.key!==variantCurrentVector)});blocked(r,/dependency_missing/);
 for(const patch of [{memoryId:'foreign'},{revision:2},{sourceDigest:'foreign'},{scopeKey:identity('libra',2)},{turnRange:{start:6,end:10}}]) {
  const changed=clone(variantInputs);changed[2].value=JSON.stringify({...variantMemory,...patch});
  r=await inspect('libra',{records:changed});blocked(r,/dependency_missing/);
 }
 r=await inspect('libra',{records:variantInputs.filter(x=>x.key!==variantMemoryKey)});blocked(r,/dependency_missing/);
 r=await inspect('libra',{records:variantInputs.map(x=>x.key===variantCurrentVector?{...x,location:'server'}:x)});blocked(r,/dependency_missing/);
 r=await inspect('libra',{records:variantInputs.map(x=>x.key===variantMemoryKey?{...x,location:'server'}:x)});blocked(r,/dependency_missing/);
 // A current scope can retain a committed canonical memory after quarantine
 // removed its vector. The stale variant hint must not block a source transfer.
 const pendingVariantInputs=clone(variantInputs).filter(x=>x.key!==variantCurrentVector);
 const pendingVariantMemory={...variantMemory,status:'committed',embedding:{status:'rebuild_required',vectorKey:'',vectorCount:0,
  profileId:'retired-profile',quarantinedProfileId:'retired-profile',provider:'voyageai',model:'voyage-4-large',dimensions:1024,
  reason:'previous quarantined vector deleted'}};
 const pendingManifestRef={...variantRef,status:'committed',embeddingStatus:'rebuild_required',vectorCount:0};delete pendingManifestRef.vectorKey;
 pendingVariantInputs[0].value=JSON.stringify({...JSON.parse(pendingVariantInputs[0].value),memories:{1:pendingManifestRef}});
 pendingVariantInputs[2].value=JSON.stringify(pendingVariantMemory);
 r=await inspect('libra',{records:pendingVariantInputs});ok(r);
 for(let i=0;i<pendingVariantInputs.length;i++)assert.equal(r.records[i].value,pendingVariantInputs[i].value,'quarantine-deleted current memory remains pending and unchanged');
 assert.ok(r.records.every(rec=>!rec.dependencyKeys.includes(variantOldVector)),'pending current memory needs no retired vector');
 r=await inspect('libra',{records:pendingVariantInputs.filter(x=>x.key!==variantMemoryKey)});blocked(r,/dependency_missing/);
 for(const patch of [{memoryId:'foreign'},{revision:2},{sourceDigest:'foreign'},{scopeKey:identity('libra',2)}]) {
  const inputs=clone(pendingVariantInputs);inputs[2].value=JSON.stringify({...pendingVariantMemory,...patch});
  r=await inspect('libra',{records:inputs});blocked(r,/dependency_missing/);
 }
 r=await inspect('libra',{records:pendingVariantInputs.map(x=>x.key===variantMemoryKey?{...x,location:'server'}:x)});blocked(r,/dependency_missing/);
 // registerCanonicalVariant stores {...memory, key}, and canonicalVariantEntry
 // preserves that snapshot, including embedding.vectorKey. Exercise the stored
 // shape as well as the older flat reference above.
 for(const inputs of [variantInputs,pendingVariantInputs]) for(const flatHint of [false,true]) {
  const snapshotInputs=clone(inputs),index=JSON.parse(snapshotInputs[1].value);
  const snapshot={...variantMemory,...variantRef,status:'inactive',embedding:{status:'ready',vectorKey:variantOldVector}};
  if(!flatHint)delete snapshot.vectorKey;
  index.slots[1].variants=[snapshot];snapshotInputs[1].value=JSON.stringify(index);
  r=await inspect('libra',{records:snapshotInputs});ok(r);
  assert.equal(r.records[1].value,snapshotInputs[1].value,'nested snapshot bytes remain unchanged');
  assert.ok(!r.records[1].dependencyKeys.includes(variantOldVector));
  if(inputs===variantInputs)assert.ok(r.records[1].dependencyKeys.includes(variantCurrentVector));
  r=await inspect('libra',{records:[...snapshotInputs,row(variantOldVector,{scopeKey:variantScope})]});ok(r);
  assert.ok(r.records[1].dependencyKeys.includes(variantOldVector),'existing nested historical vector is retained');
  r=await inspect('libra',{records:snapshotInputs.filter(x=>x.key!==variantMemoryKey)});blocked(r,/dependency_missing/);
  r=await inspect('libra',{records:snapshotInputs.map(x=>x.key===variantMemoryKey?{...x,location:'server'}:x)});blocked(r,/dependency_missing/);
  for(const patch of [{memoryId:'foreign'},{revision:2},{sourceDigest:'foreign'},{scopeKey:identity('libra',2)},{turnRange:{start:6,end:10}}]) {
   const changed=clone(snapshotInputs);changed[2].value=JSON.stringify({...JSON.parse(changed[2].value),...patch});
   r=await inspect('libra',{records:changed});blocked(r,/dependency_missing/);
  }
 }
 // An embedding object outside a validated variant slot is not a historical hint.
 const unboundSnapshot=clone(pendingVariantInputs),unboundIndex=JSON.parse(unboundSnapshot[1].value);
 unboundIndex.embedding={vectorKey:variantOldVector};unboundSnapshot[1].value=JSON.stringify(unboundIndex);
 r=await inspect('libra',{records:unboundSnapshot});blocked(r,/dependency_missing/);
 // The reported three stale pointers span two colon-containing scope IDs,
 // including an r1 variant after the manifest has advanced that slot to r2.
 const reportedVariants=[];
 for(const [scopeKey,starts] of [['212e5cbd_7:1',[11]],['963560b0_24:0',[1,6]]]) {
  const manifest={...JSON.parse(root('libra',reportedVariants.length).value),scopeKey,memories:{}},slots={};
  for(const start of starts) {
   const memoryId='mem_'+String(start).padStart(6,'0'),key=`libra:v1:scope:${scopeKey}:memory:${start}:r1`;
   const memory={schema:'libra.canonical_memory.v1',scopeKey,memoryId,revision:1,sourceDigest:'synthetic-'+start,status:'committed',turnRange:{start,end:start+4},embedding:{status:'rebuild_required',vectorKey:'',vectorCount:0}};
   const snapshot={...memory,key,status:'inactive',deltaStatus:'missing_legacy',embedding:{status:'ready',vectorKey:`libra:v1:scope:${scopeKey}:vector:${memoryId}:r1:lep_ftk24b`}};
   slots[start]={variants:[snapshot]};reportedVariants.push(row(key,memory));
   if(start===6) {
    const latest={...memory,revision:2,sourceDigest:'synthetic-r2'},latestKey=`libra:v1:scope:${scopeKey}:memory:${start}:r2`;
    manifest.memories[start]={...latest,key:latestKey,history:[{key,revision:1,sourceDigest:memory.sourceDigest,status:'inactive'}]};
    reportedVariants.push(row(latestKey,latest));
   }else manifest.memories[start]={...memory,key};
  }
  reportedVariants.push(row(`libra:v1:scope:${scopeKey}:manifest`,manifest),row(`libra:v1:scope:${scopeKey}:canonical-variants:v1`,{schema:'libra.canonical_variant_index.v1',scopeKey,slots}));
 }
 r=await inspect('libra',{records:reportedVariants});ok(r);assert.equal(r.scopes.length,2);
 for(let i=0;i<reportedVariants.length;i++)assert.equal(r.records[i].value,reportedVariants[i].value,'all three nested historical hints preserve source bytes');
 // A local payload's provenance is not a dependency on retired vector metadata.
 const retiredVector=`libra:v1:scope:${projectionScope}:vector:mem_000006:r1:lep_9by1h4`;
 const retainedLocal=`libra:v1:local-vector:${stableDraftHash(retiredVector)}`;
 const localPayload={schema:'libra.local_vector_payload.v1',localKey:retainedLocal,storageKey:retiredVector,keys:['global'],lengths:[1],byteLength:4,data:'AACAPw=='};
 const retainedLocalRow=row(retainedLocal,localPayload,{space:'local',location:'device'});
 r=await inspect('libra',{records:[root('libra',1),retainedLocalRow]});ok(r);assert.ok(r.records[1].dependencyScopeIds.includes(projectionScope));assert.equal(r.records[1].value,retainedLocalRow.value);
 r=await inspect('libra',{records:[root('libra',1),row(`libra:v1:scope:${projectionScope}:vector:current:r1:p`,{scopeKey:projectionScope,vectorPayloadPortable:true,portableVectorPayload:localPayload})]});ok(r);
 r=await inspect('libra',{records:[retainedLocalRow]});blocked(r,/ownership/);
 r=await inspect('libra',{records:[root('libra',1),row(retainedLocal,{...localPayload,storageKey:retiredVector+'foreign'},{space:'local',location:'device'})]});blocked(r,/local_vector_identity/);
 // Historical registry archive owners are verified shared manifests, not chats.
 for(const archiveScope of ['flashback_archive_v1:fb_135rcsu','flashback_archive_v1:fb_fue0pq']) {
  const id=archiveScope.split(':')[1],archiveRoot=`vector_rag_memory:scope:${keyHash(archiveScope)}:manifest:v2`;
  const registry=row('vector_rag_memory:scope_registry:v2',{version:2,scopes:[{scopeKey:archiveScope,storageHash:keyHash(archiveScope)}]});
  const inputs=[root('flashback',1,{archiveRef:{archiveId:id,archiveScopeKey:archiveScope}}),row(archiveRoot,{schema:'vector_rag_memory.scope_manifest.v2',scopeKey:archiveScope,archiveOwner:true,archiveId:id,count:0,shardCount:0,shardSummaries:[]}),registry];
  r=await inspect('flashback',{records:inputs});ok(r);assert.equal(r.scopes.length,1);assert.equal(r.records[2].value,registry.value);
  r=await inspect('flashback',{records:inputs.filter(x=>x.key!==archiveRoot)});blocked(r,/archive_registry_identity|dependency_missing/);
  const corrupt=clone(inputs);corrupt[1].value=JSON.stringify({...JSON.parse(corrupt[1].value),archiveOwner:false});
  r=await inspect('flashback',{records:corrupt});blocked(r,/archive.*identity/);
 }
 // Native commit-to-legacy fallback requires the exact commit on the envelope.
 const legacyShard=`vector_rag_memory:scope:${keyHash(identity('flashback',1))}:records:shard:0000`;
 const fallbackRoot=root('flashback',1,{commitId:'retained-commit',shardCount:1,count:1});
 const fallbackShard=row(legacyShard,{scopeKey:identity('flashback',1),commitId:'retained-commit',records:[{id:'retained'}]});
 r=await inspect('flashback',{records:[fallbackRoot,fallbackShard]});ok(r);assert.ok(r.records[0].dependencyKeys.includes(legacyShard));
 r=await inspect('flashback',{records:[fallbackRoot,row(legacyShard,{scopeKey:identity('flashback',1),commitId:'foreign',records:[]})]});blocked(r,/dependency_missing/);
 r=await inspect('flashback',{records:[fallbackRoot,{...fallbackShard,location:'server'}]});blocked(r,/dependency_missing/);
 r=await inspect('flashback',{records:[fallbackRoot,{...fallbackShard,deleted:true,value:null}]});blocked(r,/dependency_missing/);
 // Historical bucket envelopes bind only through scope/index/count/hash, at observed keys.
 const bucketCounts=[7,16,2,1,0,0,0,1,0,3,0,0,2,2,1,0,0,0,1,1,0,1,1,1,0,0,0,2,1,0,1,1];
 const bucketScope=identity('flashback',1),bucketPrefix=`vector_rag_memory:scope:${keyHash(bucketScope)}:`;
 const buckets=bucketCounts.map((count,shard)=>row(bucketPrefix+`records:bucket:v1:shard:${String(shard).padStart(4,'0')}`,{
  version:1,storageMode:'bucketed_v1',shard,scopeKey:bucketScope,
  records:Array.from({length:count},(_,i)=>({id:`fixture-${shard}-${i}`,scopeKey:bucketScope,text:'PRIVATE_RECORD_BODY',vector:[1,0]}))
 }));
 const bucketRoot=root('flashback',1,{storageMode:'bucketed_v1',bucketVersion:1,bucketCount:32,bucketCounts,
  bucketHashes:buckets.map(b=>keyHash(b.value)),shardCount:32,count:45,nextId:840,commitId:'',shardSummaries:[]});
 r=await inspect('flashback',{records:[bucketRoot,...buckets]});ok(r);
 assert.equal(r.records[0].dependencyKeys.length,32);assert.ok(r.records.slice(1).every(b=>b.classification==='scope'));
 assert.equal(r.records[1].value,buckets[0].value,'bucket bytes are preserved');
 for(const count of [0,4,44]) {
  const stale=clone(bucketRoot);stale.value=JSON.stringify({...JSON.parse(stale.value),count,stats:{recordTotal:45}});
  r=await inspect('flashback',{records:[stale,...buckets]});ok(r);
  assert.equal(r.records[0].value,stale.value,'stale header bytes are preserved while every bucket is verified');
  assert.equal(r.records[0].dependencyKeys.length,32);
  const missing=buckets.filter((_,index)=>index!==0);
  r=await inspect('flashback',{records:[stale,...missing]});blocked(r,/bucket_dependency_missing/);
  const tampered=clone(buckets),body=JSON.parse(tampered[0].value);body.records[0].text='tampered';tampered[0].value=JSON.stringify(body);
  r=await inspect('flashback',{records:[stale,...tampered]});blocked(r,/bucket_dependency_missing_or_invalid/);
 }
 r=await inspect('flashback',{records:[bucketRoot,...buckets.map(b=>({...b,location:'server'}))]});blocked(r,/bucket_dependency_missing/);
 r=await inspect('flashback',{records:[bucketRoot,...buckets.slice(1)]});blocked(r,/bucket_dependency_missing/);
 r=await inspect('flashback',{records:[bucketRoot,...buckets.filter((_,i)=>i!==4)]});blocked(r,/bucket_dependency_missing/);
 r=await inspect('flashback',{records:[bucketRoot,...buckets,row(bucketPrefix+'another-physical-key',buckets[1].value)]});blocked(r,/bucket_dependency_ambiguous/);
 for(const mutate of [v=>{v.records[0].text='tampered';},v=>{v.scopeKey=identity('flashback',2);},v=>{v.shard=2;},v=>{v.version=2;},v=>{v.records.pop();}]) {
  const bad=clone(buckets),value=JSON.parse(bad[1].value);mutate(value);bad[1].value=JSON.stringify(value);
  r=await inspect('flashback',{records:[bucketRoot,...bad]});blocked(r,/bucket_dependency_missing_or_invalid/);
  assert.ok(!JSON.stringify(r.blockers).includes('PRIVATE_RECORD_BODY'));
 }
 for(const fields of [{bucketCount:33},{bucketVersion:2},{bucketHashes:[]},{bucketCounts:[]},{count:-1},{commitId:12345},{rawPageLayout:'flashback.raw_pages.v1'}]) {
  const bad=clone(bucketRoot);bad.value=JSON.stringify({...JSON.parse(bad.value),...fields});
  r=await inspect('flashback',{records:[bad,...buckets]});blocked(r,/bucket_manifest_invalid/);
  assert.ok(!r.blockers.some(issue=>issue.code==='flashback_global_unknown_scope_key'),'known bucket key family does not generate an unknown-key cascade');
  assert.ok(r.blockers.find(issue=>issue.code==='flashback_global_bucket_manifest_invalid').detail,'bucket metadata errors include a precise reason');
 }
 // Historical bucketed manifests with real-world commitId (e.g. '1r51uax') are accepted.
 const commitBucketRoot=clone(bucketRoot);commitBucketRoot.value=JSON.stringify({...JSON.parse(commitBucketRoot.value),commitId:'1r51uax'});
 r=await inspect('flashback',{records:[commitBucketRoot,...buckets]});ok(r);
 assert.equal(r.records[0].dependencyKeys.length,32);
 // source-edit-consent:v1 is recognized as a valid scope key, not an unknown key.
 const consentRow=row(bucketPrefix+'source-edit-consent:v1',{schema:'memory-suite.source-edit-consent.v1',scopeKey:bucketScope});
 r=await inspect('flashback',{records:[bucketRoot,...buckets,consentRow]});ok(r);
 assert.equal(r.records.find(rec=>rec.key===consentRow.key).classification,'scope');
 // Orphaned device-local vector shards from deleted chats do not block migration.
 const orphanedLocal=row('vector_rag_memory:local-vector-shard:v1:94fgob:2jx9g1:0000',{schema:'flashback_memory.local_vector_shard.v1',scopeKey:'char:1csfo4d|chat:1ws59r4|persona:8ai3ik'},{space:'local',location:'device'});
 r=await inspect('flashback',{records:[bucketRoot,...buckets,orphanedLocal]});ok(r);
 assert.equal(r.records.find(rec=>rec.key===orphanedLocal.key).classification,'control');
 // turn_worldline:v1 retiredRecords referencing pruned past local vector shards do not block migration.
 const prunedLocalShard='vector_rag_memory:local-vector-shard:v1:1kcca9g:1mu6jof:0006';
 const worldlineWithPruned=row(bucketPrefix+'turn_worldline:v1',{
  version:'flashback_turn_worldline_v1',scopeKey:bucketScope,revision:1,liveHash:'fixture',headTurnNodeId:'',nodes:[],
  retiredRecords:[{id:'retired_1',hash:'ret_1',sourceType:'response',text:'archived branch turn',vector:[1,0],vectorRef:{storageKey:prunedLocalShard}}]
 });
 r=await inspect('flashback',{records:[bucketRoot,...buckets,worldlineWithPruned]});ok(r);
 assert.equal(r.records.find(rec=>rec.key===worldlineWithPruned.key).classification,'scope');
 // An immutable archive layer stores copies of a live chat's records and keeps
 // their vector refs verbatim. Once the source chat retires that commit the
 // payload exists nowhere: the copy is still complete and the reader hydrates it
 // keyword-only, so an absent payload is a counted warning, never a dependency.
 const fbArchiveId='fb_fixturearchive',fbArchiveScope=`flashback_archive_v1:${fbArchiveId}`,fbArchiveHash=keyHash(fbArchiveScope);
 const fbArchiveSource=identity('flashback',9),fbRetiredVector=`vector_rag_memory:local-vector-shard:v1:${keyHash(fbArchiveSource)}:1retired:0000`;
 const fbArchiveManifest=row(`vector_rag_memory:scope:${fbArchiveHash}:manifest:v2`,{schema:'vector_rag_memory.scope_manifest.v2',version:2,
  scopeKey:fbArchiveScope,storageHash:fbArchiveHash,archiveId:fbArchiveId,archiveOwner:true,commitId:'1arc',count:2,shardCount:1,
  shardSummaries:[{shardIndex:0,recordCount:2}],vectorSidecarCount:0});
 const fbInheritedRecord=id=>({schema:'vector_rag_memory.record.v2',id,scopeKey:fbArchiveSource,vector:[],dim:0,vectorPayloadMissing:true,
  inheritedFromScopeKey:fbArchiveSource,vectorRef:{schema:'flashback_memory.local_vector_ref.v1',storage:'local',
   storageKey:fbRetiredVector,recordId:id,offset:0,length:1024,digest:'fixture',mode:'local_float32_shard_v1'}});
 const fbArchiveShard=row(`vector_rag_memory:scope:${fbArchiveHash}:records:commit:1arc:shard:0000`,{version:2,shard:0,scopeKey:fbArchiveScope,
  commitId:'1arc',checksum:'fixture',records:[fbInheritedRecord('fb_archive_a'),fbInheritedRecord('fb_archive_b')]});
 const fbArchiveSourceRoot=root('flashback',9,{commitId:'1current',count:0,shardCount:0,vectorSidecarCount:0});
 r=await inspect('flashback',{records:[fbArchiveManifest,fbArchiveShard,fbArchiveSourceRoot]});
 assert.equal(r.warningCount,2);
 assert.equal(r.warnings.length,2);
 assert.equal(r.warnings[0].code,'flashback_global_vector_payload_absent');
 assert.equal(r.warnings[0].detail,fbRetiredVector);
 assert.ok(!r.blockers.some(b=>b.detail===fbRetiredVector),JSON.stringify(r.blockers));
 // The same rule covers a live scope whose own records reference a payload that
 // no longer exists anywhere (retired commit, pruned sidecar): the shard is intact.
 const fbOwnVector=`vector_rag_memory:local-vector-shard:v1:${keyHash(identity('flashback',11))}:1gone:0000`;
 const fbOwnRoot=root('flashback',11,{commitId:'1live',count:2,shardCount:1,vectorSidecarCount:0});
 const fbOwnShard=row(`vector_rag_memory:scope:${keyHash(identity('flashback',11))}:records:commit:1live:shard:0000`,{version:2,shard:0,
  scopeKey:identity('flashback',11),commitId:'1live',checksum:'fixture',records:[
   {schema:'vector_rag_memory.record.v2',id:'live_a',scopeKey:identity('flashback',11),vector:[],dim:0,vectorPayloadMissing:true,
    vectorRef:{schema:'flashback_memory.local_vector_ref.v1',storage:'local',storageKey:fbOwnVector,recordId:'live_a',offset:0,length:1024,digest:'fixture',mode:'local_float32_shard_v1'}},
   {schema:'vector_rag_memory.record.v2',id:'live_b',scopeKey:identity('flashback',11),vector:[],dim:0,vectorPayloadMissing:true}]});
 r=await inspect('flashback',{records:[fbOwnRoot,fbOwnShard]});
 ok(r);assert.equal(r.warningCount,1);assert.equal(r.warnings[0].detail,fbOwnVector);
 // The same ref stays fatal when the payload still exists for another storage
 // source: copying the archive row would drop reachability that is still real.
 const fbServerArchiveManifest={...fbArchiveManifest,location:'server'},fbServerArchiveShard={...fbArchiveShard,location:'server'};
 const fbDeviceOnlyPayload=row(fbRetiredVector,{schema:'flashback_memory.local_vector_shard.v1',scopeKey:fbArchiveSource,
  commitId:'1retired',shardIndex:0,items:[{recordId:'record-a',offset:0,length:1}],data:'AACAPw=='},{space:'local',location:'device'});
 r=await inspect('flashback',{records:[{...fbArchiveSourceRoot,location:'server'},fbDeviceOnlyPayload]});
 ok(r);
 assert.equal(r.records[1].classification,'scope','the device shard remains an owned record in ordinary migration');
 assert.equal(r.records[1].retainDeviceCacheAfterReset,true,'a device shard with no server reference can be retained');
 r=await inspect('flashback',{records:[fbServerArchiveManifest,fbServerArchiveShard,fbArchiveSourceRoot,fbDeviceOnlyPayload]});
 blocked(r,/dependency.*missing/);
 assert.equal(r.warningCount,0);
 assert.equal(r.records[3].retainDeviceCacheAfterReset,undefined,'a referenced device-only shard remains a dependency');
 const fbDeclaredVectorCommit='1retired';
 r=await inspect('flashback',{records:[{...root('flashback',9,{commitId:fbDeclaredVectorCommit,vectorSidecarCount:1}),location:'server'},fbDeviceOnlyPayload]});
 blocked(r,/vector_dependency_count_invalid/);
 assert.equal(r.records[1].retainDeviceCacheAfterReset,undefined,'declared sidecars remain required before resolving exact keys');
 // A manifest that does declare vector sidecars for its own commit still gates:
 // a declared-but-absent sidecar count is not covered by the payload warning.
 const fbDeclaredSidecarRoot=root('flashback',10,{commitId:'1declared',count:1,shardCount:1,vectorSidecarCount:1});
 r=await inspect('flashback',{records:[fbDeclaredSidecarRoot]});
 blocked(r,/vector.*dependency.*count|count.*invalid/);
 for (const kind of ['unreferenced','matching_binding','reordered_object','reordered_server_update','different_binding','wrong_reference']) {
  const namespace='flashback', scopeKey=identity(namespace,1), commitId='vector_test', shardIndex=0;
  const scopePrefix='vector_rag_memory:scope:'+keyHash(scopeKey)+':';
  const vectorKey='vector_rag_memory:local-vector-shard:v1:'+keyHash(scopeKey)+':'+commitId+':0000';
  const shardKey=scopePrefix+'records:commit:'+commitId+':shard:0000';
  const vector=(data,recordId='record-1')=>{
   const items=[{recordId,offset:0,length:1}];
   const content={scopeKey,commitId,shardIndex,items,data};
   return {schema:'flashback_memory.local_vector_shard.v1',version:1,...content,itemCount:1,byteLength:4,floatCount:1,
     digest:keyHash(JSON.stringify(content,null,2))};
  };
  const initial=vector('AACAPw=='), remote=vector('AAAAQA==',kind==='different_binding'?'different-record':'record-1');
  const orderedObject=kind==='reordered_object'||kind==='reordered_server_update';
  const sortedObject=value=>JSON.parse(JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item));
  const shard=payload=>row(shardKey,{version:2,shard:0,scopeKey,commitId,records:[{id:'record-1',scopeKey,vector:[],
    vectorRef:{schema:'flashback_memory.local_vector_ref.v1',storageKey:vectorKey,storage:'local',recordId:'record-1',offset:0,length:1,digest:payload.digest}}]});
  const roots=kind==='unreferenced' ? [root(namespace,1)]
    : [root(namespace,1,{commitId,shardCount:1,count:1,vectorSidecarCount:1}),shard(initial)];
  const values=new Map(roots.map(entry=>[entry.key,entry.value]));
  const device=new Map([[vectorKey,orderedObject?initial:JSON.stringify(initial)]]);
  const store={getItem:async key=>device.get(key)??null,setItem:async(key,value)=>{device.set(key,value);return true;},
    removeItem:async key=>{device.delete(key);return true;},keys:async()=>[...device.keys()]};
  const f=await fixture(variantFor(namespace),{values,catalog:{characters:[{chaId:host(1).characterId,chats:[{id:host(1).chatId}]}]},
    current:scopeKey,adapter:adapters.flashback,bridgeOptions:{pluginPrefixes:['vector_rag_memory:'],localPrefixes:['vector_rag_memory:']}});
  try {
   f.bridge.createLocalStorageProxy(store);
   await f.bridge.setGlobalMode('server_only');
   const repo=f.app.repositories.flashback;
   const replace=(space,key,value)=>{
    const json=JSON.stringify(value), digest=require('node:crypto').createHash('sha256').update(json).digest('hex');
    assert.equal(repo.database.prepare('UPDATE kv SET value_json=?, digest=?, revision=revision+1 WHERE space=? AND key=?')
      .run(json,digest,space,key).changes,1);
   };
   const remoteValue=orderedObject?sortedObject(kind==='reordered_object'?initial:remote):JSON.stringify(remote);
   replace('local',vectorKey,remoteValue);
   if (['matching_binding','different_binding','reordered_server_update'].includes(kind)) replace('plugin',shardKey,shard(remote).value);
   const retained=orderedObject?initial:JSON.stringify({...initial,createdAt:'device-side rewrite'});device.set(vectorKey,retained);
   if (kind==='unreferenced'||kind==='matching_binding'||orderedObject) {
    assert.equal((await f.bridge.setGlobalMode('plugin_only')).mode,'plugin_only');
    if (kind==='unreferenced'||kind==='reordered_object') assert.equal(device.get(vectorKey),retained);
    else assert.equal(JSON.stringify(device.get(vectorKey)),JSON.stringify(remoteValue));
   } else {
    await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),error=>
      error.code==='MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT'&&error.details.key===vectorKey);
    assert.equal(device.get(vectorKey),retained);
    assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
   }
  } finally { await f.close(); }
 }
 for (const kind of ['unreferenced','portable','matching_binding','wrong_profile','wrong_digest']) {
  const namespace='libra', scopeKey=identity(namespace,1), profileId='profile';
  const projectionKey=`libra:v1:scope:${scopeKey}:vector:old:r1:${profileId}`;
  const localKey='libra:v1:local-vector:'+stableDraftHash(projectionKey);
  const vector=(number,data,profile=profileId)=>{
   const json=JSON.stringify({semantic:[number]});
   return {schema:'libra.local_vector_payload.v1',storageKey:projectionKey,localKey,profileId:profile,
    vectorHash:hash32(json+'\u001f').toString(16).padStart(8,'0')+':'+(json.length+1),keys:['semantic'],lengths:[1],floatCount:1,byteLength:4,data};
  };
  const projection=(payload,portable=false)=>{
   const {storageKey,localKey,vectorHash,keys,lengths,floatCount,byteLength}=payload;
   return row(projectionKey,{schema:'libra.embedding_projection.v2',scopeKey,profileId,
    localVectorRef:{schema:'libra.local_vector_ref.v1',storageKey,localKey,vectorHash,keys,lengths,floatCount,byteLength},
    ...(portable?{vectorPayloadPortable:true,portableVectorPayload:payload}:{})});
  };
  const initial=vector(1,'AACAPw=='), remote=vector(2,'AAAAQA==');
  const retained=JSON.stringify({...initial,createdAt:'device-side rewrite',...(kind==='wrong_profile'?{profileId:'other'}:{})});
  const roots=[root(namespace,1)];
  if (kind!=='unreferenced') roots.push(projection(initial,kind==='portable'));
  const device=new Map([[localKey,JSON.stringify(initial)]]);
  const store={getItem:async key=>device.get(key)??null,setItem:async(key,value)=>{device.set(key,value);return true;},
    removeItem:async key=>{device.delete(key);return true;},keys:async()=>[...device.keys()]};
  const f=await fixture(variantFor(namespace),{values:new Map(roots.map(entry=>[entry.key,entry.value])),
    catalog:{characters:[{chaId:host(1).characterId,chats:[{id:host(1).chatId}]}]},current:scopeKey,adapter:adapters.libra,
    bridgeOptions:{pluginPrefixes:['libra:v1:'],localPrefixes:['libra:v1:']}});
  try {
   f.bridge.createLocalStorageProxy(store);
   await f.bridge.setGlobalMode('server_only');
   const repo=f.app.repositories.libra;
   repo.mutate({kind:'set',space:'local',key:localKey,value:JSON.stringify(remote),operationId:'update_libra_vector'});
   if (kind!=='unreferenced') {
    const target=projection(kind==='wrong_digest'?initial:remote,kind==='portable');
    repo.mutate({kind:'set',space:'plugin',key:target.key,value:target.value,operationId:'update_libra_projection'});
    f.values.delete(target.key);
   }
   device.set(localKey,retained);
   if (kind==='wrong_profile'||kind==='wrong_digest') {
    await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),error=>
      error.code==='MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT'&&error.details.key===localKey);
    assert.equal(device.get(localKey),retained);
    assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
   } else {
    assert.equal((await f.bridge.setGlobalMode('plugin_only')).mode,'plugin_only');
    assert.equal(device.get(localKey),kind==='matching_binding'?JSON.stringify(remote):retained);
    if (kind==='portable') assert.deepEqual(JSON.parse(f.values.get(projectionKey)).portableVectorPayload,remote);
   }
  } finally { await f.close(); }
 }
 {
  const namespace='hayaku', scopeKey=identity(namespace,1), version='hayaku.source_postings.v2';
  const binding=stableHash64('storage-binding'), sourceDigest=stableHash64('source'), prefix=`hayaku.v2.recall_index.${scopeKey}::${binding}::`;
  const page=JSON.stringify({schema:'hayaku.recall_posting_page.v1',version,scopeKey,binding,documents:[],postings:[]});
  const digest=stableHash64(page), pageKey=prefix+'page::'+digest, manifestKey=prefix+'manifest::'+sourceDigest;
  const manifest={schema:'hayaku.recall_posting_manifest.v1',version,scopeKey,binding,sourceDigest,sourceCount:0,
    pages:[{key:pageKey,digest,bytes:Buffer.byteLength(page)}]};
  const journalKey='hayaku.v2.storage_reconciliation_journal';
  const ledger=root(namespace,1);
  const journal=serializedHash=>JSON.stringify({schema:'hayaku.storage_reconciliation_journal.v1',version:1,updatedAt:Date.now(),
    entries:[{id:ledger.key+':'+serializedHash,key:ledger.key,scopeKey,serializedHash,state:'indeterminate'}]});
  const localJournal=journal('device'), serverJournal=journal('server');
  const delta=JSON.stringify({schema:'hayaku.capture_raw_delta.v1',scopeKey,binding,packets:[]});
  const deltaKey=`${journalKey}.capture_delta::${scopeKey}::${binding}::${stableHash64(delta)}`;
  const values=new Map([[ledger.key,ledger.value],[manifestKey,JSON.stringify(manifest)],[pageKey,page],[journalKey,localJournal],[deltaKey,delta]]);
  const f=await fixture(variantFor(namespace),{values,adapter:adapters.hayaku,current:scopeKey,
    catalog:{characters:[{chaId:host(1).characterId,chats:[{id:host(1).chatId}]}]},bridgeOptions:{pluginPrefixes:['hayaku.v2.']}});
  try {
   const checked=await inspect(namespace,{records:[ledger,row(manifestKey,manifest),row(pageKey,page),row(pageKey,{}, {location:'server'})]});
   ok(checked); assert.deepEqual(Array.from(checked.records,entry=>entry.classification),['scope','control','control','scope']);
   await f.bridge.setGlobalMode('server_only');
   const repo=f.app.repositories.hayaku;
   for (const key of [manifestKey,pageKey,journalKey]) assert.equal(repo.get('plugin',key).exists,false);
   assert.equal(repo.get('plugin',deltaKey).value,delta);
   const remoteManifest=JSON.stringify({...manifest,sourceCount:1});
   repo.mutate({kind:'set',space:'plugin',key:manifestKey,value:remoteManifest,operationId:'old_hayaku_index'});
   repo.mutate({kind:'set',space:'plugin',key:pageKey,value:page,operationId:'old_hayaku_index_page'});
   repo.mutate({kind:'set',space:'plugin',key:journalKey,value:serverJournal,operationId:'old_hayaku_reconciliation_journal'});
   f.values.delete(ledger.key);
   f.values.delete(pageKey);
   f.values.delete(deltaKey);
   assert.equal((await f.bridge.setGlobalMode('plugin_only')).mode,'plugin_only');
   assert.equal(f.values.get(ledger.key),ledger.value);
   assert.equal(f.values.get(manifestKey),JSON.stringify(manifest));
   assert.equal(f.values.has(pageKey),false);
   assert.equal(repo.get('plugin',manifestKey).value,remoteManifest);
   assert.equal(f.values.get(journalKey),localJournal);
   assert.equal(repo.get('plugin',journalKey).value,serverJournal);
   assert.equal(f.values.get(deltaKey),delta);
  } finally { await f.close(); }
 }
 // The supplied empty-envelope hashes establish the historical JSON hash codec.
 const actualScope='char:1prphff|chat:1cferkl|persona:48amyh';assert.equal(keyHash(actualScope),'1hxw63t');
 for(const [shard,digest]of [[4,'wycscg'],[5,'1umqef'],[6,'1a5z36u'],[8,'iloit0'],[10,'ii1j15'],[11,'1am0jnu']]) {
  assert.equal(keyHash(JSON.stringify({version:1,storageMode:'bucketed_v1',shard,scopeKey:actualScope,records:[]})),digest);
 }
 {
  const f=await fixture(variantFor('flashback'));
  let fresh, stop;
  try {
   await f.bridge.setGlobalMode('server_only');
   const preview=await f.bridge.previewGlobalMode('plugin_only');
   let stopped=false;
   stop=f.bridge.subscribeSyncJob(job=>{
    if (!stopped && job?.checkpoints?.A) { stopped=true;void f.bridge.pauseGlobalModeJob(); }
   });
   await f.bridge.setGlobalMode('plugin_only',{previewFingerprint:preview.inventoryFingerprint});
   assert.equal(stopped,true);
   const key='__memory_suite_internal_sync_job_v1__:flashback';
   const journal=JSON.parse(f.values.get(key));
   assert.equal(journal.status,'paused');assert.ok(journal.globalPlan);
   f.values.set(key,JSON.stringify({...journal,error:'MEMORY_SUITE_GLOBAL_REDISCOVERY_REQUIRED'}));
   await f.bridge.dispose();
   fresh=await fixture(variantFor('flashback'),{app:f.app,values:f.values});
   const recovery=await fresh.bridge.recoverModeTransition('plugin');
   assert.equal(recovery.result.mode,'plugin_only',JSON.stringify({engine:fresh.bridge.getSyncJob()?.engine,status:recovery.result.status,phase:recovery.result.phase,error:recovery.result.error,findings:recovery.findings}));
   assert.notEqual(fresh.bridge.getSyncJob().jobId,journal.jobId);
   assert.equal(fresh.bridge.getSyncJob().engine,'fast');
   assert.equal(await fresh.proxy.getItem('flashback.A'),'A_SOURCE');
  } finally { stop?.();await fresh?.close();await f.close(); }
 }
 {
  const namespace='flashback', scopeId=identity(namespace,1),
    prefix='vector_rag_memory:scope:'+keyHash(scopeId)+':';
  const manifest=root(namespace,1,{commitId:'retained',count:1,shardCount:1});
  const shard=row(prefix+'records:commit:retained:shard:0000',{version:2,shard:0,scopeKey:scopeId,records:[{id:'retained'}]});
  const worldline=row(prefix+'turn_worldline:v1',{scopeKey:scopeId,records:[]});
  const other=root(namespace,2);
  const originals=[manifest,shard,worldline,other];
  const values=new Map(originals.map(entry=>[entry.key,entry.value]));
  const catalog={characters:[1,2].map(n=>({chaId:host(n).characterId,chats:[{id:host(n).chatId}]}))};
  const bridgeOptions={pluginPrefixes:['vector_rag_memory:']};
  const f=await fixture(variantFor(namespace),{values,catalog,current:scopeId,adapter:adapters.flashback,bridgeOptions});
  let fresh,dom;
  try {
   await f.bridge.setGlobalMode('server_only');
   const request=require('./helpers/inprocess-review-transport.cjs')(f.app);
   const base='http://127.0.0.1:47631';
   const headers={'X-Memory-Suite-Plugin':'flashback_hayaku_bridge','Content-Type':'application/json'};
   const boot=await (await request(base+'/bootstrap',{headers})).json();headers.Authorization='Bearer '+boot.token;
   const post=async (route,body)=>{
    const res=await request(base+route,{method:'POST',headers,body:JSON.stringify(body)});
    const payload=await res.json();assert.equal(res.status,200,JSON.stringify(payload));return payload.result;
   };
   const reset=await post('/v1/manager/reset/plan',{namespaces:[namespace]});
   await post('/v1/manager/reset/execute',{planId:reset.id,confirmation:reset.confirmation,withoutBackup:true});
   await f.bridge.acceptServerReset('empty');
   const resetChoice=JSON.parse(values.get('memory_suite_reset_choice.v2.flashback'));
   await f.bridge.dispose();
   const repo=f.app.repositories.flashback;
   const injectServerRow=(key,value,deleted=0)=>{
    const valueJson=JSON.stringify(value), digest=require('node:crypto').createHash('sha256').update(valueJson).digest('hex');
    repo.database.prepare('INSERT INTO kv(space,key,value_json,deleted,revision,digest,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('plugin',key,valueJson,deleted,1,digest,Date.now());
   };
   injectServerRow(other.key,other.value);
   fresh=await fixture(variantFor(namespace),{app:f.app,values,catalog,current:scopeId,adapter:adapters.flashback,bridgeOptions});
   const isLocalOnly=error=>error.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE'
     &&error.details.blockers.some(blocker=>blocker.code==='MEMORY_SUITE_GLOBAL_RESET_LOCAL_ONLY_RECORD');
   await assert.rejects(()=>fresh.bridge.setGlobalMode('plugin_only'),isLocalOnly);
   values.delete(shard.key);
   await assert.rejects(()=>fresh.bridge.setGlobalMode('plugin_only',{keepResetLocalScopes:resetChoice}),error=>
     error.code==='MEMORY_SUITE_GLOBAL_DISCOVERY_INCOMPLETE'&&error.details.blockers.some(blocker=>/dependency_missing/.test(blocker.code)));
   values.set(shard.key,shard.value);
   injectServerRow(manifest.key,null,1);
   await assert.rejects(()=>fresh.bridge.setGlobalMode('plugin_only',{keepResetLocalScopes:resetChoice}),isLocalOnly);
   repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',manifest.key);
   let injected=false;
   const publishDuringCopy=fresh.bridge.subscribeSyncJob(job=>{
    if(!injected&&job?.status==='running'&&job.phase==='copy'){
     injected=true;injectServerRow(manifest.key,manifest.value);
    }
   });
   try {
    await assert.rejects(()=>fresh.bridge.setGlobalMode('plugin_only',{keepResetLocalScopes:resetChoice}),
      error=>error.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'&&error.details.key===manifest.key);
    assert.equal(injected,true);
   } finally { publishDuringCopy(); }
   repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',manifest.key);
   assert.equal((await fresh.bridge.getGlobalMode()).mode,'server_only');
   dom=require('./helpers/global-allchat-panel-dom.cjs').makePanelDom();
   await fresh.bridge.mountConnectionPanel(dom.container);
   await new Promise(resolve=>setTimeout(resolve,25));
   dom.byAttr('data-url').value=base;
   for(const input of dom.radios)input.checked=input.value==='plugin_only';
   const applying=dom.byAttr('data-apply').onclick();
   const approve=dom.byAttr('data-mode-confirm-approve');
   for(let attempt=0;attempt<200&&!approve.onclick;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
   assert.equal(typeof approve.onclick,'function');
   assert.match(dom.byAttr('data-mode-confirm-text').textContent,/완전한 기기 대화.*함께 사용/);
   approve.onclick();await applying;
   assert.equal((await fresh.bridge.getGlobalMode()).mode,'plugin_only',dom.byAttr('data-status').textContent);
   assert.equal(fresh.bridge.getSyncJob().result.retainedResetScopes,1);
   for(const entry of originals.slice(0,3)){
    assert.equal(await fresh.proxy.getItem(entry.key),entry.value);
    assert.equal(repo.get('plugin',entry.key).exists,false);
   }
  } finally { if(dom)dom.root.isConnected=false;await fresh?.close();await f.close(); }
 }
 console.log(`Global owner discovery adapters: PASS (${checks} scenarios)`);
})().catch(error=>{console.error(error);process.exitCode=1;});
