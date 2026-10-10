        const buildHybridKindPlan = (queryPlan = {}, recallIntent = {}) => {
            const raw = String(queryPlan.raw || '');
            const anchors = Array.isArray(queryPlan.strongAnchors) ? queryPlan.strongAnchors : [];
            const wants = new Set();
            const bundleOrder = [];
            const push = (kind) => { if (!kind || wants.has(kind)) return; wants.add(kind); bundleOrder.push(kind); };

            if (recallIntent?.worldRule || anchors.some(a => /규칙|금지|세계관|시스템/.test(a)) || /왜\s*못|세계\s*규칙|제약/.test(raw)) push('world');
            if (recallIntent?.origin || RECALL_ORIGIN_QUERY_CUE_RE.test(raw) || /왜\s*흔들/.test(raw)) push('origin');
            if (recallIntent?.transition || /전환|계기|바뀐|이후/.test(raw)) push('transition');
            if (recallIntent?.relationship || /관계|감정|연인|사랑|relationship|romance/i.test(raw)) push('relationship');
            if (recallIntent?.aftermath) push('aftermath');
            if (recallIntent?.current || /최근|현재|방금|이어/.test(raw)) push('current');
            if (queryPlan.hasRpNamedAnchor) push('entity');
            if (anchors.length) push('exact');
            push('narrative');
            push('memory');

            const kindWeights = {
                exact: wants.has('exact') ? 1.0 : 0.55,
                entity: wants.has('entity') ? 0.92 : 0.35,
                world: wants.has('world') ? 1.0 : 0.28,
                narrative: (wants.has('origin') || wants.has('transition') || wants.has('aftermath')) ? 0.88 : 0.42,
                relationship: wants.has('relationship') ? 0.94 : 0.36,
                origin: wants.has('origin') ? 1.0 : 0.32,
                transition: wants.has('transition') ? 0.9 : 0.26,
                current: wants.has('current') ? 0.82 : 0.24,
                aftermath: wants.has('aftermath') ? 0.86 : 0.22,
                memory: 0.45
            };
            const primaryKinds = Array.from(wants).filter(k => !['exact','origin','transition','current','aftermath','memory'].includes(k));
            return {
                version: HYBRID_MEMORY_ENGINE_POLICY.version,
                wants: Array.from(wants),
                bundleOrder: uniqLimit(bundleOrder, 12),
                kindWeights,
                primaryKinds: primaryKinds.length ? primaryKinds : ['memory'],
                preserveBuckets: uniqLimit(['exact', ...bundleOrder, 'recentImportant', 'memory'], 16)
            };
        };
        const hybridRowTagHits = (row = {}, queryPlan = {}) => {
            const q = normalizeHybridToken(queryPlan.raw || '');
            const fields = {
                scene: row.sceneTags || [],
                emotion: row.emotionTags || [],
                relation: row.relationTags || [],
                world: row.worldTags || [],
                narrative: row.narrativeTags || [],
                tag: row.tags || []
            };
            const hits = {};
            Object.entries(fields).forEach(([name, list]) => {
                const matched = (Array.isArray(list) ? list : []).filter(tag => {
                    const t = normalizeHybridToken(tag);
                    if (!t) return false;
                    if (q.includes(t)) return true;
                    if (/origin|원점/.test(t) && RECALL_ORIGIN_QUERY_CUE_RE.test(q)) return true;
                    return false;
                }).slice(0, 6);
                if (matched.length) hits[name] = matched;
            });
            const flat = Object.values(hits).flat();
            return { hits, flat, count: flat.length };
        };
        const getHybridKindAlignment = (row = {}, kindPlan = {}, queryPlan = {}, recallIntent = {}) => {
            const buckets = new Set(Array.isArray(row.hybridLite?.buckets) ? row.hybridLite.buckets : []);
            const kinds = new Set(Array.isArray(row.kinds) ? row.kinds : []);
            const weights = kindPlan.kindWeights || {};
            let score = 0;
            const reasons = [];
            const add = (key, amount, reason) => {
                const value = Number(amount || 0);
                if (value <= 0) return;
                score += value;
                if (reason) reasons.push(reason);
            };
            ['exact','entity','world','narrative','relationship','origin','transition','current','aftermath','memory'].forEach(key => {
                const keyMatched = key === 'world'
                    ? (buckets.has('world') || isHybridWorldPrimary(row))
                    : (buckets.has(key) || kinds.has(key) || row.primaryKind === key || row.baseBucket === key);
                if (keyMatched) {
                    add(key, Number(weights[key] || 0), `align:${key}`);
                }
            });
            if (recallIntent?.worldRule && isHybridWorldPrimary(row)) add('world-intent', 0.55, 'intent:world');
            if (recallIntent?.origin && (buckets.has('origin') || row.baseBucket === 'origin' || row.narrativeTags?.includes('origin'))) add('origin-intent', 0.58, 'intent:origin');
            if (recallIntent?.relationship && (kinds.has('relationship') || row.primaryKind === 'relationship')) add('relationship-intent', 0.52, 'intent:relationship');
            const tagHits = hybridRowTagHits(row, queryPlan);
            if (tagHits.count) add('tag-hit', Math.min(0.75, tagHits.count * 0.18), `tag:${tagHits.flat.slice(0, 3).join('/')}`);
            const directKind = hybridKindMatchesIntent(row, recallIntent, queryPlan);
            if (directKind.length) add('direct-kind', Math.min(0.6, directKind.length * 0.24), `kind:${directKind.join('/')}`);
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const originCueProfile = strictOriginQuery ? getOriginSceneCueProfile(row.text || '', row.payload || {}) : { hits: [], strongHits: [], weakHits: [], totalCount: 0, strongCount: 0, weakCount: 0 };
            if (originCueProfile.totalCount) add('origin-scene', Math.min(1.28, (originCueProfile.strongCount * 0.42) + (originCueProfile.weakCount * 0.16)), `scene:${originCueProfile.hits.slice(0, 3).join('/')}`);
            return { score: Number(score.toFixed(4)), reasons: uniqLimit(reasons, 12), tagHits: tagHits.hits, bundleOrder: kindPlan.bundleOrder || [] };
        };
        const resolveHybridRecallBucket = (payload = {}, recallIntent = {}, meta = {}, currentTurn = 0, hybridRow = null, queryPlan = {}, kindPlan = {}) => {
            const legacy = classifyRecallBucket(payload, recallIntent, meta, currentTurn);
            if (!hybridRow) return legacy;
            const buckets = new Set(Array.isArray(hybridRow.hybridLite?.buckets) ? hybridRow.hybridLite.buckets : []);
            const kinds = new Set(Array.isArray(hybridRow.kinds) ? hybridRow.kinds : []);
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const originCueProfile = strictOriginQuery ? getOriginSceneCueProfile(hybridRow.text || '', payload || {}) : { strongCount: 0 };
            if (recallIntent?.origin && strictOriginQuery && ((originCueProfile.strongCount || 0) > 0 || buckets.has('origin') || hybridRow.baseBucket === 'origin')) return 'origin';
            if ((queryPlan.strongAnchors || []).length && buckets.has('exact')) return 'exact';
            if (recallIntent?.worldRule && isHybridWorldPrimary(hybridRow)) return 'world';
            if (recallIntent?.origin && (buckets.has('origin') || hybridRow.baseBucket === 'origin')) return 'origin';
            if (recallIntent?.transition && (hybridRow.baseBucket === 'transition' || hybridRow.narrativeTags?.includes('transition'))) return 'transition';
            if (recallIntent?.relationship && (kinds.has('relationship') || hybridRow.primaryKind === 'relationship')) return 'relationship';
            if (recallIntent?.aftermath && (hybridRow.baseBucket === 'aftermath' || hybridRow.narrativeTags?.includes('aftermath'))) return 'aftermath';
            if (recallIntent?.current && buckets.has('current')) return 'current';
            if (isHybridWorldPrimary(hybridRow)) return 'world';
            if (hybridRow.primaryKind === 'relationship') return 'relationship';
            if (hybridRow.primaryKind === 'entity' && (queryPlan.hasRpNamedAnchor || (queryPlan.strongAnchors || []).length)) return 'entity';
            if (hybridRow.primaryKind === 'narrative') {
                if (buckets.has('origin')) return 'origin';
                return 'narrative';
            }
            return legacy;
        };
        const scoreHybridRowLite = (row = {}, queryPlan = {}, recallIntent = {}, currentTurn = 0, queryTokens = [], focusNames = [], kindPlan = {}) => {
            const text = String(row.text || '');
            const anchorHits = getExactAnchorHits(queryPlan.strongAnchors || [], text).filter(isScoringStrongRecallAnchor).slice(0, 8);
            const entityHits = uniqLimit([...queryHasHybridEntity(queryPlan.raw || '', row.subjects || []), ...queryHasHybridEntity(queryPlan.raw || '', focusNames || [])], 8);
            const kindMatches = hybridKindMatchesIntent(row, recallIntent, queryPlan);
            const tokenSet = new Set(TokenizerEngine.tokenize(text).slice(0, 300));
            let tokenOverlap = 0;
            for (const token of Array.isArray(queryTokens) ? queryTokens : []) if (tokenSet.has(token)) tokenOverlap += 1;
            const turn = Number(row.turn || 0);
            const recency = calcRecency(turn, currentTurn);
            const intentBonus = calcRecallIntentBonus(row.payload || {}, recallIntent, row.meta || {}, currentTurn);
            const isRecentImportant = recency > 0.58 && Number(row.importance || 0) >= 0.62;
            const tagHits = hybridRowTagHits(row, queryPlan);
            const worldPrimaryMatch = recallIntent?.worldRule && isHybridWorldPrimary(row);
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const originCueProfile = strictOriginQuery ? getOriginSceneCueProfile(text, row.payload || {}) : { hits: [], strongHits: [], weakHits: [], totalCount: 0, strongCount: 0, weakCount: 0 };
            const originSceneCueHits = originCueProfile.hits;
            const familyOriginMismatch = recallIntent?.origin
                && RECALL_LATE_FAMILY_RE.test(text)
                && originSceneCueHits.length === 0;
            const originLateFamilyLeak = detectOriginLateFamilyLeak({
                text,
                payload: row.payload || {},
                recallIntent,
                queryPlan,
                entityNames: uniqLimit([...(Array.isArray(row.subjects) ? row.subjects : []), ...(Array.isArray(focusNames) ? focusNames : [])], 16),
                matchedAnchors: anchorHits
            });
            const weakOriginFit = strictOriginQuery
                && recallIntent?.origin
                && originSceneCueHits.length === 0
                && !anchorHits.some(anchor => RECALL_EARLY_ORIGIN_SCENE_RE.test(anchor))
                && row.baseBucket !== 'origin'
                && row.baseBucket !== 'transition';
            const buckets = new Set(['memory']);
            if (anchorHits.length) buckets.add('exact');
            if (entityHits.length || (row.subjects || []).length) buckets.add('entity');
            if (isHybridWorldPrimary(row)) buckets.add('world');
            if ((row.kinds || []).includes('narrative')) buckets.add('narrative');
            if ((row.kinds || []).includes('relationship')) buckets.add('relationship');
            if (row.baseBucket === 'origin' || row.narrativeTags?.includes('origin')) buckets.add('origin');
            if (row.baseBucket === 'transition' || row.narrativeTags?.includes('transition')) buckets.add('transition');
            if (row.baseBucket === 'aftermath' || row.narrativeTags?.includes('aftermath')) buckets.add('aftermath');
            if (row.baseBucket === 'current' || recency > 0.72) buckets.add('current');
            if (isRecentImportant) buckets.add('recentImportant');
            if (tagHits.count) buckets.add('tag');
            const alignment = getHybridKindAlignment({ ...row, hybridLite: { buckets: Array.from(buckets) } }, kindPlan, queryPlan, recallIntent);
            const score = (anchorHits.length * 5.0)
                + (entityHits.length * 3.0)
                + (kindMatches.length * 2.8)
                + Math.min(5, tokenOverlap * 0.55)
                + (intentBonus * 7.0)
                + (Number(row.importance || 0) * 1.4)
                + (recency * 0.9)
                + (worldPrimaryMatch ? 3.2 : 0)
                + ((row.baseBucket === 'origin' && recallIntent?.origin) ? 2.2 : 0)
                + ((row.baseBucket === 'transition' && recallIntent?.transition) ? 1.8 : 0)
                + (tagHits.count * 0.9)
                + Math.min(4.2, (originCueProfile.strongCount * 2.1) + (originCueProfile.weakCount * 1.0))
                + (Number(alignment.score || 0) * 2.1)
                - (familyOriginMismatch ? 3.6 : 0)
                - (originLateFamilyLeak ? 2.0 : 0)
                - (weakOriginFit ? 0.9 : 0)
                - (strictOriginQuery && recallIntent?.origin && originCueProfile.strongCount === 0 && originCueProfile.weakCount > 0 ? 0.38 : 0);
            const reasons = uniqLimit([
                ...(anchorHits.length ? [`anchor:${anchorHits.join('/')}`] : []),
                ...(entityHits.length ? [`entity:${entityHits.join('/')}`] : []),
                ...(kindMatches.length ? [`kind:${kindMatches.join('/')}`] : []),
                ...(alignment.reasons || []),
                ...(tagHits.count ? [`tag:${tagHits.flat.slice(0, 3).join('/')}`] : []),
                ...(originSceneCueHits.length ? [`scene:${originSceneCueHits.slice(0, 3).join('/')}`] : []),
                ...(strictOriginQuery && recallIntent?.origin && originCueProfile.strongCount === 0 && originCueProfile.weakCount > 0 ? ['origin-strong-scene-miss'] : []),
                ...(worldPrimaryMatch ? ['world-primary-match'] : []),
                ...(originLateFamilyLeak ? ['origin-late-family-leak'] : []),
                ...(familyOriginMismatch ? ['origin-family-mismatch'] : []),
                ...(weakOriginFit ? ['origin-scene-miss'] : []),
                ...(intentBonus > 0 ? [`intent:${intentBonus.toFixed(2)}`] : []),
                ...(tokenOverlap > 0 ? [`token:${tokenOverlap}`] : []),
                ...(isRecentImportant ? ['recent-important'] : [])
            ], 16);
            return { score, buckets: Array.from(buckets), anchorHits, entityHits, kindMatches, tokenOverlap, intentBonus, recency, tagHits: tagHits.hits, alignment, reasons };
        };
        const addHybridRowsByBucket = (target = [], seen = new Set(), rows = [], bucket = 'memory', limit = 8, maxTotal = Infinity) => {
            rows
                .filter(row => Array.isArray(row?.hybridLite?.buckets) && row.hybridLite.buckets.includes(bucket))
                .sort((a, b) => Number(b.hybridLite?.score || 0) - Number(a.hybridLite?.score || 0) || Number(b.turn || 0) - Number(a.turn || 0))
                .slice(0, Math.max(0, Number(limit || 0)))
                .forEach(row => {
                    if (target.length >= maxTotal) return;
                    if (!row?.id || seen.has(row.id)) return;
                    seen.add(row.id);
                    target.push(row);
                });
        };
        const hybridReadPathShortlist = (entries = [], { queryPlan = {}, recallIntent = {}, currentTurn = 0, queryTokens = [], focusNames = [], topK = 15, kindPlan: suppliedKindPlan = null, scopeIndexDebug = null } = {}) => {
            const sourceEntries = Array.isArray(entries) ? entries : [];
            const kindPlan = suppliedKindPlan || buildHybridKindPlan(queryPlan, recallIntent);
            const rows = sourceEntries
                .map((entry, index) => buildHybridMemoryRow(entry, index, currentTurn))
                .filter(Boolean)
                .map(row => ({ ...row, hybridLite: scoreHybridRowLite(row, queryPlan, recallIntent, currentTurn, queryTokens, focusNames, kindPlan) }));
            const rowByKey = new Map();
            rows.forEach(row => { if (row.id) rowByKey.set(row.id, row); });
            const bucketCounts = {};
            rows.forEach(row => (row.hybridLite?.buckets || ['memory']).forEach(bucket => { bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1; }));
            const totalTextCost = rows.reduce((sum, row) => sum + Math.max(1, row.contentChars || 0) * Math.max(1, Math.min(8, Math.ceil(String(queryPlan.raw || '').length / 80))), 0);
            const configuredMaxRows = Number(CONFIG.hybridReadPathMaxRows || HYBRID_MEMORY_ENGINE_POLICY.maxHeavyRowsDefault);
            const maxRows = Math.max(6, Math.min(Number(HYBRID_MEMORY_ENGINE_POLICY.maxHeavyRowsHardCap || 8), Number.isFinite(configuredMaxRows) ? configuredMaxRows : HYBRID_MEMORY_ENGINE_POLICY.maxHeavyRowsDefault));
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const shouldLimit = rows.length > maxRows
                || rows.length >= HYBRID_MEMORY_ENGINE_POLICY.minRowsBeforeLimit
                || (rows.length >= 4 && totalTextCost > HYBRID_MEMORY_ENGINE_POLICY.heavyTextCostLimit);
            if (!shouldLimit) {
                return {
                    entries: sourceEntries,
                    rows,
                    rowByKey,
                    debug: {
                        enabled: true,
                        version: HYBRID_MEMORY_ENGINE_POLICY.version,
                        readPathOnly: true,
                        integration: 'kind_alignment_v2',
                        scopeIndex: scopeIndexDebug || null,
                        kindPlan,
                        limited: false,
                        reason: 'within_budget',
                        originalRows: rows.length,
                        selectedRows: rows.length,
                        maxRows,
                        totalTextCost,
                        bucketCounts,
                        selectedBucketCounts: bucketCounts
                    }
                };
            }
            const quotas = HYBRID_MEMORY_ENGINE_POLICY.quotas;
            const selectedRows = [];
            const seen = new Set();
            const addSelectedRow = (row = null) => {
                if (!row?.id || seen.has(row.id) || selectedRows.length >= maxRows) return false;
                seen.add(row.id);
                selectedRows.push(row);
                return true;
            };
            if (strictOriginQuery) {
                rows
                    .slice()
                    .map(row => ({ row, originCueProfile: getOriginSceneCueProfile(row.text || '', row.payload || {}) }))
                    .filter(({ row, originCueProfile }) => Number(originCueProfile.strongCount || 0) > 0 || row.baseBucket === 'origin' || row.arcRole === 'origin' || row.causalRole === 'cause')
                    .sort((a, b) => {
                        const strongCueDiff = Number(b.originCueProfile?.strongCount || 0) - Number(a.originCueProfile?.strongCount || 0);
                        if (strongCueDiff) return strongCueDiff;
                        const turnDiff = Number(a.row?.turn || 0) - Number(b.row?.turn || 0);
                        if (turnDiff) return turnDiff;
                        return Number(b.row?.hybridLite?.score || 0) - Number(a.row?.hybridLite?.score || 0);
                    })
                    .slice(0, Math.min(3, maxRows))
                    .forEach(({ row }) => addSelectedRow(row));
            }
            const bucketOrder = uniqLimit([
                ...(strictOriginQuery ? ['origin', 'relationship', 'entity', 'exact'] : []),
                ...(kindPlan.preserveBuckets || []),
                'transition', 'aftermath', 'tag', 'entity', 'world', 'narrative', 'relationship', 'origin', 'current', 'recentImportant', 'memory'
            ], 24);
            bucketOrder.forEach(bucket => {
                addHybridRowsByBucket(selectedRows, seen, rows, bucket, quotas[bucket] || (bucket === 'tag' ? 8 : 6), maxRows);
            });
            rows
                .slice()
                .sort((a, b) => Number(b.hybridLite?.score || 0) - Number(a.hybridLite?.score || 0) || Number(b.turn || 0) - Number(a.turn || 0))
                .forEach(row => {
                    if (selectedRows.length >= maxRows) return;
                    if (!row.id || seen.has(row.id)) return;
                    seen.add(row.id);
                    selectedRows.push(row);
                });
            const selectedBucketCounts = {};
            selectedRows.forEach(row => (row.hybridLite?.buckets || ['memory']).forEach(bucket => { selectedBucketCounts[bucket] = (selectedBucketCounts[bucket] || 0) + 1; }));
            const selectedIds = new Set(selectedRows.map(row => row.id));
            return {
                entries: sourceEntries.filter(entry => selectedIds.has(getSafeKey(entry))),
                rows,
                rowByKey,
                debug: {
                    enabled: true,
                    version: HYBRID_MEMORY_ENGINE_POLICY.version,
                    readPathOnly: true,
                    integration: 'kind_alignment_v2',
                    scopeIndex: scopeIndexDebug || null,
                    kindPlan,
                    limited: true,
                    reason: rows.length > maxRows ? 'row_cap' : 'text_cost',
                    originalRows: rows.length,
                    selectedRows: selectedRows.length,
                    maxRows,
                    totalTextCost,
                    bucketCounts,
                    selectedBucketCounts,
                    topRows: selectedRows.slice(0, 8).map(row => ({
                        id: row.id,
                        kind: row.primaryKind,
                        kinds: row.kinds,
                        buckets: row.hybridLite?.buckets || [],
                        score: Number((row.hybridLite?.score || 0).toFixed(3)),
                        turn: row.turn || 0,
                        reasons: row.hybridLite?.reasons || [],
                        preview: String(row.text || '').replace(/\s+/g, ' ').slice(0, 100)
                    }))
                }
            };
        };

        const normalizeLoreKeywords = (raw) => {
            if (Array.isArray(raw)) return raw.map(v => String(v || '').trim()).filter(Boolean);
            return String(raw || '')
                .split(/[\n,|]/g)
                .map(v => v.trim())
                .filter(Boolean);
        };

        const isStandardLoreActive = (entry, text) => {
            if (!entry) return false;
            if (entry.alwaysActive) return true;

            const primary = normalizeLoreKeywords(entry.key);
            const secondary = normalizeLoreKeywords(entry.secondkey);
            const keywords = [...new Set([...primary, ...secondary])];
            if (keywords.length === 0) return true;

            const haystack = String(text || '').toLowerCase();
            const matches = (keyword) => haystack.includes(String(keyword || '').toLowerCase());
            const mode = String(entry.mode || '').toLowerCase();

            if (mode.includes('and')) return keywords.every(matches);
            if (mode.includes('not')) return keywords.every(keyword => !matches(keyword));
            return keywords.some(matches);
        };

        const prefilterStandardLore = (query, entries, limit = 24) => {
            const queryTokens = new Set(TokenizerEngine.tokenize(query || ''));
            const tokenCache = getStandardLoreTokenCache();
            const scored = (Array.isArray(entries) ? entries : []).map((entry) => {
                const cacheKey = getLoreSignature(entry);
                let tokenized = tokenCache.peek(cacheKey);
                if (!tokenized) {
                    const keys = normalizeLoreKeywords(entry.key).concat(normalizeLoreKeywords(entry.secondkey));
                    tokenized = {
                        keyTokens: new Set(keys.flatMap(token => TokenizerEngine.tokenize(token))),
                        contentTokens: new Set(TokenizerEngine.tokenize(entry.content || ''))
                    };
                    tokenCache.set(cacheKey, tokenized);
                }
                const keyTokens = tokenized.keyTokens;
                const contentTokens = tokenized.contentTokens;
                let keyOverlap = 0;
                let contentOverlap = 0;
                queryTokens.forEach((token) => {
                    if (keyTokens.has(token)) keyOverlap++;
                    if (contentTokens.has(token)) contentOverlap++;
                });
                const score = (keyOverlap * 4) + contentOverlap + (entry.alwaysActive ? 0.25 : 0);
                return { entry, score };
            });

            return scored
                .sort((a, b) => b.score - a.score)
                .slice(0, Math.max(3, limit))
                .map(item => item.entry);
        };

        const isLibraManagedEntry = (entry) => Boolean(entry?.comment && String(entry.comment).startsWith('lmai_'));

        const getLoreSignature = (entry) => {
            const comment = String(entry?.comment || '').trim();
            const key = String(entry?.key || '').trim();
            if (comment === 'lmai_memory') {
                const memoryKey = String(getSafeKey(entry) || '').trim();
                if (memoryKey) return `${comment}::${memoryKey}`;
            }
            if (comment.startsWith('lmai_') && key) return `${comment}::${key}`;
            return [comment, key, getEntryContentHash(entry)].join('::');
        };
        const getLoreOverrideKey = (entry) => {
            const comment = String(entry?.comment || '').trim();
            const key = String(entry?.key || '').trim();
            if (!comment && !key) return null;
            return `${comment}::${key}`;
        };
        const getLoreSourceArray = (value) => {
            if (Array.isArray(value)) return LibraLoreConsolidator.unpack(value);
            if (!value || typeof value !== 'object') return [];
            if (Array.isArray(value.entries)) return LibraLoreConsolidator.unpack(value.entries);
            if (Array.isArray(value.lorebook)) return LibraLoreConsolidator.unpack(value.lorebook);
            if (Array.isArray(value.lore)) return LibraLoreConsolidator.unpack(value.lore);
            if (Array.isArray(value.globalLore)) return LibraLoreConsolidator.unpack(value.globalLore);
            if (Array.isArray(value.data)) return LibraLoreConsolidator.unpack(value.data);
            return [];
        };
        const dedupeLoreEntries = (entries = []) => {
            const seen = new Set();
            const out = [];
            for (const entry of Array.isArray(entries) ? entries : []) {
                if (!entry || typeof entry !== 'object') continue;
                const signature = getLoreSignature(entry);
                if (seen.has(signature)) continue;
                seen.add(signature);
                out.push(entry);
            }
            return out;
        };
        const getCharacterLoreSources = (char = null) => dedupeLoreEntries([
            ...getLoreSourceArray(char?.lorebook),
            ...getLoreSourceArray(char?.lore),
            ...getLoreSourceArray(char?.characterLore),
            ...getLoreSourceArray(char?.rawCharacterLore),
            ...getLoreSourceArray(char?.globalLore),
            ...getLoreSourceArray(char?.data),
            ...getLoreSourceArray(char?.data?.lorebook),
            ...getLoreSourceArray(char?.data?.lore),
            ...getLoreSourceArray(char?.data?.globalLore),
            ...getLoreSourceArray(char?.card),
            ...getLoreSourceArray(char?.card?.data),
            ...getLoreSourceArray(char?.spec),
            ...getLoreSourceArray(char?.spec?.data)
        ]);
        const getChatLoreSources = (chat = null) => dedupeLoreEntries([
            ...getLoreSourceArray(chat?.localLore),
            ...getLoreSourceArray(chat?.lorebook),
            ...getLoreSourceArray(chat?.lore)
        ]);

        const getEffectiveLorebook = (char, chat) => {
            const manualRouted = typeof WmManualRuntime !== 'undefined' && WmManualRuntime?.isRouted();
            const globalLore = getCharacterLoreSources(char).filter(e => !manualRouted || !LibraDataStorage.isLibraEntry(e));
            // 스토리지 이전 후 LIBRA 데이터는 pluginStorage 섀도에 있고 로어에는 없다.
            // 섀도를 빼면 이 함수가 빈손이 되어 전환·요약·재분석이 빈 로어를 본다.
            const hostChatLore = getChatLoreSources(chat).filter(e => !manualRouted || !LibraDataStorage.isLibraEntry(e));
            const hostChatKeys = new Set(hostChatLore.map(entry => String(entry?.key || '')));
            let localLore = hostChatLore;
            try {
                const scopeKey = LibraDataStorage.getActiveScope?.() || '';
                if (scopeKey && LibraDataStorage.isHydrated(scopeKey)) {
                    const shadow = LibraDataStorage.getShadowEntries(scopeKey);
                    if (shadow.length > 0) {
                        const seen = new Set(localLore.map(e => String(e?.key || '')));
                        localLore = [...localLore, ...shadow.filter(e => !seen.has(String(e?.key || '')))];
                    }
                }
            } catch (_) {}
            // 전역 로어에도 같은 규칙을 적용한다 (globalLore 스코프 저장분).
            let globalWithShadow = globalLore;
            try {
                const scopeKey = LibraDataStorage.getActiveScope?.() || '';
                if (scopeKey && LibraDataStorage.isHydrated(scopeKey)) {
                    const shadow = LibraDataStorage.getShadowEntries(scopeKey)
                        .filter(e => !hostChatKeys.has(String(e?.key || '')));
                    if (shadow.length > 0) {
                        const seen = new Set(globalLore.map(e => String(e?.key || '')));
                        globalWithShadow = [...globalLore, ...shadow.filter(e => !seen.has(String(e?.key || '')))];
                    }
                }
            } catch (_) {}
            const globalLoreMerged = globalWithShadow;
            if (localLore.length === 0) return globalLoreMerged;
            if (globalLoreMerged.length === 0) return localLore;

            const merged = [];
            const seen = new Set();
            const localOverrideKeys = new Set(
                localLore
                    .map(getLoreOverrideKey)
                    .filter(Boolean)
            );
            const mark = (entry) => {
                const key = getLoreSignature(entry);
                if (seen.has(key)) return;
                seen.add(key);
                merged.push(entry);
            };

            globalLoreMerged
                .filter(entry => {
                    const overrideKey = getLoreOverrideKey(entry);
                    return !overrideKey || !localOverrideKeys.has(overrideKey);
                })
                .forEach(mark);
            localLore.forEach(mark);
            return merged;
        };

        const normalizeLoreStorage = async (char, chat, ownedPreparation = null) => {
            if (typeof WmManualRuntime !== 'undefined' && WmManualRuntime?.isRouted()) return false;
            if (VersionedCanonicalBridge.mode === "authority") throw new Error("authority_mixed_scope_unsupported");
            const checkOwned = () => {
                if (ownedPreparation && (typeof ownedPreparation.isCurrent !== 'function'
                    || typeof ownedPreparation.refresh !== 'function' || typeof ownedPreparation.cooperative !== 'boolean'
                    || ownedPreparation.isCurrent() !== true)) throw new Error('normalization_source_invalidated');
            };
            checkOwned();
            const globalLore = Array.isArray(char?.globalLore)
                ? char.globalLore
                : (Array.isArray(char?.lorebook) ? char.lorebook : []);
            if (!chat) return false;
            const localLore = Array.isArray(chat?.localLore) ? chat.localLore : [];

            // Global migration owns only rows physically present in the host's
            // global lore, never the active chat/persona shadow fallback.
            const unpackedGlobalLore = LibraLoreConsolidator.unpackRawFromLore(globalLore);
            const unpackedLocalLore = LibraLoreConsolidator.unpack(localLore);
            const localNeedsContainerPacking = localLore.some(entry => {
                const comment = String(entry?.comment || '').trim();
                return !LibraLoreConsolidator.isContainer(entry) && (comment === 'lmai_memory' || comment === 'lmai_entity' || comment === 'lmai_relation');
            });
            let localMemoryCompacted = false;
            const migrate = (entry, local) => {
                const migrated = CompactMemoryCodec.migrateEntry(entry);
                if (local && migrated?.changed) localMemoryCompacted = true;
                return migrated?.entry || entry;
            };
            let compactedLocalLore, compactedGlobalLore;
            if (ownedPreparation?.cooperative === true) {
                const controller = ResourceGovernor.createYieldController('lore_normalization');
                const prepare = async (rows, local) => {
                    const out = [];
                    for (const entry of rows) {
                        checkOwned();
                        out.push(migrate(entry, local));
                        checkOwned();
                        await ResourceGovernor.yieldIfNeeded(controller, 1);
                        checkOwned();
                    }
                    return out;
                };
                compactedLocalLore = await prepare(unpackedLocalLore, true);
                checkOwned();
                compactedGlobalLore = await prepare(unpackedGlobalLore, false);
                checkOwned();
            } else {
                compactedLocalLore = unpackedLocalLore.map(entry => migrate(entry, true));
                compactedGlobalLore = unpackedGlobalLore.map(entry => migrate(entry, false));
            }
            if (ownedPreparation && await ownedPreparation.refresh() !== true) throw new Error('normalization_source_invalidated');
            checkOwned();
            let characterLoreCueIndexChanged = false;
            try {
                const withoutCharacterLoreCueIndex = compactedLocalLore.filter(entry => String(entry?.comment || '') !== CharacterLoreCueIndex.COMMENT);
                const existingCueEntry = compactedLocalLore.find(entry => String(entry?.comment || '') === CharacterLoreCueIndex.COMMENT);
                const hasManagedRuntimeLore = withoutCharacterLoreCueIndex.some(entry => isLibraManagedEntry(entry))
                    || compactedGlobalLore.some(entry => isLibraManagedEntry(entry));
                if (!hasManagedRuntimeLore) {
                    if (existingCueEntry) {
                        compactedLocalLore = withoutCharacterLoreCueIndex;
                        characterLoreCueIndexChanged = true;
                    }
                } else {
                    const builtCueIndex = CharacterLoreCueIndex.buildLoreEntry(char, { ...chat, localLore: withoutCharacterLoreCueIndex });
                    if (builtCueIndex?.entry) {
                        const existingPayload = CharacterLoreCueIndex.parsePayload(existingCueEntry);
                        characterLoreCueIndexChanged = !existingCueEntry || existingPayload?.sourceHash !== builtCueIndex.payload?.sourceHash || String(existingCueEntry?.content || '') !== String(builtCueIndex.entry.content || '');
                        compactedLocalLore = characterLoreCueIndexChanged ? [...withoutCharacterLoreCueIndex, builtCueIndex.entry] : compactedLocalLore;
                    } else if (existingCueEntry) {
                        compactedLocalLore = withoutCharacterLoreCueIndex;
                        characterLoreCueIndexChanged = true;
                    }
                }
            } catch (error) {
                if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA] Character lore cue index normalize failed:', error?.message || error);
            }

            checkOwned();
            const globalLibra = compactedGlobalLore.filter(isLibraManagedEntry);
            if (globalLibra.length === 0 && !localNeedsContainerPacking && !localMemoryCompacted && !characterLoreCueIndexChanged) return false;

            const localSeen = new Set(compactedLocalLore.map(getLoreSignature));
            const migrated = [];
            for (const entry of globalLibra) {
                const signature = getLoreSignature(entry);
                if (localSeen.has(signature)) continue;
                localSeen.add(signature);
                migrated.push(entry);
            }

            checkOwned();
            char.globalLore = compactedGlobalLore.filter(entry => !isLibraManagedEntry(entry));
            chat.localLore = migrated.length > 0 ? [...compactedLocalLore, ...migrated] : [...compactedLocalLore];
            return migrated.length > 0 || globalLibra.length > 0 || localNeedsContainerPacking || localMemoryCompacted || characterLoreCueIndexChanged;
        };

        const getEmbeddingWithSnapshot = (text, provider, options) => StrictRecallEmbeddingTransport.request(text, provider, options);
        const EmbeddingEngine = (() => {
            const debugStats = {
                totalCalls: 0,
                cacheHits: 0,
                providerCalls: 0,
                fingerprintInvalidations: 0,
                legacyCacheHits: 0,
                lastProvider: '',
                lastModel: '',
                lastDims: 0,
                lastStatus: 'idle',
                lastFingerprint: '',
                lastInvalidationReason: '',
                sources: {}
            };
            return {
                getEmbedding: async (text, options = {}) => {
                    const source = normalizeEmbeddingDebugSource(options?.source || options?.label || 'general');
                    debugStats.totalCalls += 1;
                    bumpEmbeddingDebugSource(debugStats, source, 'total');
                    const snapshot = captureEmbeddingConfiguration();
                    const mForCache = snapshot.embed;
                    const providerForCache = mForCache.provider;
                    const modelForCache = mForCache.model;
                    if (!mForCache.enabled || options?.signal?.aborted || !isLibraRuntimeEpochActive()) return null;
                    if (!modelForCache || (!providerAllowsEmptyKey(providerForCache) && !mForCache.key.trim())
                        || (providerRequiresUrl(providerForCache) && !mForCache.url.trim())) {
                        try { ActivityDashboardCore?.recordSkippedCall?.('embedding', 'not_configured'); } catch (_) {}
                        return null;
                    }
                    const cacheable = shouldCacheEmbeddingText(text);
                    const cacheKey = cacheable ? getEmbeddingCacheKey(snapshot, text) : '';
                    const cache = getEmbeddingCache();
                    const cacheGeneration = embeddingCacheStates.get(cache)?.generation;
                    const isCurrent = () => !options?.signal?.aborted && isLibraRuntimeEpochActive()
                        && captureEmbeddingConfiguration().generation === snapshot.generation
                        && getEmbeddingCache() === cache
                        && embeddingCacheStates.get(cache)?.generation === cacheGeneration;
                    if (cacheKey && cache.has(cacheKey)) {
                        const cachedRecord = cache.get(cacheKey);
                        const cached = readEmbeddingCacheRecord(cachedRecord, snapshot, text);
                        if (!cached.ok) {
                            cache.delete(cacheKey);
                            debugStats.fingerprintInvalidations += 1;
                            debugStats.lastInvalidationReason = cached.reason || 'fingerprint_mismatch';
                            debugStats.lastStatus = 'cache-invalidated';
                            bumpEmbeddingDebugSource(debugStats, source, 'invalidated');
                            if (CONFIG.debug) {
                                recordRuntimeDebug('warn', '[LIBRA][EMBED] cache invalidated:', {
                                    source,
                                    provider: providerForCache,
                                    model: modelForCache,
                                    reason: cached.reason || 'fingerprint_mismatch'
                                });
                            }
                        } else {
                            const cachedVec = cached.vector;
                            if (cached.legacy) debugStats.legacyCacheHits += 1;
                            debugStats.cacheHits += 1;
                            debugStats.lastProvider = providerForCache;
                            debugStats.lastModel = modelForCache;
                            debugStats.lastDims = cached.dim || (Array.isArray(cachedVec) ? cachedVec.length : 0);
                            debugStats.lastFingerprint = getRuntimeEmbeddingFingerprintMeta(snapshot, cachedVec).key;
                            debugStats.lastStatus = cached.legacy ? 'cache-hit-legacy' : 'cache-hit';
                            bumpEmbeddingDebugSource(debugStats, source, 'cacheHits');
                            try {
                                ActivityDashboardCore?.recordEmbedding?.({
                                    label: 'Embedding cache',
                                    cacheHit: true,
                                    foreground: false
                                });
                            } catch (_) {}
                            if (CONFIG.debug) {
                                recordRuntimeDebug('log', `[LIBRA][EMBED] cache-hit | source=${source} | provider=${providerForCache} | model=${modelForCache} | dims=${debugStats.lastDims} | legacy=${cached.legacy === true} | chars=${String(text || '').length}`);
                            }
                            return Promise.resolve(cachedVec);
                        }
                    }
                    return EmbeddingQueue.enqueue(async () => {
                        if (!isCurrent()) { debugStats.lastStatus = 'stale'; return null; }
                        const m = snapshot.embed;
                        const providerName = m.provider;

                        try {
                            const provider = AutoProvider.get(providerName);
                            debugStats.providerCalls += 1;
                            bumpEmbeddingDebugSource(debugStats, source, 'providerCalls');
                            debugStats.lastProvider = providerName;
                            debugStats.lastModel = m.model || '';
                            debugStats.lastStatus = 'start';
                            try {
                                ActivityDashboardCore?.updateFeatureAnalysis?.({
                                    domain: 'embedding',
                                    reason: providerName,
                                    status: 'running',
                                    detail: m.model || '',
                                    source: 'embedding'
                                });
                            } catch (_) {}
                            const startAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                            if (CONFIG.debug) {
                                recordRuntimeDebug('log', 
                                    `[LIBRA][EMBED] start | source=${source} | provider=${providerName} | model=${m.model || ''} | endpointGeneration=${snapshot.endpointGeneration} | chars=${String(text || '').length} | queuePending=${EmbeddingQueue.pendingCount || 0}`
                                );
                            }
                            const vec = await provider.getEmbedding(snapshot, text);
                            if (!isCurrent()) {
                                debugStats.lastStatus = 'stale';
                                debugStats.lastFingerprint = '';
                                return null;
                            }
                            if (snapshot.expectedDimension && (!Array.isArray(vec) || vec.length !== snapshot.expectedDimension)) {
                                debugStats.lastStatus = 'dimension-mismatch';
                                debugStats.lastFingerprint = '';
                                return null;
                            }
                            if (Array.isArray(vec) && cacheKey) cache.set(cacheKey, buildEmbeddingCacheRecord(vec, snapshot, text));
                            debugStats.lastDims = Array.isArray(vec) ? vec.length : 0;
                            debugStats.lastFingerprint = Array.isArray(vec) ? getRuntimeEmbeddingFingerprintMeta(snapshot, vec).key : '';
                            debugStats.lastStatus = vec ? 'success' : 'empty';
                            if (!vec) bumpEmbeddingDebugSource(debugStats, source, 'empty');
                            try {
                                ActivityDashboardCore?.recordEmbedding?.({
                                    label: vec ? `Embedding ${providerName}` : `Embedding empty ${providerName}`,
                                    provider: providerName,
                                    failed: !vec
                                });
                            } catch (_) {}
                            if (CONFIG.debug) {
                                const endAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                                recordRuntimeDebug('log', 
                                    `[LIBRA][EMBED] ${vec ? 'success' : 'empty'} | source=${source} | provider=${providerName} | duration=${Math.max(0, Math.round(endAt - startAt))}ms | dims=${Array.isArray(vec) ? vec.length : 0}`
                                );
                            }
                            return vec;
                        } catch (e) {
                            debugStats.lastStatus = 'error';
                            bumpEmbeddingDebugSource(debugStats, source, 'error');
                            try {
                                ActivityDashboardCore?.recordEmbedding?.({
                                    label: 'Embedding failed',
                                    provider: providerName,
                                    failed: true
                                });
                            } catch (_) {}
                            if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA] Embedding Error:', e?.message || e);
                            return null;
                        }
                    });
                },
                // Called only after the owned startup/GUI settings publication boundaries.
                // Observing here retires pending work even if a later publication restores old values.
                noteConfigurationPublished: () => { captureEmbeddingConfiguration(); captureSimilarityConfiguration(); },
                getDebugSnapshot: () => ({
                    ...debugStats,
                    sources: Object.fromEntries(Object.entries(debugStats.sources || {}).map(([key, value]) => [key, { ...value }]))
                }),
                getFingerprint: (vector = null, config = CONFIG) => getEmbeddingFingerprint(config, vector),
                getFingerprintMeta: (vector = null, config = CONFIG) => safeClone(getEmbeddingFingerprintMeta(config, vector)),
                cosineSimilarity: (a, b) => {
                    if (!a || !b || a.length !== b.length) return 0;
                    let dot = 0, normA = 0, normB = 0;
                    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
                    return (normA && normB) ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
                }
            };
        })();
