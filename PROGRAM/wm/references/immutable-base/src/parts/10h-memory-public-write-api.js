            CONFIG, getSafeKey, getCachedMeta, calcRecency, EmbeddingEngine, EmotionEngine,
            emotionAdjustedImportance,
            TokenizerEngine, formatMemories, incrementalGC, META_PATTERN, parseMeta,

            rebuildIndex: (lorebook) => {
                _log("Rebuilding Hash Index...");
                if (hydrateHybridScopeIndexFromLore(lorebook, { scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || '' })) {
                    if (CONFIG.debug) recordRuntimeDebug('debug', { engine: 'HME_SCOPE_INDEX', action: 'hydrate_hash_index', stats: getHybridScopeIndexStats() }, { __libraDebugMeta: true, label: 'hme-scope-index' });
                    return;
                }
                MemoryState.hashIndex.clear();
                const entries = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : []);
                entries.forEach(entry => {
                    if (entry.comment === 'lmai_memory') {
                        try {
                            const content = CompactMemoryCodec.buildSearchTextFromEntry(entry);
                            if (content.length < 5) return;
                            if (Utils.shouldExcludeStoredMemoryContent(content)) return;
                            const key = getSafeKey(entry);
                            const idxKey = TokenizerEngine.getIndexKey(content);
                            if (!MemoryState.hashIndex.has(idxKey)) MemoryState.hashIndex.set(idxKey, new Set());
                            MemoryState.hashIndex.get(idxKey).add(key);
                        } catch (e) {
                            if (CONFIG.debug) {
                                recordRuntimeDebug('warn', '[LIBRA] rebuildIndex entry error:', e?.message);
                            }
                        }
                    }
                });
            },

            checkDuplication: async (content, existingList) => {
                const idxKey = TokenizerEngine.getIndexKey(content);
                const candidates = MemoryState.hashIndex.get(idxKey) || new Set();
                const map = new Map(existingList.map(e => [getSafeKey(e), e]));
                const checkPool = [...Array.from(candidates).map(k => map.get(k)).filter(Boolean), ...existingList.slice(-12)];
                const uniqueCheck = Array.from(new Set(checkPool));
                let heavyChecks = 0;
                const maxHeavy = CONFIG.hybridDuplicateFastEnabled === false
                    ? Infinity
                    : Math.max(0, Number(CONFIG.hybridDuplicateMaxHeavy || 12) || 0);
                let fastAccepted = 0;
                let fastRejected = 0;

                for (const item of uniqueCheck) {
                    if (!item || !item.content) continue;
                    const existingContent = CompactMemoryCodec.buildSearchTextFromEntry(item);
                    if (!existingContent) continue;
                    const fast = CONFIG.hybridDuplicateFastEnabled === false
                        ? { reject: false, accept: false, score: 0, reason: 'legacy' }
                        : scoreDuplicateCandidateFast(existingContent, content);
                    if (fast.accept) {
                        fastAccepted += 1;
                        if (CONFIG.debug) recordRuntimeDebug('debug', { engine: 'DuplicateScoringFast', accepted: true, score: fast.score, reason: fast.reason }, { __libraDebugMeta: true, label: 'memory-duplicate-fast' });
                        return true;
                    }
                    if (fast.reject) { fastRejected += 1; continue; }
                    if (Math.abs(existingContent.length - content.length) > content.length * 0.7 && Number(fast.score || 0) < 0.48) continue;
                    if (heavyChecks >= maxHeavy) continue;
                    heavyChecks += 1;
                    if (await calcSimilarity(existingContent, content) > 0.75) {
                        if (CONFIG.debug) recordRuntimeDebug('debug', { engine: 'DuplicateScoringFast', accepted: true, via: 'heavy_similarity', heavyChecks, fastScore: fast.score }, { __libraDebugMeta: true, label: 'memory-duplicate-heavy' });
                        return true;
                    }
                }
                if (CONFIG.debug) recordRuntimeDebug('debug', { engine: 'DuplicateScoringFast', accepted: false, checked: uniqueCheck.length, heavyChecks, fastAccepted, fastRejected, maxHeavy }, { __libraDebugMeta: true, label: 'memory-duplicate-summary' });
                return false;
            },

            ensureHybridScopeIndex,
            upsertHybridScopeIndexRows,
            hydrateHybridScopeIndexFromLore,
            scheduleDeferredMemoryGc,

            prepareMemory: async (data, currentTurn, existingList, lorebook, char, chat, m_id = null, metaExtra = {}) => {
                const rawInputContent = Utils.getMemorySourceText(data?.content || '');
                const importance = data?.importance;
                let payload = CompactMemoryCodec.parsePayloadFromContent(rawInputContent);
                if (!payload) payload = CompactMemoryCodec.buildPayloadFromLegacyContent(rawInputContent, { imp: importance, t: currentTurn, sourceHash: metaExtra?.sourceHash, sourceMessageIds: metaExtra?.sourceMessageIds || metaExtra?.liveMessageIds || m_id });
                if (payload) payload = CompactMemoryCodec.normalizePayloadForWrite(payload, {
                    imp: importance,
                    t: currentTurn,
                    sourceHash: metaExtra?.sourceHash,
                    sourceMessageIds: metaExtra?.sourceMessageIds || metaExtra?.liveMessageIds || m_id
                });
                let payloadToStore = payload ? {
                    ...payload,
                    turn: normalizeLegacyMemoryTurnAnchor(payload.turn || currentTurn) || currentTurn,
                    importance: Math.max(1, Math.min(10, Number(importance || payload.importance || 5) || 5)),
                    sourceHash: String(metaExtra?.sourceHash || payload.sourceHash || '').trim(),
                    sourceMessageIds: normalizeCanonicalMessageIds(metaExtra?.sourceMessageIds || metaExtra?.liveMessageIds || payload.sourceMessageIds || m_id)
                } : null;
                if (payloadToStore && CompactMemoryCodec.isLedgerPayload?.(payloadToStore)) {
                    let canonicalEntityCache = new Map();
                    try { canonicalEntityCache = EntityManager?.getEntityCache?.() || new Map(); } catch (_) {}
                    const canonicalEntityNames = new Set([
                        ...Array.from(canonicalEntityCache.values()).map(entity => String(entity?.name || '').trim()),
                        ...asHybridArray(data?.entityRefs).map(value => String(value?.name || value?.id || value || '').trim())
                    ].filter(Boolean));
                    const stripEntityParticle = (value = '') => {
                        const raw = String(value || '').trim();
                        if (!/^[가-힣]{2,12}$/.test(raw)) return raw;
                        for (const suffix of ['에게서는','에게서','에게는','에게','한테는','한테','께서는','께서','에서는','에서','으로는','으로','이라도','이며','이랑','처럼','부터','까지','에는','하고','랑','은','는','이','가','을','를','의','도','로','만','에']) {
                            if (raw.endsWith(suffix) && raw.length - suffix.length >= 2) return raw.slice(0, -suffix.length);
                        }
                        return raw;
                    };
                    const canonicalizeEntityRef = (value = '') => {
                        if (!canonicalEntityNames.size) return '';
                        const stripped = stripEntityParticle(String(value?.name || value?.id || value || '').trim());
                        if (!stripped) return '';
                        if (canonicalEntityNames.has(stripped)) return stripped;
                        try {
                            const resolved = String(EntityManager?.resolveCanonicalName?.(stripped) || '').trim();
                            if (canonicalEntityNames.has(resolved)) return resolved;
                        } catch (_) {}
                        return '';
                    };
                    const cleanEntityRefs = (values = [], limit = 12) => uniqLimit(asHybridArray(values).map(canonicalizeEntityRef).filter(Boolean), limit);
                    const participants = payloadToStore.participants && typeof payloadToStore.participants === 'object'
                        ? { ...payloadToStore.participants }
                        : {};
                    participants.canonicalEntities = cleanEntityRefs([
                        ...asHybridArray(participants.canonicalEntities),
                        ...asHybridArray(payloadToStore.mentionedEntityNames),
                        ...asHybridArray(payloadToStore.entityRefs)
                    ]);
                    payloadToStore = {
                        ...payloadToStore,
                        participants,
                        mentionedEntityNames: participants.canonicalEntities.slice(),
                        facts: asHybridArray(payloadToStore.facts).map(fact => fact && typeof fact === 'object' ? {
                            ...fact,
                            entities: cleanEntityRefs(fact.entities),
                            observerEntities: cleanEntityRefs(fact.observerEntities)
                        } : fact),
                        beats: asHybridArray(payloadToStore.beats).map(beat => beat && typeof beat === 'object' ? { ...beat, entities: cleanEntityRefs(beat.entities) } : beat),
                        relationDeltas: asHybridArray(payloadToStore.relationDeltas).map(delta => delta && typeof delta === 'object' ? { ...delta, pair: cleanEntityRefs(delta.pair || delta.entities, 2) } : delta)
                    };
                    if (payloadToStore.continuity && typeof payloadToStore.continuity === 'object') {
                        payloadToStore.continuity = {
                            ...payloadToStore.continuity,
                            openThreads: asHybridArray(payloadToStore.continuity.openThreads).map(item => item && typeof item === 'object' ? { ...item, entities: cleanEntityRefs(item.entities) } : item),
                            relationSignals: asHybridArray(payloadToStore.continuity.relationSignals).map(item => item && typeof item === 'object' ? { ...item, entities: cleanEntityRefs(item.entities) } : item)
                        };
                    }
                    if (payloadToStore.entityStates && typeof payloadToStore.entityStates === 'object' && !Array.isArray(payloadToStore.entityStates)) {
                        payloadToStore.entityStates = Object.fromEntries(Object.entries(payloadToStore.entityStates)
                            .map(([name, state]) => [canonicalizeEntityRef(name), state])
                            .filter(([name]) => Boolean(name)));
                    }
                }
                const rpTurnMemoryForRetention = payloadToStore?.rpLongTerm || null;
                if (payloadToStore && rpTurnMemoryForRetention && typeof RPContinuityCore !== 'undefined') {
                    payloadToStore = RPContinuityCore.compactPayloadTurnMemory(payloadToStore, rpTurnMemoryForRetention, {
                        turn: currentTurn
                    });
                }
                if (payloadToStore && CompactMemoryCodec.isLedgerPayload?.(payloadToStore)) {
                    payloadToStore.source = {
                        ...(payloadToStore.source && typeof payloadToStore.source === 'object' ? payloadToStore.source : {}),
                        turn: normalizeLegacyMemoryTurnAnchor(payloadToStore.turn || currentTurn) || currentTurn,
                        firstSeenTurn: normalizeLegacyMemoryTurnAnchor(payloadToStore.firstSeenTurn || payloadToStore.source?.firstSeenTurn || payloadToStore.turn || currentTurn) || currentTurn,
                        sourceHash: String(metaExtra?.sourceHash || payloadToStore.sourceHash || payloadToStore.source?.sourceHash || '').trim(),
                        sourceMessageIds: normalizeCanonicalMessageIds(metaExtra?.sourceMessageIds || metaExtra?.liveMessageIds || payloadToStore.sourceMessageIds || payloadToStore.source?.sourceMessageIds || m_id),
                        rawRetention: 'hash_summary_and_structured_evidence_only'
                    };
                    if (CompactMemoryCodec.isV3BundlePayload?.(payloadToStore)) {
                        payloadToStore.recordSchema = CompactMemoryCodec.RECORD_SCHEMA;
                        payloadToStore.records = CompactMemoryCodec.buildCanonicalRecordsV3(payloadToStore, {
                            turn: currentTurn,
                            sourceHash: payloadToStore.source.sourceHash,
                            sourceMessageIds: payloadToStore.source.sourceMessageIds,
                            scopeKey: MemoryState?._activeScopeKey || '',
                            chatId: String(chat?.id || '').trim(),
                            characterId: String(char?.id || char?.name || '').trim()
                        });
                    }
                }
                let content = payloadToStore ? CompactMemoryCodec.serialize(payloadToStore) : rawInputContent;
                let searchContent = CompactMemoryCodec.buildSearchTextFromContent(content);
                if (!searchContent || searchContent.length < 5) return null;
                if (Utils.shouldExcludeStoredMemoryContent(searchContent)) return null;

                sanitizeMemoryRetentionConfig(CONFIG, 'prepareMemory');
                const managed = MemoryEngine.getManagedEntries(lorebook);
                const safeMaxLimit = Math.max(MEMORY_RETENTION_GUARD.minMaxLimit, Math.floor(Number(CONFIG.maxLimit) || MEMORY_PRESETS.general.maxLimit));
                const earlyGcThreshold = Math.max(1, Math.floor(safeMaxLimit * 0.95));
                if (managed.length >= earlyGcThreshold) {
                    _log(`Deferred GC scheduled: ${managed.length}/${safeMaxLimit}`);
                    scheduleDeferredMemoryGc(
                        char,
                        chat,
                        currentTurn,
                        'prepareMemory-deferred-gc',
                        metaExtra?.gcTargetContext || metaExtra?.targetContext || null
                    );
                }

                const updatedList = lorebook || existingList;
                if (data?.forceCreate !== true && await MemoryEngine.checkDuplication(searchContent, updatedList)) return null;
                const hybridStaleCandidateIds = (CONFIG.hybridMemoryEngineEnabled !== false && CONFIG.hybridWritePathEnabled !== false)
                    ? findHybridStaleCandidates(searchContent, updatedList, 6)
                    : [];

                // emotion_enabled boosts importance from the stored text; disabled returns the base.
                const imp = emotionAdjustedImportance(
                    Number(importance || payloadToStore?.importance || 5) || 5,
                    searchContent || rawInputContent || payloadToStore?.summary || ''
                );
                // 수명은 **정본 기준으로 먼저** 정한다. RP-LTM 수명은 그보다 길 때만 늘린다.
                //
                // 종전에는 rpRetention?.ttl 이 정본보다 앞서 있어 RP-LTM 이 정본 수명을
                // **덮어썼다**(실측: 정본 importance 6 → permanent, RP 추출 importance 5 → long).
                // 정본은 그 턴의 실제 중요도로 판정된 값이고 RP-LTM 수명은 카테고리 기본값이라,
                // 정본을 깎거나 임의로 바꾸면 안 된다. 늘리는 방향(정본이 짧은데 지속 사실이 있음)만
                // 허용한다 — "약속이 30턴 뒤 사라진다"를 막으면서 역전은 없어진다.
                const canonicalTtl = imp >= Math.max(9, CONFIG.threshold + 2) ? -1 : (imp >= CONFIG.threshold ? 60 : 30);
                const rpRetention = (CONFIG.rpLongTermMemoryEnabled !== false && rpTurnMemoryForRetention)
                    ? RPContinuityCore.getRetentionPolicy(rpTurnMemoryForRetention, imp, CONFIG)
                    : null;
                const rpWantsLonger = rpRetention && (
                    canonicalTtl !== -1 && (rpRetention.ttl === -1 || Number(rpRetention.ttl || 0) > Number(canonicalTtl))
                );
                const ttl = rpWantsLonger ? rpRetention.ttl : canonicalTtl;
                const anchorTurn = normalizeLegacyMemoryTurnAnchor(metaExtra?.turnAnchorTurn || metaExtra?.turnAnchor || currentTurn) || currentTurn;
                const sourceMessageIds = normalizeCanonicalMessageIds(metaExtra?.sourceMessageIds || metaExtra?.liveMessageIds || m_id);
                const memoryEntityRefs = uniqLimit([
                    ...asHybridArray(payloadToStore?.mentionedEntityNames),
                    ...asHybridArray(payloadToStore?.participants?.canonicalEntities),
                    ...asHybridArray(payloadToStore?.entityRefs)
                ].map(value => String(value?.name || value?.id || value || '').trim()).filter(Boolean), 12);
                const meta = { 
                    t: anchorTurn, ttl, imp, cat: 'personal', ent: memoryEntityRefs, 
                    summary: '',
                    source: String(metaExtra?.source || 'narrative_source_record').trim() || 'narrative_source_record',
                    sourceHint: String(metaExtra?.sourceHint || 'Used as source evidence for narrative summaries.').trim() || 'Used as source evidence for narrative summaries.',
                    s_id: MemoryState.currentSessionId,
                    m_id: getPrimaryCanonicalMessageId(sourceMessageIds, true) || m_id,
                    sourceMessageIds,
                    liveMessageIds: normalizeCanonicalMessageIds(metaExtra?.liveMessageIds || sourceMessageIds),
                    sourceHash: String(metaExtra?.sourceHash || '').trim(),
                    userTurnKey: String(metaExtra?.userTurnKey || '').trim(),
                    turnKey: String(metaExtra?.turnKey || '').trim(),
                    messageSignature: compactTurnMessageSignature(metaExtra?.messageSignature || ''),
                    messageCount: Number(metaExtra?.messageCount || 0),
                    firstTurn: anchorTurn,
                    originalTurn: anchorTurn,
                    lockedTurn: anchorTurn,
                    finalizedTurn: anchorTurn,
                    turnAnchorTurn: anchorTurn,
                    turnAnchor: anchorTurn,
                    turnLocked: true,
                    turnAnchorReason: String(metaExtra?.turnAnchorReason || 'v4.2-finalized-turn').trim() || 'v4.2-finalized-turn',
                    chatId: String(metaExtra?.chatId || chat?.id || '').trim(),
                    recallHints: StrengthenedJaccardCore.buildRecallHints(searchContent, { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 }),
                    rawRetention: 'summary_and_structured_evidence',
                    rawDiscarded: true,
                    rpRetention: rpRetention ? {
                        schema: RPContinuityCore.TURN_SCHEMA,
                        protected: rpRetention.protected === true,
                        durability: rpRetention.durability,
                        reasons: rpRetention.reasons || []
                    } : undefined
                };

                if (payloadToStore && CONFIG.hybridMemoryEngineEnabled !== false && CONFIG.hybridWritePathEnabled !== false) {
                    meta.projection = {
                        schema: 'libra.memory.projection_pointer.v1',
                        hmeDerivedAtReadTime: true,
                        sourceTurnIds: [anchorTurn],
                        staleCandidateIds: hybridStaleCandidateIds,
                        hiddenFromPrompt: false
                    };
                    content = CompactMemoryCodec.serialize(payloadToStore);
                    searchContent = CompactMemoryCodec.buildSearchTextFromContent(content);
                    try { meta.recallHints = StrengthenedJaccardCore.buildRecallHints(searchContent, { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 }); }
                    catch (error) {
                        recordSuppressedRuntimeError('hme.memory_projection.recall_hints_failed', error, {
                            turn: anchorTurn,
                            contentChars: String(searchContent || '').length
                        });
                    }
                }

                IntegrityMetaManager.annotateMemoryMeta(meta, content, {
                    domain: 'memory',
                    recordSchema: 'libra.memory.entry.v1',
                    recordId: meta.turnKey || meta.sourceHash || meta.m_id || '',
                    scopeKey: String(metaExtra?.scopeKey || MemoryState?._activeScopeKey || getChatRuntimeScopeKey(chat, char) || '').trim(),
                    turn: anchorTurn,
                    source: meta.source || ''
                });
                const entryContent = `[META:${JSON.stringify(meta)}]\n${content}\n`;
                const strippedContent = CompactMemoryCodec.buildSearchTextFromContent(entryContent);
                const idxKey = TokenizerEngine.getIndexKey(strippedContent);
                const safeKey = TokenizerEngine.getSafeMapKey(entryContent);
                if (!MemoryState.hashIndex.has(idxKey)) MemoryState.hashIndex.set(idxKey, new Set());
                MemoryState.hashIndex.get(idxKey).add(safeKey);

                return {
                    key: "", comment: 'lmai_memory',
                    content: entryContent,
                    mode: "normal", insertorder: 100, alwaysActive: false
                };
            },

