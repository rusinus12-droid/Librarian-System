        // LIBRA World Manager Hybrid Memory Engine skeleton (read-path only).
        // The write path remains unchanged: existing memory/entity/world/narrative generation still
        // creates the source lorebook rows.  This adapter normalizes existing lmai_memory rows into
        // typed read rows, then uses bucket-preserving V2-lite scoring before expensive Jaccard work.
        const HYBRID_MEMORY_ENGINE_POLICY = Object.freeze({
            version: 'libra_world_hybrid_rollback_rows_v1_20260617',
            maxHeavyRowsDefault: 12,
            maxHeavyRowsHardCap: 8,
            heavyTextCostLimit: 60000,
            minRowsBeforeLimit: 8,
            quotas: Object.freeze({
                exact: 14,
                entity: 12,
                world: 10,
                narrative: 12,
                relationship: 10,
                origin: 10,
                current: 8,
                recentImportant: 10,
                memory: 12,
                fallback: 8
            })
        });
        const asHybridArray = (value) => Array.isArray(value)
            ? value.map(v => typeof v === 'string' ? v : (v?.name || v?.id || v?.label || v?.ref || '')).map(v => String(v || '').trim()).filter(Boolean)
            : String(value || '').split(/[\n,|;/]+/g).map(v => v.trim()).filter(Boolean);
        const normalizeHybridToken = (value = '') => normalizeSemanticText(String(value || '')).replace(/\s+/g, ' ').trim();
        // NOTE: 이 함수와 아래 rollbackState/rollbackTombstone 행 필드는 이름과 달리
        // **스냅샷 롤백 기능과 무관하게 살아 있다.** provenanceStatus(retracted/superseded)가
        // 관계·엔티티 계층에서 설정되고, 이 행 스키마를 10c/10d 가 읽어 회상에서 제외한다.
        // 스냅샷 롤백 삭제 시 이 필드까지 지우면 retraction 파이프라인이 깨진다.
        const normalizeHybridRollbackState = (value = '') => {
            const v = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (!v) return 'active';
            if (['candidate_deleted','deleted_candidate','tombstone','tombstoned','deleted','inactive'].includes(v)) return 'candidate_deleted';
            if (['restored','active'].includes(v)) return v === 'active' ? 'active' : 'restored';
            if (['superseded','stale'].includes(v)) return v;
            return v;
        };
        const getHybridTextSignature = (entry = null) => [entry?.comment || '', entry?.key || '', getEntryContentHash(entry)].join('::');
        const classifyHybridKinds = (payload = {}, meta = {}, text = '', currentTurn = 0) => {
            const ledger = getLedgerProjectionParts(payload);
            const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
            const raw = `${getHybridPayloadProjectionText(payload, meta, text)}\n${JSON.stringify(payload || {})}\n${JSON.stringify(meta || {})}`;
            const kinds = new Set(['memory']);
            const worldSignalProfile = getHybridWorldSignalProfile(payload, meta, text);
            const retrospectiveClass = CompactMemoryCodec.normalizeRetrospectiveClass(
                payload?.retrospectiveClass || payload?.hybridRow?.retrospectiveClass || meta?.hme?.retrospectiveClass || CompactMemoryCodec.detectRetrospectiveClass(text, payload?.summary)
            );
            const entityRefs = getHybridPayloadEntityRefs(payload, meta);
            if (entityRefs.length > 0) kinds.add('entity');
            if (worldSignalProfile.dedicatedRow) kinds.add('world');
            if (/(기원|복선|미해결|내러티브|narrative|foreshadow|unresolved|arc)/i.test(raw)
                || payload?.arcRole || payload?.causalRole || (!isLedger && payload?.primaryConflict) || ledger.narrative.length > 0) kinds.add('narrative');
            if (retrospectiveClass) kinds.add('retrospective');
            if (/(relationship|romance)/i.test(raw) || (!isLedger && payload?.relationDelta) || ledger.relation.length > 0) kinds.add('relationship');
            let bucket = classifyRecallBucket(payload, { worldRule: true, relationship: true }, meta, currentTurn);
            const worldDedicated = worldSignalProfile.dedicatedRow === true;
            if (retrospectiveClass && bucket !== 'world') bucket = 'retrospective';
            let primaryKind = 'memory';
            if (bucket === 'origin' || bucket === 'transition' || bucket === 'aftermath' || kinds.has('narrative')) primaryKind = 'narrative';
            else if (kinds.has('relationship')) primaryKind = 'relationship';
            else if (kinds.has('entity')) primaryKind = 'entity';
            else if (bucket === 'world' || worldDedicated) primaryKind = 'world';
            if (retrospectiveClass && !worldDedicated) primaryKind = 'narrative';
            return { kinds: Array.from(kinds), primaryKind, bucket, worldDedicated, retrospectiveClass };
        };
        const buildHybridMemoryRow = (entry = null, index = 0, currentTurn = 0) => {
            if (!entry || String(entry?.comment || '') !== 'lmai_memory') return null;
            const signature = getHybridTextSignature(entry);
            const cache = getHybridRowCache();
            const cached = cache.get(signature);
            if (cached) return { ...cached, entry, index };
            const meta = getCachedMeta(entry) || {};
            const payload = getRecallPayload(entry) || CompactMemoryCodec.parsePayloadFromEntry(entry) || {};
            const persistentHybrid = (payload && typeof payload.hybridRow === 'object') ? payload.hybridRow : ((meta && typeof meta.hme === 'object') ? meta.hme : ((payload && typeof payload.hme === 'object') ? payload.hme : {}));
            const provenanceStatus = String(meta?.provenanceStatus || payload?.provenanceStatus || '').trim().toLowerCase();
            const provenanceRollbackState = provenanceStatus === 'retracted'
                ? 'candidate_deleted'
                : (provenanceStatus === 'superseded' ? 'superseded' : '');
            // 스냅샷 롤백 기능이 삭제되어 저널 기반 툼스톤 폴백은 없다.
            // provenanceStatus(retracted/superseded) 는 관계·엔티티 계층이 설정하므로 유지한다.
            const rollbackState = normalizeHybridRollbackState(provenanceRollbackState || persistentHybrid?.rollbackState || meta?.hme?.rollbackState || meta?.rollbackState || 'active');
            const rollbackTombstoned = provenanceStatus === 'retracted';
            const text = CompactMemoryCodec.buildSearchTextFromEntry(entry);
            if (!text || Utils.shouldExcludeStoredMemoryContent(text)) return null;
            const worldSignalProfile = getHybridWorldSignalProfile(payload, meta, text);
            const retrospectiveClass = CompactMemoryCodec.normalizeRetrospectiveClass(
                persistentHybrid?.retrospectiveClass || payload?.retrospectiveClass || meta?.hme?.retrospectiveClass || CompactMemoryCodec.detectRetrospectiveClass(text, payload?.summary)
            );
            const recallProfile = String(persistentHybrid?.recallProfile || payload?.recallProfile || (retrospectiveClass ? 'continuity_only' : '')).trim();
            const ledgerProjection = getLedgerProjectionParts(payload);
            const entityRefs = getHybridPayloadEntityRefs(payload, meta, persistentHybrid);
            const tags = getHybridPayloadTagSeeds(payload, meta, persistentHybrid, retrospectiveClass);
            const persistentSceneTags = retrospectiveClass ? [] : asHybridArray(persistentHybrid?.sceneTags);
            const sceneTags = uniqLimit([...persistentSceneTags], 12);
            const emotionTags = uniqLimit([
                ...asHybridArray(persistentHybrid?.emotionTags)
            ], 12);
            const relationTags = uniqLimit([
                ...asHybridArray(persistentHybrid?.relationTags),
                ...( ledgerProjection.relation.length ? ['관계 신호'] : [] )
            ], 12);
            const worldTags = uniqLimit([
                ...asHybridArray(persistentHybrid?.worldTags),
                ...( worldSignalProfile.strongDefinition ? ['세계 규칙'] : [] ),
                ...( ledgerProjection.world.length ? ['세계 변화'] : [] )
            ], 12);
            const persistentNarrativeTags = asHybridArray(persistentHybrid?.narrativeTags).filter(tag => {
                if (!retrospectiveClass) return true;
                const normalized = String(tag || '').trim().toLowerCase();
                return !['origin', 'transition', 'aftermath'].includes(normalized);
            });
            const narrativeTags = uniqLimit([
                ...persistentNarrativeTags,
                ...( retrospectiveClass
                    ? ['retrospective', retrospectiveClass === 'family_postscript' ? 'family-postscript' : 'global-recap']
                    : [
                        ...( ledgerProjection.narrative.length ? ['open-thread'] : [] )
                    ])
            ], 12);
            const kindInfo = classifyHybridKinds(payload, meta, text, currentTurn);
            const persistentKinds = uniqLimit([...asHybridArray(persistentHybrid?.kinds), ...asHybridArray(persistentHybrid?.kind), ...asHybridArray(persistentHybrid?.primaryKind)], 8);
            const persistentPrimaryKind = String(persistentHybrid?.primaryKind || persistentHybrid?.kind || '').trim();
            const worldDedicated = Boolean(persistentHybrid?.worldDedicated || kindInfo.worldDedicated || worldSignalProfile.dedicatedRow);
            const mergedKinds = uniqLimit([...persistentKinds, ...(kindInfo.kinds || [])], 10).filter(kind => kind !== 'world' || worldDedicated);
            const resolvedPrimaryKind = retrospectiveClass && !worldDedicated
                ? 'narrative'
                : (persistentPrimaryKind === 'world' && !worldDedicated
                    ? kindInfo.primaryKind
                    : (persistentPrimaryKind || kindInfo.primaryKind));
            const persistentBaseBucket = String(persistentHybrid?.baseBucket || '').trim();
            const resolvedBaseBucket = retrospectiveClass
                ? 'retrospective'
                : (persistentBaseBucket === 'world' && !worldDedicated
                    ? String(kindInfo.bucket || '').trim()
                    : (persistentBaseBucket || String(kindInfo.bucket || '').trim()));
            const turn = Number(meta?.t || payload?.turn || persistentHybrid?.turn || 0);
            const row = {
                id: getSafeKey(entry) || signature,
                signature,
                entry,
                index,
                meta,
                payload,
                text,
                contentChars: String(text || '').length,
                turn,
                importance: Math.max(0, Math.min(1, Number(meta?.imp || payload?.importance || 5) / 10)),
                subjects: entityRefs,
                aliases: entityRefs,
                tags,
                sceneTags,
                emotionTags,
                relationTags,
                worldTags,
                narrativeTags,
                arcKey: String(persistentHybrid?.arcKey || payload?.arcKey || '').trim(),
                arcRole: String(persistentHybrid?.arcRole || payload?.arcRole || '').trim(),
                causalRole: String(persistentHybrid?.causalRole || payload?.causalRole || '').trim(),
                primaryKind: resolvedPrimaryKind,
                kinds: mergedKinds.length ? mergedKinds : kindInfo.kinds,
                baseBucket: resolvedBaseBucket,
                retrospectiveClass,
                recallProfile,
                worldDedicated,
                sourceTurnIds: uniqLimit([...asHybridArray(persistentHybrid?.sourceTurnIds).map(v => Number(v)).filter(v => Number.isFinite(v)), Number(meta?.t || payload?.turn || 0)].filter(Boolean), 16),
                rollbackState,
                rollbackTombstone: rollbackTombstoned,
                rollbackTombstoneInfo: persistentHybrid?.rollbackTombstone || meta?.hme?.rollbackTombstone || null,
                hiddenFromPrompt: Boolean(persistentHybrid?.hiddenFromPrompt || meta?.hme?.hiddenFromPrompt || meta?.hiddenFromPrompt),
                stale: Boolean(persistentHybrid?.stale || meta?.hme?.stale || meta?.stale),
                supersededBy: String(persistentHybrid?.supersededBy || '').trim(),
                staleCandidateIds: asHybridArray(persistentHybrid?.staleCandidateIds || persistentHybrid?.supersedesCandidateIds).slice(0, 8),
                persistedHybrid: Boolean(persistentHybrid?.schema || persistentHybrid?.engineVersion || persistentHybrid?.kind)
            };
            const cachedRow = { ...row, entry: null, index: 0 };
            cache.set(signature, cachedRow);
            return row;
        };

        const HME_SCOPE_INDEX_COMMENT = 'lmai_hme_index';
        const HME_SCOPE_INDEX_SCHEMA = 'libra.hme.scope_index.v1';
        // 2: Unicode terms; older derived rows must be rebuilt from canonical memories.
        const HME_SCOPE_INDEX_VERSION = 2;
        const staleHybridScopeIndexScopes = new Set();
        const HME_SCOPE_INDEX_MAX_TERMS = 24;
        const HME_SCOPE_INDEX_PRESELECT_HARD_CAP = 64;
        const HME_SCOPE_INDEX_INVERTED_BUCKET_LIMIT = 64;

        const getHybridScopeKey = (scopeKey = '') => String(scopeKey || MemoryState?._activeScopeKey || MemoryState?._activeChatId || 'global').trim() || 'global';
        const getHybridScopeHash = (scopeKey = '') => stableHash(getHybridScopeKey(scopeKey));
        // normalizeHmeIndexTerm is a pure wrapper over the memoized normalizeRecallAnchor
        // (whose output already has collapsed whitespace and trimmed edges, so the extra
        // .replace/.trim are no-ops).  Called once per (row x term x query) it dominated
        // HME work, so memoize the wrapper too.
        const HME_INDEX_TERM_MEMO_MAX = 20000;
        const hmeIndexTermMemo = new Map();
        const hmeIndexTermMemoStats = { hits: 0, misses: 0, maxEntries: HME_INDEX_TERM_MEMO_MAX };
        const normalizeHmeIndexTerm = (value = '') => {
            const key = String(value ?? '');
            const cached = hmeIndexTermMemo.get(key);
            if (cached !== undefined) {
                hmeIndexTermMemoStats.hits += 1;
                return cached;
            }
            hmeIndexTermMemoStats.misses += 1;
            const normalized = normalizeRecallAnchor(key).replace(/\s+/g, ' ').trim();
            if (hmeIndexTermMemo.size >= HME_INDEX_TERM_MEMO_MAX) {
                hmeIndexTermMemo.clear();
                hmeIndexTermMemoStats.clears = (hmeIndexTermMemoStats.clears || 0) + 1;
            }
            hmeIndexTermMemo.set(key, normalized);
            return normalized;
        };
        const expandHmeIndexTerms = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return [];
            return uniqLimit([
                normalizeHmeIndexTerm(raw),
                ...TokenizerEngine.tokenize(raw).map(normalizeHmeIndexTerm)
            ].filter(Boolean), 12);
        };
        const compactHmeIndexArray = (value = [], limit = 16) => uniqLimit(asHybridArray(value).map(v => String(v || '').trim()).filter(Boolean), limit);
        const hmeIndexRows = (index = null) => Array.isArray(index?.rows) ? index.rows : [];
        const hmeIndexEntryKey = (scopeKey = '') => `lmai_hme_index::${getHybridScopeHash(scopeKey)}`;

        // ─────────────────────────────────────────────────────────────
        // [HME] LIBRA-internal Associative Graph Adapter
        // Derived retrieval index only. No peer-plugin dependency, no canon,
        // no raw LiveChat storage, and no standalone memory authority.
        // ─────────────────────────────────────────────────────────────
