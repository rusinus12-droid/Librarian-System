    // One private action dispatcher per live runtime. Public tickets contain no
    // native source, canonical payload, lower-level publication receipt or view callback.
    if (!runtimeDetached) {
        let activeHealthReanalysisAbort = null;
        const viewIsCurrent = selection => typeof selection?.isViewCurrent === 'function'
            && selection.isViewCurrent() === true && selection.signal?.aborted !== true;
        const rejectReanalysis = reason => ({state:'rejected',status:'blocked',writeIssued:false,reason});
        const previewHistoricalMerge = async selection => {
            const before = await ManagementReviewCore.read(selection.binding,{isViewCurrent:()=>viewIsCurrent(selection)});
            if (!viewIsCurrent(selection)) return {allowed:false,reason:'owner_view_changed'};
            const source = ColdStartManager.snapshotHistoricalSource(before.context.chat);
            if (!source.analyzableMessageCount) return {allowed:false,reason:'historical_source_unavailable'};
            return {allowed:true,owner:'WM',scopeKey:selection.binding.scopeKey,model:true,mode:'whole_conversation_merge',
                units:[{key:'whole_conversation_merge',start:1,end:source.analyzableMessageCount,label:'전체 대화 보강 병합'}],
                warning:'전체 대화 보강 병합 · 약 '+source.estimatedCalls+'회 이상 모델 호출 · 특정 턴 교체 아님',
                source,configBytes:JSON.stringify(MemoryEngine.CONFIG),expectedRaw:before.raw,binding:selection.binding,
                isViewCurrent:selection.isViewCurrent,signal:selection.signal};
        };
        const applyHistoricalMerge = async (proof,current) => {
            let mutationStarted = false, selectionInvalidated = false;
            // Until explicit approval/admission, retain the exact preview guard.
            // Only the real admitted job may supply the private branded capture.
            let admittedAnalysisConfig = null;
            const readSelected = async (checkCanonical = true) => {
                if (selectionInvalidated) return null;
                const invalid = () => {selectionInvalidated=true;return null;};
                try {
                    if (!current() || (admittedAnalysisConfig
                        ? !isWmAnalysisConfigCurrent(admittedAnalysisConfig, MemoryEngine.CONFIG)
                        : JSON.stringify(MemoryEngine.CONFIG) !== proof.configBytes)) return invalid();
                    const read = await ManagementReviewCore.read(proof.binding,{isViewCurrent:current});
                    if (selectionInvalidated || !current() || (checkCanonical && read.raw !== proof.expectedRaw)
                        || (admittedAnalysisConfig
                            ? !isWmAnalysisConfigCurrent(admittedAnalysisConfig, MemoryEngine.CONFIG)
                            : JSON.stringify(MemoryEngine.CONFIG) !== proof.configBytes)) return invalid();
                    const source = ColdStartManager.snapshotHistoricalSource(read.context.chat);
                    if (source.sourceLabel !== proof.source.sourceLabel || source.sourceBackingPath !== proof.source.sourceBackingPath
                        || source.sourceBytes !== proof.source.sourceBytes) return invalid();
                    return selectionInvalidated ? null : read.context;
                } catch (_) { return invalid(); }
            };
            try {
                if (!await readSelected()) return rejectReanalysis('historical_selection_changed');
                const result = await ColdStartManager.reanalyzeHistoricalConversation({
                    returnOutcome:true,trigger:'manual_gui',
                    reason:'전체 대화에서 검증된 보강분을 기존 정본에 병합합니다. 특정 턴의 교체·복원은 아닙니다.',
                    selectionCurrent:async()=>!!await readSelected(),
                    resolveSelectionTarget:async()=>{
                        const context = await readSelected();
                        if (!context) throw new Error('historical_selection_changed');
                        return context;
                    },
                    onAnalysisAdmitted:config=>{
                        if (!isWmAnalysisConfigCurrent(config, MemoryEngine.CONFIG)) throw new Error('historical_analysis_capture_invalid');
                        admittedAnalysisConfig = config;
                    },
                    onMutationStarted:()=>{mutationStarted=true;}
                });
                if (result?.canonicalVerified === true && result?.committed === true)
                    return {...result,mode:'whole_conversation_merge',viewCurrent:!!await readSelected(false)};
                if (result?.writeIssued === false && result?.state === 'rejected') return {...result,mode:'whole_conversation_merge'};
                return {state:'uncertain',status:'uncertain',mode:'whole_conversation_merge',reason:'legacy_merge_outcome_unverified'};
            } catch (_) {
                return mutationStarted ? {state:'uncertain',status:'uncertain',mode:'whole_conversation_merge',reason:'legacy_merge_outcome_unverified'}
                    : {...rejectReanalysis('historical_analysis_unavailable'),mode:'whole_conversation_merge'};
            }
        };
        wmHealthOrchestrator = MemorySuiteHealthRecovery.createOrchestrator({
            inspect: async selection => {
                if (!viewIsCurrent(selection)) throw new Error('management_view_closed');
                return ManagementReviewCore.inspect(selection.binding,{isViewCurrent:()=>viewIsCurrent(selection)});
            },
            derivedCache: {
                preview: async selection => {
                    if (!viewIsCurrent(selection)) return {allowed:false,reason:'owner_view_changed'};
                    const before = await ManagementReviewCore.read(selection.binding,{isViewCurrent:()=>viewIsCurrent(selection)});
                    const ticket = await ManagementReviewCore.previewRepair(selection.binding,{isViewCurrent:()=>viewIsCurrent(selection)});
                    if (!viewIsCurrent(selection) || ticket.allowed !== true) return {allowed:false,reason:'preview_unavailable'};
                    return {allowed:true,owner:'WM',scopeKey:selection.binding.scopeKey,model:false,
                        warning:'Derived cache only; no source write or model request.',
                        ticket,expectedRaw:before.raw,binding:selection.binding,isViewCurrent:selection.isViewCurrent};
                },
                apply: async (proof,guard) => {
                    const current = () => guard.isCurrent() && proof.isViewCurrent() === true;
                    let applyStarted = false;
                    try {
                        const before = await ManagementReviewCore.read(proof.binding,{isViewCurrent:current});
                        if (!current() || before.raw !== proof.expectedRaw)
                            return {status:'blocked',writeIssued:false,reason:'canonical_changed'};
                        applyStarted = true;
                        return await ManagementReviewCore.repairDerivedCache(proof.ticket,{isViewCurrent:current});
                    } catch (_) {
                        return applyStarted ? {status:'uncertain',reason:'verification_incomplete'}
                            : {status:'blocked',writeIssued:false,reason:'owner_snapshot_unavailable'};
                    }
                },
                clear:()=>ManagementReviewCore.releaseHealth()
            },
            reanalysis: {
                preview: async selection => {
                    if (!viewIsCurrent(selection)) return {allowed:false,reason:'owner_view_changed'};
                    if (selection.mode === 'whole_conversation_merge') return previewHistoricalMerge(selection);
                    if (selection.mode && selection.mode !== 'latest_owned_turn') return {allowed:false,reason:'unsupported_reanalysis_mode'};
                    const id = String(selection.canonicalMemoryId || '');
                    const availability = turnReanalysisAvailability(id,true);
                    if (!availability.eligible) return {allowed:false,reason:'latest_owned_turn_unavailable'};
                    const before = await ManagementReviewCore.read(selection.binding,{isViewCurrent:()=>viewIsCurrent(selection)});
                    if (!viewIsCurrent(selection)) return {allowed:false,reason:'owner_view_changed'};
                    const owner = LatestTurnBaselineOwner.take(id);
                    if (owner.scopeKey !== selection.binding.scopeKey || owner.postRaw !== before.raw)
                        return {allowed:false,reason:'canonical_changed'};
                    return {allowed:true,owner:'WM',scopeKey:owner.scopeKey,model:true,
                        units:[{key:id,start:owner.turn,end:owner.turn,label:'Latest owned turn'}],
                        warning:'Explicit whole-turn analysis may use the configured model.',
                        canonicalMemoryId:id,expectedRaw:before.raw,binding:selection.binding,
                        isViewCurrent:selection.isViewCurrent,signal:selection.signal};
                },
                apply: async (proof,guard) => {
                    const abort = new AbortController(); activeHealthReanalysisAbort = abort;
                    const cancel = () => abort.abort();
                    proof.signal?.addEventListener('abort',cancel,{once:true});
                    if (proof.signal?.aborted) cancel();
                    const current = () => guard.isCurrent() && !abort.signal.aborted && proof.isViewCurrent() === true;
                    let publicationStarted = false;
                    try {
                        if (!current()) return rejectReanalysis('owner_view_changed');
                        if (proof.mode === 'whole_conversation_merge') return await applyHistoricalMerge(proof,current);
                        const before = await ManagementReviewCore.read(proof.binding,{isViewCurrent:current});
                        if (!current() || before.raw !== proof.expectedRaw) return rejectReanalysis('canonical_changed');
                        const prepared = await prepareLatestWholeTurn(proof.canonicalMemoryId,current,abort.signal);
                        if (!current()) return rejectReanalysis('owner_view_changed');
                        publicationStarted = true;
                        const result = await publishLatestWholeTurn(prepared.receipt);
                        return {...result,committed:result.state === 'committed' && result.verified === true,
                            status:result.state === 'committed' ? 'verified' : result.state === 'uncertain' ? 'uncertain' : 'blocked'};
                    } catch (error) {
                        if (publicationStarted) {
                            publicationBlocked = true;
                            return {state:'uncertain',status:'uncertain',reason:'verification_incomplete',runtimeRefreshed:false};
                        }
                        const reason = String(error?.message || '');
                        return rejectReanalysis(reason.includes('user_dlc_unsupported') ? 'user_dlc_unsupported'
                            : /incomplete_domains|detached_domain/.test(reason) ? 'incomplete_domains'
                            : !current() ? 'owner_view_changed' : 'analysis_unavailable');
                    } finally {
                        proof.signal?.removeEventListener('abort',cancel);
                        if (activeHealthReanalysisAbort === abort) activeHealthReanalysisAbort = null;
                    }
                },
                clear:()=>activeHealthReanalysisAbort?.abort()
            }
        });
        runtimeDisposers.push(()=>wmHealthOrchestrator.clear());
    }
