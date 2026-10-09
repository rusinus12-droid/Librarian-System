'use strict';

// Phase D4: analysis candidate preparation is measured separately from Recall closure.
// The real provider prompt receives request-local aliases for a 41-record prior chain;
// the product must expose at most its visible forty-row candidate window and preserve
// cancellation at the canonical job boundary.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { sourceRows } = require('./fixtures/unified_vertical_source.json');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const ALL_MODES = ['plugin_only', 'mirror', 'server_only'];
const MODES = process.env.PHASE_D_CANDIDATE_MODE
  ? ALL_MODES.filter(mode => mode === process.env.PHASE_D_CANDIDATE_MODE)
  : ALL_MODES;
assert.ok(MODES.length > 0, 'candidate mode filter selects an available storage mode');
const CANDIDATE_COUNT = Number(process.env.PHASE_D_CANDIDATE_COUNT || 41);
const cancellationManifestDiagnosticsLogged = new Set();
const CANONICAL_JOB_HISTORY_LIMIT=12;
assert.ok(Number.isInteger(CANDIDATE_COUNT)&&CANDIDATE_COUNT>=1&&CANDIDATE_COUNT<=41, 'candidate diagnostic scale is between 1 and 41 refs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const candidateSequenceTransform = source => {
  const builder = '    const buildContinuityCandidateContext = async (basis,batch,signal=null) => {';
  assert.equal(source.includes(builder), true, 'test-only candidate sequence probe anchor exists');
  source = source.replace(builder, `    let __phaseDPreparationSequence=0;\n${builder}`);
  const diagnostics = "      const diagnostics={schema:'libra.analysis_candidate_preparation.v1',refsAvailable:0";
  assert.equal(source.includes(diagnostics), true, 'test-only candidate sequence diagnostic anchor exists');
  source = source.replace(diagnostics,
    "      const diagnostics={testPreparationSequence:++__phaseDPreparationSequence,schema:'libra.analysis_candidate_preparation.v1',refsAvailable:0");
  return source;
};
const candidateRowsFromPrompt = args => {
  const user = args?.[0]?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};

const makeArtifact = ({ startRef, count, seed = 'chain' }) => {
  const value = clone(artifact());
  value.schema = 'libra.canonical_artifact.v5';
  const offset = Number(/^t(\d+)-/.exec(startRef)?.[1] || 1) - 1;
  const quoteForRef = ref => {
    const turn = Number(/^t(\d+)-/.exec(ref)?.[1] || 1);
    const suffix = /-a$/.test(ref) ? 'a' : 'u';
    if (seed === 'successor' && ref === 't6-a') return '민아와 지호가 새 약속을 기록했다.';
    return sourceRows.find(row => row.ref === `t${turn - offset}-${suffix}`)?.text || sourceRows[0].text;
  };
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      const baseTurn = Number(/^t(\d+)-/.exec(span.ref)?.[1] || 1);
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
      span.quote = quoteForRef(span.ref);
    }
  }
  const subject = value.entities.find(entity => entity.tempId === 'promise')?.tempId || 'promise';
  const evidenceRef = startRef;
  const evidenceQuote = seed === 'successor' ? '민아와 지호가 새 약속을 기록했다.' : quoteForRef(evidenceRef);
  for (let index = 0; index < count; index += 1) {
    const n = index + 1;
    const summary = seed.startsWith('chain') ? `약속-${seed.split('_')[1] || n}` : '새 약속';
    value.facts.push({
      tempFactId: `${seed}_thread_${n}`, domain: 'narrative', subjectTempRef: subject, claimKind: 'thread',
      values: { thread: { summary, status: 'open', kind: 'promise',
        participants: [{ role: 'owner', personTempRef: 'jiho' }, { role: 'target', personTempRef: 'mina' }] } },
      text: evidenceQuote, temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [{ ref: evidenceRef, quote: evidenceQuote }]
    });
  }
  return value;
};

const appendSecondBatch = f => {
  for (let index = 0; index < 10; index += 1) {
    const source = sourceRows[index];
    const turn = 6 + Math.floor(index / 2);
    f.chat.message.push({ role: source.role, data: source.text, chatId: `t${turn}-${index % 2 ? 'a' : 'u'}` });
  }
  const assistant = f.chat.message.find(row => row.chatId === 't6-a');
  assert.ok(assistant);
  assistant.data = '민아와 지호가 새 약속을 기록했다.';
  f.chat.messages = f.chat.message;
};

const appendBatch = (f, startTurn) => {
  for (let index = 0; index < 10; index += 1) {
    const source = sourceRows[index];
    const turn = startTurn + Math.floor(index / 2);
    f.chat.message.push({ role: source.role, data: source.text, chatId: `t${turn}-${index % 2 ? 'a' : 'u'}` });
  }
  f.chat.messages = f.chat.message;
};

const waitForSeedVectorPersistence = async (mode,snapshot,manifestKey) => {
  const startedAt=performance.now();
  let retryCalls=0,stableChecks=0,previousToken='',lastSummary=null;
  for(let attempt=0;attempt<1500&&performance.now()-startedAt<30000;attempt+=1){
    const localRaw=await snapshot.backend.getItem(manifestKey);
    const serverRows=snapshot.storedRows();
    const serverByKey=new Map(serverRows.map(row=>[row.key,row]));
    const serverRow=serverByKey.get(manifestKey)||null;
    const localManifest=localRaw?JSON.parse(localRaw):null;
    const manifest=mode==='server_only'?(serverRow?.value||null):(localManifest||serverRow?.value||null);
    const refs=Object.values(manifest?.memories||{}).filter(ref=>ref?.status==='committed');
    const pendingRefs=refs.filter(ref=>['pending','retry_pending'].includes(String(ref.embeddingStatus||'')));
    const pendingRows=[],rowTokens=[];
    let refsMatchRows=true;
    for(const ref of refs){
      const localMemoryRaw=await snapshot.backend.getItem(ref.key);
      const serverMemory=serverByKey.get(ref.key)||null;
      const localMemory=localMemoryRaw?JSON.parse(localMemoryRaw):null;
      const memory=mode==='server_only'?(serverMemory?.value||null):(localMemory||serverMemory?.value||null);
      const memoryStatus=String(memory?.embedding?.status||'');
      if(['pending','retry_pending'].includes(String(ref.embeddingStatus||''))||['pending','retry_pending'].includes(memoryStatus))
        pendingRows.push({start:Number(ref.turnRange?.start||0),refStatus:String(ref.embeddingStatus||''),memoryStatus});
      if(memory&&String(ref.embeddingStatus||'')!==memoryStatus)refsMatchRows=false;
      if(localMemory&&serverMemory&&String(localMemory?.embedding?.status||'')!==String(serverMemory?.value?.embedding?.status||''))refsMatchRows=false;
      rowTokens.push([ref.key,localMemoryRaw||null,serverMemory?.raw??null,serverMemory?.revision??null]);
    }
    const copiesMatch=!(mode==='mirror'&&localManifest&&serverRow)
      ||JSON.stringify(localManifest)===JSON.stringify(serverRow.value);
    const token=JSON.stringify({localRaw:localRaw||null,serverRaw:serverRow?.raw??null,serverRevision:serverRow?.revision??null,rowTokens});
    const canonicalStatus=await snapshot.f.r.api.getCanonicalJobStatus({});
    const canonicalTerminal=!canonicalStatus?.cancellable
      &&!['queued','running','cancel_requested','cancelling'].includes(String(canonicalStatus?.state||''));
    lastSummary={refs:refs.length,pendingRefCount:pendingRefs.length,pendingMemoryCount:pendingRows.length,
      refsMatchRows,copiesMatch,canonicalState:canonicalStatus?.state||null,canonicalTerminal,retryCalls};
    if(refs.length===CANDIDATE_COUNT&&pendingRefs.length===0&&pendingRows.length===0&&refsMatchRows&&copiesMatch&&canonicalTerminal&&token===previousToken)stableChecks+=1;
    else stableChecks=0;
    if(stableChecks>=10){
      const result={mode,retryCalls,stableChecks,elapsedMs:performance.now()-startedAt,manifestRevision:serverRow?.revision??null,
        pendingRefCount:0,pendingMemoryCount:0,refsMatchRows,copiesMatch,canonicalState:canonicalStatus?.state||null};
      console.log(JSON.stringify({record:'candidate_seed_vector_persistence_settled',...result}));
      return {manifest,localRaw:localRaw||null,serverRow,result};
    }
    previousToken=token;
    if(pendingRefs.length||pendingRows.length){
      if(retryCalls>=64)break;
      await snapshot.f.r.api.retryPendingUnifiedVectors();
      retryCalls+=1;
      if(retryCalls%10===0)console.log(JSON.stringify({record:'candidate_seed_vector_persistence_progress',mode,retryCalls,
        refs:refs.length,pendingRefCount:pendingRefs.length,pendingMemoryCount:pendingRows.length,elapsedMs:performance.now()-startedAt}));
    }else await sleep(20);
  }
  throw new Error(`${mode}: vector/post-commit persistence did not settle before successor setup (${JSON.stringify(lastSummary)})`);
};

