        const buildCanonicalRecordsV3 = (payload = {}, options = {}) => {
            const turn = normalizeLegacyMemoryTurnAnchor(payload.turn || payload.source?.turn || options.turn || 0) || undefined;
            const sourceHash = String(payload.source?.sourceHash || payload.sourceHash || options.sourceHash || '').trim();
            const messageIds = normalizeCanonicalMessageIds(payload.source?.sourceMessageIds || payload.sourceMessageIds || options.sourceMessageIds || []);
            const entities = Array.isArray(payload?.participants?.canonicalEntities) ? payload.participants.canonicalEntities.slice(0, MAX_ENTITIES) : [];
            const records = [];
            const seenClaims = new Set();
            const add = (kind, textValue, extra = {}) => {
                const text = clip(textValue, 360);
                if (!text) return;
                const claimKey = String(extra.claimKey || `${kind}:${text}`).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
                if (seenClaims.has(claimKey)) return;
                seenClaims.add(claimKey);
                const recordEntities = dedupeTextArray(Array.isArray(extra.entities) ? extra.entities : entities).slice(0, MAX_ENTITIES);
                records.push({
                    schema: RECORD_SCHEMA,
                    version: 3,
                    id: String(extra.id || makeLedgerId('record', claimKey, turn || 0, records.length)),
                    kind,
                    scope: {
                        characterId: String(options.characterId || '').trim(),
                        chatId: String(options.chatId || '').trim(),
                        sessionId: String(options.sessionId || options.scopeKey || '').trim()
                    },
                    source: {
                        turn,
                        turnKey: String(options.turnKey || '').trim(),
                        messageIds,
                        roles: dedupeTextArray(extra.roles || ['assistant']),
                        evidenceHash: String(extra.evidenceHash || sourceHash || TokenizerEngine.simpleHash(text))
                    },
                    claim: { key: claimKey, text, entities: recordEntities },
                    epistemic: {
                        status: String(extra.status || 'observed'),
                        confidence: Math.max(0.05, Math.min(0.99, Number(extra.confidence ?? 0.72))),
                        visibility: String(extra.visibility || 'public'),
                        authority: String(extra.authority || 'continuity_evidence'),
                        executable: false
                    },
                    lifecycle: {
                        state: String(extra.lifecycleState || 'active'),
                        validFromTurn: turn,
                        supersedes: dedupeTextArray(extra.supersedes || []).slice(0, 8)
                    },
                    retention: {
                        tier: String(extra.tier || 'episodic'),
                        salience: Math.max(0.05, Math.min(1, Number(extra.salience ?? 0.55)))
                    }
                });
            };
            for (const evidence of Array.isArray(payload.userEvidence) ? payload.userEvidence : []) {
                add('evidence', evidence?.text, {
                    id: evidence?.id,
                    claimKey: `user:${evidence?.kind || 'assertion'}:${evidence?.evidenceHash || evidence?.text || ''}`,
                    roles: ['user'],
                    status: 'user_asserted',
                    authority: 'evidence_only',
                    evidenceHash: evidence?.evidenceHash,
                    confidence: 1,
                    tier: 'episodic',
                    salience: 0.5,
                    entities: []
                });
            }
            for (const fact of Array.isArray(payload.facts) ? payload.facts : []) {
                add(fact?.type === 'world_rule' ? 'world_delta' : 'fact', fact?.text, {
                    id: fact?.id,
                    claimKey: `fact:${fact?.type || 'event'}:${fact?.text || ''}`,
                    entities: fact?.entities,
                    confidence: fact?.confidence,
                    salience: fact?.importance
                });
            }
            for (const delta of Array.isArray(payload.relationDeltas) ? payload.relationDeltas : []) {
                add('relation_delta', delta?.delta || delta?.text, {
                    id: delta?.id,
                    claimKey: `relation:${(delta?.pair || []).join('|')}:${delta?.delta || delta?.text || ''}`,
                    entities: delta?.pair,
                    confidence: delta?.confidence,
                    salience: 0.7
                });
            }
            for (const thread of Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads : []) {
                add('thread', thread?.text || thread?.label, {
                    id: thread?.id,
                    claimKey: `thread:${thread?.text || thread?.label || ''}`,
                    entities: thread?.entities,
                    confidence: thread?.confidence,
                    lifecycleState: thread?.status === 'resolved' ? 'resolved' : 'active',
                    salience: 0.68
                });
            }
            for (const change of Array.isArray(payload?.continuity?.worldChanges) ? payload.continuity.worldChanges : []) {
                add('world_delta', change?.text || change?.summary || change?.value, {
                    claimKey: `world:${change?.key || change?.type || ''}:${change?.text || change?.summary || change?.value || ''}`,
                    entities: change?.entities || [],
                    confidence: change?.confidence,
                    salience: 0.72
                });
            }
            if (payload?.entityStates && typeof payload.entityStates === 'object' && !Array.isArray(payload.entityStates)) {
                for (const [entity, state] of Object.entries(payload.entityStates)) {
                    for (const value of Array.isArray(state?.visibleState) ? state.visibleState : []) {
                        add('state', value, {
                            claimKey: `state:${entity}:visible:${value}`,
                            entities: [entity],
                            status: 'observed',
                            confidence: 0.72,
                            salience: 0.52
                        });
                    }
                    for (const value of Array.isArray(state?.inferredState) ? state.inferredState : []) {
                        add('state', value, {
                            claimKey: `state:${entity}:inferred:${value}`,
                            entities: [entity],
                            status: 'inferred',
                            confidence: 0.5,
                            salience: 0.45
                        });
                    }
                }
            }
            return records.slice(0, 28);
        };
        const isLedgerStatusOrControlText = (text = '') => {
            const raw = String(text || '').trim();
            if (!raw) return false;
            return /^★📍/.test(raw)
                || /^🚪/.test(raw)
                || /🚪\s*[^:\n]{1,24}:/.test(raw)
                || /^§\s*(?:[월화수목금토일]|Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(raw)
                || /^<img\b/i.test(raw)
                || /^<GT-|^<\/GigaTrans>/i.test(raw)
                || /^#{1,4}\s*(?:Response|응답|Volume|볼륨|Chapter|챕터|Chatindex)/i.test(raw);
        };
        const normalizeLedgerEvidenceSource = (source = 'assistant', text = '') => {
            const raw = String(text || '').trim();
            if (/^★📍|^🚪/.test(raw)) return 'status_block';
            return String(source || 'assistant').trim() || 'assistant';
        };
        const classifyLedgerEvidenceKind = (source = 'assistant', text = '') => {
            const normalizedSource = normalizeLedgerEvidenceSource(source, text);
            if (normalizedSource === 'user') return 'user_input';
            if (normalizedSource === 'status_block') return 'status_block';
            return 'direct_quote';
        };
        const ledgerEvidenceTokens = (text = '') => (String(text || '').match(/[A-Za-z0-9가-힣]{2,}/g) || [])
            .map(token => token.toLowerCase())
            .filter(token => !/^(the|and|for|with|that|this|저기|그녀|그는|그리고|하지만|있다|했다)$/.test(token))
            .slice(0, 24);
        const buildLedgerEvidenceRecords = (user = '', snippets = [], turn = 0) => {
            const records = [];
            const seen = new Set();
            const add = (source = 'assistant', textValue = '', supports = []) => {
                const text = clip(stripUserTurnSummaryText(textValue), MAX_SNIPPET_CHARS);
                if (!text) return;
                const normalizedSource = normalizeLedgerEvidenceSource(source, text);
                if (isUserLedgerSource(normalizedSource, classifyLedgerEvidenceKind(source, text))) return;
                const key = `${normalizedSource}:${text}`;
                if (seen.has(key)) return;
                seen.add(key);
                records.push({
                    id: makeLedgerId('ev', key, turn || 0, records.length),
                    source: normalizedSource,
                    kind: classifyLedgerEvidenceKind(source, text),
                    text,
                    turn: normalizeLegacyMemoryTurnAnchor(turn || 0) || undefined,
                    quoteHash: String(TokenizerEngine.simpleHash(text)),
                    supports: dedupeTextArray(Array.isArray(supports) ? supports : []).slice(0, 8)
                });
            };
            for (const snip of Array.isArray(snippets) ? snippets : []) {
                add(snip?.source || 'assistant', snip?.text || '', ['facts.scene_result', 'beats']);
            }
            return records.slice(0, MAX_SNIPPETS + 2);
        };
        const evidenceIdsForLedgerText = (text = '', evidenceRecords = [], fallbackCount = 1) => {
            const raw = String(text || '').toLowerCase();
            if (!raw) return [];
            const tokens = new Set(ledgerEvidenceTokens(raw));
            const scored = (Array.isArray(evidenceRecords) ? evidenceRecords : [])
                .map(ev => {
                    const evText = String(ev?.text || '').toLowerCase();
                    if (!ev?.id || !evText) return null;
                    let score = 0;
                    if (raw.includes(evText.slice(0, Math.min(48, evText.length))) || evText.includes(raw.slice(0, Math.min(48, raw.length)))) score += 5;
                    const evTokens = ledgerEvidenceTokens(evText);
                    const overlap = evTokens.filter(token => tokens.has(token)).length;
                    score += overlap;
                    return score > 0 ? { id: ev.id, score } : null;
                })
                .filter(Boolean)
                .sort((a, b) => b.score - a.score);
            const ids = scored.slice(0, 3).map(item => item.id);
            if (!ids.length && fallbackCount > 0) {
                return (Array.isArray(evidenceRecords) ? evidenceRecords : []).slice(0, fallbackCount).map(ev => ev?.id).filter(Boolean);
            }
            return dedupeTextArray(ids).slice(0, 3);
        };
        const attachEvidenceIdsToLedgerFacts = (facts = [], evidenceRecords = []) => (Array.isArray(facts) ? facts : [])
            .map(fact => ({
                ...fact,
                evidenceIds: evidenceIdsForLedgerText([
                    fact?.text,
                    ...(Array.isArray(fact?.evidence) ? fact.evidence.map(ev => ev?.text || ev) : [])
                ].filter(Boolean).join('\n'), evidenceRecords, 1)
            }));
        const buildLedgerBeats = ({ user = '', ai = '', entityRefs = [], evidenceRecords = [], openThreads = [], relationSignals = [], turn = 0 } = {}) => {
            const raw = [user, ai].filter(Boolean).join('\n');
            const beats = [];
            const add = (type = 'event', summary = '', seedText = '', confidence = 0.68, entities = entityRefs) => {
                const body = clip(summary, 240);
                if (!body || beats.some(item => item.type === type && item.summary === body)) return;
                beats.push({
                    id: makeLedgerId('beat', `${type}:${body}`, turn || 0, beats.length),
                    type,
                    summary: body,
                    entities: (Array.isArray(entities) ? entities : []).slice(0, 6),
                    evidenceIds: evidenceIdsForLedgerText(seedText || body, evidenceRecords, 1),
                    confidence: Math.max(0.1, Math.min(0.98, Number(confidence || 0.68)))
                });
            };
            for (const thread of Array.isArray(openThreads) ? openThreads : []) {
                add('open_thread', thread?.text || thread?.label || '', [thread?.text, ...(Array.isArray(thread?.resolutionCriteria) ? thread.resolutionCriteria : [])].filter(Boolean).join('\n'), thread?.confidence || 0.6, thread?.entities || entityRefs);
            }
            for (const signal of Array.isArray(relationSignals) ? relationSignals : []) {
                add('relation_delta', signal?.text || '', signal?.text || '', signal?.confidence || 0.52, signal?.entities || entityRefs);
            }
            return beats.slice(0, 10);
        };
        const buildLedgerEntityStates = ({ text = '', entityRefs = [], evidenceRecords = [] } = {}) => {
            const raw = String(text || '');
            const states = {};
            const addState = (entity = '', bucket = 'visibleState', value = '', seed = '') => {
                const name = String(entity || '').trim();
                const body = clip(value, 120);
                if (!name || !body) return;
                const current = states[name] || { visibleState: [], inferredState: [], evidenceIds: [] };
                current[bucket] = dedupeTextArray([...(current[bucket] || []), body]).slice(0, 8);
                current.evidenceIds = dedupeTextArray([...(current.evidenceIds || []), ...evidenceIdsForLedgerText(seed || body, evidenceRecords, 1)]).slice(0, 8);
                states[name] = current;
            };
            for (const entity of Array.isArray(entityRefs) ? entityRefs : []) {
                const base = ledgerEntityBaseName(entity);
                if (base && raw.includes(base)) addState(entity, 'visibleState', '현재 장면에 직접 관여하거나 언급된다.', base);
            }
            return states;
        };
        const buildLedgerSceneCore = ({ scene = {}, text = '', evidenceRecords = [] } = {}) => {
            const locationStatus = scene?.location ? 'explicit' : '';
            return {
                time: clip(scene?.time || '', 80),
                location: clip(scene?.location || '', 120),
                locationStatus,
                scenePhase: '',
                activeProblem: '',
                nextPhysicalAction: '',
                evidenceIds: evidenceIdsForLedgerText([scene?.time, scene?.location, scene?.summary].filter(Boolean).join('\n'), evidenceRecords, 1)
            };
        };
        const buildLedgerSummaryV2 = ({ user = '', summary = '', sceneCore = {}, beats = [], openThreads = [], tags = [], recallKeywords = [], entityRefs = [] } = {}) => {
            const beatSummaries = (Array.isArray(beats) ? beats : [])
                .filter(beat => !['user_action'].includes(beat?.type))
                .map(beat => beat?.summary)
                .filter(Boolean);
            const threadTexts = (Array.isArray(openThreads) ? openThreads : []).map(thread => thread?.text || thread?.label).filter(Boolean);
            const oneLine = clip(summary || beatSummaries[0] || '', MAX_SUMMARY_CHARS);
            const continuity = clip([
                sceneCore?.location ? `장소: ${sceneCore.location}${sceneCore.locationStatus ? ` (${sceneCore.locationStatus})` : ''}` : '',
                sceneCore?.activeProblem ? `단서: ${sceneCore.activeProblem}` : '',
                sceneCore?.nextPhysicalAction ? `다음 행동: ${sceneCore.nextPhysicalAction}` : '',
                ...beatSummaries.slice(0, 4),
                ...threadTexts.slice(0, 3)
            ].filter(Boolean).join(' / '), 560);
            const recall = clip(dedupeTextArray([
                ...(Array.isArray(recallKeywords) ? recallKeywords : []),
                ...(Array.isArray(tags) ? tags : []),
                ...(Array.isArray(entityRefs) ? entityRefs : []),
                ...(Array.isArray(openThreads) ? openThreads.flatMap(thread => [thread?.label, thread?.text, ...(Array.isArray(thread?.resolutionCriteria) ? thread.resolutionCriteria : [])]) : [])
            ].filter(Boolean)).join(' / '), 420);
            return { oneLine, continuity, recall };
        };
        const extractLedgerScene = (text = '') => {
            const raw = String(text || '');
            const time = (
                raw.match(/\[(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s*\([^)]+\))?\s+\d{1,2}:\d{2}\s*(?:AM|PM|오전|오후)?)\]/i)?.[1]
                || raw.match(/⏱️?\s*\[([^\]]{6,80})\]/)?.[1]
                || ''
            );
            const location = (
                raw.match(/★📍\s*([^§\n]{2,60})\s*§/)?.[1]
                || raw.match(/(?:위치는|장소는|장소:|위치:)\s*["“]?([^"”\n.。!?]{2,60})/)?.[1]
                || ''
            );
            return {
                time: clip(time, 80),
                location: clip(location, 120),
                summary: clip([time, location].filter(Boolean).join(' | '), 180)
            };
        };
        const extractUnresolvedMentions = () => [];
        const extractLedgerGroups = () => [];
        const buildLedgerFacts = (user = '', ai = '', summary = '', snippets = [], entityRefs = [], options = {}) => {
            const turn = normalizeLegacyMemoryTurnAnchor(options.turn || options.t || 0) || 0;
            const importance = Math.max(1, Math.min(10, Number(options.importance || 5) || 5));
            const facts = [];
            const pushFact = (type = 'event', textValue = '', source = 'assistant', confidence = 0.78) => {
                const body = clip(textValue, 360);
                if (!body || facts.some(item => item.text === body)) return;
                const actors = resolveLedgerFactActors(body, source, entityRefs, {
                    unresolvedMentions: options.unresolvedMentions,
                    groups: options.groups
                });
                facts.push({
                    id: makeLedgerId('fact', `${type}:${source}:${body}`, turn, facts.length),
                    type,
                    text: body,
                    entities: actors.entities,
                    subjects: actors.subjects,
                    observerEntities: actors.observerEntities,
                    evidence: [{ source, text: clip(textValue, 220) }],
                    confidence: Math.max(0.1, Math.min(0.98, Number(confidence || 0.78))),
                    importance: Number((importance / 10).toFixed(2))
                });
            };
            for (const snip of Array.isArray(snippets) ? snippets : []) {
                if (isUserLedgerSource(snip?.source, snip?.kind)) continue;
                pushFact('scene_result', stripUserTurnSummaryText(snip?.text || ''), snip?.source || 'assistant', 0.82);
                if (facts.length >= 5) break;
            }
            if (!facts.length && summary) pushFact('summary', summary, 'derived', 0.66);
            return facts.slice(0, 6);
        };
        const buildLedgerOpenThreads = (text = '', entityRefs = [], unresolvedMentions = [], groups = [], turn = 0, primaryConflict = '') => {
            const openThreads = [];
            const refs = [];
            refs.push(...(Array.isArray(entityRefs) ? entityRefs : []).map(entity => ledgerRefObject('entity', entity, 'observer')));
            const subjectRefs = dedupeLedgerRefs(refs);
            const addThread = (textValue = '', criteria = [], confidence = 0.58, status = 'open', extra = {}) => {
                const body = clip(textValue, 280);
                if (!body || openThreads.some(item => item.text === body)) return;
                openThreads.push({
                    id: makeLedgerId('thread', body, turn || 0, openThreads.length),
                    label: clip(extra.label || body, 120),
                    text: body,
                    entities: (Array.isArray(entityRefs) ? entityRefs : []).slice(0, 6),
                    subjectRefs,
                    resolutionCriteria: dedupeTextArray(criteria).slice(0, 8),
                    status,
                    firstTurn: normalizeLegacyMemoryTurnAnchor(turn || 0) || undefined,
                    lastSeenTurn: normalizeLegacyMemoryTurnAnchor(turn || 0) || undefined,
                    confidence
                });
            };
            if (primaryConflict) addThread(primaryConflict, ['갈등 해소 확인'], 0.58);
            return openThreads.slice(0, 6);
        };
        const sanitizeLedgerPayload = (payload = {}, meta = {}) => {
            if (!isLedgerPayload(payload)) return { payload, changed: false };
            let changed = false;
            const nextSchema = isV3BundlePayload(payload) ? BUNDLE_SCHEMA : LEDGER_SCHEMA;
            const next = { ...payload, schema: nextSchema, version: nextSchema === BUNDLE_SCHEMA ? BUNDLE_VERSION : LEDGER_VERSION };
            if (next.userRequestMetadata !== undefined) {
                delete next.userRequestMetadata;
                changed = true;
            }
            if (next.source && typeof next.source === 'object' && !Array.isArray(next.source) && next.source.userRequestMetadata !== undefined) {
                next.source = { ...next.source };
                delete next.source.userRequestMetadata;
                changed = true;
            }
            if (typeof next.summary === 'string') {
                const cleanSummary = stripUserTurnSummaryText(next.summary);
                if (cleanSummary !== next.summary) changed = true;
                next.summary = cleanSummary;
            }
            const evidenceText = buildLedgerEvidenceText(next);
            const participants = next.participants && typeof next.participants === 'object' && !Array.isArray(next.participants)
                ? { ...next.participants }
                : {};
            const beforeParticipants = JSON.stringify(next.participants || {});
            const rawEntities = [
                ...(Array.isArray(participants.canonicalEntities) ? participants.canonicalEntities : []),
                ...(Array.isArray(next.mentionedEntityNames) ? next.mentionedEntityNames : []),
                ...(Array.isArray(next.entityRefs) ? next.entityRefs : [])
            ];
            const canonicalEntities = sanitizeLedgerEntityList(rawEntities, evidenceText);
            participants.canonicalEntities = canonicalEntities;
            participants.unresolvedMentions = Array.isArray(participants.unresolvedMentions)
                ? participants.unresolvedMentions.filter(item => item && item.promoteToEntity !== true).slice(0, 8)
                : [];
            participants.groups = Array.isArray(participants.groups) ? participants.groups.slice(0, 6) : [];
            if (JSON.stringify(participants) !== beforeParticipants) changed = true;
            next.participants = participants;

            const cleanTags = sanitizeLedgerTags(next.tags || [], evidenceText, next.retrospectiveClass);
            if (JSON.stringify(cleanTags) !== JSON.stringify(Array.isArray(next.tags) ? next.tags : [])) changed = true;
            next.tags = cleanTags;
            const cleanRecallKeywords = sanitizeLedgerRecallKeywords(next.recallKeywords || [], evidenceText);
            if (JSON.stringify(cleanRecallKeywords) !== JSON.stringify(Array.isArray(next.recallKeywords) ? next.recallKeywords : [])) changed = true;
            next.recallKeywords = cleanRecallKeywords;

            const cleanArcKey = sanitizeLedgerArcKey(next.arcKey, next.retrospectiveClass);
            if (cleanArcKey !== String(next.arcKey || '').trim()) changed = true;
            next.arcKey = cleanArcKey;

            const cleanConflict = sanitizeLedgerConflictText(next.primaryConflict);
            if (cleanConflict !== String(next.primaryConflict || '').trim()) changed = true;
            next.primaryConflict = cleanConflict;

            const cleanRelationDelta = sanitizeLedgerRelationText(next.relationDelta, canonicalEntities);
            if (cleanRelationDelta !== String(next.relationDelta || '').trim()) changed = true;
            next.relationDelta = cleanRelationDelta;

            if (Array.isArray(next.facts)) {
                const cleanFacts = next.facts.map(fact => {
                    if (!fact || typeof fact !== 'object') return null;
                    if (/^(?:user_turn|user_evidence)$/i.test(String(fact.type || '').trim())) return null;
                    const factEntities = sanitizeLedgerEntityList(fact.entities || [], [evidenceText, fact.text].filter(Boolean).join('\n'));
                    const cleanEvidence = Array.isArray(fact.evidence)
                        ? fact.evidence
                            .filter(ev => !isUserLedgerSource(ev?.source, ev?.kind))
                            .map(ev => ({ ...ev, text: clip(stripUserTurnSummaryText(ev?.text || ''), 220) }))
                            .filter(ev => ev.text)
                            .slice(0, 3)
                        : [];
                    return {
                        ...fact,
                        entities: factEntities,
                        subjects: sanitizeLedgerRefObjects(fact.subjects || []),
                        observerEntities: sanitizeLedgerEntityList(fact.observerEntities || [], [evidenceText, fact.text].filter(Boolean).join('\n')),
                        evidence: cleanEvidence,
                        evidenceIds: dedupeTextArray(Array.isArray(fact.evidenceIds) ? fact.evidenceIds.map(value => clip(value, 80)).filter(Boolean) : [])
                    };
                }).filter(Boolean).slice(0, 6);
                if (JSON.stringify(cleanFacts) !== JSON.stringify(next.facts)) changed = true;
                next.facts = cleanFacts;
            }

            const continuity = next.continuity && typeof next.continuity === 'object' && !Array.isArray(next.continuity)
                ? { ...next.continuity }
                : { openThreads: [], relationSignals: [], worldChanges: [] };
            const cleanOpenThreads = (Array.isArray(continuity.openThreads) ? continuity.openThreads : [])
                .map(item => item && typeof item === 'object' ? {
                    ...item,
                    label: clip(item.label || item.text || '', 120),
                    text: sanitizeLedgerConflictText(item.text),
                    entities: sanitizeLedgerEntityList(item.entities || [], evidenceText),
                    subjectRefs: sanitizeLedgerRefObjects(item.subjectRefs || []),
                    resolutionCriteria: dedupeTextArray(Array.isArray(item.resolutionCriteria) ? item.resolutionCriteria.map(value => clip(value, 80)).filter(Boolean) : []),
                    evidenceIds: dedupeTextArray(Array.isArray(item.evidenceIds) ? item.evidenceIds.map(value => clip(value, 80)).filter(Boolean) : []),
                    status: clip(item.status || 'open', 40),
                    firstTurn: normalizeLegacyMemoryTurnAnchor(item.firstTurn || item.turn || meta.turn || meta.t || 0) || item.firstTurn,
                    lastSeenTurn: normalizeLegacyMemoryTurnAnchor(item.lastSeenTurn || item.turn || meta.turn || meta.t || 0) || item.lastSeenTurn
                } : null)
                .filter(item => item?.text)
                .slice(0, 8);
            const cleanRelationSignals = (Array.isArray(continuity.relationSignals) ? continuity.relationSignals : [])
                .map(item => item && typeof item === 'object' ? { ...item, text: sanitizeLedgerRelationText(item.text, canonicalEntities), entities: sanitizeLedgerEntityList(item.entities || canonicalEntities, evidenceText) } : null)
                .filter(item => item?.text)
                .slice(0, 8);
            const cleanWorldChanges = (Array.isArray(continuity.worldChanges) ? continuity.worldChanges : [])
                .map(item => item && typeof item === 'object'
                    ? { ...item, tags: sanitizeLedgerTags(item.tags || [], evidenceText, next.retrospectiveClass) }
                    : null)
                .filter(Boolean)
                .slice(0, 8);
            if (JSON.stringify(cleanOpenThreads) !== JSON.stringify(continuity.openThreads || [])
                || JSON.stringify(cleanRelationSignals) !== JSON.stringify(continuity.relationSignals || [])
                || JSON.stringify(cleanWorldChanges) !== JSON.stringify(continuity.worldChanges || [])) changed = true;
            next.continuity = {
                openThreads: cleanOpenThreads,
                relationSignals: cleanRelationSignals,
                worldChanges: cleanWorldChanges
            };

            if (Array.isArray(next.evidence)) {
                const cleanEvidence = next.evidence
                    .map(item => item && typeof item === 'object' ? {
                        id: clip(item.id || '', 80),
                        source: clip(item.source || 'assistant', 40),
                        kind: clip(item.kind || 'direct_quote', 40),
                        text: clip(stripUserTurnSummaryText(item.text || ''), MAX_SNIPPET_CHARS),
                        turn: normalizeLegacyMemoryTurnAnchor(item.turn || meta.turn || meta.t || 0) || item.turn,
                        quoteHash: clip(item.quoteHash || '', 80),
                        supports: dedupeTextArray(Array.isArray(item.supports) ? item.supports.map(value => clip(value, 80)).filter(Boolean) : [])
                    } : null)
                    .filter(item => item?.id && item?.text && !isUserLedgerSource(item.source, item.kind))
                    .slice(0, MAX_SNIPPETS + 2);
                if (JSON.stringify(cleanEvidence) !== JSON.stringify(next.evidence)) changed = true;
                next.evidence = cleanEvidence;
            }
            if (Array.isArray(next.userEvidence)) {
                const cleanUserEvidence = next.userEvidence
                    .map((item, index) => item && typeof item === 'object' ? {
                        id: clip(item.id || makeLedgerId('user-evidence', item.text || '', item.turn || meta.turn || meta.t || 0, index), 96),
                        sourceRole: 'user',
                        kind: clip(item.kind || classifyUserEvidence(item.text || ''), 40),
                        text: clip(item.text || '', 220),
                        turn: normalizeLegacyMemoryTurnAnchor(item.turn || meta.turn || meta.t || 0) || item.turn,
                        evidenceHash: clip(item.evidenceHash || TokenizerEngine.simpleHash(item.text || ''), 80),
                        epistemicStatus: 'user_asserted',
                        authority: 'evidence_only',
                        executable: false
                    } : null)
                    .filter(item => item?.id && item?.text)
                    .slice(0, 3);
                if (JSON.stringify(cleanUserEvidence) !== JSON.stringify(next.userEvidence)) changed = true;
                next.userEvidence = cleanUserEvidence;
            }
            if (Array.isArray(next.beats)) {
                const cleanBeats = next.beats
                    .map(item => item && typeof item === 'object' ? {
                        id: clip(item.id || '', 80),
                        type: clip(item.type || 'event', 40),
                        summary: clip(item.summary || '', 240),
                        entities: sanitizeLedgerEntityList(item.entities || [], evidenceText),
                        evidenceIds: dedupeTextArray(Array.isArray(item.evidenceIds) ? item.evidenceIds.map(value => clip(value, 80)).filter(Boolean) : []),
                        confidence: Math.max(0.1, Math.min(0.98, Number(item.confidence || 0.68)))
                    } : null)
                    .filter(item => item?.summary && item.type !== 'user_action')
                    .slice(0, 10);
                if (JSON.stringify(cleanBeats) !== JSON.stringify(next.beats)) changed = true;
                next.beats = cleanBeats;
            }
            if (Array.isArray(next.directEvidenceSnippets)) {
                const cleanSnippets = next.directEvidenceSnippets
                    .map(item => typeof item === 'string' ? { source: 'assistant', text: item } : item)
                    .filter(item => item && typeof item === 'object' && !isUserLedgerSource(item.source, item.kind))
                    .map(item => ({ ...item, text: clip(stripUserTurnSummaryText(item.text || ''), MAX_SNIPPET_CHARS) }))
                    .filter(item => item.text)
                    .slice(0, MAX_SNIPPETS);
                if (JSON.stringify(cleanSnippets) !== JSON.stringify(next.directEvidenceSnippets)) changed = true;
                next.directEvidenceSnippets = cleanSnippets;
            }
            if (Array.isArray(next.recallAnchors)) {
                const cleanAnchors = next.recallAnchors
                    .map(item => item && typeof item === 'object' ? {
                        ...item,
                        summary: clip(stripUserTurnSummaryText(item.summary || ''), 180),
                        hint: clip(item.hint || '', 180)
                    } : null)
                    .filter(item => item && (item.summary || item.hint))
                    .slice(0, MAX_ANCHORS);
                if (JSON.stringify(cleanAnchors) !== JSON.stringify(next.recallAnchors)) changed = true;
                next.recallAnchors = cleanAnchors;
            }
            if (next.summaryV2 && typeof next.summaryV2 === 'object' && !Array.isArray(next.summaryV2)) {
                const cleanSummaryV2 = {
                    oneLine: clip(stripUserTurnSummaryText(next.summaryV2.oneLine || next.summary || ''), MAX_SUMMARY_CHARS),
                    continuity: clip(stripUserTurnSummaryText(next.summaryV2.continuity || ''), 560),
                    recall: clip(stripUserTurnSummaryText(next.summaryV2.recall || ''), 420)
                };
                if (JSON.stringify(cleanSummaryV2) !== JSON.stringify(next.summaryV2)) changed = true;
                next.summaryV2 = cleanSummaryV2;
            }
            if (next.sceneCore && typeof next.sceneCore === 'object' && !Array.isArray(next.sceneCore)) {
                const cleanSceneCore = {
                    time: clip(next.sceneCore.time || '', 80),
                    location: clip(next.sceneCore.location || '', 120),
                    locationStatus: clip(next.sceneCore.locationStatus || '', 40),
                    scenePhase: clip(next.sceneCore.scenePhase || '', 40),
                    activeProblem: clip(next.sceneCore.activeProblem || '', 220),
                    nextPhysicalAction: clip(next.sceneCore.nextPhysicalAction || '', 180),
                    evidenceIds: dedupeTextArray(Array.isArray(next.sceneCore.evidenceIds) ? next.sceneCore.evidenceIds.map(value => clip(value, 80)).filter(Boolean) : [])
                };
                if (JSON.stringify(cleanSceneCore) !== JSON.stringify(next.sceneCore)) changed = true;
                next.sceneCore = cleanSceneCore;
            }
            if (next.entityStates && typeof next.entityStates === 'object' && !Array.isArray(next.entityStates)) {
                const cleanEntityStates = {};
                for (const [name, state] of Object.entries(next.entityStates)) {
                    const entityName = sanitizeLedgerEntityList([name], evidenceText)[0] || clip(name, 80);
                    if (!entityName || !state || typeof state !== 'object') continue;
                    cleanEntityStates[entityName] = {
                        visibleState: dedupeTextArray(Array.isArray(state.visibleState) ? state.visibleState.map(value => clip(value, 120)).filter(Boolean) : []).slice(0, 8),
                        inferredState: dedupeTextArray(Array.isArray(state.inferredState) ? state.inferredState.map(value => clip(value, 120)).filter(Boolean) : []).slice(0, 8),
                        evidenceIds: dedupeTextArray(Array.isArray(state.evidenceIds) ? state.evidenceIds.map(value => clip(value, 80)).filter(Boolean) : []).slice(0, 8)
                    };
                }
                if (JSON.stringify(cleanEntityStates) !== JSON.stringify(next.entityStates)) changed = true;
                next.entityStates = cleanEntityStates;
            }
            if (Array.isArray(next.relationDeltas)) {
                const cleanRelationDeltas = next.relationDeltas
                    .map(item => item && typeof item === 'object' ? {
                        id: clip(item.id || '', 80),
                        pair: sanitizeLedgerEntityList(item.pair || item.entities || [], evidenceText).slice(0, 2),
                        delta: sanitizeLedgerRelationText(item.delta || item.text || '', canonicalEntities),
                        trigger: clip(item.trigger || '', 160),
                        evidenceIds: dedupeTextArray(Array.isArray(item.evidenceIds) ? item.evidenceIds.map(value => clip(value, 80)).filter(Boolean) : []),
                        confidence: Math.max(0.1, Math.min(0.98, Number(item.confidence || 0.55)))
                    } : null)
                    .filter(item => item?.delta)
                    .slice(0, 6);
                if (JSON.stringify(cleanRelationDeltas) !== JSON.stringify(next.relationDeltas)) changed = true;
                next.relationDeltas = cleanRelationDeltas;
            }

            if (JSON.stringify(next.mentionedEntityNames || []) !== JSON.stringify(canonicalEntities)) changed = true;
            next.mentionedEntityNames = canonicalEntities.slice(0, MAX_ENTITIES);
            if (next.entityRefs !== undefined) { delete next.entityRefs; changed = true; }

            next.retention = {
                ...(next.retention && typeof next.retention === 'object' ? next.retention : {}),
                rawRetention: LEDGER_RAW_RETENTION,
                rawDiscarded: true
            };
            next.rawRetention = LEDGER_RAW_RETENTION;
            next.rawDiscarded = true;
            next.source = {
                ...(next.source && typeof next.source === 'object' ? next.source : {}),
                rawRetention: LEDGER_SOURCE_RETENTION
            };
            if (isV3BundlePayload(next)) {
                const canonicalRecords = buildCanonicalRecordsV3(next, {
                    ...meta,
                    sourceHash: next.source?.sourceHash || next.sourceHash,
                    sourceMessageIds: next.source?.sourceMessageIds || next.sourceMessageIds
                });
                if (JSON.stringify(canonicalRecords) !== JSON.stringify(next.records)) changed = true;
                next.recordSchema = RECORD_SCHEMA;
                next.records = canonicalRecords;
            }
            return { payload: next, changed };
        };
