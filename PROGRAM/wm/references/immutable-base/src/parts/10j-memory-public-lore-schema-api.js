            getRecallDerivedStorageAdapter,
            getEmbeddingWithSnapshot,
            searchHmeTypedGraphCandidates,
            maintainHmeTypedSourceGraph,
            searchHeuristicCandidatesPreMmr: async (query, entries, context = {}, depth = 32) => {
                const poolBound = Math.min(8192, Math.max(1, Math.floor(Number(context.__typedCorpusBound) || 2048)));
                if (!Array.isArray(entries) || entries.length > poolBound) return { status: 'degraded', reason: 'memory_corpus_bound', hits: [],
                    trace: { stage: 'pre_mmr', scoredCount: 0, detailCandidateBound: poolBound } };
                const lane = await MemoryEngine.retrieveMemories(query, context.currentTurn || 0, entries,
                    { ...context, __typedCorpusBound: poolBound, embeddingAllowed: false, __typedPreMmr: true }, Math.min(32, Math.max(1, Number(depth) || 32)));
                return Array.isArray(lane) ? { status: 'degraded', reason: 'memory_domain_suppressed', hits: [], trace: { stage: 'pre_mmr', scoredCount: 0 } } : lane;
            },
            getLorebook: (char, chat) => LibraLoreConsolidator.unpack(
                Array.isArray(chat?.localLore)
                    ? chat.localLore
                    : (Array.isArray(char?.globalLore) ? char.globalLore : (Array.isArray(char?.lorebook) ? char.lorebook : []))
            ),
            renameEntityReferencesInLore,
            getEffectiveLorebook,
            normalizeLoreStorage,
            isStandardLoreActive,
            prefilterStandardLore,
            setLorebook: (char, chat, data) => {
                const target = Array.isArray(chat?.localLore)
                    ? chat.localLore
                    : (Array.isArray(char?.globalLore) ? char.globalLore : (Array.isArray(char?.lorebook) ? char.lorebook : null));
                try {
                    const hasHmeScopeIndex = Array.isArray(data) && data.some(entry => String(entry?.comment || '').trim() === 'lmai_hme_index');
                    if (!hasHmeScopeIndex) {
                        ensureHybridScopeIndex(data, {
                            scopeKey: getChatRuntimeScopeKey(chat, char),
                            currentTurn: MemoryState.currentTurn,
                            reason: 'setLorebook-bootstrap'
                        });
                    }
                } catch (error) {
                    if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMEIndex] setLorebook index update failed:', error?.message || error);
                }
                const externalEntries = Array.isArray(target)
                    ? target.filter(e => !e.comment || !String(e.comment).startsWith('lmai_'))
                    : [];
                const libraEntries = LibraLoreConsolidator.unpack(Array.isArray(data) ? data : [])
                    .filter(e => e.comment && String(e.comment).startsWith('lmai_'))
                    .map(e => safeClone(e));
                const merged = [...externalEntries, ...libraEntries];
                if (Array.isArray(chat?.localLore)) chat.localLore = merged;
                else if (char) char.globalLore = merged;
                else if (chat) chat.localLore = merged;
            },
            inspectRecallEligibility,
            filterRecallEligibleEntries,
            getManagedEntries: (lorebook) => LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .filter(e => e.comment === 'lmai_memory')
                .filter(e => isIntegrityValidMemoryEntry(e, { scopeKey: MemoryState?._activeScopeKey || '' })),
            inspectMemorySchema: (entry = null) => CompactMemoryCodec.inspectEntryCompatibility(entry),
            auditMemorySchema: (entries = []) => CompactMemoryCodec.migrateEntries(
                LibraLoreConsolidator.unpack(Array.isArray(entries) ? entries : []),
                { dryRun: true }
            ),
            migrateMemorySchema: (entries = []) => CompactMemoryCodec.migrateEntries(
                LibraLoreConsolidator.unpack(Array.isArray(entries) ? entries : []),
                { dryRun: false }
            ),
            exportMemorySchemaV2: (entries = []) => CompactMemoryCodec.exportEntriesV2(
                LibraLoreConsolidator.unpack(Array.isArray(entries) ? entries : [])
            ),
            getMemorySchemaSupport: () => ({
                writeSchema: CompactMemoryCodec.WRITE_SCHEMA || CompactMemoryCodec.LEDGER_SCHEMA,
                readSchemas: [CompactMemoryCodec.LEGACY_SCHEMA, CompactMemoryCodec.LEDGER_SCHEMA, CompactMemoryCodec.BUNDLE_SCHEMA].filter(Boolean),
                legacyRawRead: true,
                migrationPolicy: 'lazy_read_v1_v2_write_v3_with_v2_export'
            }),
            buildRecallSuppressionPlan: (query = '') => buildRecallSuppressionPlan(query, buildRecallQueryPlan(query, extractExactRecallAnchors(query), classifyRecallIntent(query)), classifyRecallIntent(query)),
            matchesRecallSuppressionText: (value = '', plan = {}) => matchesRecallSuppressionText(value, plan),
            getLastRetrievalDebug: () => lastRetrievalDebug ? safeClone(lastRetrievalDebug) : null,
            getCacheStats: () => ({
                meta: getMetaCache().stats,
                sim: getSimCache().stats,
                embedding: getEmbeddingCache().stats,
                embeddingDebug: EmbeddingEngine.getDebugSnapshot?.() || null,
                hybridRows: getHybridRowCache().stats,
                hmeScopeIndex: getHybridScopeIndexStats(),
                hmeGraphIndex: getHmeGraphIndexStats()
            }),
            clearDerivedCaches: () => {
                const before = {
                    meta: getMetaCache().stats?.size || 0,
                    sim: getSimCache().stats?.size || 0,
                    embedding: getEmbeddingCache().stats?.size || 0,
                    hybridRows: getHybridRowCache().stats?.size || 0,
                    hmeScopes: MemoryState.hmeScopeIndexByScope.size || 0,
                    hmeGraphs: MemoryState.hmeGraphIndexByScope.size || 0,
                    hmeTypedGraphs: TypedHmeSourceGraph.cachedScopes()
                };
                MemoryState.hashIndex.clear();
                getMetaCache().clear();
                getSimCache().clear();
                getEmbeddingCache().clear();
                MemoryState.standardLoreTokenCache?.clear?.();
                getHybridRowCache().clear();
                MemoryState.hmeScopeIndexByScope.clear();
                staleHybridScopeIndexScopes.clear();
                MemoryState.hmeGraphIndexByScope.clear();
                MemoryState.hmeGraphStaleRebuildByScope.clear();
                TypedHmeSourceGraph.clear();
                MemoryState.characterLoreEmbeddingCache.clear();
                MemoryState.characterLoreIndexStatusByScope.clear();
                MemoryState.libraProjectionDigestByScope.clear();
                try { DirectProviderCatalog?.resetCache?.(); } catch (_) {}
                return {
                    ok: true,
                    clearedEntries: Object.values(before).reduce((sum, value) => sum + (Number(value) || 0), 0),
                    before
                };
            },
            incrementTurn: () => { MemoryState.currentTurn++; return MemoryState.currentTurn; },
            getCurrentTurn: () => MemoryState.currentTurn,
            setTurn: (turn) => { MemoryState.currentTurn = turn; },
            // Declared-setting introspection: lets tests and the debug export confirm the
            // args wired to emotion/weight/preset/graph-debug actually took effect.
            emotionAdjustedImportance: (baseImportance, text) => emotionAdjustedImportance(baseImportance, text),
            resolveRecallWeights: (query = '') => resolveRecallWeights(query),
            hmeGraphDebugLevel: () => String(CONFIG?.hmeGraphDebug || 'off').trim().toLowerCase() || 'off',
            // Recall-anchor memo introspection: lets tests prove the memo is lossless and that
            // it actually removes work (count the work, not the wall clock).
            normalizeRecallAnchorCached: (value = '') => normalizeRecallAnchor(value),
            normalizeHmeIndexTermCached: (value = '') => normalizeHmeIndexTerm(value),
            normalizeHmeGraphTokenCached: (value = '') => normalizeHmeGraphToken(value),
            // HME 그래프 노드 종류 확장(인물·로어 노드) introspection —
            //   게이트가 그래프를 *직접 만들어* 노드/엣지를 검사할 수 있게 한다.
            //   실측이 필요한 이유: 노드 종류·엣지 의미·예산 보존은 문자열 검사로 판정할 수 없다.
            buildHmeGraphIndexFromScopeIndexForTest: (scopeIndex = null, options = {}) => buildHmeGraphIndexFromScopeIndex(scopeIndex, options),
            hmeGraphNeedsRebuildForTest: (graph = null) => hmeGraphNeedsSemanticV2Rebuild(graph),
            compactHmeGraphForPersistenceForTest: (graph = null) => compactHmeGraphForPersistence(graph),
            getHmeGraphIndexVersion: () => HME_GRAPH_INDEX_VERSION,
            // GUI 시각화용 그래프 뷰 — **제품 그래프를 그대로** 돌려준다.
            //   노드를 새로 만들지 않는다: 화면이 그리는 것은 제품이 만든 노드·엣지여야 한다.
            //   상한으로 자르되 **종류별 보장**을 지킨다(균일 절단은 entity/lore 를 밀어낸다 — 실측).
            //   표본이 아니라 뷰다: 노드 상한 안에서 인물 허브 중심으로 골라 담는다.
            // 인물 중심 뷰 — 관계 화면용. 인물 노드와 **그들 사이의 엣지**만 담는다.
            //   기억 노드 수백 개는 관계 화면에서 소음이다(사용자 제약: 정확 > 화려함).
            //   관계(E3 `relation_record`)가 없으면 인물만 남고, 그러면 "관계가 없다"가 화면에 보인다.
            getHmeEntityGraphView: (scopeKey = '') => {
                try {
                    const key = String(scopeKey || getHybridScopeKey() || '').trim();
                    const graph = getCachedHmeGraphIndex(key) || getCachedHmeGraphIndex(getHybridScopeKey());
                    if (!graph) return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };
                    const all = hmeGraphNodes(graph);
                    const hubs = all.filter(n => String(n.nodeType || '') === 'entity').slice(0, 64);
                    const ids = new Set(hubs.map(n => n.id));
                    // 인물 간 엣지 + 인물-로어 엣지(관계 서술이 로어에 있는 경우)만 남긴다.
                    const edges = hmeGraphEdges(graph)
                        .filter(e => ids.has(e.from) && ids.has(e.to))
                        .slice(0, 400)
                        .map(e => ({
                            from: e.from, to: e.to, relation: e.relation || '', layer: e.layer || '',
                            weight: Number(Number(e.weight || 0).toFixed(3))
                        }));
                    const byId = new Map(all.map(n => [n.id, n]));
                    const withEdges = new Set();
                    for (const e of edges) { withEdges.add(e.from); withEdges.add(e.to); }
                    return {
                        ok: true, reason: '', scopeKey: key,
                        schema: String(graph.schema || ''), version: Number(graph.version || 0) || 0,
                        mode: normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode),
                        stats: {
                            nodeCount: all.filter(n => String(n.nodeType || '') === 'entity').length,
                            edgeCount: hmeGraphEdges(graph).length,
                            // 관계 화면이 알아야 하는 것: 인물 몇 개 중 몇 개가 관계로 이어졌는가
                            linkedCount: withEdges.size,
                            relationCounts: { ...(graph.stats?.relationCounts || {}) },
                            layerCounts: { ...(graph.stats?.layerCounts || {}) }
                        },
                        nodes: hubs.map(n => ({
                            id: n.id, rowId: n.rowId, nodeType: 'entity',
                            label: n.name || n.rowId, kind: 'entity', turn: n.turn ?? null
                        })),
                        edges
                    };
                } catch (err) {
                    return { ok: false, reason: 'view_failed:' + String(err && err.message || err).slice(0, 80), nodes: [], edges: [] };
                }
            },
            // 인물 화면용 뷰 — 인물 노드 + 그들 사이 관계 + (선택) 각 인물이 등장한 기억 일부.
            //   관계 화면(`getHmeEntityGraphView`)과 다른 점: 기억을 **인물당 상한**으로 조금 담는다.
            //   이유: 인물 화면의 질문은 "이 인물이 어떤 기억에 나오는가" 다 — 관계만 보이면 그걸 못 본다.
            //   기억을 전부 담으면 화면이 소음이 되므로 **인물당 최대 N개**로 제한한다.
            getHmeCharacterGraphView: (scopeKey = '', options = {}) => {
                try {
                    const key = String(scopeKey || getHybridScopeKey() || '').trim();
                    const graph = getCachedHmeGraphIndex(key) || getCachedHmeGraphIndex(getHybridScopeKey());
                    if (!graph) return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };
                    const memPerEntity = Math.max(0, Math.min(12, Number(options.memoriesPerEntity ?? 5) || 0));
                    const all = hmeGraphNodes(graph);
                    const byId = new Map(all.map(n => [n.id, n]));
                    const entities = all.filter(n => String(n.nodeType || '') === 'entity').slice(0, 48);
                    const entityIds = new Set(entities.map(n => n.id));
                    const chosenIds = new Set(entityIds);
                    // 인물-기억 엣지(E1) 중 인물당 상한만큼 골라 기억 노드를 포함시킨다.
                    //
                    // ★ 정렬이 필요하다 (실측 결함):
                    //   종전에는 `hmeGraphEdges(graph)` 를 **삽입 순서대로** 순회하며 앞에서 N개를
                    //   골랐다. 그런데 E1 엣지의 weight 는 **전부 1.00**(역할 가중 primary=1.0)이라
                    //   weight 로는 구분이 안 되고, 결과가 엣지 생성 순서에 좌우됐다.
                    //   실측(중요도 0.1·0.9·0.3·0.8·0.5·0.95, 상한 3):
                    //     종전 선택 = 0.1 · 0.9 · 0.3  ← 최고 중요도(0.95)가 밀렸다.
                    //     엣지 배열을 뒤집으면 선택이 통째로 달라졌다(순서 의존).
                    //   축은 **노드의 기존 필드**를 쓴다 — 이 저장소의 관례(10c:1543):
                    //     turn DESC → importance DESC → id asc
                    const memoryRank = (memoryNode = {}) => ({
                        turn: Number(memoryNode?.turn || 0) || 0,
                        importance: Number(memoryNode?.importance || 0) || 0,
                        id: String(memoryNode?.id || '')
                    });
                    const compareMemoryEdges = (left, right) => {
                        const memOf = (e) => {
                            const aEnt = entityIds.has(e.from), bEnt = entityIds.has(e.to);
                            return byId.get(aEnt ? e.to : e.from);
                        };
                        const a = memoryRank(memOf(left)), b = memoryRank(memOf(right));
                        return (b.turn - a.turn)
                            || (b.importance - a.importance)
                            || a.id.localeCompare(b.id)
                            || String(left.id || '').localeCompare(String(right.id || ''));
                    };
                    const perEntity = new Map();
                    const keptMemoryEdges = [];
                    // ★ 같은 인물-기억 쌍이 **여러 relation 으로 중복 집계**되지 않게 한다(실측):
                    //   `shared_entity`(pairwise) 엣지도 `aEnt !== bEnt` 를 통과해 후보로 들어온다.
                    //   중복 제거가 없으면 상한 N 이 **한 기억**으로 채워져 나머지 기억이 사라진다
                    //   (게이트 실측: 상한 3 에 picked 2건).
                    const seenPair = new Set();
                    for (const e of hmeGraphEdges(graph).slice().sort(compareMemoryEdges)) {
                        const aEnt = entityIds.has(e.from), bEnt = entityIds.has(e.to);
                        if (aEnt === bEnt) continue;                 // 인물-기억 쌍만
                        const entId = aEnt ? e.from : e.to;
                        const memId = aEnt ? e.to : e.from;
                        if (String(byId.get(memId)?.nodeType || '') !== 'memory') continue;
                        const pairKey = `${entId}\u0001${memId}`;
                        if (seenPair.has(pairKey)) continue;         // 같은 쌍은 한 번만 센다
                        const n = perEntity.get(entId) || 0;
                        if (n >= memPerEntity) continue;
                        seenPair.add(pairKey);
                        perEntity.set(entId, n + 1);
                        keptMemoryEdges.push(e);
                        chosenIds.add(memId);
                    }
                    const edges = hmeGraphEdges(graph)
                        .filter(e => chosenIds.has(e.from) && chosenIds.has(e.to)
                            && (entityIds.has(e.from) || entityIds.has(e.to)))
                        .slice(0, 900)
                        .map(e => ({
                            from: e.from, to: e.to, relation: e.relation || '', layer: e.layer || '',
                            weight: Number(Number(e.weight || 0).toFixed(3))
                        }));
                    const withEdges = new Set();
                    for (const e of edges) { withEdges.add(e.from); withEdges.add(e.to); }
                    return {
                        ok: true, reason: '', scopeKey: key,
                        schema: String(graph.schema || ''), version: Number(graph.version || 0) || 0,
                        mode: normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode),
                        stats: {
                            nodeCount: entities.length,
                            edgeCount: hmeGraphEdges(graph).length,
                            linkedCount: Array.from(entityIds).filter(id => withEdges.has(id)).length,
                            memoriesPerEntity: memPerEntity,
                            relationCounts: { ...(graph.stats?.relationCounts || {}) },
                            layerCounts: { ...(graph.stats?.layerCounts || {}) },
                            nodeTypeCounts: { ...(graph.stats?.nodeTypeCounts || {}) }
                        },
                        nodes: Array.from(chosenIds).map(id => {
                            const n = byId.get(id);
                            if (!n) return null;
                            return {
                                id: n.id, rowId: n.rowId, nodeType: String(n.nodeType || 'memory'),
                                label: n.name || n.rowId, kind: n.kind || 'memory', turn: n.turn ?? null
                            };
                        }).filter(Boolean),
                        edges
                    };
                } catch (err) {
                    return { ok: false, reason: 'view_failed:' + String(err && err.message || err).slice(0, 80), nodes: [], edges: [] };
                }
            },
            getHmeGraphView: (scopeKey = '') => {
                try {
                    const key = String(scopeKey || getHybridScopeKey() || '').trim();
                    const graph = getCachedHmeGraphIndex(key) || getCachedHmeGraphIndex(getHybridScopeKey());
                    if (!graph) {
                        // 아직 그래프가 없으면 만들지 않고 **없다고** 알린다 —
                        //   GUI 렌더 도중 그래프를 구축하면 화면이 멈춘다(사용자 제약: 렉 없음).
                        return { ok: false, reason: 'no_graph_cached', scopeKey: key, nodes: [], edges: [] };
                    }
                    const viewNodes = hmeGraphSampleNodes(graph);
                    return {
                        ok: true,
                        reason: '',
                        scopeKey: key,
                        schema: String(graph.schema || ''),
                        version: Number(graph.version || 0) || 0,
                        mode: normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode),
                        stats: {
                            nodeCount: graph.stats?.nodeCount || hmeGraphNodes(graph).length,
                            edgeCount: graph.stats?.edgeCount || hmeGraphEdges(graph).length,
                            relationCounts: { ...(graph.stats?.relationCounts || {}) },
                            layerCounts: { ...(graph.stats?.layerCounts || {}) },
                            // 종류별 **보존** 수 — 뷰가 담은 수와 다르다(화면 상한).
                            //   관계 화면 KPI 가 "몇 개 중 몇 개" 를 정확히 말할 수 있게 한다.
                            nodeTypeCounts: { ...(graph.stats?.nodeTypeCounts || {}) }
                        },
                        nodes: viewNodes,
                        edges: hmeGraphSampleEdges(graph, viewNodes)
                    };
                } catch (err) {
                    return { ok: false, reason: 'view_failed:' + String(err && err.message || err).slice(0, 80), nodes: [], edges: [] };
                }
            },
            getHmeIndexTermMemoStats: () => ({
                hits: hmeIndexTermMemoStats.hits,
                misses: hmeIndexTermMemoStats.misses,
                clears: hmeIndexTermMemoStats.clears || 0,
                size: hmeIndexTermMemo.size,
                maxEntries: HME_INDEX_TERM_MEMO_MAX
            }),
            getRecallAnchorMemoStats: () => ({
                hits: recallAnchorMemoStats.hits,
                misses: recallAnchorMemoStats.misses,
                clears: recallAnchorMemoStats.clears || 0,
                size: recallAnchorMemo.size,
                maxEntries: RECALL_ANCHOR_MEMO_MAX
            })
        };
    })();
