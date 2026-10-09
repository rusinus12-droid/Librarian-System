    // Native C0: a fresh strict physical read precedes every pure parse lookup.
    // Local route/request tokens are lifetime fences, never storage authority.
    let clearNativeReadonlyFallback = () => {};
    const WmNativeReadonlyDerivedCache = (() => {
        const config = environment.nativeReadonlyDerivedCache;
        const disabled = Object.freeze({ enabled: false, openRequest: () => null, releaseRequest() {}, invalidateScope() {}, dispose() {}, drain: async () => ({ ok: true }), stats: () => ({ enabled: false }) });
        if (runtimeDetached || VersionedCanonicalBridge.mode !== 'native' || config?.enabled === false) return disabled;
        // Initial measured setting, not a total JS heap cap or a product-wide quota.
        const budgets = { maxBytes: 131072, maxEntries: 4, maxFlights: 4, maxSubscribers: 16, maxOwners: 16, maxObservations: 32, maxAuthorities: 1, maxValueNodes: 8192, ...config?.budgets };
        const module = WmSharedCacheFactory(), requests = new WeakMap(), reads = new WeakMap(), active = new Set();
        const counts = { parseLoads: 0, budgetFallbacks: 0, representationFallbacks: 0, fallbackReuses: 0, observations: 0, routeResets: 0, activeLoadRawBytes: 0 };
        let core = null, authority = null, route = null, routeSerial = 0, disposed = false;
        const fail = reason => ({ ok: false, reason });
        const readRoute = () => { try { return RisuCompat.pluginStorage.readRouteIdentity(); } catch (_) { return null; } };
        const sameRoute = (a, b) => !!a && !!b && a.storage === b.storage && a.getItem === b.getItem;
        const releaseItem = item => {
            for (const pin of item.pins) { pin.borrow.release(); item.core.closeObservation(pin.observation); }
            item.pins.clear();
            if (item.owner) item.core.closeOwner(item.owner);
        };
        const releaseRequest = request => {
            const state = requests.get(request); if (!state) return;
            state.closed = true;
            for (const item of state.scopes.values()) releaseItem(item);
            state.scopes.clear(); state.guard = null;
            for (const token of state.reads) reads.delete(token);
            state.reads.clear(); requests.delete(request); active.delete(state);
        };
        const invalidateScope = scope => {
            if (core) core.invalidate({ namespace: 'WM-native-readonly', scope }, 'native_scope_retired');
            clearNativeReadonlyFallback(scope);
            for (const state of active) { const item = state.scopes.get(scope); if (item) { releaseItem(item); state.scopes.delete(scope); } }
        };
        const resetRoute = next => {
            if (core) { for (const state of [...active]) releaseRequest(state.request); core.dispose(); clearNativeReadonlyFallback(); route = null; if (core.stats().jobs) return false; counts.routeResets++; }
            clearNativeReadonlyFallback(); route = next; if (!next) return false; routeSerial++;
            core = module.createSnapshotCache(budgets);
            const registered = core.registerAuthority({ level: 'C0', descriptor: { authorityId: 'wm-native-pure-parse', storeId: 'runtime-pluginStorage-instance', routeId: 'risu-compat-strict-native', bindingEpoch: 'local-route-' + routeSerial } });
            if (!registered.ok) throw new Error(registered.reason);
            authority = registered.value; return true;
        };
        const live = state => {
            if (disposed || runtimeDisposed || !isLibraRuntimeEpochActive() || !state || state.closed || requests.get(state.request) !== state) return false;
            try { return state.guard() && sameRoute(state.route, readRoute()); } catch (_) { return false; }
        };
        const openRequest = ({ guard = () => true } = {}) => {
            if (disposed || runtimeDisposed || !isLibraRuntimeEpochActive() || typeof guard !== 'function') return null;
            const next = readRoute(); if (!next) { if (core) resetRoute(null); return null; }
            if ((!core || !sameRoute(route, next)) && !resetRoute(next)) { counts.budgetFallbacks++; return null; }
            if (active.size >= budgets.maxOwners) { counts.budgetFallbacks++; return null; }
            const request = Object.freeze({}), state = { request, route, guard, scopes: new Map(), reads: new Set(), closed: false };
            requests.set(request, state); active.add(state); return request;
        };
        const beginRead = (request, scope) => {
            const state = requests.get(request); if (!live(state)) return fail('native_derived_request_closed');
            let item = state.scopes.get(scope);
            if (!item) {
                const opened = scope.length <= 1024 ? core.openOwner({ namespace: 'WM-native-readonly', scope }) : fail('unsupported_value');
                if (!opened.ok && opened.reason !== 'resource_budget' && opened.reason !== 'unsupported_value') return opened;
                item = { core, owner: opened.ok ? opened.value : null, fallbackReason: opened.reason, pins: new Set() }; state.scopes.set(scope, item);
            }
            const token = Object.freeze({}); reads.set(token, { state, item, scope }); state.reads.add(token); return { ok: true, value: token };
        };
        const currentRead = token => {
            const read = reads.get(token);
            return read && live(read.state) && read.state.scopes.get(read.scope) === read.item && read.item.core === core ? read : null;
        };
        const validateRead = token => !!currentRead(token);
        const finishRead = token => {
            const read = reads.get(token); if (!read) return;
            read.state.reads.delete(token); reads.delete(token);
            // Uncached fallback must not retain one owner per traversed scope.
            if (!read.item.pins.size && read.state.scopes.get(read.scope) === read.item
                && ![...read.state.reads].some(other => reads.get(other)?.item === read.item)) {
                releaseItem(read.item); read.state.scopes.delete(read.scope);
            }
        };
        // Loader frame contains only pure raw/parse work, never a request or receipt.
        const parseLoader = (frame, parse, scope) => () => {
            const raw = frame.raw; frame.raw = null; counts.parseLoads++; counts.activeLoadRawBytes += raw.length * 2;
            try { frame.parsed = parse(raw, scope); return frame.parsed; }
            finally { counts.activeLoadRawBytes -= raw.length * 2; }
        };
        const parseReadonly = async ({ read: token, raw, storageKey, parse, fallbackValue = null }) => {
            const read = currentRead(token); if (!read || typeof raw !== 'string') return fail('native_derived_request_closed');
            if (fallbackValue) { counts.fallbackReuses++; return { ok: true, value: fallbackValue, cached: false, immutable: true }; }
            const reserveBytes = raw.length * 10 + 16384;
            const fallback = (reason, parsed = null) => {
                if (!currentRead(token)) return fail('native_derived_request_closed');
                if (reason !== 'resource_budget' && reason !== 'unsupported_value') return fail(reason);
                if (reason === 'resource_budget') counts.budgetFallbacks++; else counts.representationFallbacks++;
                const result = parsed || parse(raw, read.scope);
                return result.ok ? { ok: true, value: result.value, cached: false } : result;
            };
            if (!read.item.owner) return fallback(read.item.fallbackReason);
            if (!Number.isSafeInteger(reserveBytes) || reserveBytes > budgets.maxBytes) return fallback('resource_budget');
            const observed = core.openObservation(read.item.owner, { raw });
            if (!observed.ok) return fallback(observed.reason);
            counts.observations++;
            const observation = observed.value, frame = { raw, parsed: null }, service = core;
            let result;
            try {
                result = await service.getOrLoad({ owner: read.item.owner, authority, observation, kind: 'pure_projection', reserveBytes,
                    identity: { segmentId: storageKey, codecVersion: 'wm-canonical-envelope-json-v1', transformVersion: 'wm-readonly-entries-v1' },
                    load: parseLoader(frame, parse, read.scope) });
                if (!currentRead(token)) { if (result.ok) result.value.release(); return fail('native_derived_request_closed'); }
                if (!result.ok) return fallback(result.reason, frame.parsed);
                const value = result.value.value;
                const existing = [...read.item.pins].find(pin => pin.borrow.value === value);
                if (existing) result.value.release();
                else { read.item.pins.add({ borrow: result.value, observation }); result = null; }
                return { ok: true, value, cached: true };
            } finally {
                frame.raw = null; frame.parsed = null;
                if (result !== null) service.closeObservation(observation);
            }
        };
        const dispose = () => {
            if (disposed) return; disposed = true;
            for (const state of [...active]) releaseRequest(state.request);
            clearNativeReadonlyFallback(); if (core) core.dispose(); route = null;
        };
        runtimeDisposers.push(dispose);
        const stats = () => ({ enabled: true, ...counts, requestOwners: active.size, requestBorrows: [...active].reduce((n, s) => n + [...s.scopes.values()].reduce((m, i) => m + i.pins.size, 0), 0),
            pendingReads: [...active].reduce((n, s) => n + s.reads.size, 0), core: core ? core.stats() : null, budgets: { ...budgets } });
        return Object.freeze({ enabled: true, openRequest, beginRead, validateRead, finishRead, parseReadonly, releaseRequest, invalidateScope, dispose, drain: async () => core ? core.drain() : ({ ok: true }), stats });
    })();
