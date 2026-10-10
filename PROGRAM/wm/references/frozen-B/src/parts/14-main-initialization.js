// ══════════════════════════════════════════════════════════════
// [MAIN] Initialization
// ══════════════════════════════════════════════════════════════
const updateConfigFromArgs = async () => {
    const cfg = MemoryEngine.CONFIG;
    delete cfg.manualOocPause;
    delete cfg.manual_ooc_pause;
    delete cfg.internalDataLanguageMode;
    delete cfg.internalDataLanguageDebug;
    delete cfg.internal_data_language_mode;
    delete cfg.internal_data_language_debug;
    let local = {};

    try {
        const saved = await readCommonPluginSettings();
        // ★ 옛 alias 를 정본 키로 접는다 — 구 저장 데이터의 사용자 설정이 보존된다(P1).
        //   그러지 않으면 `local.hybridMemoryEngineEnabled` 가 없어 config 기본값으로 내려간다.
        if (saved) local = (() => { try { const p = typeof saved === 'string' ? JSON.parse(saved) : saved; const normalized = p && typeof p === 'object' && !Array.isArray(p) ? p : {}; return normalizeMemoryRetentionSettings(normalizeSettingsAliases(normalized)); } catch (_) { return {}; } })();
    } catch (e) {
        recordRuntimeDebug('warn', '[LIBRA] Config load failed:', e?.message || e);
    }

    const getVal = async (key, argName, type, parent, fallback) => {
        const localVal = parent ? local[parent]?.[key] : local[key];
        let argVal;
        try {
            argVal = await RisuCompat.getArgument(argName);
        } catch {}
        const configVal = parent ? cfg[parent]?.[key] : cfg[key];
        const hasArgVal = argVal !== undefined && argVal !== null && argVal !== '';
        const raw = hasArgVal ? argVal : localVal !== undefined ? localVal : configVal !== undefined ? configVal : fallback;

        if (raw === undefined || raw === null) return fallback;

        switch (type) {
            case 'number': { const n = Number(raw); return Number.isFinite(n) ? n : (fallback ?? configVal); }
            case 'boolean': return parseRuntimeBoolean(raw, parseRuntimeBoolean(localVal, parseRuntimeBoolean(configVal, fallback)));
            default: return String(raw);
        }
    };
    const readRuntimeArg = async (argName) => {
        try {
            const value = await RisuCompat.getArgument(argName);
            return value !== undefined && value !== null && String(value).trim() !== '' ? value : undefined;
        } catch {
            return undefined;
        }
    };
    const hasRuntimeArgValue = async (argName) => await readRuntimeArg(argName) !== undefined;
    const parseRuntimeBoolean = (raw, fallback) => {
        if (raw === undefined || raw === null) return fallback;
        if (raw === true || raw === 1) return true;
        if (raw === false || raw === 0) return false;
        const text = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', 'enable', 'enabled'].includes(text)) return true;
        if (['false', '0', 'no', 'n', 'off', 'disable', 'disabled'].includes(text)) return false;
        return fallback;
    };
    const parseRuntimeNumber = (raw, fallback) => {
        if (raw === undefined || raw === null) return fallback;
        const n = Number(String(raw).trim().replace(/,/g, ''));
        return Number.isFinite(n) ? n : fallback;
    };
    const parseRuntimeRatio = (raw, fallback, options = {}) => {
        if (raw === undefined || raw === null) return fallback;
        const text = String(raw).trim();
        const hasPercent = /%$/.test(text);
        const n = parseRuntimeNumber(text.replace(/%$/, ''), NaN);
        const allowZero = options.allowZero === true;
        if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return fallback;
        if (n === 0) return 0;
        if (hasPercent) return n <= 100 ? n / 100 : fallback;
        if (n >= 1) return n <= 100 ? n / 100 : fallback;
        return n;
    };
    const parseRuntimeJsonObject = (raw, fallback = {}) => {
        if (raw === undefined || raw === null || raw === '') return fallback;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
        try {
            const parsed = JSON.parse(String(raw || '').trim());
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
        } catch {
            return fallback;
        }
    };
    const normalizeRuntimeInjectionBudgetPreset = (value, fallback) => {
        const key = String(value || '').trim().toLowerCase();
        if (!key) return fallback;
        if (['small', 'compact'].includes(key)) return 'compact';
        if (['medium', 'balanced'].includes(key)) return 'balanced';
        if (['high', 'large'].includes(key)) return 'large';
        if (['xlarge', 'ultra', 'max'].includes(key)) return 'max';
        if (key === 'custom') return 'custom';
        return fallback;
    };
    const getRuntimeArgVal = async (argName, type, fallback, savedKey = null) => {
        const arg = await readRuntimeArg(argName);
        // Only declared user settings opt into this saved layer. Hidden defaults stay unchanged.
        const raw = arg !== undefined ? arg : savedKey ? local[savedKey] : undefined;
        if (raw === undefined || raw === null) return fallback;
        switch (type) {
            case 'number':
                return parseRuntimeNumber(raw, fallback);
            case 'boolean':
                return parseRuntimeBoolean(raw, fallback);
            default:
                return String(raw);
        }
    };
    const normalizeStringOption = (value, allowed, fallback) => {
        const raw = String(value || '').trim().toLowerCase();
        return allowed.includes(raw) ? raw : fallback;
    };
    const clampRuntimeNumber = (value, fallback, min, max) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    };
    const clampRuntimeInt = (value, fallback, min, max) => {
        const n = Math.floor(Number(value));
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    };
    const normalizeProviderTimeoutMs = (value, fallback, min = 5000, max = 600000) => {
        const n = Math.floor(Number(value));
        const fb = Math.floor(Number(fallback));
        const base = Number.isFinite(n) && n > 0 ? n : (Number.isFinite(fb) && fb > 0 ? fb : 120000);
        return Math.max(min, Math.min(max, base));
    };

    cfg.coldStartScopePreset = await getVal('coldStartScopePreset', 'cold_start_scope_preset', 'string', null, 'all');
    cfg.coldStartHistoryLimit = await getVal('coldStartHistoryLimit', 'cold_start_history_limit', 'number', null, 0);
    Object.assign(cfg, buildOptimizedHiddenSettingsDefaults({
        coldStartScopePreset: cfg.coldStartScopePreset,
        coldStartHistoryLimit: cfg.coldStartHistoryLimit
    }));
    cfg.analysisEvidenceMode = normalizeAnalysisEvidenceMode(await getVal('analysisEvidenceMode', 'analysis_evidence_mode', 'string', null, cfg.analysisEvidenceMode));
    cfg.entityBlocklist = normalizeEntityBlocklistCollection(await getVal('entityBlocklist', 'entity_blocklist', 'string', null, ''));
    cfg.storyAuthorEnabled = await getVal('storyAuthorEnabled', 'story_author_enabled', 'boolean', null, false);
    cfg.storyAuthorMode = await getVal('storyAuthorMode', 'story_author_mode', 'string', null, 'disabled');
    cfg.directorEnabled = await getVal('directorEnabled', 'director_enabled', 'boolean', null, false);
    cfg.directorMode = await getVal('directorMode', 'director_mode', 'string', null, 'disabled');
    cfg.worldAdditionalEnabled = true;
    cfg.worldAdditionalMode = 'firm';
    cfg.worldAdditionalMaxPerRequest = clampRuntimeInt(
        await getVal('worldAdditionalMaxPerRequest', 'world_additional_max_per_request', 'number', null, 3),
        3,
        1,
        6
    );
    cfg.worldAdditionalAutoIntegrate = true;
    cfg.worldCanonCustomText = '';
    cfg.worldCanonCustomForce = false;
    cfg.worldAdditionalCustomText = '';
    cfg.worldAdditionalCustomForce = false;
    cfg.entityVisualCanonEnabled = await getVal('entityVisualCanonEnabled', 'entity_visual_canon_enabled', 'boolean', null, true);
    cfg.resourceGovernorEnabled = await getVal('resourceGovernorEnabled', 'resource_governor_enabled', 'boolean', null, true);
    cfg.resourceWorkingSetSoftBytes = clampRuntimeInt(await getVal('resourceWorkingSetSoftBytes', 'resource_working_set_soft_bytes', 'number', null, 96 * 1024 * 1024), 96 * 1024 * 1024, 32 * 1024 * 1024, 1024 * 1024 * 1024);
    cfg.resourceWorkingSetHardBytes = clampRuntimeInt(await getVal('resourceWorkingSetHardBytes', 'resource_working_set_hard_bytes', 'number', null, 160 * 1024 * 1024), 160 * 1024 * 1024, Math.max(48 * 1024 * 1024, cfg.resourceWorkingSetSoftBytes + 16 * 1024 * 1024), 1536 * 1024 * 1024);
    cfg.resourcePendingQueueSoftBytes = clampRuntimeInt(await getVal('resourcePendingQueueSoftBytes', 'resource_pending_queue_soft_bytes', 'number', null, 8 * 1024 * 1024), 8 * 1024 * 1024, 1 * 1024 * 1024, 128 * 1024 * 1024);
    cfg.resourcePendingQueueHardBytes = clampRuntimeInt(await getVal('resourcePendingQueueHardBytes', 'resource_pending_queue_hard_bytes', 'number', null, 24 * 1024 * 1024), 24 * 1024 * 1024, Math.max(2 * 1024 * 1024, cfg.resourcePendingQueueSoftBytes + 1 * 1024 * 1024), 256 * 1024 * 1024);
    cfg.resourceSampleIntervalMs = clampRuntimeInt(await getVal('resourceSampleIntervalMs', 'resource_sample_interval_ms', 'number', null, 2000), 2000, 500, 15000);
    cfg.resourcePressureHoldMs = clampRuntimeInt(await getVal('resourcePressureHoldMs', 'resource_pressure_hold_ms', 'number', null, 3500), 3500, 500, 30000);
    cfg.resourceRecoveryHoldMs = clampRuntimeInt(await getVal('resourceRecoveryHoldMs', 'resource_recovery_hold_ms', 'number', null, 15000), 15000, 3000, 120000);
    cfg.resourceTargetTaskSliceMs = clampRuntimeNumber(await getVal('resourceTargetTaskSliceMs', 'resource_target_task_slice_ms', 'number', null, 10), 10, 4, 30);
    cfg.resourceNormalMaintenanceConcurrency = clampRuntimeInt(await getVal('resourceNormalMaintenanceConcurrency', 'resource_normal_maintenance_concurrency', 'number', null, 3), 3, 1, 6);
    cfg.resourcePressureMaintenanceConcurrency = clampRuntimeInt(await getVal('resourcePressureMaintenanceConcurrency', 'resource_pressure_maintenance_concurrency', 'number', null, 2), 2, 1, 4);
    cfg.resourceCriticalMaintenanceConcurrency = clampRuntimeInt(await getVal('resourceCriticalMaintenanceConcurrency', 'resource_critical_maintenance_concurrency', 'number', null, 1), 1, 1, 2);
    if (!cfg.storyAuthorEnabled || String(cfg.storyAuthorMode || '').toLowerCase() === 'disabled') {
        cfg.storyAuthorEnabled = false;
        cfg.storyAuthorMode = 'disabled';
    } else {
        cfg.storyAuthorEnabled = true;
    }
    if (!cfg.directorEnabled || String(cfg.directorMode || '').toLowerCase() === 'disabled') {
        cfg.directorEnabled = false;
        cfg.directorMode = 'disabled';
    } else {
        cfg.directorEnabled = true;
    }
    cfg.worldAdditionalEnabled = true;
    cfg.worldAdditionalMode = 'firm';
    sanitizeMemoryRetentionConfig(cfg, 'config-load');
    {
        let activityDashboardArg;
        try { activityDashboardArg = await RisuCompat.getArgument('activity_dashboard'); } catch (_) {}
        const hasActivityDashboardArg = activityDashboardArg !== undefined && activityDashboardArg !== null && String(activityDashboardArg).trim() !== '';
        const hasSavedActivityDashboard = local && Object.prototype.hasOwnProperty.call(local, 'activityDashboard');
        const rawActivityDashboard = hasActivityDashboardArg
            ? activityDashboardArg
            : hasSavedActivityDashboard
                ? local.activityDashboard
                : 'compact';
        cfg.activityDashboard = normalizeActivityDashboard(rawActivityDashboard, 'compact');
    }
    cfg.flexRoutingMode = FlexTierPolicy.normalizeRoutingMode(await getVal('flexRoutingMode', 'flex_routing_mode', 'string', null, 'off'));
    cfg.flexTimeoutMs = FlexTierPolicy.normalizeTimeout(await getVal('flexTimeoutMs', 'flex_timeout_ms', 'number', null, 600000));
    cfg.flexFallbackToStandard = await getVal('flexFallbackToStandard', 'flex_fallback_to_standard', 'boolean', null, false);
    cfg.vertexFlexMode = FlexTierPolicy.normalizeVertexFlexMode(await getVal('vertexFlexMode', 'vertex_flex_mode', 'string', null, 'provisioned_then_flex'));
    cfg.customServiceTierPassthrough = await getVal('customServiceTierPassthrough', 'custom_service_tier_passthrough', 'boolean', null, false);
    cfg.llm = {
        provider: await getVal('provider', 'llm_provider', 'string', 'llm', 'openai'),
        requestFormat: normalizeLLMRequestFormat(await getVal('requestFormat', 'llm_request_format', 'string', 'llm', 'chat_completions')),
        url: await getVal('url', 'llm_url', 'string', 'llm', ''),
        key: await getVal('key', 'llm_key', 'string', 'llm', ''),
        model: await getVal('model', 'llm_model', 'string', 'llm', 'gpt-4o-mini'),
        temp: await getVal('temp', 'llm_temp', 'number', 'llm', 0.3),
        timeout: normalizeProviderTimeoutMs(await getVal('timeout', 'llm_timeout_ms', 'number', 'llm', await getVal('timeout', 'llm_timeout', 'number', 'llm', 120000)), 120000),
        serviceTier: FlexTierPolicy.normalizeServiceTier(await getVal('serviceTier', 'llm_service_tier', 'string', 'llm', 'off')),
        reasoningPreset: await getVal('reasoningPreset', 'llm_reasoning_preset', 'string', 'llm', 'auto'),
        reasoningEffort: await getVal('reasoningEffort', 'llm_reasoning_effort', 'string', 'llm', 'none'),
        reasoningBudgetTokens: await getVal('reasoningBudgetTokens', 'llm_reasoning_budget_tokens', 'number', 'llm', DEFAULT_REASONING_BUDGET_TOKENS),
        maxCompletionTokens: await getVal('maxCompletionTokens', 'llm_max_completion_tokens', 'number', 'llm', DEFAULT_MAX_COMPLETION_TOKENS),
        glmThinkingType: await getVal('glmThinkingType', 'llm_glm_thinking', 'string', 'llm', await getVal('glmThinkingType', 'llm_glm_thinking_type', 'string', 'llm', 'enabled')),
        stream: await getVal('stream', 'llm_stream', 'boolean', 'llm', false)
    };
    cfg.auxLlm = {
        enabled: await getVal('enabled', 'aux_llm_enabled', 'boolean', 'auxLlm', false),
        provider: await getVal('provider', 'aux_llm_provider', 'string', 'auxLlm', cfg.llm.provider || 'openai'),
        requestFormat: normalizeLLMRequestFormat(await getVal('requestFormat', 'aux_llm_request_format', 'string', 'auxLlm', cfg.llm.requestFormat || 'chat_completions')),
        url: await getVal('url', 'aux_llm_url', 'string', 'auxLlm', cfg.llm.url || ''),
        key: await getVal('key', 'aux_llm_key', 'string', 'auxLlm', ''),
        model: await getVal('model', 'aux_llm_model', 'string', 'auxLlm', cfg.llm.model || 'gpt-4o-mini'),
        temp: await getVal('temp', 'aux_llm_temp', 'number', 'auxLlm', 0.2),
        timeout: normalizeProviderTimeoutMs(await getVal('timeout', 'aux_llm_timeout_ms', 'number', 'auxLlm', await getVal('timeout', 'aux_llm_timeout', 'number', 'auxLlm', 90000)), 90000),
        serviceTier: FlexTierPolicy.normalizeServiceTier(await getVal('serviceTier', 'aux_llm_service_tier', 'string', 'auxLlm', 'off')),
        reasoningPreset: await getVal('reasoningPreset', 'aux_llm_reasoning_preset', 'string', 'auxLlm', 'auto'),
        reasoningEffort: await getVal('reasoningEffort', 'aux_llm_reasoning_effort', 'string', 'auxLlm', 'none'),
        reasoningBudgetTokens: await getVal('reasoningBudgetTokens', 'aux_llm_reasoning_budget_tokens', 'number', 'auxLlm', DEFAULT_REASONING_BUDGET_TOKENS),
        maxCompletionTokens: await getVal('maxCompletionTokens', 'aux_llm_max_completion_tokens', 'number', 'auxLlm', DEFAULT_AUX_MAX_COMPLETION_TOKENS),
        glmThinkingType: await getVal('glmThinkingType', 'aux_llm_glm_thinking', 'string', 'auxLlm', await getVal('glmThinkingType', 'aux_llm_glm_thinking_type', 'string', 'auxLlm', 'enabled')),
        stream: await getVal('stream', 'aux_llm_stream', 'boolean', 'auxLlm', false)
    };
    if (!cfg.auxLlm.enabled || !isProviderProfileConfigured(cfg.auxLlm)) {
        cfg.auxLlm.enabled = false;
    }
    const llmPresetsRaw = await readRuntimeArg('llm_presets_json');
    const modelPresetsRaw = llmPresetsRaw === undefined ? await readRuntimeArg('model_presets_json') : undefined;
    const providerPresetsRaw = llmPresetsRaw === undefined && modelPresetsRaw === undefined ? await readRuntimeArg('provider_presets_json') : undefined;
    const llmRoutingRaw = await readRuntimeArg('llm_routing_json');
    const llmDefaultPresetRaw = await readRuntimeArg('llm_default_preset');
    const defaultPresetRaw = llmDefaultPresetRaw === undefined ? await readRuntimeArg('default_preset') : undefined;
    const presetSource = llmPresetsRaw !== undefined
        ? llmPresetsRaw
        : modelPresetsRaw !== undefined
            ? modelPresetsRaw
            : providerPresetsRaw !== undefined
                ? providerPresetsRaw
                : (local.llmPresetsJson !== undefined
                    ? local.llmPresetsJson
                    : local.modelPresetsJson !== undefined
                        ? local.modelPresetsJson
                        : local.providerPresetsJson !== undefined
                            ? local.providerPresetsJson
                            : (local.llmPresets !== undefined ? local.llmPresets : cfg.llmPresets));
    const routingSource = llmRoutingRaw !== undefined
        ? llmRoutingRaw
        : (local.llmRoutingJson !== undefined ? local.llmRoutingJson : (local.llmRouting !== undefined ? local.llmRouting : cfg.llmRouting));
    cfg.llmPresets = normalizeLLMPresetMap(
        parseRuntimeJsonObject(presetSource, cfg.llmPresets || {}),
        cfg.llm,
        cfg.auxLlm
    );
    cfg.llmRouting = normalizeLLMRouteMap(parseRuntimeJsonObject(routingSource, cfg.llmRouting || {}));
    cfg.llmDefaultPreset = normalizeLLMPresetName(
        llmDefaultPresetRaw !== undefined
            ? llmDefaultPresetRaw
            : defaultPresetRaw !== undefined
                ? defaultPresetRaw
                : (local.llmDefaultPreset || local.defaultPreset || local.defaultPresetName || cfg.llmDefaultPreset || '')
    );
    if (!cfg.llmDefaultPreset) cfg.llmDefaultPreset = 'primary';

    const embedProviderFallback = await getVal('provider', 'embed_provider', 'string', 'embed', 'voyageai');
    const embedUrlFallback = await getVal('url', 'embed_url', 'string', 'embed', 'https://api.voyageai.com/v1/embeddings');
    const embedKeyFallback = await getVal('key', 'embed_key', 'string', 'embed', '');
    const embedModelFallback = await getVal('model', 'embed_model', 'string', 'embed', 'voyage-4-large');
    const embedTimeoutFallback = await getVal('timeout', 'embed_timeout', 'number', 'embed', 120000);
    cfg.embed = {
        enabled: await getVal('enabled', 'embedding_enabled', 'boolean', 'embed', true),
        provider: await getVal('provider', 'embedding_provider', 'string', 'embed', embedProviderFallback),
        url: await getVal('url', 'embedding_url', 'string', 'embed', embedUrlFallback),
        key: await getVal('key', 'embedding_key', 'string', 'embed', embedKeyFallback),
        model: await getVal('model', 'embedding_model', 'string', 'embed', embedModelFallback),
        dimension: await getVal('dimension', 'embedding_dimension', 'number', 'embed', null),
        modelRevision: await getVal('modelRevision', 'embedding_model_revision', 'string', 'embed', ''),
        timeout: normalizeProviderTimeoutMs(await getVal('timeout', 'embedding_timeout_ms', 'number', 'embed', embedTimeoutFallback), 120000)
    };
    MemoryEngine.EmbeddingEngine.noteConfigurationPublished();
    cfg.debug = await getVal('debug', 'debug', 'boolean', null, cfg.debug);
    cfg.cbsEnabled = await getRuntimeArgVal('cbs_enabled', 'boolean', cfg.cbsEnabled, 'cbsEnabled');
    cfg.bypassAuxRequests = await getRuntimeArgVal('bypass_aux_requests', 'boolean', cfg.bypassAuxRequests, 'bypassAuxRequests');
    cfg.responseStreamingCompatEnabled = await getRuntimeArgVal('response_streaming_compat_enabled', 'boolean', cfg.responseStreamingCompatEnabled, 'responseStreamingCompatEnabled');
    cfg.useLorebookRAG = await getRuntimeArgVal('use_lorebook_rag', 'boolean', cfg.useLorebookRAG, 'useLorebookRAG');
    cfg.emotionEnabled = await getRuntimeArgVal('emotion_enabled', 'boolean', cfg.emotionEnabled, 'emotionEnabled');
    cfg.nsfwGuidancePromptEnabled = await getVal('nsfwGuidancePromptEnabled', 'nsfw_guidance_prompt_enabled', 'boolean', null, cfg.nsfwGuidancePromptEnabled !== false);
    cfg.assistantPrefillEnabled = await getVal('assistantPrefillEnabled', 'assistant_prefill_enabled', 'boolean', null, cfg.assistantPrefillEnabled !== false);
    const nsfwEnabledArg = await readRuntimeArg('nsfw_enabled');
    const nsfwModeArg = await readRuntimeArg('nsfw_mode');
    const legacyNsfwEnabled = nsfwEnabledArg !== undefined
        ? parseRuntimeBoolean(nsfwEnabledArg, cfg.nsfwEnabled)
        : parseRuntimeBoolean(local.nsfwEnabled, cfg.nsfwEnabled);
    cfg.nsfwMode = normalizeNsfwMode(
        nsfwModeArg !== undefined
            ? nsfwModeArg
            : nsfwEnabledArg !== undefined
                ? (legacyNsfwEnabled ? 'direct' : 'off')
                : local.nsfwMode !== undefined
                    ? local.nsfwMode
                    : (legacyNsfwEnabled ? (cfg.nsfwMode || 'direct') : 'off')
    );
    cfg.nsfwEnabled = cfg.nsfwMode !== 'off';
    cfg.sectionWorldInferenceEnabled = await getRuntimeArgVal('section_world_inference_enabled', 'boolean', cfg.sectionWorldInferenceEnabled, 'sectionWorldInferenceEnabled');
    cfg.secretKnowledgeEnabled = await getRuntimeArgVal('secret_knowledge_enabled', 'boolean', cfg.secretKnowledgeEnabled, 'secretKnowledgeEnabled');
    cfg.entityKnowledgeVaultEnabled = await getRuntimeArgVal('entity_knowledge_vault_enabled', 'boolean', cfg.entityKnowledgeVaultEnabled, 'entityKnowledgeVaultEnabled');
    cfg.rpLongTermMemoryEnabled = await getRuntimeArgVal('rp_long_term_memory_enabled', 'boolean', cfg.rpLongTermMemoryEnabled, 'rpLongTermMemoryEnabled');
    cfg.rpLongTermLlmEnrichment = await getRuntimeArgVal('rp_long_term_llm_enrichment', 'boolean', cfg.rpLongTermLlmEnrichment);
    cfg.rpLongTermInjectionMaxChars = clampRuntimeInt(await getRuntimeArgVal('rp_long_term_injection_max_chars', 'number', cfg.rpLongTermInjectionMaxChars, 'rpLongTermInjectionMaxChars'), cfg.rpLongTermInjectionMaxChars, 400, 12000);
    cfg.rpLongTermLongTtl = clampRuntimeInt(await getRuntimeArgVal('rp_long_term_long_ttl', 'number', cfg.rpLongTermLongTtl, 'rpLongTermLongTtl'), cfg.rpLongTermLongTtl, 120, 100000);
    cfg.rpLongTermMediumTtl = clampRuntimeInt(await getRuntimeArgVal('rp_long_term_medium_ttl', 'number', cfg.rpLongTermMediumTtl), cfg.rpLongTermMediumTtl, 60, 50000);
    cfg.characterSourceReflectionEnabled = await getRuntimeArgVal('character_source_reflection_enabled', 'boolean', cfg.characterSourceReflectionEnabled, 'characterSourceReflectionEnabled');
    cfg.personaBindingSyncEnabled = await getRuntimeArgVal('persona_binding_sync_enabled', 'boolean', cfg.personaBindingSyncEnabled, 'personaBindingSyncEnabled');
    cfg.backgroundMaintenanceDelayMs = clampRuntimeInt(await getRuntimeArgVal('background_maintenance_delay_ms', 'number', cfg.backgroundMaintenanceDelayMs), cfg.backgroundMaintenanceDelayMs, 0, 600000);
    cfg.afterRequestMaintenanceMode = normalizeAfterRequestMaintenanceMode(
        await getRuntimeArgVal('after_request_maintenance_mode', 'string', cfg.afterRequestMaintenanceMode),
        cfg.afterRequestMaintenanceMode || DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE
    );
    cfg.afterRequestForegroundTimeoutMs = normalizeAfterRequestForegroundTimeoutMs(
        await getRuntimeArgVal('after_request_foreground_timeout_ms', 'number', cfg.afterRequestForegroundTimeoutMs),
        cfg.afterRequestForegroundTimeoutMs || 45000
    );
    cfg.afterRequestAnalysisBudgetMs = normalizeAfterRequestAnalysisBudgetMs(
        await getRuntimeArgVal('after_request_analysis_budget_ms', 'number', cfg.afterRequestAnalysisBudgetMs),
        cfg.afterRequestAnalysisBudgetMs || 480000
    );
    cfg.afterRequestParallelAnalysis = await getRuntimeArgVal('after_request_parallel_analysis', 'boolean', cfg.afterRequestParallelAnalysis, 'afterRequestParallelAnalysis');
    cfg.maxLimit = await getRuntimeArgVal('max_limit', 'number', cfg.maxLimit, 'maxLimit');
    cfg.threshold = await getRuntimeArgVal('threshold', 'number', cfg.threshold, 'threshold');
    cfg.simThreshold = parseRuntimeRatio(await readRuntimeArg('sim_threshold'), parseRuntimeNumber(local.simThreshold, cfg.simThreshold));
    cfg.gcBatchSize = await getRuntimeArgVal('gc_batch_size', 'number', cfg.gcBatchSize, 'gcBatchSize');
    // memory_preset supplies retention defaults; explicit per-field args still win below.
    // 'custom' (the default) means "keep the configured values as-is".
    cfg.memoryPreset = normalizeStringOption(
        await getRuntimeArgVal('memory_preset', 'string', cfg.memoryPreset, 'memoryPreset'),
        [...Object.keys(MEMORY_PRESETS), 'custom'],
        cfg.memoryPreset
    );
    const presetValues = MEMORY_PRESETS[cfg.memoryPreset];
    if (presetValues && cfg.memoryPreset !== 'custom') {
        if (!await hasRuntimeArgValue('max_limit')) cfg.maxLimit = presetValues.maxLimit;
        if (!await hasRuntimeArgValue('threshold')) cfg.threshold = presetValues.threshold;
        if (!await hasRuntimeArgValue('sim_threshold')) cfg.simThreshold = presetValues.simThreshold;
        if (!await hasRuntimeArgValue('gc_batch_size')) cfg.gcBatchSize = presetValues.gcBatchSize;
    }
    // weight_mode + w_sim/w_imp/w_rec select the recall weight vector.
    cfg.weightMode = String(await getRuntimeArgVal('weight_mode', 'string', cfg.weightMode || 'auto', 'weightMode')).trim().toLowerCase() || 'auto';
    {
        cfg.weights = { ...(cfg.weights || {}), ...(local.weights && typeof local.weights === 'object' ? local.weights : {}) };
        const customWeights = {};
        const wSim = await readRuntimeArg('w_sim');
        const wImp = await readRuntimeArg('w_imp');
        const wRec = await readRuntimeArg('w_rec');
        if (wSim !== undefined && Number.isFinite(Number(wSim))) customWeights.similarity = Number(wSim);
        if (wImp !== undefined && Number.isFinite(Number(wImp))) customWeights.importance = Number(wImp);
        if (wRec !== undefined && Number.isFinite(Number(wRec))) customWeights.recency = Number(wRec);
        if (Object.keys(customWeights).length > 0) {
            cfg.weights = resolveWeightsForMode('custom', { ...(cfg.weights || {}), ...customWeights });
            if (!await hasRuntimeArgValue('weight_mode')) cfg.weightMode = 'custom';
        } else {
            cfg.weights = resolveWeightsForMode(cfg.weightMode, cfg.weights);
        }
    }
    sanitizeMemoryRetentionConfig(cfg, 'runtime-arg-override');
    cfg.worldAdjustmentMode = normalizeStringOption(
        await getRuntimeArgVal('world_adjustment_mode', 'string', cfg.worldAdjustmentMode),
        ['off', 'static', 'soft', 'dynamic', 'strict', 'hard'],
        cfg.worldAdjustmentMode || 'dynamic'
    );

    cfg.injectionBudgetPreset = normalizeRuntimeInjectionBudgetPreset(local.injectionBudgetPreset, cfg.injectionBudgetPreset);
    const savedInjectionBudget = parseRuntimeNumber(local.injectionBudgetMaxTokens ?? local.injectionBudgetTokens, NaN);
    if (Number.isFinite(savedInjectionBudget)) {
        // Preserve the saved GUI value; effective-budget clamps remain in the existing consumer.
        cfg.injectionBudgetMaxTokens = savedInjectionBudget;
        cfg.injectionBudgetTokens = cfg.injectionBudgetMaxTokens;
    }
    const injectionPresetArg = await readRuntimeArg('injection_budget_preset');
    const injectionMaxArg = await readRuntimeArg('injection_budget_max_tokens');
    const injectionTokensArg = injectionMaxArg === undefined ? await readRuntimeArg('injection_budget_tokens') : undefined;
    if (injectionPresetArg !== undefined) {
        cfg.injectionBudgetPreset = normalizeRuntimeInjectionBudgetPreset(injectionPresetArg, cfg.injectionBudgetPreset);
    }
    let injectionBudgetOverrideApplied = false;
    if (injectionMaxArg !== undefined || injectionTokensArg !== undefined) {
        const parsedInjectionBudget = parseRuntimeNumber(injectionMaxArg ?? injectionTokensArg, NaN);
        if (Number.isFinite(parsedInjectionBudget)) {
            cfg.injectionBudgetMaxTokens = clampInjectionBudgetMax(parsedInjectionBudget, { allowExtended: true });
            cfg.injectionBudgetTokens = cfg.injectionBudgetMaxTokens;
            if (injectionPresetArg === undefined) cfg.injectionBudgetPreset = 'custom';
            injectionBudgetOverrideApplied = true;
        }
    }
    if (!injectionBudgetOverrideApplied && cfg.injectionBudgetPreset !== 'custom') {
        cfg.injectionBudgetMaxTokens = getInjectionBudgetPresetTokens(cfg.injectionBudgetPreset);
        cfg.injectionBudgetTokens = cfg.injectionBudgetMaxTokens;
    }

    cfg.scoringProfile = normalizeREScoringProfile(local.scoringProfile ?? cfg.scoringProfile);
    cfg.scoringWeights = normalizeREScoringWeights(cfg.scoringProfile, local.scoringWeights ?? cfg.scoringWeights);
    const scoringProfileArg = await readRuntimeArg('scoring_profile');
    const scoringWeightOverrides = {};
    const scoringWeightArgMap = {
        word: 'scoring_word_weight',
        char: 'scoring_char_weight',
        concept: 'scoring_concept_weight',
        lexicalCoverage: 'scoring_lexical_coverage_weight',
        focus: 'scoring_focus_weight'
    };
    for (const [key, argName] of Object.entries(scoringWeightArgMap)) {
        const raw = await readRuntimeArg(argName);
        if (raw === undefined) continue;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) scoringWeightOverrides[key] = n;
    }
    if (scoringProfileArg !== undefined || Object.keys(scoringWeightOverrides).length > 0) {
        cfg.scoringProfile = normalizeREScoringProfile(scoringProfileArg ?? cfg.scoringProfile);
        cfg.scoringWeights = normalizeREScoringWeights(cfg.scoringProfile, scoringWeightOverrides);
    }
    cfg.recallEvidenceGate = normalizeStringOption(
        await getRuntimeArgVal('recall_evidence_gate', 'string', cfg.recallEvidenceGate, 'recallEvidenceGate'),
        ['off', 'soft', 'strict'],
        cfg.recallEvidenceGate || 'soft'
    );
    cfg.recallAnchorBonus = clampRuntimeNumber(parseRuntimeRatio(await readRuntimeArg('recall_anchor_bonus'), cfg.recallAnchorBonus, { allowZero: true }), cfg.recallAnchorBonus, 0, 1);
    cfg.recallSentenceWindowEnabled = await getRuntimeArgVal('recall_sentence_window', 'boolean', cfg.recallSentenceWindowEnabled);
    cfg.recallSentenceWindowChars = clampRuntimeInt(await getRuntimeArgVal('recall_sentence_window_chars', 'number', cfg.recallSentenceWindowChars), cfg.recallSentenceWindowChars, 80, 1200);
    cfg.recallInjectionMaxTokens = clampRuntimeInt(await getRuntimeArgVal('recall_injection_max_tokens', 'number', cfg.recallInjectionMaxTokens), cfg.recallInjectionMaxTokens, 320, 6000);
    cfg.recallScoringTextMaxChars = clampRuntimeInt(await getRuntimeArgVal('recall_scoring_text_max_chars', 'number', cfg.recallScoringTextMaxChars), cfg.recallScoringTextMaxChars, 160, 4000);
    cfg.recallScoringV2Enabled = await getRuntimeArgVal('recall_scoring_v2', 'boolean', cfg.recallScoringV2Enabled);
    cfg.recallDomainGuardEnabled = await getRuntimeArgVal('recall_domain_guard', 'boolean', cfg.recallDomainGuardEnabled);
    cfg.hybridMemoryEngineEnabled = await getRuntimeArgVal('hybrid_memory_engine', 'boolean', cfg.hybridMemoryEngineEnabled, 'hybridMemoryEngineEnabled');
    cfg.hybridReadPathEnabled = await getRuntimeArgVal('hybrid_read_path', 'boolean', cfg.hybridReadPathEnabled);
    cfg.hybridReadPathMaxRows = clampRuntimeInt(await getRuntimeArgVal('hybrid_read_path_max_rows', 'number', cfg.hybridReadPathMaxRows), cfg.hybridReadPathMaxRows, 1, 256);
    cfg.hybridWritePathEnabled = await getRuntimeArgVal('hybrid_write_path', 'boolean', cfg.hybridWritePathEnabled);
    cfg.hybridDuplicateFastEnabled = await getRuntimeArgVal('hybrid_duplicate_fast', 'boolean', cfg.hybridDuplicateFastEnabled);
    cfg.hybridDuplicateMaxHeavy = clampRuntimeInt(await getRuntimeArgVal('hybrid_duplicate_max_heavy', 'number', cfg.hybridDuplicateMaxHeavy), cfg.hybridDuplicateMaxHeavy, 0, 200);
    cfg.hybridScopeIndexEnabled = await getRuntimeArgVal('hybrid_scope_index', 'boolean', cfg.hybridScopeIndexEnabled);
    cfg.dualRecallMode = await getVal('dualRecallMode','dual_recall_mode','string',null,'dual');
    cfg.dualRecallHeuristicDepth = await getVal('dualRecallHeuristicDepth','dual_recall_heuristic_depth','number',null,32);
    cfg.dualRecallSemanticDepth = await getVal('dualRecallSemanticDepth','dual_recall_semantic_depth','number',null,32);
    cfg.dualRecallRrfK = await getVal('dualRecallRrfK','dual_recall_rrf_k','number',null,60);
    cfg.dualRecallQueryBudgetMs = await getVal('dualRecallQueryBudgetMs','dual_recall_query_budget_ms','number',null,1500);
    const admissionArg=await readRuntimeArg('dual_recall_admission_json');
    cfg.dualRecallAdmission=admissionArg!==undefined?admissionArg:local.dualRecallAdmission;
    TypedRecallRollout.configureProduction(cfg);
    const requestedInjectionMode = await getRuntimeArgVal('libra_injection_mode', 'string', cfg.libraInjectionMode);
    cfg.libraInjectionMode = normalizeLibraInjectionMode(requestedInjectionMode);
    if (String(requestedInjectionMode || '').trim().toLowerCase() === 'hybrid') {
        recordRuntimeDebug('warn', '[LIBRA] Transitional hybrid injection retired; using direct. Canonical data unchanged.');
    }
    cfg.libraProjectionAlwaysActive = await getRuntimeArgVal('libra_projection_always_active', 'boolean', cfg.libraProjectionAlwaysActive);
    cfg.libraProjectionMaxChars = clampRuntimeInt(await getRuntimeArgVal('libra_projection_max_chars', 'number', cfg.libraProjectionMaxChars), cfg.libraProjectionMaxChars, 400, 20000);
    cfg.libraProjectionRecallBundle = normalizeLibraProjectionRecallBundle(await getRuntimeArgVal('libra_projection_recall_bundle', 'string', cfg.libraProjectionRecallBundle));
    cfg.hmeAssociativeGraphMode = normalizeStringOption(
        await getRuntimeArgVal('hme_associative_graph', 'string', cfg.hmeAssociativeGraphMode, 'hmeAssociativeGraphMode'),
        ['off', 'light', 'balanced', 'deep'],
        cfg.hmeAssociativeGraphMode || LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode
    );
    cfg.hmeGraphMaxSeeds = clampRuntimeInt(await getRuntimeArgVal('hme_graph_max_seeds', 'number', cfg.hmeGraphMaxSeeds), cfg.hmeGraphMaxSeeds, 0, 32);
    cfg.hmeGraphMaxCandidates = clampRuntimeInt(await getRuntimeArgVal('hme_graph_max_candidates', 'number', cfg.hmeGraphMaxCandidates), cfg.hmeGraphMaxCandidates, 0, 96);
    cfg.hmeGraphMaxNodes = clampRuntimeInt(await getRuntimeArgVal('hme_graph_max_nodes', 'number', cfg.hmeGraphMaxNodes), cfg.hmeGraphMaxNodes, 64, 2400);
    cfg.hmeGraphMaxEdges = clampRuntimeInt(await getRuntimeArgVal('hme_graph_max_edges', 'number', cfg.hmeGraphMaxEdges), cfg.hmeGraphMaxEdges, 128, 4096);
    cfg.hmeGraphMaxHops = clampRuntimeInt(await getRuntimeArgVal('hme_graph_max_hops', 'number', cfg.hmeGraphMaxHops), cfg.hmeGraphMaxHops, 0, 2);
    cfg.hmeGraphBonusCap = clampRuntimeNumber(parseRuntimeRatio(await readRuntimeArg('hme_graph_bonus_cap'), cfg.hmeGraphBonusCap, { allowZero: true }), cfg.hmeGraphBonusCap, 0, 0.24);
    cfg.hmeGraphDebug = normalizeStringOption(
        await getRuntimeArgVal('hme_graph_debug', 'string', cfg.hmeGraphDebug, 'hmeGraphDebug'),
        ['off', 'compact', 'full'],
        cfg.hmeGraphDebug
    );
    // Hidden advanced defaults are intentionally not exposed in the GUI.
    // Direct injection is the canonical current-request path. Legacy projection
    // settings remain readable only when explicitly supplied by the user.
    if (!await hasRuntimeArgValue('libra_projection_max_chars') && Number(cfg.libraProjectionMaxChars || 0) < 6400) {
        cfg.libraProjectionMaxChars = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.libraProjectionMaxChars;
    }
    if (!await hasRuntimeArgValue('hme_associative_graph') && local.hmeAssociativeGraphMode === undefined && cfg.hmeAssociativeGraphMode === 'off') {
        cfg.hmeAssociativeGraphMode = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeAssociativeGraphMode;
    }
    if (!await hasRuntimeArgValue('hme_graph_max_seeds') && Number(cfg.hmeGraphMaxSeeds || 0) <= 8) {
        cfg.hmeGraphMaxSeeds = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxSeeds;
    }
    if (!await hasRuntimeArgValue('hme_graph_max_candidates') && Number(cfg.hmeGraphMaxCandidates || 0) <= 16) {
        cfg.hmeGraphMaxCandidates = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxCandidates;
    }
    if (!await hasRuntimeArgValue('hme_graph_max_hops') && Number(cfg.hmeGraphMaxHops || 0) <= 1) {
        // 옛 기본값(1)에서 올린다 — 1이면 인물 허브를 경유할 수 없다(허브가 hop 을 소모).
        cfg.hmeGraphMaxHops = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxHops;
    }
    if (!await hasRuntimeArgValue('hme_graph_bonus_cap') && Number(cfg.hmeGraphBonusCap || 0) <= 0.15) {
        cfg.hmeGraphBonusCap = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphBonusCap;
    }
    if (!await hasRuntimeArgValue('hme_graph_max_nodes') && Number(cfg.hmeGraphMaxNodes || 0) <= 1600) {
        cfg.hmeGraphMaxNodes = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxNodes;
    }
    if (!await hasRuntimeArgValue('hme_graph_max_edges') && Number(cfg.hmeGraphMaxEdges || 0) <= 8000) {
        cfg.hmeGraphMaxEdges = LIBRA_HIDDEN_OPERATIONAL_DEFAULTS.hmeGraphMaxEdges;
    }

    cfg.moduleLorebookReflectionEnabled = await getVal('moduleLorebookReflectionEnabled', 'module_lorebook_reflection_enabled', 'boolean', null, false);
    cfg.moduleLorebookSelectedIds = await getVal('moduleLorebookSelectedIds', 'module_lorebook_selected_ids', 'string', null, '');
};

