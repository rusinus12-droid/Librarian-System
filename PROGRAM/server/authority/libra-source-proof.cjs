'use strict';
// One fixed backend fact codec. This module deliberately has no recall, native,
// route, archive, Micro, source-edit eligibility or corpus transport authority.
const C=require('./contracts.cjs'),M=require('./receipt-codec.cjs'),J=require('./observation-json.cjs'),IO=require('./observation-io.cjs');
const CODEC='libra.plugin-json-string.canonical-facts.v1',PROFILE='libra.canonical.memory-text.v1',BINDING='qualified-writer-observed-path.v1',MiB=J.MiB;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const blob=(column,max)=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${max} THEN CAST(${column} AS BLOB) ELSE NULL END`;
const integer=(column,min=0)=>`CASE WHEN typeof(${column})='integer' AND ${column} BETWEEN ${min} AND 9007199254740991 THEN ${column} ELSE NULL END`;
function key(value){M.assertWriterKey('plugin',value);J.unicode(value);if(value.includes('\0'))C.fail('SOURCE_PROFILE_UNAVAILABLE');return value;}
function scopeKeys(scopeKey){J.unicode(scopeKey);if(!scopeKey)C.fail('SOURCE_PROOF_UNAVAILABLE');const prefix=key(`libra:v1:scope:${scopeKey}:memory:`);return {prefix,upper:prefix.slice(0,-1)+';',manifest:key(`libra:v1:scope:${scopeKey}:manifest`),optional:['state-worldline-meta:v1','recall-catalog:v1'].map(suffix=>key(`libra:v1:scope:${scopeKey}:${suffix}`))};}
const META_SQL=`SELECT k.key IS NOT NULL AS kv_exists,l.key IS NOT NULL AS lifecycle_exists,
 typeof(k.value_json) AS value_type,length(CAST(k.value_json AS BLOB)) AS serialized_bytes,
 ${integer('k.deleted')} AS deleted,${integer('k.revision',1)} AS row_revision,${blob('k.digest',64)} AS row_digest,
 ${blob('l.source_id',240)} AS source_id,${blob('l.generation',240)} AS generation,${integer('l.version',1)} AS version,${integer('l.present')} AS present,
 ${integer('l.revision',1)} AS lifecycle_revision,${blob('l.digest',64)} AS lifecycle_digest,
 typeof(l.revision) AS revision_type,typeof(l.digest) AS digest_type
 FROM (SELECT 1) LEFT JOIN kv k ON k.space='plugin' AND k.key=? LEFT JOIN authority_source_lifecycle l ON l.space='plugin' AND l.key=?`;
function metadata(session,sourceKey){const s=IO.assertOwnerSession(session);key(sourceKey);if(!s.metadata)s.metadata=new Map();if(s.metadata.has(sourceKey))return s.metadata.get(sourceKey);
 const row=IO.acquireRows(s.db,META_SQL,[sourceKey,sourceKey],s.budget,{kind:'source',maximum:2048});
 let lifecycle=null,presence;
 if(row.lifecycle_exists){
  try{C.identifier(row.source_id);C.identifier(row.generation);C.boundedInteger(row.version,1);if(![0,1].includes(row.present)||row.generation!==s.context.marker.generation)C.fail('AUTHORITY_QUARANTINED');
   if(row.revision_type!=='null')C.boundedInteger(row.lifecycle_revision,1);if(row.digest_type!=='null'&&!digest(row.lifecycle_digest))C.fail('AUTHORITY_QUARANTINED');
   lifecycle={space:'plugin',key:sourceKey,sourceId:row.source_id,generation:row.generation,version:row.version,present:row.present===1,revision:row.lifecycle_revision,digest:row.lifecycle_digest};M.encodeTouch(lifecycle);
  }catch{C.fail('AUTHORITY_QUARANTINED');}
 }
 if(row.kv_exists){if(!lifecycle||![0,1].includes(row.deleted)||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||!digest(row.row_digest)||lifecycle.present!==(row.deleted===0)||lifecycle.revision!==row.row_revision||lifecycle.digest!==row.row_digest)C.fail('AUTHORITY_QUARANTINED');presence=row.deleted?'tombstone':'live';}
 else{if(lifecycle&&(lifecycle.present||lifecycle.revision!==null||lifecycle.digest!==null))C.fail('AUTHORITY_QUARANTINED');presence=lifecycle?'purged-with-lifecycle':'never-present';}
 const fact={key:sourceKey,presence,lifecycle,rowRevision:row.kv_exists?row.row_revision:null,rowDigest:row.kv_exists?row.row_digest:null,valueType:row.kv_exists?row.value_type:null,serializedBytes:row.kv_exists?row.serialized_bytes:null};
 s.metadata.set(sourceKey,fact);if(s.metadata.size>IO.LIMITS.keys)C.fail('RESOURCE_LIMIT');return fact;
}
function inventory(session,keys){const s=IO.assertOwnerSession(session),b=s.budget;
 // Bound BOTH streams before their union, preserve invalid entries rather than
 // filtering them out, and reject the overflow sentinel/aggregate before bytes.
 const sql=`WITH k AS MATERIALIZED (SELECT key FROM kv WHERE space='plugin' AND CAST(key AS BLOB)>=CAST(? AS BLOB) AND CAST(key AS BLOB)<CAST(? AS BLOB) ORDER BY key COLLATE BINARY LIMIT 8193),l AS MATERIALIZED (SELECT key FROM authority_source_lifecycle WHERE space='plugin' AND CAST(key AS BLOB)>=CAST(? AS BLOB) AND CAST(key AS BLOB)<CAST(? AS BLOB) ORDER BY key COLLATE BINARY LIMIT 8193),u AS MATERIALIZED (SELECT key FROM k UNION SELECT key FROM l),t AS (SELECT count(*) n,coalesce(sum(length(CAST(key AS BLOB))),0) bytes,coalesce(min(typeof(key)='text' AND length(CAST(key AS BLOB))<=12288),1) good FROM u) SELECT n,bytes,good,CASE WHEN n<=8192 AND bytes<=1048576 AND good=1 THEN CAST(key AS BLOB) ELSE NULL END AS key FROM u CROSS JOIN t ORDER BY key COLLATE BINARY LIMIT 8193`;
 const rows=IO.acquireRows(s.db,sql,[keys.prefix,keys.upper,keys.prefix,keys.upper],b,{kind:'source',maximum:MiB,overhead:9*MiB,many:true});
 if(rows.length>8192||rows.some(r=>r.n!==rows.length||r.good!==1||r.bytes>MiB||r.key===null))C.fail('RESOURCE_LIMIT');
 // SQL BINARY order is retained. Never sort these keys with UTF-16 comparison.
 return rows.map(row=>metadata(session,key(row.key)));
}
function qualifyJsonEngine(session){const s=IO.assertOwnerSession(session);if(s.jsonProfile)return;
 const sample='{"text\\u0000shadow":"wrong","text":"a\\u0000b","a\\u0000b":1,"a\\u0000c":2}';
 const r=IO.acquireRows(s.db,`SELECT json_valid(?,1) AS valid,(SELECT length(CAST(atom AS BLOB)) FROM json_each(?) WHERE CAST(key AS BLOB)=X'74657874') AS bytes,(SELECT count(*)+sum(typeof(key)='text') FROM json_tree(?)) AS nodes,(SELECT count(DISTINCT CAST(key AS BLOB)) FROM json_each(?)) AS keys,json_valid('{"x":1,}',1) AS loose,json_type(json_extract(?, '$')) AS inner_type`,[sample,sample,sample,sample,JSON.stringify('{"x":1}')],s.budget,{kind:'source',maximum:128});
 if(r.valid!==1||r.bytes!==3||r.nodes!==9||r.keys!==4||r.loose!==0||r.inner_type!=='object')C.fail('SOURCE_PROFILE_UNAVAILABLE');s.jsonProfile=true;
}
function rowPreflight(session,fact){const s=IO.assertOwnerSession(session);if(fact.presence!=='live')C.fail('SOURCE_PROOF_UNAVAILABLE');if(fact.valueType!=='text')C.fail('SOURCE_PROFILE_UNAVAILABLE');if(!Number.isSafeInteger(fact.serializedBytes)||fact.serializedBytes>MiB)C.fail('RESOURCE_LIMIT');qualifyJsonEngine(session);
 const sql=`WITH raw AS MATERIALIZED (SELECT CASE WHEN typeof(value_json)='text' AND length(CAST(value_json AS BLOB))<=1048576 AND deleted=0 AND revision=? AND digest=? THEN value_json ELSE NULL END AS outer_json FROM kv WHERE space='plugin' AND key=?),decoded AS MATERIALIZED (SELECT CASE WHEN json_valid(outer_json,1) THEN CASE WHEN json_type(outer_json)='text' THEN json_extract(outer_json,'$') END END AS inner_json FROM raw),obj AS MATERIALIZED (SELECT CASE WHEN typeof(inner_json)='text' AND length(CAST(inner_json AS BLOB))<=1048576 AND json_valid(inner_json,1) THEN CASE WHEN json_type(inner_json)='object' THEN inner_json END END AS inner_json FROM decoded),tree AS MATERIALIZED (SELECT key,type,parent FROM json_tree((SELECT inner_json FROM obj)) LIMIT 65537),dupes AS (SELECT 1 FROM tree WHERE typeof(key)='text' GROUP BY parent,CAST(key AS BLOB) HAVING count(*)>1 LIMIT 1) SELECT inner_json IS NOT NULL AS valid,length(CAST(inner_json AS BLOB)) AS inner_bytes,(SELECT type FROM json_each(inner_json) WHERE CAST(key AS BLOB)=X'74657874' LIMIT 1) AS text_type,(SELECT CASE WHEN type='text' THEN length(CAST(atom AS BLOB)) END FROM json_each(inner_json) WHERE CAST(key AS BLOB)=X'74657874' LIMIT 1) AS text_bytes,(SELECT count(*)+coalesce(sum(typeof(key)='text'),0) FROM tree) AS nodes,EXISTS(SELECT 1 FROM dupes) AS duplicates FROM obj`;
 const p=IO.acquireRows(s.db,sql,[fact.rowRevision,fact.rowDigest,fact.key],s.budget,{kind:'source',maximum:256});
 if(!p||p.valid!==1||p.duplicates)C.fail('SOURCE_PROFILE_UNAVAILABLE');if(p.nodes>65536||p.inner_bytes>MiB)C.fail('RESOURCE_LIMIT');return p;
}
function decodeRow(session,fact,{narrative=false}={}){const s=IO.assertOwnerSession(session),b=s.budget,p=rowPreflight(session,fact);if(narrative&&(p.text_type!=='text'||p.text_bytes<1))C.fail('SOURCE_PROOF_UNAVAILABLE');
 if(narrative){s.plannedNarrative=(s.plannedNarrative||0)+p.text_bytes;if(s.plannedNarrative>MiB)C.fail('RESOURCE_LIMIT');}
 s.logicalOuter=(s.logicalOuter||0)+fact.serializedBytes;if(s.logicalOuter>MiB)C.fail('RESOURCE_LIMIT');b.counters.admittedSerializedBytes+=fact.serializedBytes;
 // Hold the complete upper-bound reservation through the attempt. Raw BLOB,
 // outer/inner strings, scanner strings/sets and parsed tree can coexist.
 b.reserve(fact.serializedBytes*12+p.nodes*512+65536);
 const row=s.db.prepare(`SELECT CASE WHEN typeof(k.value_json)='text' AND length(CAST(k.value_json AS BLOB))=? AND k.deleted=0 AND k.revision=? AND k.digest=? AND l.source_id=? AND l.generation=? AND l.version=? AND l.present=1 AND l.revision=k.revision AND l.digest=k.digest THEN CAST(k.value_json AS BLOB) END AS raw FROM kv k JOIN authority_source_lifecycle l ON l.space=k.space AND l.key=k.key WHERE k.space='plugin' AND k.key=?`).get(fact.serializedBytes,fact.rowRevision,fact.rowDigest,fact.lifecycle.sourceId,fact.lifecycle.generation,fact.lifecycle.version,fact.key);
 b.check();b.charge('source',row?.raw===null?1:0);if(!(row?.raw instanceof Uint8Array))C.fail('AUTHORITY_QUARANTINED');b.content('materializedSerializedBytes',row.raw.byteLength);
 const raw=J.decode(row.raw),rawHash=M.hashUtf8(raw);if(rawHash!==fact.rowDigest||rawHash!==fact.lifecycle.digest)C.fail('AUTHORITY_QUARANTINED');
 const outer=J.parse(raw);if(typeof outer.value!=='string')C.fail('SOURCE_PROFILE_UNAVAILABLE');const parsed=J.parse(outer.value),value=J.plain(parsed.value);
 if(parsed.utf8Bytes!==p.inner_bytes||parsed.nodes!==p.nodes)C.fail('SOURCE_PROFILE_UNAVAILABLE');
 if(narrative){if(typeof value.text!=='string'||Buffer.byteLength(value.text)!==p.text_bytes)C.fail('SOURCE_PROFILE_UNAVAILABLE');b.content('hydratedNarrativeBytes',p.text_bytes);}
 b.check();return {value,innerBytes:p.inner_bytes,rawSha256:rawHash,textBytes:p.text_bytes};
}
function requiredString(value){J.unicode(value);if(!value||value.length>4096)C.fail('SOURCE_PROOF_UNAVAILABLE');return value;}
function pointer(manifest,start,scopeKey){const ref=J.plain(manifest.memories[String(start)]);C.boundedInteger(ref.revision,1);const expected=key(`libra:v1:scope:${scopeKey}:memory:${start}:r${ref.revision}`);if(ref.key!==expected||ref.status!=='committed'||ref.archiveShared===true)C.fail('SOURCE_PROOF_UNAVAILABLE');
 const range=J.plain(ref.turnRange);if(range.start!==start||!Number.isSafeInteger(range.end)||range.end<start)C.fail('SOURCE_PROOF_UNAVAILABLE');
 return {start,path:'/memories/'+start,key:expected,memoryId:requiredString(ref.memoryId),revision:ref.revision,sourceDigest:requiredString(ref.sourceDigest),status:ref.status,turnRange:{start,end:range.end}};
}
function captureCanonicalFacts(session,{scopeKey,starts}){const s=IO.assertOwnerSession(session),keys=scopeKeys(scopeKey),canonicalInventory=inventory(session,keys),manifestMeta=metadata(session,keys.manifest),loaded=decodeRow(session,manifestMeta),manifest=loaded.value;
 if(manifest.schema!=='libra.manifest.v1'||manifest.scopeKey!==scopeKey)C.fail('SOURCE_PROOF_UNAVAILABLE');requiredString(manifest.characterId);requiredString(manifest.chatId);J.plain(manifest.memories);J.plain(manifest.branchGuard);J.plain(manifest.worldlineMeta);
 const selectedPointers=starts.map(start=>pointer(manifest,start,scopeKey)),records=[],items=[],dependencies=[manifestMeta];
 for(const ref of selectedPointers){const meta=metadata(session,ref.key),body=decodeRow(session,meta,{narrative:true}),v=body.value;
  if(v.schema!=='libra.canonical_memory.v1'||v.scopeKey!==scopeKey||v.status!=='committed'||v.memoryId!==ref.memoryId||v.revision!==ref.revision||v.sourceDigest!==ref.sourceDigest||v.turnRange?.start!==ref.turnRange.start||v.turnRange?.end!==ref.turnRange.end)C.fail('SOURCE_PROOF_UNAVAILABLE');
  const sha256=M.hashUtf8(v.text);dependencies.push(meta);records.push({...meta,innerBytes:body.innerBytes,schema:v.schema,memoryId:v.memoryId,revision:v.revision,sourceDigest:v.sourceDigest,status:v.status,textProfile:PROFILE,textBytes:body.textBytes,textSha256:sha256});items.push({key:ref.key,profile:PROFILE,text:v.text,utf8Bytes:body.textBytes,sha256});
 }
 const optionalFacts=[];for(const sourceKey of keys.optional){const meta=metadata(session,sourceKey);dependencies.push(meta);if(meta.presence==='live'){const value=decodeRow(session,meta);optionalFacts.push({...meta,rawSha256:value.rawSha256,innerBytes:value.innerBytes});}else optionalFacts.push(meta);}
 const metadataClosure={dependencies,canonicalInventory};
 const closure={schema:'memory-suite.libra-backend-facts.v1',bindingModel:BINDING,scopeKey,codec:CODEC,manifest:{...manifestMeta,innerBytes:loaded.innerBytes,rawSha256:loaded.rawSha256,branchGuardDigest:C.hash(manifest.branchGuard),worldlineMetaDigest:C.hash(manifest.worldlineMeta)},selectedPointers,records,optionalFacts,canonicalInventory,byteCounts:{serializedBytes:s.logicalOuter,narrativeBytes:items.reduce((n,row)=>n+row.utf8Bytes,0)}};
 s.budget.check();return {closure,metadataClosure,items};
}
function compareLibraFactClosure(session,{scopeKey,metadataClosure}){const keys=scopeKeys(scopeKey),canonicalInventory=inventory(session,keys),dependencies=metadataClosure.dependencies.map(prior=>metadata(session,prior.key));return C.canonical({dependencies,canonicalInventory})===C.canonical(metadataClosure);}


// Fixed full-Micro renderer projection. Only byte/type scalars cross the SQL
// boundary until all record and aggregate source limits have been admitted.
const jsonField=(expr,name,column='value')=>`(SELECT ${column} FROM json_each(${expr}) WHERE CAST(key AS BLOB)=X'${Buffer.from(name).toString('hex')}' LIMIT 1)`;
function microProjectedSizes(session,fact,{archive=false}={}){
 const s=IO.assertOwnerSession(session);rowPreflight(session,fact);
 const f=jsonField,sz=expr=>`length(CAST(${expr} AS BLOB))`,record='records.body',claims=f(record,'claims'),excerpt=f(record,'excerpt');
 const textType=(expr,name)=>`${f(expr,name,'type')}='text'`;
 const evidence=f('claim.value','evidence');
 const claimBytes=`${Buffer.byteLength('[변화  ·  · ] \n근거: ')}+${sz('CAST(CAST(claim.key AS INTEGER)+1 AS TEXT)')}+${sz(f(evidence,'role'))}+${sz(f(evidence,'messageId'))}+${sz(f('claim.value','text'))}+${sz(f(evidence,'exactQuote'))}`;
 const validClaim=`claim.type='object' AND ${f('claim.value','evidence','type')}='object' AND ${textType('claim.value','text')} AND ${textType(evidence,'role')} AND ${textType(evidence,'messageId')} AND ${textType(evidence,'exactQuote')}`;
 const claimSource=`json_each(CASE WHEN ${f(record,'claims','type')}='array' THEN ${claims} ELSE '[]' END)`;
 const verified=`CASE WHEN ${f(record,'claims','type')}='array' AND (SELECT count(*) FROM ${claimSource}) BETWEEN 1 AND 16 AND NOT EXISTS(SELECT 1 FROM ${claimSource} claim WHERE NOT coalesce(${validClaim},0)) THEN (SELECT sum(${claimBytes})+count(*)-1 FROM ${claimSource} claim) END`;
 const minimum=`CASE WHEN ${f(record,'excerpt','type')}='object' AND ${textType(excerpt,'role')} AND ${textType(excerpt,'messageId')} AND ${textType(excerpt,'exactQuote')} THEN ${Buffer.byteLength('[원문 발췌 ·  · ] ')}+${sz(f(excerpt,'role'))}+${sz(f(excerpt,'messageId'))}+${sz(f(excerpt,'exactQuote'))} END`;
 const bodyBytes=`${Buffer.byteLength('[MICRO T · 단일 턴 근거]\n')}+${sz(`CAST(${f(record,'turn')} AS TEXT)`)}+CASE ${f(record,'analysisStatus')} WHEN 'verified' THEN ${verified} WHEN 'minimum_source_bound' THEN ${minimum} END`;
 const records=archive?`SELECT ${f('row.value','key')} AS key,${f('row.value','value')} AS body FROM obj,json_each(CASE WHEN ${f('obj.body','records','type')}='array' THEN ${f('obj.body','records')} ELSE '[]' END) row WHERE ${f(f('row.value','value'),'schema')}='libra.micro_memory.v1'`:`SELECT ? AS key,body FROM obj`;
 const sql=`WITH obj AS MATERIALIZED(SELECT json_extract(value_json,'$') AS body FROM kv WHERE space='plugin' AND key=? AND revision=? AND digest=? AND deleted=0),records AS MATERIALIZED(${records}),projected AS MATERIALIZED(SELECT key,${bodyBytes} AS narrative_bytes FROM records),totals AS(SELECT count(*) n,coalesce(sum(narrative_bytes),0) bytes,coalesce(min(narrative_bytes>0 AND typeof(key)='text' AND length(CAST(key AS BLOB))<=12288),1) good FROM projected) SELECT n,bytes,good,CASE WHEN n<=8192 AND bytes<=1048576 AND good=1 THEN CAST(key AS BLOB) END AS key,CASE WHEN n<=8192 AND bytes<=1048576 AND good=1 THEN narrative_bytes END AS narrative_bytes FROM projected CROSS JOIN totals LIMIT 8193`;
 const args=[fact.key,fact.rowRevision,fact.rowDigest,...(archive?[]:[fact.key])];
 const rows=IO.acquireRows(s.db,sql,args,s.budget,{kind:'source',maximum:MiB,many:true,overhead:9*MiB});
 if(rows.length>8192||rows.some(r=>r.n!==rows.length||r.bytes>MiB))C.fail('RESOURCE_LIMIT');
 if(rows.some(r=>r.good!==1||typeof r.key!=='string'||!Number.isSafeInteger(r.narrative_bytes)||r.narrative_bytes<1))C.fail('SOURCE_PROFILE_UNAVAILABLE');
 const sizes=new Map();for(const r of rows){key(r.key);if(sizes.has(r.key))C.fail('SOURCE_PROOF_UNAVAILABLE');sizes.set(r.key,r.narrative_bytes);}
 const bytes=[...sizes.values()].reduce((sum,n)=>sum+n,0);s.plannedNarrative=(s.plannedNarrative||0)+bytes;if(s.plannedNarrative>MiB)C.fail('RESOURCE_LIMIT');return sizes;
}
module.exports={CODEC,PROFILE,BINDING,scopeKeys,captureCanonicalFacts,compareLibraFactClosure,metadata,inventory,decodeRow,key,microProjectedSizes};