const captureScopePublicationState = async (snapshot,manifestKey,successorMemoryKey) => {
  const scopePrefix=manifestKey.replace(/manifest$/,'');
  const serverRows=snapshot.storedRows();
  const serverByKey=new Map(serverRows.map(row=>[row.key,row]));
  const keys=new Set([
    ...snapshot.local.keys().filter(key=>key.startsWith(scopePrefix)),
    ...serverRows.filter(row=>row.key.startsWith(scopePrefix)).map(row=>row.key),
    successorMemoryKey
  ]);
  const rows={};
  for(const key of [...keys].sort()){
    const localRaw=await snapshot.backend.getItem(key);
    const serverRow=serverByKey.get(key)||null;
    rows[key]={localRaw:localRaw??null,serverRaw:serverRow?.raw??null,serverRevision:serverRow?.revision??null};
  }
  return {scopePrefix,rows,head:snapshot.getHead()||null};
};

const rawSha256 = value => value == null ? null : crypto.createHash('sha256').update(String(value)).digest('hex');
const summarizeStoredRaw = raw => {
  if(raw==null)return null;
  try{
    const value=JSON.parse(raw);
    const summary={schema:value?.schema||null,keys:Object.keys(value||{}).sort().slice(0,32)};
    for(const key of ['state','status','jobId','runId','updatedAt','createdAt','finishedAt','durationMs','lastError','phase','stage','currentStage','cancellable','turnRange','scopeKey'])
      if(Object.prototype.hasOwnProperty.call(value,key))summary[key]=value[key];
    if(Object.prototype.hasOwnProperty.call(value,'providerBudget'))summary.providerBudget=value.providerBudget;
    if(Object.prototype.hasOwnProperty.call(value,'analysisDiagnostic'))summary.analysisDiagnostic=value.analysisDiagnostic;
    if(value?.frontiers)summary.frontiers={...value.frontiers};
    if(value?.branchGuard)summary.branchGuard={...value.branchGuard};
    if(value?.stats)summary.stats={...value.stats};
    if(value?.memories){summary.memoryRefCount=Object.keys(value.memories).length;summary.memoriesSha256=rawSha256(JSON.stringify(value.memories));}
    if(value?.inheritedMemories)summary.inheritedMemoriesSha256=rawSha256(JSON.stringify(value.inheritedMemories));
    if(Object.prototype.hasOwnProperty.call(value,'inFlight'))summary.inFlight=value.inFlight?{runId:value.inFlight.runId,status:value.inFlight.status,startTurn:value.inFlight.startTurn}:null;
    if(value?.currentDraft)summary.currentDraftChars=String(value.currentDraft).length;
    if(value?.stageObjects)summary.stageCount=value.stageObjects.length;
    return summary;
  }catch(_){return {parseable:false,chars:String(raw).length};}
};
const diffPublicationRows = (before,after) => {
  const keys=[...new Set([...Object.keys(before?.rows||{}),...Object.keys(after?.rows||{})])].sort();
  const changed=[];
  for(const key of keys){
    const a=before?.rows?.[key]||null,b=after?.rows?.[key]||null;
    if(JSON.stringify(a)===JSON.stringify(b))continue;
    changed.push({key,localChanged:(a?.localRaw??null)!==(b?.localRaw??null),
      serverChanged:(a?.serverRaw??null)!==(b?.serverRaw??null),revisionChanged:(a?.serverRevision??null)!==(b?.serverRevision??null),
      before:{localSha256:rawSha256(a?.localRaw),serverSha256:rawSha256(a?.serverRaw),serverRevision:a?.serverRevision??null,
        localSummary:summarizeStoredRaw(a?.localRaw),serverSummary:summarizeStoredRaw(a?.serverRaw)},
      after:{localSha256:rawSha256(b?.localRaw),serverSha256:rawSha256(b?.serverRaw),serverRevision:b?.serverRevision??null,
        localSummary:summarizeStoredRaw(b?.localRaw),serverSummary:summarizeStoredRaw(b?.serverRaw)},
      topLevelChangedKeys:(()=>{try{const av=JSON.parse(a?.localRaw??a?.serverRaw??'null')||{},bv=JSON.parse(b?.localRaw??b?.serverRaw??'null')||{};
        return [...new Set([...Object.keys(av),...Object.keys(bv)])].filter(name=>JSON.stringify(av[name])!==JSON.stringify(bv[name])).sort();}catch(_){return [];}})(),
      branchGuardChangedKeys:(()=>{try{const av=JSON.parse(a?.localRaw??a?.serverRaw??'null')?.branchGuard||{},bv=JSON.parse(b?.localRaw??b?.serverRaw??'null')?.branchGuard||{};
        return [...new Set([...Object.keys(av),...Object.keys(bv)])].filter(name=>JSON.stringify(av[name])!==JSON.stringify(bv[name])).sort();}catch(_){return [];}})()});
  }
  return {changed,headChanged:JSON.stringify(before?.head??null)!==JSON.stringify(after?.head??null),
    headBeforeSha256:rawSha256(JSON.stringify(before?.head??null)),headAfterSha256:rawSha256(JSON.stringify(after?.head??null))};
};
const immutablePublicationState = (state,mutableKeys=[]) => {
  const expectedMutableKeys=new Set(mutableKeys);
  return {scopePrefix:state.scopePrefix,
    rows:Object.fromEntries(Object.entries(state.rows).filter(([key])=>!expectedMutableKeys.has(key))),
    head:state.head};
};
const storedValueForRow = row => {
  const raw=row?.localRaw??row?.serverRaw??null;
  return raw==null?null:JSON.parse(raw);
};
const storedValueForMode = (mode,row) => {
  const raw=mode==='server_only'?(row?.serverRaw??null):(row?.localRaw??row?.serverRaw??null);
  return raw==null?null:JSON.parse(raw);
};
const canonicalJobEntries = (mode,state) => Object.entries(state?.rows||{})
  .filter(([key])=>key.startsWith(`${state.scopePrefix}canonical-job:`)&&key!==`${state.scopePrefix}canonical-job-head:v1`)
  .map(([key,row])=>({key,job:storedValueForMode(mode,row)}))
  .filter(entry=>entry.job?.schema==='libra.canonical_job.v1'&&entry.job.scopeKey===state.scopePrefix.split(':scope:')[1].replace(/:$/,''));
