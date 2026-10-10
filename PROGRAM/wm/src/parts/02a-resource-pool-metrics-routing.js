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

    // Compatibility names remain for callers; purposes no longer assign model identities.
    const DEFAULT_LLM_ROUTE_PROFILES = Object.freeze({});
    const normalizeLLMRouteProfileName = (profile = '') => {
        const value = String(profile || '').trim();
        return value ? normalizeLLMPresetName(value) : '';
    };
    const resolveLLMRouteProfile = (routeKey = '', config = MemoryEngine?.CONFIG || {}, fallbackProfile = 'primary') => (
        resolveCommonAnalysisPreset(config).presetName
    );
    const resolveAnalysisProfile = (config = MemoryEngine?.CONFIG || {}, routeKey = '', fallbackProfile = 'primary') => (
        resolveLLMRouteProfile(routeKey, config, fallbackProfile)
    );
    // Exactly the fields owned/replaced by the RAM capture constructor below.
    // Source, lease, scope, embedding and all other task settings remain live guards.
    const WM_ANALYSIS_CAPTURED_MODEL_FIELDS = Object.freeze([
        'useLLM', 'llm', 'auxLlm', 'llmPresets', 'llmDefaultPreset',
        'llmRouting', 'llmRoutingJson', 'llm_routing_json',
        'llmPresetsJson', 'modelPresetsJson', 'providerPresetsJson',
        'llm_presets_json', 'model_presets_json', 'provider_presets_json',
        'defaultPreset', 'defaultPresetName', 'llm_default_preset', 'default_preset'
    ]);
    const wmPrivateAnalysisCaptures = new WeakSet();
    // RAM-only job/request copy. Never persist this object or use it as a source-authority claim.
    const captureWmAnalysisConfig = (baseConfig = {}, selectionConfig = baseConfig) => {
        const copy = cloneAnalysisSettingsValue(baseConfig || {});
        let selected;
        try { selected = normalizeCommonAnalysisSettings(selectionConfig || {}).config; }
        catch (_) { selected = { useLLM: false, llmDefaultPreset: '', llmPresets: {} }; }
        for (const key of WM_ANALYSIS_CAPTURED_MODEL_FIELDS) delete copy[key];
        const name = selected.llmDefaultPreset;
        const definition = name && Object.prototype.hasOwnProperty.call(selected.llmPresets || {}, name)
            ? cloneAnalysisSettingsValue(selected.llmPresets[name]) : null;
        copy.useLLM = selected.useLLM;
        copy.llmDefaultPreset = name;
        copy.llmPresets = definition ? { [name]: definition } : {};
        copy.llm = definition ? cloneAnalysisSettingsValue(definition) : {};
        wmPrivateAnalysisCaptures.add(copy);
        return copy;
    };
    const isWmAnalysisConfigCurrent = (captured, current) => {
        if (!captured || !wmPrivateAnalysisCaptures.has(captured) || !current) return false;
        const nonModel = value => Object.fromEntries(Object.entries(value)
            .filter(([key]) => !WM_ANALYSIS_CAPTURED_MODEL_FIELDS.includes(key)));
        try { return JSON.stringify(nonModel(captured)) === JSON.stringify(nonModel(current)); }
        catch (_) { return false; }
    };
    const buildFastAnalysisProfile = (config = MemoryEngine?.CONFIG || {}, options = {}) => {
        const { maxCompletionTokens = 2200, routeKey = '', allowReasoning = false } = options || {};
        const nextConfig = captureWmAnalysisConfig(config);
        const selected = resolveCommonAnalysisPreset(nextConfig);
        const targetProfile = selected.presetName;
        if (selected.ok) {
            const current = selected.profile;
            const shaped = allowReasoning ? current : {
                ...current,
                reasoningPreset: 'custom',
                reasoningEffort: 'none',
                reasoningBudgetTokens: 0,
                glmThinkingType: 'disabled',
                maxCompletionTokens: Math.min(
                    maxCompletionTokens,
                    Math.max(800, parseInt(current.maxCompletionTokens, 10) || maxCompletionTokens)
                )
            };
            nextConfig.llmPresets[targetProfile] = shaped;
            nextConfig.llm = cloneAnalysisSettingsValue(shaped);
        }
        return { config: nextConfig, profile: targetProfile, routeKey: String(routeKey || '').trim() };
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
