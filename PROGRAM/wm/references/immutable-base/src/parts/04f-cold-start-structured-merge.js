        const mergeStructuredKnowledge = async (finalData, options = {}) => {
            const opts = {
                updateNarrative: true,
                worldNote: "Updated via Cold Start",
                sourceId: 'baseline',
                suppressSyntheticEvidence: false,
                suppressSyntheticNarrativeAnchors: false,
                preserveExistingMetaSource: false,
                ...options
            };
            const requireSelectionCurrent = async () => {
                if (typeof opts.selectionCurrent === 'function' && await opts.selectionCurrent() !== true)
                    throw new Error('historical_selection_changed');
            };
            await requireSelectionCurrent();
            const sanitized = sanitizeStructuredKnowledge(finalData);
            if (!hasMeaningfulStructuredSnapshot(sanitized)) {
                throw new Error('적용할 구조화 데이터가 없습니다.');
            }
            const resolvedSource = resolveStructuredKnowledgeSourceLabel(opts.sourceId);
            const sourceMaxTurn = getColdStartSourceMessagesMaxTurn(opts.sourceMessages);
            const baselineAnchorTurn = Math.max(1, Number(opts.anchorTurn || sourceMaxTurn || getStructuredKnowledgeBaselineAnchorTurn()));
            const transactionScopeHint = String(
                (opts.targetChat ? getChatRuntimeScopeKey(opts.targetChat, opts.targetChar || null) : '')
                || MemoryState._activeScopeKey
                || opts.targetChat?.id
                || 'structured-merge'
            ).trim() || 'structured-merge';
            let runtimeTransactionToken = null;
            if (isLibraRuntimeEpochActive()) {
                // afterRequest owns the same singleton managers. Wait outside the
                // lore lock so its final commit can finish without deadlocking us.
                const transactionDeadline = Date.now() + 2000;
                while (!runtimeTransactionToken && Date.now() < transactionDeadline) {
                    runtimeTransactionToken = ScopedRuntimeTransaction.begin(transactionScopeHint, `structured-merge:${opts.sourceId || 'baseline'}`);
                    if (!runtimeTransactionToken) await sleep(100);
                }
                if (!runtimeTransactionToken) {
                    throw new LIBRAError('다른 LIBRA 후처리가 아직 실행 중입니다. 완료 후 다시 시도해 주세요.', 'RUNTIME_BUSY');
                }
            }
            let mergedTargetChatId = '';
            await loreLock.writeLock();
            try {
                let char = null;
                let chat = null;
                if (opts.targetChat?.id) {
                    const targetCtx = await resolveActiveChatContext(opts.targetChat);
                    if (!targetCtx?.char || !targetCtx?.chat || String(targetCtx.chat?.id || '') !== String(opts.targetChat.id || '')) {
                        throw new Error('구조 반영 대상 채팅방을 찾을 수 없습니다.');
                    }
                    char = targetCtx.char;
                    chat = targetCtx.chat;
                } else {
                    char = opts.targetChar || await requireLoadedCharacter();
                    chat = await getActiveChatForCharacter(char);
                }
                let lore = [...MemoryEngine.getLorebook(char, chat)];
                mergedTargetChatId = String(chat?.id || '').trim();
                await requireSelectionCurrent();
                opts.onMutationStarted?.();
                loadStructuredMergeRuntimeFromLore(lore, char, chat);
                
                LMAI_GUI.toast("데이터 반영 중...");
                const activityContext = { scopeKey: getChatRuntimeScopeKey(chat, char), activityDashboard: MemoryEngine.CONFIG.activityDashboard };
                ActivityDashboardCore.update(activityContext, {
                    phase: 'structured-merge',
                    status: 'running',
                    progress: 82,
                    step: '데이터 반영',
                    stepStatus: 'running',
                    message: '엔티티, 관계, 세계관, 내러티브를 로어북에 반영합니다.'
                });

                if (opts.updateNarrative) {
                    const mergedNarrativeState = buildMergedNarrativeStateFromImportedKnowledge(
                        sanitized,
                        NarrativeTracker.getState(),
                        {
                            sourceId: opts.sourceId,
                            anchorTurn: baselineAnchorTurn,
                            suppressSyntheticEvidence: opts.suppressSyntheticEvidence,
                            suppressSyntheticNarrativeAnchors: opts.suppressSyntheticNarrativeAnchors
                        }
                    );
                    NarrativeTracker.resetState(mergedNarrativeState);
                }

                // 2. Entities & Relations 반영
                for (const ent of (sanitized.entities || [])) {
                    if (!ent.name) continue;
                    const normalizedEntity = extractImportedEntityFields(ent);
                    const extendedEntity = mergeColdStartStructuredValue(
                        ent.extension || {},
                        buildColdStartEntityV2Fields(ent, normalizedEntity, {
                            sourceId: opts.suppressSyntheticEvidence ? '' : resolvedSource,
                            sourceKind: opts.suppressSyntheticEvidence ? '' : 'cold_start_entity',
                            anchorTurn: baselineAnchorTurn,
                            suppressSyntheticEvidence: opts.suppressSyntheticEvidence
                        }),
                        'entity'
                    );
                    const entityPatch = {
                        sex: normalizedEntity.sex || '',
                        appearance: { features: [normalizedEntity.appearance || ''] },
                        personality: {
                            traits: [normalizedEntity.personality || ''],
                            sexualOrientation: normalizedEntity.sexualOrientation || '',
                            sexualPreferences: Array.isArray(normalizedEntity.sexualPreferences) ? normalizedEntity.sexualPreferences : []
                        },
                        background: {
                            origin: normalizedEntity.background || '',
                            occupation: normalizedEntity.occupation || ''
                        },
                        status: {},
                        identity: extendedEntity.identity,
                        profile: extendedEntity.profile,
                        currentState: extendedEntity.currentState,
                        continuity: extendedEntity.continuity,
                        povKnowledge: extendedEntity.povKnowledge,
                        episodeLedger: extendedEntity.episodeLedger,
                        evidence: extendedEntity.evidence,
                        quality: extendedEntity.quality
                    };
                    if (!opts.preserveExistingMetaSource) {
                        entityPatch.source = resolvedSource;
                        entityPatch.s_id = opts.sourceId;
                    }
                    EntityManager.updateEntity(ent.name, entityPatch, lore);
                }

                for (const rel of (sanitized.relations || [])) {
                    if (!rel.entityA || !rel.entityB) continue;
                    const extendedRelation = mergeColdStartStructuredValue(
                        rel.extension || {},
                        buildColdStartRelationV2Fields(rel, {
                            sourceId: opts.suppressSyntheticEvidence ? '' : resolvedSource,
                            sourceKind: opts.suppressSyntheticEvidence ? '' : 'cold_start_relation',
                            anchorTurn: baselineAnchorTurn,
                            suppressSyntheticEvidence: opts.suppressSyntheticEvidence
                        }),
                        'relation'
                    );
                    const relationPatch = {
                        relationType: rel.type || '',
                        sentiments: { fromAtoB: rel.sentiment || '' },
                        currentStatus: extendedRelation.currentStatus,
                        metrics: extendedRelation.metrics,
                        axes: rel.axes || rel.extension?.axes,
                        dynamics: extendedRelation.dynamics,
                        sharedContext: extendedRelation.sharedContext,
                        eventLedger: extendedRelation.eventLedger,
                        evidence: extendedRelation.evidence,
                        quality: extendedRelation.quality
                    };
                    if (!opts.preserveExistingMetaSource) {
                        relationPatch.source = resolvedSource;
                        relationPatch.s_id = opts.sourceId;
                    }
                    EntityManager.updateRelation(rel.entityA, rel.entityB, relationPatch, lore);
                }

                // 3. World Rules 반영 (Root Node)
                HierarchicalWorldManager.loadWorldGraph(lore, true);
                const profile = HierarchicalWorldManager.getProfile();
                const rootNode = profile?.nodes?.get(profile?.rootId);
                if (rootNode && sanitized.world) {
                    rootNode.rules = mergeImportedWorldRules(rootNode.rules, sanitized.world, sanitized.narrative || '');
                    const worldMetaPayload = buildWorldMetaPayload(sanitized.world, rootNode.meta || {});
                    rootNode.meta.classification = worldMetaPayload.classification;
                    rootNode.meta.worldSummary = worldMetaPayload.worldSummary;
                    rootNode.meta.worldMetadata = worldMetaPayload.worldMetadata;
                    rootNode.meta.notes = opts.worldNote;
                    if (!opts.preserveExistingMetaSource) rootNode.meta.s_id = opts.sourceId;
                    recordStructuredWorldState(sanitized, baselineAnchorTurn);
                }
                applyGlobalWorldFeaturesFromImportedKnowledge(profile, sanitized);
                await refreshSectionWorldFromImportedKnowledge(sanitized, opts);
                applyStructuredNarrativeOrchestration(sanitized, baselineAnchorTurn, opts);

                // 4. 모든 매니저의 상태를 하나의 로어북 배열로 통합
                // 각 saveState는 lore 배열을 직접 수정하며, 최종 저장은 아래에서 한 번만 수행합니다.
                
                await HierarchicalWorldManager.saveWorldGraphUnsafe(lore);
                await NarrativeTracker.saveState(lore);
                await StoryAuthor.saveState?.(lore);
                await Director.saveState?.(lore);
                await WorldAdditionalCore.saveState?.(lore);
                await UserDlcCore.saveState?.(lore);
                await CharacterStateTracker.saveState(lore);
                await WorldStateTracker.saveState(lore);
                await SecretKnowledgeCore.saveState(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                await EntityKnowledgeVaultCore.saveState(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                await TimeEngine.saveState(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                });
                
                // EntityManager의 캐시를 로어북 엔트리로 변환하여 병합
                for (const [name, entity] of EntityManager.getEntityCache()) {
                    if (!opts.preserveExistingMetaSource) entity.meta.s_id = entity.meta.s_id || opts.sourceId || 'baseline';
                    IntegrityMetaManager.applyIntegrityMeta(entity, {
                        domain: 'entity',
                        recordSchema: 'libra.entity.record.v1',
                        recordId: entity.name || name,
                        scopeKey: getChatRuntimeScopeKey(chat, char),
                        turn: MemoryState?.currentTurn || 0,
                        source: entity?.meta?.source || 'structured_merge'
                    });
                    const entry = {
                        key: LibraLoreKeys.entityFromName(name),
                        comment: "lmai_entity",
                        content: JSON.stringify(entity, null, 2),
                        mode: 'normal',
                        insertorder: 50,
                        alwaysActive: false
                    };
                    const existingIdx = lore.findIndex(e => {
                        if (e.comment !== "lmai_entity") return false;
                        try {
                            const parsed = JSON.parse(e.content || '{}');
                            return EntityManager.normalizeName(parsed.name || '') === name;
                        } catch {
                            return false;
                        }
                    });
                    if (existingIdx >= 0) lore[existingIdx] = entry;
                    else lore.push(entry);
                }

                for (const [id, relation] of EntityManager.getRelationCache()) {
                    if (!opts.preserveExistingMetaSource) relation.meta.s_id = relation.meta.s_id || opts.sourceId || 'baseline';
                    IntegrityMetaManager.applyIntegrityMeta(relation, {
                        domain: 'relation',
                        recordSchema: 'libra.relation.record.v1',
                        recordId: relation.id || id,
                        scopeKey: getChatRuntimeScopeKey(chat, char),
                        turn: MemoryState?.currentTurn || 0,
                        source: relation?.meta?.source || 'structured_merge'
                    });
                    const entry = {
                        key: LibraLoreKeys.relationFromNames(relation.entityA, relation.entityB),
                        comment: "lmai_relation",
                        content: JSON.stringify(relation, null, 2),
                        mode: 'normal',
                        insertorder: 60,
                        alwaysActive: false
                    };
                    const existingIdx = lore.findIndex(e => {
                        if (e.comment !== "lmai_relation") return false;
                        try {
                            const parsed = JSON.parse(e.content || '{}');
                            const parsedId = parsed.id || `${EntityManager.normalizeName(parsed.entityA || '')}_${EntityManager.normalizeName(parsed.entityB || '')}`;
                            return parsedId === id;
                        } catch {
                            return false;
                        }
                    });
                    if (existingIdx >= 0) lore[existingIdx] = entry;
                    else lore.push(entry);
                }

                const coldStartHydration = await hydrateColdStartBaselineMemory(sanitized, {
                    char,
                    chat,
                    lore,
                    sourceMessages: opts.sourceMessages,
                    sourceId: opts.sourceId,
                    hydrateBaselineMemory: opts.hydrateBaselineMemory,
                    baselineAnchorTurn
                });
                if (MemoryEngine.CONFIG.debug && coldStartHydration && coldStartHydration.skipped !== true) {
                    recordRuntimeDebug('log', '[LIBRA] Cold-start baseline hydration:', coldStartHydration);
                }
                ActivityDashboardCore.update(activityContext, {
                    phase: 'structured-merge',
                    status: 'running',
                    progress: 92,
                    step: '데이터 반영',
                    stepStatus: 'done',
                    message: `콜드 스타트 메모리 ${coldStartHydration?.addedMemoryCount || 0}개를 반영했습니다.`
                });

                // 최종 저장
                if (chat) {
                    chat.localLore = lore;
                } else {
                    char.globalLore = lore;
                }
                await requireSelectionCurrent();
                const persistResult = await persistLoreToActiveChat(chat, lore, {beforeCanonicalWrite:opts.selectionCurrent});
                if (!persistResult?.ok) {
                    throw Object.assign(new Error(`구조 데이터 저장 실패: ${persistResult?.reason || 'unknown'}`),{persistence:persistResult});
                }
                if (opts.requireVerifiedOutcome === true && persistResult.canonicalVerified !== true) return persistResult;
                enterRefreshStabilizeWindow();
                ActivityDashboardCore.finish(activityContext, 'ok', '구조 데이터 저장 완료');
                return persistResult;

            } catch (e) {
                recordRuntimeDebug('error', "[LIBRA] Cold Start Apply Error:", e);
                ActivityDashboardCore.finish({
                    scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                    activityDashboard: MemoryEngine.CONFIG.activityDashboard
                }, 'failed', `구조 데이터 반영 실패: ${e?.message || e}`);
                throw e;
            } finally {
                // A cold/reanalysis request may finish after the user navigates to
                // another chat. Restore singleton managers to the actually active
                // chat after saving the captured target, otherwise the next request
                // could observe the off-screen session's state.
                try {
                    const activeContext = await resolveActiveChatContext();
                    const activeChatId = String(activeContext?.chat?.id || '').trim();
                    if (activeContext?.char && activeContext?.chat && activeChatId && activeChatId !== mergedTargetChatId) {
                        const activeLore = MemoryEngine.getLorebook(activeContext.char, activeContext.chat) || [];
                        loadStructuredMergeRuntimeFromLore(activeLore, activeContext.char, activeContext.chat);
                        MemoryState._activeChatId = activeChatId;
                        MemoryState._activeScopeKey = getChatRuntimeScopeKey(activeContext.chat, activeContext.char);
                    }
                } catch (restoreError) {
                    recordRuntimeDebug('warn', '[LIBRA] Structured merge active runtime restore failed:', restoreError?.message || restoreError);
                }
                loreLock.writeUnlock();
                if (runtimeTransactionToken) ScopedRuntimeTransaction.end(runtimeTransactionToken);
            }
        };

        const applyFinalData = async (finalData, options = {}) => mergeStructuredKnowledge(finalData, {
            updateNarrative: true,
            worldNote: "Updated via Cold Start",
            sourceId: 'baseline',
            ...options
        });

        const buildCurrentStructuredSnapshot = (lore) => {
            // This helper is also used after an awaited LLM call.  At that point the
            // user may be viewing another chat and the singleton trackers may belong
            // to that chat.  Parse only the supplied target lore so verification can
            // never mix another session's narrative or world state into this one.
            let managedLore = Array.isArray(lore) ? lore : [];
            try { managedLore = LibraLoreConsolidator.unpack(managedLore); } catch (_) {}
            const parseEntry = (entry, fallback = {}) => {
                try {
                    const parsed = JSON.parse(String(entry?.content || '{}'));
                    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
                } catch (_) { return fallback; }
            };
            const narrativeState = parseEntry(
                managedLore.find(entry => entry?.comment === 'lmai_narrative'),
                { storylines: [] }
            );
            const storylines = Array.isArray(narrativeState.storylines) ? narrativeState.storylines : [];
            const narrative = storylines
                .map(storyline => {
                    const parts = [];
                    if (storyline.name) parts.push(storyline.name);
                    if (storyline.currentContext) parts.push(storyline.currentContext);
                    if (Array.isArray(storyline.keyPoints) && storyline.keyPoints.length > 0) parts.push(`Key: ${storyline.keyPoints.join('; ')}`);
                    if (Array.isArray(storyline.ongoingTensions) && storyline.ongoingTensions.length > 0) parts.push(`Flow: ${storyline.ongoingTensions.join('; ')}`);
                    return parts.join(' | ');
                })
                .filter(Boolean)
                .join('\n');
            const entities = managedLore
                .filter(entry => entry?.comment === 'lmai_entity')
                .map(entry => parseEntry(entry, null))
                .filter(entity => entity && String(entity.name || '').trim())
                .map(entity => ({
                name: entity.name || '',
                appearance: [...(entity.appearance?.features || []), ...(entity.appearance?.distinctiveMarks || []), ...(entity.appearance?.clothing || [])].filter(Boolean).join(', '),
                personality: [...(entity.personality?.traits || []), ...(entity.personality?.likes || []), ...(entity.personality?.dislikes || [])].filter(Boolean).join(', '),
                background: [entity.background?.origin || '', ...(entity.background?.history || [])].filter(Boolean).join(', '),
                occupation: entity.background?.occupation || '',
                currentLocation: '',
                sexualOrientation: entity.personality?.sexualOrientation || '',
                sexualPreferences: Array.isArray(entity.personality?.sexualPreferences) ? entity.personality.sexualPreferences : [],
                identity: safeClone(entity.identity || {}),
                profile: safeClone(entity.profile || {}),
                currentState: safeClone(entity.currentState || {}),
                continuity: safeClone(entity.continuity || {}),
                povKnowledge: safeClone(entity.povKnowledge || {}),
                episodeLedger: safeClone(entity.episodeLedger || []),
                evidence: safeClone(entity.evidence || []),
                quality: safeClone(entity.quality || {})
            }));
            const relations = managedLore
                .filter(entry => entry?.comment === 'lmai_relation')
                .map(entry => parseEntry(entry, null))
                .filter(relation => relation && String(relation.entityA || '').trim() && String(relation.entityB || '').trim())
                .map(relation => ({
                entityA: relation.entityA || '',
                entityB: relation.entityB || '',
                type: relation.relationType || '',
                sentiment: [relation.sentiments?.fromAtoB || '', relation.sentiments?.fromBtoA || ''].filter(Boolean).join(' / '),
                currentStatus: safeClone(relation.currentStatus || {}),
                metrics: safeClone(relation.metrics || {}),
                dynamics: safeClone(relation.dynamics || {}),
                sharedContext: safeClone(relation.sharedContext || {}),
                eventLedger: safeClone(relation.eventLedger || []),
                evidence: safeClone(relation.evidence || []),
                quality: safeClone(relation.quality || {})
            }));
            const storedWorld = parseEntry(
                managedLore.find(entry => entry?.comment === 'lmai_world_graph'),
                {}
            );
            const worldNodes = Array.isArray(storedWorld.nodes) ? storedWorld.nodes : [];
            const rootId = String(storedWorld.rootId || worldNodes?.[0]?.[0] || '').trim();
            const rootPair = worldNodes.find(pair => String(pair?.[0] || '') === rootId) || worldNodes[0] || null;
            const rootNode = rootPair?.[1] && typeof rootPair[1] === 'object' ? rootPair[1] : null;
            const rootRules = rootNode?.rules || {};
            const rootMeta = rootNode?.meta || {};
            return sanitizeStructuredKnowledge({
                narrative,
                narrativeDetails: {
                    storylines: storylines.map(storyline => ({
                        name: storyline?.name || '',
                        context: storyline?.currentContext || '',
                        keyPoints: Array.isArray(storyline?.keyPoints) ? storyline.keyPoints : [],
                        ongoingTensions: Array.isArray(storyline?.ongoingTensions) ? storyline.ongoingTensions : [],
                        entities: Array.isArray(storyline?.entities) ? storyline.entities : []
                    }))
                },
                entities,
                relations,
                world: {
                    tech: rootRules?.exists?.technology || '',
                    summary: String(rootMeta?.worldSummary || '').trim(),
                    description: String(rootMeta?.worldMetadata?.description || '').trim(),
                    classification: { primary: inferWorldClassificationLabel(rootRules, '') },
                    exists: safeClone(rootRules?.exists || {}),
                    systems: safeClone(rootRules?.systems || {}),
                    physics: safeClone(rootRules?.physics || {}),
                    custom: safeClone(rootRules?.custom || {}),
                    rules: [
                        ...(Array.isArray(rootRules?.physics?.special_phenomena) ? rootRules.physics.special_phenomena : []),
                        ...Object.values(normalizeWorldCustomRules(rootRules?.custom || {}))
                    ]
                }
            });
        };
        const hasMeaningfulStructuredSnapshot = (snapshot) => {
            if (!snapshot || typeof snapshot !== 'object') return false;
            if (String(snapshot?.narrative || '').trim()) return true;
            if (Array.isArray(snapshot?.entities) && snapshot.entities.length > 0) return true;
            if (Array.isArray(snapshot?.relations) && snapshot.relations.length > 0) return true;
            if (String(snapshot?.world?.summary || '').trim()) return true;
            if (String(snapshot?.world?.description || '').trim()) return true;
            if (Array.isArray(snapshot?.world?.rules) && snapshot.world.rules.length > 0) return true;
            if (Array.isArray(snapshot?.narrativeDetails?.storylines) && snapshot.narrativeDetails.storylines.length > 0) return true;
            return false;
        };
        const summarizeStructuredSnapshotForDebug = (snapshot) => ({
            narrative: DebugExportManager.textDigest(snapshot?.narrative || ''),
            storylines: Array.isArray(snapshot?.narrativeDetails?.storylines) ? snapshot.narrativeDetails.storylines.length : 0,
            entities: Array.isArray(snapshot?.entities) ? snapshot.entities.length : 0,
            relations: Array.isArray(snapshot?.relations) ? snapshot.relations.length : 0,
            worldRules: Array.isArray(snapshot?.world?.rules) ? snapshot.world.rules.length : 0,
            meaningful: hasMeaningfulStructuredSnapshot(snapshot)
        });
