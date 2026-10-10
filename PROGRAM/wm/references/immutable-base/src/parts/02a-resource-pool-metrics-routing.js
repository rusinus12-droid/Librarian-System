    const runResourceBoundSettledPool = async (items = [], worker = async value => value, options = {}) => {
        const source = Array.isArray(items) ? items : Array.from(items || []);
        if (source.length === 0) return [];
        const results = new Array(source.length);
        const label = String(options.label || 'resource-bound-pool').trim() || 'resource-bound-pool';
        const hardMax = Math.max(1, Math.min(16, Math.floor(Number(options.maxConcurrency || 6) || 6)));
        let cursor = 0;
        let active = 0;
        let settled = 0;
        const controller = ResourceGovernor.createYieldController(label);
        return await new Promise(resolve => {
            const pump = () => {
                if (settled >= source.length) { resolve(results); return; }
                const policy = ResourceGovernor.getPolicy();
                const window = Math.max(1, Math.min(hardMax,
                    Number(policy.maintenanceConcurrency || 1)
                    + (policy.backgroundAllowed === false ? 0 : 1)
                ));
                while (active < window && cursor < source.length) {
                    const index = cursor++;
                    active += 1;
                    Promise.resolve()
                        .then(() => worker(source[index], index))
                        .then(
                            value => { results[index] = { status: 'fulfilled', value }; },
                            reason => { results[index] = { status: 'rejected', reason }; }
                        )
                        .finally(async () => {
                            active = Math.max(0, active - 1);
                            settled += 1;
                            try { await ResourceGovernor.yieldIfNeeded(controller, 1); } catch (_) {}
                            pump();
                        });
                }
            };
            pump();
        });
    };


    // ── [PERF] Runtime metrics + routed LLM profiles
    // These are intentionally lightweight and safe to leave enabled: they only
    // count completed runtime events and do not change prompt contents.
    const LIBRA_Metrics = (() => {
        const initialState = () => ({
            startedAt: Date.now(),
            llmCalls: 0,
            llmFailures: 0,
            llmTotalLatencyMs: 0,
            llmMaxLatencyMs: 0,
            byTask: Object.create(null),
            byProfile: { primary: { calls: 0, failures: 0, totalMs: 0 }, aux: { calls: 0, failures: 0, totalMs: 0 } },
            queueStarts: 0,
            queueFailures: 0,
            bgRuns: 0,
            bgSkipped: 0,
            bgDropped: 0
        });
        let M = initialState();
        const normalizeTaskKey = (value = '') => String(value || 'unknown').trim().replace(/\s+/g, '-').slice(0, 120) || 'unknown';
        const normalizeProfile = (value = '') => String(value || 'primary').trim().toLowerCase() === 'aux' ? 'aux' : 'primary';
        const recordLlm = (taskName = 'llm', latencyMs = 0, ok = true, meta = {}) => {
            const taskKey = normalizeTaskKey(taskName || meta.label || meta.reason || 'llm');
            const profile = normalizeProfile(meta.profile || 'primary');
            const latency = Math.max(0, Math.round(Number(latencyMs) || 0));
            M.llmCalls += 1;
            if (!ok) M.llmFailures += 1;
            M.llmTotalLatencyMs += latency;
            M.llmMaxLatencyMs = Math.max(M.llmMaxLatencyMs, latency);
            const task = M.byTask[taskKey] || (M.byTask[taskKey] = { calls: 0, failures: 0, totalMs: 0, profile, domain: '', reason: '' });
            task.calls += 1;
            if (!ok) task.failures += 1;
            task.totalMs += latency;
            task.profile = profile;
            task.domain = String(meta.domain || task.domain || '').slice(0, 80);
            task.reason = String(meta.reason || task.reason || '').slice(0, 120);
            const prof = M.byProfile[profile] || (M.byProfile[profile] = { calls: 0, failures: 0, totalMs: 0 });
            prof.calls += 1;
            if (!ok) prof.failures += 1;
            prof.totalMs += latency;
        };
        const recordQueue = (kind = 'start', ok = true) => {
            if (kind === 'background-run') M.bgRuns += 1;
            else if (kind === 'background-skipped') M.bgSkipped += 1;
            else if (kind === 'background-dropped') M.bgDropped += 1;
            else if (/start|enqueue|begin/i.test(String(kind || ''))) M.queueStarts += 1;
            if (!ok) M.queueFailures += 1;
        };
        const snapshot = () => {
            const avg = M.llmCalls > 0 ? Math.round(M.llmTotalLatencyMs / M.llmCalls) : 0;
            const mapTask = (entry = {}) => ({
                calls: Number(entry.calls || 0),
                failures: Number(entry.failures || 0),
                avgMs: entry.calls ? Math.round(Number(entry.totalMs || 0) / Number(entry.calls || 1)) : 0,
                profile: entry.profile || '',
                domain: entry.domain || '',
                reason: entry.reason || ''
            });
            return {
                uptimeMs: Math.max(0, Date.now() - M.startedAt),
                llm: {
                    calls: M.llmCalls,
                    failures: M.llmFailures,
                    successRate: M.llmCalls ? Number(((M.llmCalls - M.llmFailures) / M.llmCalls).toFixed(3)) : 1,
                    totalLatencyMs: M.llmTotalLatencyMs,
                    avgLatencyMs: avg,
                    maxLatencyMs: M.llmMaxLatencyMs
                },
                queues: {
                    maintenance: { active: MaintenanceLLMQueue.activeCount, pending: MaintenanceLLMQueue.pendingCount, pendingBytes: MaintenanceLLMQueue.pendingByteCount, concurrency: MaintenanceLLMQueue.maxConcurrent },
                    background: { active: BackgroundMaintenanceQueue.activeCount, pending: BackgroundMaintenanceQueue.pendingCount, pendingBytes: BackgroundMaintenanceQueue.pendingByteCount, concurrency: BackgroundMaintenanceQueue.maxConcurrent },
                    starts: M.queueStarts,
                    failures: M.queueFailures
                },
                resourceGovernor: ResourceGovernor.snapshot(),
                providerHealth: (() => {
                    try { return LLMProvider?.getProfileHealthSnapshot?.() || []; }
                    catch (_) { return []; }
                })(),
                background: { runs: M.bgRuns, skipped: M.bgSkipped, dropped: M.bgDropped },
                byProfile: Object.fromEntries(Object.entries(M.byProfile).map(([key, value]) => [key, mapTask(value)])),
                byTask: Object.fromEntries(Object.entries(M.byTask).map(([key, value]) => [key, mapTask(value)]))
            };
        };
        const reset = () => { M = initialState(); };
        return Object.freeze({ recordLlm, recordQueue, snapshot, reset });
    })();
    try { if (typeof globalThis !== 'undefined') globalThis.LIBRA_Metrics = LIBRA_Metrics; } catch (_) {}

    const runMaintenanceLLM = (task, name = 'maintenance-llm') => MaintenanceLLMQueue.enqueue(async () => {
        const token = FlexTierRuntime.enter(name);
        LIBRA_Metrics.recordQueue('maintenance-start', true);
        try {
            return await task();
        } catch (error) {
            LIBRA_Metrics.recordQueue('maintenance-finish', false);
            throw error;
        } finally {
            FlexTierRuntime.leave(token);
        }
    }, name, { background: true, estimatedBytes: 1024 });

    const DEFAULT_LLM_ROUTE_PROFILES = Object.freeze({
        bootstrapBotCharacter: 'primary',
        bootstrapNpcCharacter: 'aux',
        bootstrapPersona: 'aux',
        bootstrapRelations: 'primary',
        liveExtraction: 'aux',
        liveExtractionRepair: 'aux',
        turnCorrection: 'primary',
        relationGraph: 'primary',
        storyAuthor: 'primary',
        director: 'primary',
        sectionWorldInference: 'aux',
        turnCanonicalPacket: 'aux',
        turnMaintenanceBundle: 'primary',
        worldAdditionalTurnAnalysis: 'aux',
        characterStateConsolidation: 'aux',
        worldStateConsolidation: 'aux',
        backgroundSimulation: 'primary',
        coldStartChunkSummary: 'aux',
        coldStartFinalSynthesis: 'primary',
        structuredMerge: 'primary',
        mergeVerification: 'primary',
        reanalysisReview: 'aux',
        reanalysisWindowArbiter: 'primary',
        reanalysisFinalArbiter: 'primary',
        transitionSummary: 'aux',
        guiManualCorrection: 'primary',
        guiWorldReanalysis: 'aux',
        guiEntityReanalysis: 'aux',
        guiNarrativeReanalysis: 'aux',
        userDlcWorldAnalysis: 'primary',
        userDlcEntityAnalysis: 'primary',
        userDlcTrackerAnalysis: 'primary',
        entityApprovalAlias: 'aux',
        narrativeTurnBrief: 'aux',
        worldCodex: 'aux'
    });
    const normalizeLLMRouteProfileName = (profile = '') => {
        const normalized = String(profile || '').trim().toLowerCase();
        if (normalized === 'main' || normalized === 'primary') return 'primary';
        if (normalized === 'aux' || normalized === 'secondary' || normalized === 'sub') return 'aux';
        return normalized
            .replace(/[^\p{L}\p{N}_.:-]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 48);
    };
    const resolveLLMRouteProfile = (routeKey = '', config = MemoryEngine?.CONFIG || {}, fallbackProfile = 'primary') => {
        const key = String(routeKey || '').trim();
        const configured = key && config?.llmRouting && typeof config.llmRouting === 'object' && !Array.isArray(config.llmRouting)
            ? config.llmRouting[key]
            : undefined;
        const configuredProfile = configured && typeof configured === 'object' && !Array.isArray(configured)
            ? (configured.profile || configured.preset || configured.llmPreset || configured.name || '')
            : configured;
        const builtInDefault = DEFAULT_LLM_ROUTE_PROFILES[key] || fallbackProfile || 'primary';
        const globalDefault = normalizeLLMRouteProfileName(config?.llmDefaultPreset || config?.defaultPreset || config?.defaultPresetName || '');
        const desired = normalizeLLMRouteProfileName(configuredProfile || globalDefault || builtInDefault) || 'primary';
        const fallback = normalizeLLMRouteProfileName(builtInDefault) || normalizeLLMRouteProfileName(fallbackProfile) || 'primary';
        const candidates = [];
        const push = (value) => {
            const normalized = normalizeLLMRouteProfileName(value);
            if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
        };
        push(desired);
        if (desired === 'aux') push('primary');
        else if (desired === 'primary') push('aux');
        else {
            push(fallback);
            push(globalDefault);
        }
        push('primary');
        push('aux');
        const configuredCandidates = candidates.filter(candidate => LLMProvider?.isConfigured?.(config, candidate));
        const healthyCandidate = configuredCandidates.find(candidate => LLMProvider?.isProfileHealthy?.(config, candidate) !== false);
        if (healthyCandidate) return healthyCandidate;
        if (configuredCandidates.length > 0) return configuredCandidates[0];
        return desired;
    };
    const resolveAnalysisProfile = (config = MemoryEngine?.CONFIG || {}, routeKey = '', fallbackProfile = 'primary') => (
        resolveLLMRouteProfile(routeKey, config, fallbackProfile)
    );
    const buildFastAnalysisProfile = (config = MemoryEngine?.CONFIG || {}, options = {}) => {
        const {
            maxCompletionTokens = 2200,
            routeKey = '',
            fallbackProfile = 'aux',
            allowReasoning = false
        } = options || {};
        const nextConfig = safeClone(config || {});
        const targetProfile = resolveLLMRouteProfile(routeKey, config, fallbackProfile);
        const targetKey = targetProfile === 'aux' ? 'auxLlm' : (targetProfile === 'primary' ? 'llm' : '');
        const tuneProfile = (currentProfile = {}) => allowReasoning
            ? { ...currentProfile }
            : {
                ...currentProfile,
                reasoningPreset: 'custom',
                reasoningEffort: 'none',
                reasoningBudgetTokens: 0,
                glmThinkingType: 'disabled',
                maxCompletionTokens: Math.min(
                    maxCompletionTokens,
                    Math.max(800, parseInt(currentProfile.maxCompletionTokens, 10) || maxCompletionTokens)
                )
            };
        if (targetKey) {
            const currentProfile = (nextConfig && nextConfig[targetKey] && typeof nextConfig[targetKey] === 'object')
                ? nextConfig[targetKey]
                : {};
            nextConfig[targetKey] = tuneProfile(currentProfile);
        } else {
            nextConfig.llmPresets = {
                ...(nextConfig.llmPresets && typeof nextConfig.llmPresets === 'object' && !Array.isArray(nextConfig.llmPresets) ? nextConfig.llmPresets : {})
            };
            nextConfig.llmPresets[targetProfile] = tuneProfile(nextConfig.llmPresets[targetProfile] || {});
        }
        return {
            config: nextConfig,
            profile: targetProfile,
            routeKey: String(routeKey || '').trim()
        };
    };
    const toSerializableClone = (value, seen = new WeakMap()) => {
        if (value == null) return value;
        const valueType = typeof value;
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
        if (valueType === 'bigint') return Number(value);
        if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') return undefined;
        if (seen.has(value)) return seen.get(value);
        if (value instanceof Date) return new Date(value.getTime()).toISOString();
        if (value instanceof RegExp) return String(value);
        if (Array.isArray(value)) {
            const arr = [];
            seen.set(value, arr);
            for (const item of value) {
                const cloned = toSerializableClone(item, seen);
                arr.push(cloned === undefined ? null : cloned);
            }
            return arr;
        }
        if (value instanceof Map) {
            const obj = {};
            seen.set(value, obj);
            for (const [entryKey, entryValue] of value.entries()) {
                const key = String(entryKey ?? '');
                const cloned = toSerializableClone(entryValue, seen);
                if (cloned !== undefined) obj[key] = cloned;
            }
            return obj;
        }
        if (value instanceof Set) {
            const arr = [];
            seen.set(value, arr);
            for (const entryValue of value.values()) {
                const cloned = toSerializableClone(entryValue, seen);
                if (cloned !== undefined) arr.push(cloned);
            }
            return arr;
        }
        const tag = Object.prototype.toString.call(value);
        if (/\[object (Window|HTML.+Element|Document|Event|MessagePort)\]/.test(tag)) return undefined;
        const output = {};
        seen.set(value, output);
        for (const key of Object.keys(value)) {
            const cloned = toSerializableClone(value[key], seen);
            if (cloned !== undefined) output[key] = cloned;
        }
        return output;
    };
    const safeClone = (value) => {
        if (value == null || typeof value !== 'object') return value;
        try {
            return typeof structuredClone === 'function' ? structuredClone(value) : toSerializableClone(value);
        } catch (cloneError) {
            try {
                return toSerializableClone(value);
            } catch (serializableError) {
                try {
                    return JSON.parse(JSON.stringify(value));
                } catch (jsonError) {
                    if (isLibraDebugEnabled()) {
                        recordRuntimeDebug('warn', '[LIBRA] safeClone fallback to serializable clone failed', cloneError?.message || cloneError, serializableError?.message || serializableError, jsonError?.message || jsonError);
                    }
                    return value;
                }
            } finally {
                if (isLibraDebugEnabled()) {
                    recordRuntimeDebug('warn', '[LIBRA] safeClone fallback to serializable clone', cloneError?.message || cloneError);
                }
            }
        }
    };
    const cloneForMutation = (value) => {
        const cloned = safeClone(value);
        if (cloned !== value || value == null || typeof value !== 'object') return cloned;
        if (Array.isArray(value)) {
            return value.map(item => safeClone(item));
        }
        return { ...value };
    };
    const DEFAULT_ACTIVITY_DASHBOARD = 'compact';
    const ACTIVITY_DASHBOARD_MODES = new Set(['off', 'compact', 'full']);
    const normalizeActivityDashboard = (value, fallback = DEFAULT_ACTIVITY_DASHBOARD) => {
        const raw = String(value || '').trim().toLowerCase();
        if (ACTIVITY_DASHBOARD_MODES.has(raw)) return raw;
        return ACTIVITY_DASHBOARD_MODES.has(String(fallback || '').trim().toLowerCase())
            ? String(fallback).trim().toLowerCase()
            : DEFAULT_ACTIVITY_DASHBOARD;
    };
    const DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE = 'background';
    const AFTER_REQUEST_MAINTENANCE_MODES = new Set(['foreground', 'background']);
    const normalizeAfterRequestMaintenanceMode = (value, fallback = DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE) => {
        const raw = String(value || '').trim().toLowerCase();
        if (AFTER_REQUEST_MAINTENANCE_MODES.has(raw)) return raw;
        const fb = String(fallback || '').trim().toLowerCase();
        return AFTER_REQUEST_MAINTENANCE_MODES.has(fb) ? fb : DEFAULT_AFTER_REQUEST_MAINTENANCE_MODE;
    };
    const normalizeAfterRequestForegroundTimeoutMs = (value, fallback = 45000) => {
        // V5.2.7 freeze guard: foreground afterRequest is now an opt-in compatibility mode.
        // Do not let legacy 20-minute waits pin the request pipeline or UI thread.
        const n = Number(value);
        const base = Number.isFinite(n) ? n : Number(fallback || 45000);
        return Math.max(1000, Math.min(120000, Math.round(base || 45000)));
    };
    const normalizeAfterRequestAnalysisBudgetMs = (value, fallback = 480000) => {
        const n = Number(value);
        const base = Number.isFinite(n) ? n : Number(fallback || 480000);
        // Five minutes is a latency target, not a destructive cutoff. Slow but
        // healthy providers may finish later, so allow a bounded recovery window
        // instead of aborting a valid canonical commit near the old deadline.
        return Math.max(30000, Math.min(900000, Math.round(base || 480000)));
    };
    const DEFAULT_INJECTION_BUDGET_MIN_TOKENS = 12000;
    const DEFAULT_INJECTION_BUDGET_MAX_TOKENS = 32000;
    const CUSTOM_INJECTION_BUDGET_MAX_TOKENS = 32000;
    const normalizeInjectionBudgetPreset = (value) => {
        const key = String(value || '').trim().toLowerCase();
        if (key === 'small') return 'compact';
        if (key === 'medium') return 'balanced';
        if (key === 'high') return 'large';
        if (key === 'xlarge' || key === 'ultra') return 'max';
        if (key === 'compact' || key === 'balanced' || key === 'large' || key === 'max' || key === 'custom') return key;
        return 'compact';
    };
    const clampInjectionBudgetMax = (value, options = {}) => {
        const allowExtended = options.allowExtended === true;
        const upperBound = allowExtended ? CUSTOM_INJECTION_BUDGET_MAX_TOKENS : DEFAULT_INJECTION_BUDGET_MAX_TOKENS;
        const num = Math.floor(Number(value));
        if (!Number.isFinite(num)) return upperBound;
        return Math.max(DEFAULT_INJECTION_BUDGET_MIN_TOKENS, Math.min(upperBound, num));
    };
    const getInjectionBudgetPresetTokens = (preset) => {
        const normalized = normalizeInjectionBudgetPreset(preset);
        const presetMap = {
            compact: 12000,
            balanced: 15000,
            large: 20000,
            max: 32000
        };
        return clampInjectionBudgetMax(presetMap[normalized] || DEFAULT_INJECTION_BUDGET_MAX_TOKENS);
    };
    const resolveEffectiveInjectionBudgetPreset = (config = null) => {
        const active = config || MemoryEngine?.CONFIG || {};
        return normalizeInjectionBudgetPreset(active?.injectionBudgetPreset || 'compact');
    };
    const resolveInjectionBudgetMaxTokens = (config = null) => {
        const active = config || MemoryEngine?.CONFIG || {};
        const preset = resolveEffectiveInjectionBudgetPreset(active);
        if (preset === 'custom') {
            return clampInjectionBudgetMax(active?.injectionBudgetMaxTokens ?? active?.injectionBudgetTokens, { allowExtended: true });
        }
        return getInjectionBudgetPresetTokens(preset);
    };
