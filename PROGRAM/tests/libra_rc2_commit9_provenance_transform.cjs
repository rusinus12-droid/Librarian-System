'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  rep('state_correction_meta_schema',
`    const STATE_CORRECTION_STORE_SCHEMA = 'libra.state_correction_store.v1';
    const STATE_CORRECTION_EVENT_SCHEMA = 'libra.state_correction.v1';
`,
`    const STATE_CORRECTION_STORE_SCHEMA = 'libra.state_correction_store.v1';
    const STATE_CORRECTION_META_SCHEMA = 'libra.state_correction_meta.v1';
    const STATE_CORRECTION_COMMIT_SCHEMA = 'libra.state_correction_commit.v1';
    const STATE_CORRECTION_EVENT_SCHEMA = 'libra.state_correction.v1';
`);

  rep('state_correction_meta_key',
`      stateCorrections: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:state-corrections:v2\`,
      stateWorldlineMeta: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:state-worldline-meta:v1\`,
`,
`      stateCorrections: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:state-corrections:v2\`,
      stateCorrectionMeta: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:state-correction-meta:v1\`,
      stateCorrectionCommit: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:state-correction-commit:v1\`,
      stateWorldlineMeta: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:state-worldline-meta:v1\`,
`);

  rep('continuity_override_scope_serialization_start',
`    const saveContinuityOverride = async ({ jobId = '', patch = {}, baseFingerprint = '' } = {}) => {
      const context = await resolveContext(); const job = await loadCanonicalJob(context.scope, jobId);
`,
`    const saveContinuityOverride = async ({ jobId = '', patch = {}, baseFingerprint = '' } = {}) => {
      const initialContext=await resolveContext(); const expectedScopeKey=string(initialContext?.scope?.scopeKey||'');
      return await enqueue(expectedScopeKey,async()=>{
      assertPortableMemoryIdle();
      const context = await resolveContext();
      if (string(context?.scope?.scopeKey||'')!==expectedScopeKey) throw stateCorrectionFailure('STATE_CORRECTION_SCOPE_CHANGED');
      const job = await loadCanonicalJob(context.scope, jobId);
`);

  rep('continuity_override_scope_serialization_end',
`      } catch (error) { warn('LIBRA state correction journal mirror failed', error); }
      return clone(override);
    };
`,
`      } catch (error) { warn('LIBRA state correction journal mirror failed', error); }
      return clone(override);
      });
    };
`);

  rep('bounded_state_correction_meta_store',
`    const saveStateCorrectionJournal = async (scope, storeValue) => {
      const store = { ...stateCorrectionDefaultStore(scope), ...clone(storeValue), schema: STATE_CORRECTION_STORE_SCHEMA, scopeKey: string(scope.scopeKey), updatedAt: nowIso() };
      store.revision = Math.max(0, Number(store.revision || 0)) + 1;
      store.records = asArray(store.records).map(row => ({ ...clone(row), schema: STATE_CORRECTION_EVENT_SCHEMA, scopeKey: string(scope.scopeKey), status: normalizeStateCorrectionStatus(row?.status) }));
      store.migratedLegacyOverrideIds = Array.from(new Set(asArray(store.migratedLegacyOverrideIds).map(string).filter(Boolean)));
      const storageKey=key.stateCorrections(scope); const previous=await storage.getJson(storageKey,null);
      try {
        await storage.setJson(storageKey, store);
        const readback = await assertStateStoredValue(storageKey, store, 'STATE_CORRECTION_JOURNAL_READBACK_FAILED');
        if (readback?.schema !== STATE_CORRECTION_STORE_SCHEMA
          || string(readback.scopeKey || '') !== string(scope.scopeKey)
          || Number(readback.revision || 0) !== Number(store.revision || 0)) throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_READBACK_FAILED');
        return readback;
      } catch(error) {
        try { await restoreStateStoredValue(storageKey,previous,'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'); }
        catch(rollbackError) { throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(rollbackError?.message||rollbackError,300)); }
        throw error;
      }
    };
`,
`    const touchWorldManagerRuntimeMeta = () => {
      state.worldManagerRuntimeMetaGeneration = Math.max(0, Number(state.worldManagerRuntimeMetaGeneration || 0)) + 1;
      return state.worldManagerRuntimeMetaGeneration;
    };
    const stateCorrectionCountSummary = recordsValue => {
      const rows=asArray(recordsValue);
      const counts=Object.fromEntries(STATE_CORRECTION_STATUSES.map(statusValue=>[statusValue,rows.filter(row=>row?.status===statusValue).length]));
      counts.total=rows.length; counts.available=true;
      return counts;
    };
    const stateCorrectionMetaFromJournal = (scope,storeValue) => {
      if (!storeValue) return null;
      return {
        schema:STATE_CORRECTION_META_SCHEMA,scopeKey:string(scope?.scopeKey||''),journalRevision:Number(storeValue.revision||0),
        journalDigest:stateStoredValueDigest({schema:storeValue.schema,scopeKey:storeValue.scopeKey,revision:storeValue.revision,records:asArray(storeValue.records),migratedLegacyOverrideIds:asArray(storeValue.migratedLegacyOverrideIds)}),
        correctionCounts:stateCorrectionCountSummary(storeValue.records),updatedAt:string(storeValue.updatedAt||'')
      };
    };
    const loadStateCorrectionMeta = async (scope,{strict=false}={}) => {
      const loaded=await storage.getJson(key.stateCorrectionMeta(scope),null);
      if (loaded==null) return null;
      const counts=asObject(loaded.correctionCounts);
      const valid=loaded.schema===STATE_CORRECTION_META_SCHEMA
        && string(loaded.scopeKey||'')===string(scope?.scopeKey||'')
        && Number.isInteger(Number(loaded.journalRevision))&&Number(loaded.journalRevision)>=0
        && /^[a-f0-9]{8}:\\d+$/i.test(string(loaded.journalDigest||''))
        && STATE_CORRECTION_STATUSES.every(statusValue=>Number.isInteger(Number(counts[statusValue]))&&Number(counts[statusValue])>=0)
        && Number.isInteger(Number(counts.total))&&Number(counts.total)>=0
        && Number(counts.total)===STATE_CORRECTION_STATUSES.reduce((sum,statusValue)=>sum+Number(counts[statusValue]||0),0);
      if (!valid) { if (strict) throw stateCorrectionFailure('STATE_CORRECTION_META_INVALID'); return null; }
      return clone(loaded);
    };
    const stateCorrectionCommitFromMeta = (scope,meta,transactionId,status='committed') => ({
      schema:STATE_CORRECTION_COMMIT_SCHEMA,scopeKey:string(scope?.scopeKey||''),status:string(status||''),transactionId:string(transactionId||''),
      targetJournalRevision:Number(meta?.journalRevision||0),targetJournalDigest:string(meta?.journalDigest||''),
      updatedAt:nowIso(),...(status==='committed'?{committedAt:nowIso()}:{})
    });
    const loadStateCorrectionCommit = async (scope,{strict=false}={}) => {
      const loaded=await storage.getJson(key.stateCorrectionCommit(scope),null);
      if (loaded==null) return null;
      const valid=loaded.schema===STATE_CORRECTION_COMMIT_SCHEMA
        && string(loaded.scopeKey||'')===string(scope?.scopeKey||'')
        && ['pending','committed'].includes(string(loaded.status||''))
        && !!string(loaded.transactionId||'')
        && Number.isInteger(Number(loaded.targetJournalRevision))&&Number(loaded.targetJournalRevision)>=0
        && /^[a-f0-9]{8}:\\d+$/i.test(string(loaded.targetJournalDigest||''));
      if (!valid) { if (strict) throw stateCorrectionFailure('STATE_CORRECTION_COMMIT_INVALID'); return null; }
      return clone(loaded);
    };
    const stateCorrectionMetaCommitCoherent = (meta,commit) => !!meta&&!!commit
      && commit.status==='committed'
      && Number(commit.targetJournalRevision)===Number(meta.journalRevision)
      && string(commit.targetJournalDigest||'')===string(meta.journalDigest||'');
    const saveStateCorrectionJournal = async (scope, storeValue) => {
      const store = { ...stateCorrectionDefaultStore(scope), ...clone(storeValue), schema: STATE_CORRECTION_STORE_SCHEMA, scopeKey: string(scope.scopeKey), updatedAt: nowIso() };
      store.revision = Math.max(0, Number(store.revision || 0)) + 1;
      store.records = asArray(store.records).map(row => ({ ...clone(row), schema: STATE_CORRECTION_EVENT_SCHEMA, scopeKey: string(scope.scopeKey), status: normalizeStateCorrectionStatus(row?.status) }));
      store.migratedLegacyOverrideIds = Array.from(new Set(asArray(store.migratedLegacyOverrideIds).map(string).filter(Boolean)));
      const storageKey=key.stateCorrections(scope); const metaKey=key.stateCorrectionMeta(scope); const commitKey=key.stateCorrectionCommit(scope);
      const previous=await storage.getJson(storageKey,null); const previousMeta=await storage.getJson(metaKey,null); const previousCommit=await storage.getJson(commitKey,null);
      const correctionMeta=stateCorrectionMetaFromJournal(scope,store);
      const transactionId=id('state_correction_commit');
      const pendingCommit=stateCorrectionCommitFromMeta(scope,correctionMeta,transactionId,'pending');
      const committedCommit=stateCorrectionCommitFromMeta(scope,correctionMeta,transactionId,'committed');
      try {
        await storage.setJson(commitKey,pendingCommit);
        const pendingReadback=await assertStateStoredValue(commitKey,pendingCommit,'STATE_CORRECTION_COMMIT_PENDING_READBACK_FAILED');
        if (pendingReadback?.schema!==STATE_CORRECTION_COMMIT_SCHEMA || pendingReadback?.status!=='pending' || string(pendingReadback.transactionId||'')!==transactionId) throw stateCorrectionFailure('STATE_CORRECTION_COMMIT_PENDING_READBACK_FAILED');
        touchWorldManagerRuntimeMeta();
        await storage.setJson(storageKey, store);
        const readback = await assertStateStoredValue(storageKey, store, 'STATE_CORRECTION_JOURNAL_READBACK_FAILED');
        if (readback?.schema !== STATE_CORRECTION_STORE_SCHEMA
          || string(readback.scopeKey || '') !== string(scope.scopeKey)
          || Number(readback.revision || 0) !== Number(store.revision || 0)) throw stateCorrectionFailure('STATE_CORRECTION_JOURNAL_READBACK_FAILED');
        await storage.setJson(metaKey,correctionMeta);
        const metaReadback=await assertStateStoredValue(metaKey,correctionMeta,'STATE_CORRECTION_META_READBACK_FAILED');
        if (metaReadback?.schema!==STATE_CORRECTION_META_SCHEMA || Number(metaReadback.journalRevision||0)!==Number(readback.revision||0) || string(metaReadback.journalDigest||'')!==string(correctionMeta.journalDigest||'')) throw stateCorrectionFailure('STATE_CORRECTION_META_READBACK_FAILED');
        await storage.setJson(commitKey,committedCommit);
        const commitReadback=await assertStateStoredValue(commitKey,committedCommit,'STATE_CORRECTION_COMMIT_READBACK_FAILED');
        if (!stateCorrectionMetaCommitCoherent(metaReadback,commitReadback) || string(commitReadback.transactionId||'')!==transactionId) throw stateCorrectionFailure('STATE_CORRECTION_COMMIT_READBACK_FAILED');
        touchWorldManagerRuntimeMeta();
        return readback;
      } catch(error) {
        const rollbackFailures=[];
        try { await storage.setJson(commitKey,pendingCommit); await assertStateStoredValue(commitKey,pendingCommit,'STATE_CORRECTION_COMMIT_INVALIDATION_FAILED'); } catch(rollbackError) { rollbackFailures.push(rollbackError); }
        try { await restoreStateStoredValue(storageKey,previous,'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'); } catch(rollbackError) { rollbackFailures.push(rollbackError); }
        try { await restoreStateStoredValue(metaKey,previousMeta,'STATE_CORRECTION_META_ROLLBACK_FAILED'); } catch(rollbackError) { rollbackFailures.push(rollbackError); }
        if (!rollbackFailures.length) {
          try { await restoreStateStoredValue(commitKey,previousCommit,'STATE_CORRECTION_COMMIT_ROLLBACK_FAILED'); }
          catch(rollbackError) { rollbackFailures.push(rollbackError); }
        }
        touchWorldManagerRuntimeMeta();
        if (rollbackFailures.length) throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(rollbackFailures.map(item=>item?.message||item).join(' | '),300));
        throw error;
      }
    };
`);

  rep('durable_replay_error_resolution',
`    const recordStateReplayError = async (scope,error,contextValue={}) => {
      const keyName=key.stateReplayErrors(scope); const existing=await storage.getJson(keyName,{schema:STATE_REPLAY_ERROR_SCHEMA,scopeKey:string(scope.scopeKey),records:[]}); const rec={at:nowIso(),message:compact(error?.message||error,700),code:compact(error?.code||'STATE_REPLAY_FAILED',120),context:clone(contextValue)}; existing.schema=STATE_REPLAY_ERROR_SCHEMA; existing.scopeKey=string(scope.scopeKey); existing.records=[...asArray(existing.records),rec].slice(-64); existing.updatedAt=nowIso(); await storage.setJson(keyName,existing); return rec;
    };
`,
`    const recordStateReplayError = async (scope,error,contextValue={}) => {
      const keyName=key.stateReplayErrors(scope); const existing=await storage.getJson(keyName,{schema:STATE_REPLAY_ERROR_SCHEMA,scopeKey:string(scope.scopeKey),records:[]});
      const rec={errorId:id('state_replay_error'),at:nowIso(),message:compact(error?.message||error,700),code:compact(error?.code||'STATE_REPLAY_FAILED',120),context:clone(contextValue),resolvedAt:null,resolution:null};
      existing.schema=STATE_REPLAY_ERROR_SCHEMA; existing.scopeKey=string(scope.scopeKey); existing.records=[...asArray(existing.records),rec].slice(-64); existing.updatedAt=nowIso();
      await storage.setJson(keyName,existing); await assertStateStoredValue(keyName,existing,'STATE_REPLAY_ERROR_READBACK_FAILED'); touchWorldManagerRuntimeMeta(); return rec;
    };
    const resolveStateReplayErrors = async (scope,{worldlineId='',replayFingerprint='',throughTurn=0,at=''}={}) => {
      const keyName=key.stateReplayErrors(scope); const existing=await storage.getJson(keyName,null);
      if (existing==null) return {resolved:0};
      if (existing.schema!==STATE_REPLAY_ERROR_SCHEMA || string(existing.scopeKey||'')!==string(scope.scopeKey)) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_ERROR_STORE_INVALID');
      const resolvedAt=string(at||nowIso()); let resolved=0;
      existing.records=asArray(existing.records).map(row=>{
        if (row?.resolvedAt) return row;
        const errorContext=asObject(row?.context); const errorWorldline=string(errorContext.worldlineId||'');
        const rollbackIncomplete=errorContext.rollbackIncomplete===true || /ROLLBACK_INCOMPLETE/.test(string(row?.code||''));
        const resolvedAtMs=Date.parse(resolvedAt); const errorAtMs=Date.parse(string(row?.at||''));
        if (rollbackIncomplete || !errorWorldline || errorWorldline!==string(worldlineId||'') || !Number.isFinite(resolvedAtMs) || !Number.isFinite(errorAtMs) || resolvedAtMs<=errorAtMs) return row;
        resolved+=1;
        return {...clone(row),resolvedAt,resolution:{worldlineId:string(worldlineId||''),replayFingerprint:string(replayFingerprint||''),throughTurn:Number(throughTurn||0)}};
      });
      if (!resolved) return {resolved:0};
      existing.updatedAt=resolvedAt; await storage.setJson(keyName,existing); await assertStateStoredValue(keyName,existing,'STATE_REPLAY_ERROR_RESOLUTION_READBACK_FAILED'); touchWorldManagerRuntimeMeta();
      return {resolved};
    };
`);

  rep('replay_error_worldline_binding',
`      let attemptedHead=undefined; let attemptedCache=undefined;
      try {
        const meta=await loadStateWorldlineMeta(liveContext.scope,{strict:true}); const activeId=string(worldlineId||meta.activeWorldlineId||'main'); const line=asObject(meta.worldlines?.[activeId]);
`,
`      let attemptedHead=undefined; let attemptedCache=undefined; let attemptedWorldlineId=string(worldlineId||''); let attemptedReplayFingerprint='';
      try {
        const meta=await loadStateWorldlineMeta(liveContext.scope,{strict:true}); const activeId=string(worldlineId||meta.activeWorldlineId||'main'); const line=asObject(meta.worldlines?.[activeId]);
        attemptedWorldlineId=activeId;
`);

  rep('replay_error_fingerprint_binding',
`        const replayFingerprint=stateReplayFingerprint({manifest:liveManifest,store,worldlineId:activeId,cutoffTurn:Number.isFinite(effectiveCutoff)?effectiveCutoff:null});
`,
`        const replayFingerprint=stateReplayFingerprint({manifest:liveManifest,store,worldlineId:activeId,cutoffTurn:Number.isFinite(effectiveCutoff)?effectiveCutoff:null});
        attemptedReplayFingerprint=replayFingerprint;
`);

  rep('successful_replay_explicit_error_resolution',
`          const afterWriteBoundary=await loadStateReplayBoundaryFingerprint({context:liveContext,pairs:livePairs,worldlineId:activeId});
          if (string(afterWriteBoundary)!==string(requiredBoundaryFingerprint||boundaryFingerprint)) throw stateCorrectionFailure('STATE_REPLAY_BOUNDARY_CHANGED');
          state.lastContinuityState=clone(durableHead);
`,
`          const afterWriteBoundary=await loadStateReplayBoundaryFingerprint({context:liveContext,pairs:livePairs,worldlineId:activeId});
          if (string(afterWriteBoundary)!==string(requiredBoundaryFingerprint||boundaryFingerprint)) throw stateCorrectionFailure('STATE_REPLAY_BOUNDARY_CHANGED');
          touchWorldManagerRuntimeMeta();
          try { await resolveStateReplayErrors(liveContext.scope,{worldlineId:activeId,replayFingerprint,throughTurn:Number(durableHead.throughTurn||0),at:cache.updatedAt}); }
          catch (resolutionError) { warn('LIBRA replay error resolution readback failed',resolutionError); }
          state.lastContinuityState=clone(durableHead);
`);

  rep('replay_error_context_active_worldline',
`        await recordStateReplayError(liveContext.scope,surfaced,{reason,worldlineId,cutoffTurn,rollbackIncomplete:!!rollbackError}).catch(()=>{});
`,
`        await recordStateReplayError(liveContext.scope,surfaced,{reason,worldlineId:attemptedWorldlineId,replayFingerprint:attemptedReplayFingerprint,cutoffTurn,rollbackIncomplete:!!rollbackError}).catch(()=>{});
`);

  rep('replay_expected_scope_preflight',
`    const rebuildCurrentStateForWorldline = async (options={}) => {
      const initial=options.context||await resolveContext(); const expectedScopeKey=string(initial?.scope?.scopeKey||'');
      return await enqueue(expectedScopeKey,async()=>{
`,
`    const rebuildCurrentStateForWorldline = async (options={}) => {
      const initial=options.context||await resolveContext(); const resolvedScopeKey=string(initial?.scope?.scopeKey||''); const expectedScopeKey=string(options.expectedScopeKey||resolvedScopeKey);
      if (!expectedScopeKey || (resolvedScopeKey&&resolvedScopeKey!==expectedScopeKey)) throw stateCorrectionFailure('STATE_REPLAY_SCOPE_CHANGED');
      return await enqueue(expectedScopeKey,async()=>{
`);

  rep('replay_baseline_correction_meta',
`    const restoreStateReplayBaseline = async ({scope,head,journal,cache,meta=null,includeMeta=false,expectedHead=undefined,expectedCache=undefined,guardDerived=false,lastContinuityState=undefined,snapshotContinuityState=undefined}) => {
      const failures=[];
      const entries=[
        {storageKey:key.stateCorrections(scope),previous:journal,code:'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'},
        {storageKey:key.continuityState(scope),previous:head,expected:expectedHead,derived:true,code:'STATE_REPLAY_HEAD_ROLLBACK_FAILED'},
`,
`    const restoreStateReplayBaseline = async ({scope,head,journal,correctionMeta=undefined,correctionCommit=undefined,cache,meta=null,includeMeta=false,expectedHead=undefined,expectedCache=undefined,guardDerived=false,lastContinuityState=undefined,snapshotContinuityState=undefined}) => {
      const failures=[];
      const entries=[
        {storageKey:key.stateCorrections(scope),previous:journal,code:'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'},
        {storageKey:key.stateCorrectionMeta(scope),previous:correctionMeta===undefined?stateCorrectionMetaFromJournal(scope,journal):correctionMeta,code:'STATE_CORRECTION_META_ROLLBACK_FAILED'},
        {storageKey:key.stateCorrectionCommit(scope),previous:correctionCommit===undefined?null:correctionCommit,code:'STATE_CORRECTION_COMMIT_ROLLBACK_FAILED'},
        {storageKey:key.continuityState(scope),previous:head,expected:expectedHead,derived:true,code:'STATE_REPLAY_HEAD_ROLLBACK_FAILED'},
`);

  rep('rebuild_baseline_correction_meta_capture',
`      const previousJournal=await storage.getJson(key.stateCorrections(liveContext.scope),null);
      const previousCache=await storage.getJson(key.stateReplayCache(liveContext.scope),null);
`,
`      const previousJournal=await storage.getJson(key.stateCorrections(liveContext.scope),null);
      const previousCorrectionMeta=await storage.getJson(key.stateCorrectionMeta(liveContext.scope),null);
      const previousCorrectionCommit=await storage.getJson(key.stateCorrectionCommit(liveContext.scope),null);
      const previousCache=await storage.getJson(key.stateReplayCache(liveContext.scope),null);
`);

  rep('rebuild_rollback_correction_meta_restore',
`          try { await restoreStateReplayBaseline({scope:liveContext.scope,head:previousHead,journal:previousJournal,cache:previousCache,expectedHead:attemptedHead,expectedCache:attemptedCache,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH'].includes(string(error?.code||'')),lastContinuityState:previousLastContinuityState,snapshotContinuityState:previousSnapshotContinuityState}); }
`,
`          try { await restoreStateReplayBaseline({scope:liveContext.scope,head:previousHead,journal:previousJournal,correctionMeta:previousCorrectionMeta,correctionCommit:previousCorrectionCommit,cache:previousCache,expectedHead:attemptedHead,expectedCache:attemptedCache,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH'].includes(string(error?.code||'')),lastContinuityState:previousLastContinuityState,snapshotContinuityState:previousSnapshotContinuityState}); }
`);

  rep('correction_baselines_capture_meta',
`        const baseline={journal:await storage.getJson(key.stateCorrections(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        const preflight=await stateCorrectionPreflight({context,manifest,patch,target,anchorTurn,basisFingerprint,worldlineId,supersedes});
`,
`        const baseline={journal:await storage.getJson(key.stateCorrections(context.scope),null),correctionMeta:await storage.getJson(key.stateCorrectionMeta(context.scope),null),correctionCommit:await storage.getJson(key.stateCorrectionCommit(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        const preflight=await stateCorrectionPreflight({context,manifest,patch,target,anchorTurn,basisFingerprint,worldlineId,supersedes});
`);

  rep('correction_status_baseline_capture_meta',
`        const baseline={journal:await storage.getJson(key.stateCorrections(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        const rec=asArray(store.records).find(row=>string(row.correctionId||'')===string(correctionId||'')); if(!rec) throw stateCorrectionFailure('STATE_CORRECTION_NOT_FOUND','state_correction_not_found');
`,
`        const baseline={journal:await storage.getJson(key.stateCorrections(context.scope),null),correctionMeta:await storage.getJson(key.stateCorrectionMeta(context.scope),null),correctionCommit:await storage.getJson(key.stateCorrectionCommit(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
        const rec=asArray(store.records).find(row=>string(row.correctionId||'')===string(correctionId||'')); if(!rec) throw stateCorrectionFailure('STATE_CORRECTION_NOT_FOUND','state_correction_not_found');
`);

  rep('worldline_baseline_capture_correction_meta',
`        const baseline={meta:await storage.getJson(key.stateWorldlineMeta(context.scope),null),journal:await storage.getJson(key.stateCorrections(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
`,
`        const baseline={meta:await storage.getJson(key.stateWorldlineMeta(context.scope),null),journal:await storage.getJson(key.stateCorrections(context.scope),null),correctionMeta:await storage.getJson(key.stateCorrectionMeta(context.scope),null),correctionCommit:await storage.getJson(key.stateCorrectionCommit(context.scope),null),head:await storage.getJson(key.continuityState(context.scope),null),cache:await storage.getJson(key.stateReplayCache(context.scope),null),lastContinuityState:clone(state.lastContinuityState),snapshotContinuityState:sameSnapshotScope(state.snapshot?.scope,context.scope)?clone(state.snapshot?.continuityState):undefined};
`);

  rep('correction_rollback_restore_meta',
`      try { await restoreStateReplayBaseline({scope,head:baseline.head,journal:baseline.journal,cache:baseline.cache,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH'].includes(string(error?.code||'')),lastContinuityState:baseline.lastContinuityState,snapshotContinuityState:baseline.snapshotContinuityState}); }
`,
`      try { await restoreStateReplayBaseline({scope,head:baseline.head,journal:baseline.journal,correctionMeta:baseline.correctionMeta,correctionCommit:baseline.correctionCommit,cache:baseline.cache,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH'].includes(string(error?.code||'')),lastContinuityState:baseline.lastContinuityState,snapshotContinuityState:baseline.snapshotContinuityState}); }
`);

  rep('worldline_rollback_restore_meta',
`          try { await restoreStateReplayBaseline({scope:context.scope,head:baseline.head,journal:baseline.journal,cache:baseline.cache,meta:baseline.meta,includeMeta:true,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH','STATE_CORRECTION_ROLLBACK_INCOMPLETE'].includes(string(error?.code||'')),lastContinuityState:baseline.lastContinuityState,snapshotContinuityState:baseline.snapshotContinuityState}); }
`,
`          try { await restoreStateReplayBaseline({scope:context.scope,head:baseline.head,journal:baseline.journal,correctionMeta:baseline.correctionMeta,correctionCommit:baseline.correctionCommit,cache:baseline.cache,meta:baseline.meta,includeMeta:true,guardDerived:['STATE_REPLAY_BOUNDARY_CHANGED','STATE_REPLAY_JOURNAL_CHANGED','STATE_REPLAY_JOURNAL_FINGERPRINT_MISMATCH','STATE_CORRECTION_ROLLBACK_INCOMPLETE'].includes(string(error?.code||'')),lastContinuityState:baseline.lastContinuityState,snapshotContinuityState:baseline.snapshotContinuityState}); }
`);

  rep('correction_incomplete_rollback_restore_meta',
`        try { await restoreStateStoredValue(key.stateCorrections(scope),baseline.journal,'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'); }
        catch(_) {}
`,
`        try { await restoreStateStoredValue(key.stateCorrections(scope),baseline.journal,'STATE_CORRECTION_JOURNAL_ROLLBACK_FAILED'); }
        catch(_) {}
        try { await restoreStateStoredValue(key.stateCorrectionMeta(scope),baseline.correctionMeta,'STATE_CORRECTION_META_ROLLBACK_FAILED'); }
        catch(_) {}
        try { await restoreStateStoredValue(key.stateCorrectionCommit(scope),baseline.correctionCommit,'STATE_CORRECTION_COMMIT_ROLLBACK_FAILED'); }
        catch(_) {}
`);

  rep('correction_rollback_error_worldline_binding',
`        await recordStateReplayError(scope,error,{operation,correctionId,rollbackIncomplete:true}).catch(()=>{});
`,
`        await recordStateReplayError(scope,error,{operation,correctionId,worldlineId:string(baseline?.head?.worldlineId||''),rollbackIncomplete:true}).catch(()=>{});
`);

  rep('correction_transaction_error_worldline_binding',
`      await recordStateReplayError(scope,surfaced,{operation,correctionId,rollbackIncomplete:!!rollbackError}).catch(()=>{});
`,
`      await recordStateReplayError(scope,surfaced,{operation,correctionId,worldlineId:string(baseline?.head?.worldlineId||''),rollbackIncomplete:!!rollbackError}).catch(()=>{});
`);

  rep('worldline_meta_runtime_invalidation',
`        if (readback?.schema!==STATE_WORLDLINE_META_SCHEMA || string(readback.scopeKey||'')!==string(scope.scopeKey) || Number(readback.revision||0)!==Number(meta.revision||0)) throw stateCorrectionFailure('STATE_WORLDLINE_META_READBACK_FAILED');
        return readback;
`,
`        if (readback?.schema!==STATE_WORLDLINE_META_SCHEMA || string(readback.scopeKey||'')!==string(scope.scopeKey) || Number(readback.revision||0)!==Number(meta.revision||0)) throw stateCorrectionFailure('STATE_WORLDLINE_META_READBACK_FAILED');
        touchWorldManagerRuntimeMeta();
        return readback;
`);

  rep('worldline_meta_incomplete_rollback_invalidation',
`        try { await restoreStateStoredValue(storageKey,previous,'STATE_WORLDLINE_META_ROLLBACK_FAILED'); }
        catch(rollbackError) { throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(rollbackError?.message||rollbackError,300)); }
`,
`        try { await restoreStateStoredValue(storageKey,previous,'STATE_WORLDLINE_META_ROLLBACK_FAILED'); }
        catch(rollbackError) { touchWorldManagerRuntimeMeta(); throw stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE',compact(rollbackError?.message||rollbackError,300)); }
`);

  rep('replay_baseline_runtime_invalidation',
`      state.lastContinuityState=clone(lastContinuityState===undefined?head:lastContinuityState);
      if (sameSnapshotScope(state.snapshot?.scope,scope)) state.snapshot.continuityState=clone(snapshotContinuityState===undefined?head:snapshotContinuityState);
      return true;
`,
`      state.lastContinuityState=clone(lastContinuityState===undefined?head:lastContinuityState);
      if (sameSnapshotScope(state.snapshot?.scope,scope)) state.snapshot.continuityState=clone(snapshotContinuityState===undefined?head:snapshotContinuityState);
      touchWorldManagerRuntimeMeta();
      return true;
`);

  rep('replay_incomplete_rollback_runtime_invalidation',
`      if (failures.length) {
        const error=stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE','state_correction_rollback_incomplete');
        error.failures=failures;
        throw error;
      }
`,
`      if (failures.length) {
        const error=stateCorrectionFailure('STATE_CORRECTION_ROLLBACK_INCOMPLETE','state_correction_rollback_incomplete');
        error.failures=failures;
        touchWorldManagerRuntimeMeta();
        throw error;
      }
`);

  rep('continuity_domain_status_source_retention',
`      return {
        status: compact(source.status || fallbackStatus, 80) || fallbackStatus,
        sessionEpoch: Number.isFinite(Number(rawSessionEpoch)) ? Number(rawSessionEpoch) : 0,
        throughTurn: Math.max(0, Number(source.throughTurn ?? source.through_turn ?? evidence?.turnRange?.end ?? 0) || 0),
        reason: compact(source.reason || fallbackReason, 300),
        evidence,
        attemptedEvidence
      };
`,
`      return {
        status: compact(source.status || fallbackStatus, 80) || fallbackStatus,
        source: typeof source.source === 'string' ? compact(source.source, 80) : '',
        sessionEpoch: Number.isFinite(Number(rawSessionEpoch)) ? Number(rawSessionEpoch) : 0,
        throughTurn: Math.max(0, Number(source.throughTurn ?? source.through_turn ?? evidence?.turnRange?.end ?? 0) || 0),
        reason: compact(source.reason || fallbackReason, 300),
        evidence,
        attemptedEvidence
      };
`);

  rep('continuity_domain_status_source_advance',
`    const advanceContinuityDomainStatus = (currentValue, evidenceValue, statusValue = 'ready', reasonValue = '') => {
      const current = normalizeContinuityDomainStatus(currentValue);
      const evidence = normalizeContinuityEvidence(evidenceValue);
      const currentReview = continuityDomainStatusReviewEvidence(current);
      if (currentReview && evidence && compareContinuityEvidence(currentReview, evidence) > 0) return current;
      return {
        status: statusValue,
        sessionEpoch: Number(evidence?.sessionEpoch || 0),
        throughTurn: Number(evidence?.turnRange?.end || 0),
        reason: compact(reasonValue || '', 300),
        evidence: statusValue === 'ready' ? evidence : normalizeContinuityEvidence(current.evidence),
        attemptedEvidence: statusValue === 'ready' ? null : evidence
      };
    };
    const failContinuityDomainStatus = (currentValue, evidenceValue, reasonValue, head, domain) => {
      const current = normalizeContinuityDomainStatus(currentValue);
      const evidence = normalizeContinuityEvidence(evidenceValue);
      const currentReview = continuityDomainStatusReviewEvidence(current);
      if (currentReview && evidence && compareContinuityEvidence(currentReview, evidence) > 0) return current;
      const lastKnown = normalizeContinuityEvidence(current.evidence) || continuityStateDomainNewestEvidence(head, domain);
      return {
        status: 'not_updated',
        sessionEpoch: Number(lastKnown?.sessionEpoch || evidence?.sessionEpoch || 0),
        throughTurn: Number(lastKnown?.turnRange?.end || 0),
        reason: compact(reasonValue || 'state_patch_unavailable', 300),
        evidence: lastKnown,
        attemptedEvidence: evidence
      };
    };
`,
`    const advanceContinuityDomainStatus = (currentValue, evidenceValue, statusValue = 'ready', reasonValue = '', sourceValue = '') => {
      const current = normalizeContinuityDomainStatus(currentValue);
      const evidence = normalizeContinuityEvidence(evidenceValue);
      const currentReview = continuityDomainStatusReviewEvidence(current);
      if (currentReview && evidence && compareContinuityEvidence(currentReview, evidence) > 0) return current;
      return {
        status: statusValue,
        source: compact(sourceValue || current.source || '', 80),
        sessionEpoch: Number(evidence?.sessionEpoch || 0),
        throughTurn: Number(evidence?.turnRange?.end || 0),
        reason: compact(reasonValue || '', 300),
        evidence: statusValue === 'ready' ? evidence : normalizeContinuityEvidence(current.evidence),
        attemptedEvidence: statusValue === 'ready' ? null : evidence
      };
    };
    const failContinuityDomainStatus = (currentValue, evidenceValue, reasonValue, head, domain) => {
      const current = normalizeContinuityDomainStatus(currentValue);
      const evidence = normalizeContinuityEvidence(evidenceValue);
      const currentReview = continuityDomainStatusReviewEvidence(current);
      if (currentReview && evidence && compareContinuityEvidence(currentReview, evidence) > 0) return current;
      const lastKnown = normalizeContinuityEvidence(current.evidence) || continuityStateDomainNewestEvidence(head, domain);
      return {
        status: 'not_updated',
        source: compact(current.source || '', 80),
        sessionEpoch: Number(lastKnown?.sessionEpoch || evidence?.sessionEpoch || 0),
        throughTurn: Number(lastKnown?.turnRange?.end || 0),
        reason: compact(reasonValue || 'state_patch_unavailable', 300),
        evidence: lastKnown,
        attemptedEvidence: evidence
      };
    };
`);

  rep('continuity_narrative_status_fallback_source',
`      const narrativeStatusFallback = narrative.updatedThroughTurn > 0 ? { status: 'ready', throughTurn: narrative.updatedThroughTurn, reason: '', evidence: headSource } : { status: 'empty', throughTurn: 0, reason: 'no_narrative_delta', evidence: null };
`,
`      const narrativeStatusFallback = narrative.updatedThroughTurn > 0 ? { status: 'ready', source: narrative.source || '', throughTurn: narrative.updatedThroughTurn, reason: '', evidence: headSource } : { status: 'empty', source: '', throughTurn: 0, reason: 'no_narrative_delta', evidence: null };
`);

  rep('continuity_domain_status_rewind_source',
`        return {
          status: latest ? 'partial' : 'empty',
          sessionEpoch: Number(latest?.sessionEpoch || 0),
          throughTurn: Number(latest?.turnRange?.end || 0),
          reason: 'canonical_basis_rewound',
          evidence: latest,
          attemptedEvidence: attemptedEvidenceValid ? normalizeContinuityEvidence(current.attemptedEvidence) : null
        };
`,
`        return {
          status: latest ? 'partial' : 'empty',
          source: compact(current.source || '', 80),
          sessionEpoch: Number(latest?.sessionEpoch || 0),
          throughTurn: Number(latest?.turnRange?.end || 0),
          reason: 'canonical_basis_rewound',
          evidence: latest,
          attemptedEvidence: attemptedEvidenceValid ? normalizeContinuityEvidence(current.attemptedEvidence) : null
        };
`);

  rep('continuity_character_source_advance',
`        head.domainStatus.characters = advanceContinuityDomainStatus(head.domainStatus.characters, evidence, 'ready', '');
        head.domainStatus.relationships = advanceContinuityDomainStatus(head.domainStatus.relationships, evidence, 'ready', '');
`,
`        const characterSource = compact(derivedDelta?.domains?.character_relationship?.source || characterPatch?.stage || 'character_ito', 80);
        head.domainStatus.characters = advanceContinuityDomainStatus(head.domainStatus.characters, evidence, 'ready', '', characterSource);
        head.domainStatus.relationships = advanceContinuityDomainStatus(head.domainStatus.relationships, evidence, 'ready', '', characterSource);
`);

  rep('continuity_world_source_advance',
`        head.domainStatus.world = advanceContinuityDomainStatus(head.domainStatus.world, evidence, 'ready', '');
`,
`        const worldSource = compact(derivedDelta?.domains?.world?.source || worldPatch?.stage || 'world_ito', 80);
        head.domainStatus.world = advanceContinuityDomainStatus(head.domainStatus.world, evidence, 'ready', '', worldSource);
`);

  rep('continuity_narrative_source_advance',
`          head.domainStatus.narrative = advanceContinuityDomainStatus(head.domainStatus.narrative, evidence, derivedDelta?.domains?.narrative?.status === 'fallback' ? 'ready' : 'ready', derivedDelta?.domains?.narrative?.status === 'fallback' ? 'ariadne_seed_fallback' : '');
`,
`          head.domainStatus.narrative = advanceContinuityDomainStatus(head.domainStatus.narrative, evidence, 'ready', derivedDelta?.domains?.narrative?.status === 'fallback' ? 'ariadne_seed_fallback' : '', derivedDelta?.domains?.narrative?.source || normalizedNarrative.patch?.source || '');
`);

  rep('bounded_runtime_meta_api',
`    const getWorldManagerRuntimeMeta = async () => {
      const context=await resolveContext();
      const [meta,journal,replayCache,replayErrors]=await Promise.all([
        loadStateWorldlineMeta(context.scope,{strict:true}),loadStateCorrectionJournal(context.scope,{strict:true}),
        storage.getJson(key.stateReplayCache(context.scope),null),storage.getJson(key.stateReplayErrors(context.scope),null)
      ]);
      if (replayCache!=null&&(replayCache.schema!==STATE_REPLAY_CACHE_SCHEMA||string(replayCache.scopeKey||'')!==string(context.scope.scopeKey))) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_CACHE_INVALID');
      if (replayErrors!=null&&(replayErrors.schema!==STATE_REPLAY_ERROR_SCHEMA||string(replayErrors.scopeKey||'')!==string(context.scope.scopeKey))) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_ERROR_STORE_INVALID');
      const correctionCounts=Object.fromEntries(STATE_CORRECTION_STATUSES.map(statusValue=>[statusValue,asArray(journal.records).filter(row=>row?.status===statusValue).length]));
      correctionCounts.total=asArray(journal.records).length;
      const activeId=string(meta.activeWorldlineId||'main'); const errors=asArray(replayErrors?.records);
      return clone({
        scopeKey:string(context.scope.scopeKey),
        worldline:{activeWorldlineId:activeId,revision:Number(meta.revision||0),current:clone(meta.worldlines?.[activeId]||null)},
        replayCache:replayCache?{worldlineId:string(replayCache.worldlineId||''),fingerprint:string(replayCache.fingerprint||''),throughTurn:Number(replayCache.throughTurn||0),appliedDeltas:Number(replayCache.appliedDeltas||0),appliedCorrectionsCount:asArray(replayCache.appliedCorrections).length,reason:string(replayCache.reason||''),updatedAt:string(replayCache.updatedAt||'')}:null,
        correctionCounts,lastReplayError:errors.length?{at:string(errors[errors.length-1]?.at||''),code:string(errors[errors.length-1]?.code||''),message:compact(errors[errors.length-1]?.message||'',700)}:null
      });
    };
`,
`    const getWorldManagerRuntimeMeta = async () => {
      const context=await resolveContext();
      const [meta,correctionMeta,correctionCommit,replayCache,replayErrors]=await Promise.all([
        loadStateWorldlineMeta(context.scope,{strict:true}),loadStateCorrectionMeta(context.scope,{strict:true}),loadStateCorrectionCommit(context.scope,{strict:true}),
        storage.getJson(key.stateReplayCache(context.scope),null),storage.getJson(key.stateReplayErrors(context.scope),null)
      ]);
      if (replayCache!=null&&(replayCache.schema!==STATE_REPLAY_CACHE_SCHEMA||string(replayCache.scopeKey||'')!==string(context.scope.scopeKey))) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_CACHE_INVALID');
      if (replayErrors!=null&&(replayErrors.schema!==STATE_REPLAY_ERROR_SCHEMA||string(replayErrors.scopeKey||'')!==string(context.scope.scopeKey))) throw stateCorrectionFailure('WORLD_MANAGER_REPLAY_ERROR_STORE_INVALID');
      const emptyCorrectionCounts=Object.fromEntries(STATE_CORRECTION_STATUSES.map(statusValue=>[statusValue,0]));
      const correctionCoherent=stateCorrectionMetaCommitCoherent(correctionMeta,correctionCommit);
      const correctionCounts=correctionCoherent
        ? {...emptyCorrectionCounts,...clone(correctionMeta.correctionCounts),available:true}
        : {...emptyCorrectionCounts,active:null,total:null,available:false};
      const activeId=string(meta.activeWorldlineId||'main'); const errors=asArray(replayErrors?.records);
      const lastError=[...errors].reverse().find(row=>{
        const errorContext=row?.context&&typeof row.context==='object'?row.context:{}; const errorWorldline=string(errorContext.worldlineId||'');
        const rollbackIncomplete=errorContext.rollbackIncomplete===true || /ROLLBACK_INCOMPLETE/.test(string(row?.code||''));
        if (rollbackIncomplete) return true;
        if (row?.resolvedAt) return false;
        return !errorWorldline || errorWorldline===activeId;
      })||null;
      const snapshotValue=typeof state!=='undefined'&&state?.snapshot&&string(state.snapshot?.scope?.scopeKey||'')===string(context.scope.scopeKey)?state.snapshot:null;
      const snapshotHead=snapshotValue?.continuityState?.head||snapshotValue?.continuityState||null;
      const lastErrorContext=lastError?.context&&typeof lastError.context==='object'?lastError.context:{};
      const publicLastErrorContext={worldlineId:string(lastErrorContext.worldlineId||''),replayFingerprint:string(lastErrorContext.replayFingerprint||''),rollbackIncomplete:lastErrorContext.rollbackIncomplete===true,operation:string(lastErrorContext.operation||''),correctionId:string(lastErrorContext.correctionId||''),reason:string(lastErrorContext.reason||'')};
      return clone({
        scopeKey:string(context.scope.scopeKey),generation:typeof state!=='undefined'?Number(state.worldManagerRuntimeMetaGeneration||0):0,
        snapshotGeneration:string(snapshotValue?.snapshotGeneration||snapshotValue?.generation||''),headGeneration:string(snapshotHead?.generation||snapshotHead?.revision||snapshotHead?.updatedAt||''),
        worldline:{activeWorldlineId:activeId,revision:Number(meta.revision||0),current:clone(meta.worldlines?.[activeId]||null)},
        replayCache:replayCache?{worldlineId:string(replayCache.worldlineId||''),fingerprint:string(replayCache.fingerprint||''),throughTurn:Number(replayCache.throughTurn||0),appliedDeltas:Number(replayCache.appliedDeltas||0),appliedCorrectionsCount:asArray(replayCache.appliedCorrections).length,reason:string(replayCache.reason||''),updatedAt:string(replayCache.updatedAt||'')}:null,
        correctionCounts,correctionCommitStatus:string(correctionCommit?.status||'unavailable'),lastReplayError:lastError?{at:string(lastError.at||''),code:string(lastError.code||''),message:compact(lastError.message||'',700),context:publicLastErrorContext,rollbackIncomplete:lastErrorContext.rollbackIncomplete===true||/ROLLBACK_INCOMPLETE/.test(string(lastError.code||''))}:null
      });
    };
`);

  rep('gui_runtime_meta_state',
`    worldManagerEditError: '',
    worldManagerSaving: false,
    worldManagerDomainSections: { characters: 'current', relationships: 'current', world: 'current' },
`,
`    worldManagerEditError: '',
    worldManagerSaving: false,
    worldManagerRuntimeMeta: null,
    worldManagerRuntimeMetaScopeKey: '',
    worldManagerRuntimeMetaSnapshotToken: '',
    worldManagerRuntimeMetaLoading: false,
    worldManagerRuntimeMetaError: '',
    worldManagerRuntimeMetaErrorScopeKey: '',
    worldManagerRuntimeMetaLoadSerial: 0,
    worldManagerRuntimeMetaScheduledScopeKey: '',
    worldManagerRuntimeMetaRebuilding: false,
    worldManagerDomainSections: { characters: 'current', relationships: 'current', world: 'current' },
`);

  rep('plot_narrative_patch_viewer',
`              : guiEl('div', {}, [
                  guiEl('h4', { text: 'ito가 적용한 patch' }),
                  guiEl('pre', { class: 'sga-live-result-code', text: JSON.stringify(stage.patch || {}, null, 2) }),
                  guiEl('h4', { text: 'patch 적용 뒤 메모리' }),
                  guiEl('pre', { class: 'sga-live-result-code', text: stage.preview || '' })
                ]),
`,
`              : (() => {
                  const rawPatch = stage.patch && typeof stage.patch === 'object' && !Array.isArray(stage.patch) ? stage.patch : {};
                  const rawDomain = rawPatch.domain && typeof rawPatch.domain === 'object' && !Array.isArray(rawPatch.domain) ? rawPatch.domain : null;
                  const narrativePatch = stage.narrativePatch && typeof stage.narrativePatch === 'object'
                    ? stage.narrativePatch
                    : rawPatch.narrativePatch && typeof rawPatch.narrativePatch === 'object'
                      ? rawPatch.narrativePatch
                      : rawPatch.narrative_patch && typeof rawPatch.narrative_patch === 'object'
                        ? rawPatch.narrative_patch
                        : rawDomain?.narrative_patch && typeof rawDomain.narrative_patch === 'object'
                          ? rawDomain.narrative_patch
                          : rawDomain?.narrativePatch && typeof rawDomain.narrativePatch === 'object' ? rawDomain.narrativePatch : null;
                  const canonicalMemoryPatch = { ...rawPatch };
                  delete canonicalMemoryPatch.narrativePatch;
                  delete canonicalMemoryPatch.narrative_patch;
                  if (rawDomain) {
                    canonicalMemoryPatch.domain = { ...rawDomain };
                    delete canonicalMemoryPatch.domain.narrativePatch;
                    delete canonicalMemoryPatch.domain.narrative_patch;
                  }
                  return guiEl('div', {}, [
                    guiEl('h4', { text: 'ito가 적용한 정본 메모리 patch' }),
                    guiEl('pre', { class: 'sga-live-result-code', text: JSON.stringify(canonicalMemoryPatch, null, 2) }),
                    stage.stage === 'plot_ito' && narrativePatch ? guiLazyDetails({ class: 'sga-card', open: true }, guiEl('summary', { text: 'Narrative Patch · ' + (stage.narrativePatchStatus?.status || 'ready') }), () => [
                      stage.narrativePatchStatus?.reason ? guiEl('div', { class: 'sga-note', text: stage.narrativePatchStatus.reason }) : null,
                      guiEl('pre', { class: 'sga-live-result-code', text: JSON.stringify(narrativePatch, null, 2) })
                    ]) : null,
                    guiEl('h4', { text: 'patch 적용 뒤 메모리' }),
                    guiEl('pre', { class: 'sga-live-result-code', text: stage.preview || '' })
                  ]);
                })(),
`);

  rep('world_manager_runtime_loader',
`  const worldManagerDomainCopy = (view, domain, label) => {
    const row = guiAsObject(view.domainStatus?.[domain]);
    const status = row.status === 'ready' ? '최신' : row.status === 'not_updated' ? '마지막 확인값' : row.status === 'partial' ? '부분 상태' : '생성 대기';
    const turn = Number(row.throughTurn || view.throughTurn || 0);
    return { label, status, turn, reason: text(row.reason || ''), ready: row.status === 'ready' };
  };
`,
`  const worldManagerDomainCopy = (view, domain, label) => {
    const row = guiAsObject(view.domainStatus?.[domain]);
    const status = row.status === 'ready' ? '최신' : row.status === 'not_updated' ? '마지막 확인값' : row.status === 'partial' ? '부분 상태' : '생성 대기';
    const turn = Number(row.throughTurn || view.throughTurn || 0);
    return { label, status, turn, reason: text(row.reason || ''), ready: row.status === 'ready' };
  };

  const currentWorldManagerScopeKey = () => text(LibraMemoryCore.peekSnapshot()?.scope?.scopeKey || '');
  const currentWorldManagerSnapshotIdentity = () => {
    const snapshot=LibraMemoryCore.peekSnapshot()||{}; const continuity=snapshot.continuityState&&typeof snapshot.continuityState==='object'?snapshot.continuityState:null; const head=continuity?.head&&typeof continuity.head==='object'?continuity.head:continuity;
    return {scopeKey:text(snapshot?.scope?.scopeKey||''),snapshotGeneration:text(snapshot?.snapshotGeneration||snapshot?.generation||''),runtimeGeneration:Number(LibraMemoryCore.state?.worldManagerRuntimeMetaGeneration||0),headGeneration:text(head?.generation||head?.revision||head?.updatedAt||''),worldlineId:text(head?.worldlineId||''),throughTurn:Number(head?.throughTurn||0),replayFingerprint:text(head?.basis?.replayFingerprint||''),updatedAt:text(head?.updatedAt||'')};
  };
  const currentWorldManagerSnapshotToken = () => Object.values(currentWorldManagerSnapshotIdentity()).join('|');
  const worldManagerRuntimeMetaForCurrentScope = () => {
    const meta = Gui.worldManagerRuntimeMeta && typeof Gui.worldManagerRuntimeMeta === 'object' ? Gui.worldManagerRuntimeMeta : null;
    if (!meta) return null;
    const currentScopeKey = currentWorldManagerScopeKey();
    const boundScopeKey = text(Gui.worldManagerRuntimeMetaScopeKey || meta.scopeKey || '');
    if (currentScopeKey && boundScopeKey && currentScopeKey !== boundScopeKey) return null;
    const identity=currentWorldManagerSnapshotIdentity();
    if (text(meta.snapshotGeneration||'')&&identity.snapshotGeneration&&text(meta.snapshotGeneration)!==identity.snapshotGeneration) return null;
    if (text(meta.headGeneration||'')&&identity.headGeneration&&text(meta.headGeneration)!==identity.headGeneration) return null;
    return text(Gui.worldManagerRuntimeMetaSnapshotToken||'')===currentWorldManagerSnapshotToken() ? meta : null;
  };
  const loadWorldManagerRuntimeMeta = async ({ force = false } = {}) => {
    const scopeKey = currentWorldManagerScopeKey();
    const snapshotToken = currentWorldManagerSnapshotToken();
    if (!force) {
      const current = worldManagerRuntimeMetaForCurrentScope();
      if (current) return current;
      if (Gui.worldManagerRuntimeMetaLoading) return null;
    }
    const serial = Number(Gui.worldManagerRuntimeMetaLoadSerial || 0) + 1;
    Gui.worldManagerRuntimeMetaLoadSerial = serial;
    Gui.worldManagerRuntimeMetaLoading = true;
    Gui.worldManagerRuntimeMetaError = '';
    Gui.worldManagerRuntimeMetaErrorScopeKey = scopeKey;
    try {
      const api = globalThis.__LIBRA__;
      if (!api || typeof api.getWorldManagerRuntimeMeta !== 'function') throw new Error('World Manager 진단 API가 준비되지 않았습니다.');
      const meta = await api.getWorldManagerRuntimeMeta();
      if (serial !== Gui.worldManagerRuntimeMetaLoadSerial) return null;
      if (currentWorldManagerScopeKey()!==scopeKey || currentWorldManagerSnapshotToken()!==snapshotToken) return null;
      const returnedScopeKey = text(meta?.scopeKey || '');
      if (scopeKey && returnedScopeKey && returnedScopeKey !== scopeKey) throw new Error('World Manager 진단 scope가 현재 채팅과 일치하지 않습니다.');
      Gui.worldManagerRuntimeMeta = meta && typeof meta === 'object' ? meta : null;
      Gui.worldManagerRuntimeMetaScopeKey = returnedScopeKey || scopeKey;
      Gui.worldManagerRuntimeMetaSnapshotToken = snapshotToken;
      Gui.worldManagerRuntimeMetaErrorScopeKey = returnedScopeKey || scopeKey;
      return Gui.worldManagerRuntimeMeta;
    } catch (error) {
      if (serial === Gui.worldManagerRuntimeMetaLoadSerial && currentWorldManagerScopeKey()===scopeKey) {
        Gui.worldManagerRuntimeMeta = null;
        Gui.worldManagerRuntimeMetaScopeKey = scopeKey;
        Gui.worldManagerRuntimeMetaSnapshotToken = currentWorldManagerSnapshotToken();
        Gui.worldManagerRuntimeMetaErrorScopeKey = scopeKey;
        Gui.worldManagerRuntimeMetaError = (error?.code ? String(error.code) + ' · ' : '') + String(error?.message || error);
      }
      return null;
    } finally {
      if (serial === Gui.worldManagerRuntimeMetaLoadSerial) {
        Gui.worldManagerRuntimeMetaLoading = false;
        queueGuiNavigationRender();
      }
    }
  };
  const scheduleWorldManagerRuntimeMetaLoad = () => {
    const scopeToken = (currentWorldManagerScopeKey() || '__current__') + '|' + currentWorldManagerSnapshotToken();
    if (worldManagerRuntimeMetaForCurrentScope() || Gui.worldManagerRuntimeMetaLoading || Gui.worldManagerRuntimeMetaScheduledScopeKey === scopeToken) return;
    Gui.worldManagerRuntimeMetaScheduledScopeKey = scopeToken;
    Promise.resolve().then(() => loadWorldManagerRuntimeMeta()).catch(() => {});
  };
  const worldManagerReplayAssessment = (view,meta) => {
    const runtimeMeta=meta&&typeof meta==='object'?meta:null; const cache=runtimeMeta?.replayCache&&typeof runtimeMeta.replayCache==='object'?runtimeMeta.replayCache:null;
    const error=runtimeMeta?.lastReplayError&&typeof runtimeMeta.lastReplayError==='object'?runtimeMeta.lastReplayError:null;
    if (error) return {ok:false,label:'재검토 필요',kind:'error',reason:error.rollbackIncomplete?'rollback 불완전 오류가 해소되지 않았습니다.':'마지막 Replay 오류가 해소되지 않았습니다.'};
    if (!runtimeMeta) return {ok:false,label:Gui.worldManagerRuntimeMetaLoading?'확인 중':'상태 대기',kind:'pending',reason:'Runtime metadata가 없습니다.'};
    if (!view?.head&&!cache) return {ok:false,label:'생성 대기',kind:'pending',reason:'첫 Current Head와 Replay cache가 아직 없습니다.'};
    if (!view?.head||!cache) return {ok:false,label:'확인 필요',kind:'warn',reason:'Current Head와 Replay cache 중 하나가 없습니다.'};
    const activeId=text(runtimeMeta?.worldline?.activeWorldlineId||'main'); const headWorldline=text(view.head?.worldlineId||'main'); const cacheWorldline=text(cache.worldlineId||'');
    if (activeId!==headWorldline||activeId!==cacheWorldline) return {ok:false,label:'재검토 필요',kind:'warn',reason:'Replay worldline이 현재 Current Head와 일치하지 않습니다.'};
    if (Number(cache.throughTurn||0)!==Number(view.throughTurn||0)) return {ok:false,label:'재검토 필요',kind:'warn',reason:'Replay turn 경계가 현재 Current Head와 일치하지 않습니다.'};
    const headFingerprint=text(view.head?.basis?.replayFingerprint||'');
    if (!headFingerprint||!text(cache.fingerprint||'')) return {ok:false,label:'확인 필요',kind:'warn',reason:'Replay fingerprint 증거가 없어 정상 상태로 확정할 수 없습니다.'};
    if (text(cache.fingerprint||'')!==headFingerprint) return {ok:false,label:'재검토 필요',kind:'warn',reason:'Replay fingerprint가 현재 Current Head와 일치하지 않습니다.'};
    return {ok:true,label:'정상',kind:'good',reason:''};
  };
  const replayWorldManagerFromHome = async () => {
    if (Gui.worldManagerRuntimeMetaRebuilding) return;
    const startingScopeKey=currentWorldManagerScopeKey();
    Gui.worldManagerRuntimeMetaRebuilding = true;
    try {
      const api = globalThis.__LIBRA__;
      if (!api || typeof api.rebuildWorldManagerState !== 'function') throw new Error('World Manager 재구축 API가 준비되지 않았습니다.');
      const result = await api.rebuildWorldManagerState({ reason: 'gui_home_replay_retry', expectedScopeKey: startingScopeKey });
      if (result?.ok === false) { const error = new Error(result.error || 'World Manager 상태 재구축에 실패했습니다.'); error.code = result.code || 'STATE_REPLAY_FAILED'; throw error; }
      if (currentWorldManagerScopeKey()!==startingScopeKey) return;
      await LibraMemoryCore.refreshSnapshot(undefined, { suppressGuiSchedule: true, limits: LibraMemoryCore.state.guiSnapshotLimits || LIBRA_SNAPSHOT_PAGE_LIMITS });
      if (currentWorldManagerScopeKey()!==startingScopeKey) return;
      const refreshedMeta = await loadWorldManagerRuntimeMeta({ force: true });
      if (!refreshedMeta) throw new Error(Gui.worldManagerRuntimeMetaError || 'World Manager 진단 readback에 실패했습니다.');
      if (currentWorldManagerScopeKey()!==startingScopeKey) return;
      const assessment=worldManagerReplayAssessment(worldManagerSnapshotView(),refreshedMeta);
      if (!assessment.ok) throw new Error(assessment.reason||'World Manager Replay postcondition이 현재 Head와 일치하지 않습니다.');
      guiSetStatus('World Manager 상태를 다시 계산하고 readback을 확인했습니다.');
    } catch (error) {
      if (currentWorldManagerScopeKey()!==startingScopeKey) return;
      Gui.worldManagerRuntimeMetaErrorScopeKey = startingScopeKey;
      Gui.worldManagerRuntimeMetaError = (error?.code ? String(error.code) + ' · ' : '') + String(error?.message || error);
      guiSetStatus(Gui.worldManagerRuntimeMetaError, true, true);
    } finally {
      Gui.worldManagerRuntimeMetaRebuilding = false;
      queueGuiNavigationRender();
    }
  };
  const openWorldManagerDiagnostics = () => {
    Gui.settingsHubSection = 'general';
    Gui.generalSettingsSection = 'debug';
    sharedNavigate('settings');
  };
`);

  rep('world_manager_source_badges',
`  const buildWorldManagerSnapshotNotice = (view, domain, label, count) => {
    const copy = worldManagerDomainCopy(view, domain, label);
    if (!view.head) return guiEl('div', { class: 'sga-callout', dataset: { snapshotOnly: 'true', worldDomain: domain } }, [
      guiEl('strong', { text: \`아직 \${label} Current Head가 없습니다.\` }),
      guiEl('div', { text: '다음 5턴 정본 분석이 완료되면 이 화면에 표시됩니다.' })
    ]);
    return guiEl('div', { class: \`sga-callout\${copy.ready ? '' : ' warn'}\`, dataset: { snapshotOnly: 'true', worldDomain: domain } }, [
      guiEl('strong', { text: \`\${label} · \${copy.status} · \${Number(count || 0)}개\` }),
      guiEl('div', { text: \`정본 기준 T\${copy.turn || view.throughTurn} · \${libraFormatTime(view.head.updatedAt)}\` }),
      copy.reason ? guiEl('div', { class: 'sga-note', text: copy.reason }) : null,
      guiEl('div', { class: 'sga-note', text: '이 첫 화면은 현재 snapshot만 읽습니다. History와 Correction Journal은 사용자가 해당 기능을 열기 전에는 조회하지 않습니다.' })
    ]);
  };

  const worldManagerRowIdentity = (domain, row, index) => {
    if (row?.id) return String(row.id);
    if (domain === 'relationships') return [row?.subjectId || row?.subjectName, row?.targetId || row?.targetName, row?.dimension, index].join('::');
    return String(domain) + ':' + String(index);
  };

  const worldManagerCorrectionId = row => text(row?.correctionProvenance?.correctionId || '');
  const worldManagerCorrectionBadge = row => worldManagerCorrectionId(row)
    ? libraStatusBadge('사용자 교정', 'warn')
    : libraStatusBadge('AI 분석', 'good');
`,
`  const worldManagerCorrectionId = row => text(row?.correctionProvenance?.correctionId || '');
  const worldManagerSourceDescriptor = (domain, row, view = null) => {
    if (worldManagerCorrectionId(row)) return { label: '사용자 교정', kind: 'warn', source: 'user_correction' };
    const normalizedDomain = text(domain || '').toLowerCase();
    const domainKey = normalizedDomain.startsWith('narrative') ? 'narrative' : normalizedDomain;
    const status = guiAsObject(view?.domainStatus?.[domainKey]);
    const narrative = guiAsObject(view?.narrative);
    const sourceText = [
      row?.source, row?.provenance?.source, row?.evidence?.source,
      status.source, status.reason,
      domainKey === 'narrative' ? narrative.source : ''
    ].map(value => text(value || '').toLowerCase()).filter(Boolean).join(' ');
    if (/legacy|migration|migrated/.test(sourceText)) return { label: '이전 데이터 이관', kind: 'warn', source: sourceText };
    if (/plot[_\\s-]?ito/.test(sourceText)) return { label: 'Plot ito', kind: 'good', source: sourceText };
    if (/ariadne|fallback/.test(sourceText)) return { label: /fallback|보조/.test(sourceText) ? 'Ariadne 보조 상태' : 'Ariadne', kind: /fallback|보조/.test(sourceText) ? 'warn' : 'good', source: sourceText };
    if (/character[_\\s-]?ito/.test(sourceText)) return { label: 'Character ito', kind: 'good', source: sourceText };
    if (/world[_\\s-]?ito/.test(sourceText)) return { label: 'World ito', kind: 'good', source: sourceText };
    return { label: '출처 미확인', kind: 'warn', source: 'unknown' };
  };
  const worldManagerSourceBadge = (domain, row, view = null) => {
    const descriptor = worldManagerSourceDescriptor(domain, row, view);
    return libraStatusBadge(descriptor.label, descriptor.kind);
  };

  const buildWorldManagerSnapshotNotice = (view, domain, label, count) => {
    const copy = worldManagerDomainCopy(view, domain, label);
    if (!view.head) return guiEl('div', { class: 'sga-callout', dataset: { snapshotOnly: 'true', worldDomain: domain } }, [
      guiEl('strong', { text: \`아직 \${label} Current Head가 없습니다.\` }),
      guiEl('div', { text: '다음 5턴 정본 분석이 완료되면 이 화면에 표시됩니다.' })
    ]);
    const sourceRow = domain === 'narrative' ? view.narrative : {};
    return guiEl('div', { class: \`sga-callout\${copy.ready ? '' : ' warn'}\`, dataset: { snapshotOnly: 'true', worldDomain: domain } }, [
      guiEl('div', { class: 'sga-agent-head' }, [guiEl('strong', { text: \`\${label} · \${copy.status} · \${Number(count || 0)}개\` }), worldManagerSourceBadge(domain, sourceRow, view)]),
      guiEl('div', { text: \`정본 기준 T\${copy.turn || view.throughTurn} · \${libraFormatTime(view.head.updatedAt)}\` }),
      copy.reason ? guiEl('div', { class: 'sga-note', text: copy.reason }) : null,
      guiEl('div', { class: 'sga-note', text: '이 첫 화면은 현재 snapshot만 읽습니다. History와 Correction Journal은 사용자가 해당 기능을 열기 전에는 조회하지 않습니다.' })
    ]);
  };

  const worldManagerRowIdentity = (domain, row, index) => {
    if (row?.id) return String(row.id);
    if (domain === 'relationships') return [row?.subjectId || row?.subjectName, row?.targetId || row?.targetName, row?.dimension, index].join('::');
    return String(domain) + ':' + String(index);
  };
`);

  rep('correction_editor_source_badge',
`      worldManagerCorrectionBadge(row),
`,
`      worldManagerSourceBadge(domain, row, view),
`);

  rep('world_manager_record_source_badges',
`        }, [guiEl('strong', { text: titleFor(row, index) }), guiEl('small', { class: 'sga-note', text: subtitleFor(row, index) }), worldManagerCorrectionId(row) ? guiEl('small',{class:'sga-note',text:'사용자 교정'}) : null])))
      ]),
      guiEl('section', { class: 'sga-card libra-memory-detail-panel', dataset: { worldRecordDetail: selectedId } }, [
        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3', { text: titleFor(selected, selectedIndex) }),guiEl('div', { class: 'sga-note', text: subtitleFor(selected, selectedIndex) })]),worldManagerCorrectionBadge(selected)]),
`,
`        }, [guiEl('strong', { text: titleFor(row, index) }), guiEl('small', { class: 'sga-note', text: subtitleFor(row, index) }), guiEl('small', { class: 'sga-note', text: worldManagerSourceDescriptor(domain, row, view).label })])))
      ]),
      guiEl('section', { class: 'sga-card libra-memory-detail-panel', dataset: { worldRecordDetail: selectedId } }, [
        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3', { text: titleFor(selected, selectedIndex) }),guiEl('div', { class: 'sga-note', text: subtitleFor(selected, selectedIndex) })]),worldManagerSourceBadge(domain, selected, view)]),
`);

  rep('narrative_current_source_badge',
`        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3', { text: '현재까지 실제로 성립한 이야기' }),guiEl('div', { text: text(narrative.summary || '현재 내러티브 요약 없음') })]),worldManagerCorrectionBadge(narrative)]),
`,
`        guiEl('div',{class:'sga-agent-head'},[guiEl('div',{},[guiEl('h3', { text: '현재까지 실제로 성립한 이야기' }),guiEl('div', { text: text(narrative.summary || '현재 내러티브 요약 없음') })]),worldManagerSourceBadge('narrative', narrative, view)]),
`);

  rep('shared_home_runtime_diagnostics',
`  const buildSharedHomeOverviewPanel = () => {
    const view = worldManagerSnapshotView();
    const manifest = guiAsObject(view.snapshot.manifest);
    const family = activeGuiResponseFamily();
    const memoryCount = Number(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length);
    const domainCards = [
      ['characters', '인물', view.characters.length], ['relationships', '관계', view.relationships.length],
      ['world', '세계', view.world.length], ['narrative', '내러티브', guiAsArray(view.narrative.arcs).length + guiAsArray(view.narrative.threads).length]
    ];
    return guiEl('div', { class: 'sga-flow-section shared-home-overview', dataset: { snapshotOnly: 'true' } }, [
      guiEl('section', { class: 'sga-card wide' }, [
        guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: '기억 → 현재 세계 → 초안' }), guiEl('div', { class: 'sga-note', text: 'LIBRA와 GRADIA가 같은 정본·리콜·월드 매니저를 보고, 공통 리콜 이후의 초안 작업공간만 달라집니다.' })]), libraStatusBadge(view.head ? '공통 Current Head' : '생성 대기', view.head ? 'good' : 'warn')]),
        guiEl('div', { class: 'sga-summary-table' }, [
          guiEl('span', { text: '정본 메모리' }), guiEl('strong', { text: String(memoryCount) }),
          guiEl('span', { text: '정본화 Turn' }), guiEl('strong', { text: \`T\${Number(manifest.frontiers?.committedTurn || 0)}\` }),
          guiEl('span', { text: '월드 매니저 기준' }), guiEl('strong', { text: view.head ? \`T\${view.throughTurn}\` : '대기' }),
          guiEl('span', { text: '초안 엔진' }), guiEl('strong', { text: family === 'gradia' ? 'GRADIA' : 'LIBRA' })
        ])
      ]),
      guiEl('section', { class: 'sga-card wide' }, [
        guiEl('h3', { text: '현재 세계' }),
        guiEl('div', { class: 'libra-home-pipeline-grid' }, domainCards.map(([id, label, count]) => guiEl('button', { class: 'libra-home-stage-card', type: 'button', onClick: () => sharedNavigate(id) }, [guiEl('strong', { text: label }), guiEl('span', { class: 'sga-metric', text: String(count) }), guiEl('small', { class: 'sga-note', text: worldManagerDomainCopy(view, id, label).status })])))
      ]),
      buildActiveDraftSummaryCard(family),
      view.snapshot.error ? guiEl('div', { class: 'sga-callout danger', text: view.snapshot.error }) : null
    ]);
  };
`,
`  const buildSharedHomeOverviewPanel = () => {
    const view = worldManagerSnapshotView();
    const manifest = guiAsObject(view.snapshot.manifest);
    const family = activeGuiResponseFamily();
    const memoryCount = Number(view.snapshot.totals?.memories ?? guiAsArray(view.snapshot.memories).length);
    const worldManagerRuntimeMeta = worldManagerRuntimeMetaForCurrentScope();
    const currentRuntimeScopeKey = currentWorldManagerScopeKey();
    const worldManagerRuntimeMetaError = !Gui.worldManagerRuntimeMetaErrorScopeKey || !currentRuntimeScopeKey || Gui.worldManagerRuntimeMetaErrorScopeKey === currentRuntimeScopeKey ? Gui.worldManagerRuntimeMetaError : '';
    if (!worldManagerRuntimeMeta && !Gui.worldManagerRuntimeMetaLoading && !worldManagerRuntimeMetaError) scheduleWorldManagerRuntimeMetaLoad();
    const worldline = guiAsObject(worldManagerRuntimeMeta?.worldline);
    const replayCache = worldManagerRuntimeMeta?.replayCache && typeof worldManagerRuntimeMeta.replayCache === 'object' ? worldManagerRuntimeMeta.replayCache : null;
    const lastReplayError = worldManagerRuntimeMeta?.lastReplayError && typeof worldManagerRuntimeMeta.lastReplayError === 'object' ? worldManagerRuntimeMeta.lastReplayError : null;
    const correctionCounts = guiAsObject(worldManagerRuntimeMeta?.correctionCounts);
    const replayAssessment = worldManagerReplayAssessment(view,worldManagerRuntimeMeta);
    const replayLabel = replayAssessment.label;
    const lastRecall = LibraMemoryCore.getLastRecall?.() || null; const recallDelivery=guiAsObject(lastRecall?.delivery);
    const lastRecallCount=Number(recallDelivery.selectedMemories ?? guiAsArray(lastRecall?.memories).length); const lastRecallAt=text(lastRecall?.at||recallDelivery?.at||'');
    const liveTailCopy=recallDelivery.liveTailUsed===true ? 'T'+Number(recallDelivery.liveTailStartTurn||0)+'~T'+Number(recallDelivery.liveTailEndTurn||0)+' · '+Number(recallDelivery.liveTailPairCount||0)+'턴' : '미제공';
    const openThreadCount=guiAsArray(view.narrative.threads).filter(row=>row?.status==='open').length;
    const domainCards = [
      ['characters', '인물', view.characters.length], ['relationships', '관계', view.relationships.length],
      ['world', '세계', view.world.length], ['narrative', '내러티브', guiAsArray(view.narrative.arcs).length + guiAsArray(view.narrative.threads).length]
    ];
    return guiEl('div', { class: 'sga-flow-section shared-home-overview', dataset: { snapshotOnly: 'true' } }, [
      guiEl('section', { class: 'sga-card wide' }, [
        guiEl('div', { class: 'sga-agent-head' }, [guiEl('div', {}, [guiEl('h3', { text: '기억 → 현재 세계 → 초안' }), guiEl('div', { class: 'sga-note', text: 'LIBRA와 GRADIA가 같은 정본·리콜·월드 매니저를 보고, 공통 리콜 이후의 초안 작업공간만 달라집니다.' })]), libraStatusBadge(view.head ? '공통 Current Head' : '생성 대기', view.head ? 'good' : 'warn')]),
        guiEl('div', { class: 'sga-summary-table' }, [
          guiEl('span', { text: '정본 메모리' }), guiEl('strong', { text: String(memoryCount) }),
          guiEl('span', { text: '정본화 Turn' }), guiEl('strong', { text: \`T\${Number(manifest.frontiers?.committedTurn || 0)}\` }),
          guiEl('span', { text: '월드 매니저 기준' }), guiEl('strong', { text: view.head ? \`T\${view.throughTurn}\` : '대기' }),
          guiEl('span', { text: '현재 월드라인' }), guiEl('strong', { text: text(worldline.activeWorldlineId || view.head?.worldlineId || 'main') }),
          guiEl('span', { text: 'Replay' }), guiEl('strong', { text: replayLabel }),
          guiEl('span', { text: '적용 중인 교정' }), guiEl('strong', { text: correctionCounts.available===true ? String(Number(correctionCounts.active||0)) : '집계 전' }),
          guiEl('span', { text: '최근 리콜' }), guiEl('strong', { text: lastRecall ? String(lastRecallCount)+'개'+(lastRecallAt?' · '+libraFormatTime(lastRecallAt):'') : '아직 없음' }),
          guiEl('span', { text: '미확정 Live Tail' }), guiEl('strong', { text: liveTailCopy }),
          guiEl('span', { text: '열린 Thread' }), guiEl('strong', { text: String(openThreadCount) }),
          guiEl('span', { text: '초안 엔진' }), guiEl('strong', { text: family === 'gradia' ? 'GRADIA' : 'LIBRA' })
        ])
      ]),
      Gui.worldManagerRuntimeMetaLoading ? guiEl('div', { class: 'sga-callout', text: '월드 매니저 상태를 불러오는 중...' }) : null,
      worldManagerRuntimeMetaError ? guiEl('section', { class: 'sga-callout danger' }, [
        guiEl('strong', { text: 'World Manager 진단 상태를 불러오지 못했습니다.' }),
        guiEl('div', { class: 'sga-note', text: worldManagerRuntimeMetaError }),
        guiEl('div', { class: 'sga-actions' }, [guiEl('button', { class: 'sga-btn', type: 'button', text: '다시 확인', onClick: () => { Gui.worldManagerRuntimeMetaError = ''; Gui.worldManagerRuntimeMetaErrorScopeKey = currentRuntimeScopeKey; Gui.worldManagerRuntimeMetaScheduledScopeKey = ''; void loadWorldManagerRuntimeMeta({ force: true }); } }), guiEl('button', { class: 'sga-btn ghost', type: 'button', text: '진단 열기', onClick: openWorldManagerDiagnostics })])
      ]) : null,
      lastReplayError ? guiEl('section', { class: 'sga-callout danger', dataset: { replayWarning: 'true' } }, [
        guiEl('strong', { text: '상태 재구축에 실패했습니다.' }),
        guiEl('div', { text: '이전 정상 상태는 보존되었습니다.' }),
        guiEl('div', { class: 'sga-note', text: [lastReplayError.code, lastReplayError.message, libraFormatTime(lastReplayError.at)].filter(Boolean).join(' · ') }),
        guiEl('div', { class: 'sga-actions' }, [
          guiEl('button', { class: 'sga-btn primary', type: 'button', text: Gui.worldManagerRuntimeMetaRebuilding ? '다시 계산 중...' : '다시 계산', disabled: Gui.worldManagerRuntimeMetaRebuilding, onClick: () => { void replayWorldManagerFromHome(); } }),
          guiEl('button', { class: 'sga-btn ghost', type: 'button', text: '진단 열기', onClick: openWorldManagerDiagnostics })
        ])
      ]) : replayAssessment.kind==='warn' ? guiEl('section',{class:'sga-callout warn',dataset:{replayMismatch:'true'}},[
        guiEl('strong',{text:'Replay metadata가 현재 Current Head와 일치하지 않습니다.'}),
        guiEl('div',{class:'sga-note',text:replayAssessment.reason}),
        guiEl('div',{class:'sga-actions'},[guiEl('button',{class:'sga-btn primary',type:'button',text:Gui.worldManagerRuntimeMetaRebuilding?'다시 계산 중...':'다시 계산',disabled:Gui.worldManagerRuntimeMetaRebuilding,onClick:()=>{void replayWorldManagerFromHome();}}),guiEl('button',{class:'sga-btn ghost',type:'button',text:'진단 열기',onClick:openWorldManagerDiagnostics})])
      ]) : replayCache&&replayAssessment.ok ? guiEl('div', { class: 'sga-note', text: \`Replay T\${Number(replayCache.throughTurn || 0)} · Delta \${Number(replayCache.appliedDeltas || 0)} · Correction \${Number(replayCache.appliedCorrectionsCount || 0)} · \${libraFormatTime(replayCache.updatedAt)}\` }) : replayAssessment.reason ? guiEl('div',{class:'sga-note',text:replayAssessment.reason}) : null,
      guiEl('section', { class: 'sga-card wide' }, [
        guiEl('h3', { text: '현재 세계' }),
        guiEl('div', { class: 'libra-home-pipeline-grid' }, domainCards.map(([id, label, count]) => {
          const sourceRow = id === 'narrative' ? view.narrative : {};
          return guiEl('button', { class: 'libra-home-stage-card', type: 'button', onClick: () => sharedNavigate(id) }, [guiEl('strong', { text: label }), guiEl('span', { class: 'sga-metric', text: String(count) }), worldManagerSourceBadge(id, sourceRow, view), guiEl('small', { class: 'sga-note', text: worldManagerDomainCopy(view, id, label).status })]);
        }))
      ]),
      buildActiveDraftSummaryCard(family),
      view.snapshot.error ? guiEl('div', { class: 'sga-callout danger', text: view.snapshot.error }) : null
    ]);
  };
`);

  rep('portable_state_correction_digest_helper',
`    const digestCanonical = async value => {
      const body = typeof value === 'string' ? value : canonicalize(value);
`,
`    const portableStateStoredValueDigest = value => {
      const body=canonicalize(value==null?null:value); let hash=2166136261;
      for (let index=0;index<body.length;index+=1) { hash^=body.charCodeAt(index); hash=Math.imul(hash,16777619); }
      hash^=31; hash=Math.imul(hash,16777619);
      return (hash>>>0).toString(16).padStart(8,'0')+':'+String(body.length+1);
    };
    const digestCanonical = async value => {
      const body = typeof value === 'string' ? value : canonicalize(value);
`);

  rep('portable_state_correction_graph_validation',
`        const [manifestKey, manifest] = manifests[0];
        const scopeKey = textValue(envelope?.source?.scopeKey || envelope?.source?.scopeId || manifest?.scopeKey);
`,
`        const [manifestKey, manifest] = manifests[0];
        const scopeKey = textValue(envelope?.source?.scopeKey || envelope?.source?.scopeId || manifest?.scopeKey);
        const correctionJournals=[...decoded.entries()].filter(([,value])=>value?.schema==='libra.state_correction_store.v1');
        const correctionMetas=[...decoded.entries()].filter(([,value])=>value?.schema==='libra.state_correction_meta.v1');
        const correctionCommits=[...decoded.entries()].filter(([,value])=>value?.schema==='libra.state_correction_commit.v1');
        if (correctionJournals.length>1||correctionMetas.length>1||correctionCommits.length>1) throw new Error('portable_backup_state_correction_record_count_invalid');
        if ((correctionMetas.length||correctionCommits.length)&&(!correctionJournals.length||!correctionMetas.length||!correctionCommits.length)) throw new Error('portable_backup_state_correction_transaction_incomplete');
        if (correctionJournals.length&&correctionMetas.length&&correctionCommits.length) {
          const [journalKey,journal]=correctionJournals[0]; const [metaKey,correctionMeta]=correctionMetas[0]; const [commitKey,correctionCommit]=correctionCommits[0];
          if (!journalKey.endsWith(':state-corrections:v2')||!metaKey.endsWith(':state-correction-meta:v1')||!commitKey.endsWith(':state-correction-commit:v1')) throw new Error('portable_backup_state_correction_key_invalid');
          if (textValue(journal.scopeKey)!==scopeKey||textValue(correctionMeta.scopeKey)!==scopeKey||textValue(correctionCommit.scopeKey)!==scopeKey) throw new Error('portable_backup_state_correction_scope_mismatch');
          const journalDigest=portableStateStoredValueDigest({schema:journal.schema,scopeKey:journal.scopeKey,revision:journal.revision,records:Array.isArray(journal.records)?journal.records:[],migratedLegacyOverrideIds:Array.isArray(journal.migratedLegacyOverrideIds)?journal.migratedLegacyOverrideIds:[]});
          const statuses=['active','suspended','dormant_after_rollback','superseded','deleted'];
          const expectedCounts=Object.fromEntries(statuses.map(status=>[status,(Array.isArray(journal.records)?journal.records:[]).filter(row=>row?.status===status).length])); expectedCounts.total=Array.isArray(journal.records)?journal.records.length:0; expectedCounts.available=true;
          if (Number(correctionMeta.journalRevision)!==Number(journal.revision)||textValue(correctionMeta.journalDigest)!==journalDigest||!equalValues(correctionMeta.correctionCounts,expectedCounts)) throw new Error('portable_backup_state_correction_meta_mismatch');
          if (correctionCommit.status!=='committed'||!textValue(correctionCommit.transactionId)||Number(correctionCommit.targetJournalRevision)!==Number(correctionMeta.journalRevision)||textValue(correctionCommit.targetJournalDigest)!==textValue(correctionMeta.journalDigest)) throw new Error('portable_backup_state_correction_commit_mismatch');
        }
`);

  rep('portable_post_restore_graph_readback',
`        const verified = [];
        for (const record of envelope.records) {
          const expected = decodeValue(record.value);
          const actual = await adapter.get(record.key);
          const valid = equalValues(actual, expected);
          if (!valid) throw new Error(\`portable_backup_post_restore_mismatch:\${record.key}\`);
          verified.push(record.key);
        }
`,
`        const verified = [];
        const physicalRecords=[];
        for (const record of envelope.records) {
          const expected = decodeValue(record.value);
          const actual = await adapter.get(record.key);
          const valid = equalValues(actual, expected);
          if (!valid) throw new Error(\`portable_backup_post_restore_mismatch:\${record.key}\`);
          verified.push(record.key);
          physicalRecords.push({...record,value:encodeValue(actual)});
        }
        validatePluginGraph(physicalRecords,envelope);
`);

  rep('portable_world_manager_queue_gate',
`      if (runtime.operationId || LibraMemoryCore.state.portableMemoryActiveOperationId) {
`,
`      if (LibraMemoryCore.state.queues instanceof Map && LibraMemoryCore.state.queues.size > 0) {
        const error = new Error('월드 매니저 또는 기억 정본 transaction이 실행 중입니다. 현재 작업이 끝난 뒤 다시 시도해 주세요.');
        error.code = 'LIBRA_WORLD_MANAGER_BUSY';
        throw error;
      }
      if (runtime.operationId || LibraMemoryCore.state.portableMemoryActiveOperationId) {
`);

  rep('continuity_prompt_narrative_status_scope_fix',
`      const domainStatus = {
        characters: normalizeContinuityDomainStatus(head?.domainStatus?.characters),
        relationships: normalizeContinuityDomainStatus(head?.domainStatus?.relationships),
        world: normalizeContinuityDomainStatus(head?.domainStatus?.world),
        narrative: previousHead?.domainStatus?.narrative || { status: 'empty', source: 'legacy_normalization' }
      };
`,
`      const domainStatus = {
        characters: normalizeContinuityDomainStatus(head?.domainStatus?.characters),
        relationships: normalizeContinuityDomainStatus(head?.domainStatus?.relationships),
        world: normalizeContinuityDomainStatus(head?.domainStatus?.world),
        narrative: normalizeContinuityDomainStatus(head?.domainStatus?.narrative)
      };
`);

  rep('continuity_rebase_narrative_status_scope_fix',
`      rebased.domainStatus = {
        characters: mappedDomainStatus('characters', rebased.domainStatus?.characters),
        relationships: mappedDomainStatus('relationships', rebased.domainStatus?.relationships),
        world: mappedDomainStatus('world', rebased.domainStatus?.world),
        narrative: previousHead?.domainStatus?.narrative || { status: 'empty', source: 'legacy_normalization' }
      };
`,
`      rebased.domainStatus = {
        characters: mappedDomainStatus('characters', rebased.domainStatus?.characters),
        relationships: mappedDomainStatus('relationships', rebased.domainStatus?.relationships),
        world: mappedDomainStatus('world', rebased.domainStatus?.world),
        narrative: mappedDomainStatus('narrative', rebased.domainStatus?.narrative)
      };
`);

  return { source, labels };
};
