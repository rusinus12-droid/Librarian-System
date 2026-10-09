'use strict';
// Stored typed approved-input/render closure. No native/current-State authority.
const C=require('./contracts.cjs'),J=require('./observation-json.cjs'),V=require('./libra-source-codec.cjs'),T=require('./libra-typed-codec.cjs'),M=require('./receipt-codec.cjs');
const need=V.requireFact,str=V.requiredString,int=V.integer;
const fingerprint=T.memorySuiteReviewFingerprint,digest=T.digest;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const schemas=['libra.canonical_artifact.v4','libra.canonical_artifact.v5'];
function declared(memory,ref){return [memory.artifactSchema,memory.canonicalArtifact?.schema,ref.artifactSchema].some(value=>value!=null);}
function typed(memory,ref){const values=[memory.artifactSchema,memory.canonicalArtifact?.schema,ref.artifactSchema];if(!values.some(value=>schemas.includes(value)))return false;need(values.every(value=>value===memory.artifactSchema));return true;}
function approvedInput(memory,read){
 const er=J.exact(memory.sourceEvidenceRef,['schema','owner','scopeKey','key','payloadDigest','sourceDigest','identity','normalizationVersion']);
 need(er.schema==='memory-suite.source-evidence-ref.v1'&&er.owner==='libra'&&er.scopeKey===memory.scopeKey&&er.sourceDigest===memory.sourceDigest);for(const k of ['identity','payloadDigest','normalizationVersion'])str(er[k]);
 const start=int(memory.turnRange.start,1),end=int(memory.turnRange.end,start);need(end===start+4&&(start-1)%5===0);
 const binding={owner:'libra',scopeKey:memory.scopeKey,unitKey:String(start),start,end,identity:er.identity,sourceDigest:memory.sourceDigest};
 const key=`libra:v1:scope:${memory.scopeKey}:source-evidence:v1:`+fingerprint(['libra',memory.scopeKey,String(start),er.identity,memory.sourceDigest]);need(er.key===key);
 const record=J.exact(read(key),['schema','binding','normalizationVersion','rows','payloadDigest']);
 need(record.schema==='memory-suite.source-evidence.v1'&&same(record.binding,binding)&&record.normalizationVersion===er.normalizationVersion);
 need(record.normalizationVersion==='libra-comparison:illustration-v1'||/^libra-comparison:source-rules-v1:[a-f0-9]{8}:\d+$/.test(record.normalizationVersion));
 need(Array.isArray(record.rows)&&record.rows.length===5);const ids=new Set();
 for(let i=0;i<5;i++){const r=J.exact(record.rows[i],['turn','userMessageId','assistantMessageId','userText','assistantText','userRaw','assistantRaw','rawAvailable','projectionLabel']);need(r.turn===start+i&&typeof r.rawAvailable==='boolean');for(const field of ['userMessageId','assistantMessageId']){str(r[field]);need(!ids.has(r[field]));ids.add(r[field]);}for(const field of ['userText','assistantText','userRaw','assistantRaw','projectionLabel'])J.unicode(r[field]);}
 need(record.payloadDigest===er.payloadDigest&&record.payloadDigest===fingerprint(JSON.stringify({binding:record.binding,normalizationVersion:record.normalizationVersion,rows:record.rows})));
 const batch=record.rows.map(r=>({turn:r.turn,user:{chatId:r.userMessageId,text:r.userText},assistant:{chatId:r.assistantMessageId,text:r.assistantText}}));
 need(T.sourceDigest(batch)===memory.sourceDigest&&digest(T.sourcePairs(batch))===digest(memory.sourcePairs));
 need(er.identity===T.branchContentHash(JSON.stringify([memory.scopeKey,memory.worldlineId||'main',batch.map(p=>[p.user.chatId,p.assistant.chatId])])));
 return {batch,proof:{...er,binding,rows:record.rows,rowCount:5,roleCount:10,recordSha256:C.hash(record),authority:'stored-approved-input-only'}};
}
function rawPacket(memory,pair,ref,read){
 J.exact(ref,['schema','storageKey','field','packetDigest','originRelation','algorithm','scopeKey','worldlineId','sessionEpoch','turn','sourceRevisionId','sourceDigest']);
 need(ref.schema==='libra.completed_turn_raw_ref.v1'&&ref.algorithm==='SHA-256'&&['current_original_capture','transferred_original_capture'].includes(ref.originRelation));str(ref.scopeKey);str(ref.worldlineId);int(ref.sessionEpoch);need(ref.turn===pair.turn&&ref.sourceDigest===T.sourceDigest([pair]));str(ref.sourceRevisionId);need(/^[a-f0-9]{64}$/.test(ref.packetDigest));
 // Archive copies can retain the source's immutable raw reference; rebinding of
 // approved evidence is separate and captured by unifiedTransfer below.
 need(ref.scopeKey===memory.scopeKey||memory.unifiedTransfer?.sourceScopeKey===ref.scopeKey||memory.unifiedTransfer&&memory.unifiedOrigin?.scopeKey===ref.scopeKey);
 const receiptKey=V.key.completedTurnReceipt(ref,ref.worldlineId,ref.sessionEpoch,ref.turn,ref.sourceRevisionId),captureKey=V.key.completedTurnCapture(ref,ref.worldlineId,ref.sessionEpoch,ref.turn,ref.sourceRevisionId);
 need([receiptKey,captureKey].includes(ref.storageKey)&&(ref.field==='rawSourcePacket'||ref.storageKey===captureKey&&/^rawSourceVariants\.[a-f0-9]{64}$/.test(ref.field)));
 const receipt=V.receipt(read(receiptKey),receiptKey);need(receipt.sourceDigest===ref.sourceDigest&&receipt.scopeKey===ref.scopeKey&&receipt.worldlineId===ref.worldlineId&&receipt.sessionEpoch===ref.sessionEpoch&&receipt.turn===ref.turn&&same(T.sourcePairs([receipt]),T.sourcePairs([pair])));
 const physical=ref.storageKey===receiptKey?receipt:read(captureKey);need(physical.schema===(ref.storageKey===receiptKey?'libra.completed_turn_receipt.v1':'libra.completed_turn_capture.v1')&&physical.scopeKey===receipt.scopeKey&&physical.worldlineId===receipt.worldlineId&&physical.sessionEpoch===receipt.sessionEpoch&&physical.turn===receipt.turn&&physical.revisionId===receipt.revisionId&&physical.sourceDigest===receipt.sourceDigest);
 if(ref.storageKey===captureKey)need(physical.receiptKey===receiptKey);
 need(same(physical.rawPacketRef,ref)||Array.isArray(physical.rawVariantRefs)&&physical.rawVariantRefs.some(candidate=>same(candidate,ref)));
 const packet=ref.field==='rawSourcePacket'?physical.rawSourcePacket:physical.rawSourceVariants?.[ref.field.slice('rawSourceVariants.'.length)];J.plain(packet);const origin=J.plain(packet.origin);
 need(packet.schema==='libra.completed_turn_raw_packet.v1'&&packet.packetDigest===ref.packetDigest);const {packetDigest,...body}=packet;need(M.hashUtf8(JSON.stringify(body))===packetDigest);
 if(ref.field!=='rawSourcePacket')need(ref.field==='rawSourceVariants.'+packetDigest);
 for(const field of ['scopeKey','worldlineId','sourceRevisionId','sourceDigest'])str(origin[field]);int(origin.turn,1);int(origin.sessionEpoch);need(origin.completionProvenance==='validated_original_source_rows');
 if(ref.originRelation==='current_original_capture')for(const field of ['scopeKey','worldlineId','sessionEpoch','turn','sourceDigest'])need(origin[field]===receipt[field]);
 if(ref.originRelation==='current_original_capture')need(origin.sourceRevisionId===receipt.revisionId);
 const segments=[];
 for(const role of ['user','assistant']){const rows=packet[role]?.segments;need(Array.isArray(rows)&&rows.length>0);const projected=rows.filter(row=>row.contributesText===true);need(projected.length===receipt[role].sourceMessageCount&&digest(projected.map(row=>row.rawPayloadDigest))===digest(receipt[role].rawPayloadDigests));if(ref.originRelation==='current_original_capture')need(digest(projected.map(row=>row.messageId))===digest(receipt[role].chatIds));
  for(let i=0;i<rows.length;i++){const row=J.plain(rows[i]);J.unicode(row.rawValue);need(['string','json','number','boolean','null'].includes(row.rawType)&&typeof row.contributesText==='boolean');str(row.messageId);str(row.identitySource);int(row.index);need(i===0||row.index>rows[i-1].index);need(digest({type:row.rawType,value:row.rawValue})===row.rawPayloadDigest&&Buffer.byteLength(row.rawValue)===row.utf8ByteLength&&M.hashUtf8(row.rawValue)===row.utf8Sha256);segments.push({role,messageId:row.messageId,index:row.index,rawType:row.rawType,contributesText:row.contributesText,utf8ByteLength:row.utf8ByteLength,utf8Sha256:row.utf8Sha256});}
 }
 // The active native rows are deliberately not fabricated from this packet.
 return {ref,receiptKey,receiptSha256:C.hash(receipt),physicalSha256:C.hash(physical),packetSha256:packetDigest,segments,origin,authority:'stored-original-capture-only',nativeCurrentness:'unavailable'};
}
function basisProof(memory,read){if(memory.unifiedBasis==null)return {status:'not_recorded'};const basis=J.plain(memory.unifiedBasis);need(['libra.unified.v1','libra.unified.v2'].includes(basis.engineVersion)&&basis.scopeKey===memory.scopeKey&&basis.sourceDigest===memory.sourceDigest&&basis.worldlineId==='main');
 for(const flag of ['memoryFirst','statePending','replayRequired'])if(basis[flag]!=null)need(typeof basis[flag]==='boolean');
 const key=`libra:v1:scope:${memory.scopeKey}:entity-registry:v2:unified-basis:${memory.memoryId}:${memory.revision}`;need(basis.snapshotKey===key);str(basis.snapshotDigest);const snapshot=read(key,{optional:true});
 // The producer explicitly removes this execution snapshot after State work.
 // Its absence is a captured historical fact, never authority to replay work.
 if(snapshot){need(snapshot.schema==='libra.unified_basis_snapshot.v1'&&snapshot.scopeKey===memory.scopeKey&&digest(snapshot)===basis.snapshotDigest);if(!basis.replayRequired)need(digest(snapshot.head)===basis.headDigest&&digest(snapshot.registry)===basis.registryDigest);}
 return {status:'historical-execution-descriptor',descriptor:basis,sha256:C.hash(basis),snapshotKey:key,snapshotStatus:snapshot?'present':'absent-transient',snapshotSha256:snapshot?C.hash(snapshot):null,stateAuthority:'unavailable',executionAuthority:'unavailable'};
}
function transferProof(memory,batch,read){if(memory.unifiedTransfer==null)return null;const transfer=J.plain(memory.unifiedTransfer);need(transfer.schema==='libra.unified_transfer_binding.v1'&&transfer.targetScopeKey===memory.scopeKey&&transfer.targetMemoryId===memory.memoryId&&transfer.targetSourceDigest===memory.sourceDigest&&transfer.artifactDigest===memory.artifactDigest&&transfer.consentTransferred===false&&transfer.remoteJobsTransferred===false);str(transfer.sourceScopeKey);str(transfer.sourceMemoryId);int(transfer.sourceRevision,1);
 const er=transfer.sourceEvidenceRef;need(er?.scopeKey===transfer.sourceScopeKey);const source=approvedInput({...memory,scopeKey:transfer.sourceScopeKey,sourceDigest:er.sourceDigest,sourceEvidenceRef:er,sourcePairs:read(er.key).rows.map(r=>({turn:r.turn,userChatId:r.userMessageId,assistantChatId:r.assistantMessageId}))},read);
 need(source.batch.every((p,i)=>p.user.text===batch[i].user.text&&p.assistant.text===batch[i].assistant.text));return {binding:transfer,sourceApprovedInput:source.proof};
}
function validate(memory,ref,read,budget){
 need(typed(memory,ref));if(memory.engineVersion!=null)need(['libra.unified.v1','libra.unified.v2'].includes(memory.engineVersion));need(memory.artifactDigest===digest(memory.canonicalArtifact)&&ref.artifactDigest===memory.artifactDigest&&T.unifiedRecordAdmissionValid(memory,ref));
 const source=approvedInput(memory,read);if(ref.sourceEvidenceDigest!=null)need(ref.sourceEvidenceDigest===source.proof.payloadDigest);if(ref.unifiedOriginDigest!=null)need(ref.unifiedOriginDigest===T.unifiedOriginKey(memory));
 // Fixed artifact arrays are capped by the production codec (100 entities,
 // 120 facts, ten spans each, 120000 UTF-16 artifact units). Reserve renderer,
 // source comparisons, artifact projection and result before invoking them.
 const comparableUnits=source.batch.reduce((sum,pair)=>sum+pair.user.text.length+pair.assistant.text.length,0);
 // Unicode NFKC can expand one scalar substantially. Bound normalization and
 // renderer scratch independently of the already reserved parsed source rows.
 budget.reserve(4*J.MiB+comparableUnits*64);need(T.validateUnifiedArtifact(memory.canonicalArtifact,source.batch,{allowLegacyProfileStrings:true}).ok);
 const rendered=T.renderUnifiedArtifact(memory.canonicalArtifact);J.unicode(rendered);need(rendered===memory.text);
 if(memory.rawPacketRefs!=null)need(Array.isArray(memory.rawPacketRefs)&&memory.rawPacketRefs.length===5);
 const rawPackets=(memory.rawPacketRefs||[]).map((ref,i)=>rawPacket(memory,source.batch[i],ref,read));
 const transfer=memory.unifiedTransfer==null?null:transferProof(memory,source.batch,read);
 return {threadTargets:[],typedArtifact:{schema:memory.artifactSchema,digest:memory.artifactDigest,sha256:C.hash(memory.canonicalArtifact),artifact:memory.canonicalArtifact,semanticProfile:'production-v4-v5-approved-evidence.v1',renderer:'production-unified-to-canonical-v3.v1',renderSha256:M.hashUtf8(rendered),renderUtf8Bytes:Buffer.byteLength(rendered)},approvedInput:source.proof,rawPackets,rawPacketStatus:memory.rawPacketRefs?'complete-recorded-five-pair-provenance':'not-recorded-historical',basis:basisProof(memory,read),transfer};
}
// Count the exact canonical JSON wire length before the final proof encoder.
// Repeated source objects count repeatedly, even when their in-memory identity is
// shared. This prevents transfer/lineage reuse from bypassing the proof byte cap.
function assertProofBound(value){let bytes=0,nodes=0;const ancestors=new Set();
 const add=n=>{bytes+=n;if(bytes>J.MiB)C.fail('RESOURCE_LIMIT');};
 function stringBytes(text){J.unicode(text);add(2);for(const char of text){const cp=char.codePointAt(0);add(cp===34||cp===92?2:cp<32?([8,9,10,12,13].includes(cp)?2:6):cp<128?1:cp<2048?2:cp<65536?3:4);}}
 function visit(v,depth){if(++nodes>65536||depth>32)C.fail('RESOURCE_LIMIT');if(typeof v==='string'){stringBytes(v);return;}if(v===null||typeof v==='boolean'||typeof v==='number'){need(typeof v!=='number'||Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v)));add(JSON.stringify(v).length);return;}
  need(v&&typeof v==='object'&&!ancestors.has(v));ancestors.add(v);const array=Array.isArray(v),keys=Object.keys(v);add(2+Math.max(0,keys.length-1));for(const key of keys){if(!array){visit(key,depth+1);add(1);}visit(v[key],depth+1);}ancestors.delete(v);
 }
 visit(value,0);return bytes;
}
module.exports={declared,typed,validate,assertProofBound};
