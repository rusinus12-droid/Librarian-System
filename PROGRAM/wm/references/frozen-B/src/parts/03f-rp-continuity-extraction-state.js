        const extractHeuristic = (userText = '', aiText = '', options = {}) => {
            const turn = Math.max(0, Number(options.turn || 0) || 0);
            const knownNames = getKnownEntityNames(options);
            const result = normalizeTurnMemory({ turn, importance: 4, durability: 'medium', source: 'heuristic' }, { turn, entityRefs: knownNames, source: 'heuristic' });
            const sourceSentences = [
                ...splitSentences(aiText).map(text => ({ source: 'assistant', text }))
            ].filter(item => item.text && !META_CONTROL_RE.test(item.text));
            const durableSentences = [];
            const add = (category, raw, context = {}) => {
                const item = normalizeItem(category, raw, {
                    turn,
                    entityRefs: knownNames,
                    source: `heuristic:${context.source || 'turn'}`,
                    importance: context.importance || raw?.importance || 6,
                    confidence: context.confidence || raw?.confidence || (context.source === 'user' ? 0.88 : 0.78)
                });
                if (!item) return;
                const idx = result[category].findIndex(existing => isMatchingItem(category, existing, item));
                if (idx >= 0) result[category][idx] = mergeItems(category, result[category][idx], item);
                else result[category].push(item);
                durableSentences.push(item.text);
            };
            for (const { source, text } of sourceSentences.slice(0, 34)) {
                if (TRANSIENT_MOOD_ONLY_RE.test(text)) continue;
                const entities = entitiesInText(text, knownNames);
                const subject = inferSubject(text, entities, source);
                const visibility = normalizeVisibility('', text);
                const knownByMatch = text.match(POV_RE);
                const knownBy = knownByMatch ? uniqueStrings([knownByMatch[1], knownByMatch[2]], 4) : [];
                const shared = { entities, subject, visibility, knownBy, source };
                if (COMMITMENT_RE.test(text)) {
                    const status = COMMITMENT_RESOLVED_RE.test(text) ? 'fulfilled' : (COMMITMENT_BROKEN_RE.test(text) ? 'broken' : 'open');
                    add('commitments', {
                        ...shared,
                        text,
                        owner: subject || entities[0] || (source === 'user' ? 'User' : ''),
                        target: entities.find(name => name !== subject) || '',
                        status,
                        resolution: status === 'open' ? '' : text,
                        importance: /(맹세|다시는|끝까지|평생|forever|never again|always)/i.test(text) ? 9 : 8,
                        durability: /(평생|영원|다시는|forever|always|never again)/i.test(text) ? 'permanent' : 'long'
                    }, { source, importance: 8 });
                }
                const strongPreferenceEvidence = /(취향|선호|최애|알레르기|못\s*먹|먹지\s*못|경계선|금기|평소|항상|원래|favorite|favourite|prefers?|allergic|cannot\s+eat|can['’]?t\s+eat|usually|always|boundary|taboo)/i.test(text);
                const directPreferenceDeclaration = /(?:나는|난|저는|전|i\s+(?:like|love|hate|dislike|prefer|fear)|[가-힣A-Za-z0-9 _-]{1,40}(?:은|는|이|가).{0,60}(?:좋아한다|싫어한다|선호한다|두려워한다|무서워한다))/i.test(text);
                const transientPreferenceContext = /(?:오늘만|이번만|당장은|잠시|순간|그때는|오늘|지금|tonight|today|right\s+now|for\s+now|for\s+a\s+moment|this\s+time)/i.test(text);
                if (PREFERENCE_RE.test(text) && (source === 'user' || strongPreferenceEvidence || (directPreferenceDeclaration && !transientPreferenceContext))) {
                    add('preferences', {
                        ...shared,
                        text,
                        kind: inferPreferenceKind(text),
                        topic: inferPreferenceTopic(text),
                        importance: /(알레르기|못\s*먹|하지\s*마|경계선|allergic|cannot eat|can't eat|boundary|do not)/i.test(text) ? 9 : 7,
                        durability: 'permanent'
                    }, { source, importance: 7 });
                }
                if (STABLE_FACT_RE.test(text) && !/(?:일지도|같다|듯하다|추측|아마|maybe|perhaps|seems?|might|could be)/i.test(text)) {
                    add('stableFacts', {
                        ...shared,
                        text,
                        slot: inferFactSlot(text),
                        value: text,
                        importance: IDENTITY_RE.test(text) ? 9 : 8,
                        durability: 'permanent'
                    }, { source, importance: 8 });
                }
                if (MAJOR_RELATION_RE.test(text)) {
                    const inferredPair = entities.length >= 2
                        ? entities
                        : ((/(두\s*사람|둘은|서로|the two|both of them)/i.test(text) && knownNames.length === 2) ? knownNames : [subject, ...entities]);
                    const pair = uniqueStrings(inferredPair, 2);
                    add('relationshipMilestones', {
                        ...shared,
                        text,
                        pair,
                        axis: inferRelationAxis(text),
                        direction: inferDirection(text),
                        importance: /(결혼|약혼|이별|절교|배신|married|engaged|breakup|betrayed)/i.test(text) ? 10 : 8,
                        durability: IRREVERSIBLE_RE.test(text) ? 'permanent' : 'long'
                    }, { source, importance: 8 });
                }
                if (STATE_CHANGE_RE.test(text)) {
                    add('stateChanges', {
                        ...shared,
                        text,
                        entity: subject || entities[0] || '',
                        domain: inferStateDomain(text),
                        slot: inferStateSlot(text),
                        after: text,
                        importance: IRREVERSIBLE_RE.test(text) ? 9 : 7,
                        durability: IRREVERSIBLE_RE.test(text) ? 'permanent' : 'long'
                    }, { source, importance: 7 });
                }
                if (OPEN_LOOP_RE.test(text) && !LOOP_RESOLVED_RE.test(text)) {
                    add('openLoops', {
                        ...shared,
                        text,
                        type: /(수수께끼|의문|단서|비밀|mystery|clue|secret|find out|figure out)/i.test(text) ? 'mystery' : 'goal',
                        status: 'open',
                        resolutionCriteria: [clip(`Resolve or explicitly close: ${text}`, 140)],
                        importance: 7,
                        durability: 'long'
                    }, { source, importance: 7 });
                } else if (LOOP_RESOLVED_RE.test(text)) {
                    add('openLoops', {
                        ...shared,
                        text,
                        type: 'resolution',
                        status: 'resolved',
                        resolution: text,
                        importance: 6,
                        durability: 'long'
                    }, { source, importance: 6 });
                }
                if (CALLBACK_RE.test(text) && /(주었|건넸|건네|받았|간직|남겼|새겼|기억|약속|중요|상징|gave|handed|received|kept|left|engraved|remember|promise|important|symbol)/i.test(text)) {
                    add('callbacks', {
                        ...shared,
                        text,
                        label: clip(text, 100),
                        importance: 7,
                        durability: 'long'
                    }, { source, importance: 7 });
                }
            }
            const hasSignals = CATEGORY_ORDER.some(category => category !== 'episodes' && result[category].length > 0);
            if (hasSignals) {
                const payloadScene = options.scene && typeof options.scene === 'object' ? options.scene : {};
                const episodeText = clip(dedupeTextArray(durableSentences).slice(0, 3).join(' / '), 420);
                if (episodeText) {
                    result.episodes = normalizeCategoryList('episodes', [{
                        text: episodeText,
                        summary: episodeText,
                        location: payloadScene.location || options.location || '',
                        time: payloadScene.time || options.time || '',
                        entities: knownNames.filter(name => episodeText.toLowerCase().includes(name.toLowerCase())).slice(0, 8),
                        importance: Math.max(6, ...CATEGORY_ORDER.filter(category => category !== 'episodes').flatMap(category => result[category].map(item => Number(item.importance || 0)))),
                        durability: 'long',
                        status: 'active',
                        source: 'heuristic:episode'
                    }], { turn, entityRefs: knownNames, source: 'heuristic:episode' });
                }
            }
            const normalized = normalizeTurnMemory(result, { turn, entityRefs: knownNames, source: 'heuristic' });
            normalized.tags = dedupeTextArray([
                ...normalized.tags,
                normalized.stableFacts.length ? 'canon_fact' : '',
                normalized.preferences.length ? 'preference' : '',
                normalized.commitments.length ? 'commitment' : '',
                normalized.openLoops.length ? 'open_loop' : '',
                normalized.relationshipMilestones.length ? 'relationship_milestone' : '',
                normalized.stateChanges.length ? 'state_change' : '',
                normalized.callbacks.length ? 'callback' : ''
            ].filter(Boolean)).slice(0, 16);
            return normalized;
        };
        const hasSignals = (turnMemory = null) => {
            const normalized = normalizeTurnMemory(turnMemory || {});
            return CATEGORY_ORDER.some(category => normalized[category].length > 0);
        };
        const resolveImportance = (turnMemory = null, fallback = 5) => {
            const normalized = normalizeTurnMemory(turnMemory || {}, { importance: fallback });
            if (!hasSignals(normalized)) return clampImportance(fallback, 5);
            return clampImportance(normalized.importance, fallback);
        };
        const getRetentionPolicy = (turnMemory = null, importance = 5, config = {}) => {
            const normalized = normalizeTurnMemory(turnMemory || {}, { importance });
            const defaultTtl = importance >= Math.max(9, Number(config.threshold || 6) + 2) ? -1 : (importance >= Number(config.threshold || 6) ? 60 : 30);
            if (!hasSignals(normalized)) return { ttl: defaultTtl, protected: false, durability: 'short', reasons: [] };
            const longTtl = Math.max(120, Number(config.rpLongTermLongTtl || 720) || 720);
            const mediumTtl = Math.max(60, Number(config.rpLongTermMediumTtl || 240) || 240);
            let ttl = defaultTtl;
            if (normalized.protected || normalized.durability === 'permanent') ttl = -1;
            else if (normalized.durability === 'long') ttl = longTtl;
            else if (normalized.durability === 'medium') ttl = mediumTtl;
            else ttl = Math.max(defaultTtl, 80);
            return {
                ttl,
                protected: normalized.protected === true || ttl === -1,
                durability: normalized.durability,
                reasons: normalized.retentionReasons || [],
                importance: resolveImportance(normalized, importance)
            };
        };
        const attachToPayload = (payload = null, userText = '', aiText = '', options = {}) => {
            if (!payload || typeof payload !== 'object') return payload;
            const entityRefs = uniqueStrings([
                ...(Array.isArray(options.entityRefs) ? options.entityRefs : []),
                ...(Array.isArray(payload?.participants?.canonicalEntities) ? payload.participants.canonicalEntities : []),
                ...(Array.isArray(payload?.mentionedEntityNames) ? payload.mentionedEntityNames : [])
            ], 24);
            const heuristic = extractHeuristic(userText, aiText, {
                ...options,
                turn: options.turn || payload.turn || payload.source?.turn || 0,
                entityRefs,
                scene: payload.scene || options.scene || {}
            });
            const merged = mergeTurnMemory(payload.rpLongTerm || null, heuristic, {
                turn: options.turn || payload.turn || payload.source?.turn || 0,
                entityRefs,
                source: 'turn_capture'
            });
            const next = { ...payload, rpLongTerm: merged };
            next.importance = Math.max(Number(payload.importance || 0), resolveImportance(merged, Number(payload.importance || 5)));
            next.tags = dedupeTextArray([...(Array.isArray(payload.tags) ? payload.tags : []), ...(merged.tags || [])]).slice(0, 18);
            return next;
        };
        const flattenForSearch = (turnMemory = null) => {
            const normalized = normalizeTurnMemory(turnMemory || {});
            const parts = [
                ...(normalized.tags || []),
                ...(normalized.retentionReasons || [])
            ];
            for (const category of CATEGORY_ORDER) {
                for (const item of normalized[category] || []) {
                    parts.push(category, item.text, item.subject, item.owner, item.target, item.slot, item.value, item.kind, item.topic, item.type, item.axis, item.direction, item.domain, item.before, item.after, item.label, item.location, item.time, item.status);
                    parts.push(...(item.entities || []), ...(item.pair || []), ...(item.knownBy || []), ...(item.resolutionCriteria || []), ...(item.consequences || []));
                }
            }
            return dedupeTextArray(parts.map(value => String(value || '').trim()).filter(Boolean)).join('\n');
        };
        const formatTurnForDisplay = (turnMemory = null, maxChars = 240) => {
            const normalized = normalizeTurnMemory(turnMemory || {});
            const lines = [];
            const add = (label, items, limit = 1) => {
                const texts = (Array.isArray(items) ? items : []).map(item => item?.text || item?.summary).filter(Boolean).slice(0, limit);
                if (texts.length) lines.push(`${label}: ${texts.join(' / ')}`);
            };
            add('Canon', normalized.stableFacts, 1);
            add('Promise', normalized.commitments.filter(item => ACTIVE_STATUS.has(normalizeStatus(item.status))), 1);
            add('Open', normalized.openLoops.filter(item => ACTIVE_STATUS.has(normalizeStatus(item.status))), 1);
            add('Relation', normalized.relationshipMilestones, 1);
            add('State', normalized.stateChanges, 1);
            add('Callback', normalized.callbacks, 1);
            return clip(lines.join(' | '), maxChars);
        };
        const buildTurnMemoryRef = (turnMemory = null, options = {}) => {
            const normalized = normalizeTurnMemory(turnMemory || {}, options);
            const counts = {};
            for (const category of CATEGORY_ORDER) {
                const count = Array.isArray(normalized[category]) ? normalized[category].length : 0;
                if (count > 0) counts[category] = count;
            }
            return {
                schema: 'libra.rp_turn_memory.ref.v1',
                turn: Math.max(0, Number(options.turn || normalized.turn || 0) || 0),
                durability: normalized.durability || 'short',
                protected: normalized.protected === true,
                retentionReasons: uniqueStrings(normalized.retentionReasons || [], 8),
                tags: uniqueStrings(normalized.tags || [], 10),
                counts,
                summary: formatTurnForDisplay(normalized, 320)
            };
        };
        const compactPayloadTurnMemory = (payload = null, turnMemory = null, options = {}) => {
            if (!payload || typeof payload !== 'object') return payload;
            const source = turnMemory || payload.rpLongTerm || null;
            if (!source) return payload;
            const next = { ...payload, rpLongTermRef: buildTurnMemoryRef(source, options) };
            delete next.rpLongTerm;
            return next;
        };
        const emptyState = () => ({
            schema: SCHEMA,
            version: VERSION,
            revision: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            migratedFromLegacy: false,
            migrationTurnFloor: 0,
            sourceMemoryKeys: [],
            stableFacts: [],
            preferences: [],
            commitments: [],
            openLoops: [],
            relationshipMilestones: [],
            stateChanges: [],
            callbacks: [],
            episodes: []
        });
        const normalizeState = (raw = null) => {
            const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
            const state = {
                ...emptyState(),
                ...value,
                schema: SCHEMA,
                version: VERSION,
                revision: Math.max(0, Number(value.revision || 0) || 0),
                createdAt: Number(value.createdAt || Date.now()) || Date.now(),
                updatedAt: Number(value.updatedAt || Date.now()) || Date.now(),
                migratedFromLegacy: value.migratedFromLegacy === true,
                migrationTurnFloor: Math.max(0, Number(value.migrationTurnFloor || 0) || 0),
                sourceMemoryKeys: dedupeTextArray((Array.isArray(value.sourceMemoryKeys) ? value.sourceMemoryKeys : [])
                    .map(item => String(item || '').trim()).filter(Boolean)).slice(-1600)
            };
            for (const category of CATEGORY_ORDER) state[category] = normalizeCategoryList(category, value[category] || [], { source: 'aggregate', maxItems: CATEGORY_LIMITS[category] || 120 });
            return state;
        };
        const findStateEntryIndex = (lore = []) => (Array.isArray(lore) ? lore : []).findIndex(entry => String(entry?.comment || '').trim() === COMMENT || String(entry?.key || '').trim() === KEY);
        const parseStateEntry = (entry = null) => {
            if (!entry?.content) return null;
            try {
                const parsed = JSON.parse(String(entry.content || ''));
                return parsed && typeof parsed === 'object' ? normalizeState(parsed) : null;
            } catch (_) { return null; }
        };
        const migrateLegacyMemories = (lore = [], state = null, options = {}) => {
            let next = normalizeState(state || {});
            const maxEntries = Math.max(220, Math.min(4000, Number(options.maxEntries || 1200) || 1200));
            const entries = (Array.isArray(lore) ? lore : [])
                .filter(entry => String(entry?.comment || '') === 'lmai_memory')
                .slice(-maxEntries);
            const seenKeys = new Set((next.sourceMemoryKeys || []).map(value => String(value || '').trim()).filter(Boolean));
            let highestTurn = next.migrationTurnFloor || 0;
            for (const entry of entries) {
                // 키는 반드시 `memory_hash:<hash>` 정규형으로 통일한다.
                // `entry.key` 는 getSafeMapKey 산출물(`<hash>_<앞8>_<뒤4>`)일 수 있는데,
                // 본문이 `[META:{...` 로 시작하면 `-1457614357_[META:{"_"}}` 처럼
                // 의미 없는 문자열이 되고, 같은 기억이 정상형과 깨진형으로 이중 등록된다.
                // 실측: 89개 키 중 20개가 깨진형이고 그 20개가 정상형과 해시가 겹쳤다.
                const rawEntryKey = String(entry?.key || '').trim();
                const entryKeyHash = rawEntryKey.match(/^(-?\d+)(?:_|$)/);
                const memoryKey = entryKeyHash
                    ? `memory_hash:${entryKeyHash[1]}`
                    : (rawEntryKey && !rawEntryKey.includes('[')
                        ? rawEntryKey
                        : `memory_hash:${TokenizerEngine.simpleHash(String(entry?.content || ''))}`);
                if (options.force !== true && seenKeys.has(memoryKey)) continue;
                let payload = null;
                try { payload = CompactMemoryCodec.parsePayloadFromEntry(entry) || null; } catch (_) { payload = null; }
                if (!payload) continue;
                const entryMeta = parseLibraMetaObject(entry.content, {});
                const hybridRow = payload?.hybridRow && typeof payload.hybridRow === 'object' ? payload.hybridRow : {};
                if (
                    entryMeta.hiddenFromPrompt === true
                    || hybridRow.hiddenFromPrompt === true
                    || hybridRow.stale === true
                    || String(hybridRow.rollbackState || '').toLowerCase() === 'candidate_deleted'
                ) continue;
                seenKeys.add(memoryKey);
                const turn = Math.max(0, Number(payload.turn || payload.source?.turn || entryMeta.t || 0) || 0);
                highestTurn = Math.max(highestTurn, turn);
                let derived = payload.rpLongTerm ? normalizeTurnMemory(payload.rpLongTerm, { turn, source: 'legacy_migration' }) : null;
                if (!derived || !hasSignals(derived)) {
                    const openThreads = Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads : [];
                    const relationSignals = [
                        ...(Array.isArray(payload?.continuity?.relationSignals) ? payload.continuity.relationSignals : []),
                        ...(Array.isArray(payload?.relationDeltas) ? payload.relationDeltas.map(item => ({ ...item, text: item?.text || item?.delta || item?.trigger })) : [])
                    ];
                    // Legacy ledger facts are event-centric. Reclassify their text through
                    // the RP continuity extractor instead of promoting every high-scored fact to
                    // permanent canon; otherwise one-off actions become immutable character facts.
                    const legacyEntityRefs = dedupeTextArray([
                        ...(Array.isArray(payload?.participants?.canonicalEntities) ? payload.participants.canonicalEntities : []),
                        ...(Array.isArray(payload?.mentionedEntityNames) ? payload.mentionedEntityNames : []),
                        ...(Array.isArray(payload?.facts) ? payload.facts.flatMap(item => Array.isArray(item?.entities) ? item.entities : []) : [])
                    ].map(item => String(item || '').trim()).filter(Boolean)).slice(0, 16);
                    const highFactTexts = (Array.isArray(payload?.facts) ? payload.facts : [])
                        .filter(item => Number(item?.importance || 0) >= 0.75 && item?.type !== 'user_turn')
                        .map(item => String(item?.text || '').trim())
                        .filter(Boolean)
                        .slice(0, 8);
                    const legacyEvidenceText = dedupeTextArray([
                        ...highFactTexts,
                        Number(payload.importance || 0) >= 7 ? String(payload.summary || '').trim() : ''
                    ].filter(Boolean)).join('\n');
                    const legacyHeuristic = legacyEvidenceText
                        ? extractHeuristic('', legacyEvidenceText, {
                            turn,
                            entityRefs: legacyEntityRefs,
                            source: 'legacy_migration'
                        })
                        : normalizeTurnMemory({ turn, importance: Number(payload.importance || 5) }, {
                            turn,
                            entityRefs: legacyEntityRefs,
                            source: 'legacy_migration'
                        });
                    const explicitLegacySignals = normalizeTurnMemory({
                        turn,
                        importance: Number(payload.importance || 5),
                        openLoops: openThreads.map(item => ({ ...item, status: item?.status || 'open', source: 'legacy_open_thread' })),
                        relationshipMilestones: relationSignals.map(item => ({ ...item, text: item?.text || item?.delta || '', source: 'legacy_relation_signal' })),
                        episodes: Number(payload.importance || 0) >= 8 && payload.summary ? [{
                            text: payload.summary,
                            summary: payload.summary,
                            entities: legacyEntityRefs,
                            importance: payload.importance,
                            durability: 'long',
                            confidence: 0.62,
                            source: 'legacy_high_importance_episode'
                        }] : []
                    }, { turn, entityRefs: legacyEntityRefs, source: 'legacy_migration' });
                    derived = mergeTurnMemory(legacyHeuristic, explicitLegacySignals, {
                        turn,
                        entityRefs: legacyEntityRefs,
                        source: 'legacy_migration'
                    });
                }
                if (hasSignals(derived)) {
                    next = mergeIntoState(next, derived, { turn, source: 'legacy_migration', bumpRevision: false });
                }
            }
            next.migratedFromLegacy = true;
            next.migrationTurnFloor = highestTurn;
            next.sourceMemoryKeys = Array.from(seenKeys).slice(-1600);
            return normalizeState(next);
        };
        const loadState = (lore = [], options = {}) => {
            const index = findStateEntryIndex(lore);
            const parsed = index >= 0 ? parseStateEntry(lore[index]) : null;
            let state = parsed || emptyState();
            if (options.migrate !== false && (!parsed || state.migratedFromLegacy !== true)) state = migrateLegacyMemories(lore, state);
            return normalizeState(state);
        };
        const saveState = (lore = [], state = null) => {
            if (!Array.isArray(lore)) return { changed: false, reason: 'invalid_lore', state: normalizeState(state) };
            const normalized = normalizeState(state || {});
            normalized.updatedAt = Date.now();
            const entry = {
                key: KEY,
                comment: COMMENT,
                content: JSON.stringify(normalized),
                mode: 'constant',
                insertorder: 12,
                alwaysActive: false
            };
            const index = findStateEntryIndex(lore);
            const previous = index >= 0 ? String(lore[index]?.content || '') : '';
            const changed = previous !== entry.content;
            if (index >= 0) lore[index] = { ...lore[index], ...entry };
            else lore.push(entry);
            return { changed, state: normalized, entry };
        };
        const stateItemRank = (item = null) => {
            if (!item) return -Infinity;
            const active = ACTIVE_STATUS.has(normalizeStatus(item.status)) ? 1200 : 0;
            const permanent = DURABILITY_RANK[item.durability] === 3 ? 900 : (DURABILITY_RANK[item.durability] === 2 ? 320 : 0);
            const visibilityPenalty = item.visibility === 'secret' ? -10 : 0;
            return active + permanent + (Number(item.importance || 0) * 40) + (Number(item.confidence || 0) * 30) + (Number(item.reinforcement || 1) * 4) + Math.min(600, Number(item.lastTurn || 0)) + visibilityPenalty;
        };
        const pruneStateCategory = (category = '', items = []) => {
            const limit = CATEGORY_LIMITS[category] || 120;
            return [...(Array.isArray(items) ? items : [])]
                .sort((a, b) => stateItemRank(b) - stateItemRank(a) || Number(b.lastTurn || 0) - Number(a.lastTurn || 0))
                .slice(0, limit)
                .sort((a, b) => Number(a.firstTurn || 0) - Number(b.firstTurn || 0));
        };
        function mergeIntoState(state = null, turnMemory = null, options = {}) {
            const next = normalizeState(state || {});
            const normalized = normalizeTurnMemory(turnMemory || {}, { turn: options.turn || turnMemory?.turn || 0, source: options.source || turnMemory?.source || 'turn' });
            for (const category of CATEGORY_ORDER) {
                const bucket = [...(next[category] || [])];
                for (const incoming of normalized[category] || []) {
                    let idx = bucket.findIndex(existing => isMatchingItem(category, existing, incoming));
                    if (idx < 0) idx = findStatusResolutionMatchIndex(category, bucket, incoming);
                    if (idx >= 0) bucket[idx] = mergeItems(category, bucket[idx], incoming);
                    else bucket.push(incoming);
                }
                next[category] = pruneStateCategory(category, bucket);
            }
            if (options.bumpRevision !== false && hasSignals(normalized)) next.revision = Math.max(0, Number(next.revision || 0)) + 1;
            next.updatedAt = Date.now();
            return next;
        }
        const upsertFromTurn = (lore = [], turnMemory = null, options = {}) => {
            if (!Array.isArray(lore) || !turnMemory) return { changed: false, reason: 'invalid_input' };
            const normalized = normalizeTurnMemory(turnMemory, { turn: options.turn || turnMemory.turn || 0, entityRefs: options.entityRefs || [], source: options.source || 'turn_commit' });
            if (!hasSignals(normalized)) return { changed: false, reason: 'no_durable_signals', turnMemory: normalized };
            const current = loadState(lore, { migrate: options.migrate !== false });
            const next = mergeIntoState(current, normalized, { turn: options.turn || normalized.turn, source: options.source || 'turn_commit' });
            // 들어온 키를 정규형으로 통일한다. 호출자가 getSafeMapKey 산출물
            // (`<hash>_<앞8>_<뒤4>`) 을 넘기면 본문이 `[META:{...` 로 시작할 때
            // `-1457614357_[META:{"_"}}` 같은 문자열이 저장되고, 같은 기억이
            // 정상형과 깨진형으로 이중 등록된다 (실측 89개 중 20개).
            const rawSourceKey = String(options.sourceMemoryKey || '').trim();
            const sourceKeyHash = rawSourceKey.match(/^(-?\d+)(?:_|$)/);
            const sourceMemoryKey = !rawSourceKey
                ? ''
                : (sourceKeyHash
                    ? `memory_hash:${sourceKeyHash[1]}`
                    : (rawSourceKey.includes('[') ? '' : rawSourceKey));
            if (sourceMemoryKey) next.sourceMemoryKeys = dedupeTextArray([...(next.sourceMemoryKeys || []), sourceMemoryKey]).slice(-1600);
            const saved = saveState(lore, next);
            return { ...saved, turnMemory: normalized };
        };
