    const runTurnMaintenanceRecord = async (record = null) => {
        if (!record) return { skipped: true, reason: 'missing-record' };
        const maintenanceLogKey = DebugExportManager.startRequest('turn_maintenance', {
            scopeKey: record.scopeKey || record.targetContext?.scopeKey || record.chatId,
            turn: record.turnForMaintenance
        });
        const finishMaintenanceLog = result => {
            DebugExportManager.finishRequest(maintenanceLogKey, result?.status || (result?.skipped ? 'skipped' : result?.failed ? 'failed' : 'done'), { failed: result?.failed === true });
            return result;
        };
        let { char, chat } = record;
        const { aiResponse, turnForMaintenance } = record;
        let turnState = record.turnState || {};
        const maintenanceConfig = record.maintenanceConfig || MemoryEngine.CONFIG;
        const analysisDeadlineAt = Number(record.analysisDeadlineAt || maintenanceConfig?.__analysisDeadlineAt || 0) || 0;
        let deferredRecoveryScheduled = false;
        let deferredRecoveryExhausted = false;
        let maintenanceFailure = null;
        let maintenanceUncertain = false;
        let persistenceAttempted = false;
        let analysisReservationFailed = false;
        let runtimeTransactionToken = null;
        if (analysisDeadlineAt > 0 && Date.now() >= analysisDeadlineAt - 1000) {
            if (record?.targetContext?.durableLedgerRecordKey) {
                try {
                    await DurableTurnLedger.markStatus({
                        recordKey: record.targetContext.durableLedgerRecordKey,
                        recordId: record.targetContext.durableLedgerRecordId || '',
                        scopeKey: record.targetContext.scopeKey || record.scopeKey || ''
                    }, { analysisStatus: 'deadline', analysisRecoveryAttempt: Math.max(0, Number(record?.analysisRecoveryAttempt || 0)), analysisFinishedAt: Date.now() });
                } catch (_) {}
            }
            return finishMaintenanceLog({ skipped: true, reason: 'analysis-deadline-expired', turn: turnForMaintenance });
        }
        if (record?.targetContext?.chatId) {
            const resolvedTarget = await resolveChatContextByTarget(record.targetContext, { allowActiveFallback: false });
            if (!resolvedTarget?.ok) {
                return finishMaintenanceLog({
                    status: 'waiting',
                    skipped: true,
                    reason: resolvedTarget?.reason || 'maintenance-target-unavailable',
                    turn: turnForMaintenance,
                    chatId: record.targetContext.chatId
                });
            }
            char = resolvedTarget.char;
            chat = resolvedTarget.chat;
            record.char = char;
            record.chat = chat;
            record.runtimeScopeKey = resolvedTarget.scopeKey || record.runtimeScopeKey || '';
            record.targetContext = {
                ...record.targetContext,
                characterIndex: normalizeRisuIndex(resolvedTarget.charIdx),
                chatIndex: normalizeRisuIndex(resolvedTarget.chatIndex),
                scopeKey: record.targetContext.scopeKey || resolvedTarget.scopeKey,
                runtimeScopeKey: resolvedTarget.scopeKey || record.targetContext.runtimeScopeKey || ''
            };
        }
        const activeContext = await resolveActiveChatContext();
        const targetIsActive = !record?.targetContext?.chatId || !!(
            activeContext?.chat
            && String(activeContext.chat?.id || '').trim() === String(record.targetContext.chatId || '').trim()
            && (!record.targetContext.characterId
                || String(activeContext.char?.id || activeContext.char?.chaId || '').trim() === String(record.targetContext.characterId || '').trim())
        );
        if (!targetIsActive) {
            return finishMaintenanceLog({ status: 'waiting', skipped: true, reason: 'maintenance-target-not-active', turn: turnForMaintenance });
        }
        runtimeTransactionToken = ScopedRuntimeTransaction.begin(record.scopeKey || record?.targetContext?.scopeKey || record.chatId, 'afterRequest:maintenance');
        if (!runtimeTransactionToken) {
            return finishMaintenanceLog({ status: 'waiting', skipped: true, reason: 'runtime-transaction-busy', turn: turnForMaintenance });
        }
        const assertMaintenanceTransaction = () => {
            if (!ScopedRuntimeTransaction.owns(runtimeTransactionToken) || !isLibraRuntimeEpochActive()) {
                throw new Error('maintenance runtime transaction invalidated');
            }
            if (analysisDeadlineAt > 0 && Date.now() >= analysisDeadlineAt) {
                throw new Error('maintenance analysis deadline exceeded');
            }
        };
            const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            try {
                assertMaintenanceTransaction();
                if (record?.targetContext?.durableLedgerRecordKey) {
                    // Persist the shared receipt's attempt before provider work.
                    // A failed/uncertain reservation consumes no provider calls.
                    const claim = await DurableTurnLedger.markStatus({
                        recordKey: record.targetContext.durableLedgerRecordKey,
                        recordId: record.targetContext.durableLedgerRecordId || '',
                        scopeKey: record.targetContext.scopeKey || record.scopeKey || ''
                    }, {
                        analysisStatus: 'running', analysisStartedAt: Date.now(), analysisFinishedAt: 0,
                        analysisRecoveryAttempt: Math.max(0, Number(record.analysisRecoveryAttempt || 0))
                    }, {
                        claimAnalysisAttempt: true, resetGeneration: record.targetContext.resetGeneration ?? 0,
                        maxRecoveryAttempts: Math.max(0, Math.min(4, Number(maintenanceConfig?.analysisRecoveryDeferredAttempts ?? 2) || 0))
                    });
                    assertMaintenanceTransaction();
                    if (!claim.ok || claim.verified !== true) {
                        analysisReservationFailed = claim.attemptWasUnstarted === true;
                        throw new Error(`analysis_receipt_unverified:${claim.reason}`);
                    }
                    if (claim.unchanged) {
                        ScopedRuntimeTransaction.end(runtimeTransactionToken);
                        runtimeTransactionToken = null;
                        return finishMaintenanceLog({ status: 'skipped', skipped: true, reason: claim.reason || 'analysis_already_completed', turn: turnForMaintenance });
                    }
                }
                DebugExportManager.recordPhase(maintenanceLogKey, 'analysis', {}, 'running');
                updateTurnMaintenanceActivity(record, {
                    progress: 74,
                    step: '후처리 분석',
                    activeTask: '턴 상태 분석',
                    postprocessDetail: '커밋된 턴의 엔티티 후보와 내러티브 상태를 확인합니다.',
                    message: '커밋된 턴 상태를 분석하고 있습니다.'
                });
                let latestLoreForCorrection = MemoryEngine.getLorebook(char, chat);
                if (turnState?.analysisPending === true) {
                    updateTurnMaintenanceActivity(record, {
                        progress: 78,
                        step: '후처리 분석',
                        activeTask: '엔티티/내러티브 보강',
                        postprocessDetail: '빠른 커밋으로 남겨둔 턴 상태를 정밀 분석으로 보강합니다.',
                        message: '턴 상태 보강 분석을 진행합니다.'
                    });
                    turnState = await analyzeCommittedTurnState(
                        char,
                        chat,
                        latestLoreForCorrection,
                        turnState,
                        aiResponse,
                        turnForMaintenance,
                        maintenanceConfig,
                        {
                            recoveryAttempt: Math.max(0, Number(record?.analysisRecoveryAttempt || 0) || 0)
                        }
                    );
                    assertMaintenanceTransaction();
                    latestLoreForCorrection = MemoryEngine.getLorebook(char, chat);
                }
                updateTurnMaintenanceActivity(record, {
                    progress: 82,
                    step: '후처리 분석',
                    activeTask: turnState?.precomputedMaintenance ? '통합 분석 정리' : '번들 분석',
                    postprocessDetail: '메모리/엔티티/월드/내러티브 후처리 결과를 계산합니다.',
                    message: turnState?.precomputedMaintenance
                        ? '통합 분석 결과를 후처리 상태로 정리합니다.'
                        : '후처리 번들 분석을 실행하고 있습니다.'
                });
                let bundledMaintenance = turnState?.precomputedMaintenance || await TurnMaintenanceOptimizer.run(
                        turnForMaintenance,
                        turnState,
                        aiResponse,
                        MemoryEngine.getEffectiveLorebook(char, chat),
                        maintenanceConfig
                    );
                assertMaintenanceTransaction();
                DebugExportManager.recordPhase(maintenanceLogKey, 'analysis', {}, turnState?.analysisDeferred === true ? 'waiting' : 'done');
                const bundledBrief = String(bundledMaintenance?.narrativeBrief || '').trim();
                if (bundledBrief) {
                    NarrativeTracker.correctTurn(turnForMaintenance, {
                        summary: bundledBrief,
                        entities: turnState.involvedEntities || [],
                        storyAuthor: bundledMaintenance?.storyAuthor || null,
                        storylineName: bundledMaintenance?.storyAuthor?.currentArc || '',
                        narrativeGoal: bundledMaintenance?.storyAuthor?.narrativeGoal || '',
                        keyPoints: [
                            ...(Array.isArray(bundledMaintenance?.storyAuthor?.nextBeats) ? bundledMaintenance.storyAuthor.nextBeats : []),
                            ...(Array.isArray(bundledMaintenance?.storyAuthor?.recentDecisions) ? bundledMaintenance.storyAuthor.recentDecisions : [])
                        ],
                        ongoingTensions: Array.isArray(bundledMaintenance?.storyAuthor?.activeTensions) ? bundledMaintenance.storyAuthor.activeTensions : []
                    });
                }
                updateTurnMaintenanceActivity(record, {
                    progress: 88,
                    step: '후처리 분석',
                    activeTask: '분석 결과 반영 준비',
                    postprocessDetail: '스토리 작가/감독, 엔티티 보정, 흡수 병합 계획을 정리합니다.',
                    message: '분석 결과를 각 매니저에 반영할 준비를 합니다.'
                });
                const correctionResult = await applyTurnStateCorrections(
                    turnState,
                    aiResponse,
                    turnForMaintenance,
                    maintenanceConfig,
                    latestLoreForCorrection,
                    bundledMaintenance?.correctionReviewed === true ? (bundledMaintenance?.correction || null) : undefined
                );
                assertMaintenanceTransaction();
                try {
                    const packet = bundledMaintenance?.canonicalPacket && typeof bundledMaintenance.canonicalPacket === 'object'
                        ? bundledMaintenance.canonicalPacket
                        : null;
                    const packetWorld = packet?.world && typeof packet.world === 'object' ? packet.world : null;
                    const packetWorldState = packetWorld?.state && typeof packetWorld.state === 'object' ? packetWorld.state : {};
                    const packetSceneTime = String(packetWorldState.time || packetWorld?.time || '').replace(/\s+/g, ' ').trim();
                    const packetSceneLocation = String(packetWorldState.location || packetWorld?.location || '').replace(/\s+/g, ' ').trim();
                    const packetScene = String(packetWorldState.scene || packetWorld?.scene || '').replace(/\s+/g, ' ').trim();
                    const packetActiveEvents = Array.isArray(packetWorldState.active_events)
                        ? packetWorldState.active_events
                        : (Array.isArray(packetWorldState.activeEvents) ? packetWorldState.activeEvents : (Array.isArray(packetWorld?.active_events) ? packetWorld.active_events : packetWorld?.activeEvents));
                    const packetOffscreenThreads = Array.isArray(packetWorldState.offscreen_threads)
                        ? packetWorldState.offscreen_threads
                        : (Array.isArray(packetWorldState.offscreenThreads) ? packetWorldState.offscreenThreads : (Array.isArray(packetWorld?.offscreen_threads) ? packetWorld.offscreen_threads : packetWorld?.offscreenThreads));
                    if (packetSceneTime) {
                        const focusedEntities = Array.isArray(turnState.involvedEntities)
                            ? turnState.involvedEntities.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean)
                            : [];
                        TimeEngine.ingestLiveTurn(
                            focusedEntities,
                            '',
                            `Turn ${turnForMaintenance} canonical packet scene time`,
                            { sceneTimeLabel: packetSceneTime }
                        );
                        const timeState = TimeEngine.getState?.() || {};
                        NarrativeTracker.correctTurn(turnForMaintenance, {
                            sceneDate: timeState.currentDate || '',
                            sceneTime: timeState.currentTime || '',
                            sceneTimeLabel: timeState.currentLabel || packetSceneTime
                        });
                    }
                    if (packetSceneTime || packetSceneLocation || packetScene || (Array.isArray(packetActiveEvents) && packetActiveEvents.length) || (Array.isArray(packetOffscreenThreads) && packetOffscreenThreads.length)) {
                        const worldProfile = HierarchicalWorldManager.getProfile?.() || {};
                        const currentNode = HierarchicalWorldManager.getCurrentNode?.();
                        const currentMeta = currentNode?.meta || {};
                        const currentRules = HierarchicalWorldManager.getCurrentRules?.() || {};
                        WorldStateTracker.replaceState(turnForMaintenance, {
                            activePath: worldProfile?.activePath || [],
                            rules: currentRules,
                            global: worldProfile?.global || {},
                            classification: String(currentMeta.classification || currentMeta.worldMetadata?.classification || packetWorld?.classification?.primary || '').trim(),
                            worldSummary: String(currentMeta.worldSummary || currentMeta.worldMetadata?.summary || packetWorld?.summary || '').trim(),
                            currentTime: packetSceneTime,
                            currentLocation: packetSceneLocation,
                            currentScene: packetScene,
                            activeEvents: packetActiveEvents,
                            offscreenThreads: packetOffscreenThreads,
                            ruleHighlights: extractWorldRuleHighlights(currentRules, 6),
                            notes: packetSceneTime ? `Canonical packet scene time: ${packetSceneTime}` : ''
                        });
                    }
                } catch (timePacketError) {
                    if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Canonical packet time/world-state projection skipped:', timePacketError?.message || timePacketError);
                }
                try {
                    const authorPayload = {
                        turn: turnForMaintenance,
                        turnState,
                        userMsg: String(turnState.strictUserMsg || turnState.userMsgForNarrative || turnState.userMsgForMemory || '').trim(),
                        strictUserMsg: String(turnState.strictUserMsg || '').trim(),
                        aiResponse,
                        isEmptyInput: !String(turnState.strictUserMsg || turnState.userMsgForNarrative || turnState.userMsgForMemory || '').trim(),
                        focusedEntities: Array.isArray(turnState.involvedEntities)
                            ? turnState.involvedEntities.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).slice(0, 8)
                            : [],
                        relationStateSignals: Array.from(EntityManager.getRelationCache?.()?.values?.() || [])
                            .filter(rel => (turnState.involvedEntities || []).some(item => {
                                const name = typeof item === 'string' ? item : item?.name;
                                return name && (name === rel?.entityA || name === rel?.entityB);
                            }))
                            .slice(0, 8)
                            .map(rel => EntityManager.formatRelationForPrompt?.(rel) || '')
                            .filter(Boolean),
                        worldPrompt: HierarchicalWorldManager.formatForPrompt(),
                        worldStatePrompt: WorldStateTracker.formatForPrompt(),
                        narrativePrompt: NarrativeTracker.formatForPrompt(),
                        recentTurns: (NarrativeTracker.getState()?.turnLog || []).slice(-8).map(t => `Turn ${t.turn}: ${t.summary || t.response || t.responseBrief || ''}`),
                        sceneContract: bundledMaintenance?.sceneContract || null,
                        narrativeDiagnostics: bundledMaintenance?.narrativeDiagnostics || null,
                        plannerRefreshModes: bundledMaintenance?.plannerRefreshModes || { storyAuthor: 'light', director: 'light' },
                        plannerRefreshReasons: bundledMaintenance?.plannerRefreshReasons || [],
                        plannerProvenance: bundledMaintenance?.plannerProvenance || null,
                        sourceMessageIds: normalizeCanonicalMessageIds([
                            turnState?.sourceMessageIds,
                            turnState?.liveMessageIds,
                            turnState?.messageId,
                            turnState?.initialMessageId,
                            turnState?.finalizedMessageId
                        ]),
                        sourceRevision: Math.max(0, Number(turnState?.sourceRevision || turnForMaintenance) || turnForMaintenance)
                    };
                    StoryAuthor.applyPlanState?.(turnForMaintenance, bundledMaintenance?.storyAuthor || null, authorPayload, maintenanceConfig);
                    Director.applyDirectiveState?.(turnForMaintenance, bundledMaintenance?.director || null, {
                        ...authorPayload,
                        storyAuthorState: StoryAuthor.getState?.() || {},
                        storyAuthorPrompt: StoryAuthor.formatForPrompt?.() || ''
                    }, maintenanceConfig);
                    WorldAdditionalCore.ingestMaintenance?.(
                        bundledMaintenance?.worldAdditional || null,
                        aiResponse || '',
                        {
                            turn: turnForMaintenance,
                            userText: String(turnState.strictUserMsg || turnState.userMsgForMemory || '').trim(),
                            focusedEntities: authorPayload.focusedEntities || []
                        },
                        maintenanceConfig
                    );
                } catch (orchestrationError) {
                    if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Story author/director update skipped:', orchestrationError?.message || orchestrationError);
                }
                const absorptionPlans = await EntityAwareProcessor.planPendingEntityAbsorptions(
                    latestLoreForCorrection,
                    maintenanceConfig,
                    { maxTasks: 1, turn: turnForMaintenance, preserveLiveEntityCache: true }
                );
                const entityNamesForMaintenance = Array.from(turnState.entitiesToConsolidate || []);
                updateTurnMaintenanceActivity(record, {
                    progress: 92,
                    step: '후처리 분석',
                    activeTask: '엔티티/월드/내러티브 반영',
                    postprocessDetail: '요약, 엔티티 상태, 월드 상태 통합 작업을 실행합니다.',
                    message: '엔티티/월드/내러티브 상태를 반영하고 있습니다.'
                });
                const stateConsolidationTask = (typeof StateConsolidationBundler !== 'undefined' && StateConsolidationBundler?.consolidateIfNeeded)
                    ? StateConsolidationBundler.consolidateIfNeeded(entityNamesForMaintenance, turnForMaintenance, maintenanceConfig)
                    : Promise.allSettled([
                        ...entityNamesForMaintenance.map(name =>
                            CharacterStateTracker.consolidateIfNeeded(name, turnForMaintenance, maintenanceConfig)
                        ),
                        WorldStateTracker.consolidateIfNeeded(turnForMaintenance, maintenanceConfig)
                    ]);
                await Promise.allSettled([
                    NarrativeTracker.summarizeIfNeeded(turnForMaintenance, maintenanceConfig),
                    stateConsolidationTask
                ]);
                assertMaintenanceTransaction();

                updateTurnMaintenanceActivity(record, {
                    progress: 96,
                    step: '최종 저장',
                    activeTask: '최종 저장',
                    postprocessPhase: 'afterRequest:maintenance',
                    postprocessDetail: '후처리 결과를 로어북과 각 상태 저장소에 기록합니다.',
                    message: '후처리 결과를 최종 저장하고 있습니다.'
                });
                await loreLock.writeLock();
                let absorptionAppliedCount = 0;
                try {
                    assertMaintenanceTransaction();
                    const resolvedLatest = record?.targetContext?.chatId
                        ? await resolveChatContextByTarget(record.targetContext, { allowActiveFallback: false })
                        : null;
                    if (record?.targetContext?.chatId && !resolvedLatest?.ok) {
                        throw new Error(`maintenance target lost before save: ${resolvedLatest?.reason || 'unavailable'}`);
                    }
                    const latestChar = resolvedLatest?.char || await requireLoadedCharacter();
                    const latestChat = resolvedLatest?.chat || await getActiveChatForCharacter(latestChar);
                    if (!latestChat) throw new Error('maintenance target chat unavailable before save');
                    if (record?.chatId && String(latestChat?.id || '').trim() !== String(record.chatId || '').trim()) {
                        throw new Error('maintenance target chat mismatch before save');
                    }
                    const latestLore = [...MemoryEngine.getLorebook(latestChar, latestChat)];
                    const scopeKey = getChatRuntimeScopeKey(latestChat, latestChar);
                    const chatId = String(latestChat?.id || getActiveManagedChatId() || '').trim();
                    let integratedJournalChanged = false;
                    let userDlcStateLoaded = false;
                    try {
                        const trackerUpdates = Array.isArray(bundledMaintenance?.userDlcTrackerUpdates)
                            ? bundledMaintenance.userDlcTrackerUpdates
                            : [];
                        const hasUserDlcState = LibraLoreConsolidator.unpack(latestLore)
                            .some(entry => String(entry?.comment || '') === 'lmai_user_dlc');
                        if (hasUserDlcState || trackerUpdates.length) {
                            UserDlcCore.loadState?.(latestLore, { scopeKey, chatId });
                            userDlcStateLoaded = true;
                            const trackerResult = UserDlcCore.applyTrackerUpdates?.(trackerUpdates, {
                                turn: turnForMaintenance,
                                assistantText: aiResponse || '',
                                sourceMessageId: turnState?.m_id || record?.m_id || ''
                            });
                            if (maintenanceConfig.debug && trackerResult?.evaluated) {
                                recordRuntimeDebug('log', '[LIBRA] User DLC custom trackers evaluated:', trackerResult);
                            }
                        }
                    } catch (trackerApplyError) {
                        recordRuntimeDebug('warn', '[LIBRA] User DLC tracker update isolated; other maintenance will continue:', trackerApplyError?.message || trackerApplyError);
                    }
                    const canonicalGuard = record?.canonicalCommitGuard || null;
                    if (canonicalGuard) {
                        const guardMerge = reconcileCanonicalTurnCommitGuard(latestLore, canonicalGuard, latestChar, latestChat, {
                            reason: 'maintenance-pre-merge'
                        });
                        if (!guardMerge.ok) throw new Error(`canonical commit guard pre-merge failed: ${guardMerge.reason || 'unknown'}`);
                        if (maintenanceConfig.debug && (guardMerge.restoredMemories || guardMerge.repairedMemories || guardMerge.turnRecordRestored || guardMerge.rollbackRestored)) {
                            recordRuntimeDebug('warn', '[LIBRA] Canonical commit artifacts restored before maintenance save:', guardMerge);
                        }
                    }

                    try {
                        const packetForJournal = bundledMaintenance?.canonicalPacket && typeof bundledMaintenance.canonicalPacket === 'object'
                            ? bundledMaintenance.canonicalPacket
                            : null;
                        if (packetForJournal) {
                            const journalResult = IntegratedAnalysisJournal.recordPacket?.(latestLore, packetForJournal, {
                                turn: turnForMaintenance,
                                turnKey: turnState?.anchorMeta?.turnKey || record?.turnKey || '',
                                profile: bundledMaintenance?.analysisProfile || '',
                                label: bundledMaintenance?.analysisLabel || '',
                                sourceMode: bundledMaintenance?.entitySourceMode || bundledMaintenance?.entityExtraction?.sourceMode || '',
                                parallel: bundledMaintenance?.analysisParallel === true
                            });
                            integratedJournalChanged = journalResult?.changed === true;
                        }
                    } catch (journalError) {
                        if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Integrated analysis journal update skipped:', journalError?.message || journalError);
                    }

                    try {
                        const packetForEntityMaterialization = bundledMaintenance?.canonicalPacket && typeof bundledMaintenance.canonicalPacket === 'object'
                            ? bundledMaintenance.canonicalPacket
                            : null;
                        let extractionForEntityMaterialization = bundledMaintenance?.entityExtraction && typeof bundledMaintenance.entityExtraction === 'object'
                            ? bundledMaintenance.entityExtraction
                            : null;
                        if (extractionForEntityMaterialization) {
                            const extractionGuard = AnalysisResultGuard?.isMergeAllowed?.(extractionForEntityMaterialization, {
                                domain: 'entity',
                                operation: 'runTurnMaintenanceRecord.entityExtractionMaterialization',
                                sourceMode: extractionForEntityMaterialization.sourceMode || bundledMaintenance?.entitySourceMode || 'maintenance_entity_extraction'
                            }) || { allowed: true };
                            if (!extractionGuard.allowed) {
                                try {
                                    QuarantineManager?.append?.(latestLore, extractionForEntityMaterialization, {
                                        guard: extractionGuard,
                                        domain: 'entity',
                                        operation: 'runTurnMaintenanceRecord.entityExtractionMaterialization',
                                        sourceMode: extractionForEntityMaterialization.sourceMode || bundledMaintenance?.entitySourceMode || 'maintenance_entity_extraction',
                                        turn: turnForMaintenance,
                                        turnKey: turnState?.anchorMeta?.turnKey || record?.turnKey || '',
                                        chatId,
                                        scopeKey,
                                        config: maintenanceConfig
                                    });
                                } catch (quarantineError) {
                                    if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Analysis quarantine append skipped:', quarantineError?.message || quarantineError);
                                }
                                if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Maintenance entity extraction merge blocked:', extractionGuard);
                                extractionForEntityMaterialization = null;
                            }
                        }
                        let materializedExtraction = null;
                        if (packetForEntityMaterialization && EntityAwareProcessor?.extractStructuredEntitySignalsFromPackets) {
                            materializedExtraction = EntityAwareProcessor.extractStructuredEntitySignalsFromPackets(packetForEntityMaterialization, {
                                lorebook: latestLore,
                                conversationText: aiResponse || '',
                                sourceMessageId: turnState?.m_id || record?.m_id || '',
                                turn: turnForMaintenance
                            });
                        }
                        if (extractionForEntityMaterialization) {
                            const packetEntities = Array.isArray(materializedExtraction?.entities) ? materializedExtraction.entities : [];
                            materializedExtraction = {
                                ...(materializedExtraction || { success: false, entities: [], relations: [], world: {}, conflicts: [] }),
                                entities: dedupeTextArray([
                                    ...packetEntities.map(entity => entity?.name).filter(Boolean),
                                    ...(Array.isArray(extractionForEntityMaterialization.entities) ? extractionForEntityMaterialization.entities.map(entity => entity?.name).filter(Boolean) : [])
                                ]).map(name => {
                                    const packetEntity = packetEntities.find(entity => String(entity?.name || '').trim() === String(name || '').trim());
                                    const llmEntity = (Array.isArray(extractionForEntityMaterialization.entities) ? extractionForEntityMaterialization.entities : [])
                                        .find(entity => String(entity?.name || '').trim() === String(name || '').trim());
                                    return { ...(packetEntity || {}), ...(llmEntity || {}), name };
                                }),
                                relations: [
                                    ...((Array.isArray(materializedExtraction?.relations) ? materializedExtraction.relations : [])),
                                    ...((Array.isArray(extractionForEntityMaterialization.relations) ? extractionForEntityMaterialization.relations : []))
                                ],
                                world: {
                                    ...((materializedExtraction?.world && typeof materializedExtraction.world === 'object') ? materializedExtraction.world : {}),
                                    ...((extractionForEntityMaterialization.world && typeof extractionForEntityMaterialization.world === 'object') ? extractionForEntityMaterialization.world : {})
                                },
                                conflicts: [
                                    ...((Array.isArray(materializedExtraction?.conflicts) ? materializedExtraction.conflicts : [])),
                                    ...((Array.isArray(extractionForEntityMaterialization.conflicts) ? extractionForEntityMaterialization.conflicts : []))
                                ],
                                sourceMode: extractionForEntityMaterialization.sourceMode || bundledMaintenance?.entitySourceMode || materializedExtraction?.sourceMode || 'structured_packet',
                                packetEvidenceEntities: [
                                    ...packetEntities,
                                    ...(Array.isArray(extractionForEntityMaterialization.packetEvidenceEntities) ? extractionForEntityMaterialization.packetEvidenceEntities : [])
                                ],
                                conversationText: aiResponse || materializedExtraction?.conversationText || ''
                            };
                            materializedExtraction.success = materializedExtraction.entities.length > 0
                                || materializedExtraction.relations.length > 0
                                || !!(materializedExtraction.world && Object.keys(materializedExtraction.world).length > 0);
                        }
                        if (materializedExtraction?.success) {
                            const sanitizedMaterializedExtraction = EntityAwareProcessor.sanitizeExtractionPayload(materializedExtraction, latestLore, {
                                sourceMode: materializedExtraction.sourceMode || 'structured_packet',
                                conversationText: aiResponse || materializedExtraction.conversationText || '',
                                requireConversationEvidenceForNew: false,
                                packetEvidenceEntities: materializedExtraction.packetEvidenceEntities || materializedExtraction.entities || []
                            });
                            if (sanitizedMaterializedExtraction?.entities?.length || sanitizedMaterializedExtraction?.relations?.length || sanitizedMaterializedExtraction?.world) {
                                await EntityAwareProcessor.applyExtractions(sanitizedMaterializedExtraction, latestLore, maintenanceConfig, turnState?.m_id || record?.m_id || null, { sourceTurn: turnForMaintenance });
                            }
                        }
                    } catch (materializeError) {
                        if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Live packet entity materialization skipped:', materializeError?.message || materializeError);
                    }

                    if (Array.isArray(absorptionPlans) && absorptionPlans.length > 0) {
                        EntityManager.rebuildCache(latestLore);
                        for (const plan of absorptionPlans) {
                            const applied = EntityManager.applyEntityAbsorption(plan, latestLore, {
                                source: 'turn_maintenance_absorption'
                            });
                            if (!applied?.ok) {
                                if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA] Entity absorption apply skipped:', applied?.reason || 'unknown');
                                continue;
                            }
                            absorptionAppliedCount += 1;
                            const oldViewerId = SecretKnowledgeCore.entityViewerId?.(applied.sourceName) || `entity:${applied.sourceName}`;
                            const newViewerId = `entity:${applied.targetName}`;
                            const renameContext = {
                                oldName: applied.sourceName,
                                newName: applied.targetName,
                                oldViewerId,
                                newViewerId,
                                previousNames: applied.previousNames || [applied.sourceName],
                                absorptionId: applied.id
                            };
                            SecretKnowledgeCore.renameEntityReferences?.(renameContext);
                            EntityKnowledgeVaultCore.renameEntityViewer?.(renameContext);
                            TimeEngine.renameEntityAnchor?.(applied.sourceName, applied.targetName, {
                                oldKey: String(applied.sourceName || '').toLowerCase(),
                                newKey: String(applied.targetName || '').toLowerCase()
                            });
                            NarrativeTracker.renameEntityReferences?.(applied.sourceName, applied.targetName, renameContext);
                            StoryAuthor.renameEntityReferences?.(applied.sourceName, applied.targetName, renameContext);
                            Director.renameEntityReferences?.(applied.sourceName, applied.targetName, renameContext);
                            WorldAdditionalCore.renameEntityReferences?.(applied.sourceName, applied.targetName, renameContext);
                            UserDlcCore.renameEntityReferences?.(applied.sourceName, applied.targetName, renameContext);
                            CharacterStateTracker.renameEntityKey?.(applied.sourceName, applied.targetName, renameContext);
                            MemoryEngine.renameEntityReferencesInLore?.(latestLore, applied.sourceName, applied.targetName, {
                                ...renameContext,
                                scopeKey,
                                currentTurn: MemoryEngine.getCurrentTurn?.() || turnForMaintenance || 0,
                                rewriteAliases: false,
                                structuredOnly: true
                            });
                            RPContinuityCore.renameEntityReferences?.(latestLore, applied.sourceName, applied.targetName);
                        }
                    }

                    DebugExportManager.recordPhase(maintenanceLogKey, 'memory', {}, maintenanceConfig.rpLongTermMemoryEnabled === false ? 'skipped' : 'running');
                    if (maintenanceConfig.rpLongTermMemoryEnabled !== false) {
                        try {
                            const rpUpdate = RPContinuityCore.enrichCommittedTurn(
                                latestLore,
                                turnForMaintenance,
                                bundledMaintenance?.longTermMemory || null,
                                {
                                    userText: '',
                                    aiText: aiResponse || '',
                                    entityRefs: turnState.involvedEntities || [],
                                    source: maintenanceConfig.rpLongTermLlmEnrichment === false ? 'maintenance_heuristic' : 'maintenance_llm',
                                    config: maintenanceConfig
                                }
                            );
                            DebugExportManager.recordPhase(maintenanceLogKey, 'memory', { count: rpUpdate?.changedEntries?.length || 0 }, 'done');
                            if (Array.isArray(rpUpdate?.changedEntries) && rpUpdate.changedEntries.length > 0) {
                                MemoryEngine.upsertHybridScopeIndexRows(latestLore, rpUpdate.changedEntries, {
                                    scopeKey,
                                    currentTurn: turnForMaintenance,
                                    reason: 'rp-long-term-enrichment'
                        });
                            }
                        } catch (error) {
                            DebugExportManager.recordPhase(maintenanceLogKey, 'memory', {}, 'failed');
                            if (maintenanceConfig.debug) recordRuntimeDebug('warn', '[LIBRA][RP-LTM] maintenance enrichment skipped:', error?.message || error);
                        }
                    }

                    DebugExportManager.recordPhase(maintenanceLogKey, 'world', {}, 'running');
                    HierarchicalWorldManager.saveWorldGraphUnsafe(latestLore);
                    DebugExportManager.recordPhase(maintenanceLogKey, 'world', {}, 'done');
                    DebugExportManager.recordPhase(maintenanceLogKey, 'entity', {}, 'running');
                    await EntityManager.saveToLorebook(latestChar, latestChat, latestLore);
                    DebugExportManager.recordPhase(maintenanceLogKey, 'entity', {}, 'done');
                    DebugExportManager.recordPhase(maintenanceLogKey, 'narrative', {}, 'running');
                    await NarrativeTracker.saveState(latestLore);
                    DebugExportManager.recordPhase(maintenanceLogKey, 'narrative', {}, 'done');
                    await StoryAuthor.saveState?.(latestLore);
                    await Director.saveState?.(latestLore);
                    await WorldAdditionalCore.saveState?.(latestLore);
                    if (userDlcStateLoaded) await UserDlcCore.saveState?.(latestLore);
                    if (integratedJournalChanged) await IntegratedAnalysisJournal.saveState?.(latestLore);
                    await CharacterStateTracker.saveState(latestLore);
                    await WorldStateTracker.saveState(latestLore);
                    await SecretKnowledgeCore.saveState(latestLore, {
                        scopeKey,
                        chatId
                    });
                    await EntityKnowledgeVaultCore.saveState(latestLore, {
                        scopeKey,
                        chatId
                    });
                    await TimeEngine.saveState(latestLore, {
                        scopeKey,
                        chatId
                    });

                    if (canonicalGuard) {
                        const finalGuardMerge = reconcileCanonicalTurnCommitGuard(latestLore, canonicalGuard, latestChar, latestChat, {
                            reason: 'maintenance-final-merge'
                        });
                        if (!finalGuardMerge.ok) throw new Error(`canonical commit guard final merge failed: ${finalGuardMerge.reason || 'unknown'}`);
                        const guardVerification = verifyCanonicalTurnCommitGuard(latestLore, canonicalGuard, latestChar, latestChat);
                        if (!guardVerification.ok) {
                            throw new Error(`canonical commit invariant failed: ${guardVerification.reason || 'artifact_missing'}`);
                        }
                        if (maintenanceConfig.debug) {
                            recordRuntimeDebug('log', '[LIBRA] Canonical commit invariant verified before maintenance persist', {
                                __libraDebugMeta: true,
                                label: 'canonical-commit-invariant',
                                turn: canonicalGuard.turn,
                                turnKey: canonicalGuard.turnKey,
                                memoryCount: guardVerification.memoryChecks?.length || 0
                            });
                        }
                    }

                    MemoryEngine.setLorebook(latestChar, latestChat, latestLore);
                    assertMaintenanceTransaction();
                    DebugExportManager.recordPhase(maintenanceLogKey, 'save', {}, 'running');
                    persistenceAttempted = true;
                    const persistResult = await persistLoreToActiveChat(latestChat, latestLore, {
                        targetContext: record?.targetContext?.chatId ? record.targetContext : null,
                        reason: 'turn-maintenance-explicit-target'
                    });
                    const verifiedCandidate = typeof runtimeDetached !== 'undefined' && runtimeDetached === true
                        && persistResult?.candidateOnly === true && persistResult?.verified === true;
                    const verifiedCompletion = persistResult?.ok === true
                        && (persistResult?.canonicalVerified === true || verifiedCandidate);
                    DebugExportManager.recordPhase(maintenanceLogKey, 'save', { canonicalVerified: persistResult?.canonicalVerified === true },
                        verifiedCompletion ? 'done' : (persistResult?.ok !== true && persistResult?.writeIssued === false ? 'failed' : 'uncertain'));
                    if (!verifiedCompletion) {
                        maintenanceUncertain = !(persistResult?.ok !== true && persistResult?.writeIssued === false);
                        persistenceAttempted = maintenanceUncertain;
                        throw new Error(maintenanceUncertain ? 'maintenance canonical save unverified'
                            : `maintenance persist failed: ${persistResult?.reason || 'unknown'}`);
                    }
                    persistenceAttempted = false;
                    if (turnState?.analysisDeferred === true) {
                        const recoveryAttempt = Math.max(0, Number(record?.analysisRecoveryAttempt || 0) || 0);
                        const maxDeferredAttempts = Math.max(0, Math.min(4, Number(maintenanceConfig?.analysisRecoveryDeferredAttempts ?? 2) || 0));
                        if (recoveryAttempt < maxDeferredAttempts && typeof setTimeout === 'function') {
                            const nextAttempt = recoveryAttempt + 1;
                            const delayMs = Math.max(1000, Math.min(60000, Number(maintenanceConfig?.analysisRecoveryDeferredDelayMs ?? 5000) * nextAttempt));
                            const retryRecord = {
                                ...record,
                                analysisRecoveryAttempt: nextAttempt,
                                createdAt: Date.now(),
                                turnState: {
                                    ...turnState,
                                    analysisPending: true,
                                    analysisCompleted: false,
                                    analysisDeferred: false,
                                    analysisRecoveryStatus: 'retry_scheduled',
                                    precomputedMaintenance: null
                                }
                            };
                            setTimeout(() => {
                                try {
                                    scheduleTurnMaintenanceRecord(retryRecord, { reason: `analysis-recovery-${nextAttempt}` });
                                } catch (recoveryScheduleError) {
                                    recordSuppressedRuntimeError('turn_maintenance.analysis_recovery_schedule', recoveryScheduleError, {
                                        turn: turnForMaintenance,
                                        attempt: nextAttempt
                                    });
                                }
                            }, delayMs);
                            deferredRecoveryScheduled = true;
                            DebugExportManager.recordPhase(maintenanceLogKey, 'retry', { attempt: nextAttempt }, 'retry');
                            if (maintenanceConfig?.debug) recordRuntimeDebug('warn', '[LIBRA] Deferred canonical analysis retry scheduled:', {
                                turn: turnForMaintenance,
                                attempt: nextAttempt,
                                maxAttempts: maxDeferredAttempts,
                                delayMs,
                                failures: turnState.analysisRecoveryFailures || []
                            });
                        } else {
                            deferredRecoveryExhausted = true;
                            DebugExportManager.recordPhase(maintenanceLogKey, 'retry', { attempt: recoveryAttempt }, 'failed');
                            if (maintenanceConfig?.debug) recordRuntimeDebug('warn', '[LIBRA] Deferred canonical analysis retries exhausted; safe fallback retained:', {
                                turn: turnForMaintenance,
                                attempts: recoveryAttempt,
                                failures: turnState.analysisRecoveryFailures || []
                            });
                        }
                    }
                    const completionMessage = deferredRecoveryScheduled
                        ? '안전 저장을 완료했고 정밀 분석 재시도를 예약했습니다.'
                        : (deferredRecoveryExhausted
                            ? '정밀 분석 재시도 한도에 도달해 안전 저장 결과를 유지합니다.'
                            : '후처리 결과 저장을 완료했습니다.');
                    updateTurnMaintenanceActivity(record, {
                        status: turnState?.analysisDeferred === true ? (deferredRecoveryScheduled ? 'waiting' : 'failed') : 'done',
                        progress: 100,
                        step: '최종 저장',
                        stepStatus: turnState?.analysisDeferred === true ? 'waiting' : 'done',
                        activeTask: turnState?.analysisDeferred === true ? '정밀 분석 미완료' : '최종 저장 완료',
                        postprocessPhase: 'afterRequest:maintenance',
                        postprocessDetail: completionMessage,
                        message: completionMessage
                    });
                    try {
                        if (record?.activityContext && ActivityDashboardCore?.finish) {
                            ActivityDashboardCore.finish(record.activityContext, turnState?.analysisDeferred === true ? (deferredRecoveryScheduled ? 'waiting' : 'failed') : 'done', completionMessage);
                        }
                    } catch (dashboardFinishError) {
                        recordSuppressedRuntimeError('turn_maintenance.activity_finish', dashboardFinishError, {
                            turn: turnForMaintenance
                        });
                    }
                } finally {
                    loreLock.writeUnlock();
                }
                const maintenanceToasts = [];
                if (absorptionAppliedCount > 0) maintenanceToasts.push('엔티티 흡수 병합을 완료했습니다.');
                if (entityNamesForMaintenance.length > 0 || correctionResult?.corrected) maintenanceToasts.push('엔티티 정리를 완료했습니다.');
                maintenanceToasts.push('월드 정리를 완료했습니다.', '내러티브 정리를 완료했습니다.');
                LibraToast.sequence(maintenanceToasts, { keyPrefix: `libra-maintenance-${turnForMaintenance}`, duration: 1250, gap: 900 });
                if (maintenanceConfig.debug) {
                    const finishedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    recordRuntimeDebug('log', `[LIBRA] Background maintenance complete | turn=${turnForMaintenance} | duration=${Math.max(0, Math.round(finishedAt - startedAt))}ms | llmPending=${MaintenanceLLMQueue.pendingCount} | llmActive=${MaintenanceLLMQueue.activeCount}`);
                }
            } catch (bgErr) {
                maintenanceFailure = bgErr;
                maintenanceUncertain = maintenanceUncertain || persistenceAttempted;
                DebugExportManager.recordPhase(maintenanceLogKey, maintenanceUncertain ? 'save' : 'analysis', {}, maintenanceUncertain ? 'uncertain' : 'failed');
                updateTurnMaintenanceActivity(record, {
                    status: maintenanceUncertain ? 'uncertain' : 'failed',
                    progress: 96,
                    step: maintenanceUncertain ? '저장 결과 확인 필요' : '후처리 분석',
                    stepStatus: maintenanceUncertain ? 'uncertain' : 'failed',
                    activeTask: maintenanceUncertain ? '저장 결과 미확인' : '후처리 분석 실패',
                    postprocessDetail: maintenanceUncertain ? '원문은 보존되며 저장 결과를 확인해야 합니다. 자동 재분석을 예약하지 않습니다.' : bgErr?.message || String(bgErr || 'unknown'),
                    message: maintenanceUncertain ? '저장 결과 미확인: 원문을 보존하고 확인을 기다립니다.' : `후처리 분석 실패: ${bgErr?.message || bgErr}`
                });
                recordRuntimeDebug('error', '[LIBRA] Background maintenance error:', bgErr?.message || bgErr);
            }
        if (maintenanceFailure) {
            let durableReplaySuppressed = false;
            if (runtimeTransactionToken) ScopedRuntimeTransaction.end(runtimeTransactionToken);
            if (record?.targetContext?.durableLedgerRecordKey) {
                try {
                    const terminalResult = await DurableTurnLedger.markStatus({
                        recordKey: record.targetContext.durableLedgerRecordKey,
                        recordId: record.targetContext.durableLedgerRecordId || '',
                        scopeKey: record.targetContext.scopeKey || record.scopeKey || ''
                    }, {
                        analysisStatus: maintenanceUncertain ? 'terminal' : (analysisReservationFailed ? 'deferred' : 'failed'),
                        ...(maintenanceUncertain ? { analysisOutcome: 'uncertain' } : {}),
                        ...(analysisReservationFailed ? { analysisStartedAt: 0 } : {}),
                        analysisRecoveryAttempt: Math.max(0, Number(record?.analysisRecoveryAttempt || 0)),
                        analysisError: maintenanceUncertain ? 'canonical_save_unverified' : String(maintenanceFailure?.message || maintenanceFailure || 'unknown').slice(0, 1000),
                        analysisFinishedAt: analysisReservationFailed ? 0 : Date.now()
                    });
                    durableReplaySuppressed = terminalResult?.ok === true && terminalResult?.verified === true
                        && ['terminal', 'done', 'committed'].includes(String(terminalResult?.record?.analysisStatus || ''));
                } catch (_) {}
            }
            return finishMaintenanceLog({
                status: maintenanceUncertain ? 'uncertain' : 'failed',
                failed: !maintenanceUncertain,
                ...(maintenanceUncertain ? { uncertain: true, durableReplaySuppressed } : {}),
                turn: turnForMaintenance,
                error: String(maintenanceFailure?.message || maintenanceFailure || 'unknown')
            });
        }
        if (runtimeTransactionToken) ScopedRuntimeTransaction.end(runtimeTransactionToken);
        if (record?.targetContext?.durableLedgerRecordKey) {
            try {
                await DurableTurnLedger.markStatus({
                    recordKey: record.targetContext.durableLedgerRecordKey,
                    recordId: record.targetContext.durableLedgerRecordId || '',
                    scopeKey: record.targetContext.scopeKey || record.scopeKey || ''
                }, {
                    analysisStatus: turnState?.analysisDeferred === true ? (deferredRecoveryScheduled ? 'queued' : 'failed') : 'done',
                    analysisRecoveryAttempt: Math.max(0, Number(record?.analysisRecoveryAttempt || 0) || 0),
                    analysisTurn: turnForMaintenance,
                    analysisFinishedAt: Date.now()
                });
            } catch (_) {}
        }
        if (turnState?.analysisDeferred === true) return finishMaintenanceLog({
            status: deferredRecoveryScheduled ? 'deferred' : 'failed',
            failed: !deferredRecoveryScheduled,
            analysisDeferred: true,
            error: deferredRecoveryScheduled ? '' : 'analysis_unavailable',
            turn: turnForMaintenance
        });
        return finishMaintenanceLog({ status: 'done', turn: turnForMaintenance });
    };

