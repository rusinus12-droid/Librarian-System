        const readStructuredWorldFlag = (world = {}, keys = []) => {
            const roots = [world?.global, world?.structure, world?.flags, world?.meta];
            for (const root of roots) {
                if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
                for (const key of keys) {
                    if (root[key] === true) return true;
                    if (root[key] === false) return false;
                }
            }
            return undefined;
        };
        const applyGlobalWorldFeaturesFromImportedKnowledge = (profile, sanitized) => {
            if (!profile?.global) return;
            const world = (sanitized?.world && typeof sanitized.world === 'object' && !Array.isArray(sanitized.world)) ? sanitized.world : {};
            const systems = (world.systems && typeof world.systems === 'object' && !Array.isArray(world.systems)) ? world.systems : {};
            const applyFlag = (targetKey, sourceKeys) => {
                const value = readStructuredWorldFlag(world, sourceKeys);
                if (value === true || value === false) profile.global[targetKey] = value;
            };
            applyFlag('multiverse', ['multiverse', 'multiVerse', 'multipleWorlds', 'multiple_worlds']);
            applyFlag('dimensionTravel', ['dimensionTravel', 'dimension_travel', 'interdimensionalTravel', 'interdimensional_travel']);
            applyFlag('timeTravel', ['timeTravel', 'time_travel', 'timeLoop', 'time_loop']);
            applyFlag('metaNarrative', ['metaNarrative', 'meta_narrative', 'fourthWall', 'fourth_wall']);
            applyFlag('virtualReality', ['virtualReality', 'virtual_reality', 'simulation']);
            applyFlag('dreamWorld', ['dreamWorld', 'dream_world']);
            applyFlag('reincarnationPossession', ['reincarnationPossession', 'reincarnation_possession', 'reincarnation', 'possession', 'transmigration']);
            const explicitSystemInterface = readStructuredWorldFlag(world, ['systemInterface', 'system_interface']);
            const structuredSystemInterface = [
                systems.systemInterface,
                systems.system_interface,
                systems.leveling,
                systems.skills,
                systems.stats,
                systems.classes,
                systems.quests,
                systems.inventory
            ].some(value => value === true);
            if (explicitSystemInterface === true || explicitSystemInterface === false) {
                profile.global.systemInterface = explicitSystemInterface;
            } else if (structuredSystemInterface) {
                profile.global.systemInterface = true;
            }
        };
        const refreshSectionWorldFromImportedKnowledge = async (sanitized, opts = {}) => {
            try {
                const worldPrompt = HierarchicalWorldManager.formatForPrompt();
                const worldStatePrompt = WorldStateTracker.formatForPrompt();
                const narrativePrompt = NarrativeTracker.formatForPrompt();
                const focusCharacters = dedupeTextArray([
                    ...(Array.isArray(sanitized?.entities) ? sanitized.entities.map(entity => entity?.name) : []),
                    ...((sanitized?.narrativeDetails?.storylines || []).flatMap(storyline => Array.isArray(storyline?.entities) ? storyline.entities : []))
                ]).slice(0, 8);
                const worldSettingHints = normalizeWorldSettingRules(sanitized?.world?.setting);
                const memoryHints = compactTextArray([
                    sanitized?.world?.rules,
                    worldSettingHints.places,
                    worldSettingHints.organizations,
                    worldSettingHints.socialRules,
                    sanitized?.world?.physics?.special_phenomena
                ], 8, 140);
                const loreHints = compactTextArray((sanitized?.narrativeDetails?.storylines || []).flatMap(storyline => Array.isArray(storyline?.keyPoints) ? storyline.keyPoints : []), 8, 140);
                if (!worldPrompt && !worldStatePrompt && !narrativePrompt && memoryHints.length === 0 && loreHints.length === 0) {
                    SectionWorldInferenceManager.resetState();
                    return '';
                }
                return await SectionWorldInferenceManager.inferPrompt(MemoryEngine.CONFIG, {
                    turn: MemoryEngine.getCurrentTurn?.() || 0,
                    userMsg: String(opts?.sourceLabel || opts?.worldNote || 'Imported knowledge').trim(),
                    worldPrompt,
                    worldStatePrompt,
                    narrativePrompt,
                    focusCharacters,
                    memoryHints,
                    loreHints
                });
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Section world refresh after import failed:', e?.message || e);
                return '';
            }
        };
        const resolveStructuredKnowledgeSourceLabel = (sourceId = 'baseline') => {
            const id = String(sourceId || 'baseline').trim();
            if (id === 'baseline') return 'cold_start';
            if (id === 'reanalysis') return 'reanalysis';
            if (id === 'user_lorebook') return 'user_lorebook';
            return id || 'structured_import';
        };
        const getStructuredKnowledgeBaselineAnchorTurn = () => {
            const current = Number(MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0);
            return Math.max(1, Number.isFinite(current) ? Math.floor(current) : 1);
        };
        const hasStructuredWorldStateValue = (state = {}) => !!(
            String(state?.time || '').trim()
            || String(state?.location || '').trim()
            || String(state?.scene || '').trim()
            || (Array.isArray(state?.activeEvents) && state.activeEvents.length > 0)
            || (Array.isArray(state?.offscreenThreads) && state.offscreenThreads.length > 0)
        );
        const recordStructuredWorldState = (sanitized = {}, anchorTurn = 0) => {
            const state = sanitized?.world?.state || {};
            if (!hasStructuredWorldStateValue(state)) return false;
            const profile = HierarchicalWorldManager.getProfile?.();
            const currentNode = HierarchicalWorldManager.getCurrentNode?.();
            const currentRules = HierarchicalWorldManager.getCurrentRules?.();
            WorldStateTracker.replaceState(Math.max(1, Number(anchorTurn || 0) || 1), {
                activePath: profile?.activePath || [],
                rules: currentRules || {},
                global: profile?.global || {},
                classification: currentNode?.meta?.classification || sanitized?.world?.classification?.primary || '',
                worldSummary: sanitized?.world?.summary || state.scene || '',
                currentTime: state.time || '',
                currentLocation: state.location || '',
                currentScene: state.scene || '',
                activeEvents: state.activeEvents || [],
                offscreenThreads: state.offscreenThreads || [],
                notes: compactTextArray([state.activeEvents, state.offscreenThreads], 8, 180).join(' | ')
            });
            return true;
        };
        const getColdStartSourceMessagesMaxTurn = (messages = []) => {
            const pairs = buildColdStartReplayableTurnPairs(Array.isArray(messages) ? messages : [], null);
            return Math.max(0, ...pairs.map(pair => normalizeLegacyMemoryTurnAnchor(pair?.turn || 0)).filter(Boolean));
        };
        const buildMergedNarrativeStateFromImportedKnowledge = (sanitized, existingState = null, options = {}) => {
            const currentState = existingState && typeof existingState === 'object'
                ? safeClone(existingState)
                : { storylines: [], turnLog: [], lastSummaryTurn: 0 };
            const incomingStorylines = normalizeNarrativeStorylinesForMerge(
                sanitized?.narrativeDetails?.storylines,
                sanitized?.narrative || ''
            );
            if (incomingStorylines.length === 0 && !String(sanitized?.narrative || '').trim()) {
                return currentState;
            }

            const baselineAnchorTurn = Math.max(1, Number(options?.anchorTurn || getStructuredKnowledgeBaselineAnchorTurn()));
            const baselineSourceId = String(options?.sourceId || 'baseline');
            const baselineReason = baselineSourceId === 'baseline' ? 'cold-start-baseline' : `${baselineSourceId}-structured-baseline`;
            const suppressSyntheticAnchors = options?.suppressSyntheticEvidence === true || options?.suppressSyntheticNarrativeAnchors === true;
            const byKey = new Map();
            const makeKey = (storyline) => {
                const name = String(storyline?.name || '').trim().toLowerCase();
                if (name) return `name:${name}`;
                const entities = Array.isArray(storyline?.entities) ? storyline.entities.map(v => String(v || '').trim().toLowerCase()).filter(Boolean).sort().join('|') : '';
                return entities ? `entities:${entities}` : `fallback:${TokenizerEngine.simpleHash(JSON.stringify(storyline || {}))}`;
            };

            for (const storyline of (Array.isArray(currentState.storylines) ? currentState.storylines : [])) {
                const cloned = safeClone(storyline);
                byKey.set(makeKey(cloned), cloned);
            }

            incomingStorylines.forEach((storyline, idx) => {
                const key = makeKey(storyline);
                const prev = byKey.get(key);
                const summaryText = storyline.context || sanitized.narrative || '';
                const summaryEntry = {
                    upToTurn: baselineAnchorTurn,
                    summary: summaryText,
                    keyPoints: [...storyline.keyPoints],
                    ongoingTensions: [...storyline.ongoingTensions],
                    timestamp: Date.now(),
                    baseline: true,
                    sourceId: baselineSourceId,
                    turnAnchor: baselineAnchorTurn,
                    turnAnchorTurn: baselineAnchorTurn,
                    lockedTurn: baselineAnchorTurn,
                    finalizedTurn: baselineAnchorTurn,
                    turnAnchorReason: baselineReason
                };
                if (prev) {
                    prev.name = storyline.name || prev.name || `Imported Storyline ${idx + 1}`;
                    prev.entities = dedupeTextArray([...(Array.isArray(prev.entities) ? prev.entities : []), ...(Array.isArray(storyline.entities) ? storyline.entities : []), ...((sanitized.entities || []).map(e => e.name).filter(Boolean))]);
                    prev.currentContext = coalesceKnowledgeField(prev.currentContext, summaryText);
                    prev.keyPoints = dedupeTextArray([...(Array.isArray(prev.keyPoints) ? prev.keyPoints : []), ...storyline.keyPoints]);
                    prev.ongoingTensions = dedupeTextArray([...(Array.isArray(prev.ongoingTensions) ? prev.ongoingTensions : []), ...storyline.ongoingTensions]);
                    prev.recentEvents = Array.isArray(prev.recentEvents) ? prev.recentEvents : [];
                    if (summaryText && !suppressSyntheticAnchors) {
                        prev.recentEvents.push({ turn: baselineAnchorTurn, brief: summaryText });
                        prev.recentEvents = prev.recentEvents.slice(-10);
                    }
                    prev.summaries = Array.isArray(prev.summaries) ? prev.summaries.filter(entry => entry?.live !== true) : [];
                    if (!suppressSyntheticAnchors && (summaryText || summaryEntry.keyPoints.length > 0 || summaryEntry.ongoingTensions.length > 0)) {
                        prev.summaries.push(summaryEntry);
                        prev.summaries = prev.summaries.slice(-12);
                    }
                } else {
                    byKey.set(key, {
                        id: idx + 1,
                        name: storyline.name || `Imported Storyline ${idx + 1}`,
                        entities: storyline.entities.length > 0 ? storyline.entities : (sanitized.entities || []).map(e => e.name).filter(Boolean),
                        turns: suppressSyntheticAnchors ? [] : [baselineAnchorTurn],
                        firstTurn: suppressSyntheticAnchors ? 0 : baselineAnchorTurn,
                        lastTurn: suppressSyntheticAnchors ? 0 : baselineAnchorTurn,
                        recentEvents: summaryText && !suppressSyntheticAnchors ? [{ turn: baselineAnchorTurn, brief: summaryText }] : [],
                        summaries: !suppressSyntheticAnchors && (summaryText || summaryEntry.keyPoints.length > 0 || summaryEntry.ongoingTensions.length > 0) ? [summaryEntry] : [],
                        currentContext: summaryText,
                        keyPoints: [...storyline.keyPoints],
                        ongoingTensions: [...storyline.ongoingTensions],
                        meta: { manualLocked: false, manualLockedAt: 0, baseline: true, sourceId: baselineSourceId, turnAnchor: baselineAnchorTurn, turnAnchorTurn: baselineAnchorTurn, lockedTurn: baselineAnchorTurn, finalizedTurn: baselineAnchorTurn, turnAnchorReason: baselineReason }
                    });
                }
            });

            return {
                ...currentState,
                storylines: Array.from(byKey.values()),
                turnLog: Array.isArray(currentState.turnLog) ? currentState.turnLog : [],
                lastSummaryTurn: suppressSyntheticAnchors
                    ? Number(currentState.lastSummaryTurn || 0)
                    : Math.max(Number(currentState.lastSummaryTurn || 0), baselineAnchorTurn)
            };
        };

        const loadStructuredMergeRuntimeFromLore = (targetLore, targetChar, targetChat) => {
            const safeLore = Array.isArray(targetLore) ? targetLore : [];
            const scopeKey = getChatRuntimeScopeKey(targetChat, targetChar);
            const chatId = String(targetChat?.id || '').trim();
            MemoryEngine.rebuildIndex(safeLore);
            SecretKnowledgeCore.loadState(safeLore, { scopeKey, chatId });
            EntityKnowledgeVaultCore.loadState(safeLore, { scopeKey, chatId });
            TimeEngine.loadState(safeLore, { scopeKey, chatId });
            EntityManager.rebuildCache(safeLore);
            HierarchicalWorldManager.loadWorldGraph(safeLore, true);
            NarrativeTracker.loadState(safeLore);
            StoryAuthor.loadState(safeLore);
            Director.loadState(safeLore);
            WorldAdditionalCore.loadState?.(safeLore, { scopeKey, chatId });
            CharacterStateTracker.loadState(safeLore);
            WorldStateTracker.loadState(safeLore);
            SectionWorldInferenceManager.resetState?.();
            MemoryEngine.setTurn(deriveMaxTurnFromLorebook(safeLore));
            return { scopeKey, chatId };
        };

        const applyStructuredNarrativeOrchestration = (sanitized, anchorTurn, options = {}) => {
            const config = MemoryEngine.CONFIG || {};
            const storylines = Array.isArray(sanitized?.narrativeDetails?.storylines)
                ? sanitized.narrativeDetails.storylines
                : [];
            const primary = storylines[0] || {};
            const existingAuthor = StoryAuthor.getState?.() || {};
            const focusedEntities = dedupeTextArray([
                ...(Array.isArray(primary.entities) ? primary.entities : []),
                ...(Array.isArray(sanitized?.entities) ? sanitized.entities.map(entity => entity?.name) : [])
            ]).slice(0, 8);
            const tensions = dedupeTextArray(primary.ongoingTensions || []).slice(0, 8);
            const keyPoints = dedupeTextArray(primary.keyPoints || []).slice(0, 8);
            const relationSignals = (Array.isArray(sanitized?.relations) ? sanitized.relations : [])
                .map(relation => [relation?.entityA, relation?.entityB, relation?.type || relation?.sentiment].filter(Boolean).join(' ↔ '))
                .filter(Boolean)
                .slice(0, 8);
            const worldHints = dedupeTextArray([
                sanitized?.world?.summary,
                sanitized?.world?.description,
                sanitized?.world?.rules
            ]).slice(0, 8);
            const payload = {
                turn: anchorTurn,
                userMsg: '',
                strictUserMsg: '',
                aiResponse: String(sanitized?.narrative || primary?.context || '').trim(),
                isEmptyInput: false,
                hasUserRequestMetadata: false,
                focusedEntities,
                recentTurns: [sanitized?.narrative, primary?.context].filter(Boolean),
                storylineCarryoverSignals: [...keyPoints, ...tensions].slice(0, 8),
                relationStateSignals: relationSignals,
                worldManagerHints: worldHints,
                environmentPressures: tensions,
                narrativePrompt: NarrativeTracker.formatForPrompt?.() || '',
                worldStatePrompt: WorldStateTracker.formatForPrompt?.() || '',
                worldPrompt: HierarchicalWorldManager.formatForPrompt?.() || '',
                plannerRefreshModes: { storyAuthor: 'full', director: 'full' },
                sourceRevision: anchorTurn
            };
            payload.sceneContract = NarrativeOrchestrationCore.buildSceneContract({ ...payload, turn: anchorTurn });
            payload.narrativeDiagnostics = NarrativeOrchestrationCore.buildNarrativeDiagnostics(payload, payload.sceneContract);
            payload.plannerProvenance = NarrativeOrchestrationCore.buildPlannerProvenance(payload, 'full');
            const authorPlan = {
                currentArc: String(primary?.name || existingAuthor.currentArc || 'Ongoing Story').trim(),
                narrativeGoal: String(primary?.context || sanitized?.narrative || existingAuthor.narrativeGoal || '').trim(),
                scenePhase: existingAuthor.scenePhase || payload.narrativeDiagnostics?.scenePhase || 'development',
                activeTensions: tensions.length ? tensions : (existingAuthor.activeTensions || []),
                primaryTension: tensions[0] || existingAuthor.primaryTension || '',
                openQuestions: existingAuthor.openQuestions || [],
                payoffCandidates: existingAuthor.payoffCandidates || [],
                recommendedBeatType: existingAuthor.recommendedBeatType || payload.narrativeDiagnostics?.recommendedBeatType || 'dialogue',
                nextBeats: keyPoints.length
                    ? keyPoints.slice(-4)
                    : ((existingAuthor.nextBeats || []).length
                        ? existingAuthor.nextBeats
                        : tensions.slice(0, 3).map(item => `Advance the active scene without prematurely resolving: ${item}`)),
                beatReason: 'Historical conversation analysis established the active arc, continuity, and unresolved pressure.',
                guardrails: existingAuthor.guardrails || [],
                doNotResolveYet: tensions,
                entityContextHints: focusedEntities,
                relationStateSignals: relationSignals,
                worldManagerHints: worldHints,
                environmentPressures: tensions,
                storylineCarryoverSignals: [...keyPoints, ...tensions].slice(0, 8),
                focusCharacters: focusedEntities,
                userIntentAlignment: 'The latest live user input remains primary; this historical plan supplies continuity only.',
                sceneContract: payload.sceneContract,
                narrativeDiagnostics: payload.narrativeDiagnostics
            };
            StoryAuthor.applyPlanState?.(anchorTurn, authorPlan, payload, config);
            Director.applyDirectiveState?.(anchorTurn, null, {
                ...payload,
                storyAuthorState: StoryAuthor.getState?.() || {},
                storyAuthorPrompt: StoryAuthor.formatForPrompt?.() || ''
            }, config);
            if (options?.worldAdditionalMaintenance?.payload) {
                WorldAdditionalCore.ingestMaintenance?.(
                    options.worldAdditionalMaintenance.payload,
                    '',
                    {
                        turn: anchorTurn,
                        source: String(options.worldAdditionalMaintenance.source || `${options.sourceId || 'cold_start'}_world_additional`),
                        focusedEntities,
                        injectedIds: []
                    },
                    config
                );
            }
        };

