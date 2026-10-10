    const findLatestAssistantMessage = (chat) => {
        const msgs = getChatMessages(chat);
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (!msg || isUserLikeMessage(msg)) continue;
            return msg;
        }
        return null;
    };

    // ══════════════════════════════════════════════════════════════
    // [ENGINE] V4.2 Turn Anchor Utilities
    // Late-model LIBRA uses stable turn anchors instead of background polling.
    // The lorebook schema remains V3.5.1-compatible;
    // these helpers only enrich META and rollback decisions.
    // ══════════════════════════════════════════════════════════════
    const normalizeCanonicalMessageIds = (value) => {
        const collected = [];
        const visited = new Set();
        const collect = (item) => {
            if (item == null) return;
            if (Array.isArray(item)) { item.forEach(collect); return; }
            if (typeof item === 'object') {
                if (visited.has(item)) return;
                visited.add(item);
                [
                    item?.id,
                    item?.messageId,
                    item?.m_id,
                    item?.uuid,
                    item?.key,
                    ...(Array.isArray(item?.sourceMessageIds) ? item.sourceMessageIds : []),
                    ...(Array.isArray(item?.m_ids) ? item.m_ids : []),
                    ...(Array.isArray(item?.liveMessageIds) ? item.liveMessageIds : [])
                ].forEach(collect);
                return;
            }
            const normalized = String(item || '').trim();
            if (!normalized || normalized === '[object Object]') return;
            collected.push(normalized);
        };
        collect(value);
        return [...new Set(collected)];
    };

    const getPrimaryCanonicalMessageId = (value, allowEmpty = false) => {
        const primary = String(normalizeCanonicalMessageIds(value)[0] || '').trim();
        if (primary) return primary;
        return allowEmpty ? '' : null;
    };

    const hasCanonicalMessageIdOverlap = (left, right) => {
        const leftIds = normalizeCanonicalMessageIds(left);
        const rightIds = normalizeCanonicalMessageIds(right);
        if (leftIds.length === 0 || rightIds.length === 0) return false;
        const rightSet = new Set(rightIds);
        return leftIds.some(id => rightSet.has(id));
    };

    const getLiveMessageId = (msg) => String(normalizeCanonicalMessageIds([
        msg?.id,
        msg?.messageId,
        msg?.m_id,
        msg?.uuid,
        msg?.key,
        // RisuAI stores the per-generation message identifier in Message.chatId.
        // This is distinct from the parent chat object's id.
        msg?.chatId,
        msg?.generationInfo?.generationId
    ])[0] || '').trim();

    // Prospective request-owner evidence only. This does not grant analysis or
    // replacement eligibility, and is not a fabricated native host revision.
    const ProspectiveSourceReceipt = (() => {
        const schema = 'wm.prospective-source.v1';
        const blocked = reason => ({ schema, state: 'unsupported', analysisEligible: false, replacementEligible: false, reason });
        const ids = message => normalizeCanonicalMessageIds([
            message?.id, message?.messageId, message?.m_id, message?.uuid,
            message?.key, message?.chatId, message?.generationInfo?.generationId
        ]).filter(id => !/^\d+$/.test(id)
            && !/(?:^|\|)(?:T\d+$|(?:idx_|index:|position:|pos:|turn:)\d+(?:$|\|))/i.test(id)
            && !/^(?:derivedmsg|afterrequest|synthetic|fallback|legacy|hash|sha(?:1|256|512)?|content(?:-hash)?|text(?:-hash)?):/i.test(id));
        const text = message => {
            const values = ['data', 'content', 'text'].filter(key => typeof message?.[key] === 'string').map(key => message[key]);
            return values.length && values.every(value => value === values[0]) ? values[0] : null;
        };
        const role = message => {
            const value = String(message?.role || '').toLowerCase();
            return value === 'user' ? 'user' : ['assistant', 'char'].includes(value) ? 'assistant' : '';
        };
        const usable = message => message && !message.disabled && !message.isComment && !message.isOOC;
        const uniqueAt = (messages, expected, expectedIndex) => {
            if (!Array.isArray(expected) || !expected.length || !expected.every(id => typeof id === 'string' && id)) return false;
            const wanted = new Set(expected);
            let matched = -1;
            for (let index = 0; index < messages.length; index++) {
                if (!ids(messages[index]).some(id => wanted.has(id))) continue;
                if (matched >= 0) return false;
                matched = index;
            }
            return matched === expectedIndex;
        };
        const capture = (chat, origin) => {
            if (origin?.autoContinue) return blocked('continuation_pair_not_captured');
            if (!origin?.requestId || !origin?.canonicalScope || !origin?.characterId || !origin?.chatId) return blocked('explicit_scope_unavailable');
            const messages = getChatMessages(chat);
            const index = messages.length - 1;
            const user = messages[index];
            const userIds = ids(user), userText = text(user);
            if (!usable(user) || role(user) !== 'user' || userText === null) return blocked('native_request_user_unavailable');
            if (!uniqueAt(messages, userIds, index)) return blocked('native_request_user_identity_ambiguous');
            return {
                schema, state: 'captured', requestId: origin.requestId,
                canonicalScope: origin.canonicalScope, characterId: origin.characterId,
                chatId: origin.chatId, resetGeneration: origin.resetGeneration ?? 0,
                originMessageCount: messages.length, userIds, userText,
                runtimeLease: RuntimeStateLease.capture(),
                analysisEligible: false, replacementEligible: false, reason: 'assistant_not_accepted'
            };
        };
        const bind = (chat, pending, assistantIds) => {
            const source = pending?.sourceCapture;
            if (!source || source.schema !== schema || source.state !== 'captured') return blocked(source?.reason || 'prospective_capture_unavailable');
            if (!Array.isArray(source.userIds) || !source.userIds.length || typeof source.userText !== 'string'
                || !Number.isInteger(source.originMessageCount) || source.originMessageCount < 1
                || !Array.isArray(assistantIds)) return blocked('source_capture_malformed');
            if (!RuntimeStateLease.isCurrent(source.runtimeLease)) return blocked('source_capture_lease_expired');
            const target = pending?.targetContext || {};
            if (source.requestId !== target.durableLedgerRecordId || source.canonicalScope !== target.canonicalScope
                || source.characterId !== target.characterId || source.chatId !== chat?.id || source.chatId !== target.chatId
                || source.resetGeneration !== (target.resetGeneration ?? 0)) return blocked('source_capture_scope_mismatch');
            const messages = getChatMessages(chat), userIndex = source.originMessageCount - 1, assistantIndex = source.originMessageCount;
            const user = messages[userIndex], assistant = messages[assistantIndex];
            if (!usable(user) || role(user) !== 'user' || !uniqueAt(messages, source.userIds, userIndex)) return blocked('captured_user_identity_changed');
            if (JSON.stringify(ids(user).slice().sort()) !== JSON.stringify(source.userIds.slice().sort())) return blocked('captured_user_aliases_changed');
            if (text(user) !== source.userText) return blocked('captured_user_bytes_changed');
            const nativeAssistantIds = ids(assistant);
            if (!usable(assistant) || role(assistant) !== 'assistant' || text(assistant) === null
                || !nativeAssistantIds.some(id => assistantIds.includes(id))
                || !uniqueAt(messages, nativeAssistantIds, assistantIndex)) return blocked('accepted_assistant_identity_mismatch');
            return {
                schema, state: 'bound', requestId: source.requestId,
                canonicalScope: source.canonicalScope, characterId: source.characterId,
                chatId: source.chatId, resetGeneration: source.resetGeneration,
                userIds: source.userIds.slice(), assistantIds: nativeAssistantIds,
                originMessageCount: source.originMessageCount,
                bindingAuthority: 'registered_request_and_accepted_host_response',
                analysisEligible: false, replacementEligible: false, reason: 'derived_attribution_unproven'
            };
        };
        return Object.freeze({ capture, bind });
    })();

    const getNarrativeMessageStableId = (chat, msg, options = {}) => {
        if (!msg) return '';
        const explicitId = String(
            msg?.id
            || msg?.messageId
            || msg?.m_id
            || msg?.chatId
            || msg?.generationInfo?.generationId
            || ''
        ).trim();
        if (explicitId) return explicitId;
        const indexHint = Number.isFinite(Number(options?.indexHint)) ? Number(options.indexHint) : -1;
        const aiText = String(
            options?.aiText
            || Utils.getNarrativeComparableText(Utils.getMessageText(msg), 'ai')
            || Utils.getMemorySourceText(Utils.getMessageText(msg))
            || ''
        ).trim();
        if (!aiText) return '';
        const chatId = String(chat?.id || options?.chatId || 'global').trim() || 'global';
        const hash = TokenizerEngine.simpleHash(aiText);
        const idxLabel = indexHint >= 0 ? String(indexHint) : 'na';
        return `derivedmsg:${chatId}:${idxLabel}:${hash}`;
    };

    const buildAfterRequestSyntheticMessageId = (chat, turn = 0, sourceHash = '') => {
        const chatId = String(chat?.id || 'global').trim() || 'global';
        const safeTurn = normalizeLegacyMemoryTurnAnchor(turn) || 'pending';
        const hash = String(sourceHash || '').trim() || 'nohash';
        return `afterrequest:${chatId}:${safeTurn}:${hash}`;
    };

    const buildAfterRequestSyntheticMessageSignature = (turn = 0, aiText = '', sourceHash = '') => {
        const hash = String(sourceHash || (aiText ? TokenizerEngine.simpleHash(aiText) : '') || '').trim() || 'nohash';
        const safeTurn = normalizeLegacyMemoryTurnAnchor(turn) || 0;
        return `ai::afterRequest::${safeTurn}::${hash}`;
    };

    const buildCanonicalMemoryCaptureContent = (userText = '', aiText = '', options = {}) => {
        const user = String(Utils.getMemorySourceText(userText) || '').trim();
        const ai = String(Utils.getMemorySourceText(aiText) || '').trim();
        if (!ai) return '';
        let payload = CompactMemoryCodec.buildTurnPayload(user, ai, {
            importance: 6,
            turn: options.turn || 0,
            entityRefs: options.entityRefs || [],
            knownEntityNames: options.knownEntityNames || options.entityRefs || [],
            strictKnownEntityNamesOnly: true
        });
        try {
            if (payload && (typeof MemoryEngine === 'undefined' || MemoryEngine.CONFIG?.rpLongTermMemoryEnabled !== false)) {
                payload = RPContinuityCore.attachToPayload(payload, user, ai, options);
            }
        } catch (error) {
            if (typeof MemoryEngine !== 'undefined' && MemoryEngine.CONFIG?.debug) {
                recordRuntimeDebug('warn', '[LIBRA][RP-LTM] heuristic turn capture skipped:', error?.message || error);
            }
        }
        return payload ? CompactMemoryCodec.serialize(payload) : '';
    };
    const WORLD_RECALL_MEMORY_MIN_INTERVAL_TURNS = 5;
    const buildWorldRecallMemoryContent = (worldMeta = {}, currentRules = {}, options = {}) => {
        const meta = (worldMeta && typeof worldMeta === 'object') ? worldMeta : {};
        const normalizedRules = normalizeWorldRuleUpdate(currentRules || {});
        const classification = String(meta.classification || meta.worldMetadata?.classification || '').trim();
        const worldSummary = String(meta.worldSummary || meta.worldMetadata?.summary || '').trim();
        const worldDescription = String(meta.worldMetadata?.description || '').trim();
        const userWorldCorrection = String(meta.userWorldCorrection || meta.worldMetadata?.userWorldCorrection || '').trim();
        const worldSnapshot = options.worldSnapshot && typeof options.worldSnapshot === 'object' ? options.worldSnapshot : {};
        const activePath = dedupeTextArray(
            (Array.isArray(options.activePath) ? options.activePath : (Array.isArray(worldSnapshot.activePath) ? worldSnapshot.activePath : []))
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
        ).slice(0, 8);
        const meaningfulActivePath = activePath.filter(item => String(item || '').trim());
        const ruleHighlights = extractWorldRuleHighlights(normalizedRules, 6);
        const meaningfulHighlights = ruleHighlights.filter(item => String(item || '').trim());
        // 활성 경로(activePath)는 노드 이름 목록이고, 분류(classification)는 라벨이다.
        // 둘 다 "어느 세계인가"를 가리킬 뿐 세계 규칙의 내용이 아니다. 이 둘만으로
        // 회상 가능한 기억을 만들면 내용이 0자인 레코드가 생기고, 그 레코드가
        // 임베딩 공간에서 모든 질의에 어중간하게 가까운 끌개가 된다.
        //
        // 실측(2026-09-27, qwen3-embedding 4096D, 실제 저장 항목):
        //   내용 0자 레코드(검색 텍스트 22자)가 무관 질의 top1 이었다 4/4.
        //   무관 질의 최고 코사인 0.4489 → 그 레코드 제외 시 0.3959.
        //   관련 질의 정답 rank1 3/8 → 4/8.
        // 따라서 "내용"을 가진 신호만 회상 대상으로 인정한다.
        const hasWorldContentSignal = Boolean(
            worldSummary
            || worldDescription
            || userWorldCorrection
            || meaningfulHighlights.length > 0
        );
        if (!hasWorldContentSignal) return '';

        const normalizedTurn = normalizeLegacyMemoryTurnAnchor(options.turn || options.t || 0) || undefined;
        const summaryParts = [];
        if (classification) summaryParts.push(`분류 ${classification}`);
        if (meaningfulActivePath.length > 0) summaryParts.push(`활성 경로 ${meaningfulActivePath.join('→')}`);
        if (worldSummary) summaryParts.push(`세계 요약 ${truncateForLLM(worldSummary, 220, ' ... ')}`);
        else if (worldDescription) summaryParts.push(`세계 설명 ${truncateForLLM(worldDescription, 220, ' ... ')}`);
        if (meaningfulHighlights.length > 0) summaryParts.push(`핵심 규칙 ${meaningfulHighlights.join(', ')}`);
        if (userWorldCorrection) summaryParts.push(`수동 보정 ${truncateForLLM(userWorldCorrection, 160, ' ... ')}`);
        if (summaryParts.length === 0) return '';

        const snippetPool = [];
        if (classification) snippetPool.push(`분류/Classification: ${classification}`);
        if (meaningfulActivePath.length > 0) snippetPool.push(`활성 경로/Active Path: ${meaningfulActivePath.join('→')}`);
        if (worldSummary) snippetPool.push(`요약/Summary: ${truncateForLLM(worldSummary, 180, ' ... ')}`);
        else if (worldDescription) snippetPool.push(`설명/Description: ${truncateForLLM(worldDescription, 180, ' ... ')}`);
        if (meaningfulHighlights.length > 0) snippetPool.push(`규칙/Rules: ${meaningfulHighlights.join(', ')}`);
        if (userWorldCorrection) snippetPool.push(`수동 보정/User Correction: ${truncateForLLM(userWorldCorrection, 160, ' ... ')}`);

        const classificationTag = classification ? `분류:${classification}` : '';
        // 'world_rule_snapshot' 은 라우팅용 식별자다. 태그로 남기면 검색 텍스트에
        // 그대로 들어가 임베딩을 오염시킨다 (03d의 식별자 제거와 같은 부류).
        const tags = dedupeTextArray([
            '세계 규칙',
            classificationTag,
            ...meaningfulHighlights
        ].filter(Boolean)).slice(0, 10);
        const worldTags = dedupeTextArray([
            '세계 규칙',
            classification,
            ...meaningfulHighlights,
            ...(userWorldCorrection ? ['수동 보정'] : [])
        ].filter(Boolean)).slice(0, 12);
        const summary = truncateForLLM(summaryParts.join(' | '), 420, ' ... ');
        const worldSignature = stableHash(JSON.stringify({
            classification,
            activePath: meaningfulActivePath,
            worldSummary,
            worldDescription,
            userWorldCorrection,
            ruleHighlights: meaningfulHighlights
        }));
        const anchorHint = truncateForLLM(dedupeTextArray([
            '세계 규칙',
            classificationTag,
            ...meaningfulHighlights
        ].filter(Boolean)).join(' / '), 160, ' ... ');
        const createdAt = Date.now();
        const sourceMessageIds = normalizeCanonicalMessageIds(options.sourceMessageIds || options.liveMessageIds || []);
        const payload = {
            schema: CompactMemoryCodec.WRITE_SCHEMA || CompactMemoryCodec.LEDGER_SCHEMA,
            version: (CompactMemoryCodec.WRITE_SCHEMA && CompactMemoryCodec.WRITE_SCHEMA !== CompactMemoryCodec.LEDGER_SCHEMA) ? 3 : 2,
            turn: normalizedTurn,
            firstSeenTurn: normalizedTurn,
            source: {
                turn: normalizedTurn,
                firstSeenTurn: normalizedTurn,
                sourceHash: String(options.sourceHash || '').trim(),
                sourceMessageIds,
                createdAt,
                rawRetention: 'hash_summary_and_structured_evidence_only'
            },
            scene: {
                time: '',
                location: '',
                // 분류가 없으면 장면 요약은 비운다. 타입 이름('world_rule_snapshot')을 넣으면
                // 검색 텍스트가 그 토큰으로 채워져 임베딩이 의미 내용 대신 타입을 학습한다.
                // 실측(2026-09-27, 실제 저장 항목): 무관 질의 최고 코사인이 이 토큰 때문에
                // 0.3837 이었다 (토큰 제거 후 0.3472).
                summary: classification ? `world:${classification}` : ''
            },
            participants: {
                canonicalEntities: [],
                unresolvedMentions: [],
                groups: []
            },
            facts: snippetPool.slice(0, 3).map((text, index) => ({
                id: `fact.${normalizedTurn || 'world'}.${index + 1}.${String(stableHash(`${worldSignature}:${index}:${text}`)).replace(/^-/, 'n').slice(0, 10)}`,
                type: 'world_rule',
                text: truncateForLLM(text, 220, ' ... '),
                entities: [],
                evidence: [{ source: 'world', text: truncateForLLM(text, 220, ' ... ') }],
                confidence: 0.86,
                importance: 0.7
            })),
            continuity: {
                openThreads: [],
                relationSignals: [],
                worldChanges: [{
                    id: `world.${String(worldSignature).replace(/^-/, 'n')}`,
                    // type 은 라우팅 식별자다. 검색 텍스트에서 걸러진다(03d).
                    type: 'world_rule_snapshot',
                    text: summary,
                    summary,
                    tags: worldTags,
                    signature: worldSignature,
                    confidence: 0.86
                }]
            },
            audit: {
                cautions: [],
                overpromotionRisks: [],
                confidence: 'medium'
            },
            retention: {
                rawRetention: 'summary_and_structured_evidence',
                rawDiscarded: true
            },
            arcKey: 'world_rule_snapshot',
            arcRole: 'current',
            causalRole: '',
            primaryConflict: '',
            relationDelta: '',
            summary,
            recallAnchors: [{
                summary: truncateForLLM(summary, 180, ' ... '),
                hint: anchorHint,
                entityRefs: [],
                confidence: 0.82
            }],
            directEvidenceSnippets: snippetPool.slice(0, 3).map(text => ({ source: 'world', text })),
            mentionedEntityNames: [],
            tags,
            importance: Math.max(6, Math.min(10, Number(options.importance || 6) || 6)),
            impression: Math.max(0.55, Math.min(0.95, Number(options.impression || 0.68) || 0.68)),
            sourceHash: String(options.sourceHash || '').trim(),
            sourceMessageIds,
            rawRetention: 'summary_and_structured_evidence',
            rawDiscarded: true,
            createdAt,
            classification,
            worldSignature,
            worldSummary: truncateForLLM(worldSummary || worldDescription, 1000, ' ... '),
            // 세계 규칙은 정본(08a 노드 rules)에만 산다 — 기억에 값을 **복사하지 않는다**.
            // 실측: 복사본 때문에 같은 규칙 텍스트가 세계 블록과 회상 텍스트에 두 번 나갔다
            //   (어절 공유 25/25 = 100%).
            // 다만 **지문(해시)은 남긴다**: shouldCreateWorldRecallMemorySnapshot 이 그것으로
            //   "규칙이 바뀌었나"를 판정한다(05e:354). 값이 아니라 지문이라서 복사가 아니다.
            //   값까지 지우면 해시 입력이 비어 변경 감지가 영구히 죽는다.
            world: {
                signature: worldSignature,
                revision: 1,
                ruleHash: stableHash(JSON.stringify({
                    classification,
                    exists: normalizedRules.exists || {},
                    systems: normalizedRules.systems || {},
                    physics: normalizedRules.physics || {},
                    custom: normalizeWorldCustomRules(normalizedRules.custom),
                    ruleHighlights: meaningfulHighlights,
                    worldSummary: String(worldSummary || worldDescription || '').trim()
                })),
                activePathHash: stableHash(JSON.stringify(meaningfulActivePath)),
                correctionHash: stableHash(String(userWorldCorrection || '').trim())
            }
        };
        return CompactMemoryCodec.serialize(payload);
    };
    const getWorldRecallRuleHash = (payload = {}) => {
        // 새 형태: 빌드 시 계산해 둔 **지문**을 그대로 쓴다(값 복사 없음).
        const stored = String(payload?.world?.ruleHash || payload?.worldRuleHash || '').trim();
        if (stored) return stored;
        // 레거시(값을 복사하던 시절의 기억): 종전대로 재계산한다.
        return stableHash(JSON.stringify({
            classification: payload?.classification || payload?.world?.classification || {},
            exists: payload?.world?.exists || {},
            systems: payload?.world?.systems || {},
            physics: payload?.world?.physics || {},
            custom: payload?.world?.custom || {},
            ruleHighlights: payload?.world?.ruleHighlights || [],
            worldSummary: payload?.worldSummary || ''
        }));
    };
    const getWorldRecallActivePathHash = (payload = {}) => {
        const stored = String(payload?.world?.activePathHash || payload?.activePathHash || '').trim();
        if (stored) return stored;
        return stableHash(JSON.stringify(
            Array.isArray(payload?.world?.activePath)
                ? payload.world.activePath
                : (Array.isArray(payload?.activePath) ? payload.activePath : [])
        ));
    };
    const getWorldRecallCorrectionHash = (payload = {}) => {
        const stored = String(payload?.world?.correctionHash || payload?.correctionHash || '').trim();
        if (stored) return stored;
        return stableHash(String(
            payload?.world?.userCorrection || payload?.userWorldCorrection || ''
        ).trim());
    };
    const getWorldRecallMemoryEntries = (lorebook = []) => LibraLoreConsolidator
        .unpack(Array.isArray(lorebook) ? lorebook : [])
        .filter(entry => entry && String(entry?.comment || '').trim() === 'lmai_memory');
    const findLatestWorldRecallMemoryInfo = (lorebook = []) => {
        if (!Array.isArray(lorebook)) return null;
        let inspected = 0;
        const memoryEntries = getWorldRecallMemoryEntries(lorebook);
        for (let i = memoryEntries.length - 1; i >= 0 && inspected < 128; i--) {
            const entry = memoryEntries[i];
            inspected += 1;
            let payload = null;
            try { payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || null; } catch (_) { payload = null; }
            if (!payload || String(payload?.arcKey || '').trim() !== 'world_rule_snapshot') continue;
            const turn = normalizeLegacyMemoryTurnAnchor(payload?.turn || payload?.firstSeenTurn || payload?.source?.turn || 0) || 0;
            return {
                payload,
                turn,
                signature: String(payload?.worldSignature || payload?.world?.signature || '').trim(),
                ruleHash: getWorldRecallRuleHash(payload),
                activePathHash: getWorldRecallActivePathHash(payload),
                correctionHash: getWorldRecallCorrectionHash(payload)
            };
        }
        return null;
    };
    const shouldCreateWorldRecallMemorySnapshot = (lorebook = [], payload = null, options = {}) => {
        if (!payload || typeof payload !== 'object') return { create: false, reason: 'empty_payload' };
        const signature = String(payload?.worldSignature || payload?.world?.signature || '').trim();
        if (signature && hasMatchingWorldRecallMemory(lorebook, signature)) {
            return { create: false, reason: 'same_signature', signature };
        }
        const turn = normalizeLegacyMemoryTurnAnchor(options.turn || payload.turn || payload.firstSeenTurn || 0) || 0;
        const latest = findLatestWorldRecallMemoryInfo(lorebook);
        if (!latest) return { create: true, reason: 'baseline', signature };
        const currentRuleHash = getWorldRecallRuleHash(payload);
        const currentActivePathHash = getWorldRecallActivePathHash(payload);
        const currentCorrectionHash = getWorldRecallCorrectionHash(payload);
        if (options.isWorldCritical === true) {
            return { create: true, reason: 'critical_world_path', signature, previousSignature: latest.signature };
        }
        if (currentCorrectionHash !== latest.correctionHash) {
            return { create: true, reason: 'user_world_correction_changed', signature, previousSignature: latest.signature };
        }
        if (currentRuleHash !== latest.ruleHash) {
            return { create: true, reason: 'world_rules_changed', signature, previousSignature: latest.signature };
        }
        if (currentActivePathHash !== latest.activePathHash) {
            return { create: true, reason: 'world_path_changed', signature, previousSignature: latest.signature };
        }
        const age = turn > 0 && latest.turn > 0 ? turn - latest.turn : 0;
        if (age >= WORLD_RECALL_MEMORY_MIN_INTERVAL_TURNS) {
            return { create: true, reason: 'interval_refresh', signature, previousSignature: latest.signature, age };
        }
        return { create: false, reason: 'recent_equivalent', signature, previousSignature: latest.signature, age };
    };
    const hasMatchingWorldRecallMemory = (lorebook = [], signature = '') => {
        const target = String(signature || '').trim();
        if (!target || !Array.isArray(lorebook)) return false;
        let inspected = 0;
        const memoryEntries = getWorldRecallMemoryEntries(lorebook);
        for (let i = memoryEntries.length - 1; i >= 0 && inspected < 96; i--) {
            const entry = memoryEntries[i];
            inspected += 1;
            let payload = null;
            try { payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || null; } catch (_) { payload = null; }
            if (!payload || String(payload?.arcKey || '').trim() !== 'world_rule_snapshot') continue;
            const existingSignature = String(payload?.worldSignature || payload?.world?.signature || '').trim();
            if (existingSignature && existingSignature === target) return true;
        }
        return false;
    };
    const buildLatestAssistantSnapshot = (chat, options = {}) => {
        const latestMessages = Array.isArray(getChatMessages(chat)) ? getChatMessages(chat) : [];
        const currentMessageCount = latestMessages.length;
        const latestAiMsg = findLatestAssistantMessage(chat);
        const latestComparable = String(
            Utils.getNarrativeComparableText(Utils.getMessageText(latestAiMsg), 'ai')
            || Utils.getMemorySourceText(Utils.getMessageText(latestAiMsg))
            || ''
        ).trim();
        const latestHash = String((latestComparable ? TokenizerEngine.simpleHash(latestComparable) : '') || '').trim();
        const latestMessageSignature = String(getMessageSignature(latestAiMsg) || '').trim();
        const latestLiveId = String(getLiveMessageId(latestAiMsg) || '').trim();
        let latestStableId = '';
        if (options?.includeStableId === true && latestAiMsg) {
            const latestIndex = latestMessages.lastIndexOf(latestAiMsg);
            latestStableId = String(getNarrativeMessageStableId(chat, latestAiMsg, {
                aiText: latestComparable,
                indexHint: latestIndex
            }) || '').trim();
        }
        return {
            latestMessages,
            currentMessageCount,
            latestAiMsg,
            latestComparable,
            latestHash,
            latestMessageSignature,
            latestLiveId,
            latestStableId
        };
    };

    const findPersistedAssistantSnapshotByHash = (chat, expectedHash = '', options = {}) => {
        const targetHash = String(expectedHash || '').trim();
        const messages = Array.isArray(getChatMessages(chat)) ? getChatMessages(chat) : [];
        if (!targetHash || messages.length === 0) return null;
        const originMessageCount = Math.max(0, Number(options?.originMessageCount || 0) || 0);
        const expectedUserText = String(Utils.getMemorySourceText(options?.expectedUserText || '') || '').trim();
        const expectedUserHash = expectedUserText ? String(TokenizerEngine.simpleHash(expectedUserText) || '').trim() : '';
        const expectedIds = new Set(normalizeCanonicalMessageIds(options?.expectedMessageIds || [])
            .filter(id => !id.startsWith('afterrequest:')));
        const hasOriginBoundary = options?.originMessageCount != null;
        const previous = options?.originLatestAssistant || null;
        const candidates = [];
        const firstIndex = hasOriginBoundary
            ? Math.max(0, originMessageCount - (options?.allowContinuation === true ? 1 : 0)) : 0;
        const endIndex = hasOriginBoundary ? Math.min(messages.length, originMessageCount + 1) : messages.length;
        for (let index = firstIndex; index < endIndex; index++) {
            const msg = messages[index];
            if (!msg || isUserLikeMessage(msg)) continue;
            const comparable = String(
                Utils.getNarrativeComparableText(Utils.getMessageText(msg), 'ai')
                || Utils.getMemorySourceText(Utils.getMessageText(msg))
                || ''
            ).trim();
            if (!comparable) continue;
            const hash = String(TokenizerEngine.simpleHash(comparable) || '').trim();
            if (!hash || hash !== targetHash) continue;
            const liveId = String(getLiveMessageId(msg) || '').trim();
            const stableId = String(getNarrativeMessageStableId(chat, msg, {
                aiText: comparable,
                indexHint: index
            }) || '').trim();
            const ids = normalizeCanonicalMessageIds([liveId, stableId]);
            let previousUserHash = '';
            for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
                const previous = messages[userIndex];
                if (!previous || !isUserLikeMessage(previous)) continue;
                const previousUserText = String(Utils.getMemorySourceText(Utils.getMessageText(previous)) || '').trim();
                if (previousUserText) previousUserHash = String(TokenizerEngine.simpleHash(previousUserText) || '').trim();
                break;
            }
            const idMatch = ids.some(id => expectedIds.has(id));
            const userMatch = !!expectedUserHash && previousUserHash === expectedUserHash;
            const signature = String(getMessageSignature(msg) || '').trim();
            // Identity and position are admission gates, not ranking hints. A
            // repeated reply elsewhere in history cannot stand in for this turn.
            if (expectedIds.size && !idMatch) continue;
            // Request formatting/CBS may transform user text relative to the
            // host message. Exact assistant ID or frozen position is stronger.
            if (!hasOriginBoundary && !expectedIds.size && expectedUserHash && !userMatch) continue;
            // Only exact response-hash lookup may opt into a changed final
            // origin slot. Host-transformed text cannot prove continuation.
            const continuedOriginSlot = options?.allowContinuation === true
                && previous && Number.isInteger(previous.index)
                && previous.index === originMessageCount - 1 && index === previous.index
                && messages.length === originMessageCount
                && !!previous.hash
                && (hash !== previous.hash || signature !== previous.signature
                    || (!!previous.id && !ids.includes(previous.id)));
            const afterOrigin = index === originMessageCount;
            if (hasOriginBoundary && !afterOrigin && !continuedOriginSlot) continue;
            const expectedIndex = originMessageCount;
            const distance = Math.abs(index - expectedIndex);
            const score = (idMatch ? 10000 : 0) + (userMatch ? 1000 : 0) + (afterOrigin ? 100 : 0) - Math.min(99, distance);
            candidates.push({
                score,
                distance,
                index,
                latestAiMsg: msg,
                latestComparable: comparable,
                latestHash: hash,
                latestMessageSignature: String(getMessageSignature(msg) || '').trim(),
                latestLiveId: liveId,
                latestStableId: stableId,
                latestMessages: messages,
                currentMessageCount: messages.length,
                historicalMatch: index !== messages.length - 1,
                matchedByUser: userMatch,
                matchedById: idMatch
            });
        }
        candidates.sort((a, b) => b.score - a.score || a.distance - b.distance || a.index - b.index);
        return candidates[0] || null;
    };

    const buildLogicalUserTurnKey = (userMsgForNarrative = '', userMsgForMemory = '', autoContinue = false) => {
        if (autoContinue) return '[auto-continue]';
        const base = String(userMsgForNarrative || userMsgForMemory || '').trim();
        return base ? TokenizerEngine.simpleHash(base) : '';
    };

    const buildCanonicalTurnKey = (chatId = '', userTurnKey = '', sourceHash = '', messageSignature = '', liveMessageIds = []) => {
        const normalizedIds = normalizeCanonicalMessageIds(liveMessageIds);
        const compactSignature = typeof compactTurnMessageSignature === 'function'
            ? compactTurnMessageSignature(messageSignature)
            : String(messageSignature || '').trim();
        const compactSignatureForKey = compactSignature.startsWith('sig:') ? compactSignature.slice(4) : compactSignature;
        return [
            `chat:${String(chatId || '').trim() || 'global'}`,
            `user:${String(userTurnKey || '').trim() || 'none'}`,
            `source:${String(sourceHash || '').trim() || 'none'}`,
            `sig:${compactSignatureForKey || 'none'}`,
            `ids:${normalizedIds.join(',') || 'none'}`
        ].join('|');
    };

    const normalizeCanonicalFactSlot = (value = 'turn_summary') => {
        const normalized = String(value || 'turn_summary')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9가-힣:_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return normalized || 'turn_summary';
    };

    const buildCanonicalMemoryId = (chatId = '', acceptedMessageId = '', factSlot = 'turn_summary', fallback = {}) => {
        const scope = String(chatId || fallback?.chatId || 'global').trim() || 'global';
        const messageId = String(acceptedMessageId || fallback?.messageId || '').trim();
        const slot = normalizeCanonicalFactSlot(factSlot);
        // Live and replayed memories use a stable ID derived from an assistant
        // message that actually exists in the chat. Legacy migrations may use
        // a deterministic turn key/source hash only when no host ID ever existed.
        const anchor = messageId
            ? `message:${messageId}`
            : `legacy:${String(fallback?.turnKey || fallback?.sourceHash || fallback?.turn || 'unknown').trim() || 'unknown'}`;
        return `libra-memory:${scope}:${anchor}:${slot}`;
    };

    const normalizeLegacyMemoryTurnAnchor = (value = 0) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 && n < 1000000 ? Math.floor(n) : 0;
    };

    const deriveRuntimeTurnFromLorebook = (lorebook = []) => Math.max(0, Number(deriveMaxTurnFromLorebook(lorebook) || 0));


    const V42_TURN_RECORD_COMMENT = 'lmai_turn_records';
    const V42_TURN_RECORD_VERSION = 1;
    const V42_TURN_RECORD_LIMIT = 160;
    const V42_TURN_RECORD_FORMAT = 'compact_v2';

    function compactTurnMessageSignature(value = '') {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (raw.length <= 72 && !/\s{2,}|[\r\n]/.test(raw)) return raw;
        return `sig:${stableHash(raw)}`;
    }

    const parseJsonSafeV42 = (value, fallback = null) => {
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            return parsed == null ? fallback : parsed;
        } catch {
            return fallback;
        }
    };

    const splitManagedMemoryMetaPrefix = (content = '') => {
        const raw = String(content || '');
        const metaJson = extractLibraMetaJsonString(raw);
        if (!metaJson) return { meta: {}, body: raw.trim(), hadMeta: false };
        const markerStart = raw.indexOf('[META:');
        const jsonStart = raw.indexOf(metaJson, markerStart >= 0 ? markerStart : 0);
        const close = jsonStart >= 0 ? raw.indexOf(']', jsonStart + metaJson.length) : -1;
        return {
            meta: parseJsonSafeV42(metaJson, {}) || {},
            body: (close >= 0 ? raw.slice(close + 1) : raw.slice((jsonStart >= 0 ? jsonStart + metaJson.length : 0))).trim(),
            hadMeta: true
        };
    };

    const refreshManagedMemoryEntryIntegrity = (entry = null, context = {}) => {
        if (!entry || typeof entry !== 'object' || String(entry?.comment || '').trim() !== 'lmai_memory') {
            return { ok: false, reason: 'invalid_memory_entry', entry };
        }
        const split = splitManagedMemoryMetaPrefix(entry.content || '');
        const meta = { ...(split.meta || {}) };
        const body = String(split.body || '').trim();
        const scopeKey = String(
            context.scopeKey
            || meta?.integrity?.scopeKey
            || meta.scopeKey
            || context.chatId
            || meta.chatId
            || MemoryState?._activeScopeKey
            || ''
        ).trim();
        const turn = normalizeLegacyMemoryTurnAnchor(
            context.turn || meta.t || meta.turn || meta.turnAnchor || meta.finalizedTurn || 0
        );
        try {
            const recordId = String(context.recordId || meta.canonicalMemoryId || meta.turnKey || meta.sourceHash || meta.m_id || '').trim();
            const currentValidation = IntegrityMetaManager.validateMemoryMeta(meta, body, {
                domain: 'memory',
                recordId,
                scopeKey,
                turn
            });
            if (currentValidation?.ok) {
                return { ok: true, meta, body, validation: currentValidation, entry, unchanged: true };
            }
            IntegrityMetaManager.annotateMemoryMeta(meta, body, {
                domain: 'memory',
                recordSchema: 'libra.memory.entry.v1',
                recordId,
                scopeKey,
                turn,
                source: String(context.source || meta.source || '').trim()
            });
            const validation = IntegrityMetaManager.validateMemoryMeta(meta, body, {
                domain: 'memory',
                recordId,
                scopeKey,
                turn
            });
            if (!validation?.ok) {
                return { ok: false, reason: validation?.reason || 'integrity_validation_failed', validation, entry };
            }
            entry.content = `[META:${JSON.stringify(meta)}]\n${body}\n`;
            return { ok: true, meta, body, validation, entry };
        } catch (error) {
            return { ok: false, reason: String(error?.message || error || 'integrity_refresh_failed'), error, entry };
        }
    };

    const forceMemoryTurnAnchor = (entry = null, anchorMeta = {}) => {
        if (!entry || typeof entry !== 'object' || String(entry?.comment || '').trim() !== 'lmai_memory') return null;
        const split = splitManagedMemoryMetaPrefix(entry.content || '');
        const turn = normalizeLegacyMemoryTurnAnchor(
            anchorMeta?.turnAnchor
            || anchorMeta?.turnAnchorTurn
            || anchorMeta?.lockedTurn
            || anchorMeta?.finalizedTurn
            || anchorMeta?.turn
            || split.meta?.turnAnchorTurn
            || split.meta?.t
        );
        const sourceIds = normalizeCanonicalMessageIds(
            anchorMeta?.liveMessageIds
            || anchorMeta?.sourceMessageIds
            || anchorMeta?.messageId
            || anchorMeta?.m_id
            || split.meta?.sourceMessageIds
            || split.meta?.m_ids
            || split.meta?.m_id
        );
        const merged = {
            ...split.meta,
            ...Object.fromEntries(Object.entries(anchorMeta || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''))
        };
        if (turn > 0) {
            merged.t = turn;
            merged.turn = turn;
            merged.turnAnchor = turn;
            merged.turnAnchorTurn = turn;
            merged.lockedTurn = turn;
            merged.finalizedTurn = turn;
        }
        if (sourceIds.length > 0) {
            merged.sourceMessageIds = sourceIds;
            merged.liveMessageIds = sourceIds;
            merged.m_ids = sourceIds;
            if (!merged.m_id) merged.m_id = sourceIds[0];
            if (!merged.messageId) merged.messageId = sourceIds[0];
        }
        if (anchorMeta?.sourceHash || anchorMeta?.aiHash) merged.sourceHash = String(anchorMeta.sourceHash || anchorMeta.aiHash).trim();
        if (anchorMeta?.turnKey) merged.turnKey = String(anchorMeta.turnKey).trim();
        if (anchorMeta?.userTurnKey) merged.userTurnKey = String(anchorMeta.userTurnKey).trim();
        if (anchorMeta?.messageSignature) merged.messageSignature = compactTurnMessageSignature(anchorMeta.messageSignature);
        if (anchorMeta?.runtimeMode) merged.runtimeMode = String(anchorMeta.runtimeMode).trim();
        if (anchorMeta?.runtimeReliability) merged.runtimeReliability = String(anchorMeta.runtimeReliability).trim();
        if (anchorMeta?.canonicalFactSlot) merged.canonicalFactSlot = String(anchorMeta.canonicalFactSlot).trim();
        if (anchorMeta?.canonicalMemoryId) merged.canonicalMemoryId = String(anchorMeta.canonicalMemoryId).trim();

        entry.content = `[META:${JSON.stringify(merged)}]
${split.body || ''}
`;
        const refreshed = refreshManagedMemoryEntryIntegrity(entry, {
            scopeKey: String(anchorMeta?.scopeKey || merged?.integrity?.scopeKey || merged.scopeKey || MemoryState?._activeScopeKey || merged.chatId || '').trim(),
            recordId: String(merged.canonicalMemoryId || merged.turnKey || merged.sourceHash || merged.m_id || '').trim(),
            turn,
            source: String(merged.source || anchorMeta?.source || '').trim()
        });
        if (!refreshed.ok) {
            recordSuppressedRuntimeError?.('memory.turn_anchor.integrity_refresh_failed', refreshed.error || refreshed.reason, {
                turn,
                recordId: String(merged.canonicalMemoryId || merged.turnKey || merged.sourceHash || merged.m_id || '').trim(),
                reason: refreshed.reason || ''
            });
        }
        return merged;
    };

