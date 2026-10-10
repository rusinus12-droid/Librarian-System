/* MEMORY SUITE RETRACE HEALTH ADAPTER v1.0.0 */
const createMemorySuiteRetraceHealthAdapter = options => {
  const snapshot = async () => {
    const authority = options.storage.captureReadOnlyAuthorityFence();
    const context = await options.readContext(), scope = options.scopeFor(context);
    if (!scope?.scopeKey || !scope.scopeId || !context.character || !context.chat || !context.profile) throw Error('RETRACE_HEALTH_CONTEXT_UNVERIFIED');
    const keys = options.keysFor(scope.scopeKey), rows = [];
    if (!Array.isArray(keys) || !keys.length) throw Error('RETRACE_HEALTH_INVENTORY_UNVERIFIED');
    for (const item of keys) {
      const row = await options.storage.inspectLocalHealthSnapshot(scope, item.key, { strictPhysical: true });
      if (row.mode !== 'plugin_only' || (rows.length && row.binding !== rows[0].binding)) throw Error('RETRACE_HEALTH_AUTHORITY_CHANGED');
      const value = row.raw == null ? null : typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
      if (value != null && (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== item.schema
          || (value.scopeKey != null && value.scopeKey !== scope.scopeKey))) throw Error('RETRACE_HEALTH_METADATA_UNVERIFIED');
      rows.push(row);
    }
    const journal = options.validateJournal(context.chat);
    if (context.chat.memorySessionBridge && journal?.available !== true) throw Error('RETRACE_HEALTH_JOURNAL_UNVERIFIED');
    authority.assertCurrent();
    return { valid: true, mode: rows[0].mode, scopeKey: scope.scopeKey, assertCurrent: authority.assertCurrent,
      withFreshContext: publish => options.readContext(current => {
        if (JSON.stringify(current) !== JSON.stringify(context)) throw Error('RETRACE_HEALTH_HOST_CHANGED');
        authority.assertCurrent();
        // The host reader calls us immediately after its final observed host
        // witness. No metadata read or awaited work may precede publication.
        return publish();
      }),
      binding: JSON.stringify([scope.scopeId, context, rows.map(row => [row.binding, row.mode, row.raw])]) };
  };
  const captureCache = () => {
    const target = options.cache;
    if (!target || typeof target !== 'object') return null;
    const fields = ['lastPreview','compatibilitySuite','compatibilityCheckedAt','compatibilityAcknowledgedAt'];
    const empty = [null, null, 0, 0];
    const read = () => fields.map((key, index) => {
      const field = MemorySuiteHealthRecovery.readOwnCacheField(target, key);
      if (!field.exists || (!Object.is(field.value, empty[index]) && field.writable !== true)) throw Error('RETRACE_CACHE_FIELD_UNVERIFIED');
      return field;
    });
    const captured = read(), fingerprint = MemorySuiteHealthRecovery.cacheDataFingerprint(captured);
    return Object.freeze({
      matches: () => {
        const current = read();
        return options.cache === target && current.every((field, index) => Object.is(field.value, captured[index].value))
          && MemorySuiteHealthRecovery.cacheDataFingerprint(current) === fingerprint;
      },
      invalidate: () => {
        let changedFields = 0;
        fields.forEach((key, index) => {
          if (!Object.is(captured[index].value, empty[index])) { target[key] = empty[index]; changedFields += 1; }
        });
        return { changedFields };
      },
      verify: () => options.cache === target && read().every((field, index) => Object.is(field.value, empty[index]))
    });
  };
  return MemorySuiteHealthRecovery.localOwnerAdapter({ owner: 'RETRACE', snapshot, captureCache,
    isBusy: options.isBusy, isAlive: options.isAlive });
};
/* END MEMORY SUITE RETRACE HEALTH ADAPTER */
