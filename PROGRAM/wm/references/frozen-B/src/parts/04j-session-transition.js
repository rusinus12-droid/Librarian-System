    const TransitionManager = (() => {
        const SCENE_CONTEXT_KEY = 'LIBRA_SCENE_CONTEXT';
        // ★ 재진입 방어 상태 (감사 G2).
        //   확인 대화상자 → `await executeTransition()` 사이에 취소 경로도 플래그도 없었다.
        //   실측: 두 번 통과하면 `_generateUUID()` 로 새 채팅이 **두 개** 생기고 상속 데이터가 두 벌이 된다.
        //   정본(RETRACE `transferId`·`resumed:attempt>1`·HandoffJournal)의 취지 = 재시도 안전성.
        let _transitionInFlight = false;
        let _lastBlockedReason = '';
        const transitionInFlight = () => _transitionInFlight;
        const lastBlockedReason = () => _lastBlockedReason;

        const TransitionSummaryPrompt = `당신은 대화 세션 전환을 돕는 맥락 브릿지 전문가입니다.
제공된 마지막 대화 내역을 바탕으로, 새 채팅방에서 대화를 자연스럽게 이어갈 수 있도록 현재 상황을 요약하십시오.

[정본 규칙 / Canonical Evidence]
- assistant/AI 응답에서 실제로 묘사된 내용만 직전 상황으로 요약하십시오.
- 사용자 입력/요청/명령은 발생한 사건으로 취급하지 마십시오.
- 마지막 사용자 입력이 아직 assistant 응답으로 처리되지 않았다면 요약에 포함하지 마십시오.

[필수 포함 내용]
1. 현재 장소 및 시간적 배경
2. 주요 등장인물들이 직전에 수행하던 구체적인 행동
3. 현재 대화의 핵심 분위기와 진행 중인 사건의 긴박함 정도

요약은 1~2문단으로 간결하고 명확하게 작성하십시오.`;

        const _generateUUID = () => {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = (Math.random() * 16) | 0;
                return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
            });
        };

        const _libraComments = [
            "lmai_entity",
            "lmai_relation", "lmai_narrative", "lmai_char_states",
            "lmai_world_states", "lmai_memory", "lmai_rp_longterm",
            // Narrative orchestration and world-additional are independent
            // canonical databases.  TransitionManager reloads these comments in
            // the destination chat, so omitting them here silently reset them.
            "lmai_story_author", "lmai_director", "lmai_world_additional", "lmai_user_dlc",
            // Preserve the rest of the canonical world/knowledge state.  Scope-
            // bound runtime indices and WALs are intentionally rebuilt instead.
            "lmai_world_graph", "lmai_entity_knowledge_vault",
            "lmai_time_engine", "lmai_secret_knowledge",
            "lmai_character_lore_cues", "lmai_integrated_packet_journal",
            "lmai_recall_feedback"
        ];
        const _libraInheritedComments = [
            ..._libraComments,
            'lmai_user',
            'lmai_hypa_v3_source',
            'hypa_v3_import'
        ];

        const _buildInheritedLore = (sourceLore, sceneSummary) => {
            const inherited = sourceLore.filter(e => _libraInheritedComments.includes(e.comment) && e.key !== SCENE_CONTEXT_KEY);

            const memoryEntries = inherited.filter(e => e.comment === 'lmai_memory');
            const structuralEntries = inherited.filter(e => e.comment !== 'lmai_memory');
            const baselineEntries = structuralEntries.map(e => {
                try {
                    const content = JSON.parse(e.content);
                    if (content.meta) content.meta.s_id = 'baseline';
                    return { ...e, content: JSON.stringify(content) };
                } catch { return e; }
            });

            let newLore = [...baselineEntries, ...memoryEntries];

            if (sceneSummary) {
                const anchorTurn = Math.max(1, deriveMaxTurnFromLorebook(newLore) + 1);
                const sourceHash = TokenizerEngine.simpleHash(sceneSummary);
                const userTurnKey = `baseline:${sourceHash}`;
                const meta = {
                    imp: 10,
                    t: anchorTurn,
                    ttl: -1,
                    cat: 'system',
                    ent: [],
                    summary: 'Previous Scene Context',
                    source: 'transition_scene_context',
                    sourceHint: 'Inherited previous-scene context for the new chat scope.',
                    s_id: 'baseline',
                    sourceMessageIds: [],
                    liveMessageIds: [],
                    sourceHash,
                    aiHash: sourceHash,
                    userTurnKey,
                    turnKey: buildCanonicalTurnKey('', userTurnKey, sourceHash, '', []),
                    messageSignature: '',
                    messageCount: 0,
                    firstTurn: anchorTurn,
                    originalTurn: anchorTurn,
                    lockedTurn: anchorTurn,
                    finalizedTurn: anchorTurn,
                    turnAnchorTurn: anchorTurn,
                    turnAnchor: anchorTurn,
                    turnLocked: true,
                    turnAnchorReason: 'transition-scene-context',
                    recallHints: StrengthenedJaccardCore.buildRecallHints(sceneSummary, { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 })
                };
                const sceneEntry = {
                    key: SCENE_CONTEXT_KEY,
                    comment: "lmai_memory",
                    content: `[META:${JSON.stringify(meta)}]\n【직전 상황 요약 / Previous Scene Context】\n${sceneSummary}`,
                    mode: 'normal',
                    insertorder: 10,
                    alwaysActive: false
                };
                newLore.unshift(sceneEntry);
            }

            return newLore;
        };

        const _rescopeInheritedIntegrity = (inheritedLore, scopeKey) => {
            if (!Array.isArray(inheritedLore) || !scopeKey) return inheritedLore;
            for (const entry of inheritedLore) {
                if (!entry || !String(entry.comment || '').startsWith('lmai_')) continue;
                let parsed = null;
                try { parsed = JSON.parse(String(entry.content || '')); } catch (_) { continue; }
                const integrity = parsed?.meta?.integrity;
                if (!integrity || typeof integrity !== 'object') continue;
                IntegrityMetaManager.applyIntegrityMeta(parsed, {
                    domain: integrity.domain || '',
                    recordSchema: integrity.recordSchema || parsed.schema || parsed.kind || '',
                    recordId: integrity.recordId || parsed.id || parsed.name || entry.key || '',
                    scopeKey,
                    turn: Number(integrity.turn || 0) || deriveMaxTurnFromLorebook(inheritedLore),
                    source: integrity.source || 'session_transition'
                });
                entry.content = JSON.stringify(parsed);
            }
            return inheritedLore;
        };

        const executeTransition = async () => {
            if (VersionedCanonicalBridge.mode === "authority") {_lastBlockedReason="authority_upstream_writer_unsupported";return false;}
            // ★ 재진입 가드 — 겹친 호출을 **조용히 거부**한다(부분 상태를 만들지 않는다).
            //   `false` 를 돌려주는 건 기존 실패 계약과 같다 — 구분은 `lastBlockedReason()` 으로 한다.
            if (_transitionInFlight) {
                _lastBlockedReason = 'transition_already_in_flight';
                try { recordRuntimeDebug('warn', '[LIBRA] Session transition rejected: already in flight.'); } catch (_) {}
                return false;
            }
            _transitionInFlight = true;
            _lastBlockedReason = '';
            try {
                const sourceContext = await resolveActiveChatContext();
                if (!sourceContext?.chat || !sourceContext?.personaAdmission?.ok) {
                    throw new LIBRAError('기존 데이터의 소유 범위를 확인할 수 없어 세션 전환을 중단했습니다.', 'SOURCE_UNVERIFIED');
                }
                const sourceChar = sourceContext.char;
                const sourceChat = sourceContext.chat;
                const sourceChatId = sourceChat?.id || null;
                const sourceCharIndex = normalizeRisuIndex(sourceContext?.charIdx ?? await RisuCompat.getCurrentCharacterIndex());
                const sourceCharacterId = String(sourceChar?.id || sourceChar?.chaId || '').trim();

                LMAI_GUI.toast("데이터 패키징 중...");

                // 1. 직전 상황 요약 생성 (Graceful Degradation 적용)
                let sceneSummary = "";
                try {
                    const msgs_all = getChatMessages(sourceChat);
                    const lastMsgs = msgs_all.slice(-10)
                        .filter(m => getMessageSignature(m) !== MemoryState.ignoredGreetingSignature)
                        .map(m => ({ msg: m, text: getComparableMessageText(m) }))
                        .filter(item => item.text);
                    if (lastMsgs.length > 0) {
                        LMAI_GUI.toast("직전 상황 요약 중...");
                        const contextText = buildAssistantCanonicalTranscript(lastMsgs, {
                            maxChars: 6000,
                            perItemChars: 1600,
                            includeTurn: false
                        });
                        if (contextText) {
                            const result = await LLMProvider.call(MemoryEngine.CONFIG, TransitionSummaryPrompt, contextText, {
                                maxTokens: 800,
                                label: 'transition-summary',
                                domain: 'narrative_summary',
                                reason: 'transition-summary',
                            });
                            if (result.content) sceneSummary = Utils.stripLLMThinkingTags(result.content).trim();
                        }
                    }
                } catch (summaryError) {
                    recordRuntimeDebug('warn', "[LIBRA] Transition Summary generation failed, but continuing transition:", summaryError);
                }

                // Freeze scoped canonical writers only for the short packaging
                // window. Existing afterRequest work gets a brief chance to finish;
                // if it remains busy we abort safely instead of creating a session
                // from a half-committed source revision.
                let transitionRuntimeToken = null;
                if (isLibraRuntimeEpochActive()) {
                    const transitionScopeKey = getChatRuntimeScopeKey(sourceChat, sourceChar);
                    const busyDeadline = Date.now() + 2000;
                    while (!transitionRuntimeToken && Date.now() < busyDeadline) {
                        transitionRuntimeToken = ScopedRuntimeTransaction.begin(transitionScopeKey, 'session-transition');
                        if (!transitionRuntimeToken) await sleep(100);
                    }
                    if (!transitionRuntimeToken) {
                        throw new LIBRAError('후처리가 아직 진행 중입니다. 작업 대시보드가 닫힌 뒤 다시 시도해 주세요.', 'SOURCE_BUSY');
                    }
                }

                await loreLock.writeLock();
                try {
                    // 3. 새 채팅방 생성 및 데이터 직접 주입
                    LMAI_GUI.toast("새 채팅방 생성 중...");
                    const latestContext = await resolveActiveChatContext();
                    if (!latestContext?.chat || latestContext.personaAdmission?.scopeKey !== sourceContext.personaAdmission.scopeKey) {
                        throw new LIBRAError('세션 전환 중 채팅 또는 페르소나가 변경되었습니다.', 'CHAT_CHANGED');
                    }
                    const latestChar = latestContext.char;
                    const latestChat = latestContext.chat;
                    const latestSourceChatId = latestChat?.id || null;
                    const latestCharacterId = String(latestChar?.id || latestChar?.chaId || '').trim();
                    const latestCharIndex = normalizeRisuIndex(latestContext?.charIdx);
                    const characterChanged = sourceCharacterId && latestCharacterId
                        ? sourceCharacterId !== latestCharacterId
                        : (sourceCharIndex >= 0 && latestCharIndex >= 0 && sourceCharIndex !== latestCharIndex);
                    if (characterChanged || latestSourceChatId !== sourceChatId) {
                        throw new LIBRAError('Active chat changed during transition', 'CHAT_CHANGED');
                    }

                    // The summary call can overlap a final live-turn/maintenance
                    // commit.  Re-read the source only after acquiring the shared
                    // lore lock so the destination inherits that newest canonical
                    // revision instead of the pre-LLM snapshot.
                    const latestEffectiveLore = MemoryEngine.getEffectiveLorebook(latestChar, latestChat);
                    const latestLore = Array.isArray(latestEffectiveLore) && latestEffectiveLore.length > 0
                        ? [...latestEffectiveLore]
                        : [...MemoryEngine.getLorebook(latestChar, latestChat)];
                    const inheritedLore = _buildInheritedLore(latestLore, sceneSummary);

                    const nextChar = cloneForMutation(latestChar);
                    nextChar.chats = Array.isArray(nextChar.chats) ? nextChar.chats : [];
                    const chatCount = nextChar.chats.length;
                    const newChat = {
                        message: [],
                        note: String(latestChat?.note || ''),
                        name: `Session ${chatCount + 1} (LIBRA)`,
                        localLore: inheritedLore,
                        fmIndex: -1,
                        id: _generateUUID()
                    };
                    const inheritedPersonaId = sourceContext.personaAdmission.personaId;
                    if (inheritedPersonaId !== 'default') newChat.bindedPersona = inheritedPersonaId;
                    PersonaScopeIdentity.remember(nextChar, newChat, inheritedPersonaId, 'verified_session_transition');

                    nextChar.chats.unshift(newChat);
                    nextChar.chatPage = 0;

                    const newScopeKey = getChatRuntimeScopeKey(newChat, nextChar);
                    _rescopeInheritedIntegrity(inheritedLore, newScopeKey);
                    // ★ `lmai_memory` 는 `[META:{...}]` 본문 접두 형식이라 위 함수의 `JSON.parse` 가 실패해
                    //   **건너뛰어진다**(catch → continue). 공용 리스코프가 두 형식을 모두 다룬다.
                    try {
                        const shared = LibraDataStorage?.rescopeEntriesIntegrity?.(inheritedLore, newScopeKey, newChat?.id || '');
                        if (shared && shared.changed > 0) {
                            for (let i = 0; i < inheritedLore.length; i += 1) inheritedLore[i] = shared.entries[i] || inheritedLore[i];
                        }
                    } catch (_) {}
                    try {
                        const db = await getLibraIdentityDatabase();
                        SecretKnowledgeCore.loadState(inheritedLore, {
                            scopeKey: newScopeKey,
                            chatId: String(newChat?.id || '').trim()
                        });
                        EntityKnowledgeVaultCore.loadState(inheritedLore, {
                            scopeKey: newScopeKey,
                            chatId: String(newChat?.id || '').trim()
                        });
                        TimeEngine.loadState(inheritedLore, {
                            scopeKey: newScopeKey,
                            chatId: String(newChat?.id || '').trim()
                        });
                        // Validate the rescoping against the staged destination
                        // without reattaching the still-active source shadow.
                        LibraLoreConsolidator.withRawManagementRead(() => {
                            EntityManager.rebuildCache(inheritedLore, { scopeKey: newScopeKey });
                        });
                        const personaSync = await SourceReflectionManager.syncPersonaIdentity(nextChar, newChat, inheritedLore, db);
                        if (personaSync.changed) {
                            await EntityManager.saveToLorebook(nextChar, newChat, inheritedLore);
                        }
                        // Package only the explicitly inherited destination data.
                        // The source remains active until the host commit; ordinary
                        // unpack/index bootstrap would reattach its scoped WAL.
                        LibraLoreConsolidator.withRawManagementRead(() => {
                            MemoryEngine.setLorebook(nextChar, newChat, inheritedLore);
                        });
                        // 스토리지 이전 후 실제 데이터는 pluginStorage 섀도에 있다. 새 채팅의
                        // 섀도를 **리스코프된 상속 로어**로 시드한다 (부모 섀도를 그대로
                        // 복사하면 부모 스코프 무결성 메타가 남아 검증 실패·중복이 생긴다 —
                        // 실측: memMax 98→97, 턴 1·2·97 중복).
                        try {
                            const seed = inheritedLore
                                .filter(entry => entry && typeof entry === 'object' && LibraDataStorage.isLibraEntry(entry))
                                .map(entry => ({ ...entry }));
                            if (seed.length > 0) {
                                await LibraDataStorage.save(nextChar, newChat, seed);
                                await LibraDataStorage.hydrate(nextChar, newChat);
                            }
                        } catch (seedError) {
                            recordRuntimeDebug('warn', '[LIBRA][Storage] transition shadow seed skipped:', seedError?.message || seedError);
                        }
                    } catch (personaSyncError) {
                        recordRuntimeDebug('warn', '[LIBRA] Transition persona sync skipped:', personaSyncError?.message || personaSyncError);
                    }

                    // Persona synchronization may await host/database work. Recheck
                    // the visible target immediately before committing and prefer
                    // the indexed writer so a last-moment character switch cannot
                    // overwrite whichever character became active.
                    const commitContext = await resolveActiveChatContext();
                    const commitChar = commitContext?.char || null;
                    const commitChat = commitContext?.chat || null;
                    const commitCharacterId = String(commitChar?.id || commitChar?.chaId || '').trim();
                    const commitCharIndex = normalizeRisuIndex(commitContext?.charIdx);
                    const commitCharacterChanged = sourceCharacterId && commitCharacterId
                        ? sourceCharacterId !== commitCharacterId
                        : (sourceCharIndex >= 0 && commitCharIndex >= 0 && sourceCharIndex !== commitCharIndex);
                    if (commitCharacterChanged || String(commitChat?.id || '') !== String(sourceChatId || '')
                        || commitContext.personaAdmission?.scopeKey !== sourceContext.personaAdmission.scopeKey) {
                        throw new LIBRAError('Active character or chat changed before transition commit', 'CHAT_CHANGED');
                    }
                    const indexedTarget = sourceCharIndex >= 0 ? sourceCharIndex : commitCharIndex;
                    if (indexedTarget >= 0 && RisuCompat.has('setCharacterToIndex')) {
                        const saved = await RisuCompat.setCharacterToIndex(indexedTarget, safeClone(nextChar));
                        if (saved === false) throw new LIBRAError('Indexed character write failed during transition', 'TRANSITION_WRITE_FAILED');
                    } else {
                        await RisuCompat.setCharacter(safeClone(nextChar));
                    }

                    // 4. 세션 추적 갱신
                    MemoryState.pendingTurnCommits.clear();
                    MemoryState.transientMissing.clear();
                    MemoryState.finalizedTurnMetaByScope.clear();
                    MemoryState.liveSyncStateByScope.clear();
                    MemoryState.commitRevisionByScope.clear();
                    enterRefreshStabilizeWindow();
                    MemoryState._activeChatId = newChat.id;
                    MemoryState._activeScopeKey = newScopeKey;
                    MemoryState.currentSessionId = buildScopedSessionId(newScopeKey);
                    MemoryState.greetingIsolationChatId = newChat.id;
                    MemoryState.greetingIsolationRearmAvailable = false;
                    MemoryState.pendingGreetingIsolationChatId = newChat.id;
                    MemoryState.pendingGreetingIsolationArmed = true;
                    MemoryState.ignoredGreetingSignature = null;

                    // 5. 엔진 재로드
                    MemoryEngine.rebuildIndex(inheritedLore);
                    SecretKnowledgeCore.loadState(inheritedLore, {
                        scopeKey: newScopeKey,
                        chatId: String(newChat?.id || '').trim()
                    });
                    EntityKnowledgeVaultCore.loadState(inheritedLore, {
                        scopeKey: newScopeKey,
                        chatId: String(newChat?.id || '').trim()
                    });
                    TimeEngine.loadState(inheritedLore, {
                        scopeKey: newScopeKey,
                        chatId: String(newChat?.id || '').trim()
                    });
                    HierarchicalWorldManager.loadWorldGraph(inheritedLore, true);
                    EntityManager.rebuildCache(inheritedLore);
                    NarrativeTracker.loadState(inheritedLore);
                    StoryAuthor.loadState(inheritedLore);
                    Director.loadState(inheritedLore);
                    WorldAdditionalCore.loadState?.(inheritedLore, {
                        scopeKey: newScopeKey,
                        chatId: String(newChat?.id || '').trim()
                    });
                    CharacterStateTracker.loadState(inheritedLore);
                    WorldStateTracker.loadState(inheritedLore);
                    MemoryEngine.setTurn(deriveMaxTurnFromLorebook(inheritedLore));

                    // 6. 상태 복구
                    MemoryState.isSessionRestored = true;
                    await identifyGreeting();
                } finally {
                    loreLock.writeUnlock();
                    if (transitionRuntimeToken) ScopedRuntimeTransaction.end(transitionRuntimeToken);
                }

                recordRuntimeDebug('log', "[LIBRA] Session transition complete. New chat created with inherited data.");
                LMAI_GUI.toast("✨ 새 세션이 생성되었습니다! 모든 기억이 계승되었습니다.");
                return true;
            } catch (e) {
                recordRuntimeDebug('error', "[LIBRA] Execute Transition Error:", e);
                return false;
            } finally {
                // ★ 예외로 끝나도 반드시 해제한다 — 안 그러면 전환이 영구히 막힌다.
                _transitionInFlight = false;
            }
        };


        const identifyGreeting = async () => {
            if (!MemoryState.isSessionRestored) return;
            
            try {
                const char = await RisuCompat.getCharacter();
                const chat = await getActiveChatForCharacter(char);
                const msgs_all = getChatMessages(chat);
                const currentChatId = chat?.id || null;
                const pendingChatId = MemoryState.pendingGreetingIsolationChatId || null;
                const pendingArmed = MemoryState.pendingGreetingIsolationArmed === true;

                if (!pendingArmed || !currentChatId || !pendingChatId || currentChatId !== pendingChatId) {
                    MemoryState.pendingGreetingIsolationChatId = null;
                    MemoryState.pendingGreetingIsolationArmed = false;
                    return;
                }
                
                if (chat && msgs_all.length === 1) {
                    const firstMsg = msgs_all[0];
                    if (firstMsg && !isUserLikeMessage(firstMsg)) {
                        MemoryState.ignoredGreetingSignature = getMessageSignature(firstMsg);
                        MemoryState.greetingIsolationChatId = currentChatId;
                        MemoryState.greetingIsolationRearmAvailable = true;
                        recordRuntimeDebug('log', '[LIBRA] Initial greeting identified and will be isolated');
                    }
                }
                MemoryState.pendingGreetingIsolationChatId = null;
                MemoryState.pendingGreetingIsolationArmed = false;
            } catch (e) {
                recordRuntimeDebug('warn', "[LIBRA] Failed to identify greeting:", e);
            }
        };

        return { executeTransition, identifyGreeting, transitionInFlight, lastBlockedReason };
    })();
    // ★ 게이트가 **실행**할 수 있게 노출한다 — 소스 문자열 검사는 죽은 코드를 통과시킨다(반복 교훈).
    if (typeof globalThis !== 'undefined') globalThis.LIBRA_TransitionManager = TransitionManager;
