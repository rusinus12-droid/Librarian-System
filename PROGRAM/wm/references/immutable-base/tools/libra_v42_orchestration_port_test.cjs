#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(async () => {

const ROOT = path.resolve(__dirname, '..');
const PARTS_DIR = path.join(ROOT, 'src', 'parts');
const OUT_DIR = path.join(ROOT, 'test-output');
const OUT_PATH = path.join(OUT_DIR, 'libra-v42-orchestration-port-test.json');

const source09 = fs.readdirSync(PARTS_DIR)
  .filter(name => /^09(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'))
  .join('\n');
const source05 = fs.readdirSync(PARTS_DIR)
  .filter(name => /^05(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'))
  .join('');
const source13 = fs.readdirSync(PARTS_DIR)
  .filter(name => /^13(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'))
  .join('');
const source02 = fs.readdirSync(PARTS_DIR)
  .filter(name => /^02(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'))
  .join('');
const combined = `${source02}\n${source09}\n${source05}\n${source13}`;

const checks = [];
const check = (name, ok, detail = null) => checks.push({ name, ok: !!ok, detail: detail == null ? null : String(detail) });
const contains = (needle) => combined.includes(needle);

// Static contract: only orchestration is ported. Current storage, relation,
// Resource Governor, and one-call maintenance architecture must remain intact.
check('scene_contract_v2_present', contains("schema: 'libra.scene_contract.v2'"));
check('narrative_diagnostics_v2_present', contains("schema: 'libra.narrative_diagnostics.v2'"));
check('story_author_v2_present', contains("schema: 'libra.story_author.v2'"));
check('director_v2_present', contains("schema: 'libra.director.v2'"));
check('planner_provenance_v2_present', contains("schema: 'libra.planner_provenance.v2'"));
check('planner_refresh_modes_present', contains('resolveRefreshModes') && contains("new Set(['full', 'light', 'reuse'])"));
check('scene_phase_alias_normalization_present', contains('const normalizeScenePhase') && contains("return 'escalation'"));
check('active_participants_use_current_turn_mentions', contains('const mentionedParticipants') && contains('activeParticipants = explicitParticipants.length'));
check('author_director_handoff_present', contains('validateDirectorHandoff') && contains('buildAuthorPlanInputs'));
check('story_author_authority_boundary_present', contains('Story Author owns narrative meaning'));
check('director_authority_boundary_present', contains('Director owns execution only'));
check('remembered_dialogue_adaptation_present', /remembered dialogue|memory dialogue|대사.*적응/i.test(combined));
// 스냅샷 롤백 모듈(05/05a~05d)이 삭제되어 source_assistant_superseded 같은
// 사유 라벨은 사라졌다. 플래너 무효화 API 자체는 09 트래커에 살아 있어야 한다.
check('planner_invalidation_on_supersede_present', source09.includes('invalidateBySourceIds'));
check('scene_contract_direct_injection_present', /key: 'sceneContract'[\s\S]{0,180}priority: sceneContractPrompt \? 'required'/.test(source13));
check('diagnostics_direct_injection_present', /key: 'narrativeDiagnostics'[\s\S]{0,220}priority: narrativeDiagnosticsPrompt \? 'conditional'/.test(source13));
check('orchestration_injection_respects_existing_feature_switches', source13.includes('const narrativeOrchestrationEnabled') && source13.includes('storyAuthorEnabled === true') && source13.includes('directorEnabled === true'));
check('request_time_scene_contract_rebuilt_from_live_user', source13.includes('const currentOrchestrationPayload') && source13.includes('userMsg: userMessage') && source13.includes('NarrativeOrchestrationCore.buildSceneContract?.(currentOrchestrationPayload)'));
check('request_time_diagnostics_rebuilt_from_live_context', source13.includes('NarrativeOrchestrationCore.buildNarrativeDiagnostics?.(currentOrchestrationPayload, activeSceneContract)'));
check('request_time_contract_does_not_mutate_planner_runtime_cache', source13.includes('recordRuntime: false') && source09.includes("if (payload?.recordRuntime !== false) lastSceneContract = clone(contract)") && source09.includes("if (payload?.recordRuntime !== false) lastNarrativeDiagnostics = clone(diagnostics)"));
check('stored_scene_contract_not_selected_as_current_request', !source13.includes("StoryAuthor.getState?.()?.sceneContract || Director.getState?.()?.sceneContract"));
check('story_author_prompt_does_not_embed_stale_contract', !source09.includes('formatSceneContractForPrompt(authorState.sceneContract)') && !source09.includes('formatDiagnosticsForPrompt(authorState.narrativeDiagnostics)'));
check('unified_turn_maintenance_call_preserved', source09.includes("reason: 'turn-maintenance-bundle'") || source09.includes('turn-maintenance-bundle'));
check('no_new_story_author_llm_reason', !/reason:\s*['"]story-author(?:-|_)/i.test(source09));
check('no_new_director_llm_reason', !/reason:\s*['"]director(?:-|_)/i.test(source09));
const source08 = fs.readdirSync(PARTS_DIR)
  .filter(name => /^08(?:-|[a-z]).*\.js$/i.test(name))
  .sort()
  .map(name => fs.readFileSync(path.join(PARTS_DIR, name), 'utf8'))
  .join('');
check('planner_invalidation_on_delete_present', source08.includes("'retracted'") && source09.includes('invalidateBySourceIds'));
check('current_relation_model_not_replaced', source08.includes('retractRelationTimelineEvents') && source08.includes('relationTimeline'));
check('resource_governor_not_duplicated_in_port', (source09.match(/const ResourceGovernor\s*=/g) || []).length === 0);
check('planner_load_does_not_merge_previous_scope_state', !source09.includes('normalizeState({ ...authorState, ...JSON.parse') && !source09.includes('normalizeState({ ...directorState, ...JSON.parse'));
check('orchestration_runtime_cache_can_clear', source09.includes("lastSceneContract = value && typeof value === 'object' ? clone(value) : null") && source09.includes("lastNarrativeDiagnostics = value && typeof value === 'object' ? clone(value) : null"));
check('reuse_preserves_generation_provenance', source09.includes('lastObservedSourceMessageIds: provenance.sourceMessageIds || []') && !/\.\.\.authorState\.plannerMeta,\s*\.\.\.provenance,\s*status: 'active'[\s\S]{0,120}refreshMode: 'reuse'/.test(source09));
check('planner_derivatives_are_feature_gated', source09.includes('const plannerOrchestrationActive = storyAuthorActive || directorActive') && source09.includes('if (plannerOrchestrationActive)') && source09.includes('plannerOrchestrationActive ? recentTurns.slice(-6) : []'));
check('maintenance_schema_omits_disabled_planners', source09.includes('getMaintenanceResponseShape = (includeRpLongTermLlm = false, includeWorldAdditional = false, includeStoryAuthor = false, includeDirector = false, includeUserDlcTrackers = false)') && source09.includes('if (includeStoryAuthor)') && source09.includes('if (includeDirector)'));
check('user_dlc_tracker_has_dedicated_profile_worker', source09.includes('const runUserDlcTrackerUpdates') && source09.includes("resolveAnalysisProfile(config, 'userDlcTrackerAnalysis', 'primary')") && source09.includes("reason: 'user-dlc-tracker-analysis'"));
check('user_dlc_manual_analysis_has_dedicated_profile_routes', source09.includes("targetMode === 'entity' ? 'userDlcEntityAnalysis' : 'userDlcWorldAnalysis'") && source09.includes('LLMProvider.isConfigured(config, resolvedProfile)'));
try {
  const routing = await require('./libra_dlc_routing_contract.cjs').verifyDlcRouting();
  check('user_dlc_tracker_has_separate_output_and_profile_route', true, JSON.stringify(routing));
} catch (error) {
  check('user_dlc_tracker_has_separate_output_and_profile_route', false, error?.stack || String(error));
}
check('user_dlc_tracker_parallel_path_keeps_separate_profile_call', source09.includes('Promise.allSettled([packetTask, maintenanceTask, trackerTask])') && source09.includes('runUserDlcTrackerUpdates(currentTurn, turnState, aiResponse, effectiveLore, config, payload)'));
check('world_additional_parallel_path_uses_dedicated_lightweight_worker', source09.includes('const runWorldAdditionalTurnUpdates') && source09.includes("reason: 'world-additional-turn-analysis'") && source09.includes('runWorldAdditionalTurnUpdates(currentTurn, turnState, aiResponse, effectiveLore, config, payload)'));
check('parallel_auxiliary_results_reused_during_serial_fallback', source09.includes('__analysisShared') && source09.includes('shared.worldAdditionalResolved = true') && source09.includes('parallel-result-reused-in-fallback'));
check('user_dlc_tracker_updates_are_evidence_db_compatibility_gated_and_failure_isolated', source09.includes('trackerEvidenceSupportedByAssistant') && source09.includes("!['compatible', 'explicit_transition'].includes(update.dbCompatibility)") && source05.includes('User DLC tracker update isolated; other maintenance will continue'));
check('user_dlc_conflicted_items_are_runtime_blocked', source09.includes("reason: 'canon_conflict'") && source09.includes("item.canonCompatibility?.status || 'unverified') !== 'conflicted'"));
check('active_user_dlc_has_user_authority_and_mandatory_execution_contract', source13.includes('active User DLC is persisted user input, not reference data') && source13.includes('has user-level priority') && source13.includes('compatible active entries are mandatory'));
check('user_dlc_canon_adaptation_does_not_silently_mutate_libra_db', source13.includes('must not silently mutate canonical LIBRA DB') && source09.includes('They are never evidence for canonicalPacket'));
check('user_dlc_tracker_state_is_saved_in_final_locked_commit', source05.includes('UserDlcCore.applyTrackerUpdates') && source05.includes('if (userDlcStateLoaded) await UserDlcCore.saveState'));
check('user_dlc_tracker_json_contract_accepts_update_array', source02.includes("'userDlcTrackerUpdates', 'user_dlc_tracker_updates'") && source02.includes('!hasArrayShape(parsed.userDlcTrackerUpdates)'));
check('world_views_formatted_once_per_maintenance_payload', source09.includes('const worldPromptText = HierarchicalWorldManager.formatForPrompt()') && source09.includes('worldPrompt: worldPromptText') && !source09.includes('worldPrompt: HierarchicalWorldManager.formatForPrompt()'));

// Extract and execute only the new orchestration core with minimal current-engine
// adapters. This validates behavior instead of checking strings alone.
const startMarker = 'const NarrativeOrchestrationCore = (() => {';
const endMarker = '\n    try {\n        if (typeof globalThis !== \'undefined\') globalThis.LIBRA_NarrativeOrchestrationCore';
const start = source09.indexOf(startMarker);
const end = source09.indexOf(endMarker, start);
let dynamicError = null;
let dynamic = {};
try {
    if (start < 0 || end < 0) throw new Error('orchestration core extraction markers not found');
    const assignmentPrefix = 'const NarrativeOrchestrationCore = ';
    const expression = source09.slice(start + assignmentPrefix.length, end).trim().replace(/;$/, '');
    const stableHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
    const dedupeTextArray = (items = []) => {
        const seen = new Set();
        const out = [];
        for (const item of Array.isArray(items) ? items : []) {
            const text = String(item || '').trim();
            if (!text) continue;
            const key = text.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(text);
        }
        return out;
    };
    const normalizeCanonicalMessageIds = (value) => {
        const out = [];
        const visit = (item) => {
            if (item == null) return;
            if (Array.isArray(item)) return item.forEach(visit);
            if (typeof item === 'object') {
                visit(item.id); visit(item.messageId); visit(item.m_id);
                visit(item.sourceMessageIds); visit(item.liveMessageIds);
                return;
            }
            const text = String(item).trim();
            if (text && !out.includes(text)) out.push(text);
        };
        visit(value);
        return out;
    };
    const truncateForLLM = (value, max = 220, suffix = ' ... ') => {
        const text = String(value || '');
        return text.length <= max ? text : `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
    };

    const StoryAuthor = {
        state: {
            currentArc: 'Hidden succession dispute',
            narrativeGoal: 'Reveal the forged letter without resolving the culprit',
            scenePhase: 'development',
            activeTensions: ['The forged letter may expose the regent'],
            openQuestions: ['Who forged the letter?'],
            payoffCandidates: ['The seal mismatch'],
            recommendedBeatType: 'reveal',
            nextBeats: ['Reveal the seal mismatch'],
            doNotResolveYet: ['Who forged the letter?'],
            guardrails: ['Do not expose the protected witness'],
            lastPlanTurn: 9,
            plannerMeta: {
                status: 'active',
                contextSignature: 'previous-context',
                sceneContractSignature: 'previous-scene'
            }
        },
        getState() { return this.state; }
    };
    const Director = {
        state: { sceneMandate: 'Stage the letter inspection', lastTurn: 9, plannerMeta: StoryAuthor.state.plannerMeta },
        getState() { return this.state; }
    };
    const MemoryEngine = { CONFIG: { directorMode: 'strong' }, getCurrentTurn: () => 10 };
    const WorldStateTracker = { getState: () => ({ currentLocation: 'Council archive' }) };
    const TimeEngine = { getState: () => ({ currentDate: 'Day 12', currentTime: 'Night' }) };
    const NarrativeTracker = { getState: () => ({ storylines: [{ ongoingTensions: ['The witness remains hidden'] }] }) };
    const TokenizerEngine = { simpleHash: stableHash };

    const factory = new Function(
        'truncateForLLM', 'dedupeTextArray', 'normalizeCanonicalMessageIds',
        'TokenizerEngine', 'MemoryEngine', 'WorldStateTracker', 'TimeEngine',
        'NarrativeTracker', 'StoryAuthor', 'Director',
        `"use strict"; return (${expression});`
    );
    const core = factory(
        truncateForLLM, dedupeTextArray, normalizeCanonicalMessageIds,
        TokenizerEngine, MemoryEngine, WorldStateTracker, TimeEngine,
        NarrativeTracker, StoryAuthor, Director
    );

    const payload = {
        turn: 10,
        userMsg: '“그 편지의 인장을 다시 보여줘.”',
        sourceMessageIds: ['assistant-10'],
        focusedEntities: ['세영', '마리'],
        relationStateSignals: ['세영→마리 trust 0.31, tension 0.78'],
        activeWorldRules: ['Council archives cannot be altered after midnight'],
        protectedSecrets: ['The witness identity'],
        recentTurns: [
            '세영은 편지를 바라보며 숨을 골랐다.',
            '세영은 편지를 바라보며 숨을 골랐다.',
            '마리는 편지를 바라보며 침묵했다.',
            '마리는 편지를 바라보며 침묵했다.'
        ],
        stateChangeSignals: []
    };
    const contract = core.buildSceneContract(payload);
    const diagnostics = core.buildNarrativeDiagnostics({ ...payload, scenePhase: 'investigation_to_confrontation' }, contract);
    const authorPlan = {
        ...StoryAuthor.state,
        sceneContract: contract,
        narrativeDiagnostics: diagnostics
    };
    const handed = core.validateDirectorHandoff({
        executionMode: 'forceful',
        beatTypeToExecute: 'reveal',
        requiredOutcomes: ['Who forged the letter?'],
        stagingInstructions: ['Place the letter under the archive lamp']
    }, authorPlan, { sceneContract: contract, narrativeDiagnostics: diagnostics }, MemoryEngine.CONFIG);
    const refresh = core.resolveRefreshModes({
        ...payload,
        sceneContract: contract,
        narrativeDiagnostics: diagnostics,
        mutationReasons: ['relation_projection_changed']
    }, 10, MemoryEngine.CONFIG);
    const oocContract = core.buildSceneContract({ ...payload, userMsg: 'OOC: 편지는 위조가 아니야. 설정을 정정해.', turn: 11 });
    const oocDiagnostics = core.buildNarrativeDiagnostics({ ...payload, userMsg: 'OOC: 편지는 위조가 아니야. 설정을 정정해.', turn: 11 }, oocContract);
    const oocRefresh = core.resolveRefreshModes({ ...payload, turn: 11, userMsg: 'OOC: 편지는 위조가 아니야. 설정을 정정해.', sceneContract: oocContract, narrativeDiagnostics: oocDiagnostics }, 11, MemoryEngine.CONFIG);

    dynamic = { contract, diagnostics, handed, refresh, oocRefresh };
    check('dynamic_scene_contract_schema', contract.schema === 'libra.scene_contract.v2', contract.schema);
    check('dynamic_scene_contract_preserves_source_id', contract.sourceMessageIds.includes('assistant-10'), JSON.stringify(contract.sourceMessageIds));
    check('dynamic_scene_contract_has_user_agency_lock', contract.userAgencyLocks.some(line => /consent|동의|agency/i.test(line)), contract.userAgencyLocks.join(' | '));
    check('dynamic_diagnostics_detects_repetition', Number(diagnostics.repetitionRisk || 0) >= 0.58, diagnostics.repetitionRisk);
    check('dynamic_scene_phase_alias_maps_to_enum', diagnostics.scenePhase === 'escalation', diagnostics.scenePhase);
    check('dynamic_director_inherits_author_inputs', handed.authorPlanInputs.some(line => line === 'beat:reveal') && handed.authorPlanInputs.some(line => /^preserve:/.test(line)), handed.authorPlanInputs.join(' | '));
    check('dynamic_director_filters_preserved_resolution', !handed.requiredOutcomes.some(line => /Who forged the letter/i.test(line)), handed.requiredOutcomes.join(' | '));
    check('dynamic_director_adds_continuity_locks', handed.continuityLocks.some(line => /Preserve unresolved thread/i.test(line)), handed.continuityLocks.join(' | '));
    check('dynamic_mutation_forces_full_refresh', refresh.storyAuthor === 'full' && refresh.director === 'full', JSON.stringify(refresh));
    check('dynamic_ooc_forces_full_refresh', oocRefresh.storyAuthor === 'full' && oocRefresh.director === 'full', JSON.stringify(oocRefresh));
    check('dynamic_prompt_formatter_is_compact', core.formatSceneContractForPrompt(contract).length < 4000 && core.formatDiagnosticsForPrompt(diagnostics).length < 4000);
} catch (error) {
    dynamicError = error && error.stack ? error.stack : String(error);
    check('dynamic_orchestration_core_executes', false, dynamicError);
}

const failed = checks.filter(item => !item.ok);
const result = {
    ok: failed.length === 0,
    checks,
    failedCount: failed.length,
    dynamicError,
    dynamicSummary: dynamicError ? null : {
        sceneContractSchema: dynamic.contract?.schema,
        diagnosticsSchema: dynamic.diagnostics?.schema,
        repetitionRisk: dynamic.diagnostics?.repetitionRisk,
        refresh: dynamic.refresh ? { storyAuthor: dynamic.refresh.storyAuthor, director: dynamic.refresh.director, reasons: dynamic.refresh.reasons } : null,
        oocRefresh: dynamic.oocRefresh ? { storyAuthor: dynamic.oocRefresh.storyAuthor, director: dynamic.oocRefresh.director, reasons: dynamic.oocRefresh.reasons } : null,
        directorBeat: dynamic.handed?.beatTypeToExecute,
        authorPlanInputs: dynamic.handed?.authorPlanInputs
    },
    checkedAt: new Date().toISOString()
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

})().catch(error => { console.error(error); process.exitCode = 1; });
