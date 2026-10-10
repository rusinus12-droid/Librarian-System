    const clearTurnMaintenanceScheduleTimer = (entry = null) => {
        if (!entry?.timer) return;
        try { clearTimeout(entry.timer); } catch (error) {
            recordSuppressedRuntimeError('turn_maintenance.clear_timer', error, { chatId: entry.chatId || '' });
        }
        entry.timer = null;
    };

    const enqueueTurnMaintenanceEntry = (entry = null) => {
        if (!entry || entry.queued || entry.running) return;
        const nextRecord = getPendingTurnMaintenanceRecords(entry)[0] || null;
        if (!nextRecord) return;
        // Committed-turn maintenance is part of the canonical memory pipeline,
        // not speculative background work. Under pressure it is serialized and
        // delayed by the governor, but never deferred indefinitely; otherwise the
        // next foreground request can wait on a task that the governor itself keeps
        // postponing.
        const queuedTurn = Number(nextRecord?.turnForMaintenance || 0);
        entry.queued = true;
        const estimatedBytes = ResourceGovernor.estimateBytes(nextRecord, { maxDepth: 4, maxNodes: 256 });
        BackgroundMaintenanceQueue.enqueue(async () => {
            entry.queued = false;
            entry.running = true;
            const record = shiftPendingTurnMaintenanceRecord(entry);
            try {
                const result = await runTurnMaintenanceRecord(record);
                if (
                    result?.status === 'waiting'
                    && Number(record?.analysisDeadlineAt || record?.maintenanceConfig?.__analysisDeadlineAt || 0) > Date.now() + 1500
                ) {
                    upsertPendingTurnMaintenanceRecord(entry, record);
                }
                return result;
            } finally {
                entry.running = false;
                entry.lastFinishedAt = Date.now();
                if (getPendingTurnMaintenanceRecords(entry).length > 0) {
                    scheduleTurnMaintenanceRecord(null, { existingEntry: entry, reason: 'post-run-next' });
                }
            }
        }, `afterRequest-turn-${queuedTurn}`, {
            background: true,
            essential: true,
            estimatedBytes,
            record: nextRecord
        }).catch(e => {
            entry.queued = false;
            entry.running = false;
            recordRuntimeDebug('error', '[LIBRA] Background maintenance queue error:', e?.message || e);
        });
    };

    const scheduleTurnMaintenanceRecord = (record = null, options = {}) => {
        const existingEntry = options?.existingEntry || null;
        if (!record?.chatId && !existingEntry?.chatId) return;
        const maintenanceConfig = record?.maintenanceConfig || existingEntry?.pendingRecords?.[0]?.maintenanceConfig || MemoryEngine.CONFIG;
        let entry = existingEntry || MemoryState.turnMaintenanceSchedulesByChatId.get(record.chatId);
        if (!entry) {
            entry = {
                chatId: record.chatId,
                timer: null,
                queued: false,
                running: false,
                latest: null,
                pendingRecords: [],
                lastFinishedAt: 0
            };
            MemoryState.turnMaintenanceSchedulesByChatId.set(record.chatId, entry);
        } else if (!Array.isArray(entry.pendingRecords)) {
            entry.pendingRecords = [];
        }
        const scheduledRecord = record ? upsertPendingTurnMaintenanceRecord(entry, record) : (getPendingTurnMaintenanceRecords(entry)[0] || null);
        if (!scheduledRecord) return;
        const pendingRecords = getPendingTurnMaintenanceRecords(entry);
        const entityCount = Array.from(scheduledRecord?.turnState?.entitiesToConsolidate || []).length;
        if (maintenanceConfig?.debug) {
            recordRuntimeDebug('log', `[LIBRA] Scheduling background maintenance | turn=${scheduledRecord.turnForMaintenance} | entities=${entityCount} | pendingRecords=${pendingRecords.length} | bgPending=${BackgroundMaintenanceQueue.pendingCount} | llmPending=${MaintenanceLLMQueue.pendingCount} | coalesced=${scheduledRecord.coalescedCount || 1} | reason=${options?.reason || 'schedule'}`);
        }
        if (entry.running || entry.queued) {
            if (maintenanceConfig?.debug) {
                recordRuntimeDebug('log', `[LIBRA] Background maintenance queued by turn | chat=${entry.chatId} | turn=${scheduledRecord.turnForMaintenance} | pendingRecords=${pendingRecords.length} | queued=${entry.queued} | running=${entry.running}`);
            }
            return;
        }
        clearTurnMaintenanceScheduleTimer(entry);
        const configuredDelayMs = Math.max(0, Math.min(600000, Number(maintenanceConfig?.backgroundMaintenanceDelayMs ?? 1500) || 0));
        const cooldownRemainingMs = entry.lastFinishedAt
            ? Math.max(0, BACKGROUND_MAINTENANCE_COOLDOWN_MS - (Date.now() - Number(entry.lastFinishedAt || 0)))
            : 0;
        const delayMs = ResourceGovernor.getMaintenanceDelayMs(Math.max(configuredDelayMs, BACKGROUND_MAINTENANCE_DEBOUNCE_MS, cooldownRemainingMs));
        if (delayMs > 0 && typeof setTimeout === 'function') {
            entry.timer = setTimeout(() => {
                entry.timer = null;
                enqueueTurnMaintenanceEntry(entry);
            }, delayMs);
        } else {
            enqueueTurnMaintenanceEntry(entry);
        }
    };

    const scheduleTurnMaintenance = (char, chat, turnState, aiResponse, turnForMaintenance, maintenanceConfig) => {
        const effectiveConfig = maintenanceConfig || MemoryEngine.CONFIG;
        scheduleTurnMaintenanceRecord(
            buildTurnMaintenanceRecord(char, chat, turnState, aiResponse, turnForMaintenance, effectiveConfig),
            { reason: 'afterRequest' }
        );
    };

    const withTurnMaintenanceLock = async (chatId = 'global', task = async () => {}) => {
        const lockKey = String(chatId || 'global').trim() || 'global';
        const previous = MemoryState.turnMaintenanceLocksByChatId.get(lockKey) || Promise.resolve();
        let current = null;
        current = previous.catch(() => null).then(async () => task());
        MemoryState.turnMaintenanceLocksByChatId.set(lockKey, current);
        try {
            return await current;
        } finally {
            if (MemoryState.turnMaintenanceLocksByChatId.get(lockKey) === current) {
                MemoryState.turnMaintenanceLocksByChatId.delete(lockKey);
            }
        }
    };

    const startCommittedTurnMaintenance = (record = null, options = {}) => {
        if (!record?.chatId) return { mode: 'none', skipped: true, reason: 'missing-record' };
        const config = record.maintenanceConfig || MemoryEngine.CONFIG;
        const mode = normalizeAfterRequestMaintenanceMode(config?.afterRequestMaintenanceMode || DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE);
        if (mode !== 'foreground') {
            const backgroundRecord = options?.activityContext
                ? { ...record, activityContext: options.activityContext }
                : record;
            scheduleTurnMaintenanceRecord(backgroundRecord, { reason: options?.reason || 'afterRequest' });
            try {
                if (options?.activityContext) {
                    ActivityDashboardCore.update(options.activityContext, {
                        phase: 'afterRequest:maintenance',
                        status: 'waiting',
                        progress: Math.max(72, Number(MemoryState.activityDashboard?.progress || 0)),
                        step: options?.step || '후처리 분석',
                        stepStatus: 'waiting',
                        activeTask: options?.step || '후처리 분석 대기',
                        postprocessPhase: 'afterRequest:maintenance',
                        postprocessDetail: options?.message || '커밋 후 백그라운드 분석을 대기합니다.',
                        message: options?.message || '커밋 후 백그라운드 분석을 대기합니다.'
                    });
                }
            } catch (error) {
                recordSuppressedRuntimeError('turn_maintenance.background_queue_dashboard', error);
            }
            return { mode: 'background', queued: true, turn: Number(record.turnForMaintenance || 0) || 0 };
        }
        const scopeKey = String(record.scopeKey || getChatMemoryScopeKey(record.chat) || record.chatId || 'global').trim() || 'global';
        const activityContext = options?.activityContext || null;
        const task = withTurnMaintenanceLock(record.chatId, async () => {
            try {
                if (activityContext) {
                    ActivityDashboardCore.update(activityContext, {
                        phase: 'afterRequest:maintenance',
                        status: 'running',
                        progress: Math.max(72, Number(MemoryState.activityDashboard?.progress || 0)),
                        step: options?.step || '후처리 분석',
                        stepStatus: 'running',
                        activeTask: options?.step || '후처리 분석',
                        postprocessPhase: 'afterRequest:maintenance',
                        postprocessDetail: options?.message || '엔티티/월드/내러티브 분석을 완료하는 중입니다.',
                        message: options?.message || '엔티티/월드/내러티브 분석을 완료하는 중입니다.'
                    });
                }
            } catch (error) {
                recordSuppressedRuntimeError('turn_maintenance.foreground_start_dashboard', error);
            }
            const result = await runTurnMaintenanceRecord({
                ...record,
                foreground: true,
                foregroundReason: options?.reason || 'afterRequest',
                activityContext
            });
            try {
                if (activityContext) {
                    const uncertain = result?.status === 'uncertain';
                    const failed = result?.failed === true || result?.status === 'failed';
                    const deferred = result?.analysisDeferred === true;
                    ActivityDashboardCore.update(activityContext, {
                        phase: 'afterRequest:maintenance',
                        status: uncertain ? 'uncertain' : failed ? 'failed' : (deferred ? 'waiting' : 'running'),
                        progress: Math.max(94, Number(MemoryState.activityDashboard?.progress || 0)),
                        step: '최종 저장',
                        stepStatus: uncertain ? 'uncertain' : failed ? 'failed' : (deferred ? 'waiting' : (result?.skipped ? 'skipped' : 'done')),
                        activeTask: uncertain ? '저장 결과 미확인' : failed ? '후처리 분석 실패' : (deferred ? '정밀 분석 재시도 대기' : (result?.skipped ? '후처리 분석 건너뜀' : '후처리 분석 완료')),
                        postprocessPhase: 'afterRequest:maintenance',
                        postprocessDetail: uncertain ? '저장 결과 미확인: 원문을 보존하고 확인을 기다립니다.' : failed
                            ? `후처리 분석 실패: ${result.error || 'unknown'}`
                            : deferred ? '안전 저장을 유지하며 정밀 분석 재시도를 대기합니다.'
                            : result?.skipped
                            ? `후처리 분석 건너뜀: ${result.reason || 'skipped'}`
                            : '후처리 분석과 상태 저장을 완료했습니다.',
                        message: uncertain ? '저장 결과 미확인: 원문을 보존하고 확인을 기다립니다.' : failed
                            ? `턴 분석 실패: ${result.error || 'unknown'}`
                            : deferred ? '안전 저장을 유지하며 정밀 분석 재시도를 대기합니다.'
                            : result?.skipped
                            ? `턴 분석 건너뜀: ${result.reason || 'skipped'}`
                            : '후처리 분석과 상태 저장을 완료했습니다.'
                    });
                }
            } catch (error) {
                recordSuppressedRuntimeError('turn_maintenance.foreground_finish_dashboard', error);
            }
            return result;
        });
        MemoryState.afterRequestForegroundTasksByScope.set(scopeKey, task);
        task.then(
            () => {
                if (MemoryState.afterRequestForegroundTasksByScope.get(scopeKey) === task) {
                    MemoryState.afterRequestForegroundTasksByScope.delete(scopeKey);
                }
            },
            () => {
                if (MemoryState.afterRequestForegroundTasksByScope.get(scopeKey) === task) {
                    MemoryState.afterRequestForegroundTasksByScope.delete(scopeKey);
                }
            }
        );
        return { mode: 'foreground', task, scopeKey, turn: Number(record.turnForMaintenance || 0) || 0 };
    };

    const awaitCommittedTurnMaintenance = async (started = null, options = {}) => {
        if (!started?.task) return { status: 'none', mode: started?.mode || 'none' };
        const timeoutMs = normalizeAfterRequestForegroundTimeoutMs(options?.timeoutMs ?? MemoryEngine.CONFIG?.afterRequestForegroundTimeoutMs ?? 45000, 45000);
        let timer = null;
        const wait = started.task.then(
            result => ({ status: result?.status === 'uncertain' ? 'uncertain' : result?.failed === true || result?.status === 'failed' ? 'failed' : (result?.analysisDeferred ? 'deferred' : (result?.skipped ? 'skipped' : 'done')), result, error: result?.error || '' }),
            error => ({ status: 'failed', error: String(error?.message || error || 'unknown') })
        );
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve({ status: 'timeout', timeoutMs }), timeoutMs);
        });
        const result = await Promise.race([wait, timeout]);
        if (timer) {
            try { clearTimeout(timer); } catch (_) {}
        }
        if (result?.status === 'timeout') {
            try {
                const scopeKey = String(started.scopeKey || '').trim();
                if (scopeKey && MemoryState.afterRequestForegroundTasksByScope?.get(scopeKey) === started.task) {
                    MemoryState.afterRequestForegroundTasksByScope.delete(scopeKey);
                }
            } catch (_) {}
            if (MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('warn', '[LIBRA] Foreground afterRequest maintenance timed out; detaching task from beforeRequest wait path', {
                    scopeKey: started.scopeKey || '',
                    turn: started.turn || 0,
                    timeoutMs
                });
            }
        }
        return result;
    };

    const buildFastCommittedTurnState = async (char, chat, lore, userMsg, aiResponse, m_id = null, options = {}) => {
        const config = MemoryEngine.CONFIG;
        const turnChannel = (options?.narrativeChannel && typeof options.narrativeChannel === 'object')
            ? options.narrativeChannel
            : classifyNarrativeTurnChannel(userMsg, aiResponse);
        const strictUserMsg = turnChannel.strictUser || getStrictNarrativeUserText(userMsg);
        const strictAiResponse = String(turnChannel.strictAi || Utils.getNarrativeComparableText(aiResponse, 'ai') || '').trim();
        const narrativeUserLabel = strictUserMsg
            || (turnChannel.channel === 'meta' ? String(turnChannel.rawUser || userMsg || '').trim() : '')
            || ((options.autoContinue && aiResponse) ? '[auto-continue]' : '');
        const finalizedTurn = normalizeLegacyMemoryTurnAnchor(options?.finalizedTurn || options?.anchorMeta?.finalizedTurn || options?.anchorMeta?.turn || MemoryEngine.getCurrentTurn?.() || 0);
        const anchorMeta = options?.anchorMeta && typeof options.anchorMeta === 'object' ? options.anchorMeta : {};
        const shouldRecordNarrative = options?.allowNarrativeProcessing !== false && options?.skipNarrativeRecord !== true && !!narrativeUserLabel;
        if (shouldRecordNarrative) {
            const narrativeAnchorMeta = {
                ...anchorMeta,
                m_id: m_id || anchorMeta.m_id || '',
                messageId: m_id || anchorMeta.messageId || '',
                chatId: String(chat?.id || anchorMeta.chatId || '').trim(),
                turnAnchorReason: String(anchorMeta.turnAnchorReason || 'v4.2-finalized-turn').trim() || 'v4.2-finalized-turn'
            };
            await NarrativeTracker.recordTurn(finalizedTurn, narrativeUserLabel, aiResponse, [], config, {
                anchorMeta: narrativeAnchorMeta,
                channel: turnChannel.channel,
                containsMetaSignals: turnChannel.containsMetaSignals
            });
        }
        return {
            config,
            analysisPending: turnChannel.channel === 'scene',
            analysisCompleted: false,
            conversationEmotion: null,
            entityResult: null,
            involvedEntities: [],
            entitiesToConsolidate: [],
            strictUserMsg,
            strictAiResponse,
            narrativeUserLabel,
            recordedNarrativeTurn: shouldRecordNarrative,
            narrativeTrack: turnChannel.channel,
            narrativeChannelPreview: turnChannel,
            anchorMeta,
            hostPromptEvidence: options?.hostPromptEvidence || null,
            finalizedTurn,
            m_id
        };
    };

    const analyzeCommittedTurnState = async (char, chat, lore, fastTurnState = {}, aiResponse = '', turnForMaintenance = 0, maintenanceConfig = MemoryEngine.CONFIG, analysisContext = {}) => {
        if (!fastTurnState?.analysisPending) return fastTurnState;
        const recoveryAttempt = Math.max(0, Number(analysisContext?.recoveryAttempt || 0) || 0);
        let entityAnalysisContext = null;
        let unifiedAnalysis = null;
        try {
            const strictUserForAnalysis = String(fastTurnState.strictUserMsg || fastTurnState.narrativeUserLabel || '').trim();
            const strictAiForAnalysis = String(fastTurnState.strictAiResponse || Utils.getNarrativeComparableText(aiResponse, 'ai') || aiResponse || '').trim();
            if (fastTurnState.narrativeTrack !== 'meta' && maintenanceConfig?.useLLM !== false) {
                entityAnalysisContext = await buildCurrentTurnEntityAnalysisContext(
                    char,
                    chat,
                    lore,
                    strictUserForAnalysis,
                    strictAiForAnalysis,
                    turnForMaintenance,
                    maintenanceConfig,
                    fastTurnState.hostPromptEvidence || null
                );
                unifiedAnalysis = await TurnMaintenanceOptimizer.runUnified?.(
                    turnForMaintenance,
                    {
                        ...fastTurnState,
                        strictUserMsg: strictUserForAnalysis,
                        strictAiResponse: strictAiForAnalysis
                    },
                    aiResponse,
                    MemoryEngine.getEffectiveLorebook(char, chat),
                    maintenanceConfig,
                    {
                        entityStoredInfo: entityAnalysisContext.storedInfo,
                        characterEntityHintBlock: entityAnalysisContext.characterEntityHintBlock,
                        hostPromptValidationBlock: entityAnalysisContext.hostPromptValidationBlock,
                        entityMemoryHintBlock: entityAnalysisContext.memoryHintBlock,
                        recoveryMode: recoveryAttempt > 0,
                        recoveryAttempt
                    }
                );
                if (unifiedAnalysis?.entityExtraction && maintenanceConfig?.debug) {
                    recordRuntimeDebug('log', '[LIBRA] Unified afterRequest analysis accepted:', {
                        turn: turnForMaintenance,
                        profile: unifiedAnalysis.profile || '',
                        label: unifiedAnalysis.label || ''
                    });
                }
            }
        } catch (unifiedError) {
            if (maintenanceConfig?.debug) {
                recordRuntimeDebug('warn', '[LIBRA] Unified afterRequest analysis setup failed:', unifiedError?.message || unifiedError);
            }
            unifiedAnalysis = null;
        }
        const analyzed = await processNarrativeTurnState(
            char,
            chat,
            lore,
            fastTurnState.strictUserMsg || fastTurnState.narrativeUserLabel || '',
            aiResponse,
            fastTurnState.m_id || fastTurnState.anchorMeta?.m_id || null,
            {
                autoContinue: !String(fastTurnState.strictUserMsg || '').trim() && !!aiResponse,
                anchorMeta: fastTurnState.anchorMeta || {},
                narrativeChannel: fastTurnState.narrativeChannelPreview || null,
                skipNarrativeRecord: true,
                hostPromptEvidence: fastTurnState.hostPromptEvidence || null,
                entityAnalysisContext,
                precomputedEntityExtraction: unifiedAnalysis?.entityExtraction || null,
                precomputedSourceMode: unifiedAnalysis?.entityExtraction
                    ? (unifiedAnalysis?.entitySourceMode || unifiedAnalysis?.entityExtraction?.sourceMode || 'afterrequest_unified_analysis')
                    : ''
            }
        );
        const merged = {
            ...fastTurnState,
            ...analyzed,
            analysisPending: false,
            analysisCompleted: unifiedAnalysis?.analysisDeferred !== true,
            analysisDeferred: unifiedAnalysis?.analysisDeferred === true,
            analysisRecoveryStatus: String(unifiedAnalysis?.recoveryStatus || '').trim(),
            analysisRecoveryFailures: Array.isArray(unifiedAnalysis?.recoveryFailures) ? unifiedAnalysis.recoveryFailures.slice(-8) : [],
            foregroundAnalyzedAt: Date.now(),
            precomputedMaintenance: unifiedAnalysis?.maintenance
                ? {
                    ...unifiedAnalysis.maintenance,
                    canonicalPacket: unifiedAnalysis?.canonicalPacket || unifiedAnalysis.maintenance?.canonicalPacket || null,
                    entityExtraction: unifiedAnalysis?.entityExtraction || unifiedAnalysis.maintenance?.entityExtraction || null,
                    entitySourceMode: unifiedAnalysis?.entitySourceMode || unifiedAnalysis?.entityExtraction?.sourceMode || unifiedAnalysis.maintenance?.entitySourceMode || '',
                    analysisProfile: unifiedAnalysis?.profile || unifiedAnalysis.maintenance?.analysisProfile || '',
                    analysisLabel: unifiedAnalysis?.label || unifiedAnalysis.maintenance?.analysisLabel || '',
                    analysisParallel: unifiedAnalysis?.parallel === true
                }
                : null,
            unifiedAnalysisUsed: !!(unifiedAnalysis?.entityExtraction && unifiedAnalysis?.maintenance)
        };
        try {
            const povRecordResult = EntityKnowledgeVaultCore.recordTurnForEntities(merged.involvedEntities || [], {
                userText: '',
                aiText: aiResponse,
                turn: turnForMaintenance,
                source: 'afterRequest-foreground-analysis'
            }, {
                turn: turnForMaintenance,
                source: 'afterRequest-foreground-analysis'
            });
            if (povRecordResult?.changed && maintenanceConfig?.debug) {
                recordRuntimeDebug('log', '[LIBRA] Entity POV vault updated after foreground analysis', {
                    turn: turnForMaintenance,
                    count: povRecordResult.count || 0,
                    entities: merged.involvedEntities || []
                });
            }
        } catch (povRecordError) {
            if (maintenanceConfig?.debug) recordRuntimeDebug('warn', '[LIBRA] Entity POV vault foreground update skipped:', povRecordError?.message || povRecordError);
        }
        try {
            const candidateResult = EntityCandidateCore?.recordInvolvedEntityCandidates?.(lore, merged.involvedEntities || [], {
                turn: turnForMaintenance,
                source: 'maintenance.involvedEntities',
                reason: 'related_but_not_promoted',
                userText: '',
                aiText: aiResponse
            });
            if (candidateResult?.changed && maintenanceConfig?.debug) {
                recordRuntimeDebug('log', '[LIBRA] Entity candidates updated after foreground analysis', {
                    turn: turnForMaintenance,
                    count: candidateResult.count || 0
                });
            }
        } catch (candidateRecordError) {
            if (maintenanceConfig?.debug) recordRuntimeDebug('warn', '[LIBRA] Entity candidate foreground update skipped:', candidateRecordError?.message || candidateRecordError);
        }
        if (Array.isArray(merged.involvedEntities) && merged.involvedEntities.length > 0) {
            try {
                NarrativeTracker.correctTurn(turnForMaintenance, {
                    entities: merged.involvedEntities || []
                });
            } catch (narrativeCorrectionError) {
                if (maintenanceConfig?.debug) recordRuntimeDebug('warn', '[LIBRA] Narrative entity backfill skipped:', narrativeCorrectionError?.message || narrativeCorrectionError);
            }
        }
        return merged;
    };

