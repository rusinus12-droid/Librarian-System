        const COLD_START_BASELINE_MEMORY_MAX_ROWS = 64;
        const buildColdStartReplayableTurnPairs = (msgs, chat = null) => {
            const pairs = [];
            const source = Array.isArray(msgs) ? msgs : [];
            let pendingUser = null;
            let pendingAssistantParts = [];
            let pendingAssistantMsgs = [];
            let turn = 0;
            const flushPendingPair = () => {
                if (!pendingUser || pendingAssistantParts.length === 0) {
                    pendingAssistantParts = [];
                    pendingAssistantMsgs = [];
                    return;
                }
                const aiText = pendingAssistantParts.join('\n\n').trim();
                if (!aiText) {
                    pendingAssistantParts = [];
                    pendingAssistantMsgs = [];
                    return;
                }
                const userText = String(
                    getStrictNarrativeUserText(pendingUser.text || Utils.getMessageText(pendingUser.msg) || '')
                    || Utils.getMemorySourceText(pendingUser.text || Utils.getMessageText(pendingUser.msg) || '')
                    || ''
                ).trim();
                if (!userText && !aiText) {
                    pendingAssistantParts = [];
                    pendingAssistantMsgs = [];
                    return;
                }
                const combined = `${userText}\n${aiText}`.trim();
                if (Utils.shouldExcludeStoredMemoryContent(aiText)) {
                    pendingAssistantParts = [];
                    pendingAssistantMsgs = [];
                    return;
                }
                const normalizedTurn = normalizeLegacyMemoryTurnAnchor(pendingUser.turn || pairs.length + 1) || pairs.length + 1;
                const sourceHash = TokenizerEngine.simpleHash(aiText || combined);
                const primaryAssistant = pendingAssistantMsgs[pendingAssistantMsgs.length - 1] || pendingAssistantMsgs[0] || null;
                const primaryAssistantMsg = primaryAssistant?.msg || null;
                const primaryIndex = Number.isFinite(Number(primaryAssistant?.index)) ? Number(primaryAssistant.index) : pendingUser.index;
                const stableMessageId = getNarrativeMessageStableId(chat, primaryAssistantMsg, { indexHint: primaryIndex, aiText })
                    || getLiveMessageId(primaryAssistantMsg)
                    || buildAfterRequestSyntheticMessageId(chat, normalizedTurn, sourceHash);
                const liveMessageIds = normalizeCanonicalMessageIds([
                    stableMessageId,
                    ...pendingAssistantMsgs.map(item => getLiveMessageId(item?.msg)),
                    getLiveMessageId(pendingUser.msg)
                ]);
                const messageSignature = compactTurnMessageSignature(getMessageSignature(primaryAssistantMsg) || `ai::cold-start::${normalizedTurn}::${sourceHash}`);
                const userTurnKey = buildLogicalUserTurnKey(userText, userText, false);
                const turnKey = buildCanonicalTurnKey(chat?.id || '', userTurnKey, sourceHash, messageSignature, liveMessageIds);
            pairs.push({
                turn: normalizedTurn,
                userText,
                aiText,
                canonicalEvidenceText: aiText,
                userRequestMetadata: '',
                combined,
                    sourceHash,
                    messageSignature,
                    userTurnKey,
                    turnKey,
                    liveMessageIds,
                    sourceMessageIds: liveMessageIds,
                    messageId: stableMessageId,
                    userMsg: pendingUser.msg || null,
                    aiMsg: primaryAssistantMsg,
                    assistantMsgs: pendingAssistantMsgs.map(item => item?.msg).filter(Boolean),
                    index: primaryIndex
                });
                pendingUser = null;
                pendingAssistantParts = [];
                pendingAssistantMsgs = [];
            };
            for (let i = 0; i < source.length; i++) {
                const item = source[i];
                const msg = item?.msg || item;
                if (!msg) continue;
                const isUser = getMessageRoleHint(item) === 'user';
                const rawText = Utils.getMessageText(msg);
                if (isUser) {
                    flushPendingPair();
                    turn += 1;
                    pendingUser = { item, msg, index: i, text: item?.text || rawText || '', turn };
                    continue;
                }
                const analysisText = item?.text || rawText || '';
                const aiText = String(
                    Utils.getNarrativeComparableText(analysisText, 'ai')
                    || Utils.getMemorySourceText(analysisText)
                    || ''
                ).trim();
                if (!aiText) continue;
                if (!pendingUser) continue;
                pendingAssistantParts.push(aiText);
                pendingAssistantMsgs.push({ msg, index: i });
            }
            flushPendingPair();
            return pairs;
        };
        const scoreColdStartMemoryPair = (pair = {}) => {
            const text = String(pair.aiText || pair.canonicalEvidenceText || '');
            let score = 1;
            if (text.length >= 120) score += 1;
            if (String(pair.aiText || '').trim()) score += 1;
            if (Array.isArray(pair.sourceMessageIds) && pair.sourceMessageIds.length > 0) score += 1;
            return score;
        };
        const selectColdStartMemoryPairs = (pairs = [], maxRows = COLD_START_BASELINE_MEMORY_MAX_ROWS) => {
            const source = Array.isArray(pairs) ? pairs.filter(Boolean) : [];
            const limit = Math.max(16, Math.min(COLD_START_BASELINE_MEMORY_MAX_ROWS, Number(maxRows || COLD_START_BASELINE_MEMORY_MAX_ROWS) || COLD_START_BASELINE_MEMORY_MAX_ROWS));
            if (source.length <= limit) return source.map(pair => ({ ...pair, _coldStartScore: scoreColdStartMemoryPair(pair) }));
            const scored = source
                .map(pair => ({ ...pair, _coldStartScore: scoreColdStartMemoryPair(pair) }))
                .sort((a, b) => Number(b._coldStartScore || 0) - Number(a._coldStartScore || 0) || Number(a.turn || 0) - Number(b.turn || 0));
            const selected = new Map();
            const add = (pair) => {
                if (!pair || selected.size >= limit) return;
                const key = pair.turnKey || `${pair.turn}:${pair.sourceHash}:${pair.index}`;
                if (!selected.has(key)) selected.set(key, pair);
            };
            const topLimit = Math.max(12, Math.floor(limit * 0.45));
            const recentLimit = Math.max(8, Math.floor(limit * 0.15));
            scored.slice(0, topLimit).forEach(add);
            source.slice(-recentLimit).forEach(add);
            const remaining = Math.max(0, limit - selected.size);
            if (remaining > 0) {
                const stride = Math.max(1, source.length / remaining);
                for (let i = 0; i < remaining; i++) {
                    add(source[Math.min(source.length - 1, Math.floor(i * stride))]);
                }
            }
            for (const pair of scored) {
                if (selected.size >= limit) break;
                add(pair);
            }
            return Array.from(selected.values()).sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0));
        };
        const buildColdStartSummaryMemoryPayload = (pair = {}, options = {}) => {
            const importance = Number(options.importance || 6) || 6;
            const basePayload = CompactMemoryCodec.buildTurnPayload('', pair.aiText || '', {
                turn: pair.turn,
                firstSeenTurn: pair.turn,
                importance,
                impression: options.impression,
                sourceHash: pair.sourceHash,
                sourceMessageIds: pair.sourceMessageIds,
                knownEntityNames: options.knownEntityNames || [],
                source: 'cold_start_summary'
            });
            if (!basePayload) return null;
            const brief = compactColdStartText(
                NarrativeTracker?.buildHeuristicTurnBrief?.('', pair.aiText || '')
                || basePayload.summary
                || pair.aiText
                || '',
                320
            );
            if (!brief) return null;
            const entityRefs = Array.isArray(basePayload.mentionedEntityNames)
                ? basePayload.mentionedEntityNames
                : (Array.isArray(options.knownEntityNames) ? options.knownEntityNames.filter(name => String(pair.aiText || '').includes(name)) : []);
            basePayload.summary = brief;
            basePayload.summaryV2 = {
                oneLine: brief,
                continuity: '',
                recall: brief
            };
            basePayload.directEvidenceSnippets = [];
            basePayload.evidenceRecords = [];
            basePayload.facts = [{
                id: `fact.${normalizeLegacyMemoryTurnAnchor(pair.turn) || 0}.summary.${TokenizerEngine.simpleHash(brief)}`,
                type: 'scene_summary',
                text: brief,
                entities: entityRefs.slice(0, 8),
                subjects: entityRefs.slice(0, 8),
                observerEntities: entityRefs.slice(0, 8),
                evidence: [],
                confidence: 0.72,
                importance: Math.max(0.1, Math.min(1, importance / 10))
            }];
            basePayload.beats = [];
            basePayload.recallAnchors = [{
                summary: compactColdStartText(brief, 180),
                hint: compactColdStartText(entityRefs.slice(0, 6).join(' / '), 180),
                entityRefs: entityRefs.slice(0, 6),
                confidence: 0.72
            }];
            basePayload.rawRetention = 'summary_only_with_turn_record_reference';
            basePayload.rawDiscarded = true;
            return basePayload;
        };
        const buildColdStartAnchorMeta = (pair = {}, chat = null, options = {}) => {
            const turn = normalizeLegacyMemoryTurnAnchor(pair.turn) || 1;
            const sourceHash = String(pair.sourceHash || TokenizerEngine.simpleHash(pair.aiText || pair.combined || '')).trim();
            const sourceMessageIds = normalizeCanonicalMessageIds(pair.sourceMessageIds || pair.liveMessageIds || pair.messageId);
            const messageSignature = String(pair.messageSignature || '').trim();
            const userTurnKey = String(pair.userTurnKey || buildLogicalUserTurnKey(pair.userText, pair.userText, false)).trim();
            const turnKey = String(pair.turnKey || buildCanonicalTurnKey(chat?.id || '', userTurnKey, sourceHash, messageSignature, sourceMessageIds)).trim();
            const canonicalFactSlot = normalizeCanonicalFactSlot(options.canonicalFactSlot || 'turn_summary');
            const canonicalMemoryId = buildCanonicalMemoryId(
                chat?.id || '',
                getPrimaryCanonicalMessageId(sourceMessageIds, true) || pair.messageId || '',
                canonicalFactSlot,
                { turnKey, sourceHash, turn }
            );
            return {
                t: turn,
                turn,
                firstTurn: turn,
                originalTurn: turn,
                lockedTurn: turn,
                finalizedTurn: turn,
                turnAnchorTurn: turn,
                turnAnchor: turn,
                turnLocked: true,
                turnAnchorReason: String(options.turnAnchorReason || 'cold-start-baseline-hydration'),
                sourceMessageIds,
                liveMessageIds: normalizeCanonicalMessageIds(pair.liveMessageIds || sourceMessageIds),
                m_id: getPrimaryCanonicalMessageId(sourceMessageIds, true) || pair.messageId || '',
                messageId: getPrimaryCanonicalMessageId(sourceMessageIds, true) || pair.messageId || '',
                sourceHash,
                aiHash: sourceHash,
                responseHash: sourceHash,
                userTurnKey,
                turnKey,
                canonicalFactSlot,
                canonicalMemoryId,
                provenanceStatus: 'active',
                sourceRevision: 1,
                validFrom: turn,
                validTo: null,
                messageSignature,
                messageCount: Number(pair.index || 0) + 1,
                liveOrder: Number(pair.index || 0) + 1,
                chatId: String(chat?.id || '').trim(),
                runtimeMode: 'cold-start-baseline',
                runtimeReliability: 'historical-replay',
                source: 'cold_start_baseline',
                s_id: String(options.sourceId || 'baseline')
            };
        };
        const ensureColdStartNarrativeTurnCoverage = (options = {}) => {
            const state = NarrativeTracker.getState?.();
            if (!state || typeof state !== 'object') return { skipped: true, reason: 'missing_state' };
            const turnLog = (Array.isArray(state.turnLog) ? state.turnLog : [])
                .map(entry => ({ ...entry, turn: normalizeLegacyMemoryTurnAnchor(entry?.turn || 0) }))
                .filter(entry => entry.turn > 0)
                .sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0));
            if (turnLog.length === 0) return { skipped: true, reason: 'empty_turn_log' };

            const nextState = safeClone(state);
            nextState.storylines = Array.isArray(nextState.storylines) ? nextState.storylines : [];
            const maxTurn = Math.max(
                Number(options.maxTurn || 0),
                ...turnLog.map(entry => Number(entry.turn || 0)).filter(Boolean)
            );
            const fallbackEntities = dedupeTextArray(options.entityNames || []).slice(0, 12);
            if (nextState.storylines.length === 0) {
                nextState.storylines.push({
                    id: 1,
                    name: 'Cold Start Timeline',
                    arcKey: 'cold_start_timeline',
                    phase: '',
                    primaryConflict: '',
                    entities: [...fallbackEntities],
                    turns: [],
                    firstTurn: 0,
                    lastTurn: 0,
                    recentEvents: [],
                    summaries: [],
                    currentContext: '',
                    keyPoints: [],
                    ongoingTensions: [],
                    meta: { manualLocked: false, manualLockedAt: 0, baseline: true, sourceId: options.sourceId || 'baseline' }
                });
            }

            const primary = nextState.storylines.find(storyline => storyline?.meta?.baseline === true)
                || nextState.storylines.find(storyline => /imported|canonical|cold start|timeline|현재 장면/i.test(String(storyline?.name || storyline?.arcKey || '')))
                || nextState.storylines[0];
            primary.turns = Array.isArray(primary.turns) ? primary.turns.map(normalizeLegacyMemoryTurnAnchor).filter(Boolean) : [];
            primary.recentEvents = Array.isArray(primary.recentEvents) ? primary.recentEvents : [];
            primary.entities = dedupeTextArray([...(Array.isArray(primary.entities) ? primary.entities : []), ...fallbackEntities]).slice(0, 20);

            const coveredTurns = new Set(nextState.storylines.flatMap(storyline =>
                (Array.isArray(storyline?.turns) ? storyline.turns : []).map(normalizeLegacyMemoryTurnAnchor).filter(Boolean)
            ));
            let addedTurns = 0;
            for (const entry of turnLog) {
                if (!coveredTurns.has(entry.turn)) {
                    primary.turns.push(entry.turn);
                    coveredTurns.add(entry.turn);
                    addedTurns += 1;
                }
                const brief = compactColdStartText(entry.lastDistinctEvent || entry.responseBrief || entry.summary || entry.response || '', 220);
                if (brief && !primary.recentEvents.some(event => Number(event?.turn || 0) === Number(entry.turn || 0))) {
                    primary.recentEvents.push({ turn: entry.turn, brief, arcKey: primary.arcKey || '' });
                }
            }

            primary.turns = Array.from(new Set(primary.turns.map(normalizeLegacyMemoryTurnAnchor).filter(Boolean))).sort((a, b) => a - b);
            primary.firstTurn = primary.turns[0] || 0;
            primary.lastTurn = primary.turns[primary.turns.length - 1] || 0;
            primary.recentEvents = primary.recentEvents
                .filter(event => normalizeLegacyMemoryTurnAnchor(event?.turn || 0) > 0 && String(event?.brief || '').trim())
                .sort((a, b) => Number(a.turn || 0) - Number(b.turn || 0))
                .slice(-10);
            if (Array.isArray(primary.summaries)) {
                primary.summaries = primary.summaries.map(summary => {
                    if (summary?.baseline === true && Number(summary?.upToTurn || 0) < maxTurn) {
                        return { ...summary, upToTurn: maxTurn };
                    }
                    return summary;
                });
            }
            nextState.lastSummaryTurn = Math.max(Number(nextState.lastSummaryTurn || 0), maxTurn);
            NarrativeTracker.resetState(nextState);
            return {
                skipped: false,
                turnLogCount: turnLog.length,
                storylineCount: nextState.storylines.length,
                addedTurns,
                maxTurn
            };
        };
        const flattenColdStartIds = (items = []) => {
            const out = [];
            const visit = (value) => {
                if (value == null) return;
                if (Array.isArray(value)) {
                    value.forEach(visit);
                    return;
                }
                const text = String(value || '').trim();
                if (text) out.push(text);
            };
            visit(items);
            return out;
        };
        const buildColdStartMemoryFingerprints = (parts = {}) => {
            const turn = normalizeLegacyMemoryTurnAnchor(parts.turn || parts.t || parts.finalizedTurn || parts.turnAnchorTurn || 0) || 0;
            const sourceHash = String(parts.sourceHash || parts.aiHash || parts.responseHash || '').trim();
            const turnKey = String(parts.turnKey || '').trim();
            const userTurnKey = String(parts.userTurnKey || '').trim();
            const messageSignature = compactTurnMessageSignature(parts.messageSignature || '');
            const canonicalMemoryId = String(parts.canonicalMemoryId || '').trim();
            const ids = normalizeCanonicalMessageIds(flattenColdStartIds([
                parts.sourceMessageIds,
                parts.liveMessageIds,
                parts.m_id,
                parts.messageId
            ]));
            const keys = [];
            if (canonicalMemoryId) keys.push(`canonicalMemoryId:${canonicalMemoryId}`);
            if (turnKey) keys.push(`turnKey:${turnKey}`);
            if (sourceHash) keys.push(`sourceHash:${sourceHash}`);
            if (turn && sourceHash) keys.push(`turnSource:${turn}:${sourceHash}`);
            if (turn && messageSignature) keys.push(`turnSignature:${turn}:${messageSignature}`);
            if (userTurnKey && sourceHash) keys.push(`userSource:${userTurnKey}:${sourceHash}`);
            ids.forEach(id => keys.push(`messageId:${id}`));
            return dedupeTextArray(keys);
        };
        const collectExistingColdStartMemoryFingerprints = (lore = []) => {
            const keys = new Set();
            const memoryKeyByFingerprint = new Map();
            const add = (fingerprint, memoryKey = '') => {
                const key = String(fingerprint || '').trim();
                if (!key) return;
                keys.add(key);
                if (memoryKey && !memoryKeyByFingerprint.has(key)) memoryKeyByFingerprint.set(key, memoryKey);
            };
            const entries = LibraLoreConsolidator.unpack(Array.isArray(lore) ? lore : []).filter(entry => String(entry?.comment || '').trim() === 'lmai_memory');
            for (const entry of entries) {
                const entryKey = entry?.key || TokenizerEngine.getSafeMapKey(entry?.content || '');
                const meta = parseLibraMetaObject(entry?.content || '', {});
                const payload = CompactMemoryCodec.parsePayloadFromEntry(entry);
                const payloadSource = payload?.source && typeof payload.source === 'object' ? payload.source : {};
                const fingerprints = buildColdStartMemoryFingerprints({
                    turn: payload?.turn || payloadSource.turn || meta.turn || meta.t,
                    finalizedTurn: meta.finalizedTurn,
                    turnAnchorTurn: meta.turnAnchorTurn,
                    sourceHash: payload?.sourceHash || payloadSource.sourceHash || meta.sourceHash,
                    aiHash: meta.aiHash,
                    responseHash: meta.responseHash,
                    turnKey: meta.turnKey,
                    canonicalMemoryId: meta.canonicalMemoryId || payload?.canonicalMemoryId || payloadSource.canonicalMemoryId,
                    userTurnKey: meta.userTurnKey,
                    messageSignature: meta.messageSignature,
                    sourceMessageIds: [
                        payload?.sourceMessageIds,
                        payloadSource.sourceMessageIds,
                        meta.sourceMessageIds,
                        meta.liveMessageIds
                    ],
                    liveMessageIds: meta.liveMessageIds,
                    m_id: meta.m_id,
                    messageId: meta.messageId
                });
                fingerprints.forEach(fingerprint => add(fingerprint, entryKey));
            }
            return { keys, memoryKeyByFingerprint };
        };
        const findColdStartMemoryIndexByCanonicalId = (lore = [], canonicalMemoryId = '') => {
            const target = String(canonicalMemoryId || '').trim();
            if (!target || !Array.isArray(lore)) return -1;
            for (let i = 0; i < lore.length; i += 1) {
                const entry = lore[i];
                if (String(entry?.comment || '').trim() !== 'lmai_memory') continue;
                const meta = parseLibraMetaObject(entry?.content || '', {});
                if (String(meta?.canonicalMemoryId || '').trim() === target) return i;
            }
            return -1;
        };
        const hydrateColdStartBaselineMemory = async (sanitized, options = {}) => {
            const lore = Array.isArray(options.lore) ? options.lore : null;
            const chat = options.chat || null;
            const char = options.char || null;
            const sourceMessages = Array.isArray(options.sourceMessages) ? options.sourceMessages : [];
            const hydrationDisabled = options.hydrateBaselineMemory === false;
            if (!lore || !chat || sourceMessages.length === 0 || hydrationDisabled) {
                return { skipped: true, reason: !sourceMessages.length ? 'no_source_messages' : 'disabled_or_missing_context' };
            }
            const hydrateWorldMemory = options.hydrateWorldMemory !== false;
            let pairs = buildColdStartReplayableTurnPairs(sourceMessages, chat);
            let userOnlyFallback = false;
            if (pairs.length === 0) userOnlyFallback = false;
            if (pairs.length === 0) return { skipped: true, reason: 'no_turn_pairs' };

            const existingMemoryCount = MemoryEngine.getManagedEntries(lore).length;
            const maxRows = Math.max(16, Math.min(
                COLD_START_BASELINE_MEMORY_MAX_ROWS,
                Math.floor(Number(MemoryEngine.CONFIG?.maxLimit || COLD_START_BASELINE_MEMORY_MAX_ROWS) * 0.55) || COLD_START_BASELINE_MEMORY_MAX_ROWS
            ));
            const selectedPairs = selectColdStartMemoryPairs(pairs, maxRows);
            const selectedKeys = new Set(selectedPairs.map(pair => pair.turnKey || `${pair.turn}:${pair.sourceHash}:${pair.index}`));
            const entityNames = dedupeTextArray([
                ...(Array.isArray(sanitized?.entities) ? sanitized.entities.map(entity => entity?.name).filter(Boolean) : []),
                ...Array.from(EntityManager.getEntityCache?.().values?.() || []).map(entity => entity?.name).filter(Boolean)
            ]).slice(0, 80);
            const addedMemories = [];
            const memoryKeyByTurnKey = new Map();
            const existingFingerprints = collectExistingColdStartMemoryFingerprints(lore);
            let skippedExistingMemoryCount = 0;
            let maxTurn = 0;

            for (const pair of selectedPairs) {
                maxTurn = Math.max(maxTurn, normalizeLegacyMemoryTurnAnchor(pair.turn) || 0);
                const score = Number(pair._coldStartScore || scoreColdStartMemoryPair(pair) || 0);
                const importance = Math.max(5, Math.min(9, 5 + Math.floor(score / 4)));
                const anchorMeta = buildColdStartAnchorMeta(pair, chat, { sourceId: options.sourceId });
                const pairFingerprints = buildColdStartMemoryFingerprints({
                    ...anchorMeta,
                    turn: pair.turn,
                    sourceHash: pair.sourceHash,
                    turnKey: pair.turnKey || anchorMeta.turnKey,
                    canonicalMemoryId: anchorMeta.canonicalMemoryId,
                    userTurnKey: pair.userTurnKey || anchorMeta.userTurnKey,
                    messageSignature: pair.messageSignature || anchorMeta.messageSignature,
                    sourceMessageIds: [pair.sourceMessageIds, anchorMeta.sourceMessageIds],
                    liveMessageIds: [pair.liveMessageIds, anchorMeta.liveMessageIds],
                    m_id: anchorMeta.m_id,
                    messageId: pair.messageId || anchorMeta.messageId
                });
                const existingMemoryKey = pairFingerprints
                    .map(fingerprint => existingFingerprints.memoryKeyByFingerprint.get(fingerprint))
                    .find(Boolean) || '';
                if (pairFingerprints.some(fingerprint => existingFingerprints.keys.has(fingerprint))) {
                    skippedExistingMemoryCount += 1;
                    if (pair.turnKey && existingMemoryKey) memoryKeyByTurnKey.set(pair.turnKey, existingMemoryKey);
                    continue;
                }
                const payload = buildColdStartSummaryMemoryPayload(pair, {
                    importance,
                    impression: Math.max(0.55, Math.min(0.9, 0.55 + score * 0.035)),
                    knownEntityNames: entityNames
                });
                if (!payload) continue;
                const newMemory = await MemoryEngine.prepareMemory(
                    { content: CompactMemoryCodec.serialize(payload), importance, forceCreate: true },
                    pair.turn,
                    lore,
                    lore,
                    char,
                    chat,
                    anchorMeta.m_id || null,
                    anchorMeta
                );
                if (!newMemory) continue;
                forceMemoryTurnAnchor(newMemory, anchorMeta);
                lore.push(newMemory);
                addedMemories.push(newMemory);
                const memoryKey = newMemory.key || TokenizerEngine.getSafeMapKey(newMemory.content || '');
                if (pair.turnKey) memoryKeyByTurnKey.set(pair.turnKey, memoryKey);
                pairFingerprints.forEach(fingerprint => {
                    existingFingerprints.keys.add(fingerprint);
                    if (memoryKey && !existingFingerprints.memoryKeyByFingerprint.has(fingerprint)) {
                        existingFingerprints.memoryKeyByFingerprint.set(fingerprint, memoryKey);
                    }
                });
            }

            for (const pair of pairs) {
                maxTurn = Math.max(maxTurn, normalizeLegacyMemoryTurnAnchor(pair.turn) || 0);
                const anchorMeta = buildColdStartAnchorMeta(pair, chat, { sourceId: options.sourceId });
                const involvedEntities = entityNames.filter(name => name && String(pair.aiText || '').includes(name)).slice(0, 8);
                await NarrativeTracker.recordTurn(pair.turn, '', pair.aiText, involvedEntities, MemoryEngine.CONFIG, {
                    anchorMeta,
                    channel: 'scene'
                });
                TurnRecordLedger.upsertRecord(lore, {
                    ...anchorMeta,
                    userPreview: String(pair.userText || pair.userMsg || '').replace(/\s+/g, ' ').trim().slice(0, 90),
                    aiPreview: pair.aiText || '',
                    memoryKey: memoryKeyByTurnKey.get(pair.turnKey) || '',
                    status: 'active',
                    reason: selectedKeys.has(pair.turnKey || `${pair.turn}:${pair.sourceHash}:${pair.index}`)
                        ? 'cold-start-baseline-memory'
                        : 'cold-start-baseline-turn'
                }, chat, char);
            }
            const narrativeCoverage = ensureColdStartNarrativeTurnCoverage({
                entityNames,
                maxTurn,
                sourceId: options.sourceId
            });
            if (MemoryEngine.CONFIG.debug && narrativeCoverage && narrativeCoverage.skipped !== true) {
                recordRuntimeDebug('log', '[LIBRA] Cold-start narrative coverage:', narrativeCoverage);
            }

            let worldMemoryDecision = { create: false, reason: hydrateWorldMemory ? 'not_evaluated' : 'hydrate_world_memory_disabled' };
            if (hydrateWorldMemory) {
                const lastReplayPair = pairs[pairs.length - 1] || null;
                const worldAnchorMessageId = getPrimaryCanonicalMessageId(
                    normalizeCanonicalMessageIds(lastReplayPair?.sourceMessageIds || lastReplayPair?.liveMessageIds || lastReplayPair?.messageId),
                    true
                ) || '';
                const currentWorldNode = HierarchicalWorldManager.getCurrentNode?.();
                const currentWorldRules = HierarchicalWorldManager.getCurrentRules?.();
                const currentWorldProfile = HierarchicalWorldManager.getProfile?.();
                const worldMemoryContent = buildWorldRecallMemoryContent(currentWorldNode?.meta || {}, currentWorldRules || {}, {
                    turn: maxTurn || pairs.length,
                    importance: 7,
                    sourceHash: stableHash(JSON.stringify(sanitized?.world || {})),
                    sourceMessageIds: [],
                    activePath: currentWorldProfile?.activePath || []
                });
                const worldMemoryPayload = worldMemoryContent ? (CompactMemoryCodec.parsePayloadFromContent(worldMemoryContent) || null) : null;
                worldMemoryDecision = worldMemoryContent
                    ? shouldCreateWorldRecallMemorySnapshot(lore, worldMemoryPayload, { turn: maxTurn || pairs.length })
                    : { create: false, reason: 'empty_content' };
                if (worldMemoryContent && worldMemoryDecision.create) {
                    const worldTurn = maxTurn || pairs.length;
                    const worldSourceHash = worldMemoryPayload?.sourceHash || stableHash(worldMemoryContent);
                    const anchorMeta = {
                        turn: worldTurn,
                        turnAnchorTurn: worldTurn,
                        finalizedTurn: worldTurn,
                        sourceHash: worldSourceHash,
                        canonicalFactSlot: 'world_snapshot',
                        canonicalMemoryId: buildCanonicalMemoryId(chat?.id || '', worldAnchorMessageId, 'world_snapshot', { sourceHash: worldSourceHash, turn: worldTurn }),
                        provenanceStatus: 'active',
                        sourceRevision: 1,
                        validFrom: worldTurn,
                        validTo: null,
                        sourceMessageIds: [],
                        turnAnchorReason: 'cold-start-world-memory'
                    };
                    const worldMemory = await MemoryEngine.prepareMemory(
                        { content: worldMemoryContent, importance: 7, forceCreate: true },
                        maxTurn || pairs.length,
                        lore,
                        lore,
                        char,
                        chat,
                        null,
                        anchorMeta
                    );
                    if (worldMemory) {
                        forceMemoryTurnAnchor(worldMemory, anchorMeta);
                        const existingWorldIndex = findColdStartMemoryIndexByCanonicalId(lore, anchorMeta.canonicalMemoryId);
                        if (existingWorldIndex >= 0) lore[existingWorldIndex] = worldMemory;
                        else lore.push(worldMemory);
                        addedMemories.push(worldMemory);
                        worldMemoryDecision = {
                            ...worldMemoryDecision,
                            mode: existingWorldIndex >= 0 ? 'canonical_replace' : 'append',
                            canonicalMemoryId: anchorMeta.canonicalMemoryId
                        };
                    }
                }
            }

            if (addedMemories.length > 0) {
                MemoryEngine.ensureHybridScopeIndex?.(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    currentTurn: maxTurn || pairs.length,
                    force: true,
                    reason: 'cold-start-baseline-hydration-reconcile'
                });
            } else {
                MemoryEngine.ensureHybridScopeIndex?.(lore, {
                    scopeKey: getChatRuntimeScopeKey(chat, char),
                    currentTurn: maxTurn || pairs.length,
                    force: true,
                    reason: 'cold-start-empty-hydration'
                });
            }
            if (maxTurn > 0) MemoryEngine.setTurn(maxTurn);
            await NarrativeTracker.summarizeIfNeeded(maxTurn || pairs.length);
            await NarrativeTracker.saveState(lore);
            await StoryAuthor.saveState?.(lore);
            await Director.saveState?.(lore);
            await WorldAdditionalCore.saveState?.(lore);
            await UserDlcCore.saveState?.(lore);
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
            MemoryEngine.rebuildIndex(lore);
            return {
                skipped: false,
                sourcePairs: pairs.length,
                selectedPairs: selectedPairs.length,
                existingMemoryCount,
                skippedExistingMemoryCount,
                addedMemoryCount: addedMemories.length,
                worldMemoryDecision,
                turnRecordCount: pairs.length,
                userOnlyFallback,
                maxTurn: maxTurn || pairs.length
            };
        };
