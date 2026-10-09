    const buildCurrentTurnEntityAnalysisContext = async (char, chat, lore, strictUserMsg, strictAiResponse, turnForMaintenance = 0, config = MemoryEngine.CONFIG, hostPromptEvidence = null) => {
        const analysisEvidence = buildCurrentTurnAnalysisEvidence(strictUserMsg, strictAiResponse, config);
        const entityConversationText = String(analysisEvidence.text || strictAiResponse || '').trim();
        const storedInfo = EntityAwareProcessor.formatStoredInfoForExtraction(10, {
            conversationText: entityConversationText,
            maxChars: 5600
        });
        const hostPromptValidationBlock = HostPromptEvidenceBuffer.formatForAnalysis(
            hostPromptEvidence,
            strictAiResponse,
            { maxRecords: 8, maxChars: 3200 }
        );
        const entityAnalysisMemoryHints = AnalysisMemoryHintBridge.build(lore, entityConversationText, {
            limit: 5,
            maxChars: 220,
            purpose: 'current_turn_entity_world_analysis'
        });
        const rpLongTermEntityCueBlock = EntityAnalysisHintBridge.buildRpLongTermCueBlock(lore, entityConversationText, {
            maxChars: 1400,
            currentTurn: turnForMaintenance || MemoryEngine.getCurrentTurn()
        });
        const characterEntityHintBlock = rpLongTermEntityCueBlock;
        const memoryHintTitle = 'Long-Term Compact Memory Hints for Current Turn Analysis';
        const memoryHintBlock = AnalysisMemoryHintBridge.format(entityAnalysisMemoryHints, { title: memoryHintTitle });
        return {
            entityConversationText,
            storedInfo,
            characterEntityHintBlock,
            hostPromptValidationBlock,
            memoryHints: entityAnalysisMemoryHints,
            memoryHintTitle,
            memoryHintBlock,
            analysisEvidenceMode: analysisEvidence.mode,
            analysisIncludesUserInput: analysisEvidence.includeUser,
            userEvidenceText: analysisEvidence.userText,
            assistantEvidenceText: analysisEvidence.assistantText,
            evidenceLabel: analysisEvidence.label,
            evidencePolicy: analysisEvidence.policy
        };
    };

    const processNarrativeTurnState = async (char, chat, lore, userMsg, aiResponse, m_id = null, options = {}) => {
        const config = MemoryEngine.CONFIG;
        const skipNarrativeRecord = options?.skipNarrativeRecord === true;
        const turnChannel = (options?.narrativeChannel && typeof options.narrativeChannel === 'object')
            ? options.narrativeChannel
            : classifyNarrativeTurnChannel(userMsg, aiResponse);
        const strictUserMsg = turnChannel.strictUser || getStrictNarrativeUserText(userMsg);
        const strictAiResponse = String(turnChannel.strictAi || Utils.getNarrativeComparableText(aiResponse, 'ai') || '').trim();
        const narrativeUserLabel = strictUserMsg
            || (turnChannel.channel === 'meta' ? String(turnChannel.rawUser || userMsg || '').trim() : '')
            || ((options.autoContinue && aiResponse) ? '[auto-continue]' : '');
        if (turnChannel.channel === 'meta') {
            if (narrativeUserLabel && !skipNarrativeRecord) {
                const narrativeAnchorMeta = {
                    ...(options?.anchorMeta && typeof options.anchorMeta === 'object' ? options.anchorMeta : {}),
                    m_id: m_id || options?.anchorMeta?.m_id || '',
                    messageId: m_id || options?.anchorMeta?.messageId || '',
                    chatId: String(chat?.id || options?.anchorMeta?.chatId || '').trim(),
                    turnAnchorReason: String(options?.anchorMeta?.turnAnchorReason || 'v4.2-finalized-turn').trim() || 'v4.2-finalized-turn'
                };
                await NarrativeTracker.recordTurn(MemoryEngine.getCurrentTurn(), narrativeUserLabel, aiResponse, [], config, {
                    anchorMeta: narrativeAnchorMeta,
                    channel: 'meta',
                    containsMetaSignals: turnChannel.containsMetaSignals
                });
            }
            return {
                config,
                conversationEmotion: null,
                involvedEntities: [],
                entitiesToConsolidate: [],
                strictUserMsg,
                recordedNarrativeTurn: !!narrativeUserLabel && !skipNarrativeRecord,
                narrativeTrack: 'meta'
            };
        }
        const conversationEmotion = null;
        const conversationEmotionNote = '';

        const entityContext = options?.entityAnalysisContext && typeof options.entityAnalysisContext === 'object'
            ? options.entityAnalysisContext
            : await buildCurrentTurnEntityAnalysisContext(char, chat, lore, strictUserMsg, strictAiResponse, MemoryEngine.getCurrentTurn(), config, options?.hostPromptEvidence || null);
        const entityConversationText = entityContext.entityConversationText || strictAiResponse;
        let entityResult = await EntityAwareProcessor.extractFromConversation(
            '', strictAiResponse, entityContext.storedInfo, config, {
                userRequestMetadata: entityContext.analysisIncludesUserInput
                    ? (entityContext.userEvidenceText || strictUserMsg)
                    : '',
                canonicalEvidenceText: entityConversationText,
                userEvidenceText: entityContext.userEvidenceText || strictUserMsg,
                assistantEvidenceText: entityContext.assistantEvidenceText || strictAiResponse,
                evidenceLabel: entityContext.evidenceLabel || getAnalysisEvidenceLabel(config),
                evidencePolicy: entityContext.evidencePolicy || getAnalysisEvidencePolicy(config),
                analysisEvidenceMode: entityContext.analysisEvidenceMode || getAnalysisEvidenceMode(config),
                characterEntityHintBlock: [
                    entityContext.hostPromptValidationBlock,
                    entityContext.characterEntityHintBlock
                ].filter(Boolean).join('\n\n'),
                memoryHints: entityContext.memoryHints || [],
                memoryHintTitle: entityContext.memoryHintTitle || 'Long-Term Compact Memory Hints for Current Turn Analysis',
                lorebook: lore,
                precomputedEntityExtraction: options?.precomputedEntityExtraction || null,
                precomputedSourceMode: options?.precomputedSourceMode || ''
            }
        );
        let structuredPacketEntityResult = EntityAwareProcessor.extractStructuredEntitySignals(aiResponse, {
            lorebook: lore,
            conversationText: entityConversationText,
            sourceMessageId: m_id || options?.anchorMeta?.messageId || '',
            turn: MemoryEngine.getCurrentTurn()
        });
        entityResult = EntityAwareProcessor.sanitizeExtractionPayload(entityResult, lore, {
            sourceMode: entityResult?.sourceMode || 'conversation',
            conversationText: entityConversationText,
            requireConversationEvidenceForNew: true
        });
        structuredPacketEntityResult = EntityAwareProcessor.sanitizeExtractionPayload(structuredPacketEntityResult, lore, {
            sourceMode: 'structured_packet',
            conversationText: entityConversationText,
            requireConversationEvidenceForNew: true
        });
        const guardNarrativeAnalysisResult = (result = null, sourceMode = '', operation = '') => {
            const guard = AnalysisResultGuard?.isMergeAllowed?.(result, {
                domain: 'entity',
                operation,
                sourceMode
            }) || { allowed: true };
            if (guard.allowed) return result;
            try {
                QuarantineManager?.append?.(lore, result, {
                    guard,
                    domain: 'entity',
                    operation,
                    sourceMode,
                    turn: MemoryEngine.getCurrentTurn(),
                    turnKey: options?.anchorMeta?.turnKey || '',
                    chatId: String(chat?.id || options?.anchorMeta?.chatId || '').trim(),
                    config
                });
            } catch (quarantineError) {
                if (config.debug) recordRuntimeDebug('warn', '[LIBRA] Analysis quarantine append skipped:', quarantineError?.message || quarantineError);
            }
            if (config.debug) recordRuntimeDebug('warn', '[LIBRA] Narrative analysis merge blocked:', guard);
            return {
                ...(AnalysisResultGuard?.markBlocked?.(result, guard) || { ...(result || {}), success: false, __libraMergeBlocked: true, __libraGuard: guard }),
                entities: [],
                relations: [],
                world: {},
                conflicts: []
            };
        };
        entityResult = guardNarrativeAnalysisResult(entityResult, entityResult?.sourceMode || 'conversation', 'processNarrativeTurnState.entityExtraction');
        structuredPacketEntityResult = guardNarrativeAnalysisResult(structuredPacketEntityResult, 'structured_packet', 'processNarrativeTurnState.structuredPacket');
        if (config.debug && (entityResult.rejectedEntities?.length || entityResult.rejectedRelations?.length || structuredPacketEntityResult.rejectedEntities?.length || structuredPacketEntityResult.rejectedRelations?.length)) {
            recordRuntimeDebug('warn', '[LIBRA] Entity extraction candidates suppressed:', {
                rejectedEntities: [
                    ...(entityResult.rejectedEntities || []),
                    ...(structuredPacketEntityResult.rejectedEntities || [])
                ].slice(0, 12),
                rejectedRelations: [
                    ...(entityResult.rejectedRelations || []),
                    ...(structuredPacketEntityResult.rejectedRelations || [])
                ].slice(0, 12)
            });
        }
        const worldPayloadForMutation = (entityResult?.world && typeof entityResult.world === 'object' && !Array.isArray(entityResult.world)) ? entityResult.world : {};
        const worldMutationPolicy = resolveStructuredWorldMutationPolicy(worldPayloadForMutation);
        const readMutationFlag = (keys = []) => {
            const roots = [worldPayloadForMutation?.global, worldPayloadForMutation?.structure, worldPayloadForMutation?.flags, worldPayloadForMutation?.meta];
            for (const root of roots) {
                if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
                for (const key of keys) {
                    if (root[key] === true) return true;
                    if (root[key] === false) return false;
                }
            }
            return undefined;
        };
        const profile = HierarchicalWorldManager.getProfile();
        const explicitShifts = Array.isArray(worldPayloadForMutation?.dimensionalShifts)
            ? worldPayloadForMutation.dimensionalShifts
            : (Array.isArray(worldPayloadForMutation?.dimensional_shifts) ? worldPayloadForMutation.dimensional_shifts : []);
        if (turnChannel.channel === 'scene' && profile?.global && worldMutationPolicy.allowDimensionalShift) {
            for (const shift of explicitShifts) {
                const targetName = String(shift?.to || shift?.target || shift?.world || '').trim();
                if (!targetName) continue;
                if (!profile?.nodes) continue;
                let targetNode = null;

                for (const [id, node] of profile.nodes) {
                    const nodeName = String(node?.name || '').trim();
                    if (nodeName && (nodeName === targetName || nodeName.includes(targetName) || targetName.includes(nodeName))) {
                        targetNode = node;
                        break;
                    }
                }

                if (!targetNode) {
                    const createResult = HierarchicalWorldManager.createNode({
                        name: targetName,
                        layer: 'dimension',
                        parent: profile.rootId,
                        source: 'llm_structured_world_payload'
                    });
                    if (createResult.success) {
                        targetNode = createResult.node;
                        if (config.debug) recordRuntimeDebug('log', '[LIBRA] New dimension created from structured world payload:', targetName);
                    }
                }

                if (targetNode) {
                    HierarchicalWorldManager.changeActivePath(targetNode.id, { method: String(shift?.type || shift?.method || 'llm_structured') });
                }
            }
        }
        if (turnChannel.channel === 'scene' && profile?.global && worldMutationPolicy.allowGlobalFlags) {
            const applyFlag = (targetKey, keys) => {
                const value = readMutationFlag(keys);
                if (value === true || value === false) profile.global[targetKey] = value;
            };
            applyFlag('multiverse', ['multiverse', 'multiVerse', 'multipleWorlds', 'multiple_worlds']);
            applyFlag('dimensionTravel', ['dimensionTravel', 'dimension_travel', 'interdimensionalTravel', 'interdimensional_travel']);
            applyFlag('timeTravel', ['timeTravel', 'time_travel', 'timeLoop', 'time_loop']);
            applyFlag('metaNarrative', ['metaNarrative', 'meta_narrative', 'fourthWall', 'fourth_wall']);
            applyFlag('virtualReality', ['virtualReality', 'virtual_reality', 'simulation']);
            applyFlag('dreamWorld', ['dreamWorld', 'dream_world']);
            applyFlag('reincarnationPossession', ['reincarnationPossession', 'reincarnation_possession', 'reincarnation', 'possession', 'transmigration']);
        }
        if (turnChannel.channel === 'scene' && profile?.global && worldMutationPolicy.allowSystemInterface) {
            profile.global.systemInterface = true;
        }

        if (entityResult.success) {
            for (const entityData of entityResult.entities || []) {
                if (!entityData.name) continue;
                const consistency = EntityManager.checkConsistency(entityData.name, entityData, lore);
                if (!consistency.consistent && config.debug) {
                    recordRuntimeDebug('warn', `[LIBRA] Entity consistency warning:`, consistency.conflicts);
                }
            }
            await EntityAwareProcessor.applyExtractions(entityResult, lore, config, m_id, { sourceTurn: Number(options?.finalizedTurn || MemoryEngine.currentTurn || 0) || 0 });
        } else if (entityResult.world && String(entityResult.world.__genreSourceText || '').trim()) {
            await EntityAwareProcessor.applyExtractions({
                entities: [],
                relations: [],
                world: entityResult.world,
                conflicts: []
            }, lore, config, m_id, { sourceTurn: Number(options?.finalizedTurn || MemoryEngine.currentTurn || 0) || 0 });
        }
        if (structuredPacketEntityResult?.success) {
            await EntityAwareProcessor.applyExtractions(structuredPacketEntityResult, lore, config, m_id, { sourceTurn: Number(options?.finalizedTurn || MemoryEngine.currentTurn || 0) || 0 });
        }

        const involvedEntities = dedupeTextArray([
            ...((entityResult.success && entityResult.entities) ? entityResult.entities.map(e => e.name).filter(Boolean) : []),
            ...((structuredPacketEntityResult.success && structuredPacketEntityResult.entities) ? structuredPacketEntityResult.entities.map(e => e.name).filter(Boolean) : [])
        ]);
        const recordedNarrativeTurn = !!narrativeUserLabel && !skipNarrativeRecord;
        if (recordedNarrativeTurn) {
            const narrativeAnchorMeta = {
                ...(options?.anchorMeta && typeof options.anchorMeta === 'object' ? options.anchorMeta : {}),
                m_id: m_id || options?.anchorMeta?.m_id || '',
                messageId: m_id || options?.anchorMeta?.messageId || '',
                chatId: String(chat?.id || options?.anchorMeta?.chatId || '').trim(),
                turnAnchorReason: String(options?.anchorMeta?.turnAnchorReason || 'v4.2-finalized-turn').trim() || 'v4.2-finalized-turn'
            };
            await NarrativeTracker.recordTurn(MemoryEngine.getCurrentTurn(), narrativeUserLabel, aiResponse, involvedEntities, config, {
                anchorMeta: narrativeAnchorMeta,
                channel: turnChannel.channel,
                containsMetaSignals: turnChannel.containsMetaSignals
            });
        }

        const compactStateList = (value, limit = 4) => dedupeTextArray(
            (Array.isArray(value) ? value : (value ? [value] : []))
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
        ).slice(0, limit).join(', ');
        const buildCharacterStatusSnapshot = (entityData = {}, extraNote = '') => {
            const rawStatus = entityData?.status;
            const status = rawStatus && typeof rawStatus === 'object' && !Array.isArray(rawStatus) ? rawStatus : {};
            const currentStateRaw = entityData?.currentState || entityData?.current_state;
            const currentState = currentStateRaw && typeof currentStateRaw === 'object' && !Array.isArray(currentStateRaw) ? currentStateRaw : {};
            const emotionalState = compactStateList(currentState.emotionalState || currentState.emotional_state, 5);
            const physicalState = compactStateList(currentState.physicalState || currentState.physical_state, 4);
            const cognitiveFocus = compactStateList(currentState.cognitiveFocus || currentState.cognitive_focus, 4);
            const activeProblems = compactStateList(currentState.activeProblems || currentState.active_problems, 4);
            const baseNotes = [
                typeof rawStatus === 'string' ? rawStatus : '',
                status.notes,
                typeof currentStateRaw === 'string' ? currentStateRaw : '',
                currentState.summary || currentState.current_state,
                currentState.immediateGoal || currentState.immediate_goal ? `goal=${currentState.immediateGoal || currentState.immediate_goal}` : '',
                cognitiveFocus ? `focus=${cognitiveFocus}` : '',
                physicalState ? `physical=${physicalState}` : '',
                activeProblems ? `issues=${activeProblems}` : ''
            ].filter(Boolean)
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            const snapshot = {
                currentLocation: status.currentLocation || status.location || currentState.location || '',
                currentMood: status.currentMood || status.mood || emotionalState || '',
                healthStatus: status.healthStatus || status.health || '',
                notes: ''
            };
            const hasEntityState = snapshot.currentLocation || snapshot.currentMood || snapshot.healthStatus || baseNotes.length > 0;
            if (!hasEntityState) return null;
            snapshot.notes = dedupeTextArray([
                ...baseNotes,
                extraNote
            ].filter(Boolean)
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
            ).join(' | ');
            return snapshot;
        };
        const collectEntityStateNameCandidates = (entityData = {}, canonicalName = '') => {
            const values = [
                canonicalName,
                entityData?.name,
                entityData?.canonicalName,
                entityData?.matchedExistingEntity,
                ...(Array.isArray(entityData?.aliases) ? entityData.aliases : [])
            ];
            const entityCache = EntityManager.getEntityCache?.();
            const cachedEntity = canonicalName && entityCache?.get ? entityCache.get(canonicalName) : null;
            if (cachedEntity) {
                values.push(
                    cachedEntity.name,
                    cachedEntity.canonicalName,
                    ...(Array.isArray(cachedEntity.aliases) ? cachedEntity.aliases : []),
                    ...(Array.isArray(cachedEntity.meta?.aliases) ? cachedEntity.meta.aliases : []),
                    ...(Array.isArray(cachedEntity.identity?.aliases) ? cachedEntity.identity.aliases : [])
                );
            }
            return dedupeTextArray(values.map(item => String(item || '').trim()).filter(Boolean));
        };
        const resolveCharacterStateEntityName = (entityData = {}) => {
            const candidates = collectEntityStateNameCandidates(entityData, '');
            for (const candidate of candidates) {
                const resolved = EntityManager.resolveCanonicalName?.(candidate, lore);
                if (resolved) return resolved;
            }
            return String(entityData?.canonicalName || entityData?.matchedExistingEntity || entityData?.name || '').trim();
        };

        const entitiesToConsolidate = new Set();
        if (turnChannel.channel === 'scene' && (entityResult.success || structuredPacketEntityResult?.success)) {
            for (const entityData of [...(entityResult.entities || []), ...(structuredPacketEntityResult?.entities || [])]) {
                if (!entityData.name) continue;
                const statusForRecord = buildCharacterStatusSnapshot(entityData, conversationEmotionNote);
                if (!statusForRecord) continue;
                const canonicalEntityName = resolveCharacterStateEntityName(entityData) || entityData.name;
                if (canonicalEntityName !== entityData.name) {
                    CharacterStateTracker.renameEntityKey?.(entityData.name, canonicalEntityName, {
                        previousNames: collectEntityStateNameCandidates(entityData, canonicalEntityName)
                    });
                }
                // 세포(인물)가 어느 개체(세계)에 속하는가 — 세계 정본에서 해석한다.
                //   location 은 휘발성(04:119)이라 소속을 위치에서 파생할 수 없다. 명시적으로 해석해 넘긴다.
                //   ★ 규칙 텍스트는 넘기지 않는다 — 세계 규칙은 세계 블록이 매 턴 내고 있고,
                //     여기 또 넣으면 5단계에서 끊은 중복이 돌아온다.
                const entityWorldName = (typeof HierarchicalWorldManager !== 'undefined' && HierarchicalWorldManager)
                    ? HierarchicalWorldManager.resolveEntityWorldName?.({ location: statusForRecord.currentLocation }) || ''
                    : '';
                const isCritical = CharacterStateTracker.isCriticalMoment(canonicalEntityName, statusForRecord);
                CharacterStateTracker.recordState(canonicalEntityName, MemoryEngine.getCurrentTurn(), {
                    ...statusForRecord,
                    world: entityWorldName
                });
                if (isCritical) {
                    CharacterStateTracker.recordCriticalMoment(canonicalEntityName, MemoryEngine.getCurrentTurn(),
                        `Critical change: ${JSON.stringify(statusForRecord)}`);
                }
                entitiesToConsolidate.add(canonicalEntityName);
            }
        }

        let worldSnapshotForCommit = null;
        let isWorldCriticalForCommit = false;
        if (turnChannel.channel === 'scene') {
            const collectWorldPayloadNotesForCommit = (worldPayload = {}) => {
                const payload = worldPayload && typeof worldPayload === 'object' && !Array.isArray(worldPayload) ? worldPayload : {};
                const notes = [];
                const pushText = (label, value) => {
                    const text = String(value || '').replace(/\s+/g, ' ').trim();
                    if (text) notes.push(`${label}: ${truncateForLLM(text, 180, ' ... ')}`);
                };
                const exists = payload.exists && typeof payload.exists === 'object' && !Array.isArray(payload.exists) ? payload.exists : {};
                pushText('Scene', exists.currentScene || exists.scene);
                pushText('Location', exists.currentLocation || exists.location);
                pushText('Time', exists.currentTime || exists.time);
                const systems = payload.systems && typeof payload.systems === 'object' && !Array.isArray(payload.systems) ? payload.systems : {};
                const packetRules = Array.isArray(systems.packetRules) ? systems.packetRules : [];
                if (packetRules.length > 0) pushText('Rules', packetRules.slice(0, 4).join(' | '));
                const custom = payload.custom && typeof payload.custom === 'object' && !Array.isArray(payload.custom) ? payload.custom : {};
                const activeEvents = Array.isArray(custom.activeEvents) ? custom.activeEvents : [];
                if (activeEvents.length > 0) pushText('Events', activeEvents.slice(0, 4).join(' | '));
                const offscreenThreads = Array.isArray(custom.offscreenThreads) ? custom.offscreenThreads : [];
                if (offscreenThreads.length > 0) pushText('Offscreen', offscreenThreads.slice(0, 3).join(' | '));
                return dedupeTextArray(notes).slice(0, 8);
            };
            const worldProfile = HierarchicalWorldManager.getProfile();
            const currentNode = HierarchicalWorldManager.getCurrentNode?.();
            const currentMeta = currentNode?.meta || {};
            const currentRules = HierarchicalWorldManager.getCurrentRules();
            const worldSignals = [];
            if (worldMutationPolicy.allowDimensionalShift && Array.isArray(explicitShifts) && explicitShifts.length > 0) {
                worldSignals.push(`Shift: ${explicitShifts.slice(0, 2).map(shift => `${shift?.from || '?'}->${shift?.to || shift?.target || shift?.world || '?'}`).join(', ')}`);
            }
            worldSignals.push(
                ...collectWorldPayloadNotesForCommit(entityResult?.world || {}),
                ...collectWorldPayloadNotesForCommit(structuredPacketEntityResult?.world || {})
            );
            const worldSnapshot = {
                activePath: worldProfile?.activePath || [],
                rules: currentRules,
                global: worldProfile?.global || {},
                classification: String(currentMeta.classification || currentMeta.worldMetadata?.classification || '').trim(),
                worldSummary: String(currentMeta.worldSummary || currentMeta.worldMetadata?.summary || '').trim(),
                ruleHighlights: extractWorldRuleHighlights(currentRules, 6),
                // 세계는 세포(인물)들이 모인 개체다 — 개체가 자기 세포를 봐야 한다.
                // 인물 상태 로그가 이미 여기 있으므로 재료는 갖춰져 있었다(실측: 이 축이 없어
                // 인물이 바뀌어도 세계 상태 로그가 반응하지 않았다).
                presentEntities: (() => {
                    try {
                        const nameList = Array.isArray(involvedEntities) ? involvedEntities.slice(0, 16) : [];
                        const history = (typeof CharacterStateTracker !== 'undefined' && CharacterStateTracker?.getState) ? (CharacterStateTracker.getState() || {}) : {};
                        return nameList.map(name => {
                            const key = String(name || '').trim();
                            if (!key) return null;
                            const log = history[key]?.turnLog || [];
                            const last = log.length ? log[log.length - 1] : null;
                            return {
                                name: key,
                                location: String(last?.location || '').trim(),
                                health: String(last?.health || '').trim(),
                                state: String(last?.mood || '').trim()
                            };
                        }).filter(item => item && item.name);
                    } catch (error) { return []; }
                })(),
                notes: worldSignals.join(' | ')
            };
            const isWorldCritical = WorldStateTracker.isCriticalMoment(worldSnapshot);
            worldSnapshotForCommit = worldSnapshot;
            isWorldCriticalForCommit = isWorldCritical;
            WorldStateTracker.recordState(MemoryEngine.getCurrentTurn(), worldSnapshot);
            if (isWorldCritical) {
                WorldStateTracker.recordCriticalMoment(MemoryEngine.getCurrentTurn(),
                    `World path changed: ${(worldSnapshot.activePath || []).join('→')}`);
            }
        }

        return {
            config,
            conversationEmotion,
            entityResult,
            involvedEntities,
            entitiesToConsolidate: Array.from(entitiesToConsolidate),
            strictUserMsg,
            narrativeUserLabel,
            recordedNarrativeTurn,
            narrativeTrack: turnChannel.channel,
            worldSnapshot: worldSnapshotForCommit,
            isWorldCritical: isWorldCriticalForCommit,
            m_id
        };
    };
    const NO_PRECOMPUTED_CORRECTION = Symbol('libra.no_precomputed_correction');
    const applyTurnStateCorrections = async (turnState, aiResponse, turnForMaintenance, maintenanceConfig, lorebook, precomputedCorrection = NO_PRECOMPUTED_CORRECTION) => {
        if (!turnState || maintenanceConfig?.autoCorrectStates === false || turnState?.narrativeTrack === 'meta') return { corrected: false };
        const extracted = turnState.entityResult && typeof turnState.entityResult === 'object'
            ? turnState.entityResult
            : { entities: [], relations: [], world: {} };
        const correctionWasPrecomputed = precomputedCorrection !== NO_PRECOMPUTED_CORRECTION;
        const correction = correctionWasPrecomputed
            ? precomputedCorrection
            : await EntityAwareProcessor.verifyTurnCorrections(
                turnState.strictUserMsg || '',
                aiResponse || '',
                extracted,
                maintenanceConfig
            );
        if (!EntityAwareProcessor.hasCorrectionPayload(correction)) {
            return { corrected: false, correction };
        }

        const sanitizedCorrectionEntities = EntityAwareProcessor.sanitizeEntities(correction.correctedEntities || [], lorebook);
        const sanitizedCorrectionRelations = EntityAwareProcessor.sanitizeRelations(
            correction.correctedRelations || [],
            lorebook,
            sanitizedCorrectionEntities.map(entity => entity?.name || '')
        );
        const correctionPayload = {
            entities: sanitizedCorrectionEntities,
            relations: sanitizedCorrectionRelations,
            world: correction.world || {},
            conflicts: [],
            sourceMode: 'correction'
        };
        await EntityAwareProcessor.applyExtractions(correctionPayload, lorebook, maintenanceConfig, turnState.m_id || null, { sourceTurn: turnForMaintenance });

        const correctedEntityNames = sanitizedCorrectionEntities
            .map(entity => String(entity?.name || '').trim())
            .filter(Boolean);
        if (correctedEntityNames.length > 0) {
            turnState.involvedEntities = Array.from(new Set([...(turnState.involvedEntities || []), ...correctedEntityNames]));
            turnState.entitiesToConsolidate = Array.from(new Set([...(turnState.entitiesToConsolidate || []), ...correctedEntityNames]));
        }

        const correctionReasonText = Array.isArray(correction.reasons) && correction.reasons.length > 0
            ? `Auto-corrected: ${correction.reasons.join(' | ')}`
            : 'Auto-corrected';
        for (const entityData of sanitizedCorrectionEntities) {
            if (!entityData?.name || !entityData?.status) continue;
            const statusForRecord = {
                ...entityData.status,
                notes: [entityData.status.notes || '', correctionReasonText].filter(Boolean).join(' | ')
            };
            CharacterStateTracker.replaceState(entityData.name, turnForMaintenance, statusForRecord);
        }

        if (correction.world && Object.keys(correction.world).length > 0) {
            const worldProfile = HierarchicalWorldManager.getProfile();
            const currentNode = HierarchicalWorldManager.getCurrentNode?.();
            const currentMeta = currentNode?.meta || {};
            const currentRules = HierarchicalWorldManager.getCurrentRules();
            const correctionWorldNote = buildWorldCorrectionNote(correction.world, correctionReasonText);
            WorldStateTracker.replaceState(turnForMaintenance, {
                activePath: worldProfile?.activePath || [],
                rules: currentRules,
                global: worldProfile?.global || {},
                classification: String(currentMeta.classification || currentMeta.worldMetadata?.classification || '').trim(),
                worldSummary: String(currentMeta.worldSummary || currentMeta.worldMetadata?.summary || '').trim(),
                ruleHighlights: extractWorldRuleHighlights(currentRules, 6),
                notes: correctionWorldNote
            });
        }

        const correctedNarrativeSummary = String(correction?.narrative?.summary || '').trim();
        const correctedNarrativeEntities = Array.isArray(correction?.narrative?.entities)
            ? correction.narrative.entities.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        if (correctedNarrativeSummary || correctedNarrativeEntities.length > 0) {
            NarrativeTracker.correctTurn(turnForMaintenance, {
                summary: correctedNarrativeSummary,
                entities: correctedNarrativeEntities.length > 0 ? correctedNarrativeEntities : correctedEntityNames,
                storylineName: correction?.narrative?.currentArc || correction?.narrative?.storylineName || '',
                narrativeGoal: correction?.narrative?.narrativeGoal || correction?.narrative?.primaryConflict || '',
                keyPoints: Array.isArray(correction?.narrative?.keyPoints) ? correction.narrative.keyPoints : [],
                ongoingTensions: Array.isArray(correction?.narrative?.ongoingTensions) ? correction.narrative.ongoingTensions : []
            });
        }

        const narrativeState = NarrativeTracker.getState?.();
        if (narrativeState && typeof narrativeState === 'object') {
            narrativeState.lastSummaryTurn = Math.min(Number(narrativeState.lastSummaryTurn || turnForMaintenance), Math.max(0, turnForMaintenance - 1));
        }

        if (maintenanceConfig.debug) {
            recordRuntimeDebug('log', '[LIBRA] Turn auto-correction applied:', correction.reasons || []);
        }
        return { corrected: true, correction };
    };
