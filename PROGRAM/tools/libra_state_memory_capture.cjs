'use strict';
module.exports = function createLibraStateMemoryCapture(native, engine) {
  return async (options, guard) => {
    const context = await native.context(options), scope = context.scope;
    if (options.expectedScopeKey && options.expectedScopeKey !== scope.scopeKey) throw Error('LIBRA_STATE_SCOPE_CHANGED');
    const check = () => native.check(scope, guard);
    let snapshot;
    try { snapshot = await native.snapshot(context, options); check(); }
    catch (error) { native.abandon?.(context); throw error; }
    const entities = engine.entityTable(snapshot.head);
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
        id: 'lens:' + native.fingerprint([value.key, row.lensItem?.itemId || n]), family: 'lens', sourceKey: value.key,
        // A note is filed under what it is about, so lens notes no longer all land on one axis.
        axis: row.domain ? engine.axisFor(row.domain)
          : engine.classifyAxis(row.lensItem?.text || row.text, { people: row.lensItem?.people, entities }) })) };
    } : null;
    return { scope, manifest, head, refs, turns, worldlineId, identity, owner, stateKey, settings,
      stateAuthority: snapshot.stateAuthority, check, canonical, micro, lens,
      microIndex: typeof native.microIndex === 'function' ? async () => { const value = await native.microIndex(context, snapshot); check(); return value; } : null,
      settle: typeof native.settle === 'function' ? () => native.settle(context) : null,
      abandon: typeof native.abandon === 'function' ? () => native.abandon(context) : null,
      register: sources => native.register(scope, sources.flatMap(source => source.proofs), snapshot),
      assertCurrent: async token => { check(); await native.assertCurrent(token, context, snapshot); check(); },
      release: native.release };
  };
};
