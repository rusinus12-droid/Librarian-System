    // Derived jobs share one bounded background transport queue. Canonical data is read only.
    const TypedSemanticRuntime = (() => {
        const scopes = new Map(), inflight = new Map(), taintedDomains = new WeakMap(), queryRequests = new WeakMap();
        const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
        const copy = v => freeze(JSON.parse(JSON.stringify(v)));
        const issuedCaptures = new WeakSet(), sourceSizes = new WeakMap(), capturedSourceHandles = new WeakMap();
        const capture = s => {
            if (TypedRecallCorpus.isIssuedSnapshot(s) || issuedCaptures.has(s)) {
                const source = s.canonicalLore;
                const sourceHandle = TypedRecallCorpus.canonicalSourceHandle(s) || capturedSourceHandles.get(s);
                if (sourceHandle) {
                    // Canonical storage owns this immutable source, not a request
                    // JSON copy. Only an issued, scope/reset-bound handle enters
                    // the bounded request frame. Enumeration and consumer gates
                    // still inspect every source required by the current policy.
                    const rawFrame = JSON.stringify({ ...s, canonicalLore: [], canonicalSource: sourceHandle });
                    if (rawFrame.length > 4194304 || new TextEncoder().encode(rawFrame).length > 4194304) throw new Error('snapshot_bytes_bound');
                    const captured = Object.freeze({ ...freeze(JSON.parse(rawFrame)), canonicalLore: source, diagnostics: [] });
                    issuedCaptures.add(captured); capturedSourceHandles.set(captured, sourceHandle); return captured;
                }
                let size = sourceSizes.get(source);
                if (!size) {
                    const rawSource = JSON.stringify(source);
                    size = { chars: rawSource.length, bytes: new TextEncoder().encode(rawSource).length };
                    sourceSizes.set(source, size);
                }
                const rawFrame = JSON.stringify({ ...s, canonicalLore: [] });
                if (size.chars + rawFrame.length - 2 > 4194304 || size.bytes + new TextEncoder().encode(rawFrame).length - 2 > 4194304) throw new Error('snapshot_bytes_bound');
                const captured = Object.freeze({ ...freeze(JSON.parse(rawFrame)), canonicalLore: source, diagnostics: [] });
                issuedCaptures.add(captured); return captured;
            }
            const raw = JSON.stringify(s);
            if (typeof raw !== 'string' || raw.length > 4194304 || new TextEncoder().encode(raw).length > 4194304) throw new Error('snapshot_bytes_bound');
            const captured = Object.freeze({ ...freeze(JSON.parse(raw)), diagnostics: [] });
            issuedCaptures.add(captured); return captured;
        };
        const hash = v => SemanticRecallIndex.sourceHash(JSON.stringify(v));
        const bytes = s => new TextEncoder().encode(s).length;
        const fail = reason => ({ ok: false, reason });
        const stamp = s => JSON.stringify([s.scopeKey, s.branchId, s.resetGeneration, s.corpusRevision, s.worldlineRevision, s.viewerId, s.currentTurn, s.ephemeralDriftExclusion]);
        const units = (s, p) => TypedRecallCorpus.enumerate(s, p).filter(u => TypedRecallCorpus.adapters[u.family]?.eligibility(u, s).eligible);
        const state = scope => {
            if (!scopes.has(scope)) {
                if (scopes.size >= 64) throw new Error('scope_runtime_bound');
                scopes.set(scope, { latest: null, config: null, version: 0, querySerial: 0, paused: false, persistBaseline: null, diagnostics: [], pending: new Set(), controllers: new Set() });
            }
            return scopes.get(scope);
        };
        const diagnostic = (s, reason, detail = {}) => {
            const item = Object.freeze({ at: Date.now(), reason, ...detail }); s.diagnostics.push(item);
            if (s.diagnostics.length > 256) s.diagnostics.shift(); return item;
        };
        const install = (s, snapshot) => {
            if (s.latest && s.latest.requestGeneration > snapshot.requestGeneration && stamp(s.latest) !== stamp(snapshot)) return false;
            s.latest = capture(snapshot); return true;
        };
        const nativeCurrent = snapshot => JSON.stringify(LibraTurnWorldline.get(snapshot.worldlineScopeKey) || null) === JSON.stringify(snapshot.worldlineState || null);
        const current = (s, snapshot, version) => !s.paused && (!s.operationGuard || s.operationGuard()) && s.version === version && s.latest && stamp(s.latest) === stamp(snapshot) && nativeCurrent(s.latest);
        // capture.requestGeneration orders canonical observations, not user requests.
        // Only starting a query changes this nonce. Recapture/backfill and all persistent
        // row/vector bindings remain independent; query work never cancels background work.
        const beginQuery = s => { const token = Object.freeze({ nonce: ++s.querySerial }); queryRequests.set(token, s); return token; };
        const currentQuery = (s, token) => queryRequests.get(token) === s && token.nonce === s.querySerial;
        const budgetFor = b => {
            if (!b || !Number.isInteger(b.maxCalls) || b.maxCalls < 0 || !['maxRows', 'maxBytes', 'maxMillis'].every(k => Number.isInteger(b[k]) && b[k] > 0)) throw new Error('explicit_budget_required');
            return copy({ maxCalls: Math.min(64, b.maxCalls), maxRows: Math.min(256, b.maxRows), maxBytes: Math.min(1048576, b.maxBytes), maxMillis: Math.min(120000, b.maxMillis) });
        };
        // A queue slot follows transport completion. Caller deadlines include waiting;
        // expired waiting work never starts. Separate queues avoid backfill head-of-line blocking.
        const queue = limit => {
            const waiting = []; let active = 0;
            const pump = () => {
                while (active < limit && waiting.length) {
                    const job = waiting.shift();
                    if (job.done || job.controller.signal.aborted || Date.now() >= job.deadline) { job.finish(fail('deadline')); continue; }
                    active++;
                    Promise.resolve().then(() => job.run(job.controller.signal)).then(result => {
                        if (job.done) job.late(result); else job.finish(result);
                    }, error => { if (job.done) job.late(fail(String(error?.message || 'transport_failed'))); else job.finish(fail(String(error?.message || 'transport_failed'))); })
                        .finally(() => { active--; pump(); });
                }
            };
            return (run, deadline, signal, s) => new Promise(resolve => {
                if (waiting.length >= 64) return resolve(fail('queue_bound'));
                const controller = new AbortController(); s.controllers.add(controller);
                const job = { run, deadline, controller, done: false, finish: null, late: result => diagnostic(s, 'late_transport_discarded', { outcome: result.reason || 'success' }) };
                const cancel = () => { controller.abort(); job.finish(fail('cancelled')); };
                let timer;
                job.finish = result => {
                    if (job.done) return; job.done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', cancel); s.controllers.delete(controller); resolve(result);
                };
                if (signal?.aborted || deadline <= Date.now()) return job.finish(fail(signal?.aborted ? 'cancelled' : 'deadline'));
                timer = setTimeout(() => { job.finish(fail('deadline')); controller.abort(); }, deadline - Date.now());
                signal?.addEventListener?.('abort', cancel, { once: true });
                controller.signal.addEventListener('abort', () => { if (!job.done) job.finish(fail('cancelled')); }, { once: true });
                waiting.push(job); pump();
            });
        };
        const queryQueue = queue(1), backgroundQueue = queue(1);
        const cacheBinding = (s, u, p) => ({ schema: 'libra.typed-semantic.vector.v1', scopeKey: s.scopeKey, branchId: s.branchId,
            identity: u.identity, family: u.family, subtype: u.subtype, sourceHash: SemanticRecallIndex.sourceHash(u.text),
            provider: SemanticRecallIndex.providerDescriptor(p), mode: p.documentMode, dimension: p.dimension });
        const cacheKey = binding => `libra:v1:typed-semantic:${encodeURIComponent(binding.scopeKey)}:${encodeURIComponent(binding.branchId)}:vector:${hash(binding)}`;
        const vectorValid = (vector, dimension) => Array.isArray(vector) && vector.length === dimension && vector.every(n => typeof n === 'number' && Number.isFinite(n))
            && Number.isFinite(Math.hypot(...vector)) && Math.hypot(...vector) > 0;
        const tainted = adapter => {
            if (!taintedDomains.has(adapter.runtimeDomain)) taintedDomains.set(adapter.runtimeDomain, new Set());
            return taintedDomains.get(adapter.runtimeDomain);
        };
        const checkedCache = (raw, binding, maxBytes) => {
            if (typeof raw !== 'string' || raw.length > maxBytes || bytes(raw) > maxBytes) throw new Error('cache_bytes_bound');
            const row = JSON.parse(raw);
            if (Object.keys(row).sort().join() !== 'binding,vector,vectorChecksum' || JSON.stringify(row.binding) !== JSON.stringify(binding)
                || !vectorValid(row.vector, binding.dimension) || row.vectorChecksum !== SemanticRecallIndex.vectorChecksum(row.vector)) throw new Error('cache_binding_or_vector');
            return copy(row.vector);
        };
        const readCache = async (adapter, binding, maxBytes) => {
            const key = cacheKey(binding); if (tainted(adapter).has(key)) return null;
            try { const raw = await adapter.get(key); return raw == null ? null : checkedCache(raw, binding, maxBytes); } catch (_) { return null; }
        };
        const acknowledgedSet = async (adapter, key, value) => {
            try { if (!adapter.set || await adapter.set(key, value) === false) throw new Error('storage_set_failed'); tainted(adapter).delete(key); }
            catch (error) { const t = tainted(adapter); t.add(key); while (t.size > 4096) t.delete(t.values().next().value); throw error; }
        };
        const row = (snapshot, unit, p, vector) => ({ schema: SemanticRecallIndex.ROW_SCHEMA, scopeKey: snapshot.scopeKey, branchId: snapshot.branchId,
            identity: unit.identity, family: unit.family, subtype: unit.subtype, locator: unit.locator, contentHash: unit.persistentContentHash,
            dependencyHash: unit.persistentDependencyHash, representationVersion: unit.representationVersion, sourceHash: SemanticRecallIndex.sourceHash(unit.text),
            provider: SemanticRecallIndex.providerDescriptor(p), mode: p.documentMode, dimension: p.dimension,
            viewerId: snapshot.viewerId, vector, vectorChecksum: SemanticRecallIndex.vectorChecksum(vector) });
        const track = (s, work) => { s.pending.add(work); work.finally(() => s.pending.delete(work)).catch(() => {}); return work; };
        const execute = async (before, snapshot, p, policy, requestedBudget, options) => {
            const report = { ok: false, complete: false, calls: 0, reused: 0, written: 0, remaining: 0, bytes: 0, retired: [], diagnostics: [] };
            options.report = report;
            let s;
            try {
                s = state(snapshot.scopeKey); const b = budgetFor(requestedBudget), version = s.version;
                if (s.paused || !install(s, snapshot)) throw new Error('stale_or_paused');
                const deadline = options.deadline, all = units(snapshot, policy);
                if (all.length > Math.min(8192, policy?.storage?.maxExpectedRows || 2048) || bytes(JSON.stringify(snapshot)) > Math.min(4194304, policy?.storage?.maxExpectedBytes || 8388608)) throw new Error('corpus_bound');
                const old = new Map(before ? units(before, policy).map(u => [u.identity, u]) : []), now = new Map(all.map(u => [u.identity, u]));
                report.retired = [...old.keys()].filter(id => !now.has(id));
                const adapter = await MemoryEngine.getRecallDerivedStorageAdapter();
                if (!adapter?.set || adapter.setAcknowledgement !== 'awaited_local_storage_api') throw new Error('attempt_tracking_unavailable');
                const handle = await SemanticRecallIndex.open(snapshot, p, policy), validRows = new Map(SemanticRecallIndex.read(handle, all).rows.map(r => [r.identity, r]));
                const previousRows = before ? new Map(SemanticRecallIndex.read(await SemanticRecallIndex.open(before, p, policy), [...old.values()]).rows.map(r => [r.identity, r])) : new Map();
                if (!handle.writable) throw new Error('index_not_writable');
                const maxRowBytes = handle.limits.maxRowBytes;
                let processed = 0;
                for (const u of all) {
                    if (!current(s, snapshot, version) || options.signal.aborted || Date.now() >= deadline) { report.remaining++; continue; }
                    if (validRows.has(u.identity)) { report.reused++; continue; }
                    const binding = cacheBinding(snapshot, u, p), key = cacheKey(binding);
                    const previous = old.get(u.identity), changed = !previous || previous.persistentContentHash !== u.persistentContentHash || previous.persistentDependencyHash !== u.persistentDependencyHash || previous.representationVersion !== u.representationVersion;
                    let vector = await readCache(adapter, binding, maxRowBytes);
                    const validatedRow = validRows.get(u.identity) || previousRows.get(u.identity);
                    const rowVector = validatedRow?.sourceHash === binding.sourceHash ? validatedRow.vector : null;
                    if (vector && validRows.has(u.identity)) { report.reused++; continue; }
                    // Unchanged initial resident units are never implicitly embedded on persist.
                    if (before && !changed && !vector && !rowVector && !inflight.has(key)) continue;
                    // Reserve source, row/cache payloads, keys and advisory attempt records
                    // before transport. 24 bytes per finite JSON number is a safe upper bound.
                    const template = row(snapshot, u, p, Array(p.dimension).fill(0));
                    const rowReserve = bytes(JSON.stringify(template)) + p.dimension * 24;
                    const cacheReserve = bytes(JSON.stringify({ binding, vector: Array(p.dimension).fill(0), vectorChecksum: SemanticRecallIndex.vectorChecksum([1]) })) + p.dimension * 24;
                    const workReserve = bytes(u.text) + rowReserve + cacheReserve + bytes(SemanticRecallIndex.rowKey(snapshot, u, p)) + bytes(key) * 4 + 2048;
                    if (rowReserve > maxRowBytes || cacheReserve > maxRowBytes || ++processed > b.maxRows || report.bytes + workReserve > b.maxBytes) { report.remaining++; continue; }
                    report.bytes += workReserve;
                    if (!vector && rowVector) {
                        const raw = JSON.stringify({ binding, vector: rowVector, vectorChecksum: SemanticRecallIndex.vectorChecksum(rowVector) });
                        try { await acknowledgedSet(adapter, key, raw); vector = checkedCache(await adapter.get(key), binding, maxRowBytes); }
                        catch (error) { report.remaining++; report.diagnostics.push(diagnostic(s, 'cache_storage_failed', { outcome: String(error?.message || 'storage_failed') })); continue; }
                    }
                    if (vector) report.reused++;
                    else {
                        if (!inflight.has(key) && report.calls >= b.maxCalls) { report.remaining++; continue; }
                        if (!inflight.has(key)) {
                            const work = backgroundQueue(async signal => {
                                if (!current(s, snapshot, version)) return fail('stale_before_transport');
                                const cached = await readCache(adapter, binding, maxRowBytes); if (cached) return { ok: true, vector: cached, reused: true };
                                const intentKey = `${key}:intent`, attemptId = crypto.randomUUID(), prior = tainted(adapter).has(intentKey) ? null : await adapter.get(intentKey);
                                if (prior) {
                                    if (!options.retryUncertain) return fail('attempt_uncertain');
                                    let priorAttempt; try { priorAttempt = JSON.parse(prior); } catch (_) { return fail('attempt_uncertain'); }
                                    if (priorAttempt?.bindingHash !== hash(binding) || !Number.isFinite(priorAttempt.deadline)) return fail('attempt_uncertain');
                                    // Advisory lease/backoff only. Expiry never authorizes an
                                    // automatic retry and never proves the old host call stopped.
                                    if (Date.now() < priorAttempt.deadline + 200) return fail('attempt_lease_active');
                                }
                                // Advisory attempt journal, not a lease lock or exactly-once claim.
                                // A restart with an unfinished intent requires explicit retry authorization.
                                const attempt = { schema: 'libra.typed-semantic.attempt.v1', bindingHash: hash(binding), attemptId, started: Date.now(), deadline, previousAttempt: prior ? SemanticRecallIndex.sourceHash(String(prior)) : null };
                                await acknowledgedSet(adapter, `${key}:attempt:${attemptId}`, JSON.stringify(attempt));
                                await acknowledgedSet(adapter, intentKey, JSON.stringify(attempt));
                                if (await adapter.get(intentKey) !== JSON.stringify(attempt)) return fail('attempt_readback_failed');
                                if (signal.aborted || !current(s, snapshot, version) || Date.now() >= deadline) return fail('stale_before_transport');
                                report.calls++; diagnostic(s, 'document_started', { identity: u.identity, family: u.family, attemptId });
                                const result = await MemoryEngine.getEmbeddingWithSnapshot(u.text, p, { mode: p.documentMode, signal, deadline });
                                if (!result.ok) {
                                    try { await acknowledgedSet(adapter, `${key}:attempt:${attemptId}:result`, JSON.stringify({ attemptId, state: 'uncertain', reason: result.reason })); } catch (_) {}
                                    return result;
                                }
                                if(s.beforePublish&&await s.beforePublish(snapshot,p)!==true)return fail('canonical_source_changed');
                                if (signal.aborted || s.paused || (s.operationGuard && !s.operationGuard()) || s.version !== version || Date.now() >= deadline) return fail('late_document_discarded');
                                // Rebind only if the latest eligible canonical unit still has this input.
                                const latest = units(s.latest, policy).find(n => n.identity === u.identity);
                                if (!latest || !nativeCurrent(s.latest) || cacheKey(cacheBinding(s.latest, latest, p)) !== key) return fail('canonical_source_changed');
                                const raw = JSON.stringify({ binding, vector: result.vector, vectorChecksum: SemanticRecallIndex.vectorChecksum(result.vector) });
                                if (bytes(raw) > maxRowBytes) return fail('cache_bytes_bound');
                                await acknowledgedSet(adapter, key, raw);
                                const verified = checkedCache(await adapter.get(key), binding, maxRowBytes);
                                await acknowledgedSet(adapter, `${key}:attempt:${attemptId}:result`, JSON.stringify({ attemptId, state: 'cache_acknowledged', checksum: SemanticRecallIndex.vectorChecksum(verified) }));
                                return { ok: true, vector: verified };
                            }, deadline, options.signal, s);
                            if (inflight.size >= 256) throw new Error('inflight_bound');
                            inflight.set(key, work); work.finally(() => { if (inflight.get(key) === work) inflight.delete(key); }).catch(() => {});
                        }
                        const result = await inflight.get(key);
                        if (!result?.ok) { report.remaining++; report.diagnostics.push(diagnostic(s, result?.reason || 'document_failed', { identity: u.identity, uncertain: true })); continue; }
                        vector = result.vector; if (result.reused) report.reused++;
                    }
                    if(s.beforePublish&&await s.beforePublish(snapshot,p)!==true){report.remaining++;report.diagnostics.push(diagnostic(s,'canonical_source_changed',{identity:u.identity}));continue;}
                    if (!current(s, snapshot, version) || options.signal.aborted || Date.now() >= deadline) { report.remaining++; report.diagnostics.push(diagnostic(s, 'late_publish_discarded', { identity: u.identity })); continue; }
                    const publication = await SemanticRecallIndex.publish(handle, [row(snapshot, u, p, vector)], snapshot);
                    report.written += publication.written || 0;
                    if (!publication.ok) { report.remaining++; report.diagnostics.push(diagnostic(s, 'row_storage_failed', { identity: u.identity, outcome: publication.reason })); }
                }
                report.readiness = SemanticRecallIndex.read(handle, all).readiness;
                report.complete = report.remaining === 0 && current(s, snapshot, version);
                report.ok = report.complete; return report;
            } catch (error) { report.diagnostics.push(s ? diagnostic(s, String(error?.message || 'job_failed'), { uncertain: report.calls > 0 }) : { reason: String(error?.message || 'job_failed') }); return report; }
        };
        return { state, capture, copy, stamp, install, current, beginQuery, currentQuery, units, diagnostic, queryQueue, cacheBinding, readCache, row, execute, track, budgetFor,
            watchesScope: scope => scopes.has(scope) };
    })();

    const SemanticRecallJobs = (() => {
        const R = TypedSemanticRuntime;
        const configure = (scopeKey, provider, policy = {}) => {
            const p = StrictRecallEmbeddingTransport.snapshot(provider), s = R.state(scopeKey);
            s.version++; for (const controller of s.controllers) controller.abort();
            s.config = Object.freeze({ provider: p, policy: R.copy(policy) });
            R.diagnostic(s, 'configured'); return { ok: true };
        };
        const start = (before, snapshot, provider, policy, budget, options = {}) => {
            try { const s = R.state(snapshot.scopeKey), p = StrictRecallEmbeddingTransport.snapshot(provider), snap = R.capture(snapshot), pol = R.copy(policy || {}), bounded = R.budgetFor(budget);
                const controller = new AbortController(), deadline = Date.now() + bounded.maxMillis, context = { ...options, signal: controller.signal, deadline, report: null };
                s.controllers.add(controller);
                let timer;
                const timeout = new Promise(resolve => { timer = setTimeout(() => {
                    const d = R.diagnostic(s, 'backfill_deadline', { uncertain: (context.report?.calls || 0) > 0 });
                    resolve(R.copy({ ...context.report, ok: false, complete: false, diagnostics: [...(context.report?.diagnostics || []), d] })); controller.abort();
                }, bounded.maxMillis); });
                const execution = R.execute(before ? R.capture(before) : null, snap, p, pol, bounded, context);
                return R.track(s, Promise.race([execution, timeout]).finally(() => { clearTimeout(timer); s.controllers.delete(controller); }));
            } catch (e) { return Promise.resolve({ ok: false, complete: false, calls: 0, reused: 0, written: 0, diagnostics: [{ reason: String(e?.message || 'job_failed') }] }); }
        };
        const onPersist = (before, after, provider, policy = {}) => {
            if (!after?.scopeKey || (before && before.scopeKey !== after.scopeKey)) return Promise.resolve({ ok: false, reason: 'scope_mismatch' });
            const s = R.state(after.scopeKey), configuration = s.config;
            const baseline = s.persistBaseline || before;
            const p = provider || configuration?.provider, pol = provider ? policy : configuration?.policy;
            // Install the successful canonical generation even if indexing is disabled.
            if (!R.install(s, after)) return Promise.resolve({ ok: false, reason: 'stale_snapshot' });
            s.persistBaseline = null;
            if (!p || !pol?.background) return Promise.resolve({ ok: false, reason: 'unconfigured', calls: 0 });
            if(pol.mode==='production'&&s.schedulePersist)return Promise.resolve(s.schedulePersist(after,'acknowledged_persist'));
            return start(baseline, after, p, pol, pol.background);
        };
        const backfill = (snapshot, provider, policy, options = {}) => options.explicit === true
            ? start(null, snapshot, provider, policy, options.budget, { retryUncertain: options.retryUncertain === true })
            : Promise.resolve({ ok: false, reason: 'explicit_backfill_required', calls: 0 });
        const pause = scope => { const s = R.state(scope); s.paused = true; s.version++; for (const c of s.controllers) c.abort(); R.diagnostic(s, 'paused'); };
        const resume = scope => { const s = R.state(scope); s.paused = false; R.diagnostic(s, 'resumed'); };
        const drain = async scope => { const s = R.state(scope); while (s.pending.size) await Promise.allSettled([...s.pending]); };
        const inspect = scope => { const s = R.state(scope); return R.copy({ paused: s.paused, version: s.version, pending: s.pending.size, diagnostics: s.diagnostics }); };
        const beginPersist = before => { const s = R.state(before.scopeKey); if (!s.persistBaseline) s.persistBaseline = R.capture(before); };
        return Object.freeze({ configure, onPersist, backfill, pause, resume, cancel: pause, drain, inspect, beginPersist, watchesScope: R.watchesScope });
    })();

    const SemanticRecallEngine = (() => {
        const R = TypedSemanticRuntime;
        const search = async (query, snapshot, provider, options = {}) => {
            const started = Date.now(), deadline = Math.min(started + 1500, Number.isFinite(options.deadline) ? options.deadline : Infinity);
            const empty = reason => ({ status: 'degraded', reason, hits: [], elapsedMs: Date.now() - started, deadline, queryCalls: 0, documentCalls: 0 });
            let s, calls = 0;
            try {
                const snap = R.capture(snapshot), policy = R.copy(options.policy || {});
                s = R.state(snap.scopeKey); const version = s.version, activeScope = MemoryState._activeScopeKey;
                const requestToken = options.requestToken || R.beginQuery(s), queryCurrent = () => R.currentQuery(s, requestToken);
                const p = StrictRecallEmbeddingTransport.snapshot(provider);
                const scopeCurrent = () => MemoryState._activeScopeKey === activeScope;
                if (s.config && JSON.stringify(SemanticRecallIndex.providerDescriptor(s.config.provider)) !== JSON.stringify(SemanticRecallIndex.providerDescriptor(p))) return empty('provider_changed');
                if (s.paused || !R.install(s, snap)) return empty('stale_or_paused');
                const work = R.queryQueue(async signal => {
                    if (!R.current(s, snap, version) || !scopeCurrent() || !queryCurrent()) return { ok: false, reason: 'stale_snapshot' };
                    calls++; R.diagnostic(s, 'query_started', { deadline });
                    const result = await MemoryEngine.getEmbeddingWithSnapshot(query, p, { mode: p.queryMode, signal, deadline });
                    if (!result.ok) return result;
                    if (!R.current(s, snap, version) || !scopeCurrent() || !queryCurrent() || signal.aborted || Date.now() >= deadline) return { ok: false, reason: 'late_query_discarded' };
                    const all = R.units(snap, policy), handle = await SemanticRecallIndex.open(snap, p, policy);
                    const rows = new Map(SemanticRecallIndex.read(handle, all).rows.map(row => [row.identity, row.vector]));
                    const adapter = await MemoryEngine.getRecallDerivedStorageAdapter();
                    const hits = []; let scanned = 0;
                    for (const unit of all) {
                        if (++scanned > Math.min(8192, Number.isInteger(options.maxScanUnits) ? Math.max(1, options.maxScanUnits) : 256, policy?.storage?.maxExpectedRows || 2048) || Date.now() >= deadline || signal.aborted) break;
                        const vector = rows.get(unit.identity) || (adapter ? await R.readCache(adapter, R.cacheBinding(snap, unit, p), handle.limits.maxRowBytes) : null);
                        if (!vector) continue;
                        const norm = Math.hypot(...vector) * Math.hypot(...result.vector), score = vector.reduce((sum, n, i) => sum + n * result.vector[i], 0) / norm;
                        if (Number.isFinite(score)) hits.push({ identity: unit.identity, family: unit.family, subtype: unit.subtype, locator: unit.locator,
                            contentHash: unit.contentHash, dependencyHash: unit.dependencyHash, representationVersion: unit.representationVersion,
                            sourceHash: SemanticRecallIndex.sourceHash(unit.text), score });
                    }
                    if (!R.current(s, snap, version) || !scopeCurrent() || !queryCurrent() || signal.aborted || Date.now() >= deadline) return { ok: false, reason: 'late_query_discarded' };
                    hits.sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
                    const admitted = typeof options.filterHits === 'function' ? options.filterHits(hits) : hits;
                    if (!R.current(s, snap, version) || !scopeCurrent() || !queryCurrent() || signal.aborted || Date.now() >= deadline) return { ok: false, reason: 'late_query_discarded' };
                    return { ok: true, hits: admitted.slice(0, Math.max(1, Math.min(64, Number(options.depth) || 20))), coverage: { eligible: all.length, valid: hits.length, admitted: admitted.length } };
                }, deadline, options.signal, s);
                const result = await R.track(s, work);
                if (!result.ok) { R.diagnostic(s, result.reason, { lane: 'query', uncertain: calls > 0 }); return { ...empty(result.reason), queryCalls: calls }; }
                if (!R.current(s, snap, version) || !scopeCurrent() || !queryCurrent()) return { ...empty('late_query_discarded'), queryCalls: calls };
                return { status: result.hits.length ? (result.coverage.valid === result.coverage.eligible ? 'ready' : 'partial') : 'degraded', reason: result.hits.length ? '' : 'missing_vectors', hits: result.hits,
                    coverage: result.coverage, elapsedMs: Date.now() - started, deadline, queryCalls: calls, documentCalls: 0 };
            } catch (error) { const reason = String(error?.message || 'search_failed'); if (s) R.diagnostic(s, reason, { lane: 'query' }); return { ...empty(reason), queryCalls: calls }; }
        };
        return Object.freeze({ search });
    })();

    // Explicit fixture/shadow coordinator; no beforeRequest or consumer activation.
    const DualRecallEngine = (() => {
        const FAMILIES = ['memory', 'entity', 'world', 'narrative'], R = TypedSemanticRuntime;
        const graphEvidence = new WeakMap();
        const bounded = (value, fallback, lo, hi) => Number.isInteger(value) ? Math.max(lo, Math.min(hi, value)) : fallback;
        const depthFor = (policy, lane = 'heuristic') => bounded(policy?.[lane + 'Depth'], bounded(policy?.laneDepth, 32, 1, 32), 1, 32);
        const corpusLimit = policy => bounded(policy?.maxCorpusUnits, 2048, 1, 8192);
        const policyMode = p => (['fixture', 'shadow'].includes(p?.mode) || productionRecallPolicyValid(p)) && typeof p.version === 'string' && p.version;
        const no = reason => ({ ok: false, evidence: {}, reason });
        const resolveCurrent = (identity, snapshot, policy) => TypedRecallCorpus.enumerate(snapshot, policy).find(u => u.identity === identity);
        const canonicalBinding = (candidate, unit, snapshot, current) => {
            if (!unit || unit.scopeKey !== snapshot?.scopeKey || candidate?.identity !== unit.identity) return no('scope_or_identity');
            if (!current || current.contentHash !== unit.contentHash || current.dependencyHash !== unit.dependencyHash || current.representationVersion !== unit.representationVersion
                || current.family !== unit.family || current.subtype !== unit.subtype || JSON.stringify(current.locator) !== JSON.stringify(unit.locator)
                || current.text !== unit.text || (candidate.contentHash !== undefined && candidate.contentHash !== current.contentHash)
                || (candidate.dependencyHash !== undefined && candidate.dependencyHash !== current.dependencyHash)
                || (candidate.sourceHash !== undefined && candidate.sourceHash !== SemanticRecallIndex.sourceHash(current.text))) return no('stale_canonical');
            return { ok: true };
        };
        const admitResolved = (candidate, unit, snapshot, policy = {}, current) => {
            // Explicit user exclusions precede all soft evidence and semantic exceptions.
            const hard = TypedRecallCorpus.adapters[current?.family]?.eligibility(current, snapshot, policy.exclusions || {});
            if (!hard?.eligible) return no(hard?.reason || 'unknown_type');
            const binding = canonicalBinding(candidate, unit, snapshot, current);
            if (!binding.ok) return binding;
            const p = policy.admission?.[unit.family];
            if (!policyMode(policy) || !p) return no('policy_unconfigured');
            const evidence = { ...(candidate.evidence || {}), lane: candidate.lane, family: unit.family, canonical: true, partial: unit.partial || null };
            if (candidate.lane === 'semantic') {
                const lexical = TypedRecallCorpus.adapters[unit.family].heuristic(candidate.query || '', current).evidence.lexicalOverlap;
                // Lexical overlap is diagnostic only. Reject policies that make it a gate.
                if (p.semanticMinLexicalOverlap !== undefined && p.semanticMinLexicalOverlap !== 0) return no('semantic_lexical_gate_forbidden');
                if (![p.semanticMinScore, p.semanticMinMargin].every(Number.isFinite)) return no('semantic_policy_missing');
                if (!Number.isFinite(candidate.score) || candidate.score < p.semanticMinScore) return no('semantic_threshold');
                if ((Number.isFinite(candidate.margin) ? candidate.margin : 0) < p.semanticMinMargin) return no('semantic_margin');
                return { ok: true, reason: '', evidence: { ...evidence, semanticScore: candidate.score, lexicalOverlap: lexical,
                    margin: Number.isFinite(candidate.margin) ? candidate.margin : 0, independentAdmission: true } };
            }
            if (candidate.lane !== 'heuristic' || !Number.isFinite(p.heuristicMinScore) || !Number.isFinite(candidate.score) || candidate.score < p.heuristicMinScore) return no('heuristic_threshold');
            const issuedGraph = evidence.graph && graphEvidence.get(evidence.graph);
            const graphAccepted = issuedGraph && issuedGraph.identity === unit.identity
                && issuedGraph.contentHash === unit.contentHash && issuedGraph.dependencyHash === unit.dependencyHash
                && issuedGraph.query === String(candidate.query || '') && issuedGraph.requestGeneration === snapshot.requestGeneration
                && evidence.graph.scopeKey === snapshot.scopeKey && evidence.graph.corpusRevision === snapshot.corpusRevision;
            if (!graphAccepted && (unit.family === 'memory' ? !evidence.legacyAccepted : !(evidence.lexicalOverlap > 0))) return no('heuristic_evidence');
            return { ok: true, evidence, reason: '' };
        };
        const admit = (candidate, unit, snapshot, policy = {}) => admitResolved(candidate, unit, snapshot, policy,
            unit ? resolveCurrent(unit.identity, snapshot, policy) : null);
        const expandGraphLane = async (query, canonicalMap, snapshot, policy, admitted, seeds, trace, guard = null) => {
            const unique = new Map([...canonicalMap].filter(([, unit]) =>
                TypedRecallCorpus.adapters[unit.family]?.eligibility(unit, snapshot, policy.exclusions || {}).eligible));
            let graph;
            try { graph = await MemoryEngine.searchHmeTypedGraphCandidates([...unique.values()], seeds,
                { ...snapshot, sourceUnits: [...canonicalMap.values()], guard }); }
            catch (_) { graph = { hits: [], trace: { reason: 'graph_unavailable' } }; }
            trace.graph = { ...graph.trace, expansions: 1 };
            const admittedById = new Map(admitted.map(hit => [hit.identity, hit]));
            for (const hit of graph.hits) {
                const unit = unique.get(hit.identity); if (!unit) continue;
                const evidence = Object.freeze({ ...hit.evidence });
                graphEvidence.set(evidence, Object.freeze({ identity: unit.identity, contentHash: unit.contentHash,
                    dependencyHash: unit.dependencyHash, query: String(query || ''), requestGeneration: snapshot.requestGeneration }));
                const c = policy.calibration[unit.family], previous = admittedById.get(hit.identity);
                const candidate = { identity: unit.identity, lane: 'heuristic', family: unit.family, query,
                    rawScore: hit.score, score: Math.max(previous?.score || 0, hit.score * c.scale + c.offset),
                    evidence: { ...(previous?.evidence || {}), graph: evidence } };
                const verdict = admitResolved(candidate, unit, snapshot, policy, canonicalMap.get(unit.identity));
                if (!verdict.ok) { trace.drops.push({ identity: unit.identity, family: unit.family, reason: verdict.reason }); continue; }
                admittedById.set(unit.identity, { ...candidate, evidence: verdict.evidence });
            }
            const ranked = [...admittedById.values()].sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
            for (const omitted of ranked.slice(depthFor(policy))) trace.drops.push({ identity: omitted.identity, family: omitted.family, reason: 'outside_lane_depth' });
            return ranked.slice(0, depthFor(policy)).map((hit, i) => ({ ...hit, rank: i + 1 }));
        };
        const searchHeuristic = async (query, inputUnits, snapshot, policy = {}, options = {}) => {
            const trace = { stage: 'typed_pre_mmr', memory: null, drops: [], scanned: 0 };
            try {
                if (!policyMode(policy)) throw new Error('policy_not_frozen');
                for (const family of FAMILIES) {
                    const c = policy.calibration?.[family];
                    if (!c || !Number.isFinite(c.scale) || c.scale <= 0 || !Number.isFinite(c.offset)) throw new Error(`calibration_missing:${family}`);
                }
                const canonicalMap = new Map(TypedRecallCorpus.enumerate(snapshot, policy).map(unit => [unit.identity, unit]));
                const unique = new Map();
                for (const supplied of inputUnits || []) {
                    const current = canonicalMap.get(supplied?.identity), binding = canonicalBinding({ identity: supplied?.identity }, supplied, snapshot, current);
                    if (!binding.ok) { trace.drops.push({ identity: supplied?.identity, family: supplied?.family, reason: binding.reason }); continue; }
                    if (unique.has(supplied.identity)) { trace.drops.push({ identity: supplied.identity, reason: 'duplicate_identity' }); continue; }
                    const hard = TypedRecallCorpus.adapters[current.family]?.eligibility(current, snapshot, policy.exclusions || {});
                    if (!hard?.eligible) { trace.drops.push({ identity: supplied.identity, family: supplied.family, reason: hard?.reason || 'unknown_type' }); continue; }
                    unique.set(current.identity, current);
                }
                if (unique.size > corpusLimit(policy)) throw new Error('corpus_bound');
                trace.scanned = unique.size;
                const memory = [...unique.values()].filter(u => u.family === 'memory'), byKey = new Map(memory.map(u => [u.entry.key, u]));
                const memoryLane = await MemoryEngine.searchHeuristicCandidatesPreMmr(query, memory.map(u => u.entry), { currentTurn: snapshot.currentTurn,
                    scopeKey: snapshot.scopeKey, worldlineScopeKey: snapshot.worldlineScopeKey, worldlineState: snapshot.worldlineState,
                    ephemeralDriftExclusion: snapshot.ephemeralDriftExclusion, recallFeedbackLorebook: snapshot.canonicalLore,
                    ...(policy.memoryContext || {}), __typedCorpusBound: corpusLimit(policy), __typedPreMmrAdmission: hit => {
                        const unit = byKey.get(hit.entry.key), c = policy.calibration.memory;
                        const verdict = admitResolved({ identity: unit?.identity, lane: 'heuristic', family: 'memory', query,
                            score: hit.rawScore * c.scale + c.offset, evidence: hit.evidence }, unit, snapshot, policy, canonicalMap.get(unit?.identity));
                        if (!verdict.ok) trace.drops.push({ identity: unit?.identity, family: 'memory', reason: verdict.reason });
                        return verdict;
                    } }, depthFor(policy));
                trace.memory = memoryLane.trace;
                const candidates = memoryLane.hits.map(hit => ({ ...hit, unit: byKey.get(hit.entry.key) })).filter(hit => hit.unit);
                for (const unit of unique.values()) if (unit.family !== 'memory') candidates.push({ ...TypedRecallCorpus.adapters[unit.family].heuristic(query, unit), unit });
                const admitted = [];
                for (const raw of candidates) {
                    const unit = raw.unit, c = policy.calibration[unit.family], candidate = { identity: unit.identity, lane: 'heuristic',
                        family: unit.family, rawScore: raw.rawScore, score: raw.rawScore * c.scale + c.offset, evidence: raw.evidence, query };
                    const verdict = admitResolved(candidate, unit, snapshot, policy, canonicalMap.get(unit.identity));
                    if (!verdict.ok) { trace.drops.push({ identity: unit.identity, family: unit.family, reason: verdict.reason }); continue; }
                    admitted.push({ ...candidate, evidence: verdict.evidence });
                }
                admitted.sort((a, b) => b.score - a.score || a.identity.localeCompare(b.identity));
                const graphSeeds = admitted.map(hit => hit.identity);
                if (!options.deferGraph) {
                    const hits = await expandGraphLane(query, canonicalMap, snapshot, policy, admitted, graphSeeds, trace);
                    return { status: hits.length ? 'ready' : 'degraded', reason: hits.length ? '' : 'no_evidence', hits, trace };
                }
                for (const omitted of admitted.slice(depthFor(policy))) trace.drops.push({ identity: omitted.identity, family: omitted.family, reason: 'outside_lane_depth' });
                const hits = admitted.slice(0, depthFor(policy)).map((hit, i) => ({ ...hit, rank: i + 1 }));
                return { status: hits.length ? 'ready' : 'degraded', reason: hits.length ? '' : 'no_evidence', hits, trace, graphSeeds };
            } catch (error) { return { status: 'degraded', reason: String(error?.message || 'heuristic_failed'), hits: [], trace }; }
        };
        const fuseRrf = (heuristic, semantic, { k = 60 } = {}) => {
            if (!Number.isFinite(k) || k < 1 || k > 1000) throw new Error('rrf_policy');
            const union = new Map();
            for (const [lane, value] of [['heuristic', heuristic], ['semantic', semantic]]) {
                const seen = new Set(); let rank = 0;
                for (const candidate of value?.hits || []) {
                    if (!candidate?.identity || seen.has(candidate.identity)) continue;
                    seen.add(candidate.identity);
                    if (++rank > 32) break;
                    if (!union.has(candidate.identity)) union.set(candidate.identity, { identity: candidate.identity, rrf: 0,
                        ranks: { heuristic: null, semantic: null }, evidence: {} });
                    const item = union.get(candidate.identity);
                    item.rrf += 1 / (k + rank); item.ranks[lane] = rank; item.evidence[lane] = candidate.evidence || {};
                }
            }
            return [...union.values()].sort((a, b) => b.rrf - a.rrf || a.identity.localeCompare(b.identity)).slice(0, 64);
        };
        const selectDiverse = (fused, policy = {}) => {
            const p = policy.diversity || {}, items = [], trace = { steps: [], drops: [] }, seen = new Set(), typeCounts = new Map(), arcs = new Map();
            if (![p.lambda, p.crossRolePenalty, p.arcPenalty].every(Number.isFinite) || p.lambda < 0 || p.lambda > 1 || p.crossRolePenalty < 0 || p.crossRolePenalty > 1 || p.arcPenalty < 0)
                return { items, trace: { ...trace, reason: 'diversity_policy_missing' } };
            const maxItems = bounded(p.maxItems, 4, 1, 64), maxArc = bounded(p.maxPerArc, 2, 1, 64);
            const candidates = fused.filter(item => item?.unit && Number.isFinite(item.rrf) && !seen.has(item.identity) && seen.add(item.identity));
            const tokens = new Map(candidates.map(item => [item.identity, new Set(TokenizerEngine.tokenize(item.unit.text))]));
            const arcOf = item => item.unit.record?.arcKey || item.unit.record?.meta?.arcKey || '';
            const redundancy = item => items.reduce((max, prior) => {
                const a = tokens.get(item.identity), b = tokens.get(prior.identity), overlap = [...a].filter(token => b.has(token)).length;
                let similarity = overlap / Math.max(1, a.size + b.size - overlap);
                const roles = item.unit.roles || [], oldRoles = prior.unit.roles || [];
                if (roles.length && oldRoles.length && !roles.some(role => oldRoles.includes(role))) similarity *= p.crossRolePenalty;
                return Math.max(max, similarity);
            }, 0);
            const maxRrf = Math.max(0.000001, ...candidates.map(x => x.rrf)), selected = new Set();
            while (items.length < maxItems) {
                const ranked = [];
                for (const item of candidates) {
                    if (selected.has(item.identity)) continue;
                    const family = item.unit.family, cap = p.typeCaps?.[family], arc = arcOf(item);
                    if (Number.isInteger(cap) && (typeCounts.get(family) || 0) >= Math.max(0, cap)) { selected.add(item.identity); trace.drops.push({ identity: item.identity, family, roles: item.unit.roles, sourceRefs: item.unit.sourceRefs, reason: 'type_quota' }); continue; }
                    if (arc && (arcs.get(arc) || 0) >= maxArc) { selected.add(item.identity); trace.drops.push({ identity: item.identity, family, roles: item.unit.roles, sourceRefs: item.unit.sourceRefs, reason: 'arc_quota' }); continue; }
                    const red = redundancy(item), relevance = item.rrf / maxRrf;
                    const score = p.lambda * relevance - (1 - p.lambda) * red - p.arcPenalty * (arc ? arcs.get(arc) || 0 : 0);
                    ranked.push({ item, redundancy: red, relevance, mmr: score });
                }
                ranked.sort((a, b) => b.mmr - a.mmr || b.item.rrf - a.item.rrf || a.item.identity.localeCompare(b.item.identity));
                if (!ranked.length) break;
                // Consumer refill may seed surviving selections from this same union.
                const preferred = (p.preferredIdentities || []).find(id => !selected.has(id) && ranked.some(row => row.item.identity === id));
                const best = preferred ? ranked.find(row => row.item.identity === preferred) : ranked[0], item = best.item; items.push(item); selected.add(item.identity);
                typeCounts.set(item.unit.family, (typeCounts.get(item.unit.family) || 0) + 1);
                const arc = arcOf(item); if (arc) arcs.set(arc, (arcs.get(arc) || 0) + 1);
                trace.steps.push({ identity: item.identity, family: item.unit.family, roles: item.unit.roles, sourceRefs: item.unit.sourceRefs, redundancy: best.redundancy, relevance: best.relevance, mmr: best.mmr });
            }
            for (const item of candidates) if (!selected.has(item.identity)) trace.drops.push({ identity: item.identity, family: item.unit.family, roles: item.unit.roles, sourceRefs: item.unit.sourceRefs, reason: 'mmr_not_selected' });
            return { items, trace };
        };
        const retrieve = async (query, snapshot, provider, policy = {}) => {
            const trace = { reason: '', lanes: {}, union: 0, byType: Object.fromEntries(FAMILIES.map(family => [family, { corpus: 0, heuristic: 0, semantic: 0, fused: 0, selected: 0, causes: [] }])) };
            const empty = reason => ({ selection: [], trace: { ...trace, reason }, mode: policy.mode || 'shadow', productionEligible: false });
            try {
                if (!policyMode(policy)) return empty('policy_not_frozen');
                const snap = R.capture(snapshot), p = R.copy(policy), all = TypedRecallCorpus.enumerate(snap, p), byId = new Map(all.map(u => [u.identity, u]));
                if (all.length > corpusLimit(p)) return empty('corpus_bound');
                const runtime = R.state(snap.scopeKey), version = runtime.version, activeScope = MemoryState._activeScopeKey;
                const requestToken = R.beginQuery(runtime), deadline = Date.now() + bounded(p.queryBudgetMs, 1500, 1, 1500);
                if (!R.install(runtime, snap)) return empty('request_invalidated');
                const requestCurrent = () => R.current(runtime, snap, version) && R.currentQuery(runtime, requestToken) && MemoryState._activeScopeKey === activeScope;
                for (const u of all) trace.byType[u.family].corpus++;
                const h = await searchHeuristic(query, all, snap, p, { deferGraph: true });
                if (!requestCurrent()) return empty('request_invalidated');
                const drops = [...h.trace.drops];
                const sRaw = await SemanticRecallEngine.search(query, snap, provider, { requestToken, deadline, depth: depthFor(p, 'semantic'), policy: p, maxScanUnits: corpusLimit(p), filterHits: ranked => {
                    const admitted = [];
                    for (const [i, hit] of ranked.entries()) {
                        const unit = byId.get(hit.identity); if (!unit) { drops.push({ identity: hit.identity, reason: 'canonical_missing' }); continue; }
                        const candidate = { ...hit, lane: 'semantic', query, margin: hit.score - (ranked[i + 1]?.score ?? hit.score) };
                        const verdict = admitResolved(candidate, unit, snap, p, unit);
                        if (!verdict.ok) { drops.push({ identity: hit.identity, family: unit.family, reason: verdict.reason }); continue; }
                        admitted.push({ ...candidate, evidence: verdict.evidence });
                    }
                    for (const omitted of admitted.slice(depthFor(p, 'semantic'))) drops.push({ identity: omitted.identity, family: omitted.family, reason: 'outside_lane_depth' });
                    return admitted;
                } });
                if (!requestCurrent()) return empty('request_invalidated');
                const s = { ...sRaw, hits: sRaw.hits.map((hit, i) => ({ ...hit, rank: i + 1 })) };
                // Interleave the two admitted seed sets before the existing HME
                // seed cap. Expand once; graph discoveries stay in the heuristic
                // lane and never acquire a third RRF vote.
                const seedIds = [], seedSeen = new Set(), hSeeds = h.graphSeeds || [], sSeeds = s.hits.map(hit => hit.identity);
                for (let i = 0; i < Math.max(hSeeds.length, sSeeds.length); i++)
                    for (const identity of [hSeeds[i], sSeeds[i]]) if (identity && !seedSeen.has(identity)) { seedSeen.add(identity); seedIds.push(identity); }
                h.hits = await expandGraphLane(query, byId, snap, p, h.hits, seedIds, h.trace, requestCurrent);
                h.status = h.hits.length ? 'ready' : 'degraded'; h.reason = h.hits.length ? '' : 'no_evidence';
                if (!requestCurrent()) return empty('request_invalidated');
                trace.lanes = { heuristic: { returned: h.hits.length, status: h.status, reason: h.reason, trace: h.trace },
                    semantic: { returned: s.hits.length, rawReturned: sRaw.hits.length, status: s.status, reason: s.reason, queryCalls: s.queryCalls, documentCalls: s.documentCalls, coverage: s.coverage || null } };
                const fused = fuseRrf(h, s, p.rrf || {}); trace.union = fused.length;
                const diverse = selectDiverse(fused.map(item => ({ ...item, unit: byId.get(item.identity) })), p);
                trace.diversity = diverse.trace; trace.fused = fused; trace.drops = [...drops, ...diverse.trace.drops];
                for (const [name, lane] of [['heuristic', h], ['semantic', s]]) for (const hit of lane.hits) trace.byType[byId.get(hit.identity).family][name]++;
                for (const hit of fused) trace.byType[byId.get(hit.identity).family].fused++;
                for (const hit of diverse.items) trace.byType[hit.unit.family].selected++;
                for (const drop of trace.drops) if (trace.byType[drop.family]) trace.byType[drop.family].causes.push(drop.reason);
                for (const value of Object.values(trace.byType)) { value.causes = [...new Set(value.causes)]; if (value.corpus && !value.selected && !value.causes.length) value.causes.push(!value.fused ? 'no_lane_candidate' : 'mmr_not_selected'); }
                if (!requestCurrent()) return empty('request_invalidated');
                return { selection: diverse.items, union: fused.map(item => ({ ...item, unit: byId.get(item.identity) })), requestGuard: requestCurrent, trace, mode: p.mode, productionEligible: p.mode === 'production' };
            } catch (error) { return empty(String(error?.message || 'fusion_failed')); }
        };
        return Object.freeze({ searchHeuristic, admit, fuseRrf, selectDiverse, retrieve });
    })();
