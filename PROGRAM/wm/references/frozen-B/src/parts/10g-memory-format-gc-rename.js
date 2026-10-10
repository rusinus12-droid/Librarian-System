        const formatMemories = (memories, query = '', options = {}) => {
            if (!memories || memories.length === 0) return '';
            const maxTokens = Math.max(0, Math.floor(Number(options?.maxTokens || 0) || 0));
            const maxItems = Math.max(1, Math.min(40, Math.floor(Number(options?.maxItems || memories.length) || memories.length)));
            const maxPerBucket = Math.max(1, Math.min(12, Math.floor(Number(options?.maxPerBucket || 4) || 4)));
            const fitRecallLines = (sourceLines = []) => {
                const rawLines = (Array.isArray(sourceLines) ? sourceLines : []).map(String).filter(Boolean);
                if (!maxTokens) return rawLines.join('\n');
                const full = rawLines.join('\n');
                const originalTokens = TokenizerEngine.estimateTokens(full, 'simple');
                if (originalTokens <= maxTokens) return full;
                const marker = '[LIBRA recall bundle compacted to its dedicated token budget]';
                const markerTokens = TokenizerEngine.estimateTokens(marker, 'simple');
                const selected = [];
                let used = 0;
                let dropped = 0;
                for (const line of rawLines) {
                    const lineTokens = TokenizerEngine.estimateTokens(line, 'simple');
                    if (used + lineTokens + markerTokens <= maxTokens) {
                        selected.push(line);
                        used += lineTokens;
                    } else {
                        dropped += 1;
                    }
                }
                if (dropped > 0 && used + markerTokens <= maxTokens) selected.push(marker);
                try {
                    if (lastRetrievalDebug && typeof lastRetrievalDebug === 'object') {
                        lastRetrievalDebug.injectionPacking = {
                            maxTokens,
                            originalTokens,
                            packedTokens: TokenizerEngine.estimateTokens(selected.join('\n'), 'simple'),
                            sourceLines: rawLines.length,
                            packedLines: selected.length,
                            droppedLines: dropped
                        };
                    }
                } catch (_) {}
                return selected.join('\n');
            };
            const groupLabels = {
                exact: 'Exact Anchor / 직접 앵커',
                origin: 'Origin / 기원',
                transition: 'Transition / 전환점',
                relationship: 'Relationship Carryover / 관계 연결',
                world: 'World/Rule Cause / 세계 규칙',
                narrative: 'Narrative Pressure / 서사 압력',
                entity: 'Entity/Subject Carryover / 엔티티 연결',
                current: 'Current Carryover / 현재 연결',
                aftermath: 'Aftermath / 후속 여파',
                general: 'Related / 관련 기억'
            };
            const renderIntent = classifyRecallIntent(query || '');
            const order = renderIntent?.origin
                ? ['origin', 'exact', 'world', 'relationship', 'narrative', 'entity', 'transition', 'current', 'aftermath', 'general']
                : ['exact', 'origin', 'world', 'relationship', 'narrative', 'entity', 'transition', 'current', 'aftermath', 'general'];
            const rows = memories.slice(0, maxItems).map((m, i) => {
                const meta = getCachedMeta(m);
                const content = CompactMemoryCodec.buildSearchTextFromEntry(m);
                const displayContent = CompactMemoryCodec.buildDisplayTextFromEntry(m, 340);
                const originLabel = /^(summary_only|summary_and_structured_evidence)$/.test(String(meta.rawRetention || '')) ? '압축 기억' : (meta.source === 'narrative_source_record' ? '서사 근거 원문' : '원문 기억');
                const detail = m?._recallDetail || {};
                const reasons = Array.isArray(detail.evidenceReasons) ? detail.evidenceReasons.slice(0, 3).join('+') : '';
                const scoreLabel = Number.isFinite(Number(m?._score)) ? ` / 점수:${Number(m._score).toFixed(2)}` : '';
                const bonusLabel = Number(m?._recallIntentBonus || 0) > 0 ? ` / 의도보너스:${Number(m._recallIntentBonus).toFixed(2)}` : '';
                const hybridLabel = m?._hybridKind ? ` / HME:${String(m._hybridKind || 'memory')}` : '';
                const reasonLabel = reasons ? ` / 근거:${reasons}` : '';
                const compactPayload = CompactMemoryCodec.parsePayloadFromEntry(m);
                let excerpt = compactPayload ? displayContent : String(m?._recallWindow || detail.bestWindow || '').trim();
                if (!excerpt && CONFIG.recallSentenceWindowEnabled && query) {
                    excerpt = StrengthenedJaccardCore.selectBestWindow(query, content, {
                        meta,
                        currentTurn: MemoryEngine.getCurrentTurn(),
                        maxChars: CONFIG.recallSentenceWindowChars || 260,
                        radius: 1
                    });
                }
                if (!excerpt) excerpt = displayContent || content.slice(0, 220);
                const exactBackfill = Array.isArray(m?._recallExactAnchorBackfill) && m._recallExactAnchorBackfill.length > 0;
                const maxChars = exactBackfill
                    ? 190
                    : Math.max(120, Math.min(520, Number(CONFIG.recallSentenceWindowChars || 260)));
                if (excerpt.length > maxChars) excerpt = `${excerpt.slice(0, maxChars).trim()}...`;
                const storedBucket = String(m?._recallBucket || '').trim();
                const bucket = exactBackfill && (!storedBucket || storedBucket === 'general')
                    ? 'exact'
                    : (storedBucket || (exactBackfill ? 'exact' : 'general'));
                return {
                    index: i,
                    bucket: groupLabels[bucket] ? bucket : 'general',
                    score: Number(m?._score || 0),
                    turn: Number(meta.t || 0),
                    line: `[${i + 1}] (${originLabel} / 중요도:${meta.imp}/10${scoreLabel}${bonusLabel}${hybridLabel}${reasonLabel}) ${excerpt}`
                };
            });
            const hasStructured = rows.some(row => row.bucket !== 'general');
            if (!hasStructured) return fitRecallLines(rows.map(row => row.line));
            const lines = ['[Retrieved Continuity Bundle / 회수 연속성 묶음]'];
            const queryStrongAnchors = buildRecallQueryPlan(query, extractExactRecallAnchors(query), classifyRecallIntent(query)).strongAnchors.slice(0, 12);
            const directAnchors = queryStrongAnchors
                .filter(anchor => memories.some(memory => getExactAnchorHits([anchor], CompactMemoryCodec.buildSearchTextFromEntry(memory)).length > 0))
                .slice(0, 8);
            if (directAnchors.length > 0) {
                lines.push(`- Direct Anchor Coverage / 직접 앵커 커버리지: ${directAnchors.join(', ')}`);
            }
            const selectedKinds = uniqLimit(rows.map(row => {
                const m = memories[row.index || 0];
                return String(m?._hybridKind || '').trim();
            }).filter(Boolean), 8);
            if (selectedKinds.length > 0) {
                lines.push(`- Hybrid Kind Coverage / 하이브리드 종류 커버리지: ${selectedKinds.join(', ')}`);
            }
            for (const bucket of order) {
                const group = rows
                    .filter(row => row.bucket === bucket)
                    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.turn || 0) - Number(b.turn || 0));
                if (group.length === 0) continue;
                lines.push(`- ${groupLabels[bucket]}`);
                group.slice(0, maxPerBucket).forEach(row => lines.push(`  ${row.line}`));
            }
            return fitRecallLines(lines);
        };

        const incrementalGC = async (allEntries, currentTurn) => {
            sanitizeMemoryRetentionConfig(CONFIG, 'gc');
            const toDelete = new Set();
            if (!Array.isArray(allEntries) || allEntries.length === 0) return { entries: Array.isArray(allEntries) ? allEntries : [], deleted: 0 };

            // TTL 검사는 lmai_memory 엔트리만 대상으로 함 (시스템 엔트리 보호)
            const memoryEntries = allEntries.filter(e => e.comment === 'lmai_memory');
            const gcBatchSize = Math.max(1, Math.floor(Number(CONFIG.gcBatchSize) || MEMORY_PRESETS.general.gcBatchSize));
            const maxLimit = Math.max(MEMORY_RETENTION_GUARD.minMaxLimit, Math.floor(Number(CONFIG.maxLimit) || MEMORY_PRESETS.general.maxLimit));
            if (memoryEntries.length > 0) {
                for (let i = 0; i < gcBatchSize; i++) {
                    const idx = (MemoryState.gcCursor + i) % memoryEntries.length;
                    const entry = memoryEntries[idx];
                    const meta = getCachedMeta(entry);
                    const ttl = Number(meta.ttl);
                    const turn = Number(meta.t);
                    const rpProtected = CONFIG.rpLongTermMemoryEnabled !== false && RPContinuityCore.isEntryProtected(entry);
                    if (!rpProtected && ttl !== -1 && Number.isFinite(turn) && Number.isFinite(ttl) && (turn + ttl) < currentTurn) {
                        toDelete.add(getSafeKey(entry));
                    }
                }
                MemoryState.gcCursor = (MemoryState.gcCursor + gcBatchSize) % Math.max(1, memoryEntries.length);
            }

            const managed = memoryEntries;
            if (managed.length > maxLimit) {
                const overflowCount = managed.length - maxLimit;
                const ranked = [...managed].sort((a, b) => {
                    const retentionA = CONFIG.rpLongTermMemoryEnabled !== false ? RPContinuityCore.entryRetentionRank(a) : 0;
                    const retentionB = CONFIG.rpLongTermMemoryEnabled !== false ? RPContinuityCore.entryRetentionRank(b) : 0;
                    if (retentionA !== retentionB) return retentionA - retentionB;
                    const metaA = getCachedMeta(a);
                    const metaB = getCachedMeta(b);
                    const belowThresholdA = (metaA.imp || 0) < CONFIG.threshold ? 0 : 1;
                    const belowThresholdB = (metaB.imp || 0) < CONFIG.threshold ? 0 : 1;
                    if (belowThresholdA !== belowThresholdB) return belowThresholdA - belowThresholdB;
                    if ((metaA.imp || 0) !== (metaB.imp || 0)) return (metaA.imp || 0) - (metaB.imp || 0);
                    return (metaA.t || 0) - (metaB.t || 0);
                });
                ranked
                    .filter(entry => CONFIG.rpLongTermMemoryEnabled === false || RPContinuityCore.entryRetentionRank(entry) < 3)
                    .slice(0, overflowCount)
                    .forEach(e => toDelete.add(getSafeKey(e)));
            }

            if (toDelete.size > 0) {
                const archiveCandidates = allEntries.filter(e => e?.comment === 'lmai_memory' && toDelete.has(getSafeKey(e)));
                let archiveResult = { ok: true, changed: false, reason: 'empty_candidates' };
                if (archiveCandidates.length > 0) {
                    try {
                        archiveResult = (typeof ColdArchiveManager !== 'undefined' && ColdArchiveManager?.archivePrunedMemoryEntries)
                            ? await ColdArchiveManager.archivePrunedMemoryEntries(allEntries, archiveCandidates, {
                                currentTurn,
                                reason: managed.length > maxLimit ? 'memory_cap_pressure' : 'memory_ttl_expired',
                                scopeKey: MemoryState?._activeScopeKey || MemoryState?._activeChatId || '',
                                chatId: MemoryState?._activeChatId || '',
                                maxLimit,
                                config: CONFIG,
                                candidateIds: archiveCandidates.map(getSafeKey)
                            })
                            : { ok: false, changed: false, reason: 'cold_archive_unavailable', ackedIds: [] };
                    } catch (archiveError) {
                        archiveResult = { ok: false, changed: false, reason: archiveError?.message || 'cold_archive_failed' };
                    }
                    const ackedIds = new Set((Array.isArray(archiveResult?.ackedIds) ? archiveResult.ackedIds : []).map(value => String(value || '')).filter(Boolean));
                    if (!archiveResult?.ok || ackedIds.size === 0) {
                        recordRuntimeDebug('warn', '[LIBRA] Memory GC skipped because cold archive failed:', archiveResult?.reason || 'unknown');
                        return {
                            entries: allEntries,
                            deleted: 0,
                            archived: 0,
                            archiveFailed: true,
                            archiveReason: archiveResult?.reason || 'cold_archive_failed',
                            archiveRequested: archiveCandidates.length,
                            archiveAcked: 0
                        };
                    }
                    const requestedKeys = new Set(archiveCandidates.map(getSafeKey));
                    const unackedKeys = Array.from(requestedKeys).filter(key => !ackedIds.has(String(key)));
                    toDelete.forEach(key => {
                        if (requestedKeys.has(key) && !ackedIds.has(String(key))) toDelete.delete(key);
                    });
                    archiveResult.unackedIds = unackedKeys;
                }
                if (toDelete.size === 0) {
                    return {
                        entries: allEntries,
                        deleted: 0,
                        archived: 0,
                        archiveFailed: true,
                        archiveReason: 'archive_ack_empty',
                        archiveRequested: archiveCandidates.length,
                        archiveAcked: 0
                    };
                }
                MemoryState.hashIndex.forEach(set => toDelete.forEach(item => set.delete(item)));
                const emptyKeys = [];
                MemoryState.hashIndex.forEach((set, key) => { if (set.size === 0) emptyKeys.push(key); });
                emptyKeys.forEach(key => MemoryState.hashIndex.delete(key));
                const remainingMemoryCount = allEntries.filter(e => e?.comment === 'lmai_memory' && !toDelete.has(getSafeKey(e))).length;
                MemoryState.gcCursor = remainingMemoryCount > 0 ? (MemoryState.gcCursor % remainingMemoryCount) : 0;
                return {
                    entries: allEntries.filter(e => !toDelete.has(getSafeKey(e))),
                    deleted: toDelete.size,
                    archived: toDelete.size,
                    archiveRequested: archiveCandidates.length,
                    archiveAcked: toDelete.size,
                    archivePartial: archiveResult?.partial === true || Number(archiveCandidates.length || 0) !== Number(toDelete.size || 0),
                    archiveUnackedIds: Array.isArray(archiveResult?.unackedIds) ? archiveResult.unackedIds : [],
                    archiveShardId: archiveResult?.shard?.id || '',
                    archiveShardIds: Array.isArray(archiveResult?.shards) ? archiveResult.shards.map(shard => shard?.id).filter(Boolean) : [],
                    persistentArchiveBackend: archiveResult?.persistent?.backend || ''
                };
            }
            return { entries: allEntries, deleted: 0 };
        };


        const scheduleDeferredMemoryGc = (char, chat, currentTurn = 0, reason = 'prepareMemory-threshold', targetContext = null) => {
            const scopeKey = String(getChatMemoryScopeKey(chat, char) || chat?.id || 'global').trim() || 'global';
            if (!chat || typeof setTimeout !== 'function') return false;
            const requestedTarget = {
                characterId: String(targetContext?.characterId || targetContext?.charId || char?.id || char?.chaId || '').trim(),
                characterIndex: normalizeRisuIndex(targetContext?.characterIndex ?? targetContext?.charIndex),
                chatId: String(targetContext?.chatId || chat?.id || '').trim(),
                chatIndex: normalizeRisuIndex(targetContext?.chatIndex)
            };
            const existing = MemoryState.deferredGcByScope?.get?.(scopeKey);
            const now = Date.now();
            if (existing && (now - Number(existing.scheduledAt || 0)) < 60000) return false;
            const timer = setTimeout(async () => {
                MemoryState.deferredGcByScope?.delete?.(scopeKey);
                await loreLock.writeLock();
                try {
                    let resolvedTarget = null;
                    if (requestedTarget.characterIndex >= 0) {
                        resolvedTarget = await resolveChatContextByTarget(requestedTarget, { allowActiveFallback: false });
                    } else {
                        // Legacy callers may not carry an index. In that case only
                        // proceed while the same character can still resolve the
                        // captured chat; never reinterpret it as another active char.
                        const activeContext = await resolveActiveChatContext(chat);
                        const activeCharacterId = String(activeContext?.char?.id || activeContext?.char?.chaId || '').trim();
                        const characterMatches = !requestedTarget.characterId || activeCharacterId === requestedTarget.characterId;
                        const chatMatches = String(activeContext?.chat?.id || '').trim() === requestedTarget.chatId;
                        if (characterMatches && chatMatches) {
                            resolvedTarget = { ...activeContext, ok: true };
                        }
                    }
                    if (!resolvedTarget?.ok || !resolvedTarget?.char || !resolvedTarget?.chat) {
                        if (CONFIG.debug) recordRuntimeDebug('warn', `[LIBRA] Deferred GC skipped: target unavailable | scope=${stableHash(scopeKey)}`);
                        return;
                    }
                    const freshChar = resolvedTarget.char;
                    const freshChat = resolvedTarget.chat;
                    const freshLore = MemoryEngine.getLorebook(freshChar, freshChat);
                    if (!Array.isArray(freshLore) || freshLore.length === 0) return;
                    const gcResult = await MemoryEngine.incrementalGC(freshLore, currentTurn);
                    if (!gcResult || Number(gcResult.deleted || 0) <= 0) return;
                    freshLore.length = 0;
                    freshLore.push(...gcResult.entries);
                    ensureHybridScopeIndex(freshLore, {
                        scopeKey: getChatRuntimeScopeKey(freshChat, freshChar),
                        currentTurn,
                        force: true,
                        reason
                    });
                    MemoryEngine.rebuildIndex(freshLore);
                    MemoryEngine.setLorebook(freshChar, freshChat, freshLore);
                    const persistResult = await persistLoreToActiveChat(freshChat, freshLore, {
                        targetContext: requestedTarget.characterIndex >= 0 ? requestedTarget : null,
                        reason: 'deferred-memory-gc-delete',
                        allowManagedDrops: true
                    });
                    if (!persistResult?.ok) throw new Error(`Deferred GC persist failed: ${persistResult?.reason || 'unknown'}`);
                    if (CONFIG.debug) recordRuntimeDebug('log', `[LIBRA] Deferred GC removed ${gcResult.deleted} entries | scope=${stableHash(scopeKey)} | reason=${reason}`);
                } catch (e) {
                    if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA] Deferred GC failed:', e?.message || e);
                } finally {
                    loreLock.writeUnlock();
                }
            }, 750);
            MemoryState.deferredGcByScope?.set?.(scopeKey, { timer, scheduledAt: now, reason });
            return true;
        };

        const renameEntityReferencesInLore = (lorebook = [], oldName = '', newName = '', options = {}) => {
            if (!Array.isArray(lorebook)) return { changed: false, entriesChanged: 0, reason: 'invalid_lore' };
            const oldText = String(oldName || '').trim();
            const newText = String(newName || '').trim();
            if (!oldText || !newText) return { changed: false, entriesChanged: 0, reason: 'empty_name' };
            const normalizeRefKey = (value = '') => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
            const oldKeys = new Set([oldText, ...(Array.isArray(options.previousNames) ? options.previousNames : [])].map(normalizeRefKey).filter(Boolean));
            const replaceName = (value = '') => oldKeys.has(normalizeRefKey(value)) ? newText : String(value || '').trim();
            const textualEntityFields = new Set([
                'summary', 'summaryv2', 'oneline', 'continuity', 'recall', 'text', 'description', 'brief', 'lastdistinctevent', 'scenesummary', 'event', 'snippet',
                'detail', 'details', 'note', 'notes', 'title', 'label', 'claim', 'delta', 'activity', 'reason',
                'scene', 'directive', 'activationcondition', 'resolutioncriteria', 'visibleState', 'inferredState',
                'guardrails', 'continuitylocks', 'requiredoutcomes', 'forbiddenmoves', 'staginginstructions',
                'dialogueinstructions', 'pacinginstructions', 'authorplaninputs', 'worldmanagerinputs'
            ].map(key => String(key).toLowerCase()));
            const escapeRenameRegExp = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const replaceNameInNarrativeText = (value = '') => {
                const original = String(value ?? '');
                if (!original || normalizeRefKey(oldText) === normalizeRefKey(newText)) return original;
                const protectedValues = [];
                const protectedPrefix = '\uE000LIBRA_NAME_';
                const newNamePattern = escapeRenameRegExp(newText).replace(/\\ /g, '\\s+');
                let next = original.replace(new RegExp(newNamePattern, 'giu'), match => {
                    const index = protectedValues.push(match) - 1;
                    return `${protectedPrefix}${index}\uE001`;
                });
                const oldNamePattern = escapeRenameRegExp(oldText).replace(/\\ /g, '\\s+');
                const particle = '(?:에게서|으로는|에게는|에서는|께서는|으로도|에게|에서|으로|께서|까지|부터|처럼|보다|은|는|이|가|을|를|와|과|로|도|만|께|님|씨|から|まで|より|さん|さま|様|は|が|を|に|へ|と|で|の|も)';
                const boundary = '[^\\p{L}\\p{M}\\p{N}_]';
                const oldNameRegex = new RegExp(`(^|${boundary})(${oldNamePattern})(?=$|${boundary}|${particle}(?=$|${boundary}))`, 'giu');
                next = next.replace(oldNameRegex, (_match, prefix) => `${prefix}${newText}`);
                if (protectedValues.length) {
                    next = next.replace(new RegExp(`${protectedPrefix}(\\d+)\\uE001`, 'gu'), (_match, index) => protectedValues[Number(index)] || '');
                }
                return next;
            };
            const entityArrayKeys = new Set(['mentionedEntityNames', 'entityRefs', 'canonicalEntities', 'entities', 'observerEntities', 'pair', 'subjects', 'subjectRefs', 'visibleTo', 'visibleToEntityNames', 'knownBy', 'unknownTo']);
            if (options.rewriteAliases !== false) entityArrayKeys.add('aliases');
            const entityScalarKeys = new Set(['entityA', 'entityB', 'ownerEntityName', 'subject', 'owner', 'target', 'entity']);
            const rewriteEntityArray = (items = [], arrayKey = '') => {
                let changed = false;
                const next = [];
                for (const item of Array.isArray(items) ? items : []) {
                    if (typeof item === 'string') {
                        const renamed = replaceName(item);
                        if (renamed !== item) changed = true;
                        if (renamed && !next.includes(renamed)) next.push(renamed);
                    } else if (item && typeof item === 'object') {
                        const rewritten = rewriteStructuredRefs(item, arrayKey);
                        if (rewritten.changed) changed = true;
                        next.push(rewritten.value);
                    }
                }
                return { value: next, changed };
            };
            const rewriteEntityStates = (states = {}) => {
                let changed = false;
                const next = {};
                for (const [key, value] of Object.entries(states && typeof states === 'object' && !Array.isArray(states) ? states : {})) {
                    const nextKey = replaceName(key);
                    if (nextKey !== key) changed = true;
                    const rewritten = rewriteStructuredRefs(value, '');
                    if (rewritten.changed) changed = true;
                    if (next[nextKey] && typeof next[nextKey] === 'object' && rewritten.value && typeof rewritten.value === 'object') {
                        next[nextKey] = { ...next[nextKey], ...rewritten.value };
                    } else {
                        next[nextKey] = rewritten.value;
                    }
                }
                return { value: next, changed };
            };
            function rewriteStructuredRefs(value, key = '') {
                if (Array.isArray(value)) {
                    if (entityArrayKeys.has(key)) return rewriteEntityArray(value, key);
                    let changed = false;
                    const next = value.map(item => {
                        const rewritten = rewriteStructuredRefs(item, key);
                        if (rewritten.changed) changed = true;
                        return rewritten.value;
                    });
                    return { value: next, changed };
                }
                if (!value || typeof value !== 'object') {
                    if (typeof value === 'string' && entityScalarKeys.has(key)) {
                        const renamed = replaceName(value);
                        return { value: renamed, changed: renamed !== value };
                    }
                    if (typeof value === 'string' && options.structuredOnly !== true && textualEntityFields.has(String(key || '').toLowerCase())) {
                        const renamed = replaceNameInNarrativeText(value);
                        return { value: renamed, changed: renamed !== value };
                    }
                    return { value, changed: false };
                }
                if (key === 'entityStates') return rewriteEntityStates(value);
                let changed = false;
                const next = {};
                const entityRefObject = ['subjects', 'subjectRefs'].includes(key)
                    || /^(?:entity|person|character|mention)$/i.test(String(value.type || value.kind || value.refType || ''));
                for (const [childKey, childValue] of Object.entries(value)) {
                    if (childKey === 'entityStates' && childValue && typeof childValue === 'object' && !Array.isArray(childValue)) {
                        const rewritten = rewriteEntityStates(childValue);
                        next[childKey] = rewritten.value;
                        changed = changed || rewritten.changed;
                        continue;
                    }
                    if (entityScalarKeys.has(childKey) && typeof childValue === 'string') {
                        const renamed = replaceName(childValue);
                        next[childKey] = renamed;
                        changed = changed || renamed !== childValue;
                        continue;
                    }
                    if (entityRefObject && childKey === 'label' && typeof childValue === 'string') {
                        const renamed = replaceName(childValue);
                        next[childKey] = renamed;
                        changed = changed || renamed !== childValue;
                        continue;
                    }
                    if (key === 'claim' && childKey === 'key' && typeof childValue === 'string' && options.structuredOnly !== true) {
                        const renamed = replaceNameInNarrativeText(childValue);
                        next[childKey] = renamed;
                        changed = changed || renamed !== childValue;
                        continue;
                    }
                    const rewritten = rewriteStructuredRefs(childValue, childKey);
                    next[childKey] = rewritten.value;
                    changed = changed || rewritten.changed;
                }
                return { value: next, changed };
            }

            let entriesChanged = 0;
            const entries = LibraLoreConsolidator.unpack(lorebook);
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                if (!entry || String(entry.comment || '') !== 'lmai_memory') continue;
                const payload = CompactMemoryCodec.parsePayloadFromEntry(entry);
                const meta = parseMeta(entry.content, {});
                let changed = false;
                let nextPayload = payload;
                let nextMeta = meta;
                if (payload && typeof payload === 'object') {
                    const rewrittenPayload = rewriteStructuredRefs(payload, '');
                    nextPayload = rewrittenPayload.value;
                    changed = changed || rewrittenPayload.changed;
                }
                if (meta && typeof meta === 'object') {
                    const rewrittenMeta = rewriteStructuredRefs(meta, '');
                    nextMeta = rewrittenMeta.value;
                    changed = changed || rewrittenMeta.changed;
                }
                if (!changed || !nextPayload) continue;
                try { nextMeta.recallHints = StrengthenedJaccardCore.buildRecallHints(CompactMemoryCodec.buildSearchTextFromPayload(nextPayload), { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 }); } catch (_) {}
                // meta 를 재작성했으므로 무결성 체크섬을 다시 찍는다.
                // 재스탬프가 없으면 이 기억은 getManagedEntries 의 무결성 필터에서
                // 조용히 탈락한다 (entity rename 1회로 회상 후보에서 사라진다).
                const rewrittenBody = CompactMemoryCodec.serialize(nextPayload);
                try {
                    IntegrityMetaManager.annotateMemoryMeta(nextMeta, rewrittenBody, {
                        domain: 'memory',
                        recordSchema: 'libra.memory.entry.v1',
                        recordId: String(nextMeta?.integrity?.recordId || nextMeta?.canonicalMemoryId || nextMeta?.turnKey || nextMeta?.sourceHash || nextMeta?.m_id || ''),
                        scopeKey: String(options.scopeKey || nextMeta?.integrity?.scopeKey || MemoryState?._activeScopeKey || '').trim(),
                        turn: Number(nextMeta?.t || nextMeta?.turn || 0) || 0,
                        source: String(nextMeta?.source || '')
                    });
                } catch (_) {}
                entries[i] = {
                    ...entry,
                    content: `[META:${JSON.stringify(nextMeta)}]\n${rewrittenBody}\n`
                };
                entriesChanged += 1;
            }
            if (!entriesChanged) return { changed: false, entriesChanged: 0 };
            lorebook.length = 0;
            lorebook.push(...entries);
            safeClearMemoryCache('entity_rename.hybrid_row_cache', () => MemoryState.hybridRowCache, () => MemoryState.hybridRowCache?.cache, {
                scopeKey: options.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                turn: options.currentTurn || MemoryState.currentTurn || 0
            });
            safeClearMemoryCache('entity_rename.scope_index', () => MemoryState.hmeScopeIndexByScope, null, {
                scopeKey: options.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                turn: options.currentTurn || MemoryState.currentTurn || 0
            });
            safeClearMemoryCache('entity_rename.graph_index', () => MemoryState.hmeGraphIndexByScope, null, {
                scopeKey: options.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                turn: options.currentTurn || MemoryState.currentTurn || 0
            });
            try {
                ensureHybridScopeIndex(lorebook, {
                    scopeKey: options.scopeKey || MemoryState._activeScopeKey || MemoryState._activeChatId || '',
                    currentTurn: options.currentTurn || MemoryState.currentTurn || 0,
                    force: true,
                    reason: 'entity-rename'
                });
            } catch (error) {
                if (CONFIG.debug) recordRuntimeDebug('warn', '[LIBRA][HMEIndex] entity rename rebuild failed:', error?.message || error);
            }
            return { changed: true, entriesChanged };
        };

        return {