const canonicalJobTerminal = job => ['completed','completed_with_warnings','cancelled','failed','original_kept'].includes(String(job?.state||''));
const planCanonicalJobRetention = (mode,state,preserveJobId) => {
  const terminal=canonicalJobEntries(mode,state).filter(entry=>canonicalJobTerminal(entry.job))
    .sort((a,b)=>String(b.job.updatedAt||b.job.finishedAt||'').localeCompare(String(a.job.updatedAt||a.job.finishedAt||'')));
  const retainedOlder=terminal.slice(0,CANONICAL_JOB_HISTORY_LIMIT-1);
  const pruned=terminal.slice(CANONICAL_JOB_HISTORY_LIMIT-1);
  return {limit:CANONICAL_JOB_HISTORY_LIMIT,terminalBefore:terminal.map(entry=>entry.job.jobId),
    expectedRetainedJobIds:[String(preserveJobId),...retainedOlder.map(entry=>entry.job.jobId)],
    expectedPrunedJobIds:pruned.map(entry=>entry.job.jobId),expectedPrunedKeys:pruned.map(entry=>entry.key)};
};
const assertJobRetentionTransition = (mode,beforeState,afterState,jobId,plan) => {
  const beforeTerminal=canonicalJobEntries(mode,beforeState).filter(entry=>canonicalJobTerminal(entry.job));
  const afterTerminal=canonicalJobEntries(mode,afterState).filter(entry=>canonicalJobTerminal(entry.job));
  const actuallyPruned=beforeTerminal.filter(entry=>!afterState.rows[entry.key]||storedValueForMode(mode,afterState.rows[entry.key])==null)
    .map(entry=>entry.job.jobId);
  assert.deepEqual(actuallyPruned,plan.expectedPrunedJobIds,`${mode}: only the exact oldest terminal job receipts over the 12-row limit are pruned`);
  assert.equal(afterTerminal.length,Math.min(plan.limit,beforeTerminal.length+1),`${mode}: terminal job receipt count stays within the configured retention limit`);
  const actualRetained=afterTerminal.map(entry=>entry.job.jobId).sort();
  assert.deepEqual(actualRetained,[...plan.expectedRetainedJobIds].sort(),`${mode}: cancellation preserves the new terminal receipt and the 11 newest prior receipts`);
  assert.ok(afterTerminal.some(entry=>entry.job.jobId===jobId&&entry.job.state==='cancelled'),`${mode}: active canceled job is retained`);
  return {limit:plan.limit,terminalBefore:beforeTerminal.length,terminalAfter:afterTerminal.length,
    prunedJobIds:actuallyPruned,retainedJobIds:actualRetained};
};
const withoutFields = (value,fields) => {
  const copy=clone(value||{});
  for(const field of fields)delete copy[field];
  return copy;
};
const changedObjectFields = (before,after) => [...new Set([...Object.keys(before||{}),...Object.keys(after||{})])]
  .filter(field=>JSON.stringify(before?.[field])!==JSON.stringify(after?.[field])).sort();
