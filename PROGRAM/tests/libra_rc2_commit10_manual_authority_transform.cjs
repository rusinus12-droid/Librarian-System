'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };
  const repBetween = (label, startMarker, endMarker, replacement) => {
    const start = source.indexOf(startMarker);
    const secondStart = start < 0 ? -1 : source.indexOf(startMarker, start + startMarker.length);
    if (start < 0) throw new Error(label + ':start_missing');
    if (secondStart >= 0) throw new Error(label + ':start_not_unique');
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (end < 0) throw new Error(label + ':end_missing');
    source = source.slice(0, start) + replacement + source.slice(end);
    labels.push(label);
  };

  rep('manual_authority_schemas',
`    const CANONICAL_VARIANT_INDEX_SCHEMA = 'libra.canonical_variant_index.v1';
    const CANONICAL_JOB_SCHEMA = 'libra.canonical_job.v1';
`,
`    const CANONICAL_VARIANT_INDEX_SCHEMA = 'libra.canonical_variant_index.v1';
    const CANONICAL_JOB_SCHEMA = 'libra.canonical_job.v1';
    const CANONICAL_MANUAL_AUTHORITY_SCHEMA = 'libra.canonical_manual_authority.v1';
    const CANONICAL_ADOPTION_TRANSACTION_SCHEMA = 'libra.canonical_adoption_transaction.v1';
`);

  rep('canonical_adoption_journal_key',
`      canonicalJobHead: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:canonical-job-head:v1\`,
      continuityDelta: (scope, memoryId, revision) => \`\${PREFIX}:scope:\${scope.scopeKey}:continuity-delta:\${String(memoryId || 'memory')}:r\${Number(revision || 0)}\`,
`,
`      canonicalJobHead: scope => \`\${PREFIX}:scope:\${scope.scopeKey}:canonical-job-head:v1\`,
      canonicalAdoptionJournal: (scope, jobId) => \`\${PREFIX}:scope:\${scope.scopeKey}:canonical-adoption-transaction:\${String(jobId || 'job')}\`,
      continuityDelta: (scope, memoryId, revision) => \`\${PREFIX}:scope:\${scope.scopeKey}:continuity-delta:\${String(memoryId || 'memory')}:r\${Number(revision || 0)}\`,
`);

  rep('adoption_scope_routing',
`canonical-job:|canonical-job-head:|continuity-delta:`,
`canonical-job:|canonical-job-head:|canonical-adoption-transaction:|continuity-delta:`);

  rep('restore_rejects_adoption_journal',
`    } else if (key.includes(':canonical-job:') || key.includes(':canonical-job-head:')) {
      if (String(parsed.schema || '') !== 'libra.canonical_job.v1' || String(parsed.scopeKey || '') !== scopeKey || !String(parsed.jobId || '')) errors.push({ code:'libra_restore_canonical_job_invalid', key });
`,
`    } else if (key.includes(':canonical-adoption-transaction:')) {
      errors.push({ code:'libra_restore_canonical_adoption_incomplete', key });
    } else if (key.includes(':canonical-job:') || key.includes(':canonical-job-head:')) {
      if (String(parsed.schema || '') !== 'libra.canonical_job.v1' || String(parsed.scopeKey || '') !== scopeKey || !String(parsed.jobId || '')) errors.push({ code:'libra_restore_canonical_job_invalid', key });
`);

  rep('portable_rejects_adoption_journal',
`        const correctionCommits=[...decoded.entries()].filter(([,value])=>value?.schema==='libra.state_correction_commit.v1');
        if (correctionJournals.length>1||correctionMetas.length>1||correctionCommits.length>1) throw new Error('portable_backup_state_correction_record_count_invalid');
`,
`        const correctionCommits=[...decoded.entries()].filter(([,value])=>value?.schema==='libra.state_correction_commit.v1');
        const adoptionJournals=[...decoded.entries()].filter(([key,value])=>key.includes(':canonical-adoption-transaction:')||value?.schema==='libra.canonical_adoption_transaction.v1');
        if (adoptionJournals.length) throw new Error('portable_backup_canonical_adoption_incomplete');
        if (correctionJournals.length>1||correctionMetas.length>1||correctionCommits.length>1) throw new Error('portable_backup_state_correction_record_count_invalid');
`);

  rep('manual_authority_helpers',
`    const findCanonicalVariant = async (scope, variantId, manifest = null) => {
      const index = await loadCanonicalVariantIndex(scope, manifest);
      for (const slot of Object.values(asObject(index.slots))) {
        const variant = asArray(slot?.variants).find(item => string(item?.variantId || '') === string(variantId || ''));
        if (variant) return { index, slot, variant: clone(variant) };
      }
      return { index, slot: null, variant: null };
    };
`,
`    const findCanonicalVariant = async (scope, variantId, manifest = null) => {
      const index = await loadCanonicalVariantIndex(scope, manifest);
      for (const slot of Object.values(asObject(index.slots))) {
        const variant = asArray(slot?.variants).find(item => string(item?.variantId || '') === string(variantId || ''));
        if (variant) return { index, slot, variant: clone(variant) };
      }
      return { index, slot: null, variant: null };
    };
    const stripCanonicalAutomaticReceipts = memoryValue => {
      const memory=clone(memoryValue)||{};
      for (const field of ['artifactSchema','canonicalArtifact','artifactValidation','renderValidation','promptProvenance','pipeline']) delete memory[field];
      return memory;
    };
    const canonicalManualAuthorityHash = authorityValue => {
      const authority=asObject(authorityValue);
      return digest(stableReferenceJson({
        schema:authority.schema,origin:authority.origin,scopeKey:authority.scopeKey,parentKey:authority.parentKey,parentRevision:Number(authority.parentRevision||0),
        memoryId:authority.memoryId,revision:Number(authority.revision||0),turnRange:clone(asObject(authority.turnRange)),sourceDigest:authority.sourceDigest,
        sourcePairsHash:authority.sourcePairsHash,editedTextHash:authority.editedTextHash,renderHash:authority.renderHash,contentHash:authority.contentHash
      }));
    };
    const createCanonicalManualAuthority = ({scope,parentRef,memory,batch,text='',status='draft',createdAt=''}) => {
      const body=string(text||'').trim();
      const authority={
        schema:CANONICAL_MANUAL_AUTHORITY_SCHEMA,origin:'user_edit',status:string(status||'draft'),scopeKey:string(scope?.scopeKey||''),
        parentKey:string(parentRef?.key||''),parentRevision:Number(parentRef?.revision||0),memoryId:string(memory?.memoryId||''),revision:Number(memory?.revision||0),
        turnRange:clone(asObject(memory?.turnRange)),sourceDigest:string(memory?.sourceDigest||''),sourcePairsHash:digest(stableReferenceJson(sourcePairs(batch))),
        editedTextHash:body?digest(body):'',renderHash:body?digest(body):'',contentHash:body?digest(body):'',createdAt:string(createdAt||nowIso()),updatedAt:nowIso(),adoptedAt:''
      };
      authority.authorityHash=canonicalManualAuthorityHash(authority);
      return authority;
    };
    const validateCanonicalManualAuthority = (memory,variant,scope) => {
      const authority=asObject(memory?.manualAuthority); const body=string(memory?.text||'').trim();
      const valid=authority.schema===CANONICAL_MANUAL_AUTHORITY_SCHEMA && authority.origin==='user_edit'
        && ['candidate','committed'].includes(string(authority.status||''))
        && string(authority.scopeKey||'')===string(scope?.scopeKey||'')
        && string(authority.memoryId||'')===string(memory?.memoryId||'') && Number(authority.revision||0)===Number(memory?.revision||0)
        && string(authority.sourceDigest||'')===string(memory?.sourceDigest||'') && string(authority.contentHash||'')===digest(body)
        && string(authority.editedTextHash||'')===digest(body) && string(authority.renderHash||'')===string(memory?.renderValidation?.contentHash||'')
        && memory?.renderValidation?.ok===true && canonicalManualAuthorityHash(authority)===string(authority.authorityHash||'')
        && string(variant?.origin||'')==='manual_edit' && !memory?.canonicalArtifact && !memory?.artifactValidation && !memory?.promptProvenance && !memory?.pipeline;
      if (!valid) throw new Error('canonical_manual_authority_invalid');
      return clone(authority);
    };
    const canonicalNextSlotRevision = async (scope,manifest,index,startTurn) => {
      const slot=asObject(index?.slots?.[String(startTurn)]); const ref=memoryRefForStart(manifest,startTurn);
      const revisions=[Number(ref?.revision||0),...asArray(ref?.history).map(row=>Number(row?.revision||0)),...asArray(slot.variants).map(row=>Number(row?.revision||0))];
      const prefix=key.memory(scope,startTurn,0).slice(0,-1);
      for (const storageKey of await storage.keys()) if (string(storageKey).startsWith(prefix)) revisions.push(Number(string(storageKey).slice(prefix.length)||0));
      return Math.max(0,...revisions.filter(Number.isFinite))+1;
    };
    const canonicalStoredDigest = value => digest(stableReferenceJson(value??null));
    const assertCanonicalStoredValue = async (storageKey,expected,code) => {
      const actual=await storage.getJson(storageKey,null);
      if (canonicalStoredDigest(actual)!==canonicalStoredDigest(expected)) { const error=new Error(code); error.code=code; throw error; }
      return actual;
    };
    const validateCanonicalAdoptionBinding = async ({scope,found,candidate}) => {
      if (string(found?.variant?.key||'')!==string(candidate?.key||found?.variant?.key||'')
        || Number(found?.variant?.revision||0)!==Number(candidate?.revision||0)
        || string(found?.variant?.memoryId||'')!==string(candidate?.memoryId||'')
        || string(found?.variant?.sourceDigest||'')!==string(candidate?.sourceDigest||'')) throw new Error('canonical_adoption_candidate_identity_mismatch');
      const deltaKey=string(found?.variant?.deltaKey||key.continuityDelta(scope,candidate?.memoryId,candidate?.revision));
      const delta=await storage.getJson(deltaKey,null);
      if (delta?.schema!==CONTINUITY_DELTA_SCHEMA||string(delta.memoryId||'')!==string(candidate?.memoryId||'')
        || Number(delta.revision||0)!==Number(candidate?.revision||0)||string(delta.sourceDigest||'')!==string(candidate?.sourceDigest||'')) throw new Error('canonical_adoption_delta_identity_mismatch');
      if (found?.variant?.origin==='manual_edit' && (string(delta?.manualAuthority?.authorityHash||'')!==string(candidate?.manualAuthority?.authorityHash||'')
        || string(delta?.manualAuthority?.contentHash||'')!==string(candidate?.manualAuthority?.contentHash||'')
        || string(delta?.manualAuthority?.sourceDigest||'')!==string(candidate?.sourceDigest||'')
        || Number(delta?.manualAuthority?.revision||0)!==Number(candidate?.revision||0))) throw new Error('canonical_adoption_delta_manual_authority_mismatch');
      return {deltaKey,deltaDigest:canonicalStoredDigest(delta),memoryId:string(candidate?.memoryId||''),revision:Number(candidate?.revision||0),sourceDigest:string(candidate?.sourceDigest||''),contentHash:string(candidate?.manualAuthority?.contentHash||digest(string(candidate?.text||'').trim())),authorityHash:string(candidate?.manualAuthority?.authorityHash||'')};
    };
    const restoreCanonicalStoredValue = async (storageKey,previous,code) => {
      if (previous==null) await storage.remove(storageKey); else await storage.setJson(storageKey,previous);
      return await assertCanonicalStoredValue(storageKey,previous??null,code);
    };
    const buildCanonicalAdoptionTargets = ({context,manifest,found,candidate,pairs,startTurn}) => {
      const oldRef=clone(memoryRefForStart(manifest,startTurn));
      if (!oldRef?.key) throw new Error('canonical_adoption_active_ref_missing');
      const nextCandidate=clone(candidate);
      if (nextCandidate.status!=='committed') { nextCandidate.status='committed'; nextCandidate.updatedAt=nowIso(); }
      if (found.variant.origin==='manual_edit') {
        const authority=validateCanonicalManualAuthority(nextCandidate,found.variant,context.scope);
        if (authority.status!=='committed'||!authority.adoptedAt) {
          nextCandidate.status='committed'; nextCandidate.updatedAt=nowIso();
          nextCandidate.manualAuthority={...authority,status:'committed',adoptedAt:authority.adoptedAt||nowIso(),updatedAt:nowIso()};
          nextCandidate.manualAuthority.authorityHash=canonicalManualAuthorityHash(nextCandidate.manualAuthority);
        }
      }
      const history=[...asArray(oldRef.history),{key:oldRef.key,memoryId:oldRef.memoryId,revision:oldRef.revision,sourceDigest:oldRef.sourceDigest,status:'inactive',supersededAt:nowIso()}].slice(-12);
      const nextManifest=clone(manifest);
      nextManifest.memories[String(startTurn)]=memoryRefFromStoredMemory(nextCandidate,found.variant.key,history,nextCandidate.createdAt||nowIso());
      nextManifest.memories[String(startTurn)].deltaKey=string(found.variant.deltaKey||key.continuityDelta(context.scope,nextCandidate.memoryId,nextCandidate.revision));
      refreshCanonicalFrontiers(nextManifest,pairs.length); nextManifest.updatedAt=nowIso();
      const nextIndex=clone(found.index); const slotKey=String(startTurn); const slot=asObject(nextIndex.slots?.[slotKey]);
      const variants=asArray(slot.variants).map(row=>{
        if (string(row.variantId||'')===string(found.variant.variantId||'')) return {...clone(row),status:'active',userPinned:true,origin:row.origin||'candidate_adopted',updatedAt:nowIso()};
        if (row.status==='active') return {...clone(row),status:'superseded',userPinned:true,origin:'user_demoted',updatedAt:nowIso()};
        return clone(row);
      });
      nextIndex.schema=CANONICAL_VARIANT_INDEX_SCHEMA; nextIndex.scopeKey=string(context.scope.scopeKey);
      nextIndex.slots[slotKey]={...clone(slot),activeVariantId:found.variant.variantId,variants,updatedAt:nowIso()}; nextIndex.updatedAt=nowIso();
      return {candidate:nextCandidate,manifest:nextManifest,index:nextIndex,oldRef};
    };
    const commitCanonicalAdoptionTransaction = async ({context,job,found,prepared,onPrepared}) => {
      const journalKey=key.canonicalAdoptionJournal(context.scope,job.jobId); let journal=await storage.getJson(journalKey,null);
      if (journal!=null && (journal.schema!==CANONICAL_ADOPTION_TRANSACTION_SCHEMA || string(journal.scopeKey||'')!==string(context.scope.scopeKey) || string(journal.jobId||'')!==string(job.jobId) || string(journal.candidateKey||'')!==string(found.variant.key))) throw new Error('canonical_adoption_journal_invalid');
      if (journal==null) {
        const binding=await validateCanonicalAdoptionBinding({scope:context.scope,found,candidate:prepared.candidate});
        journal={schema:CANONICAL_ADOPTION_TRANSACTION_SCHEMA,scopeKey:string(context.scope.scopeKey),jobId:string(job.jobId),candidateKey:string(found.variant.key),state:'prepared',
          previous:{candidate:await storage.getJson(found.variant.key,null),manifest:await storage.getJson(key.manifest(context.scope),null),index:await storage.getJson(key.canonicalVariantIndex(context.scope),null)},
          target:{candidate:clone(prepared.candidate),manifest:clone(prepared.manifest),index:clone(prepared.index)},binding,createdAt:nowIso(),updatedAt:nowIso()};
        journal.targetDigest=canonicalStoredDigest(journal.target); journal.previousDigest=canonicalStoredDigest(journal.previous);
        await storage.setJson(journalKey,journal); await assertCanonicalStoredValue(journalKey,journal,'CANONICAL_ADOPTION_JOURNAL_READBACK_FAILED');
      } else {
        if (string(journal.targetDigest||'')!==canonicalStoredDigest(journal.target)||string(journal.previousDigest||'')!==canonicalStoredDigest(journal.previous)) throw new Error('canonical_adoption_journal_digest_mismatch');
        const binding=await validateCanonicalAdoptionBinding({scope:context.scope,found,candidate:journal.target.candidate});
        if (canonicalStoredDigest(binding)!==canonicalStoredDigest(journal.binding)) throw new Error('canonical_adoption_journal_binding_mismatch');
      }
      if (typeof onPrepared==='function') await onPrepared(journal);
      const writes=[
        {key:found.variant.key,value:journal.target.candidate,code:'CANONICAL_ADOPTION_CANDIDATE_READBACK_FAILED'},
        {key:key.manifest(context.scope),value:journal.target.manifest,code:'CANONICAL_ADOPTION_MANIFEST_READBACK_FAILED'},
        {key:key.canonicalVariantIndex(context.scope),value:journal.target.index,code:'CANONICAL_ADOPTION_INDEX_READBACK_FAILED'}
      ];
      try {
        journal={...journal,state:'writing',updatedAt:nowIso()}; await storage.setJson(journalKey,journal); await assertCanonicalStoredValue(journalKey,journal,'CANONICAL_ADOPTION_JOURNAL_READBACK_FAILED');
        for (const entry of writes) { await storage.setJson(entry.key,entry.value); await assertCanonicalStoredValue(entry.key,entry.value,entry.code); }
        const committedBinding=await validateCanonicalAdoptionBinding({scope:context.scope,found,candidate:journal.target.candidate});
        if (canonicalStoredDigest(committedBinding)!==canonicalStoredDigest(journal.binding)) throw new Error('canonical_adoption_delta_changed_during_commit');
        journal={...journal,state:'committed',committedAt:nowIso(),updatedAt:nowIso()}; await storage.setJson(journalKey,journal); await assertCanonicalStoredValue(journalKey,journal,'CANONICAL_ADOPTION_JOURNAL_COMMIT_READBACK_FAILED');
        await storage.remove(journalKey); await assertCanonicalStoredValue(journalKey,null,'CANONICAL_ADOPTION_JOURNAL_CLEANUP_FAILED');
        return clone(journal.target);
      } catch(error) {
        const failures=[];
        for (const entry of [
          {key:found.variant.key,value:journal.previous.candidate,code:'CANONICAL_ADOPTION_CANDIDATE_ROLLBACK_FAILED'},
          {key:key.manifest(context.scope),value:journal.previous.manifest,code:'CANONICAL_ADOPTION_MANIFEST_ROLLBACK_FAILED'},
          {key:key.canonicalVariantIndex(context.scope),value:journal.previous.index,code:'CANONICAL_ADOPTION_INDEX_ROLLBACK_FAILED'}
        ]) { try { await restoreCanonicalStoredValue(entry.key,entry.value,entry.code); } catch(rollbackError) { failures.push(rollbackError); } }
        if (!failures.length) { try { await storage.remove(journalKey); await assertCanonicalStoredValue(journalKey,null,'CANONICAL_ADOPTION_JOURNAL_CLEANUP_FAILED'); } catch(rollbackError) { failures.push(rollbackError); } }
        if (failures.length) {
          try { const failed={...journal,state:'rollback_incomplete',rollbackErrors:failures.map(item=>compact(item?.message||item,300)),updatedAt:nowIso()}; await storage.setJson(journalKey,failed); } catch(_) {}
          const wrapped=new Error('canonical_adoption_rollback_incomplete'); wrapped.code='CANONICAL_ADOPTION_ROLLBACK_INCOMPLETE'; wrapped.cause=error; throw wrapped;
        }
        throw error;
      }
    };
`);

  rep('manual_narrative_delta_provider',
`    const executeStage = async (stageName, batch, previousStage = null, options = {}) => stageName === 'ariadne'
`,
`    const callManualNarrativeDeltaProvider = async (batch,canonicalText,options={}) => {
      const previousStage={schema:FULL_DRAFT_STAGE_SCHEMA,stage:'ariadne',ok:true,manualEdit:true,analysis:{summary:'User-authored canonical edit',constraints:[],risks:[]},draft:{rp_text:string(canonicalText||''),beats:[],do_not_reveal:[],pov_limits:[],notes:[]}};
      const stage=await callIto('plot_ito',batch,previousStage,{signal:options.signal,narrativeOnly:true,reason:'canonical_manual_edit'});
      const rawPatch=stage?.narrativePatch||stage?.patch?.narrative_patch||stage?.domain?.narrative_patch;
      const normalized=__libraNarrativeNormalizePatch(rawPatch);
      if (!normalized.ok) throw new Error('manual_narrative_delta_provider_failed:'+(normalized.error||'invalid_narrative_patch'));
      const narrativePatch=validateAndBindNarrativePatchEvidence(normalized.patch,{batch,previousStage});
      return {...stage,stage:'plot_ito',ok:true,narrativeOnly:true,stateOnly:true,narrativePatch};
    };

    const executeStage = async (stageName, batch, previousStage = null, options = {}) => stageName === 'ariadne'
`);

  repBetween('create_manual_edit_draft',
    '    const createCanonicalEditDraft = async identity => {',
    '    const saveCanonicalEditDraft = async ({ candidateId, text: editedText } = {}) => {',
`    const createCanonicalEditDraft = async identity => {
      assertPortableMemoryIdle();
      const context=await resolveContext(); const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
      const target=await resolveCanonicalTarget(context,manifest,identity); const batch=batchForStart(pairs,target.startTurn);
      if (batch.length!==BATCH_SIZE||sourceDigest(batch)!==target.memory.sourceDigest) throw new Error('canonical_source_digest_changed');
      const index=await loadCanonicalVariantIndex(context.scope,manifest);
      if (asArray(index?.slots?.[String(target.startTurn)]?.variants).some(item=>item.status==='candidate')) throw new Error('canonical_candidate_already_pending');
      if (await findPendingCanonicalChoice(context.scope,{startTurn:target.startTurn})) throw new Error('canonical_candidate_already_pending');
      const job=await beginCanonicalJob(context.scope,'edit_rebuild',{startTurns:[target.startTurn],total:1,message:'수정용 복사본을 생성합니다.'});
      const revision=await canonicalNextSlotRevision(context.scope,manifest,index,target.startTurn);
      const draftKey=key.memory(context.scope,target.startTurn,revision);
      if (await storage.getJson(draftKey,null)!=null) throw new Error('canonical_candidate_key_collision');
      const draft=stripCanonicalAutomaticReceipts(target.memory);
      draft.revision=revision; draft.status='candidate'; draft.runId=job.jobId; draft.embedding={status:'pending',projectionVersion:RETRIEVAL_PROJECTION_VERSION};
      draft.sections={}; draft.anchors={}; draft.retrieval={version:RETRIEVAL_PROJECTION_VERSION}; draft.createdAt=nowIso(); draft.updatedAt=nowIso();
      draft.manualAuthority=createCanonicalManualAuthority({scope:context.scope,parentRef:target.ref,memory:draft,batch,status:'draft',createdAt:draft.createdAt});
      draft.editProvenance={schema:CANONICAL_MANUAL_AUTHORITY_SCHEMA,parentKey:target.ref.key,parentRevision:target.ref.revision,copiedAt:nowIso(),authorityHash:draft.manualAuthority.authorityHash};
      await storage.setJson(draftKey,draft); await assertCanonicalStoredValue(draftKey,draft,'CANONICAL_EDIT_DRAFT_READBACK_FAILED');
      const variant=await registerCanonicalVariant(context.scope,manifest,draft,draftKey,{status:'candidate',origin:'manual_edit',parentVariantId:canonicalVariantId({...target.ref,scopeKey:context.scope.scopeKey}),userPinned:true,jobId:job.jobId,deltaKey:'',deltaStatus:'rebuild_pending',manualAuthorityHash:draft.manualAuthority.authorityHash});
      const beforeState=await loadContinuityState(context.scope,manifest,{requireCurrent:true}).catch(()=>null);
      const comparison={active:{variantId:canonicalVariantId({...target.ref,scopeKey:context.scope.scopeKey}),memoryId:target.memory.memoryId,revision:target.memory.revision,key:target.ref.key,sourceDigest:target.memory.sourceDigest,text:target.memory.text,summary:target.memory.summary},candidate:{variantId:variant.variantId,memoryId:draft.memoryId,revision:draft.revision,key:draftKey,sourceDigest:draft.sourceDigest,text:draft.text,summary:draft.summary,manualAuthority:clone(draft.manualAuthority)},beforeState:clone(beforeState),afterState:clone(beforeState),stateDiff:stateDiffSummary(beforeState,beforeState),stateError:'',createdAt:nowIso()};
      await updateCanonicalJob(context.scope,{state:'awaiting_edit',phase:'edit',candidateId:variant.variantId,comparison,cancellable:true,message:'복사본을 수정하세요. 원본 정본은 그대로 유지됩니다.'});
      state.canonicalJobAbortController=null; return clone(state.canonicalJob);
    };

`);

  repBetween('save_manual_edit_draft',
    '    const saveCanonicalEditDraft = async ({ candidateId, text: editedText } = {}) => {',
    '    const resolveCanonicalCandidate = async ({ jobId, decision } = {}) => {',
`    const saveCanonicalEditDraft = async ({ candidateId, text: editedText } = {}) => {
      assertPortableMemoryIdle();
      const context=await resolveContext(); const pairs=buildPairs(context.chat,context?.scope?.scopeKey||''); const manifest=await loadManifest(context.scope,pairs.length);
      const found=await findCanonicalVariant(context.scope,candidateId,manifest);
      if (!found.variant||found.variant.status!=='candidate'||found.variant.origin!=='manual_edit') throw new Error('canonical_edit_candidate_not_found');
      let draft=await storage.getJson(found.variant.key,null); if(!draft) throw new Error('canonical_edit_record_missing');
      const activeRef=memoryRefForStart(manifest,Number(draft.turnRange.start)); const activeMemory=await loadMemoryRef(activeRef); const batch=batchForStart(pairs,Number(draft.turnRange.start));
      if (!activeRef||activeRef.sourceDigest!==draft.sourceDigest||sourceDigest(batch)!==draft.sourceDigest) throw new Error('canonical_source_digest_changed');
      const nextText=stripFence(editedText||'').trim(); const renderValidation=validateCanonicalRenderedText(nextText);
      if (!renderValidation.ok) throw new Error('canonical_edit_render_invalid:'+renderValidation.issues.join('|'));
      await updateCanonicalJob(context.scope,{state:'running',phase:'edit_rebuild',cancellable:true,message:'수정본의 검색 데이터와 상태 delta를 재구축합니다.'});
      draft=stripCanonicalAutomaticReceipts(draft); draft.text=nextText; draft.summary=memorySummary(nextText); draft.recallKeys=recallKeys(nextText); draft.updatedAt=nowIso(); draft.renderValidation=clone(renderValidation);
      draft.manualAuthority=createCanonicalManualAuthority({scope:context.scope,parentRef:activeRef,memory:draft,batch,text:nextText,status:'candidate',createdAt:draft.manualAuthority?.createdAt||draft.createdAt});
      draft.editProvenance={schema:CANONICAL_MANUAL_AUTHORITY_SCHEMA,parentKey:activeRef.key,parentRevision:activeRef.revision,copiedAt:draft.editProvenance?.copiedAt||nowIso(),authorityHash:draft.manualAuthority.authorityHash};
      const projection=buildMemoryRetrievalProjection(draft); draft.sections=clone(projection.sections); draft.anchors=clone(projection.anchors); draft.retrieval={version:RETRIEVAL_PROJECTION_VERSION,sparseFields:clone(projection.sparseFields),textHashes:clone(projection.textHashes)};
      try { draft.embedding=await embedMemory(context.scope,draft,activeMemory); } catch(error) { draft.embedding={status:'retry_pending',reason:compact(error?.message||error,500),projectionVersion:RETRIEVAL_PROJECTION_VERSION}; }
      const settings=await loadSettings().catch(()=>Runtime.settings||{}); const stateStages=[]; const rebuildErrors=[];
      for (const stageName of ['character_ito','world_ito','plot_ito']) {
        if (!memoryStageEnabledForSettings(settings,stageName)) continue;
        try { stateStages.push(stageName==='plot_ito'?await callManualNarrativeDeltaProvider(batch,nextText,{signal:state.canonicalJobAbortController?.signal}):await callContinuityDeltaProvider(stageName,batch,nextText,{signal:state.canonicalJobAbortController?.signal})); }
        catch(error) { rebuildErrors.push(stageName+':'+compact(error?.message||error,500)); }
      }
      const stateRebuildError=rebuildErrors.join(' | ');
      await storage.setJson(found.variant.key,draft); const draftReadback=await assertCanonicalStoredValue(found.variant.key,draft,'CANONICAL_EDIT_CANDIDATE_READBACK_FAILED');
      validateCanonicalManualAuthority(draftReadback,found.variant,context.scope);
      const deltaValue={...continuityDeltaFromStageObjects(draftReadback,stateStages),rebuildError:stateRebuildError,manualAuthority:{schema:CANONICAL_MANUAL_AUTHORITY_SCHEMA,authorityHash:draft.manualAuthority.authorityHash,contentHash:draft.manualAuthority.contentHash,sourceDigest:draft.sourceDigest,revision:draft.revision}};
      const savedDelta=await saveContinuityDelta(context.scope,draftReadback,deltaValue);
      if (string(savedDelta.delta?.sourceDigest||'')!==string(draft.sourceDigest)||Number(savedDelta.delta?.revision||0)!==Number(draft.revision)||string(savedDelta.delta?.manualAuthority?.authorityHash||'')!==string(draft.manualAuthority.authorityHash)) throw new Error('canonical_edit_delta_binding_failed');
      const refreshedVariant=await registerCanonicalVariant(context.scope,manifest,draftReadback,found.variant.key,{...found.variant,status:'candidate',deltaKey:savedDelta.key,deltaStatus:stateRebuildError?'partial':'ready',manualAuthorityHash:draft.manualAuthority.authorityHash});
      const variantReadback=await findCanonicalVariant(context.scope,refreshedVariant.variantId,manifest);
      if (!variantReadback.variant||variantReadback.variant.status!=='candidate'||string(variantReadback.variant.deltaKey||'')!==string(savedDelta.key)||string(variantReadback.variant.manualAuthorityHash||'')!==string(draft.manualAuthority.authorityHash)) throw new Error('canonical_edit_variant_readback_failed');
      const comparison=await buildCanonicalComparison({context,manifest,activeRef,activeMemory,candidateMemory:draftReadback,candidateVariant:variantReadback.variant}); comparison.stateError||=stateRebuildError; comparison.candidate.manualAuthority=clone(draft.manualAuthority);
      state.canonicalComparisonCache.set(state.canonicalJob.jobId,clone(comparison));
      return await updateCanonicalJob(context.scope,{state:'awaiting_choice',phase:'compare',completed:1,cancellable:false,comparison,message:stateRebuildError?'수정본은 저장됐지만 상태 재분석에 경고가 있습니다. 비교 후 결정하세요.':'수정본과 상태 변화를 비교한 뒤 채택 여부를 선택하세요.'});
    };

`);

  rep('adoption_manual_authority_preflight',
`      const candidate = await storage.getJson(found.variant.key, null);
      if (!candidate) throw new Error('canonical_candidate_record_missing');
`,
`      const candidate = await storage.getJson(found.variant.key, null);
      if (!candidate) throw new Error('canonical_candidate_record_missing');
      if (found.variant.origin==='manual_edit') validateCanonicalManualAuthority(candidate,found.variant,context.scope);
      await validateCanonicalAdoptionBinding({scope:context.scope,found,candidate});
`);

  rep('resume_adopting_job',
`    const resumeCanonicalJob = async ({ jobId = '' } = {}) => {
      const context = await resolveContext(); const job = await loadCanonicalJob(context.scope, jobId);
      if (!job || job.state !== 'interrupted') throw new Error('canonical_job_not_resumable');
      if (job.kind === 'regenerate') return await regenerateCanonicalMemory({ ...asObject(job.targetMemory), resumeJobId: job.jobId });
      return await runManagedScan(job.kind, { startTurns: job.targetStarts, resumeJobId: job.jobId });
    };
`,
`    const resumeCanonicalJob = async ({ jobId = '' } = {}) => {
      const context = await resolveContext(); const job = await loadCanonicalJob(context.scope, jobId);
      if (!job) throw new Error('canonical_job_not_resumable');
      if (job.state === 'adopting') return await resolveCanonicalCandidate({ jobId: job.jobId, decision: 'adopt' });
      if (job.state !== 'interrupted') throw new Error('canonical_job_not_resumable');
      if (job.kind === 'regenerate') return await regenerateCanonicalMemory({ ...asObject(job.targetMemory), resumeJobId: job.jobId });
      return await runManagedScan(job.kind, { startTurns: job.targetStarts, resumeJobId: job.jobId });
    };
`);

  rep('adopting_recovery_button',
`    } else if (job.state === 'interrupted') {
      body.appendChild(guiEl('button', { class: 'sga-btn good', type: 'button', text: '중단된 작업 재개', onClick: () => { void LibraMemoryCore.resumeCanonicalJob({ jobId: job.jobId }).catch(error => guiSetStatus(error.message || String(error), true, true)); } }));
`,
`    } else if (job.state === 'adopting') {
      body.appendChild(guiEl('button', { class: 'sga-btn good', type: 'button', text: '중단된 채택 복구', onClick: () => { void LibraMemoryCore.resumeCanonicalJob({ jobId: job.jobId }).catch(error => guiSetStatus(error.message || String(error), true, true)); } }));
    } else if (job.state === 'interrupted') {
      body.appendChild(guiEl('button', { class: 'sga-btn good', type: 'button', text: '중단된 작업 재개', onClick: () => { void LibraMemoryCore.resumeCanonicalJob({ jobId: job.jobId }).catch(error => guiSetStatus(error.message || String(error), true, true)); } }));
`);

  rep('manual_authority_gui_copy',
`guiEl('div', { class: 'sga-note', text: '원문 U+A, TURN, digest와 provenance는 잠겨 있으며 이 텍스트만 새 버전에 저장됩니다.' })`,
`guiEl('div', { class: 'sga-note', text: '원문 U+A, TURN, digest와 provenance는 잠깁니다. 7개 정본 섹션 제목을 유지한 사용자 작성본만 새 후보로 저장됩니다.' })`);

  rep('manual_authority_candidate_label',
`guiEl('section', {}, [guiEl('h3', { text: '새 후보' }), guiEl('pre', { text: comparison.candidate?.text || '' })`,
`guiEl('section', {}, [guiEl('h3', { text: comparison.candidate?.manualAuthority ? '새 후보 · 사용자 작성 정본' : '새 후보' }), guiEl('pre', { text: comparison.candidate?.text || '' })`);

  repBetween('atomic_candidate_adoption',
    "      await updateCanonicalJob(context.scope, { state: 'adopting', phase: alreadySwitched ? 'derived_rebuild' : 'manifest_switch', cancellable: false, message: '후보를 활성 정본으로 전환하고 파생 뷰를 재구축합니다.' });",
    '      state.recallCatalogCache.delete(string(context.scope.scopeKey)); state.recallCatalogBlockCache.clear();',
`      const existingAdoptionJournal=await storage.getJson(key.canonicalAdoptionJournal(context.scope,job.jobId),null);
      if (!alreadySwitched||existingAdoptionJournal) {
        const prepared=existingAdoptionJournal?null:buildCanonicalAdoptionTargets({context,manifest,found,candidate,pairs,startTurn});
        const committed=await commitCanonicalAdoptionTransaction({context,job,found,prepared,onPrepared:async()=>{
          await updateCanonicalJob(context.scope,{state:'adopting',phase:'manifest_switch',cancellable:false,message:'후보를 활성 정본으로 전환하고 파생 뷰를 재구축합니다.'});
        }});
        for (const field of Object.keys(candidate)) delete candidate[field]; Object.assign(candidate,clone(committed.candidate));
        for (const field of Object.keys(manifest)) delete manifest[field]; Object.assign(manifest,clone(committed.manifest));
      } else {
        await updateCanonicalJob(context.scope,{state:'adopting',phase:'derived_rebuild',cancellable:false,message:'채택된 정본의 파생 뷰를 재구축합니다.'});
      }
`);

  return { source, labels };
};
