/* MEMORY SUITE HEALTH RECOVERY v1.0.0
 * Pure summary and bounded derived-cache repair policy. No storage, model,
 * timer, credential, source-text, or owner-engine access belongs here.
 */
const MemorySuiteHealthRecovery = (() => {
  const report = (input = {}) => {
    const known = input.known === true, complete = known && input.complete === true;
    const issues = (Array.isArray(input.issues) ? input.issues : []).slice(0, 100).map(value => ({
      code: /^[A-Z0-9_]{1,80}$/.test(String(value?.code || '')) ? value.code : 'OWNER_REVIEW_REQUIRED',
      count: Math.max(0, Math.min(1000000, Number(value?.count) || 0))
    }));
    return Object.freeze({ schema: 'memory-suite.health.v1', owner: ['WM','LIBRA','HAYAKU','FLASHBACK','LIA','RETRACE'].includes(input.owner) ? input.owner : 'UNKNOWN',
      readOnly: true, known, complete, status: !known ? 'unknown' : !complete ? 'incomplete' : issues.length ? 'attention' : 'no_detected_issue',
      issues, automaticModelReanalysis: false, automaticPhysicalRepair: false });
  };
  const create = (options = {}) => {
    const clock = typeof options.now === 'function' ? options.now : Date.now;
    const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts) || 2));
    const retryMs = Math.max(100, Math.min(60000, Number(options.retryMs) || 5000));
    let active = null, inFlight = null;
    const outcome = (status, reason, extra = {}) => Object.freeze({ status, reason, ...extra });
    const preview = (binding, action = {}) => {
      const allowed = typeof binding === 'string' && binding.length > 0 && action.id === 'refresh_derived_cache'
        && action.safe === true && action.model === false && action.physical === false;
      if (!allowed) return Object.freeze({ allowed: false, action: 'manual_review', reason: 'not_safe_derived_repair' });
      if (active?.binding === binding) return active.ticket;
      if (inFlight) return Object.freeze({ allowed: false, action: action.id, reason: 'operation_in_progress' });
      const ticket = Object.freeze({ allowed: true, action: action.id, modelCalls: 0, physicalWrites: 0 });
      // A health UI owns one current preview, not a history of chat snapshots.
      // Replacing it releases the previous proof and makes its ticket invalid.
      active = { ticket, binding, attempts: 0, retryAt: 0, running: null, terminal: null };
      return ticket;
    };
    const run = (ticket, options = {}) => {
      const entry = active?.ticket === ticket ? active : null;
      if (!entry || options.binding !== entry.binding) return Promise.resolve(outcome('blocked', 'stale_or_unknown_ticket'));
      if (entry.running) return entry.running;
      if (entry.terminal) return Promise.resolve(entry.terminal);
      if (clock() < entry.retryAt) return Promise.resolve(outcome('deferred', 'backoff', { retryAt: entry.retryAt }));
      inFlight = entry;
      entry.running = Promise.resolve().then(async () => {
        entry.attempts += 1;
        let started = false;
        try {
          if (typeof options.execute !== 'function' || typeof options.verify !== 'function') {
            return entry.terminal = outcome('blocked', 'adapter_contract_missing');
          }
          if (options.preflight && await options.preflight() !== true) {
            if (entry.attempts >= maxAttempts) return entry.terminal = outcome('blocked', 'attempts_exhausted');
            entry.retryAt = clock() + retryMs * Math.pow(2, entry.attempts - 1);
            return outcome('deferred', 'preflight_unavailable', { retryAt: entry.retryAt });
          }
          if (active !== entry) return outcome('blocked', 'stale_or_unknown_ticket');
          started = true; await options.execute();
          if (active !== entry) return entry.terminal = outcome('uncertain', 'verification_incomplete');
          const verified = await options.verify();
          if (active !== entry || verified !== true) return entry.terminal = outcome('uncertain', 'verification_incomplete');
          return entry.terminal = outcome('verified', 'derived_cache_refreshed');
        } catch (_) {
          // Once execution starts, even a local refresh can have partially
          // published state. Never infer rollback or launch another attempt.
          return entry.terminal = outcome(started ? 'uncertain' : 'blocked', started ? 'verification_incomplete' : 'preflight_failed');
        } finally { entry.running = null; if (inFlight === entry) inFlight = null; }
      });
      return entry.running;
    };
    const clear = () => { active = null; };
    const observe = binding => { if (active && active.binding !== binding) clear(); };
    const retention = () => ({ activeTickets: active ? 1 : 0, inFlight: inFlight ? 1 : 0,
      bindingCodeUnits: (active || inFlight)?.binding.length || 0 });
    return Object.freeze({ preview, run, clear, observe, retention });
  };
  const ownerAdapter = ({ owner, snapshot, clear, empty }) => {
    const policy = create();
    let lifetime = 0;
    const clearProof = () => { lifetime += 1; policy.clear(); };
    const inspect = async () => {
      const started = lifetime;
      try { const before = await snapshot(), after = await snapshot();
        if (started !== lifetime) return report({ owner, known: false, complete: false });
        if (before.binding !== after.binding) { policy.clear(); throw new Error('changed'); }
        policy.observe(before.binding);
        return report({ owner, known: before.valid === true, complete: false,
          issues: before.valid ? [{ code: 'DEEP_CHECK_NOT_RUN', count: 1 }] : [{ code: 'OWNER_METADATA_UNVERIFIED', count: 1 }] });
      } catch (_) { policy.clear(); return report({ owner, known: false, complete: false }); }
    };
    const preview = async () => {
      const started = lifetime;
      try { const value = await snapshot();
        if (started !== lifetime) return Object.freeze({ allowed: false, reason: 'owner_view_changed' });
        policy.observe(value.binding);
        return policy.preview(value.binding, { id: 'refresh_derived_cache', safe: value.valid === true && value.mode === 'plugin_only' && !value.busy, model: false, physical: false });
      } catch (_) { policy.clear(); return Object.freeze({ allowed: false, reason: 'owner_snapshot_unavailable' }); }
    };
    const repair = async ticket => {
      const started = lifetime;
      try { const before = await snapshot();
        if (started !== lifetime) return { status: 'blocked', reason: 'owner_view_changed' };
        policy.observe(before.binding);
        if (!before.valid || before.mode !== 'plugin_only' || before.busy) return { status: 'blocked', reason: 'owner_snapshot_unavailable' };
        const result = await policy.run(ticket, { binding: before.binding,
          preflight: async () => { const current = await snapshot(); return current.binding === before.binding && !current.busy; },
          execute: async () => clear(before.scopeKey),
          verify: async () => { const after = await snapshot(); return after.binding === before.binding && !after.busy && empty(before.scopeKey); }
        });
        // A completed ticket records an earlier clear, not the current cache.
        // Normal recall may refill it without changing canonical source bytes.
        if (result.status === 'verified' && !empty(before.scopeKey)) {
          policy.clear();
          return { status: 'blocked', reason: 'derived_cache_refilled' };
        }
        return result;
      } catch (_) { policy.clear(); return { status: 'blocked', reason: 'owner_snapshot_unavailable' }; }
    };
    return Object.freeze({ inspect, preview, repair, clear: clearProof, retention: policy.retention });
  };
  const createOrchestrator = (options = {}) => {
    const adapters = { refresh_derived_cache: options.derivedCache, explicit_reanalysis: options.reanalysis,
      physical_storage_repair: options.physicalRepair };
    const previews = new Map(), requests = new Map();
    let lifetime = 0, running = null;
    const blocked = reason => Object.freeze({ ok: false, status: 'blocked', reason, ...(options.cacheOnly === true
      ? { owner: options.owner, sourceCurrentness: 'unknown', writeIssued: false, effects: Object.freeze({ modelCalls: 0, canonicalWrites: 0, physicalWrites: 0, derivedCache: 'not_started', changedFields: 0 }) } : {}) });
    const inspect = async selection => typeof options.inspect === 'function'
      ? await options.inspect(selection) : report({ known: false, complete: false });
    const preview = async (actionKind, selection) => {
      const adapter = adapters[actionKind];
      if (!adapter || typeof adapter.preview !== 'function' || typeof adapter.apply !== 'function')
        return Object.freeze({ allowed: false, reason: 'unsupported_repair_action' });
      if (running) return Object.freeze({ allowed: false, reason: 'operation_in_progress' });
      previews.delete(actionKind);
      const request = (requests.get(actionKind) || 0) + 1, started = lifetime;
      requests.set(actionKind, request);
      try {
        // Preview adapters may inspect eligibility, never invoke a model.
        const proof = await adapter.preview(selection);
        if (started !== lifetime || requests.get(actionKind) !== request || running)
          return Object.freeze({ allowed: false, reason: 'owner_view_changed' });
        if (proof?.allowed !== true) return Object.freeze({ allowed: false, reason: proof?.reason || 'preview_unavailable' });
        // Do not expose the adapter's private execution/publication proof.
        const physical = actionKind === 'physical_storage_repair';
        const summary = physical ? { counts: Object.freeze(Object.fromEntries([
          'eligibleSources', 'eligibleRecords', 'failedSources', 'uncertainSources', 'legacySources', 'blockedSources', 'archivePending'
        ].map(key => { const value = Number(proof.counts?.[key]);
          return [key, Number.isFinite(value) ? Math.max(0, Math.min(1000000, Math.floor(value))) : 0];
        }))) } : { units: Object.freeze((Array.isArray(proof.units) ? proof.units : []).map(unit => Object.freeze({
          key: String(unit.key || ''), start: Number(unit.start || 0), end: Number(unit.end || 0), label: String(unit.label || '')
        }))) };
        const ticket = Object.freeze({ allowed: true, actionKind, owner: String(proof.owner || ''),
          scopeKey: String(proof.scopeKey || ''), ...summary, ...(options.cacheOnly === true ? { sourceCurrentness: 'unknown' } : {}), warning: String(proof.warning || ''),
          model: physical ? proof.model === true : actionKind === 'explicit_reanalysis' && proof.model !== false });
        previews.set(actionKind, { ticket, proof, adapter, lifetime: started });
        return ticket;
      } catch (_) { return Object.freeze({ allowed: false, reason: 'preview_unavailable' }); }
    };
    const apply = ticket => {
      if (running?.ticket === ticket) return running.promise;
      const entry = previews.get(ticket?.actionKind);
      if (!entry || entry.ticket !== ticket || entry.lifetime !== lifetime) return Promise.resolve(blocked('stale_or_unknown_ticket'));
      if (running) return Promise.resolve(blocked('operation_in_progress'));
      const physical = ticket.actionKind === 'physical_storage_repair';
      if (ticket.actionKind === 'explicit_reanalysis' || physical || options.oneUseDerivedCache === true) previews.delete(ticket.actionKind);
      const operation = { ticket, promise: null }, sealedResults = new WeakSet();
      const sealResult = result => {
        if (!result || typeof result !== 'object') throw new TypeError('execution_result_required');
        const visited = new WeakSet();
        const freeze = value => {
          if (typeof value === 'function') throw new TypeError('execution_result_must_be_data');
          if (!value || typeof value !== 'object' || visited.has(value)) return;
          const prototype = Object.getPrototypeOf(value);
          if (!Array.isArray(value) && prototype !== null &&
              (Object.getPrototypeOf(prototype) !== null || prototype.constructor?.name !== 'Object'))
            throw new TypeError('execution_result_must_be_data');
          visited.add(value);
          for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new TypeError('execution_result_must_be_data');
            freeze(descriptor.value);
          }
          Object.freeze(value);
        };
        freeze(result); sealedResults.add(result); return result;
      };
      const guard = Object.freeze({ isCurrent: () => entry.lifetime === lifetime, sealResult });
      running = operation;
      operation.promise = Promise.resolve().then(async () => {
        try {
          if (!guard.isCurrent()) return blocked('owner_view_changed');
          const result = await entry.adapter.apply(entry.proof, guard);
          // A physical adapter may retain its exact immutable execution result
          // after view invalidation. Public result-shaped flags confer no proof,
          // and sealing never upgrades an uncertain or blocked outcome.
          const preserved = physical || options.cacheOnly === true ? sealedResults.has(result)
            : result?.committed === true || result?.writeIssued === false || result?.status === 'uncertain';
          return guard.isCurrent() || preserved ? result : Object.freeze({ ok: false, status: 'uncertain', reason: 'verification_incomplete' });
        } catch (_) { return Object.freeze({ ok: false, status: 'uncertain', reason: 'verification_incomplete' }); }
        finally { if (running === operation) running = null; }
      });
      return operation.promise;
    };
    const clear = () => {
      lifetime += 1; previews.clear(); requests.clear();
      for (const adapter of Object.values(adapters)) { try { adapter?.clear?.(); } catch (_) {} }
    };
    return Object.freeze({ inspect, preview, apply, clear, isBusy: () => running !== null });
  };
  // Exact data witnesses for RAM caches only. No accessor is invoked and
  // absent, undefined and null remain distinct. Unsupported/cyclic cache data
  // makes repair unavailable rather than falling back to identity-only checks.
  const readOwnCacheField = (object, key) => {
    if (!object || typeof object !== 'object') throw Error('CACHE_OBJECT_UNAVAILABLE');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) {
      if (key in object) throw Error('CACHE_INHERITED_FIELD_UNSUPPORTED');
      return { exists: false, value: undefined, writable: false, configurable: false };
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw Error('CACHE_ACCESSOR_UNSUPPORTED');
    return { ...descriptor, exists: true };
  };
  const cacheDataFingerprint = input => {
    const visiting = new Set(); let nodes = 0;
    const encode = value => {
      if (++nodes > 100000) throw Error('CACHE_WITNESS_TOO_LARGE');
      if (value === null) return ['null'];
      const type = typeof value;
      if (type === 'undefined') return ['undefined'];
      if (type === 'string' || type === 'boolean') return [type, value];
      if (type === 'number' && Number.isFinite(value)) return ['number', Object.is(value, -0) ? '-0' : String(value)];
      if (type !== 'object' || visiting.has(value)) throw Error('CACHE_DATA_UNSUPPORTED');
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== null) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
        if (Object.getPrototypeOf(prototype) !== null || !constructor || !Object.prototype.hasOwnProperty.call(constructor, 'value')
            || typeof constructor.value !== 'function' || Object.getOwnPropertyDescriptor(constructor.value, 'name')?.value !== 'Object') throw Error('CACHE_PROTOTYPE_UNSUPPORTED');
      }
      visiting.add(value);
      const entries = Reflect.ownKeys(value).map(key => {
        if (typeof key !== 'string') throw Error('CACHE_SYMBOL_UNSUPPORTED');
        const descriptor = readOwnCacheField(value, key);
        return [key, descriptor.enumerable === true, descriptor.configurable === true, descriptor.writable === true, encode(descriptor.value)];
      });
      visiting.delete(value);
      return [Array.isArray(value) ? 'array' : prototype === null ? 'null_object' : 'object', entries];
    };
    return JSON.stringify(encode(input));
  };
  // Bounded local-only adapters. A cache permit is never authority to invoke
  // an analyzer, restore storage, hand off a chat, or repair another owner.
  const localOwnerAdapter = (options = {}) => {
    const owner = options.owner;
    if (!['LIA', 'RETRACE'].includes(owner)) throw Error('LOCAL_HEALTH_OWNER_UNSUPPORTED');
    if (typeof options.snapshot !== 'function') throw Error('LOCAL_HEALTH_CONTRACT_MISSING');
    let epoch = 0, mutations = 0, router;
    const effects = (derivedCache, changedFields = 0) => Object.freeze({ modelCalls: 0, canonicalWrites: 0, physicalWrites: 0, derivedCache, changedFields });
    const result = (status, reason, effect = 'not_started', changedFields = 0) => Object.freeze({
      ok: status === 'cache_invalidated' || status === 'cache_unchanged', status, reason, owner, sourceCurrentness: 'unknown',
      writeIssued: effect !== 'not_started' && effect !== 'unchanged', effects: effects(effect, changedFields) });
    const externalBusy = () => mutations > 0 || options.isBusy?.() === true;
    const alive = () => options.isAlive?.() !== false;
    const assertSnapshot = value => {
      if (!value || value.valid !== true || value.mode !== 'plugin_only'
          || typeof value.scopeKey !== 'string' || !value.scopeKey
          || typeof value.binding !== 'string' || !value.binding
          || typeof value.assertCurrent !== 'function' || typeof value.withFreshContext !== 'function') throw Error('owner_snapshot_unavailable');
      value.assertCurrent();
    };
    const sample = async started => {
      if (!alive() || externalBusy() || started !== epoch) throw Error('owner_busy_or_changed');
      const before = await options.snapshot(); assertSnapshot(before);
      const after = await options.snapshot(); assertSnapshot(after);
      if (!alive() || externalBusy() || started !== epoch || before.binding !== after.binding || before.scopeKey !== after.scopeKey)
        throw Error('owner_busy_or_changed');
      before.assertCurrent(); after.assertCurrent();
      return after;
    };
    const inspect = async () => {
      const started = epoch;
      try { await sample(started); return Object.freeze({ ...report({ owner, known: true, complete: false,
        issues: [{ code: 'DEEP_CHECK_NOT_RUN', count: 1 }] }), sourceCurrentness: 'unknown', repairScope: 'captured_ram_cache' }); }
      catch (_) { return Object.freeze({ ...report({ owner, known: false, complete: false,
        issues: [{ code: 'OWNER_METADATA_UNVERIFIED', count: 1 }] }), sourceCurrentness: 'unknown', repairScope: 'captured_ram_cache' }); }
    };
    router = createOrchestrator({ inspect, owner, oneUseDerivedCache: true, cacheOnly: true,
      derivedCache: {
        preview: async () => {
          const started = epoch;
          try {
            const snapshot = await sample(started);
            let cache;
            try {
              cache = typeof options.captureCache === 'function' ? options.captureCache(snapshot.scopeKey) : null;
              if (!cache || !['matches', 'invalidate', 'verify'].every(key => typeof cache[key] === 'function') || cache.matches() !== true)
                return { allowed: false, reason: 'cache_witness_unavailable' };
            } catch (_) { return { allowed: false, reason: 'cache_witness_unavailable' }; }
            return { allowed: true, owner, scopeKey: snapshot.scopeKey, model: false,
              warning: 'Only the exact captured RAM cache is invalidated. Source consistency is not certified. Restore and reanalysis use their existing explicit workflows.',
              epoch: started, binding: snapshot.binding, snapshot, cache };
          } catch (_) { return { allowed: false, reason: 'owner_busy_or_changed' }; }
        },
        apply: async (proof, guard) => {
          let issued = false, finished = null, pending = null;
          const finish = (...args) => guard.sealResult(result(...args));
          try {
            const current = await sample(proof.epoch);
            if (!guard.isCurrent() || current.binding !== proof.binding || current.scopeKey !== proof.scopeKey)
              return finish('blocked', 'owner_view_changed');
            // Host reads only detect observed drift. They cannot certify atomic
            // cross-process source consistency. Authority here is the private
            // exact RAM witness, compared and consumed in one synchronous turn.
            await current.withFreshContext(() => {
              proof.snapshot.assertCurrent(); current.assertCurrent();
              if (issued || !alive() || externalBusy() || proof.epoch !== epoch || !guard.isCurrent()) throw Error('owner_view_changed');
              if (proof.cache.matches() !== true) throw Error('captured_cache_changed');
              issued = true;
              const changed = proof.cache.invalidate();
              if (changed && typeof changed.then === 'function') { pending = changed; return; }
              if (changed?.complete === false) { finished = finish('partial', 'captured_cache_partially_invalidated', 'partial'); return; }
              if (proof.cache.verify() !== true) { finished = finish('uncertain', 'cache_invalidation_unconfirmed', 'unknown'); return; }
              const count = changed?.changedFields;
              if (!Number.isInteger(count) || count < 0) throw Error('cache_effect_receipt_missing');
              // Seal the exact effect before returning across any promise or
              // lifecycle boundary. Later close/unload cannot erase this fact.
              finished = count > 0 ? finish('cache_invalidated', 'captured_cache_invalidated', 'invalidated', count)
                : finish('cache_unchanged', 'captured_cache_already_empty', 'unchanged', 0);
            });
            if (pending) {
              try { await pending; } catch (_) {}
              return finish('uncertain', 'async_cache_invalidation_unsupported', 'unknown');
            }
            if (!finished) throw Error('owner_final_witness_missing');
            return finished;
          } catch (error) {
            return finish(issued ? 'uncertain' : 'blocked', issued ? 'cache_invalidation_unconfirmed'
              : error?.message === 'captured_cache_changed' ? 'captured_cache_changed' : 'owner_busy_or_changed', issued ? 'unknown' : 'not_started');
          }
        }
      }
    });
    const clear = () => { epoch += 1; router.clear(); };
    const enterMutation = () => {
      if (router.isBusy()) throw Error('HEALTH_OPERATION_IN_PROGRESS');
      // Ordinary owner operations retain their own locking and return values.
      // This counter only excludes a simultaneous health cache clear; nested
      // owner operations and unrelated owner workflows remain admissible.
      clear(); mutations += 1;
      let released = false;
      return () => { if (!released) { released = true; mutations -= 1; } };
    };
    const withMutation = task => {
      let release; try { release = enterMutation(); } catch (error) { return Promise.reject(error); }
      return Promise.resolve().then(task).finally(release);
    };
    const repair = ticket => {
      const work = router.apply(ticket);
      // Orchestrator-level rejection has not dispatched the adapter.
      // Reuse its exact promise for duplicate in-flight calls.
      return work;
    };
    return Object.freeze({ inspect: () => router.inspect(),
      preview: (action = 'refresh_derived_cache') => action === 'refresh_derived_cache' ? router.preview(action)
        : Promise.resolve(Object.freeze({ allowed: false, owner, reason: 'owner_action_required' })),
      repair, clear, withMutation, enterMutation, isBusy: () => router.isBusy() });
  };
  return Object.freeze({ report, create, ownerAdapter, createOrchestrator, localOwnerAdapter, readOwnCacheField, cacheDataFingerprint });
})();
/* END MEMORY SUITE HEALTH RECOVERY */
