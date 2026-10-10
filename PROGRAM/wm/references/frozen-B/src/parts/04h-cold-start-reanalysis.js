        const analyzeConversationMessages = async (msgs, taskLabel = 'cold-start', options = {}) => {
            if (!Array.isArray(msgs) || msgs.length === 0) return null;
            const isColdStartTask = String(taskLabel || '').startsWith('cold-start');
            const isReanalysisTask = String(taskLabel || '').startsWith('cold-reanalysis');
            const shouldUseFastPath = isColdStartTask || isReanalysisTask;
            const chunks = buildAnalysisMessageChunks(msgs, shouldUseFastPath ? 40 : 25);
            const fastLlm = shouldUseFastPath ? buildFastAnalysisProfile(MemoryEngine.CONFIG, { maxCompletionTokens: 2400, routeKey: 'coldStartChunkSummary', fallbackProfile: 'aux' }) : null;
            const activityContext = {
                scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                activityDashboard: MemoryEngine.CONFIG.activityDashboard
            };

            LMAI_GUI.toast(`총 ${chunks.length}개 청크 병렬 분석 시작...`);
            ActivityDashboardCore.update(activityContext, {
                phase: taskLabel,
                status: 'running',
                progress: 24,
                step: '청크 분석',
                stepStatus: 'running',
                message: `대화 청크 ${chunks.length}개를 분석합니다.`
            });

            let completedChunkCount = 0;
            const chunkResults = await runResourceBoundSettledPool(chunks, (chunk, i) => {
                const chunkText = buildAnalysisChunkText(chunk, { evidenceMode: 'assistant_canonical' });
                return runMaintenanceLLM(() =>
                    (async () => {
                        if (typeof options.isCurrent === 'function') await requireColdStartSelectionCurrent(options.isCurrent);
                        if (!String(chunkText || '').trim()) {
                            return { skipped: true, reason: 'empty_assistant_canonical_chunk' };
                        }
                        if (shouldUseFastPath) {
                            return callColdStartLLMWithPreflight({
                                isCurrent:options.isCurrent,
                                config: fastLlm.config,
                                system: ColdStartSummaryPrompt,
                                user: chunkText,
                                maxTokens: 1600,
                                profile: fastLlm.profile,
                                label: `${taskLabel}-fast-chunk-${i + 1}`,
                                domain: 'cold_start',
                                reason: `${taskLabel}-fast-chunk`,
                                preflightDomain: 'coldStartChunkSummary',
                            });
                        }
                        let auxDraft = null;
                        const draftProfile = resolveAnalysisProfile(MemoryEngine.CONFIG, 'coldStartChunkSummary', 'aux');
                        if (!LLMProvider.isConfigured(MemoryEngine.CONFIG, 'primary') && LLMProvider.isConfigured(MemoryEngine.CONFIG, 'aux')) {
                            const auxResult = await callColdStartLLMWithPreflight({
                                isCurrent:options.isCurrent,
                                config: MemoryEngine.CONFIG,
                                system: ColdStartSummaryPrompt,
                                user: chunkText,
                                maxTokens: 1300,
                                profile: draftProfile,
                                label: `${taskLabel}-${draftProfile}-chunk-${i + 1}`,
                                domain: 'cold_start',
                                reason: `${taskLabel}-${draftProfile}-chunk`,
                                preflightDomain: 'coldStartChunkSummary',
                            });
                            auxDraft = extractStructuredJson(auxResult?.content || '');
                        }

                        const primaryInput = auxDraft
                            ? [
                                `[원문 대화 청크 / Source Conversation Chunk]`,
                                chunkText,
                                ``,
                                `[보조 요약 초안 / Auxiliary Draft]`,
                                JSON.stringify(compactChunkSummary(auxDraft))
                            ].join('\n')
                            : chunkText;

                        return callColdStartLLMWithPreflight({
                                isCurrent:options.isCurrent,
                            config: MemoryEngine.CONFIG,
                            system: auxDraft ? ColdStartChunkArbiterPrompt : ColdStartSummaryPrompt,
                            user: primaryInput,
                            maxTokens: 1900,
                            profile: resolveAnalysisProfile(MemoryEngine.CONFIG, 'coldStartFinalSynthesis', 'primary'),
                            label: `${taskLabel}-final-chunk-${i + 1}`,
                            domain: 'cold_start',
                            reason: `${taskLabel}-final-chunk`,
                            preflightDomain: 'coldStartFinalSynthesis',
                        });
                    })()
                , `${taskLabel}-chunk-${i + 1}`).finally(() => {
                    completedChunkCount += 1;
                    ActivityDashboardCore.update(activityContext, {
                        phase: taskLabel,
                        status: 'running',
                        progress: 24 + Math.round((completedChunkCount / Math.max(1, chunks.length)) * 44),
                        step: '청크 분석',
                        stepStatus: completedChunkCount >= chunks.length ? 'done' : 'running',
                        message: `청크 분석 ${completedChunkCount}/${chunks.length} 완료`
                    });
                });
            }, { label: `${taskLabel}-conversation-pool`, maxConcurrency: 6 });

            if (typeof options.isCurrent === 'function') await requireColdStartSelectionCurrent(options.isCurrent);
            const chunkSummaries = [];
            let skippedChunkCount = 0;
            let failedChunkCount = 0;
            const totalChunkCount = Math.max(1, chunkResults.length);
            let settledChunkCount = 0;
            for (const result of chunkResults) {
                settledChunkCount += 1;
                if (result.status === 'fulfilled' && result.value?.skipped) {
                    skippedChunkCount++;
                    continue;
                }
                if (result.status === 'fulfilled' && result.value?.content) {
                    const parsed = extractStructuredJson(result.value.content);
                    if (parsed) chunkSummaries.push(parsed);
                    else failedChunkCount++;
                    continue;
                }
                failedChunkCount++;
            }
            if (chunkSummaries.length === 0) {
                if (skippedChunkCount > 0 && failedChunkCount === 0) {
                    throw new Error("assistant 정본 응답이 없어 과거 대화 분석을 실행할 수 없습니다.");
                }
                chunkSummaries.push(buildFallbackChunkSummary(msgs, taskLabel));
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] Conversation analysis used deterministic fallback summary', {
                        taskLabel,
                        chunks: chunks.length,
                        skippedChunkCount,
                        failedChunkCount,
                        settledChunkCount,
                        totalChunkCount
                    });
                }
                ActivityDashboardCore.update(activityContext, {
                    phase: taskLabel,
                    status: 'running',
                    progress: 70,
                    step: '청크 분석',
                    stepStatus: 'done',
                    message: '청크 JSON 파싱에 실패해 원문 기반 fallback summary로 합성을 계속합니다.'
                });
            }

            LMAI_GUI.toast(chunkSummaries.length > HIERARCHICAL_SYNTHESIS_MAX_BATCHES ? "초대형 대화 계층 합성 중..." : "최종 데이터 합성 중...");
            ActivityDashboardCore.update(activityContext, {
                phase: taskLabel,
                status: 'running',
                progress: 74,
                step: '계층 합성',
                stepStatus: 'running',
                message: chunkSummaries.length > HIERARCHICAL_SYNTHESIS_MAX_BATCHES ? '초대형 대화 계층 합성 중입니다.' : '최종 구조 데이터를 합성합니다.'
            });
            return await synthesizeChunkSummariesHierarchically(chunkSummaries, taskLabel, options);
        };

        const reanalyzeHistoricalConversation = async (options = {}) => {
            if (VersionedCanonicalBridge.mode === "authority") throw new Error("authority_upstream_writer_unsupported");
            const mode = 'whole_conversation_merge';
            const selectionCurrent = async () => typeof options.selectionCurrent !== 'function' || await options.selectionCurrent() === true;
            const rejected = (reason,extra = {}) => ({skipped:true,state:'rejected',status:'blocked',writeIssued:false,mode,reason,...extra});
            if (!await selectionCurrent()) return rejected('historical_selection_changed');
            let confirmationContext = typeof options.resolveSelectionTarget === 'function' ? await options.resolveSelectionTarget() : null;
            const approval = await requestColdStartApproval('reanalysis', {...options,
                ...(confirmationContext ? {char:confirmationContext.char,chat:confirmationContext.chat} : {})});
            confirmationContext = null;
            if (!approval.approved) {
                notifyLibraTask('과거 대화 재분석을 취소했습니다.', { key: 'libra-cold-reanalysis-cancelled', duration: 1400 });
                return rejected('user_cancelled',{approval});
            }
            if (!await selectionCurrent()) return rejected('historical_selection_changed');
            if (isProcessing) throw new Error("이미 콜드 스타트/재분석이 진행 중입니다.");
            isProcessing = true;
            notifyLibraTask('과거 대화 재분석을 시작했습니다.', { key: 'libra-cold-reanalysis-start', duration: 1600 });
            let mutationStarted = false;
            try {
                const selected = typeof options.resolveSelectionTarget === 'function' ? await options.resolveSelectionTarget() : null;
                const char = selected?.char || await RisuCompat.getCharacter();
                if (!char) throw new Error("캐릭터 데이터를 불러올 수 없습니다.");
                const chat = selected?.chat || await getActiveChatForCharacter(char);
                if (!chat) throw new Error("채팅방을 찾을 수 없습니다.");
                if (!await selectionCurrent()) return rejected('historical_selection_changed');
                const activityContext = { scopeKey: getChatRuntimeScopeKey(chat, char), activityDashboard: MemoryEngine.CONFIG.activityDashboard };
                ActivityDashboardCore.beginRequest({
                    flow: 'cold-reanalysis',
                    title: '과거 대화 재분석',
                    stageLabel: '과거 대화 재분석을 준비합니다.',
                    status: 'running',
                    progress: 8,
                    forceVisible: true
                }, activityContext);
                const lore = MemoryEngine.getLorebook(char, chat);
                const reanalysisSource = resolveColdStartMessageSource(chat);
                const msgs = buildAnalyzableMessages(chat, {
                    sourceMessages: reanalysisSource.messages,
                    sourceInfo: reanalysisSource
                });
                if (msgs.length === 0) throw new Error("재분석할 대화 내역이 없습니다.");

                const candidateData = await analyzeConversationMessages(msgs, 'cold-reanalysis', {isCurrent:options.selectionCurrent});
                if (!await selectionCurrent()) return rejected('historical_selection_changed');
                if (!hasMeaningfulStructuredSnapshot(candidateData)) {
                    throw new Error("재분석 결과가 비어 있습니다.");
                }
                const currentData = buildCurrentStructuredSnapshot(lore);
                const verifiedMergedData = await verifyMergedStructuredKnowledge(currentData, candidateData, 'cold-reanalysis-verify');
                if (!await selectionCurrent()) return rejected('historical_selection_changed');
                const worldAdditionalMaintenance = await analyzeHistoricalWorldAdditional(
                    verifiedMergedData,
                    msgs,
                    char,
                    chat,
                    'cold-reanalysis'
                );
                if (!await selectionCurrent()) return rejected('historical_selection_changed');
                const mergeResult = await mergeStructuredKnowledge(verifiedMergedData, {
                    selectionCurrent:options.selectionCurrent,
                    requireVerifiedOutcome:options.returnOutcome === true,
                    onMutationStarted:()=>{mutationStarted=true;options.onMutationStarted?.();},
                    updateNarrative: true,
                    sourceId: 'reanalysis',
                    worldNote: 'Merged via Reanalysis Verification',
                    sourceMessages: msgs,
                    worldAdditionalMaintenance,
                    targetChar: char,
                    targetChat: chat
                });
                const persistence = mergeResult?.persistence || mergeResult;
                if (options.returnOutcome === true && persistence?.canonicalVerified !== true) {
                    ActivityDashboardCore.finish(activityContext,'failed','보강 병합의 정본 저장 결과를 확인할 수 없습니다.');
                    return {state:'uncertain',status:'uncertain',mode,reason:'legacy_persistence_unverified'};
                }
                ActivityDashboardCore.finish(activityContext, 'ok', '과거 대화 재분석 완료');
                notifyLibraTask('과거 대화 재분석을 완료했습니다.', { key: 'libra-cold-reanalysis-complete', duration: 1600 });
                return options.returnOutcome === true
                    ? {state:'committed',status:'verified',committed:true,mode,canonicalVerified:true}
                    : verifiedMergedData;
            } catch (e) {
                recordRuntimeDebug('error', "[LIBRA] Reanalysis Error:", e);
                ActivityDashboardCore.finish({
                    scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                    activityDashboard: MemoryEngine.CONFIG.activityDashboard
                }, 'failed', `재분석 실패: ${e.message || e}`);
                if (options.returnOutcome === true) {
                    if (e?.persistence?.canonicalVerified === true) return {state:'committed',status:'verified',committed:true,mode,canonicalVerified:true};
                    return mutationStarted ? {state:'uncertain',status:'uncertain',mode,reason:'legacy_merge_outcome_unverified'}
                        : rejected('historical_analysis_unavailable');
                }
                throw e;
            } finally {
                isProcessing = false;
            }
        };


        const integrateImportedKnowledge = async (rawTexts, sourceLabel = 'Imported', options = {}) => {
            if (VersionedCanonicalBridge.mode === "authority") throw new Error("authority_upstream_writer_unsupported");
            if (!MemoryEngine.CONFIG.useLLM) {
                throw new Error("LLM 사용이 꺼져 있어 구조화 분석을 진행할 수 없습니다.");
            }
            const opts = {
                updateNarrative: true,
                worldNote: `Updated via ${sourceLabel} Import`,
                ...options
            };
            const synthesizedData = await synthesizeStructuredKnowledge(rawTexts, `import-${String(sourceLabel || 'knowledge').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`);
            if (!hasMeaningfulStructuredSnapshot(synthesizedData)) {
                throw new Error("가져온 지식 데이터를 구조화하지 못했습니다.");
            }
            let char = null;
            let chat = null;
            if (opts.targetChat?.id) {
                const targetCtx = await resolveActiveChatContext(opts.targetChat);
                if (!targetCtx?.char || !targetCtx?.chat || String(targetCtx.chat?.id || '') !== String(opts.targetChat.id || '')) {
                    throw new Error('가져온 지식 반영 대상 채팅방을 찾을 수 없습니다.');
                }
                char = targetCtx.char;
                chat = targetCtx.chat;
            } else {
                char = opts.targetChar || await requireLoadedCharacter();
                chat = await getActiveChatForCharacter(char);
            }
            const lore = MemoryEngine.getLorebook(char, chat);
            const currentData = buildCurrentStructuredSnapshot(lore);
            const finalData = await verifyMergedStructuredKnowledge(
                currentData,
                synthesizedData,
                `import-verify-${String(sourceLabel || 'knowledge').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`
            );
            if (!hasMeaningfulStructuredSnapshot(finalData)) {
                throw new Error("가져온 지식 데이터를 구조화하지 못했습니다.");
            }
            await mergeStructuredKnowledge(finalData, {
                updateNarrative: opts.updateNarrative,
                worldNote: opts.worldNote,
                sourceId: opts.sourceId,
                targetChar: char,
                targetChat: chat
            });
            return finalData;
        };

