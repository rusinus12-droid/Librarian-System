'use strict';
// A bounded restoration protocol, not a provider or whole-corpus repair engine.
// Only one existing active shard's already-referenced Float32 payload can change.
const crypto = require('node:crypto');
const SCHEMA = 'flashback.server-vector-repair.v2';
const MAX_ROWS = 60, MAX_VALUE_BYTES = 2 * 1024 ** 2, MAX_TOTAL_BYTES = 8 * 1024 ** 2;
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = value => Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const hash = value => { let h=0x811c9dc5; for(let i=0;i<value.length;i++) h=Math.imul(h^value.charCodeAt(i),0x01000193); return(h>>>0).toString(36); };
const fail = (code, statusCode=409) => { throw Object.assign(new Error(code), {code,statusCode}); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return null; } };
const id = value => typeof value === 'string' && /^[A-Za-z0-9._-]{16,100}$/.test(value);
const referencedPayloadValid = (row,target,scopeKey) => {
  if(!row.exists||sha(row.value)!==row.digest)return false;
  const p=parse(row.value);
  if(!object(p)||p.schema!=='flashback_memory.local_vector_shard.v1'||p.scopeKey!==scopeKey||p.commitId!==target.commitId||p.shardIndex!==target.shardIndex
    ||JSON.stringify(p.items)!==JSON.stringify(target.items)||p.floatCount!==target.floatCount||p.itemCount!==target.items.length||p.byteLength!==target.floatCount*4
    ||typeof p.data!=='string'||p.digest!==target.expectedDigest)return false;
  const bytes=Buffer.from(p.data,'base64');if(bytes.length!==p.byteLength||bytes.toString('base64')!==p.data)return false;
  for(const item of target.items){let nonzero=false;for(let i=item.offset;i<item.offset+item.length;i++){const v=bytes.readFloatLE(i*4);if(!Number.isFinite(v))return false;if(v!==0)nonzero=true;}if(!nonzero)return false;}
  return hash(JSON.stringify({scopeKey:p.scopeKey,commitId:p.commitId,shardIndex:p.shardIndex,items:p.items,data:p.data}))===target.expectedDigest;
};
const predicate = (space,key,row) => ({space,key,expectedRevision:row.revision,expectedDigest:row.digest,expectedExists:row.exists===true,expectedTombstone:row.tombstone===true});
const publicOperation = (j, extra={}) => ({schema:SCHEMA,operationId:j.operationId,state:j.state,requestId:j.requestId||null,
  durable:true,wireAuthorized:false,providerOutcome:'not_used',publicationAuthorized:false,strongProofAvailable:!!j.strongProof,
  hostAuthorityVerified:false,profileAuthorityVerified:false,physicalRepairAllowed:false,originalVectorBytesVerified:j.state==='completed'&&!!j.strongProof,vectorProof:j.strongProof?'server_bound_backup_sha256':'none',sourceMutationAllowed:false,
  repairKind:'restore_referenced_vector_payload',...extra});