const assertCancellationBookkeeping = (mode,beforeState,afterState,{jobId,manifestKey,runKey,workKey}) => {
  const scopePrefix=beforeState.scopePrefix;
  const jobKey=`${scopePrefix}canonical-job:${jobId}`,headKey=`${scopePrefix}canonical-job-head:v1`;
  const beforeJob=storedValueForMode(mode,beforeState.rows[jobKey]),afterJob=storedValueForMode(mode,afterState.rows[jobKey]);
  const beforeHead=storedValueForMode(mode,beforeState.rows[headKey]),afterHead=storedValueForMode(mode,afterState.rows[headKey]);
  assert.ok(beforeJob&&afterJob&&beforeHead&&afterHead,`${mode}: canonical job receipt/head rows are present before and after cancellation`);
  assert.deepEqual(withoutFields(afterJob,['cancelRequested','cancellable','finishedAt','message','phase','result','skipped','state','updatedAt']),
    withoutFields(beforeJob,['cancelRequested','cancellable','finishedAt','message','phase','result','skipped','state','updatedAt']),
    `${mode}: cancellation changes only the active job's explicit terminal receipt fields`);
  assert.equal(beforeJob.jobId,jobId,`${mode}: persisted active job row matches the active job id`);
  assert.equal(afterJob.jobId,jobId,`${mode}: persisted canceled job row retains the active job id`);
  assert.equal(beforeJob.state,'running',`${mode}: job was running at the frozen tail-read barrier`);
  assert.equal(afterJob.state,'cancelled',`${mode}: job row records terminal cancellation`);
  assert.equal(afterJob.cancelRequested,true,`${mode}: canceled job retains its cancellation request`);
  assert.equal(afterJob.cancellable,false,`${mode}: canceled job is no longer cancellable`);
  assert.ok(afterJob.finishedAt,`${mode}: canceled job has a terminal timestamp`);
  assert.deepEqual(withoutFields(afterHead,['state','updatedAt']),withoutFields(beforeHead,['state','updatedAt']),
    `${mode}: only the exact job-head state/timestamp changes`);
  assert.equal(beforeHead.jobId,jobId,`${mode}: pre-cancel head points at active job`);
  assert.equal(afterHead.jobId,jobId,`${mode}: post-cancel head retains active job`);
  assert.equal(afterHead.state,'cancelled',`${mode}: job head records terminal cancellation`);

  const beforeManifest=storedValueForMode(mode,beforeState.rows[manifestKey]);
  const afterManifest=storedValueForMode(mode,afterState.rows[manifestKey]);
  assert.ok(beforeManifest&&afterManifest,`${mode}: manifest exists across cancellation`);
  if (mode === 'mirror' || mode === 'server_only') {
    const manifestRowSummary = row => {
      const parse = raw => {
        if (raw == null) return null;
        const value=JSON.parse(raw);
        return {inFlight:value.inFlight||null,frontiers:value.frontiers||null,
          refsSha256:rawSha256(JSON.stringify(value.memories||{})),refCount:Object.keys(value.memories||{}).length};
      };
      return {serverRevision:row?.serverRevision??null,local:parse(row?.localRaw??null),server:parse(row?.serverRaw??null)};
    };
    const beforeRow=beforeState.rows[manifestKey],afterRow=afterState.rows[manifestKey];
    if (!cancellationManifestDiagnosticsLogged.has(mode)
      && JSON.stringify(manifestRowSummary(beforeRow)) !== JSON.stringify(manifestRowSummary(afterRow))) {
      cancellationManifestDiagnosticsLogged.add(mode);
      console.log(JSON.stringify({record:'candidate_cancel_manifest_storage_diagnostic',mode,
        before:manifestRowSummary(beforeRow),after:manifestRowSummary(afterRow)}));
    }
  }
  const normalizeManifest=value=>{
    const normalized=clone(value);delete normalized.inFlight;delete normalized.updatedAt;
    if(normalized.branchGuard){delete normalized.branchGuard.lastFullAuditAt;delete normalized.branchGuard.updatedAt;}
    return normalized;
  };
  assert.deepEqual(normalizeManifest(afterManifest),normalizeManifest(beforeManifest),
    `${mode}: manifest changes only inFlight, updatedAt, and branch-audit timestamps during cancellation`);
  assert.deepEqual(afterManifest.memories,beforeManifest.memories,`${mode}: canonical refs remain exact across cancellation`);
  assert.deepEqual(afterManifest.inheritedMemories,beforeManifest.inheritedMemories,`${mode}: inherited refs remain exact across cancellation`);
  assert.deepEqual(afterManifest.frontiers,beforeManifest.frontiers,`${mode}: canonical frontiers remain exact across cancellation`);
  assert.deepEqual(afterManifest.stats,beforeManifest.stats,`${mode}: manifest stats remain exact across cancellation`);
  assert.equal(beforeManifest.inFlight?.runId,storedValueForMode(mode,beforeState.rows[runKey])?.runId,
    `${mode}: manifest in-flight id matches the preparing run`);
  assert.equal(beforeManifest.inFlight?.status,'running',`${mode}: manifest marks successor run active before cancel`);
  assert.equal(afterManifest.inFlight,null,`${mode}: cancellation clears the successor in-flight marker`);
  if(mode==='mirror'){
    assert.equal(JSON.parse(afterState.rows[manifestKey]?.localRaw||'null')?.inFlight,null,
      `${mode}: cancellation clears the local mirrored in-flight marker`);
    assert.equal(JSON.parse(afterState.rows[manifestKey]?.serverRaw||'null')?.inFlight,null,
      `${mode}: cancellation clears the server-authoritative in-flight marker`);
  }else if(mode==='server_only'){
    assert.equal(JSON.parse(afterState.rows[manifestKey]?.serverRaw||'null')?.inFlight,null,
      `${mode}: cancellation clears the server-authoritative in-flight marker`);
  }
  const beforeGuard=beforeManifest.branchGuard||{},afterGuard=afterManifest.branchGuard||{};
  assert.deepEqual(withoutFields(afterGuard,['lastFullAuditAt','updatedAt']),withoutFields(beforeGuard,['lastFullAuditAt','updatedAt']),
    `${mode}: branch guard identity/signatures remain exact; only audit timestamps may advance`);
  assert.deepEqual(afterGuard.batchSignatures,beforeGuard.batchSignatures,`${mode}: branch guard source signatures remain exact`);
  assert.deepEqual(afterGuard.verifiedStarts,beforeGuard.verifiedStarts,`${mode}: branch guard verified starts remain exact`);
  assert.ok(Number(afterGuard.lastFullAuditAt||0)>=Number(beforeGuard.lastFullAuditAt||0),`${mode}: branch guard audit time does not move backward`);
  assert.ok(Date.parse(afterGuard.updatedAt||'')>=Date.parse(beforeGuard.updatedAt||''),`${mode}: branch guard update time does not move backward`);

  const beforeRun=storedValueForMode(mode,beforeState.rows[runKey]),afterRun=storedValueForMode(mode,afterState.rows[runKey]);
  assert.ok(beforeRun&&afterRun,`${mode}: successor execution row remains available for transition checks`);
  assert.deepEqual(withoutFields(afterRun,['analysisDiagnostic','durationMs','finishedAt','status']),
    withoutFields(beforeRun,['analysisDiagnostic','durationMs','finishedAt','status']),`${mode}: run row changes only at its cancel terminal fields`);
  assert.equal(beforeRun.status,'running',`${mode}: run was active at cancellation barrier`);
  assert.equal(afterRun.status,'interrupted',`${mode}: canceled successor run is marked interrupted`);
  assert.equal(afterRun.runId,beforeRun.runId,`${mode}: interrupted run retains its run id`);
  assert.equal(afterRun.startedAt,beforeRun.startedAt,`${mode}: run start time is preserved`);
  assert.ok(afterRun.finishedAt&&Number(afterRun.durationMs)>0,`${mode}: interrupted run records finite completion timing`);
  assert.equal(afterRun.analysisDiagnostic?.error,'Canonical job cancelled.',`${mode}: run diagnostic records the typed cancellation`);
  assert.equal(afterRun.analysisDiagnostic?.invocation?.submitted,false,`${mode}: run diagnostic confirms no provider submission`);

  const beforeWork=storedValueForMode(mode,beforeState.rows[workKey]),afterWork=storedValueForMode(mode,afterState.rows[workKey]);
  assert.ok(beforeWork&&afterWork,`${mode}: successor work row remains available for transition checks`);
  assert.deepEqual(withoutFields(afterWork,['lastError','providerBudget','status','updatedAt']),
    withoutFields(beforeWork,['lastError','providerBudget','status','updatedAt']),`${mode}: work row changes only at its cancel terminal fields`);
  assert.equal(beforeWork.status,'building',`${mode}: work was building at cancellation barrier`);
  assert.equal(afterWork.status,'interrupted',`${mode}: canceled work is marked interrupted`);
  assert.equal(afterWork.runId,beforeWork.runId,`${mode}: interrupted work retains its run id`);
  assert.equal(afterWork.lastError,'cancelled_at_safe_boundary',`${mode}: work row records the safe cancellation boundary`);
  assert.equal(Number(afterWork.providerBudget?.totalCalls||0),0,`${mode}: provider budget records no physical model call`);
  assert.equal((Array.isArray(afterWork.providerBudget?.attempts)?afterWork.providerBudget.attempts:[]).length,0,`${mode}: no provider attempt is published in the canceled work row`);
  return {jobId,manifestKey,runKey,workKey,cancelledReceiptValid:true,runState:afterRun.status,workState:afterWork.status,
    providerBudgetCalls:Number(afterWork.providerBudget?.totalCalls||0),branchAuditChanged:changedObjectFields(beforeGuard,afterGuard)};
};
const sourceEvidenceFingerprint = body => {
  let a=2166136261,b=2246822507;
  for(let i=0;i<body.length;i+=1){const c=body.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,3266489909);}
  return `${(a>>>0).toString(16).padStart(8,'0')}${(b>>>0).toString(16).padStart(8,'0')}:${body.length}`;
};
const inspectCanonicalSourceEvidence = async (mode,snapshot,originalGetItem,orderedRefs,publicationAtBarrier) => {
  const scopePrefix=publicationAtBarrier.scopePrefix;
  const serverByKey=new Map(snapshot.storedRows().map(row=>[row.key,row]));
  const pointers=[];
  for(const ref of orderedRefs){
    const localMemoryRaw=await originalGetItem(ref.key);
    const serverMemoryRow=serverByKey.get(ref.key)||null;
    const serverMemoryRaw=serverMemoryRow?.raw??null;
    const memoryValue=mode==='server_only'
      ? storedValueForRow({serverRaw:serverMemoryRaw})
      : storedValueForRow({localRaw:localMemoryRaw,serverRaw:serverMemoryRaw});
    assert.ok(memoryValue,`${mode}: canonical memory row exists for ${ref.key}`);
    const pointer=memoryValue.sourceEvidenceRef;
    assert.equal(pointer?.owner,'libra',`${mode}: memory source evidence pointer has LIBRA ownership (${ref.key})`);
    assert.equal(pointer?.scopeKey,memoryValue.scopeKey,`${mode}: evidence pointer scope matches its memory (${ref.key})`);
    assert.equal(memoryValue.scopeKey,scopePrefix.split(':scope:')[1].replace(/:$/,''),`${mode}: canonical memory belongs to manifest scope (${ref.key})`);
    assert.equal(pointer?.sourceDigest,memoryValue.sourceDigest,`${mode}: evidence pointer source digest matches memory (${ref.key})`);
    assert.equal(pointer?.sourceDigest,ref.sourceDigest,`${mode}: evidence pointer source digest matches manifest ref (${ref.key})`);
    if(pointer?.payloadDigest!==ref.sourceEvidenceDigest)console.log(JSON.stringify({record:'candidate_evidence_manifest_digest_mismatch',mode,
      memoryKey:ref.key,refArtifactSchema:ref.artifactSchema,refHasEvidenceDigest:Object.prototype.hasOwnProperty.call(ref,'sourceEvidenceDigest'),
      refEvidenceDigest:ref.sourceEvidenceDigest,memoryArtifactSchema:memoryValue.artifactSchema,
      memoryEvidencePayloadDigest:pointer?.payloadDigest,memoryEvidenceKey:pointer?.key,refKeys:Object.keys(ref).sort()}));
    assert.equal(pointer?.payloadDigest,ref.sourceEvidenceDigest,`${mode}: manifest evidence digest matches memory pointer (${ref.key})`);
    assert.ok(typeof pointer?.key==='string'&&pointer.key.startsWith(`${scopePrefix}source-evidence:v1:`),
      `${mode}: canonical evidence pointer targets the scope source-evidence namespace (${ref.key})`);
    const localEvidenceRaw=await originalGetItem(pointer.key);
    const serverEvidenceRow=serverByKey.get(pointer.key)||null;
    const serverEvidenceRaw=serverEvidenceRow?.raw??null;
    const recordValue=mode==='server_only'
      ? storedValueForRow({serverRaw:serverEvidenceRaw})
      : storedValueForRow({localRaw:localEvidenceRaw,serverRaw:serverEvidenceRaw});
    assert.ok(recordValue,`${mode}: pointed-to source evidence row exists (${pointer.key})`);
    assert.equal(recordValue.schema,'memory-suite.source-evidence.v1',`${mode}: evidence row schema is authoritative (${pointer.key})`);
    assert.equal(recordValue.binding?.owner,'libra',`${mode}: evidence binding owner matches (${pointer.key})`);
    assert.equal(recordValue.binding?.scopeKey,memoryValue.scopeKey,`${mode}: evidence binding scope matches (${pointer.key})`);
    assert.equal(recordValue.binding?.sourceDigest,memoryValue.sourceDigest,`${mode}: evidence binding source digest matches (${pointer.key})`);
    assert.equal(recordValue.binding?.unitKey,String(memoryValue.turnRange?.start),`${mode}: evidence unit key matches memory start (${pointer.key})`);
    assert.equal(recordValue.binding?.start,Number(memoryValue.turnRange?.start),`${mode}: evidence range starts at memory turn (${pointer.key})`);
    assert.equal(recordValue.binding?.end,Number(memoryValue.turnRange?.end),`${mode}: evidence range ends at memory turn (${pointer.key})`);
    assert.equal(recordValue.binding?.identity,pointer.identity,`${mode}: evidence identity matches memory pointer (${pointer.key})`);
    assert.equal(recordValue.payloadDigest,pointer.payloadDigest,`${mode}: evidence payload digest matches memory pointer (${pointer.key})`);
    assert.equal(recordValue.payloadDigest,sourceEvidenceFingerprint(JSON.stringify({binding:recordValue.binding,
      normalizationVersion:recordValue.normalizationVersion,rows:recordValue.rows})),`${mode}: evidence payload digest verifies (${pointer.key})`);
    assert.equal(recordValue.rows?.length,Number(memoryValue.turnRange?.end)-Number(memoryValue.turnRange?.start)+1,
      `${mode}: source evidence covers every turn in its canonical memory (${pointer.key})`);
    assert.ok(publicationAtBarrier.rows[pointer.key],`${mode}: source evidence row is in the frozen scope snapshot (${pointer.key})`);
    assert.equal(publicationAtBarrier.rows[pointer.key].localRaw??null,localEvidenceRaw??null,`${mode}: evidence local bytes match frozen scope snapshot (${pointer.key})`);
    assert.equal(publicationAtBarrier.rows[pointer.key].serverRaw??null,serverEvidenceRaw??null,`${mode}: evidence server bytes match frozen scope snapshot (${pointer.key})`);
    pointers.push({memoryKey:ref.key,evidenceKey:pointer.key,sourceDigest:pointer.sourceDigest,payloadDigest:pointer.payloadDigest,
      localRaw:localEvidenceRaw??null,serverRaw:serverEvidenceRaw,serverRevision:serverEvidenceRow?.revision??null});
  }
  assert.equal(pointers.length,CANDIDATE_COUNT,`${mode}: all 41 canonical memories link to source evidence`);
  assert.equal(new Set(pointers.map(pointer=>pointer.evidenceKey)).size,CANDIDATE_COUNT,`${mode}: all 41 source evidence records are distinct`);
  return pointers;
};

