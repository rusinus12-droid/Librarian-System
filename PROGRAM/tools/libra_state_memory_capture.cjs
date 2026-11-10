'use strict';
module.exports = function createLibraStateMemoryCapture(native, engine) {
  return async (options, guard) => {
    const context = await native.context(), scope = context.scope;
    if (options.expectedScopeKey && options.expectedScopeKey !== scope.scopeKey) throw Error('LIBRA_STATE_SCOPE_CHANGED');
    const check = () => native.check(scope, guard);
    const snapshot = await native.snapshot(context, options); check();
    const { manifest, head, refs, turns, worldlineId, identity, owner, stateKey, settings } = snapshot;
    const canonical = async ref => {
      const value = await native.canonical(context, ref, snapshot); check();
      return { key: ref.key, proofs: value.proofs, rows: value.rows.map((row, n) => ({ ...row,
        id: 'canonical:' + native.fingerprint([ref.key, ref.revision, n]), family: 'canonical', axis: engine.axisFor(row.domain),
        sourceKey: ref.key, turn: Number(ref.turnRange?.end || 0) })) };
    };
    const micro = async turn => {
      const value = await native.micro(context, snapshot, turn); check();
      if (!value) return null;
      return { key: value.key, proofs: value.proofs, rows: value.rows.map((row, n) => ({ ...row,
        id: 'micro:' + native.fingerprint([value.key, n]), family: 'micro', axis: engine.axisFor(row.domain), sourceKey: value.key, turn })) };
    };
    const lens = typeof native.lens === 'function' ? async (query, maxCharacters) => {
      const value = await native.lens(context, snapshot, query, maxCharacters); check();
      return { ...value, rows: (value.rows || []).map((row, n) => ({ ...row,
        id: 'lens:' + native.fingerprint([value.key, row.lensItem?.itemId || n]), family: 'lens', axis: engine.axisFor(row.domain), sourceKey: value.key })) };
    } : null;
    return { scope, manifest, head, refs, turns, worldlineId, identity, owner, stateKey, settings,
      stateAuthority: snapshot.stateAuthority, check, canonical, micro, lens,
      register: sources => native.register(scope, sources.flatMap(source => source.proofs), snapshot),
      assertCurrent: async token => { check(); await native.assertCurrent(token, context, snapshot); check(); },
      release: native.release };
  };
};
