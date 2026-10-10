        const startAutoSummarization = async (options = {}) => {
            const approval = await requestColdStartApproval('cold_start', options);
            if (!approval.approved) {
                notifyLibraTask('콜드 스타트/정본 보강을 취소했습니다.', { key: 'libra-cold-start-cancelled', duration: 1400 });
                return { skipped: true, reason: 'user_cancelled', approval };
            }
            if (isProcessing) throw new Error("이미 콜드 스타트/재분석이 진행 중입니다.");
            isProcessing = true;
            let coldStartDebugKey = '';
            notifyLibraTask('콜드 스타트 작업을 시작했습니다.', { key: 'libra-cold-start-start', duration: 1800 });
            try {
                coldStartDebugKey = DebugExportManager.startRequest('cold-start', {
                    scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || 'global',
                    requestType: 'manual-cold-start',
                    request: {
                        historyPreset: MemoryEngine.CONFIG.coldStartScopePreset,
                        historyLimit: MemoryEngine.CONFIG.coldStartHistoryLimit
                    }
                });
                DebugExportManager.recordPhase(coldStartDebugKey, 'start', {
                    historyPreset: MemoryEngine.CONFIG.coldStartScopePreset,
                    historyLimit: MemoryEngine.CONFIG.coldStartHistoryLimit
                }, 'running');
                const char = await RisuCompat.getCharacter();
                if (!char) throw new Error("캐릭터 데이터를 불러올 수 없습니다.");

                const chat = await getActiveChatForCharacter(char);
                const messageSource = resolveColdStartMessageSource(chat);
                const msgs_all = messageSource.messages;

                if (!chat || msgs_all.length === 0) {
                    throw new Error("분석할 대화 내역이 없습니다.");
                }
                const activityContext = { scopeKey: getChatRuntimeScopeKey(chat, char), activityDashboard: MemoryEngine.CONFIG.activityDashboard };
                DebugExportManager.updateRequestContext(coldStartDebugKey, {
                    scopeKey: activityContext.scopeKey,
                    chatId: String(chat?.id || '').trim(),
                    request: {
                        rawMessages: msgs_all.length,
                        messageSource: messageSource.label,
                        chatName: String(chat?.name || '').trim()
                    }
                });
                DebugExportManager.recordPhase(coldStartDebugKey, 'collect_messages', {
                    rawMessages: msgs_all.length,
                    chatId: String(chat?.id || '').trim(),
                    source: messageSource.label,
                    sourceCandidates: messageSource.candidates
                }, 'done');
                ActivityDashboardCore.beginRequest({
                    flow: 'cold-start',
                    title: '초기 구조 분석',
                    stageLabel: '과거 대화를 수집합니다.',
                    status: 'running',
                    progress: 8,
                    forceVisible: true
                }, activityContext);
                const analysisBuild = buildAnalyzableMessagesWithAudit(chat, {
                    sourceMessages: msgs_all,
                    sourceInfo: messageSource
                });
                const msgs = analysisBuild.messages;
                
                if (msgs.length === 0) throw new Error("분석할 대화 내역이 없습니다.");
                DebugExportManager.recordPhase(coldStartDebugKey, 'analyzable_messages', {
                    messages: msgs.length,
                    roleCounts: DebugExportManager.countRoles(msgs.map(item => item?.msg).filter(Boolean)),
                    filteredMessages: Math.max(0, msgs_all.length - msgs.length),
                    source: analysisBuild.source,
                    filterSummary: analysisBuild.summary,
                    filterAudit: analysisBuild.audit.slice(-COLD_START_MESSAGE_AUDIT_LIMIT)
                }, 'done');
                ActivityDashboardCore.update(activityContext, {
                    phase: 'cold-start',
                    status: 'running',
                    progress: 16,
                    step: '대화 수집',
                    stepStatus: 'done',
                    message: `분석 대상 메시지 ${msgs.length}개를 수집했습니다.`
                });
                const analyzedData = await analyzeConversationMessages(msgs, 'cold-start');
                if (!hasMeaningfulStructuredSnapshot(analyzedData)) {
                    throw new Error("초기 구조 분석 결과가 비어 있습니다.");
                }
                DebugExportManager.recordPhase(coldStartDebugKey, 'final_synthesis', {
                    result: summarizeStructuredSnapshotForDebug(analyzedData)
                }, 'done');

                if (MemoryEngine.CONFIG.debug) recordRuntimeDebug('log', "[LIBRA] Cold Start Synthesis Data:", analyzedData);
                
                // 데이터 반영 실행. Existing LIBRA data must be augmented, not replaced.
                const currentLore = MemoryEngine.getLorebook(char, chat) || [];
                const currentData = buildCurrentStructuredSnapshot(currentLore);
                const hasExistingData = hasMeaningfulStructuredSnapshot(currentData);
                DebugExportManager.recordPhase(coldStartDebugKey, 'existing_data', {
                    hasExistingData,
                    current: summarizeStructuredSnapshotForDebug(currentData)
                }, hasExistingData ? 'augment' : 'baseline');
                if (hasExistingData) {
                    const verifiedMergedData = await verifyMergedStructuredKnowledge(currentData, analyzedData, 'cold-start-existing-data-augment-verify');
                    DebugExportManager.recordPhase(coldStartDebugKey, 'merge_verify', {
                        result: summarizeStructuredSnapshotForDebug(verifiedMergedData)
                    }, 'done');
                    const worldAdditionalMaintenance = await analyzeHistoricalWorldAdditional(
                        verifiedMergedData,
                        msgs,
                        char,
                        chat,
                        'cold-start-augment'
                    );
                    await mergeStructuredKnowledge(verifiedMergedData, {
                        updateNarrative: true,
                        worldNote: 'Augmented via Cold Start',
                        sourceId: 'cold-start-augment',
                        sourceMessages: msgs,
                        worldAdditionalMaintenance,
                        targetChar: char,
                        targetChat: chat
                    });
                    notifyLibraTask('콜드 스타트 보강 병합을 완료했습니다.', { key: 'libra-cold-start-augment-complete', duration: 1800 });
                    ActivityDashboardCore.finish(activityContext, 'ok', '콜드 스타트 보강 병합 완료');
                    DebugExportManager.finishRequest(coldStartDebugKey, 'committed', {
                        mode: 'augment',
                        result: summarizeStructuredSnapshotForDebug(verifiedMergedData)
                    });
                    return verifiedMergedData;
                }
                // The analysis can outlive the currently selected chat.  Commit to the
                // char/chat captured when cold start began so a mid-request chat switch
                // cannot leak the reconstructed state into another session.
                const worldAdditionalMaintenance = await analyzeHistoricalWorldAdditional(
                    analyzedData,
                    msgs,
                    char,
                    chat,
                    'cold-start'
                );
                await applyFinalData(analyzedData, {
                    sourceMessages: msgs,
                    worldAdditionalMaintenance,
                    targetChar: char,
                    targetChat: chat
                });
                notifyLibraTask('콜드 스타트 작업을 완료했습니다.', { key: 'libra-cold-start-complete', duration: 1800 });
                ActivityDashboardCore.finish(activityContext, 'ok', '콜드 스타트 완료');
                DebugExportManager.finishRequest(coldStartDebugKey, 'committed', {
                    mode: 'baseline',
                    result: summarizeStructuredSnapshotForDebug(analyzedData)
                });
                return analyzedData;

            } catch (e) {
                recordRuntimeDebug('error', "[LIBRA] Cold Start Error:", e);
                DebugExportManager.finishRequest(coldStartDebugKey, 'failed', {
                    error: e?.message || String(e || 'unknown')
                });
                ActivityDashboardCore.finish({
                    scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                    activityDashboard: MemoryEngine.CONFIG.activityDashboard
                }, 'failed', `콜드 스타트 실패: ${e.message || e}`);
                throw e;
            } finally {
                isProcessing = false;
            }
        };

        return {
            check,
            startAutoSummarization,
            reanalyzeHistoricalConversation,
            snapshotHistoricalSource,
            integrateImportedKnowledge,
            buildAnalyzableMessages,
            requestApproval: requestColdStartApproval,
            prompts: Object.freeze({})
        };
    })();

    // ══════════════════════════════════════════════════════════════
    // [MANAGER] Transition Manager
    // ══════════════════════════════════════════════════════════════