module.exports = ({getRepository,dataInstanceId,epochs,canWrite,strongProofProvider}) => {
  const authority = body => {
    if(body.dataInstanceId!==dataInstanceId)fail('REPAIR_DATA_CHANGED');
    if(!Number.isSafeInteger(body.epoch)||body.epoch<0||body.epoch!==Number(epochs().flashback||0))fail('REPAIR_RESET_CHANGED');
    if(body.mode!=='server_only')fail('REPAIR_SERVER_MODE_REQUIRED');
    if(!/^[a-f0-9]{64}$/.test(body.authorityDigest||''))fail('REPAIR_AUTHORITY_DIGEST_REQUIRED',400);
    if(!canWrite())fail('REPAIR_MAINTENANCE',503);
  };
  const names = scopeKey => {const alias=hash(scopeKey),prefix=`vector_rag_memory:scope:${alias}:`;return {alias,prefix,vectorPrefix:`vector_rag_memory:local-vector-shard:v1:${alias}:`,head:prefix+'server_physical_repair:v2',journal:op=>prefix+'server_physical_repair:v2:'+op};};
  const binding = body => ({scopeKey:body.scopeKey,dataInstanceId:body.dataInstanceId,epoch:body.epoch,mode:body.mode,authorityDigest:body.authorityDigest});
  const rawRead = (repo,space,key) => {
    let metadata;
    if(space==='plugin'&&/:server_physical_repair:v2(?::[A-Za-z0-9._-]{16,100})?$/.test(key)){
      if(typeof repo.getMetadata!=='function')fail('REPAIR_STORAGE_UNVERIFIED',503);
      metadata=repo.getMetadata(space,key);
      if(metadata?.namespace!=='flashback'||metadata.space!==space||metadata.key!==key||!Number.isSafeInteger(metadata.valueBytes)||metadata.valueBytes<0)fail('REPAIR_STORAGE_UNVERIFIED',503);
      if(metadata.valueBytes>MAX_VALUE_BYTES)fail('REPAIR_VALUE_LIMIT');
    }
    let row;try{row=repo.get(space,key,{maxValueBytes:MAX_VALUE_BYTES});}catch(error){if(error?.code==='STORAGE_VALUE_LIMIT')fail('REPAIR_VALUE_LIMIT');throw error;}
    if(!Number.isSafeInteger(row?.revision)||row.revision<0||typeof row.exists!=='boolean'||typeof row.tombstone!=='boolean'
      ||row.exists&&row.tombstone||row.revision===0&&(row.exists||row.tombstone||row.digest!=='')||row.revision>0&&!/^[a-f0-9]{64}$/.test(row.digest||''))fail('REPAIR_STORAGE_UNVERIFIED',503);
    if(metadata&&['revision','digest','exists','tombstone','updatedAt'].some(field=>metadata[field]!==row[field]))fail('REPAIR_SNAPSHOT_CHANGED');
    if(space==='plugin'&&row.exists&&sha(row.value)!==row.digest)fail('REPAIR_JOURNAL_OR_SOURCE_DIGEST_INVALID');return row;
  };
  const snapshot = (repo,body) => {
    authority(body);const n=names(body.scopeKey),rows=[],readSet=[],values=new Map();let bytes=0;
    for(const [space,prefix] of [['plugin',n.prefix],['local',n.vectorPrefix]]){
      const page=repo.list(space,prefix,{paged:true,limit:1000,cursorKey:''});
      if(!Array.isArray(page?.records)||page.page?.hasMore!==false||page.records.length>1000)fail('REPAIR_INVENTORY_INCOMPLETE');
      for(const listed of page.records){
        if(typeof listed.key!=='string'||!listed.key.startsWith(prefix))fail('REPAIR_INVENTORY_UNVERIFIED');
        const name=listed.key.slice(prefix.length);
        // Protocol records have separate exact predicates and never carry source authority.
        if(space==='plugin'&&/^server_physical_repair:v2(?::[A-Za-z0-9._-]{16,100})?$/.test(name))continue;
        if(rows.length>=MAX_ROWS)fail('REPAIR_READ_SET_LIMIT');
        const allowed=space==='plugin'?/^(?:manifest:v2(?::previous:v1)?|turn_worldline:v1|source-edit-consent:v1|records:shard:[0-9]{4,6}|records:commit:[A-Za-z0-9_-]{1,160}:shard:[0-9]{4,6})$/.test(name):/^[A-Za-z0-9_-]{1,160}:[0-9]{4,6}$/.test(name);
        if(!allowed)fail('REPAIR_UNSUPPORTED_SCOPE_RECORD');
        if(!Number.isSafeInteger(listed.valueBytes)||listed.valueBytes<0||listed.valueBytes>MAX_VALUE_BYTES||bytes+listed.valueBytes>MAX_TOTAL_BYTES)fail('REPAIR_VALUE_LIMIT');
        const row=rawRead(repo,space,listed.key);
        if(row.revision!==listed.revision||row.digest!==listed.digest||row.tombstone!==listed.tombstone)fail('REPAIR_SNAPSHOT_CHANGED');
        const actual=row.exists?sha(row.value):'';
        if(space==='plugin'&&row.exists&&actual!==row.digest)fail('REPAIR_SOURCE_DIGEST_INVALID');
        bytes+=row.exists?Buffer.byteLength(JSON.stringify(row.value)):0;if(bytes>MAX_TOTAL_BYTES)fail('REPAIR_VALUE_LIMIT');
        rows.push([space,listed.key,row.revision,row.digest,row.exists,row.tombstone,actual]);readSet.push(predicate(space,listed.key,row));values.set(space+'\n'+listed.key,row);
      }
    }
    const manifest=parse(values.get('plugin\n'+n.prefix+'manifest:v2')?.value);
    if(!object(manifest)||manifest.schema!=='vector_rag_memory.scope_manifest.v2'||manifest.scopeKey!==body.scopeKey)fail('REPAIR_MANIFEST_UNVERIFIED');
    if(manifest.archiveRef||manifest.archiveOwner||body.scopeKey.startsWith('flashback_archive_v1:')||['rawPageLayout','rawPageReferences','rawPageDirectoryDigest'].some(k=>Object.hasOwn(manifest,k)))fail('REPAIR_LAYOUT_UNSUPPORTED');
    if(!Number.isSafeInteger(manifest.shardCount)||manifest.shardCount<1||manifest.shardCount>MAX_ROWS||!Number.isSafeInteger(body.shardIndex)||body.shardIndex<0||body.shardIndex>=manifest.shardCount
      ||typeof manifest.commitId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(manifest.commitId))fail('REPAIR_SHARD_UNVERIFIED');
    let target,recordCount=0;
    for(let i=0;i<manifest.shardCount;i++){
      const key=n.prefix+`records:commit:${manifest.commitId}:shard:${String(i).padStart(4,'0')}`,shard=parse(values.get('plugin\n'+key)?.value);
      if(!object(shard)||shard.scopeKey!==body.scopeKey||shard.commitId!==manifest.commitId||shard.shard!==i||!Array.isArray(shard.records)||!shard.records.length
        ||shard.records.some(r=>!object(r)||r.scopeKey!==body.scopeKey))fail('REPAIR_SOURCE_INCOMPLETE');
      recordCount+=shard.records.length;if(i===body.shardIndex)target=shard;
    }
    if(manifest.count!==recordCount)fail('REPAIR_SOURCE_INCOMPLETE');
    const key=n.vectorPrefix+`${manifest.commitId}:${String(body.shardIndex).padStart(4,'0')}`,items=[];let nextOffset=0,expectedDigest='';
    for(const record of target.records){
      if(record.vectorRef==null)continue;const ref=record.vectorRef;
      if(ref.schema!=='flashback_memory.local_vector_ref.v1'||ref.storage!=='local'||ref.storageKey!==key||ref.recordId!==String(record.id||record.hash||'')
        ||!ref.recordId||ref.offset!==nextOffset||!Number.isSafeInteger(ref.length)||ref.length<1||ref.length>65536||record.dim!==ref.length
        ||!Array.isArray(record.vector)||record.vector.length||ref.mode!=='local_float32_shard_v1'||!/^[a-z0-9]{1,8}$/.test(ref.digest||'')
        ||expectedDigest&&ref.digest!==expectedDigest)fail('REPAIR_VECTOR_REFERENCE_UNVERIFIED');
      expectedDigest=ref.digest;items.push({recordId:ref.recordId,offset:ref.offset,length:ref.length});nextOffset+=ref.length;
    }
    if(!items.length||items.length>200||new Set(items.map(r=>r.recordId)).size!==items.length||nextOffset*4>MAX_VALUE_BYTES/2)fail('REPAIR_VECTOR_REFERENCE_UNVERIFIED');
    const targetRow=values.get('local\n'+key)||rawRead(repo,'local',key);
    if(!values.has('local\n'+key))readSet.push(predicate('local',key,targetRow));
    rows.sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
    authority(body);
    const sourceRows=readSet.filter(r=>r.space==='plugin'&&(r.key===n.prefix+'manifest:v2'||r.key.startsWith(n.prefix+'records:commit:'+manifest.commitId+':shard:')));
    return {fingerprint:sha({binding:binding(body),rows,absentTarget:targetRow.revision===0?key:null,shardIndex:body.shardIndex}),readSet,sourceRows,
      target:{key,commitId:manifest.commitId,shardIndex:body.shardIndex,items,floatCount:nextOffset,expectedDigest},targetRow};
  };
  return (principal,action,body) => {
    let proof;
    try{
      if(principal?.namespace!=='flashback'||!principal.roles?.includes('owner'))fail('REPAIR_OWNER_REQUIRED',403);
      const fields={preview:['shardIndex','backupId'],reserve:['shardIndex','operationId','previewFingerprint','backupId'],submitted:['operationId','requestId'],status:['operationId'],cancel:['operationId'],commit:['operationId','requestId']};
      if(!fields[action]||!object(body)||Object.keys(body).some(k=>!['scopeKey','dataInstanceId','epoch','mode','authorityDigest',...fields[action]].includes(k)))fail('REPAIR_REQUEST_INVALID',400);
      if(typeof body.scopeKey!=='string'||!body.scopeKey||body.scopeKey!==body.scopeKey.trim()||body.scopeKey.length>512||/[\r\n\0]/.test(body.scopeKey))fail('REPAIR_SCOPE_INVALID',400);
      if(Buffer.byteLength(JSON.stringify(body))>MAX_VALUE_BYTES)fail('REPAIR_BODY_LIMIT',413);
      authority(body);const repo=getRepository(),n=names(body.scopeKey);
      if(action==='preview'){
        repo.database.exec('BEGIN');try{const s=snapshot(repo,body),valid=referencedPayloadValid(s.targetRow,s.target,body.scopeKey);
          let reason=valid?'payload_already_valid':'strong_backup_proof_required';
          if(!valid&&strongProofProvider&&body.backupId){try{proof=strongProofProvider.capture({backupId:body.backupId,binding:binding(body),target:s.target,sourceRows:s.sourceRows});proof.assertCurrent();reason='verified_backup_available';}catch(_){proof?.close();proof=null;reason='strong_backup_proof_unavailable';}}
          return {schema:SCHEMA,allowed:!valid&&!!proof,reason,readOnly:true,fingerprint:s.fingerprint,shardIndex:body.shardIndex,backupId:proof?.descriptor.backupId||null,vectorCount:s.target.items.length,
          hostAuthorityVerified:false,profileAuthorityVerified:false,physicalRepairAllowed:false,originalVectorBytesVerified:false,strongProofAvailable:!!proof,vectorProof:proof?'server_bound_backup_sha256':'none',sourceMutationAllowed:false,
          repairKind:'restore_referenced_vector_payload',limits:{maxRows:MAX_ROWS,maxValueBytes:MAX_VALUE_BYTES,maxTotalBytes:MAX_TOTAL_BYTES},
          exclusions:['archive','raw_page_directory','reembedding','host_currentness','profile_currentness','settings','credentials']};}finally{repo.database.exec('ROLLBACK');}
      }
      if(!id(body.operationId))fail('REPAIR_OPERATION_ID_INVALID',400);
      if(['submitted','commit'].includes(action)&&!id(body.requestId))fail('REPAIR_REQUEST_ID_INVALID',400);
      const journalKey=n.journal(body.operationId),journalRow=rawRead(repo,'plugin',journalKey),j=journalRow.exists?parse(journalRow.value):null;
      if(journalRow.exists&&(!object(j)||j.schema!==SCHEMA||j.operationId!==body.operationId))fail('REPAIR_JOURNAL_UNVERIFIED');
      if(j&&sha(j.binding)!==sha(binding(body)))fail('REPAIR_AUTHORITY_CHANGED');
      if(action==='status'){if(!j)fail('REPAIR_OPERATION_NOT_FOUND',404);return publicOperation(j);}
      const inputHash=sha(stable({action,...body})),prior=j?.stageInputs?.[action];
      if(prior){if(prior!==inputHash)fail('REPAIR_OPERATION_PAYLOAD_CONFLICT');return publicOperation(j,{reconciled:true});}
      if(action!=='reserve'&&!j)fail('REPAIR_OPERATION_NOT_FOUND',404);
      if(action==='reserve'&&j)fail('REPAIR_OPERATION_PAYLOAD_CONFLICT');
      if(action==='reserve'&&!/^[a-f0-9]{64}$/.test(body.previewFingerprint||''))fail('REPAIR_PREVIEW_REQUIRED',400);
      if(j&&['completed','cancelled','unknown'].includes(j.state))fail('REPAIR_OPERATION_TERMINAL');
      if(action==='submitted'&&j.state!=='reserved'||action==='commit'&&(j.state!=='submitted'||j.requestId!==body.requestId))fail('REPAIR_PHASE_INVALID');
      const headRow=rawRead(repo,'plugin',n.head),head=headRow.exists?parse(headRow.value):null;
      if(headRow.exists&&(!object(head)||head.schema!==SCHEMA))fail('REPAIR_HEAD_UNVERIFIED');
      if(action==='reserve'&&head&&['reserved','submitted','unknown'].includes(head.state)&&head.operationId!==body.operationId)fail('REPAIR_SCOPE_BUSY');
      if(action!=='reserve'&&(!head||head.operationId!==body.operationId||head.state!==j.state))fail('REPAIR_HEAD_CHANGED');
      const s=action==='cancel'?{readSet:[],fingerprint:j.sourceFingerprint,sourceRows:j.sourceRows,target:j.target}:snapshot(repo,{...body,shardIndex:j?.target.shardIndex??body.shardIndex});
      if(s.fingerprint!==(j?.sourceFingerprint??body.previewFingerprint))fail('REPAIR_SOURCE_CHANGED');
      if(action==='reserve'&&referencedPayloadValid(s.targetRow,s.target,body.scopeKey))fail('REPAIR_PAYLOAD_ALREADY_VALID');
      if(j&&sha(j.target)!==sha(s.target))fail('REPAIR_DURABLE_TARGET_CHANGED');
      if(!strongProofProvider||!(j?.strongProof?.backupId||body.backupId))fail('REPAIR_STRONG_PROOF_REQUIRED');
      proof=strongProofProvider.capture({backupId:j?.strongProof?.backupId||body.backupId,binding:binding(body),target:s.target,sourceRows:s.sourceRows});proof.assertCurrent();
      if(j&&sha(j.strongProof)!==sha(proof.descriptor))fail('REPAIR_STRONG_PROOF_CHANGED');
      const fence=repo.writerFence.command({action:'acquire',key:n.prefix+'manifest:v2',owner:body.operationId});
      const next=j?JSON.parse(JSON.stringify(j)):{schema:SCHEMA,operationId:body.operationId,binding:binding(body),sourceFingerprint:s.fingerprint,target:s.target,sourceRows:s.sourceRows,strongProof:proof.descriptor,createdAt:Date.now(),stageInputs:{}};
      next.stageInputs[action]=inputHash;next.state=action==='reserve'?'reserved':action==='submitted'?'submitted':action==='commit'?'completed':j.requestId?'unknown':'cancelled';
      if(action==='submitted')next.requestId=body.requestId;
      const mutations=[{...predicate('plugin',journalKey,journalRow),kind:'set',value:next},{...predicate('plugin',n.head,headRow),kind:'set',value:{schema:SCHEMA,operationId:body.operationId,state:next.state}}];
      if(action==='commit')mutations.push({...predicate('local',s.target.key,s.targetRow),kind:'set',value:proof.storedValue});
      const written=new Set(mutations.map(r=>r.space+'\n'+r.key)),checks=s.readSet.filter(r=>!written.has(r.space+'\n'+r.key)).map(r=>({...r,kind:'check'}));
      const operationId='fb_repair_'+body.operationId+'_'+action;
      repo.applyConditionalBatch([...checks,...mutations],{operationId,fence,scopeId:body.scopeKey,assertTransactionCurrent:()=>{
        authority(body);proof.assertCurrent();
        const currentJournal=rawRead(repo,'plugin',journalKey),currentHead=rawRead(repo,'plugin',n.head);
        if(sha(currentJournal)!==sha(journalRow)||sha(currentHead)!==sha(headRow))fail('REPAIR_JOURNAL_CHANGED');
        if(action!=='cancel'){const inside=snapshot(repo,{...body,shardIndex:next.target.shardIndex});if(inside.fingerprint!==next.sourceFingerprint)fail('REPAIR_SOURCE_CHANGED');}
      }});
      const durable=rawRead(repo,'plugin',journalKey);if(!durable.exists||sha(durable.value)!==sha(next)||!repo.operation(operationId))fail('REPAIR_COMMIT_UNCONFIRMED',503);
      if(['completed','cancelled'].includes(next.state))repo.writerFence.command({action:'release',key:n.prefix+'manifest:v2',...fence});
      return publicOperation(next,{publicationAuthorized:action==='submitted',reconciled:false});
    }catch(error){if(/^REPAIR_[A-Z_]+$/.test(error?.code||''))throw error;fail('REPAIR_STORAGE_UNCONFIRMED',503);}
    finally{proof?.close();}
  };
};
