'use strict';
const assert = require('node:assert/strict');
const createNetwork = require('../tools/libra_memory_network.cjs');
const frame = { owner: 'plugin_only:owner-a', scopeKey: 'scope-a', worldlineId: 'main', asOf: null, authorityEpoch: 7, activeSourceMapping: 'mapping-a' };
const source = { ownerNamespace: 'owner-a', originScope: 'scope-a', objectUUID: 'object-a', birthIncarnation: 'birth-a', revision: 1, analysisRevision: 1, recordKey: 'canonical-a:r1' };
const typed = { actorId: 'entity-a', targetId: 'object-key', predicate: 'condition', direction: 'outgoing', value: 'open', polarity: 'positive', time: { turn: 1 }, certainty: 'confirmed', sourceAnchors: ['object-a:assistant:0:12'], text: 'The door opened.' };
const claim = { changeKind: 'world', text: 'The door opened.', actor: '', target: 'door', temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none', evidence: {role: 'assistant', messageId: 'message-a', startOffset: 0, endOffset: 12, exactQuote: 'door opened!'} };
const record = { schema: 'libra.micro_memory.v1', scopeKey: 'scope-a', worldlineId: 'main', sessionEpoch: 0, turn: 1, sourceRevisionId: 'receipt-r1', sourceDigest: 'source-body-a', receiptKey: 'receipt-a:r1', analysisRevisionId: 'analysis-a:r1', analysisStatus: 'verified', claims: [claim] };
const evidenceReport={schema:'libra.B1.synthetic_evidence.v1',access:[],correspondence:[]};
const observedRows=viewer=>Array.from(viewer.rows||[]).map(row=>({kind:row.kind,memoryId:row.memoryId,revision:row.revision,
  sourceReceiptKey:row.sourceReceiptKey,sourceRevisionId:row.sourceRevisionId,authority:row.evidenceAuthority,
  sourceSpans:JSON.parse(JSON.stringify(row.sourceSpans||[])),injected:row.injected,classicUsed:row.classicUsed,
  deduplicatedClaims:row.deduplicatedClaims,selectedText:row.selectedText,
  emission:row.injected?'emitted':row.deduplicatedClaims?'typed_absorbed_by_emitted_canonical':'not_emitted_by_final_renderer'}));
const saveEvidence=()=>{if(process.env.LIBRA_B1_EVIDENCE_PATH)require('node:fs').writeFileSync(process.env.LIBRA_B1_EVIDENCE_PATH,JSON.stringify(evidenceReport,null,2)+'\n');};
function factoryCases() {
  const n = createNetwork({hash: value => require('node:crypto').createHash('sha256').update(value).digest('hex')});
  assert.equal(typeof n.projectMicro, 'function', 'B1 requires Micro projection before old shortlist/hydration');
  assert.equal(typeof n.resolveEvidenceCluster, 'function', 'B1 requires conservative common-identity clustering');
  const row = { ref: {key: 'micro-a:r1'} };
  const units = n.projectMicro(record, { frame, row, source: {recordKey: row.ref.key} });
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'micro');
  assert.equal(units[0].authority, 'source_verified_candidate');
  assert.equal(units[0].binding.projectionVersion,'libra.micro-network.v1','Micro representation binding has its own version');
  assert.equal(units[0].identityCoverage, 'partial', 'surface IDs cannot establish UUID/birth identity');
  n.upsert(units, {frame});
  assert.equal(n.diagnostics().canonicalCandidates,0,'Micro access cannot be mislabeled a canonical candidate');
  assert.equal(n.diagnostics().microCandidates,1);
  assert.deepEqual(n.discover({tokens: ['opened']}).map(c => c.id), [units[0].nodeId]);
  assert.equal(n.discover({tokens: ['opened']})[0].row, row, 'access locator retains its identity');
  assert.ok(units[0].sourceSpans.some(span => span.exactQuote === claim.evidence.exactQuote));
  const sourceOnly = {...record, analysisStatus: 'minimum_source_bound', analysisRevisionId: 'minimum-r1', claims: [], excerpt: claim.evidence};
  const minimum = n.projectMicro(sourceOnly, {frame, row: {ref:{key:'minimum-a'}}, source:{recordKey:'minimum-a'}});
  n.upsert(minimum, {frame});
  assert.equal(minimum[0].kind, 'source_only');
  assert.equal(minimum[0].authority, 'source_only');
  assert.equal(minimum[0].claims.length, 0, 'original source span is not an inferred claim');
  assert.notEqual(n.projectMicro({...sourceOnly,excerpt:{...claim.evidence,role:'user'}},{frame,row:{},source:{recordKey:'minimum-a'}})[0].sourceId,
    minimum[0].sourceId,'source-only role/span attachment cannot collapse under equal rendered text');
  assert.equal(n.projectMicro(sourceOnly,{frame,normalizedClaims:[typed]})[0].claims.length,0,'source-only cannot adopt caller typed claims');
  assert.ok(n.discover({tokens:['opened']}).some(c => c.id === minimum[0].nodeId));
  const stableSpanA=n.projectMicro(sourceOnly,{frame,source,row:{tag:'stable-span-a'}})[0];
  const stableSpanB=n.projectMicro({...sourceOnly,excerpt:{...claim.evidence,role:'user',startOffset:12,endOffset:24}},
    {frame,source,row:{tag:'stable-span-b'}})[0];
  assert.equal(stableSpanA.sourceId,stableSpanB.sourceId,'different spans preserve one proven SourceObjectID');
  assert.notEqual(stableSpanA.nodeId,stableSpanB.nodeId,'source-only evidence units distinguish exact role/span attachment');
  n.upsert([stableSpanA,stableSpanB],{frame});
  assert.ok(n.discover({tokens:['opened']}).some(c=>c.id===stableSpanA.nodeId));
  assert.ok(n.discover({tokens:['opened']}).some(c=>c.id===stableSpanB.nodeId),'registry retains both spans instead of replacing their bindings');
  const shaMarker='const sha256Hex = value => {';
  const forcedFactory=require('node:vm').runInNewContext('('+createNetwork.toString().replace(shaMarker,shaMarker+" return '0'.repeat(64);")+')');
  const forced=forcedFactory({adapters:{hash:()=> 'constant'}}),forcedRegistry=forced.createRegistry({frame});
  const forcedA=forced.projectMicro(sourceOnly,{frame,source})[0];
  const forcedB=forced.projectMicro({...sourceOnly,excerpt:{...claim.evidence,role:'user',startOffset:12,endOffset:24}},{frame,source})[0];
  assert.equal(forcedA.nodeId,forcedB.nodeId,'synthetic strong-label collision controls only the equality guard');
  const originalRow={tag:'original-span'};forcedRegistry.upsert(forcedA,originalRow);
  assert.throws(()=>forcedRegistry.upsert(forcedB,{tag:'other-span'}),/IDENTITY_LABEL_COLLISION/,'private exact span tuple guards unexpected equal node labels');
  assert.equal(forcedRegistry.rows()[0],originalRow,'colliding source-only span cannot replace existing row');
  assert.notEqual(n.projectMicro({...record, sourceRevisionId:'r2'}, {frame})[0].sourceId, units[0].sourceId);
  assert.notEqual(n.projectMicro({...record, scopeKey:'other'}, {frame})[0].sourceId, units[0].sourceId);
  const projectionReuse = n.projectMicro({...record,networkEvidence:{any:'derived'},embedding:{status:'ready'},updatedAt:'tomorrow'}, {frame,row,source:{recordKey:row.ref.key}})[0];
  assert.equal(projectionReuse.nodeId,units[0].nodeId,'derived metadata cannot recursively change prehydration IDs');
  assert.equal(projectionReuse.claims[0].claimId,units[0].claims[0].claimId);
  const canonical = n.project({memory:{memoryId:'canonical-a',revision:1,text:typed.text,claims:[typed]},source,frame,row:{memory:{}}})[0];
  const micro = n.projectMicro(record, {frame, source, normalizedClaims:[typed], row:{memory:{kind:'micro'}}})[0];
  assert.equal(canonical.sourceId, micro.sourceId);
  assert.equal(canonical.claims[0].claimId, micro.claims[0].claimId);
  const cluster = n.resolveEvidenceCluster([micro, canonical]);
  assert.equal(cluster.representative, canonical, 'proved same source+typed claim chooses canonical');
  assert.equal(cluster.supportingSources.length, 1, 'representations of one source do not become independent support');
  assert.equal(cluster.conflicts.length, 0);
  const attachment={schema:'libra.revision_source_attachment.v1',owner:frame.owner,sourceScope:frame.scopeKey,
    worldlineId:frame.worldlineId,sessionEpoch:0,turn:1,role:'assistant',originIdentity:JSON.stringify(['origin-a','full original bytes']),sourceRevision:'receipt-r1'};
  const localSource={attachment,revision:'receipt-r1',analysisRevision:'analysis-r1',recordKey:'local-canonical'};
  const localCanonical=n.project({memory:{memoryId:'local-canonical',revision:1,text:typed.text,claims:[typed]},source:localSource,frame,row:{}})[0];
  const localMicro=n.projectMicro(record,{frame,source:{...localSource,recordKey:'local-micro'},normalizedClaims:[typed]})[0];
  assert.equal(localCanonical.identityCoverage,'partial','legacy attachment does not invent stable UUID/birth identity');
  assert.equal(localCanonical.sourceId,localMicro.sourceId,'verified revision attachment is shared across representations');
  assert.equal(localCanonical.claims[0].claimId,localMicro.claims[0].claimId);
  assert.equal(n.resolveEvidenceCluster([localMicro,localCanonical]).representative,localCanonical,'fully typed local correspondence may cluster even while stable identity remains partial');
  assert.equal(n.resolveEvidenceCluster([units[0], canonical]).representative, null, 'matching quote/text alone cannot prove typed identity');
  const identicalPartial=n.project({memory:{memoryId:'micro_'+record.analysisRevisionId,revision:record.sourceRevisionId,
    scopeKey:record.scopeKey,worldlineId:record.worldlineId,sessionEpoch:record.sessionEpoch,receiptKey:record.receiptKey,
    analysisStatus:record.analysisStatus,turnRange:{start:1,end:1},sourceSpans:[claim.evidence],text:claim.text+'\n'+claim.evidence.exactQuote,claims:[claim]},
    source:{recordKey:row.ref.key,revision:record.sourceRevisionId,analysisRevision:record.analysisRevisionId,sourceDigest:record.sourceDigest},frame,row:{}})[0];
  assert.equal(n.resolveEvidenceCluster([units[0],identicalPartial]).representative,null,'identical partial generic payload never establishes typed correspondence');
  const changed = n.projectMicro(record, {frame,source,normalizedClaims:[{...typed,value:'closed'}]})[0];
  assert.notEqual(changed.claims[0].claimId, micro.claims[0].claimId);
  assert.equal(n.resolveEvidenceCluster([micro,changed]).representative,null);
  assert.equal(n.resolveEvidenceCluster([micro,changed]).conflicts.length,2);
  assert.equal(Object.isFrozen(record), false, 'projection never freezes caller records');
  assert.equal(Object.isFrozen(claim.evidence), false);
  assert.throws(() => n.projectMicro({...record,analysisStatus:'pending'}, {frame}), /MICRO_ANALYSIS_STATUS/);
  assert.throws(()=>n.projectMicro({...record,claims:[claim,claim]},{frame,normalizedClaims:[typed]}),/MICRO_CLAIM_CARDINALITY/,'typed adapter cannot hide a duplicate by changing cardinality');
  assert.throws(() => n.projectMicro({...record,claims:[{...claim,evidence:{...claim.evidence,endOffset:-1}}]}, {frame}), /MICRO_SOURCE_SPAN/);
  console.log('PASS B1 pure Micro/source-only lexical discovery and conservative identity clusters');
}
factoryCases();
if (!process.argv.includes('--factory-only')) runtimeCases().then(saveEvidence).catch(error => {saveEvidence();console.error(error);process.exitCode=1;});
async function runtimeCases() {
  if(process.argv.includes('--temporal-only'))return temporalAccessCase();
  if(process.argv.includes('--correspondence-only'))return correspondenceCases();
  const {fixture} = require('./fixtures/libra_unified_runtime_fixture.cjs');
  const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
  const {waitFor} = require('./fixtures/libra_vm_harness.cjs');
  const quote = '도서관 전체는 정숙 구역';
  for (const storageMode of ['plugin_only','server_only']) for (const minimum of [false,true]) {
    let listener;
    const options={args:{memory_suite_server_mode:storageMode},mode:storageMode,host:{
      async nativeFetch(){throw new Error('offline_B1_external_provider_forbidden');},
      async addRisuChatListener(_type,handler){listener=handler;return true;}
    },transformSource:source=>{
      const old = 'settings, guard, microCorpus.refs);';
      assert.equal(source.split(old).length,2,'test removes only old Micro catalog access');
      return source.replace(old,'settings, guard, []);');
    }};
    const fx=storageMode==='server_only'?await serverFixture(options):null;
    const f=fx?.f||await fixture(options);
    try {
      f.chat.message=f.chat.message.slice(0,2);f.chat.messages=f.chat.message;
      f.control.onCall=async args=>{
        if(minimum)return {type:'error',result:'synthetic Micro unavailable'};
        const input=JSON.parse(args[0].messages[1].content),startOffset=input.assistant.text.indexOf(quote);
        assert.ok(startOffset>=0);
        return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'world',text:quote+'이다.',actor:'',target:'도서관',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset,endOffset:startOffset+quote.length,exactQuote:quote}}]}})};
      };
      listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});
      await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===1,15000);
      const active=await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(active.status,'verified');
      assert.equal(active.record.analysisStatus,minimum?'minimum_source_bound':'verified');
      assert.equal(active.head.recallProjection.networkEvidence?.schema,'libra.micro_network_evidence.v1','owner publication durably binds network access metadata');
      const headBefore=JSON.stringify(active.head),bodyBefore=JSON.stringify(active.record),calls=f.control.calls.length;
      f.control.onCall=async()=>{throw new Error('B1 recall must not invoke analysis/provider');};
      const recall=await f.r.api.previewUnifiedMemoryRecall(quote);
      assert.equal(recall.diagnostics.microNetworkAccess.indexed,1);
      assert.equal(recall.diagnostics.microNetworkAccess.discoveredIds.length,1);
      assert.deepEqual(Array.from(recall.diagnostics.microNetworkAccess.hydratedIds),Array.from(recall.diagnostics.microNetworkAccess.discoveredIds),'access IDs survive physical reprojection');
      assert.ok(Array.from(recall.memories).some(row=>row.memory.kind==='micro'),'independent registry access bypasses empty old shortlist');
      const beforeHead=f.getHead();
      await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
      const delivered=await f.control.hooks.beforeRequest([{role:'user',content:quote}],'model');
      assert.ok(delivered.some(row=>String(row.content||'').includes(quote)),'actual final request delivers independently discovered source');
      const viewer=f.r.api.getLastMemoryRecallViewer();
      evidenceReport.access.push({storageMode,sourceOnly:minimum,access:JSON.parse(JSON.stringify(recall.diagnostics.microNetworkAccess)),
        selectedIds:Array.from(recall.memories).map(row=>row.id),finalRows:observedRows(viewer),
        systemPacket:delivered.filter(row=>row.role==='system').map(row=>row.content)});
      assert.ok(viewer.rows.some(row=>row.kind==='micro'&&row.injected&&row.evidenceAuthority===(minimum?'source_only':'source_verified_candidate')));
      assert.equal(f.control.calls.length,calls,'unchanged recall spends no provider calls');
      assert.deepEqual(f.getHead(),beforeHead,'lexical source access never writes State');
      const after=await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(JSON.stringify(after.head),headBefore);assert.equal(JSON.stringify(after.record),bodyBefore);
      const allMessages=require('./fixtures/unified_vertical_source.json').sourceRows.map(r=>({role:r.role,chatId:r.ref,data:r.text}));
      f.chat.message=allMessages;f.chat.messages=allMessages;
      const partial=await f.r.api.previewUnifiedMemoryRecall(quote);
      assert.equal(partial.diagnostics.microRecallIndex.status,'partial','one durable head does not certify a complete known five-turn Micro corpus');
      assert.ok(Array.from(partial.diagnostics.microRecallIndex.pendingTurns).some(row=>row.turn===3));
    } finally {if(fx)await fx.cleanup();else await f.r.cleanup();}
  }
  console.log('PASS B1 actual independent Micro/source-only access without old shortlist, canonical or embedding');
  await correspondenceCases();
  await temporalAccessCase();
}
async function temporalAccessCase(){
  const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs'),{waitFor}=require('./fixtures/libra_vm_harness.cjs');
  const quote='준호가 지호에게서 열쇠를 받아 들었다.';let listener;
  const f=await fixture({args:{memory_suite_server_mode:'plugin_only'},host:{async nativeFetch(){throw Error('offline_B1_external_provider_forbidden');},async addRisuChatListener(_t,h){listener=h;return true;}}});
  try{
    const all=f.chat.message;f.chat.message=all.slice(0,6);f.chat.messages=f.chat.message;
    f.control.onCall=async args=>{
      const input=JSON.parse(args[0].messages[1].content),startOffset=input.assistant.text.indexOf(quote);
      assert.ok(startOffset>=0);
      return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:quote,actor:'준호',target:'열쇠',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset,endOffset:startOffset+quote.length,exactQuote:quote}}]}})};
    };
    listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:5});
    await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===3,15000);
    f.chat.message=all;f.chat.messages=all;f.control.onCall=async()=>({type:'success',result:JSON.stringify(f.control.artifact)});
    assert.equal((await f.run()).completed,1);
    f.control.onCall=async()=>{throw Error('B1 recall cannot invoke provider');};
    const query='과거 T1 '+quote,recall=await f.r.api.previewUnifiedMemoryRecall(query);
    assert.equal(recall.diagnostics.temporalAnchor.status,'resolved');
    assert.equal(recall.diagnostics.temporalAnchor.requestedTurn,1);
    assert.ok(recall.diagnostics.microNetworkAccess.discoveredIds.length>0,'lexical access can discover a later candidate');
    assert.equal(recall.diagnostics.microNetworkAccess.hydratedIds.length,0,'ineligible access candidate cannot cross physical hydration admission');
    assert.equal(recall.diagnostics.microNetworkAccess.ineligibleCandidates[0].reason,'as_of_worldline_mismatch','existing canonical logical/Micro physical worldline gate remains conservative');
    assert.equal(Array.from(recall.memories).some(row=>row.memory.kind==='micro'&&row.memory.turnRange.start===3),false,'new access preserves existing as-of eligible-ref gate before hydration');
    await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
    const packet=await f.control.hooks.beforeRequest([{role:'user',content:query}],'model'),viewer=f.r.api.getLastMemoryRecallViewer();
    assert.equal(viewer.rows.some(row=>row.kind==='micro'&&row.turnRange.start===3&&row.injected),false,'actual past packet excludes later Micro');
    assert.ok(packet.filter(row=>row.role==='system').every(row=>!String(row.content).includes(quote)),'actual injected system packet contains no beyond-anchor T3 quote');
    evidenceReport.correspondence.push({case:'temporal_access',access:recall.diagnostics.microNetworkAccess,finalRows:observedRows(viewer),systemPacket:packet.filter(row=>row.role==='system').map(row=>row.content)});
    console.log('PASS B1 independent access retains existing as-of eligibility gate');
  }finally{await f.r.cleanup();}
}
async function correspondenceCases(){
  const {fixture}=require('./fixtures/libra_unified_runtime_fixture.cjs');
  const {waitFor}=require('./fixtures/libra_vm_harness.cjs');
  const defaultQuote='도서관 전체는 정숙 구역';
  const requested=process.argv.find(value=>value.startsWith('--case='))?.slice(7);
  for(const mode of ['absorbed','omitted','conflicting','repeated','canonical_not_packed','generic','duplicate_micro','duplicate_canonical','classic_budget_drop','alias_micro','structured_rule','unresolved_management','unresolved_ownership','scalar_clear_absorbed','profile_clear_selector'].filter(value=>!requested||value===requested)){
    const quote=mode==='scalar_clear_absorbed'?'도서관 상태를 지웠다':mode==='profile_clear_selector'?'민아는 커피를 좋아하지 않는다':defaultQuote;
    const claimText=['scalar_clear_absorbed','profile_clear_selector'].includes(mode)?quote+'.':quote+'이다.';
    let listener;
    const f=await fixture({args:{memory_suite_server_mode:'plugin_only'},host:{async nativeFetch(){throw Error('offline_B1_external_provider_forbidden');},async addRisuChatListener(_t,h){listener=h;return true;}},
      transformSource:mode==='classic_budget_drop'?source=>{
        const marker='const renderClassicBlock =';const at=source.indexOf(marker);assert.ok(at>0);
        const renderer=source.slice(at).replace('const body = [];','const body = [{kind:"test_reservation",text:""}];')
          .replace('let used = 0;','let used = Math.max(0, available - 700);');
        return source.slice(0,at)+renderer;
      }:mode==='canonical_not_packed'?source=>{
        const old='const selected = packed.selected;';assert.equal(source.split(old).length,2);
        return source.replace(old,old.replace('packed.selected','packed.selected.filter(row => row.memory.kind === "micro")'));
      }:undefined});
    try{
      const all=f.chat.message;
      const referenceCase=mode==='structured_rule'?{field:'rule',kind:'rule',value:JSON.parse(JSON.stringify(f.control.artifact.facts.find(fact=>fact.claimKind==='rule').values.rule))}
        : mode==='unresolved_management'?{field:'managerRef',kind:'management',value:'org'}
        : mode==='unresolved_ownership'?{field:'ownerRef',kind:'ownership',value:'mina'}
        : mode==='scalar_clear_absorbed'?{field:'condition',kind:'world_state',value:null,operation:'clear'}
        : mode==='profile_clear_selector'?{domain:'character',target:'민아',subject:'mina',field:'preferences',kind:'character_preference',
          value:[{content:'커피를 좋아한다',topic:'커피',kind:'preference'}],operation:'clear'}:null;
      if(['scalar_clear_absorbed','profile_clear_selector'].includes(mode))all[1].data+=' '+quote+'.';
      if(mode==='repeated')all[1].data+=' '+quote+'.';
      f.chat.message=all.slice(0,2);f.chat.messages=f.chat.message;
      f.control.onCall=async args=>{
        const input=JSON.parse(args[0].messages[1].content),startOffset=input.assistant.text.indexOf(quote);
        const operation=referenceCase?.operation||'set';
        const envelope={schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:referenceCase?.domain==='character'?'person':'world',text:claimText,actor:'',target:referenceCase?.target||'도서관',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:mode==='generic'?'none':operation,...(mode==='generic'?{}:{stateIntent:{domain:referenceCase?.domain||'world',target:{entityName:referenceCase?.target||'도서관'},field:referenceCase?.field||'condition',operation,...(operation==='clear'?{}:{value:referenceCase?referenceCase.value:quote})}}),evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset,endOffset:startOffset+quote.length,exactQuote:quote}}]}};
        if(['duplicate_micro','alias_micro'].includes(mode)){
          const duplicate=JSON.parse(JSON.stringify(envelope.micro.claims[0]));
          if(mode==='alias_micro')duplicate.stateIntent.target.entityName='도서관 전체';
          envelope.micro.claims.push(duplicate);
        }
        return {type:'success',result:JSON.stringify(envelope)};
      };
      listener({char:f.character,chat:f.chat,characterIndex:0,chatIndex:0,messageIndex:1});
      await waitFor(()=>f.r.api.getCaptureBackendState().lastMicroPublication?.turn===1,15000);
      if(referenceCase){
        const subject=referenceCase.subject||'library',domain=referenceCase.domain||'world';
        const existing=f.control.artifact.facts.find(fact=>fact.claimKind===referenceCase.kind&&fact.subjectTempRef===subject);
        const fact={tempFactId:'f_reference_b1',domain,subjectTempRef:subject,claimKind:referenceCase.kind,
          values:{[referenceCase.field]:referenceCase.value},text:claimText,effect:referenceCase.operation||'set',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t1-a',quote}]};
        if(existing){fact.tempFactId=existing.tempFactId;Object.assign(existing,fact);}
        else{f.control.artifact.facts.push(fact);f.control.artifact.stateBindings.push({factTempId:fact.tempFactId,typedValueField:referenceCase.field,stateDomain:domain,stateField:referenceCase.field});}
        if(mode==='profile_clear_selector')f.control.artifact.schema='libra.canonical_artifact.v5';
      }else if(mode!=='omitted'){
        f.control.artifact.facts.push({tempFactId:'f_condition_b1',domain:'world',subjectTempRef:'library',claimKind:'world_state',values:{condition:mode==='conflicting'?quote+'이다':quote},text:quote+'이다.',temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref:'t1-a',quote}]});
        f.control.artifact.stateBindings.push({factTempId:'f_condition_b1',typedValueField:'condition',stateDomain:'world',stateField:'condition'});
        if(mode==='duplicate_canonical')f.control.artifact.facts.push({...JSON.parse(JSON.stringify(f.control.artifact.facts.at(-1))),tempFactId:'f_condition_b1_copy'});
      }
      f.chat.message=all;f.chat.messages=all;
      f.control.onCall=async()=>({type:'success',result:JSON.stringify(f.control.artifact)});
      assert.equal((await f.run()).completed,1);
      if(mode==='alias_micro'){
        const registry=f.getRecords('libra.entity_registry.v1')[0]||f.getRecords('libra.entity_registry.v2')[0];
        assert.ok(registry,'synthetic alias test requires real durable entity registry');
        registry.value.entities.find(entity=>entity.name==='도서관').aliases.push('도서관 전체');
        f.r.values.set(registry.key,JSON.stringify(registry.value));
      }
      f.control.onCall=async()=>{throw Error('B1 recall cannot invoke provider');};
      const stateBefore=JSON.stringify(f.getHead());
      await f.r.api.saveLibraProviderConfig({responseFamily:'libra',libraResponseMode:'classic'});
      const packet=await f.control.hooks.beforeRequest([{role:'user',content:quote}],'model');
      const viewer=f.r.api.getLastMemoryRecallViewer();
      evidenceReport.correspondence.push({case:mode,network:f.r.api.getRuntime().lastMemoryRecall.diagnostics.microNetworkClusters,
        finalRows:observedRows(viewer),systemPacket:packet.filter(row=>row.role==='system').map(row=>row.content)});
      assert.ok(packet.some(row=>String(row.content||'').includes(quote)),mode+': grounded quote reaches actual packet');
      const micro=viewer.rows.find(row=>row.kind==='micro');assert.ok(micro,mode+': durable Micro remains selected');
      if(['absorbed','scalar_clear_absorbed'].includes(mode)){
        assert.equal(micro.deduplicatedClaims,1,'unique same-source typed claim is absorbed by actually packed canonical');
        assert.equal(micro.injected,false);
      }else{
        assert.equal(micro.deduplicatedClaims,0,mode+': no unjustified typed absorption');
        assert.equal(micro.injected,true,mode+': omitted/conflicting/ambiguous/unpacked Micro remains delivered');
      }
      assert.equal(JSON.stringify(f.getHead()),stateBefore,mode+': search clustering never mutates current State');
      if(mode==='absorbed'){
        const prepared=f.r.api.getLastResponseContext(),sourceKey=f.getMemory().sourceEvidenceRef.key;
        const storage=f.r.context.risuai.pluginStorage,original=storage.getItem;
        let finalReached=false;
        storage.getItem=async key=>{
          if(!finalReached&&key===sourceKey&&f.r.api.getLastResponseContext()?.requestId!==prepared.requestId){
            finalReached=true;const body=JSON.parse(f.r.values.get(key));body.rows[0].assistantText+=' changed after packing';f.r.values.set(key,JSON.stringify(body));
          }
          return original(key);
        };
        try{
          const input=[{role:'user',content:quote}],rejected=await f.control.hooks.beforeRequest(input,'model');
          assert.equal(finalReached,true,'typed absorption retains physical source dependency at actual final consume');
          assert.deepEqual(JSON.parse(JSON.stringify(rejected)),input,'late source dependency change cannot inject');
          assert.match(f.r.api.getLastMemoryRecallViewer().errorCode,/CONSUMER_NETWORK_DEPENDENCY_CHANGED/);
        }finally{storage.getItem=original;}
      }
    }finally{await f.r.cleanup();}
  }
  console.log('PASS B1 actually packed typed absorption, omitted/conflicting/ambiguous source retention');
}