const runScale = async mode => {
  const modeStartedAt = Date.now();
  const progress = (phase, detail = {}) => console.log(JSON.stringify({
    record: 'candidate_context_scale_timing', mode, phase, elapsedMs: Date.now() - modeStartedAt, ...detail
  }));
  progress('mode_start', { candidateCount: CANDIDATE_COUNT });
  const snapshot = await serverFixture({ mode, transformSource: candidateSequenceTransform });
  progress('server_fixture_ready');
  try {
    const f = snapshot.f;
    const promptRows = [];
    f.control.onCall = args => {
      promptRows.push(candidateRowsFromPrompt(args));
      return { type: 'success', result: JSON.stringify(f.control.artifact) };
    };
    const seedStartedAt = Date.now();
    for (let batch = 0; batch < CANDIDATE_COUNT; batch += 1) {
      const start = 1 + batch * 5;
      if (batch > 0) appendBatch(f, start);
      f.control.artifact = makeArtifact({ startRef: `t${start}-a`, count: 1, seed: `chain_${batch + 1}` });
      const result = await f.run();
      assert.equal(result.completed, 1, `${mode}: candidate seed ${batch + 1} commits ${JSON.stringify(result)}`);
      if (batch % 10 === 0 || batch === CANDIDATE_COUNT - 1) {
        console.log(JSON.stringify({ record: 'candidate_context_seed_progress', mode, seed: batch + 1,
          totalSeeds: CANDIDATE_COUNT, state: result.state || 'completed', completed: result.completed,
          elapsedMs: Date.now() - modeStartedAt, seedElapsedMs: Date.now() - seedStartedAt,
          candidatePreparationElapsedMs: f.r.api.getRuntime().lastMemoryAnalysisDiagnostic?.candidatePreparation?.elapsedMs ?? null }));
      }
    }
    progress('all_candidate_seeds_complete', { seedCount: CANDIDATE_COUNT, seedElapsedMs: Date.now() - seedStartedAt });
    const cancellationStartedAt = Date.now();
    progress('cancellation_start', { seedsComplete: true });
    const cancellation = await runCancellation(mode, snapshot, { seedsComplete: true });
    progress('cancellation_complete', { cancellationElapsedMs: Date.now() - cancellationStartedAt,
      refsScanned: cancellation.refsScanned, cancelObserved: cancellation.cancelObserved,
      sourceEvidenceRowsObserved: cancellation.sourceEvidenceRowsObserved, immutableScopedRowsUnchanged: cancellation.immutableScopedRowsUnchanged });
    const secondRun = await f.run();
    progress('successor_complete', { completed: secondRun.completed });
    assert.equal(secondRun.completed, 1, `${mode}: candidate scale successor commits`);
    const scopePrefix=cancellation.scopePrefix;
    const manifestKey=`${scopePrefix}manifest`;
    const afterSuccessorRows=snapshot.storedRows();
    const afterSuccessorServerManifest=afterSuccessorRows.find(row=>row.key===manifestKey)||null;
    const afterSuccessorLocalManifestRaw=await snapshot.backend.getItem(manifestKey);
    const afterSuccessorManifest=storedValueForMode(mode,{localRaw:afterSuccessorLocalManifestRaw??null,
      serverRaw:afterSuccessorServerManifest?.raw??null,serverRevision:afterSuccessorServerManifest?.revision??null});
    const successorRunId=String(afterSuccessorManifest?.runIds?.[0]||'');
    assert.ok(successorRunId&&successorRunId!==cancellation.cancelledRunId,
      `${mode}: next candidate call creates a fresh run instead of reusing the cancelled run (${JSON.stringify({successorRunId,cancelledRunId:cancellation.cancelledRunId})})`);
    assert.equal(afterSuccessorManifest?.runIds?.includes(cancellation.cancelledRunId),false,
      `${mode}: same-start successor removes the canceled run id from the manifest run index`);
    const cancelledRunKey=`${scopePrefix}run:${cancellation.cancelledRunId}`;
    const cancelledRunRow=afterSuccessorRows.find(row=>row.key===cancelledRunKey)||null;
    if(cancelledRunRow||await snapshot.backend.getItem(cancelledRunKey)){
      const cancelledRun=storedValueForMode(mode,{serverRaw:cancelledRunRow?.raw??null,
        localRaw:await snapshot.backend.getItem(cancelledRunKey)});
      assert.equal(cancelledRun?.status,'interrupted',`${mode}: any retained canceled run remains interrupted after the fresh successor starts`);
    }
    assert.equal(afterSuccessorManifest?.inFlight,null,`${mode}: fresh successor scan leaves no stale canceled in-flight marker`);
    assert.equal(promptRows.length, CANDIDATE_COUNT + 1, `${mode}: one provider call per canonical ref plus successor`);
    assert.equal(promptRows[0].length, 0, `${mode}: first analysis has no prior candidates`);
    const visible = promptRows.at(-1);
    assert.equal(visible.length, Math.min(40,CANDIDATE_COUNT), `${mode}: analysis candidate context exposes the bounded forty-row window`);
    const visibleCount=Math.min(40,CANDIDATE_COUNT);
    const firstVisibleSeed=CANDIDATE_COUNT-visibleCount+1;
    assert.deepEqual(visible.map(row => row.summary),
      Array.from({ length: visibleCount }, (_, index) => `약속-${firstVisibleSeed+index}`),
      `${mode}: truncation preserves the same ordered tail of lifecycle candidates`);
    assert.equal(new Set(visible.map(row => row.alias)).size, visibleCount, `${mode}: visible aliases are request-local and unique`);
    assert.ok(visible.every(row => Object.keys(row).sort().join(',') === 'alias,participants,summary'),
      `${mode}: candidate payload contains only public alias summary participants`);
    assert.doesNotMatch(JSON.stringify(visible), /memoryId|lifecycleId|personId|factId|cursor/,
      `${mode}: candidate prompt does not expose durable identity fields`);
    const runtime = f.r.api.getRuntime();
    const preparation = runtime.lastMemoryAnalysisDiagnostic?.candidatePreparation;
    assert.equal(preparation?.refsAvailable, CANDIDATE_COUNT, `${mode}: diagnostic counts all candidate refs before visible slicing`);
    assert.equal(preparation?.refsScanned, CANDIDATE_COUNT, `${mode}: diagnostic counts every candidate ref read`);
    assert.ok(Number(preparation?.factsInspected) >= CANDIDATE_COUNT, `${mode}: diagnostic counts inspected facts separately`);
    assert.equal(preparation?.visibleCount, Math.min(40,CANDIDATE_COUNT), `${mode}: diagnostic records the visible candidate bound`);
    progress('scale_and_readback_assertions_complete', { refsAvailable: preparation.refsAvailable,
      refsScanned: preparation.refsScanned, factsInspected: preparation.factsInspected,
      visibleCandidates: visible.length, providerCalls: f.control.calls.length });
    return { mode, seedRefs: CANDIDATE_COUNT, refsAvailable: preparation.refsAvailable,
      refsScanned: preparation.refsScanned, factsInspected: preparation.factsInspected,
      visibleCandidates: visible.length, promptChars: JSON.stringify(visible).length,
      candidatePreparationElapsedMs: preparation.elapsedMs, providerCalls: f.control.calls.length,
      completed: secondRun.completed, successorRunId, cancellation };
  } finally {
    await snapshot.cleanup();
    progress('mode_cleanup_complete');
  }
};

