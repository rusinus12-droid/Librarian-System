    const TurnMaintenanceOptimizer = (() => {
        // ── 계약별 출력 예산은 02h 가 단일 정의한다 ──
        // 02h 가 먼저 실행되므로(build-manifest) 정의는 02h 에 있고 여기서는 읽기만 한다.
        // 표를 두 곳에 두면 한쪽만 올렸을 때 min() 이 요청을 조용히 자른다(실측으로 겪은 결함).
        // 폴백 사본을 두지 않는다 — 사본이 있으면 02h 로드가 실패했을 때 **낡은 값으로 조용히 돌아간다**.
        // 파편화를 없애는 것이 목적이므로 단일 출처만 읽는다(02h 가 먼저 실행되므로 항상 존재한다.
        // 없으면 예산을 임의로 정하지 않고 즉시 실패하는 편이 낫다 — 게이트 product_exports_available 이 잡는다).
        const CONTRACT_OUTPUT_BUDGETS = AnalysisBudgetPreflight?.contractBudgets || Object.freeze({});
        const resolveTurnAnalysisOutputBudget = (payload = {}, worker = 'canonical_packet', options = {}) => {
            const evidenceChars = String(payload?.evidenceText || payload?.canonicalEvidenceText || payload?.aiResponse || '').length;
            const entityCount = Array.isArray(payload?.focusedEntities) ? payload.focusedEntities.length : 0;
            const relationCount = Array.isArray(payload?.relationTexts) ? payload.relationTexts.length : 0;
            const recentTurnCount = Array.isArray(payload?.recentTurns) ? payload.recentTurns.length : 0;
            const hostEvidenceChars = String(payload?.hostPromptEvidenceText || '').length;
            let score = 0;
            if (evidenceChars >= 10000) score += 3;
            else if (evidenceChars >= 5000) score += 2;
            else if (evidenceChars >= 1800) score += 1;
            if (entityCount >= 7) score += 2;
            else if (entityCount >= 4) score += 1;
            if (relationCount >= 6) score += 1;
            if (recentTurnCount >= 8) score += 1;
            if (hostEvidenceChars >= 4500) score += 1;
            if (payload?.worldCanonCustomActive === true) score += 2;
            if (payload?.worldAdditionalCustomActive === true) score += 1;
            if (payload?.plannerOrchestrationActive === true) score += 1;
            if (payload?.analysisIncludesUserInput === true && String(payload?.strictUserMsg || payload?.userMsg || '').length >= 1600) score += 1;
            const recovery = options?.recoveryMode === true;
            const tier = recovery ? 'recovery' : (score >= 7 ? 'critical' : (score >= 4 ? 'complex' : (score >= 2 ? 'standard' : 'light')));
            const key = String(worker || 'canonical_packet').trim().toLowerCase();
            // world_additional 출력 예산. 실측(2026-09-27, 실제 출하 프롬프트 + 로컬 모델 2종,
            // 캡처 8턴 = worldAdditional 9건 × 2모델)에서 **standard(1300)에서 잘림이 났다**:
            //   성공 최대 2,980자 @1300  ·  실패 3,468/3,474자 @1300 (done=length, 최상위 '}' 3개 부족)
            //   유일한 light(1000) 실행은 1,319자로 통과 — 즉 조이는 것은 light 가 아니라 standard 였다.
            // 계약 JSON 은 한국어에서 대략 2.3자/토큰이므로 3,500자 ≈ 1,520토큰이다. 여유를 두고 올린다.
            // 주의: 이 테이블은 02h 의 domain profile(turnMaintenanceBundle.fullMaxTokens 2400)과 함께
            // min() 으로 곱해진다. 지금은 테이블이 더 작아 테이블이 지배한다 — 02h 만 올리면 효과가 없다.
            // 계약별 출력 예산은 **한 곳에서만** 정의한다(파편화 방지).
            // 실측(2026-09-27): turnMaintenanceBundle 도메인 천장 2800 인데 manual/historical 은 3200,
            // RP 장기기억 포함 경로는 3600 을 요청해 **둘 다 조용히 2800 으로 잘리고 있었다**. 어느 파일에도
            // 요청값과 실효값을 함께 보여주는 곳이 없어서 드러나지 않던 파편화의 실제 피해다.
            // 이제 하드코딩 지점도 이 상수에서 값을 얻고, 게이트가 "요청 ≤ 실효" 를 검사한다.
            const table = CONTRACT_OUTPUT_BUDGETS[key] || CONTRACT_OUTPUT_BUDGETS.canonical_packet;
            return Object.freeze({
                worker: key,
                tier,
                score,
                maxTokens: table[tier] || table.standard,
                disableReasoning: recovery || tier !== 'critical',
                evidenceChars,
                entityCount,
                relationCount,
                recentTurnCount
            });
        };
        const sanitizeCorrectionPayloadLite = (payload) => ({
            shouldCorrect: !!payload?.shouldCorrect,
            reasons: Array.isArray(payload?.reasons) ? payload.reasons.map(v => String(v || '').trim()).filter(Boolean).slice(0, 6) : [],
            correctedEntities: Array.isArray(payload?.correctedEntities) ? payload.correctedEntities.filter(item => item && item.name) : [],
            correctedRelations: Array.isArray(payload?.correctedRelations) ? payload.correctedRelations.filter(item => item && item.entityA && item.entityB) : [],
            world: (payload?.world && typeof payload.world === 'object' && !Array.isArray(payload.world)) ? payload.world : {},
            narrative: (payload?.narrative && typeof payload.narrative === 'object' && !Array.isArray(payload.narrative)) ? payload.narrative : {}
        });

        const buildPayload = (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG) => {
            const worldAdditionalActive = config?.worldAdditionalEnabled === true && String(config?.worldAdditionalMode || 'off').toLowerCase() !== 'off';
            const storyAuthorActive = config?.storyAuthorEnabled === true && String(config?.storyAuthorMode || 'disabled').toLowerCase() !== 'disabled';
            const directorActive = config?.directorEnabled === true && String(config?.directorMode || 'disabled').toLowerCase() !== 'disabled';
            const plannerOrchestrationActive = storyAuthorActive || directorActive;
            const involvedNames = [...new Set((turnState?.involvedEntities || []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean))];
            const userEvidenceText = String(turnState?.strictUserMsg || turnState?.userMsgForMemory || turnState?.userMsgForNarrative || '').trim();
            const analysisEvidence = buildCurrentTurnAnalysisEvidence(userEvidenceText, aiResponse, config);
            const entityCache = Array.from(EntityManager.getEntityCache().values());
            const focusedEntities = involvedNames.length > 0
                ? entityCache.filter(entity => involvedNames.includes(entity.name))
                : entityCache.slice(0, 4);
            const charStateTexts = focusedEntities
                .map(entity => CharacterStateTracker.formatForPrompt(entity.name))
                .filter(Boolean);
            const entityTexts = focusedEntities
                .map(entity => EntityManager.formatEntityForPrompt(entity.name))
                .filter(Boolean);
            const relationTexts = focusedEntities
                .flatMap(entity => EntityManager.formatRelationsForPrompt(entity.name))
                .filter(Boolean)
                .slice(0, 8);
            const recentTurns = (NarrativeTracker.getState()?.turnLog || []).slice(-8)
                .map(t => `Turn ${t.turn}: ${t.summary || t.response}`);
            const memoryEntries = MemoryEngine.getManagedEntries(effectiveLore)
                .map(entry => ({ entry, meta: MemoryEngine.getCachedMeta(entry) }))
                .sort((a, b) => (b.meta.imp - a.meta.imp) || (b.meta.t - a.meta.t))
                .slice(0, 6)
                .map(({ entry }) => CompactMemoryCodec.buildDisplayTextFromEntry(entry, 220))
                .filter(Boolean);
            const hostPromptEvidenceText = HostPromptEvidenceBuffer.formatForAnalysis(
                turnState?.hostPromptEvidence,
                analysisEvidence.assistantText,
                { maxRecords: 8, maxChars: 5000 }
            );
            // Format the expensive world/narrative views once. V4.2 planner-only
            // derivative arrays are built only when Story Author or Director is active.
            const worldPromptText = HierarchicalWorldManager.formatForPrompt();
            const worldStatePromptText = WorldStateTracker.formatForPrompt();
            const narrativePromptText = NarrativeTracker.formatForPrompt();
            let userDlcTrackerPrompt = '';
            try {
                const unpackedLore = LibraLoreConsolidator.unpack(Array.isArray(effectiveLore) ? effectiveLore : []);
                if (unpackedLore.some(entry => String(entry?.comment || '') === 'lmai_user_dlc')) {
                    const previousDlcState = UserDlcCore.getState?.() || {};
                    UserDlcCore.loadState?.(effectiveLore, { scopeKey: previousDlcState.scopeKey || '', chatId: previousDlcState.chatId || '' });
                }
                // Result consumers never receive the dedicated analyzer's raw state/history.
                userDlcTrackerPrompt = '';
            } catch (trackerLoadError) {
                if (config?.debug) recordRuntimeDebug('warn', '[LIBRA] User DLC tracker prompt preparation skipped:', trackerLoadError?.message || trackerLoadError);
            }

            const wmResultContext = { lorebook: effectiveLore, scopeKey: UserDlcCore.getState().scopeKey, focusNames: involvedNames };
            const wmResultSnapshot = WmResultProjection.capture(wmResultContext);
            const payload = {
                wmResultSnapshot, wmResultContext,
                turn: currentTurn,
                turnState,
                userMsg: analysisEvidence.includeUser ? userEvidenceText : '',
                strictUserMsg: userEvidenceText,
                userRequestMetadata: userEvidenceText,
                hasUserRequestMetadata: !!userEvidenceText,
                aiResponse: analysisEvidence.assistantText,
                assistantEvidenceText: analysisEvidence.assistantText,
                canonicalEvidenceText: analysisEvidence.text,
                evidenceText: analysisEvidence.text,
                evidenceLabel: analysisEvidence.label,
                evidencePolicy: analysisEvidence.policy,
                analysisEvidenceMode: analysisEvidence.mode,
                analysisIncludesUserInput: analysisEvidence.includeUser,
                extracted: turnState?.entityResult && typeof turnState.entityResult === 'object'
                    ? safeClone(turnState.entityResult)
                    : { entities: [], relations: [], world: {} },
                focusedEntities: focusedEntities.map(e => e.name),
                entityTexts,
                relationTexts,
                relationStateSignals: plannerOrchestrationActive ? relationTexts.slice(0, 8) : [],
                entityContextHints: plannerOrchestrationActive ? [...entityTexts, ...charStateTexts].slice(0, 8) : [],
                charStateTexts,
                worldPrompt: worldPromptText,
                worldStatePrompt: worldStatePromptText,
                narrativePrompt: narrativePromptText,
                currentStoryAuthorPrompt: storyAuthorActive ? StoryAuthor.formatForPrompt(wmResultContext) : '',
                currentDirectorPrompt: directorActive ? Director.formatForPrompt(wmResultContext) : '',
                currentWorldAdditionalPrompt: '', // Legacy result prose is management-only until provenance is verified.
                userDlcTrackerPrompt,
                userDlcTrackersActive: !!userDlcTrackerPrompt,
                worldCanonCustomText: getWorldCanonCustomText(config),
                worldCanonCustomActive: hasWorldCanonCustomMandate(config),
                worldAdditionalCustomText: worldAdditionalActive ? getWorldAdditionalCustomText(config) : '',
                worldAdditionalCustomActive: worldAdditionalActive && hasWorldAdditionalCustomMandate(config),
                recentTurns,
                storylineCarryoverSignals: plannerOrchestrationActive ? recentTurns.slice(-6) : [],
                worldManagerHints: plannerOrchestrationActive ? [
                    ...String(worldPromptText || '').split(/\r?\n/),
                    ...String(worldStatePromptText || '').split(/\r?\n/)
                ].map(item => String(item || '').trim()).filter(Boolean).slice(0, 8) : [],
                environmentPressures: plannerOrchestrationActive
                    ? String(worldStatePromptText || '').split(/\r?\n/).map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
                    : [],
                memoryEntries,
                hostPromptEvidenceText,
                sourceMessageIds: plannerOrchestrationActive
                    ? NarrativeOrchestrationCore.collectSourceMessageIds({ ...turnState, turnState })
                    : [],
                sourceRevision: Math.max(0, Number(turnState?.sourceRevision || currentTurn) || currentTurn),
                plannerOrchestrationActive,
                storyAuthorActive,
                directorActive
            };
            if (plannerOrchestrationActive) {
                payload.sceneContract = NarrativeOrchestrationCore.buildSceneContract(payload);
                payload.narrativeDiagnostics = NarrativeOrchestrationCore.buildNarrativeDiagnostics(payload, payload.sceneContract);
                const refresh = NarrativeOrchestrationCore.resolveRefreshModes(payload, currentTurn, config);
                payload.plannerRefreshModes = { storyAuthor: refresh.storyAuthor, director: refresh.director };
                payload.plannerRefreshReasons = refresh.reasons || [];
                payload.plannerProvenance = { ...(refresh.plannerProvenance || NarrativeOrchestrationCore.buildPlannerProvenance(payload, 'light')), wmResultVersion: wmResultSnapshot.version };
                payload.authorPlanInputs = NarrativeOrchestrationCore.buildAuthorPlanInputs(WmResultProjection.plannerState(StoryAuthor.getState?.() || {}, wmResultContext));
            } else {
                payload.sceneContract = null;
                payload.narrativeDiagnostics = null;
                payload.plannerRefreshModes = null;
                payload.plannerRefreshReasons = [];
                payload.plannerProvenance = null;
                payload.authorPlanInputs = [];
            }
            return payload;
        };

        const buildHeuristicStoryAuthor = (payload, config = MemoryEngine.CONFIG) => {
            const focused = Array.isArray(payload.focusedEntities) ? payload.focusedEntities.slice(0, 8) : [];
            const mode = String(config?.storyAuthorMode || 'disabled').toLowerCase();
            const diagnostics = payload?.narrativeDiagnostics || NarrativeOrchestrationCore.buildNarrativeDiagnostics(payload, payload?.sceneContract);
            const nextBeats = [];
            if (diagnostics?.repetitionRisk >= 0.65) nextBeats.push('Change the beat type or create a concrete state change instead of repeating the previous emotional or dialogue loop.');
            if (focused.length > 0) nextBeats.push(mode === 'supportive'
                ? `${focused[0]} may respond through a grounded action or dialogue that preserves the user-led rhythm.`
                : `${focused[0]} should take a grounded action, decision, or reveal that changes at least one visible state.`);
            if (payload.worldStatePrompt) nextBeats.push('Use world and relationship pressure as constraints or possibilities, not pre-decided outcomes.');
            if (!payload.hasUserRequestMetadata) nextBeats.push('Continue from the immediately active scene without restarting or recapping it.');
            if (mode === 'aggressive') nextBeats.push('Create a consequential beat before the response ends without forcing user agency.');
            return {
                refreshMode: payload?.plannerRefreshModes?.storyAuthor || 'light',
                currentArc: WmResultProjection.plannerState(StoryAuthor.getState?.() || {}, payload.wmResultContext).currentArc || 'Ongoing Story',
                narrativeGoal: payload.hasUserRequestMetadata
                    ? 'Align the next story beat with the latest user input and confirmed continuity.'
                    : 'Continue the active scene from its current state without inventing a new premise.',
                scenePhase: diagnostics?.scenePhase || 'development',
                activeTensions: diagnostics?.openTensions?.length ? diagnostics.openTensions : ['Preserve the most relevant unresolved tension without forcing a premature payoff.'],
                primaryTension: diagnostics?.openTensions?.[0] || '',
                openQuestions: WmResultProjection.plannerState(StoryAuthor.getState?.() || {}, payload.wmResultContext).openQuestions || [],
                payoffCandidates: diagnostics?.payoffCandidates || [],
                recommendedBeatType: diagnostics?.recommendedBeatType || 'dialogue',
                nextBeats,
                beatReason: diagnostics?.repetitionRisk >= 0.65
                    ? 'The next response should vary the beat and produce state change.'
                    : 'The next response should directly answer the current user intent while preserving continuity.',
                escalationDelta: mode === 'aggressive' ? 1 : 0,
                guardrails: diagnostics?.guardrails || [],
                doNotResolveYet: diagnostics?.doNotResolveYet || [],
                entityContextHints: payload?.entityContextHints || [],
                relationStateSignals: payload?.relationStateSignals || [],
                worldManagerHints: payload?.worldManagerHints || [],
                environmentPressures: payload?.environmentPressures || [],
                storylineCarryoverSignals: payload?.storylineCarryoverSignals || [],
                focusCharacters: focused,
                recentDecisions: [],
                userIntentAlignment: diagnostics?.userIntentAlignment || '',
                sceneContract: payload?.sceneContract || null,
                narrativeDiagnostics: diagnostics || null
            };
        };
        const buildHeuristicDirector = (payload, config = MemoryEngine.CONFIG) => {
            const mode = String(config?.directorMode || 'disabled').toLowerCase();
            const authorPlan = buildHeuristicStoryAuthor(payload, config);
            const focused = Array.isArray(payload.focusedEntities) ? payload.focusedEntities.slice(0, 8) : [];
            const requiredOutcomes = [];
            if (mode === 'absolute' || mode === 'strong') requiredOutcomes.push(authorPlan.nextBeats?.[0] || 'Create one visible, continuity-grounded state change.');
            else if (authorPlan.nextBeats?.[0]) requiredOutcomes.push(`Where natural, realize this author beat: ${authorPlan.nextBeats[0]}`);
            if (!payload.hasUserRequestMetadata) requiredOutcomes.push('Continue from the immediately active scene without restarting it.');
            return NarrativeOrchestrationCore.validateDirectorHandoff({
                refreshMode: payload?.plannerRefreshModes?.director || 'light',
                sceneMandate: mode === 'absolute'
                    ? 'Execute the approved Story Author plan with unmistakable scene movement while preserving user agency and continuity.'
                    : mode === 'strong'
                        ? 'Execute the approved Story Author plan through a clear scene beat, consequence, decision, reveal, or relationship shift.'
                        : 'Translate the approved Story Author plan into scene-local staging, pacing, and emphasis without over-directing the user-led rhythm.',
                executionMode: mode === 'absolute' ? 'absolute' : mode === 'strong' ? 'forceful' : mode === 'light' ? 'subtle' : 'balanced',
                beatTypeToExecute: authorPlan.recommendedBeatType || 'dialogue',
                requiredOutcomes,
                forbiddenMoves: [
                    'Do not independently create a new story goal.',
                    'Do not contradict established world rules, relationship states, known facts, or the latest user input.'
                ],
                emphasis: ['Render guidance through visible action, dialogue, pacing, or consequence rather than backstage explanation.'],
                stagingInstructions: focused.length ? [`Keep staging centered on ${focused.join(', ')} unless the user introduces another active participant.`] : [],
                dialogueInstructions: ['Use remembered dialogue as voice and continuity evidence, not as lines to copy verbatim.'],
                pacingInstructions: [payload?.narrativeDiagnostics?.recommendedPacing || 'Follow the current user-led rhythm.'],
                targetPacing: mode === 'absolute' ? 'relentless' : mode === 'strong' ? 'brisk' : mode === 'light' ? 'measured' : 'steady',
                pressureLevel: mode,
                focusCharacters: focused,
                endingRequirement: mode === 'absolute' ? 'End after a concrete state change or consequential turn, not before it.' : ''
            }, authorPlan, payload, config);
        };
        const buildHeuristicBundle = (payload, config = MemoryEngine.CONFIG) => ({
            narrativeBrief: NarrativeTracker.buildHeuristicTurnBrief('', payload.aiResponse),
            correction: null,
            correctionReviewed: false,
            sceneContract: safeClone(payload?.sceneContract || null),
            narrativeDiagnostics: safeClone(payload?.narrativeDiagnostics || null),
            plannerRefreshModes: safeClone(payload?.plannerRefreshModes || { storyAuthor: 'light', director: 'light' }),
            plannerRefreshReasons: Array.isArray(payload?.plannerRefreshReasons) ? payload.plannerRefreshReasons.slice(0, 12) : [],
            plannerProvenance: safeClone(payload?.plannerProvenance || null),
            longTermMemory: config?.rpLongTermMemoryEnabled === false
                ? null
                : RPContinuityCore.extractHeuristic('', payload.aiResponse, {
                    turn: payload.turn,
                    entityRefs: payload.focusedEntities || [],
                    source: 'maintenance_heuristic'
                }),
            storyAuthor: config?.storyAuthorEnabled === true && String(config?.storyAuthorMode || 'disabled').toLowerCase() !== 'disabled'
                ? buildHeuristicStoryAuthor(payload, config)
                : null,
            director: config?.directorEnabled === true && String(config?.directorMode || 'disabled').toLowerCase() !== 'disabled'
                ? buildHeuristicDirector(payload, config)
                : null,
            worldAdditional: null, // Canonical phase cannot publish extension proposals.
            userDlcTrackerUpdates: []
        });

        const getWorldAdditionalResponseShape = () => {
            // 02g promptShape 와 같은 방식으로 구조 객체에서 파생한다.
            // 손으로 쓴 이스케이프 문자열은 배열마다 enum 이 조용히 달라져도 아무도 모른다
            // (실측: worldDeltas/characterAdditions 의 status 에서 injected/retired/blocked 가
            //  빠져 있었고, 제품 VALID_STATUSES 와 ingestMaintenance 의 injected 판정이
            //  두 배열에도 적용되는데도 발견되지 않았다).
            // 공통 필드를 공유하고 enum 을 상수로 두어 불일치를 구조적으로 막는다.
            const STATUS = 'prepared|armed|injected|manifested|integrated|retired|blocked';
            const TIER = 'ambient|local|section|arc|climax|final';
            const FORCE = 'soft|firm|hard';
            const IMPACT = 'none|ambient|soft|direct|major';
            // 필드 순서를 원본 shape 과 동일하게 유지한다. 모델 출력이 순서에 영향을 받을 수 있고,
            // 리팩터링이 프롬프트를 바꾸지 않았다는 것을 캡처 대조로 확인할 수 있어야 한다.
            // 원본 순서(sceneInterventions/worldDeltas):
            //   type,title,description,directive,purpose,sourceBasis,reusedCanonEntity,
            //   activationCondition,progressionTier,customSource,forceLevel,userImpact,constraints,status
            // characterAdditions 는 name,title,role,description,... 로 name/role/novelty* 가 중간에 온다.
            // 필드 순서를 원본 shape 과 동일하게 유지한다. 모델 출력이 순서에 영향을 받을 수 있고,
            // 리팩터링이 프롬프트를 바꾸지 않았음을 캡처 대조로 확인할 수 있어야 한다.
            // 원본 순서 (캡처 대조로 확정):
            //   sceneInterventions/worldDeltas: type,title,description,directive,purpose,sourceBasis,
            //     reusedCanonEntity,activationCondition,progressionTier,customSource,forceLevel,
            //     userImpact,constraints,status
            //   characterAdditions: type,name,title,role,description,...,reusedCanonEntity,
            //     noveltyReason,noveltyScope,progressionTier,customSource,activationCondition,...
            const COMMON = {
                title: '', description: '', directive: '', purpose: '', sourceBasis: [''],
                reusedCanonEntity: '', activationCondition: '', progressionTier: TIER,
                customSource: '', forceLevel: FORCE, userImpact: IMPACT,
                constraints: [''], status: STATUS
            };
            const ORDER_PLAIN = ['title', 'description', 'directive', 'purpose', 'sourceBasis',
                'reusedCanonEntity', 'activationCondition', 'progressionTier', 'customSource',
                'forceLevel', 'userImpact', 'constraints', 'status'];
            const ORDER_CHARACTER = ['name', 'title', 'role', 'description', 'directive', 'purpose',
                'sourceBasis', 'reusedCanonEntity', 'noveltyReason', 'noveltyScope',
                'progressionTier', 'customSource', 'activationCondition', 'forceLevel',
                'userImpact', 'constraints', 'status'];
            const directiveFields = (typeLabel, isCharacter = false) => {
                const out = { type: typeLabel };
                const order = isCharacter ? ORDER_CHARACTER : ORDER_PLAIN;
                for (const key of order) {
                    if (key === 'name') out.name = '';
                    else if (key === 'role') out.role = '';
                    else if (key === 'noveltyReason') out.noveltyReason = '';
                    else if (key === 'noveltyScope') out.noveltyScope = 'unintroduced_new|canon_reuse|custom_requested';
                    else out[key] = COMMON[key];
                }
                return out;
            };
            return JSON.stringify({
                worldAdditional: {
                    sceneInterventions: [directiveFields('scene_intervention')],
                    worldDeltas: [directiveFields('world_delta')],
                    characterAdditions: [directiveFields('character_addition', true)],
                    manifestations: [{ id: '', title: '', type: 'scene_intervention|world_delta|character_addition',
                        manifested: true, integrate: false, retire: false, note: '' }]
                }
            }).slice(1, -1);
        };
        const getUserDlcTrackerResponseShape = () => {
            // world_additional 과 같은 이유로 구조 객체에서 파생한다.
            const CONFIDENCE = 'confirmed|likely|possible|uncertain|unknown';
            const VIRGINITY = 'unknown|no_confirmed_sex_experience|sexually_experienced';
            const SH_BASIS = 'unknown|observed_minimum|canonical_total';
            const DB_COMPAT = 'compatible|explicit_transition|conflicted';
            const N = null;
            return JSON.stringify({
                userDlcTrackerUpdates: [{
                    trackerId: '',
                    packetId: '', packetRevision: '', evidenceRefs: [''],
                    value: '',
                    confidence: CONFIDENCE,
                    currentSnapshot: {
                        summary: '', relationshipState: '', probabilityMin: N, probabilityMax: N,
                        probabilityLabel: '', expectedResponse: '', dialogueExamples: [''],
                        defenseAssessment: '', sceneDate: '', cycleStatus: '', fertilityWindow: '',
                        contraception: '', healthStatus: '', sexCount: N, virginityStatus: VIRGINITY,
                        masturbationCount: N, pregnancyCount: N, birthCount: N, distinctPartnerCount: N,
                        vaginalEjaculationCount: N, fellatioCount: N, analSexCount: N,
                        firstSexPartner: '', knownSexPartners: [''], sexualHistoryCountingBasis: SH_BASIS,
                        sexualHistoryNote: '', nextEvaluation: '', confidenceNote: ''
                    },
                    eventKey: '', canonicalOccurrenceRef: '', eventType: '', probabilityMin: N, probabilityMax: N, sceneDate: '',
                    sexualHistoryDelta: {
                        sexCount: N, masturbationCount: N, pregnancyCount: N, birthCount: N,
                        vaginalEjaculationCount: N, fellatioCount: N, analSexCount: N, newPartnerCount: N,
                        virginityStatus: '', partnerNames: [''], firstSexPartner: ''
                    },
                    evidence: ['direct current-assistant evidence'],
                    reason: '',
                    dbCompatibility: DB_COMPAT,
                    dbConflicts: [''],
                    relevant: true
                }]
            }).slice(1, -1);
        };
        const getMaintenanceResponseShape = (includeRpLongTermLlm = false, includeWorldAdditional = false, includeStoryAuthor = false, includeDirector = false, includeUserDlcTrackers = false) => {
            const fields = [
                '"narrativeBrief":""',
                '"correction":{"shouldCorrect":false,"reasons":[],"correctedEntities":[],"correctedRelations":[],"world":{},"narrative":{}}'
            ];
            if (includeRpLongTermLlm) {
                fields.push('"longTermMemory":{"importance":5,"durability":"short|medium|long|permanent","stableFacts":[{"subject":"","slot":"","value":"","text":"","confidence":0.8,"visibility":"public|pov|secret","knownBy":[],"unknownTo":[]}],"preferences":[{"subject":"","kind":"preference|boundary|fear|medical_or_food_boundary","topic":"","text":"","confidence":0.8}],"commitments":[{"owner":"","target":"","text":"","status":"open|fulfilled|broken|cancelled","due":"","confidence":0.8}],"openLoops":[{"type":"goal|mystery|conflict","text":"","status":"open|resolved","resolutionCriteria":[],"confidence":0.8}],"relationshipDeltas":[{"pair":["",""],"axis":"trust|affection|fear|loyalty|hostility|status","direction":"increase|decrease|shift","text":"","confidence":0.8}],"stateChanges":[{"entity":"","domain":"physical|location|role|knowledge|possession|goal","before":"","after":"","text":"","confidence":0.8}],"callbacks":[{"label":"","text":"","entities":[],"confidence":0.8}]}');
            }
            if (includeStoryAuthor) {
                fields.push('"storyAuthor":{"refreshMode":"full|light|reuse","currentArc":"","narrativeGoal":"","scenePhase":"setup|development|escalation|turning_point|aftermath|transition","activeTensions":[""],"primaryTension":"","openQuestions":[""],"payoffCandidates":[""],"recommendedBeatType":"dialogue|decision|reveal|confrontation|intimacy|interruption|consequence|transition","nextBeats":[""],"beatReason":"","escalationDelta":0,"guardrails":[""],"doNotResolveYet":[""],"entityContextHints":[""],"relationStateSignals":[""],"worldManagerHints":[""],"environmentPressures":[""],"storylineCarryoverSignals":[""],"focusCharacters":[""],"recentDecisions":[""],"userIntentAlignment":""}');
            }
            if (includeDirector) {
                fields.push('"director":{"refreshMode":"full|light|reuse","sceneMandate":"","executionMode":"subtle|balanced|forceful|absolute","beatTypeToExecute":"dialogue|decision|reveal|confrontation|intimacy|interruption|consequence|transition","requiredOutcomes":[""],"forbiddenMoves":[""],"emphasis":[""],"stagingInstructions":[""],"dialogueInstructions":[""],"pacingInstructions":[""],"continuityLocks":[""],"authorPlanInputs":[""],"worldManagerInputs":[""],"targetPacing":"","pressureLevel":"","focusCharacters":[""],"endingRequirement":""}');
            }
            if (includeWorldAdditional) fields.push(getWorldAdditionalResponseShape());
            if (includeUserDlcTrackers) fields.push(getUserDlcTrackerResponseShape());
            return `{${fields.join(',')}}`;
        };



        const normalizeMaintenanceBundleResult = (parsed, heuristic, payload, config = MemoryEngine.CONFIG) => {
            const safe = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            const plannerOrchestrationActive = payload?.plannerOrchestrationActive === true;
            const storyAuthorActive = payload?.storyAuthorActive === true;
            const directorActive = payload?.directorActive === true;
            const refreshModes = plannerOrchestrationActive ? {
                storyAuthor: NarrativeOrchestrationCore.normalizeEnum(
                    payload?.plannerRefreshModes?.storyAuthor || safe?.storyAuthor?.refreshMode,
                    NarrativeOrchestrationCore.VALID_REFRESH_MODES,
                    'light'
                ),
                director: NarrativeOrchestrationCore.normalizeEnum(
                    payload?.plannerRefreshModes?.director || safe?.director?.refreshMode,
                    NarrativeOrchestrationCore.VALID_REFRESH_MODES,
                    'light'
                )
            } : { storyAuthor: 'reuse', director: 'reuse' };
            const sceneContract = plannerOrchestrationActive ? safeClone(payload?.sceneContract || heuristic?.sceneContract || null) : null;
            const narrativeDiagnostics = plannerOrchestrationActive ? safeClone(payload?.narrativeDiagnostics || heuristic?.narrativeDiagnostics || null) : null;
            const plannerProvenance = plannerOrchestrationActive ? safeClone(
                payload?.plannerProvenance
                || heuristic?.plannerProvenance
                || NarrativeOrchestrationCore.buildPlannerProvenance({ ...payload, sceneContract, narrativeDiagnostics }, 'light')
            ) : null;
            const rawStoryAuthor = plannerOrchestrationActive && safe.storyAuthor && typeof safe.storyAuthor === 'object'
                ? safe.storyAuthor
                : (plannerOrchestrationActive ? heuristic.storyAuthor : null);
            const storyAuthor = !storyAuthorActive || refreshModes.storyAuthor === 'reuse'
                ? null
                : (rawStoryAuthor && typeof rawStoryAuthor === 'object'
                    ? {
                        ...rawStoryAuthor,
                        refreshMode: refreshModes.storyAuthor,
                        sceneContract,
                        narrativeDiagnostics,
                        userIntentAlignment: rawStoryAuthor.userIntentAlignment || narrativeDiagnostics?.userIntentAlignment || '',
                        doNotResolveYet: Array.isArray(rawStoryAuthor.doNotResolveYet) ? rawStoryAuthor.doNotResolveYet : (narrativeDiagnostics?.doNotResolveYet || []),
                        recommendedBeatType: rawStoryAuthor.recommendedBeatType || narrativeDiagnostics?.recommendedBeatType || '',
                        scenePhase: rawStoryAuthor.scenePhase || narrativeDiagnostics?.scenePhase || ''
                    }
                    : null);
            const authorForHandoff = rawStoryAuthor || storyAuthor || heuristic.storyAuthor || WmResultProjection.plannerState(StoryAuthor.getState?.() || {}, payload.wmResultContext);
            const rawDirector = plannerOrchestrationActive && safe.director && typeof safe.director === 'object'
                ? safe.director
                : (plannerOrchestrationActive ? heuristic.director : null);
            const director = !directorActive || refreshModes.director === 'reuse'
                ? null
                : (rawDirector && typeof rawDirector === 'object'
                    ? NarrativeOrchestrationCore.validateDirectorHandoff({
                        ...rawDirector,
                        refreshMode: refreshModes.director
                    }, authorForHandoff, {
                        ...payload,
                        sceneContract,
                        narrativeDiagnostics
                    }, config)
                    : null);
            return {
                narrativeBrief: String(safe.narrativeBrief || '').trim() || heuristic.narrativeBrief,
                correction: safe.correction ? sanitizeCorrectionPayloadLite(safe.correction) : null,
                correctionReviewed: Object.prototype.hasOwnProperty.call(safe, 'correction'),
                sceneContract,
                narrativeDiagnostics,
                plannerRefreshModes: refreshModes,
                plannerRefreshReasons: Array.isArray(payload?.plannerRefreshReasons) ? payload.plannerRefreshReasons.slice(0, 12) : [],
                plannerProvenance,
                longTermMemory: config?.rpLongTermMemoryEnabled === false
                    ? null
                    : (config?.rpLongTermLlmEnrichment === false
                        ? heuristic.longTermMemory
                        : RPContinuityCore.mergeTurnMemory(heuristic.longTermMemory, safe.longTermMemory || null, {
                            turn: payload.turn,
                            entityRefs: payload.focusedEntities || [],
                            source: 'maintenance_llm'
                        })),
                storyAuthor,
                director,
                worldAdditional: config?.worldAdditionalEnabled === true && String(config?.worldAdditionalMode || 'off').toLowerCase() !== 'off'
                    ? WorldAdditionalCore.normalizeMaintenancePayload?.(safe.worldAdditional || safe.world_additional || heuristic.worldAdditional || null)
                    : null,
                userDlcTrackerUpdates: payload?.userDlcTrackersActive === true
                    ? UserDlcCore.normalizeTrackerUpdates?.(safe.userDlcTrackerUpdates || safe.user_dlc_tracker_updates || []) || []
                    : [],
                canonicalPacket: safe.canonicalPacket && typeof safe.canonicalPacket === 'object' && !Array.isArray(safe.canonicalPacket)
                    ? safeClone(safe.canonicalPacket)
                    : null
            };
        };


        const extractUnifiedEntityPayload = (parsed = {}) => {
            const compat = parsed?.compat && typeof parsed.compat === 'object' && !Array.isArray(parsed.compat) ? parsed.compat : {};
            const candidate = parsed?.entityExtraction || compat?.entityExtraction || parsed?.entityExtractionPatch || parsed?.entity || parsed?.entitiesPatch || null;
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
            const hasEntityShape = Array.isArray(candidate.entities)
                || Array.isArray(candidate.relations)
                || Array.isArray(candidate.spans)
                || (candidate.world && typeof candidate.world === 'object' && !Array.isArray(candidate.world));
            return hasEntityShape ? candidate : null;
        };

        const isPacketObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
        const hasCanonicalPacketKeys = (value = {}) => isPacketObject(value) && [
            'meta', 'memory', 'entity', 'world', 'narrative', 'guidance', 'guards', 'importance'
        ].some(key => Object.prototype.hasOwnProperty.call(value, key));
        const extractUnifiedCanonicalPacket = (parsed = {}) => {
            const candidates = [
                parsed?.canonicalPacket,
                parsed?.canonical_packet,
                parsed?.packet,
                parsed?.packet_patch,
                parsed?.compat?.canonicalPacket,
                parsed?.compat?.packet
            ];
            for (const candidate of candidates) {
                if (hasCanonicalPacketKeys(candidate)) return safeClone(candidate);
            }
            if (hasCanonicalPacketKeys(parsed) && !Object.prototype.hasOwnProperty.call(parsed, 'entityExtraction')) {
                return safeClone(parsed);
            }
            return null;
        };
        const attachCanonicalPacketEvidenceContext = (packet = null, payload = {}, options = {}) => {
            if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return packet;
            const next = safeClone(packet);
            const turn = Math.max(0, Number(payload?.turn || 0) || 0);
            const sourceMessageId = String(options?.sourceMessageId || options?.messageId || '').trim();
            next.meta = next.meta && typeof next.meta === 'object' && !Array.isArray(next.meta) ? next.meta : {};
            const trustedSourceIds = normalizeCanonicalMessageIds([options?.sourceMessageIds, sourceMessageId]);
            const assertEvidenceBinding = (ref) => {
                if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return;
                if (ref.turn && turn && Number(ref.turn) !== turn) throw new Error('canonical_packet_turn_mismatch');
                const id = String(ref.messageId || '').trim();
                if (id && trustedSourceIds.length && !trustedSourceIds.includes(id)) throw new Error('canonical_packet_source_mismatch');
            };
            assertEvidenceBinding({ turn: next.meta.turn });
            for (const id of normalizeCanonicalMessageIds(next.meta.sourceMessageIds)) assertEvidenceBinding({ messageId: id });
            // Every axis can carry evidence, including nested world/narrative state.
            // Reject contradictions rather than laundering them into trusted IDs.
            const inspectEvidence = (value) => {
                if (!value || typeof value !== 'object') return;
                if (Array.isArray(value)) { value.forEach(inspectEvidence); return; }
                for (const [key, child] of Object.entries(value)) {
                    if (key === 'evidenceRefs' && Array.isArray(child)) child.forEach(assertEvidenceBinding);
                    else inspectEvidence(child);
                }
            };
            inspectEvidence(next);
            if (!next.meta.turn && turn) next.meta.turn = turn;
            const sourceIds = dedupeTextArray([
                ...(Array.isArray(next.meta.sourceMessageIds) ? next.meta.sourceMessageIds : []),
                sourceMessageId
            ].filter(Boolean)).slice(0, 8);
            if (sourceIds.length) next.meta.sourceMessageIds = sourceIds;
            const enrichRefs = (item) => {
                if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.evidenceRefs)) return item;
                item.evidenceRefs = item.evidenceRefs.slice(0, 8).map(ref => {
                    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return ref;
                    return {
                        ...ref,
                        turn: Math.max(0, Number(ref.turn || turn || 0) || 0),
                        messageId: String(ref.messageId || sourceMessageId || '').trim()
                    };
                });
                return item;
            };
            for (const list of [
                next.memory?.events, next.memory?.facts, next.memory?.open_threads,
                next.entity?.characters, next.entity?.relations, next.entity?.current_state
            ]) {
                if (Array.isArray(list)) list.forEach(enrichRefs);
            }
            return next;
        };
        const packetArray = (value) => Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
        const packetObject = (value) => isPacketObject(value) ? value : {};
        const packetText = (value, max = 220) => {
            if (value == null) return '';
            if (isPacketObject(value)) {
                const picked = value.summary || value.text || value.label || value.value || value.current_state || value.state || value.reason || '';
                if (picked) return packetText(picked, max);
                try { return packetText(JSON.stringify(value), max); } catch { return ''; }
            }
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (!text) return '';
            return text.length > max ? `${text.slice(0, Math.max(24, max - 1)).trim()}…` : text;
        };
        const packetTextList = (value, limit = 8, max = 180) => dedupeTextArray(
            packetArray(value)
                .map(item => packetText(item, max))
                .filter(Boolean)
        ).slice(0, Math.max(1, Number(limit || 8)));
        const packetObjectList = (value) => packetArray(value).filter(item => isPacketObject(item));
        const packetOperation = (item = {}) => String(item?.operation || 'add').trim().toLowerCase() || 'add';
        const packetObjectListForWrite = (value) => packetObjectList(value).filter(item => packetOperation(item) !== 'no_change');
        const packetImportance = (packet = {}, fallback = 5) => {
            const raw = packet?.importance?.overall ?? packet?.importance ?? packet?.meta?.importance;
            const numeric = Number(raw);
            if (!Number.isFinite(numeric)) return fallback;
            if (numeric <= 1) return Math.max(1, Math.min(10, Math.round(numeric * 10)));
            return Math.max(1, Math.min(10, Math.round(numeric)));
        };
        const pushPacketFact = (out, subject, slot, value, text, meta = {}) => {
            const body = packetText(text || value, 260);
            if (!body) return;
            out.push({
                subject: packetText(subject || 'current_turn', 120) || 'current_turn',
                slot: packetText(slot || 'fact', 80) || 'fact',
                value: packetText(value || body, 220),
                text: body,
                confidence: Math.max(0, Math.min(1, Number(meta.confidence ?? 0.78) || 0.78)),
                visibility: packetText(meta.visibility || 'public', 32) || 'public',
                knownBy: Array.isArray(meta.knownBy) ? meta.knownBy.map(item => packetText(item, 80)).filter(Boolean).slice(0, 8) : [],
                unknownTo: Array.isArray(meta.unknownTo) ? meta.unknownTo.map(item => packetText(item, 80)).filter(Boolean).slice(0, 8) : [],
                operation: packetOperation(meta),
                evidenceRefs: Array.isArray(meta.evidenceRefs) ? safeClone(meta.evidenceRefs).slice(0, 8) : []
            });
        };
        const buildLongTermMemoryFromCanonicalPacket = (packet = {}, payload = {}, config = MemoryEngine.CONFIG) => {
            if (config?.rpLongTermMemoryEnabled === false || !hasCanonicalPacketKeys(packet)) return null;
            const meta = packetObject(packet.meta);
            const memory = packetObject(packet.memory);
            const entity = packetObject(packet.entity);
            const world = packetObject(packet.world);
            const narrative = packetObject(packet.narrative);
            const guidance = { ...packetObject(packet.guidance), ...packetObject(packet.guards) };
            const stableFacts = [];
            const callbacks = [];
            const openLoops = [];
            const relationshipDeltas = [];
            const stateChanges = [];
            for (const item of packetObjectListForWrite(memory.facts || memory.stableFacts || memory.stable_facts)) {
                pushPacketFact(stableFacts, item.subject || item.entity || 'current_turn', item.slot || item.type || 'fact', item.value || item.summary || item.text, item.text || item.summary || item.value, item);
            }
            for (const rule of packetTextList(world.rules || world.active_rules || world.activeRules, 12, 240)) {
                pushPacketFact(stableFacts, 'world', 'rule', rule, rule, { confidence: 0.82 });
            }
            for (const item of packetObjectListForWrite(entity.characters || entity.entities || entity.people)) {
                const name = packetText(item.name || item.canonicalName || item.displayName, 120);
                const summary = packetText(item.identity || item.role || item.summary || item.current_state || item.currentState, 260);
                if (name && summary) pushPacketFact(stableFacts, name, 'entity_profile', summary, summary, item);
                const state = packetText(item.current_state || item.currentState || item.state || item.status, 260);
                if (name && state) {
                    stateChanges.push({
                        entity: name,
                        domain: 'state',
                        before: '',
                        after: state,
                        text: state,
                        confidence: Math.max(0, Math.min(1, Number(item.confidence ?? item.quality?.confidence ?? 0.78) || 0.78)),
                        evidenceRefs: Array.isArray(item.evidenceRefs) ? safeClone(item.evidenceRefs).slice(0, 8) : []
                    });
                }
            }
            for (const item of packetObjectListForWrite(entity.relations || entity.relationships)) {
                const pair = packetArray(item.pair || item.entities || item.participants)
                    .map(value => packetText(value, 120))
                    .filter(Boolean)
                    .slice(0, 2);
                const entityA = packetText(item.entityA || item.a || item.from || pair[0] || '', 120);
                const entityB = packetText(item.entityB || item.b || item.to || pair[1] || '', 120);
                const text = packetText(item.text || item.summary || item.current_state || item.currentState || item.state || item.event, 260);
                if (entityA && entityB && text) {
                    relationshipDeltas.push({
                        pair: [entityA, entityB],
                        axis: packetText(item.axis || item.type || item.relationType || 'status', 80) || 'status',
                        direction: packetText(item.direction || item.change || 'shift', 40) || 'shift',
                        text,
                        confidence: Math.max(0, Math.min(1, Number(item.confidence ?? item.quality?.confidence ?? 0.78) || 0.78)),
                        evidenceRefs: Array.isArray(item.evidenceRefs) ? safeClone(item.evidenceRefs).slice(0, 8) : []
                    });
                }
            }
            for (const event of [
                ...packetObjectListForWrite(memory.events),
                ...packetObjectList(meta?.node_memory?.nodes),
                ...packetObjectList(world.active_events || world.activeEvents),
                ...packetObjectList(narrative.scene_deltas || narrative.sceneDeltas)
            ]) {
                const text = packetText(event.summary || event.text || event.event || event.label || event, 260);
                if (!text) continue;
                callbacks.push({
                    label: packetText(event.label || event.type || 'turn_event', 80) || 'turn_event',
                    text,
                    entities: packetTextList(event.entities || event.characters || event.participants || payload.focusedEntities, 8, 80),
                    confidence: Math.max(0, Math.min(1, Number(event.confidence ?? 0.76) || 0.76)),
                    evidenceRefs: Array.isArray(event.evidenceRefs) ? safeClone(event.evidenceRefs).slice(0, 8) : []
                });
            }
            for (const item of packetObjectListForWrite(memory.open_threads || memory.openThreads)) {
                const text = packetText(item.summary || item.text || item.label, 220);
                if (!text) continue;
                openLoops.push({
                    id: packetText(item.id || '', 120),
                    type: packetText(item.type || 'conflict', 80) || 'conflict',
                    text,
                    status: packetOperation(item) === 'resolve' ? 'resolved' : packetText(item.status || 'open', 32),
                    resolutionCriteria: packetTextList(item.resolutionCriteria || item.resolution_criteria, 6, 140),
                    confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.74) || 0.74)),
                    evidenceRefs: Array.isArray(item.evidenceRefs) ? safeClone(item.evidenceRefs).slice(0, 8) : []
                });
            }
            for (const text of [
                ...packetTextList(narrative.unresolved_threads || narrative.unresolvedThreads || narrative.conflict_traces || narrative.conflictTraces, 10, 220),
                ...packetTextList(world.offscreen_threads || world.offscreenThreads, 8, 220),
                ...packetTextList(guidance.unresolved_pressure || guidance.unresolvedPressure, 8, 220)
            ]) {
                openLoops.push({
                    type: 'conflict',
                    text,
                    status: 'open',
                    resolutionCriteria: [],
                    confidence: 0.74
                });
            }
            for (const text of [
                packetText(world.scene, 240),
                packetText(world.location ? `Location: ${world.location}` : '', 180),
                packetText(world.time ? `Time: ${world.time}` : '', 120)
            ].filter(Boolean)) {
                stateChanges.push({
                    entity: 'world',
                    domain: 'location',
                    before: '',
                    after: text,
                    text,
                    confidence: 0.76
                });
            }
            const hasAny = stableFacts.length || callbacks.length || openLoops.length || relationshipDeltas.length || stateChanges.length;
            if (!hasAny) return null;
            return {
                importance: packetImportance(packet, 5),
                durability: packetImportance(packet, 5) >= 8 ? 'long' : 'medium',
                stableFacts: stableFacts.slice(0, 12),
                preferences: [],
                commitments: [],
                openLoops: openLoops.slice(0, 10),
                relationshipDeltas: relationshipDeltas.slice(0, 10),
                stateChanges: stateChanges.slice(0, 12),
                callbacks: callbacks.slice(0, 12)
            };
        };
        const buildMaintenancePayloadFromCanonicalPacket = (packet = {}, heuristic = {}, payload = {}, config = MemoryEngine.CONFIG) => {
            if (!hasCanonicalPacketKeys(packet)) return null;
            const meta = packetObject(packet.meta);
            const memory = packetObject(packet.memory);
            const narrative = packetObject(packet.narrative);
            const guidance = { ...packetObject(packet.guidance), ...packetObject(packet.guards) };
            const summaryMemory = packetObject(meta.summary_memory || meta.summaryMemory);
            const narrativeBrief = packetText(
                narrative.summary
                || narrative.scene_summary
                || narrative.sceneSummary
                || summaryMemory.one_line
                || summaryMemory.summary
                || memory.summary
                || packetTextList(memory.events, 2, 180).join(' / '),
                260
            );
            const guardrails = dedupeTextArray([
                ...packetTextList(guidance.continuity_locks || guidance.continuityLocks, 8, 160),
                ...packetTextList(guidance.audit_cautions || guidance.auditCautions, 6, 160)
            ]);
            const tensions = dedupeTextArray([
                ...packetTextList(narrative.conflict_traces || narrative.conflictTraces, 8, 160),
                ...packetTextList(guidance.unresolved_pressure || guidance.unresolvedPressure, 8, 160)
            ]);
            const nextBeats = dedupeTextArray([
                ...packetTextList(narrative.scene_deltas || narrative.sceneDeltas, 6, 160),
                ...packetTextList(narrative.unresolved_threads || narrative.unresolvedThreads, 4, 160)
            ]);
            const correction = isPacketObject(guidance.correction) ? sanitizeCorrectionPayloadLite(guidance.correction) : null;
            return {
                narrativeBrief: narrativeBrief || heuristic.narrativeBrief || '',
                correction,
                longTermMemory: buildLongTermMemoryFromCanonicalPacket(packet, payload, config),
                storyAuthor: {
                    ...(heuristic.storyAuthor || {}),
                    refreshMode: payload?.plannerRefreshModes?.storyAuthor || heuristic.storyAuthor?.refreshMode || 'light',
                    currentArc: packetText(narrative.current_arc || narrative.currentArc || narrative.arc || heuristic.storyAuthor?.currentArc || '', 120),
                    narrativeGoal: packetText(narrative.narrative_goal || narrative.narrativeGoal || heuristic.storyAuthor?.narrativeGoal || '', 220),
                    scenePhase: packetText(narrative.scene_phase || narrative.scenePhase || payload?.narrativeDiagnostics?.scenePhase || heuristic.storyAuthor?.scenePhase || '', 80),
                    activeTensions: tensions.length ? tensions : (heuristic.storyAuthor?.activeTensions || []),
                    primaryTension: tensions[0] || heuristic.storyAuthor?.primaryTension || '',
                    openQuestions: packetTextList(narrative.open_questions || narrative.openQuestions || [], 8, 160),
                    payoffCandidates: packetTextList(narrative.payoff_candidates || narrative.payoffCandidates || [], 8, 160),
                    recommendedBeatType: packetText(narrative.recommended_beat_type || narrative.recommendedBeatType || payload?.narrativeDiagnostics?.recommendedBeatType || heuristic.storyAuthor?.recommendedBeatType || '', 60),
                    nextBeats: nextBeats.length ? nextBeats : (heuristic.storyAuthor?.nextBeats || []),
                    beatReason: packetText(narrative.beat_reason || narrative.beatReason || heuristic.storyAuthor?.beatReason || '', 200),
                    escalationDelta: Number(narrative.escalation_delta ?? narrative.escalationDelta ?? heuristic.storyAuthor?.escalationDelta ?? 0) || 0,
                    guardrails: guardrails.length ? guardrails : (heuristic.storyAuthor?.guardrails || []),
                    doNotResolveYet: packetTextList(narrative.do_not_resolve_yet || narrative.doNotResolveYet || payload?.narrativeDiagnostics?.doNotResolveYet || [], 8, 160),
                    entityContextHints: heuristic.storyAuthor?.entityContextHints || payload?.entityContextHints || [],
                    relationStateSignals: heuristic.storyAuthor?.relationStateSignals || payload?.relationStateSignals || [],
                    worldManagerHints: heuristic.storyAuthor?.worldManagerHints || payload?.worldManagerHints || [],
                    environmentPressures: heuristic.storyAuthor?.environmentPressures || payload?.environmentPressures || [],
                    storylineCarryoverSignals: heuristic.storyAuthor?.storylineCarryoverSignals || payload?.storylineCarryoverSignals || [],
                    focusCharacters: packetTextList(packet.entity?.focus || packet.entity?.active || payload.focusedEntities || [], 8, 80),
                    recentDecisions: packetTextList(narrative.recent_decisions || narrative.recentDecisions || [], 6, 160),
                    userIntentAlignment: payload?.narrativeDiagnostics?.userIntentAlignment || heuristic.storyAuthor?.userIntentAlignment || ''
                },
                director: NarrativeOrchestrationCore.validateDirectorHandoff({
                    ...(heuristic.director || {}),
                    refreshMode: payload?.plannerRefreshModes?.director || heuristic.director?.refreshMode || 'light',
                    sceneMandate: packetText(narrative.scene_mandate || narrative.sceneMandate || heuristic.director?.sceneMandate || '', 220),
                    executionMode: heuristic.director?.executionMode || '',
                    beatTypeToExecute: packetText(narrative.recommended_beat_type || narrative.recommendedBeatType || payload?.narrativeDiagnostics?.recommendedBeatType || heuristic.director?.beatTypeToExecute || '', 60),
                    requiredOutcomes: packetTextList(guidance.consequence_notes || guidance.consequenceNotes || narrative.scene_deltas || narrative.sceneDeltas, 8, 160),
                    forbiddenMoves: packetTextList(guidance.overpromotion_risks || guidance.overpromotionRisks || guidance.audit_cautions || guidance.auditCautions, 8, 160),
                    emphasis: packetTextList(narrative.theme_motifs || narrative.themeMotifs || [], 8, 120),
                    stagingInstructions: heuristic.director?.stagingInstructions || [],
                    dialogueInstructions: heuristic.director?.dialogueInstructions || [],
                    pacingInstructions: heuristic.director?.pacingInstructions || [],
                    continuityLocks: guardrails,
                    authorPlanInputs: NarrativeOrchestrationCore.buildAuthorPlanInputs(heuristic.storyAuthor || {}),
                    worldManagerInputs: payload?.worldManagerHints || [],
                    targetPacing: heuristic.director?.targetPacing || '',
                    pressureLevel: heuristic.director?.pressureLevel || '',
                    focusCharacters: packetTextList(packet.entity?.focus || packet.entity?.active || payload.focusedEntities || [], 8, 80),
                    endingRequirement: heuristic.director?.endingRequirement || ''
                }, heuristic.storyAuthor || {}, payload, config),
                canonicalPacket: safeClone(packet)
            };
        };
        const mergeCanonicalPacketIntoMaintenancePayload = (maintenancePayload = null, packet = null, heuristic = {}, payload = {}, config = MemoryEngine.CONFIG) => {
            const base = maintenancePayload && typeof maintenancePayload === 'object' && !Array.isArray(maintenancePayload)
                ? safeClone(maintenancePayload)
                : {};
            if (!hasCanonicalPacketKeys(packet)) return Object.keys(base).length ? base : null;
            const packetMaintenance = buildMaintenancePayloadFromCanonicalPacket(packet, heuristic, payload, config) || {};
            const merged = {
                ...base,
                ...packetMaintenance,
                storyAuthor: {
                    ...(base.storyAuthor && typeof base.storyAuthor === 'object' ? base.storyAuthor : {}),
                    ...(packetMaintenance.storyAuthor || {})
                },
                director: {
                    ...(base.director && typeof base.director === 'object' ? base.director : {}),
                    ...(packetMaintenance.director || {})
                },
                worldAdditional: base.worldAdditional || base.world_additional || packetMaintenance.worldAdditional || null,
                canonicalPacket: safeClone(packet)
            };
            if (packetMaintenance.longTermMemory && base.longTermMemory && config?.rpLongTermMemoryEnabled !== false) {
                merged.longTermMemory = RPContinuityCore.mergeTurnMemory(packetMaintenance.longTermMemory, base.longTermMemory, {
                    turn: payload.turn,
                    entityRefs: payload.focusedEntities || [],
                    source: 'unified_canonical_packet'
                });
            }
            return merged;
        };
        const deriveEntityExtractionFromCanonicalPacket = (packet = null, payload = {}, options = {}) => {
            if (!hasCanonicalPacketKeys(packet)) return null;
            const materializationPacket = safeClone(packet);
            if (materializationPacket?.entity && typeof materializationPacket.entity === 'object') {
                materializationPacket.entity.characters = packetObjectListForWrite(materializationPacket.entity.characters || materializationPacket.entity.entities || materializationPacket.entity.people);
                materializationPacket.entity.relations = packetObjectListForWrite(materializationPacket.entity.relations || materializationPacket.entity.relationships);
            }
            try {
                if (typeof EntityAwareProcessor !== 'undefined' && EntityAwareProcessor?.extractStructuredEntitySignalsFromPackets) {
                    return EntityAwareProcessor.extractStructuredEntitySignalsFromPackets(materializationPacket, {
                        lorebook: options?.lorebook || [],
                        conversationText: payload.canonicalEvidenceText || payload.aiResponse || '',
                        sourceText: payload.canonicalEvidenceText || payload.aiResponse || '',
                        sourceMessageId: options?.sourceMessageId || '',
                        turn: payload.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0
                    });
                }
            } catch (error) {
                if (MemoryEngine.CONFIG?.debug) recordRuntimeDebug('warn', '[LIBRA] Canonical packet entity adapter failed:', error?.message || error);
            }
            const packetEntity = packetObject(materializationPacket?.entity);
            const packetCharacters = packetArray(packetEntity.characters || packetEntity.entities || packetEntity.people)
                .map(item => {
                    const obj = packetObject(item);
                    const name = packetText(obj.name || obj.canonicalName || obj.displayName || obj.subject || '', 120);
                    if (!name) return null;
                    const visualCanon = obj.visualCanon || obj.visual_canon || obj.visualProfile || obj.visual_profile || null;
                    const currentState = obj.currentState || obj.current_state || {};
                    return {
                        ...obj,
                        name,
                        visualCanon: visualCanon || undefined,
                        currentState: currentState && typeof currentState === 'object' ? currentState : undefined,
                        quality: { ...(obj.quality || {}), sourceMix: ['structured_packet'], confidence: obj.quality?.confidence || 0.75 }
                    };
                })
                .filter(Boolean);
            return {
                spans: [],
                entities: packetCharacters,
                relations: [],
                world: {},
                conflicts: [],
                uncertain: [],
                rejected: [],
                sourceMode: 'structured_packet'
            };
        };

        const mergeUnifiedEntityExtractionWithPacketEvidence = (entityExtraction = null, packetExtraction = null) => {
            const base = entityExtraction && typeof entityExtraction === 'object' && !Array.isArray(entityExtraction)
                ? safeClone(entityExtraction)
                : {};
            const packet = packetExtraction && typeof packetExtraction === 'object' && !Array.isArray(packetExtraction)
                ? packetExtraction
                : null;
            if (!packet) return Object.keys(base).length ? base : null;
            const mergeByName = (left = [], right = []) => {
                const out = [];
                const seen = new Set();
                const push = (item) => {
                    if (!item || typeof item !== 'object') return;
                    const name = String(item.name || item.canonicalName || item.displayName || '').trim();
                    const key = name.toLowerCase();
                    if (!key || seen.has(key)) return;
                    seen.add(key);
                    out.push(item);
                };
                (Array.isArray(left) ? left : []).forEach(push);
                (Array.isArray(right) ? right : []).forEach(push);
                return out;
            };
            const mergeRelations = (left = [], right = []) => {
                const out = [];
                const seen = new Set();
                const push = (item) => {
                    if (!item || typeof item !== 'object') return;
                    const a = String(item.entityA || item.nameA || item.a || item.from || '').trim();
                    const b = String(item.entityB || item.nameB || item.b || item.to || '').trim();
                    if (!a || !b || a === b) return;
                    const key = [a, b].sort().join('::').toLowerCase();
                    if (!key || seen.has(key)) return;
                    seen.add(key);
                    out.push(item);
                };
                (Array.isArray(left) ? left : []).forEach(push);
                (Array.isArray(right) ? right : []).forEach(push);
                return out;
            };
            const mergeWorld = (left = {}, right = {}) => {
                if (!right || typeof right !== 'object' || Array.isArray(right)) return left && typeof left === 'object' ? left : {};
                if (!left || typeof left !== 'object' || Array.isArray(left)) return safeClone(right);
                return { ...safeClone(right), ...safeClone(left) };
            };
            base.entities = mergeByName(base.entities, packet.entities);
            base.relations = mergeRelations(base.relations, packet.relations);
            base.world = mergeWorld(base.world, packet.world);
            base.conflicts = [
                ...(Array.isArray(base.conflicts) ? base.conflicts : []),
                ...(Array.isArray(packet.conflicts) ? packet.conflicts : [])
            ];
            base.uncertain = [
                ...(Array.isArray(base.uncertain) ? base.uncertain : []),
                ...(Array.isArray(packet.uncertain) ? packet.uncertain : [])
            ];
            base.rejected = [
                ...(Array.isArray(base.rejected) ? base.rejected : []),
                ...(Array.isArray(packet.rejected) ? packet.rejected : [])
            ];
            base.packetEvidenceEntities = mergeByName(base.packetEvidenceEntities, packet.entities);
            base.sourceMode = base.sourceMode || packet.sourceMode || 'structured_packet';
            base.packetEvidenceMerged = true;
            return base;
        };
        const compactUnifiedEntityExtraction = (entityExtraction = null) => {
            if (!entityExtraction || typeof entityExtraction !== 'object' || Array.isArray(entityExtraction)) return entityExtraction;
            const compactTextList = (items = [], limit = 12, max = 180) => dedupeTextArray((Array.isArray(items) ? items : (items ? [items] : []))
                .map(item => packetText(item, max))
                .filter(Boolean)
            ).slice(0, Math.max(1, Number(limit || 12)));
            const compactEvidence = (items = [], limit = 8) => (Array.isArray(items) ? items : [])
                .map(item => {
                    if (!item || typeof item !== 'object' || Array.isArray(item)) return packetText(item, 220);
                    return {
                        ...item,
                        source: packetText(item.source || item.sourceKind || '', 80),
                        sourceKind: packetText(item.sourceKind || item.source || '', 80),
                        snippet: packetText(item.snippet || item.quote || item.text || item.summary || item.evidence || '', 240),
                        text: item.text ? packetText(item.text, 240) : undefined,
                        summary: item.summary ? packetText(item.summary, 220) : undefined
                    };
                })
                .filter(Boolean)
                .slice(-Math.max(1, Number(limit || 8)));
            const compactEntity = (entity = {}) => {
                if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return entity;
                const next = safeClone(entity);
                if (Array.isArray(next.evidence)) next.evidence = compactEvidence(next.evidence, 8);
                if (next.visualCanon && typeof next.visualCanon === 'object' && !Array.isArray(next.visualCanon)) {
                    next.visualCanon = {
                        ...next.visualCanon,
                        evidence: compactEvidence(next.visualCanon.evidence || next.visualCanon.sources || [], 8)
                    };
                }
                const visualState = next.currentState?.visualState || next.currentState?.visual_state || null;
                if (visualState && typeof visualState === 'object' && !Array.isArray(visualState)) {
                    const compactedVisualState = { ...visualState };
                    for (const key of Object.keys(compactedVisualState)) {
                        if (Array.isArray(compactedVisualState[key])) compactedVisualState[key] = compactTextList(compactedVisualState[key], 14, 90);
                        else if (typeof compactedVisualState[key] === 'string') compactedVisualState[key] = packetText(compactedVisualState[key], key === 'notes' ? 220 : 120);
                    }
                    next.currentState = { ...(next.currentState || {}), visualState: compactedVisualState };
                }
                return next;
            };
            const compactRelation = (relation = {}) => {
                if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return relation;
                const next = safeClone(relation);
                if (Array.isArray(next.evidence)) next.evidence = compactEvidence(next.evidence, 6);
                if (Array.isArray(next.eventLedger)) next.eventLedger = next.eventLedger.slice(-8);
                return next;
            };
            const next = safeClone(entityExtraction);
            next.entities = (Array.isArray(next.entities) ? next.entities : []).map(compactEntity).slice(0, 24);
            next.relations = (Array.isArray(next.relations) ? next.relations : []).map(compactRelation).slice(0, 24);
            next.conflicts = compactTextList(next.conflicts || [], 12, 220);
            next.uncertain = compactTextList(next.uncertain || [], 12, 220);
            next.rejected = compactTextList(next.rejected || [], 12, 220);
            next.packetEvidenceEntities = (Array.isArray(next.packetEvidenceEntities) ? next.packetEvidenceEntities : [])
                .map(compactEntity)
                .slice(0, 24);
            return next;
        };

        const prepareCommittedTrackerPrompt = (committed,batch,config,payload={}) => {
            const currentTurn=committed.turn,trackerBudget=contractOutputBudget('user_dlc_tracker','standard');
            const allowedEvidenceIds=new Set(batch.evidenceIds);
            const selectedSource={...committed,evidence:committed.evidence.filter(item=>allowedEvidenceIds.has(item.id) || ['world.time','world.clock'].includes(item.id)),events:(committed.events || []).filter(event=>event.evidenceRefs.length && event.evidenceRefs.every(id=>allowedEvidenceIds.has(id)))};
            payload={...payload,userDlcTrackerPrompt:batch.prompt};
            const system = [
                'You are LIBRA User DLC Adaptive Entity/Relation Tracker.',
                'Evaluate only the listed tracker IDs against the supplied committed canonical evidence records.',
                'A user-authored tracker instruction defines what to inspect; it does not create the tracked fact.',
                'Absence of mention, silence, genre convention, probability, and prior speculation are not evidence. Omit irrelevant trackers.',
                'Copy an allowed value exactly. Return packetId, packetRevision and evidenceRefs containing exact supplied evidence IDs; never invent a reference. Missing evidence means omit the update.',
                'The LIBRA Memory/Entity/Relation/World DB is authoritative. User DLC tracker definitions and old tracker values are not canonical evidence and must never override it.',
                'Set dbCompatibility=compatible only when the update agrees with the supplied LIBRA DB. Use explicit_transition only when the committed canonical packet directly depicts a state change or correction that explains the difference. Use conflicted and list dbConflicts when neither condition is met.',
                'Updates without an explicit compatible or explicit_transition verdict are rejected by the runtime.',
                'Sensitive body, reproductive, pregnancy, contraception, medical, consent, or intimate states must never be marked confirmed without an explicit in-scene statement, test result, observed outcome, or other direct committed canonical evidence.',
                'For scenario_response and relationship_model items, preserve the full scenario table and return only the presently applicable expected response in currentSnapshot. Base dialogue direction on the authoritative LIBRA entity speech style; do not repeat examples verbatim unless natural.',
                'Affection or attraction may influence tone and willingness but never substitutes for scene-specific consent. Coercion, refusal, resistance, freezing, placating, escape, and defense capability are separate axes.',
                'For capability items, distinguish willingness to resist from physical/magical ability to resist, escape, delay, call for help, or use terrain and equipment.',
                'For reproductive_health and health_risk items, never convert annual typical-use rates directly into a per-event rate, never call any day absolutely safe, and never invent a disease or infertility diagnosis absent canon or direct evidence.',
                'When ACTIVE USER DLC CONTRACEPTIVE WORLD TOOLS are supplied, treat their profiles as world-setting context only. A tool existing or being available is not evidence of acquisition, use, correct application, tolerance, failure, pregnancy prevention, or infection protection. Apply a profile only when the committed canonical packet directly identifies the tool and depicts the relevant use or failure detail.',
                'Never invent probability parameters, event totals or a random outcome. For a directly observed structured event requiring legacy event-lock handling, copy its canonicalOccurrenceRef and eventType exactly; a model-coined eventKey alone cannot establish an occurrence. Missing lineage stays pending.',
                'For sexual_history items, update counters only for a canonically adult target and only when the committed canonical packet directly depicts a newly completed event or explicitly establishes a historical fact. Plans, invitations, negotiation, consent alone, attempts, fantasies, dreams, hypothetical narration, and ambiguous euphemism do not count.',
                'For each supported sexual_history update, emit one stable eventKey and sexualHistoryDelta. Reuse the same eventKey whenever the same event is mentioned again. Runtime applies a new event delta once and ignores duplicate deltas.',
                'sexualHistoryDelta.sexCount counts completed partnered sexual encounters, once per encounter/scene rather than once per act. masturbationCount counts completed solo masturbation events. vaginalEjaculationCount, fellatioCount, and analSexCount count only the corresponding explicitly completed acts. pregnancyCount and birthCount require an explicitly confirmed pregnancy or completed birth, never mere risk.',
                'Supply partnerNames only for directly identified partners. Use newPartnerCount only for partners directly established as newly distinct from all previously counted partners; it also supports an explicitly distinct but unnamed partner. Supply firstSexPartner only when canon or direct dialogue explicitly establishes that person as the first partner; a newly observed partner is not automatically the first. The runtime combines newPartnerCount with known unique partner names to maintain distinctPartnerCount.',
                'virginityStatus is narrative first-partnered-sex history only, never an anatomical, hymen, examination, purity, or medical inference. Use no_confirmed_sex_experience only when the story explicitly establishes no prior partnered sex; silence is unknown. A completed partnered sex event establishes sexually_experienced.',
                'Do not send lifetime totals in currentSnapshot during turn updates. Put only new increments in sexualHistoryDelta. If an old lifetime baseline was unknown, the resulting count is a confirmed observed minimum, not proof of the lifetime total.',
                'Use the canonical story clock for cycle/health progression. If the date is missing or the cycle is irregular/unknown, widen uncertainty and say so instead of advancing by turn count.',
                'Return JSON only. No markdown or explanation.',
                `Required shape: {${getUserDlcTrackerResponseShape()}}`
            ].join('\n');
            const user = [
                `Turn: ${Number(currentTurn || payload.turn || 0) || 0}`,
                `[Committed canonical packet — sole update evidence]\n${JSON.stringify(selectedSource)}`,
                `[User DLC tracker definitions and current values — non-canonical]\n${payload.userDlcTrackerPrompt || ''}`,
                payload.entityTexts?.length ? `[Authoritative LIBRA Entity DB]\n${truncateForLLM(payload.entityTexts.join('\n\n'), 5000, ' ... ')}` : '',
                payload.relationTexts?.length ? `[Authoritative LIBRA Relation DB]\n${truncateForLLM(payload.relationTexts.join('\n\n'), 3500, ' ... ')}` : '',
                payload.worldPrompt ? `[Authoritative LIBRA World DB]\n${truncateForLLM(payload.worldPrompt, 3500, ' ... ')}` : '',
                payload.worldStatePrompt ? `[Authoritative current LIBRA World State]\n${truncateForLLM(payload.worldStatePrompt, 2500, ' ... ')}` : ''
            ].filter(Boolean).join('\n\n');
            const preflight = AnalysisBudgetPreflight?.preparePrompt?.({
                domain: 'turnMaintenanceBundle',
                system,
                user,
                config,
                maxTokens: trackerBudget
            }) || { system, user, maxTokens: trackerBudget, mode: 'full', reason: 'unavailable' };
            return {system,user,preflight,trackerBudget};
        };
        const buildCommittedExtensionBatches = (source,config=MemoryEngine.CONFIG) => UserDlcCore.buildCommittedTrackerBatch(source,5200,{
            fits:batch=>{const {user,preflight}=prepareCommittedTrackerPrompt(source,batch,config);return (preflight.user ?? user)===user;}
        });
        const runUserDlcTrackerUpdates = async (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG, preparedPayload = null) => {
            // tracker 는 자기 계약표에서 값을 얻는다. standard = 1800 으로 이전 하드코딩 값을 그대로 보존한다.
            // (정의를 runUserDlcAnalysis 안에 넣었다가 여기서 ReferenceError 가 났다 — 같은 IIFE 라도
            //  함수 스코프가 다르다. 게이트가 아니라 전체 회귀가 이걸 잡았다.)
            const trackerBudget = contractOutputBudget('user_dlc_tracker', 'standard');
            const committed = IntegratedAnalysisJournal.readCommittedSource(preparedPayload?.committedSourceToken);
            if (!committed || committed.turn !== Number(currentTurn) || config?.useLLM === false) return [];
            const payload = preparedPayload;
            const batch = payload?.committedTrackerBatch;
            if (!batch || batch.status !== 'ready' || !batch.trackerIds.length) return [];
            if (payload?.userDlcTrackersActive !== true || !String(payload.userDlcTrackerPrompt || '').trim()) return [];
            const resolvedProfile = resolveAnalysisProfile(config, 'userDlcTrackerAnalysis', 'primary');
            if (!LLMProvider.isConfigured(config, resolvedProfile)) {
                if (config?.debug) recordRuntimeDebug('warn', '[LIBRA] User DLC tracker profile is not configured; tracker update skipped:', resolvedProfile);
                if (payload.requireCompleteExtensionResult) throw Error('tracker_profile_unconfigured');
                return [];
            }
            const {system,user,preflight}=prepareCommittedTrackerPrompt(committed,batch,config,payload);
            // This batch uses whole definitions and evidence; preflight may lower output, never cut input.
            if ((preflight.user || user) !== user) throw new Error('tracker_batch_requires_compaction');
            AnalysisBudgetPreflight?.debugPreflight?.(config, 'user-dlc-tracker-analysis', preflight);
            try {
                const result = await runMaintenanceLLM(() => (IntegratedAnalysisJournal.noteExtensionAttempt(payload.committedSourceToken), LLMProvider.call(config, preflight.system || system, preflight.user || user, {
                    maxTokens: Number(preflight.maxTokens || trackerBudget) || trackerBudget,
                    profile: resolvedProfile,
                    label: `user-dlc-tracker-${resolvedProfile}`,
                    domain: 'turn_maintenance',
                    reason: 'user-dlc-tracker-analysis',
                    attemptObserver: payload.attemptObserver,
                    analysisPreflight: {
                        mode: preflight.mode,
                        reason: preflight.reason,
                        estimatedTokens: preflight.estimatedTokens,
                        preparedEstimatedTokens: preflight.preparedEstimatedTokens
                    }
                })), `user-dlc-tracker-${currentTurn}`);
                let parsed = parseTurnMaintenanceJson(result?.content || '', false);
                if (!parsed && payload.requireCompleteExtensionResult) {
                    const empty = parseLooseJson(Utils.stripLLMThinkingTags(String(result?.content || '')));
                    if (empty && !Array.isArray(empty) && (Array.isArray(empty.userDlcTrackerUpdates) || Array.isArray(empty.user_dlc_tracker_updates))) parsed = empty;
                }
                if (!parsed) {
                    if (config?.debug) recordRuntimeDebug('warn', '[LIBRA] User DLC tracker analysis returned invalid JSON; updates skipped.');
                    if (payload.requireCompleteExtensionResult) throw Error('tracker_result_invalid');
                    return [];
                }
                const updates = UserDlcCore.normalizeTrackerUpdates?.(parsed.userDlcTrackerUpdates || parsed.user_dlc_tracker_updates || []) || [];
                return updates.filter(update => batch.trackerIds.includes(update.trackerId)
                    && update.committedEvidenceRefs.length > 0
                    && update.committedEvidenceRefs.every(id => (batch.evidenceByTracker[update.trackerId] || []).includes(id)));
            } catch (error) {
                recordRuntimeDebug('warn', '[LIBRA] User DLC tracker analysis isolated; other maintenance will continue:', error?.message || error);
                if (payload.requireCompleteExtensionResult) throw error;
                return [];
            }
        };

        const runWorldAdditionalTurnUpdates = async (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG, preparedPayload = null) => {
            const enabled = UserDlcCore.isAutomaticGenerationEnabled();
            if (!enabled) return null;
            const committed = IntegratedAnalysisJournal.readCommittedSource(preparedPayload?.committedSourceToken);
            if (!committed || committed.turn !== Number(currentTurn) || config?.useLLM === false) return null;
            const payload = preparedPayload;
            const profile = resolveAnalysisProfile(config, 'worldAdditionalTurnAnalysis', 'aux');
            if (!LLMProvider.isConfigured(config, profile)) {
                if (payload.requireCompleteExtensionResult) throw Error('world_additional_profile_unconfigured');
                return null;
            }
            const responseShape = `{${getWorldAdditionalResponseShape()}}`;
            const system = [
                'You are LIBRA World Additional Turn Worker.',
                'Analyze only the independent non-canonical World Additional layer for the current completed turn.',
                'Do not repeat canonical packet extraction, long-term memory, correction, Story Author, Director, narrative briefing, entity extraction, or User DLC tracking.',
                'First report manifestations only when the supplied committed canonical evidence directly shows them. Missing evidence is unavailable, never an absent event.',
                'Then create or revise only grounded sceneInterventions, worldDeltas, or characterAdditions that fit the current world, place, unresolved thread, and progression tier.',
                'Prefer an established LIBRA entity over inventing a new actor. A new actor must be genuinely unintroduced and locally justified.',
                'Never force the user character\'s action, consent, private emotion, bodily reaction, hidden past, or final choice.',
                'User-authored World Additional custom input has priority inside this separate layer, but it must be adapted to canonical world rules instead of mutating canonical DB.',
                'Return JSON only. No markdown, commentary, long-term memory, planner data, or canonicalPacket.',
                UserDlcCore.getState().settings.autoGenerationEnabled === true ? 'Optional worldAdditional.extensionProposal: one bundleVersion=1 with worldItems (intent=world_candidate only), adaptiveItems (intent=tracking, exact registered entity ID, kind=state|scenario_response|relationship_model|capability), unresolved:[], and evidenceRefs containing exact committed evidence IDs. Create only when this evidence establishes a persistent need. Never create author rules or sensitive packages automatically. All definitions use the direct bundle fields requestItemId, dependsOn, kind, title/adaptedConcept or targetType/entity targetIds/label/instruction/valueType/currentValue. Unknown values stay unknown. Do not repeat existing definitions or rejected signals. No code or calculator parameters.' : '',
                `Required shape: ${responseShape}`
            ].join('\n');
            const capped = (value = '', limit = 4000) => truncateForLLM(String(value || '').trim(), limit, '\n...[TRUNCATED]...\n');
            const user = [
                `Turn: ${payload.turn}`,
                `[Committed canonical packet]\n${JSON.stringify({...committed,evidence:committed.evidence.filter(item=>!item.visibility || item.visibility.mode==='public'),events:(committed.events || []).filter(event=>event.visibility?.mode==='public')})}`,
                payload.worldPrompt ? `[Canonical World]\n${capped(payload.worldPrompt, 4200)}` : '',
                payload.worldStatePrompt ? `[Current World State]\n${capped(payload.worldStatePrompt, 3000)}` : '',
                payload.narrativePrompt ? `[Current Narrative]\n${capped(payload.narrativePrompt, 2600)}` : '',
                payload.automaticPackageContext ? `[Existing extension definitions and target IDs]\n${payload.automaticPackageContext}` : '',
                payload.currentWorldAdditionalPrompt ? `[Existing World Additional DB]\n${capped(payload.currentWorldAdditionalPrompt, 3600)}` : '',
                payload.worldAdditionalCustomActive && payload.worldAdditionalCustomText ? `[User-authored World Additional Input]\n${capped(payload.worldAdditionalCustomText, 3200)}` : '',
                payload.entityTexts?.length ? `[Known LIBRA Entities]\n${capped(payload.entityTexts.join('\n\n'), 3600)}` : '',
                payload.relationTexts?.length ? `[Known Relations]\n${capped(payload.relationTexts.join('\n\n'), 2200)}` : '',
                payload.recentTurns?.length ? `[Recent Turns]\n${capped(payload.recentTurns.join('\n'), 2200)}` : ''
            ].filter(Boolean).join('\n\n');
            const execution = resolveTurnAnalysisOutputBudget(payload, 'world_additional');
            const preflight = AnalysisBudgetPreflight?.preparePrompt?.({
                domain: 'turnMaintenanceBundle',
                system,
                user,
                config,
                maxTokens: execution.maxTokens
            }) || { system, user, maxTokens: execution.maxTokens, mode: 'full', reason: 'unavailable' };
            AnalysisBudgetPreflight?.debugPreflight?.(config, 'world-additional-turn-analysis', preflight);
            try {
                const result = await runMaintenanceLLM(() => (IntegratedAnalysisJournal.noteExtensionAttempt(payload.committedSourceToken), LLMProvider.call(config, preflight.system || system, preflight.user || user, {
                    maxTokens: Number(preflight.maxTokens || execution.maxTokens) || execution.maxTokens,
                    profile,
                    label: `world-additional-turn-${profile}`,
                    domain: 'turn_maintenance',
                    reason: 'world-additional-turn-analysis',
                    attemptObserver: payload.attemptObserver,
                    disableReasoning: execution.disableReasoning,
                    analysisComplexity: { tier: execution.tier, score: execution.score },
                    analysisPreflight: {
                        mode: preflight.mode,
                        reason: preflight.reason,
                        estimatedTokens: preflight.estimatedTokens,
                        preparedEstimatedTokens: preflight.preparedEstimatedTokens
                    }
                })), `world-additional-turn-${currentTurn}`);
                const cleaned = Utils.stripLLMThinkingTags(String(result?.content || ''));
                const parsed = parseLooseJson(cleaned) || extractStructuredJson(cleaned);
                const rawPayload = parsed?.worldAdditional || parsed?.world_additional || parsed?.maintenance?.worldAdditional || parsed?.maintenance?.world_additional || null;
                const normalized = WorldAdditionalCore.normalizeMaintenancePayload?.(rawPayload) || null;
                if (!normalized) throw new Error('world_additional_turn_invalid_json');
                if (rawPayload?.extensionProposal && UserDlcCore.getState().settings.autoGenerationEnabled === true) normalized.extensionProposal = safeClone(rawPayload.extensionProposal);
                return normalized;
            } catch (error) {
                recordRuntimeDebug('warn', '[LIBRA] World Additional turn analysis isolated; canonical maintenance will continue:', error?.message || error);
                if (payload.requireCompleteExtensionResult) throw error;
                return null;
            }
        };

        const run = async (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG, options = {}) => {
            const profile = (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux'))
                ? resolveAnalysisProfile(config, 'turnMaintenanceBundle', 'primary')
                : null;
            const payload = options?.preparedPayload && typeof options.preparedPayload === 'object'
                ? options.preparedPayload
                : buildPayload(currentTurn, turnState, aiResponse, effectiveLore, config);
            const heuristic = buildHeuristicBundle(payload, config);
            const trackerTask = Promise.resolve([]); // Extensions run once, after the verified canonical save.
            if (!profile) return { ...heuristic, userDlcTrackerUpdates: await trackerTask };

            try {
                const includeRpLongTermLlm = config?.rpLongTermMemoryEnabled !== false && config?.rpLongTermLlmEnrichment !== false;
                const includeWorldAdditional = false; // Post-commit extension worker owns this axis.
                const includeUserDlcTrackers = false; // Dedicated route/profile handled by runUserDlcTrackerUpdates.
                const includePlanner = payload?.plannerOrchestrationActive === true;
                const includeStoryAuthor = includePlanner; // Director handoff also needs an author intent plan.
                const includeDirector = payload?.directorActive === true;
                const wmResultContext = payload.wmResultContext || { lorebook: effectiveLore, scopeKey: UserDlcCore.getState().scopeKey, focusNames: payload.focusedEntities || [] };
                const wmResultSnapshot = payload.wmResultSnapshot || WmResultProjection.capture(wmResultContext);
                const wmResultPrompt = includePlanner ? WmResultProjection.format(wmResultSnapshot, { audience: includeDirector ? 'director' : 'writer' }, 5200) : '';
                const resultGuard = () => { if (wmResultPrompt) WmResultProjection.assertCurrent(wmResultSnapshot, wmResultContext); };
                const responseShape = getMaintenanceResponseShape(includeRpLongTermLlm, includeWorldAdditional, includeStoryAuthor, includeDirector, includeUserDlcTrackers);
                const system = [
                    'You are LIBRA Turn Maintenance Optimizer.',
                    'Combine turn correction and narrative briefing in one pass.',
                    includePlanner
                        ? (includeRpLongTermLlm
                            ? 'Also produce V4.2-style Story Author planning, Director execution guidance when enabled, and durable RP long-term memory for the next response.'
                            : 'Also produce V4.2-style Story Author planning and Director execution guidance when enabled for the next response.')
                        : (includeRpLongTermLlm ? 'Also produce durable RP long-term memory for the next response.' : ''),
                    includePlanner ? 'The current user input and explicit user correction outrank memory summaries, world pressure, Story Author, and Director.' : '',
                    includePlanner ? 'Story Author owns narrative meaning, scene phase, unresolved tensions, payoff timing, and next-beat intent. It must not write direct staging orders, dialogue orders, mandatory user actions, consent, feelings, or fixed outcomes.' : '',
                    includeDirector ? 'Director owns execution only: staging, pacing, emphasis, forbidden moves, continuity locks, and visible response constraints. It must convert the Story Author plan into execution and must not independently create a new narrative goal.' : '',
                    includeDirector ? 'Director.authorPlanInputs must explicitly reflect Story Author narrativeGoal, primaryTension, recommendedBeatType, nextBeats, and doNotResolveYet when present.' : '',
                    includePlanner ? 'Do not resolve anything listed in Story Author.doNotResolveYet. Preserve it as an open thread unless the current user explicitly resolves or redirects it.' : '',
                    includePlanner ? 'Past dialogue in memory is evidence for voice, relationship, emotion, and events—not a script to copy. Adapt it to current facts and never replay established events as first-time events.' : '',
                    includePlanner ? 'Use Planner Refresh Modes exactly: full rebuilds the plan, light updates the nearest beat while preserving valid intent, reuse leaves the existing planner state unchanged.' : '',
                    'Do not invent canon. Only fix clear extraction mistakes and keep guidance compact, natural, and actionable.',
                    payload.evidencePolicy,
                    'Host Prompt Validation Context is read-only corroboration. Never create or update canon solely from it. A fact must independently appear in the current assistant evidence; use host context only to validate identity, reject contradictions, or normalize names.',
                    payload.userDlcTrackerPrompt ? 'User DLC definitions, analyses, and tracker values belong to a separate non-canonical DB. They are never evidence for canonical memory/entity/relation/world updates. Existing LIBRA DB wins on conflict unless the current assistant evidence explicitly depicts a valid transition or correction.' : '',
                    payload.worldCanonCustomActive ? 'A LIBRA Canon DB Reflection Directive is stable user-authored design input for canonical storage only. Do not reinterpret it as a World Additional scene directive.' : '',
                    payload.worldAdditionalCustomActive ? 'A World Additional Custom Directive belongs only to maintenance.worldAdditional sceneInterventions, worldDeltas, or characterAdditions. Do not promote it directly into canon.' : '',
                    includeUserDlcTrackers ? 'For userDlcTrackerUpdates, evaluate only the listed tracker IDs against direct evidence in the current assistant response. A user-authored tracker instruction defines what to inspect; it does not create the tracked fact.' : '',
                    includeUserDlcTrackers ? 'Tracker evidence gate: absence of mention, silence, genre convention, probability, or prior speculation is not evidence. Omit irrelevant updates. Copy an allowed value exactly and include a concise direct evidence paraphrase.' : '',
                    includeUserDlcTrackers ? 'Sensitive body, reproductive, pregnancy, contraception, medical, consent, or intimate states must never be marked confirmed without an explicit in-scene statement, test result, observed outcome, or otherwise direct current-response evidence. Use possible/uncertain only when the listed values permit it.' : '',
                    includeRpLongTermLlm ? `For longTermMemory, record only facts directly supported by ${payload.evidenceLabel}. Omit transient prose, uncertain guesses, generic mood, and duplicates.` : '',
                    includeRpLongTermLlm ? 'Treat stable identity/family/occupation facts, explicit preferences or boundaries, promises, unresolved goals, irreversible state changes, relationship milestones, and callback objects as durable.' : '',
                    includeRpLongTermLlm ? 'Use visibility=secret or visibility=pov for undisclosed information; never convert hidden knowledge into public canon.' : '',
                    includeRpLongTermLlm
                        ? 'If correction is unnecessary, return null for correction. Empty long-term categories must be arrays.'
                        : 'If correction is unnecessary, return null for correction.',
                    'Respond only as JSON with this shape:',
                    responseShape,
                    'Top-level keys must match this shape directly. Never wrap the result in data/result/output/message/status/done. A JSON object with only status/done/message is invalid.'
                ].filter(Boolean).join('\n');
                const user = [
                    `Turn: ${payload.turn}`,
                    payload.evidenceText ? `[${payload.evidenceLabel}]\n${payload.evidenceText}` : `[${payload.evidenceLabel}]\n(empty)`,
                    `[Current Extracted State]\n${JSON.stringify(payload.extracted, null, 2)}`,
                    payload.plannerRefreshModes ? `[Planner Refresh Modes]\n${JSON.stringify({ ...payload.plannerRefreshModes, reasons: payload.plannerRefreshReasons || [] }, null, 2)}` : '',
                    payload.sceneContract ? `[Scene Contract]\n${JSON.stringify(payload.sceneContract, null, 2)}` : '',
                    payload.narrativeDiagnostics ? `[Narrative Diagnostics]\n${JSON.stringify(payload.narrativeDiagnostics, null, 2)}` : '',
                    payload.authorPlanInputs?.length ? `[Existing Story Author Handoff Inputs]\n- ${payload.authorPlanInputs.join('\n- ')}` : '',
                    payload.worldPrompt ? `World:\n${payload.worldPrompt}` : '',
                    payload.worldStatePrompt ? `World State:\n${payload.worldStatePrompt}` : '',
                    payload.narrativePrompt ? `Narrative:\n${payload.narrativePrompt}` : '',
                    payload.currentStoryAuthorPrompt ? `Existing Story Author:\n${payload.currentStoryAuthorPrompt}` : '',
                    payload.currentDirectorPrompt ? `Existing Director:\n${payload.currentDirectorPrompt}` : '',
                    wmResultPrompt,
                    payload.worldCanonCustomActive && payload.worldCanonCustomText ? `LIBRA Canon DB Reflection Directive / User-authored stable canon input:\n${payload.worldCanonCustomText}` : '',
                    payload.worldAdditionalCustomActive && payload.worldAdditionalCustomText ? `World Additional Custom Directive / User-authored active addition input:\n${payload.worldAdditionalCustomText}` : '',
                    payload.entityTexts.length ? `Entities:\n${payload.entityTexts.join('\n\n')}` : '',
                    payload.relationTexts.length ? `Relations:\n${payload.relationTexts.join('\n\n')}` : '',
                    payload.charStateTexts.length ? `Character States:\n${payload.charStateTexts.join('\n\n')}` : '',
                    payload.recentTurns.length ? `Recent Turns:\n${payload.recentTurns.join('\n')}` : '',
                    payload.memoryEntries.length ? `Important Memories:\n- ${payload.memoryEntries.join('\n- ')}` : '',
                    payload.hostPromptEvidenceText ? `Host Prompt Validation Context:\n${payload.hostPromptEvidenceText}` : ''
                ].filter(Boolean).join('\n\n');
                // RP 장기기억 강화가 켜지면 critical tier 를 쓴다. 값은 번들 **자기 계약표**에서 나온다
                // (canonical_packet 표를 빌려 쓰면 도메인 천장에 잘린다 — 게이트가 그 실수를 잡았다).
                const bundleBudget = contractOutputBudget('turn_maintenance_bundle', includeRpLongTermLlm ? 'critical' : 'complex');
                const maintenancePreflight = AnalysisBudgetPreflight?.preparePrompt?.({
                    domain: 'turnMaintenanceBundle',
                    system,
                    user,
                    config,
                    maxTokens: bundleBudget
                }) || {
                    mode: 'full',
                    reason: 'unavailable',
                    system,
                    user,
                    maxTokens: bundleBudget,
                    originalUserChars: user.length,
                    preparedUserChars: user.length
                };
                const activeMaintenanceUser = maintenancePreflight.user || user;
                const activeMaintenanceMaxTokens = Number(maintenancePreflight.maxTokens || bundleBudget) || bundleBudget;
                AnalysisBudgetPreflight?.debugPreflight?.(config, 'turn-maintenance-bundle', maintenancePreflight);
                const result = await runMaintenanceLLM(() => {
                    resultGuard();
                    return LLMProvider.call(config, system, activeMaintenanceUser, {
                        resultProjectionGuard: resultGuard,
                        attemptObserver: async phase => { if (phase === 'reserve') resultGuard(); },
                        maxTokens: activeMaintenanceMaxTokens,
                        profile,
                        label: `turn-maintenance-bundle-${profile}`,
                        domain: 'turn_maintenance',
                        reason: 'turn-maintenance-bundle',
                        analysisPreflight: {
                            mode: maintenancePreflight.mode,
                            reason: maintenancePreflight.reason,
                            estimatedTokens: maintenancePreflight.estimatedTokens,
                            preparedEstimatedTokens: maintenancePreflight.preparedEstimatedTokens
                        }
                    });
                }, `turn-maintenance-bundle-${currentTurn}`);
                resultGuard();
                const parsed = parseTurnMaintenanceJson(result?.content || '', includeRpLongTermLlm);
                if (!parsed) {
                    recordRuntimeDebug('warn', '[LIBRA] Turn maintenance bundle returned invalid JSON shape; using heuristic fallback.', {
                        __libraDebugMeta: true,
                        label: 'turn-maintenance-invalid-json',
                        preview: truncateForLLM(result?.content || '', 260, ' ... ')
                    });
                    return { ...heuristic, userDlcTrackerUpdates: await trackerTask };
                }
                const normalized = normalizeMaintenanceBundleResult(parsed, heuristic, payload, config);
                normalized.worldAdditional = null;
                normalized.userDlcTrackerUpdates = await trackerTask;
                return normalized;
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Turn maintenance bundle failed:', e?.message || e);
                return { ...heuristic, userDlcTrackerUpdates: await trackerTask };
            }
        };

        const runUnifiedParallel = async (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG, options = {}) => {
            const profile = (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux'))
                ? resolveAnalysisProfile(config, 'turnCanonicalPacket', 'aux')
                : null;
            if (!profile) return null;
            const payload = buildPayload(currentTurn, turnState, aiResponse, effectiveLore, config);
            const shared = options?.__analysisShared && typeof options.__analysisShared === 'object' ? options.__analysisShared : null;
            const heuristic = buildHeuristicBundle(payload, config);
            const memoryHintBlock = String(options?.entityMemoryHintBlock || '').trim();
            const characterEntityHintBlock = String(options?.characterEntityHintBlock || '').trim();
            const entityStoredInfo = String(options?.entityStoredInfo || '').trim() || 'none';
            const canonicalPacketShape = CanonicalPacketContract.promptShape;
            const capped = (value = '', limit = 6000) => truncateForLLM(String(value || '').trim(), limit, '\n...[TRUNCATED]...\n');
            const system = [
                'You are LIBRA AfterRequest Canonical Packet Worker.',
                'This is the authoritative fact-writing worker. Produce canonicalPacket only; LIBRA derives compatibility entity and maintenance views in code.',
                'Return one JSON object with the single top-level key canonicalPacket.',
                'Never wrap the object in data/result/output/message/status/done. A status-only object is invalid and will be discarded.',
                payload.evidencePolicy,
                'Host Prompt Validation Context is read-only corroboration. Never create or update canon solely from it. A fact must independently appear in the current assistant evidence; use host context only to validate identity, reject contradictions, or normalize names.',
                'canonicalPacket: summarize the current turn once across memory, entity, world, narrative, and guards. Keep current-turn evidence chronological and do not collapse memory into prose-only canon.',
                'Axis ownership rule: memory.events/facts are chronological recall records; entity owns characters, relations, POV/private knowledge, secrets, and current states; world owns persistent setting fields, places/facilities, organizations, social rules, systems, physics, phenomena, and current world state; put current time/location/scene under world.state, not persistent world rules; narrative owns scene phase, conflict traces, scene deltas, motifs, and unresolved threads; guards owns continuity locks, audit cautions, and overpromotion risks.',
                'Record each fact in the most specific axis. Do not duplicate the same fact across axes except for a short memory event anchor.',
                'Mutation rule: operation=add creates a new durable record, update changes an identified record, resolve closes an open thread, and no_change explicitly preserves it. Never use an empty array to imply deletion.',
                'Evidence rule: every added/updated/resolved entity, relation, memory fact/event, or open thread requires evidenceRefs. Use concise paraphrased snippets and the supplied turn/message identifiers; do not copy long dialogue.',
                `Perform span-grounded NER-style analysis for ${payload.evidenceLabel}. Extract only directly supported person/character entities, relations, and world changes into canonicalPacket. Do not invent names or canon.`,
                'Visual profile rule: when a LIBRA Canon DB Reflection Directive or explicit current-scene evidence defines stable appearance, include entity.visualCanon as natural-language appearanceText only. Host prompt context may validate an appearance already manifested in the current response, but cannot promote one by itself. Do not create tokenized prompt lists.',
                'LIBRA Canon DB Reflection Directive, when present and active, is direct user-authored stable design input. Reflect it into canonicalPacket world/entity/narrative/visualCanon fields as user-authored design evidence while preserving canon-fit.',
                'If a LIBRA Canon DB Reflection Directive specifies a character appearance, adapt it into the matching entity.visualCanon.appearanceText in natural language. Ignore image prompt tags as canonical storage unless they are restated as ordinary appearance facts.',
                'Do not expose hidden/pov information as public canon. If evidence is weak, leave arrays empty or lower confidence instead of promoting a fact.',
                'Return JSON only. No markdown.',
                'Optional structured memory.events: preserve a stable canonical id for the same occurrence; set eventType, exact registered targetIds, role, factStatus, scalar fields, exact ruleRefs and visibility only when grounded by evidenceRefs. Use state_observed for explicit scalar state fields, counter_delta_observed for exact numeric changes and item_use_observed for actual tool use. Use direct only for an observed completed fact; plans, reported claims, negation and hypotheses remain distinct. item_use_observed requires explicit actual use, itemRef and used=true. Do not invent quantities, probabilities, missing IDs or times. world.state.storyClock may be {calendarId,day,current:true,evidenceRefs} only for an explicitly established current story-calendar day; never use PC time, turn count or a flashback as current time.',
                `canonicalPacket shape: ${canonicalPacketShape}`
            ].join('\n');
            const user = [
                `Turn: ${payload.turn}`,
                `Source Message ID: ${String(options?.sourceMessageId || options?.messageId || '(unavailable)').trim() || '(unavailable)'}`,
                payload.evidenceText ? `[${payload.evidenceLabel}]\n${payload.evidenceText}` : `[${payload.evidenceLabel}]\n(empty)`,
                `[Known LIBRA Entity State]\n${capped(entityStoredInfo, 6500)}`,
                characterEntityHintBlock ? `[LIBRA Long-Term Entity Cues]\n${capped(characterEntityHintBlock, 5200)}` : '',
                payload.hostPromptEvidenceText ? `[Host Prompt Validation Context]\n${capped(payload.hostPromptEvidenceText, 5000)}` : '',
                memoryHintBlock ? `[Long-Term Memory Cues]\n${capped(memoryHintBlock, 4800)}` : '',
                payload.worldPrompt ? `[World]\n${capped(payload.worldPrompt, 3600)}` : '',
                payload.worldStatePrompt ? `[World State]\n${capped(payload.worldStatePrompt, 2600)}` : '',
                payload.narrativePrompt ? `[Narrative]\n${capped(payload.narrativePrompt, 2600)}` : '',
                payload.worldCanonCustomActive && payload.worldCanonCustomText ? `[LIBRA Canon DB Reflection Directive / User-authored stable canon input]\n${capped(payload.worldCanonCustomText, 3600)}` : '',
                payload.entityTexts.length ? `[Existing Focus Entities]\n${capped(payload.entityTexts.join('\n\n'), 5200)}` : '',
                payload.relationTexts.length ? `[Existing Relations]\n${capped(payload.relationTexts.join('\n\n'), 2600)}` : '',
                payload.charStateTexts.length ? `[Character States]\n${capped(payload.charStateTexts.join('\n\n'), 2600)}` : '',
                payload.recentTurns.length ? `[Recent Turns]\n${capped(payload.recentTurns.join('\n'), 2400)}` : '',
                payload.memoryEntries.length ? `[Important Memories]\n- ${capped(payload.memoryEntries.join('\n- '), 2800)}` : ''
            ].filter(Boolean).join('\n\n');
            const packetExecution = resolveTurnAnalysisOutputBudget(payload, 'canonical_packet', options);
            const packetPreflight = AnalysisBudgetPreflight?.preparePrompt?.({
                domain: 'afterrequestCanonicalPacket',
                system,
                user,
                config,
                maxTokens: packetExecution.maxTokens
            }) || {
                mode: 'full',
                reason: 'unavailable',
                system,
                user,
                maxTokens: packetExecution.maxTokens,
                originalUserChars: user.length,
                preparedUserChars: user.length
            };
            const activePacketUser = packetPreflight.user || user;
            const activePacketMaxTokens = Number(packetPreflight.maxTokens || packetExecution.maxTokens) || packetExecution.maxTokens;
            AnalysisBudgetPreflight?.debugPreflight?.(config, 'afterrequest-canonical-packet', packetPreflight);

            if (config?.debug) {
                recordRuntimeDebug('log', '[LIBRA] Parallel afterRequest analysis started:', {
                    turn: currentTurn,
                    packetProfile: profile,
                    maintenanceProfile: resolveAnalysisProfile(config, 'turnMaintenanceBundle', 'primary'),
                    userDlcTrackerProfile: payload?.userDlcTrackersActive === true ? resolveAnalysisProfile(config, 'userDlcTrackerAnalysis', 'primary') : '',
                    systemChars: system.length,
                    userChars: activePacketUser.length,
                    rawUserChars: user.length,
                    preflightMode: packetPreflight.mode
                });
            }

            const packetTask = runMaintenanceLLM(() =>
                LLMProvider.call(config, system, activePacketUser, {
                    maxTokens: activePacketMaxTokens,
                    profile,
                    label: `afterrequest-canonical-packet-${profile}`,
                    domain: 'turn_maintenance',
                    reason: 'afterrequest-parallel-canonical-packet',
                     analysisPreflight: {
                        mode: packetPreflight.mode,
                        reason: packetPreflight.reason,
                        estimatedTokens: packetPreflight.estimatedTokens,
                         preparedEstimatedTokens: packetPreflight.preparedEstimatedTokens
                     },
                     disableReasoning: packetExecution.disableReasoning,
                     analysisComplexity: { tier: packetExecution.tier, score: packetExecution.score }
                 }),
            `afterrequest-packet-${currentTurn}`);
            let packetSettled;
            try { packetSettled = { status: 'fulfilled', value: await packetTask }; }
            catch (reason) { packetSettled = { status: 'rejected', reason }; }
            let parsed = null;
            if (packetSettled.status === 'fulfilled') {
                parsed = parseUnifiedAfterRequestJson(packetSettled.value?.content || '');
            } else if (config?.debug) {
                recordRuntimeDebug('warn', '[LIBRA] Parallel afterRequest packet worker failed:', packetSettled.reason?.message || packetSettled.reason);
            }
            if (!parsed) {
                if (config?.debug) {
                    recordRuntimeDebug('warn', '[LIBRA] Parallel afterRequest packet worker returned invalid JSON; falling back to unified analysis.', {
                        __libraDebugMeta: true,
                        label: 'parallel-afterrequest-invalid-packet',
                        preview: packetSettled.status === 'fulfilled' ? truncateForLLM(packetSettled.value?.content || '', 260, ' ... ') : ''
                    });
                }
                return null;
            }

            const canonicalPacket = attachCanonicalPacketEvidenceContext(extractUnifiedCanonicalPacket(parsed), payload, options);
            let entityExtraction = extractUnifiedEntityPayload(parsed);
            let entitySourceMode = 'afterrequest_parallel_packet';
            if (canonicalPacket) {
                const packetEntityExtraction = deriveEntityExtractionFromCanonicalPacket(canonicalPacket, payload, {
                    lorebook: effectiveLore,
                    sourceMessageId: options?.sourceMessageId || options?.messageId || ''
                });
                if (!entityExtraction) {
                    entityExtraction = packetEntityExtraction;
                    entitySourceMode = 'structured_packet';
                } else {
                    entityExtraction = mergeUnifiedEntityExtractionWithPacketEvidence(entityExtraction, packetEntityExtraction);
                    entityExtraction.sourceMode = entityExtraction.sourceMode || 'structured_packet';
                    entitySourceMode = entityExtraction.sourceMode || 'structured_packet';
                }
            }

            const maintenanceBase = {};
            const maintenancePayload = mergeCanonicalPacketIntoMaintenancePayload(
                maintenanceBase,
                canonicalPacket,
                heuristic,
                payload,
                config
            ) || maintenanceBase || heuristic;
            if (!entityExtraction) {
                entityExtraction = {
                    spans: [],
                    entities: [],
                    relations: [],
                    world: {},
                    conflicts: [],
                    uncertain: [],
                    rejected: [],
                    sourceMode: entitySourceMode
                };
            }
            entityExtraction = compactUnifiedEntityExtraction(entityExtraction);
            const unifiedEntityNames = dedupeTextArray([
                ...(Array.isArray(payload.focusedEntities) ? payload.focusedEntities : []),
                ...(Array.isArray(entityExtraction.entities) ? entityExtraction.entities.map(entity => entity?.name).filter(Boolean) : [])
            ]).slice(0, 12);
            const unifiedPayload = { ...payload, focusedEntities: unifiedEntityNames };
            const normalizedMaintenance = normalizeMaintenanceBundleResult(maintenancePayload, heuristic, unifiedPayload, config);
            normalizedMaintenance.worldAdditional = null;
            normalizedMaintenance.userDlcTrackerUpdates = [];
            if (canonicalPacket && !normalizedMaintenance.canonicalPacket) {
                normalizedMaintenance.canonicalPacket = safeClone(canonicalPacket);
            }
            if (config?.debug) {
                recordRuntimeDebug('log', '[LIBRA] Parallel afterRequest analysis accepted:', {
                    turn: currentTurn,
                    profile,
                    hasCanonicalPacket: !!canonicalPacket,
                    entityCount: Array.isArray(entityExtraction.entities) ? entityExtraction.entities.length : 0,
                    extensionsPendingCommit: true
                });
            }
            return {
                entityExtraction,
                maintenance: normalizedMaintenance,
                canonicalPacket,
                entitySourceMode,
                profile,
                label: `afterrequest-parallel-${profile}`,
                parallel: false,
                extensionsPendingCommit: true
            };
        };

        const runUnifiedSerial = async (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG, options = {}) => {
            const profile = (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux'))
                ? resolveAnalysisProfile(config, 'turnMaintenanceBundle', 'primary')
                : null;
            if (!profile) return null;
            const payload = buildPayload(currentTurn, turnState, aiResponse, effectiveLore, config);
            const shared = options?.__analysisShared && typeof options.__analysisShared === 'object' ? options.__analysisShared : null;
            const heuristic = buildHeuristicBundle(payload, config);
            const sharedWorldAdditional = null;
            const includeWorldAdditional = false;
            const includeUserDlcTrackers = false; // Post-commit extension worker owns both axes.
            const auxiliaryFields = [
                includeWorldAdditional ? getWorldAdditionalResponseShape() : '',
                includeUserDlcTrackers ? getUserDlcTrackerResponseShape() : ''
            ].filter(Boolean);
            const includeAuxiliaryMaintenance = auxiliaryFields.length > 0;
            const auxiliaryShape = includeAuxiliaryMaintenance ? `,"maintenance":{${auxiliaryFields.join(',')}}` : '';
            const memoryHintBlock = String(options?.entityMemoryHintBlock || '').trim();
            const characterEntityHintBlock = String(options?.characterEntityHintBlock || '').trim();
            const entityStoredInfo = String(options?.entityStoredInfo || '').trim() || 'none';
            const canonicalPacketShape = CanonicalPacketContract.promptShape;
            try {
                const system = [
                    'You are LIBRA AfterRequest Unified Analysis.',
                    options?.recoveryMode === true ? 'This is a recovery pass after an invalid or empty result. Prefer a smaller complete packet over a broad partial packet. Never omit required schema, operation, or evidenceRefs fields.' : '',
                    'Use a single packet-commit style: one analysis produces one authoritative canonicalPacket, and every canonical storage axis is derived from that packet.',
                    includeAuxiliaryMaintenance
                        ? 'Return one JSON object with canonicalPacket and optional maintenance fields from the supplied shape. Do not output entityExtraction, longTermMemory, storyAuthor, director, correction, or narrativeBrief.'
                        : 'Return one JSON object with the single top-level key canonicalPacket. Do not output entityExtraction or maintenance.',
                    'Never wrap the object in data/result/output/message/status/done. A status-only object is invalid and will be discarded.',
                    payload.evidencePolicy,
                    'Host Prompt Validation Context is read-only corroboration. Never create or update canon solely from it. A fact must independently appear in the current assistant evidence; use host context only to validate identity, reject contradictions, or normalize names.',
                    payload.userDlcTrackerPrompt ? 'User DLC definitions, analyses, and tracker values belong to a separate non-canonical DB. They are never evidence for canonicalPacket. On conflict, preserve the LIBRA DB unless the current assistant evidence explicitly depicts a valid transition or correction; otherwise record the contradiction in guards/conflicts and omit the mutation.' : '',
                    'canonicalPacket: summarize the current turn once across memory, entity, world, narrative, and guards. Keep current-turn evidence chronological and do not collapse memory into prose-only canon.',
                    'Axis ownership rule: memory.events/facts are chronological recall records; entity owns characters, relations, POV/private knowledge, secrets, and current states; world owns persistent setting fields, places/facilities, organizations, social rules, systems, physics, phenomena, and current world state; put current time/location/scene under world.state, not persistent world rules; narrative owns scene phase, conflict traces, scene deltas, motifs, and unresolved threads; guards owns continuity locks, audit cautions, and overpromotion risks.',
                    'Record each fact in the most specific axis. Do not duplicate the same fact across axes except for a short memory event anchor.',
                    'Mutation rule: operation=add creates a new durable record, update changes an identified record, resolve closes an open thread, and no_change explicitly preserves it. Never use an empty array to imply deletion.',
                    'Evidence rule: every added/updated/resolved entity, relation, memory fact/event, or open thread requires evidenceRefs. Use concise paraphrased snippets and supplied turn/message identifiers; do not copy long dialogue.',
                    `Perform span-grounded NER-style analysis for ${payload.evidenceLabel}. Extract only directly supported person/character entities, relations, and world changes into canonicalPacket. Do not invent names or canon.`,
                    'Visual profile rule: when a LIBRA Canon DB Reflection Directive or explicit current-scene evidence defines stable appearance, include entity.visualCanon as natural-language appearanceText only. Host prompt context may validate an appearance already manifested in the current response, but cannot promote one by itself. Do not create tokenized prompt lists.',
                    includeWorldAdditional ? 'maintenance.worldAdditional is an active World Changer layer, not a passive candidate list. It may add three kinds of non-canon directives: sceneInterventions, worldDeltas, and characterAdditions.' : '',
                    includeWorldAdditional ? 'WorldAdditional canon-fit gate: additions must grow naturally from the current place, mission, social situation, unresolved thread, or established world logic. Do not add random or genre-breaking elements just for surprise.' : '',
                    includeWorldAdditional ? 'Before creating any characterAddition, first check Known LIBRA Entity State, LIBRA Long-Term Entity Cues, Host Prompt Validation Context, Long-Term Memory Cues, World/World State, Important Memories, and Recent Turns. Host context may identify an existing actor but cannot create canon by itself. If an existing canon/LIBRA character can naturally help, oppose, guide, observe, or pressure the scene, use that character through sceneIntervention/worldDelta instead of inventing a new person.' : '',
                    includeWorldAdditional ? 'New-character insertion rule: when the purpose is explicitly to add a new person, prioritize a genuinely unintroduced actor for the current section who is absent from current response evidence, Host Prompt Validation Context, recent turns, and LIBRA canonical entities. The new actor still needs sourceBasis, noveltyReason, noveltyScope, progressionTier, and activationCondition. If the named actor already appears in known state or validation context, do not label them as a new characterAddition; use reuse/canon-first handling instead.' : '',
                    includeWorldAdditional ? 'Progression guard for characterAdditions: match the current section scale. Early/local scenes should add local helpers, contacts, observers, rivals, clues, proxies, rumors, or foreshadowing; do not directly manifest final-boss/endgame-tier figures unless the current narrative is already at that scale. If a World Additional Custom Directive asks for an over-tier figure too early, adapt it into staged foreshadowing, traces, a proxy, or a local representative rather than direct appearance.' : '',
                    includeWorldAdditional ? 'LIBRA Canon DB Reflection Directive, when present and active, is direct user-authored stable design input. Reflect it into canonicalPacket world/entity/narrative/visualCanon fields as user-authored design evidence while preserving canon-fit. Do not convert it into maintenance.worldAdditional unless it explicitly asks for temporary active scene intervention.' : 'LIBRA Canon DB Reflection Directive, when present and active, is direct user-authored stable design input. Reflect it into canonicalPacket world/entity/narrative/visualCanon fields as user-authored design evidence while preserving canon-fit.',
                    'If a LIBRA Canon DB Reflection Directive specifies a character appearance, adapt it into the matching entity.visualCanon.appearanceText in natural language. Ignore image prompt tags as canonical storage unless they are restated as ordinary appearance facts.',
                    includeWorldAdditional ? 'World Additional Custom Directive, when present and active, is direct user-authored input for the World Additional layer only. Convert it into maintenance.worldAdditional sceneInterventions, worldDeltas, or characterAdditions. Do not paste the raw text as-is when adaptation is needed.' : '',
                    includeWorldAdditional ? 'For worldAdditional, create only grounded additions that fit the current world/narrative. Use status armed for additions that should be manifested soon. Use manifestations to report whether previously injected directives actually appeared in this turn.' : '',
                    includeWorldAdditional ? 'WorldAdditional safeguards: never force the user character\'s action, emotion, hidden past, bloodline, body state, or consent; major userImpact should be avoided unless the latest user explicitly asked for it.' : '',
                    includeUserDlcTrackers ? 'maintenance.userDlcTrackerUpdates may update only the listed tracker IDs. The tracker instruction defines what to inspect but does not establish a fact. Use direct current assistant evidence only, copy an allowed value exactly, and omit irrelevant trackers.' : '',
                    includeUserDlcTrackers ? 'Tracker evidence gate: absence of mention, silence, probability, genre convention, and prior speculation are not evidence. Sensitive body, reproductive, pregnancy, contraception, medical, consent, or intimate states require an explicit statement, test result, observed outcome, or other direct current-response evidence before confirmed.' : '',
                    'Do not put speculative World Additional additions into canonicalPacket. A separate LIBRA Canon DB Reflection Directive is the only custom directive that may directly update canonicalPacket without first manifesting in the scene.',
                    'Do not expose hidden/pov information as public canon. If correction is unnecessary, use null.',
                    'Treat guards and guidance as continuity constraints or audit notes, not direct instructions to the next assistant response.',
                    'If evidence is weak, leave arrays empty or lower confidence instead of promoting a fact.',
                    'Return JSON only. No markdown.',
                    'Optional structured memory.events: preserve a stable canonical id for the same occurrence; set eventType, exact registered targetIds, role, factStatus, scalar fields, exact ruleRefs and visibility only when grounded by evidenceRefs. Use state_observed for explicit scalar state fields, counter_delta_observed for exact numeric changes and item_use_observed for actual tool use. Use direct only for an observed completed fact; plans, reported claims, negation and hypotheses remain distinct. item_use_observed requires explicit actual use, itemRef and used=true. Do not invent quantities, probabilities, missing IDs or times. world.state.storyClock may be {calendarId,day,current:true,evidenceRefs} only for an explicitly established current story-calendar day; never use PC time, turn count or a flashback as current time.',
                `canonicalPacket shape: ${canonicalPacketShape}`,
                    includeAuxiliaryMaintenance ? `Complete response shape: {"canonicalPacket":${canonicalPacketShape}${auxiliaryShape}}` : ''
                ].join('\n');
                const user = [
                    `Turn: ${payload.turn}`,
                    `Source Message ID: ${String(options?.sourceMessageId || options?.messageId || '(unavailable)').trim() || '(unavailable)'}`,
                    payload.evidenceText ? `[${payload.evidenceLabel}]\n${payload.evidenceText}` : `[${payload.evidenceLabel}]\n(empty)`,
                    `[Known LIBRA Entity State]\n${entityStoredInfo}`,
                    characterEntityHintBlock ? `[LIBRA Long-Term Entity Cues]\n${characterEntityHintBlock}` : '',
                    payload.hostPromptEvidenceText ? `[Host Prompt Validation Context]\n${payload.hostPromptEvidenceText}` : '',
                    memoryHintBlock ? `[Long-Term Memory Cues]\n${memoryHintBlock}` : '',
                    payload.worldPrompt ? `[World]\n${payload.worldPrompt}` : '',
                    payload.worldStatePrompt ? `[World State]\n${payload.worldStatePrompt}` : '',
                    payload.narrativePrompt ? `[Narrative]\n${payload.narrativePrompt}` : '',
                    // Planner prose may copy extension results; neither is canonical extraction evidence.
                    payload.worldCanonCustomActive && payload.worldCanonCustomText ? `[LIBRA Canon DB Reflection Directive / User-authored stable canon input]\n${payload.worldCanonCustomText}` : '',
                    payload.worldAdditionalCustomActive && payload.worldAdditionalCustomText ? `[World Additional Custom Directive / User-authored active addition input]\n${payload.worldAdditionalCustomText}` : '',
                    payload.entityTexts.length ? `[Existing Focus Entities]\n${payload.entityTexts.join('\n\n')}` : '',
                    payload.relationTexts.length ? `[Existing Relations]\n${payload.relationTexts.join('\n\n')}` : '',
                    payload.charStateTexts.length ? `[Character States]\n${payload.charStateTexts.join('\n\n')}` : '',
                    payload.recentTurns.length ? `[Recent Turns]\n${payload.recentTurns.join('\n')}` : '',
                    payload.memoryEntries.length ? `[Important Memories]\n- ${payload.memoryEntries.join('\n- ')}` : ''
                ].filter(Boolean).join('\n\n');
                const unifiedExecution = resolveTurnAnalysisOutputBudget(payload, 'unified', options);
                const unifiedPreflight = AnalysisBudgetPreflight?.preparePrompt?.({
                    domain: 'afterrequestUnifiedAnalysis',
                    system,
                    user,
                    config,
                    maxTokens: unifiedExecution.maxTokens
                }) || {
                    mode: 'full',
                    reason: 'unavailable',
                    system,
                    user,
                    maxTokens: unifiedExecution.maxTokens,
                    originalUserChars: user.length,
                    preparedUserChars: user.length
                };
                const preflightUnifiedUser = unifiedPreflight.user || user;
                const activeUnifiedUser = options?.recoveryMode === true
                    ? AnalysisBudgetPreflight.compactTextMiddle(preflightUnifiedUser, 18000, '\n...[LIBRA RECOVERY CONTEXT COMPACTED]...\n')
                    : preflightUnifiedUser;
                const activeUnifiedMaxTokens = Number(unifiedPreflight.maxTokens || unifiedExecution.maxTokens) || unifiedExecution.maxTokens;
                AnalysisBudgetPreflight?.debugPreflight?.(config, 'afterrequest-analysis-bundle', unifiedPreflight);
                if (config?.debug) {
                    recordRuntimeDebug('log', '[LIBRA] Unified afterRequest analysis prompt budget:', {
                        analysisEvidenceMode: payload.analysisEvidenceMode,
                        analysisIncludesUserInput: payload.analysisIncludesUserInput,
                        evidenceLabel: payload.evidenceLabel,
                        systemChars: system.length,
                        userChars: activeUnifiedUser.length,
                        rawUserChars: user.length,
                        preflightMode: unifiedPreflight.mode,
                        userEvidenceChars: String(payload.userMsg || payload.userRequestMetadata || '').length,
                        assistantEvidenceChars: String(payload.assistantEvidenceText || payload.aiResponse || '').length,
                        canonicalEvidenceChars: String(payload.canonicalEvidenceText || payload.evidenceText || '').length,
                        entityStoredChars: entityStoredInfo.length,
                        characterHintChars: characterEntityHintBlock.length,
                        memoryHintChars: memoryHintBlock.length
                    });
                }
                const result = await runMaintenanceLLM(() =>
                    LLMProvider.call(config, system, activeUnifiedUser, {
                        maxTokens: activeUnifiedMaxTokens,
                        profile,
                        label: `afterrequest-analysis-bundle-${profile}`,
                        domain: 'turn_maintenance',
                        reason: 'afterrequest-analysis-bundle',
                        analysisPreflight: {
                            mode: unifiedPreflight.mode,
                            reason: unifiedPreflight.reason,
                            estimatedTokens: unifiedPreflight.estimatedTokens,
                         preparedEstimatedTokens: unifiedPreflight.preparedEstimatedTokens
                     },
                     disableReasoning: unifiedExecution.disableReasoning,
                     analysisComplexity: { tier: unifiedExecution.tier, score: unifiedExecution.score }
                 }),
                `afterrequest-analysis-bundle-${currentTurn}`);
                const parsed = parseUnifiedAfterRequestJson(result?.content || '');
                if (!parsed) {
                    recordRuntimeDebug('warn', '[LIBRA] Unified afterRequest analysis returned invalid JSON shape; falling back to split analysis.', {
                        __libraDebugMeta: true,
                        label: 'unified-afterrequest-invalid-json',
                        preview: truncateForLLM(result?.content || '', 260, ' ... ')
                    });
                    return null;
                }
                const canonicalPacket = attachCanonicalPacketEvidenceContext(extractUnifiedCanonicalPacket(parsed), payload, options);
                let entityExtraction = extractUnifiedEntityPayload(parsed);
                let entitySourceMode = 'afterrequest_unified_analysis';
                if (canonicalPacket) {
                    const packetEntityExtraction = deriveEntityExtractionFromCanonicalPacket(canonicalPacket, payload, {
                        lorebook: effectiveLore,
                        sourceMessageId: options?.sourceMessageId || options?.messageId || ''
                    });
                    if (!entityExtraction) {
                        entityExtraction = packetEntityExtraction;
                        entitySourceMode = 'structured_packet';
                    } else {
                        entityExtraction = mergeUnifiedEntityExtractionWithPacketEvidence(entityExtraction, packetEntityExtraction);
                        entityExtraction.sourceMode = entityExtraction.sourceMode || 'structured_packet';
                        entitySourceMode = entityExtraction.sourceMode || 'structured_packet';
                    }
                }
                const compat = parsed?.compat && typeof parsed.compat === 'object' && !Array.isArray(parsed.compat) ? parsed.compat : {};
                const parsedMaintenancePayload = parsed.maintenance && typeof parsed.maintenance === 'object'
                    ? parsed.maintenance
                    : (compat.maintenance && typeof compat.maintenance === 'object' ? compat.maintenance : null);
                const rawMaintenancePayload = sharedWorldAdditional
                    ? { ...(parsedMaintenancePayload || {}), worldAdditional: sharedWorldAdditional }
                    : parsedMaintenancePayload;
                const maintenancePayload = mergeCanonicalPacketIntoMaintenancePayload(
                    rawMaintenancePayload,
                    canonicalPacket,
                    heuristic,
                    payload,
                    config
                );
                if (!entityExtraction && !maintenancePayload) return null;
                if (!entityExtraction) {
                    entityExtraction = {
                        spans: [],
                        entities: [],
                        relations: [],
                        world: {},
                        conflicts: [],
                        uncertain: [],
                        rejected: [],
                        sourceMode: entitySourceMode
                    };
                }
                entityExtraction = compactUnifiedEntityExtraction(entityExtraction);
                const unifiedEntityNames = dedupeTextArray([
                    ...(Array.isArray(payload.focusedEntities) ? payload.focusedEntities : []),
                    ...(Array.isArray(entityExtraction.entities) ? entityExtraction.entities.map(entity => entity?.name).filter(Boolean) : [])
                ]).slice(0, 12);
                const unifiedPayload = { ...payload, focusedEntities: unifiedEntityNames };
                const normalizedMaintenance = normalizeMaintenanceBundleResult(maintenancePayload, heuristic, unifiedPayload, config);
                normalizedMaintenance.worldAdditional = null;
                normalizedMaintenance.userDlcTrackerUpdates = [];
                if (canonicalPacket && !normalizedMaintenance.canonicalPacket) {
                    normalizedMaintenance.canonicalPacket = safeClone(canonicalPacket);
                }
                return {
                    entityExtraction,
                    maintenance: normalizedMaintenance,
                    canonicalPacket,
                    entitySourceMode,
                    profile,
                    label: `afterrequest-analysis-bundle-${profile}`
                };
            } catch (e) {
                recordRuntimeDebug('warn', '[LIBRA] Unified afterRequest analysis failed; falling back to split analysis:', e?.message || e);
                return null;
            }
        };

        const runUnified = async (currentTurn, turnState, aiResponse, effectiveLore = [], config = MemoryEngine.CONFIG, options = {}) => {
            const failures = [];
            const deferredRecoveryMode = options?.recoveryMode === true;
            const executionTrace = [];
            const analysisShared = {};
            const trustedSourceIds = normalizeCanonicalMessageIds([
                turnState?.m_id, turnState?.anchorMeta?.messageId, turnState?.anchorMeta?.m_id,
                turnState?.anchorMeta?.sourceMessageIds, turnState?.anchorMeta?.liveMessageIds
            ]);
            const routedOptions = {
                ...(options && typeof options === 'object' ? options : {}),
                sourceMessageId: trustedSourceIds[0] || options?.sourceMessageId || options?.messageId || '',
                sourceMessageIds: trustedSourceIds.length ? trustedSourceIds : normalizeCanonicalMessageIds([options?.sourceMessageId, options?.messageId]),
                __analysisShared: analysisShared
            };
            const attachExecutionTrace = (result, strategy = '') => result && typeof result === 'object'
                ? {
                    ...result,
                    analysisExecution: {
                        mode: deferredRecoveryMode ? 'deferred_recovery' : 'normal',
                        strategy,
                        recoveryAttempt: Math.max(0, Number(options?.recoveryAttempt || 0) || 0),
                        logicalAttempts: executionTrace.length,
                        attempts: executionTrace.slice()
                    }
                }
                : result;
            if (!deferredRecoveryMode && config?.afterRequestParallelAnalysis !== false) {
                try {
                    executionTrace.push('parallel_canonical_packet');
                    const parallel = await runUnifiedParallel(currentTurn, turnState, aiResponse, effectiveLore, config, routedOptions);
                    if (parallel) return attachExecutionTrace(parallel, 'parallel');
                    failures.push('parallel_invalid_or_empty');
                } catch (parallelError) {
                    failures.push(`parallel:${parallelError?.message || parallelError || 'unknown'}`);
                    if (config?.debug) {
                        recordRuntimeDebug('warn', '[LIBRA] Parallel afterRequest analysis failed; falling back to unified analysis:', parallelError?.message || parallelError);
                    }
                }
            }
            try {
                executionTrace.push(deferredRecoveryMode ? 'serial_compact_recovery' : 'serial_unified');
                const serial = await runUnifiedSerial(currentTurn, turnState, aiResponse, effectiveLore, config, routedOptions);
                if (serial) return attachExecutionTrace(serial, deferredRecoveryMode ? 'serial_recovery' : 'serial');
                failures.push('serial_invalid_or_empty');
            } catch (serialError) {
                failures.push(`serial:${serialError?.message || serialError || 'unknown'}`);
            }

            // A durable deferred retry is already a recovery attempt. Re-running the
            // parallel worker, serial worker, and immediate retry loop here multiplies
            // provider traffic without adding independent evidence. Deferred recovery
            // therefore performs exactly one compact serial call before preserving the
            // safe heuristic state for the next scheduled attempt.
            const immediateRecoveryAttempts = deferredRecoveryMode
                ? 0
                : Math.max(0, Math.min(2, Number(config?.analysisRecoveryImmediateAttempts ?? 1) || 0));
            for (let attempt = 1; attempt <= immediateRecoveryAttempts; attempt++) {
                try {
                    if (typeof sleep === 'function') await sleep(Math.min(1200, 250 * attempt));
                    executionTrace.push(`serial_immediate_recovery_${attempt}`);
                    const recovered = await runUnifiedSerial(currentTurn, turnState, aiResponse, effectiveLore, config, {
                        ...routedOptions,
                        recoveryAttempt: attempt,
                        recoveryMode: true
                    });
                    if (recovered) {
                        recovered.recovered = true;
                        recovered.recoveryAttempt = attempt;
                        recovered.recoveryFailures = failures.slice(-6);
                        if (config?.debug) recordRuntimeDebug('log', '[LIBRA] Unified analysis recovered after immediate retry:', {
                            turn: currentTurn,
                            attempt,
                            failures: failures.slice(-6)
                        });
                        return attachExecutionTrace(recovered, 'immediate_recovery');
                    }
                    failures.push(`recovery_${attempt}:invalid_or_empty`);
                } catch (recoveryError) {
                    failures.push(`recovery_${attempt}:${recoveryError?.message || recoveryError || 'unknown'}`);
                }
            }

            const payload = buildPayload(currentTurn, turnState, aiResponse, effectiveLore, config);
            const heuristic = buildHeuristicBundle(payload, config);
            if (config?.debug) recordRuntimeDebug('warn', '[LIBRA] Unified analysis deferred; safe heuristic state retained:', {
                turn: currentTurn,
                failures: failures.slice(-8)
            });
            return attachExecutionTrace({
                entityExtraction: null,
                maintenance: heuristic,
                canonicalPacket: null,
                entitySourceMode: 'safe_heuristic_fallback',
                profile: '',
                label: 'afterrequest-safe-heuristic-fallback',
                analysisDeferred: true,
                recoveryStatus: 'safe_fallback_saved',
                recoveryFailures: failures.slice(-8)
            }, 'safe_heuristic_fallback');
        };

        const committedExtensionInputGuard = (source, config = MemoryEngine.CONFIG, selection=buildCommittedExtensionBatches(source,config)) => {
            const batches=(selection.batches || []).map(batch=>({role:batch.role,visibility:batch.visibility,trackerIds:batch.trackerIds,
                prompt:String(batch.prompt || '').split('\n').map(line=>{
                    if (!line.startsWith('{"trackerId":')) return line;
                    const definition=JSON.parse(line);if(definition.storyClock){delete definition.storyClock.sceneTurn;delete definition.storyClock.updatedAt;}
                    return JSON.stringify(definition);
                }).join('\n')}));
            return JSON.stringify({batches,worldPrompt:WorldAdditionalCore.formatStateForAnalysis?.(4000) || '',
                worldEnabled:UserDlcCore.isAutomaticGenerationEnabled(),worldMode:String(config?.worldAdditionalMode || 'off')});
        };
        const legacyPermissionSelection=source=>UserDlcCore.buildCommittedTrackerBatch(source,5200,{legacy:true});
        const legacyPermissionInputGuard=(source,config)=>committedExtensionInputGuard(source,config,legacyPermissionSelection(source));
        const legacyCommittedExtensionInputGuard = (source, config) => {
            if (source.events?.length || source.storyClock) return null;
            const selection=legacyPermissionSelection(source),batches=selection.batches || [];
            if (batches.some(batch=>batch.visibility.mode!=='public') || UserDlcCore.getState().entityTrackers.some(item=>selection.trackerIds.includes(item.id) && item.executionDefinition)) return null;
            const trackerPrompt=String(selection.prompt || '').split('\n').map(line=>{
                if(!line.startsWith('{"trackerId":')) return line;
                const definition=JSON.parse(line);if(definition.storyClock){delete definition.storyClock.sceneTurn;delete definition.storyClock.updatedAt;}return JSON.stringify(definition);
            }).join('\n');
            return JSON.stringify({trackerIds:selection.trackerIds,trackerPrompt,worldPrompt:WorldAdditionalCore.formatStateForAnalysis?.(4000) || '',
                worldEnabled:UserDlcCore.isAutomaticGenerationEnabled(),worldMode:String(config?.worldAdditionalMode || 'off')});
        };
        const verifyExtensionResultGuard = (sourceToken, config = MemoryEngine.CONFIG) => {
            const source=IntegratedAnalysisJournal.readCommittedSource(sourceToken),result=IntegratedAnalysisJournal.readExtensionResult(sourceToken);
            return !!source && (!result || result.inputGuard===committedExtensionInputGuard(source,config) || result.inputGuard===legacyPermissionInputGuard(source,config) || result.inputGuard===legacyCommittedExtensionInputGuard(source,config));
        };
        const runCommittedExtensions = async (sourceToken, config = MemoryEngine.CONFIG, lifecycle = {}) => {
            const source=IntegratedAnalysisJournal.readCommittedSource(sourceToken);
            if (!source) return {skipped:true,reason:'committed_evidence_unavailable_or_consumed',worldAdditional:null,userDlcTrackerUpdates:[]};
            if (!verifyExtensionResultGuard(sourceToken,config)) throw Error('extension_result_dependencies_changed');
            if (!IntegratedAnalysisJournal.claimCommittedSource(sourceToken)) return {skipped:true,reason:'committed_evidence_unavailable_or_consumed'};
            const retained=IntegratedAnalysisJournal.readExtensionResult(sourceToken);
            const selection=retained && retained.inputGuard!==committedExtensionInputGuard(source,config)
                ?legacyPermissionSelection(source):buildCommittedExtensionBatches(source,config),batches=selection.batches || [];
            const publicEvidence=source.evidence.filter(item=>!item.visibility || item.visibility.mode==='public');
            const timeOnly=source.evidence.length>0 && source.evidence.every(item=>['world.time','world.clock'].includes(item.id));
            const structuredOnly=(source.events || []).length>0 && source.evidence.every(item=>item.id.startsWith('event:') || ['world.time','world.clock'].includes(item.id));
            const payload={turn:source.turn,committedSourceToken:sourceToken,requireCompleteExtensionResult:true,
                evidenceText:publicEvidence.map(item=>`[${item.id}] ${item.text}`).join('\n'),
                automaticPackageContext:UserDlcCore.getState().settings.autoGenerationEnabled===true?UserDlcCore.automaticPackageContext(lifecycle.lorebook || []):'',
                focusedEntities:dedupeTextArray(publicEvidence.flatMap(item=>item.targets || [])),
                currentWorldAdditionalPrompt:WorldAdditionalCore.formatStateForAnalysis?.(4000) || '',entityTexts:[],relationTexts:[],recentTurns:[],worldPrompt:'',worldStatePrompt:'',narrativePrompt:''};
            payload.canonicalEvidenceText=payload.evidenceText;
            const inputGuard=IntegratedAnalysisJournal.readExtensionResult(sourceToken)?.inputGuard || committedExtensionInputGuard(source,config);
            const retainedRoles={...(IntegratedAnalysisJournal.readExtensionResult(sourceToken)?.roles || {})};
            await lifecycle.prepareWork?.(batches.map(batch=>({role:batch.role,trackerIds:batch.trackerIds,status:batch.status,reason:batch.reason})),inputGuard);
            const runRole=async(role,execute)=>{
                if(Object.hasOwn(retainedRoles,role)) return safeClone(retainedRoles[role].value);
                await lifecycle.beforeRole?.(role);const value=await execute(async(phase,detail)=>lifecycle.providerAttempt?.(role,phase,detail));await lifecycle.afterRole?.(role,value,inputGuard);
                retainedRoles[role]={value:safeClone(value)};return value;
            };
            // Permission partitions consume the existing single interpretation slot over
            // successive maintenance passes. No new call budget or hidden retry is added.
            const next=batches.find(batch=>batch.status==='ready' && !Object.hasOwn(retainedRoles,batch.role));
            if(next && config?.useLLM!==false) await runRole(next.role,attemptObserver=>runUserDlcTrackerUpdates(source.turn,{},'',[],config,
                {...payload,attemptObserver,committedTrackerBatch:next,userDlcTrackersActive:true,userDlcTrackerPrompt:next.prompt}));
            const pending=batches.filter(batch=>batch.status!=='ready' || !Object.hasOwn(retainedRoles,batch.role));
            if(pending.length) return {skipped:true,reason:config?.useLLM===false?'analysis_ai_paused':pending[0].reason || 'permission_batches_pending',
                waitingTrackerIds:pending.flatMap(batch=>batch.trackerIds),worldAdditional:null,userDlcTrackerUpdates:[],packetId:source.packetId,packetRevision:source.revision};
            const userDlcTrackerUpdates=batches.flatMap(batch=>retainedRoles[batch.role]?.value || []);
            const worldAdditional=!timeOnly && !structuredOnly && publicEvidence.length && config?.useLLM!==false
                ?await runRole('world',attemptObserver=>runWorldAdditionalTurnUpdates(source.turn,{},'',[],config,{...payload,attemptObserver})):null;
            return {worldAdditional,userDlcTrackerUpdates,packetId:source.packetId,packetRevision:source.revision,
                trackerIds:selection.trackerIds,trackerEvidenceIds:selection.evidenceIds,analysisReason:timeOnly?'time_only_code_calculation':structuredOnly?'structured_event_dispatch':''};
        };

        const runWorldAdditionalAnalysis = async (context = {}, config = MemoryEngine.CONFIG) => {
            const analysisMode = String(context?.analysisMode || 'manual').toLowerCase() === 'historical' ? 'historical' : 'manual';
            const historical = analysisMode === 'historical';
            const profile = (LLMProvider.isConfigured(config, 'primary') || LLMProvider.isConfigured(config, 'aux'))
                ? resolveAnalysisProfile(config, 'turnMaintenanceBundle', 'primary')
                : null;
            if (!profile) throw new Error('월드 에디셔널 분석에 사용할 LLM 프로바이더가 설정되지 않았습니다.');
            const turn = Math.max(0, Number(context?.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0);
            const historyText = truncateForLLM(String(context?.historyText || '').trim(), 32000, '\n...[OLDER CHAT TRUNCATED]...\n');
            if (!historyText) throw new Error('분석할 현재 채팅 기록이 없습니다.');
            const responseShape = `{${getWorldAdditionalResponseShape()}}`;
            const system = [
                historical ? 'You are LIBRA World Additional Historical Analyzer.' : 'You are LIBRA World Additional Manual Analyzer.',
                historical
                    ? 'This path is invoked by cold start or past-dialogue reanalysis. It initializes only the independent World Additional DB; the dedicated manual button remains a separate callable path.'
                    : 'This is a dedicated manual analysis path. It is independent from cold start, past-dialogue reanalysis, canonical packet writing, and normal afterRequest maintenance.',
                historical
                    ? 'Analyze the supplied historical chat and reconstructed LIBRA state only to prepare grounded non-canon World Additional directives for future scenes.'
                    : 'Analyze the supplied chat history and current LIBRA world state only to prepare useful non-canon World Additional directives for future scenes.',
                'Do not rewrite canonical memory, entities, relations, world rules, narrative history, Story Author, or Director state.',
                'Create only grounded additions that follow from the current location, mission, social situation, unresolved thread, or established world logic.',
                'Prefer reusing known canon actors through sceneInterventions/worldDeltas. Create a characterAddition only when a genuinely unintroduced local actor serves a clear current need.',
                'Match progression scale. Do not introduce endgame or final-tier actors into local/early scenes; adapt them into traces, rumors, proxies, or foreshadowing.',
                'Never force the user character\'s actions, consent, hidden past, emotions, bodily state, bloodline, or final decision.',
                'Use status armed for directives suitable for upcoming scenes and prepared for longer-term possibilities.',
                'Return JSON only. No markdown or explanation.',
                `Required shape: ${responseShape}`
            ].join('\n');
            const user = [
                `Current LIBRA turn: ${turn}`,
                context?.worldPrompt ? `[Canonical World]\n${truncateForLLM(context.worldPrompt, 6000, ' ... ')}` : '',
                context?.worldStatePrompt ? `[Current World State]\n${truncateForLLM(context.worldStatePrompt, 4000, ' ... ')}` : '',
                context?.narrativePrompt ? `[Current Narrative]\n${truncateForLLM(context.narrativePrompt, 4000, ' ... ')}` : '',
                context?.entityContext ? `[Known Canon/LIBRA Actors]\n${truncateForLLM(context.entityContext, 6000, ' ... ')}` : '',
                context?.existingDirectives ? `[Existing World Additional DB]\n${truncateForLLM(context.existingDirectives, 4000, ' ... ')}` : '',
                context?.customDirective ? `[User-authored World Additional Directive]\n${truncateForLLM(context.customDirective, 6000, ' ... ')}` : '',
                `[Current Chat History]\n${historyText}`
            ].filter(Boolean).join('\n\n');
            // manual/historical 은 표를 안 거치던 하드코딩이었다(3200). 계약 표에서 값을 얻되,
            // 표의 최고 tier(2600)보다 원래 요청이 컸으므로 floor 로 원래 값을 보존한다.
            const manualBudget = contractOutputBudget('world_additional', 'critical', 3200);
            const preflight = AnalysisBudgetPreflight?.preparePrompt?.({
                domain: 'turnMaintenanceBundle',
                system,
                user,
                config,
                maxTokens: manualBudget
            }) || { system, user, maxTokens: manualBudget, mode: 'full', reason: 'unavailable' };
            AnalysisBudgetPreflight?.debugPreflight?.(config, `world-additional-${analysisMode}`, preflight);
            const result = await runMaintenanceLLM(() => LLMProvider.call(config, preflight.system || system, preflight.user || user, {
                maxTokens: Number(preflight.maxTokens || manualBudget) || manualBudget,
                profile,
                label: `world-additional-${analysisMode}-${profile}`,
                domain: 'turn_maintenance',
                reason: historical ? 'world-additional-historical-analysis' : 'world-additional-manual-analysis',
                analysisPreflight: {
                    mode: preflight.mode,
                    reason: preflight.reason,
                    estimatedTokens: preflight.estimatedTokens,
                    preparedEstimatedTokens: preflight.preparedEstimatedTokens
                }
            }), `world-additional-${analysisMode}-${turn}`);
            const cleaned = Utils.stripLLMThinkingTags(String(result?.content || ''));
            const parsed = parseLooseJson(cleaned) || extractStructuredJson(cleaned);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('월드 에디셔널 전용 분석 결과가 올바른 JSON이 아닙니다.');
            }
            const rawPayload = parsed.worldAdditional
                || parsed.world_additional
                || parsed.maintenance?.worldAdditional
                || parsed.maintenance?.world_additional
                || parsed;
            const payload = WorldAdditionalCore.normalizeMaintenancePayload?.(rawPayload) || null;
            if (!payload) throw new Error('월드 에디셔널 분석 결과를 정규화하지 못했습니다.');
            return {
                payload,
                profile,
                turn,
                source: historical ? 'historical_world_additional_analysis' : 'manual_world_additional_analysis',
                rawChars: String(result?.content || '').length
            };
        };

        const runWorldAdditionalManual = (context = {}, config = MemoryEngine.CONFIG) => runWorldAdditionalAnalysis({
            ...context,
            analysisMode: 'manual'
        }, config);
        const runWorldAdditionalHistorical = (context = {}, config = MemoryEngine.CONFIG) => runWorldAdditionalAnalysis({
            ...context,
            analysisMode: 'historical'
        }, config);

        const runUserDlcAnalysis = async (mode = 'world', context = {}, config = MemoryEngine.CONFIG) => {
            const targetMode = ['entity', 'direct'].includes(String(mode || '').toLowerCase()) ? String(mode).toLowerCase() : 'world';
            const routeKey = targetMode === 'entity' ? 'userDlcEntityAnalysis' : 'userDlcWorldAnalysis';
            const resolvedProfile = resolveAnalysisProfile(config, routeKey, 'primary');
            const profile = LLMProvider.isConfigured(config, resolvedProfile) ? resolvedProfile : null;
            if (!profile) throw new Error('유저 DLC 분석에 사용할 LLM 프로바이더가 설정되지 않았습니다.');
            const turn = Math.max(0, Number(context?.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0);
            const analysisBatchLabel = String(context?.analysisBatchLabel || '').trim().replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
            const analysisLabelSuffix = analysisBatchLabel ? `-${analysisBatchLabel}` : '';
            // User DLC creation is a creative-writing analysis path too. Carry the
            // active NSFW mode and host prefill forward so generated DLC mechanics
            // fit the same scene contract as the main narrative. The analysis still
            // returns JSON, so the prefill is context only and must never be emitted.
            const nsfwGuidance = buildNsfwGuidanceBlock('User DLC NSFW Guidance', config);
            const assistantPrefill = buildPrefillBlock(config);
            const creativeResponseContract = [
                nsfwGuidance,
                assistantPrefill
                    ? '[Active Assistant Prefill — analysis-safe contract]\nThe active assistant prefill applies to downstream narrative portrayal. Preserve its mature-scene directness, continuity, consent logic, character integrity, language, and tone while designing DLC, but do not quote, imitate, or continue assistant prose in this analysis response.'
                    : ''
            ].filter(Boolean);
            const commonRules = [
                'This is a user-authored DLC analysis path. It must not rewrite canonical LIBRA memory, entities, relations, world rules, Narrative, Story Author, or Director state.',
                'Treat the active User DLC concept, requested function, and required result as user-authority input. No Memory summary, Narrative plan, Story Author plan, Director guidance, or World Additional suggestion may weaken or discard it.',
                'Use Character Description, Character Lorebook, and the LIBRA Memory/Entity/Relation/World DB as canon adaptation constraints rather than competing instructions. Preserve the user\'s required outcome while translating names, materials, technology or magic, institutions, scale, and causal mechanics to fit established world rules.',
                'Clearly distinguish established evidence from inference. Do not invent contradictory canon merely to justify the requested idea.',
                'When any requested statement conflicts with LIBRA DB, do not overwrite the DB. Either produce an adapted compatible analogue, or mark canonCompatibility.status=conflicted and list the exact conflict so runtime injection is blocked.',
                'Never assign the user character\'s actions, consent, emotions, secret past, bodily state, or final decision.',
                ...creativeResponseContract,
                'Keep the JSON compact enough to finish: use concise strings, at most three scenarioBands, at most three dialogueExamples per branch, and at most five entries in other descriptive arrays unless exact target coverage requires more.',
                'Return JSON only. No markdown and no explanation outside JSON.'
            ];
            const system = targetMode === 'direct' ? [
                'You are LIBRA direct extension request composer. Propose one complete mixed bundle for one preview and one explicit user apply.',
                ...commonRules,
                'Separate each requested world candidate, one-time entity analysis, and continuous tracker. Use only exact registered entity IDs from the supplied catalog. The optional selected entity resolves pronouns, but does not redirect explicitly named people. Never invent a target or silently choose between ambiguous names; put an explanation in unresolved.',
                'World candidates remain in the existing User DLC owner as setting proposals, not canonical author rules. If the user explicitly sets a canonical author rule, mark intent=author_rule and include sourceQuote as an exact substring of the user request, plus one concise adaptedConcept rule sentence and optional exact nodeId. The explicit preview apply may publish it through the canonical owner. Never disguise a candidate as an author rule.',
                'Every item needs a unique requestItemId and dependsOn array. Put local world requestItemIds in tracker dependsOn when their rule/effect must first be canonically established. Dependent trackers are saved inactive as waiting_dependency; candidate existence is never proof that the rule or effect is active.',
                'Use entity_analysis for a one-time response; tracking only for explicitly continuing requests. Each adaptiveItems entry has exactly one registered entity target, while several entries may address different requested functions/people. Do not invent observations or initial values: use unknown when unsupported.',
                'Use generic state/scenario_response/relationship_model/capability, or an explicitly requested reproductive_health/health_risk/sexual_history observer. Sensitive observers require exact canonically adult targets and separate scope-specific user permission in preview. Return unknown initial values; never fabricate a cycle, medical odds, simulation defaults or unobserved counts. No arbitrary code. Unsupported calculator actions belong in unresolved.',
                'Return all requested parts or report unresolved; do not drop a failed part or return a partial success. Do not perform semantic repair by adding another model call.',
                context.existingTrackerEdit ? 'EXISTING-CARD EDIT MODE: edit only the supplied trackerId. worldItems and adaptiveItems must be empty. Add trackerEdits:[{trackerId,editIntent:"controls|instruction_only",patch,sourceQuotes}]. Set editIntent=controls for any executable setting change and include the changed controls; instruction_only is exclusively for wording/analysis-guidance edits and must not substitute for functional intent. patch is sparse: instruction (string), trackingEnabled/useEnabled/simulationEnabled/cycleEnabled/pregnancyEnabled (booleans), but only supplied editableFields are allowed. Omit every unrequested field. sourceQuotes must give an exact substring of the user request for each changed field. For keeping cycle tracking but stopping pregnancy simulation, propose pregnancyEnabled:false and leave unrelated controls unchanged. Never replace the execution definition, reset history/seed/anchors, alter targets, consent, visibility, numeric parameters or create a card. Put ambiguous or unsupported changes in unresolved. An instruction-only change must never stand in for a requested functional change. The user will review before apply.' : '',
                'Required shape: {"bundleVersion":1,"worldItems":[{"requestItemId":"setting1","intent":"world_candidate|author_rule","sourceQuote":"exact user request phrase for author rules","nodeId":"optional exact world ID","dependsOn":[],"kind":"custom","title":"","adaptedConcept":"","mechanism":"","canonCompatibility":{"status":"adapted|conflicted","conflicts":[]}}],"adaptiveItems":[{"requestItemId":"tracking1","intent":"entity_analysis|tracking","dependsOn":[],"targetType":"entity","targetIds":["exact registered ID"],"kind":"state|scenario_response|relationship_model|capability|reproductive_health|health_risk|sexual_history","label":"","instruction":"","valueType":"text|status|number|boolean","currentValue":"unknown","currentSnapshot":{"summary":""},"useEnabled":true}],"unresolved":[{"message":""}]}. Empty arrays are allowed when that category was not requested. Never omit any root.'
            ].join('\n') : targetMode === 'world' ? [
                'You are LIBRA User DLC World Adapter.',
                ...commonRules,
                'The user provides only a natural-language creative request. Infer the most suitable kind, title, mechanics, trigger, scope, and adaptation strategy internally; never require the user to write an analysis prompt.',
                'Adapt the requested tool, contraceptive, dungeon, monster, drop item, experience system, monster gate, magic, sorcery, magic array, magic wand, magic circle, skill, superpower, trap, crisis development, hazard, mechanism, lore, location, faction, rule, history, artifact, or custom scenario into the supplied world.',
                'Use kind-specific adaptive logic: traps/hazards/crises need observable cues, trigger, fair counterplay and consequences; tools/artifacts need use conditions, limits and setting-grounded construction; locations/factions/rules/history need role, boundaries, links and continuity fit.',
                'For a requested contraceptive tool, use kind=contraceptive and create a contraceptiveProfile grounded in the setting\'s technology, magic, alchemy, medicine, institutions, materials, economy and access rules. If the user asks for several tools, return one worldItems entry per materially distinct tool instead of combining them into one entry.',
                'Each contraceptiveProfile must state methodClass, physical or magical form, exact in-world useProtocol, onset, effectiveWindow, categorical reliabilityTier, concrete failureConditions, sideEffects or constraints, availability, reversibility, protectionScope and settingBasis. The profile describes the item, never a character\'s actual use or bodily outcome.',
                'Use reliabilityTier unknown|low|moderate|high|very_high rather than inventing precise medical percentages. Never describe a method as absolutely safe or guaranteed. Distinguish pregnancy prevention from infection protection: use pregnancy_and_infection only when the tool\'s established mechanism supports both.',
                'Contraceptive tools are for canonically adult characters only. Do not assign purchase, possession, use, consent, side effects, pregnancy state, fertility state or final decisions to the user character.',
                'For dungeon, monster, drop_item, experience_system, monster_gate, magic, sorcery, magic_array, magic_wand, magic_circle, skill, or superpower, create fantasySystemProfile. When the user requests a connected package, return one worldItems entry per distinct element and cross-link their exact titles through relatedElements; never collapse the package into one generic item.',
                'Use dungeon for an explorable space with entry, exit, encounter and reward rules; monster for a creature with ecology, spawn rules, behavior, weaknesses and possible drops; drop_item for a separately reusable reward with source, rarity and acquisition conditions; experience_system for experience award, progression and anti-exploit rules; monster_gate for a portal or breach with opening, spawn, entry, exit, duration and closure conditions.',
                'Use magic for the setting\'s general spell or magical technique; sorcery for a distinct occult, innate, folk, forbidden or setting-specific art when canon supports that distinction; magic_array for an inscribed ritual diagram or formation; magic_wand for a wand, staff or casting implement; magic_circle for a rank, stage, orbit or progression-circle structure. Never treat magic_array and magic_circle as synonyms.',
                'Use skill for a learned or system-granted technique and superpower for an innate, awakened, altered or otherwise exceptional power. Every magic, sorcery, wand, circle, skill and superpower entry needs acquisition or prerequisites, activation, resource costs, limits, failure consequences and counterplay appropriate to canon.',
                'Drops, rewards and experience are definitions, not current possessions or awards. Grant them only after an explicitly eligible completed event, never merely because the element exists, and include antiExploitRules that prevent duplicate rewards for the same event. Dungeon, gate and monster existence likewise does not mean they are active in the current scene unless activation or spawn conditions are met.',
                'Do not overwrite canon power levels, grant abilities or inventory, force entry into a dungeon/gate, decide combat outcomes, or assign the user character\'s actions. Adapt rank vocabulary, metaphysics, technology and scale to established world rules.',
                'If the literal concept conflicts with canon, preserve its function through a canon-compatible analogue and list the adaptations and conflicts.',
                'Required shape: {"worldItems":[{"kind":"tool|contraceptive|dungeon|monster|drop_item|experience_system|monster_gate|magic|sorcery|magic_array|magic_wand|magic_circle|skill|superpower|trap|crisis|hazard|mechanism|lore|location|faction|rule|history|artifact|custom","title":"","userConcept":"","adaptedConcept":"","worldFitSummary":"","mechanism":"","trigger":"","effects":[""],"counterplay":[""],"risks":[""],"activationCondition":"","progressionTier":"ambient|local|section|arc|climax|final","userImpact":"ambient|soft|direct","relatedEntities":[""],"relatedWorldRules":[""],"sourceBasis":[""],"contraceptiveProfile":{"methodClass":"barrier|hormonal|chemical|device|emergency|surgical|magical|technological|alchemical|hybrid|other","form":"","useProtocol":"","onset":"","effectiveWindow":"","reliabilityTier":"unknown|low|moderate|high|very_high","failureConditions":[""],"sideEffects":[""],"availability":"","reversibility":"unknown|reversible|long_acting_reversible|permanent","protectionScope":"unknown|pregnancy_only|pregnancy_and_infection|infection_only","settingBasis":""},"fantasySystemProfile":{"category":"","rank":"","rarity":"","levelRange":"","origin":"","acquisition":"","activation":"","duration":"","prerequisites":[""],"costs":[""],"limits":[""],"progressionRules":[""],"rewardRules":[""],"drops":[""],"weaknesses":[""],"entryConditions":[""],"exitConditions":[""],"spawnConditions":[""],"failureConsequences":[""],"antiExploitRules":[""],"relatedElements":["exact linked DLC title"],"settingBasis":""},"canonCompatibility":{"status":"compatible|adapted|conflicted","conflicts":[""],"adaptations":[""]},"status":"armed"}]}'
            ].join('\n') : [
                'You are LIBRA User DLC Adaptive Character Response Designer.',
                ...commonRules,
                'The user provides only a natural-language desired behavior, scenario, relationship feature, capability comparison, reproductive-health tracker, health-risk tracker, sexual-history tracker, or other state. Infer the internal tracker kind and configuration automatically.',
                'Analyze only the exact LIBRA character targets supplied by the user. Never rename, merge, omit, or silently substitute a selected target.',
                'The supplied LIBRA Relation DB records are evidence for each character response, not DLC targets. Use closeness, trust, tension, directional sentiment, boundaries, speech dynamics and recent changes when relevant, but never create or mutate a relation-target DLC item.',
                'Choose kind from state, scenario_response, relationship_model, capability, reproductive_health, health_risk, or sexual_history. Return exactly one adaptiveItems entry per selected character and always use targetType=entity.',
                'For relationship_model, model the selected character\'s own response and perspective. Do not turn the relationship record itself into the tracked subject.',
                'For scenario_response and relationship_model, generate compact scenarioBands covering materially different relationship states, but put only the currently applicable branch in currentSnapshot. Include expected behavior and several speech-style-grounded dialogue examples.',
                'A high affection score may raise receptiveness but never guarantees acceptance; trust, safety, current emotion, boundaries, recent events and proposal type remain independent inputs. Consent is evaluated per scene.',
                'For coercion/capability requests, separately assess refusal/resistance intent and the practical ability to defend, escape, delay, call for help, or use powers, equipment and terrain.',
                'For reproductive_health, track story-date-based cycle uncertainty, fertility likelihood, contraception/exposure, age and only canonically established fertility modifiers. Never call a day absolutely safe and never infer infertility or disease from age alone. Male and female factors may both matter.',
                'When a canonically adult reproductive_health target has no canonical cycle timing, create one fictional RP-only cycle model with an arbitrary but internally consistent cycle length, cycle day, bleeding duration, anchor story date, and fertile-window range. Label cycleModel=fictional_rp, state that it is not medical fact, persist the generated parameters, and advance them from the story clock instead of rerandomizing on later analyses.',
                'Contraceptive effectiveness figures are population-level priors, not per-act truth. Produce a conservative RP event range only when the relevant event and method are established. Use eventResolutionMode=single_event_locked so runtime resolves each event once rather than once per turn.',
                'For health_risk, require a depicted exposure, injury or established condition before creating a disease-risk event. Track exposure/incubation/symptom/confirmation/recovery without rerolling the same event.',
                'For sexual_history, track sexCount, virginityStatus, masturbationCount, pregnancyCount, birthCount, distinctPartnerCount, vaginalEjaculationCount, fellatioCount, analSexCount, firstSexPartner, and knownSexPartners. Use eventResolutionMode=single_event_locked and trackingRecommended=true.',
                'sexual_history sexCount means completed partnered sexual encounters and counts once per encounter/scene, while fellatioCount and analSexCount are act-specific. Keep all unknown lifetime counts null; never turn absence of evidence into zero. Use sexualHistoryCountingBasis=canonical_total only when canon establishes the lifetime total, otherwise unknown. Runtime will change it to observed_minimum when newly depicted events accumulate from an unknown baseline.',
                'For sexual_history, virginityStatus is narrative first-partnered-sex history only, never anatomy, hymen state, purity, examination, or medical inference. Use no_confirmed_sex_experience only when canon explicitly establishes no prior partnered sex, sexually_experienced when prior partnered sex is established, and unknown otherwise.',
                'For sexual_history, set firstSexPartner and knownSexPartners only from established canon or explicit scene evidence. Do not assume the earliest partner visible in supplied context was the first. Derive distinctPartnerCount from unique established partners or an explicit canonical count; do not guess unnamed partners.',
                'Pregnancy and birth history must be confirmed narrative events. A risk estimate, missed period, symptom, rumor, attempt, or hypothetical does not increment pregnancyCount or birthCount.',
                '[Age & Adulthood Mandate] In all User DLC character additions, it is a fundamental premise that all characters within the narrative are adults; any discrepancy or use of younger/different ages is strictly limited to in-universe roleplaying, aliases, or deceptive characterization and does not alter their underlying adult status. Roleplay aliases, deceptive in-story age claims, or other fictional age labels are characterization only and never establish adulthood. Do not treat them as evidence that a target is an adult.',
                'Only calculate intimate or reproductive mechanics for canonically adult targets. If adulthood is contradicted, mark the item unusable; if age evidence is absent, state uncertainty and avoid asserting medical facts.',
                'Default trackingRecommended=false for a one-time hypothetical scenario. Use true for an explicitly continuous relationship model, reproductive health, health risk, sexual history, or when the user explicitly requests continuing tracking. Default useEnabled=true.',
                'Required shape: {"adaptiveItems":[{"targetType":"entity","targetIds":[""],"displayName":"","kind":"state|scenario_response|relationship_model|capability|reproductive_health|health_risk|sexual_history","label":"","userRequest":"","instruction":"","valueType":"status|text","allowedValues":[""],"currentValue":"","confidence":"confirmed|likely|possible|uncertain|unknown","currentSnapshot":{"summary":"","relationshipState":"","probabilityMin":null,"probabilityMax":null,"probabilityLabel":"","expectedResponse":"","dialogueExamples":[""],"defenseAssessment":"","sceneDate":"","cycleModel":"fictional_rp|canonical|unknown","cycleAnchorDate":"","cycleLengthDays":null,"cycleDay":null,"bleedingDurationDays":null,"fertileWindowStartDay":null,"fertileWindowEndDay":null,"cycleStatus":"","fertilityWindow":"","contraception":"","healthStatus":"","sexCount":null,"virginityStatus":"unknown|no_confirmed_sex_experience|sexually_experienced","masturbationCount":null,"pregnancyCount":null,"birthCount":null,"distinctPartnerCount":null,"vaginalEjaculationCount":null,"fellatioCount":null,"analSexCount":null,"firstSexPartner":"","knownSexPartners":[""],"sexualHistoryCountingBasis":"unknown|observed_minimum|canonical_total","sexualHistoryNote":"","nextEvaluation":"","confidenceNote":""},"scenarioBands":[{"band":"","conditions":[""],"probabilityMin":null,"probabilityMax":null,"expectedResponse":"","dialogueExamples":[""]}],"trackingEnabled":false,"trackingRecommended":false,"useEnabled":true,"updateMode":"every_turn|manual","eventResolutionMode":"none|single_event_locked","evidence":[""],"reason":""}]}'
            ].join('\n');
            const user = [
                `Current LIBRA turn: ${turn}`,
                targetMode === 'direct' && context.existingTrackerEdit ? `[Selected existing card — only these fields may change]\n${JSON.stringify(context.existingTrackerEdit)}` : '',
                targetMode === 'direct' ? `[Complete user direct request]\n${context.request || ''}\n[Optional exact entity selection]\n${context.selectedEntityId || '(none; resolve only explicit registered targets)'}` : '',
                targetMode === 'world' ? `[User natural-language world addition]\n${truncateForLLM(context.userConcept || '', 6000, ' ... ')}` : '',
                targetMode === 'entity' ? `[User-selected exact targets]\n${truncateForLLM(context.selectedTargets || '', 9000, ' ... ')}\n[User natural-language request]\n${truncateForLLM(context.analysisPrompt || '', 6000, ' ... ')}` : '',
                targetMode === 'entity' && context.coverageRetry === true ? '[Coverage retry]\nThe previous batch omitted these characters. Return exactly one complete adaptiveItems entry for every target listed above; return no other targets.' : '',
                targetMode === 'entity' && context.retargeting === true ? '[Existing tracker retargeting]\nReanalyze the same user-authored tracking concept for the newly selected character membership. Respect the supplied existing tracker definitions, current values, uncertainty, fictional cycle anchors, event locks and accumulated history. Do not erase or reset established tracker data merely because membership changed.' : '',
                context.storyClock ? `[Canonical in-story clock]\n${truncateForLLM(context.storyClock, 1200, ' ... ')}` : '',
                context.characterWorldSources ? `[Character Description and Character Lorebook — world authority]\n${truncateForLLM(context.characterWorldSources, 10000, ' ... ')}` : '',
                context.worldPrompt ? `[LIBRA World DB]\n${truncateForLLM(context.worldPrompt, 7000, ' ... ')}` : '',
                context.worldStatePrompt ? `[Current LIBRA World State]\n${truncateForLLM(context.worldStatePrompt, 4000, ' ... ')}` : '',
                context.worldCodexPrompt ? `[World Additional World Codex]\n${truncateForLLM(context.worldCodexPrompt, 5000, ' ... ')}` : '',
                context.entityContext ? `[LIBRA Entity DB context]\n${truncateForLLM(context.entityContext, 9000, ' ... ')}` : '',
                context.relationContext ? `[LIBRA Relation DB evidence — context only, never an output target]\n${truncateForLLM(context.relationContext, 12000, ' ... ')}` : '',
                context.existingDlc ? `[Existing User DLC DB — cumulative update basis]\n${truncateForLLM(context.existingDlc, 6000, ' ... ')}` : '',
                context.historyText ? `[Recent scene context]\n${truncateForLLM(context.historyText, 10000, ' ... ')}` : ''
            ].filter(Boolean).join('\n\n');
            if (targetMode === 'direct' && (!String(context.request || '').trim() || String(context.request).length > 6000)) throw new Error('직접 추가 요청은 기존 입력 한도 안에서 나누어 주세요.');
            if (targetMode === 'world' && !String(context.userConcept || '').trim()) throw new Error('창안할 World 요소를 입력해 주세요.');
            if (targetMode === 'entity' && (!String(context.selectedTargets || '').trim() || !String(context.analysisPrompt || '').trim())) throw new Error('분석 대상과 사용자 분석 프롬프트를 모두 지정해 주세요.');
            const requestedMaxTokens = targetMode === 'world' ? 4200 : 5200;
            const preflight = AnalysisBudgetPreflight?.preparePrompt?.({ domain: 'userDlcAnalysis', system, user, config, maxTokens: requestedMaxTokens })
                || { system, user, maxTokens: requestedMaxTokens, mode: 'full', reason: 'unavailable' };
            if (targetMode === 'direct' && ((preflight.user || user) !== user || (preflight.system || system) !== system)) throw new Error('혼합 요청 전체를 분석 한도에 담지 못했습니다. 요청을 나누어 주세요.');
            AnalysisBudgetPreflight?.debugPreflight?.(config, `user-dlc-${targetMode}`, preflight);
            const result = await runMaintenanceLLM(() => LLMProvider.call(config, preflight.system || system, preflight.user || user, {
                maxTokens: Number(preflight.maxTokens || requestedMaxTokens),
                profile,
                label: `user-dlc-${targetMode}${analysisLabelSuffix}-${profile}`,
                domain: 'turn_maintenance',
                reason: `user-dlc-${targetMode}-analysis`,
                jsonMode: true,
                forceJsonMode: true,
                forceNonStreaming: true,
                disableReasoning: true,
                reasoningPresetOverride: 'off',
                analysisPreflight: { mode: preflight.mode, reason: preflight.reason, estimatedTokens: preflight.estimatedTokens, preparedEstimatedTokens: preflight.preparedEstimatedTokens }
            }), `user-dlc-${targetMode}-${turn}${analysisLabelSuffix}`);
            const cleaned = Utils.stripLLMThinkingTags(String(result?.content || ''));
            const parseObject = text => {
                const candidate = parseLooseJson(text) || extractStructuredJson(text);
                return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
            };
            let parsed = parseObject(cleaned);
            // ── JSON 복구 패스는 은퇴했다 (추가 LLM 호출 없음) ──
            // 실측(2026-09-27): 이 패스는 이미 **도달 불가**였다. c24ef6a 의 closeUnbalancedJson 이
            // 닫는 괄호만 부족한 응답을 유효 JSON 으로 완성하므로 parseObject 가 non-null 을 내고,
            // 복구 조건이 `if (!parsed)` 뿐이었기 때문에 2차 호출이 한 번도 실행되지 않았다.
            //   입력   : {"adaptiveItems":[{"targetType":"entity","targetIds":["entity-ariel"]
            //   완성   : {"adaptiveItems":[{"targetType":"entity","targetIds":["entity-ariel"]}]}  → JSON.parse 성공
            //   결과   : 모델이 만들지 않은 kind/label/currentValue 등이 소리 없이 사라진 채 "성공"으로 집계됐다.
            // 그래서 2차 호출로 원문을 복원하는 대신 **복원하지 않는다**(호출 비용 0). 대신 잘림을 드러내고
            // 원인을 아래 로그의 likelyTruncated 로 분류한다.
            // 주의: 여기서 parsed 를 완성본이 아니라 **원문 기준**으로 판정해야 잘림이 보인다. cleaned 는
            // 복구 헬퍼를 거치지 않은 원본 모델 출력이다.
            const jsonBalance = (text = '', openCh = '{', closeCh = '}') => {
                let depth = 0, inString = false, escaped = false;
                for (let i = 0; i < text.length; i++) {
                    const ch = text[i];
                    if (escaped) { escaped = false; continue; }
                    if (ch === '\\') { escaped = true; continue; }
                    if (ch === '"') { inString = !inString; continue; }
                    if (inString) continue;
                    if (ch === openCh) depth += 1;
                    else if (ch === closeCh) depth -= 1;
                }
                return depth;
            };
            if (!parsed) {
                const braceDepth = jsonBalance(cleaned, '{', '}');
                const bracketDepth = jsonBalance(cleaned, '[', ']');
                // depth > 0 = 덜 닫힘(잘림). depth < 0 = 과잉 닫힘(모델 오류). 둘 다 구조가 깨진 응답이다.
                const structurallyBroken = braceDepth !== 0 || bracketDepth !== 0;
                const finishReason = String(result?.finishReason || result?.streamMeta?.finishReason || '');
                const completionTokens = Number(result?.usage?.completion_tokens || result?.usage?.output_tokens || 0) || 0;
                // 끝문자만 보면 done=stop 인데 브레이스가 안 맞는 응답을 놓친다. 12-processors 가 쓰는
                // 균형 판정을 같은 목적으로 쓴다.
                const likelyTruncated = result?.truncated === true
                    || /^(?:length|max_tokens)$/i.test(finishReason)
                    || structurallyBroken
                    || !/[}\]]\s*(?:```)?\s*$/.test(cleaned.trim());
                recordRuntimeDebug('warn', '[LIBRA] User DLC JSON parse failed; JSON repair pass is retired, no second call is made.', {
                    mode: targetMode,
                    chars: cleaned.length,
                    completionTokens,
                    finishReason,
                    likelyTruncated,
                    braceDepth,
                    bracketDepth
                });
                throw new Error(`유저 DLC 분석 결과가 올바른 JSON이 아닙니다. JSON 복구는 은퇴했으므로 재시도하지 않습니다${likelyTruncated ? ' (원본 응답 잘림 의심)' : ''}${finishReason ? ` [finish=${finishReason}]` : ''}.`);
            }
            // ── 계약 완전성 검사 — 복구 패스가 없으므로 여기서 반드시 막아야 한다 ──
            // 파싱 성공은 "괄호가 맞았다"는 뜻일 뿐이다. closeUnbalancedJson 이 응답을 완성할 수 있으므로,
            // **필드가 빠진 채 잘린 응답**도 파싱에는 성공한다. 복구 호출을 은퇴시킨 이상 그 조용한 수용을
            // 막을 곳은 여기뿐이다. 실측(2026-09-27): 필드가 사라진 항목이 currentValue 없는 트래커로
            // 저장될 수 있었다(normalizeTrackerValue 가 빈 값을 돌려준다).
            // 존재 여부만 본다 — 값의 진위는 판정하지 않는다(그건 admission/oracle 의 몫이다).
            if (targetMode === 'direct' && (jsonBalance(cleaned, '{', '}') !== 0 || jsonBalance(cleaned, '[', ']') !== 0 || parsed.bundleVersion !== 1 || !Array.isArray(parsed.worldItems) || !Array.isArray(parsed.adaptiveItems) || !Array.isArray(parsed.unresolved))) throw new Error('혼합 응답이 불완전합니다. 부분 저장하지 않습니다.');
            const contractRoots = targetMode !== 'entity'
                ? ['worldItems', 'world_items']
                : ['adaptiveItems', 'adaptive_items', 'entityTrackers', 'entity_trackers', 'trackers'];
            const requiredItemKeys = targetMode !== 'entity'
                ? ['kind', 'title']
                : ['targetIds', 'kind', 'valueType', 'currentValue'];
            const contractArray = (() => {
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
                for (const root of contractRoots) {
                    if (Array.isArray(parsed[root])) return { root, items: parsed[root] };
                }
                return null;
            })();
            const incompleteItems = contractArray
                ? contractArray.items
                    .map((item, index) => ({ index, missing: item && typeof item === 'object'
                        ? requiredItemKeys.filter(key => !(key in item))
                        : ['(not an object)'] }))
                    .filter(entry => entry.missing.length)
                : [];
            if (!contractArray || incompleteItems.length) {
                const rootKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 12) : [];
                recordRuntimeDebug('warn', `[LIBRA] User DLC ${targetMode} response is structurally incomplete; JSON repair is retired, so it is rejected rather than stored partially.`, {
                    mode: targetMode,
                    expectedRoots: contractRoots,
                    presentRootKeys: rootKeys,
                    incompleteItems: incompleteItems.slice(0, 6)
                });
                const detail = !contractArray
                    ? `계약 root(${contractRoots.join('|')}) 배열이 없습니다 — 실제 keys: ${rootKeys.join(', ') || '(없음)'}`
                    : `항목 ${incompleteItems.length}개에 필수 필드가 없습니다: ${incompleteItems.slice(0, 3).map(entry => `#${entry.index} [${entry.missing.join(', ')}]`).join(' / ')}`;
                throw new Error(`유저 DLC 분석 결과가 계약을 채우지 못했습니다. JSON 복구는 은퇴했으므로 부분 저장하지 않습니다 — ${detail}`);
            }
            return {
                payload: parsed.userDlc || parsed.user_dlc || parsed,
                profile,
                turn,
                source: `user_dlc_${targetMode}_analysis`,
                rawChars: String(result?.content || '').length,
            };
        };
        const normalizeUserDlcCoverageKey = (value = '') => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
        const parseUserDlcSelectedTargetRecords = (context = {}) => {
            let records = Array.isArray(context.selectedTargetRecords) ? context.selectedTargetRecords : null;
            if (!records) {
                const raw = String(context.selectedTargets || '').trim();
                if (!raw) return [];
                try {
                    const parsed = JSON.parse(raw);
                    records = Array.isArray(parsed) ? parsed : [parsed];
                } catch (_) {
                    records = raw.split(/\r?\n/).map(line => {
                        try { return JSON.parse(line); }
                        catch (_) { return null; }
                    }).filter(Boolean);
                }
            }
            if (records.some(item => String(item?.targetType || 'entity').toLowerCase() === 'relation')) {
                throw new Error('관계 레코드는 유저 DLC 분석 대상이 아닙니다. 반응을 분석할 인물을 선택해 주세요. 관계 DB는 자동으로 근거에 포함됩니다.');
            }
            const seen = new Set();
            return records.map(item => {
                if (!item || typeof item !== 'object') return null;
                const rawIds = Array.isArray(item.targetIds) ? item.targetIds : [item.targetId || item.id];
                const targetIds = rawIds.map(value => String(value || '').trim()).filter(Boolean);
                const displayName = String(item.displayName || item.name || targetIds[0] || '').trim();
                const primaryKey = normalizeUserDlcCoverageKey(targetIds[0] || displayName);
                if (!primaryKey || seen.has(primaryKey)) return null;
                seen.add(primaryKey);
                return {
                    targetType: 'entity',
                    targetIds: targetIds.length ? [targetIds[0]] : [displayName],
                    displayName: displayName || targetIds[0],
                    promptContext: String(item.promptContext || item.entityContext || '').trim()
                };
            }).filter(Boolean);
        };
        const userDlcTargetCoverageKeys = (target = {}) => new Set([
            ...(Array.isArray(target.targetIds) ? target.targetIds : []),
            target.displayName
        ].map(normalizeUserDlcCoverageKey).filter(Boolean));
        const buildUserDlcEntityBatchContext = (context = {}, batchTargets = [], batchIndex = 0, totalBatches = 1, coverageRetry = false) => {
            const selectedTargets = batchTargets.map(item => JSON.stringify({
                targetType: 'entity', targetIds: item.targetIds, displayName: item.displayName
            })).join('\n');
            const explicitEntityContext = batchTargets.map(item => item.promptContext).filter(Boolean).join('\n\n');
            const relationRecords = Array.isArray(context.relationContextRecords) ? context.relationContextRecords : [];
            const batchKeys = new Set(batchTargets.flatMap(item => [...userDlcTargetCoverageKeys(item)]));
            const matchingRelations = relationRecords.filter(record => {
                const endpoints = Array.isArray(record?.entityIds) ? record.entityIds : [];
                return endpoints.map(normalizeUserDlcCoverageKey).some(key => key && batchKeys.has(key));
            }).slice(0, 12);
            const explicitRelationContext = matchingRelations.map(item => String(item?.promptContext || '')).filter(Boolean).join('\n\n');
            return {
                ...context,
                selectedTargets,
                selectedTargetRecords: batchTargets,
                entityContext: explicitEntityContext || String(context.entityContext || ''),
                relationContext: explicitRelationContext || (totalBatches === 1 ? String(context.relationContext || '') : ''),
                coverageRetry,
                analysisBatchLabel: `${coverageRetry ? 'coverage-retry-' : 'batch-'}${batchIndex + 1}-of-${totalBatches}`
            };
        };
        const mapUserDlcItemsToExactTargets = (payload = {}, targets = []) => {
            const candidates = payload?.adaptiveItems || payload?.adaptive_items || payload?.entityTrackers || payload?.entity_trackers || payload?.trackers || [];
            const items = Array.isArray(candidates) ? candidates : [];
            const used = new Set();
            const normalized = [];
            const missing = [];
            targets.forEach(target => {
                const targetKeys = userDlcTargetCoverageKeys(target);
                const candidateIndex = items.findIndex((item, index) => {
                    if (used.has(index) || !item || typeof item !== 'object') return false;
                    const itemKeys = [
                        ...(Array.isArray(item.targetIds) ? item.targetIds : []),
                        item.targetId, item.displayName
                    ].map(normalizeUserDlcCoverageKey).filter(Boolean);
                    return itemKeys.some(key => targetKeys.has(key));
                });
                if (candidateIndex < 0) {
                    missing.push(target);
                    return;
                }
                used.add(candidateIndex);
                normalized.push({
                    ...items[candidateIndex],
                    targetType: 'entity',
                    targetIds: [...target.targetIds],
                    displayName: target.displayName
                });
            });
            return { items: normalized, missing };
        };
        const runUserDlcDirect = (context = {}, config = MemoryEngine.CONFIG) => runUserDlcAnalysis('direct', context, config);
        const runUserDlcWorld = (context = {}, config = MemoryEngine.CONFIG) => runUserDlcAnalysis('world', context, config);
        const runUserDlcEntity = async (context = {}, config = MemoryEngine.CONFIG) => {
            config = captureWmAnalysisConfig(config);
            const targets = parseUserDlcSelectedTargetRecords(context);
            if (!targets.length) throw new Error('분석할 LIBRA 인물을 한 명 이상 지정해 주세요.');
            const batchSize = Math.max(1, Math.min(6, Number(config?.userDlcEntityBatchSize || 4) || 4));
            const batches = [];
            for (let index = 0; index < targets.length; index += batchSize) batches.push(targets.slice(index, index + batchSize));
            recordRuntimeDebug('info', '[LIBRA] User DLC multi-character analysis prepared.', {
                targetCount: targets.length,
                batchCount: batches.length,
                batchSize,
                automaticRelationEvidence: Array.isArray(context.relationContextRecords) ? context.relationContextRecords.length : 0
            });
            const adaptiveItems = [];
            let profile = '';
            let rawChars = 0;
            let repaired = false;
            let coverageRetryCount = 0;
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                const batchTargets = batches[batchIndex];
                const batchContext = buildUserDlcEntityBatchContext(context, batchTargets, batchIndex, batches.length, false);
                const primaryResult = await runUserDlcAnalysis('entity', batchContext, config);
                profile ||= primaryResult?.profile || '';
                rawChars += Number(primaryResult?.rawChars || 0) || 0;
                repaired = repaired || primaryResult?.repaired === true;
                const primaryCoverage = mapUserDlcItemsToExactTargets(primaryResult?.payload || {}, batchTargets);
                const batchItems = [...primaryCoverage.items];
                let missing = primaryCoverage.missing;
                if (missing.length) {
                    coverageRetryCount += 1;
                    recordRuntimeDebug('warn', '[LIBRA] User DLC batch omitted selected characters; retrying missing coverage once.', {
                        batch: batchIndex + 1,
                        batchCount: batches.length,
                        missingTargetIds: missing.map(item => item.targetIds[0])
                    });
                    const retryContext = buildUserDlcEntityBatchContext(context, missing, batchIndex, batches.length, true);
                    const retryResult = await runUserDlcAnalysis('entity', retryContext, config);
                    rawChars += Number(retryResult?.rawChars || 0) || 0;
                    repaired = repaired || retryResult?.repaired === true;
                    const retryCoverage = mapUserDlcItemsToExactTargets(retryResult?.payload || {}, missing);
                    batchItems.push(...retryCoverage.items);
                    missing = retryCoverage.missing;
                }
                if (missing.length) {
                    const labels = missing.map(item => item.displayName || item.targetIds[0]).join(', ');
                    throw new Error(`다중 인물 분석에서 다음 대상의 결과가 누락되었습니다: ${labels}. 누락 대상 재분석 1회도 완료되지 않아 저장을 중단했습니다.`);
                }
                const ordered = mapUserDlcItemsToExactTargets({ adaptiveItems: batchItems }, batchTargets);
                if (ordered.missing.length) {
                    const labels = ordered.missing.map(item => item.displayName || item.targetIds[0]).join(', ');
                    throw new Error(`다중 인물 분석 결과 정렬 중 대상 연결이 손실되었습니다: ${labels}. 저장을 중단했습니다.`);
                }
                adaptiveItems.push(...ordered.items);
            }
            return {
                payload: { adaptiveItems },
                profile,
                turn: Math.max(0, Number(context?.turn || MemoryEngine.getCurrentTurn?.() || MemoryState.currentTurn || 0) || 0),
                source: 'user_dlc_entity_analysis',
                rawChars,
                batchCount: batches.length,
                targetCount: targets.length,
                coverageRetryCount,
                repaired
            };
        };

        // 계약별 출력 예산을 **표에서 파생**시켜 쓰는 지점. 하드코딩을 늘리지 않고 여기서만 값을 얻는다.
        // 09c 안의 계약 밖 호출(manual/historical, turn-maintenance-bundle 등)이 이 표면을 쓴다.
        const contractOutputBudget = (worker = 'world_additional', tier = 'standard', floor = 0) => {
            const key = String(worker || 'world_additional').trim().toLowerCase();
            const tableFor = CONTRACT_OUTPUT_BUDGETS[key] || CONTRACT_OUTPUT_BUDGETS.canonical_packet;
            return Math.max(Number(floor) || 0, tableFor[tier] || tableFor.standard);
        };

        return { buildCommittedExtensionBatches,
            run,
            runUnified,
            runCommittedExtensions,
            verifyExtensionResultGuard,
            runUserDlcTrackerUpdates,
            runWorldAdditionalTurnUpdates,
            runWorldAdditionalManual,
            runWorldAdditionalHistorical,
            runUserDlcWorld,
            runUserDlcDirect,
            runUserDlcEntity,
            getAnalysisExecutionPlan: (payload = {}, worker = 'canonical_packet', options = {}) => ({ ...resolveTurnAnalysisOutputBudget(payload, worker, options) }),
            getContractOutputBudget: (worker = 'world_additional', tier = 'standard', floor = 0) => contractOutputBudget(worker, tier, floor)
        };
    })();
