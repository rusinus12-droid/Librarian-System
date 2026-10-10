            retrieveMemories: async (query, currentTurn, candidates, vars, topK = 15) => {
                const preMmr = vars?.__typedPreMmr === true;
                const recallStartedAt = (typeof performance !== 'undefined' && performance?.now) ? performance.now() : Date.now();
                const cleanQuery = query.trim();
                try {
                    const scopeKey = vars?.scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || '';
                    if (!preMmr) await Promise.race([
                        HmeDerivedCacheStore.hydrate(scopeKey),
                        new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'bounded_timeout' }), 80))
                    ]);
                } catch (error) {
                    if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMECache] derived cache hydrate failed:', error?.message || error);
                }
                const queryTokens = TokenizerEngine.tokenize(cleanQuery);
                const exactAnchors = extractExactRecallAnchors(cleanQuery);
                const recallIntent = classifyRecallIntent(cleanQuery);
                const queryPlan = buildRecallQueryPlan(cleanQuery, exactAnchors, recallIntent);
                const suppressionPlan = normalizeRecallSuppressionPlan(vars?.suppressionPlan || null, cleanQuery, queryPlan, recallIntent);
                queryPlan.suppressionPlan = suppressionPlan;
                const hybridKindPlan = buildHybridKindPlan(queryPlan, recallIntent);
                const scoringAnchors = (CONFIG.recallScoringV2Enabled === false) ? exactAnchors : (queryPlan.strongAnchors || []);
                const W = calculateDynamicWeights(cleanQuery);
                const originalCandidateCount = Array.isArray(candidates) ? candidates.length : 0;
                if (CONFIG.recallDomainGuardEnabled !== false && suppressionPlan.suppressMemoryRecall) {
                    lastRetrievalDebug = {
                        query: cleanQuery,
                        recallIntent: recallIntent.labels || [],
                        queryPlan,
                        suppressionPlan,
                        hybridKindPlan,
                        originalCandidates: originalCandidateCount,
                        filteredCandidates: 0,
                        selectedCount: 0,
                        exactAnchors,
                        scoringAnchors,
                        scoringV2: { enabled: CONFIG.recallScoringV2Enabled !== false, version: RECALL_SCORING_V2_POLICY.version },
                        domainGuardBlocked: true,
                        rejectedReason: suppressionPlan.reason || 'query_domain_mismatch'
                    };
                    if (CONFIG.debug) recordRuntimeDebug('debug', lastRetrievalDebug, { __libraDebugMeta: true, label: 'memory-recall-domain-guard', turn: currentTurn });
                    return [];
                }

                let scopeIndexDebug = null;
                let candidatePool = Array.isArray(candidates) ? candidates : [];
                const recallSourceLorebook = vars?.recallFeedbackLorebook || vars?.effectiveLorebook || candidates;
                const recallFeedbackIndex = buildRecallFeedbackIndex(recallSourceLorebook);
                let coldArchiveHydrationDebug = {
                    enabled: CONFIG.coldArchiveHydrationEnabled !== false,
                    searched: 0,
                    matchedShards: 0,
                    hydratedEntries: 0,
                    skippedReason: ''
                };
                if (!preMmr && CONFIG.coldArchiveHydrationEnabled !== false && Array.isArray(recallSourceLorebook) && typeof ColdArchiveManager !== 'undefined' && ColdArchiveManager?.searchShards && ColdArchiveManager?.hydrateShardsForRecall) {
                    try {
                        const archiveSearch = ColdArchiveManager.searchShards(recallSourceLorebook, cleanQuery, {
                            limit: CONFIG.coldArchiveHydrationMaxShards,
                            minScore: CONFIG.coldArchiveHydrationMinScore
                        });
                        const archiveHydration = await ColdArchiveManager.hydrateShardsForRecall(archiveSearch?.shards || [], {
                            maxEntries: CONFIG.coldArchiveHydrationMaxEntries,
                            itemsPerShard: Math.max(1, Math.ceil((Number(CONFIG.coldArchiveHydrationMaxEntries || 8) || 8) / Math.max(1, Number(CONFIG.coldArchiveHydrationMaxShards || 4) || 4))),
                            scopeKey: vars?.scopeKey || MemoryState?._activeScopeKey || '',
                            chatId: vars?.chatId || '',
                            characterId: vars?.characterId || ''
                        });
                        const existingKeys = new Set(candidatePool.map(entry => String(getSafeKey(entry) || '').trim()).filter(Boolean));
                        const hydratedEntries = (archiveHydration?.entries || []).filter(entry => {
                            const key = String(getSafeKey(entry) || entry?.key || '').trim();
                            if (!key || existingKeys.has(key)) return false;
                            existingKeys.add(key);
                            return true;
                        });
                        if (hydratedEntries.length > 0) candidatePool = [...candidatePool, ...hydratedEntries];
                        coldArchiveHydrationDebug = {
                            enabled: true,
                            searched: Number(archiveSearch?.debug?.searched || 0),
                            matchedShards: Number(archiveSearch?.debug?.matched || 0),
                            hydratedEntries: hydratedEntries.length,
                            search: archiveSearch?.debug || null,
                            hydrate: archiveHydration?.debug || null
                        };
                    } catch (error) {
                        recordSuppressedRuntimeError('cold_archive.recall_hydration_failed', error, {
                            queryChars: cleanQuery.length,
                            candidateCount: candidatePool.length
                        });
                        coldArchiveHydrationDebug = { enabled: true, searched: 0, matchedShards: 0, hydratedEntries: 0, skippedReason: error?.message || 'failed' };
                    }
                } else if (CONFIG.coldArchiveHydrationEnabled === false) {
                    coldArchiveHydrationDebug.skippedReason = 'disabled';
                } else {
                    coldArchiveHydrationDebug.skippedReason = 'unavailable';
                }
                const eligibilityContext = { ...vars, currentTurn };
                candidatePool = filterRecallEligibleEntries(candidatePool, eligibilityContext).entries;
                const allCandidatesByKey = new Map(candidatePool
                    .map(entry => [String(getSafeKey(entry) || '').trim(), entry])
                    .filter(([key]) => key));
                let scopeIndexPreselected = false;
                const scopeIndexBypassLimit = Math.max(24, Math.min(HME_SCOPE_INDEX_PRESELECT_HARD_CAP, Math.max(Number(topK || 10) * 3, 28)));
                const scopeIndexEnabled = !preMmr && CONFIG.hybridMemoryEngineEnabled !== false && CONFIG.hybridReadPathEnabled !== false && CONFIG.hybridScopeIndexEnabled !== false;
                const boundedCandidatePool = candidatePool.length <= scopeIndexBypassLimit;
                if (scopeIndexEnabled && !boundedCandidatePool) {
                    const scopeIndexed = queryHybridScopeIndex(candidatePool, {
                        query: cleanQuery,
                        queryPlan,
                        recallIntent,
                        currentTurn,
                        queryTokens,
                        focusNames: uniqLimit(vars?.focusNames || [], 24),
                        directFocusNames: uniqLimit(vars?.directFocusNames || vars?.focusNames || [], 24),
                        relatedFocusNames: uniqLimit(vars?.relatedFocusNames || [], 24),
                        narrativeArcKeys: uniqLimit(vars?.narrativeArcKeys || [], 12),
                        topK,
                        kindPlan: hybridKindPlan,
                        lorebook: recallSourceLorebook,
                        scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || ''
                    });
                    scopeIndexDebug = scopeIndexed?.debug || { enabled: true, schema: HME_SCOPE_INDEX_SCHEMA, mode: 'scope_index_preselect', ok: false, reason: scopeIndexed?.reason || 'unavailable' };
                    if (scopeIndexed?.ok && Array.isArray(scopeIndexed.entries) && scopeIndexed.entries.length > 0 && scopeIndexed.entries.length < candidatePool.length) {
                        candidatePool = scopeIndexed.entries;
                        scopeIndexPreselected = true;
                        MemoryState.recallRuntimeStats.scopeIndexHits = Number(MemoryState.recallRuntimeStats.scopeIndexHits || 0) + 1;
                    }
                } else if (scopeIndexEnabled && boundedCandidatePool) {
                    scopeIndexDebug = {
                        enabled: true,
                        schema: HME_SCOPE_INDEX_SCHEMA,
                        mode: 'bounded_pool_bypass',
                        ok: true,
                        sourceCandidates: candidatePool.length,
                        bypassLimit: scopeIndexBypassLimit
                    };
                    MemoryState.recallRuntimeStats.boundedPoolBypass = Number(MemoryState.recallRuntimeStats.boundedPoolBypass || 0) + 1;
                }
                if (scopeIndexEnabled && !boundedCandidatePool && !scopeIndexPreselected) {
                    MemoryState.recallRuntimeStats.fullScanFallback = Number(MemoryState.recallRuntimeStats.fullScanFallback || 0) + 1;
                }

                let filtered = filterRecallEligibleEntries(candidatePool, eligibilityContext).entries;

                let hybridReadPathDebug = null;
                let hybridRowsByKey = new Map();
                // 그래프 게이트가 볼 후보풀 크기를 **좁히기 전에** 기록한다.
                //
                // 왜: `10f hybridReadPathShortlist` 가 topK(8 등)로 잘라낸 *뒤*의 길이를
                //   게이트가 보면, 기억이 60건이어도 항상 8 이라 `hmeGraphMinRecallCandidates(24)`
                //   를 **영영 못 넘는다**. 실측: 6·12·20·23·24·30·60건 전부 candidate_gate.
                //   그래프가 확장할 수 있는 대상은 좁힘 *이전* 풀이므로, 게이트도 그 값을 봐야 한다.
                const preShortlistCount = filtered.length;
                if (!preMmr && CONFIG.hybridMemoryEngineEnabled !== false && CONFIG.hybridReadPathEnabled !== false) {
                    const hybridResult = hybridReadPathShortlist(filtered, { queryPlan, recallIntent, currentTurn, queryTokens, focusNames: uniqLimit(vars?.focusNames || [], 24), topK, kindPlan: hybridKindPlan, scopeIndexDebug });
                    filtered = hybridResult.entries || filtered;
                    hybridRowsByKey = hybridResult.rowByKey || new Map();
                    hybridReadPathDebug = hybridResult.debug || null;
                }

                let hmeGraphRecallDebug = null;
                let hmeGraphBoostByKey = new Map();
                if (!preMmr && isHmeGraphEnabled()) {
                    const minGraphRecallCandidates = Math.max(0, Number(CONFIG.hmeGraphMinRecallCandidates ?? LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMinRecallCandidates ?? 24) || 0);
                    // 게이트는 좁힘 전 후보풀을 본다 (preShortlistCount).
                    //   단, 그래프에 넘기는 대상은 좁힌 뒤(filtered) 다 — 확장 결과가
                    //   HME 선택과 합류해야 하기 때문이다. 그래서 둘을 함께 본다:
                    //   좁힘 전이 임계 이상이면 게이트를 열고, 그래프 시드는 좁힌 것에서 뽑는다.
                    if (minGraphRecallCandidates > 0 && preShortlistCount < minGraphRecallCandidates) {
                        hmeGraphRecallDebug = { enabled: true, schema: HME_GRAPH_INDEX_SCHEMA, mode: normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode), ok: false, reason: 'candidate_gate', candidateCount: preShortlistCount, preShortlistCount, minCandidates: minGraphRecallCandidates };
                    } else {
                    const graphResult = expandHmeGraphRecallCandidates(filtered, allCandidatesByKey, {
                        query: cleanQuery,
                        queryPlan,
                        recallIntent,
                        currentTurn,
                        queryTokens,
                        topK,
                        focusNames: uniqLimit(vars?.focusNames || [], 24),
                        directFocusNames: uniqLimit(vars?.directFocusNames || vars?.focusNames || [], 24),
                        relatedFocusNames: uniqLimit(vars?.relatedFocusNames || [], 24),
                        narrativeArcKeys: uniqLimit(vars?.narrativeArcKeys || [], 12),
                        lorebook: recallSourceLorebook,
                        scopeKey: MemoryState._activeScopeKey || MemoryState._activeChatId || ''
                    });
                    if (graphResult?.ok) {
                        filtered = filterRecallEligibleEntries(graphResult.entries || filtered, eligibilityContext).entries;
                        hmeGraphBoostByKey = graphResult.boostByKey || new Map();
                        hmeGraphRecallDebug = graphResult.debug || null;
                    } else {
                        hmeGraphRecallDebug = { enabled: isHmeGraphEnabled(), schema: HME_GRAPH_INDEX_SCHEMA, ok: false, reason: graphResult?.reason || 'unavailable' };
                    }
                    }
                    // hme_graph_debug controls whether graph recall is recorded to the debug
                    // export.  Default 'off' keeps recall allocation-free; the arg must be set
                    // explicitly.  This covers both the candidate-gate path and the expand path.
                    const hmeGraphDebugLevel = String(CONFIG.hmeGraphDebug || 'off').trim().toLowerCase();
                    if (hmeGraphRecallDebug && (hmeGraphDebugLevel === 'compact' || hmeGraphDebugLevel === 'full')) {
                        const graphDebugPayload = hmeGraphDebugLevel === 'full'
                            ? { ...hmeGraphRecallDebug, query: cleanQuery }
                            : {
                                enabled: hmeGraphRecallDebug.enabled,
                                ok: hmeGraphRecallDebug.ok,
                                reason: hmeGraphRecallDebug.reason || '',
                                mode: hmeGraphRecallDebug.mode || '',
                                nodeCount: hmeGraphRecallDebug.nodeCount || 0,
                                edgeCount: hmeGraphRecallDebug.edgeCount || 0,
                                seedCount: hmeGraphRecallDebug.seedCount || 0,
                                candidateCount: hmeGraphRecallDebug.candidateCount || 0,
                                addedCandidates: hmeGraphRecallDebug.addedCandidates || 0
                            };
                        recordRuntimeDebug('debug', graphDebugPayload, { __libraDebugMeta: true, label: 'hme-graph-recall', turn: currentTurn });
                    }
                }

                // Optimization: Pre-filter by keyword overlap if too many candidates,
                // but keep recency/importance/origin backstops so paraphrased or
                // "why/how it started" RP recall queries do not lose old causal memories.
                if (!preMmr && filtered.length > 50 && queryTokens.length >= 2) {
                    const ranked = filtered.map(entry => {
                        const content = CompactMemoryCodec.buildRecallScoringTextFromEntry(entry, CONFIG.recallScoringTextMaxChars || 800) || CompactMemoryCodec.buildSearchTextFromEntry(entry);
                        const contentTokens = new Set(TokenizerEngine.tokenize(content));
                        let overlap = 0;
                        for (const token of queryTokens) {
                            if (contentTokens.has(token)) overlap++;
                        }
                        const meta = getCachedMeta(entry);
                        const payload = getRecallPayload(entry);
                        const exactAnchorHits = getExactAnchorHits(scoringAnchors, content);
                        const intentBonus = calcRecallIntentBonus(payload, recallIntent, meta, currentTurn);
                        const fallbackRank = (calcRecency(meta.t, currentTurn) * 0.45) + ((meta.imp / 10) * 0.35) + (intentBonus * 0.8) + Math.min(0.5, exactAnchorHits.length * 0.16);
                        return { entry, overlap, exactAnchorHits, fallbackRank, intentBonus };
                    });

                    const maxOverlap = ranked.reduce((max, item) => Math.max(max, item.overlap), 0);
                    if (maxOverlap > 0) {
                        const selected = new Set();
                        const overlapTop = ranked
                            .slice()
                            .sort((a, b) => b.overlap - a.overlap || b.intentBonus - a.intentBonus || b.fallbackRank - a.fallbackRank)
                            .slice(0, 60);
                        overlapTop.forEach(item => selected.add(item.entry));

                        const fallbackTop = ranked
                            .slice()
                            .sort((a, b) => b.fallbackRank - a.fallbackRank || b.intentBonus - a.intentBonus || b.overlap - a.overlap)
                            .slice(0, 28);
                        fallbackTop.forEach(item => selected.add(item.entry));

                        const exactAnchorTop = ranked
                            .filter(item => Array.isArray(item.exactAnchorHits) && item.exactAnchorHits.length > 0)
                            .sort((a, b) => b.exactAnchorHits.length - a.exactAnchorHits.length || b.fallbackRank - a.fallbackRank || b.overlap - a.overlap)
                            .slice(0, 32);
                        exactAnchorTop.forEach(item => selected.add(item.entry));

                        // Origin/transition queries need at least a few old cause candidates.
                        if (recallIntent.origin || recallIntent.transition) {
                            ranked
                                .filter(item => item.intentBonus > 0)
                                .sort((a, b) => b.intentBonus - a.intentBonus || b.fallbackRank - a.fallbackRank)
                                .slice(0, 16)
                                .forEach(item => selected.add(item.entry));
                        }
                        filtered = Array.from(selected);
                    }
                }

                let belowThresholdCount = 0;
                let gateRejectedCount = 0;
                const evidenceGateMode = String(CONFIG.recallEvidenceGate || 'soft').toLowerCase();
                const focusNames = uniqLimit(vars?.focusNames || [], 24);
                const embeddingEngine = EmbeddingEngine;
                const semanticEmbeddingAvailable = vars?.embeddingAllowed !== false && !!(embeddingEngine && typeof embeddingEngine.getEmbedding === 'function' && typeof embeddingEngine.cosineSimilarity === 'function');
                const candidateEmbeddingMax = Math.max(0, Math.min(64, Math.floor(Number(CONFIG.recallEmbeddingCandidateMax ?? 8)) || 0));
                const candidateEmbeddingMinSparse = Math.max(0, Math.min(1, Number(CONFIG.recallEmbeddingPrefilterMinSparse ?? RECALL_SCORING_V2_POLICY.minWeakSparseGate) || RECALL_SCORING_V2_POLICY.minWeakSparseGate));
                let preparedCandidates = filtered.map((entry, index) => {
                    const meta = getCachedMeta(entry);
                    const payload = getRecallPayload(entry);
                    const text = CompactMemoryCodec.buildRecallScoringTextFromEntry(entry, CONFIG.recallScoringTextMaxChars || 800) || CompactMemoryCodec.buildSearchTextFromEntry(entry);
                    const recallFeedback = getRecallFeedbackAdjustmentForEntry(entry, meta, payload, recallFeedbackIndex);
                    const hybridRow = hybridRowsByKey.get(getSafeKey(entry)) || null;
                    const recency = calcRecency(meta.t, currentTurn);
                    const importance = (meta.imp / 10);
                    const intentBonus = calcRecallIntentBonus(payload, recallIntent, meta, currentTurn);
                    const recallBucket = resolveHybridRecallBucket(payload, recallIntent, meta, currentTurn, hybridRow, queryPlan, hybridKindPlan);
                    const effectiveRecency = (recallIntent.origin || recallIntent.transition)
                        ? Math.min(recency, 0.72)
                        : recency;
                    const hybridAlignment = hybridRow?.hybridLite?.alignment || null;
                    const hybridBoost = (CONFIG.hybridMemoryEngineEnabled !== false && hybridRow?.hybridLite)
                        ? Math.min(0.20, (Math.max(0, Number(hybridRow.hybridLite.score || 0)) * 0.010) + (Math.max(0, Number(hybridAlignment?.score || 0)) * 0.035))
                        : 0;
                    const hmeGraphBoostInfo = getHmeGraphEntryBoost(entry, { boostByKey: hmeGraphBoostByKey });
                    const hmeGraphPreset = getHmeGraphPreset();
                    const hmeGraphBoost = hmeGraphBoostInfo
                        ? Math.min(hmeGraphPreset.bonusCap || 0, Math.max(0, Number(hmeGraphBoostInfo.boost || 0)))
                        : 0;
                    return {
                        index,
                        entry,
                        meta,
                        payload,
                        text,
                        recallFeedback,
                        hybridRow,
                        recency,
                        importance,
                        intentBonus,
                        recallBucket,
                        effectiveRecency,
                        hybridAlignment,
                        hybridBoost,
                        hmeGraphBoostInfo,
                        hmeGraphPreset,
                        hmeGraphBoost
                    };
                });
                const configuredDetailCap = Number(CONFIG.recallDetailCandidateMax ?? CONFIG.recallDetailedCandidateCap ?? Math.max(32, topK * 4));
                const detailCandidateLimit = Math.max(
                    topK,
                    Math.min(96, Math.floor(configuredDetailCap) || Math.max(32, topK * 4))
                );
                const originalPreparedCandidateCount = preparedCandidates.length;
                if (!preMmr && preparedCandidates.length > detailCandidateLimit) {
                    const queryTokenSet = new Set(queryTokens);
                    const fastRankedCandidates = preparedCandidates.map(item => {
                        const tokenSet = new Set(TokenizerEngine.tokenize(String(item.text || '').slice(0, CONFIG.recallScoringTextMaxChars || 800)));
                        let overlap = 0;
                        for (const token of queryTokenSet) {
                            if (tokenSet.has(token)) overlap++;
                        }
                        const exactHits = getExactAnchorHits(scoringAnchors, item.text);
                        const score = (overlap * 1.35)
                            + (Math.min(4, exactHits.length) * 1.15)
                            + (Math.max(0, Number(item.intentBonus || 0)) * 4)
                            + (Math.max(0, Number(item.hmeGraphBoost || 0)) * 3)
                            + (Math.max(0, Number(item.hybridBoost || 0)) * 3)
                            + (Number(item.recallFeedback?.adjustment || 0) * 4)
                            + (Math.max(0, Number(item.importance || 0)) * 0.55)
                            + (Math.max(0, Number(item.effectiveRecency || item.recency || 0)) * 0.35);
                        item.fastPrefilter = { overlap, exactAnchorHits: exactHits, score };
                        return { item, score, overlap, exactHits };
                    });
                    preparedCandidates = fastRankedCandidates
                        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0)
                            || Number(b.overlap || 0) - Number(a.overlap || 0)
                            || Number(b.exactHits?.length || 0) - Number(a.exactHits?.length || 0)
                            || Number(b.item?.meta?.t || 0) - Number(a.item?.meta?.t || 0))
                        .slice(0, detailCandidateLimit)
                        .map(row => row.item);
                }
                const cheapDetails = await Promise.all(preparedCandidates.map(item => calcSimilarityDetailed(cleanQuery, item.text, {
                    meta: item.meta,
                    currentTurn,
                    focusNames,
                    embeddingAllowed: false,
                    embeddingSkipReason: 'semantic_prefilter_probe',
                    includeWindow: false,
                    maxWindowChars: CONFIG.recallSentenceWindowChars || 260
                })));
                for (let detailIndex = 0; detailIndex < preparedCandidates.length; detailIndex++) {
                    const item = preparedCandidates[detailIndex];
                    item.cheapDetail = cheapDetails[detailIndex] || {
                        similarity: 0,
                        sparseScore: 0,
                        baseScore: 0,
                        embedding: 0,
                        embeddingUsed: false,
                        evidenceGate: false,
                        evidenceReasons: [],
                        anchorBonus: 0,
                        bestWindow: ''
                    };
                    item.exactAnchorHits = getExactAnchorHits(scoringAnchors, item.text);
                    const detail = item.cheapDetail;
                    const sparse = Number(detail?.sparseScore || 0);
                    const baseSparse = Number(detail?.baseScore || 0);
                    const entityHits = Array.isArray(detail?.semanticEntityHits) ? detail.semanticEntityHits : [];
                    const directEvidence = !!(detail?.evidenceGate
                        || Number(detail?.anchorBonus || 0) > 0
                        || Number(detail?.overlap || 0) >= 2
                        || hasDirectSparseEvidence(detail)
                        || item.exactAnchorHits.length > 0
                        || entityHits.length > 0);
                    const intentAligned = !!(bucketMatchesIntent(item.recallBucket, recallIntent) || Number(item.intentBonus || 0) >= 0.14);
                    const graphSignal = !!item.hmeGraphBoostInfo;
                    const hybridSignal = !!(item.hybridRow?.hybridLite && (
                        Number(item.hybridRow.hybridLite.score || 0) > 0
                        || Number(item.hybridAlignment?.score || 0) > 0
                    ));
                    const sparseEligible = sparse >= candidateEmbeddingMinSparse || baseSparse >= candidateEmbeddingMinSparse;
                    const eligible = !!(semanticEmbeddingAvailable && candidateEmbeddingMax > 0 && (
                        sparseEligible
                        || directEvidence
                        || intentAligned
                        || graphSignal
                        || hybridSignal
                    ));
                    const reasons = uniqLimit([
                        ...(sparseEligible ? ['sparse'] : []),
                        ...(directEvidence ? ['direct_evidence'] : []),
                        ...(entityHits.length ? ['entity_overlap'] : []),
                        ...(item.exactAnchorHits.length ? ['exact_anchor'] : []),
                        ...(intentAligned ? ['intent'] : []),
                        ...(graphSignal ? ['hme_graph'] : []),
                        ...(hybridSignal ? ['hybrid'] : [])
                    ], 8);
                    item.embeddingPrefilter = {
                        eligible,
                        reasons,
                        sparse,
                        baseSparse,
                        score: (sparse * 4)
                            + (baseSparse * 2)
                            + (Math.min(0.4, Number(detail?.anchorBonus || 0)) * 3)
                            + (Math.min(3, entityHits.length) * 0.24)
                            + (Math.min(3, item.exactAnchorHits.length) * 0.28)
                            + (Number(item.intentBonus || 0) * 2)
                            + (Number(item.hmeGraphBoost || 0) * 2)
                            + (Math.max(0, Number(item.hybridRow?.hybridLite?.score || 0)) * 0.018)
                            + (Math.max(0, Number(item.hybridAlignment?.score || 0)) * 0.04)
                            + (Number(item.recallFeedback?.adjustment || 0) * 3)
                            + (Math.max(0, Number(item.importance || 0)) * 0.16)
                            + (Math.max(0, Number(item.recency || 0)) * 0.06)
                    };
                }
                const embeddingEligible = preparedCandidates
                    .filter(item => item.embeddingPrefilter?.eligible)
                    .sort((a, b) => Number(b.embeddingPrefilter?.score || 0) - Number(a.embeddingPrefilter?.score || 0)
                        || Number(b.meta?.t || 0) - Number(a.meta?.t || 0));
                const embeddingSelectedSet = new Set(embeddingEligible.slice(0, candidateEmbeddingMax).map(item => item.index));
                const embeddingPrefilterDebug = {
                    enabled: semanticEmbeddingAvailable,
                    candidateMax: candidateEmbeddingMax,
                    minSparse: candidateEmbeddingMinSparse,
                    candidateCount: preparedCandidates.length,
                    originalCandidateCount: originalPreparedCandidateCount,
                    detailCandidateLimit,
                    eligibleCount: embeddingEligible.length,
                    selectedCandidateCount: embeddingSelectedSet.size,
                    skippedCandidateCount: Math.max(0, preparedCandidates.length - embeddingSelectedSet.size),
                    queryEmbedded: false,
                    embeddedCandidateCount: 0
                };
                let queryEmbedding = undefined;
                if (embeddingSelectedSet.size > 0 && semanticEmbeddingAvailable) {
                    queryEmbedding = await embeddingEngine.getEmbedding(cleanQuery, { source: 'memory_recall_query' });
                    embeddingPrefilterDebug.queryEmbedded = !!queryEmbedding;
                }
                if (queryEmbedding) embeddingPrefilterDebug.embeddedCandidateCount = embeddingSelectedSet.size;
                const scoredResults = await Promise.all(preparedCandidates.map(async (item) => {
                    const {
                        entry,
                        meta,
                        payload,
                        text,
                        recallFeedback,
                        hybridRow,
                        recency,
                        importance,
                        intentBonus,
                        recallBucket,
                        effectiveRecency,
                        hybridAlignment,
                        hybridBoost,
                        hmeGraphBoostInfo,
                        hmeGraphPreset,
                        hmeGraphBoost
                    } = item;
                    const shouldEmbedCandidate = !!(queryEmbedding && embeddingSelectedSet.has(item.index));
                    const detail = shouldEmbedCandidate
                        ? await calcSimilarityDetailed(cleanQuery, text, {
                            meta,
                            currentTurn,
                            focusNames,
                            queryEmbedding,
                            embeddingAllowed: true,
                            embeddingSourceB: 'memory_recall_candidate',
                            includeWindow: false,
                            maxWindowChars: CONFIG.recallSentenceWindowChars || 260
                        })
                        : { ...item.cheapDetail };
                    detail.embeddingPrefilter = {
                        selected: shouldEmbedCandidate,
                        eligible: !!item.embeddingPrefilter?.eligible,
                        reasons: item.embeddingPrefilter?.reasons || [],
                        sparse: Number(item.embeddingPrefilter?.sparse || 0),
                        score: Number(item.embeddingPrefilter?.score || 0),
                        skippedReason: shouldEmbedCandidate ? '' : (item.embeddingPrefilter?.eligible ? (queryEmbedding ? 'candidate_embedding_cap' : 'query_embedding_unavailable') : 'low_signal')
                    };
                    const sim = Number(detail?.similarity || 0);
                    const legacyScore = (sim * W.similarity) + (effectiveRecency * W.recency) + (importance * W.importance) + intentBonus;
                    const scoringV2 = scoreRecallItemV2({
                        detail,
                        queryPlan,
                        recallIntent,
                        payload,
                        meta,
                        currentTurn,
                        recency,
                        effectiveRecency,
                        importance,
                        intentBonus,
                        recallBucket,
                        W,
                        text,
                        query: cleanQuery,
                        focusNames,
                        hmeGraphBoostInfo,
                        hmeGraphBoost
                    });
                    if (hmeGraphBoostInfo) {
                        scoringV2.hmeGraphRecall = {
                            schema: HME_GRAPH_INDEX_SCHEMA,
                            mode: hmeGraphPreset.mode,
                            boost: hmeGraphBoost,
                            graphOnly: !!hmeGraphBoostInfo.graphOnly,
                            graphOnlyMaxScore: HME_GRAPH_ONLY_MAX_SCORE,
                            reasons: hmeGraphBoostInfo.reasons || [],
                            edgeChain: hmeGraphBoostInfo.edgeChain || [],
                            edgeLayer: hmeGraphBoostInfo.edgeLayer || '',
                            relation: hmeGraphBoostInfo.relation || '',
                            confidence: Number(hmeGraphBoostInfo.confidence || 0),
                            graphReason: hmeGraphBoostInfo.graphReason || ''
                        };
                    }
                    if (hybridRow?.hybridLite) {
                        scoringV2.hybridReadPath = {
                            version: HYBRID_MEMORY_ENGINE_POLICY.version,
                            kind: hybridRow.primaryKind || 'memory',
                            kinds: hybridRow.kinds || ['memory'],
                            buckets: hybridRow.hybridLite.buckets || [],
                            liteScore: Number(hybridRow.hybridLite.score || 0),
                            boost: hybridBoost,
                            alignment: hybridAlignment,
                            kindPlan: hybridKindPlan,
                            reasons: hybridRow.hybridLite.reasons || []
                        };
                    }
                    if (recallFeedback?.enabled) {
                        scoringV2.recallFeedback = {
                            adjustment: Number(recallFeedback.adjustment || 0),
                            stats: recallFeedback.stats || emptyRecallFeedbackStats(),
                            usedBonus: Number(recallFeedback.usedBonus || 0),
                            ignoredPenalty: Number(recallFeedback.ignoredPenalty || 0),
                            contradictedPenalty: Number(recallFeedback.contradictedPenalty || 0),
                            uncertainPenalty: Number(recallFeedback.uncertainPenalty || 0)
                        };
                    }
                    const feedbackAdjustment = Number(recallFeedback?.adjustment || 0);
                    const rawScore = CONFIG.recallScoringV2Enabled === false
                        ? (legacyScore + feedbackAdjustment)
                        : (scoringV2.finalScore + hybridBoost + hmeGraphBoost + feedbackAdjustment);
                    const score = (CONFIG.recallScoringV2Enabled !== false && hmeGraphBoostInfo?.graphOnly)
                        ? Math.min(rawScore, HME_GRAPH_ONLY_MAX_SCORE)
                        : rawScore;
                    const thresholdPass = CONFIG.recallScoringV2Enabled === false
                        ? (sim >= CONFIG.simThreshold
                            || (intentBonus >= 0.12 && sim >= (CONFIG.simThreshold * 0.58))
                            || (detail.semanticGate && sim >= (CONFIG.simThreshold * 0.68))
                            || (detail.semanticAliasBridge && sim >= (CONFIG.simThreshold * 0.58))
                            || (evidenceGateMode === 'soft' && detail.evidenceGate && sim >= (CONFIG.simThreshold * 0.82))
                            || (evidenceGateMode === 'soft' && detail.evidence?.continuationRecent && sim >= 0.24))
                        : scoringV2.thresholdPass;
                    const gatePass = CONFIG.recallScoringV2Enabled === false
                        ? (evidenceGateMode === 'off'
                            || detail.evidenceGate
                            || detail.semanticGate
                            || intentBonus >= 0.14
                            || sim >= (CONFIG.simThreshold + (evidenceGateMode === 'strict' ? 0.08 : 0.04))
                            || (importance >= 0.85 && sim >= CONFIG.simThreshold * 0.75))
                        : scoringV2.gatePass;
                    detail.scoringV2 = scoringV2;
                    detail.scoringV2Breakdown = scoringV2;
                    if (!thresholdPass || !gatePass) {
                        if (!thresholdPass) belowThresholdCount += 1;
                        if (!gatePass) gateRejectedCount += 1;
                        return {
                            entry,
                            accepted: false,
                            similarity: sim,
                            recency,
                            effectiveRecency,
                            importance,
                            intentBonus,
                            recallBucket,
                            finalScore: score,
                            meta,
                            payload,
                            text,
                            detail,
                            scoringV2,
                            hybridRow,
                            recallFeedback,
                            exactAnchorHits: item.exactAnchorHits || [],
                            rejectReason: scoringV2?.domainMismatchHardReject ? 'domain_mismatch' : (!gatePass ? 'evidence_gate' : 'similarity_threshold')
                        };
                    }
                    return {
                        entry: { ...entry, _score: score, _recallDetail: detail, _recallWindow: detail.bestWindow || '', _recallBucket: recallBucket, _recallIntentBonus: intentBonus, _recallIntentLabels: recallIntent.labels || [], _hybridKind: hybridRow?.primaryKind || '', _hybridKinds: hybridRow?.kinds || [], _hybridBuckets: hybridRow?.hybridLite?.buckets || [], _hybridReasons: hybridRow?.hybridLite?.reasons || [], _hybridKindAlignment: hybridAlignment, _hybridKindPlan: hybridKindPlan, _hmeGraphBoost: hmeGraphBoost, _hmeGraphReasons: hmeGraphBoostInfo?.reasons || [], _hmeGraphOnly: !!hmeGraphBoostInfo?.graphOnly, _recallFeedbackAdjustment: feedbackAdjustment, _recallFeedbackStats: recallFeedback?.stats || null },
                        accepted: true,
                        similarity: sim,
                        recency,
                        effectiveRecency,
                        importance,
                        intentBonus,
                        recallBucket,
                        finalScore: score,
                        meta,
                        payload,
                        text,
                        detail,
                        scoringV2,
                        hybridRow,
                        recallFeedback,
                        exactAnchorHits: item.exactAnchorHits || []
                    };
                }));

                if (preMmr) return buildHeuristicPreMmrLane(scoredResults, topK, { originalCandidates: originalCandidateCount, queryPlan, suppressionPlan,
                    detailPoolCount: preparedCandidates.length, detailCandidateBound: vars.__typedCorpusBound,
                    legacyDetailCandidateLimit: detailCandidateLimit, legacyDetailCapApplied: false }, vars.__typedPreMmrAdmission);
                const accepted = scoredResults.filter(item => item && item.accepted).sort((a, b) => b.finalScore - a.finalScore);
                const selectedDiverseItems = selectRecallDiverse(accepted, topK, recallIntent);
                const selectedItems = rebalanceSelectedRecallItemsForIntent(
                    applyExactAnchorBackfill(selectedDiverseItems, scoredResults, scoringAnchors, topK, recallIntent, currentTurn, eligibilityContext),
                    scoredResults,
                    queryPlan,
                    recallIntent,
                    topK,
                    currentTurn
                );
                const selected = filterRecallEligibleEntries(selectedItems.map(item => item.entry || item), eligibilityContext).entries;
                const rejected = scoredResults.filter(item => item && !item.accepted);
                lastRetrievalDebug = {
                    query: cleanQuery,
                    recallIntent: recallIntent.labels || [],
                    originalCandidates: originalCandidateCount,
                    filteredCandidates: filtered.length,
                    selectedCount: selected.length,
                    exactAnchors,
                    scoringAnchors,
                    queryPlan,
                    suppressionPlan,
                    hybridKindPlan,
                    scoringV2: { enabled: CONFIG.recallScoringV2Enabled !== false, version: RECALL_SCORING_V2_POLICY.version },
                    hybridMemoryEngine: hybridReadPathDebug || { enabled: CONFIG.hybridMemoryEngineEnabled !== false, readPathOnly: true, limited: false, originalRows: filtered.length, selectedRows: filtered.length },
                    hmeAssociativeGraph: hmeGraphRecallDebug || { enabled: isHmeGraphEnabled(), schema: HME_GRAPH_INDEX_SCHEMA, mode: normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode), ok: false, reason: isHmeGraphEnabled() ? 'not_run' : 'disabled' },
                    coldArchiveHydration: coldArchiveHydrationDebug,
                    recallFeedback: {
                        enabled: !!recallFeedbackIndex.enabled,
                        records: recallFeedbackIndex.records || 0,
                        observations: recallFeedbackIndex.observations || 0,
                        adjustedCandidates: scoredResults.filter(item => item?.recallFeedback?.enabled && Number(item.recallFeedback.adjustment || 0) !== 0).length
                    },
                    embeddingPrefilter: embeddingPrefilterDebug,
                    exactAnchorBackfillCount: selectedItems.filter(item => item?.exactAnchorBackfill || item?.entry?._recallExactAnchorBackfill).length,
                    belowThresholdCount,
                    gateRejectedCount,
                    evidenceGateMode,
                    simThreshold: CONFIG.simThreshold,
                    threshold: CONFIG.threshold,
                    weights: { ...W },
                    detailed: CONFIG.debug === true,
                    topEntries: CONFIG.debug === true ? accepted.slice(0, Math.min(6, accepted.length)).map(item => ({
                        importance: Number(item.importance.toFixed(3)),
                        similarity: Number(item.similarity.toFixed(3)),
                        sparse: Number((item.detail?.sparseScore || 0).toFixed(3)),
                        baseSparse: Number((item.detail?.baseScore || 0).toFixed(3)),
                        anchorBonus: Number((item.detail?.anchorBonus || 0).toFixed(3)),
                        intentBonus: Number((item.intentBonus || 0).toFixed(3)),
                        recallBucket: item.recallBucket || 'general',
                        arcKey: item.payload?.arcKey || '',
                        arcRole: item.payload?.arcRole || '',
                        causalRole: item.payload?.causalRole || '',
                        embedding: Number((item.detail?.embedding || 0).toFixed(3)),
                        semanticAssist: !!item.detail?.semanticAssist,
                        semanticGate: !!item.detail?.semanticGate,
                        semanticWeights: `${Number(item.detail?.semanticSparseWeight || 0).toFixed(2)}/${Number(item.detail?.semanticEmbeddingWeight || 0).toFixed(2)}`,
                        semanticReasons: item.detail?.semanticReasons || [],
                        evidenceGate: !!item.detail?.evidenceGate,
                        evidenceReasons: item.detail?.evidenceReasons || [],
                        recency: Number(item.recency.toFixed(3)),
                        effectiveRecency: Number(item.effectiveRecency.toFixed(3)),
                        finalScore: Number(item.finalScore.toFixed(3)),
                        scoringV2: item.scoringV2 ? {
                            relevanceGate: !!item.scoringV2.relevanceGate,
                            directEvidence: !!item.scoringV2.directEvidence,
                            semanticEvidence: !!item.scoringV2.semanticEvidence,
                            intentAligned: !!item.scoringV2.intentAligned,
                            positiveBonus: Number((item.scoringV2.positiveBonus || 0).toFixed(3)),
                            penalty: Number((item.scoringV2.penalty || 0).toFixed(3)),
                            reasons: item.scoringV2.reasons || [],
                            hybridReadPath: item.scoringV2.hybridReadPath || null,
                            hmeGraphRecall: item.scoringV2.hmeGraphRecall || null,
                            recallFeedback: item.scoringV2.recallFeedback || null
                        } : null,
                        hybrid: item.hybridRow ? {
                            kind: item.hybridRow.primaryKind || 'memory',
                            kinds: item.hybridRow.kinds || [],
                            buckets: item.hybridRow.hybridLite?.buckets || [],
                            alignment: item.hybridRow.hybridLite?.alignment || null,
                            reasons: item.hybridRow.hybridLite?.reasons || []
                        } : null,
                        turn: item.meta?.t || 0,
                        preview: String(item.entry?._recallWindow || item.text || '').slice(0, 120)
                    })) : [],
                    selectedBuckets: CONFIG.debug === true ? selectedItems.map(item => ({
                        bucket: item.recallBucket || 'general',
                        arcKey: item.payload?.arcKey || '',
                        turn: item.meta?.t || 0,
                        score: Number((item.finalScore || 0).toFixed(3)),
                        recallFeedbackAdjustment: Number((item?.recallFeedback?.adjustment || item?.entry?._recallFeedbackAdjustment || 0).toFixed(3)),
                        exactAnchorBackfill: Boolean(item?.exactAnchorBackfill || item?.entry?._recallExactAnchorBackfill),
                        exactAnchorHits: item?.exactAnchorHits || item?.entry?._recallExactAnchorBackfill || [],
                        hybridKind: item?.hybridRow?.primaryKind || item?.entry?._hybridKind || '',
                        hybridBuckets: item?.hybridRow?.hybridLite?.buckets || item?.entry?._hybridBuckets || [],
                        hmeGraphBoost: Number(item?.entry?._hmeGraphBoost || 0),
                        hmeGraphOnly: !!item?.entry?._hmeGraphOnly
                    })) : [],
                    rejectedSamples: CONFIG.debug === true ? rejected.slice(0, Math.min(3, rejected.length)).map(item => ({
                        reason: item.rejectReason || 'rejected',
                        similarity: Number(item.similarity.toFixed(3)),
                        intentBonus: Number((item.intentBonus || 0).toFixed(3)),
                        anchorBonus: Number((item.detail?.anchorBonus || 0).toFixed(3)),
                        semanticAssist: !!item.detail?.semanticAssist,
                        semanticReasons: item.detail?.semanticReasons || [],
                        evidenceReasons: item.detail?.evidenceReasons || [],
                        scoringV2: item.scoringV2 ? { reasons: item.scoringV2.reasons || [], penalty: Number((item.scoringV2.penalty || 0).toFixed(3)), relevanceGate: !!item.scoringV2.relevanceGate, hybridReadPath: item.scoringV2.hybridReadPath || null } : null,
                        hybrid: item.hybridRow ? { kind: item.hybridRow.primaryKind || '', buckets: item.hybridRow.hybridLite?.buckets || [], reasons: item.hybridRow.hybridLite?.reasons || [] } : null,
                        turn: item.meta?.t || 0,
                        preview: String(item.text || '').slice(0, 80)
                    })) : []
                };
                const recallLatencyMs = Math.max(0, ((typeof performance !== 'undefined' && performance?.now) ? performance.now() : Date.now()) - recallStartedAt);
                MemoryState.recallRuntimeStats.total = Number(MemoryState.recallRuntimeStats.total || 0) + 1;
                MemoryState.recallRuntimeStats.coldHydrated = Number(MemoryState.recallRuntimeStats.coldHydrated || 0) + Number(coldArchiveHydrationDebug.hydratedEntries || 0);
                MemoryState.recallRuntimeStats.totalLatencyMs = Number(MemoryState.recallRuntimeStats.totalLatencyMs || 0) + recallLatencyMs;
                MemoryState.recallRuntimeStats.lastLatencyMs = recallLatencyMs;
                MemoryState.recallRuntimeStats.lastCandidateCount = filtered.length;
                lastRetrievalDebug.runtimeStats = {
                    ...MemoryState.recallRuntimeStats,
                    averageLatencyMs: MemoryState.recallRuntimeStats.total > 0
                        ? Number((MemoryState.recallRuntimeStats.totalLatencyMs / MemoryState.recallRuntimeStats.total).toFixed(3))
                        : 0
                };
                if (CONFIG.debug) {
                    recordRuntimeDebug('debug', lastRetrievalDebug, { __libraDebugMeta: true, label: 'memory-recall', turn: currentTurn });
                }
                return selected;
            },
