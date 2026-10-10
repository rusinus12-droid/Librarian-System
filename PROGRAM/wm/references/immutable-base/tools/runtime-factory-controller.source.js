    // Preparation is read-only against live state. Only a captured owner can
    // supply the baseline; callers cannot provide roots or native identities.
    let reanalysisPreparationRunning = false;
    let reanalysisSequence = 0;
    let preparedReanalyses = new WeakMap();
    let publicationTickets = new WeakMap();
    runtimeDisposers.push(() => { preparedReanalyses = new WeakMap(); publicationTickets = new WeakMap(); });
    let publicationBlocked = false;
    let turnReanalysisActionRunning = false;
    const turnReanalysisAvailability = (canonicalMemoryId, ignorePresentationBusy = false) => {
        if (publicationBlocked) return {eligible:false,reason:'저장 결과가 불확실합니다. 재시도하지 말고 정본 상태를 확인해 주세요.'};
        if ((!ignorePresentationBusy && turnReanalysisActionRunning) || reanalysisPreparationRunning) return {eligible:false,reason:'턴 전체 재분석이 진행 중입니다.'};
        const owner = LatestTurnBaselineOwner.inspect();
        if (owner.state !== 'ready') return {eligible:false,reason:owner.reason === 'already_reanalyzed_until_next_turn'
            ? '이 턴의 재분석을 완료했습니다. 다음 정상 턴까지 다시 실행할 수 없습니다.'
            : '현재 실행에서 분석이 완료되고 안전한 기준본이 남아 있는 마지막 턴만 지원합니다. 이전 턴·재시작 후 기록은 지원하지 않습니다.'};
        if (!canonicalMemoryId || owner.canonicalMemoryId !== canonicalMemoryId) return {eligible:false,reason:'이전 턴이나 합쳐진 기억은 지원하지 않습니다. 현재 실행에서 안전하게 소유한 마지막 턴만 재분석할 수 있습니다.'};
        try {
            const baseline = LatestTurnBaselineOwner.take(canonicalMemoryId);
            if (JSON.parse(baseline.postRaw).entries?.some(entry => entry.comment === 'lmai_user_dlc')) return {eligible:false,reason:'사용자 추가 요소가 있는 대화의 턴 재분석은 아직 지원하지 않습니다.'};
        } catch (_) { return {eligible:false,reason:'안전한 기준본을 확인할 수 없어 재분석할 수 없습니다.'}; }
        return {eligible:true,reason:'현재 원문을 다시 읽어 기억·인물·세계·내러티브 전체를 재분석합니다. 모델 분석 비용이 발생할 수 있습니다.'};
    };
    const getPublicationMetadata = ticket => {
        const record = ticket && publicationTickets.get(ticket);
        if (!record || record.state !== 'publishing') throw new Error('invalid_publication_ticket');
        return copySnapshot(record.metadata);
    };
    const prepareLatestWholeTurn = async (canonicalMemoryId, isViewCurrent = () => true, signal = null) => {
        assertRuntimeActive();
        if (runtimeDetached || reanalysisPreparationRunning || publicationBlocked) throw new Error('reanalysis_preparation_unavailable');
        if (!isViewCurrent()) throw new Error('reanalysis_view_changed');
        const owner = LatestTurnBaselineOwner.take(canonicalMemoryId);
        if (JSON.parse(owner.postRaw).entries?.some(entry => entry.comment === 'lmai_user_dlc')) throw new Error('reanalysis_user_dlc_unsupported');
        const configBytes = JSON.stringify(MemoryEngine.CONFIG);
        let context = null;
        const cancel = () => context?.dispose();
        signal?.addEventListener('abort', cancel, {once:true});
        const awaitCandidateWork = async work => {
            const signals = [signal, contextAbort.signal].filter(Boolean);
            const listeners = [];
            try {
                return await new Promise((resolve,reject) => {
                    Promise.resolve(work).then(resolve,reject);
                    for (const source of signals) {
                        const onAbort = () => reject(new Error('reanalysis_cancelled'));
                        if (source.aborted) onAbort();
                        else { source.addEventListener('abort',onAbort,{once:true}); listeners.push([source,onAbort]); }
                    }
                });
            } finally { for (const [source,onAbort] of listeners) source.removeEventListener('abort',onAbort); }
        };
        reanalysisPreparationRunning = true;
        const resolveSource = chat => {
            const messages = getChatMessages(chat);
            const resolve = (ids, user) => {
                const matches = messages.filter(message => normalizeCanonicalMessageIds([message?.id,message?.messageId,message?.m_id,message?.uuid,message?.key,message?.chatId,message?.generationInfo?.generationId]).some(id => ids.includes(id)));
                if (matches.length !== 1) throw new Error('source_native_identity_ambiguous');
                const message = matches[0], role = String(message.role || '').toLowerCase();
                if ((user ? role !== 'user' : !['char','assistant'].includes(role)) || message.disabled || message.isComment || message.isOOC) throw new Error('source_role_unavailable');
                const strings = ['data','content','text'].filter(key => typeof message[key] === 'string').map(key => message[key]);
                if (!strings.length || strings.some(text => text !== strings[0])) throw new Error('source_bytes_ambiguous');
                return strings[0];
            };
            return {userText:resolve(owner.sourceReceipt.userIds,true),assistantText:resolve(owner.sourceReceipt.assistantIds,false)};
        };
        const fresh = async expectedSource => {
            assertRuntimeActive();
            if (signal?.aborted || !isViewCurrent()) throw new Error('reanalysis_view_changed');
            if (!LatestTurnBaselineOwner.isCurrent(owner)) throw new Error('reanalysis_owner_changed');
            if (JSON.stringify(MemoryEngine.CONFIG) !== configBytes) throw new Error('reanalysis_config_changed');
            const active = await resolveActiveChatContext(null, {expectedCanonicalScope:owner.scopeKey,expectedGeneration:owner.resetGeneration});
            assertRuntimeActive();
            if (!active.ok || !active.chat || !LatestTurnBaselineOwner.checkTopology(active.chat)) throw new Error('reanalysis_native_scope_changed');
            const source = resolveSource(active.chat);
            if (expectedSource && JSON.stringify(source) !== JSON.stringify(expectedSource)) throw new Error('reanalysis_source_changed');
            const read = await LibraDataStorage.readVerified(owner.scopeKey);
            if (!read.ok || read.raw !== owner.postRaw || read.resetGeneration !== owner.resetGeneration) throw new Error('reanalysis_canonical_changed');
            if (!isViewCurrent() || !LatestTurnBaselineOwner.isCurrent(owner) || JSON.stringify(MemoryEngine.CONFIG) !== configBytes) throw new Error('reanalysis_owner_or_config_changed');
            return {active,source};
        };
        try {
            const {active,source} = await fresh();
            const character = copySnapshot(active.char);
            character.chats[active.chatIndex] = copySnapshot(active.chat);
            const database = await RisuCompat.database.get(['selectedPersona','personas']);
            await fresh(source);
            context = await createLibraRuntime({mode:'detached',snapshot:{character,characterIndex:active.charIdx,chatIndex:active.chatIndex,database,
                storageEntries:owner.beforeRaw === null ? [] : [[LibraDataStorage.storageKeyFor(owner.scopeKey),owner.beforeRaw]]},
                scheduler,provider:async (url,init) => { await fresh(source); return RisuCompat.request(url,init); }});
            if (signal?.aborted) { context.dispose(); throw new Error('reanalysis_view_changed'); }
            const release = () => context?.dispose(); runtimeDisposers.push(release);
            try {
                await awaitCandidateWork(context.initialize({config:JSON.parse(configBytes)}));
                const result = await awaitCandidateWork(context.stageWholeTurn({analysisId:'explicit-reanalysis:'+Date.now()+':'+(++reanalysisSequence),turn:owner.turn,
                    canonicalMemoryId:owner.canonicalMemoryId,sourceReceipt:owner.sourceReceipt,...source}));
                if (!result.domainLedger?.complete || result.domainLedger.domains.length !== 16) throw new Error('reanalysis_incomplete_domains');
                await fresh(source);
                if (result.writes.some(row => !['canonical_knowledge','derived_cache_rebuild_only'].includes(row.kind))) throw new Error('reanalysis_unknown_auxiliary_write');
                const receipt = Object.freeze({});
                const metadata = {schema:'wm.reanalysis_revision.v1',analysisId:result.sourceObservation.analysisId,
                    scopeKey:owner.scopeKey,resetGeneration:owner.resetGeneration,canonicalMemoryId:owner.canonicalMemoryId,
                    sourceReference:{...copySnapshot(result.sourceObservation),nativeSource:copySnapshot(source)},domainLedger:copySnapshot(result.domainLedger)};
                preparedReanalyses.set(receipt,{state:'prepared',owner,source,configBytes,resolveSource,isViewCurrent,
                    entries:copySnapshot(result.entries),metadata});
                return {state:'staged_unverified',receipt,domainLedger:copySnapshot(result.domainLedger),publicationEligible:true};
            } finally { const index=runtimeDisposers.indexOf(release); if(index>=0) runtimeDisposers.splice(index,1); }
        } finally { signal?.removeEventListener('abort',cancel); context?.dispose(); reanalysisPreparationRunning = false; }
    };

    const publishLatestWholeTurn = async receipt => {
        assertRuntimeActive();
        const record = receipt && preparedReanalyses.get(receipt);
        if (!record) throw new Error('invalid_receipt');
        if (record.state !== 'prepared') throw new Error('receipt_already_consumed');
        record.state = 'consumed';
        if (runtimeDetached || publicationBlocked || reanalysisPreparationRunning) return {state:'rejected',writeIssued:false,reason:'publication_unavailable'};
        const {owner,source,configBytes,metadata} = record;
        let ticket,active,saveResult;
        const current = async () => {
            assertRuntimeActive();
            if (record.isViewCurrent?.() === false || !LatestTurnBaselineOwner.isCurrent(owner) || !RuntimeStateLease.isCurrent(owner.lease)) return false;
            if (JSON.stringify(MemoryEngine.CONFIG) !== configBytes) return false;
            const resolved = await resolveActiveChatContext(null,{expectedCanonicalScope:owner.scopeKey,expectedGeneration:owner.resetGeneration});
            if (!resolved.ok || !resolved.chat || !LatestTurnBaselineOwner.checkTopology(resolved.chat)) return false;
            if (JSON.stringify(record.resolveSource(resolved.chat)) !== JSON.stringify(source)) return false;
            if (record.isViewCurrent?.() === false || !LatestTurnBaselineOwner.isCurrent(owner) || JSON.stringify(MemoryEngine.CONFIG) !== configBytes) return false;
            active = resolved; return true;
        };
        try {
            if (!await current()) return {state:'rejected',writeIssued:false,reason:'reanalysis_precondition_changed'};
            const before = await LibraDataStorage.readVerified(owner.scopeKey);
            if (!before.ok || before.raw !== owner.postRaw || before.resetGeneration !== owner.resetGeneration || !await current()) return {state:'rejected',writeIssued:false,reason:'reanalysis_canonical_or_owner_changed'};
            ticket = LatestTurnBaselineOwner.claimPublication(owner);
            record.state = 'publishing'; publicationTickets.set(ticket,record);
            saveResult = await LibraDataStorage.saveVerified(owner.scopeKey,record.entries,{
                expectedRaw:owner.postRaw,expectedGeneration:owner.resetGeneration,
                reanalysisPublicationTicket:ticket,isCurrent:current});
        } catch (error) {
            // saveVerified contains all physical-write errors; exceptions before it are preflight failures.
            if (!ticket) return {state:'rejected',writeIssued:false,reason:String(error.message || error)};
            saveResult = {ok:false,uncertain:true,reason:String(error.message || error)};
        } finally {
            if (ticket) publicationTickets.delete(ticket);
            record.state = 'consumed';
        }
        if (!saveResult.ok && !saveResult.uncertain) {
            LatestTurnBaselineOwner.invalidate('publication_prewrite_rejected');
            return {state:'rejected',writeIssued:false,reason:saveResult.reason};
        }
        // Never compensate or retry a possibly issued write. A fresh read is the only authority.
        const read = await LibraDataStorage.readVerified(owner.scopeKey);
        let accepted = false;
        if (read.ok && read.resetGeneration === owner.resetGeneration) {
            try {
                const root = JSON.parse(read.raw);
                accepted = root.scopeKey === owner.scopeKey && JSON.stringify(root.reanalysisRevision) === JSON.stringify(metadata)
                    && JSON.stringify(root.entries) === JSON.stringify(record.entries);
            } catch (_) {}
        }
        if (!accepted) {
            publicationBlocked = true;
            LatestTurnBaselineOwner.invalidate('publication_outcome_uncertain');
            return {state:'uncertain',writeIssued:true,reason:read.ok?'different_canonical_root':'canonical_read_unavailable',analysisId:metadata.analysisId,runtimeRefreshed:false};
        }
        let runtimeRefreshed = false;
        try {
            // A verified durable result does not authorize reloading a different/currently edited view.
            if (await current()) {
                const runtimeScope = getChatRuntimeScopeKey(active.chat,active.char);
                const cacheKeys = [runtimeScope,'hash:'+stableHash(runtimeScope)];
                for (const key of cacheKeys) { MemoryState.hmeScopeIndexByScope.delete(key); MemoryState.hmeGraphIndexByScope.delete(key); MemoryState.hmeGraphStaleRebuildByScope.delete(key); }
                MemoryState.invalidateTypedHmeSourceGraph?.();
                reloadChatScopedRuntime(read.entries,active.chat.id || active.chat.chatId,{scopeKey:getChatRuntimeScopeKey(active.chat,active.char),
                    resetSessionCaches:false,resetScopedState:true,forceWorldReload:true,restoreScopeSnapshot:false});
                runtimeRefreshed = await MemoryEngine.refreshReanalysisDerived(read.entries,runtimeScope,() => !runtimeDisposed && record.isViewCurrent?.() !== false && RuntimeStateLease.isCurrent(owner.lease) && LatestTurnBaselineOwner.isCurrent(owner) && JSON.stringify(MemoryEngine.CONFIG) === configBytes);
            }
        } catch (_) {}
        LatestTurnBaselineOwner.invalidate('already_reanalyzed_until_next_turn');
        record.entries = null;
        return {state:'committed',writeIssued:true,verified:true,analysisId:metadata.analysisId,runtimeRefreshed,
            repeatReason:'already_reanalyzed_until_next_turn'};
    };
