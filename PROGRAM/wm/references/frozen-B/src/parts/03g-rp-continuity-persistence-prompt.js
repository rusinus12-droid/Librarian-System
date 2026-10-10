        const backfillFromMemories = (lore = [], options = {}) => {
            if (!Array.isArray(lore)) return { changed: false, reason: 'invalid_lore', addedMemoryKeys: 0 };
            const existingIndex = findStateEntryIndex(lore);
            const current = loadState(lore, { migrate: false });
            const beforeKeys = new Set((current.sourceMemoryKeys || []).map(value => String(value || '').trim()).filter(Boolean));
            const beforeDigest = JSON.stringify(CATEGORY_ORDER.map(category => current[category] || []));
            const next = migrateLegacyMemories(lore, current, { maxEntries: options.maxEntries || 1200, force: options.force === true });
            const afterKeys = new Set((next.sourceMemoryKeys || []).map(value => String(value || '').trim()).filter(Boolean));
            const addedMemoryKeys = Array.from(afterKeys).filter(key => !beforeKeys.has(key)).length;
            const afterDigest = JSON.stringify(CATEGORY_ORDER.map(category => next[category] || []));
            const contentChanged = beforeDigest !== afterDigest;
            const hasAggregateSignals = CATEGORY_ORDER.some(category => Array.isArray(next[category]) && next[category].length > 0);
            if (!addedMemoryKeys && !contentChanged) return { changed: false, reason: 'up_to_date', addedMemoryKeys: 0, state: current };
            if (!hasAggregateSignals && existingIndex < 0) return { changed: false, reason: 'no_durable_signals', addedMemoryKeys, state: next };
            if (contentChanged) next.revision = Math.max(0, Number(next.revision || 0)) + 1;
            const saved = saveState(lore, next);
            return { ...saved, addedMemoryKeys, contentChanged };
        };
        const rewriteMemoryEntry = (entry = null, payload = null, meta = null) => {
            const nextMeta = { ...(meta || {}) };
            const body = CompactMemoryCodec.serialize(payload);
            // Maintenance enrichment rewrites both META and the compact payload.
            // Preserve the integrity contract by signing the final bytes instead
            // of carrying the checksum that belonged to the pre-enrichment row.
            try {
                if (typeof IntegrityMetaManager !== 'undefined' && IntegrityMetaManager?.annotateMemoryMeta) {
                    IntegrityMetaManager.annotateMemoryMeta(nextMeta, body, {
                        domain: 'memory',
                        recordSchema: 'libra.memory.entry.v1',
                        recordId: String(nextMeta.canonicalMemoryId || nextMeta.turnKey || nextMeta.sourceHash || nextMeta.m_id || '').trim(),
                        scopeKey: String(nextMeta?.integrity?.scopeKey || nextMeta.scopeKey || nextMeta.chatId || MemoryState?._activeScopeKey || '').trim(),
                        turn: Number(nextMeta.t || nextMeta.turn || nextMeta.turnAnchor || 0) || 0,
                        source: String(nextMeta.source || '').trim()
                    });
                }
            } catch (error) {
                try { recordSuppressedRuntimeError?.('rp_ltm.memory_integrity_refresh_failed', error, { turn: Number(nextMeta.t || 0) || 0 }); } catch (_) {}
            }
            return {
                ...entry,
                content: `[META:${JSON.stringify(nextMeta)}]\n${body}\n`
            };
        };
        const enrichCommittedTurn = (lore = [], turn = 0, enrichment = null, options = {}) => {
            if (!Array.isArray(lore)) return { changed: false, reason: 'invalid_lore', changedEntries: [] };
            const targetTurn = Math.max(0, Number(turn || 0) || 0);
            const normalizedIncoming = normalizeTurnMemory(enrichment || {}, {
                turn: targetTurn,
                entityRefs: options.entityRefs || [],
                source: options.source || 'maintenance_llm'
            });
            let targetIndex = -1;
            let targetPayload = null;
            for (let i = lore.length - 1; i >= 0; i--) {
                const entry = lore[i];
                if (String(entry?.comment || '') !== 'lmai_memory') continue;
                let payload = null;
                try { payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || null; } catch (_) { payload = null; }
                if (!payload || String(payload.arcKey || '') === 'world_rule_snapshot') continue;
                const entryTurn = Math.max(0, Number(payload.turn || payload.source?.turn || parseLibraMetaObject(entry.content, {}).t || 0) || 0);
                if (targetTurn > 0 && entryTurn !== targetTurn) continue;
                targetIndex = i;
                targetPayload = payload;
                break;
            }
            if (targetIndex < 0 || !targetPayload) return { changed: false, reason: 'turn_memory_not_found', changedEntries: [] };
            const heuristic = extractHeuristic(options.userText || '', options.aiText || '', {
                turn: targetTurn,
                entityRefs: options.entityRefs || targetPayload?.participants?.canonicalEntities || [],
                scene: targetPayload.scene || {}
            });
            const merged = mergeTurnMemory(targetPayload.rpLongTerm || heuristic, normalizedIncoming, {
                turn: targetTurn,
                entityRefs: options.entityRefs || [],
                source: options.source || 'maintenance_llm'
            });
            let nextPayload = {
                ...targetPayload,
                rpLongTerm: merged,
                importance: Math.max(Number(targetPayload.importance || 0), resolveImportance(merged, Number(targetPayload.importance || 5))),
                tags: dedupeTextArray([...(Array.isArray(targetPayload.tags) ? targetPayload.tags : []), ...(merged.tags || [])]).slice(0, 18)
            };
            const meta = parseLibraMetaObject(lore[targetIndex]?.content || '', {});
            const retention = getRetentionPolicy(merged, nextPayload.importance, options.config || (typeof MemoryEngine !== 'undefined' ? MemoryEngine.CONFIG : {}));
            meta.imp = Math.max(Number(meta.imp || 0), nextPayload.importance);
            meta.ttl = retention.ttl;
            meta.rpRetention = { schema: TURN_SCHEMA, protected: retention.protected, durability: retention.durability, reasons: retention.reasons };
            meta.summary = nextPayload.summary || meta.summary || '';
            try { meta.recallHints = StrengthenedJaccardCore.buildRecallHints(CompactMemoryCodec.buildSearchTextFromPayload(nextPayload), { maxTokens: 12, maxNumbers: 4, maxQuotes: 2 }); } catch (_) {}
            nextPayload = compactPayloadTurnMemory(nextPayload, merged, { turn: targetTurn });
            const rewritten = rewriteMemoryEntry(lore[targetIndex], nextPayload, meta);
            const changed = String(rewritten.content || '') !== String(lore[targetIndex]?.content || '');
            if (changed) lore[targetIndex] = rewritten;
            const aggregate = upsertFromTurn(lore, merged, {
                turn: targetTurn,
                entityRefs: options.entityRefs || [],
                source: options.source || 'maintenance_llm',
                sourceMemoryKey: (() => {
                    const raw = String(lore[targetIndex]?.key || '').trim();
                    const hm = raw.match(/^(-?\d+)(?:_|$)/);
                    if (hm) return `memory_hash:${hm[1]}`;
                    if (raw && !raw.includes('[')) return raw;
                    return `memory_hash:${TokenizerEngine.simpleHash(String(lore[targetIndex]?.content || ''))}`;
                })()
            });
            return { changed: changed || aggregate.changed, changedEntries: changed ? [rewritten] : [], aggregate, turnMemory: merged, entry: rewritten };
        };
        const entryRetentionRank = (entry = null) => {
            let payload = null;
            try { payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || null; } catch (_) { payload = null; }
            const rp = payload?.rpLongTerm;
            if (!rp || !hasSignals(rp)) {
                const meta = parseLibraMetaObject(entry?.content || '', {});
                const retention = meta?.rpRetention && typeof meta.rpRetention === 'object' ? meta.rpRetention : {};
                if (retention.protected === true || String(retention.durability || '') === 'permanent') return 3;
                if (String(retention.durability || '') === 'long') return 2;
                if (String(retention.durability || '') === 'medium') return 1;
                return 0;
            }
            const normalized = normalizeTurnMemory(rp);
            if (normalized.protected || normalized.durability === 'permanent') return 3;
            if (normalized.commitments.some(item => ACTIVE_STATUS.has(normalizeStatus(item.status))) || normalized.openLoops.some(item => ACTIVE_STATUS.has(normalizeStatus(item.status)))) return 3;
            if (normalized.durability === 'long') return 2;
            return 1;
        };
        const isEntryProtected = (entry = null) => entryRetentionRank(entry) >= 3;
        const itemVisibleForMainPrompt = (item = null, focusNames = []) => {
            if (!item) return false;
            if (item.visibility === 'secret') return false;
            if (item.visibility !== 'pov') return true;
            // A shared prompt block is visible to every character the model may
            // portray. Merely focusing an NPC must not grant that NPC access to
            // another entity's private knowledge. Character-scoped POV facts
            // belong in EntityKnowledgeVault; only user/main-request knowledge
            // is safe in this shared aggregate.
            const allowed = new Set(['user', 'player', 'main_request'].map(normalizeText));
            return (item.knownBy || []).some(name => allowed.has(normalizeText(name)));
        };
        const queryScoreItem = (item = null, query = '', focusNames = [], currentTurn = 0) => {
            if (!item) return -Infinity;
            const q = normalizeText(query);
            const qTokens = new Set(tokenize(q));
            const text = normalizeText([item.text, item.subject, item.owner, item.target, item.slot, item.kind, item.axis, item.domain, ...(item.entities || []), ...(item.pair || [])].filter(Boolean).join(' '));
            const tTokens = new Set(tokenize(text));
            let overlap = 0;
            for (const token of qTokens) if (tTokens.has(token)) overlap += 1;
            const focusHits = uniqueStrings(focusNames, 16).filter(name => text.includes(normalizeText(name))).length;
            const active = ACTIVE_STATUS.has(normalizeStatus(item.status)) ? 28 : 0;
            const permanent = item.durability === 'permanent' ? 12 : (item.durability === 'long' ? 6 : 0);
            const recency = currentTurn > 0 && Number(item.lastTurn || 0) > 0 ? Math.max(0, 8 - Math.max(0, currentTurn - Number(item.lastTurn || 0)) / 12) : 0;
            return (overlap * 4.5) + (focusHits * 8) + active + permanent + (Number(item.importance || 0) * 1.6) + (Number(item.confidence || 0) * 3) + recency;
        };
        const formatForPrompt = (lore = [], options = {}) => {
            if (!Array.isArray(lore)) return '';
            const state = loadState(lore, { migrate: true });
            const query = String(options.query || '').trim();
            const focusNames = uniqueStrings(options.focusNames || [], 16);
            const maxChars = Math.max(700, Math.min(8000, Number(options.maxChars || 2600) || 2600));
            const currentTurn = Math.max(0, Number(options.currentTurn || (typeof MemoryEngine !== 'undefined' ? MemoryEngine.getCurrentTurn?.() : 0) || 0) || 0);
            const categoryLabels = {
                stableFacts: 'Stable Canon Facts / 고정 사실',
                preferences: 'Preferences & Boundaries / 취향·경계',
                commitments: 'Active Commitments / 약속',
                openLoops: 'Open Threads / 미해결 과제',
                relationshipMilestones: 'Relationship Milestones / 관계 이정표',
                stateChanges: 'Durable State Changes / 지속 상태 변화',
                callbacks: 'Callback Anchors / 회수할 상징',
                episodes: 'Key Episodes / 핵심 에피소드'
            };
            const perCategoryLimits = { stableFacts: 4, preferences: 3, commitments: 4, openLoops: 4, relationshipMilestones: 4, stateChanges: 3, callbacks: 3, episodes: 2 };
            // 리롤·롤백된 턴의 아이템을 뺀다 — 기억은 13c 가 거르지만 RP 장기 연속성은
            //   로어에서 직접 읽어 나가 같은 필터를 안 탔다(실측). 옵션으로 상태를 받는다.
            const rpWorldlineState = options.worldlineState && typeof options.worldlineState === 'object'
                ? options.worldlineState : null;
            const rpFilter = (items = []) => {
                if (!rpWorldlineState) return { items, excluded: 0, excludedTurns: [] };
                try {
                    const fn = (typeof LibraTurnWorldline !== 'undefined' && LibraTurnWorldline?.filterSupersededRpItems)
                        || (typeof globalThis !== 'undefined' && globalThis.LibraTurnWorldline?.filterSupersededRpItems);
                    if (typeof fn !== 'function') return { items, excluded: 0, excludedTurns: [] };
                    return fn(items, rpWorldlineState);
                } catch (_) { return { items, excluded: 0, excludedTurns: [] }; }
            };
            const lines = [
                '[RP Long-Term Continuity / RP 장기 연속성]',
                'Use these consolidated continuity records as durable reference data. The latest explicit user turn and manual lorebook corrections override them.',
                'Do not reveal hidden or POV-restricted facts merely because they exist. Preserve unresolved promises, goals, relationship consequences, and stable preferences until explicitly changed or resolved.'
            ];
            // 주입에서 'episodes' 를 뺀다 — 그 카테고리는 다른 카테고리의 문장을 **재조합**해
            // 만들어진다(실측: stableFacts·commitments·관계 이정표가 한 줄로 다시 나와
            // 같은 문장이 블록 안에서 2번, 정본 기억과 합치면 3번 반복됐다).
            // 원문 회상은 [관련 기억] 슬롯이 담당하므로 정보 손실 없이 중복만 사라진다.
            const PROMPT_EXCLUDED_CATEGORIES = new Set(['episodes']);
            for (const category of CATEGORY_ORDER) {
                if (PROMPT_EXCLUDED_CATEGORIES.has(category)) continue;
                const selected = rpFilter(state[category] || []).items
                    .filter(item => itemVisibleForMainPrompt(item, focusNames))
                    .filter(item => {
                        if (category === 'commitments' || category === 'openLoops') return !CLOSED_STATUS.has(normalizeStatus(item.status)) || queryScoreItem(item, query, focusNames, currentTurn) >= 20;
                        return true;
                    })
                    .map(item => ({ item, score: queryScoreItem(item, query, focusNames, currentTurn) }))
                    .sort((a, b) => b.score - a.score || Number(b.item.lastTurn || 0) - Number(a.item.lastTurn || 0))
                    .slice(0, perCategoryLimits[category] || 3)
                    .map(({ item }) => item);
                if (!selected.length) continue;
                lines.push(`\n[${categoryLabels[category]}]`);
                for (const item of selected) {
                    const refs = uniqueStrings(item.pair?.length ? item.pair : item.entities, 4);
                    const status = (category === 'commitments' || category === 'openLoops') ? ` status=${normalizeStatus(item.status)}` : '';
                    const turnLabel = Number(item.lastTurn || 0) > 0 ? ` turn=${Number(item.lastTurn)}` : '';
                    const refLabel = refs.length ? ` (${refs.join(' ↔ ')})` : '';
                    lines.push(`- ${clip(item.text || item.summary || '', 360)}${refLabel}${status}${turnLabel}`);
                }
            }
            if (lines.length <= 3) return '';
            let text = lines.join('\n');
            try {
                if (typeof SecretKnowledgeCore !== 'undefined' && SecretKnowledgeCore?.redactForViewer) {
                    text = SecretKnowledgeCore.redactForViewer(text, 'main_request');
                }
            } catch (_) {}
            return truncateForLLM(text, maxChars, '\n...[RP LONG-TERM CONTINUITY TRUNCATED]...\n');
        };
        const renameEntityReferences = (lore = [], oldName = '', newName = '') => {
            if (!Array.isArray(lore)) return { changed: false };
            const oldKey = normalizeText(oldName);
            const replacement = normalizeEntity(newName);
            if (!oldKey || !replacement) return { changed: false };
            const state = loadState(lore, { migrate: false });
            let changed = false;
            const replace = (value = '') => normalizeText(value) === oldKey ? replacement : String(value || '').trim();
            for (const category of CATEGORY_ORDER) {
                state[category] = (state[category] || []).map(item => {
                    const next = { ...item };
                    const scalarKeys = ['subject', 'owner', 'target', 'entity'];
                    for (const key of scalarKeys) {
                        if (typeof next[key] === 'string') {
                            const value = replace(next[key]);
                            if (value !== next[key]) changed = true;
                            next[key] = value;
                        }
                    }
                    for (const key of ['entities', 'pair', 'knownBy', 'unknownTo']) {
                        if (!Array.isArray(next[key])) continue;
                        const values = uniqueStrings(next[key].map(replace), key === 'pair' ? 2 : 12);
                        if (JSON.stringify(values) !== JSON.stringify(next[key])) changed = true;
                        next[key] = values;
                    }
                    return next;
                });
            }
            if (!changed) return { changed: false, state };
            state.revision = Number(state.revision || 0) + 1;
            return { ...saveState(lore, state), changed: true };
        };
        return Object.freeze({
            COMMENT,
            KEY,
            SCHEMA,
            TURN_SCHEMA,
            normalizeTurnMemory,
            mergeTurnMemory,
            extractHeuristic,
            attachToPayload,
            flattenForSearch,
            formatTurnForDisplay,
            buildTurnMemoryRef,
            compactPayloadTurnMemory,
            hasSignals,
            resolveImportance,
            getRetentionPolicy,
            loadState,
            saveState,
            upsertFromTurn,
            backfillFromMemories,
            enrichCommittedTurn,
            entryRetentionRank,
            isEntryProtected,
            formatForPrompt,
            renameEntityReferences
        });
    })();