// Initialize
(async () => {
    let initializationLease = null;
    try {
        recordRuntimeDebug('log', '[LIBRA] LIBRA World Manager v6.0.0 Initializing...');
        await updateConfigFromArgs();

        if (RisuCompat.api()) {
            const context = await resolveActiveChatContext(null, { includeReadOnly: true });
            const activation = await PersonaRuntimeCoordinator.activate(context);
            if (activation.ok) {
                const { char, chat } = activation.context;
                const initialScopeKey = activation.admission.runtimeScopeKey;
                initializationLease = RuntimeStateLease.capture(initialScopeKey);
                if (chat) {
                    const lore = MemoryEngine.getLorebook(char, chat);
                    if (Array.isArray(lore)) {
                        MemoryEngine.rebuildIndex(lore);
                        // Canonical-name migration must inherit the persisted turn anchor so
                        // rename history/provenance is not stamped as T0 during plugin load.
                        const maxTurn = deriveMaxTurnFromLorebook(lore);
                        MemoryEngine.setTurn(maxTurn);
                        SecretKnowledgeCore.loadState(lore, {
                            scopeKey: initialScopeKey,
                            chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                        });
                        EntityKnowledgeVaultCore.loadState(lore, {
                            scopeKey: initialScopeKey,
                            chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                        });
                        TimeEngine.loadState(lore, {
                            scopeKey: initialScopeKey,
                            chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                        });
                        HierarchicalWorldManager.loadWorldGraph(lore);
                        const entityFieldMigration = VersionedCanonicalBridge.mode === "authority" ? {changed:false,count:0,reason:"authority_upstream_writer_unsupported"} : (EntityManager.repairLegacyFieldMappings?.(lore) || { changed: false, count: 0 });
                        EntityManager.rebuildCache(lore);
                        NarrativeTracker.loadState(lore);
                        StoryAuthor.loadState(lore);
                        Director.loadState(lore);
                        WorldAdditionalCore.loadState?.(lore, {
                            scopeKey: initialScopeKey,
                            chatId: String(chat?.id || getActiveManagedChatId() || '').trim()
                        });
                        CharacterStateTracker.loadState(lore);
                        WorldStateTracker.loadState(lore);
                        if (entityFieldMigration.changed) {
                            try {
                                const persistResult = await persistLoreToActiveChat(chat, lore, { reason: 'entity-field-mapping-migration', runtimeLease: initializationLease });
                                RuntimeStateLease.assertCurrent(initializationLease);
                                if (!persistResult?.ok) throw new Error(persistResult?.reason || 'persist_failed');
                                recordRuntimeDebug('log', '[LIBRA][EntityFieldMigration] structured entity fields recovered', {
                                    count: entityFieldMigration.count,
                                    fields: entityFieldMigration.fields || []
                                });
                            } catch (error) {
                                recordSuppressedRuntimeError('entity.field_mapping_migration.persist_failed', error, {
                                    count: entityFieldMigration.count,
                                    scopeKey: initialScopeKey,
                                    chatId: String(chat?.id || '').trim()
                                });
                            }
                        }
                        try {
                            RuntimeStateLease.assertCurrent(initializationLease);
                            const canonicalNameMigration = await EntityCanonicalNameMigration.run({
                                runtimeLease: initializationLease,
                                char,
                                chat,
                                lore,
                                scopeKey: initialScopeKey,
                                chatId: String(chat?.id || '').trim(),
                                persist: true,
                                reason: 'plugin-load'
                            });
                            if (canonicalNameMigration?.changed) {
                                recordRuntimeDebug('log', '[LIBRA][EntityNameMigration] canonical person names upgraded', {
                                    count: canonicalNameMigration.applied?.length || 0,
                                    renames: (canonicalNameMigration.applied || []).map(item => `${item.oldName}=>${item.newName}`),
                                    sourceHash: canonicalNameMigration.sourceHash || ''
                                });
                            }
                        } catch (error) {
                            recordSuppressedRuntimeError('entity.canonical_name_migration.init_failed', error, {
                                scopeKey: initialScopeKey,
                                chatId: String(chat?.id || '').trim()
                            });
                        }
                    }
                }
            }
        }

        if (initializationLease && !RuntimeStateLease.isCurrent(initializationLease)) return;
        MemoryState.isInitialized = true;
        void TypedRecallRollout.activateCurrent('startup');
        ResourceGovernor.start();
        // V4.2-hybrid commits turns from afterRequest immediately and retries pending anchors in beforeRequest.
            const activeCfg = MemoryEngine.CONFIG;
        const embedStatus = isProviderProfileConfigured(activeCfg.embed || {}) ? `${activeCfg.embed.provider}/${activeCfg.embed.model}` : 'disabled (fallback to strengthened Jaccard)';
        const governorStatus = ResourceGovernor.snapshot();
        recordRuntimeDebug('log', `[LIBRA] LIBRA World Manager v6.0.0 Ready. LLM=${activeCfg.useLLM} | Mode=${activeCfg.weightMode} | MemoryLimit=${activeCfg.maxLimit} | GC=${activeCfg.gcBatchSize} | Embed=${embedStatus} | ResourceGovernor=${governorStatus.state}`);
        
        // Memory Carry-Over 및 Cold Start 감지 실행
        if (RisuCompat.api()) {
            setTimeout(async () => {

                await ColdStartManager.check();
            }, 2000);
        }
    } catch (e) {
        recordRuntimeDebug('error', "[LIBRA] Init Error:", e?.message || e);
    }
})();
