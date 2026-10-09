'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {typedSourceFixture}=require('./fixtures/authority_typed_source_fixture.cjs');
const {createAuthorityObserver}=require('../server/authority/observation.cjs');
function observer(t,f){const o=createAuthorityObserver({dataDir:f.dataDir,control:f.control});t.after(()=>o.close());return o;}
function capture(o,f){const {handle}=o.observeSourceClosure(f.sourceRequest());return {args:{handle,requestId:'closure1'},view:o.readCaptured({handle,requestId:'closure1'})};}
for(const version of [4,5])test(`v${version} canonical closes complete approved evidence, artifact and exact production render`,t=>{
 const f=typedSourceFixture(t,{version}),o=observer(t,f),{args,view}=capture(o,f),row=view.receipt.records.find(r=>r.key===f.key);
 assert.equal(view.items.find(i=>i.key===f.key).text,f.memory.text);assert.deepEqual(row.typedArtifact.artifact,f.memory.canonicalArtifact);assert.equal(row.typedArtifact.schema,f.memory.artifactSchema);assert.equal(row.approvedInput.key,f.typed.evidenceKey);assert.equal(row.approvedInput.identity,f.memory.sourceEvidenceRef.identity);assert.equal(row.rawPackets.length,5);assert.equal(row.basis.snapshotStatus,'present');assert.equal(view.receipt.coverage.typedCanonicalItems,1);assert.ok(Object.isFrozen(row.typedArtifact.artifact.facts));assert.equal(o.assertCurrent(args).status,'current');assert.throws(()=>o.captureCorpus(f.sourceRequest()),{code:'SOURCE_PROOF_UNAVAILABLE'});
 f.mutate(f.typed.evidenceKey,{...f.typed.evidence,payloadDigest:'changed'});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
});
const {digest}=require('./fixtures/authority_source_closure_fixture.cjs');
const {fingerprint,sha}=require('./fixtures/authority_typed_source_fixture.cjs');
function reseal(f,x,{render=true}={}){f.memory.artifactDigest=digest(f.memory.canonicalArtifact);f.manifest.memories['1'].artifactSchema=f.memory.artifactSchema;f.manifest.memories['1'].artifactDigest=f.memory.artifactDigest;if(render)f.memory.text=require('../server/authority/libra-typed-codec.cjs').renderUnifiedArtifact(f.memory.canonicalArtifact);f.seed(f.key,f.memory);f.seed(f.manifestKey,f.manifest);}
test('typed source refuses malformed version, enum, semantic evidence, approved identity and incomplete proof as a whole',async t=>{
 const cases={
  unknown_schema(f,x){f.memory.artifactSchema='libra.canonical_artifact.v6';f.memory.canonicalArtifact.schema=f.memory.artifactSchema;reseal(f,x);},
  split_schema(f,x){f.memory.artifactSchema='libra.canonical_artifact.v4';f.seed(f.key,f.memory);},
  v4_extension(f,x){f.memory.artifactSchema='libra.canonical_artifact.v4';f.memory.canonicalArtifact.schema=f.memory.artifactSchema;reseal(f,x);},
  enum(f,x){f.memory.canonicalArtifact.facts[0].certainty='confirmed_typo';reseal(f,x);},
  dangling_binding(f,x){f.memory.canonicalArtifact.stateBindings[0].factTempId='absent';reseal(f,x);},
  unsupported_claim(f,x){f.memory.canonicalArtifact.facts[0].claimKind='constructor';reseal(f,x,{render:false});},
  artifact_digest(f){f.memory.artifactDigest='00000000:0';f.seed(f.key,f.memory);},
  wrong_render(f){f.memory.text+=' silently changed';f.seed(f.key,f.memory);},
  foreign_quote(f,x){f.memory.canonicalArtifact.facts[0].evidenceSpans[0].quote='This never happened.';reseal(f,x);},
  approved_identity(f,x){x.evidence.binding.identity='forged';f.seed(x.evidenceKey,x.evidence);},
  unsupported_normalization(f,x){x.evidence.normalizationVersion='future:unknown';f.seed(x.evidenceKey,x.evidence);},
  approved_missing(f,x){f.databases.libra.prepare('DELETE FROM kv WHERE key=?').run(x.evidenceKey);},
  raw_missing(f){f.databases.libra.prepare('DELETE FROM kv WHERE key=?').run(f.memory.rawPacketRefs[0].storageKey);},
  raw_incomplete(f){f.memory.rawPacketRefs.pop();f.seed(f.key,f.memory);},
  raw_digest(f,x){const row=x.stored.find(r=>r.key===f.memory.rawPacketRefs[0].storageKey);row.value.rawSourcePacket.user.segments[0].rawValue+='tampered';f.seed(row.key,row.value);},
  admission(f){f.memory.artifactValidation={admission:{schema:'libra.record_admission.v1',status:'complete'}};f.memory.recordAdmissionDigest='invalid';f.seed(f.key,f.memory);},
  unknown_engine(f){f.memory.engineVersion='libra.unified.v99';f.seed(f.key,f.memory);},
  basis_digest(f,x){const row=x.stored.find(r=>r.key===f.memory.unifiedBasis.snapshotKey);row.value.registry={entities:[]};f.seed(row.key,row.value);}
 };
 for(const [name,mutateSeed] of Object.entries(cases))await t.test(name,t=>{const f=typedSourceFixture(t,{mutateSeed}),o=observer(t,f);assert.throws(()=>o.observeSourceClosure(f.sourceRequest()),{code:'SOURCE_PROOF_UNAVAILABLE'});});
});
test('raw capture closes the exact consumed variant while newer stored variants do not replace it',t=>{
 let captureKey;const f=typedSourceFixture(t,{mutateSeed(f,x){const old=f.memory.rawPacketRefs[0],row=x.stored.find(r=>r.key===old.storageKey),receipt=row.value,packet=receipt.rawSourcePacket;captureKey=old.storageKey.replace(':source-receipt:',':source-receipt-capture:');
  const expected={...old,storageKey:captureKey,field:'rawSourceVariants.'+packet.packetDigest};const newer=structuredClone(packet);newer.user.segments[0].rawValue='tagged Continue.';newer.user.segments[0].rawPayloadDigest=digest({type:'string',value:newer.user.segments[0].rawValue});newer.user.segments[0].utf8Sha256=sha(newer.user.segments[0].rawValue);newer.user.segments[0].utf8ByteLength=Buffer.byteLength(newer.user.segments[0].rawValue);delete newer.packetDigest;newer.packetDigest=sha(JSON.stringify(newer));
  const nextRef={...expected,field:'rawSourceVariants.'+newer.packetDigest,packetDigest:newer.packetDigest};const captureRecord={schema:'libra.completed_turn_capture.v1',scopeKey:receipt.scopeKey,worldlineId:receipt.worldlineId,sessionEpoch:0,turn:receipt.turn,receiptKey:old.storageKey,revisionId:receipt.revisionId,sourceDigest:receipt.sourceDigest,rawSourceVariants:{[packet.packetDigest]:packet,[newer.packetDigest]:newer},rawPacketRef:nextRef,rawVariantRefs:[expected,nextRef]};f.memory.rawPacketRefs[0]=expected;f.seed(captureKey,captureRecord);f.seed(f.key,f.memory);
 }}),o=observer(t,f),{args,view}=capture(o,f),proof=view.receipt.records.find(r=>r.key===f.key).rawPackets[0];assert.equal(proof.ref.storageKey,captureKey);assert.equal(proof.packetSha256,f.memory.rawPacketRefs[0].packetDigest);assert.equal(proof.nativeCurrentness,'unavailable');f.mutate(captureKey,null,{purge:true});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
});
test('historical collected basis is durable absence and cannot become execution authority',t=>{
 const f=typedSourceFixture(t,{mutateSeed(f){f.databases.libra.prepare('DELETE FROM kv WHERE key=?').run(f.memory.unifiedBasis.snapshotKey);}}),o=observer(t,f),{args,view}=capture(o,f),proof=view.receipt.records.find(r=>r.key===f.key).basis;
 assert.equal(proof.snapshotStatus,'absent-transient');assert.equal(proof.executionAuthority,'unavailable');f.mutate(proof.snapshotKey,{schema:'new'});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
});
test('source-evidence SQLite storage type and byte bounds fail before payload decoding',async t=>{
 for(const kind of ['blob','oversized'])await t.test(kind,t=>{const f=typedSourceFixture(t,{mutateSeed(f,x){const raw=kind==='blob'?Buffer.from(JSON.stringify(JSON.stringify(x.evidence))):JSON.stringify(JSON.stringify({...x.evidence,padding:'x'.repeat(1048576)}));f.seed(x.evidenceKey,null,{raw});}}),o=observer(t,f);assert.throws(()=>o.observeSourceClosure(f.sourceRequest()),{code:kind==='blob'?'SOURCE_PROFILE_UNAVAILABLE':'RESOURCE_LIMIT'});});
});
function sameBatchThread(f,x,bad=false){const art=f.memory.canonicalArtifact,span={ref:'t1-a',quote:'Ari opened the door.'},participants=[{role:'owner',personTempRef:'ari'}],participantIds=[{role:'owner',personId:'personAri'}];art.entities.push({tempId:'door',name:'door',type:'world',kind:'thread',evidenceSpans:[span]});
 const opening={tempFactId:'open1',domain:'narrative',subjectTempRef:'door',claimKind:'thread',values:{thread:{summary:'door opened',status:'open',kind:'task',participants,participantIds,lifecycleId:'doorTask',linkStatus:'new'}},text:'Ari opened the door.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[span]};
 const closing={...structuredClone(opening),tempFactId:'close1',evidenceSpans:[{...span,ref:'t2-a'}]};closing.values.thread={...closing.values.thread,status:'resolved',resolution:'completed',link:'resolve',linkStatus:'accepted',linkTarget:{schema:'libra.same_batch_thread_target.v1',scopeKey:f.scopeKey,worldlineId:'main',sourceDigest:f.memory.sourceDigest,subjectTempRef:'door',factId:bad?'unknown':'open1',lifecycleId:'doorTask',participantIds,linkKind:'resolve',targetStatus:'open'}};art.facts.push(opening,closing);reseal(f,x);
}
test('v5 same-batch thread target uses the real production ordering and target validator',async t=>{
 for(const bad of [false,true])await t.test(bad?'missing target rejects whole unit':'complete target accepted',t=>{const f=typedSourceFixture(t,{mutateSeed:(f,x)=>sameBatchThread(f,x,bad)}),o=observer(t,f);if(bad)assert.throws(()=>capture(o,f),{code:'SOURCE_PROOF_UNAVAILABLE'});else assert.equal(capture(o,f).view.receipt.coverage.typedCanonicalItems,1);});
});
test('typed archive retains target approved evidence and original source evidence/raw closure',t=>{
 let archiveKey,archiveEvidenceKey;const f=typedSourceFixture(t,{mutateSeed(f,x,state){
  const T=require('../server/authority/libra-typed-codec.cjs'),V=require('../server/authority/libra-source-codec.cjs');const old=state.archive.refs[1];archiveKey=old.key;
  const memory={...structuredClone(f.memory),scopeKey:'archive:archive2',memoryId:old.memoryId,archiveShared:true,archiveId:'archive2',archiveCanonicalId:old.archiveCanonicalId,sessionEpoch:-1,inheritedSessionHistory:true};delete memory.unifiedBasis;
  memory.unifiedOrigin={scopeKey:f.memory.scopeKey,memoryId:f.memory.memoryId,revision:1,sourceDigest:f.memory.sourceDigest,artifactDigest:f.memory.artifactDigest,turnRange:f.memory.turnRange};memory.unifiedTransfer={schema:'libra.unified_transfer_binding.v1',sourceScopeKey:f.scopeKey,sourceMemoryId:f.memory.memoryId,sourceRevision:1,sourceEvidenceRef:structuredClone(f.memory.sourceEvidenceRef),targetScopeKey:memory.scopeKey,targetMemoryId:memory.memoryId,targetSourceDigest:memory.sourceDigest,artifactDigest:memory.artifactDigest,consentTransferred:false,remoteJobsTransferred:false};
  const evidence=structuredClone(x.evidence);evidence.binding.scopeKey=memory.scopeKey;evidence.binding.identity=T.branchContentHash(JSON.stringify([memory.scopeKey,'main',x.batch.map(p=>[p.user.chatId,p.assistant.chatId])]));evidence.payloadDigest=fingerprint(JSON.stringify({binding:evidence.binding,normalizationVersion:evidence.normalizationVersion,rows:evidence.rows}));
  archiveEvidenceKey=`libra:v1:scope:${memory.scopeKey}:source-evidence:v1:`+fingerprint(['libra',memory.scopeKey,'1',evidence.binding.identity,memory.sourceDigest]);memory.sourceEvidenceRef={...memory.sourceEvidenceRef,scopeKey:memory.scopeKey,key:archiveEvidenceKey,identity:evidence.binding.identity,payloadDigest:evidence.payloadDigest};
  const ref={...old,artifactSchema:memory.artifactSchema,artifactDigest:memory.artifactDigest,sourceDigest:memory.sourceDigest,sourceEvidenceDigest:evidence.payloadDigest,unifiedOriginDigest:digest(memory.unifiedOrigin)};ref.recordDigest=V.libraArchiveRecordDigest(ref);state.archive.refs[1]=ref;f.manifest.inheritedMemories=state.archive.refs;
  const archive=state.archive.rows[3].value;archive.memoryRefs=[ref];archive.deltaDigest=V.libraArchiveRefsDigest([ref],2);archive.digest=V.libraArchiveRefsDigest(state.archive.refs,2);f.manifest.archiveRef.digest=archive.digest;
  f.seed(archiveEvidenceKey,evidence);f.seed(archiveKey,memory);f.seed(state.archive.rows[3].key,archive);f.seed(f.manifestKey,f.manifest);
 }}),o=observer(t,f),{args,view}=capture(o,f),proof=view.receipt.records.find(r=>r.key===archiveKey);
 assert.equal(view.receipt.coverage.typedCanonicalItems,2);assert.equal(proof.approvedInput.key,archiveEvidenceKey);assert.equal(proof.transfer.sourceApprovedInput.key,f.typed.evidenceKey);assert.equal(proof.rawPackets.length,5);assert.equal(proof.basis.status,'not_recorded');f.mutate(archiveEvidenceKey,null,{purge:true});assert.throws(()=>o.assertCurrent(args),{code:'SOURCE_CHANGED'});
});
test('v5 cross-batch thread target binds the complete stored lineage, exact prior fact and participants',async t=>{
 for(const bad of [false,true])await t.test(bad?'changed lineage fails':'bounded predecessor closes',t=>{
  let targetKey;const f=typedSourceFixture(t,{mutateSeed(f,x,state){
   const T=require('../server/authority/libra-typed-codec.cjs'),{typedData}=require('./fixtures/authority_typed_source_fixture.cjs');sameBatchThread(f,x);f.memory.canonicalArtifact.facts.pop();reseal(f,x);
   const index=T.newUnifiedThreadTargetIndex();for(const old of state.archive.refs){const body=state.archive.rows.find(r=>r.key===old.key).value;T.appendUnifiedThreadTargets(index,old,body,'main');}T.appendUnifiedThreadTargets(index,f.manifest.memories['1'],f.memory,'main');const prior=index.byLifecycle.get('doorTask');targetKey=f.key;
   for(const micro of state.local)for(const row of micro.rows)f.databases.libra.prepare('DELETE FROM kv WHERE key=?').run(row.key);
   const next=typedData(f,{start:6,memoryId:'mem2'}),opening=f.memory.canonicalArtifact.facts.at(-1),fact=structuredClone(opening);fact.tempFactId='resolve2';fact.evidenceSpans=[{ref:'t6-a',quote:'door'}];fact.values.thread={...fact.values.thread,status:'resolved',resolution:'completed',link:'resolve',linkStatus:'accepted',linkTarget:{schema:'libra.thread_link_target.v2',lifecycleId:'doorTask',canonicalOriginKey:prior.originKey,cursor:prior.cursor,factId:prior.factId,participantIds:prior.participantIds,lineageDigest:bad?'00000000:0':prior.lineageDigest,linkKind:'resolve',targetStatus:'open'}};
   next.memory.canonicalArtifact.entities.push({...structuredClone(f.memory.canonicalArtifact.entities.at(-1)),evidenceSpans:[{ref:'t6-a',quote:'door'}]});next.memory.canonicalArtifact.facts.push(fact);next.memory.artifactDigest=digest(next.memory.canonicalArtifact);next.memory.text=T.renderUnifiedArtifact(next.memory.canonicalArtifact);next.ref.artifactDigest=next.memory.artifactDigest;
   // typedData starts from the source object, but an ordinary new canonical is
   // not a transferred record or reuse of the source's execution descriptor.
   f.manifest.memories['6']=next.ref;for(const row of next.stored)f.seed(row.key,row.value);f.seed(next.ref.key,next.memory);f.seed(f.manifestKey,f.manifest);
  }}),o=observer(t,f);const request={...f.sourceRequest(),throughTurn:10};if(bad)assert.throws(()=>o.observeSourceClosure(request),{code:'SOURCE_PROOF_UNAVAILABLE'});else{const cap=o.observeSourceClosure(request),view=o.readCaptured({handle:cap.handle,requestId:'closure1'}),proof=view.receipt.records.find(r=>r.memoryId==='mem2');assert.equal(view.receipt.coverage.typedCanonicalItems,2);assert.equal(proof.threadTargets[0].targetMemoryKey,targetKey);assert.equal(proof.threadTargets[0].targetFactId,'open1');}
 });
});
test('fixed typed reader preserves production legacy profile strings and complete artifact beyond text compaction',t=>{
 const T=require('../server/authority/libra-typed-codec.cjs');let fullText;const f=typedSourceFixture(t,{mutateSeed(f,x){const art=f.memory.canonicalArtifact;art.facts[1].values.preferences=['Ari likes mint tea.'];fullText='Ari opened the door. '+ 'All stored typed detail stays available. '.repeat(35);art.facts[0].text=fullText;art.facts[0].values.detail=fullText;reseal(f,x);}}),o=observer(t,f),{view}=capture(o,f),proof=view.receipt.records.find(r=>r.key===f.key);
 assert.equal(proof.typedArtifact.artifact.facts[0].text,fullText);assert.match(view.items.find(i=>i.key===f.key).text,/\[truncated\]/);assert.equal(view.items.find(i=>i.key===f.key).text,T.renderUnifiedArtifact(f.memory.canonicalArtifact));
});
test('historical v4 without recorded raw packet or basis remains explicit approved-input proof only',t=>{
 const f=typedSourceFixture(t,{version:4,raw:false,basis:false}),o=observer(t,f),{view}=capture(o,f),proof=view.receipt.records.find(r=>r.key===f.key);assert.equal(proof.rawPacketStatus,'not-recorded-historical');assert.deepEqual(proof.rawPackets,[]);assert.equal(proof.basis.status,'not_recorded');assert.equal(view.receipt.nativeAuthority,'unavailable');
});
test('proof preflight counts escaped Unicode and repeated references before whole JSON encoding',()=>{
 const {assertProofBound}=require('../server/authority/libra-typed-source.cjs'),C=require('../server/authority/contracts.cjs');const shared={text:'한글 😀\n\u0000"\\'},value={a:shared,b:shared,flags:[true,false,null,42]};assert.equal(assertProofBound(value),Buffer.byteLength(C.canonical(value)));const big={text:'x'.repeat(530000)};assert.throws(()=>assertProofBound({a:big,b:big}),{code:'RESOURCE_LIMIT'});
});
