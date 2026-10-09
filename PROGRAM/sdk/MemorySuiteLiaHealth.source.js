/* MEMORY SUITE LIA HEALTH ADAPTER v1.0.0 */
const createMemorySuiteLiaHealthAdapter = options => {
  const parse = raw => raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const snapshot = async () => {
    const authority = options.storage.captureReadOnlyAuthorityFence();
    const context = await options.readContext(), scope = options.scopeFor(context);
    if (!scope?.scopeKey || !scope.scopeId || !context.character || !context.chat || !context.profile) throw Error('LIA_HEALTH_CONTEXT_UNVERIFIED');
    const key = options.keyFor(scope.scopeKey), keys = [options.indexKey, key, options.legacyKey];
    const rows = [];
    for (const item of keys) rows.push(await options.storage.inspectLocalHealthSnapshot(scope, item, { strictPhysical: true }));
    if (rows.some(row => row.mode !== 'plugin_only' || row.binding !== rows[0].binding)) throw Error('LIA_HEALTH_AUTHORITY_CHANGED');
    const index = parse(rows[0].raw), binding = parse(rows[1].raw), legacy = parse(rows[2].raw);
    if (legacy != null) throw Error('LIA_HEALTH_LEGACY_REVIEW_REQUIRED');
    let valid = false;
    if (index == null && binding == null) {
      valid = !String(context.chat.bindedPersona || context.chat.personaId || '').startsWith('lia-live-persona::');
    } else if (object(index) && index.schema === options.indexSchema && object(index.entries)) {
      const entry = index.entries[scope.scopeKey];
      if (!entry && binding == null) valid = !String(context.chat.bindedPersona || context.chat.personaId || '').startsWith('lia-live-persona::');
      else if (object(entry) && object(binding)) {
        const raw = typeof rows[1].raw === 'string' ? rows[1].raw : JSON.stringify(rows[1].raw);
        valid = entry.storageKey === key && entry.digest === options.hash(raw)
          && binding.scopeKey === scope.scopeKey && typeof binding.livePersonaId === 'string' && !!binding.livePersonaId
          && entry.livePersonaId === binding.livePersonaId && Array.isArray(binding.ledgers) && Array.isArray(binding.liveState);
      }
    }
    authority.assertCurrent();
    return { valid, mode: rows[0].mode, scopeKey: scope.scopeKey, assertCurrent: authority.assertCurrent,
      withFreshContext: publish => options.readContext(current => {
        if (JSON.stringify(current) !== JSON.stringify(context)) throw Error('LIA_HEALTH_HOST_CHANGED');
        authority.assertCurrent();
        // The host reader calls us immediately after its final observed host
        // witness. No metadata read or awaited work may precede publication.
        return publish();
      }),
      binding: JSON.stringify([scope.scopeId, context, rows.map(row => [row.binding, row.mode, row.raw])]) };
  };
  const captureCache = scopeKey => {
    const cache = options.cache;
    if (!cache || !['getStore','getComplete','setComplete'].every(key => typeof cache[key] === 'function')) return null;
    const read = () => {
      const store = cache.getStore(), complete = cache.getComplete();
      if (typeof complete !== 'boolean') throw Error('LIA_CACHE_COMPLETENESS_UNVERIFIED');
      let bindings = null, entry = { exists: false, value: undefined };
      if (store != null) {
        const container = MemorySuiteHealthRecovery.readOwnCacheField(store, 'bindings');
        if (!container.exists || !container.value || typeof container.value !== 'object' || Array.isArray(container.value)) throw Error('LIA_CACHE_CONTAINER_UNVERIFIED');
        bindings = container.value;
        entry = MemorySuiteHealthRecovery.readOwnCacheField(bindings, scopeKey);
        if (entry.exists && entry.configurable !== true) throw Error('LIA_CACHE_ENTRY_NOT_REMOVABLE');
      }
      return { store, bindings, entry, complete,
        fingerprint: MemorySuiteHealthRecovery.cacheDataFingerprint([store, complete]) };
    };
    const captured = read();
    return Object.freeze({
      matches: () => {
        const current = read();
        return current.store === captured.store && current.bindings === captured.bindings
          && current.entry.exists === captured.entry.exists && Object.is(current.entry.value, captured.entry.value)
          && current.complete === captured.complete && current.fingerprint === captured.fingerprint;
      },
      invalidate: () => {
        let changedFields = 0;
        if (captured.entry.exists) {
          if (!Reflect.deleteProperty(captured.bindings, scopeKey)) throw Error('LIA_CACHE_ENTRY_INVALIDATION_FAILED');
          changedFields += 1;
        }
        if (captured.complete !== false) { cache.setComplete(false); changedFields += 1; }
        return { changedFields };
      },
      verify: () => {
        const current = read();
        return current.store === captured.store && current.bindings === captured.bindings
          && current.entry.exists === false && current.complete === false;
      }
    });
  };
  return MemorySuiteHealthRecovery.localOwnerAdapter({ owner: 'LIA', snapshot, captureCache,
    isBusy: options.isBusy, isAlive: options.isAlive });
};
/* END MEMORY SUITE LIA HEALTH ADAPTER */
