    // ══════════════════════════════════════════════════════════════
    // [UTILITY] RWLock
    // ══════════════════════════════════════════════════════════════
    class RWLock {
        constructor() {
            this.readers = 0;
            this.writer = false;
            this.queue = [];
        }

        async readLock() {
            return new Promise(resolve => {
                if (!this.writer && this.queue.length === 0) {
                    this.readers++;
                    resolve();
                } else {
                    this.queue.push({ type: 'read', resolve });
                }
            });
        }

        async writeLock() {
            return new Promise(resolve => {
                if (!this.writer && this.readers === 0) {
                    this.writer = true;
                    resolve();
                } else {
                    this.queue.push({ type: 'write', resolve });
                }
            });
        }

        readUnlock() {
            if (this.readers <= 0) {
                this.readers = 0;
                if (isLibraDebugEnabled()) {
                    recordRuntimeDebug('warn', '[LIBRA][RWLock] readUnlock called with no active readers');
                }
                this._next();
                return;
            }
            this.readers--;
            this._next();
        }
        writeUnlock() { this.writer = false; this._next(); }

        _next() {
            while (this.queue.length > 0) {
                const next = this.queue[0];
                if (next.type === 'write') {
                    if (this.readers === 0) {
                        this.queue.shift();
                        this.writer = true;
                        next.resolve();
                        return;
                    }
                    break;
                } else if (next.type === 'read') {
                    if (!this.writer) {
                        this.queue.shift();
                        this.readers++;
                        next.resolve();
                        continue;
                    }
                    break;
                }
            }
        }
    }

    const loreLock = new RWLock();

    // ══════════════════════════════════════════════════════════════
    // [UTILITY] Async Task Queue
    // ══════════════════════════════════════════════════════════════
    class AsyncTaskQueue {
        constructor(maxConcurrent = 1, label = 'AsyncTaskQueue', options = {}) {
            this.baseMaxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
            this.maxConcurrent = this.baseMaxConcurrent;
            this.label = String(label || 'AsyncTaskQueue');
            this.queue = [];
            this.active = 0;
            this.pendingBytes = 0;
            this.options = options && typeof options === 'object' ? options : {};
        }

        _isDebugEnabled() {
            return isLibraDebugEnabled();
        }

        _now() {
            try {
                return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            } catch {
                return Date.now();
            }
        }

        _log(message) {
            if (this._isDebugEnabled()) {
                recordRuntimeDebug('log', `[LIBRA][${this.label}] ${message}`);
            }
        }

        _notifyDashboard() {
            try {
                ActivityDashboardCore?.updateQueues?.(this.label, this.active, this.queue.length);
            } catch (_) {}
            try { ResourceGovernor?.touch?.(`queue:${this.label}`); } catch (_) {}
        }

        setMaxConcurrent(value, reason = '') {
            const next = Math.max(1, Math.floor(Number(value) || this.baseMaxConcurrent));
            if (next === this.maxConcurrent) return false;
            const previous = this.maxConcurrent;
            this.maxConcurrent = next;
            this._log(`concurrency ${previous}→${next}${reason ? ` | ${reason}` : ''}`);
            this._notifyDashboard();
            this._drain();
            return true;
        }

        _drain() {
            while (this.active < this.maxConcurrent && this.queue.length > 0) {
                const item = this.queue.shift();
                this.pendingBytes = Math.max(0, this.pendingBytes - Number(item.estimatedBytes || 0));
                this.active += 1;
                this._notifyDashboard();
                const startedAt = this._now();
                const queuedFor = Math.max(0, Math.round(startedAt - item.enqueuedAt));
                this._log(`start ${item.name} | queued=${queuedFor}ms | bytes=${item.estimatedBytes || 0} | active=${this.active}/${this.maxConcurrent} | pending=${this.queue.length}`);
                Promise.resolve()
                    .then(item.task)
                    .then(item.resolve)
                    .catch(item.reject)
                    .finally(() => {
                        const finishedAt = this._now();
                        const ranFor = Math.max(0, Math.round(finishedAt - startedAt));
                        this.active -= 1;
                        try { ResourceGovernor?.reportTask?.(this.label, ranFor, item.meta || {}); } catch (_) {}
                        this._log(`finish ${item.name} | ran=${ranFor}ms | active=${this.active}/${this.maxConcurrent} | pending=${this.queue.length}`);
                        this._notifyDashboard();
                        this._drain();
                    });
            }
        }

        enqueue(task, name = 'task', meta = {}) {
            return new Promise((resolve, reject) => {
                const normalizedMeta = meta && typeof meta === 'object' ? meta : {};
                let estimatedBytes = Math.max(0, Math.floor(Number(normalizedMeta.estimatedBytes || 0) || 0));
                if (!estimatedBytes) {
                    try { estimatedBytes = ResourceGovernor?.estimateTaskBytes?.(normalizedMeta, name) || 512; } catch (_) { estimatedBytes = 512; }
                }
                const item = { task, resolve, reject, name, meta: normalizedMeta, estimatedBytes, enqueuedAt: this._now() };
                if (normalizedMeta.foreground === true || normalizedMeta.priority === 'foreground') this.queue.unshift(item);
                else this.queue.push(item);
                this.pendingBytes += estimatedBytes;
                this._log(`enqueue ${item.name} | bytes=${estimatedBytes} | active=${this.active}/${this.maxConcurrent} | pending=${this.queue.length}`);
                this._notifyDashboard();
                this._drain();
            });
        }

        clearPending(reason = 'cleared') {
            const dropped = this.queue.splice(0, this.queue.length);
            this.pendingBytes = 0;
            const normalizedReason = String(reason || 'cleared').trim() || 'cleared';
            for (const item of dropped) {
                try { item.resolve({ skipped: true, reason: normalizedReason }); } catch (_) {}
            }
            this._log(`clear pending | dropped=${dropped.length} | active=${this.active}/${this.maxConcurrent} | pending=${this.queue.length} | reason=${normalizedReason}`);
            this._notifyDashboard();
            return dropped.length;
        }

        kick() { this._drain(); }
        get pendingCount() { return this.queue.length; }
        get activeCount() { return this.active; }
        get pendingByteCount() { return this.pendingBytes; }
    }

    const FlexTierRuntime = (() => {
        const stack = [];
        const enter = (label = '') => {
            const token = { label: String(label || ''), startedAt: Date.now() };
            stack.push(token);
            return token;
        };
        const leave = (token = null) => {
            if (!stack.length) return;
            const idx = token ? stack.lastIndexOf(token) : stack.length - 1;
            if (idx >= 0) stack.splice(idx, 1);
            else stack.pop();
        };
        const currentLabel = () => stack.length ? String(stack[stack.length - 1]?.label || '') : '';
        return Object.freeze({ enter, leave, currentLabel });
    })();

    // ── [CORE] Adaptive Resource Governor
    // One quality profile is used on every device. The governor changes only
    // execution cost (cache residency, concurrency, batch size and background
    // scheduling); it never changes canonical memory, recall semantics or the
    // prompt token budget.
    const ResourceGovernor = (() => {
        const MB = 1024 * 1024;
        const DEFAULTS = Object.freeze({
            enabled: true,
            workingSetSoftBytes: 96 * MB,
            workingSetHardBytes: 160 * MB,
            pendingQueueSoftBytes: 8 * MB,
            pendingQueueHardBytes: 24 * MB,
            sampleIntervalMs: 2000,
            pressureHoldMs: 3500,
            recoveryHoldMs: 15000,
            targetTaskSliceMs: 10,
            normalMaintenanceConcurrency: 3,
            pressureMaintenanceConcurrency: 2,
            criticalMaintenanceConcurrency: 1
        });
        const caches = new Set();
        const queues = new Set();
        const taskEma = new Map();
        const runtime = {
            state: 'normal',
            stateSince: Date.now(),
            pressureSince: 0,
            healthySince: 0,
            lastSampleAt: 0,
            lastTouchAt: 0,
            lastTrimAt: 0,
            lastReason: 'init',
            timer: null,
            touchTimer: null,
            expectedTickAt: 0,
            eventLoopLagMs: 0,
            eventLoopLagEmaMs: 0,
            transitionCount: 0,
            sampleCount: 0,
            measurements: {
                cacheBytes: 0,
                queueBytes: 0,
                runtimeBytes: 0,
                ownedBytes: 0,
                heapUsedBytes: 0,
                heapLimitBytes: 0,
                heapRatio: 0,
                pendingTasks: 0,
                activeTasks: 0
            }
        };
        const now = () => {
            try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
            catch (_) { return Date.now(); }
        };
        const clamp = (value, min, max, fallback) => {
            const n = Number(value);
            return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
        };
        const getConfig = () => {
            let cfg = {};
            try { cfg = MemoryEngine?.CONFIG || {}; } catch (_) {}
            return {
                enabled: cfg.resourceGovernorEnabled !== false,
                workingSetSoftBytes: Math.floor(clamp(cfg.resourceWorkingSetSoftBytes, 32 * MB, 1024 * MB, DEFAULTS.workingSetSoftBytes)),
                workingSetHardBytes: Math.floor(clamp(cfg.resourceWorkingSetHardBytes, 48 * MB, 1536 * MB, DEFAULTS.workingSetHardBytes)),
                pendingQueueSoftBytes: Math.floor(clamp(cfg.resourcePendingQueueSoftBytes, 1 * MB, 128 * MB, DEFAULTS.pendingQueueSoftBytes)),
                pendingQueueHardBytes: Math.floor(clamp(cfg.resourcePendingQueueHardBytes, 2 * MB, 256 * MB, DEFAULTS.pendingQueueHardBytes)),
                sampleIntervalMs: Math.floor(clamp(cfg.resourceSampleIntervalMs, 500, 15000, DEFAULTS.sampleIntervalMs)),
                pressureHoldMs: Math.floor(clamp(cfg.resourcePressureHoldMs, 500, 30000, DEFAULTS.pressureHoldMs)),
                recoveryHoldMs: Math.floor(clamp(cfg.resourceRecoveryHoldMs, 3000, 120000, DEFAULTS.recoveryHoldMs)),
                targetTaskSliceMs: clamp(cfg.resourceTargetTaskSliceMs, 4, 30, DEFAULTS.targetTaskSliceMs),
                normalMaintenanceConcurrency: Math.floor(clamp(cfg.resourceNormalMaintenanceConcurrency, 1, 6, DEFAULTS.normalMaintenanceConcurrency)),
                pressureMaintenanceConcurrency: Math.floor(clamp(cfg.resourcePressureMaintenanceConcurrency, 1, 4, DEFAULTS.pressureMaintenanceConcurrency)),
                criticalMaintenanceConcurrency: Math.floor(clamp(cfg.resourceCriticalMaintenanceConcurrency, 1, 2, DEFAULTS.criticalMaintenanceConcurrency))
            };
        };
        const estimateBytes = (value, options = {}) => {
            const maxDepth = Math.max(1, Math.min(8, Number(options.maxDepth || 4) || 4));
            const maxNodes = Math.max(16, Math.min(4096, Number(options.maxNodes || 384) || 384));
            const maxCollectionItems = Math.max(4, Math.min(256, Number(options.maxCollectionItems || 48) || 48));
            const seen = new Set();
            const stack = [{ value, depth: 0, multiplier: 1 }];
            let nodes = 0;
            let bytes = 0;
            while (stack.length && nodes < maxNodes) {
                const current = stack.pop();
                const item = current.value;
                const multiplier = Math.max(1, Number(current.multiplier || 1) || 1);
                nodes += 1;
                if (item == null) { bytes += 4 * multiplier; continue; }
                const type = typeof item;
                if (type === 'string') { bytes += (24 + item.length * 2) * multiplier; continue; }
                if (type === 'number' || type === 'bigint') { bytes += 8 * multiplier; continue; }
                if (type === 'boolean') { bytes += 4 * multiplier; continue; }
                if (type === 'function' || type === 'symbol') { bytes += 32 * multiplier; continue; }
                if (seen.has(item)) { bytes += 8 * multiplier; continue; }
                seen.add(item);
                if (typeof ArrayBuffer !== 'undefined' && item instanceof ArrayBuffer) { bytes += (item.byteLength || 0) + 32; continue; }
                if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(item)) { bytes += (item.byteLength || 0) + 48; continue; }
                if (current.depth >= maxDepth) { bytes += 128 * multiplier; continue; }
                if (Array.isArray(item)) {
                    bytes += 40 + item.length * 8;
                    const count = Math.min(item.length, maxCollectionItems);
                    const scale = count > 0 ? Math.min(32, item.length / count) : 1;
                    for (let i = 0; i < count; i += 1) stack.push({ value: item[i], depth: current.depth + 1, multiplier: scale });
                    continue;
                }
                if (item instanceof Map) {
                    bytes += 64 + item.size * 24;
                    let count = 0;
                    const scale = Math.max(1, Math.min(32, item.size / Math.max(1, Math.min(item.size, maxCollectionItems))));
                    for (const [key, val] of item) {
                        stack.push({ value: key, depth: current.depth + 1, multiplier: scale });
                        stack.push({ value: val, depth: current.depth + 1, multiplier: scale });
                        if (++count >= maxCollectionItems) break;
                    }
                    continue;
                }
                if (item instanceof Set) {
                    bytes += 56 + item.size * 16;
                    let count = 0;
                    const scale = Math.max(1, Math.min(32, item.size / Math.max(1, Math.min(item.size, maxCollectionItems))));
                    for (const val of item) {
                        stack.push({ value: val, depth: current.depth + 1, multiplier: scale });
                        if (++count >= maxCollectionItems) break;
                    }
                    continue;
                }
                const keys = Object.keys(item);
                bytes += 48 + keys.length * 16;
                const count = Math.min(keys.length, maxCollectionItems);
                const scale = count > 0 ? Math.min(16, keys.length / count) : 1;
                for (let i = 0; i < count; i += 1) {
                    const key = keys[i];
                    bytes += key.length * 2 + 8;
                    stack.push({ value: item[key], depth: current.depth + 1, multiplier: scale });
                }
            }
            if (stack.length) bytes += stack.length * 96;
            return Math.max(0, Math.ceil(bytes));
        };
        const estimateTaskBytes = (meta = {}, name = '') => Math.max(256, Math.min(8 * MB,
            estimateBytes({ name, payload: meta?.payload || meta?.record || meta?.context || meta }, { maxDepth: 3, maxNodes: 128 })
        ));
        const registerCache = (cache) => { if (cache) caches.add(cache); return cache; };
        const unregisterCache = (cache) => { if (cache) caches.delete(cache); };
        const registerQueue = (queue) => { if (queue) queues.add(queue); return queue; };
        const cacheRatioForState = (state = runtime.state) => state === 'critical' ? 0.36 : state === 'pressure' ? 0.66 : state === 'recovery' ? 0.78 : 1;
        const entryRatioForState = (state = runtime.state) => state === 'critical' ? 0.35 : state === 'pressure' ? 0.62 : state === 'recovery' ? 0.78 : 1;
        const getCacheBudget = (label = '', baseBytes = 0) => {
            const base = Math.max(0, Number(baseBytes || 0) || 0);
            if (!base) return 0;
            return Math.max(Math.min(base, 16 * 1024), Math.floor(base * cacheRatioForState()));
        };
        const getCacheEntryLimit = (label = '', baseEntries = 0) => {
            const base = Math.max(1, Math.floor(Number(baseEntries || 1) || 1));
            return Math.max(32, Math.floor(base * entryRatioForState()));
        };
        const enforceMapBudget = (map, label = 'map', baseEntries = 1024, baseBytes = 0) => {
            if (!(map instanceof Map)) return { removed: 0, bytes: 0 };
            const entryLimit = getCacheEntryLimit(label, baseEntries);
            let removed = 0;
            while (map.size > entryLimit) {
                const key = map.keys().next().value;
                if (key === undefined) break;
                map.delete(key);
                removed += 1;
            }
            const byteLimit = getCacheBudget(label, baseBytes);
            let estimated = 0;
            if (byteLimit > 0 && map.size > 0) {
                estimated = estimateBytes(map, { maxDepth: 3, maxNodes: 256 });
                while (estimated > byteLimit && map.size > 32) {
                    const dropCount = Math.max(1, Math.ceil(map.size * 0.1));
                    for (let i = 0; i < dropCount; i += 1) {
                        const key = map.keys().next().value;
                        if (key === undefined) break;
                        map.delete(key);
                        removed += 1;
                    }
                    estimated = estimateBytes(map, { maxDepth: 3, maxNodes: 192 });
                }
            }
            if (removed > 0) touch(`map-trim:${label}`);
            return { removed, bytes: estimated };
        };
        const trimMapToLimit = (map, limit, preserveKey = '') => {
            if (!(map instanceof Map)) return 0;
            let removed = 0;
            const safeLimit = Math.max(0, Math.floor(Number(limit || 0) || 0));
            for (const key of Array.from(map.keys())) {
                if (map.size <= safeLimit) break;
                if (preserveKey && String(key) === String(preserveKey)) continue;
                map.delete(key);
                removed += 1;
            }
            return removed;
        };
        const trimRuntimeRecomputable = (state = runtime.state) => {
            let removed = 0;
            try {
                const activeScope = String(MemoryState?._activeScopeKey || MemoryState?._activeChatId || '');
                const limits = state === 'critical'
                    ? { scope: 1, graph: 1, session: 3, cbs: 2, cue: 2, debug: 8 }
                    : { scope: 4, graph: 3, session: 8, cbs: 6, cue: 6, debug: 20 };
                removed += trimMapToLimit(MemoryState.hmeScopeIndexByScope, limits.scope, activeScope);
                removed += trimMapToLimit(MemoryState.hmeGraphIndexByScope, limits.graph, activeScope);
                removed += trimMapToLimit(MemoryState.hmeGraphStaleRebuildByScope, limits.graph, activeScope);
                removed += trimMapToLimit(MemoryState.cbsResolvedCharacterLoreByScope, limits.cbs, activeScope);
                removed += trimMapToLimit(MemoryState.characterLoreEmbeddingCache, limits.cue * 16, '');
                removed += trimMapToLimit(MemoryState.characterLoreIndexStatusByScope, limits.cue, activeScope);
                removed += trimMapToLimit(MemoryState.sessionCache, limits.session, activeScope);
                removed += trimMapToLimit(MemoryState.runtimeDebugRequestsByKey, limits.debug, '');
                if (Array.isArray(MemoryState.runtimeDebugRecentRequestKeys) && MemoryState.runtimeDebugRecentRequestKeys.length > limits.debug) {
                    MemoryState.runtimeDebugRecentRequestKeys = MemoryState.runtimeDebugRecentRequestKeys.slice(-limits.debug);
                }
                if (Array.isArray(MemoryState.runtimeDebugProviderCalls) && MemoryState.runtimeDebugProviderCalls.length > limits.debug) {
                    MemoryState.runtimeDebugProviderCalls = MemoryState.runtimeDebugProviderCalls.slice(-limits.debug);
                }
                if (Array.isArray(MemoryState.activityDashboard?.events)) {
                    MemoryState.activityDashboard.events = MemoryState.activityDashboard.events.slice(-(state === 'critical' ? 12 : 32));
                }
            } catch (_) {}
            return removed;
        };
        const trimCaches = (state = runtime.state, reason = 'pressure') => {
            const ratio = cacheRatioForState(state);
            let removed = 0;
            for (const cache of Array.from(caches)) {
                if (!cache) { caches.delete(cache); continue; }
                try {
                    const base = Math.max(0, Number(cache.maxBytes || cache.totalBytes || 0) || 0);
                    if (typeof cache.trimToBytes === 'function' && base > 0) removed += Number(cache.trimToBytes(Math.max(128 * 1024, Math.floor(base * ratio))) || 0);
                    if (typeof cache.trimToSize === 'function') removed += Number(cache.trimToSize(getCacheEntryLimit(cache.label || '', cache.maxSize || 1000)) || 0);
                } catch (_) {}
            }
            removed += trimRuntimeRecomputable(state);
            runtime.lastTrimAt = Date.now();
            if (removed > 0 && isLibraDebugEnabled()) recordRuntimeDebug('log', `[LIBRA][ResourceGovernor] trimmed ${removed} runtime cache entries | state=${state} | reason=${reason}`);
            return removed;
        };
        const measureRuntimeBytes = () => {
            let total = 0;
            try {
                const maps = [
                    MemoryState?.hmeScopeIndexByScope,
                    MemoryState?.hmeGraphIndexByScope,
                    MemoryState?.sessionCache,
                    MemoryState?.pendingTurnCommits,
                    MemoryState?.turnMaintenanceSchedulesByChatId,
                    MemoryState?.recentMainResponseOutputCaptureByChatId,
                    MemoryState?.characterLoreEmbeddingCache,
                    MemoryState?.cbsResolvedCharacterLoreByScope,
                    MemoryState?.runtimeDebugRequestsByKey
                ];
                for (const map of maps) total += estimateBytes(map, { maxDepth: 3, maxNodes: 192, maxCollectionItems: 24 });
                total += estimateBytes(MemoryState?.activityDashboard?.events || [], { maxDepth: 2, maxNodes: 96 });
            } catch (_) {}
            return Math.max(0, total);
        };
        const getPolicy = (state = runtime.state) => {
            const cfg = getConfig();
            if (state === 'critical') return { maintenanceConcurrency: cfg.criticalMaintenanceConcurrency, batchRatio: 0.25, taskSliceMs: Math.max(4, cfg.targetTaskSliceMs * 0.55), maintenanceDelayRatio: 6, prefetch: false, backgroundAllowed: false };
            if (state === 'pressure') return { maintenanceConcurrency: cfg.pressureMaintenanceConcurrency, batchRatio: 0.55, taskSliceMs: Math.max(5, cfg.targetTaskSliceMs * 0.75), maintenanceDelayRatio: 2, prefetch: false, backgroundAllowed: true };
            if (state === 'recovery') return { maintenanceConcurrency: cfg.pressureMaintenanceConcurrency, batchRatio: 0.72, taskSliceMs: Math.max(6, cfg.targetTaskSliceMs * 0.85), maintenanceDelayRatio: 1.5, prefetch: false, backgroundAllowed: true };
            return { maintenanceConcurrency: cfg.normalMaintenanceConcurrency, batchRatio: 1, taskSliceMs: cfg.targetTaskSliceMs, maintenanceDelayRatio: 1, prefetch: true, backgroundAllowed: true };
        };
        const applyPolicy = (reason = '') => {
            const policy = getPolicy();
            for (const queue of queues) {
                try {
                    const desired = /MaintenanceLLMQueue/i.test(queue.label || '') ? policy.maintenanceConcurrency : 1;
                    queue.setMaxConcurrent?.(desired, `governor:${runtime.state}${reason ? `:${reason}` : ''}`);
                    queue.kick?.();
                } catch (_) {}
            }
        };
        const transition = (nextState, reason = '') => {
            if (!nextState || nextState === runtime.state) return false;
            const previous = runtime.state;
            runtime.state = nextState;
            runtime.stateSince = Date.now();
            runtime.transitionCount += 1;
            runtime.lastReason = String(reason || 'sample');
            applyPolicy(reason);
            if (nextState === 'pressure' || nextState === 'critical') trimCaches(nextState, reason);
            try { recordRuntimeDebug(nextState === 'critical' ? 'warn' : 'log', `[LIBRA][ResourceGovernor] ${previous}→${nextState} | reason=${runtime.lastReason} | owned=${runtime.measurements.ownedBytes} | queue=${runtime.measurements.queueBytes} | lag=${Math.round(runtime.eventLoopLagEmaMs)}ms`); } catch (_) {}
            return true;
        };
        const sample = (reason = 'interval', options = {}) => {
            const cfg = getConfig();
            if (!cfg.enabled) {
                if (runtime.state !== 'normal') transition('normal', 'disabled');
                return snapshot();
            }
            const t = Date.now();
            if (!options.force && runtime.lastSampleAt && (t - runtime.lastSampleAt) < 250) return snapshot();
            runtime.lastSampleAt = t;
            runtime.sampleCount += 1;
            let cacheBytes = 0, queueBytes = 0, pendingTasks = 0, activeTasks = 0;
            for (const cache of Array.from(caches)) {
                if (!cache) { caches.delete(cache); continue; }
                cacheBytes += Math.max(0, Number(cache.totalBytes || 0) || 0);
            }
            for (const queue of queues) {
                queueBytes += Math.max(0, Number(queue.pendingByteCount || 0) || 0);
                pendingTasks += Math.max(0, Number(queue.pendingCount || 0) || 0);
                activeTasks += Math.max(0, Number(queue.activeCount || 0) || 0);
            }
            const runtimeBytes = measureRuntimeBytes();
            let heapUsedBytes = 0, heapLimitBytes = 0, heapRatio = 0;
            try {
                const memory = performance?.memory;
                heapUsedBytes = Math.max(0, Number(memory?.usedJSHeapSize || 0) || 0);
                heapLimitBytes = Math.max(0, Number(memory?.jsHeapSizeLimit || 0) || 0);
                heapRatio = heapLimitBytes > 0 ? heapUsedBytes / heapLimitBytes : 0;
            } catch (_) {}
            const ownedBytes = cacheBytes + queueBytes + runtimeBytes;
            runtime.measurements = { cacheBytes, queueBytes, runtimeBytes, ownedBytes, heapUsedBytes, heapLimitBytes, heapRatio, pendingTasks, activeTasks };
            // A single slow foreground task is not the same thing as memory pressure.
            // Queue/working-set/heap limits may enter CRITICAL immediately, while
            // event-loop delay must be sustained before it can escalate. This avoids
            // a feedback loop where a legitimate long recall causes cache eviction,
            // index rebuilds, and even more main-thread work.
            const sustainedLag = runtime.eventLoopLagEmaMs >= 250
                && runtime.pressureSince > 0
                && (t - runtime.pressureSince) >= cfg.pressureHoldMs;
            const severeSustainedLag = runtime.eventLoopLagEmaMs >= 1000
                && runtime.pressureSince > 0
                && (t - runtime.pressureSince) >= Math.max(cfg.pressureHoldMs * 2, 1500);
            const critical = ownedBytes >= cfg.workingSetHardBytes
                || queueBytes >= cfg.pendingQueueHardBytes
                || heapRatio >= 0.92
                || severeSustainedLag;
            const pressured = ownedBytes >= cfg.workingSetSoftBytes
                || queueBytes >= cfg.pendingQueueSoftBytes
                || pendingTasks >= 12
                || heapRatio >= 0.82
                || runtime.eventLoopLagEmaMs >= 250
                || sustainedLag;
            if (critical) {
                runtime.pressureSince = runtime.pressureSince || t;
                runtime.healthySince = 0;
                transition('critical', `${reason}:hard-limit`);
                if ((t - runtime.lastTrimAt) > 2000) trimCaches('critical', `${reason}:hard-limit`);
            } else if (pressured) {
                runtime.pressureSince = runtime.pressureSince || t;
                runtime.healthySince = 0;
                if (runtime.state === 'critical' || runtime.state === 'recovery') transition('pressure', `${reason}:pressure-returned`);
                else if (runtime.state === 'normal' && (t - runtime.pressureSince) >= cfg.pressureHoldMs) transition('pressure', `${reason}:soft-limit`);
                else if (runtime.state === 'pressure' && (t - runtime.lastTrimAt) > 5000) trimCaches('pressure', `${reason}:sustained`);
            } else {
                runtime.pressureSince = 0;
                runtime.healthySince = runtime.healthySince || t;
                const healthyFor = t - runtime.healthySince;
                if ((runtime.state === 'critical' || runtime.state === 'pressure') && healthyFor >= Math.min(5000, cfg.recoveryHoldMs / 3)) transition('recovery', `${reason}:healthy`);
                else if (runtime.state === 'recovery' && healthyFor >= cfg.recoveryHoldMs) transition('normal', `${reason}:stable`);
            }
            applyPolicy(reason);
            return snapshot();
        };
        const touch = (reason = 'touch') => {
            runtime.lastTouchAt = Date.now();
            if (runtime.touchTimer || typeof setTimeout !== 'function') return;
            runtime.touchTimer = setTimeout(() => {
                runtime.touchTimer = null;
                sample(reason);
            }, 400);
            try { runtime.touchTimer?.unref?.(); } catch (_) {}
        };
        const reportTask = (label = 'task', durationMs = 0, meta = {}) => {
            const key = String(label || 'task').slice(0, 80);
            const duration = Math.max(0, Number(durationMs || 0) || 0);
            const previous = taskEma.get(key) || duration;
            taskEma.set(key, previous * 0.8 + duration * 0.2);
            // End-to-end task latency may include network/LLM waits and should not
            // be treated as event-loop lag. Actual lag is sampled by the interval
            // clock in start(), so quality-preserving foreground work does not
            // falsely force the governor into CRITICAL.
            touch(`task:${key}`);
        };
        const adaptiveBatchSize = (baseSize = 1, options = {}) => {
            const base = Math.max(1, Math.floor(Number(baseSize || 1) || 1));
            const min = Math.max(1, Math.floor(Number(options.min || 1) || 1));
            const max = Math.max(min, Math.floor(Number(options.max || base) || base));
            const label = String(options.label || 'batch');
            const ema = taskEma.get(label) || 0;
            const policy = getPolicy();
            const cfg = getConfig();
            const timingRatio = ema > 0 ? Math.max(0.25, Math.min(1.5, cfg.targetTaskSliceMs / ema)) : 1;
            return Math.max(min, Math.min(max, Math.floor(base * policy.batchRatio * timingRatio)));
        };
        const createYieldController = (label = 'work') => ({ label: String(label || 'work'), startedAt: now(), lastYieldAt: now(), processed: 0 });
        const yieldIfNeeded = async (controller = null, increment = 1) => {
            const ctl = controller || createYieldController();
            ctl.processed += Math.max(0, Number(increment || 0) || 0);
            const current = now();
            const slice = getPolicy().taskSliceMs;
            if ((current - ctl.lastYieldAt) < slice) return false;
            const ranFor = current - ctl.lastYieldAt;
            await new Promise(resolve => setTimeout(resolve, 0));
            ctl.lastYieldAt = now();
            reportTask(ctl.label, ranFor, { cooperativeYield: true });
            return true;
        };
        const shouldDeferBackground = (meta = {}) => runtime.state === 'critical' && meta?.essential !== true && meta?.foreground !== true;
        const getMaintenanceDelayMs = (baseMs = 0) => Math.min(120000, Math.max(0, Math.round((Number(baseMs || 0) || 0) * getPolicy().maintenanceDelayRatio)));
        const getPendingMaintenanceLimit = () => runtime.state === 'critical' ? 3 : runtime.state === 'pressure' ? 6 : runtime.state === 'recovery' ? 8 : 12;
        const start = () => {
            stop();
            const cfg = getConfig();
            if (!cfg.enabled || typeof setInterval !== 'function') return false;
            runtime.expectedTickAt = Date.now() + cfg.sampleIntervalMs;
            runtime.timer = setInterval(() => {
                const t = Date.now();
                const lag = Math.max(0, t - runtime.expectedTickAt);
                runtime.eventLoopLagMs = lag;
                runtime.eventLoopLagEmaMs = runtime.eventLoopLagEmaMs * 0.8 + lag * 0.2;
                runtime.expectedTickAt = t + getConfig().sampleIntervalMs;
                sample('interval', { force: true });
            }, cfg.sampleIntervalMs);
            try { runtime.timer?.unref?.(); } catch (_) {}
            sample('start', { force: true });
            return true;
        };
        const stop = () => {
            if (runtime.timer) { try { clearInterval(runtime.timer); } catch (_) {} runtime.timer = null; }
            if (runtime.touchTimer) { try { clearTimeout(runtime.touchTimer); } catch (_) {} runtime.touchTimer = null; }
        };
        const reset = () => {
            stop();
            runtime.state = 'normal';
            runtime.stateSince = Date.now();
            runtime.pressureSince = 0;
            runtime.healthySince = 0;
            runtime.lastSampleAt = 0;
            runtime.lastTrimAt = 0;
            runtime.lastReason = 'reset';
            runtime.eventLoopLagMs = 0;
            runtime.eventLoopLagEmaMs = 0;
            runtime.measurements = { cacheBytes: 0, queueBytes: 0, runtimeBytes: 0, ownedBytes: 0, heapUsedBytes: 0, heapLimitBytes: 0, heapRatio: 0, pendingTasks: 0, activeTasks: 0 };
            taskEma.clear();
            applyPolicy('reset');
        };
        const snapshot = () => ({
            state: runtime.state,
            stateSince: runtime.stateSince,
            lastReason: runtime.lastReason,
            transitionCount: runtime.transitionCount,
            sampleCount: runtime.sampleCount,
            eventLoopLagMs: Math.round(runtime.eventLoopLagMs),
            eventLoopLagEmaMs: Math.round(runtime.eventLoopLagEmaMs),
            policy: { ...getPolicy() },
            measurements: { ...runtime.measurements },
            queues: Array.from(queues).map(queue => ({ label: queue.label, active: queue.activeCount, pending: queue.pendingCount, pendingBytes: queue.pendingByteCount, concurrency: queue.maxConcurrent })),
            caches: Array.from(caches).map(cache => ({ label: cache?.label || '', size: cache?.cache?.size || 0, bytes: Number(cache?.totalBytes || 0) || 0, maxBytes: Number(cache?.maxBytes || 0) || 0 }))
        });
        return Object.freeze({
            registerCache, unregisterCache, registerQueue, estimateBytes, estimateTaskBytes,
            getCacheBudget, getCacheEntryLimit, enforceMapBudget, trimCaches,
            sample, touch, reportTask, adaptiveBatchSize, createYieldController, yieldIfNeeded,
            shouldDeferBackground, getMaintenanceDelayMs, getPendingMaintenanceLimit,
            getPolicy, start, stop, reset, snapshot
        });
    })();

    const MaintenanceLLMQueue = ResourceGovernor.registerQueue(new AsyncTaskQueue(3, 'MaintenanceLLMQueue'));
    const BackgroundMaintenanceQueue = ResourceGovernor.registerQueue(new AsyncTaskQueue(1, 'BackgroundMaintenanceQueue'));

    // Processes every item, but only materializes a small dynamic window of
    // promises. This prevents cold-start/import jobs from placing thousands of
    // closures and payloads on the maintenance queue at once. The governor may
    // shrink or expand the producer window without changing result order or
    // skipping any analysis item.