const runCancellation = async (mode, sharedSnapshot = null, { seedsComplete = false } = {}) => {
  const cancellationStartedAt = Date.now();
  const progress = (phase, detail = {}) => console.log(JSON.stringify({
    record: 'candidate_cancel_timing', mode, phase, elapsedMs: Date.now() - cancellationStartedAt, ...detail
  }));
  progress('start', { seedsComplete });
  const ownsSnapshot = !sharedSnapshot;
  const snapshot = sharedSnapshot || await serverFixture({ mode, transformSource: candidateSequenceTransform });
  let releaseRead = () => {}, timeout = null, onUnhandled = null;
  try {
    const f = snapshot.f;
    if (!seedsComplete) {
      f.control.onCall = () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
      for (let batch = 0; batch < CANDIDATE_COUNT; batch += 1) {
        const start = 1 + batch * 5;
        if (batch > 0) appendBatch(f, start);
        f.control.artifact = makeArtifact({ startRef: `t${start}-a`, count: 1, seed: `chain_${batch + 1}` });
        const seeded = await f.run();
        assert.equal(seeded.completed, 1, `${mode}: cancellation seed ${batch + 1} commits`);
        if (batch % 10 === 0 || batch === CANDIDATE_COUNT - 1) {
          console.log(JSON.stringify({ record: 'candidate_cancel_seed_progress', mode, seed: batch + 1,
            totalSeeds: CANDIDATE_COUNT, completed: seeded.completed }));
        }
      }
    }
    const manifestKey = [...snapshot.local.keys()].find(key => /:manifest$/.test(key))
      || snapshot.storedRows().find(row => /:manifest$/.test(row.key))?.key;
    assert.ok(manifestKey, `${mode}: manifest key is available before successor setup`);
    const settledSeed = await waitForSeedVectorPersistence(mode,snapshot,manifestKey);
    progress('seed_vector_persistence_settled', { stableChecks: settledSeed.stableChecks ?? null,
      pendingRefCount: settledSeed.pendingRefCount ?? null });
    const initialServerManifestRow = settledSeed.serverRow;
    const initialLocalManifestBefore = settledSeed.localRaw;
    const manifest = settledSeed.manifest;
    assert.equal(Object.keys(manifest?.memories||{}).length,CANDIDATE_COUNT,`${mode}: vector drain leaves all 41 canonical refs available`);
    const successorStart = 1 + CANDIDATE_COUNT * 5;
    appendBatch(f, successorStart);
    f.control.artifact = makeArtifact({ startRef: `t${successorStart}-a`, count: 1, seed: 'successor' });
    const previousPreparationSequence = Number(f.r.api.getRuntime().lastMemoryCandidatePreparation?.testPreparationSequence || 0);
    assert.ok(manifest?.memories, `${mode}: canonical manifest is available for deterministic tail barrier`);
    const orderedRefs = Object.values(manifest.memories).filter(ref => ref?.status === 'committed')
      .sort((left, right) => Number(left.sessionEpoch || 0) - Number(right.sessionEpoch || 0)
        || Number(left.turnRange?.start || 0) - Number(right.turnRange?.start || 0)
        || Number(left.turnRange?.end || 0) - Number(right.turnRange?.end || 0));
    assert.equal(orderedRefs.length, CANDIDATE_COUNT, `${mode}: barrier is selected from the exact 41-ref manifest`);
    const targetRef = orderedRefs.at(-1);
    const historyAtStart=await f.r.api.getWorldManagerHistoryDetail({memoryId:targetRef.memoryId,revision:targetRef.revision});
    progress('target_history_readback', { targetTurnStart: targetRef.turnRange.start });
    let enteredResolve;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const gate = new Promise(resolve => { releaseRead = resolve; });
    let barrierEntered = false;
    const holdTargetRead = async key => {
      if (String(key) !== String(targetRef.key) || barrierEntered) return;
      const currentPreparation = f.r.api.getRuntime().lastMemoryCandidatePreparation;
      if (Number(currentPreparation?.testPreparationSequence || 0) <= previousPreparationSequence
        || Number(currentPreparation?.refsAvailable || 0) !== CANDIDATE_COUNT
        || Number(currentPreparation?.refsScanned || 0) !== CANDIDATE_COUNT) return;
      barrierEntered = true;
      enteredResolve();
      await gate;
    };
    const originalGetItem = snapshot.backend.getItem.bind(snapshot.backend);
    snapshot.backend.getItem = async key => {
      await holdTargetRead(key);
      return originalGetItem(key);
    };
    snapshot.hooks.beforeServerRequest = async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/v1/kv/get') && parsed.searchParams.get('key') === targetRef.key) {
        await holdTargetRead(targetRef.key);
      }
    };
    const initialServerManifestBefore = initialServerManifestRow?.raw ?? null;
    const initialServerRevisionBefore = initialServerManifestRow?.revision ?? null;
    const unhandledRejections = [];
    onUnhandled = reason => unhandledRejections.push(String(reason?.stack || reason));
    process.on('unhandledRejection', onUnhandled);
    const pendingOutcome = f.run().then(value => ({ value }), error => ({ error }));
    await Promise.race([entered, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${mode}: tail memory read barrier timed out`)), 30000); })]);
    clearTimeout(timeout); timeout = null;
    progress('tail_read_barrier_entered', { refsExpected: CANDIDATE_COUNT });
    const preparation = f.r.api.getRuntime().lastMemoryCandidatePreparation;
    assert.equal(Number(preparation?.refsScanned || 0), CANDIDATE_COUNT,
      `${mode}: deterministic target memory read was entered after scanning all 41 refs (${JSON.stringify(preparation)})`);
    assert.equal(f.control.calls.length, CANDIDATE_COUNT, `${mode}: successor provider is not called while the tail read is held`);
    const localManifestAtBarrier = manifestKey ? await originalGetItem(manifestKey) : null;
    const serverManifestAtBarrier = snapshot.storedRows().find(row => row.key === manifestKey);
    const barrierManifest = localManifestAtBarrier ? JSON.parse(localManifestAtBarrier)
      : serverManifestAtBarrier?.raw ? JSON.parse(serverManifestAtBarrier.raw) : snapshot.getManifest();
    assert.deepEqual(barrierManifest?.memories, manifest.memories,
      `${mode}: branch reconciliation before cancellation leaves the 41 canonical refs unchanged`);
    assert.equal(Number(barrierManifest?.frontiers?.observedTurn), successorStart + 4,
      `${mode}: successor source reconciliation observes its five current turns before the cancellation barrier`);
    assert.equal(Number(barrierManifest?.frontiers?.committedTurn), CANDIDATE_COUNT * 5,
      `${mode}: successor turns remain uncommitted when cancellation reaches the tail read`);
    const preCancelObservation = {
      initialObservedTurn: Number(manifest?.frontiers?.observedTurn || 0),
      barrierObservedTurn: Number(barrierManifest?.frontiers?.observedTurn || 0),
      initialBytesChangedBeforeCancel: localManifestAtBarrier !== initialLocalManifestBefore,
      canonicalRefsUnchanged: JSON.stringify(barrierManifest?.memories) === JSON.stringify(manifest.memories),
      serverRevisionBefore: initialServerRevisionBefore, serverRevisionAtBarrier: serverManifestAtBarrier?.revision ?? null
    };
    const localManifestBeforeCancel = localManifestAtBarrier;
    const serverManifestBeforeCancel = serverManifestAtBarrier?.raw ?? null;
    const serverRevisionBeforeCancel = serverManifestAtBarrier?.revision ?? null;
    const successorMemoryKey=`${manifestKey.replace(/manifest$/,'')}memory:${successorStart}:r1`;
    const publicationAtBarrier=await captureScopePublicationState(snapshot,manifestKey,successorMemoryKey);
    const sourceEvidencePointers=await inspectCanonicalSourceEvidence(mode,snapshot,originalGetItem,orderedRefs,publicationAtBarrier);
    const successorRowAtBarrier=publicationAtBarrier.rows[successorMemoryKey];
    assert.ok(successorRowAtBarrier&&successorRowAtBarrier.localRaw===null&&successorRowAtBarrier.serverRaw===null,
      `${mode}: no successor memory row exists at the cancellation barrier`);
    const statusBeforeCancel = await f.r.api.getCanonicalJobStatus({});
    assert.equal(statusBeforeCancel?.cancellable, true,
      `${mode}: canonical job remains cancellable at the tail read barrier (${JSON.stringify(statusBeforeCancel)})`);
    assert.ok(statusBeforeCancel?.jobId,`${mode}: active canonical job id identifies its exact durable status rows`);
    const canonicalStatusKeys=[`${publicationAtBarrier.scopePrefix}canonical-job:${statusBeforeCancel.jobId}`,
      `${publicationAtBarrier.scopePrefix}canonical-job-head:v1`];
    for(const key of canonicalStatusKeys)assert.ok(publicationAtBarrier.rows[key],`${mode}: active job receipt row is frozen at the cancellation barrier (${key})`);
    const started = performance.now();
    const cancel = await f.r.api.cancelCanonicalJob({});
    releaseRead();
    const outcome = await pendingOutcome;
    const elapsed = performance.now() - started;
    progress('cancellation_settled', { cancellationElapsedMs: elapsed,
      outcomeState: outcome.value?.state ?? null, abortError: outcome.error?.name === 'AbortError' });
    assert.equal(cancel.ok, true, `${mode}: cancellation acknowledged (${JSON.stringify(cancel)})`);
    const resolvedCancelled=outcome.value?.state==='cancelled';
    const exactAbortRejection=outcome.error?.name==='AbortError'&&outcome.error?.message==='Canonical job cancelled.';
    assert.ok(resolvedCancelled||exactAbortRejection,
      `${mode}: public run settles as cancelled or rejects only its typed AbortError (${JSON.stringify({value:outcome.value,error:outcome.error})})`);
    const finalPreparation = f.r.api.getRuntime().lastMemoryCandidatePreparation;
    assert.equal(finalPreparation?.cancelObserved, true, `${mode}: candidate preparation observes the internal cancellation signal`);
    assert.equal(f.control.calls.length, CANDIDATE_COUNT, `${mode}: cancellation prevents the successor provider call`);
    let stableNoPublicationChecks=0,previousPublicationToken='',postCancelSummary=null,firstPublicationDiff=null;
    const quiescenceStarted=performance.now();
    const jobId=String(statusBeforeCancel.jobId);
    const cancelledReceiptKeys=[`${publicationAtBarrier.scopePrefix}canonical-job:${jobId}`,
      `${publicationAtBarrier.scopePrefix}canonical-job-head:v1`];
    const jobRetentionPlan=planCanonicalJobRetention(mode,publicationAtBarrier,jobId);
    const manifestAtBarrier=storedValueForMode(mode,publicationAtBarrier.rows[manifestKey]);
    const runId=String(manifestAtBarrier?.inFlight?.runId||'');
    assert.ok(runId,`${mode}: manifest in-flight id identifies the successor run at cancellation barrier`);
    const runKey=`${publicationAtBarrier.scopePrefix}run:${runId}`;
    const workKey=`${publicationAtBarrier.scopePrefix}work:${successorStart}`;
    const cancellationBookkeepingKeys=[...cancelledReceiptKeys,manifestKey,runKey,workKey,...jobRetentionPlan.expectedPrunedKeys];
    for(const key of cancellationBookkeepingKeys)assert.ok(publicationAtBarrier.rows[key],`${mode}: exact cancellation bookkeeping key is frozen (${key})`);
    const immutableAtBarrier=immutablePublicationState(publicationAtBarrier,cancellationBookkeepingKeys);
    for(let attempt=0;attempt<1500&&stableNoPublicationChecks<10&&performance.now()-quiescenceStarted<30000;attempt+=1){
      const finalStatus=await f.r.api.getCanonicalJobStatus({});
      const publicationAfter=await captureScopePublicationState(snapshot,manifestKey,successorMemoryKey);
      const historyAfter=await f.r.api.getWorldManagerHistoryDetail({memoryId:targetRef.memoryId,revision:targetRef.revision});
      const immutableAfter=immutablePublicationState(publicationAfter,cancellationBookkeepingKeys);
      const sameImmutableState=JSON.stringify(immutableAfter)===JSON.stringify(immutableAtBarrier);
      const bookkeepingTransition=assertCancellationBookkeeping(mode,publicationAtBarrier,publicationAfter,
        {jobId,manifestKey,runKey,workKey});
      const jobRetention=assertJobRetentionTransition(mode,publicationAtBarrier,publicationAfter,jobId,jobRetentionPlan);
      const rowDiff=diffPublicationRows(publicationAtBarrier,publicationAfter);
      const historyUnchanged=JSON.stringify(historyAfter)===JSON.stringify(historyAtStart);
      const terminalCancelled=finalStatus?.state==='cancelled'&&finalStatus?.cancellable===false;
      const persistedJob=storedValueForMode(mode,publicationAfter.rows[cancelledReceiptKeys[0]]);
      const persistedHead=storedValueForMode(mode,publicationAfter.rows[cancelledReceiptKeys[1]]);
      const cancelledReceiptValid=terminalCancelled&&bookkeepingTransition.cancelledReceiptValid
        &&persistedJob?.jobId===jobId&&persistedJob?.state==='cancelled'
        &&persistedHead?.jobId===jobId&&persistedHead?.state==='cancelled';
      const providerUnchanged=f.control.calls.length===CANDIDATE_COUNT;
      const successorMemoryAbsent=publicationAfter.rows[successorMemoryKey]?.localRaw==null
        &&publicationAfter.rows[successorMemoryKey]?.serverRaw==null;
      if(rowDiff.changed.length>0&&!firstPublicationDiff){
        firstPublicationDiff={...rowDiff,changedCount:rowDiff.changed.length};
        console.log(JSON.stringify({record:'candidate_cancel_scope_first_diff',mode,jobId,
          expectedCanonicalStatusKeys:cancelledReceiptKeys,firstChangedRow:rowDiff.changed[0]||null,changedRows:rowDiff.changed,
          changedCount:rowDiff.changed.length,headChanged:rowDiff.headChanged,
          headBeforeSha256:rowDiff.headBeforeSha256,headAfterSha256:rowDiff.headAfterSha256}));
        if(process.env.PHASE_D_CANDIDATE_DIFF_ONLY==='1'){
          console.log(JSON.stringify({record:'candidate_cancel_diff_diagnostic_complete',mode,jobId,
            changedKeys:rowDiff.changed.map(row=>row.key),note:'diagnostic stops after one post-cancel read; not an acceptance run'}));
          throw new Error('D4_DIAGNOSTIC_DIFF_CAPTURED');
        }
      }
      const token=JSON.stringify({state:finalStatus?.state,updatedAt:finalStatus?.updatedAt,immutableAfter,historyAfter,
        persistedJobState:persistedJob?.state||null,persistedHeadState:persistedHead?.state||null});
      postCancelSummary={state:finalStatus?.state||null,cancellable:finalStatus?.cancellable===true,
        sameImmutableState,cancelledReceiptValid,historyUnchanged,providerUnchanged,successorMemoryAbsent,
        bookkeepingTransition,jobRetention,changedCount:rowDiff.changed.length,firstChangedKey:rowDiff.changed[0]?.key||null,changedKeys:rowDiff.changed.map(row=>row.key)};
      if(cancelledReceiptValid&&sameImmutableState&&historyUnchanged&&providerUnchanged&&successorMemoryAbsent&&token===previousPublicationToken)stableNoPublicationChecks+=1;
      else stableNoPublicationChecks=0;
      previousPublicationToken=token;
      if(stableNoPublicationChecks<10)await sleep(20);
    }
    assert.equal(stableNoPublicationChecks,10,
      `${mode}: canceled job reaches ten stable reads; only exact cancellation bookkeeping keys make allowed transitions (${JSON.stringify(postCancelSummary)})`);
    progress('stable_no_publication_checks_complete', { stableChecks: stableNoPublicationChecks,
      quiescenceElapsedMs: performance.now() - quiescenceStarted, changedKeys: postCancelSummary?.changedKeys ?? [] });
    process.removeListener('unhandledRejection', onUnhandled); onUnhandled = null;
    assert.deepEqual(unhandledRejections, [], `${mode}: cancellation produces no unhandled rejection`);
    const finalStatus=await f.r.api.getCanonicalJobStatus({});
    const publicationAfter=await captureScopePublicationState(snapshot,manifestKey,successorMemoryKey);
    const historyAfter=await f.r.api.getWorldManagerHistoryDetail({memoryId:targetRef.memoryId,revision:targetRef.revision});
    const serverManifestAfter=snapshot.storedRows().find(row=>row.key===manifestKey);
    const finalBookkeepingTransition=assertCancellationBookkeeping(mode,publicationAtBarrier,publicationAfter,
      {jobId,manifestKey,runKey,workKey});
    const finalJobRetention=assertJobRetentionTransition(mode,publicationAtBarrier,publicationAfter,jobId,jobRetentionPlan);
    assert.deepEqual(immutablePublicationState(publicationAfter,cancellationBookkeepingKeys),immutableAtBarrier,
      `${mode}: cancellation leaves every non-bookkeeping scoped row, evidence, registry, and head unchanged`);
    assert.deepEqual(historyAfter,historyAtStart,`${mode}: cancellation does not create or mutate the selected World Manager history detail`);
    assert.equal(finalStatus?.state,'cancelled',`${mode}: cancellation receipt is visible as terminal cancelled job`);
    assert.equal(sourceEvidencePointers.length,CANDIDATE_COUNT,`${mode}: all source evidence pointers remain linked after cancellation`);
    for(const pointer of sourceEvidencePointers){
      const row=publicationAfter.rows[pointer.evidenceKey];
      assert.equal(row?.localRaw??null,pointer.localRaw,`${mode}: local source-evidence bytes remain unchanged (${pointer.evidenceKey})`);
      assert.equal(row?.serverRaw??null,pointer.serverRaw,`${mode}: server source-evidence bytes remain unchanged (${pointer.evidenceKey})`);
      assert.equal(row?.serverRevision??null,pointer.serverRevision,`${mode}: source-evidence server revision remains unchanged (${pointer.evidenceKey})`);
    }
    progress('physical_publication_and_evidence_readback_complete', { refsScanned: finalPreparation.refsScanned,
      sourceEvidenceRowsObserved: sourceEvidencePointers.length, immutableScopedRowsUnchanged: true,
      historyUnchanged: true, successorMemoryAbsent: true });
    return { mode, refsAvailable: finalPreparation.refsAvailable, refsScanned: finalPreparation.refsScanned,
      factsInspected: finalPreparation.factsInspected, cancelObserved: finalPreparation.cancelObserved,
      cancellationElapsedMs: elapsed, postCancelQuiescenceElapsedMs:performance.now()-quiescenceStarted,
      postCancelStableChecks:stableNoPublicationChecks,cancelState:cancel.ok?'acknowledged':cancel.reason,
      resultState:resolvedCancelled?'cancelled':'AbortError',providerCalls:f.control.calls.length,
      targetTurnStart:targetRef.turnRange.start,tailReadBarrierEntered:barrierEntered,preCancelObservation,
      unhandledRejectionCount:unhandledRejections.length,manifestBytesChangedForCancelBookkeeping:true,
      immutableScopedRowsUnchanged:true,cancellationBookkeepingTransition:finalBookkeepingTransition,jobRetention:finalJobRetention,headUnchanged:true,
      sourceEvidenceRowsObserved:sourceEvidencePointers.length,sourceEvidenceRowsUnchanged:true,historyUnchanged:true,
      historySnapshotChars:JSON.stringify(historyAfter).length,successorMemoryAbsent:true,
      cancellationBookkeepingKeys,firstPublicationDiff,canonicalJobReceiptState:'cancelled',
      serverManifestRevisionAtBarrier:serverRevisionBeforeCancel,serverManifestRevisionAfter:serverManifestAfter?.revision??null,
      cancelledRunId:runId,scopePrefix:publicationAtBarrier.scopePrefix };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onUnhandled) process.removeListener('unhandledRejection', onUnhandled);
    releaseRead();
    if (ownsSnapshot) await snapshot.cleanup();
  }
};

(async () => {
  const combined = [];
  for (const mode of MODES) combined.push(await runScale(mode));
  const cancellations = combined.map(row => row.cancellation);
  const scale = combined.map(({ cancellation, ...row }) => row);
  console.log(JSON.stringify({ test: 'libra_phase_d_candidate_context_scale', passed: scale.length + cancellations.length,
    scale, cancellations, boundary: 'analysis candidate preparation through the real canonical job; deterministic local provider; no live model' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
