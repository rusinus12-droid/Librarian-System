        const hasColdStartCanonicalPacketShape = (value) => {
            if (!isColdStartPlainObject(value)) return false;
            const contract = CanonicalPacketContract.inspect(value, { allowLegacy: true, requireCoreAxes: true });
            if (contract.strictV3) return contract.valid;
            const axisKeys = ['meta', 'memory', 'entity', 'world', 'narrative', 'guards', 'importance'];
            const axisCount = axisKeys.reduce((count, key) => count + (Object.prototype.hasOwnProperty.call(value, key) ? 1 : 0), 0);
            return axisCount >= 3 && !Array.isArray(value.entities);
        };
        const extractColdStartCanonicalPacket = (payload) => {
            if (Array.isArray(payload)) {
                for (const item of payload) {
                    const packet = extractColdStartCanonicalPacket(item);
                    if (packet) return packet;
                }
                return null;
            }
            if (!isColdStartPlainObject(payload)) return null;
            const candidates = [
                payload.canonicalPacket,
                payload.canonical_packet,
                payload.packet,
                payload.packet_patch,
                payload.canonical,
                payload.delta,
                payload
            ];
            return candidates.find(hasColdStartCanonicalPacketShape) || null;
        };
        const normalizeColdStartImportance = (value, fallback = 0.5) => {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return normalizeColdStart01(fallback, 0.5);
            return normalizeColdStart01(numeric > 1 ? numeric / 10 : numeric, fallback);
        };
        const collectColdStartPacketItems = (...values) => {
            const items = [];
            for (const value of values) {
                if (value == null) continue;
                if (Array.isArray(value)) items.push(...value);
                else if (isColdStartPlainObject(value)) items.push(...coerceColdStartObjectArray(value));
                else {
                    const text = compactColdStartText(value, 260);
                    if (text) items.push({ summary: text });
                }
            }
            return items.filter(Boolean);
        };
        const buildPacketEvidence = (value, fallbackSnippet = '', sourceKind = 'cold_start_packet', confidence = 0.68) => {
            const direct = isColdStartPlainObject(value)
                ? (value.evidence || value.evidence_snippet || value.source || value.reason || value.snippet)
                : value;
            return compactColdStartEvidence(direct, {
                fallbackSnippet,
                sourceKind,
                confidence,
                limit: 5
            });
        };
        const classifyColdStartEntityDetailFragments = (...values) => {
            const out = { appearance: [], personality: [], background: [], speech: [], psychology: [] };
            const fragments = compactColdStartList(values, 24, 220)
                .flatMap(item => normalizeDelimitedList(item).length > 1 ? normalizeDelimitedList(item) : [item])
                .map(item => String(item || '').trim())
                .filter(Boolean);
            const appearanceRe = /(hair|eye|skin|face|body|height|clothing|outfit|wearing|glasses|breast|chest|머리|눈동자|눈빛|안경|피부|체형|키|복장|옷|착용|블라우스|스커트|스타킹|가디건|가터|유방|가슴|쇄골|어깨|허리|맨발|금속 장식)/i;
            const speechRe = /(voice|tone|speech|말투|어조|목소리|말|존댓말|반말|허락을 구|정중한|낮고|부드러운 목소리)/i;
            const backgroundRe = /(teacher|student|librarian|academy|school|club|council|occupation|affiliation|origin|backstory|history|교사|학생|사서|아카데미|교육원|도서관|직업|소속|출신|과거|배경|역할|담당|고전문학|심리학)/i;
            const psychologyRe = /(psych|conflict|trauma|fear|desire|긴장|기대|갈등|두려움|욕망|수용적|불안|망설임|진심|존중|인내|상대방의 속도)/i;
            const personalityRe = /(personality|trait|attitude|value|kind|strict|gentle|careful|bold|성격|태도|가치관|친절|단호|신중|조심|우아|자애|적극|차분|헌신|장난|사려|인내심)/i;
            for (const fragment of fragments) {
                if (appearanceRe.test(fragment)) out.appearance.push(fragment);
                else if (speechRe.test(fragment)) out.speech.push(fragment);
                else if (backgroundRe.test(fragment)) out.background.push(fragment);
                else if (psychologyRe.test(fragment)) out.psychology.push(fragment);
                else if (personalityRe.test(fragment)) out.personality.push(fragment);
                else out.personality.push(fragment);
            }
            Object.keys(out).forEach(key => { out[key] = dedupeTextArray(out[key]).slice(0, 10); });
            return out;
        };
        const canonicalPacketToStructuredSnapshot = (packet, fallbackSnapshot = {}) => {
            if (!hasColdStartCanonicalPacketShape(packet)) return null;
            const meta = compactColdStartObject(packet.meta);
            const memory = compactColdStartObject(packet.memory);
            const entityAxis = compactColdStartObject(packet.entity);
            const world = compactColdStartObject(packet.world);
            const narrative = compactColdStartObject(packet.narrative);
            const guards = compactColdStartObject(packet.guards);

            const memoryEvents = collectColdStartPacketItems(memory.events, memory.timeline, memory.memories);
            const memoryThreads = collectColdStartPacketItems(memory.open_threads, memory.unresolved, narrative.unresolved_threads);
            const memoryEventTexts = memoryEvents.map(item => compactColdStartText(item.summary || item.text || item.event || item, 260)).filter(Boolean);
            const narrativeSummary = compactColdStartText(
                narrative.summary
                || narrative.scene_summary
                || narrative.current_arc
                || meta.summary_memory?.summary
                || memoryEventTexts.join('; '),
                1400
            );

            const packetStorylines = collectColdStartPacketItems(narrative.storylines, narrative.arcs);
            const storylines = packetStorylines.map((storyline, idx) => {
                const context = compactColdStartText(
                    storyline.context
                    || storyline.currentContext
                    || storyline.summary
                    || storyline.current_arc
                    || storyline.status
                    || narrativeSummary,
                    420
                );
                return {
                    name: compactColdStartText(storyline.name || storyline.title || `Canonical Storyline ${idx + 1}`, 80),
                    context,
                    keyPoints: compactColdStartList([
                        storyline.keyPoints,
                        storyline.key_points,
                        storyline.events,
                        storyline.scene_deltas,
                        narrative.scene_deltas
                    ], 10, 180),
                    ongoingTensions: compactColdStartList([
                        storyline.ongoingTensions,
                        storyline.ongoing_tensions,
                        storyline.tensions,
                        storyline.unresolved_threads,
                        narrative.unresolved_threads,
                        narrative.conflict_traces
                    ], 10, 180),
                    entities: compactColdStartList(storyline.entities || storyline.characters, 12, 80)
                };
            });
            if (storylines.length === 0 && narrativeSummary) {
                storylines.push({
                    name: 'Canonical Timeline',
                    context: narrativeSummary,
                    keyPoints: compactColdStartList(memoryEventTexts, 10, 180),
                    ongoingTensions: compactColdStartList([memoryThreads, guards.uncertain, guards.conflicts], 10, 180),
                    entities: []
                });
            }

            const entityCandidates = collectColdStartPacketItems(
                entityAxis.characters,
                entityAxis.entities,
                entityAxis.people,
                entityAxis.character_states,
                entityAxis.current_state
            );
            const entities = entityCandidates.map((character) => {
                const name = compactColdStartText(character.name || character.character || character.entity || character.id || '', 120);
                if (!name) return null;
                const currentSummary = compactColdStartText(character.current_state || character.currentState || character.status || character.scene_state || '', 320);
                const classifiedDetails = classifyColdStartEntityDetailFragments(
                    character.details,
                    character.summary,
                    character.profile,
                    character.description
                );
                const appearanceText = compactColdStartText([
                    character.appearance,
                    character.looks,
                    character.visual,
                    classifiedDetails.appearance
                ], 360);
                const personalityText = compactColdStartText([
                    character.personality,
                    character.traits,
                    character.temperament,
                    classifiedDetails.personality
                ], 360);
                const backgroundText = compactColdStartText([
                    character.background,
                    character.history,
                    character.backstory,
                    classifiedDetails.background
                ], 420);
                const speechNotes = compactColdStartList([
                    character.speech_style,
                    character.speechStyle,
                    character.speech,
                    classifiedDetails.speech
                ], 8, 140);
                const characterPsychology = isColdStartPlainObject(character.psychology) ? character.psychology : {};
                const psychologyText = compactColdStartText([
                    characterPsychology.baseline,
                    characterPsychology.defaultState,
                    characterPsychology.default_state,
                    characterPsychology.core,
                    isColdStartPlainObject(character.psychology) ? '' : character.psychology,
                    character.psyche,
                    character.baselinePsychology,
                    character.psychologicalBaseline,
                    character.psychological_baseline,
                    classifiedDetails.psychology
                ], 240);
                const psychologyConflict = compactColdStartText([
                    characterPsychology.currentConflict,
                    characterPsychology.current_conflict,
                    characterPsychology.innerConflict,
                    characterPsychology.inner_conflict,
                    characterPsychology.internalConflict,
                    characterPsychology.internal_conflict,
                    characterPsychology.conflict,
                    character.current_conflict,
                    character.currentConflict,
                    character.inner_conflict,
                    character.innerConflict,
                    character.internal_conflict,
                    character.internalConflict,
                    character.conflict
                ], 220);
                const psychologyCopingStyle = compactColdStartText([
                    characterPsychology.copingStyle,
                    characterPsychology.coping_style,
                    characterPsychology.coping,
                    character.coping_style,
                    character.copingStyle,
                    character.coping
                ], 160);
                const psychologyNotes = compactColdStartList([
                    characterPsychology.notes,
                    characterPsychology.cues,
                    characterPsychology.signals,
                    character.psychology_notes,
                    character.psychological_notes,
                    character.mental_notes,
                    character.mentalNotes
                ], 8, 140);
                const profileSummary = compactColdStartText(character.identity || character.bio || backgroundText || '', 420);
                const importance = normalizeColdStartImportance(character.importance || character.salience || packet.importance?.entity, 0.55);
                const confidence = normalizeColdStartImportance(character.confidence || character.quality?.confidence, 0.68);
                return {
                    name,
                    sex: /^(male|female)$/i.test(String(character.sex || '').trim()) ? String(character.sex).trim().toLowerCase() : '',
                    appearance: appearanceText,
                    personality: personalityText,
                    background: backgroundText,
                    identity: {
                        age: compactColdStartText(character.age || '', 60),
                        occupation: compactColdStartText(character.occupation || character.job || '', 120),
                        affiliation: compactColdStartText(character.affiliation || character.group || '', 160),
                        roleInStory: compactColdStartText(character.role || character.roleInStory || '', 160),
                        summary: profileSummary,
                        aliases: compactColdStartList(character.aliases, 8, 80),
                        honorifics: compactColdStartList(character.honorifics, 8, 80)
                    },
                    profile: {
                        personality: {
                            values: compactColdStartList(character.values, 8, 120),
                            fears: compactColdStartList(character.fears, 8, 120),
                            likes: compactColdStartList(character.likes, 8, 120),
                            dislikes: compactColdStartList(character.dislikes, 8, 120),
                            boundaries: compactColdStartList(character.boundaries, 8, 120)
                        },
                        speechStyle: {
                            defaultTone: compactColdStartText(character.defaultTone || character.tone || '', 120),
                            honorificStyle: compactColdStartText(character.honorificStyle || '', 120),
                            pressureMarkers: compactColdStartList(character.pressureMarkers, 6, 120),
                            catchphrases: compactColdStartList(character.catchphrases, 6, 120),
                            notes: speechNotes
                        },
                        psychology: {
                            baseline: psychologyText,
                            currentConflict: psychologyConflict,
                            copingStyle: psychologyCopingStyle,
                            notes: psychologyNotes
                        }
                    },
                    currentState: {
                        summary: currentSummary,
                        sceneTime: compactColdStartText(character.time || character.sceneTime || world.time || '', 100),
                        location: '',
                        physicalState: compactColdStartList(character.physical_state || character.physicalState, 8, 120),
                        emotionalState: compactColdStartList(character.emotional_state || character.emotionalState, 8, 120),
                        cognitiveFocus: compactColdStartList(character.cognitive_focus || character.cognitiveFocus || character.focus, 8, 120),
                        immediateGoal: compactColdStartText(character.goal || character.immediateGoal || '', 180),
                        activeProblems: compactColdStartList(character.active_problems || character.activeProblems || character.problems, 8, 140)
                    },
                    continuity: {
                        openThreads: compactColdStartList([
                            character.open_threads,
                            character.openThreads,
                            character.activeThreads,
                            character.active_threads,
                            character.threads,
                            character.unresolvedThreads,
                            character.unresolved_threads,
                            character.openLoops,
                            character.open_loops,
                            character.openHooks,
                            character.open_hooks,
                            character.plotHooks,
                            character.plot_hooks,
                            character.looseEnds,
                            character.loose_ends,
                            character.pendingQuestions,
                            character.pending_questions,
                            character.unresolved
                        ], 8, 140)
                            .map(label => ({ label, status: 'active', pressure: 0 })),
                        unresolvedNeeds: compactColdStartList([character.unresolved_needs, character.unresolvedNeeds, character.needs, character.pendingNeeds, character.pending_needs], 8, 140),
                        commitments: compactColdStartList([character.commitments, character.promises, character.obligations], 8, 140),
                        nextActionHints: compactColdStartList([character.next_action_hints, character.nextActionHints, character.next_actions, character.nextActions, character.nextSteps, character.next_steps, character.plannedNextSteps, character.planned_next_steps], 8, 140)
                    },
                    povKnowledge: {
                        knownToSelf: compactColdStartList(character.known_to_self || character.knownToSelf, 8, 140),
                        unknownToSelf: compactColdStartList(character.unknown_to_self || character.unknownToSelf, 8, 140),
                        knownToOthers: compactColdStartList(character.known_to_others || character.knownToOthers, 8, 140),
                        visibleTo: compactColdStartList(character.visible_to || character.visibleTo, 8, 100),
                        privateExperiences: compactColdStartList(character.private_experiences || character.privateExperiences, 8, 140),
                        privacy: compactColdStartText(character.privacy || '', 120)
                    },
                    episodeLedger: currentSummary ? [{ turn: 0, summary: currentSummary, impact: '', stability: 'current_state' }] : [],
                    evidence: buildPacketEvidence(character, profileSummary || currentSummary, 'cold_start_entity_packet', confidence),
                    quality: {
                        confidence,
                        salience: importance,
                        importance,
                        pressure: normalizeColdStartImportance(character.pressure, 0),
                        needsReview: false
                    }
                };
            }).filter(Boolean);

            const relationCandidates = collectColdStartPacketItems(entityAxis.relations, entityAxis.relationships, packet.relations);
            const relations = relationCandidates.map((relation) => {
                const pair = Array.isArray(relation.pair) ? relation.pair : [];
                const entityA = compactColdStartText(relation.entityA || relation.a || relation.from || pair[0] || '', 120);
                const entityB = compactColdStartText(relation.entityB || relation.b || relation.to || pair[1] || '', 120);
                if (!entityA || !entityB) return null;
                const summary = compactColdStartText(relation.summary || relation.status || relation.currentStatus || relation.details || '', 360);
                const relationDynamics = isColdStartPlainObject(relation.dynamics) ? relation.dynamics : {};
                const rawDynamicsItems = isColdStartPlainObject(relation.dynamics) ? [] : relation.dynamics;
                const unresolvedIssues = compactColdStartList([
                    relation.unresolvedIssues,
                    relation.unresolved_issues,
                    relation.openIssues,
                    relation.open_issues,
                    relation.pendingIssues,
                    relation.pending_issues,
                    relation.issues,
                    relation.unresolved,
                    relation.pendingQuestions,
                    relation.pending_questions,
                    relationDynamics.unresolvedIssues,
                    relationDynamics.unresolved_issues,
                    relationDynamics.openIssues,
                    relationDynamics.open_issues,
                    relationDynamics.pendingIssues,
                    relationDynamics.pending_issues,
                    relationDynamics.issues,
                    relationDynamics.unresolved
                ], 8, 140);
                const recentChanges = compactColdStartList([
                    relation.recentChanges,
                    relation.recent_changes,
                    relation.changes,
                    relation.relationshipChanges,
                    relation.relationship_changes,
                    relation.relationshipDeltas,
                    relation.relationship_deltas,
                    relationDynamics.recentChanges,
                    relationDynamics.recent_changes,
                    relationDynamics.changes,
                    relationDynamics.relationshipChanges,
                    relationDynamics.relationship_changes,
                    relationDynamics.relationshipDeltas,
                    relationDynamics.relationship_deltas,
                    rawDynamicsItems,
                    relation.event,
                    summary
                ], 8, 140);
                const confidence = normalizeColdStartImportance(relation.confidence || relation.quality?.confidence, 0.65);
                const importance = normalizeColdStartImportance(relation.importance || relation.salience || packet.importance?.entity, 0.5);
                return {
                    entityA,
                    entityB,
                    type: compactColdStartText(relation.type || relation.relation || relation.label || summary, 120),
                    sentiment: compactColdStartText(relation.sentiment || relation.emotion || relation.affect || '', 120),
                    currentStatus: {
                        summary,
                        publicLayer: compactColdStartText(relation.publicLayer || relation.public_layer || '', 180),
                        privateLayer: compactColdStartText(relation.privateLayer || relation.private_layer || '', 180),
                        boundaryState: compactColdStartText(relation.boundaryState || relation.boundary_state || '', 180)
                    },
                    metrics: {
                        closeness: relation.closeness == null ? null : normalizeColdStartImportance(relation.closeness, 0),
                        trust: relation.trust == null ? null : normalizeColdStartImportance(relation.trust, 0),
                        tension: normalizeColdStartImportance(relation.tension, 0),
                        risk: normalizeColdStartImportance(relation.risk, 0),
                        ambiguity: relation.closeness == null && relation.trust == null ? 0.65 : normalizeColdStartImportance(relation.ambiguity, 0),
                        pressure: normalizeColdStartImportance(relation.pressure, 0)
                    },
                    dynamics: {
                        fromAtoB: compactColdStartList([relation.fromAtoB, relation.from_a_to_b, relationDynamics.fromAtoB, relationDynamics.from_a_to_b], 8, 140),
                        fromBtoA: compactColdStartList([relation.fromBtoA, relation.from_b_to_a, relationDynamics.fromBtoA, relationDynamics.from_b_to_a], 8, 140),
                        unresolvedIssues,
                        recentChanges
                    },
                    sharedContext: {
                        location: compactColdStartText(relation.location || '', 140),
                        workplace: compactColdStartText(relation.workplace || '', 140),
                        privateThreads: compactColdStartList(relation.private_threads || relation.privateThreads, 8, 140),
                        notes: compactColdStartList(relation.notes, 8, 140)
                    },
                    eventLedger: summary ? [{ turn: 0, summary, impact: '', stability: 'current_state' }] : [],
                    evidence: buildPacketEvidence(relation, summary, 'cold_start_relation_packet', confidence),
                    quality: {
                        confidence,
                        salience: importance,
                        importance,
                        pressure: normalizeColdStartImportance(relation.pressure, 0)
                    }
                };
            }).filter(Boolean);

            const worldRules = compactColdStartList([
                world.rules,
                world.laws,
                world.constraints
            ], 40, 240);
            const classifiedWorldRules = classifyWorldCanonStatements(worldRules);
            const worldSetting = normalizeWorldSettingRules({
                places: [
                    world.places,
                    world.locations,
                    world.facilities,
                    classifiedWorldRules.places
                ],
                organizations: [
                    world.organizations,
                    world.orgs,
                    world.factions,
                    classifiedWorldRules.organizations
                ],
                socialRules: [
                    world.social_rules,
                    world.socialRules,
                    world.culture,
                    world.customs,
                    classifiedWorldRules.socialRules
                ]
            });
            const worldPhenomena = normalizeWorldCanonTextList([
                world.phenomena,
                world.special_phenomena,
                world.specialPhenomena,
                classifiedWorldRules.phenomena
            ], 16);
            const customRules = {};
            classifiedWorldRules.custom.forEach((rule, index) => { customRules[`packet_rule_${index + 1}`] = rule; });
            const worldExists = {
                ...(isColdStartPlainObject(world.exists) ? safeClone(world.exists) : {}),
            };
            delete worldExists.currentTime;
            delete worldExists.currentLocation;
            delete worldExists.currentScene;
            Object.keys(worldExists).forEach(key => {
                if (worldExists[key] == null || worldExists[key] === '') delete worldExists[key];
            });
            const worldPhysics = isColdStartPlainObject(world.physics) ? safeClone(world.physics) : {};
            if (worldPhenomena.length > 0) {
                worldPhysics.special_phenomena = dedupeTextArray([...(Array.isArray(worldPhysics.special_phenomena) ? worldPhysics.special_phenomena : []), ...worldPhenomena]);
            }
            const worldState = {
                time: compactColdStartText(world.state?.time || world.time || '', 120),
                location: compactColdStartText(world.state?.location || world.location || '', 160),
                scene: compactColdStartText(world.state?.scene || world.scene || '', 260),
                activeEvents: compactColdStartList([world.state?.active_events, world.state?.activeEvents, world.active_events, world.activeEvents], 12, 220),
                offscreenThreads: compactColdStartList([world.state?.offscreen_threads, world.state?.offscreenThreads, world.offscreen_threads, world.offscreenThreads], 12, 220)
            };
            const worldSummary = compactColdStartText(world.summary || world.scene || world.description || worldRules.join('; '), 1200);

            return sanitizeStructuredKnowledge({
                narrative: narrativeSummary,
                narrativeDetails: { storylines },
                entities,
                relations,
                world: {
                    tech: compactColdStartText(world.tech || world.technology || worldExists.technology || '', 160),
                    summary: worldSummary,
                    description: compactColdStartText(world.description || worldSummary, 1200),
                    classification: isColdStartPlainObject(world.classification) ? safeClone(world.classification) : {},
                    exists: worldExists,
                    systems: isColdStartPlainObject(world.systems) ? safeClone(world.systems) : {},
                    setting: worldSetting,
                    physics: worldPhysics,
                    custom: customRules,
                    rules: normalizeWorldCanonTextList(worldRules, 40),
                    state: worldState
                }
            });
        };
        const normalizeCanonicalColdStartPayload = (payload, fallbackSummaries = [], fallbackNarrative = "Cold Start: Canonical packet fallback applied.") => {
            const packet = extractColdStartCanonicalPacket(payload);
            const structuredCandidates = isColdStartPlainObject(payload)
                ? [
                    payload.structuredSnapshot,
                    payload.structured_snapshot,
                    payload.snapshot,
                    payload.compatibilitySnapshot,
                    payload.compatibility_snapshot,
                    payload.compatibility?.structuredSnapshot,
                    payload.compatibility?.structured_snapshot
                ]
                : [];
            let structured = null;
            for (const candidate of structuredCandidates) {
                structured = coerceFinalSynthesisCandidate(candidate);
                if (hasMeaningfulStructuredSnapshot(structured)) break;
            }
            if (!structured && !packet) {
                structured = coerceFinalSynthesisCandidate(payload);
            }
            const packetSnapshot = packet ? canonicalPacketToStructuredSnapshot(packet, structured || {}) : null;
            const normalized = mergeStructuredKnowledgeSnapshots(
                ...(structured ? [structured] : []),
                ...(packetSnapshot ? [packetSnapshot] : [])
            ) || structured || packetSnapshot;
            return hasMeaningfulStructuredSnapshot(normalized)
                ? normalized
                : normalizeFinalSynthesisPayload(null, fallbackSummaries, fallbackNarrative);
        };
        const synthesizeChunkSummariesHierarchically = async (chunkSummaries, taskLabel = 'cold-start', options = {}) => {
            const analysisConfig = options.analysisConfig || captureWmAnalysisConfig(MemoryEngine.CONFIG);
            if (typeof options.isCurrent === 'function') await requireColdStartSelectionCurrent(options.isCurrent);
            const sourceSummaries = Array.isArray(chunkSummaries) ? chunkSummaries.filter(Boolean) : [];
            if (sourceSummaries.length === 0) return null;
            const isFastTask = /^cold-(?:start|reanalysis)/.test(String(taskLabel || ''));
            const fastLlm = isFastTask ? buildFastAnalysisProfile(analysisConfig, { maxCompletionTokens: 3200, routeKey: 'coldStartFinalSynthesis', fallbackProfile: 'primary' }) : null;

            const directInput = buildSynthesisInput(sourceSummaries);
            if (sourceSummaries.length <= HIERARCHICAL_SYNTHESIS_MAX_BATCHES && directInput.length <= SYNTHESIS_MAX_INPUT_CHARS) {
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const synthesisResult = await runMaintenanceLLM(() =>
                            callColdStartLLMWithPreflight({
                                isCurrent:options.isCurrent,
                                config: isFastTask ? fastLlm.config : analysisConfig,
                                system: ColdStartCanonicalPacketPrompt,
                                user: directInput,
                                maxTokens: isFastTask ? 3600 : 4200,
                                profile: isFastTask ? fastLlm.profile : 'primary',
                                label: `${taskLabel}-canonical-synthesis-${attempt + 1}`,
                                domain: 'cold_start',
                                reason: `${taskLabel}-canonical-synthesis`,
                                preflightDomain: 'coldStartFinalSynthesis',
                            })
                        , `${taskLabel}-canonical-synthesis-${attempt + 1}`);
                        if (synthesisResult.skipped) throw new Error("LLM이 구성되지 않았습니다.");
                        const parsed = extractStructuredJson(synthesisResult?.content || '');
                        const normalized = parsed ? normalizeCanonicalColdStartPayload(parsed, sourceSummaries) : null;
                        if (hasMeaningfulStructuredSnapshot(normalized)) return normalized;
                    } catch (e) {
                        if (e?.code === 'historical_selection_changed') throw e;
                        if (attempt === 0) recordRuntimeDebug('warn', "[LIBRA] Direct synthesis attempt failed, retrying:", e?.message || e);
                    }
                }
                return normalizeFinalSynthesisPayload(null, sourceSummaries);
            }

            let layerReports = [];
            let currentBatches = batchItemsByCharLimit(sourceSummaries, compactChunkSummary, SYNTHESIS_MAX_INPUT_CHARS);

            for (let i = 0; i < currentBatches.length; i++) {
                const batch = currentBatches[i];
                const synthesisInput = buildSynthesisInput(batch);
                let parsed = null;
                for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
                    try {
                        const synthesisResult = await runMaintenanceLLM(() =>
                            callColdStartLLMWithPreflight({
                                isCurrent:options.isCurrent,
                                config: isFastTask ? fastLlm.config : analysisConfig,
                                system: ColdStartCanonicalPacketPrompt,
                                user: synthesisInput,
                                maxTokens: isFastTask ? 3600 : 4200,
                                profile: isFastTask ? fastLlm.profile : 'primary',
                                label: `${taskLabel}-canonical-layer-1-batch-${i + 1}-attempt-${attempt + 1}`,
                                domain: 'cold_start',
                                reason: `${taskLabel}-canonical-layer-1`,
                                preflightDomain: 'coldStartFinalSynthesis',
                            })
                        , `${taskLabel}-canonical-layer-1-batch-${i + 1}-attempt-${attempt + 1}`);
                        const candidate = extractStructuredJson(synthesisResult?.content || '');
                        parsed = candidate ? normalizeCanonicalColdStartPayload(candidate, batch, "Cold Start: Layer canonical fallback applied.") : null;
                    } catch (e) {
                        if (e?.code === 'historical_selection_changed') throw e;
                        if (attempt === 0) recordRuntimeDebug('warn', '[LIBRA] Layer-1 synthesis retry:', e?.message || e);
                    }
                }
                layerReports.push(hasMeaningfulStructuredSnapshot(parsed) ? parsed : fallbackChunkSummariesToStructured(batch, "Cold Start: Layer synthesis fallback applied."));
            }

            for (let layer = 2; layer <= HIERARCHICAL_SYNTHESIS_MAX_LAYERS && layerReports.length > 1; layer++) {
                const nextReports = [];
                const reportBatches = batchItemsByCharLimit(layerReports, compactStructuredSnapshot, SYNTHESIS_MAX_INPUT_CHARS);
                for (let i = 0; i < reportBatches.length; i++) {
                    const batch = reportBatches[i];
                    const mergeInput = buildStructuredMergeInput(batch);
                    let parsed = null;
                    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
                        try {
                            const mergeResult = await runMaintenanceLLM(() =>
                                callColdStartLLMWithPreflight({
                                isCurrent:options.isCurrent,
                                    config: isFastTask ? fastLlm.config : analysisConfig,
                                    system: ColdStartCanonicalMergePrompt,
                                    user: mergeInput,
                                    maxTokens: isFastTask ? 3800 : 4400,
                                    profile: isFastTask ? fastLlm.profile : 'primary',
                                    label: `${taskLabel}-canonical-layer-${layer}-batch-${i + 1}-attempt-${attempt + 1}`,
                                    domain: 'cold_start',
                                    reason: `${taskLabel}-canonical-layer-${layer}`,
                                    preflightDomain: 'coldStartFinalSynthesis',
                                })
                        , `${taskLabel}-canonical-layer-${layer}-batch-${i + 1}-attempt-${attempt + 1}`);
                            const candidate = extractStructuredJson(mergeResult?.content || '');
                            parsed = candidate ? normalizeCanonicalColdStartPayload(candidate, batch, "Cold Start: Canonical merge fallback applied.") : null;
                        } catch (e) {
                        if (e?.code === 'historical_selection_changed') throw e;
                            if (attempt === 0) recordRuntimeDebug('warn', `[LIBRA] Layer-${layer} merge retry:`, e?.message || e);
                        }
                    }
                    nextReports.push(hasMeaningfulStructuredSnapshot(parsed) ? parsed : (mergeStructuredKnowledgeSnapshots(...batch) || batch[0]));
                }
                layerReports = nextReports;
            }

            if (layerReports.length > 1) {
                return mergeStructuredKnowledgeSnapshots(...layerReports) || layerReports[0];
            }
            return layerReports[0] || fallbackChunkSummariesToStructured(sourceSummaries);
        };
        const sanitizeStructuredKnowledge = (finalData) => ({
            narrative: String(finalData?.narrative || '').trim(),
            narrativeDetails: {
                storylines: normalizeNarrativeStorylinesForMerge(finalData?.narrativeDetails?.storylines, finalData?.narrative || '')
            },
            entities: dedupeEntitiesForMerge(finalData?.entities),
            relations: dedupeRelationsForMerge(finalData?.relations),
            world: {
                tech: String(finalData?.world?.tech || '').trim(),
                summary: String(finalData?.world?.summary || '').trim(),
                description: String(finalData?.world?.description || '').trim(),
                classification: finalData?.world?.classification && typeof finalData.world.classification === 'object'
                    ? safeClone(finalData.world.classification)
                    : {},
                exists: finalData?.world?.exists && typeof finalData.world.exists === 'object' && !Array.isArray(finalData.world.exists)
                    ? safeClone(finalData.world.exists)
                    : {},
                systems: finalData?.world?.systems && typeof finalData.world.systems === 'object' && !Array.isArray(finalData.world.systems)
                    ? safeClone(finalData.world.systems)
                    : {},
                setting: normalizeWorldSettingRules(finalData?.world?.setting),
                physics: finalData?.world?.physics && typeof finalData.world.physics === 'object' && !Array.isArray(finalData.world.physics)
                    ? safeClone(finalData.world.physics)
                    : {},
                custom: normalizeWorldCustomRules(finalData?.world?.custom),
                state: {
                    time: String(finalData?.world?.state?.time || '').trim(),
                    location: String(finalData?.world?.state?.location || '').trim(),
                    scene: String(finalData?.world?.state?.scene || '').trim(),
                    activeEvents: normalizeWorldCanonTextList(finalData?.world?.state?.activeEvents || finalData?.world?.state?.active_events, 12),
                    offscreenThreads: normalizeWorldCanonTextList(finalData?.world?.state?.offscreenThreads || finalData?.world?.state?.offscreen_threads, 12)
                },
                __genreSourceText: String(finalData?.world?.__genreSourceText || '').trim(),
                rules: dedupeTextArray([
                    ...(Array.isArray(finalData?.world?.rules) ? finalData.world.rules : []),
                    ...normalizeWorldSettingRules(finalData?.world?.setting).places,
                    ...normalizeWorldSettingRules(finalData?.world?.setting).organizations,
                    ...normalizeWorldSettingRules(finalData?.world?.setting).socialRules,
                    ...Object.values(normalizeWorldCustomRules(finalData?.world?.custom))
                ].filter(value => !isDiscardableWorldCanonFragment(value)))
            }
        });
