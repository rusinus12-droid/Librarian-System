        const buildHybridScopeIndexRow = (entry = null, index = 0, currentTurn = 0, options = {}) => withSynchronousEntityProjection(() => {
            if (!entry || String(entry?.comment || '') !== 'lmai_memory') return null;
            try {
                const contentHash = String(getEntryContentHash(entry));
                const meta = getCachedMeta(entry) || {};
                const payload = getRecallPayload(entry) || CompactMemoryCodec.parsePayloadFromEntry(entry) || {};
                const text = CompactMemoryCodec.buildSearchTextFromEntry(entry);
                if (!text || Utils.shouldExcludeStoredMemoryContent(text)) return null;
                const row = buildHybridMemoryRow(entry, index, currentTurn) || {};
                let recallHints = meta?.recallHints && typeof meta.recallHints === 'object' ? meta.recallHints : null;
                if (!recallHints) {
                    try { recallHints = StrengthenedJaccardCore.buildRecallHints(text, { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 }); }
                    catch (_) { recallHints = {}; }
                }
                const isLedger = CompactMemoryCodec.isLedgerPayload?.(payload);
                const ledgerProjection = getLedgerProjectionParts(payload);
                const subjects = normalizeHmeEntityNameList([
                    ...(row.subjects || []),
                    ...(row.aliases || []),
                    ...(isLedger ? ledgerProjection.entities : [
                        ...asHybridArray(payload?.mentionedEntityNames),
                        ...asHybridArray(meta?.ent),
                        ...asHybridArray(meta?.entities)
                    ])
                ], 32);
                const aliases = normalizeHmeEntityNameList([
                    ...(row.aliases || []),
                    ...(row.subjects || []),
                    ...subjects
                ], 32);
                const tags = compactHmeIndexArray([
                    ...(row.tags || []),
                    ...(isLedger ? ledgerProjection.tags : [
                        ...asHybridArray(payload?.tags),
                        payload?.arcKey,
                        payload?.arcRole,
                        payload?.causalRole
                    ]),
                    ...asHybridArray(meta?.tags)
                ], 24);
                const sceneTags = compactHmeIndexArray(row.sceneTags || [], 12);
                const emotionTags = compactHmeIndexArray(row.emotionTags || [], 12);
                const relationTags = compactHmeIndexArray(row.relationTags || [], 12);
                const worldTags = compactHmeIndexArray(row.worldTags || [], 12);
                const narrativeTags = compactHmeIndexArray(row.narrativeTags || [], 12);
                const graphSignals = buildHmeGraphRowSignals(payload, meta, {
                    ...row,
                    subjects,
                    aliases,
                    tags,
                    sceneTags,
                    emotionTags,
                    relationTags,
                    worldTags,
                    narrativeTags
                }, recallHints, ledgerProjection, options.canonicalSignals);
                const hintTokens = [
                    ...asHybridArray(recallHints?.tokens),
                    ...asHybridArray(recallHints?.names),
                    ...asHybridArray(recallHints?.numbers),
                    ...asHybridArray(recallHints?.quotes).flatMap(v => TokenizerEngine.tokenize(v).slice(0, 4))
                ];
                const indexTerms = uniqLimit([
                    ...TokenizerEngine.tokenize(text).slice(0, 32),
                    ...hintTokens,
                    ...subjects,
                    ...tags,
                    ...sceneTags,
                    ...emotionTags,
                    ...relationTags,
                    ...worldTags,
                    ...narrativeTags,
                    row.primaryKind,
                    row.baseBucket
                ].flatMap(expandHmeIndexTerms).filter(Boolean), HME_SCOPE_INDEX_MAX_TERMS);
                const turn = normalizeLegacyMemoryTurnAnchor(meta?.t || payload?.turn || row.turn || 0) || 0;
                const ttl = Number(meta?.ttl);
                const primaryKind = String(row.primaryKind || payload?.hybridRow?.primaryKind || meta?.hme?.kind || 'memory').trim() || 'memory';
                const kinds = compactHmeIndexArray([...(row.kinds || []), primaryKind], 10);
                const baseBucket = String(row.baseBucket || payload?.hybridRow?.baseBucket || '').trim();
                const worldDedicated = Boolean(row.worldDedicated);
                const topicKeys = uniqLimit([
                    ...asHybridArray(payload?.topics),
                    ...asHybridArray(payload?.topic),
                    ...asHybridArray(payload?.tags),
                    ...asHybridArray(payload?.keywords),
                    ...tags,
                    ...sceneTags,
                    ...emotionTags,
                    ...relationTags,
                    ...worldTags,
                    ...narrativeTags,
                    ...asHybridArray(graphSignals.recallKeywords),
                    ...asHybridArray(graphSignals.openThreads).flatMap(item => asHybridArray(item)),
                    ...TokenizerEngine.tokenize([
                        payload?.summary,
                        payload?.text,
                        payload?.value,
                        payload?.note,
                        graphSignals.summaryContinuity
                    ].filter(Boolean).join(' ')).slice(0, 18)
                ].flatMap(expandHmeIndexTerms).filter(Boolean), 48);
                const entityKeys = uniqLimit([
                    ...subjects,
                    ...aliases,
                    ...asHybridArray(meta?.ent),
                    ...asHybridArray(meta?.entities),
                    ...asHybridArray(payload?.entities),
                    ...asHybridArray(payload?.entityRefs),
                    ...asHybridArray(payload?.mentionedEntityNames),
                    ...asHybridArray(payload?.knownBy)
                ].flatMap(expandHmeIndexTerms).filter(Boolean), 48);
                const domainKeys = uniqLimit([
                    primaryKind,
                    baseBucket,
                    payload?.hybridRow?.primaryKind,
                    payload?.hybridRow?.kind,
                    payload?.hybridRow?.baseBucket,
                    meta?.hme?.primaryKind,
                    meta?.hme?.kind,
                    meta?.hme?.baseBucket,
                    ...(kinds || []),
                    ...(worldDedicated ? ['world'] : []),
                    ...(isLedger ? ['ledger'] : []),
                    String(meta?.cat || '').trim(),
                    String(payload?.category || '').trim(),
                    String(payload?.domain || '').trim(),
                    String(payload?.schema || '').split('.').slice(0, 3).join('.')
                ].flatMap(expandHmeIndexTerms).filter(Boolean), 24);
                const turnBucket = turn ? String(Math.floor(turn / 10) * 10) : '';
                const hotIndex = {
                    version: HME_SCOPE_INDEX_VERSION,
                    scopeHash: getHybridScopeHash(getHybridScopeKey()),
                    domainKeys,
                    entityKeys,
                    topicKeys,
                    turn,
                    turnBucket,
                    sourceHash: String(meta?.sourceHash || payload?.sourceHash || payload?.source?.sourceHash || '').trim()
                };
                return {
                    id: String(getSafeKey(entry) || row.id || contentHash).trim(),
                    contentHash,
                    idxKey: TokenizerEngine.getIndexKey(text),
                    turn,
                    ttl: Number.isFinite(ttl) ? ttl : 0,
                    entityAliasVersion: 2,
                    importance: Math.max(0, Math.min(1, Number(row.importance || meta?.imp / 10 || payload?.importance / 10 || 0.5))),
                    subjects,
                    aliases,
                    entityRoles: graphSignals.entityRoles,
                    tags,
                    sceneTags,
                    emotionTags,
                    relationTags,
                    worldTags,
                    narrativeTags,
                    primaryKind,
                    kinds,
                    baseBucket,
                    worldDedicated,
                    sourceTurnIds: uniqLimit([turn, ...(row.sourceTurnIds || [])].map(Number).filter(v => Number.isFinite(v) && v > 0), 16),
                    rollbackState: normalizeHybridRollbackState(row.rollbackState || meta?.hme?.rollbackState || meta?.rollbackState || 'active'),
                    rollbackTombstone: Boolean(row.rollbackTombstone || meta?.rollbackTombstone || meta?.rollbackDeleted),
                    hiddenFromPrompt: Boolean(row.hiddenFromPrompt || meta?.hme?.hiddenFromPrompt || meta?.hiddenFromPrompt),
                    stale: Boolean(row.stale || meta?.hme?.stale || meta?.stale),
                    arcKey: graphSignals.arcKey || String(row.arcKey || payload?.arcKey || '').trim(),
                    arcRole: graphSignals.arcRole || String(row.arcRole || payload?.arcRole || '').trim(),
                    causalRole: graphSignals.causalRole || String(row.causalRole || payload?.causalRole || '').trim(),
                    primaryConflict: graphSignals.primaryConflict,
                    relationDelta: graphSignals.relationDelta,
                    openThreads: graphSignals.openThreads,
                    relationSignals: graphSignals.relationSignals,
                    worldChanges: graphSignals.worldChanges,
                    worldSignature: graphSignals.worldSignature,
                    worldRuleHighlights: graphSignals.worldRuleHighlights,
                    objectContinuity: graphSignals.objectContinuity,
                    placeContinuity: graphSignals.placeContinuity,
                    recallKeywords: graphSignals.recallKeywords,
                    summaryContinuity: graphSignals.summaryContinuity,
                    hotIndexVersion: HME_SCOPE_INDEX_VERSION,
                    hotIndex,
                    domainKeys,
                    entityKeys,
                    topicKeys,
                    turnBucket,
                    indexTerms
                };
            } catch (error) {
                if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMEIndex] row build failed:', error?.message || error);
                return null;
            }
        });
        const isHybridScopeIndexRowGraphV2Ready = (row = null) => !!row
            && Number(row.entityAliasVersion || 0) >= 2
            && Number(row.hotIndexVersion || row.hotIndex?.version || 0) >= HME_SCOPE_INDEX_VERSION
            && row.entityRoles && typeof row.entityRoles === 'object'
            && Array.isArray(row.entities || row.subjects)
            && (
                Array.isArray(row.openThreads)
                || Array.isArray(row.relationDelta)
                || Array.isArray(row.primaryConflict)
                || Array.isArray(row.worldSignature)
                || Array.isArray(row.recallKeywords)
                || String(row.arcKey || '').trim()
            );

        const rebuildHybridScopeIndexInverted = (rows = []) => {
            const inverted = { token: {}, subject: {}, entity: {}, topic: {}, domain: {}, kind: {}, bucket: {}, turnBucket: {} };
            const add = (bucket, key, id) => {
                const normalized = bucket === 'kind' || bucket === 'bucket' || bucket === 'domain' || bucket === 'turnBucket'
                    ? String(key || '').trim()
                    : normalizeHmeIndexTerm(key);
                if (!normalized || !id || !inverted[bucket]) return;
                if (!inverted[bucket][normalized]) inverted[bucket][normalized] = [];
                if (!inverted[bucket][normalized].includes(id) && inverted[bucket][normalized].length < HME_SCOPE_INDEX_INVERTED_BUCKET_LIMIT) {
                    inverted[bucket][normalized].push(id);
                }
            };
            for (const row of Array.isArray(rows) ? rows : []) {
                const id = String(row?.id || '').trim();
                if (!id) continue;
                (row.subjects || []).forEach(term => add('subject', term, id));
                (row.aliases || []).forEach(term => add('subject', term, id));
                (row.entityKeys || row.hotIndex?.entityKeys || row.subjects || []).forEach(term => add('entity', term, id));
                (row.topicKeys || row.hotIndex?.topicKeys || row.tags || []).forEach(term => add('topic', term, id));
                (row.domainKeys || row.hotIndex?.domainKeys || row.kinds || []).forEach(term => add('domain', term, id));
                (row.indexTerms || []).slice(0, HME_SCOPE_INDEX_MAX_TERMS).forEach(term => add('token', term, id));
                (row.kinds || []).forEach(kind => add('kind', kind, id));
                add('kind', row.primaryKind || 'memory', id);
                add('bucket', row.baseBucket || 'memory', id);
                add('domain', row.primaryKind || 'memory', id);
                add('domain', row.baseBucket || 'memory', id);
                (row.narrativeTags || []).forEach(tag => {
                    const normalized = String(tag || '').toLowerCase();
                    if (['origin', 'transition', 'aftermath'].includes(normalized)) add('bucket', normalized, id);
                });
                const turn = normalizeLegacyMemoryTurnAnchor(row.turn || 0);
                if (turn) add('turnBucket', row.turnBucket || row.hotIndex?.turnBucket || String(Math.floor(turn / 10) * 10), id);
            }
            return inverted;
        };

        const appendHybridScopeIndexInverted = (previous = null, rows = [], changedRowIds = []) => {
            const before = hmeIndexRows(previous);
            const delta = rows.slice(before.length);
            // This certificate covers only this owned append operation. Edits,
            // deletions, reordering and stale/unknown shapes use the full path.
            // It is never a canonical storage revision or emission authority.
            if (!previous?.inverted || !delta.length || delta.length !== new Set(changedRowIds).size
                || before.some((row, i) => rows[i] !== row)
                || delta.some(row => !changedRowIds.includes(String(row.id)))) return null;
            const additions = rebuildHybridScopeIndexInverted(delta);
            const inverted = {};
            for (const bucket of Object.keys(additions)) {
                if (!previous.inverted[bucket] || typeof previous.inverted[bucket] !== 'object') return null;
                inverted[bucket] = { ...previous.inverted[bucket] };
                for (const [term, ids] of Object.entries(additions[bucket])) {
                    const prior = inverted[bucket][term] || [];
                    inverted[bucket][term] = [...new Set([...prior, ...ids])].slice(0, HME_SCOPE_INDEX_INVERTED_BUCKET_LIMIT);
                }
            }
            return inverted;
        };

        const ensureHybridScopeIndexRuntimeShape = (index = null) => {
            if (!index || index.schema !== HME_SCOPE_INDEX_SCHEMA || Number(index.version || 0) !== HME_SCOPE_INDEX_VERSION || !Array.isArray(index.rows)) return null;
            if (!index.inverted || typeof index.inverted !== 'object' || !index.inverted.token || !index.inverted.entity || !index.inverted.topic || !index.inverted.domain) {
                index.inverted = rebuildHybridScopeIndexInverted(index.rows);
            }
            return index;
        };

        const buildPersistedHybridScopeIndex = (index = null) => {
            if (!index || index.schema !== HME_SCOPE_INDEX_SCHEMA || Number(index.version || 0) !== HME_SCOPE_INDEX_VERSION) return null;
            const persisted = { ...index };
            delete persisted.inverted;
            return persisted;
        };

        const buildHybridScopeIndexDigest = (rows = []) => String(TokenizerEngine.simpleHash(
            `scope-index:${HME_SCOPE_INDEX_VERSION}|${rows.map(row => `${row.id}:${row.contentHash}:${row.rollbackState}:${row.stale ? 1 : 0}`).sort().join('|')}`
        ));
        const buildHybridScopeIndexFromEntries = (entries = [], options = {}) => {
            const scopeKey = getHybridScopeKey(options.scopeKey);
            const currentTurn = Number(options.currentTurn || MemoryState.currentTurn || 0) || 0;
            const memoryEntries = (Array.isArray(entries) ? entries : []).filter(entry => String(entry?.comment || '') === 'lmai_memory');
            const rows = memoryEntries
                .map((entry, index) => buildHybridScopeIndexRow(entry, index, currentTurn))
                .filter(Boolean);
            const maxTurn = rows.reduce((max, row) => Math.max(max, normalizeLegacyMemoryTurnAnchor(row.turn || 0) || 0), 0);
            const digest = buildHybridScopeIndexDigest(rows);
            return {
                schema: HME_SCOPE_INDEX_SCHEMA,
                version: HME_SCOPE_INDEX_VERSION,
                engineVersion: HYBRID_MEMORY_ENGINE_POLICY.version,
                source: 'hybrid_write_path_scope_index',
                scopeKey,
                scopeHash: getHybridScopeHash(scopeKey),
                builtAt: Date.now(),
                updatedAt: Date.now(),
                rowCount: rows.length,
                sourceMemoryCount: memoryEntries.length,
                maxTurn,
                digest,
                rows,
                inverted: rebuildHybridScopeIndexInverted(rows),
                policy: {
                    maxTerms: HME_SCOPE_INDEX_MAX_TERMS,
                    preselectHardCap: HME_SCOPE_INDEX_PRESELECT_HARD_CAP,
                    rawRetention: 'signals_only'
                }
            };
        };

        const parseHybridScopeIndexEntry = (entry = null) => {
            if (!entry || String(entry?.comment || '').trim() !== HME_SCOPE_INDEX_COMMENT) return null;
            try {
                const parsed = JSON.parse(String(entry.content || '{}'));
                if (!parsed || parsed.schema !== HME_SCOPE_INDEX_SCHEMA || !Array.isArray(parsed.rows)) return null;
                if (Number(parsed.version || 0) !== HME_SCOPE_INDEX_VERSION) {
                    markHybridScopeIndexStale(parsed.scopeKey);
                    return null;
                }
                return ensureHybridScopeIndexRuntimeShape(parsed);
            } catch (_) {
                return null;
            }
        };

        const findHybridScopeIndexInLore = (lorebook = [], scopeKey = '') => {
            const scope = getHybridScopeKey(scopeKey);
            const scopeHash = getHybridScopeHash(scope);
            const candidates = LibraLoreConsolidator.unpack(Array.isArray(lorebook) ? lorebook : [])
                .filter(entry => String(entry?.comment || '').trim() === HME_SCOPE_INDEX_COMMENT)
                .map(parseHybridScopeIndexEntry)
                .filter(Boolean);
            if (!candidates.length) return null;
            return candidates
                .filter(index => !scopeHash || String(index.scopeHash || '') === scopeHash || String(index.scopeKey || '') === scope)
                .sort((a, b) => Number(b.updatedAt || b.builtAt || 0) - Number(a.updatedAt || a.builtAt || 0))[0] || null;
        };

        const upsertHybridScopeIndexEntry = (entries = [], index = null) => {
            if (!Array.isArray(entries) || !index || index.schema !== HME_SCOPE_INDEX_SCHEMA) return false;
            const persisted = buildPersistedHybridScopeIndex(index);
            if (!persisted) return false;
            for (let i = entries.length - 1; i >= 0; i -= 1) {
                if (String(entries[i]?.comment || '').trim() === HME_SCOPE_INDEX_COMMENT) entries.splice(i, 1);
            }
            try { HmeDerivedCacheStore.scheduleWrite('scope', index.scopeKey, persisted); } catch (_) {}
            return true;
        };

        const markHybridScopeIndexStale = (scopeKey = '') => {
            const scope = getHybridScopeKey(scopeKey);
            const keys = [scope, `hash:${getHybridScopeHash(scope)}`];
            if (keys.some(key => Number(MemoryState.hmeScopeIndexByScope.get(key)?.version || 0) === HME_SCOPE_INDEX_VERSION)) return;
            keys.forEach(key => MemoryState.hmeScopeIndexByScope.delete(key));
            staleHybridScopeIndexScopes.add(scope);
            while (staleHybridScopeIndexScopes.size > 48) staleHybridScopeIndexScopes.delete(staleHybridScopeIndexScopes.values().next().value);
        };
        const cacheHybridScopeIndex = (index = null, scopeKey = '') => {
            const scope = getHybridScopeKey(scopeKey || index?.scopeKey);
            const runtimeIndex = ensureHybridScopeIndexRuntimeShape(index);
            if (!runtimeIndex) {
                if (index?.schema === HME_SCOPE_INDEX_SCHEMA) markHybridScopeIndexStale(scope);
                return;
            }
            staleHybridScopeIndexScopes.delete(scope);
            MemoryState.hmeScopeIndexByScope.set(scope, runtimeIndex);
            MemoryState.hmeScopeIndexByScope.set(`hash:${runtimeIndex.scopeHash || getHybridScopeHash(scope)}`, runtimeIndex);
            while (MemoryState.hmeScopeIndexByScope.size > 48) {
                const key = MemoryState.hmeScopeIndexByScope.keys().next().value;
                MemoryState.hmeScopeIndexByScope.delete(key);
            }
        };

        const getCachedHybridScopeIndex = (scopeKey = '') => {
            const scope = getHybridScopeKey(scopeKey);
            const index = MemoryState.hmeScopeIndexByScope.get(scope)
                || MemoryState.hmeScopeIndexByScope.get(`hash:${getHybridScopeHash(scope)}`)
                || null;
            if (index && Number(index.version || 0) !== HME_SCOPE_INDEX_VERSION) {
                markHybridScopeIndexStale(scope);
                return null;
            }
            return index;
        };

        const hydrateHashIndexFromHybridScopeIndex = (index = null) => {
            if (!index || Number(index.version || 0) !== HME_SCOPE_INDEX_VERSION) return false;
            const rows = hmeIndexRows(index);
            if (!rows.length) return false;
            MemoryState.hashIndex.clear();
            for (const row of rows) {
                if (!row?.id || row.idxKey === undefined || row.idxKey === null) continue;
                if (['candidate_deleted', 'superseded'].includes(normalizeHybridRollbackState(row.rollbackState || 'active')) || row.rollbackTombstone || row.hiddenFromPrompt || row.stale) continue;
                if (!MemoryState.hashIndex.has(row.idxKey)) MemoryState.hashIndex.set(row.idxKey, new Set());
                MemoryState.hashIndex.get(row.idxKey).add(String(row.id));
            }
            return true;
        };

        const reconcileHybridScopeIndexEntries = (entries = [], existingIndex = null, options = {}) => {
            if (!existingIndex || existingIndex.schema !== HME_SCOPE_INDEX_SCHEMA || Number(existingIndex.version || 0) !== HME_SCOPE_INDEX_VERSION) {
                return { index: buildHybridScopeIndexFromEntries(entries, options), changed: true, mode: 'full_build' };
            }
            const scopeKey = getHybridScopeKey(options.scopeKey || existingIndex.scopeKey);
            const currentTurn = Number(options.currentTurn || MemoryState.currentTurn || 0) || 0;
            const memoryEntries = (Array.isArray(entries) ? entries : []).filter(entry => String(entry?.comment || '') === 'lmai_memory');
            const oldRows = new Map(hmeIndexRows(existingIndex).map(row => [String(row?.id || ''), row]).filter(([id]) => id));
            const rows = [];
            let changed = Number(existingIndex.sourceMemoryCount || existingIndex.rowCount || 0) !== memoryEntries.length;
            memoryEntries.forEach((entry, index) => {
                const id = String(getSafeKey(entry) || '').trim();
                const contentHash = String(getEntryContentHash(entry));
                const old = id ? oldRows.get(id) : null;
                if (old && String(old.contentHash || '') === contentHash && isHybridScopeIndexRowGraphV2Ready(old)) {
                    rows.push(old);
                    oldRows.delete(id);
                    return;
                }
                const row = buildHybridScopeIndexRow(entry, index, currentTurn);
                if (row) rows.push(row);
                changed = true;
                if (id) oldRows.delete(id);
            });
            if (oldRows.size > 0) changed = true;
            if (!changed) return { index: existingIndex, changed: false, mode: 'reused' };
            const maxTurn = rows.reduce((max, row) => Math.max(max, normalizeLegacyMemoryTurnAnchor(row.turn || 0) || 0), 0);
            const digest = buildHybridScopeIndexDigest(rows);
            return {
                changed: true,
                mode: 'incremental_reconcile',
                index: {
                    ...existingIndex,
                    schema: HME_SCOPE_INDEX_SCHEMA,
                    version: HME_SCOPE_INDEX_VERSION,
                    engineVersion: HYBRID_MEMORY_ENGINE_POLICY.version,
                    source: 'hybrid_write_path_scope_index',
                    scopeKey,
                    scopeHash: getHybridScopeHash(scopeKey),
                    updatedAt: Date.now(),
                    rowCount: rows.length,
                    sourceMemoryCount: memoryEntries.length,
                    maxTurn,
                    digest,
                    rows,
                    inverted: rebuildHybridScopeIndexInverted(rows),
                    policy: {
                        ...(existingIndex.policy || {}),
                        maxTerms: HME_SCOPE_INDEX_MAX_TERMS,
                        preselectHardCap: HME_SCOPE_INDEX_PRESELECT_HARD_CAP,
                        rawRetention: 'signals_only'
                    }
                }
            };
        };

        const ensureHybridScopeIndex = (lorebook = [], options = {}) => {
            if (CONFIG.hybridMemoryEngineEnabled === false || CONFIG.hybridScopeIndexEnabled === false) {
                return { ok: false, reason: 'disabled' };
            }
            if (!Array.isArray(lorebook)) return { ok: false, reason: 'invalid_lore' };
            const scopeKey = getHybridScopeKey(options.scopeKey);
            const entries = LibraLoreConsolidator.unpack(lorebook);
            const existing = options.force ? null : (getCachedHybridScopeIndex(scopeKey) || findHybridScopeIndexInLore(entries, scopeKey));
            const reconciled = reconcileHybridScopeIndexEntries(entries, existing, {
                scopeKey,
                currentTurn: options.currentTurn || MemoryState.currentTurn || 0
            });
            const index = reconciled.index;
            if (!index) return { ok: false, reason: 'index_build_failed' };
            const legacyDerivedCount = entries.filter(entry => [HME_SCOPE_INDEX_COMMENT, HME_GRAPH_INDEX_COMMENT].includes(String(entry?.comment || '').trim())).length;
            if (reconciled.changed || !existing || options.force || legacyDerivedCount > 0) {
                upsertHybridScopeIndexEntry(entries, index);
                for (let i = entries.length - 1; i >= 0; i -= 1) {
                    if ([HME_SCOPE_INDEX_COMMENT, HME_GRAPH_INDEX_COMMENT].includes(String(entries[i]?.comment || '').trim())) entries.splice(i, 1);
                }
                lorebook.length = 0;
                lorebook.push(...entries);
            }
            cacheHybridScopeIndex(index, scopeKey);
            hydrateHashIndexFromHybridScopeIndex(index);
            let graphResult = null;
            try { graphResult = ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex: index, force: Boolean(reconciled.changed || !existing || options.force) }); } catch (error) { if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMEGraph] ensure graph failed:', error?.message || error); }
            return {
                ok: true,
                index,
                changed: Boolean(reconciled.changed || !existing || options.force || graphResult?.changed),
                graphChanged: Boolean(graphResult?.changed),
                graphMode: graphResult?.mode || '',
                mode: reconciled.mode || 'unknown'
            };
        };

        const upsertHybridScopeIndexRows = (lorebook = [], changedEntries = [], options = {}) => {
            if (CONFIG.hybridMemoryEngineEnabled === false || CONFIG.hybridScopeIndexEnabled === false) {
                return { ok: false, reason: 'disabled' };
            }
            if (!Array.isArray(lorebook)) return { ok: false, reason: 'invalid_lore' };
            const entriesToUpsert = (Array.isArray(changedEntries) ? changedEntries : [changedEntries])
                .filter(entry => entry && String(entry?.comment || '') === 'lmai_memory');
            if (!entriesToUpsert.length) return { ok: false, reason: 'empty_entries' };
            const scopeKey = getHybridScopeKey(options.scopeKey);
            const entries = LibraLoreConsolidator.unpack(lorebook);
            let index = findHybridScopeIndexInLore(entries, scopeKey) || getCachedHybridScopeIndex(scopeKey);
            if (!index || !hmeIndexRows(index).length) {
                return ensureHybridScopeIndex(lorebook, { ...options, scopeKey, reason: options.reason || 'index-row-upsert-bootstrap' });
            }
            const rowsById = new Map(hmeIndexRows(index).map(row => [String(row?.id || ''), row]).filter(([id]) => id));
            const changedRowIds = [];
            let changed = false;
            entriesToUpsert.forEach((entry, idx) => {
                const row = buildHybridScopeIndexRow(entry, hmeIndexRows(index).length + idx, options.currentTurn || MemoryState.currentTurn || 0);
                if (!row?.id) return;
                const prev = rowsById.get(String(row.id));
                if (!prev || String(prev.contentHash || '') !== String(row.contentHash || '') || String(prev.rollbackState || '') !== String(row.rollbackState || '')) {
                    rowsById.set(String(row.id), row);
                    changedRowIds.push(String(row.id));
                    changed = true;
                }
            });
            if (!changed) {
                cacheHybridScopeIndex(index, scopeKey);
                hydrateHashIndexFromHybridScopeIndex(index);
                let graphResult = null;
                try { graphResult = ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex: index, force: false }); } catch (error) { if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMEGraph] noop graph sync failed:', error?.message || error); }
                return {
                    ok: true,
                    index,
                    changed: Boolean(graphResult?.changed),
                    graphChanged: Boolean(graphResult?.changed),
                    graphMode: graphResult?.mode || '',
                    mode: graphResult?.changed ? 'row_upsert_noop_graph_maintenance' : 'row_upsert_noop'
                };
            }
            const rows = Array.from(rowsById.values())
                .filter(row => row && row.id)
                .sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0) || String(a.id).localeCompare(String(b.id)));
            const maxTurn = rows.reduce((max, row) => Math.max(max, normalizeLegacyMemoryTurnAnchor(row.turn || 0) || 0), 0);
            const digest = buildHybridScopeIndexDigest(rows);
            const appendedInverted = appendHybridScopeIndexInverted(index, rows, changedRowIds);
            index = {
                ...index,
                schema: HME_SCOPE_INDEX_SCHEMA,
                version: HME_SCOPE_INDEX_VERSION,
                engineVersion: HYBRID_MEMORY_ENGINE_POLICY.version,
                source: 'hybrid_write_path_scope_index',
                scopeKey,
                scopeHash: getHybridScopeHash(scopeKey),
                updatedAt: Date.now(),
                rowCount: rows.length,
                sourceMemoryCount: rows.length,
                maxTurn,
                digest,
                rows,
                inverted: appendedInverted || rebuildHybridScopeIndexInverted(rows)
            };
            upsertHybridScopeIndexEntry(entries, index);
            lorebook.length = 0;
            lorebook.push(...entries);
            cacheHybridScopeIndex(index, scopeKey);
            hydrateHashIndexFromHybridScopeIndex(index);
            let graphResult = null;
            try {
                graphResult = incrementallyPatchHmeGraphIndexRows(
                    lorebook,
                    index,
                    changedRowIds,
                    { scopeKey }
                );
            } catch (error) {
                if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMEGraph] incremental row patch failed:', error?.message || error);
                try { graphResult = ensureHmeGraphIndex(lorebook, { scopeKey, scopeIndex: index, force: true }); } catch (_) {}
            }
            return { ok: true, index, changed: true, graphChanged: Boolean(graphResult?.changed), graphMode: graphResult?.mode || '', mode: 'row_upsert' };
        };

        const hydrateHybridScopeIndexFromLore = (lorebook = [], options = {}) => {
            if (CONFIG.hybridMemoryEngineEnabled === false || CONFIG.hybridScopeIndexEnabled === false) return false;
            const scopeKey = getHybridScopeKey(options.scopeKey);
            const index = findHybridScopeIndexInLore(lorebook, scopeKey);
            if (!index || !hmeIndexRows(index).length) return false;
            cacheHybridScopeIndex(index, scopeKey);
            try { hydrateHmeGraphIndexFromLore(lorebook, { scopeKey }); } catch (error) {
                recordSuppressedRuntimeError('hme.hydrate_graph_index_from_lore', error, { scopeKey });
            }
            return hydrateHashIndexFromHybridScopeIndex(index);
        };

        const rebuildHybridScopeIndexForRecall = (entries = [], options = {}) => {
            const source = Array.isArray(entries) ? entries : [];
            const seen = new Set(source.map(getSafeKey));
            // Keep protected memory candidates and the existing entity/lore inputs together.
            const graphInputs = hmeGraphInputEntries(options.lorebook || options.entries || []).filter(entry => {
                if (['lmai_memory', HME_SCOPE_INDEX_COMMENT, HME_GRAPH_INDEX_COMMENT].includes(String(entry?.comment || '').trim())) return false;
                const key = getSafeKey(entry);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return ensureHybridScopeIndex([...source, ...graphInputs], { scopeKey: options.scopeKey, currentTurn: options.currentTurn });
        };
        const queryHybridScopeIndex = (entries = [], options = {}) => {
            if (CONFIG.hybridMemoryEngineEnabled === false || CONFIG.hybridScopeIndexEnabled === false) {
                return { ok: false, reason: 'disabled' };
            }
            const sourceEntries = Array.isArray(entries) ? entries : [];
            if (!sourceEntries.length) return { ok: false, reason: 'empty_entries' };
            const scopeKey = getHybridScopeKey(options.scopeKey);
            let index = getCachedHybridScopeIndex(scopeKey);
            if (!index && staleHybridScopeIndexScopes.has(scopeKey)) {
                // Only derived state is rewritten; never mutate the caller's canonical array.
                const rebuilt = rebuildHybridScopeIndexForRecall(sourceEntries, { ...options, scopeKey });
                if (rebuilt.ok) index = rebuilt.index;
            }
            if (!index || !hmeIndexRows(index).length) return { ok: false, reason: 'missing_index' };
            if (Number(index.sourceMemoryCount || index.rowCount || 0) !== sourceEntries.length) {
                const reconciled = reconcileHybridScopeIndexEntries(sourceEntries, index, {
                    scopeKey,
                    currentTurn: options.currentTurn || MemoryState.currentTurn || 0
                });
                index = reconciled.index || index;
                cacheHybridScopeIndex(index, scopeKey);
            }
            const entryByKey = new Map(sourceEntries.map(entry => [String(getSafeKey(entry) || '').trim(), entry]).filter(([key]) => key));
            const rows = hmeIndexRows(index).filter(row => row?.id && entryByKey.has(String(row.id)));
            if (!rows.length) return { ok: false, reason: 'index_entries_not_found' };
            const currentTurn = Number(options.currentTurn || MemoryState.currentTurn || 0) || 0;
            const queryPlan = options.queryPlan || {};
            const recallIntent = options.recallIntent || {};
            const kindPlan = options.kindPlan || {};
            const raw = String(queryPlan.raw || options.query || '').trim();
            const directFocusNames = normalizeHmeEntityNameList(options.directFocusNames || options.focusNames || [], 24);
            const relatedFocusNames = normalizeHmeEntityNameList(options.relatedFocusNames || [], 24);
            const focusNames = normalizeHmeEntityNameList([
                ...directFocusNames,
                ...relatedFocusNames,
                ...(Array.isArray(options.focusNames) ? options.focusNames : [])
            ], 40);
            const focusKeySet = hmeEntityMatchKeys(focusNames);
            const queryTerms = new Set(uniqLimit([
                ...(Array.isArray(options.queryTokens) ? options.queryTokens : TokenizerEngine.tokenize(raw)),
                ...(queryPlan.strongAnchors || []),
                ...(queryPlan.exactAnchors || []),
                ...focusNames,
                ...(recallIntent.labels || [])
            ].flatMap(expandHmeIndexTerms).filter(Boolean), 96));
            const wantedKinds = uniqLimit([...(kindPlan.primaryKinds || []), ...(kindPlan.wants || []), ...(kindPlan.bundleOrder || [])].map(v => String(v || '').trim()).filter(Boolean), 24);
            const wantedBuckets = uniqLimit([
                ...(recallIntent.origin ? ['origin'] : []),
                ...(recallIntent.transition ? ['transition'] : []),
                ...(recallIntent.aftermath ? ['aftermath'] : []),
                ...(recallIntent.current ? ['current'] : []),
                ...(recallIntent.relationship ? ['relationship'] : []),
                ...(recallIntent.worldRule ? ['world'] : []),
                ...(kindPlan.preserveBuckets || [])
            ], 24);
            const strictOriginQuery = recallQueryNeedsStrictOriginScene(queryPlan, recallIntent);
            const candidateIds = new Set();
            const addIndexed = (bucket, key) => {
                const normalized = bucket === 'kind' || bucket === 'bucket'
                    ? String(key || '').trim()
                    : normalizeHmeIndexTerm(key);
                const list = index?.inverted?.[bucket]?.[normalized];
                if (Array.isArray(list)) list.forEach(id => candidateIds.add(String(id)));
            };
            queryTerms.forEach(term => {
                addIndexed('token', term);
                addIndexed('subject', term);
                addIndexed('entity', term);
                addIndexed('topic', term);
            });
            wantedKinds.forEach(kind => addIndexed('kind', kind));
            wantedKinds.forEach(kind => addIndexed('domain', kind));
            wantedBuckets.forEach(bucket => addIndexed('bucket', bucket));
            wantedBuckets.forEach(bucket => addIndexed('domain', bucket));
            const turnBucketsWanted = new Set();
            if (recallIntent?.current && currentTurn > 0) {
                const currentBucket = Math.floor(currentTurn / 10) * 10;
                turnBucketsWanted.add(String(currentBucket));
                if (currentBucket >= 10) turnBucketsWanted.add(String(currentBucket - 10));
            }
            if (recallIntent?.origin) {
                turnBucketsWanted.add('0');
                turnBucketsWanted.add('10');
            }
            turnBucketsWanted.forEach(bucket => addIndexed('turnBucket', bucket));
            const focusSubjectHitByRowId = new Map();
            if (focusKeySet.size > 0) {
                rows.forEach(row => {
                    const hits = countHmeEntityFocusMatches(row, focusKeySet);
                    if (hits > 0) {
                        focusSubjectHitByRowId.set(String(row.id), hits);
                        candidateIds.add(String(row.id));
                    }
                });
                focusNames.flatMap(expandHmeIndexTerms).forEach(term => {
                    addIndexed('subject', term);
                    addIndexed('entity', term);
                });
            }
            const preselectLimit = Math.max(24, Math.min(
                HME_SCOPE_INDEX_PRESELECT_HARD_CAP,
                Number(options.preselectLimit || 0)
                    || Math.max(Number(options.topK || 10) * 3, 28)
            ));
            const fallbackRows = rows
                .filter(row => {
                    const rollbackState = normalizeHybridRollbackState(row.rollbackState || 'active');
                    return rollbackState !== 'candidate_deleted'
                        && rollbackState !== 'superseded'
                        && !row.rollbackTombstone
                        && !row.hiddenFromPrompt
                        && !row.stale;
                })
                .slice()
                .sort((a, b) => Number(b.turn || 0) - Number(a.turn || 0) || Number(b.importance || 0) - Number(a.importance || 0))
                .slice(0, 32);
            const fallbackSeedTarget = Math.max(12, Math.min(24, preselectLimit));
            fallbackRows.forEach((row, index) => {
                if (index < fallbackSeedTarget || candidateIds.size < fallbackSeedTarget) candidateIds.add(String(row.id));
            });
            const poolIds = new Set(Array.from(candidateIds).filter(Boolean));
            const pool = rows.filter(row => poolIds.has(String(row?.id || '')));
            const scored = pool.map(row => {
                const rollbackState = normalizeHybridRollbackState(row.rollbackState || 'active');
                if (rollbackState === 'candidate_deleted' || rollbackState === 'superseded' || row.rollbackTombstone || row.hiddenFromPrompt || row.stale) return null;
                const ttl = Number(row.ttl);
                const turn = Number(row.turn || 0);
                if (!(ttl === -1 || !Number.isFinite(ttl) || ttl <= 0 || (Number.isFinite(turn) && (turn + ttl) >= currentTurn))) return null;
                const rowTerms = new Set(Array.isArray(row.indexTerms) ? row.indexTerms : []);
                let tokenHits = 0;
                queryTerms.forEach(term => { if (rowTerms.has(term)) tokenHits += 1; });
                const entityTerms = new Set([...(row.entityKeys || row.hotIndex?.entityKeys || []), ...(row.subjects || []), ...(row.aliases || [])].flatMap(expandHmeIndexTerms));
                const topicTerms = new Set([...(row.topicKeys || row.hotIndex?.topicKeys || []), ...(row.tags || []), ...(row.sceneTags || []), ...(row.worldTags || []), ...(row.narrativeTags || [])].flatMap(expandHmeIndexTerms));
                const domainTerms = new Set([...(row.domainKeys || row.hotIndex?.domainKeys || []), row.primaryKind, row.baseBucket, ...(row.kinds || [])].flatMap(expandHmeIndexTerms));
                const subjectHits = (row.subjects || []).filter(subject => queryTerms.has(normalizeHmeIndexTerm(subject))).length;
                let entityHitsIndexed = 0;
                let topicHits = 0;
                let domainHits = 0;
                queryTerms.forEach(term => {
                    if (entityTerms.has(term)) entityHitsIndexed += 1;
                    if (topicTerms.has(term)) topicHits += 1;
                    if (domainTerms.has(term)) domainHits += 1;
                });
                const focusSubjectHits = Number(focusSubjectHitByRowId.get(String(row.id)) || 0);
                const kindHits = wantedKinds.filter(kind => (row.kinds || []).includes(kind) || row.primaryKind === kind).length;
                const bucketHits = wantedBuckets.filter(bucket => row.baseBucket === bucket || (row.narrativeTags || []).map(v => String(v || '').toLowerCase()).includes(bucket)).length;
                const turnBucketHit = turnBucketsWanted.size > 0 && turnBucketsWanted.has(String(row.turnBucket || row.hotIndex?.turnBucket || (turn ? Math.floor(turn / 10) * 10 : ''))) ? 1 : 0;
                const anchorHits = getExactAnchorHits(queryPlan.strongAnchors || [], [
                    ...(row.subjects || []),
                    ...(row.tags || []),
                    ...(row.sceneTags || []),
                    ...(row.emotionTags || []),
                    ...(row.relationTags || []),
                    ...(row.worldTags || []),
                    ...(row.narrativeTags || []),
                    ...(row.indexTerms || [])
                ].join(' '));
                const recency = calcRecency(row.turn || 0, currentTurn);
                const originCueProfile = strictOriginQuery ? getOriginSceneCueProfile(row.text || '', row.payload || {}) : { hits: [], strongHits: [], weakHits: [], totalCount: 0, strongCount: 0, weakCount: 0 };
                const originBucketSignal = strictOriginQuery && (
                    row.baseBucket === 'origin'
                    || row.arcRole === 'origin'
                    || row.causalRole === 'cause'
                    || (Array.isArray(row.narrativeTags) && row.narrativeTags.map(v => String(v || '').toLowerCase()).includes('origin'))
                ) ? 1 : 0;
                const originAgeBias = strictOriginQuery && originCueProfile.strongCount > 0 && Number.isFinite(currentTurn) && Number.isFinite(row.turn)
                    ? Math.min(0.9, Math.max(0, currentTurn - row.turn) * 0.015)
                    : 0;
                const score = (tokenHits * 0.9)
                    + (subjectHits * 2.6)
                    + (entityHitsIndexed * 2.8)
                    + (topicHits * 1.35)
                    + (domainHits * 1.1)
                    + (focusSubjectHits * 3.2)
                    + (kindHits * 2.0)
                    + (bucketHits * 1.8)
                    + (turnBucketHit * 0.85)
                    + (anchorHits.length * 4.0)
                    + (Number(row.importance || 0) * 1.2)
                    + (recency * 0.7)
                    + (strictOriginQuery ? ((originCueProfile.strongCount * 6.2) + (originCueProfile.weakCount * 1.4) + (originBucketSignal * 1.8) + originAgeBias) : 0);
                return { row, score, tokenHits, subjectHits, entityHitsIndexed, topicHits, domainHits, focusSubjectHits, kindHits, bucketHits, turnBucketHit, anchorHits, originCueProfile, originBucketSignal, originAgeBias };
            }).filter(Boolean)
                .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.row?.turn || 0) - Number(a.row?.turn || 0));
            const selectedRows = [];
            const selectedRowIds = new Set();
            const addSelectedRow = (item = null) => {
                const rowId = String(item?.row?.id || '').trim();
                if (!rowId || selectedRowIds.has(rowId) || selectedRows.length >= preselectLimit) return;
                selectedRowIds.add(rowId);
                selectedRows.push(item.row);
            };
            if (strictOriginQuery) {
                const seedLimit = Math.max(2, Math.min(6, Math.ceil(preselectLimit / 6)));
                scored
                    .filter(item => Number(item.originCueProfile?.strongCount || 0) > 0 || Number(item.originBucketSignal || 0) > 0)
                    .sort((a, b) => {
                        const strongCueDiff = Number(b.originCueProfile?.strongCount || 0) - Number(a.originCueProfile?.strongCount || 0);
                        if (strongCueDiff) return strongCueDiff;
                        const bucketDiff = Number(b.originBucketSignal || 0) - Number(a.originBucketSignal || 0);
                        if (bucketDiff) return bucketDiff;
                        const turnDiff = Number(a.row?.turn || 0) - Number(b.row?.turn || 0);
                        if (turnDiff) return turnDiff;
                        return Number(b.score || 0) - Number(a.score || 0);
                    })
                    .slice(0, seedLimit)
                    .forEach(addSelectedRow);
            }
            scored.forEach(addSelectedRow);
            const selectedEntries = selectedRows.map(row => entryByKey.get(String(row.id))).filter(Boolean);
            if (!selectedEntries.length) return { ok: false, reason: 'empty_selection' };
            return {
                ok: true,
                entries: selectedEntries,
                selectedKeys: new Set(selectedRows.map(row => String(row.id))),
                index,
                debug: {
                    enabled: true,
                    schema: HME_SCOPE_INDEX_SCHEMA,
                    version: HME_SCOPE_INDEX_VERSION,
                    scopeHash: index.scopeHash || '',
                    rowCount: rows.length,
                    sourceCandidates: sourceEntries.length,
                    poolRows: pool.length,
                    candidateIds: candidateIds.size,
                    selectedRows: selectedRows.length,
                    preselectLimit,
                    digest: index.digest || '',
                    mode: 'scope_index_preselect',
                    hotIndex: {
                        version: HME_SCOPE_INDEX_VERSION,
                        buckets: Object.fromEntries(Object.entries(index.inverted || {}).map(([key, value]) => [key, value && typeof value === 'object' ? Object.keys(value).length : 0])),
                        turnBucketsWanted: Array.from(turnBucketsWanted)
                    },
                    topRows: scored.slice(0, 8).map(item => ({
                        id: item.row.id,
                        kind: item.row.primaryKind,
                        turn: item.row.turn || 0,
                        score: Number((item.score || 0).toFixed(3)),
                        tokenHits: item.tokenHits,
                        subjectHits: item.subjectHits,
                        entityHits: item.entityHitsIndexed,
                        topicHits: item.topicHits,
                        domainHits: item.domainHits,
                        focusSubjectHits: item.focusSubjectHits,
                        kindHits: item.kindHits,
                        bucketHits: item.bucketHits,
                        turnBucketHit: item.turnBucketHit,
                        anchorHits: item.anchorHits || [],
                        originCueStrong: Number(item.originCueProfile?.strongCount || 0),
                        originCueWeak: Number(item.originCueProfile?.weakCount || 0),
                        originBucketSignal: Number(item.originBucketSignal || 0)
                    }))
                }
            };
        };

        const getHybridScopeIndexStats = () => {
            const scopeKey = getHybridScopeKey();
            const index = getCachedHybridScopeIndex(scopeKey);
            return {
                enabled: CONFIG.hybridMemoryEngineEnabled !== false && CONFIG.hybridScopeIndexEnabled !== false,
                cachedScopes: MemoryState.hmeScopeIndexByScope.size,
                scopeHash: index?.scopeHash || '',
                rowCount: Number(index?.rowCount || 0),
                sourceMemoryCount: Number(index?.sourceMemoryCount || 0),
                maxTurn: Number(index?.maxTurn || 0),
                digest: index?.digest || ''
            };
        };

        const getHmeGraphIndexStats = () => {
            const scopeKey = getHybridScopeKey();
            const graph = getCachedHmeGraphIndex(scopeKey);
            return {
                enabled: isHmeGraphEnabled(),
                mode: normalizeHmeGraphMode(CONFIG.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode),
                cachedScopes: MemoryState.hmeGraphIndexByScope.size,
                scopeHash: graph?.scopeHash || '',
                nodeCount: Number(graph?.stats?.nodeCount || hmeGraphNodes(graph).length || 0),
                edgeCount: Number(graph?.stats?.edgeCount || hmeGraphEdges(graph).length || 0),
                meaningEdgeCount: Number(graph?.stats?.meaningEdgeCount || 0),
                signalEdgeCount: Number(graph?.stats?.signalEdgeCount || 0),
                staleEdgeCount: Number(graph?.stats?.staleEdgeCount || 0),
                lastStaleEdgeCount: Number(graph?.stats?.lastStaleEdgeCount || graph?.stats?.rebuiltFromStaleEdgeCount || 0),
                lastStaleEdgeRatio: Number(graph?.stats?.lastStaleEdgeRatio || graph?.stats?.rebuiltFromStaleEdgeRatio || 0),
                activeNodeCount: Number(graph?.stats?.activeNodeCount || 0),
                relationCounts: graph?.stats?.relationCounts || {},
                layerCounts: graph?.stats?.layerCounts || {},
                staleRebuildScopes: Number(MemoryState.hmeGraphStaleRebuildByScope?.size || 0),
                sourceDigest: String(graph?.source?.hmeScopeIndexDigest || '')
            };
        };
