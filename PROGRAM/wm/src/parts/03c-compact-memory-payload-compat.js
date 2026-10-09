        const buildLedgerPayloadFromParts = ({
            user = '',
            ai = '',
            combined = '',
            summary = '',
            recallAnchors = [],
            directEvidenceSnippets = [],
            entityRefs = [],
            tags = [],
            recallKeywords = [],
            retrospectiveClass = '',
            arcKey = '',
            arcRole = '',
            causalRole = '',
            primaryConflict = '',
            relationDelta = '',
            options = {},
            world = null
        } = {}) => {
            const normalizedTurn = normalizeLegacyMemoryTurnAnchor(options.turn || options.t || 0) || undefined;
            const sourceMessageIds = normalizeCanonicalMessageIds(options.sourceMessageIds || []);
            const createdAt = Date.now();
            const unresolvedMentions = extractUnresolvedMentions(combined || [user, ai].join('\n'), entityRefs, normalizedTurn || 0);
            const groups = extractLedgerGroups(combined || [user, ai].join('\n'), normalizedTurn || 0);
            const evidenceRecords = buildLedgerEvidenceRecords(user, directEvidenceSnippets, normalizedTurn || 0);
            const ledgerFacts = attachEvidenceIdsToLedgerFacts(buildLedgerFacts(user, ai, summary, directEvidenceSnippets, entityRefs, {
                ...options,
                turn: normalizedTurn,
                unresolvedMentions,
                groups
            }), evidenceRecords);
            const relationSignals = relationDelta ? [{
                id: makeLedgerId('relation', relationDelta, normalizedTurn || 0, 0),
                text: relationDelta,
                entities: entityRefs.slice(0, 6),
                status: 'derived_candidate',
                evidenceIds: evidenceIdsForLedgerText(relationDelta, evidenceRecords, 1),
                confidence: 0.52
            }] : [];
            const openThreads = buildLedgerOpenThreads(combined || [user, ai].join('\n'), entityRefs, unresolvedMentions, groups, normalizedTurn || 0, primaryConflict)
                .map(thread => ({
                    ...thread,
                    evidenceIds: evidenceIdsForLedgerText([
                        thread?.text,
                        thread?.label,
                        ...(Array.isArray(thread?.resolutionCriteria) ? thread.resolutionCriteria : [])
                    ].filter(Boolean).join('\n'), evidenceRecords, 1)
                }));
            const worldChanges = world?.worldChange ? [world.worldChange] : [];
            const scene = world?.scene || extractLedgerScene(combined || [user, ai].join('\n'));
            const sceneCore = buildLedgerSceneCore({ scene, text: combined || [user, ai].join('\n'), evidenceRecords });
            const beats = buildLedgerBeats({
                user,
                ai,
                entityRefs,
                evidenceRecords,
                openThreads,
                relationSignals,
                turn: normalizedTurn || 0
            });
            const entityStates = buildLedgerEntityStates({ text: combined || [user, ai].join('\n'), entityRefs, evidenceRecords });
            const relationDeltas = relationSignals.map((signal, idx) => ({
                id: signal.id || makeLedgerId('relation', signal.text || '', normalizedTurn || 0, idx),
                pair: (signal.entities || entityRefs).slice(0, 2),
                delta: signal.text || '',
                trigger: clip((beats.find(beat => beat.type === 'relation_delta')?.summary || primaryConflict || ''), 160),
                evidenceIds: signal.evidenceIds || evidenceIdsForLedgerText(signal.text || '', evidenceRecords, 1),
                confidence: signal.confidence || 0.52
            }));
            if (!relationDeltas.length) {
                const relationBeat = beats.find(beat => beat.type === 'relation_delta');
                if (relationBeat) {
                    relationDeltas.push({
                        id: makeLedgerId('relation', relationBeat.summary, normalizedTurn || 0, 0),
                        pair: (relationBeat.entities || entityRefs).slice(0, 2),
                        delta: relationBeat.summary,
                        trigger: relationBeat.summary,
                        evidenceIds: relationBeat.evidenceIds || [],
                        confidence: relationBeat.confidence || 0.55
                    });
                }
            }
            const summaryV2 = buildLedgerSummaryV2({ user, summary, sceneCore, beats, openThreads, tags, recallKeywords, entityRefs });
            const userEvidence = buildUserEvidenceRecords(user, normalizedTurn || 0);
            const payload = {
                schema: BUNDLE_SCHEMA,
                version: BUNDLE_VERSION,
                turn: normalizedTurn,
                firstSeenTurn: normalizeLegacyMemoryTurnAnchor(options.firstSeenTurn || normalizedTurn || 0) || normalizedTurn,
                source: {
                    turn: normalizedTurn,
                    firstSeenTurn: normalizeLegacyMemoryTurnAnchor(options.firstSeenTurn || normalizedTurn || 0) || normalizedTurn,
                    sourceHash: String(options.sourceHash || '').trim(),
                    sourceMessageIds,
                    createdAt,
                    rawRetention: LEDGER_SOURCE_RETENTION
                },
                scene,
                sceneCore,
                participants: {
                    canonicalEntities: entityRefs.slice(0, MAX_ENTITIES),
                    unresolvedMentions,
                    groups
                },
                facts: ledgerFacts,
                evidence: evidenceRecords,
                userEvidence,
                beats,
                entityStates,
                relationDeltas,
                continuity: {
                    openThreads,
                    relationSignals,
                    worldChanges
                },
                audit: {
                    cautions: [],
                    overpromotionRisks: [],
                    confidence: retrospectiveClass ? 'medium' : 'medium'
                },
                retention: {
                    rawRetention: LEDGER_RAW_RETENTION,
                    rawDiscarded: true
                },
                // Compatibility fields for existing V5 recall/scoring while v1 rows are migrated.
                summary,
                summaryV2,
                recallAnchors,
                directEvidenceSnippets,
                mentionedEntityNames: entityRefs.slice(0, MAX_ENTITIES),
                tags: Array.isArray(tags) ? tags.slice(0, MAX_TAGS) : [],
                recallKeywords: Array.isArray(recallKeywords) ? recallKeywords.slice(0, MAX_RECALL_KEYWORDS) : [],
                importance: Math.max(1, Math.min(10, Number(options.importance || 5) || 5)),
                impression: Math.max(0, Math.min(1, Number(options.impression || 0.5) || 0.5)),
                sourceHash: String(options.sourceHash || '').trim(),
                sourceMessageIds,
                rawRetention: LEDGER_RAW_RETENTION,
                rawDiscarded: true,
                retrospectiveClass,
                recallProfile: retrospectiveClass ? 'continuity_only' : 'default',
                arcKey,
                arcRole,
                causalRole,
                primaryConflict,
                relationDelta,
                createdAt,
                ...(world?.compat || {})
            };
            payload.recordSchema = RECORD_SCHEMA;
            payload.records = buildCanonicalRecordsV3(payload, options);
            return sanitizeLedgerPayload(payload, options).payload;
        };
        const buildTurnPayload = (userText = '', aiText = '', options = {}) => {
            const user = Utils.getMemorySourceText(userText);
            const ai = Utils.getMemorySourceText(aiText);
            if (!ai && !user) return null;
            // User text is retained separately as evidence-only. Canonical entity,
            // world and relation extraction remains grounded in the assistant's
            // observable scene result so a user instruction cannot self-promote.
            const combined = ai;
            const knownEntityOptions = {
                ...options,
                knownEntityNames: getDynamicKnownEntityNames(options)
            };
            let summary = buildSummary(user, ai, knownEntityOptions);
            const retrospectiveClass = normalizeRetrospectiveClass(options.retrospectiveClass || detectRetrospectiveClass(combined, summary));
            if (retrospectiveClass) summary = buildRetrospectiveSummary(summary, retrospectiveClass);
            const entityRefs = extractEntityRefs(combined, {
                ...knownEntityOptions,
                retrospectiveClass,
                strictKnownEntityNamesOnly: Boolean(
                    options?.strictKnownEntityNamesOnly
                    || retrospectiveClass
                    || (Array.isArray(knownEntityOptions.knownEntityNames) && knownEntityOptions.knownEntityNames.length > 0)
                )
            });
            const tags = applyRetrospectiveTags(extractTags(combined), retrospectiveClass);
            const recallKeywords = retrospectiveClass ? [] : extractRecallKeywords(combined, tags);
            const directEvidenceSnippets = retrospectiveClass
                ? []
                : buildSnippets(user, ai, { ...knownEntityOptions, entityRefs });
            const recallAnchors = retrospectiveClass
                ? buildRetrospectiveAnchors(summary, entityRefs, tags, retrospectiveClass)
                : buildAnchors(summary, directEvidenceSnippets, entityRefs, tags, recallKeywords);
            const normalizedTurn = normalizeLegacyMemoryTurnAnchor(options.turn || options.t || 0) || undefined;
            const arcKey = String(
                options.arcKey
                || (retrospectiveClass === 'family_postscript' ? 'family_postscript' : '')
                || (retrospectiveClass === 'global_recap' ? 'global_recap' : '')
                || inferArcKey(combined)
                || ''
            ).trim();
            const arcRole = String(options.arcRole || (retrospectiveClass ? 'retrospective' : inferArcRole(combined)) || '').trim();
            const causalRole = String(options.causalRole || (retrospectiveClass ? 'retrospective' : inferCausalRole(combined)) || '').trim();
            const primaryConflict = clip(options.primaryConflict || inferPrimaryConflict(combined, tags) || '', 260);
            const relationDelta = clip(options.relationDelta || inferRelationDelta(combined, entityRefs) || '', 240);
            return buildLedgerPayloadFromParts({
                user,
                ai,
                combined,
                summary,
                recallAnchors,
                directEvidenceSnippets,
                entityRefs,
                tags,
                recallKeywords,
                retrospectiveClass,
                arcKey,
                arcRole,
                causalRole,
                primaryConflict,
                relationDelta,
                options: {
                    ...options,
                    turn: normalizedTurn,
                    firstSeenTurn: normalizeLegacyMemoryTurnAnchor(options.firstSeenTurn || normalizedTurn || 0) || normalizedTurn
                }
            });
        };
        const buildPayloadFromLegacyContent = (content = '', meta = {}) => {
            let tagged = splitTagged(content);
            const rawBody = Utils.getMemorySourceText(stripMeta(content));
            if ((!tagged.user || !tagged.ai) && /\[(?:USER|AI|ASSISTANT)\]/i.test(rawBody)) {
                const userMatch = rawBody.match(/\[USER\]([\s\S]*?)(?=\[(?:AI|ASSISTANT)\]|$)/i);
                const aiMatch = rawBody.match(/\[(?:AI|ASSISTANT)\]([\s\S]*)$/i);
                tagged = {
                    user: String(userMatch?.[1] || tagged.user || '').trim(),
                    ai: String(aiMatch?.[1] || tagged.ai || '').trim()
                };
            }
            const payload = buildTurnPayload(tagged.user || '', tagged.ai || '', {
                turn: meta.turn || meta.t || meta.finalizedTurn || meta.turnAnchorTurn || 0,
                importance: meta.imp || 5,
                sourceHash: meta.sourceHash || meta.aiHash || meta.responseHash || '',
                sourceMessageIds: meta.sourceMessageIds || meta.liveMessageIds || meta.m_id || []
            });
            if (!payload) return null;
            payload.migratedFrom = 'legacy_raw_memory';
            payload.migratedAt = Date.now();
            return payload;
        };
        const normalizeLedgerPayload = (payload = {}, meta = {}) => {
            if (!isLedgerPayload(payload)) return { payload, changed: false };
            let changed = false;
            const hydratedPayload = isV3BundlePayload(payload) && payload.projectionsCompacted === true
                ? hydrateV3Projections(payload)
                : payload;
            const next = { ...hydratedPayload, schema: BUNDLE_SCHEMA, version: BUNDLE_VERSION };
            if (!isV3BundlePayload(payload)) changed = true;
            if (next.hybridRow !== undefined) { delete next.hybridRow; changed = true; }
            if (next.hme !== undefined) { delete next.hme; changed = true; }
            const turn = normalizeLegacyMemoryTurnAnchor(next.turn || next.source?.turn || meta.t || meta.turn || 0) || undefined;
            if (turn && next.turn !== turn) { next.turn = turn; changed = true; }
            if (!next.source || typeof next.source !== 'object') {
                next.source = {
                    turn,
                    firstSeenTurn: normalizeLegacyMemoryTurnAnchor(next.firstSeenTurn || turn || 0) || turn,
                    sourceHash: String(next.sourceHash || meta.sourceHash || '').trim(),
                    sourceMessageIds: normalizeCanonicalMessageIds(next.sourceMessageIds || meta.sourceMessageIds || meta.liveMessageIds || []),
                    createdAt: Number(next.createdAt || Date.now()) || Date.now(),
                    rawRetention: LEDGER_SOURCE_RETENTION
                };
                changed = true;
            }
            if (!next.participants || typeof next.participants !== 'object') {
                const names = extractEntityRefs([next.summary, ...(Array.isArray(next.mentionedEntityNames) ? next.mentionedEntityNames : [])].filter(Boolean).join('\n'), {
                    knownEntityNames: getDynamicKnownEntityNames({ mentionedEntityNames: next.mentionedEntityNames || [] })
                });
                next.participants = {
                    canonicalEntities: names,
                    unresolvedMentions: extractUnresolvedMentions(next.summary || '', names, turn || 0),
                    groups: extractLedgerGroups(next.summary || '', turn || 0)
                };
                changed = true;
            }
            if (!Array.isArray(next.facts) || next.facts.length === 0) {
                next.facts = buildLedgerFacts('', '', next.summary || '', next.directEvidenceSnippets || [], next.participants?.canonicalEntities || next.mentionedEntityNames || [], { ...meta, turn, importance: next.importance || meta.imp || 5 });
                changed = true;
            }
            if (!next.continuity || typeof next.continuity !== 'object') {
                next.continuity = { openThreads: [], relationSignals: [], worldChanges: [] };
                changed = true;
            }
            if (!next.audit || typeof next.audit !== 'object') {
                next.audit = { cautions: [], overpromotionRisks: [], confidence: 'medium' };
                changed = true;
            }
            if (!next.retention || typeof next.retention !== 'object') {
                next.retention = { rawRetention: LEDGER_RAW_RETENTION, rawDiscarded: true };
                changed = true;
            }
            const sanitized = sanitizeLedgerPayload(next, meta);
            return { payload: sanitized.payload, changed: changed || sanitized.changed };
        };
        const legacyHybridToProjection = (meta = {}, payload = {}) => {
            const hme = meta?.hme && typeof meta.hme === 'object'
                ? meta.hme
                : (payload?.hybridRow && typeof payload.hybridRow === 'object' ? payload.hybridRow : (payload?.hme && typeof payload.hme === 'object' ? payload.hme : {}));
            const sourceTurnIds = dedupeTextArray([
                ...(Array.isArray(hme?.sourceTurnIds) ? hme.sourceTurnIds : []),
                payload?.turn,
                payload?.firstSeenTurn,
                meta?.t,
                meta?.turnAnchorTurn
            ].map(v => String(normalizeLegacyMemoryTurnAnchor(v) || '').trim()).filter(Boolean)).map(Number).filter(Boolean);
            return {
                schema: 'libra.memory.projection_pointer.v1',
                hmeDerivedAtReadTime: true,
                sourceTurnIds,
                staleCandidateIds: Array.isArray(hme?.staleCandidateIds) ? hme.staleCandidateIds.slice(0, 8) : [],
                rollbackState: String(hme?.rollbackState || meta?.rollbackState || '').trim(),
                hiddenFromPrompt: hme?.hiddenFromPrompt === true,
                stale: hme?.stale === true,
                staleReason: String(hme?.staleReason || '').trim()
            };
        };
        const stripLedgerMetaHme = (meta = {}, payload = {}) => {
            const nextMeta = { ...(meta || {}) };
            const hadHme = !!(nextMeta.hme || payload?.hybridRow || payload?.hme);
            if (hadHme || !nextMeta.projection) {
                nextMeta.projection = {
                    ...(nextMeta.projection && typeof nextMeta.projection === 'object' ? nextMeta.projection : {}),
                    ...legacyHybridToProjection(nextMeta, payload)
                };
            }
            if (nextMeta.hme !== undefined) delete nextMeta.hme;
            return { meta: nextMeta, changed: hadHme };
        };
        const upgradeLegacyCompactPayload = (payload = {}, meta = {}) => {
            if (!isLegacyCompactPayload(payload)) return null;
            const legacyHybrid = payload.hybridRow && typeof payload.hybridRow === 'object'
                ? payload.hybridRow
                : (payload.hme && typeof payload.hme === 'object' ? payload.hme : {});
            const knownNames = getDynamicKnownEntityNames({
                mentionedEntityNames: payload.mentionedEntityNames || legacyHybrid.subjects || []
            });
            const entityRefs = extractEntityRefs([
                ...(Array.isArray(payload.mentionedEntityNames) ? payload.mentionedEntityNames : []),
                ...(Array.isArray(payload.entityRefs) ? payload.entityRefs : []),
                ...(Array.isArray(legacyHybrid.subjects) ? legacyHybrid.subjects : [])
            ].join('\n'), { knownEntityNames: knownNames });
            const tags = dedupeTextArray((Array.isArray(payload.tags) ? payload.tags : [])
                .map(tag => String(tag || '').trim())
                .filter(tag => tag && !/^(?:current|cause|trigger|escalation|result|write_path_adapter)$/i.test(tag)))
                .slice(0, MAX_TAGS);
            const snippets = Array.isArray(payload.directEvidenceSnippets)
                ? payload.directEvidenceSnippets.map(item => typeof item === 'string' ? { source: 'legacy', text: item } : item).filter(Boolean).slice(0, MAX_SNIPPETS)
                : [];
            const anchors = Array.isArray(payload.recallAnchors) ? payload.recallAnchors.slice(0, MAX_ANCHORS) : [];
            const turn = normalizeLegacyMemoryTurnAnchor(payload.turn || meta.t || meta.turn || 0) || undefined;
            const relationDelta = entityRefs.length >= 2 ? clip(payload.relationDelta || '', 240) : '';
            const worldSignature = String(payload.worldSignature || payload.world?.signature || '').trim();
            const worldCompat = worldSignature || payload.world ? {
                worldChange: {
                    id: `world.${String(worldSignature || stableHash(payload.summary || '')).replace(/^-/, 'n')}`,
                    type: payload.arcKey === 'world_rule_snapshot' ? 'world_rule_snapshot' : 'world_fact',
                    text: clip(payload.summary || payload.worldSummary || '', 420),
                    summary: clip(payload.summary || payload.worldSummary || '', 420),
                    tags: dedupeTextArray([...(Array.isArray(payload.tags) ? payload.tags : []), ...(Array.isArray(legacyHybrid.worldTags) ? legacyHybrid.worldTags : [])]).slice(0, 12),
                    signature: worldSignature,
                    confidence: 0.78
                },
                // scene.summary 에 타입 이름을 넣으면 검색 본문이 'world_rule_snapshot' 이
                // 되어 의미 검색을 오염시킨다 (03d 의 compatParts 와 같은 부류).
                // 장면 요약이 없으면 비워 둔다 — 없는 내용을 타입 이름으로 채우지 않는다.
                scene: { time: '', location: '', summary: '' },
                compat: {
                    classification: payload.classification || '',
                    worldSignature,
                    worldSummary: payload.worldSummary || '',
                    world: payload.world && typeof payload.world === 'object' ? safeClone(payload.world) : undefined
                }
            } : null;
            const upgraded = buildLedgerPayloadFromParts({
                user: '',
                ai: '',
                combined: [
                    payload.summary,
                    payload.primaryConflict,
                    payload.relationDelta,
                    ...(Array.isArray(payload.tags) ? payload.tags : []),
                    ...snippets.map(item => item?.text || '')
                ].filter(Boolean).join('\n'),
                summary: clip(payload.summary || snippets.map(item => item?.text || '').filter(Boolean).join(' / ') || payload.primaryConflict || payload.relationDelta || '', MAX_SUMMARY_CHARS),
                recallAnchors: anchors,
                directEvidenceSnippets: snippets,
                entityRefs,
                tags,
                retrospectiveClass: normalizeRetrospectiveClass(payload.retrospectiveClass || legacyHybrid.retrospectiveClass || ''),
                arcKey: String(payload.arcKey || '').trim(),
                arcRole: String(payload.arcRole || '').trim(),
                causalRole: String(payload.causalRole || '').trim(),
                primaryConflict: clip(payload.primaryConflict || '', 260),
                relationDelta,
                options: {
                    turn,
                    firstSeenTurn: normalizeLegacyMemoryTurnAnchor(payload.firstSeenTurn || turn || 0) || turn,
                    importance: payload.importance || meta.imp || 5,
                    impression: payload.impression || 0.5,
                    sourceHash: payload.sourceHash || meta.sourceHash || '',
                    sourceMessageIds: payload.sourceMessageIds || meta.sourceMessageIds || meta.liveMessageIds || []
                },
                world: worldCompat
            });
            if (!upgraded) return null;
            upgraded.migratedFrom = 'compact_turn_v1';
            upgraded.migratedAt = Date.now();
            upgraded.legacySchema = SCHEMA;
            return upgraded;
        };
        const normalizePayloadForWrite = (payload = null, meta = {}) => {
            if (!payload || typeof payload !== 'object') return payload;
            if (isLedgerPayload(payload)) {
                const normalized = normalizeLedgerPayload(payload, meta).payload;
                return sanitizeLedgerPayload(normalized, meta).payload;
            }
            if (isLegacyCompactPayload(payload)) return upgradeLegacyCompactPayload(payload, meta) || payload;
            return payload;
        };
        const hydrateV3Projections = (payload = null) => {
            if (!isV3BundlePayload(payload) || payload.projectionsCompacted !== true || !Array.isArray(payload.records)) return payload;
            const next = { ...payload };
            const records = payload.records.filter(record => record?.schema === RECORD_SCHEMA && record?.claim?.text);
            next.userEvidence = records
                .filter(record => record?.epistemic?.status === 'user_asserted' && record?.source?.roles?.includes('user'))
                .map(record => ({
                    id: record.id,
                    sourceRole: 'user',
                    kind: String(record.claim?.key || '').split(':')[1] || 'assertion',
                    text: record.claim.text,
                    turn: record.source?.turn,
                    evidenceHash: record.source?.evidenceHash || '',
                    epistemicStatus: 'user_asserted',
                    authority: 'evidence_only',
                    executable: false
                }));
            next.facts = records
                .filter(record => record.kind === 'fact')
                .map(record => ({
                    id: record.id,
                    type: String(record.claim?.key || '').split(':')[1] || 'event',
                    text: record.claim.text,
                    entities: record.claim.entities || [],
                    subjects: [],
                    observerEntities: [],
                    evidence: [],
                    evidenceIds: [],
                    confidence: record.epistemic?.confidence ?? 0.7,
                    importance: record.retention?.salience ?? 0.5
                }));
            next.evidence = [];
            next.beats = next.facts.slice(0, 8).map(fact => ({
                id: `beat:${fact.id}`,
                type: fact.type,
                summary: fact.text,
                entities: fact.entities,
                evidenceIds: [],
                confidence: fact.confidence
            }));
            next.relationDeltas = records
                .filter(record => record.kind === 'relation_delta')
                .map(record => ({
                    id: record.id,
                    pair: record.claim.entities || [],
                    delta: record.claim.text,
                    trigger: '',
                    evidenceIds: [],
                    confidence: record.epistemic?.confidence ?? 0.55
                }));
            const openThreads = records
                .filter(record => record.kind === 'thread')
                .map(record => ({
                    id: record.id,
                    label: record.claim.text,
                    text: record.claim.text,
                    entities: record.claim.entities || [],
                    subjectRefs: [],
                    resolutionCriteria: [],
                    status: record.lifecycle?.state === 'resolved' ? 'resolved' : 'open',
                    firstTurn: record.lifecycle?.validFromTurn,
                    lastSeenTurn: record.source?.turn,
                    confidence: record.epistemic?.confidence ?? 0.6,
                    evidenceIds: []
                }));
            const worldChanges = records
                .filter(record => record.kind === 'world_delta')
                .map(record => ({
                    id: record.id,
                    text: record.claim.text,
                    entities: record.claim.entities || [],
                    confidence: record.epistemic?.confidence ?? 0.7
                }));
            next.continuity = { openThreads, relationSignals: next.relationDeltas.map(item => ({ ...item, text: item.delta, entities: item.pair })), worldChanges };
            const entityStates = {};
            for (const record of records.filter(item => item.kind === 'state')) {
                const entity = String(record.claim?.entities?.[0] || '').trim();
                if (!entity) continue;
                if (!entityStates[entity]) entityStates[entity] = { visibleState: [], inferredState: [], evidenceIds: [] };
                const bucket = record.epistemic?.status === 'inferred' ? 'inferredState' : 'visibleState';
                entityStates[entity][bucket].push(record.claim.text);
            }
            next.entityStates = entityStates;
            return next;
        };
        const compactV3ForStorage = (payload = null) => {
            if (!isV3BundlePayload(payload) || !Array.isArray(payload.records)) return payload;
            const compacted = { ...payload, projectionsCompacted: true };
            for (const key of ['facts', 'evidence', 'userEvidence', 'beats', 'entityStates', 'relationDeltas', 'continuity', 'directEvidenceSnippets']) {
                delete compacted[key];
            }
            return compacted;
        };
        const normalizePayloadForRead = (payload = null, meta = {}) => {
            if (!payload || typeof payload !== 'object') return payload;
            if (isLedgerPayload(payload)) return sanitizeLedgerPayload(hydrateV3Projections(payload), meta).payload;
            if (isLegacyCompactPayload(payload)) return upgradeLegacyCompactPayload(payload, meta) || payload;
            return payload;
        };
        const serialize = (payload = null) => JSON.stringify(compactV3ForStorage(payload) || {}, null, 0);
