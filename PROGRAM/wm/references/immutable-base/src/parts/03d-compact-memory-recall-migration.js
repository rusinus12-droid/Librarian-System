        // 검색/채점 텍스트에서 내부 식별자 토큰을 걸러내는 공용 헬퍼.
        // arcKey/arcRole/type/kind/source 는 라우팅용 식별자이고 실제 값이
        // 'world_rule_snapshot', 'current', 'narrative_source_record' 같은 타입 이름이라
        // 그대로 넣으면 임베딩이 의미 내용 대신 타입 토큰을 학습한다.
        // 실측(2026-09-27, qwen3-embedding 4096D, 실제 저장 항목):
        //   무관 질의 최고 코사인 0.5243 → 식별자 제거 후 0.3837.
        const RECALL_IDENTIFIER_TOKEN_RE = /^(?:world_rule_snapshot|world_fact|turn_summary|current|cause|trigger|escalation|result|write_path_adapter|continuity|establishment|development|resolution|narrative_source_record|ai_response|assistant)$/i;
        const searchableIdentifier = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            if (RECALL_IDENTIFIER_TOKEN_RE.test(raw)) return '';
            return raw.replace(/[_-]+/g, ' ').trim();
        };
        const buildSearchTextFromPayload = (payload = null, meta = {}) => {
            payload = normalizePayloadForRead(payload, meta) || payload;
            if (!isCompactPayload(payload)) return '';
            const ledger = isLedgerPayload(payload);
            const snippets = Array.isArray(payload.directEvidenceSnippets)
                ? payload.directEvidenceSnippets.map(item => typeof item === 'string' ? item : item?.text).filter(Boolean)
                : [];
            const anchors = Array.isArray(payload.recallAnchors)
                ? payload.recallAnchors.flatMap(item => [item?.summary, item?.hint]).filter(Boolean)
                : [];
            const ledgerSummaryV2 = ledger && payload.summaryV2 && typeof payload.summaryV2 === 'object'
                ? [payload.summaryV2.oneLine, payload.summaryV2.continuity, payload.summaryV2.recall].filter(Boolean)
                : [];
            const ledgerFacts = ledger && Array.isArray(payload.facts)
                ? payload.facts.flatMap(item => [
                    item?.text,
                    ...(Array.isArray(item?.subjects) ? item.subjects.flatMap(ref => [ref?.label, ref?.role]) : []),
                    ...(Array.isArray(item?.observerEntities) ? item.observerEntities : []),
                    ...(Array.isArray(item?.evidence) ? item.evidence.map(ev => ev?.text || ev).filter(Boolean) : [])
                ]).filter(Boolean)
                : [];
            const ledgerParticipants = ledger
                ? [
                    ...(Array.isArray(payload?.participants?.canonicalEntities) ? payload.participants.canonicalEntities : []),
                    ...(Array.isArray(payload?.participants?.unresolvedMentions) ? payload.participants.unresolvedMentions.flatMap(item => [item?.label, item?.role, item?.evidence]) : []),
                    ...(Array.isArray(payload?.participants?.groups) ? payload.participants.groups.flatMap(item => [item?.label, item?.role, item?.evidence]) : [])
                ].filter(Boolean)
                : [];
            const ledgerContinuity = ledger
                ? [
                    ...(Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads.flatMap(item => [
                        item?.label,
                        item?.text,
                        item?.status,
                        ...(Array.isArray(item?.subjectRefs) ? item.subjectRefs.flatMap(ref => [ref?.label, ref?.role]) : []),
                        ...(Array.isArray(item?.resolutionCriteria) ? item.resolutionCriteria : []),
                        ...(Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])
                    ]) : []),
                    ...(Array.isArray(payload?.continuity?.relationSignals) ? payload.continuity.relationSignals.flatMap(item => [item?.text, item?.status, ...(Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])]) : []),
                    ...(Array.isArray(payload?.continuity?.worldChanges) ? payload.continuity.worldChanges.flatMap(item => [item?.text, item?.summary]) : [])
                ].filter(Boolean)
                : [];
            const userEvidence = ledger && Array.isArray(payload.userEvidence)
                ? payload.userEvidence.map(item => item?.text).filter(Boolean)
                : [];
            const ledgerScene = ledger && payload.scene && typeof payload.scene === 'object'
                ? [payload.scene.time, payload.scene.location, payload.scene.summary].filter(Boolean)
                : [];
            const ledgerSceneCore = ledger && payload.sceneCore && typeof payload.sceneCore === 'object'
                ? [
                    payload.sceneCore.time,
                    payload.sceneCore.location,
                    payload.sceneCore.locationStatus,
                    payload.sceneCore.scenePhase,
                    payload.sceneCore.activeProblem,
                    payload.sceneCore.nextPhysicalAction
                ].filter(Boolean)
                : [];
            const ledgerBeats = ledger && Array.isArray(payload.beats)
                ? payload.beats.flatMap(item => [item?.summary, ...(Array.isArray(item?.entities) ? item.entities : [])]).filter(Boolean)
                : [];
            const ledgerEvidence = ledger && Array.isArray(payload.evidence)
                ? payload.evidence.flatMap(item => [item?.text]).filter(Boolean)
                : [];
            const ledgerEntityStates = ledger && payload.entityStates && typeof payload.entityStates === 'object'
                ? Object.entries(payload.entityStates).flatMap(([name, state]) => [
                    name,
                    ...(Array.isArray(state?.visibleState) ? state.visibleState : []),
                    ...(Array.isArray(state?.inferredState) ? state.inferredState : [])
                ]).filter(Boolean)
                : [];
            const ledgerRelationDeltas = ledger && Array.isArray(payload.relationDeltas)
                ? payload.relationDeltas.flatMap(item => [item?.delta, item?.trigger, ...(Array.isArray(item?.pair) ? item.pair : [])]).filter(Boolean)
                : [];
            const payloadWorld = (payload && payload.world && typeof payload.world === 'object' && !Array.isArray(payload.world)) ? payload.world : {};
            const worldRuleHighlights = [
                ...(Array.isArray(payloadWorld?.ruleHighlights) ? payloadWorld.ruleHighlights : []),
                ...extractWorldRuleHighlights(normalizeWorldRuleUpdate(payloadWorld), 8)
            ].map(value => String(value || '').trim()).filter(Boolean);
            const hme = (!ledger && payload && typeof payload.hybridRow === 'object') ? payload.hybridRow : ((!ledger && payload && typeof payload.hme === 'object') ? payload.hme : {});
            const hmeArrays = !ledger ? [
                hme.subjects, hme.aliases, hme.tags, hme.sceneTags, hme.emotionTags,
                hme.relationTags, hme.worldTags, hme.narrativeTags, hme.kinds, hme.kind
            ].flatMap(item => Array.isArray(item) ? item : (item ? [item] : [])) : [];
            const retrospectiveClass = normalizeRetrospectiveClass(payload?.retrospectiveClass || hme?.retrospectiveClass || '');
            const continuityOnly = isContinuityOnlyRecallProfile(payload);
            const compatParts = ledger ? [
                searchableIdentifier(payload.arcKey),
                searchableIdentifier(payload.arcRole),
                searchableIdentifier(payload.causalRole)
            ] : [
                payload.arcKey,
                payload.arcRole,
                payload.causalRole,
                payload.primaryConflict,
                payload.relationDelta,
                ...(Array.isArray(payload.tags) ? payload.tags : []),
                ...(Array.isArray(payload.mentionedEntityNames) ? payload.mentionedEntityNames : [])
            ];
            const baseParts = [
                payload.summary,
                ...ledgerSummaryV2,
                ...(Array.isArray(payload.recallKeywords) ? payload.recallKeywords : []),
                ...ledgerFacts,
                ...ledgerParticipants,
                ...ledgerContinuity,
                ...userEvidence,
                ...ledgerScene,
                ...ledgerSceneCore,
                ...ledgerBeats,
                ...ledgerEvidence,
                ...ledgerEntityStates,
                ...ledgerRelationDeltas,
                payload?.classification?.primary || payload?.classification,
                payload.worldSummary,
                payloadWorld?.classification?.primary,
                payloadWorld?.userCorrection,
                ...worldRuleHighlights,
                ...compatParts,
                (typeof RPContinuityCore !== 'undefined' ? RPContinuityCore.flattenForSearch(payload.rpLongTerm) : ''),
                payload?.rpLongTermRef?.summary || '',
                retrospectiveClass ? retrospectiveClass.replace(/_/g, ' ') : '',
                continuityOnly ? 'continuity only recall profile' : '',
                ...hmeArrays
            ];
            const detailParts = continuityOnly ? [] : [...anchors, ...snippets];
            return dedupeTextArray([...baseParts, ...detailParts].map(v => String(v || '').trim()).filter(Boolean)).join('\n');
        };
        const buildRecallScoringTextFromPayload = (payload = null, maxChars = 800, meta = {}) => {
            payload = normalizePayloadForRead(payload, meta) || payload;
            if (!isCompactPayload(payload)) return '';
            const ledger = isLedgerPayload(payload);
            const limit = Math.max(400, Math.min(4000, Number(maxChars) || 800));
            const parts = [];
            const push = (value, max = 260) => {
                const raw = String(value || '').trim();
                if (!raw) return;
                parts.push(clip(raw, max));
            };
            const pushArray = (items, maxItems = 8, maxCharsPer = 160) => {
                (Array.isArray(items) ? items : [])
                    .map(item => typeof item === 'string' ? item : (item?.summary || item?.hint || item?.text || item?.delta || item?.trigger || item?.label || item?.role || item?.type || item?.oneLine || item?.continuity || item?.recall || ''))
                    .filter(Boolean)
                    .slice(0, maxItems)
                    .forEach(item => push(item, maxCharsPer));
            };
            push(payload.summary, 520);
            if (ledger && payload.summaryV2 && typeof payload.summaryV2 === 'object') {
                push(payload.summaryV2.oneLine, 420);
                push(payload.summaryV2.continuity, 560);
                push(payload.summaryV2.recall, 420);
            }
            pushArray(payload.recallKeywords, 12, 90);
            pushArray(payload.tags, 12, 90);
            pushArray(payload.mentionedEntityNames, 12, 90);
            pushArray(payload.recallAnchors, 8, 160);
            pushArray(payload.directEvidenceSnippets, MAX_SNIPPETS, 220);
            push(searchableIdentifier(payload.arcKey), 120);
            push(searchableIdentifier(payload.arcRole), 120);
            push(searchableIdentifier(payload.causalRole), 120);
            push(payload.primaryConflict, 240);
            push(payload.relationDelta, 240);
            if (typeof RPContinuityCore !== 'undefined') push(RPContinuityCore.flattenForSearch(payload.rpLongTerm), 1400);
            push(payload?.rpLongTermRef?.summary || '', 420);
            if (ledger) {
                const facts = Array.isArray(payload.facts) ? payload.facts : [];
                facts.slice(0, 5).forEach(item => {
                    push(item?.text, 260);
                    pushArray(item?.subjects, 4, 90);
                });
                pushArray(payload?.participants?.canonicalEntities, 12, 90);
                pushArray(payload?.participants?.groups, 5, 120);
                const openThreads = Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads : [];
                openThreads.slice(0, 4).forEach(item => {
                    push(item?.label, 160);
                    push(item?.text, 260);
                    push(item?.status, 90);
                    pushArray(item?.subjectRefs, 4, 90);
                    pushArray(item?.resolutionCriteria, 5, 90);
                });
                pushArray(payload?.continuity?.relationSignals, 4, 200);
                pushArray(payload?.continuity?.worldChanges, 4, 200);
                if (payload.scene && typeof payload.scene === 'object') {
                    push(payload.scene.location, 120);
                    push(payload.scene.summary, 240);
                    push(payload.scene.time, 120);
                }
                if (payload.sceneCore && typeof payload.sceneCore === 'object') {
                    push(payload.sceneCore.location, 120);
                    push(payload.sceneCore.locationStatus, 80);
                    push(payload.sceneCore.scenePhase, 80);
                    push(payload.sceneCore.activeProblem, 240);
                    push(payload.sceneCore.nextPhysicalAction, 200);
                }
                pushArray(payload.beats, 10, 240);
                pushArray(payload.evidence, MAX_SNIPPETS + 2, 220);
                pushArray(payload.userEvidence, 3, 220);
                pushArray(payload.relationDeltas, 6, 220);
                if (payload.entityStates && typeof payload.entityStates === 'object') {
                    Object.entries(payload.entityStates).slice(0, 8).forEach(([name, state]) => {
                        push(name, 90);
                        pushArray(state?.visibleState, 6, 120);
                        pushArray(state?.inferredState, 6, 120);
                    });
                }
            }
            const payloadWorld = (payload && payload.world && typeof payload.world === 'object' && !Array.isArray(payload.world)) ? payload.world : {};
            push(payload?.classification?.primary || payload?.classification, 120);
            push(payload.worldSummary, 300);
            push(payloadWorld?.classification?.primary, 120);
            pushArray(payloadWorld?.ruleHighlights, 6, 130);
            const hme = (!ledger && payload && typeof payload.hybridRow === 'object') ? payload.hybridRow : ((!ledger && payload && typeof payload.hme === 'object') ? payload.hme : {});
            if (hme && typeof hme === 'object') {
                [hme.subjects, hme.aliases, hme.tags, hme.sceneTags, hme.emotionTags, hme.relationTags, hme.worldTags, hme.narrativeTags, hme.kinds, hme.kind]
                    .flatMap(item => Array.isArray(item) ? item : (item ? [item] : []))
                    .slice(0, 36)
                    .forEach(item => push(item, 90));
            }
            const retrospectiveClass = normalizeRetrospectiveClass(payload?.retrospectiveClass || hme?.retrospectiveClass || '');
            if (retrospectiveClass) push(retrospectiveClass.replace(/_/g, ' '), 120);
            const joined = dedupeTextArray(parts.map(v => String(v || '').trim()).filter(Boolean)).join('\n');
            return clip(joined, limit);
        };
        const buildRecallScoringTextFromContent = (content = '', maxChars = 800) => {
            const parsed = parsePayloadFromContent(content);
            if (parsed) return buildRecallScoringTextFromPayload(parsed, maxChars, parseLibraMetaObject(content, {}));
            const tagged = splitTagged(content);
            const assistantOnly = stripUserTurnSummaryText(tagged.ai || (!tagged.user && !tagged.ai ? Utils.getMemorySourceText(stripMeta(content)) : ''));
            return clip(assistantOnly, Math.max(400, Math.min(4000, Number(maxChars) || 800)));
        };
        const buildRecallScoringTextFromEntry = (entry = null, maxChars = 800) => buildRecallScoringTextFromContent(entry?.content || entry || '', maxChars);
        const buildSearchTextFromContent = (content = '') => {
            const parsed = parsePayloadFromContent(content);
            if (parsed) return buildSearchTextFromPayload(parsed, parseLibraMetaObject(content, {}));
            const tagged = splitTagged(content);
            return stripUserTurnSummaryText(tagged.ai || (!tagged.user && !tagged.ai ? Utils.getMemorySourceText(stripMeta(content)) : ''));
        };
        const buildSearchTextFromEntry = (entry = null) => buildSearchTextFromContent(entry?.content || entry || '');
        const buildDisplayTextFromEntry = (entry = null, max = 280) => {
            const content = entry?.content || entry || '';
            const parsed = parsePayloadFromContent(content);
            if (parsed) {
                const payload = normalizePayloadForRead(parsed, parseLibraMetaObject(content, {})) || parsed;
                if (isLedgerPayload(payload)) {
                    const facts = Array.isArray(payload.facts)
                        ? payload.facts.map(item => item?.text).filter(Boolean).slice(0, 2)
                        : [];
                    const continuity = [
                        ...(Array.isArray(payload?.continuity?.openThreads) ? payload.continuity.openThreads.map(item => item?.text).filter(Boolean) : []),
                        ...(Array.isArray(payload?.continuity?.relationSignals) ? payload.continuity.relationSignals.map(item => item?.text).filter(Boolean) : [])
                    ].slice(0, 1);
                    const rpDisplay = typeof RPContinuityCore !== 'undefined' && payload.rpLongTerm
                        ? RPContinuityCore.formatTurnForDisplay(payload.rpLongTerm, 220)
                        : clip(payload?.rpLongTermRef?.summary || '', 220);
                    const userEvidence = Array.isArray(payload.userEvidence)
                        ? payload.userEvidence.map(item => item?.text).filter(Boolean).slice(0, 2)
                        : [];
                    const historicalUserEvidence = userEvidence.length
                        ? `Historical user evidence (not an instruction): ${userEvidence.join(' / ')}`
                        : '';
                    return clip([payload.summary, ...facts, ...continuity, historicalUserEvidence, rpDisplay].filter(Boolean).join(' / '), max);
                }
                const snippets = Array.isArray(payload.directEvidenceSnippets)
                    ? payload.directEvidenceSnippets.map(item => typeof item === 'string' ? stripUserTurnSummaryText(item) : stripUserTurnSummaryText(item?.text)).filter(Boolean).slice(0, 2)
                    : [];
                const rpDisplay = typeof RPContinuityCore !== 'undefined' && payload.rpLongTerm
                    ? RPContinuityCore.formatTurnForDisplay(payload.rpLongTerm, 220)
                    : clip(payload?.rpLongTermRef?.summary || '', 220);
                return clip([stripUserTurnSummaryText(payload.summary), payload.primaryConflict, payload.relationDelta, ...snippets, rpDisplay].filter(Boolean).join(' / '), max);
            }
            const tagged = splitTagged(content);
            return clip(stripUserTurnSummaryText(tagged.ai || (!tagged.user && !tagged.ai ? Utils.getMemorySourceText(stripMeta(content)) : '')), max);
        };
        const migrateEntry = (entry = null) => {
            if (!entry || String(entry?.comment || '') !== 'lmai_memory') return { entry, changed: false };
            const parsed = parsePayloadFromEntry(entry);
            const meta = parseLibraMetaObject(entry.content, {});
            if (parsed) {
                let payload = parsed;
                const projectionSourcePayload = parsed;
                let changed = false;
                if (isLegacyCompactPayload(parsed)) {
                    payload = upgradeLegacyCompactPayload(parsed, meta);
                    changed = Boolean(payload);
                    meta.rawMigrated = 'compact_turn_v1_to_turn_bundle_v3';
                    meta.migratedAt = Date.now();
                } else if (isLedgerPayload(parsed)) {
                    const normalized = normalizeLedgerPayload(parsed, meta);
                    payload = normalized.payload;
                    changed = normalized.changed;
                }
                if (!payload) return { entry, changed: false };
                const stripped = stripLedgerMetaHme(meta, projectionSourcePayload || payload);
                const nextMeta = stripped.meta;
                changed = changed || stripped.changed;
                if (!changed) return { entry, changed: false };
                nextMeta.rawRetention = LEDGER_RAW_RETENTION;
                nextMeta.rawDiscarded = true;
                nextMeta.summary = payload.summary || nextMeta.summary || '';
                try { nextMeta.recallHints = StrengthenedJaccardCore.buildRecallHints(buildSearchTextFromPayload(payload), { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 }); }
                catch (_) { nextMeta.recallHints = nextMeta.recallHints || {}; }
                // meta 를 바꿨으므로 무결성 체크섬을 다시 찍는다. 재스탬프가 없으면
                // 이 기억은 다음 회상에서 isIntegrityValidMemoryEntry 로 조용히 탈락한다.
                const migratedBody = serialize(payload);
                try {
                    if (typeof IntegrityMetaManager !== 'undefined' && IntegrityMetaManager?.annotateMemoryMeta) {
                        IntegrityMetaManager.annotateMemoryMeta(nextMeta, migratedBody, {
                            domain: 'memory',
                            recordSchema: 'libra.memory.entry.v1',
                            recordId: String(nextMeta.canonicalMemoryId || nextMeta.turnKey || nextMeta.sourceHash || nextMeta.m_id || '').trim(),
                            scopeKey: String(nextMeta?.integrity?.scopeKey || nextMeta.chatId || MemoryState?._activeScopeKey || '').trim(),
                            turn: Number(nextMeta.t || nextMeta.turn || nextMeta.turnAnchor || 0) || 0,
                            source: String(nextMeta.source || '').trim()
                        });
                    }
                } catch (_) {}
                return {
                    entry: {
                        ...entry,
                        content: `[META:${JSON.stringify(nextMeta)}]\n${migratedBody}\n`
                    },
                    changed: true
                };
            }
            const payload = buildPayloadFromLegacyContent(entry.content || '', meta);
            if (!payload) return { entry, changed: false };
            meta.rawRetention = LEDGER_RAW_RETENTION;
            meta.rawDiscarded = true;
            meta.rawMigrated = 'legacy_raw_memory_to_turn_bundle_v3';
            meta.summary = payload.summary || meta.summary || '';
            const stripped = stripLedgerMetaHme(meta, payload);
            const nextMeta = stripped.meta;
            try { nextMeta.recallHints = StrengthenedJaccardCore.buildRecallHints(buildSearchTextFromPayload(payload), { maxTokens: 10, maxNumbers: 4, maxQuotes: 2 }); }
            catch (_) { nextMeta.recallHints = nextMeta.recallHints || {}; }
            const legacyMigratedBody = serialize(payload);
            try {
                if (typeof IntegrityMetaManager !== 'undefined' && IntegrityMetaManager?.annotateMemoryMeta) {
                    IntegrityMetaManager.annotateMemoryMeta(nextMeta, legacyMigratedBody, {
                        domain: 'memory',
                        recordSchema: 'libra.memory.entry.v1',
                        recordId: String(nextMeta.canonicalMemoryId || nextMeta.turnKey || nextMeta.sourceHash || nextMeta.m_id || '').trim(),
                        scopeKey: String(nextMeta?.integrity?.scopeKey || nextMeta.chatId || MemoryState?._activeScopeKey || '').trim(),
                        turn: Number(nextMeta.t || nextMeta.turn || nextMeta.turnAnchor || 0) || 0,
                        source: String(nextMeta.source || '').trim()
                    });
                }
            } catch (_) {}
            return {
                entry: {
                    ...entry,
                    content: `[META:${JSON.stringify(nextMeta)}]\n${legacyMigratedBody}\n`
                },
                changed: true
            };
        };
        const inspectEntryCompatibility = (entry = null) => {
            const comment = String(entry?.comment || '').trim();
            if (!entry || comment !== 'lmai_memory') {
                return { managed: false, supported: true, kind: 'not_memory', schema: '', version: 0, needsMigration: false };
            }
            const parsed = parsePayloadFromEntry(entry);
            if (isLedgerPayload(parsed)) {
                let migration = null;
                try { migration = migrateEntry(entry); } catch (_) {}
                return {
                    managed: true,
                    supported: true,
                    kind: isV3BundlePayload(parsed) ? 'turn_bundle_v3' : 'turn_ledger_v2',
                    schema: isV3BundlePayload(parsed) ? BUNDLE_SCHEMA : LEDGER_SCHEMA,
                    version: Number(parsed?.version || (isV3BundlePayload(parsed) ? BUNDLE_VERSION : LEDGER_VERSION)) || LEDGER_VERSION,
                    needsMigration: migration?.changed === true,
                    rawRetention: parseLibraMetaObject(entry?.content || '', {})?.rawRetention || ''
                };
            }
            if (isLegacyCompactPayload(parsed)) {
                return {
                    managed: true,
                    supported: true,
                    kind: 'compact_turn_v1',
                    schema: SCHEMA,
                    version: Number(parsed?.version || VERSION) || VERSION,
                    needsMigration: true,
                    readMode: 'dual_read_upgrade_on_write'
                };
            }
            return {
                managed: true,
                supported: true,
                kind: 'legacy_raw',
                schema: '',
                version: 0,
                needsMigration: true,
                readMode: 'legacy_text_dual_read'
            };
        };
        const migrateEntries = (entries = [], options = {}) => {
            const source = Array.isArray(entries) ? entries : [];
            const dryRun = options?.dryRun === true;
            const stats = {
                total: source.length,
                managed: 0,
                legacyRaw: 0,
                compactV1: 0,
                ledgerV2: 0,
                bundleV3: 0,
                migrated: 0,
                unchanged: 0,
                failed: 0
            };
            const output = source.map(entry => {
                const inspection = inspectEntryCompatibility(entry);
                if (!inspection.managed) { stats.unchanged += 1; return entry; }
                stats.managed += 1;
                if (inspection.kind === 'legacy_raw') stats.legacyRaw += 1;
                else if (inspection.kind === 'compact_turn_v1') stats.compactV1 += 1;
                else if (inspection.kind === 'turn_ledger_v2') stats.ledgerV2 += 1;
                else if (inspection.kind === 'turn_bundle_v3') stats.bundleV3 += 1;
                if (!inspection.needsMigration) { stats.unchanged += 1; return entry; }
                try {
                    const migrated = migrateEntry(entry);
                    if (!migrated?.changed || !migrated?.entry) { stats.failed += 1; return entry; }
                    stats.migrated += 1;
                    return dryRun ? entry : migrated.entry;
                } catch (_) {
                    stats.failed += 1;
                    return entry;
                }
            });
            return {
                schema: 'libra.memory.compatibility_report.v1',
                dryRun,
                changed: !dryRun && stats.migrated > 0,
                wouldChange: stats.migrated > 0,
                entries: output,
                stats,
                supportedSchemas: [SCHEMA, LEDGER_SCHEMA, BUNDLE_SCHEMA, RECORD_SCHEMA],
                writeSchema: BUNDLE_SCHEMA
            };
        };
        const exportPayloadV2 = (payload = null, meta = {}) => {
            if (!payload || typeof payload !== 'object') return payload;
            const normalized = normalizePayloadForRead(payload, meta) || payload;
            if (!isLedgerPayload(normalized)) return normalized;
            const v2 = { ...normalized, schema: LEDGER_SCHEMA, version: LEDGER_VERSION };
            delete v2.recordSchema;
            delete v2.records;
            // v2 readers do not understand evidence authority. Omitting this
            // field is safer than letting a legacy reader treat it as canon.
            delete v2.userEvidence;
            return sanitizeLedgerPayload(v2, meta).payload;
        };
        const exportEntriesV2 = (entries = []) => {
            let exported = 0;
            let droppedUserEvidence = 0;
            const output = (Array.isArray(entries) ? entries : []).map(entry => {
                if (!entry || String(entry.comment || '') !== 'lmai_memory') return entry;
                const parsed = parsePayloadFromEntry(entry);
                if (!isLedgerPayload(parsed)) return entry;
                droppedUserEvidence += Array.isArray(parsed.userEvidence) ? parsed.userEvidence.length : 0;
                const meta = parseLibraMetaObject(entry.content, {});
                const v2 = exportPayloadV2(parsed, meta);
                exported += 1;
                return { ...entry, content: `[META:${JSON.stringify(meta)}]\n${serialize(v2)}\n` };
            });
            return {
                schema: 'libra.memory.v2_export_report.v1',
                entries: output,
                stats: { total: Array.isArray(entries) ? entries.length : 0, exported, droppedUserEvidence }
            };
        };
        return Object.freeze({
            SCHEMA,
            LEDGER_SCHEMA,
            BUNDLE_SCHEMA,
            RECORD_SCHEMA,
            WRITE_SCHEMA: BUNDLE_SCHEMA,
            LEGACY_SCHEMA: SCHEMA,
            LEDGER_VERSION,
            isCompactPayload,
            isLedgerPayload,
            isV3BundlePayload,
            parsePayloadFromContent,
            parsePayloadFromEntry,
            normalizeRetrospectiveClass,
            detectRetrospectiveClass,
            getRetrospectiveTags,
            isContinuityOnlyRecallProfile,
            buildTurnPayload,
            buildCanonicalRecordsV3,
            buildPayloadFromLegacyContent,
            normalizePayloadForWrite,
            normalizePayloadForRead,
            serialize,
            buildSearchTextFromPayload,
            buildSearchTextFromContent,
            buildSearchTextFromEntry,
            buildRecallScoringTextFromPayload,
            buildRecallScoringTextFromContent,
            buildRecallScoringTextFromEntry,
            buildDisplayTextFromEntry,
            migrateEntry,
            inspectEntryCompatibility,
            migrateEntries,
            exportPayloadV2,
            exportEntriesV2
        });
    })();


    // ══════════════════════════════════════════════════════════════
    // [RP-LTM] Roleplay Long-Term Continuity Core
    // Durable canon, preferences, commitments, unresolved threads, and relationship milestones.
    // ══════════════════════════════════════════════════════════════
