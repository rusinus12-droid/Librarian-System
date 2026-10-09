'use strict';
const {observationFixture}=require('./authority_observation_fixture.cjs');
// Production LIBRA legacy identity hash, not the source-proof SHA256.
function digest(value){const text=typeof value==='string'?value:JSON.stringify(value??null);let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}h^=31;h=Math.imul(h,16777619);return (h>>>0).toString(16).padStart(8,'0')+':'+(text.length+1);}
const copy=v=>JSON.parse(JSON.stringify(v));
function worldline(scope){const parts=[scope.characterId,scope.chatId,scope.scopeKey];return 'wl_'+digest(['host-worldline-a',...parts]).split(':')[0]+digest(['host-worldline-b',...parts]).split(':')[0];}
function receiptRevision(r){return digest({turn:r.turn,user:{chatIds:r.user.chatIds,text:r.user.text,rawPayloadDigests:r.user.rawPayloadDigests,sanitizedTextDigests:r.user.sanitizedTextDigests},assistant:{chatIds:r.assistant.chatIds,text:r.assistant.text,rawPayloadDigests:r.assistant.rawPayloadDigests,sanitizedTextDigests:r.assistant.sanitizedTextDigests}}).replace(/[^a-z0-9]/gi,'');}
function microRows(scopeKey,worldlineId,turn,{minimum=false}={}){
 const prefix=`libra:v1:scope:${scopeKey}:`,base=`${worldlineId}:e0:t${turn}`;
 const source=('Ari opened the door. '+ 'Whole source evidence 한글 😀. '.repeat(30)).trim();
 const user={role:'user',chatId:'u'+turn,chatIds:['u'+turn],text:'Continue.',rawPayloadDigests:[],sanitizedTextDigests:[]};
 const assistant={role:'assistant',chatId:'a'+turn,chatIds:['a'+turn],text:source,rawPayloadDigests:[],sanitizedTextDigests:[]};
 const receipt={schema:'libra.completed_turn_receipt.v1',scopeKey,worldlineId,sessionEpoch:0,turn,user,assistant};
 receipt.revisionId=receiptRevision(receipt);receipt.sourceDigest=digest([{turn,userChatId:user.chatId,assistantChatId:assistant.chatId,user:user.text,assistant:assistant.text}]);
 const receiptKey=prefix+'source-receipt:'+base+':'+receipt.revisionId,workKey=prefix+'micro-work:'+base+':'+receipt.revisionId+':producer1';
 const evidence={role:'assistant',messageId:assistant.chatId,startOffset:0,endOffset:20,exactQuote:source.slice(0,20)};
 const claim={changeKind:'event',text:'Ari opened the door.',actor:'Ari',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence};
 const record={schema:'libra.micro_memory.v1',scopeKey,worldlineId,sessionEpoch:0,turn,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,receiptKey,workKey,producerVersion:'producer1',analysisStatus:minimum?'minimum_source_bound':'verified',claims:minimum?[]:Array.from({length:10},()=>copy(claim)),...(minimum?{excerpt:{...evidence,endOffset:source.length,exactQuote:source}}:{})};
 record.analysisRevisionId=digest(record);
 const recordKey=prefix+'micro-memory:'+base+':'+receipt.revisionId+':'+record.analysisRevisionId;
 const work={schema:'libra.micro_work.v1',scopeKey,worldlineId,sessionEpoch:0,turn,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,receiptKey,producerVersion:'producer1',status:'result_ready',attemptId:'attempt'+turn,result:{minimumSourceBound:copy(record)}};work.resultDigest=digest(work.result);
 const head={schema:'libra.micro_memory_head.v1',scopeKey,worldlineId,sessionEpoch:0,turn,recordKey,sourceRevisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,analysisRevisionId:record.analysisRevisionId,analysisStatus:record.analysisStatus,workKey,workDigest:digest(work),attemptId:work.attemptId,publishRuntimeToken:'saved-runtime',restoreGeneration:0};
 const sourceHead={schema:'libra.completed_turn_head.v1',scopeKey,worldlineId,sessionEpoch:0,turn,receiptKey,revisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest};
 return {recordKey,receiptKey,record,receipt,headKey:prefix+'micro-memory-head:'+base,head,rows:[{key:receiptKey,value:receipt},{key:prefix+'source-receipt-head:'+base,value:sourceHead},{key:workKey,value:work},{key:recordKey,value:record},{key:prefix+'micro-memory-head:'+base,value:head}]};
}
function archiveRecordPayload(ref){const v={schema:'libra.shared_archive_record.v2',key:ref.key,physicalScopeKey:ref.physicalScopeKey,memoryId:ref.memoryId,revision:ref.revision,sourceDigest:ref.sourceDigest,artifactSchema:ref.artifactSchema||'',artifactDigest:ref.artifactDigest||'',worldlineId:ref.worldlineId||'main',turnRange:copy(ref.turnRange),archiveId:ref.archiveId,archiveCanonicalId:ref.archiveCanonicalId,vectorKey:ref.vectorKey||''};return v;}
function refsDigest(refs){return digest({schema:'libra.shared_archive_refs.v2',integrityVersion:2,records:refs.map(ref=>({archiveCanonicalId:ref.archiveCanonicalId,key:ref.key,recordDigest:digest(archiveRecordPayload(ref))})).sort((a,b)=>a.archiveCanonicalId.localeCompare(b.archiveCanonicalId)||a.key.localeCompare(b.key))});}
function archiveRows(baseMemory){const layers=[],all=[];let parentRef=null;for(let n=1;n<=2;n++){
 const archiveId='archive'+n,archiveCanonicalId='canonical'+n,key=`libra:v1:shared-archive:${archiveId}:memory:${archiveCanonicalId}:r1`;
 const value={...copy(baseMemory),scopeKey:'archive:'+archiveId,memoryId:'archived'+n,text:'Complete archived body '+n,archiveShared:true,archiveId,archiveCanonicalId,sessionEpoch:-1,archiveGeneration:n,archiveBaseSessionEpoch:-1,inheritedSessionHistory:true};
 const ref={key,physicalScopeKey:value.scopeKey,memoryId:value.memoryId,revision:1,sourceDigest:value.sourceDigest,status:'committed',turnRange:copy(value.turnRange),archiveShared:true,archiveId,archiveCanonicalId,archiveGeneration:n,archiveBaseSessionEpoch:-1,sessionEpoch:-1,inheritedSessionHistory:true};ref.recordDigest=digest(archiveRecordPayload(ref));all.push(ref);
 const manifestKey=`libra:v1:shared-archive:${archiveId}:manifest`,archive={schema:'libra.shared_archive.v1',archiveId,integrityVersion:2,generation:n,depth:n,deltaCount:1,deltaDigest:refsDigest([ref]),recordCount:n,digest:refsDigest(all),parentRef,memoryRefs:[ref]};
 const pointer={schema:'libra.shared_archive_ref.v1',archiveId,integrityVersion:2,generation:n,depth:n,deltaCount:1,recordCount:n,digest:archive.digest,manifestKey,parentRef};
 layers.push({key,value},{key:manifestKey,value:archive});parentRef=pointer;
 }
 return {rows:layers,archiveRef:parentRef,refs:all.map(ref=>({...ref,sessionEpoch:ref.archiveBaseSessionEpoch-(2-ref.archiveGeneration)}))};
}
function sourceClosureFixture(t,options={}){let state;
 const f=observationFixture(t,{mutateSeed(f){
  const manifest=f.manifest;manifest.worldlineMeta.worldlineId=worldline(manifest);manifest.inheritedMemories=[];manifest.inheritedMicroArchives=[];manifest.archiveRef=null;manifest.frontiers={observedTurn:8};
  const local=[microRows(f.scopeKey,manifest.worldlineMeta.worldlineId,6),microRows(f.scopeKey,manifest.worldlineMeta.worldlineId,7,{minimum:true})];
  const archive=archiveRows(f.memory);manifest.archiveRef=archive.archiveRef;manifest.inheritedMemories=archive.refs;
  const inherited=microRows('predecessorScope','wl_previous',2,{minimum:true}),records=inherited.rows.slice().sort((a,b)=>a.key.localeCompare(b.key));
  const microArchive={schema:'libra.micro_handoff_archive.v1',sourceScopeKey:'predecessorScope',activeWorldlineId:'wl_previous',recordCount:records.length,recordsDigest:digest(records.map(row=>({key:row.key,valueDigest:digest(row.value)}))),records};microArchive.archiveDigest=digest(microArchive);
  const microArchiveKey='libra:v1:micro-handoff-archive:transfer1';manifest.inheritedMicroArchives=[{schema:'libra.micro_handoff_archive_ref.v1',sourceScopeKey:microArchive.sourceScopeKey,archiveKey:microArchiveKey,archiveDigest:microArchive.archiveDigest,recordCount:records.length,sessionEpoch:-1}];
  for(const row of [...local.flatMap(m=>m.rows),...archive.rows,{key:microArchiveKey,value:microArchive}])f.seed(row.key,row.value);
  f.seed(f.manifestKey,manifest);state={local,archive,microArchive,microArchiveKey,inherited};if(options.mutateSeed)options.mutateSeed(f,state);
 }});Object.assign(f,state);f.sourceRequest=(requestId='closure1')=>({namespace:'libra',requestId,scopeKey:f.scopeKey,throughTurn:8,durationMs:120000});return f;
}
module.exports={sourceClosureFixture,microRows,digest,worldline,receiptRevision,archiveRecordPayload,refsDigest};
