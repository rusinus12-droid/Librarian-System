'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
function clone(v){ return v == null ? v : JSON.parse(JSON.stringify(v)); }
function assert(name, ok, details={}){ return { name, ok: !!ok, details }; }

async function loadPlugin(args = {}) {
  let code = fs.readFileSync(DIST, 'utf8');
  const exportSnippet = `\n;globalThis.__LIBRA_WA_TEST__={\n  TypedRecallRollout,\n  MemoryEngine: typeof MemoryEngine !== 'undefined' ? MemoryEngine : null,\n  WorldAdditionalCore: typeof WorldAdditionalCore !== 'undefined' ? WorldAdditionalCore : null,\n  UserDlcCore: typeof UserDlcCore !== 'undefined' ? UserDlcCore : null,\n  NarrativeTracker: typeof NarrativeTracker !== 'undefined' ? NarrativeTracker : null,\n  Director: typeof Director !== 'undefined' ? Director : null,\n  StoryAuthor: typeof StoryAuthor !== 'undefined' ? StoryAuthor : null,\n  TurnMaintenanceOptimizer: typeof TurnMaintenanceOptimizer !== 'undefined' ? TurnMaintenanceOptimizer : null,\n  LLMProvider: typeof LLMProvider !== 'undefined' ? LLMProvider : null\n};\n`;
  const idx = code.lastIndexOf('\n})();');
  if (idx >= 0) code = code.slice(0, idx) + exportSnippet + code.slice(idx);
  else code += exportSnippet;

  const replacers = { beforeRequest: [], afterRequest: [] };
  const pluginStorage = new Map();
  const chat = { id:'chat-wa', name:'wa', localLore:[], msgs:[], message:[], isStreaming:false };
  const char = { id:'char-wa', name:'WA Character', chatPage:0, chats:[chat], lorebook:[
    { key:'ariel', comment:'', content:'아리엘: 달그림자 도서관의 기록관리자. 도현을 도울 수 있는 정본 조력자.', alwaysActive:false },
    { key:'mira', comment:'', content:'미라: 시계탑 관측실의 장치 기술자. 관측 장치를 수리한다.', alwaysActive:false }
  ] };
  const allArgs = {
    debug:'false', llm_key:'dummy-key', llm_url:'http://mock.local/v1/chat/completions', llm_model:'mock',
    embedding_enabled:'false', aux_llm_enabled:'false', world_additional_enabled:'true', world_additional_mode:'firm',
    world_additional_max_per_request:'3', world_additional_auto_integrate:'true',
    world_canon_custom_text:'', world_canon_custom_force:'true',
    world_additional_custom_text:'', world_additional_custom_force:'true', use_lorebook_rag:'true',
    ...args
  };
  const risuai = {
    apiVersion:'3.0-test',
    async getRuntimeInfo(){ return { apiVersion:'3.0-test', platform:'node-test', saveMethod:'mock' }; },
    async getArgument(name){ return allArgs[name]; },
    async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); },
    async getCurrentCharacterIndex(){ return 0; },
    async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); },
    async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(_ci,_ti,next){ Object.assign(chat, clone(next)); return true; },
    async setCharacter(next){ Object.assign(char, clone(next)); return true; },
    async addRisuReplacer(type, handler){ (replacers[type] || (replacers[type]=[])).push(handler); return true; },
    async removeRisuReplacer(type, handler){ replacers[type]=(replacers[type]||[]).filter(h=>h!==handler); return true; },
    async addRisuScriptHandler(){ return true; }, async removeRisuScriptHandler(){ return true; },
    async registerBodyIntercepter(){ return 'body-1'; }, async unregisterBodyIntercepter(){ return true; },
    async onUnload(){ return true; }, async registerSetting(){ return true; }, async registerButton(){ return true; },
    async showContainer(){ return true; }, async hideContainer(){ return true; },
    async getDatabase(){ return { personas:[], selectedPersona:null, modules:[], enabledModules:[], moduleIntergration:[], characters:[clone(char)] }; },
    pluginStorage:{ async getItem(k){ return pluginStorage.has(k)?pluginStorage.get(k):null; }, async setItem(k,v){ pluginStorage.set(k,String(v)); return true; }, async removeItem(k){ pluginStorage.delete(k); return true; } },
    safeLocalStorage:{ async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return { async getItem(){ return null; }, async setItem(){ return true; } }; },
    async nativeFetch(){ throw new Error('not used'); }
  };
  const logs = [];
  const context = {
    console: { log:(...a)=>logs.push(['log',...a.map(String)]), warn:(...a)=>logs.push(['warn',...a.map(String)]), error:(...a)=>logs.push(['error',...a.map(String)]), debug:()=>{} },
    setTimeout, clearTimeout, setInterval, clearInterval, performance, crypto:{ randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('fetch should not be called'); }, risuai, Risuai: risuai, globalThis:null, process:{env:{}},
    atob:(s)=>Buffer.from(String(s),'base64').toString('binary'), btoa:(s)=>Buffer.from(String(s),'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  let evalError = '';
  try { const result = vm.runInContext(code, context, { filename:DIST, timeout:10000 }); if (result && typeof result.then === 'function') await result; }
  catch(e){ evalError = e?.stack || e?.message || String(e); }
  await new Promise(r => setTimeout(r, 50));
  return { context, core: context.__LIBRA_WA_TEST__?.WorldAdditionalCore, userDlc: context.__LIBRA_WA_TEST__?.UserDlcCore, optimizer: context.__LIBRA_WA_TEST__?.TurnMaintenanceOptimizer, provider: context.__LIBRA_WA_TEST__?.LLMProvider, engine: context.__LIBRA_WA_TEST__?.MemoryEngine, evalError, logs, replacers, char, chat };
}

(async()=>{
  const env = await loadPlugin();
  const core = env.core;
  const userDlc = env.userDlc;
  const optimizer = env.optimizer;
  const provider = env.provider;
  const engine = env.engine;
  const assertions = [];
  assertions.push(assert('plugin_eval_no_error', !env.evalError, { error: env.evalError }));
  assertions.push(assert('world_additional_core_exported', !!core, {}));
  assertions.push(assert('user_dlc_core_exported', !!userDlc, {}));
  assertions.push(assert('turn_maintenance_optimizer_exported_for_profile_test', !!optimizer && !!provider, {}));
  assertions.push(assert('config_enabled_firm', engine?.CONFIG?.worldAdditionalEnabled === true && engine?.CONFIG?.worldAdditionalMode === 'firm', engine?.CONFIG ? { enabled: engine.CONFIG.worldAdditionalEnabled, mode: engine.CONFIG.worldAdditionalMode } : {}));

  const storedTargetLore = [
    { key:'entity-ariel', comment:'lmai_entity', content:JSON.stringify({ id:'entity-ariel', name:'아리엘', type:'npc' }) },
    { key:'relation-ariel-dohyeon', comment:'lmai_relation', content:JSON.stringify({ id:'relation-ariel-dohyeon', entityA:'아리엘', entityB:'도현', relationType:'협력 관계' }) }
  ];
  const storedEntityTargets = userDlc.listEntityTargets(storedTargetLore);
  const storedRelationTargets = userDlc.listRelationTargets(storedTargetLore);
  assertions.push(assert('user_dlc_target_lists_fallback_to_stored_entity_relation_db', storedEntityTargets.some(item => item.id === 'entity-ariel' && item.displayName === '아리엘') && storedRelationTargets.some(item => item.id === 'relation-ariel-dohyeon' && /아리엘.*협력 관계.*도현/.test(item.displayName)), { storedEntityTargets, storedRelationTargets }));
  const originalEntityBlocklist = clone(engine.CONFIG.entityBlocklist || []);
  engine.CONFIG.entityBlocklist = ['아리엘'];
  const blockedEntityTargets = userDlc.listEntityTargets(storedTargetLore);
  const blockedRelationTargets = userDlc.listRelationTargets(storedTargetLore);
  const blockedTracker = userDlc.registerEntityTracker({
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'state', label:'차단 검증',
    instruction:'차단된 인물은 분석하거나 투입하지 않는다.', valueType:'status', allowedValues:['unknown','active'],
    currentValue:'active', trackingEnabled:true, useEnabled:true
  }, { turn:1 }).item;
  const blockedInjectionPrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 3200);
  const blockedAnalysisPrompt = userDlc.formatTrackersForAnalysis(['아리엘'], 3200);
  assertions.push(assert('entity_blocklist_excludes_user_dlc_targets_relations_and_prompts',
    !blockedEntityTargets.some(item => item.displayName === '아리엘')
    && !blockedRelationTargets.some(item => /아리엘/.test(item.displayName))
    && userDlc.isTargetBlocked(blockedTracker, storedTargetLore) === true
    && blockedInjectionPrompt === ''
    && blockedAnalysisPrompt === '',
    { blockedEntityTargets, blockedRelationTargets, blockedTracker, blockedInjectionPrompt, blockedAnalysisPrompt }));
  engine.CONFIG.entityBlocklist = originalEntityBlocklist;
  userDlc.resetState();

  const config = { ...engine.CONFIG, worldAdditionalEnabled:true, worldAdditionalMode:'firm', worldAdditionalMaxPerRequest:3, worldAdditionalAutoIntegrate:true };
  const originalProviderCall = provider.call;
  const originalProviderConfigured = provider.isConfigured;
  const originalProviderHealthy = provider.isProfileHealthy;
  const routedProfiles = [];
  const userDlcSystems = [];
  const userDlcTrackerSystems = [];
  const userDlcCallOptions = [];
  provider.isConfigured = () => true;
  provider.isProfileHealthy = () => true;
  provider.call = async (_config, _system, _user, options = {}) => {
    routedProfiles.push({ reason:options.reason, profile:options.profile });
    if (/^user-dlc-(?:world|entity)-analysis$/.test(options.reason || '')) {
      userDlcSystems.push(_system);
      userDlcCallOptions.push(options);
    }
    if (options.reason === 'user-dlc-tracker-analysis') {
      userDlcTrackerSystems.push(_system);
      return { content:JSON.stringify({ userDlcTrackerUpdates:[{ trackerId:'tracker-profile-test', value:'possible', confidence:'possible', evidence:['직접 근거'], reason:'프로필 테스트', dbCompatibility:'compatible', dbConflicts:[], relevant:true }] }), usage:{} };
    }
    if (options.reason === 'user-dlc-entity-analysis') return { content:JSON.stringify({ adaptiveItems:[{ targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'scenario_response', label:'현재 제안 반응', instruction:'현재 관계와 말투에 근거한다.', valueType:'text', currentValue:'정중한 거절', currentSnapshot:{ relationshipState:'제한적 신뢰', expectedResponse:'정중히 거절한다.', dialogueExamples:['아직은 어려워요.'] }, scenarioBands:[], trackingEnabled:false, useEnabled:true, updateMode:'manual', eventResolutionMode:'none', evidence:['LIBRA Entity DB'], reason:'프로필 테스트' }] }), usage:{} };
    return { content:JSON.stringify({ worldItems:[{ kind:'tool', title:'프로필 라우팅 도구', userConcept:'테스트', adaptedConcept:'세계 적응 테스트 도구', sourceBasis:['현재 세계'], status:'armed' }] }), usage:{} };
  };
  const profileConfig = { ...config, nsfwMode:'explicit', nsfwEnabled:true, nsfwGuidancePromptEnabled:true, assistantPrefillEnabled:true, llmRouting:{ ...(config.llmRouting || {}), userDlcWorldAnalysis:'dlc_deep', userDlcEntityAnalysis:'dlc_deep', userDlcTrackerAnalysis:'dlc_deep' } };
  const routedWorld = await optimizer.runUserDlcWorld({ turn:7, userConcept:'프로필 라우팅을 검사할 도구', characterWorldSources:'테스트 세계', worldPrompt:'테스트 세계 규칙' }, profileConfig);
  const routedEntity = await optimizer.runUserDlcEntity({ turn:7, selectedTargets:'{"targetType":"entity","targetIds":["entity-ariel"],"displayName":"아리엘"}', analysisPrompt:'현재 관계에서 고백 반응을 보여 줘.', entityContext:'아리엘: 기록관리자', storyClock:'{"currentDate":"2026-07-03"}', worldPrompt:'테스트 세계 규칙' }, profileConfig);
  const routedTracker = await optimizer.runUserDlcTrackerUpdates(7, {}, '직접 근거가 드러났다.', [], profileConfig, { turn:7, assistantEvidenceText:'직접 근거가 드러났다.', userDlcTrackersActive:true, userDlcTrackerPrompt:'{"trackerId":"tracker-profile-test","allowedValues":["unknown","possible"]}' });
  // 케이스 A(대조군): 최상위 root 의 닫는 괄호 하나만 부족하고 **내용은 완전**한 응답.
  //   복구 헬퍼가 완성하므로 수용되는 것이 맞다 — 이걸 막으면 c24ef6a 의 실제 개선(1/8 → 8/8)을 되돌린다.
  // 케이스 B(결함): 괄호가 부족하고 **필드까지 빠진** 응답. 파싱에는 성공하지만 계약을 못 채운다.
  //   복구 호출을 은퇴시켰으므로 이것이 조용히 저장되면 안 된다.
  const truncationCalls = [];
  let truncationCase = 'brace_only';
  provider.call = async (_config, _system, _user, options = {}) => {
    truncationCalls.push({ reason:options.reason, options });
    if (truncationCase === 'brace_only') {
      return { content:'{"adaptiveItems":[{"targetType":"entity","targetIds":["entity-ariel"],"displayName":"아리엘","kind":"state","label":"괄호만 부족","instruction":"현재 정본을 따른다.","valueType":"text","currentValue":"정상 수용되어야 함"}', usage:{ completion_tokens:2000 }, finishReason:'length', truncated:true };
    }
    return { content:'{"adaptiveItems":[{"targetType":"entity","targetIds":["entity-ariel"]', usage:{ completion_tokens:2000 }, finishReason:'length', truncated:true };
  };
  const runTruncationCase = async (which) => {
    truncationCase = which;
    truncationCalls.length = 0;
    try {
      const result = await optimizer.runUserDlcEntity({ turn:8, selectedTargets:'{"targetType":"entity","targetIds":["entity-ariel"],"displayName":"아리엘"}', analysisPrompt:'현재 상태를 추가해 줘.', entityContext:'아리엘: 기록관리자' }, profileConfig);
      const item = result?.payload?.adaptiveItems?.[0];
      return {
        outcome: item?.currentValue ? `accepted:${item.currentValue}` : 'accepted_without_value',
        calls: truncationCalls.filter(call => call.reason === 'user-dlc-entity-analysis').length,
        repairCalls: truncationCalls.filter(call => /json-repair/.test(call.reason || '')).length
      };
    } catch (error) {
      return {
        outcome: `rejected:${String(error?.message || error)}`,
        calls: truncationCalls.filter(call => call.reason === 'user-dlc-entity-analysis').length,
        repairCalls: truncationCalls.filter(call => /json-repair/.test(call.reason || '')).length
      };
    }
  };
  const braceOnlyResult = await runTruncationCase('brace_only');
  const missingFieldsResult = await runTruncationCase('missing_fields');
  // 대조군: 잘리지 않은 정상 응답은 그대로 통과해야 한다(복구 패스 제거가 정상 응답을 막지 않았는지).
  const healthyCalls = [];
  provider.call = async (_config, _system, _user, options = {}) => {
    healthyCalls.push({ reason:options.reason });
    return { content:JSON.stringify({ adaptiveItems:[{ targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'state', label:'정상 상태', instruction:'현재 정본을 따른다.', valueType:'text', currentValue:'정상 수용', trackingEnabled:false, useEnabled:true }] }), usage:{ completion_tokens:180 }, finishReason:'stop' };
  };
  let healthyOutcome = 'resolved';
  try {
    const healthyEntity = await optimizer.runUserDlcEntity({ turn:8, selectedTargets:'{"targetType":"entity","targetIds":["entity-ariel"],"displayName":"아리엘"}', analysisPrompt:'현재 상태를 추가해 줘.', entityContext:'아리엘: 기록관리자' }, profileConfig);
    healthyOutcome = `accepted:${healthyEntity?.payload?.adaptiveItems?.[0]?.currentValue || 'no_value'}`;
  } catch (healthyError) {
    healthyOutcome = `rejected:${String(healthyError?.message || healthyError)}`;
  }
  const multiCharacterCalls = [];
  const multiCharacterNames = { 'entity-a':'A', 'entity-b':'B', 'entity-c':'C', 'entity-d':'D', 'entity-e':'E' };
  provider.call = async (_config, _system, _user, options = {}) => {
    const user = String(_user || '');
    const targetIds = [...user.matchAll(/"targetIds":\["([^"]+)"\]/g)].map(match => match[1]);
    const coverageRetry = user.includes('[Coverage retry]');
    multiCharacterCalls.push({ reason:options.reason, targetIds, coverageRetry, user, options });
    const emittedIds = !coverageRetry && targetIds.includes('entity-a') && targetIds.includes('entity-b')
      ? targetIds.filter(id => id !== 'entity-b')
      : targetIds;
    return { content:JSON.stringify({ adaptiveItems:emittedIds.map(id => ({
      targetType:'entity', targetIds:[id], displayName:multiCharacterNames[id], kind:'scenario_response',
      label:'관계 기반 반응', instruction:'LIBRA 관계 DB를 근거로 반응한다.', valueType:'text', currentValue:`${multiCharacterNames[id]} 반응`,
      currentSnapshot:{ relationshipState:'관계 근거 반영', expectedResponse:`${multiCharacterNames[id]}의 예상 반응`, dialogueExamples:[] },
      scenarioBands:[], trackingEnabled:false, useEnabled:true, updateMode:'manual', eventResolutionMode:'none', evidence:['LIBRA Relation DB'], reason:'다중 인물 테스트'
    })) }), usage:{ completion_tokens:240 }, finishReason:'stop' };
  };
  const multiCharacterTargets = Object.entries(multiCharacterNames).map(([id, displayName]) => ({
    targetType:'entity', targetIds:[id], displayName, promptContext:`ENTITY:${displayName}`
  }));
  const multiCharacterResult = await optimizer.runUserDlcEntity({
    turn:9,
    selectedTargetRecords:multiCharacterTargets,
    analysisPrompt:'각 인물이 현재 관계에 따라 제안에 어떻게 반응하는지 추가해 줘.',
    relationContextRecords:[
      { id:'rel-ab', entityIds:['A','B'], promptContext:'RELATION:A-B trust=high tension=low' },
      { id:'rel-cd', entityIds:['C','D'], promptContext:'RELATION:C-D trust=low tension=high' }
    ]
  }, { ...profileConfig, userDlcEntityBatchSize:2 });
  provider.call = originalProviderCall;
  provider.isConfigured = originalProviderConfigured;
  provider.isProfileHealthy = originalProviderHealthy;
  assertions.push(assert('user_dlc_dedicated_profile_reaches_world_entity_and_tracker_calls', routedWorld?.profile === 'dlc_deep' && routedEntity?.profile === 'dlc_deep' && routedEntity?.payload?.adaptiveItems?.[0]?.kind === 'scenario_response' && routedTracker?.length === 1 && routedProfiles.filter(item => /user-dlc-(?:world|entity|tracker)-analysis/.test(item.reason || '')).every(item => item.profile === 'dlc_deep') && routedProfiles.length === 3, { routedProfiles, routedWorldProfile:routedWorld?.profile, routedEntity, routedTracker }));
  assertions.push(assert('user_dlc_creation_receives_active_nsfw_guidance_and_analysis_safe_prefill', userDlcSystems.length === 2 && userDlcSystems.every(system => /User DLC NSFW Guidance/.test(system) && /EXPLICIT mode/.test(system) && /Active Assistant Prefill — analysis-safe contract/.test(system) && !/<assistant>/.test(system) && /do not quote, imitate, or continue assistant prose/.test(system) && /Return JSON only/.test(system)), { userDlcSystems }));
  assertions.push(assert('user_dlc_world_prompt_supports_multiple_setting_adapted_contraceptive_tools', /kind=contraceptive/.test(userDlcSystems[0] || '') && /one worldItems entry per materially distinct tool/.test(userDlcSystems[0] || '') && /useProtocol, onset, effectiveWindow/.test(userDlcSystems[0] || '') && /protectionScope/.test(userDlcSystems[0] || '') && /canonically adult characters only/.test(userDlcSystems[0] || ''), { worldSystem:userDlcSystems[0] || '' }));
  assertions.push(assert('user_dlc_world_prompt_supports_linked_fantasy_and_gameplay_elements', /dungeon, monster, drop item, experience system, monster gate/.test(userDlcSystems[0] || '') && /one worldItems entry per distinct element/.test(userDlcSystems[0] || '') && /magic_array and magic_circle as synonyms/.test(userDlcSystems[0] || '') && /antiExploitRules/.test(userDlcSystems[0] || '') && /kind":"tool\|contraceptive\|dungeon\|monster\|drop_item\|experience_system\|monster_gate\|magic\|sorcery\|magic_array\|magic_wand\|magic_circle\|skill\|superpower/.test(userDlcSystems[0] || ''), { worldSystem:userDlcSystems[0] || '' }));
  assertions.push(assert('user_dlc_creation_forces_compact_nonstreaming_json_without_reasoning', userDlcCallOptions.length === 2 && userDlcCallOptions.every(options => options.jsonMode === true && options.forceJsonMode === true && options.forceNonStreaming === true && options.disableReasoning === true && options.reasoningPresetOverride === 'off') && userDlcCallOptions.find(options=>options.reason==='user-dlc-entity-analysis')?.maxTokens >= 5000, { userDlcCallOptions }));
  assertions.push(assert('user_dlc_brace_only_truncation_is_recovered_without_second_call', braceOnlyResult.outcome === 'accepted:정상 수용되어야 함' && braceOnlyResult.calls === 1 && braceOnlyResult.repairCalls === 0, { braceOnlyResult }));
  assertions.push(assert('user_dlc_missing_fields_after_truncation_is_rejected_not_stored_partially', /^rejected:/.test(missingFieldsResult.outcome) && /JSON 복구는 은퇴/.test(missingFieldsResult.outcome) && missingFieldsResult.calls === 1 && missingFieldsResult.repairCalls === 0, { missingFieldsResult }));
  assertions.push(assert('user_dlc_healthy_json_still_accepted_after_repair_retirement', healthyOutcome === 'accepted:정상 수용' && healthyCalls.filter(call => call.reason === 'user-dlc-entity-analysis').length === 1, { healthyOutcome, healthyCalls }));
  assertions.push(assert('user_dlc_multi_character_batches_validate_coverage_and_retry_only_missing_targets', multiCharacterResult?.batchCount === 3 && multiCharacterResult?.targetCount === 5 && multiCharacterResult?.coverageRetryCount === 1 && multiCharacterResult?.payload?.adaptiveItems?.length === 5 && multiCharacterResult.payload.adaptiveItems.every((item, index) => item.targetType === 'entity' && item.targetIds?.[0] === multiCharacterTargets[index].targetIds[0]) && multiCharacterCalls.length === 4 && multiCharacterCalls[1]?.coverageRetry === true && JSON.stringify(multiCharacterCalls[1]?.targetIds) === JSON.stringify(['entity-b']), { multiCharacterResult, calls:multiCharacterCalls.map(call => ({ reason:call.reason, targetIds:call.targetIds, coverageRetry:call.coverageRetry })) }));
  assertions.push(assert('user_dlc_relations_are_automatic_batch_evidence_not_output_targets', multiCharacterCalls.some(call => call.targetIds.includes('entity-a') && call.user.includes('LIBRA Relation DB evidence') && call.user.includes('RELATION:A-B')) && multiCharacterCalls.some(call => call.targetIds.includes('entity-c') && call.user.includes('RELATION:C-D')) && multiCharacterResult?.payload?.adaptiveItems?.every(item => item.targetType === 'entity'), { calls:multiCharacterCalls.map(call => ({ targetIds:call.targetIds, hasAB:call.user.includes('RELATION:A-B'), hasCD:call.user.includes('RELATION:C-D') })), items:multiCharacterResult?.payload?.adaptiveItems }));
  assertions.push(assert('user_dlc_entity_age_aliases_do_not_override_adulthood_evidence', /\[Age & Adulthood Mandate\]/.test(userDlcSystems[1] || '') && /Roleplay aliases, deceptive in-story age claims/.test(userDlcSystems[1] || '') && /never establish adulthood/.test(userDlcSystems[1] || '') && /canonically adult targets/.test(userDlcSystems[1] || ''), { entitySystem:userDlcSystems[1] || '' }));
  assertions.push(assert('user_dlc_entity_prompt_requests_persisted_fictional_rp_cycle_when_canon_missing', /fictional RP-only cycle model/.test(userDlcSystems[1] || '') && /cycleModel=fictional_rp/.test(userDlcSystems[1] || '') && /instead of rerandomizing/.test(userDlcSystems[1] || ''), { entitySystem:userDlcSystems[1] || '' }));
  assertions.push(assert('user_dlc_entity_prompt_supports_adult_sexual_history_without_guessing_unknown_totals', /kind from state, scenario_response, relationship_model, capability, reproductive_health, health_risk, or sexual_history/.test(userDlcSystems[1] || '') && /Keep all unknown lifetime counts null/.test(userDlcSystems[1] || '') && /never anatomy, hymen state/.test(userDlcSystems[1] || '') && /firstSexPartner and knownSexPartners only from established canon/.test(userDlcSystems[1] || ''), { entitySystem:userDlcSystems[1] || '' }));
  assertions.push(assert('user_dlc_tracker_prompt_emits_event_sourced_sexual_history_deltas', /emit one stable eventKey and sexualHistoryDelta/.test(userDlcTrackerSystems[0] || '') && /once per encounter\/scene/.test(userDlcTrackerSystems[0] || '') && /resulting count is a confirmed observed minimum/.test(userDlcTrackerSystems[0] || '') && /pregnancyCount and birthCount require an explicitly confirmed/.test(userDlcTrackerSystems[0] || ''), { trackerSystem:userDlcTrackerSystems[0] || '' }));
  assertions.push(assert('user_dlc_tracker_prompt_gates_contraceptive_tool_profiles_on_direct_use_evidence', /ACTIVE USER DLC CONTRACEPTIVE WORLD TOOLS/.test(userDlcTrackerSystems[0] || '') && /not evidence of acquisition, use, correct application/.test(userDlcTrackerSystems[0] || '') && /infection protection/.test(userDlcTrackerSystems[0] || ''), { trackerSystem:userDlcTrackerSystems[0] || '' }));

  const lightPlan = optimizer.getAnalysisExecutionPlan({ evidenceText:'짧은 현재 응답', focusedEntities:['아리엘'], relationTexts:[], recentTurns:[] }, 'canonical_packet');
  const complexPlan = optimizer.getAnalysisExecutionPlan({ evidenceText:'장면 변화 '.repeat(1400), focusedEntities:['A','B','C','D','E','F','G'], relationTexts:['1','2','3','4','5','6'], recentTurns:['1','2','3','4','5','6','7','8'], worldCanonCustomActive:true, plannerOrchestrationActive:true }, 'canonical_packet');
  const recoveryPlan = optimizer.getAnalysisExecutionPlan({ evidenceText:'복구 대상 '.repeat(2000), focusedEntities:['A','B','C','D'] }, 'unified', { recoveryMode:true });
  assertions.push(assert('analysis_output_budget_scales_with_turn_complexity_and_compacts_recovery', lightPlan.maxTokens < complexPlan.maxTokens && complexPlan.maxTokens <= 12000 && lightPlan.disableReasoning === true && recoveryPlan.maxTokens === 6500 && recoveryPlan.disableReasoning === true, { lightPlan, complexPlan, recoveryPlan }));

  const executionCalls = [];
  const waTurnPayload = {
    sceneInterventions:[{
      type:'scene_intervention', title:'경량 전용 경보', description:'별핵 반응에 따라 시계탑 경보가 울린다.',
      directive:'현재 장면에서 경보와 주변 반응으로 단서를 제시한다.', purpose:'조사 압력', sourceBasis:['별핵 반응'],
      activationCondition:'별핵이 반응할 때', progressionTier:'section', forceLevel:'firm', userImpact:'soft', constraints:['사용자 행동을 강제하지 않는다.'], status:'armed'
    }],
    worldDeltas:[], characterAdditions:[], manifestations:[]
  };
  const evidenceRefs = [{ turn:9, messageId:'a-9', spanHash:'hash-9', snippet:'별핵이 반응해 시계탑 경보가 울렸다.', sourceKind:'assistant' }];
  const canonicalPacket = {
    schema:'libra.canonical_packet.v3', version:3,
    meta:{ turn:9, sourceMessageIds:['a-9'], summary_memory:{ summary:'별핵 반응으로 시계탑 경보가 울렸다.', recall:'별핵 경보' } },
    memory:{ events:[{ operation:'add', id:'event-9', summary:'별핵 반응으로 시계탑 경보가 울렸다.', evidenceRefs, confidence:0.9 }], facts:[], open_threads:[] },
    entity:{ characters:[], relations:[], pov_memories:[], secrets:[], current_state:[] },
    world:{ rules:[], places:[], organizations:[], social_rules:[], phenomena:[], systems:{}, physics:{}, exists:{}, active_events:[], offscreen_threads:[], state:{ scene:'시계탑 경보' } },
    narrative:{ scene_phase:'continuation', conflict_traces:[], scene_deltas:[], theme_motifs:[], unresolved_threads:[] },
    guards:{ continuity_locks:[], audit_cautions:[], overpromotion_risks:[], conflicts:[], uncertain:[] },
    importance:{ overall:0.6, reason:['현재 장면 변화'] }
  };
  provider.isConfigured = () => true;
  provider.isProfileHealthy = () => true;
  provider.call = async (_config, system, user, options = {}) => {
    executionCalls.push({ reason:options.reason, profile:options.profile, maxTokens:options.maxTokens, disableReasoning:options.disableReasoning, system:String(system||''), user:String(user||'') });
    if (options.reason === 'afterrequest-parallel-canonical-packet') return { content:'{"status":"invalid"}', usage:{} };
    if (options.reason === 'world-additional-turn-analysis') return { content:JSON.stringify({ worldAdditional:waTurnPayload }), usage:{} };
    if (options.reason === 'afterrequest-analysis-bundle') return { content:JSON.stringify({ canonicalPacket }), usage:{} };
    throw new Error(`unexpected optimizer call: ${options.reason}`);
  };
  const optimizedConfig = { ...config, afterRequestParallelAnalysis:true, llmRouting:{ ...(config.llmRouting || {}), worldAdditionalTurnAnalysis:'wa_fast' }, analysisRecoveryImmediateAttempts:0 };
  const optimizedUnified = await optimizer.runUnified(9, {
    strictUserMsg:'별핵을 관측 장치 가까이 가져간다.', userMsgForMemory:'별핵을 관측 장치 가까이 가져간다.',
    involvedEntities:['아리엘'], entityResult:{ entities:[], relations:[], world:{} }
  }, '별핵이 반응하자 시계탑 경보가 울렸다.', [], optimizedConfig, { sourceMessageId:'a-9' });
  provider.call = originalProviderCall;
  provider.isConfigured = originalProviderConfigured;
  provider.isProfileHealthy = originalProviderHealthy;
  const executionReasons = executionCalls.map(item => item.reason);
  const waExecutionCall = executionCalls.find(item => item.reason === 'world-additional-turn-analysis');
  assertions.push(assert('parallel_world_additional_uses_dedicated_lightweight_worker', executionReasons.filter(reason => reason === 'world-additional-turn-analysis').length === 1 && !executionReasons.includes('turn-maintenance-bundle') && waExecutionCall?.profile === 'wa_fast' && waExecutionCall?.maxTokens <= 1900 && waExecutionCall?.disableReasoning === true, { executionReasons, waExecutionCall }));
  assertions.push(assert('parallel_failure_reuses_successful_world_additional_in_serial_fallback', executionReasons.filter(reason => reason === 'world-additional-turn-analysis').length === 1 && executionReasons.filter(reason => reason === 'afterrequest-analysis-bundle').length === 1 && optimizedUnified?.maintenance?.worldAdditional?.sceneInterventions?.some(item => item.title === '경량 전용 경보'), { executionReasons, maintenance:optimizedUnified?.maintenance }));

  const deferredRecoveryCalls = [];
  provider.isConfigured = () => true;
  provider.isProfileHealthy = () => true;
  provider.call = async (_config, _system, _user, options = {}) => {
    deferredRecoveryCalls.push(options.reason || '');
    return { content:'{"status":"invalid"}', usage:{} };
  };
  const deferredRecoveryResult = await optimizer.runUnified(10, {
    strictUserMsg:'복구 대상을 다시 확인한다.', userMsgForMemory:'복구 대상을 다시 확인한다.',
    involvedEntities:['아리엘'], entityResult:{ entities:[], relations:[], world:{} }
  }, '응답 후 분석 복구가 필요하다.', [], {
    ...optimizedConfig,
    worldAdditionalEnabled:false,
    worldAdditionalMode:'off',
    analysisRecoveryImmediateAttempts:2
  }, {
    sourceMessageId:'a-10',
    recoveryMode:true,
    recoveryAttempt:1
  });
  provider.call = originalProviderCall;
  provider.isConfigured = originalProviderConfigured;
  provider.isProfileHealthy = originalProviderHealthy;
  assertions.push(assert(
    'deferred_recovery_uses_one_compact_serial_attempt',
    deferredRecoveryCalls.length === 1
      && deferredRecoveryCalls[0] === 'afterrequest-analysis-bundle'
      && deferredRecoveryResult?.analysisDeferred === true
      && deferredRecoveryResult?.analysisExecution?.mode === 'deferred_recovery'
      && deferredRecoveryResult?.analysisExecution?.logicalAttempts === 1,
    { deferredRecoveryCalls, analysisExecution:deferredRecoveryResult?.analysisExecution, recoveryFailures:deferredRecoveryResult?.recoveryFailures }
  ));
  const baseCtx = {
    turn: 7,
    userMessage: '도현은 달그림자 도서관 지하서고에서 임무 단서를 찾고 아리엘에게 도움을 요청한다.',
    worldPrompt: '루멘 아카데미, 달그림자 도서관, 시계탑 관측실. 학생회 감시망과 별핵 금지 연구가 있다.',
    worldStatePrompt: '현재 장소: 달그림자 도서관. 임무: 별핵 기록 조사.',
    narrativePrompt: '초기 조사 섹션. 아직 월식 결전은 멀다.',
    directorPrompt: '조사 장면을 정체시키지 말고 단서 하나를 제공한다.',
    storyAuthorPrompt: '정본 인물 아리엘이 조력자 역할을 할 수 있다.',
    focusCharacters: ['도현', '아리엘'],
    loreHints: ['아리엘: 달그림자 도서관의 기록관리자.']
  };

  userDlc.resetState();
  userDlc.upsertWorldItem({
    kind:'trap', title:'별핵 공명 함정', userConcept:'기억을 읽는 함정',
    adaptedConcept:'달그림자 도서관의 별핵 색인이 침입자의 최근 기억 잔향에 공명하는 기록 봉인.',
    worldFitSummary:'별핵 금지 연구와 기록 마법 체계에 맞춘 적응', mechanism:'기억 자체를 빼앗지 않고 잔향만 감지한다.',
    trigger:'봉인 색인에 허가 없이 접촉', counterplay:['아리엘의 정식 열람 표식 사용','공명 문양을 먼저 발견'],
    risks:['경보와 임시 방향감각 혼란'], relatedEntities:['아리엘'], sourceBasis:['달그림자 도서관','별핵 금지 연구'], status:'armed'
  }, { turn:7 });
  userDlc.upsertWorldItem({
    id:'udlc_duplicate_manual', kind:'trap', title:'별핵 공명 함정', userConcept:'기억 잔향을 읽는 함정',
    adaptedConcept:'별핵 색인 봉인이 기억 잔향을 감지한다.', counterplay:['봉인 해제 주문'], sourceBasis:['기록 마법'], status:'armed'
  }, { turn:8 });
  assertions.push(assert('user_dlc_duplicate_auto_merged', userDlc.getState()?.worldItems?.length === 1 && userDlc.getState()?.worldItems?.[0]?.counterplay?.length === 3, userDlc.getState()?.worldItems?.[0] || {}));
  const dlcPrompt = userDlc.formatWorldForPrompt({ turn:7, userMessage:'폐쇄 색인을 조사한다.' }, 3600);
  assertions.push(assert('user_dlc_world_prompt_has_user_authority_mandatory_execution_and_canon_adaptation', /USER DLC — WORLD/.test(dlcPrompt) && /별핵 공명 함정/.test(dlcPrompt) && /Counterplay/.test(dlcPrompt) && /ACTIVE MANDATORY DLC/.test(dlcPrompt) && /persisted user input/.test(dlcPrompt) && /do not cancel the DLC outcome/.test(dlcPrompt), { prompt:dlcPrompt }));
  userDlc.resetState();
  const barrierContraceptive = userDlc.upsertWorldItem({
    kind:'contraceptive', title:'월막 피막', userConcept:'관계 전에 사용하는 마법 피막형 피임 도구',
    adaptedConcept:'기록 마법의 얇은 보호막을 신체 외부에 안정화하는 성인용 일회성 도구.',
    worldFitSummary:'루멘 아카데미의 생활 마도구와 약국 유통망에 맞춤', mechanism:'마력 피막이 체액의 직접 접촉과 정자의 이동을 차단한다.',
    effects:['임신 예방을 목적으로 한 장벽 형성'], risks:['피막 손상 시 보호 저하'], status:'armed',
    contraceptiveProfile:{ methodClass:'magical', form:'일회용 마력 피막', useProtocol:'관계 전에 봉인을 열어 올바른 방향으로 장착하고 사용 직후 폐기한다.', onset:'정상 장착 즉시', effectiveWindow:'한 번의 장면 동안', reliabilityTier:'high', failureConditions:['잘못된 장착','마력 피막 파손'], sideEffects:['마력 알레르기 가능성'], availability:'허가 약국과 성인용품점', reversibility:'reversible', protectionScope:'pregnancy_and_infection', settingBasis:'생활 마도구와 기록 마법 피막 기술' }
  }, { turn:8 }).item;
  const alchemicalContraceptive = userDlc.upsertWorldItem({
    kind:'contraceptive', title:'성화 억제정', userConcept:'정해진 주기로 복용하는 연금술 피임정',
    adaptedConcept:'연금술 길드가 조제하는 성인용 주기 억제정.', worldFitSummary:'연금술 길드와 치유원 체계에 맞춤',
    mechanism:'정해진 복용 간격 동안 설정상 배란 관련 마력 신호를 억제한다.', effects:['임신 예방을 목적으로 한 장기 복용형 효과'], risks:['복용 누락 시 신뢰도 저하'], status:'armed',
    contraceptiveProfile:{ methodClass:'alchemical', form:'경구 정제', useProtocol:'치유사의 안내에 따라 극중 일정마다 복용한다.', onset:'복용 일정이 안정화된 뒤', effectiveWindow:'정상 복용이 이어지는 기간', reliabilityTier:'high', failureConditions:['복용 누락','상쇄 약물 병용'], sideEffects:['일시적 마력 피로'], availability:'치유원 처방 또는 연금술 길드', reversibility:'reversible', protectionScope:'pregnancy_only', settingBasis:'연금술 길드의 생체 마력 조절술' }
  }, { turn:8 }).item;
  userDlc.upsertWorldItem({
    id:barrierContraceptive.id, kind:'contraceptive', title:'월막 피막', userConcept:'월막 피막의 보관 실패 조건을 보강', adaptedConcept:'기존 월막 피막 설정을 유지한다.',
    contraceptiveProfile:{ failureConditions:['고열 보관으로 인한 봉인 열화'], sideEffects:['라텍스 유사 재료 민감 반응'] }, status:'armed'
  }, { turn:9 });
  const mergedBarrierContraceptive = userDlc.getState().worldItems.find(item=>item.id===barrierContraceptive.id);
  const contraceptiveWorldPrompt = userDlc.formatWorldForPrompt({ turn:8 }, 7600);
  const contraceptiveTracker = userDlc.registerEntityTracker({
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'reproductive_health', label:'피임 도구 적용 상태',
    instruction:'현재 응답에서 도구의 실제 사용과 실패 조건이 직접 확인될 때만 갱신한다.', valueType:'status', allowedValues:['unknown','monitoring','possible'], currentValue:'monitoring', trackingEnabled:true
  }, { turn:8 }).item;
  const contraceptiveTrackerPrompt = userDlc.formatTrackersForAnalysis(['아리엘'], 7600);
  assertions.push(assert('user_dlc_contraceptive_world_kind_persists_multiple_distinct_tools', [barrierContraceptive, alchemicalContraceptive].every(item => item?.kind === 'contraceptive' && item?.contraceptiveProfile) && barrierContraceptive?.contraceptiveProfile?.protectionScope === 'pregnancy_and_infection' && alchemicalContraceptive?.contraceptiveProfile?.protectionScope === 'pregnancy_only' && userDlc.getState().worldItems.filter(item=>item.kind==='contraceptive').length === 2, { barrierContraceptive, alchemicalContraceptive }));
  assertions.push(assert('user_dlc_contraceptive_reanalysis_preserves_existing_profile_and_merges_new_constraints', /올바른 방향으로 장착/.test(mergedBarrierContraceptive?.contraceptiveProfile?.useProtocol || '') && mergedBarrierContraceptive?.contraceptiveProfile?.reliabilityTier === 'high' && mergedBarrierContraceptive?.contraceptiveProfile?.protectionScope === 'pregnancy_and_infection' && mergedBarrierContraceptive?.contraceptiveProfile?.failureConditions?.includes('고열 보관으로 인한 봉인 열화') && mergedBarrierContraceptive?.contraceptiveProfile?.sideEffects?.length === 2, mergedBarrierContraceptive || {}));
  assertions.push(assert('user_dlc_contraceptive_world_prompt_injects_protocol_failures_and_scope', /ACTIVE CONTRACEPTIVE TOOL CATALOG/.test(contraceptiveWorldPrompt) && /월막 피막/.test(contraceptiveWorldPrompt) && /성화 억제정/.test(contraceptiveWorldPrompt) && /Use protocol/.test(contraceptiveWorldPrompt) && /Contraceptive failure conditions/.test(contraceptiveWorldPrompt) && /protection scope: pregnancy_only/.test(contraceptiveWorldPrompt) && /availability establishes only that the tool exists/.test(contraceptiveWorldPrompt), { contraceptiveWorldPrompt }));
  assertions.push(assert('user_dlc_reproductive_tracker_receives_active_contraceptive_profiles_as_context_only', /ACTIVE USER DLC CONTRACEPTIVE WORLD TOOLS/.test(contraceptiveTrackerPrompt) && /월막 피막/.test(contraceptiveTrackerPrompt) && /성화 억제정/.test(contraceptiveTrackerPrompt) && /presence is never evidence/.test(contraceptiveTrackerPrompt) && /exact tool and use\/failure details/.test(contraceptiveTrackerPrompt), { contraceptiveTrackerPrompt }));
  userDlc.deleteItem('tracker', contraceptiveTracker.id);
  userDlc.resetState();
  const fantasyDefinitions = [
    { kind:'dungeon', title:'별핵 심층서고', category:'기록형 탐사 던전', rank:'B', levelRange:'중급 조사대', activation:'봉인 열람식을 완성하면 개방', entryConditions:['정식 열람 표식'], exitConditions:['중앙 색인핵 안정화'], spawnConditions:['금지 기록을 훼손할 때 수호체 출현'], rewardRules:['최초 안정화 때만 보상'], relatedElements:['기록 포식자','별핵 파편','기록 경험치 규칙','월식 균열문'] },
    { kind:'monster', title:'기록 포식자', category:'기록 마력 포식 수호체', rank:'B', spawnConditions:['별핵 심층서고의 금지 기록 훼손'], weaknesses:['공백 봉인 주문'], drops:['별핵 파편'], relatedElements:['별핵 심층서고','별핵 파편'] },
    { kind:'drop_item', title:'별핵 파편', category:'강화 재료', rank:'B', rarity:'희귀', acquisition:'기록 포식자를 실제로 격퇴한 뒤 판정', prerequisites:['적격 격퇴 사건'], antiExploitRules:['같은 격퇴 사건에서 한 번만 드랍'], relatedElements:['기록 포식자','기록 경험치 규칙'] },
    { kind:'experience_system', title:'기록 경험치 규칙', category:'조사·전투 성장 체계', progressionRules:['새 기록 해독과 적격 전투 해결로 경험치 획득'], rewardRules:['난이도와 기여도를 반영'], antiExploitRules:['동일 사건 재서술로 경험치를 중복 지급하지 않음'], relatedElements:['별핵 심층서고','기록 포식자'] },
    { kind:'monster_gate', title:'월식 균열문', category:'한시적 몬스터 게이트', rank:'A', activation:'월식 마력과 별핵 공명이 임계치를 넘을 때 개방', duration:'극중 한 시간', entryConditions:['균열 안정화 표식'], exitConditions:['핵 봉인 또는 지속 시간 종료'], spawnConditions:['개방 단계에 따라 수호체 출현'], relatedElements:['별핵 심층서고','기록 포식자'] },
    { kind:'magic', title:'색인 추적 마법', category:'탐지 마법', rank:'2서클', acquisition:'기록학 기초 수료', activation:'대상 기록의 서명을 발성', costs:['소량의 마력'], limits:['봉인 등급이 높으면 흔적만 확인'], relatedElements:['기록 마법진','기록 마법 서클'] },
    { kind:'sorcery', title:'잔향 엮기 요술', category:'민간 잔향술', rank:'중급', acquisition:'잔향술사에게 사사', activation:'남은 감정 잔향을 실로 엮음', costs:['시전자의 집중력'], limits:['새 기억을 창조할 수 없음'], relatedElements:['색인 추적 마법'] },
    { kind:'magic_array', title:'기록 마법진', category:'새겨진 의식 도식', rank:'중급', activation:'정해진 문양과 촉매를 배치', costs:['별가루 잉크'], limits:['문양이 훼손되면 중단'], relatedElements:['색인 추적 마법','별핵 지팡이'] },
    { kind:'magic_wand', title:'별핵 지팡이', category:'기록 마법 증폭 지팡이', rank:'B', rarity:'희귀', acquisition:'기록관리자 길드 제작', activation:'장착된 별핵을 조율', costs:['충전된 별핵 마력'], limits:['과열 시 출력 제한'], relatedElements:['기록 마법진','색인 추적 마법'] },
    { kind:'magic_circle', title:'기록 마법 서클', category:'등급·궤도형 성장 구조', rank:'1~7서클', progressionRules:['각 서클마다 안정된 기록 궤도를 하나 추가'], prerequisites:['이전 서클의 완전한 안정화'], limits:['서클 수만으로 실제 전투 승리를 보장하지 않음'], relatedElements:['색인 추적 마법','기록 마법진'] },
    { kind:'skill', title:'고속 색인술', category:'학습형 조사 스킬', rank:'고급', acquisition:'반복 훈련과 시험 통과', activation:'여러 기록 표제를 병렬 대조', costs:['집중력'], limits:['미해독 언어에는 보정 필요'], progressionRules:['정확한 대조 성공으로 숙련 상승'], relatedElements:['기록 경험치 규칙'] },
    { kind:'superpower', title:'잔향 투시', category:'각성형 초능력', rank:'희귀', origin:'별핵 노출 후 각성 가능', acquisition:'정본상 각성 사건 필요', activation:'접촉한 물체의 강한 잔향을 감지', costs:['감각 피로'], limits:['사실 전체가 아닌 파편만 보임'], failureConsequences:['과사용 시 일시적 혼선'], relatedElements:['별핵 파편'] }
  ];
  const fantasyItems = fantasyDefinitions.map(definition => userDlc.upsertWorldItem({
    kind:definition.kind, title:definition.title, userConcept:`${definition.title}을 세계관 요소로 추가`, adaptedConcept:`현재 기록 마법 세계관에 맞춘 ${definition.title}.`,
    mechanism:`${definition.category}의 정해진 규칙에 따라 작동한다.`, status:'armed',
    fantasySystemProfile:{ ...definition, settingBasis:'달그림자 도서관·별핵 기록 마법 체계' }
  }, { turn:10 }).item);
  const skillItem = fantasyItems.find(item=>item.kind==='skill');
  userDlc.upsertWorldItem({ id:skillItem.id, kind:'skill', title:skillItem.title, userConcept:'고속 색인술의 제약 보강', adaptedConcept:'기존 고속 색인술을 유지한다.', fantasySystemProfile:{ limits:['장시간 사용 시 정확도 저하'], antiExploitRules:['같은 기록 묶음의 반복 대조는 숙련 보상을 중복 지급하지 않음'] }, status:'armed' }, { turn:11 });
  const mergedSkillItem = userDlc.getState().worldItems.find(item=>item.id===skillItem.id);
  const fantasyWorldPrompt = userDlc.formatWorldForPrompt({ turn:11, userMessage:'별핵 심층서고에 진입하기 전에 규칙을 확인한다.' }, 10000);
  const fantasyKinds = ['dungeon','monster','drop_item','experience_system','monster_gate','magic','sorcery','magic_array','magic_wand','magic_circle','skill','superpower'];
  assertions.push(assert('user_dlc_fantasy_world_kinds_store_each_linked_element_separately', fantasyKinds.every(kind => fantasyItems.some(item=>item?.kind===kind && item?.fantasySystemProfile)) && userDlc.getState().worldItems.filter(item=>fantasyKinds.includes(item.kind)).length === fantasyKinds.length && userDlc.getState().worldItems.find(item=>item.kind==='magic_array')?.title === '기록 마법진' && userDlc.getState().worldItems.find(item=>item.kind==='magic_circle')?.title === '기록 마법 서클', userDlc.getState().worldItems));
  assertions.push(assert('user_dlc_fantasy_reanalysis_preserves_profile_and_merges_new_limits', /여러 기록 표제를 병렬 대조/.test(mergedSkillItem?.fantasySystemProfile?.activation || '') && mergedSkillItem?.fantasySystemProfile?.limits?.includes('미해독 언어에는 보정 필요') && mergedSkillItem?.fantasySystemProfile?.limits?.includes('장시간 사용 시 정확도 저하') && mergedSkillItem?.fantasySystemProfile?.antiExploitRules?.length === 1, mergedSkillItem || {}));
  assertions.push(assert('user_dlc_fantasy_catalog_and_named_priority_inject_rules_without_auto_rewards', /ACTIVE FANTASY\/GAMEPLAY ELEMENT CATALOG/.test(fantasyWorldPrompt) && fantasyDefinitions.every(item=>fantasyWorldPrompt.includes(item.title)) && /- 별핵 심층서고 \[dungeon\]/.test(fantasyWorldPrompt) && /Entry conditions: 정식 열람 표식/.test(fantasyWorldPrompt) && /never repeatedly for the same event/.test(fantasyWorldPrompt) && /magic_array is an inscribed ritual diagram/.test(fantasyWorldPrompt), { fantasyWorldPrompt }));
  const conflictedWorld = userDlc.upsertWorldItem({ kind:'rule', title:'충돌 세계 법칙', userConcept:'기존 마법을 전면 폐기한다.', adaptedConcept:'기존 마법이 존재하지 않는다.', canonCompatibility:{ status:'conflicted', conflicts:['LIBRA World DB의 기록 마법과 정면 충돌'] }, status:'armed' }, { turn:8 }).item;
  const conflictedWorldEnable = userDlc.setInjectionState('world', conflictedWorld.id, true);
  const promptAfterConflict = userDlc.formatWorldForPrompt({ turn:8 }, 4000);
  assertions.push(assert('user_dlc_conflicted_world_is_quarantined_and_cannot_be_enabled', conflictedWorld?.injectionDisabled === true && conflictedWorldEnable?.reason === 'canon_conflict' && !/충돌 세계 법칙/.test(promptAfterConflict), { conflictedWorld, conflictedWorldEnable, promptAfterConflict }));
  userDlc.upsertTargetAnalysis({ targetType:'entity', targetIds:['아리엘'], displayName:'아리엘', prompt:'거짓말 패턴 분석', summary:'공개 기록과 폐쇄 기록을 구분해 말한다.', findings:[{ label:'회피 신호', value:'폐쇄 기록 질문에는 직책을 먼저 언급한다.', evidence:['기록관리자 설정'] }] }, { turn:7 });
  userDlc.upsertTargetAnalysis({ targetType:'entity', targetIds:['아리엘'], displayName:'아리엘', prompt:'신뢰 변화 갱신', summary:'도현에게 제한적 신뢰가 생겼다.', findings:[{ label:'신뢰 신호', value:'정식 열람 표식을 직접 제공한다.', evidence:['현재 조사'] }] }, { turn:8 });
  const dlcState = userDlc.getState();
  assertions.push(assert('user_dlc_entity_cumulative_revision', dlcState.targetAnalyses?.length === 1 && dlcState.targetAnalyses?.[0]?.revision === 2 && dlcState.targetAnalyses?.[0]?.findings?.length === 2 && dlcState.targetAnalyses?.[0]?.history?.length === 1, dlcState.targetAnalyses?.[0] || {}));
  const dlcEntityPrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 3200);
  assertions.push(assert('user_dlc_entity_reference_prompt', /USER DLC — ENTITY/.test(dlcEntityPrompt) && /신뢰 신호/.test(dlcEntityPrompt) && /mandatory continuity constraints/.test(dlcEntityPrompt), { prompt:dlcEntityPrompt }));
  const conflictedTarget = userDlc.upsertTargetAnalysis({ targetType:'entity', targetIds:['entity-ariel-conflict'], displayName:'충돌 아리엘', prompt:'충돌 검사', summary:'기존 정체성을 다른 인물로 교체한다.', findings:[{ label:'정체성', value:'다른 인물', evidence:['DLC 주장'], dbCompatibility:'conflicted', conflicts:['LIBRA Entity DB 정체성과 충돌'] }], canonCompatibility:{ status:'conflicted', conflicts:['LIBRA Entity DB 정체성과 충돌'] } }, { turn:8 }).item;
  const conflictedTargetEnable = userDlc.setInjectionState('target', conflictedTarget.id, true);
  const targetPromptAfterConflict = userDlc.formatTargetAnalysesForPrompt(['충돌 아리엘'], 3200);
  assertions.push(assert('user_dlc_conflicted_entity_analysis_is_quarantined_and_cannot_be_enabled', conflictedTarget?.injectionDisabled === true && conflictedTargetEnable?.reason === 'canon_conflict' && !/기존 정체성을 다른 인물로 교체/.test(targetPromptAfterConflict), { conflictedTarget, conflictedTargetEnable, targetPromptAfterConflict }));
  const dlcLore = [];
  await userDlc.saveState(dlcLore);
  assertions.push(assert('user_dlc_separate_lore_db', dlcLore.some(entry => entry.comment === 'lmai_user_dlc' && /libra\.user_dlc\.v1/.test(entry.content)), { comments:dlcLore.map(entry=>entry.comment) }));

  userDlc.upsertWorldItem({ kind:'tool', title:'삭제 테스트 도구', userConcept:'삭제될 도구', adaptedConcept:'삭제 테스트', status:'armed' }, { turn:8 });
  const deleteDlcId = userDlc.getState().worldItems.find(item => item.title === '삭제 테스트 도구')?.id;
  const deleteDlcResult = userDlc.deleteItem('world', deleteDlcId);
  assertions.push(assert('user_dlc_item_delete_removes_prompt_source', deleteDlcResult?.changed === true && !userDlc.getState().worldItems.some(item => item.id === deleteDlcId), deleteDlcResult || {}));

  core.resetState({ worldDeltas:[
    { id:'wa_dup_a', type:'world_delta', title:'폐쇄 색인실', description:'지하서고에 폐쇄 색인실이 있다.', directive:'조사 경로로 사용한다.', sourceBasis:['달그림자 도서관'], status:'armed' },
    { id:'wa_dup_b', type:'world_delta', title:'폐쇄 색인실', description:'별핵 기록이 보관된 폐쇄 색인실.', directive:'단서와 대응책을 함께 제공한다.', sourceBasis:['별핵 기록'], status:'prepared' }
  ] });
  const duplicateMerge = core.mergeDuplicateDirectives();
  assertions.push(assert('world_additional_duplicate_manual_merge', duplicateMerge?.merged === 1 && core.getState().worldDeltas?.length === 1 && core.getState().worldDeltas?.[0]?.mergedFromIds?.includes('wa_dup_b'), { result:duplicateMerge, item:core.getState().worldDeltas?.[0] }));
  const mergedDirectiveId = core.getState().worldDeltas?.[0]?.id;
  const deleteDirectiveResult = core.deleteItem('directive', mergedDirectiveId);
  assertions.push(assert('world_additional_delete_clears_directive', deleteDirectiveResult?.changed === true && core.getState().worldDeltas?.length === 0, deleteDirectiveResult || {}));
  const deletedReinsert = core.upsertDirective({ id:'wa_recreated', type:'world_delta', title:'폐쇄 색인실', description:'자동 분석이 다시 만든 항목', directive:'재삽입', status:'armed' });
  assertions.push(assert('world_additional_deleted_item_not_auto_recreated', deletedReinsert?.deleted === true && core.getState().worldDeltas?.length === 0 && core.getState().deletedItemKeys?.length >= 1, { result:deletedReinsert, deletedItemKeys:core.getState().deletedItemKeys }));

  core.resetState();
  const manualDirective = core.upsertDirective({ id:'wa_manual_injection', type:'world_delta', title:'수동 투입 비밀 통로', description:'달그림자 도서관의 비밀 통로.', directive:'다음 요청에 실제 투입한다.', sourceBasis:['달그림자 도서관'], userImpact:'ambient', status:'armed' }).directive;
  const globalOffConfig = { ...config, worldAdditionalEnabled:false, worldAdditionalMode:'off' };
  let manualPrompt = core.formatForPrompt(baseCtx, globalOffConfig);
  assertions.push(assert('retired_global_off_fields_do_not_disable_automatic_candidates', /수동 투입 비밀 통로/.test(manualPrompt), { prompt:manualPrompt }));
  const manualOn = core.setInjectionState('directive', manualDirective.id, true);
  manualPrompt = core.formatForPrompt(baseCtx, globalOffConfig);
  assertions.push(assert('world_additional_lit_manual_toggle_injects_when_global_off', manualOn?.enabled === true && /수동 투입 비밀 통로/.test(manualPrompt), { result:manualOn, prompt:manualPrompt }));
  const manualOff = core.setInjectionState('directive', manualDirective.id, false);
  manualPrompt = core.formatForPrompt(baseCtx, config);
  assertions.push(assert('world_additional_unlit_toggle_excludes_when_global_on', manualOff?.enabled === false && !/수동 투입 비밀 통로/.test(manualPrompt), { result:manualOff, prompt:manualPrompt }));

  core.resetState({ worldCodex:[{ id:'wc_toggle', scope:{type:'system',id:'world_main'}, subject:'world_laws', content:'달빛 마법은 기록 매체를 통해서만 발현된다.', signature:'wc_toggle_sig', confidence:'established' }] });
  const codexOff = core.setInjectionState('codex', 'wc_toggle', false);
  const codexOffPrompt = core.formatWorldCodexForPrompt(900);
  const codexOn = core.setInjectionState('codex', 'wc_toggle', true);
  const codexOnPrompt = core.formatWorldCodexForPrompt(900);
  assertions.push(assert('world_codex_injection_toggle_controls_real_prompt', codexOff?.changed === true && !/달빛 마법/.test(codexOffPrompt) && codexOn?.enabled === true && /달빛 마법/.test(codexOnPrompt), { codexOffPrompt, codexOnPrompt }));

  userDlc.resetState();
  const dlcToggleItem = userDlc.upsertWorldItem({ kind:'tool', title:'투입 토글 도구', userConcept:'토글 테스트', adaptedConcept:'세계관 적응 도구', status:'armed' }, { turn:8 }).item;
  userDlc.setInjectionState('world', dlcToggleItem.id, false);
  const dlcOffPrompt = userDlc.formatWorldForPrompt({ turn:8 }, 2000);
  userDlc.setInjectionState('world', dlcToggleItem.id, true);
  const dlcOnPrompt = userDlc.formatWorldForPrompt({ turn:8 }, 2000);
  assertions.push(assert('user_dlc_world_injection_toggle_controls_real_prompt', !/투입 토글 도구/.test(dlcOffPrompt) && /투입 토글 도구/.test(dlcOnPrompt), { dlcOffPrompt, dlcOnPrompt }));

  userDlc.resetState();
  const directWorld = userDlc.registerWorldElement({ kind:'location', title:'회색 조류 기록항', userConcept:'밤마다 과거 사건의 잔향이 떠오르는 항구', worldFitSummary:'별핵 기록 마법과 연결해 사용' }, { turn:9 });
  const directWorldOffPrompt = userDlc.formatWorldForPrompt({ turn:9 }, 2200);
  userDlc.setInjectionState('world', directWorld.item?.id, true);
  const directWorldOnPrompt = userDlc.formatWorldForPrompt({ turn:9 }, 2200);
  assertions.push(assert('user_dlc_direct_world_registration_starts_off_then_injects', directWorld?.changed === true && directWorld?.item?.registrationSource === 'user_manual' && directWorld?.item?.injectionDisabled === true && !/회색 조류 기록항/.test(directWorldOffPrompt) && /회색 조류 기록항/.test(directWorldOnPrompt) && /adapt names, metaphysics/.test(directWorldOnPrompt), { directWorld, directWorldOffPrompt, directWorldOnPrompt }));

  const directAnalysis = userDlc.registerTargetAnalysisElement({ targetType:'entity', targetIds:['아리엘'], displayName:'아리엘', label:'비공개 기록 회피 신호', value:'질문을 받으면 직책과 열람 등급을 먼저 확인한다.' }, { turn:9 });
  const directAnalysisOffPrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 2200);
  userDlc.setInjectionState('target', directAnalysis.item?.id, true);
  const directAnalysisOnPrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 2200);
  assertions.push(assert('user_dlc_direct_analysis_registration_starts_off_then_injects', directAnalysis?.changed === true && directAnalysis?.item?.registrationSource === 'user_manual' && directAnalysis?.item?.injectionDisabled === true && !/비공개 기록 회피 신호/.test(directAnalysisOffPrompt) && /비공개 기록 회피 신호/.test(directAnalysisOnPrompt), { directAnalysis, directAnalysisOffPrompt, directAnalysisOnPrompt }));

  userDlc.resetState();
  const pregnancyTracker = userDlc.registerEntityTracker({
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', label:'임신 여부',
    instruction:'현재 장면의 직접 근거만으로 임신 여부를 추적한다. 언급 부재나 추측은 상태 변경 근거가 아니다.',
    valueType:'status', allowedValues:['unknown','not_pregnant','possible','confirmed','ended'], updateMode:'relevant'
  }, { turn:10 });
  const contraceptionTracker = userDlc.registerEntityTracker({
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', label:'피임 결과',
    instruction:'명시적인 복용, 실패, 검사 또는 장면 결과만으로 피임 결과를 갱신한다.',
    valueType:'status', allowedValues:['unknown','success','failure','uncertain'], updateMode:'every_turn'
  }, { turn:10 });
  const trackerId = pregnancyTracker.item?.id;
  const unsupportedEvidenceUpdate = userDlc.applyTrackerUpdates([{ trackerId, value:'confirmed', confidence:'confirmed', evidence:['검사 결과가 양성으로 확인되었다.'], reason:'응답에 없는 근거', dbCompatibility:'compatible' }], { turn:11, assistantText:'아리엘은 창밖의 비를 바라보며 기록장을 덮었다.' });
  const noEvidenceUpdate = userDlc.applyTrackerUpdates([{ trackerId, value:'confirmed', confidence:'confirmed', evidence:[], reason:'언급이 없어서 추정', dbCompatibility:'compatible' }], { turn:11 });
  const conflictedTrackerUpdate = userDlc.applyTrackerUpdates([{ trackerId, value:'confirmed', confidence:'confirmed', evidence:['아리엘이 임신 가능성을 직접 언급했다.'], reason:'정규 DB와 충돌', dbCompatibility:'conflicted', dbConflicts:['LIBRA Entity DB는 not_pregnant'] }], { turn:12 });
  const possibleUpdate = userDlc.applyTrackerUpdates([{ trackerId, value:'possible', confidence:'possible', evidence:['아리엘이 임신 가능성을 직접 언급했다.'], reason:'가능성만 명시됨', dbCompatibility:'compatible' }], { turn:12 });
  const invalidUpdate = userDlc.applyTrackerUpdates([{ trackerId, value:'definitely_yes', confidence:'confirmed', evidence:['허용값 밖 응답'], dbCompatibility:'compatible' }], { turn:13 });
  const confirmedUpdate = userDlc.applyTrackerUpdates([{ trackerId, value:'confirmed', confidence:'confirmed', evidence:['장면 속 검사 결과가 양성이라고 명시되었다.'], reason:'명시적 검사 결과', dbCompatibility:'explicit_transition' }], { turn:14 });
  const tracked = userDlc.getState().entityTrackers.find(item => item.id === trackerId);
  const trackerAnalysisPrompt = userDlc.formatTrackersForAnalysis(['아리엘'], 5200);
  const trackerInjectionPrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 3200);
  assertions.push(assert('user_dlc_custom_trackers_register_per_target', pregnancyTracker?.created === true && contraceptionTracker?.created === true && userDlc.getState().entityTrackers.length === 2, userDlc.getState().entityTrackers));
  assertions.push(assert('user_dlc_tracker_rejects_absent_unsupported_conflicted_and_invalid_updates', unsupportedEvidenceUpdate?.evaluated === 0 && noEvidenceUpdate?.evaluated === 0 && conflictedTrackerUpdate?.evaluated === 0 && invalidUpdate?.evaluated === 0 && tracked?.currentValue === 'confirmed', { unsupportedEvidenceUpdate, noEvidenceUpdate, conflictedTrackerUpdate, invalidUpdate, tracked }));
  assertions.push(assert('user_dlc_tracker_accumulates_state_confidence_evidence_history', possibleUpdate?.changedCount === 1 && confirmedUpdate?.changedCount === 1 && tracked?.history?.length === 2 && tracked?.lastChangedTurn === 14 && /검사 결과/.test(tracked?.evidence?.[0] || ''), tracked || {}));
  assertions.push(assert('user_dlc_tracker_analysis_prompt_is_bounded_and_targeted', /CUSTOM ENTITY TRACKERS/.test(trackerAnalysisPrompt) && /임신 여부/.test(trackerAnalysisPrompt) && /피임 결과/.test(trackerAnalysisPrompt) && /allowedValues/.test(trackerAnalysisPrompt), { trackerAnalysisPrompt }));
  assertions.push(assert('user_dlc_tracker_current_state_injected_for_next_response', /CURRENT CUSTOM TRACKER STATES/.test(trackerInjectionPrompt) && /임신 여부/.test(trackerInjectionPrompt) && /Current: confirmed/.test(trackerInjectionPrompt), { trackerInjectionPrompt }));
  userDlc.setTrackerEnabled(trackerId, false);
  assertions.push(assert('user_dlc_tracker_can_be_disabled_without_deleting_history', userDlc.getState().entityTrackers.find(item => item.id === trackerId)?.enabled === false && userDlc.getState().entityTrackers.find(item => item.id === trackerId)?.updateMode === 'manual' && userDlc.getState().entityTrackers.find(item => item.id === trackerId)?.history?.length === 2, userDlc.getState().entityTrackers.find(item => item.id === trackerId) || {}));

  userDlc.resetState();
  const adaptiveScenario = userDlc.ingestAdaptiveItems({ adaptiveItems:[{
    targetType:'relation', targetIds:['relation-ariel-dohyeon'], displayName:'아리엘 ↔ 도현',
    kind:'scenario_response', label:'현재 고백 반응', userRequest:'현재 관계에서 고백하면 어떻게 반응할지 보여 줘.',
    instruction:'LIBRA 관계 DB와 아리엘의 말투에 근거해 현재 적용 분기만 응답에 사용한다.',
    valueType:'text', currentValue:'정중한 거절', trackingEnabled:false, useEnabled:true,
    currentSnapshot:{ summary:'신뢰는 있으나 연애 제안은 이르다.', relationshipState:'제한적 신뢰', probabilityMin:10, probabilityMax:25, expectedResponse:'놀라지만 관계를 해치지 않도록 정중히 거절한다.', dialogueExamples:['미안해요. 아직은 기록 동료로 있고 싶어요.'] },
    scenarioBands:[
      { band:'현재/낮은 연애 신뢰', conditions:['제한적 신뢰'], probabilityMin:10, probabilityMax:25, expectedResponse:'현재 분기 정중한 거절', dialogueExamples:['아직은 어려워요.'] },
      { band:'매우 높은 상호 신뢰', conditions:['명시적 상호 호감'], probabilityMin:70, probabilityMax:90, expectedResponse:'미래 분기에서 조심스럽게 수락', dialogueExamples:['저도 같은 마음이에요.'] }
    ]
  }]}, { turn:15, userRequest:'현재 관계에서 고백하면 어떻게 반응할지 보여 줘.' });
  const scenarioItem = adaptiveScenario[0]?.item;
  const scenarioInjection = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 3600);
  const scenarioAnalysisOff = userDlc.formatTrackersForAnalysis(['아리엘'], 5200);
  assertions.push(assert('user_dlc_adaptive_scenario_stores_all_branches_but_injects_current_only', scenarioItem?.scenarioBands?.length === 2 && scenarioItem?.enabled === false && scenarioItem?.updateMode === 'manual' && /현재 적용 분기만|Current expected response: 놀라지만/.test(scenarioInjection) && !/미래 분기에서 조심스럽게 수락/.test(scenarioInjection) && scenarioAnalysisOff === '', { scenarioItem, scenarioInjection, scenarioAnalysisOff }));
  userDlc.setTrackerEnabled(scenarioItem.id, true);
  const scenarioAnalysisOn = userDlc.formatTrackersForAnalysis(['아리엘'], 5200);
  assertions.push(assert('user_dlc_track_toggle_enables_full_internal_scenario_evaluation', userDlc.getState().entityTrackers.find(item=>item.id===scenarioItem.id)?.updateMode === 'every_turn' && /미래 분기에서 조심스럽게 수락/.test(scenarioAnalysisOn), { scenarioAnalysisOn }));
  userDlc.setInjectionState('tracker', scenarioItem.id, false);
  userDlc.ingestAdaptiveItems({ adaptiveItems:[{
    targetType:'relation', targetIds:['relation-ariel-dohyeon'], displayName:'아리엘 ↔ 도현', kind:'scenario_response', label:'현재 고백 반응',
    instruction:'현재 장면에 맞춰 예상 반응만 갱신한다.', valueType:'text',
    currentSnapshot:{ expectedResponse:'최근 사건을 고려해 답변을 보류한다.' },
    trackingEnabled:false, useEnabled:true
  }]}, { turn:16 });
  const scenarioReanalyzed = userDlc.getState().entityTrackers.find(item=>item.id===scenarioItem.id);
  assertions.push(assert('user_dlc_reanalysis_preserves_user_track_use_choices_and_unmentioned_snapshot_fields', scenarioReanalyzed?.enabled === true && scenarioReanalyzed?.updateMode === 'every_turn' && scenarioReanalyzed?.injectionDisabled === true && scenarioReanalyzed?.currentValue === '정중한 거절' && scenarioReanalyzed?.currentSnapshot?.relationshipState === '제한적 신뢰' && scenarioReanalyzed?.currentSnapshot?.expectedResponse === '최근 사건을 고려해 답변을 보류한다.', scenarioReanalyzed || {}));

  userDlc.resetState();
  const retargetSource = userDlc.registerEntityTracker({
    targetType:'entity', targetIds:['entity-a'], displayName:'A', kind:'scenario_response', label:'공통 제안 반응',
    userRequest:'현재 관계에 따른 제안 반응을 계속 추적해 줘.', instruction:'관계 DB와 현재 장면 근거로 반응을 추적한다.',
    valueType:'text', currentValue:'A 기존 반응', trackingEnabled:true, useEnabled:true,
    currentSnapshot:{ summary:'A 기존 상태', relationshipState:'기존 신뢰' },
    history:[{ turn:30, from:'unknown', to:'A 기존 반응', confidence:'possible', evidence:['기존 근거'], reason:'기존 이력' }]
  }, { turn:30 });
  const retargetSourceId = retargetSource.item?.id;
  const firstRetarget = userDlc.reconcileTrackerTargets(retargetSourceId, { adaptiveItems:[
    { targetType:'entity', targetIds:['entity-a'], displayName:'A', kind:'scenario_response', instruction:'A 재분석', valueType:'text', currentValue:'A 재분석 반응', currentSnapshot:{ summary:'A 재분석 상태' }, trackingEnabled:true, useEnabled:true },
    { targetType:'entity', targetIds:['entity-b'], displayName:'B', kind:'scenario_response', instruction:'B 신규 분석', valueType:'text', currentValue:'B 신규 반응', currentSnapshot:{ summary:'B 신규 상태' }, trackingEnabled:true, useEnabled:true }
  ]}, ['entity-a','entity-b'], { turn:31, userRequest:'현재 관계에 따른 제안 반응을 계속 추적해 줘.' });
  const afterFirstRetarget = clone(userDlc.getState().entityTrackers);
  const preservedA = afterFirstRetarget.find(item => item.id === retargetSourceId);
  const addedB = afterFirstRetarget.find(item => item.targetIds?.includes('entity-b'));
  const secondRetarget = userDlc.reconcileTrackerTargets(retargetSourceId, { adaptiveItems:[
    { targetType:'entity', targetIds:['entity-b'], displayName:'B', kind:'scenario_response', instruction:'B 재분석', valueType:'text', currentValue:'B 재분석 반응', currentSnapshot:{ summary:'B 재분석 상태' }, trackingEnabled:true, useEnabled:true },
    { targetType:'entity', targetIds:['entity-c'], displayName:'C', kind:'scenario_response', instruction:'C 신규 분석', valueType:'text', currentValue:'C 신규 반응', currentSnapshot:{ summary:'C 신규 상태' }, trackingEnabled:true, useEnabled:true }
  ]}, ['entity-b','entity-c'], { turn:32, userRequest:'현재 관계에 따른 제안 반응을 계속 추적해 줘.' });
  const afterSecondRetarget = userDlc.getState().entityTrackers;
  const archivedA = afterSecondRetarget.find(item => item.id === retargetSourceId);
  const retainedB = afterSecondRetarget.find(item => item.id === addedB?.id);
  const addedC = afterSecondRetarget.find(item => item.targetIds?.includes('entity-c'));
  const archivedEnableAttempt = userDlc.setTrackerEnabled(retargetSourceId, true);
  const retargetAnalysisPrompt = userDlc.formatTrackersForAnalysis(['A','B','C'], 5200);
  assertions.push(assert('user_dlc_retarget_adds_people_under_same_group_and_preserves_existing_tracker_identity_history', firstRetarget?.changed === true && firstRetarget?.added === 1 && firstRetarget?.updated === 1 && preservedA?.id === retargetSourceId && preservedA?.history?.length === 1 && preservedA?.currentValue === 'A 재분석 반응' && addedB?.analysisGroupId === preservedA?.analysisGroupId && addedB?.membershipActive === true, { firstRetarget, preservedA, addedB }));
  assertions.push(assert('user_dlc_retarget_archives_removed_people_without_deleting_data_and_retracks_remaining_people', secondRetarget?.changed === true && secondRetarget?.added === 1 && secondRetarget?.archived?.length === 1 && archivedA?.membershipActive === false && archivedA?.enabled === false && archivedA?.injectionDisabled === true && archivedA?.history?.length === 1 && archivedA?.currentValue === 'A 재분석 반응' && retainedB?.id === addedB?.id && retainedB?.membershipActive === true && retainedB?.currentValue === 'B 재분석 반응' && addedC?.membershipActive === true && archivedEnableAttempt?.reason === 'archived_target_membership' && !retargetAnalysisPrompt.includes('entity-a') && retargetAnalysisPrompt.includes('entity-b') && retargetAnalysisPrompt.includes('entity-c'), { secondRetarget, archivedA, retainedB, addedC, archivedEnableAttempt, retargetAnalysisPrompt }));

  userDlc.resetState();
  const fictionalCycle = userDlc.ingestAdaptiveItems({ adaptiveItems:[{
    targetType:'entity', targetIds:['entity-mira'], displayName:'미라', kind:'reproductive_health', label:'가상 RP 주기',
    userRequest:'정본 주기가 없으면 극중용 주기를 임의 생성해 계속 추적해 줘.', instruction:'가상 RP 주기를 유지하고 극중 날짜에 따라 진행한다.',
    valueType:'status', allowedValues:['unknown','monitoring'], currentValue:'monitoring', trackingEnabled:true, useEnabled:true,
    currentSnapshot:{ sceneDate:'2026-07-03' }
  }]}, { turn:19 })[0]?.item;
  const fictionalCyclePrompt = userDlc.formatTargetAnalysesForPrompt(['미라'], 3600);
  assertions.push(assert('user_dlc_reproductive_tracker_generates_and_persists_fictional_cycle_defaults', fictionalCycle?.currentSnapshot?.cycleModel === 'fictional_rp' && fictionalCycle.currentSnapshot.cycleLengthDays >= 24 && fictionalCycle.currentSnapshot.cycleLengthDays <= 35 && fictionalCycle.currentSnapshot.cycleDay >= 1 && fictionalCycle.currentSnapshot.cycleDay <= fictionalCycle.currentSnapshot.cycleLengthDays && fictionalCycle.currentSnapshot.fertileWindowStartDay <= fictionalCycle.currentSnapshot.fertileWindowEndDay && /fictional RP simulation/.test(fictionalCyclePrompt) && /not medical fact/.test(fictionalCyclePrompt), { fictionalCycle, fictionalCyclePrompt }));

  userDlc.resetState();
  const reproductive = userDlc.ingestAdaptiveItems({ adaptiveItems:[{
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'reproductive_health', label:'생식 건강·임신 가능성',
    userRequest:'극중 날짜에 따라 주기, 피임, 임신 가능성을 계속 추적해 줘.',
    instruction:'직접 묘사된 노출 사건과 정본 정보만 사용하고 같은 사건은 한 번만 판정한다.',
    valueType:'status', allowedValues:['unknown','monitoring','possible','confirmed','resolved'], currentValue:'monitoring',
    trackingEnabled:true, useEnabled:true, eventResolutionMode:'single_event_locked',
    currentSnapshot:{ summary:'주기 정보가 부족해 범위로 추적 중', sceneDate:'2026-07-03', cycleStatus:'주기 불확실', fertilityWindow:'절대적 안전일로 단정할 수 없음', contraception:'아직 사건 없음' }
  }]}, { turn:20 })[0]?.item;
  const eventText = '장면에서 피임 도구를 사용했지만 파손 가능성이 직접 언급되었다.';
  const firstEvent = userDlc.applyTrackerUpdates([{ trackerId:reproductive.id, value:'possible', confidence:'possible', eventKey:'scene-2026-07-03-exposure-1', eventType:'contraceptive_exposure', sceneDate:'2026-07-03', probabilityMin:1, probabilityMax:4, currentSnapshot:{ summary:'피임 실패 가능성이 낮지만 0은 아니다.', contraception:'도구 사용 · 파손 가능성', nextEvaluation:'극중 시간 경과 또는 검사 근거' }, evidence:[eventText], reason:'직접 묘사된 단일 노출 사건', dbCompatibility:'compatible' }], { turn:21, assistantText:eventText });
  const firstLocked = clone(userDlc.getState().entityTrackers.find(item=>item.id===reproductive.id)?.eventLedger?.[0]);
  const repeatEvent = userDlc.applyTrackerUpdates([{ trackerId:reproductive.id, value:'possible', confidence:'possible', eventKey:'scene-2026-07-03-exposure-1', eventType:'contraceptive_exposure', sceneDate:'2026-07-03', probabilityMin:70, probabilityMax:90, currentSnapshot:{ summary:'같은 사건 후속 언급' }, evidence:[eventText], reason:'동일 사건 재언급', dbCompatibility:'compatible' }], { turn:22, assistantText:eventText });
  const afterRepeat = userDlc.getState().entityTrackers.find(item=>item.id===reproductive.id);
  const secondEventText = '다음 날 별개의 두 번째 노출 사건이 직접 묘사되었다.';
  userDlc.applyTrackerUpdates([{ trackerId:reproductive.id, value:'possible', confidence:'possible', eventKey:'scene-2026-07-04-exposure-2', eventType:'unprotected_exposure', sceneDate:'2026-07-04', probabilityMin:8, probabilityMax:18, evidence:[secondEventText], reason:'별개의 신규 사건', dbCompatibility:'compatible' }], { turn:23, assistantText:secondEventText });
  const afterSecond = userDlc.getState().entityTrackers.find(item=>item.id===reproductive.id);
  const reproductivePrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 4200);
  assertions.push(assert('user_dlc_reproductive_event_resolution_is_locked_per_event', firstEvent?.evaluated === 1 && repeatEvent?.evaluated === 1 && afterRepeat?.eventLedger?.length === 1 && afterRepeat?.eventLedger?.[0]?.resolutionRoll === firstLocked?.resolutionRoll && afterRepeat?.eventLedger?.[0]?.lockedOutcome === firstLocked?.lockedOutcome && afterRepeat?.currentSnapshot?.probabilityMin === 1 && afterRepeat?.currentSnapshot?.probabilityMax === 4 && afterSecond?.eventLedger?.length === 2, { firstLocked, afterRepeat, afterSecond }));
  assertions.push(assert('user_dlc_reproductive_current_projection_includes_clock_cycle_contraception_and_locked_event', /Story date: 2026-07-04/.test(reproductivePrompt) && /Current cycle: 주기 불확실/.test(reproductivePrompt) && /Contraception\/exposure: 도구 사용/.test(reproductivePrompt) && /Locked event resolution/.test(reproductivePrompt) && /Do not reroll/.test(reproductivePrompt), { reproductivePrompt }));

  userDlc.resetState();
  const sexualHistory = userDlc.registerEntityTracker({
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'sexual_history', label:'성경험 이력',
    userRequest:'성경험 관련 횟수와 첫 상대를 계속 추적해 줘.',
    instruction:'정본 또는 현재 응답에 직접 확인된 성인 인물의 완료 사건만 고유 사건 키로 한 번씩 집계한다.',
    valueType:'status', allowedValues:['unknown','tracking'], currentValue:'tracking', trackingEnabled:true, useEnabled:true,
    currentSnapshot:{ summary:'정본상 생애 총계는 미확인', virginityStatus:'unknown', sexualHistoryCountingBasis:'unknown' }
  }, { turn:40 }).item;
  const firstSexEventText = '성인인 아리엘과 베른의 합의된 성관계가 완료되었고, 그 장면에서 펠라치오와 질내사정이 한 차례씩 직접 묘사되었다.';
  const firstSexHistoryEvent = userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', eventKey:'scene-2026-07-05-sexual-encounter-1', eventType:'partnered_sex', sceneDate:'2026-07-05',
    sexualHistoryDelta:{ sexCount:1, vaginalEjaculationCount:1, fellatioCount:1, newPartnerCount:1, partnerNames:['베른'], firstSexPartner:'베른' },
    currentSnapshot:{ summary:'직접 확인된 첫 성관계 장면을 집계함' }, evidence:[firstSexEventText], reason:'완료된 성인 간 사건이 직접 묘사됨', dbCompatibility:'explicit_transition'
  }], { turn:41, assistantText:firstSexEventText });
  const afterFirstSexHistory = clone(userDlc.getState().entityTrackers.find(item=>item.id===sexualHistory.id));
  const duplicateSexHistoryEvent = userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', eventKey:'scene-2026-07-05-sexual-encounter-1', eventType:'partnered_sex', sceneDate:'2026-07-05',
    sexualHistoryDelta:{ sexCount:1, vaginalEjaculationCount:1, fellatioCount:1, newPartnerCount:1, partnerNames:['베른'], firstSexPartner:'베른' },
    evidence:[firstSexEventText], reason:'같은 사건의 재언급', dbCompatibility:'compatible'
  }], { turn:42, assistantText:firstSexEventText });
  const secondSexEventText = '다음 날 성인인 아리엘과 카일의 별도 성관계가 완료되었으며 애널 섹스가 한 차례 직접 묘사되었다.';
  userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', eventKey:'scene-2026-07-06-sexual-encounter-2', eventType:'partnered_sex', sceneDate:'2026-07-06',
    sexualHistoryDelta:{ sexCount:1, analSexCount:1, newPartnerCount:1, partnerNames:['카일'], firstSexPartner:'카일' },
    evidence:[secondSexEventText], reason:'별개의 완료 사건', dbCompatibility:'explicit_transition'
  }], { turn:43, assistantText:secondSexEventText });
  const pregnancyHistoryText = '이후 검사로 아리엘의 임신이 확정되었다.';
  userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', eventKey:'scene-2026-08-01-pregnancy-confirmed-1', eventType:'pregnancy_confirmed', sceneDate:'2026-08-01',
    sexualHistoryDelta:{ pregnancyCount:1 }, evidence:[pregnancyHistoryText], reason:'검사로 확정된 임신 사건', dbCompatibility:'explicit_transition'
  }], { turn:44, assistantText:pregnancyHistoryText });
  const birthHistoryText = '극중 시간이 흐른 뒤 아리엘의 출산이 완료되었다.';
  userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', eventKey:'scene-2027-04-20-birth-1', eventType:'birth_completed', sceneDate:'2027-04-20',
    sexualHistoryDelta:{ birthCount:1 }, evidence:[birthHistoryText], reason:'직접 확인된 출산 완료 사건', dbCompatibility:'explicit_transition'
  }], { turn:45, assistantText:birthHistoryText });
  const bareDeltaRejected = userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', sexualHistoryDelta:{ masturbationCount:1 },
    evidence:['아리엘의 자위가 완료되었다.'], reason:'사건 키 누락', dbCompatibility:'explicit_transition'
  }], { turn:46, assistantText:'아리엘의 자위가 완료되었다.' });
  const masturbationHistoryText = '성인인 아리엘의 자위가 한 차례 완료된 장면이 직접 묘사되었다.';
  userDlc.applyTrackerUpdates([{
    trackerId:sexualHistory.id, value:'tracking', confidence:'confirmed', eventKey:'scene-2027-04-21-masturbation-1', eventType:'masturbation_completed', sceneDate:'2027-04-21',
    sexualHistoryDelta:{ masturbationCount:1 }, evidence:[masturbationHistoryText], reason:'직접 확인된 완료 사건', dbCompatibility:'explicit_transition'
  }], { turn:47, assistantText:masturbationHistoryText });
  const afterSexHistory = clone(userDlc.getState().entityTrackers.find(item=>item.id===sexualHistory.id));
  const sexualHistoryPrompt = userDlc.formatTargetAnalysesForPrompt(['아리엘'], 6200);
  assertions.push(assert('user_dlc_sexual_history_kind_forces_locked_event_ledger', sexualHistory?.kind === 'sexual_history' && sexualHistory?.eventResolutionMode === 'single_event_locked', sexualHistory || {}));
  assertions.push(assert('user_dlc_sexual_history_direct_event_counts_once', firstSexHistoryEvent?.evaluated === 1 && duplicateSexHistoryEvent?.evaluated === 1 && afterFirstSexHistory?.currentSnapshot?.sexCount === 1 && afterFirstSexHistory?.eventLedger?.length === 1 && afterSexHistory?.currentSnapshot?.sexCount === 2 && afterSexHistory?.eventLedger?.length === 5, { afterFirstSexHistory, afterSexHistory }));
  assertions.push(assert('user_dlc_sexual_history_tracks_requested_fields_without_overwriting_first_partner', afterSexHistory?.currentSnapshot?.virginityStatus === 'sexually_experienced' && afterSexHistory?.currentSnapshot?.masturbationCount === 1 && afterSexHistory?.currentSnapshot?.pregnancyCount === 1 && afterSexHistory?.currentSnapshot?.birthCount === 1 && afterSexHistory?.currentSnapshot?.distinctPartnerCount === 2 && afterSexHistory?.currentSnapshot?.vaginalEjaculationCount === 1 && afterSexHistory?.currentSnapshot?.fellatioCount === 1 && afterSexHistory?.currentSnapshot?.analSexCount === 1 && afterSexHistory?.currentSnapshot?.firstSexPartner === '베른' && afterSexHistory?.currentSnapshot?.knownSexPartners?.join('|') === '베른|카일', afterSexHistory?.currentSnapshot || {}));
  assertions.push(assert('user_dlc_sexual_history_unknown_baseline_is_observed_minimum_not_zero', afterSexHistory?.currentSnapshot?.sexualHistoryCountingBasis === 'observed_minimum' && bareDeltaRejected?.evaluated === 0 && afterSexHistory?.currentSnapshot?.masturbationCount === 1, { bareDeltaRejected, snapshot:afterSexHistory?.currentSnapshot }));
  assertions.push(assert('user_dlc_sexual_history_projection_exposes_counts_and_dedupe_lock', /Partnered sex encounters: 2 events \(confirmed minimum/.test(sexualHistoryPrompt) && /First sex partner: 베른/.test(sexualHistoryPrompt) && /Never count this event again/.test(sexualHistoryPrompt) && /never anatomy or hymen inference/.test(sexualHistoryPrompt), { sexualHistoryPrompt }));
  userDlc.resetState({ entityTrackers:[afterSexHistory] });
  const reloadedSexHistory = userDlc.getState().entityTrackers.find(item=>item.id===sexualHistory.id);
  assertions.push(assert('user_dlc_sexual_history_survives_state_reload_with_event_deltas', reloadedSexHistory?.currentSnapshot?.sexCount === 2 && reloadedSexHistory?.currentSnapshot?.firstSexPartner === '베른' && reloadedSexHistory?.eventLedger?.length === 5 && reloadedSexHistory?.eventLedger?.[0]?.sexualHistoryDelta?.fellatioCount === 1, reloadedSexHistory || {}));
  userDlc.ingestAdaptiveItems({ adaptiveItems:[{
    targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', kind:'sexual_history', label:'성경험 이력',
    instruction:'기존 이력과 새 직접 근거를 함께 사용한다.', valueType:'status', allowedValues:['unknown','tracking'], currentValue:'tracking', trackingEnabled:true,
    currentSnapshot:{ sexCount:null, virginityStatus:'unknown', pregnancyCount:null, firstSexPartner:'', knownSexPartners:[], sexualHistoryCountingBasis:'unknown' }
  }]}, { turn:48 });
  const reanalyzedSexHistory = userDlc.getState().entityTrackers.find(item=>item.id===sexualHistory.id);
  assertions.push(assert('user_dlc_sexual_history_reanalysis_does_not_erase_existing_counts_or_identity_history', reanalyzedSexHistory?.currentSnapshot?.sexCount === 2 && reanalyzedSexHistory?.currentSnapshot?.masturbationCount === 1 && reanalyzedSexHistory?.currentSnapshot?.pregnancyCount === 1 && reanalyzedSexHistory?.currentSnapshot?.virginityStatus === 'sexually_experienced' && reanalyzedSexHistory?.currentSnapshot?.firstSexPartner === '베른' && reanalyzedSexHistory?.currentSnapshot?.knownSexPartners?.join('|') === '베른|카일' && reanalyzedSexHistory?.eventLedger?.length === 5, reanalyzedSexHistory || {}));

  userDlc.resetState({ entityTrackers:[{ targetType:'entity', targetIds:['entity-ariel'], displayName:'아리엘', label:'구형 일회성 항목', instruction:'한 번만 분석한다.', valueType:'text', currentValue:'완료', updateMode:'manual' }] });
  assertions.push(assert('user_dlc_legacy_manual_tracker_does_not_reactivate_on_load', userDlc.getState().entityTrackers[0]?.enabled === false && userDlc.getState().entityTrackers[0]?.updateMode === 'manual', userDlc.getState().entityTrackers[0] || {}));

  core.resetState();
  core.upsertDirective({
    type:'character_addition', name:'세이라', title:'지하서고의 미등록 사서 세이라', role:'local helper',
    description:'달그림자 도서관 지하서고에서만 활동하는 미등장 사서. 별핵 색인 위치를 알고 있다.',
    directive:'도현이 지하서고에서 단서를 찾을 때 세이라가 현지 연락책처럼 조심스럽게 도움을 준다.',
    purpose:'정본 조력자가 접근할 수 없는 폐쇄 색인 단서를 제공',
    sourceBasis:['달그림자 도서관 지하서고', '별핵 기록 조사 임무'],
    noveltyReason:'아리엘은 공개 기록 담당이라 폐쇄 색인의 내부 이동 경로를 알 수 없고, 지하서고 현지 담당자가 필요하다.',
    noveltyScope:'unintroduced_new', progressionTier:'local', activationCondition:'달그림자 도서관 지하서고에서 별핵 색인을 찾을 때', forceLevel:'firm', userImpact:'soft', status:'armed'
  });
  let prompt = core.formatForPrompt(baseCtx, config);
  assertions.push(assert('grounded_unintroduced_character_injected', /세이라/.test(prompt) && /unintroduced/i.test(prompt), { prompt: prompt.slice(0,700) }));
  let state = core.getState();
  assertions.push(assert('injected_state_recorded', state.characterAdditions?.[0]?.status === 'injected' && state.lastInjectedIds?.length > 0, state.characterAdditions?.[0] || {}));

  core.resetState();
  core.upsertDirective({
    type:'character_addition', name:'종말의 황제', title:'최종 보스 직접 등장', role:'final boss',
    description:'세계의 최종 흑막이 초반 조사 장면에 직접 나타난다.', directive:'지금 즉시 최종 보스를 등장시킨다.', purpose:'강한 충격',
    sourceBasis:['달그림자 도서관'], progressionTier:'final', activationCondition:'초반 조사 장면', forceLevel:'hard', userImpact:'soft', status:'armed'
  });
  prompt = core.formatForPrompt(baseCtx, config);
  assertions.push(assert('premature_final_boss_blocked', !/종말의 황제|최종 보스/.test(prompt), { prompt }));

  core.resetState();
  core.upsertDirective({
    type:'character_addition', name:'랜덤 여행자', title:'랜덤 여행자', role:'helper', description:'뜬금없이 지나가던 여행자가 도와준다.', directive:'등장시킨다.', purpose:'도움', progressionTier:'local', forceLevel:'firm', userImpact:'soft', status:'armed'
  });
  prompt = core.formatForPrompt(baseCtx, config);
  assertions.push(assert('ungrounded_character_blocked', !/랜덤 여행자/.test(prompt), { prompt }));

  core.resetState();
  core.upsertDirective({
    type:'character_addition', name:'사용자의 숨겨진 혈통을 아는 예언자', title:'혈통 예언자', role:'oracle',
    description:'사용자의 숨겨진 혈통을 강제로 밝힌다.', directive:'사용자의 혈통을 확정한다.', purpose:'대형 반전', sourceBasis:['예언'], progressionTier:'local', activationCondition:'아무 장면', forceLevel:'hard', userImpact:'major', status:'armed', manualInjection:true
  });
  prompt = core.formatForPrompt(baseCtx, { ...config, worldAdditionalEnabled:false, worldAdditionalMode:'off', worldAdditionalMaxPerRequest:1 });
  assertions.push(assert('manual_injection_bypasses_retired_global_strength_and_impact_limits', /혈통 예언자|숨겨진 혈통/.test(prompt) && !/Force:|User impact:/.test(prompt), { prompt }));

  core.resetState();
  core.upsertDirective({
    type:'world_delta', title:'폐쇄 색인실', description:'달그림자 도서관 지하서고에는 공식 목록에 없는 폐쇄 색인실이 있다.', directive:'색인실을 조사 경로로 사용할 수 있게 한다.', sourceBasis:['달그림자 도서관 지하서고', '별핵 기록 조사'], progressionTier:'local', activationCondition:'지하서고 조사', forceLevel:'firm', userImpact:'ambient', status:'armed'
  });
  prompt = core.formatForPrompt(baseCtx, config);
  assertions.push(assert('grounded_world_delta_injected', /폐쇄 색인실/.test(prompt) && /World Delta/.test(prompt), { prompt: prompt.slice(0,700) }));

  const customConfig = {
    ...config,
    worldAdditionalEnabled:false,
    worldAdditionalMode:'off',
    worldCanonCustomForce:true,
    worldCanonCustomText:'리브라 캐논 DB 반영: 달그림자 도서관 지하서고에는 공식 목록에 없는 폐쇄 색인실이 존재한다.',
    worldAdditionalCustomForce:true,
    worldAdditionalCustomText:'월드 에디셔널 반영: 이번 임무에는 달그림자 도서관 지하서고의 미등장 사서 세이라를 현지 조력자로 추가한다.'
  };
  core.resetState();
  prompt = core.formatForPrompt(baseCtx, customConfig);
  assertions.push(assert('retired_direct_instruction_fields_are_ignored', prompt === '', { prompt: prompt.slice(0,1000) }));

  const manifestConfig = config;
  core.resetState();
  const { directive } = core.upsertDirective({ type:'world_delta', title:'폐쇄 색인실', description:'달그림자 도서관 지하서고의 폐쇄 색인실.', directive:'색인실을 실제 조사 경로로 쓴다.', sourceBasis:['달그림자 도서관'], progressionTier:'local', activationCondition:'지하서고 조사', forceLevel:'firm', userImpact:'ambient', status:'armed' });
  prompt = core.formatForPrompt(baseCtx, manifestConfig);
  core.ingestMaintenance({ manifestations:[{ id: directive.id, title:'폐쇄 색인실', type:'world_delta', manifested:true, integrate:true, note:'assistant used it' }] }, '도현은 폐쇄 색인실 안쪽에서 별핵 기록을 발견했다.', { turn:8 }, manifestConfig);
  state = core.getState();
  const found = state.worldDeltas?.find(x => x.id === directive.id);
  assertions.push(assert('manifested_world_delta_integrated', found?.status === 'integrated' && found?.manifestedTurn === 8, found || {}));

  core.resetState();
  core.upsertDirective({
    type:'world_delta', title:'폐쇄 색인 통로', description:'달그림자 도서관 지하서고에 폐쇄 색인 통로가 있다.',
    directive:'도현이 현재 조사에서 폐쇄 색인 통로를 실제 단서 경로로 사용할 수 있게 한다.',
    sourceBasis:['달그림자 도서관', '별핵 기록 조사'], progressionTier:'local',
    activationCondition:'지하서고에서 별핵 기록을 조사할 때', forceLevel:'firm', userImpact:'ambient', status:'armed'
  });
  const storage = env.context.LibraDataStorage;
  const fixtureAdmission = await storage.preparePersonaContext(env.char, env.chat);
  assertions.push(assert('hook_fixture_admits_empty_scope_before_producing_managed_rows', fixtureAdmission.ok === true,
    { admission: fixtureAdmission }));
  core.resetState({ ...core.getState(), scopeKey:fixtureAdmission.runtimeScopeKey, chatId:env.chat.id });
  const persistedLore = engine.getLorebook(env.char, env.chat) || [];
  await core.saveState(persistedLore);
  userDlc.resetState({ scopeKey:fixtureAdmission.runtimeScopeKey, chatId:env.chat.id });
  userDlc.upsertWorldItem({ kind:'trap', title:'별핵 공명 함정', userConcept:'기억 잔향을 읽는 봉인 함정', adaptedConcept:'별핵 색인의 공명 봉인이 최근 기억 잔향을 감지한다.', mechanism:'기록 마법 공명', trigger:'폐쇄 색인 무단 접촉', counterplay:['정식 열람 표식'], sourceBasis:['달그림자 도서관','별핵 금지 연구'], status:'armed' }, { turn:7 });
  await userDlc.saveState(persistedLore);
  engine.setLorebook(env.char, env.chat, persistedLore);
  const unownedAdmission = await storage.preparePersonaContext(env.char, env.chat);
  assertions.push(assert('managed_hook_fixture_requires_canonical_ownership',
    unownedAdmission.ok === false && unownedAdmission.reason === 'canonical_missing_unverified_data',
    { admission:unownedAdmission }));
  const admissionProbe = [{ role:'system', content:'Admission probe' }, { role:'user', content:'Read the archive' }];
  const unownedHostBefore = JSON.stringify(env.chat);
  const admissionProbeHandler = env.replacers.beforeRequest[env.replacers.beforeRequest.length - 1];
  const rejectedProbe = await admissionProbeHandler(admissionProbe, 'model');
  assertions.push(assert('before_request_hook_preserves_request_and_host_for_unowned_managed_rows',
    JSON.stringify(rejectedProbe) === JSON.stringify(admissionProbe) && JSON.stringify(env.chat) === unownedHostBefore
    && storage.getShadowEntries(fixtureAdmission.scopeKey).length === 0,
    { requestUnchanged:JSON.stringify(rejectedProbe) === JSON.stringify(admissionProbe), hostUnchanged:JSON.stringify(env.chat) === unownedHostBefore }));
  const canonicalSave = await storage.save(env.char, env.chat, persistedLore);
  const canonicalRead = await storage.readVerified(fixtureAdmission.scopeKey);
  const canonicalAdmission = await storage.preparePersonaContext(env.char, env.chat);
  const producedStates = canonicalRead.entries?.filter(row => ['lmai_world_additional','lmai_user_dlc'].includes(row.comment)) || [];
  assertions.push(assert('hook_fixture_persists_admitted_producer_states_before_injection',
    canonicalSave.ok === true && canonicalSave.verified === true && canonicalRead.ok === true && canonicalAdmission.ok === true
    && producedStates.length === 2 && producedStates.every(row => JSON.parse(row.content).scopeKey === fixtureAdmission.runtimeScopeKey),
    { save:canonicalSave, admission:canonicalAdmission, producedStates:producedStates.map(row => ({ comment:row.comment, scopeKey:JSON.parse(row.content).scopeKey })) }));
  env.chat.msgs = [{ role:'assistant', content:'달그림자 도서관 지하서고에서 별핵 기록 조사가 시작되었다.', m_id:'wa-greeting' }];
  env.chat.message = env.chat.msgs;
  env.char.chats[0] = env.chat;
  const beforeHandler = env.replacers.beforeRequest[env.replacers.beforeRequest.length - 1];
  const rollout = env.context.__LIBRA_WA_TEST__.TypedRecallRollout;
  assertions.push(assert('owned_world_hook_uses_actual_default_production_dual', engine.CONFIG.dualRecallMode === 'dual' && rollout.inspect().productionEligible === true));
  const unknownCapacityRequest = [
      { role:'system', content:'월드 에디셔널 훅 통합 테스트' },
      { role:'user', content:'도현은 달그림자 도서관 지하서고에서 별핵 기록의 다음 단서를 조사한다.' }
    ];
  const unknownRequestBefore = JSON.stringify(unknownCapacityRequest), unknownHostBefore = JSON.stringify(env.chat);
  const unknownCanonicalBefore = await storage.readVerified(fixtureAdmission.scopeKey);
  const unknownResult = await beforeHandler(unknownCapacityRequest, 'model');
  const unknownCanonicalAfter = await storage.readVerified(fixtureAdmission.scopeKey);
  const unknownTrace = rollout.inspect().last;
  assertions.push(assert('unknown_host_budget_preserves_request_and_host_for_required_control_loss',
    JSON.stringify(unknownResult) === unknownRequestBefore && JSON.stringify(env.chat) === unknownHostBefore
    && unknownCanonicalBefore.ok && unknownCanonicalAfter.ok && typeof unknownCanonicalBefore.raw === 'string'
    && unknownCanonicalBefore.raw === unknownCanonicalAfter.raw
    && unknownTrace.consumer.trace.status === 'protected_core_lost'
    && unknownTrace.consumer.protectedDrops.some(drop => drop.reason === 'budget'),
    {budget:unknownTrace.budgetInfo, drops:unknownTrace.consumer.protectedDrops}));
  assertions.push(assert('unknown_host_budget_does_not_report_empty_core_recovery',
    unknownTrace.fallback.status === 'unrecoverable_core_validity' && unknownTrace.fallback.reason === 'no_required_typed_core',
    {fallback:unknownTrace.fallback}));
  // Restore the same acknowledged producer snapshots for the independent positive.
  core.resetState(JSON.parse(canonicalRead.entries.find(row => row.comment === 'lmai_world_additional').content));
  userDlc.resetState(JSON.parse(canonicalRead.entries.find(row => row.comment === 'lmai_user_dlc').content));
  let hookedRequest = null;
  let hookError = '';
  try {
    hookedRequest = await beforeHandler({messages:[
      { role:'system', content:'월드 에디셔널 훅 통합 테스트' },
      { role:'user', content:'도현은 달그림자 도서관 지하서고에서 별핵 기록의 다음 단서를 조사한다.' }
    ],maxContextTokens:128000,maxResponseTokens:4096}, 'model');
  } catch (error) {
    hookError = error?.stack || error?.message || String(error);
  }
  const hookedText = JSON.stringify(hookedRequest || '');
  assertions.push(assert('before_request_hook_injects_world_additional', !hookError && /WORLD ADDITIONAL DIRECTIVE/.test(hookedText) && /폐쇄 색인 통로/.test(hookedText), {
    error: hookError,
    messageCount: Array.isArray(hookedRequest) ? hookedRequest.length : (Array.isArray(hookedRequest?.messages) ? hookedRequest.messages.length : 0),
    hasDirectiveHeader: /WORLD ADDITIONAL DIRECTIVE/.test(hookedText),
    hasDirectiveTitle: /폐쇄 색인 통로/.test(hookedText),
    preview: hookedText.slice(Math.max(0, hookedText.indexOf('WORLD ADDITIONAL DIRECTIVE') - 120), Math.max(0, hookedText.indexOf('WORLD ADDITIONAL DIRECTIVE') + 1800)),
    logs: env.logs.slice(-40)
  }));
  assertions.push(assert('before_request_hook_injects_user_dlc_world', !hookError && /USER DLC — WORLD/.test(hookedText) && /별핵 공명 함정/.test(hookedText), {
    error: hookError,
    hasUserDlcHeader: /USER DLC — WORLD/.test(hookedText),
    hasUserDlcTitle: /별핵 공명 함정/.test(hookedText),
    preview: hookedText.slice(Math.max(0, hookedText.indexOf('USER DLC') - 200), Math.max(0, hookedText.indexOf('USER DLC') + 1400))
  }));

  const ok = assertions.every(a=>a.ok);
  console.log(JSON.stringify({ ok, assertions }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch(e=>{ console.error(e); process.exit(1); });
