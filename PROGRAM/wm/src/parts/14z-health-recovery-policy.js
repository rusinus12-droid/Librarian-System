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
    return Object.freeze({ schema: 'memory-suite.health.v1', owner: ['WM','LIBRA','HAYAKU','FLASHBACK'].includes(input.owner) ? input.owner : 'UNKNOWN',
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
    const adapters = { refresh_derived_cache: options.derivedCache, explicit_reanalysis: options.reanalysis };
    const previews = new Map(), requests = new Map();
    let lifetime = 0, running = null;
    const blocked = reason => Object.freeze({ ok: false, status: 'blocked', reason });
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
        const units = Object.freeze((Array.isArray(proof.units) ? proof.units : []).map(unit => Object.freeze({
          key: String(unit.key || ''), start: Number(unit.start || 0), end: Number(unit.end || 0), label: String(unit.label || '')
        })));
        const ticket = Object.freeze({ allowed: true, actionKind, owner: String(proof.owner || ''),
          scopeKey: String(proof.scopeKey || ''), units, warning: String(proof.warning || ''),
          model: actionKind === 'explicit_reanalysis' && proof.model !== false });
        previews.set(actionKind, { ticket, proof, adapter, lifetime: started });
        return ticket;
      } catch (_) { return Object.freeze({ allowed: false, reason: 'preview_unavailable' }); }
    };
    const apply = ticket => {
      if (running?.ticket === ticket) return running.promise;
      const entry = previews.get(ticket?.actionKind);
      if (!entry || entry.ticket !== ticket || entry.lifetime !== lifetime) return Promise.resolve(blocked('stale_or_unknown_ticket'));
      if (running) return Promise.resolve(blocked('operation_in_progress'));
      if (ticket.actionKind === 'explicit_reanalysis') previews.delete(ticket.actionKind);
      const operation = { ticket, promise: null }, guard = Object.freeze({ isCurrent: () => entry.lifetime === lifetime });
      running = operation;
      operation.promise = Promise.resolve().then(async () => {
        try {
          if (!guard.isCurrent()) return blocked('owner_view_changed');
          const result = await entry.adapter.apply(entry.proof, guard);
          return guard.isCurrent() || result?.committed === true || result?.writeIssued === false || result?.status === 'uncertain' ? result : Object.freeze({ ok: false, status: 'uncertain', reason: 'verification_incomplete' });
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
  return Object.freeze({ report, create, ownerAdapter, createOrchestrator });
})();
/* END MEMORY SUITE HEALTH RECOVERY */

