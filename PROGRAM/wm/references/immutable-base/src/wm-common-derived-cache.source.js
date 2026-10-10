    // Optional test-fixture optimization. Storage authority, leases and receipts stay with WM.
    const WmReadonlyDerivedCache = (() => {
        const config = environment.snapshotDerivedCache;
        const disabled = Object.freeze({ enabled: false, releaseRequest() {}, invalidateScope() {}, dispose() {}, drain: async () => ({ ok: true }), stats: () => ({ enabled: false, parseLoads: 0, budgetFallbacks: 0, representationFallbacks: 0, requestBorrows: 0, requestOwners: 0 }) });
        if (!config?.enabled || VersionedCanonicalBridge.mode !== 'authority') return disabled;
        if (config.qualification?.kind !== 'test-fixture') throw new Error('wm_derived_cache_test_only');
        const module = WmSharedCacheFactory(), core = module.createSnapshotCache(config.budgets);
        const requests = new WeakMap(), active = new Set();
        const counts = { parseLoads: 0, budgetFallbacks: 0, representationFallbacks: 0, requestReuses: 0, activeLoadRawBytes: 0 };
        let disposed = false, authority = null, descriptorKey = null;
        const fail = reason => ({ ok: false, reason });
        const routeId = 'wm-explicit-test-authority', bindingEpoch = 'private-cache-instance-v1';
        const sourceFor = (scope, head) => ({ owner: 'WM', authorityId: head.authorityId, storeId: head.storeId, routeId, bindingEpoch, scope,
            head: { protocol: head.protocol, schema: head.schema, epoch: head.epoch, revision: head.revision, generationId: head.generationId, sha256: head.sha256, utf8Bytes: head.utf8Bytes, tombstone: head.tombstone } });
        const headFor = source => ({ ...source.head, authorityId: source.authorityId, storeId: source.storeId, scope: source.scope });
        const identityFor = (scope, storageKey, head) => ({ source: sourceFor(scope, head), segmentKind: 'whole', segmentId: storageKey,
            manifestRootDigest: head.sha256, contentRevision: head.revision, contentDigest: head.sha256, codecVersion: 'wm-canonical-envelope-json-v1', derivation: { transformVersion: 'wm-readonly-entries-v1' } });
        const ensureAuthority = head => {
            const nextKey = JSON.stringify([head.authorityId, head.storeId]);
            if (authority) return descriptorKey === nextKey ? { ok: true } : fail('wm_derived_cache_binding_changed');
            const description = environment.snapshotAuthority.describe();
            const result = core.registerAuthority({ level: 'C2', descriptor: { authorityId: head.authorityId, storeId: head.storeId, routeId, bindingEpoch, capabilities: [...(description.capabilities || [])] },
                qualification: { ...config.qualification }, observe: async identity => {
                    const current = await VersionedCanonicalBridge.currentSource(identity.source.scope, headFor(identity.source));
                    return current.ok && !disposed ? { ok: true, value: { healthy: true, source: identity.source } } : fail(current.reason || 'authority_disposed');
                } });
            if (!result.ok) return result;
            authority = result.value; descriptorKey = nextKey; return { ok: true };
        };
        const releaseItem = item => {
            if (item.borrow) { item.borrow.release(); item.borrow = null; }
            core.closeOwner(item.owner);
        };
        const releaseRequest = request => {
            const state = requests.get(request); if (!state) return;
            state.closed = true;
            for (const item of state.scopes.values()) releaseItem(item);
            state.scopes.clear(); requests.delete(request); active.delete(state);
        };
        const invalidateScope = scope => {
            core.invalidate({ namespace: 'WM', scope }, 'canonical_publication');
            for (const state of active) { const item = state.scopes.get(scope); if (item) { releaseItem(item); state.scopes.delete(scope); } }
        };
        // A detached loader closure captures no request owner, source receipt or lease.
        const createParseLoader = (frame, parse, scope, rawBytes) => () => {
            const text = frame.raw; frame.raw = null; counts.parseLoads++; counts.activeLoadRawBytes += rawBytes;
            try { return parse(text, scope); }
            finally { counts.activeLoadRawBytes -= rawBytes; }
        };
        const parseReadonly = async ({ request, scope, storageKey, raw, head, sourceToken, parse }) => {
            if (disposed || !request || typeof raw !== 'string' || !head || head.tombstone) return fail('wm_derived_request_invalid');
            if (!VersionedCanonicalBridge.validateSource(scope, sourceToken).ok) return fail('authority_write_token_required');
            const registered = ensureAuthority(head); if (!registered.ok) return registered;
            const stamp = JSON.stringify(head);
            let state = requests.get(request);
            if (state?.closed) return fail('wm_derived_request_closed');
            let item = state?.scopes.get(scope);
            if (item && item.stamp !== stamp) return fail('authority_source_changed');
            if (item?.borrow) {
                try { counts.requestReuses++; return { ok: true, value: item.borrow.value, cached: true }; }
                catch (_) { return fail('wm_derived_request_invalid'); }
            }
            // This is an optimization budget, never a new limit on canonical user data.
            const reserveBytes = raw.length * 10 + 16384;
            if (!Number.isSafeInteger(reserveBytes) || reserveBytes > config.budgets.maxBytes) {
                counts.budgetFallbacks++; const parsed = parse(raw, scope);
                return parsed.ok ? { ok: true, value: parsed.value, cached: false } : parsed;
            }
            if (!state) { state = { request, scopes: new Map(), closed: false }; requests.set(request, state); active.add(state); }
            if (!item) {
                const opened = core.openOwner({ namespace: 'WM', scope });
                if (!opened.ok) { counts.budgetFallbacks++; const parsed = parse(raw, scope); return parsed.ok ? { ok: true, value: parsed.value, cached: false } : parsed; }
                item = { owner: opened.value, stamp, borrow: null }; state.scopes.set(scope, item);
            }
            // The independent parse job never captures a request receipt or borrows its lease.
            const frame = { raw }, rawBytes = raw.length * 2;
            const result = await core.getOrLoad({ owner: item.owner, authority, identity: identityFor(scope, storageKey, head), reserveBytes,
                load: createParseLoader(frame, parse, scope, rawBytes) });
            frame.raw = null;
            if (disposed || state.closed || requests.get(request) !== state || state.scopes.get(scope) !== item) { if (result.ok) result.value.release(); return fail('wm_derived_request_closed'); }
            if (!result.ok) {
                if (result.reason !== 'resource_budget' && result.reason !== 'unsupported_value') return result;
                // Only cache capacity/nonrepresentability may use the existing canonical parser. Source and owner checks still govern it.
                const current = await VersionedCanonicalBridge.currentSource(scope, head);
                if (!current.ok || disposed || state.closed || requests.get(request) !== state || state.scopes.get(scope) !== item) return fail(current.reason || 'wm_derived_request_closed');
                if (result.reason === 'resource_budget') counts.budgetFallbacks++; else counts.representationFallbacks++;
                const parsed = parse(raw, scope);
                return parsed.ok ? { ok: true, value: parsed.value, cached: false } : parsed;
            }
            if (item.borrow) { result.value.release(); return { ok: true, value: item.borrow.value, cached: true }; }
            item.borrow = result.value;
            try { return { ok: true, value: item.borrow.value, cached: true }; }
            catch (_) { releaseItem(item); state.scopes.delete(scope); return fail('wm_derived_request_closed'); }
        };
        const dispose = () => { if (disposed) return; disposed = true; for (const state of [...active]) releaseRequest(state.request); core.dispose(); };
        const stats = () => ({ enabled: true, ...counts, requestOwners: active.size, requestBorrows: [...active].reduce((n, s) => n + [...s.scopes.values()].filter(i => !!i.borrow).length, 0), core: core.stats() });
        disposeAuthorityDerivedCache = dispose;
        invalidateAuthorityDerivedCache = invalidateScope;
        return Object.freeze({ enabled: true, parseReadonly, releaseRequest, invalidateScope, dispose, drain: core.drain, stats });
    })();
