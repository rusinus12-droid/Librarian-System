        const batchItemsByCharLimit = (items, serializeItem, maxChars = SYNTHESIS_MAX_INPUT_CHARS) => {
            const source = Array.isArray(items) ? items : [];
            const batches = [];
            let current = [];

            for (const item of source) {
                const candidate = [...current, item];
                const serialized = JSON.stringify(candidate.map(serializeItem));
                if (current.length > 0 && serialized.length > maxChars) {
                    batches.push(current);
                    current = [item];
                    continue;
                }
                current = candidate;
            }

            if (current.length > 0) batches.push(current);
            return batches;
        };

        const check = async () => {
            if (isProcessing) return;
            
            const char = await RisuCompat.getCharacter();
            if (!char) return;

            const chat = await getActiveChatForCharacter(char);
            if (!chat || getChatMessages(chat).length < 5) return;

            const lore = MemoryEngine.getEffectiveLorebook(char, chat);
            const comments = new Set((Array.isArray(lore) ? lore : []).map(entry => String(entry?.comment || '').trim()));
            const hasAnyCoreData = ['lmai_narrative', 'lmai_entity', 'lmai_relation', 'lmai_memory', 'lmai_world_graph']
                .some(comment => comments.has(comment));
            // A single surviving axis is not a complete cold-start baseline.  In
            // particular, narrative-only data previously suppressed repair even
            // when memory or the canonical world graph had been lost.
            const baselineComplete = comments.has('lmai_memory')
                && comments.has('lmai_narrative')
                && comments.has('lmai_world_graph');

            if (!baselineComplete) {
                await startAutoSummarization({
                    trigger: hasAnyCoreData ? 'partial_repair' : 'first_run',
                    reason: hasAnyCoreData
                        ? '일부 LIBRA 정본 축만 남아 있어 메모리·내러티브·월드 그래프의 안전한 보강이 필요합니다.'
                        : '이 채팅방에서 LIBRA가 처음 실행되어 초기 구조 데이터가 필요합니다.'
                });
            }
        };

        const coalesceKnowledgeField = (...values) => {
            let best = '';
            for (const value of values) {
                const text = String(value || '').trim();
                if (!text) continue;
                if (!best || text.length > best.length) best = text;
            }
            return best;
        };
        const extractImportedEntityFields = (entity) => {
            const appearance = typeof entity?.appearance === 'string'
                ? entity.appearance.trim()
                : [
                    ...(Array.isArray(entity?.appearance?.features) ? entity.appearance.features : []),
                    ...(Array.isArray(entity?.appearance?.distinctiveMarks) ? entity.appearance.distinctiveMarks : []),
                    ...(Array.isArray(entity?.appearance?.clothing) ? entity.appearance.clothing : [])
                ].map(String).map(v => v.trim()).filter(Boolean).join('. ');
            const personality = typeof entity?.personality === 'string'
                ? entity.personality.trim()
                : [
                    ...(Array.isArray(entity?.personality?.traits) ? entity.personality.traits : []),
                    typeof entity?.personality?.sexualOrientation === 'string' && entity.personality.sexualOrientation.trim()
                        ? [`Sexual attitude: ${entity.personality.sexualOrientation.trim()}`]
                        : [],
                    ...(Array.isArray(entity?.personality?.sexualPreferences) && entity.personality.sexualPreferences.length > 0
                        ? [`Sexual preferences: ${entity.personality.sexualPreferences.map(String).map(v => v.trim()).filter(Boolean).join(', ')}`]
                        : [])
                ].flat().map(String).map(v => v.trim()).filter(Boolean).join('. ');
            const background = typeof entity?.background === 'string'
                ? entity.background.trim()
                : [
                    typeof entity?.background?.origin === 'string' ? entity.background.origin : '',
                    typeof entity?.background?.occupation === 'string' && entity.background.occupation.trim()
                        ? `Occupation: ${entity.background.occupation.trim()}`
                        : '',
                    ...(Array.isArray(entity?.background?.history) ? entity.background.history : []),
                ].map(String).map(v => v.trim()).filter(Boolean).join('. ');
            const explicitOccupation = String(entity?.occupation || entity?.background?.occupation || '').trim();
            const parsedSex = extractBiologicalSexFromEntityPayload(entity);
            const explicitSexualOrientation = String(entity?.sexualOrientation || entity?.sexualAttitude || entity?.personality?.sexualOrientation || entity?.personality?.sexualAttitude || '').trim();
            const explicitSexualPreferences = Array.isArray(entity?.sexualPreferences)
                ? entity.sexualPreferences.map(String).filter(Boolean)
                : (Array.isArray(entity?.personality?.sexualPreferences) ? entity.personality.sexualPreferences.map(String).filter(Boolean) : []);

            const sexualOrientationPatterns = [
                /sexual attitudes?\s*[:\-]\s*([^.;\n]+)/i,
                /sexual orientation\s*[:\-]\s*([^.;\n]+)/i,
                /성관념\s*[:\-]\s*([^.;\n]+)/i
            ];
            const sexualPreferencePatterns = [
                /sexual preferences?\s*[:\-]\s*([^.;\n]+)/i,
                /sexual preference\s*[:\-]\s*([^.;\n]+)/i,
                /성적취향\s*[:\-]\s*([^.;\n]+)/i
            ];
            const occupationPatterns = [
                /\b(?:current|present|latest)\s+occupation\s*[:\-]\s*([^.;\n]+)/i,
                /\boccupation\s*[:\-]\s*([^.;\n]+)/i,
                /\bjob\s*[:\-]\s*([^.;\n]+)/i,
                /직업\s*[:\-]\s*([^.;\n]+)/i
            ];
            const parsedSexualOrientation = explicitSexualOrientation || pickLatestExplicitField(personality, sexualOrientationPatterns);
            const parsedSexualPreferences = explicitSexualPreferences.length > 0
                ? dedupeTextArray(explicitSexualPreferences)
                : normalizeDelimitedList(pickLatestExplicitField(personality, sexualPreferencePatterns));
            const parsedOccupation = explicitOccupation || pickLatestExplicitField(background, occupationPatterns);

            const cleanedPersonality = stripLabeledFragments(personality, [
                /sexual attitudes?\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /sexual orientation\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /성관념\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /sexual preferences?\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /sexual preference\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /성적취향\s*[:\-]\s*[^.;\n]+[.;]?/gi
            ]);
            const cleanedBackground = stripLabeledFragments(background, [
                /\b(?:current|present|latest)\s+occupation\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /\boccupation\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /\bjob\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /직업\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /\b(?:currently|currently at|current|present|latest)\s+(?:location|whereabouts|place)\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /\bcurrent location\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /\blocation\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /현재\s*위치\s*[:\-]\s*[^.;\n]+[.;]?/gi,
                /위치\s*[:\-]\s*[^.;\n]+[.;]?/gi
            ]);

            return {
                name: String(entity?.name || '').trim(),
                sex: parsedSex,
                appearance,
                personality: cleanedPersonality,
                background: cleanedBackground,
                occupation: parsedOccupation,
                currentLocation: '',
                sexualOrientation: parsedSexualOrientation,
                sexualPreferences: parsedSexualPreferences
            };
        };

        const mergeColdStartArrayValues = (left, right, limit = 24) => {
            const out = [];
            const seen = new Set();
            for (const item of [...(Array.isArray(left) ? left : (left ? [left] : [])), ...(Array.isArray(right) ? right : (right ? [right] : []))]) {
                if (item == null || item === '') continue;
                const key = isColdStartPlainObject(item)
                    ? JSON.stringify({
                        id: item.id || item.eventId || '',
                        label: item.label || item.summary || item.snippet || item.text || '',
                        turn: item.turn || 0
                    }).toLowerCase()
                    : normalizeKnowledgeText(item);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(isColdStartPlainObject(item) ? safeClone(item) : item);
            }
            return out.slice(-Math.max(1, Number(limit || 24) || 24));
        };
        const hasColdStartMergeValue = (value) => {
            if (Array.isArray(value)) return value.some(hasColdStartMergeValue);
            if (isColdStartPlainObject(value)) return Object.values(value).some(hasColdStartMergeValue);
            return value !== null && value !== undefined && String(value).trim() !== '';
        };
        const mergeColdStartStructuredValue = (left, right, path = '') => {
            if (!hasColdStartMergeValue(left)) return isColdStartPlainObject(right) || Array.isArray(right) ? safeClone(right) : right;
            if (!hasColdStartMergeValue(right)) return isColdStartPlainObject(left) || Array.isArray(left) ? safeClone(left) : left;
            if (Array.isArray(left) || Array.isArray(right)) return mergeColdStartArrayValues(left, right);
            if (isColdStartPlainObject(left) || isColdStartPlainObject(right)) {
                const out = {};
                const lObj = isColdStartPlainObject(left) ? left : {};
                const rObj = isColdStartPlainObject(right) ? right : {};
                for (const key of new Set([...Object.keys(lObj), ...Object.keys(rObj)])) {
                    out[key] = mergeColdStartStructuredValue(lObj[key], rObj[key], `${path}.${key}`);
                }
                return out;
            }
            if (typeof left === 'number' || typeof right === 'number') {
                const lNum = Number(left);
                const rNum = Number(right);
                if (/confidence|salience|importance|pressure|turn|last/i.test(path)) {
                    return Math.max(Number.isFinite(lNum) ? lNum : 0, Number.isFinite(rNum) ? rNum : 0);
                }
                return Number.isFinite(lNum) ? lNum : right;
            }
            if (typeof left === 'boolean' || typeof right === 'boolean') return !!left || !!right;
            return coalesceKnowledgeField(left, right);
        };
        const buildColdStartEntityV2Fields = (entity, normalized = {}, options = {}) => {
            const sourceEntity = {
                ...(entity && typeof entity === 'object' ? entity : {}),
                sex: normalized.sex || entity?.sex || entity?.biologicalSex || '',
                appearance: entity?.appearance || normalized.appearance || '',
                personality: entity?.personality || normalized.personality || entity?.details || '',
                background: entity?.background || normalized.background || '',
                occupation: entity?.occupation || normalized.occupation || '',
                currentLocation: ''
            };
            const extension = compactColdStartEntityExtension(sourceEntity);
            const anchorTurn = Math.max(0, Number(options.anchorTurn || 0) || 0);
            const suppressSyntheticEvidence = options.suppressSyntheticEvidence === true;
            const evidence = compactColdStartEvidence(entity?.evidence || entity?.evidenceItems || extension.evidence, {
                fallbackSnippet: suppressSyntheticEvidence ? '' : (entity?.details || normalized.background || normalized.personality || normalized.appearance || entity?.summary || ''),
                sourceKind: options.sourceKind || 'cold_start_entity',
                turn: suppressSyntheticEvidence ? 0 : anchorTurn,
                confidence: extension.quality?.confidence || 0.65,
                limit: 10
            });
            const stateSummary = coalesceKnowledgeField(extension.currentState?.summary, entity?.currentState, entity?.current_state);
            const baselineEpisode = stateSummary && !suppressSyntheticEvidence
                ? [{ turn: anchorTurn, summary: stateSummary, impact: '', stability: 'baseline' }]
                : [];
            return mergeColdStartStructuredValue(extension, {
                identity: {
                    sex: normalized.sex || '',
                    occupation: normalized.occupation || extension.identity?.occupation || '',
                    source: evidence[0] || null
                },
                currentState: {
                    summary: stateSummary,
                    location: '',
                    lastObservedTurn: anchorTurn
                },
                episodeLedger: extension.episodeLedger?.length ? extension.episodeLedger : baselineEpisode,
                evidence,
                quality: {
                    confidence: Math.max(extension.quality?.confidence || 0, evidence.length ? 0.65 : 0),
                    salience: extension.quality?.salience || 0,
                    importance: extension.quality?.importance || 0,
                    pressure: extension.quality?.pressure || 0,
                    lastUpdatedTurn: suppressSyntheticEvidence ? 0 : anchorTurn,
                    sourceMix: suppressSyntheticEvidence
                        ? []
                        : compactColdStartList([options.sourceId || '', options.sourceKind || 'cold_start_entity'].filter(Boolean), 6, 64),
                    needsReview: !!extension.quality?.needsReview
                }
            }, 'entity');
        };
        const buildColdStartRelationV2Fields = (relation = {}, options = {}) => {
            const extension = compactColdStartRelationExtension(relation);
            const anchorTurn = Math.max(0, Number(options.anchorTurn || 0) || 0);
            const suppressSyntheticEvidence = options.suppressSyntheticEvidence === true;
            const statusSummary = coalesceKnowledgeField(extension.currentStatus?.summary, relation?.status, relation?.sentiment, relation?.type);
            const evidence = compactColdStartEvidence(relation?.evidence || relation?.evidenceItems || extension.evidence, {
                fallbackSnippet: suppressSyntheticEvidence ? '' : statusSummary,
                sourceKind: options.sourceKind || 'cold_start_relation',
                turn: suppressSyntheticEvidence ? 0 : anchorTurn,
                confidence: extension.quality?.confidence || 0.65,
                limit: 10
            });
            const baselineEvent = statusSummary && !suppressSyntheticEvidence
                ? [{ turn: anchorTurn, summary: statusSummary, impact: '', stability: 'baseline' }]
                : [];
            return mergeColdStartStructuredValue(extension, {
                currentStatus: {
                    summary: statusSummary,
                    lastChangedTurn: anchorTurn
                },
                eventLedger: extension.eventLedger?.length ? extension.eventLedger : baselineEvent,
                evidence,
                quality: {
                    confidence: Math.max(extension.quality?.confidence || 0, evidence.length ? 0.65 : 0),
                    salience: extension.quality?.salience || 0,
                    importance: extension.quality?.importance || 0,
                    pressure: extension.quality?.pressure || 0,
                    lastUpdatedTurn: suppressSyntheticEvidence ? 0 : anchorTurn,
                    sourceMix: suppressSyntheticEvidence
                        ? []
                        : compactColdStartList([options.sourceId || '', options.sourceKind || 'cold_start_relation'].filter(Boolean), 6, 64)
                }
            }, 'relation');
        };

        const dedupeEntitiesForMerge = (entities) => {
            const merged = new Map();
            for (const entity of (Array.isArray(entities) ? entities : [])) {
                const normalized = extractImportedEntityFields(entity);
                const name = String(normalized?.name || '').trim();
                if (!name) continue;
                const key = EntityManager.normalizeName(name);
                const extension = buildColdStartEntityV2Fields(entity, normalized, { sourceKind: 'cold_start_entity' });
                const prev = merged.get(key) || { name, sex: '', appearance: '', personality: '', background: '', occupation: '', currentLocation: '', sexualOrientation: '', sexualPreferences: [], extension: {} };
                merged.set(key, {
                    name: prev.name || name,
                    sex: prev.sex || normalized?.sex || '',
                    appearance: coalesceKnowledgeField(prev.appearance, normalized?.appearance),
                    personality: coalesceKnowledgeField(prev.personality, normalized?.personality),
                    background: coalesceKnowledgeField(prev.background, normalized?.background),
                    occupation: coalesceKnowledgeField(prev.occupation, normalized?.occupation),
                    currentLocation: '',
                    sexualOrientation: coalesceKnowledgeField(prev.sexualOrientation, normalized?.sexualOrientation),
                    sexualPreferences: dedupeTextArray([...(Array.isArray(prev.sexualPreferences) ? prev.sexualPreferences : []), ...(Array.isArray(normalized?.sexualPreferences) ? normalized.sexualPreferences : [])]),
                    extension: mergeColdStartStructuredValue(prev.extension || {}, extension, 'entity')
                });
            }
            return Array.from(merged.values());
        };

        const dedupeRelationsForMerge = (relations) => {
            const merged = new Map();
            for (const relation of (Array.isArray(relations) ? relations : [])) {
                const entityA = EntityManager.normalizeName(relation?.entityA || '');
                const entityB = EntityManager.normalizeName(relation?.entityB || '');
                if (!entityA || !entityB || entityA === entityB) continue;
                const key = [entityA, entityB].sort().join('__');
                const extension = buildColdStartRelationV2Fields(relation, { sourceKind: 'cold_start_relation' });
                const prev = merged.get(key) || { entityA, entityB, type: '', sentiment: '', extension: {} };
                merged.set(key, {
                    entityA: prev.entityA || entityA,
                    entityB: prev.entityB || entityB,
                    type: coalesceKnowledgeField(prev.type, relation?.type),
                    sentiment: coalesceKnowledgeField(prev.sentiment, relation?.sentiment),
                    extension: mergeColdStartStructuredValue(prev.extension || {}, extension, 'relation')
                });
            }
            return Array.from(merged.values());
        };

        const rebuildWorldCustomRules = (items) => {
            const rules = {};
            dedupeTextArray(items).forEach((item, index) => {
                rules[`rule_${index + 1}`] = item;
            });
            return rules;
        };
        const normalizeImportedWorldStatements = (world) => {
            const statements = [];
            const pushStatement = (value) => {
                for (const line of normalizeWorldCanonTextList(value, 40)) statements.push(line);
            };
            // Only explicit schema free-form rule fields are normalized here. Tech,
            // setting, systems, and physics fields stay in their structured buckets.
            for (const rule of (Array.isArray(world?.rules) ? world.rules : [])) pushStatement(rule);
            const customRules = normalizeWorldCustomRules(world?.custom);
            for (const value of Object.values(customRules)) pushStatement(value);
            return dedupeTextArray(statements);
        };
        const mergeImportedWorldRules = (existingRules, world = {}, fallbackNarrative = '') => {
            const base = safeClone(existingRules || {});
            base.exists = (base.exists && typeof base.exists === 'object') ? base.exists : {};
            base.systems = (base.systems && typeof base.systems === 'object') ? base.systems : {};
            base.physics = (base.physics && typeof base.physics === 'object') ? base.physics : {};
            base.setting = normalizeWorldSettingRules(base.setting);
            const incoming = buildImportedWorldRuleUpdate(world, fallbackNarrative);

            base.exists = {
                ...base.exists,
                ...incoming.exists,
                mythical_creatures: dedupeTextArray([...(Array.isArray(base.exists?.mythical_creatures) ? base.exists.mythical_creatures : []), ...(Array.isArray(incoming.exists?.mythical_creatures) ? incoming.exists.mythical_creatures : [])]),
                non_human_races: dedupeTextArray([...(Array.isArray(base.exists?.non_human_races) ? base.exists.non_human_races : []), ...(Array.isArray(incoming.exists?.non_human_races) ? incoming.exists.non_human_races : [])])
            };
            base.systems = { ...base.systems, ...incoming.systems };
            base.setting = normalizeWorldSettingRules({
                places: [...base.setting.places, ...normalizeWorldSettingRules(incoming.setting).places],
                organizations: [...base.setting.organizations, ...normalizeWorldSettingRules(incoming.setting).organizations],
                socialRules: [...base.setting.socialRules, ...normalizeWorldSettingRules(incoming.setting).socialRules]
            });
            base.physics = { ...base.physics, ...incoming.physics };

            const legacyCustomValues = Object.values(normalizeWorldCustomRules(base.custom || {}));
            const legacyPhysicsValues = Array.isArray(base.physics?.special_phenomena) ? base.physics.special_phenomena : [];
            const incomingCustomValues = Object.values(normalizeWorldCustomRules(incoming.custom || {}));
            const incomingPhysicsValues = Array.isArray(incoming.physics?.special_phenomena) ? incoming.physics.special_phenomena : [];

            // Preserve only the structured bucket chosen by the LLM/schema. Do not
            // re-bucket custom rules into phenomena through local keywords.
            base.physics.special_phenomena = dedupeTextArray([
                ...legacyPhysicsValues,
                ...incomingPhysicsValues
            ].filter(value => !isDiscardableWorldCanonFragment(value)));
            base.custom = rebuildWorldCustomRules([
                ...legacyCustomValues,
                ...incomingCustomValues
            ].filter(value => !isDiscardableWorldCanonFragment(value)));
            return sanitizeWorldRuleUpdateForPolicy(base, [
                fallbackNarrative,
                collectWorldRuleEvidenceText(world),
                collectWorldRuleEvidenceText(base)
            ].filter(Boolean).join('\n'));
        };
        const buildImportedWorldRuleUpdate = (world = {}, fallbackNarrative = '') => {
            const statements = normalizeImportedWorldStatements(world);
            const sourceText = [
                String(world?.__genreSourceText || '').trim(),
                statements.join('\n')
            ].filter(Boolean).join('\n');
            const normalized = {
                classification: world?.classification && typeof world.classification === 'object'
                    ? safeClone(world.classification)
                    : {},
                exists: world?.exists && typeof world.exists === 'object' && !Array.isArray(world.exists)
                    ? safeClone(world.exists)
                    : {},
                systems: world?.systems && typeof world.systems === 'object' && !Array.isArray(world.systems)
                    ? safeClone(world.systems)
                    : {},
                physics: world?.physics && typeof world.physics === 'object' && !Array.isArray(world.physics)
                    ? safeClone(world.physics)
                    : {},
                setting: normalizeWorldSettingRules(world?.setting),
                custom: normalizeWorldCustomRules(world?.custom),
                __genreSourceText: sourceText
            };
            const rawTech = String(world?.tech || '').trim();
            if (rawTech && !String(normalized.exists.technology || '').trim()) {
                // `world.tech` is an explicit LLM field from the import schema, so it
                // may be preserved. No technology default is inferred from prose.
                normalized.exists.technology = rawTech;
            }

            const classifiedStatements = classifyWorldCanonStatements(statements);
            normalized.setting = normalizeWorldSettingRules({
                places: [
                    normalized.setting.places,
                    world?.places,
                    world?.locations,
                    world?.facilities,
                    classifiedStatements.places
                ],
                organizations: [
                    normalized.setting.organizations,
                    world?.organizations,
                    world?.orgs,
                    world?.factions,
                    classifiedStatements.organizations
                ],
                socialRules: [
                    normalized.setting.socialRules,
                    world?.social_rules,
                    world?.socialRules,
                    world?.culture,
                    world?.customs,
                    classifiedStatements.socialRules
                ]
            });
            const explicitPhenomena = normalizeWorldCanonTextList([
                world?.phenomena,
                world?.special_phenomena,
                world?.specialPhenomena,
                classifiedStatements.phenomena
            ], 20);
            if (explicitPhenomena.length > 0) {
                normalized.physics.special_phenomena = dedupeTextArray([
                    ...(Array.isArray(normalized.physics.special_phenomena) ? normalized.physics.special_phenomena : []),
                    ...explicitPhenomena
                ]);
            }
            const explicitCustom = [
                ...Object.values(normalizeWorldCustomRules(world?.custom)),
                ...classifiedStatements.custom
            ];
            normalized.custom = rebuildWorldCustomRules(explicitCustom);

            return normalizeWorldRuleUpdate(normalized);
        };
        const normalizeNarrativeStorylinesForMerge = (storylines, fallbackNarrative = '') => {
            const source = Array.isArray(storylines) ? storylines : [];
            const normalized = source.map((storyline, idx) => ({
                name: String(storyline?.name || `Storyline ${idx + 1}`).trim(),
                context: String(storyline?.context || storyline?.currentContext || fallbackNarrative || '').trim(),
                keyPoints: dedupeTextArray(storyline?.keyPoints),
                ongoingTensions: dedupeTextArray(storyline?.ongoingTensions),
                entities: dedupeTextArray(storyline?.entities)
            })).filter(item => item.name || item.context || item.keyPoints.length > 0 || item.ongoingTensions.length > 0 || item.entities.length > 0);
            if (normalized.length > 0) return normalized.slice(0, 6);
            if (!String(fallbackNarrative || '').trim()) return [];
            return [{
                name: 'Imported Storyline',
                context: String(fallbackNarrative || '').trim(),
                keyPoints: [],
                ongoingTensions: [],
                entities: []
            }];
        };
        const fallbackChunkSummariesToStructured = (chunkSummaries, fallbackNarrative = "Cold Start: Initial analysis applied.") => {
            const normalizedSummaries = (Array.isArray(chunkSummaries) ? chunkSummaries : [])
                .map(normalizeColdStartChunkSummary)
                .filter(summary =>
                    summary.events.length > 0
                    || summary.characters.length > 0
                    || summary.relationships.length > 0
                    || summary.world_rules.length > 0
                );
            const merged = {
                narrative: normalizedSummaries.map(c => c.events.join('; ')).filter(Boolean).join(' ') || fallbackNarrative,
                narrativeDetails: {
                    storylines: normalizeNarrativeStorylinesForMerge(normalizedSummaries.map((chunk, idx) => ({
                        name: `Imported Storyline ${idx + 1}`,
                        context: chunk.events.join('; '),
                        keyPoints: chunk.events,
                        ongoingTensions: [],
                        entities: chunk.characters.map(ch => ch?.name).filter(Boolean)
                    })), fallbackNarrative)
                },
                entities: [],
                relations: [],
                world: { tech: "unknown", rules: [] }
            };
            const nameSet = new Set();
            for (const chunk of normalizedSummaries) {
                for (const ch of chunk.characters) {
                    if (ch.name && !nameSet.has(ch.name)) {
                        nameSet.add(ch.name);
                        merged.entities.push({
                            name: ch.name,
                            appearance: "",
                            personality: ch.details || "",
                            background: "",
                            identity: {
                                roleInStory: ch.role || '',
                                summary: ch.details || ''
                            },
                            profile: {
                                speechStyle: { notes: compactColdStartList(ch.speechStyle || [], 4, 120) },
                                psychology: { baseline: compactColdStartText(ch.psychology || '', 180) }
                            },
                            currentState: { summary: compactColdStartText(ch.currentState || '', 220) },
                            evidence: compactColdStartEvidence(ch.evidence || [], {
                                fallbackSnippet: ch.details || ch.currentState || '',
                                sourceKind: 'cold_start_fallback',
                                confidence: 0.55,
                                limit: 4
                            })
                        });
                    }
                }
                for (const rel of chunk.relationships) {
                    if (rel.pair?.length === 2) {
                        merged.relations.push({
                            entityA: rel.pair[0],
                            entityB: rel.pair[1],
                            type: rel.status || "",
                            sentiment: "",
                            currentStatus: { summary: rel.status || '' },
                            dynamics: { recentChanges: compactColdStartList(rel.dynamics || [], 4, 140) },
                            evidence: compactColdStartEvidence(rel.evidence || [], {
                                fallbackSnippet: rel.status || '',
                                sourceKind: 'cold_start_relation_fallback',
                                confidence: 0.55,
                                limit: 4
                            })
                        });
                    }
                }
                merged.world.rules.push(...chunk.world_rules);
            }
            return sanitizeStructuredKnowledge(merged);
        };
        const mergeStructuredKnowledgeSnapshots = (...snapshots) => {
            const valid = snapshots.filter(item => item && typeof item === 'object');
            if (valid.length === 0) return null;
            const mergeWorldObjectField = (field) => valid.reduce((acc, item) => {
                const value = item?.world?.[field];
                return isColdStartPlainObject(value) ? { ...acc, ...safeClone(value) } : acc;
            }, {});
            return sanitizeStructuredKnowledge({
                narrative: valid.map(item => item?.narrative).find(value => String(value || '').trim()) || '',
                narrativeDetails: {
                    storylines: normalizeNarrativeStorylinesForMerge(valid.flatMap(item => Array.isArray(item?.narrativeDetails?.storylines) ? item.narrativeDetails.storylines : []))
                },
                entities: valid.flatMap(item => Array.isArray(item?.entities) ? item.entities : []),
                relations: valid.flatMap(item => Array.isArray(item?.relations) ? item.relations : []),
                world: {
                    tech: valid.map(item => item?.world?.tech).find(value => String(value || '').trim()) || '',
                    summary: valid.map(item => item?.world?.summary).find(value => String(value || '').trim()) || '',
                    description: valid.map(item => item?.world?.description).find(value => String(value || '').trim()) || '',
                    classification: mergeWorldObjectField('classification'),
                    exists: mergeWorldObjectField('exists'),
                    systems: mergeWorldObjectField('systems'),
                    physics: mergeWorldObjectField('physics'),
                    custom: mergeWorldObjectField('custom'),
                    __genreSourceText: valid.map(item => item?.world?.__genreSourceText).find(value => String(value || '').trim()) || '',
                    rules: valid.flatMap(item => Array.isArray(item?.world?.rules) ? item.world.rules : [])
                }
            });
        };
        const isLikelyFinalStructuredPayload = (value) => isColdStartPlainObject(value) && (
            Object.prototype.hasOwnProperty.call(value, 'narrative')
            || Object.prototype.hasOwnProperty.call(value, 'narrativeDetails')
            || Object.prototype.hasOwnProperty.call(value, 'entities')
            || Object.prototype.hasOwnProperty.call(value, 'relations')
            || Object.prototype.hasOwnProperty.call(value, 'world')
        );
        const isLikelyChunkSummaryPayload = (value) => isColdStartPlainObject(value) && (
            Object.prototype.hasOwnProperty.call(value, 'events')
            || Object.prototype.hasOwnProperty.call(value, 'characters')
            || Object.prototype.hasOwnProperty.call(value, 'relationships')
            || Object.prototype.hasOwnProperty.call(value, 'world_rules')
            || Object.prototype.hasOwnProperty.call(value, 'memory_seeds')
        );
        const coerceFinalSynthesisCandidate = (payload) => {
            if (Array.isArray(payload)) {
                const snapshots = payload
                    .map(item => coerceFinalSynthesisCandidate(item))
                    .filter(item => hasMeaningfulStructuredSnapshot(item));
                return mergeStructuredKnowledgeSnapshots(...snapshots);
            }
            if (!isColdStartPlainObject(payload)) return null;
            if (isLikelyFinalStructuredPayload(payload)) {
                const sanitized = sanitizeStructuredKnowledge(payload);
                if (hasMeaningfulStructuredSnapshot(sanitized)) return sanitized;
            }
            if (isLikelyChunkSummaryPayload(payload)) {
                const synthesized = fallbackChunkSummariesToStructured([payload], "Cold Start: Synthesis fallback applied.");
                if (hasMeaningfulStructuredSnapshot(synthesized)) return synthesized;
            }
            const sanitized = sanitizeStructuredKnowledge(payload);
            return hasMeaningfulStructuredSnapshot(sanitized) ? sanitized : null;
        };
        const normalizeFinalSynthesisPayload = (payload, fallbackSummaries = [], fallbackNarrative = "Cold Start: Synthesis fallback applied.") => {
            return coerceFinalSynthesisCandidate(payload)
                || fallbackChunkSummariesToStructured(fallbackSummaries, fallbackNarrative);
        };
