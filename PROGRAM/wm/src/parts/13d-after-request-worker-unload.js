    // afterRequest: 기억 저장 및 엔티티 업데이트
    const runLibraAfterRequestWorker = async (content, type, workerContext = {}) => {
        const extractedResponseText = extractResponseTextValue(content);
        let afterDebugKey = DebugExportManager.startRequest('afterRequest', {
            requestType: type,
            request: {
                response: DebugExportManager.textDigest(extractedResponseText || content || ''),
                incomingKind: typeof content
            }
        });
        let responseContent = extractedResponseText || content;
        const mainResponseLanguageTarget = detectMainResponseLanguageTarget(responseContent || '');
        let durableLedgerHandle = workerContext?.replayHandle || null;
        let runtimeTransactionToken = null;
        if (extractedResponseText) content = extractedResponseText;
        if (!Utils.isModelRequestType(type)) {
            _lastUserMessage = '';
            _lastUserMessageRaw = '';
            DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: `non-model request (${String(type || 'unknown').trim() || 'unknown'})`, requestType: type });
            if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('log', `[LIBRA] afterRequest bypassed: non-model request (${type || 'unknown'})`);
            return content;
        }

        const auxBypassReason = getLibraAuxRequestBypassReason(content, type, MemoryEngine.CONFIG, { phase: 'afterRequest' });
        if (auxBypassReason) {
            _lastUserMessage = '';
            _lastUserMessageRaw = '';
            DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: auxBypassReason });
            if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('log', `[LIBRA] afterRequest bypassed: ${auxBypassReason}`);
            return content;
        }
        if (isPureManagedModuleResponse(content)) {
            _lastUserMessage = '';
            _lastUserMessageRaw = '';
            DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: 'pure_managed_module_response' });
            if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('log', '[LIBRA] afterRequest bypassed: pure managed module response');
            return content;
        }

        try {
            if (!Utils.isModelRequestType(type)) {
                if (MemoryEngine.CONFIG?.debug) {
                    recordRuntimeDebug('log', `[LIBRA] afterRequest skipped for non-primary request type: ${type}`);
                }
                DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: 'non_model_request_type', requestType: type });
                return content;
            }

            const afterRequestOrigin = workerContext?.origin && typeof workerContext.origin === 'object'
                ? workerContext.origin
                : null;
            if (!afterRequestOrigin?.chatId || normalizeRisuIndex(afterRequestOrigin?.characterIndex) < 0) {
                DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: 'missing_explicit_origin' });
                return content;
            }
            if (!durableLedgerHandle?.recordKey && workerContext?.durableLedgerPromise) {
                try { durableLedgerHandle = await workerContext.durableLedgerPromise; }
                catch (ledgerPromiseError) {
                    recordRuntimeDebug('error', '[LIBRA] Scheduled durable turn ledger append failed:', ledgerPromiseError?.message || ledgerPromiseError);
                }
            }
            if (mainResponseLanguageTarget && afterRequestOrigin.scopeKey) {
                MemoryState.mainResponseLanguageByScope.set(afterRequestOrigin.scopeKey, mainResponseLanguageTarget);
            }
            try {
                if (durableLedgerHandle?.recordKey) {
                    // Replay uses the already durable receipt and must not
                    // overwrite its committed/analysis state with "observed".
                } else {
                durableLedgerHandle = await DurableTurnLedger.appendObserved({
                    origin: afterRequestOrigin,
                    recordId: String(afterRequestOrigin.requestId || '').trim() || undefined,
                    scopeKey: afterRequestOrigin.scopeKey,
                    characterId: afterRequestOrigin.characterId,
                    characterIndex: afterRequestOrigin.characterIndex,
                    chatId: afterRequestOrigin.chatId,
                    chatIndex: afterRequestOrigin.chatIndex,
                    requestSequence: afterRequestOrigin.requestSequence || 0,
                    requestType: type,
                    observedAt: afterRequestOrigin.observedAt || afterRequestOrigin.queuedAt || Date.now(),
                    analysisDeadlineAt: afterRequestOrigin.analysisDeadlineAt || 0,
                    originMessageCount: afterRequestOrigin.messageCount || 0,
                    userText: afterRequestOrigin?.canonicalUser?.raw || afterRequestOrigin?.canonicalUser?.strict || '',
                    assistantText: extractResponseTextValue(content, new WeakSet(), true) || responseContent,
                    mainResponseLanguageTarget
                });
                if (!durableLedgerHandle?.ok) {
                    recordRuntimeDebug('warn', '[LIBRA] Durable turn ledger append skipped:', durableLedgerHandle?.reason || 'unknown');
                }
                }
            } catch (ledgerError) {
                recordRuntimeDebug('error', '[LIBRA] Durable turn ledger append failed:', ledgerError?.message || ledgerError);
            }
            if (!durableLedgerHandle?.ok || durableLedgerHandle?.verified !== true) {
                DebugExportManager.finishRequest(afterDebugKey, 'waiting', { reason: 'raw_receipt_unverified' });
                return content;
            }
            const resolvedTarget = await resolveChatContextByTarget(afterRequestOrigin, { allowActiveFallback: false });
            if (!resolvedTarget?.ok) {
                if (durableLedgerHandle?.ok) {
                    try {
                        await DurableTurnLedger.markStatus(durableLedgerHandle, {
                            status: resolvedTarget?.reason === 'reset_generation_changed' ? 'discarded' : (workerContext?.committedReplay ? 'committed' : 'observed'),
                            analysisStatus: resolvedTarget?.reason === 'reset_generation_changed' ? 'discarded' : 'deferred',
                            deferredReason: resolvedTarget?.reason || 'origin_target_unavailable'
                        });
                    } catch (_) {}
                }
                DebugExportManager.finishRequest(afterDebugKey, 'waiting', {
                    reason: resolvedTarget?.reason || 'origin_target_unavailable',
                    chatId: afterRequestOrigin.chatId,
                    requestSequence: afterRequestOrigin.requestSequence || 0
                });
                return content;
            }
            let char = resolvedTarget.char;
            let chat = resolvedTarget.chat;
            if (!isLibraRuntimeEpochActive()) return content;
            const activeContext = await resolveActiveChatContext();
            const targetStillActive = !!(
                activeContext?.chat
                && String(afterRequestOrigin.runtimeScopeKey || afterRequestOrigin.scopeKey || '') === String(activeContext.scopeKey || '')
                && String(activeContext.chat?.id || '').trim() === String(afterRequestOrigin.chatId || '').trim()
                && (!afterRequestOrigin.characterId
                    || String(activeContext.char?.id || activeContext.char?.chaId || '').trim() === String(afterRequestOrigin.characterId || '').trim())
            );
            if (!targetStillActive || ScopedRuntimeTransaction.current()) {
                if (durableLedgerHandle?.ok) {
                    try {
                        await DurableTurnLedger.markStatus(durableLedgerHandle, {
                            status: workerContext?.committedReplay ? 'committed' : 'observed',
                            analysisStatus: 'deferred',
                            deferredReason: !targetStillActive ? 'target_not_active' : 'runtime_transaction_busy'
                        });
                    } catch (_) {}
                }
                DebugExportManager.finishRequest(afterDebugKey, 'waiting', {
                    reason: !targetStillActive ? 'target_not_active' : 'runtime_transaction_busy',
                    chatId: afterRequestOrigin.chatId,
                    requestSequence: afterRequestOrigin.requestSequence || 0
                });
                return content;
            }
            const activation = await PersonaRuntimeCoordinator.activate(activeContext);
            if (!activation.ok) {
                if (durableLedgerHandle?.ok) {
                    try { await DurableTurnLedger.markStatus(durableLedgerHandle, { analysisStatus: 'deferred', deferredReason: activation.reason }); } catch (_) {}
                }
                return content;
            }
            char = activation.context.char;
            chat = activation.context.chat;
            if (workerContext?.committedReplay) {
                // Fast commit already survived. Resume analysis from verified
                // canonical evidence without re-creating memories or turn anchors.
                const receipt = workerContext.committedReplay;
                const replayLease = RuntimeStateLease.capture();
                if (chat.isStreaming === true) return content;
                const lore = MemoryEngine.getLorebook(char, chat);
                const candidate = TurnRecordLedger.loadState(lore, chat, char).records
                    .find(record => record.turnKey === receipt.turnKey && record.status === 'active');
                const host = candidate && findPersistedAssistantSnapshotByHash(chat, candidate.sourceHash, {
                    expectedUserText: receipt.userText || '', expectedMessageIds: candidate.liveMessageIds
                });
                const commit = host && await findVerifiedCanonicalTurnCommit(char, chat, {
                    sourceHash: candidate.sourceHash, turnKey: candidate.turnKey,
                    messageSignature: host.latestMessageSignature,
                    liveMessageIds: normalizeCanonicalMessageIds([host.latestLiveId, host.latestStableId]),
                    canonicalScope: receipt.canonicalScope || '', resetGeneration: receipt.resetGeneration ?? 0
                });
                RuntimeStateLease.assertCurrent(replayLease);
                if (!commit) throw new Error('committed_replay_evidence_unavailable');
                const anchorMeta = {
                    ...commit.record, messageSignature: host.latestMessageSignature,
                    m_id: host.latestStableId || host.latestLiveId, messageId: host.latestStableId || host.latestLiveId
                };
                const state = await buildFastCommittedTurnState(char, chat, lore, receipt.userText || '',
                    host.latestComparable, anchorMeta.m_id, {
                        finalizedTurn: commit.record.turn, anchorMeta, skipNarrativeRecord: true,
                        autoContinue: !String(receipt.userText || '').trim()
                    });
                RuntimeStateLease.assertCurrent(replayLease);
                state.targetContext = {
                    ...afterRequestOrigin, durableLedgerRecordId: receipt.recordId,
                    durableLedgerRecordKey: receipt.recordKey
                };
                const maintenanceRecord = buildTurnMaintenanceRecord(char, chat, state, host.latestComparable,
                    commit.record.turn, MemoryEngine.CONFIG, { canonicalCommitGuard: commit.guard });
                // A replay cannot create recovery ownership by incrementing an old ordinal.
                maintenanceRecord.analysisRecoveryAttempt = 0;
                const started = startCommittedTurnMaintenance(maintenanceRecord, { reason: 'durable-committed-analysis-replay' });
                if (started?.task) await started.task;
                return content;
            }
            runtimeTransactionToken = ScopedRuntimeTransaction.begin(
                activation.admission.runtimeScopeKey,
                'afterRequest:commit'
            );
            if (!runtimeTransactionToken) {
                if (durableLedgerHandle?.ok) {
                    try { await DurableTurnLedger.markStatus(durableLedgerHandle, { analysisStatus: 'deferred', deferredReason: 'runtime_transaction_race' }); } catch (_) {}
                }
                return content;
            }
            let db = await getLibraIdentityDatabase();
            EntityManager.refreshIdentity(char, db, chat);
            tryRearmGreetingIsolation(chat);
            const msgs_all = getChatMessages(chat);
            if (!chat || msgs_all.length === 0) {
                DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: !chat ? 'missing_chat' : 'empty_chat_messages' });
                return content;
            }
            DebugExportManager.updateRequestContext(afterDebugKey, {
                scopeKey: getChatRuntimeScopeKey(chat, char),
                chatId: String(chat?.id || '').trim(),
                request: {
                    charName: String(char?.name || '').trim(),
                    chatMessageCount: msgs_all.length
                }
            });
            const responseTransport = resolveMainResponseTransportState({
                chat,
                requestOrigin: afterRequestOrigin,
                responseText: responseContent
            });
            DebugExportManager.recordPhase(afterDebugKey, 'origin_transport', {
                originMatched: !!afterRequestOrigin,
                requestSequence: afterRequestOrigin?.requestSequence || 0,
                transportMode: responseTransport?.mode || 'unknown',
                transportSource: responseTransport?.source || '',
                response: DebugExportManager.textDigest(responseContent || '')
            });
            const originGuardLatestAssistant = buildLatestAssistantSnapshot(chat, { includeStableId: true });
            const originGuardAiText = Utils.getNarrativeComparableText(
                Utils.getMemorySourceText(responseContent || ''),
                'ai'
            );
            const originGuardAiHash = String((originGuardAiText ? TokenizerEngine.simpleHash(originGuardAiText) : '') || '').trim();
            const originGuardLatestAssistantMatches = !!(
                originGuardAiHash
                && originGuardLatestAssistant.latestHash
                && originGuardLatestAssistant.latestHash === originGuardAiHash
            );
            const afterOriginAuxBypassReason = getLibraAuxRequestBypassReason(responseContent, type, MemoryEngine.CONFIG, {
                phase: 'afterRequest',
                afterRequestOriginChecked: true,
                afterRequestOrigin,
                latestAssistantMatchesCurrent: originGuardLatestAssistantMatches
            });
            if (afterOriginAuxBypassReason) {
                _lastUserMessage = '';
                _lastUserMessageRaw = '';
                DebugExportManager.recordPhase(afterDebugKey, 'auxiliary_request_guard', {
                    status: 'skipped',
                    requestType: type,
                    reason: afterOriginAuxBypassReason,
                    originMatched: !!afterRequestOrigin,
                    transportMode: responseTransport?.mode || 'unknown',
                    latestAssistantMatchesCurrent: originGuardLatestAssistantMatches,
                    response: DebugExportManager.textDigest(responseContent || '')
                }, 'skipped');
                DebugExportManager.finishRequest(afterDebugKey, 'skipped', {
                    reason: afterOriginAuxBypassReason,
                    requestType: type
                });
                if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('log', `[LIBRA] afterRequest bypassed: ${afterOriginAuxBypassReason}`);
                return responseContent;
            }
            clearStreamOutputRecoveryTimer(chat);

            if (await MemoryEngine.normalizeLoreStorage(char, chat)) {
                const normalizationPersistResult = await persistLoreToActiveChat(chat, MemoryEngine.getLorebook(char, chat), {
                    ...(WmWriterRuntime.enabled?{expectedSource:WmWriterRuntime.latestSource(LibraDataStorage.scopeKeyFor(char,chat)),operation:'sync'}:{globalLore:Array.isArray(char?.globalLore)?char.globalLore:(Array.isArray(char?.lorebook)?char.lorebook:[])})
                });
                requireSuccessfulLorePersist(normalizationPersistResult, 'afterRequest lore normalization persist');
            }

            // 인사말 필터링: 자동 생성된 첫 인사말은 분석에서 제외
            const aiMsg = msgs_all[msgs_all.length - 1];
            if (aiMsg && getMessageSignature(aiMsg) === MemoryState.ignoredGreetingSignature) {
                if (MemoryEngine.CONFIG.debug) recordRuntimeDebug('log', '[LIBRA] Bypassing analysis for isolated greeting');
                DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: 'isolated_greeting' });
                return content;
            }

            const canonicalUser = resolveCanonicalUserPayload(msgs_all);
            const originCanonical = sanitizeCanonicalUserPayload(
                afterRequestOrigin?.canonicalUser && typeof afterRequestOrigin.canonicalUser === 'object'
                    ? afterRequestOrigin.canonicalUser
                    : {}
            );
            // Detached workers may run after newer user turns have already been
            // appended. The beforeRequest origin is the authoritative pairing;
            // current-chat text is only a fallback for legacy/originless paths.
            const userMsgForNarrative = String(originCanonical.strict || '').trim() || canonicalUser.strict;
            const userMsgForMemory = String(originCanonical.raw || originCanonical.strict || '').trim() || canonicalUser.raw || canonicalUser.strict;
            try {
                const secrecyAuditScopeKey = getChatRuntimeScopeKey(chat, char);
                const secrecyAuditLore = MemoryEngine.getLorebook(char, chat);
                SecretKnowledgeCore.loadState(secrecyAuditLore, {
                    scopeKey: secrecyAuditScopeKey,
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                EntityKnowledgeVaultCore.loadState(secrecyAuditLore, {
                    scopeKey: secrecyAuditScopeKey,
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                const responseTextForAudit = String(responseContent || '');
                const lowerAuditText = `${userMsgForNarrative}\n${userMsgForMemory}\n${responseTextForAudit}`.toLowerCase();
                const auditFocusNames = Array.from(EntityManager.getEntityCache().values())
                    .map(entity => String(entity?.name || '').trim())
                    .filter(Boolean)
                    .filter(name => lowerAuditText.includes(name.toLowerCase()))
                    .slice(0, 12);
                SecretKnowledgeCore.applySceneEvidenceReveal({
                    texts: [userMsgForNarrative, userMsgForMemory],
                    focusNames: auditFocusNames,
                    turn: Number(MemoryEngine.getCurrentTurn?.() || 0) + 1,
                    source: 'afterRequest-scene-evidence'
                });
                const secretAudit = SecretKnowledgeCore.auditResponseForLeaks(responseTextForAudit, {
                    viewerId: 'main_request'
                });
                const boundaryAudit = EntityKnowledgeVaultCore.auditResponseKnowledgeBoundary(secretAudit?.text || responseTextForAudit, {
                    focusNames: auditFocusNames
                });
                if (secretAudit?.changed || boundaryAudit?.changed) {
                    responseContent = boundaryAudit?.text || secretAudit?.text || responseContent;
                    recordRuntimeDebug('warn', {
                        phase: 'afterRequest',
                        event: 'pov-secret-response-redaction',
                        secretLeaks: secretAudit?.leaks || [],
                        povViolations: boundaryAudit?.violations || [],
                        focusNames: auditFocusNames
                    }, {
                        __libraDebugMeta: true,
                        label: 'afterRequest-pov-secret-audit',
                        turn: MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0,
                        scopeKey: secrecyAuditScopeKey,
                        chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                    });
                }
            } catch (secretAuditError) {
                if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA] afterRequest POV/secret audit skipped:', secretAuditError?.message || secretAuditError);
            }
            const responseCapturePayload = resolveMainResponseMemoryCapturePayload({
                chat,
                requestOrigin: afterRequestOrigin,
                responseTransport,
                responsePayload: responseContent,
                displayContent: responseContent
            });
            if (MemoryEngine.CONFIG?.debug && responseCapturePayload?.strategy && responseCapturePayload.strategy !== 'afterRequest') {
                recordRuntimeDebug('log', '[LIBRA] afterRequest response transport resolved', {
                    __libraDebugMeta: true,
                    mode: responseTransport?.mode || 'unknown',
                    source: responseTransport?.source || '',
                    strategy: responseCapturePayload.strategy,
                    captureSource: responseCapturePayload.source || '',
                    requestMatched: responseCapturePayload.requestMatched === true
                });
            }
            const aiResponseOriginal = String(responseCapturePayload?.responsePayload || responseContent || '');
            const aiResponseRaw = Utils.getMemorySourceText(aiResponseOriginal);
            const aiResponse = Utils.getNarrativeComparableText(aiResponseRaw, 'ai');
            if (MemoryEngine.CONFIG?.debug && aiResponseRaw !== aiResponseOriginal.trim()) {
                recordRuntimeDebug('log', `[LIBRA] afterRequest sanitized managed module artifacts for commit | beforeChars=${aiResponseOriginal.length} | afterChars=${aiResponseRaw.length}`);
            }
            const originSaysAutoContinue = afterRequestOrigin?.autoContinue === true;
            const isAutoContinueTurn = !userMsgForNarrative && !userMsgForMemory && !!aiResponse && originSaysAutoContinue;
            const isRaceCondition = !userMsgForNarrative && !userMsgForMemory && !!aiResponse && !originSaysAutoContinue;
            const narrativeChannelPreview = classifyNarrativeTurnChannel(userMsgForMemory || userMsgForNarrative, aiResponse);
            const allowNarrativeProcessing = (!!aiResponse && (narrativeChannelPreview.channel === 'meta' || !narrativeChannelPreview.bypassSuggested)) || isAutoContinueTurn;
            // afterRequest can arrive before the beforeRequest origin/user text is
            // recoverable. Keep narrative handling available, but only capture a
            // user-empty turn when beforeRequest explicitly marked it as auto-continue.
            const hasRecoveredUserEvidence = !!userMsgForMemory || !!userMsgForNarrative;
            const memoryCaptureFallbackReason = (!isRaceCondition && !hasRecoveredUserEvidence && !!aiResponse && allowNarrativeProcessing)
                ? 'assistant_response_only_afterrequest_recovery'
                : '';
            const allowMemoryCapture = !isRaceCondition && !!aiResponse && (isAutoContinueTurn || hasRecoveredUserEvidence || allowNarrativeProcessing);
            DebugExportManager.recordPhase(afterDebugKey, 'response_capture', {
                strategy: responseCapturePayload?.strategy || 'afterRequest',
                source: responseCapturePayload?.source || '',
                requestMatched: responseCapturePayload?.requestMatched === true,
                aiOriginal: DebugExportManager.textDigest(aiResponseOriginal),
                aiRaw: DebugExportManager.textDigest(aiResponseRaw),
                aiNarrative: DebugExportManager.textDigest(aiResponse),
                userNarrative: DebugExportManager.textDigest(userMsgForNarrative),
                userMemory: DebugExportManager.textDigest(userMsgForMemory),
                narrativeChannel: narrativeChannelPreview?.channel || '',
                bypassSuggested: narrativeChannelPreview?.bypassSuggested === true,
                originAutoContinue: originSaysAutoContinue,
                raceConditionWithoutOrigin: isRaceCondition,
                allowNarrativeProcessing,
                allowMemoryCapture,
                memoryCaptureFallbackReason
            }, (allowNarrativeProcessing || allowMemoryCapture) ? 'done' : 'skipped');

            if (!allowNarrativeProcessing && !allowMemoryCapture) {
                if (MemoryEngine.CONFIG.debug) {
                    recordRuntimeDebug('log', '[LIBRA] afterRequest bypassed for meta/tool-style turn');
                }
                DebugExportManager.finishRequest(afterDebugKey, 'skipped', { reason: 'meta_or_tool_style_turn' });
                return content;
            }

            // 세션 변경 감지: 다른 채팅방으로 전환된 경우 모든 캐시 강제 재구축
            const _chatId = chat?.id || null;
            const _scopeKey = getChatRuntimeScopeKey(chat, char);
            const activityContext = { scopeKey: _scopeKey, activityDashboard: MemoryEngine.CONFIG.activityDashboard };
            const lore = MemoryEngine.getLorebook(char, chat);
            if (MemoryState._activeScopeKey !== _scopeKey) {
                if (MemoryState._activeScopeKey) rememberScopedRuntimeState(MemoryState._activeScopeKey);
                reloadChatScopedRuntime(lore, _chatId, { resetSessionCaches: true, forceWorldReload: true, scopeKey: _scopeKey, resetScopedState: true });
                enterRefreshStabilizeWindow();
                MemoryState.currentSessionId = buildScopedSessionId(_scopeKey);
            } else {
                HierarchicalWorldManager.loadWorldGraph(lore);
            }
            const latestAssistant = buildLatestAssistantSnapshot(chat, { includeStableId: true });
            // 롤백 저널 기반 턴 예측은 삭제됐다 (스냅샷 롤백 기능 제거).
            const predictedTurn = Math.max(
                deriveRuntimeTurnFromLorebook(lore),
                MemoryEngine.getCurrentTurn()
            ) + 1;
            const aiResponseHash = String((aiResponse ? TokenizerEngine.simpleHash(aiResponse) : '') || '').trim();
            const originLatestAssistant = {
                index: afterRequestOrigin?.latestAiIndex,
                id: afterRequestOrigin?.latestAiId || '',
                hash: afterRequestOrigin?.latestAiHash || '',
                signature: afterRequestOrigin?.latestAiSignature || ''
            };
            const matchingAssistant = findPersistedAssistantSnapshotByHash(chat, aiResponseHash, {
                originMessageCount: Math.max(0, Number(afterRequestOrigin?.messageCount || 0)),
                expectedUserText: userMsgForMemory || userMsgForNarrative || '',
                allowContinuation: true,
                originLatestAssistant
            });
            const latestAssistantMatchesCurrent = !!matchingAssistant
                && matchingAssistant.latestAiMsg === latestAssistant.latestAiMsg;
            const currentAssistantMessageId = latestAssistantMatchesCurrent
                ? (latestAssistant.latestLiveId || latestAssistant.latestStableId || buildAfterRequestSyntheticMessageId(chat, predictedTurn, aiResponseHash))
                : buildAfterRequestSyntheticMessageId(chat, predictedTurn, aiResponseHash);
            const currentAssistantIds = normalizeCanonicalMessageIds(
                latestAssistantMatchesCurrent
                    ? [latestAssistant.latestLiveId, latestAssistant.latestStableId, currentAssistantMessageId]
                    : [currentAssistantMessageId]
            );
            const currentAssistantSignature = latestAssistantMatchesCurrent
                ? (latestAssistant.latestMessageSignature || buildAfterRequestSyntheticMessageSignature(predictedTurn, aiResponse, aiResponseHash))
                : buildAfterRequestSyntheticMessageSignature(predictedTurn, aiResponse, aiResponseHash);
            try {
                const recallInjection = RecallFeedbackManager?.consumeInjection?.(_scopeKey) || null;
                if (recallInjection?.items?.length) {
                    const feedbackResult = RecallFeedbackManager.appendFeedback(lore, recallInjection, aiResponseRaw || aiResponse, {
                        turn: predictedTurn,
                        responseHash: aiResponseHash,
                        requestType: type,
                        requestSequence: Math.max(0, Number(afterRequestOrigin?.requestSequence || 0)),
                        scopeKey: _scopeKey,
                        chatId: String(chat?.id || '').trim(),
                        config: MemoryEngine.CONFIG
                    });
                    if (feedbackResult?.changed) {
                        MemoryEngine.setLorebook(char, chat, lore);
                        DebugExportManager.recordPhase(afterDebugKey, 'recall_feedback', {
                            injectedCount: feedbackResult.record?.injectedCount || 0,
                            counts: feedbackResult.record?.counts || {},
                            responseHash: feedbackResult.record?.responseHash || ''
                        }, 'done');
                    } else {
                        DebugExportManager.recordPhase(afterDebugKey, 'recall_feedback', {
                            reason: feedbackResult?.reason || 'unchanged'
                        }, 'skipped');
                    }
                } else {
                    DebugExportManager.recordPhase(afterDebugKey, 'recall_feedback', {
                        reason: 'no_recent_injection'
                    }, 'skipped');
                }
            } catch (feedbackError) {
                recordSuppressedRuntimeError('recall_feedback.after_request_failed', feedbackError, {
                    scopeKey: _scopeKey,
                    chatId: String(chat?.id || '').trim()
                });
                DebugExportManager.recordPhase(afterDebugKey, 'recall_feedback', {
                    error: feedbackError?.message || String(feedbackError || '')
                }, 'skipped');
            }
            const pendingPayload = {
                sourceCapture: afterRequestOrigin?.sourceCapture ? safeClone(afterRequestOrigin.sourceCapture) : null,
                userMsgForNarrative,
                userMsgForMemory,
                aiResponse,
                aiResponseRaw,
                autoContinueTurn: isAutoContinueTurn,
                allowNarrativeProcessing,
                allowMemoryCapture,
                narrativeChannelPreview,
                aiHash: aiResponseHash || null,
                sourceHash: aiResponseHash || null,
                initialMessageId: currentAssistantMessageId,
                liveMessageIds: currentAssistantIds,
                messageSignature: currentAssistantSignature,
                messageCount: Math.max(0, Number(afterRequestOrigin?.messageCount ?? latestAssistant.currentMessageCount) || 0),
                originMessageCount: Math.max(0, Number(afterRequestOrigin?.messageCount || 0) || 0),
                originLatestAssistant,
                predictedTurn,
                turnAnchor: predictedTurn,
                turnAnchorTurn: predictedTurn,
                userTurnKey: buildLogicalUserTurnKey(userMsgForNarrative, userMsgForMemory, isAutoContinueTurn),
                requestType: type,
                requestSequence: Math.max(0, Number(afterRequestOrigin?.requestSequence || 0)),
                hostPromptEvidence: afterRequestOrigin?.hostPromptEvidence || null,
                targetContext: {
                    resetGeneration: afterRequestOrigin.resetGeneration ?? 0,
                    canonicalScope: afterRequestOrigin.canonicalScope || activation.admission.scopeKey,
                    characterId: String(afterRequestOrigin?.characterId || char?.id || char?.chaId || '').trim(),
                    characterIndex: normalizeRisuIndex(afterRequestOrigin?.characterIndex ?? resolvedTarget?.charIdx),
                    chatId: String(afterRequestOrigin?.chatId || chat?.id || '').trim(),
                    chatIndex: normalizeRisuIndex(afterRequestOrigin?.chatIndex ?? resolvedTarget?.chatIndex),
                    scopeKey: String(afterRequestOrigin?.scopeKey || resolvedTarget?.scopeKey || '').trim(),
                    requestSequence: Math.max(0, Number(afterRequestOrigin?.requestSequence || 0))
                    ,durableLedgerRecordId: String(durableLedgerHandle?.recordId || '').trim()
                    ,durableLedgerRecordKey: String(durableLedgerHandle?.recordKey || '').trim()
                    ,mainResponseLanguageTarget: mainResponseLanguageTarget || MemoryState.mainResponseLanguageByScope.get(afterRequestOrigin?.scopeKey || '') || ''
                    ,analysisDeadlineAt: Math.max(0, Number(afterRequestOrigin?.analysisDeadlineAt || durableLedgerHandle?.record?.analysisDeadlineAt || 0) || 0)
                }
            };
            const alreadyFinalizedBeforeRegister = PendingTurnManager.isLikelyAlreadyFinalized(chat, pendingPayload);
            const pending = alreadyFinalizedBeforeRegister ? null : PendingTurnManager.registerPending(chat, pendingPayload, {durableReplay: !!workerContext?.replayHandle});
            if (pending) {
                ActivityDashboardCore.beginRequest({
                    flow: 'afterRequest',
                    title: 'LIBRA turn commit',
                    stageLabel: '응답 후처리를 시작합니다.',
                    activeTask: '턴 앵커 생성',
                    postprocessPhase: 'afterRequest',
                    postprocessDetail: `예상 턴 ${predictedTurn} 앵커 준비`,
                    status: 'running',
                    progress: 50
                }, activityContext);
                ActivityDashboardCore.update(activityContext, {
                    phase: 'afterRequest',
                    status: 'running',
                    progress: 56,
                    step: '턴 앵커',
                    stepStatus: 'done',
                    activeTask: '턴 앵커 생성',
                    postprocessPhase: 'afterRequest',
                    postprocessDetail: `예상 턴 ${predictedTurn} 앵커 준비`,
                    message: `예상 턴 ${predictedTurn} 커밋을 준비했습니다.`
                });
            }
            DebugExportManager.recordPhase(afterDebugKey, 'turn_anchor', {
                pendingRegistered: !!pending,
                alreadyFinalized: alreadyFinalizedBeforeRegister,
                predictedTurn,
                aiHash: aiResponseHash,
                latestAssistantMatchesCurrent,
                messageId: currentAssistantMessageId || '',
                requestSequence: Math.max(0, Number(afterRequestOrigin?.requestSequence || 0))
            }, pending ? 'done' : 'skipped');
            if (pending) {
                ActivityDashboardCore.update(activityContext, {
                    phase: 'afterRequest:commit',
                    status: 'running',
                    progress: 58,
                    step: '커밋 저장',
                    stepStatus: 'running',
                    activeTask: '턴 커밋 저장',
                    postprocessPhase: 'afterRequest:commit',
                    postprocessDetail: '로어북 메모리, 턴 레저, 롤백 저널을 저장합니다.',
                    message: '턴 커밋을 저장하고 있습니다.'
                });
                const afterRequestMaintenanceMode = normalizeAfterRequestMaintenanceMode(MemoryEngine.CONFIG?.afterRequestMaintenanceMode || DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE);
                const reconcileAlreadyFinalizedCommit = (result = null) => {
                    if (String(result?.status || '') !== 'none') return result;
                    if (PendingTurnManager.getPending(chat)) return result;
                    const finalized = PendingTurnManager.getFinalizedTurnMeta(chat);
                    if (!finalized) return result;
                    const finalizedTurn = normalizeLegacyMemoryTurnAnchor(
                        finalized.finalizedTurn
                        || finalized.turnAnchorTurn
                        || finalized.turnAnchor
                        || finalized.turn
                        || 0
                    );
                    const turnMatches = finalizedTurn > 0 && finalizedTurn === normalizeLegacyMemoryTurnAnchor(predictedTurn);
                    const hashMatches = !!aiResponseHash && [
                        finalized.sourceHash,
                        finalized.aiHash,
                        finalized.responseHash
                    ].some(value => String(value || '').trim() === String(aiResponseHash || '').trim());
                    const signatureMatches = !!currentAssistantSignature
                        && String(finalized.messageSignature || '').trim()
                        && String(finalized.messageSignature || '').trim() === String(currentAssistantSignature || '').trim();
                    const finalizedIds = new Set(normalizeCanonicalMessageIds([
                        finalized.liveMessageIds,
                        finalized.sourceMessageIds,
                        finalized.messageId,
                        finalized.m_id
                    ]));
                    const idMatches = normalizeCanonicalMessageIds(currentAssistantIds).some(id => finalizedIds.has(id));
                    if (!(turnMatches || hashMatches || signatureMatches || idMatches)) return result;
                    return {
                        ...(result || {}),
                        status: 'already-committed',
                        reason: 'already_finalized_afterrequest_race',
                        turn: finalizedTurn || predictedTurn,
                        turnKey: finalized.turnKey || '',
                        memoryCreated: !!finalized.memoryKey,
                        maintenanceRecord: null,
                        finalizedMetaRecovered: true
                    };
                };
                let immediateCommit = await PendingTurnManager.commitPendingNow(char, chat, 'afterRequest-immediate', {
                    pending,
                    responseText: aiResponseRaw,
                    deferMaintenance: true,
                    suppressFinalizeRetry: false
                });
                immediateCommit = reconcileAlreadyFinalizedCommit(immediateCommit);
                if (durableLedgerHandle?.ok && immediateCommit?.preserveReceiptStatus !== true) {
                    try {
                        await DurableTurnLedger.markStatus(durableLedgerHandle, {
                            status: (immediateCommit?.status === 'finalized' || immediateCommit?.status === 'already-committed') ? 'committed' : 'observed',
                            analysisStatus: immediateCommit?.maintenanceRecord
                                ? 'queued'
                                : ((immediateCommit?.status === 'finalized' || immediateCommit?.status === 'already-committed') ? 'done' : (immediateCommit?.reason === 'blocked_host_source_changed' ? 'blocked_host_source_changed' : 'awaiting_host_anchor')),
                            turn: (immediateCommit?.status === 'finalized' || immediateCommit?.status === 'already-committed') ? (Number(immediateCommit?.turn || 0) || 0) : 0,
                            turnKey: String(immediateCommit?.turnKey || '').trim(),
                            commitStatus: String(immediateCommit?.status || 'waiting').trim(),
                            deferredReason: String(immediateCommit?.reason || '').trim()
                        });
                    } catch (ledgerStatusError) {
                        recordSuppressedRuntimeError('durable_turn_ledger.commit_status', ledgerStatusError, {
                            chatId: String(chat?.id || '').trim(),
                            requestSequence: afterRequestOrigin?.requestSequence || 0
                        });
                    }
                }
                if (
                    immediateCommit?.status === 'waiting'
                    && PendingTurnManager.getPending(chat)
                ) {
                    // afterRequest runs before Risu has guaranteed that the response
                    // is accepted into the chat. Never block generation or manufacture
                    // a synthetic provenance anchor. The pending record is retried by
                    // the bounded finalize timer / next host hook and is committed only
                    // after the real assistant message is observable.
                    ActivityDashboardCore.update(activityContext, {
                        phase: 'afterRequest:commit',
                        status: 'running',
                        progress: 66,
                        step: '호스트 확정 대기',
                        stepStatus: 'waiting',
                        activeTask: '실제 메시지 앵커 대기',
                        postprocessPhase: 'afterRequest:commit',
                        postprocessDetail: '실제 assistant 메시지 ID와 본문 hash가 확인되면 한 번만 커밋합니다.',
                        message: '호스트가 응답을 확정한 뒤 LIBRA 기억을 저장합니다.'
                    });
                    DebugExportManager.recordPhase(afterDebugKey, 'commit_pending_deferred', {
                        status: immediateCommit?.status || 'waiting',
                        reason: immediateCommit?.reason || 'host_message_anchor_unavailable',
                        pendingRemaining: true,
                        maintenanceMode: afterRequestMaintenanceMode
                    }, 'waiting');
                }
                DebugExportManager.recordPhase(afterDebugKey, 'commit_pending_now', {
                    status: immediateCommit?.status || 'unknown',
                    reason: immediateCommit?.reason || '',
                    turn: immediateCommit?.turn || predictedTurn,
                    memoryCreated: immediateCommit?.memoryCreated === true,
                    turnKey: immediateCommit?.turnKey || ''
                }, (immediateCommit?.status === 'finalized' || immediateCommit?.status === 'already-committed') ? 'done' : 'waiting');
                if (immediateCommit?.status === 'finalized' || immediateCommit?.status === 'already-committed') {
                    // The canonical write is complete. Maintenance owns a fresh
                    // scoped transaction; retaining the commit token here makes
                    // foreground maintenance reject itself as "busy".
                    if (runtimeTransactionToken) {
                        ScopedRuntimeTransaction.end(runtimeTransactionToken);
                        runtimeTransactionToken = null;
                    }
                    clearStreamOutputRecoveryTimer(chat);
                    forgetRecentMainResponseOutputCapture(chat, { requestSequence: Math.max(0, Number(afterRequestOrigin?.requestSequence || 0)) });
                    notifyLibraTask('LIBRA commit을 완료했습니다.', { key: `libra-commit-${immediateCommit?.turn || predictedTurn}`, duration: 1500 });
                    ActivityDashboardCore.update(activityContext, {
                        phase: 'afterRequest:commit',
                        status: 'running',
                        progress: 70,
                        step: '커밋 저장',
                        stepStatus: 'done',
                        activeTask: '턴 커밋 완료',
                        postprocessPhase: 'afterRequest:commit',
                        postprocessDetail: `턴 ${immediateCommit?.turn || predictedTurn} 커밋 저장 완료`,
                        message: `턴 ${immediateCommit?.turn || predictedTurn} 커밋을 저장했습니다.`
                    });
                    let maintenanceWait = { status: immediateCommit?.maintenancePending ? 'queued' : 'none' };
                    if (immediateCommit?.maintenanceRecord) {
                        const maintenanceStart = startCommittedTurnMaintenance(immediateCommit.maintenanceRecord, {
                            reason: 'afterRequest',
                            activityContext,
                            step: '후처리 분석',
                            message: '커밋 완료 후 엔티티/월드/내러티브 분석을 진행합니다.'
                        });
                        DebugExportManager.recordPhase(afterDebugKey, 'turn_maintenance', {
                            mode: maintenanceStart?.mode || 'none',
                            turn: maintenanceStart?.turn || immediateCommit?.turn || predictedTurn,
                            scopeKey: maintenanceStart?.scopeKey || ''
                        }, maintenanceStart?.mode === 'foreground' ? 'waiting' : 'done');
                        if (maintenanceStart?.mode === 'foreground') {
                            maintenanceWait = await awaitCommittedTurnMaintenance(maintenanceStart, {
                                timeoutMs: MemoryEngine.CONFIG?.afterRequestForegroundTimeoutMs ?? 45000
                            });
                            DebugExportManager.recordPhase(afterDebugKey, 'turn_maintenance_result', {
                                status: maintenanceWait?.status || 'unknown',
                                error: maintenanceWait?.error || '',
                                timeoutMs: maintenanceWait?.timeoutMs || 0
                            }, maintenanceWait?.status === 'uncertain' ? 'uncertain' : maintenanceWait?.status === 'done' || maintenanceWait?.status === 'skipped' ? 'done' : 'waiting');
                        } else {
                            maintenanceWait = { status: maintenanceStart?.mode === 'background' ? 'queued' : 'none' };
                        }
                    }
                    if (maintenanceWait?.status === 'queued' || maintenanceWait?.status === 'deferred') {
                        ActivityDashboardCore.update(activityContext, {
                            phase: 'afterRequest:maintenance',
                            status: 'waiting',
                            progress: Math.max(72, Number(MemoryState.activityDashboard?.progress || 0)),
                            step: '후처리 분석',
                            stepStatus: 'waiting',
                            activeTask: '후처리 분석 대기',
                            postprocessPhase: 'afterRequest:maintenance',
                            postprocessDetail: '커밋 완료 후 백그라운드 분석을 대기합니다.',
                            message: `턴 ${immediateCommit?.turn || predictedTurn} 커밋 완료, 후처리 분석 대기 중`
                        });
                    } else if (maintenanceWait?.status === 'uncertain') {
                        ActivityDashboardCore.finish(activityContext, 'uncertain', '원문 턴은 보존됐으며 후처리 저장 결과 확인이 필요합니다.');
                    } else {
                        ActivityDashboardCore.finish(activityContext, 'committed', maintenanceWait?.status === 'done'
                            ? `턴 ${immediateCommit?.turn || predictedTurn} 커밋 및 분석 완료`
                            : `턴 ${immediateCommit?.turn || predictedTurn} 커밋 완료`);
                    }
                    DebugExportManager.finishRequest(afterDebugKey, 'committed', {
                        turn: immediateCommit?.turn || predictedTurn,
                        turnKey: immediateCommit?.turnKey || '',
                        memoryCreated: immediateCommit?.memoryCreated === true,
                        maintenanceStatus: maintenanceWait?.status || 'none'
                    });
                }
                if (immediateCommit?.status !== 'finalized' && immediateCommit?.status !== 'already-committed' && MemoryEngine.CONFIG.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] immediate turn-anchor commit deferred:', immediateCommit);
                }
                if (immediateCommit?.status !== 'finalized' && immediateCommit?.status !== 'already-committed') {
                    ActivityDashboardCore.finish(activityContext, 'waiting', `턴 ${predictedTurn} 커밋 대기: ${immediateCommit?.status || 'pending'}`);
                    DebugExportManager.finishRequest(afterDebugKey, 'waiting', {
                        turn: predictedTurn,
                        commitStatus: immediateCommit?.status || 'pending',
                        reason: immediateCommit?.reason || ''
                    });
                }
            } else {
                if (durableLedgerHandle?.ok && !alreadyFinalizedBeforeRegister) {
                    try {
                        await DurableTurnLedger.markStatus(durableLedgerHandle, {
                            status: alreadyFinalizedBeforeRegister ? 'committed' : 'skipped',
                            analysisStatus: 'done',
                            turn: predictedTurn,
                            commitStatus: alreadyFinalizedBeforeRegister ? 'already-committed' : 'skipped',
                            terminalReason: alreadyFinalizedBeforeRegister ? 'already_finalized_turn_anchor' : 'no_pending_turn_anchor',
                            terminalAt: Date.now()
                        });
                    } catch (ledgerTerminalError) {
                        recordSuppressedRuntimeError('durable_turn_ledger.terminal_skip', ledgerTerminalError, {
                            chatId: String(chat?.id || '').trim(),
                            requestSequence: afterRequestOrigin?.requestSequence || 0
                        });
                    }
                }
                DebugExportManager.finishRequest(afterDebugKey, alreadyFinalizedBeforeRegister ? 'committed' : 'skipped', {
                    reason: alreadyFinalizedBeforeRegister ? 'already_finalized_turn_anchor' : 'no_pending_turn_anchor',
                    predictedTurn
                });
            }
            if (MemoryEngine.CONFIG.debug) {
                recordRuntimeDebug('log', pending
                    ? `[LIBRA] Turn anchor registered | chat=${chat?.id || 'global'} | turn=${predictedTurn} | aiHash=${TokenizerEngine.simpleHash(aiResponse || '')}`
                    : `[LIBRA] Turn anchor not registered (${alreadyFinalizedBeforeRegister ? 'already-finalized' : 'not-eligible'}) | chat=${chat?.id || 'global'} | turn=${predictedTurn} | aiHash=${TokenizerEngine.simpleHash(aiResponse || '')}`);
            }

            _lastUserMessage = '';
            _lastUserMessageRaw = '';

            return responseContent;
        } catch (e) {
            if (durableLedgerHandle?.ok) {
                try {
                    await DurableTurnLedger.markStatus(durableLedgerHandle, {
                        status: workerContext?.committedReplay ? 'committed' : 'observed',
                        analysisStatus: 'failed',
                        lastError: String(e?.message || e || 'unknown').slice(0, 1000)
                    });
                } catch (_) {}
            }
            recordRuntimeDebug('error', '[LIBRA] afterRequest Error:', e?.message || e);
            DebugExportManager.finishRequest(afterDebugKey, 'failed', {
                error: e?.message || String(e || ''),
                errorName: e?.name || e?.code || ''
            });
            ActivityDashboardCore.finish({
                scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                activityDashboard: MemoryEngine.CONFIG.activityDashboard
            }, 'failed', `afterRequest 실패: ${e?.message || e}`);
            clearLibraTransientRuntimeState();
            return responseContent;
        } finally {
            if (runtimeTransactionToken) ScopedRuntimeTransaction.end(runtimeTransactionToken);
        }
    };
    let afterRequestWorkerTimer = null;
    let afterRequestWorkerRunning = false;
    const afterRequestWorkerQueue = [];
    const AFTER_REQUEST_WORKER_QUEUE_LIMIT = 64;
    const afterRequestWorkerRequestIdsInFlight = new Set();
    const requestAfterRequestWorkerDrain = (delayMs = 0) => {
        if (afterRequestWorkerTimer || afterRequestWorkerRunning || afterRequestWorkerQueue.length === 0) return false;
        afterRequestWorkerTimer = setTimeout(() => {
            afterRequestWorkerTimer = null;
            void drainAfterRequestWorkerQueue();
        }, Math.max(0, Number(delayMs || 0)));
        return true;
    };
    const drainAfterRequestWorkerQueue = async () => {
        if (afterRequestWorkerRunning) return;
        afterRequestWorkerRunning = true;
        try {
            while (afterRequestWorkerQueue.length > 0) {
                const job = afterRequestWorkerQueue.shift();
                if (!job) continue;
                try {
                    await runLibraAfterRequestWorker(job.content, job.type, job.context || {});
                } catch (error) {
                    recordSuppressedRuntimeError('after_request.detached_worker', error, { type: job.type || '' });
                } finally {
                    const requestId = String(job?.context?.origin?.requestId || '').trim();
                    if (requestId) afterRequestWorkerRequestIdsInFlight.delete(requestId);
                    if (!job?.context?.replayHandle && PendingTurnManager.needsReplay(job?.context?.origin?.scopeKey)) scheduleDurableTurnReplay(job.context.origin);
                }
            }
        } finally {
            afterRequestWorkerRunning = false;
            requestAfterRequestWorkerDrain(0);
        }
    };
    const scheduleAfterRequestWorker = (content, type) => {
        if (!Utils.isModelRequestType(type)) return false;
        const auxReason = getLibraAuxRequestBypassReason(content, type, MemoryEngine.CONFIG, { phase: 'afterRequest:schedule' });
        if (auxReason) return false;
        if (isPureManagedModuleResponse(content)) return false;
        const origin = claimAfterRequestOriginForType(type);
        if (!origin) return false;
        const observedAt = Date.now();
        const analysisBudgetMs = normalizeAfterRequestAnalysisBudgetMs(MemoryEngine.CONFIG?.afterRequestAnalysisBudgetMs ?? 480000, 480000);
        origin.observedAt = observedAt;
        origin.analysisDeadlineAt = Math.min(
            Number(origin.analysisDeadlineAt || Number.MAX_SAFE_INTEGER),
            observedAt + analysisBudgetMs
        );
        const responseText = extractResponseTextValue(content, new WeakSet(), true) || String(content || '');
        const durableLedgerPromise = Promise.resolve(DurableTurnLedger.appendObserved({
            origin,
            recordId: String(origin.requestId || '').trim() || undefined,
            scopeKey: origin.scopeKey,
            characterId: origin.characterId,
            characterIndex: origin.characterIndex,
            chatId: origin.chatId,
            chatIndex: origin.chatIndex,
            requestSequence: origin.requestSequence || 0,
            requestType: type,
            observedAt,
            analysisDeadlineAt: origin.analysisDeadlineAt,
            originMessageCount: origin.messageCount || 0,
            userText: origin?.canonicalUser?.raw || origin?.canonicalUser?.strict || '',
            assistantText: responseText,
            mainResponseLanguageTarget: detectMainResponseLanguageTarget(responseText)
        })).catch(error => {
            recordSuppressedRuntimeError('durable_turn_ledger.schedule_append', error, {
                chatId: String(origin.chatId || '').trim(),
                requestSequence: origin.requestSequence || 0
            });
            return { ok: false, reason: 'schedule_append_failed', error: String(error?.message || error || '') };
        });
        const signatureText = `${String(origin.scopeKey || origin.chatId || '')}:${Number(origin.requestSequence || 0)}:${String(type || '')}:${extractResponseTextValue(content) || String(content || '')}`;
        const signature = String(TokenizerEngine?.simpleHash?.(signatureText) || signatureText.slice(0, 180));
        if (afterRequestWorkerQueue.length < AFTER_REQUEST_WORKER_QUEUE_LIMIT && !afterRequestWorkerQueue.some(job => job.signature === signature)) {
            if (origin.requestId) afterRequestWorkerRequestIdsInFlight.add(String(origin.requestId));
            afterRequestWorkerQueue.push({ content, type, signature, context: { origin, durableLedgerPromise }, queuedAt: observedAt });
        }
        // Return control to Risu first so it can save/display the response.
        requestAfterRequestWorkerDrain(25);
        return true;
    };
    const durableReplayInFlight = new Set();
    // A capped sweep resumes on a later host trigger. Pre-reservation failures
    // remain retryable without repeatedly occupying the first eight slots.
    const durableReplayCursors = new Map();
    scheduleDurableTurnReplay = (targetContext = null) => {
        const scopeKey = String(targetContext?.scopeKey || '').trim();
        if (!scopeKey || durableReplayInFlight.has(scopeKey) || typeof setTimeout !== 'function') return false;
        const contextKey = JSON.stringify([
            String(targetContext?.chatId || '').trim(), String(targetContext?.characterId || '').trim(),
            String(targetContext?.runtimeScopeKey || '').trim(), String(targetContext?.canonicalScope || '').trim(),
            Number(targetContext?.resetGeneration ?? 0)
        ]);
        const saved = durableReplayCursors.get(scopeKey);
        const continuation = saved?.contextKey === contextKey ? saved : null;
        if (saved && !continuation) durableReplayCursors.delete(scopeKey);
        const replayCutoffAt = continuation?.replayCutoffAt ?? Date.now();
        durableReplayInFlight.add(scopeKey);
        setTimeout(async () => {
            try {
                if (!isLibraRuntimeEpochActive()) return;
                let cursor = continuation?.cursor || null;
                let scheduled = 0;
                const eligible = record => {
                    if (String(record?.chatId || '').trim() !== String(targetContext?.chatId || '').trim()) return false;
                    if (targetContext?.characterId && String(record?.characterId || '').trim() !== String(targetContext.characterId || '').trim()) return false;
                    if (Number(record?.observedAt || 0) > replayCutoffAt) return false;
                    if (['skipped', 'discarded', 'terminal'].includes(String(record?.status || '').trim())) return false;
                    if (record?.analysisStatus === 'blocked_host_source_changed') return false;
                    if (['done', 'committed', 'skipped', 'terminal'].includes(String(record?.analysisStatus || '').trim())) return false;
                    const maxRecoveryAttempts = Math.max(0, Math.min(4, Number(MemoryEngine.CONFIG?.analysisRecoveryDeferredAttempts ?? 2) || 0));
                    if (record.status === 'committed' && Number(record.analysisStartedAt || record.analysisFinishedAt || 0) > 0
                        && Math.max(0, Number(record.analysisRecoveryAttempt || 0)) >= maxRecoveryAttempts) return false;
                    const recordId = String(record.recordId || '').trim();
                    if (record.status === 'committed') {
                        const runtimeScope = String(record.runtimeScopeKey || targetContext.runtimeScopeKey || '');
                        if (MemoryState.afterRequestForegroundTasksByScope.has(String(record.scopeKey || ''))
                            || (runtimeScope && MemoryState.afterRequestForegroundTasksByScope.has(runtimeScope))) return false;
                        const maintenance = MemoryState.turnMaintenanceSchedulesByChatId.get(record.chatId);
                        if (maintenance?.running) return false;
                        const queued = Array.isArray(maintenance?.pendingRecords) ? maintenance.pendingRecords : [];
                        if (queued.some(item => String(item?.targetContext?.durableLedgerRecordKey || '') === String(record.recordKey || ''))) return false;
                    }
                    if ((recordId && afterRequestWorkerRequestIdsInFlight.has(recordId))
                        || (record.requestId && afterRequestWorkerRequestIdsInFlight.has(String(record.requestId)))) return false;
                    const hasActivePendingAnchor = PendingTurnManager.hasPendingReceipt(record);
                    if (hasActivePendingAnchor) return false;
                    return true;
                };
                do {
                    if (!isLibraRuntimeEpochActive()) return;
                    if (afterRequestWorkerQueue.length >= AFTER_REQUEST_WORKER_QUEUE_LIMIT) break;
                    const page = await DurableTurnLedger.listPendingPage(scopeKey, { limit: 8 - scheduled, cursor, acceptRecord: eligible });
                    cursor = page.nextCursor;
                    if (cursor) durableReplayCursors.set(scopeKey, { contextKey, replayCutoffAt, cursor });
                    else durableReplayCursors.delete(scopeKey);
                    for (const listedRecord of page.records) {
                        let record = listedRecord;
                        if (!isLibraRuntimeEpochActive()) return;
                        if (!eligible(record)) continue;
                        const recordId = String(record.recordId || '').trim();
                        const replayHandle = {
                            ok: true,
                            verified: true,
                            recordId,
                            recordKey: String(record.recordKey || '').trim(),
                            scopeKey
                        };
                        const checked = await DurableTurnLedger.readRecord(replayHandle);
                        if (!isLibraRuntimeEpochActive() || !checked.ok) continue;
                        record = checked.record;
                        if (!eligible(record)) continue;
                        const replayAdmissionContext = () => ({ verified: true, expectedHandle: replayHandle,
                            expectedResetGeneration: targetContext.resetGeneration ?? 0,
                            writerProtocolVerified: true, runtimeCurrent: isLibraRuntimeEpochActive() });
                        const admission = classifyWmAnalysisAdmission(record, null, replayAdmissionContext());
                        const deadlineExpired = current => Number.isSafeInteger(current?.analysisDeadlineAt)
                            && current.analysisDeadlineAt > 0 && Date.now() >= current.analysisDeadlineAt - 1000;
                        if (['new', 'resume', 'interrupted'].includes(admission.kind) && deadlineExpired(record)) {
                            await DurableTurnLedger.markStatus(replayHandle, {
                                analysisStatus: 'deadline', analysisFinishedAt: Date.now()
                            }, {
                                expectedResetGeneration: targetContext.resetGeneration ?? 0,
                                isCurrent: () => isLibraRuntimeEpochActive(),
                                analysisAdmissionGuard: current => eligible(current) && deadlineExpired(current)
                                    && ['new', 'resume', 'interrupted'].includes(classifyWmAnalysisAdmission(current, null, replayAdmissionContext()).kind)
                            });
                            continue;
                        }
                        if (admission.kind === 'interrupted') {
                            await DurableTurnLedger.markStatus(replayHandle, {
                                analysisStatus: 'terminal', analysisOutcome: 'interrupted',
                                terminalReason: 'analysis_snapshot_unavailable'
                            }, {
                                expectedResetGeneration: targetContext.resetGeneration ?? 0,
                                isCurrent: () => isLibraRuntimeEpochActive(),
                                analysisAdmissionGuard: current => eligible(current)
                                    && classifyWmAnalysisAdmission(current, null, replayAdmissionContext()).kind === 'interrupted'
                            });
                            continue;
                        }
                        if (admission.kind !== 'new') continue;
                        const origin = {
                            characterId: String(record.characterId || '').trim(),
                            characterIndex: normalizeRisuIndex(record.characterIndex),
                            chatId: String(record.chatId || '').trim(),
                            chatIndex: normalizeRisuIndex(record.chatIndex),
                            scopeKey,
                            requestId: String(record.recordId || '').trim(),
                            runtimeScopeKey: String(record.runtimeScopeKey || '').trim(),
                            canonicalScope: String(record.canonicalScope || '').trim(),
                            resetGeneration: record.resetGeneration ?? 0,
                            requestSequence: Math.max(0, Number(record.requestSequence || 0)),
                            requestType: String(record.requestType || 'model').trim() || 'model',
                            messageCount: Math.max(0, Number(record.originMessageCount || 0) || 0),
                            sourceCapture: record.sourceCapture ? safeClone(record.sourceCapture) : null,
                            canonicalUser: buildCanonicalUserPayload({ role: 'user', content: String(record.userText || '') }),
                            observedAt: Number(record.observedAt || Date.now()),
                            analysisDeadlineAt: Math.max(0, Number(record.analysisDeadlineAt || 0) || 0),
                            queuedAt: Number(record.observedAt || Date.now()),
                            expiresAt: Date.now() + AFTER_REQUEST_ORIGIN_TTL_MS
                        };
                        const signature = `replay:${record.recordId || record.recordKey}`;
                        if (afterRequestWorkerQueue.length < AFTER_REQUEST_WORKER_QUEUE_LIMIT && !afterRequestWorkerQueue.some(job => job.signature === signature)) {
                            const replayMark = await DurableTurnLedger.markStatus(replayHandle, {
                                analysisStatus: 'replaying', replayStartedAt: Date.now()
                            }, {
                                expectedResetGeneration: targetContext.resetGeneration ?? 0,
                                isCurrent: () => isLibraRuntimeEpochActive(),
                                analysisAdmissionGuard: current => eligible(current)
                                    && classifyWmAnalysisAdmission(current, null, replayAdmissionContext()).kind === 'new'
                            });
                            if (!replayMark.ok || replayMark.verified !== true || replayMark.unchanged) continue;
                            if (recordId) afterRequestWorkerRequestIdsInFlight.add(recordId);
                            afterRequestWorkerQueue.push({
                                content: String(record.assistantText || ''),
                                type: origin.requestType,
                                signature,
                                context: { origin, replayHandle, committedReplay: record.status === 'committed' ? record : null },
                                queuedAt: Date.now()
                            });
                            scheduled++;
                        }
                    }
                    requestAfterRequestWorkerDrain(25);
                    if (cursor && scheduled < 8) await new Promise(resolve => setTimeout(resolve, 75));
                } while (cursor && scheduled < 8);
                if (cursor && scheduled >= 8) PendingTurnManager.noteDurableReplayBacklog(targetContext);
            } catch (error) {
                // A removed/replaced journal invalidates its positional cursor.
                // Transient page reads retain progress instead of rewinding the
                // same failed prefix on every trigger; repair can resume it.
                if (String(error?.message || '').startsWith('turn ledger cursor')) durableReplayCursors.delete(scopeKey);
                recordSuppressedRuntimeError('durable_turn_ledger.replay_scope', error, { scopeKey });
            } finally {
                if (!isLibraRuntimeEpochActive()) durableReplayCursors.delete(scopeKey);
                durableReplayInFlight.delete(scopeKey);
            }
        }, 75);
        return true;
    };
    PendingTurnManager.setDurableReplayScheduler(scheduleDurableTurnReplay);
    const libraAfterRequestReplacer = (content, type) => {
        // Risu awaits replacers without timeout. The response transformer must be
        // identity and synchronous; all commit/analysis work is detached.
        try { scheduleAfterRequestWorker(content, type); } catch (_) {}
        return content;
    };
    await RisuCompat.addReplacer('afterRequest', libraAfterRequestReplacer);
    if (RisuCompat.has('onUnload')) {
        await RisuCompat.onUnload(async () => {
            // Invalidate already-running closures before awaiting any cleanup.
            // Late provider results from the old plugin instance must never
            // commit into a freshly reloaded instance.
            invalidateLibraRuntimeEpoch();
            disposeValidationSourceOwners();
            durableReplayCursors.clear();
            TypedRecallRollout.cancelAll();
            try { await RisuCompat.removeReplacer('beforeRequest', libraBeforeRequestReplacer); } catch (error) {
                recordSuppressedRuntimeError('unload.remove_before_request_replacer', error);
            }
            try { await RisuCompat.removeReplacer('afterRequest', libraAfterRequestReplacer); } catch (error) {
                recordSuppressedRuntimeError('unload.remove_after_request_replacer', error);
            }
            try {
                if (libraResponseStreamingOutputHandler) {
                    await RisuCompat.removeScriptHandler('output', libraResponseStreamingOutputHandler);
                    libraResponseStreamingOutputHandler = null;
                }
            } catch (error) {
                recordSuppressedRuntimeError('unload.remove_output_script_handler', error);
            }
            try {
                if (libraResponseStreamingEditOutputHandler) {
                    await RisuCompat.removeScriptHandler('editoutput', libraResponseStreamingEditOutputHandler);
                    libraResponseStreamingEditOutputHandler = null;
                }
            } catch (error) {
                recordSuppressedRuntimeError('unload.remove_editoutput_script_handler', error);
            }
            try {
                if (libraResponseOutputCaptureTimer) clearTimeout(libraResponseOutputCaptureTimer);
                libraResponseOutputCaptureTimer = null;
                libraResponseOutputCapturePending = null;
                libraResponseOutputCaptureRunning = false;
            } catch (error) {
                recordSuppressedRuntimeError('unload.clear_output_capture_worker', error);
            }
            try {
                const existingTransport = globalThis[LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_KEY];
                const existingId = String(existingTransport?.id || '').trim();
                if (existingId) await RisuCompat.unregisterBodyIntercepter(existingId);
                try { delete globalThis[LIBRA_MAIN_RESPONSE_TRANSPORT_INTERCEPTOR_KEY]; } catch (_) {}
            } catch (error) {
                recordSuppressedRuntimeError('unload.unregister_body_intercepter', error);
            }
            try { await LibraToast.cleanup(); } catch (error) {
                recordSuppressedRuntimeError('unload.toast_cleanup', error);
            }
            try {
                if (afterRequestWorkerTimer) clearTimeout(afterRequestWorkerTimer);
                afterRequestWorkerTimer = null;
                afterRequestWorkerQueue.length = 0;
                afterRequestWorkerRequestIdsInFlight.clear();
                durableReplayInFlight.clear();
            } catch (error) {
                recordSuppressedRuntimeError('unload.clear_after_request_worker', error);
            }
            try { ActivityDashboardCore.hide(); } catch (error) {
                recordSuppressedRuntimeError('unload.hide_activity_dashboard', error);
            }
            try { ResourceGovernor.stop(); } catch (error) {
                recordSuppressedRuntimeError('unload.stop_resource_governor', error);
            }
            try { MemoryState.reset({ preserveSessionCache: false }); } catch (error) {
                recordSuppressedRuntimeError('unload.reset_memory_state', error);
            }
            try {
                const publicGlobals = [
                    'LIBRA_Metrics',
                    'LIBRA_ActivityDashboard',
                    'LIBRA_HostPromptEvidenceBuffer',
                    'LIBRA_AnalysisResultGuard',
                    'LIBRA_AnalysisBudgetPreflight',
                    'LIBRA_IntegrityMetaManager',
                    'LIBRA_TimeParser',
                    'LIBRA_TimeEngine',
                    'LIBRA_getEntityTimeProjection',
                    'LIBRA_QuarantineManager',
                    'LIBRA_ColdArchiveManager',
                    'LIBRA_RecallFeedbackManager',
                    'LIBRA_IntegrityScanner',
                    'LIBRA_CBS_PRE_RESOLVE_CHARACTER_LORE',
                    'LIBRA_CBS_GET_RESOLVED_CHARACTER_LORE'
                ];
                for (const key of publicGlobals) {
                    try { delete globalThis[key]; } catch (_) {}
                }
            } catch (error) {
                recordSuppressedRuntimeError('unload.cleanup_public_globals', error);
            }
        });
    }
}
