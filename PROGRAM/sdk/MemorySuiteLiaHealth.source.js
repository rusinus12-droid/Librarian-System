/* MEMORY SUITE LIA HEALTH ADAPTER v1.0.0 */
const createMemorySuiteLiaHealthAdapter = options => {
  const parse = raw => raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const snapshot = async () => {
    const authority = options.storage.captureReadOnlyAuthorityFence();
    const context = await options.readContext(), scope = options.scopeFor(context);
    if (!scope?.scopeKey || !scope.scopeId || !context.character || !context.chat || !context.profile) throw Error('LIA_HEALTH_CONTEXT_UNVERIFIED');
    const row = await options.storage.inspectLocalHealthSnapshot(scope, options.proofKey, { strictPhysical: true });
    if (row.mode !== 'plugin_only') throw Error('LIA_HEALTH_AUTHORITY_CHANGED');
    const proof = parse(row.raw);
    const valid = proof == null || (object(proof) && (proof.proofs == null || object(proof.proofs)));
    authority.assertCurrent();
    return { valid, mode: row.mode, scopeKey: scope.scopeKey, assertCurrent: authority.assertCurrent,
      withFreshContext: publish => options.readContext(current => {
        if (JSON.stringify(current) !== JSON.stringify(context)) throw Error('LIA_HEALTH_HOST_CHANGED');
        authority.assertCurrent();
        // The host reader calls us immediately after its final observed host
        // witness. No metadata read or awaited work may precede publication.
        return publish();
      }),
      binding: JSON.stringify([scope.scopeId, context, [row.binding, row.mode, row.raw]]) };
  };
  return MemorySuiteHealthRecovery.localOwnerAdapter({ owner: 'LIA', snapshot,
    isBusy: options.isBusy, isAlive: options.isAlive });
};
/* END MEMORY SUITE LIA HEALTH ADAPTER */
