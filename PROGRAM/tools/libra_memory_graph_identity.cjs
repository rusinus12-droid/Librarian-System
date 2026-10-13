'use strict';

// UM1 normalized identity kernel. No storage, provider, ranking or physical-proof authority.
// Owner adapters must validate source inputs before issuing these descriptive handles.
module.exports = function createMemoryGraphIdentity({ fingerprint } = {}) {
  if (typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_FINGERPRINT_REQUIRED');
  const schema = 'libra.memory_graph_identity.v1';
  const labels = new Map(), bindings = new Map();
  let issued = new WeakMap();
  const fail = reason => { throw new TypeError('LIBRA_GRAPH_' + reason); };
  const id = value => typeof value === 'string' && value.trim().length ? value : fail('IDENTIFIER_REQUIRED');
  const copy = (value, path = new Set()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail('JSON_NUMBER_INVALID');
      return value;
    }
    if (!value || typeof value !== 'object') fail('JSON_DATA_REQUIRED');
    if (path.has(value)) fail('JSON_CYCLE');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) fail('JSON_DATA_REQUIRED');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || (array && key === 'length' ? false
      : !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')))) fail('JSON_DATA_REQUIRED');
    path.add(value);
    let result;
    if (array) {
      if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) fail('JSON_ARRAY_INVALID');
      result = Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(descriptors, String(index))) fail('JSON_ARRAY_INVALID');
        return copy(descriptors[index].value, path);
      });
    } else result = Object.fromEntries(keys.sort().map(key => [key, copy(descriptors[key].value, path)]));
    path.delete(value);
    return result;
  };
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const fields = (value, required, optional = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('FIELDS_INVALID');
    return value;
  };
  const epoch = value => Number.isSafeInteger(value) && value >= 0 ? value : fail('EPOCH_INVALID');
  const objectIdentity = input => {
    const value = copy(input);
    const common = ['kind', 'ownerNamespace', 'originScope'];
    if (value?.kind === 'stable') {
      fields(value, [...common, 'objectUUID', 'birthIncarnation']);
      for (const key of [...common, 'objectUUID', 'birthIncarnation']) id(value[key]);
    } else if (value?.kind === 'revision_bound') {
      fields(value, [...common, 'recordKind', 'recordKey', 'revision', 'restoreEpoch', 'snapshot']);
      for (const key of [...common, 'recordKind', 'recordKey']) id(value[key]);
      if (!['string', 'number'].includes(typeof value.revision) || value.revision === '') fail('REVISION_REQUIRED');
      epoch(value.restoreEpoch);
    } else fail('OBJECT_IDENTITY_REQUIRED');
    return value;
  };
  const binding = input => {
    const value = copy(input);
    fields(value, ['owner', 'scopeKey', 'worldlineId', 'restoreEpoch', 'revision', 'locator', 'body'], ['view']);
    for (const key of ['owner', 'scopeKey', 'worldlineId']) id(value[key]);
    epoch(value.restoreEpoch);
    if (!['string', 'number'].includes(typeof value.revision) || value.revision === '') fail('REVISION_REQUIRED');
    return copy({ ...value, view: value.view ?? null });
  };
  const frame = value => JSON.stringify([value.owner, value.scopeKey, value.worldlineId, value.restoreEpoch, value.view]);
  const checkRevisionIdentity = (identity, bound) => {
    if (identity.kind === 'revision_bound' && (identity.revision !== bound.revision
      || identity.restoreEpoch !== bound.restoreEpoch || JSON.stringify(identity.snapshot) !== JSON.stringify(bound.body))) fail('REVISION_BINDING_MISMATCH');
  };
  const label = (prefix, exact, table) => {
    const hash = fingerprint(exact);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) fail('FINGERPRINT_INVALID');
    const key = prefix + hash;
    if (table.has(key) && table.get(key) !== exact) fail('IDENTITY_LABEL_COLLISION');
    return key;
  };
  const get = (handle, type) => {
    const record = handle && issued.get(handle);
    if (!record || type && record.type !== type) fail('HANDLE_UNAVAILABLE');
    return record;
  };
  const emit = (type, tuple, value, descriptor, privateState = {}) => {
    const exact = JSON.stringify(tuple), bindingExact = JSON.stringify(value);
    const prefix = type === 'node' ? 'libra.node.v1:' : type === 'basis' ? 'libra.basis.v1:' : 'libra.edge.v1:';
    const key = label(prefix, exact, labels);
    const bindingId = label('libra.binding.v1:', JSON.stringify([key, bindingExact]), bindings);
    // Validate both labels before retaining anything: a failed binding collision is atomic.
    labels.set(key, exact); bindings.set(bindingId, JSON.stringify([key, bindingExact]));
    const handle = freeze({ schema, id: key, bindingId, ...descriptor });
    issued.set(handle, { type, exact, bindingExact, binding: freeze(value), ...privateState });
    return handle;
  };
  const source = ({ identity, binding: input } = {}) => {
    const normalized = objectIdentity(identity), bound = binding(input);
    checkRevisionIdentity(normalized, bound);
    return emit('node', ['source', normalized], bound, { layer: 'source', identityCoverage: normalized.kind },
      { partition: JSON.stringify([normalized.ownerNamespace, normalized.originScope]) });
  };
  const entity = ({ identity, binding: input } = {}) => {
    const normalized = objectIdentity(identity), bound = binding(input);
    checkRevisionIdentity(normalized, bound);
    return emit('node', ['entity', normalized], bound, { layer: 'entity', identityCoverage: normalized.kind });
  };
  const meaningKinds = new Set(['canonical_fact', 'micro_claim', 'source_excerpt', 'state_field', 'state_item', 'lore_passage']);
  const meaning = ({ source: origin, kind, identity, anchor, binding: input } = {}) => {
    const parent = get(origin, 'node');
    if (origin.layer !== 'source') fail('SOURCE_REQUIRED');
    if (!meaningKinds.has(kind)) fail('MEANING_KIND_INVALID');
    const bound = binding(input), unitIdentity = objectIdentity(identity), normalized = copy(anchor);
    checkRevisionIdentity(unitIdentity, bound);
    if (parent.partition !== JSON.stringify([unitIdentity.ownerNamespace, unitIdentity.originScope])) fail('SOURCE_PARTITION_MISMATCH');
    if (!normalized || typeof normalized !== 'object') fail('ANCHOR_REQUIRED');
    if (frame(parent.binding) !== frame(bound)) fail('FRAME_MISMATCH');
    return emit('node', ['meaning', kind, parent.exact, unitIdentity, normalized], [parent.binding, bound], {
      layer: 'meaning', kind, sourceId: origin.id,
      identityCoverage: origin.identityCoverage === 'stable' && unitIdentity.kind === 'stable' ? 'stable' : 'revision_bound'
    });
  };
  const basisKinds = new Set(['canonical_claim', 'source_excerpt', 'micro_span', 'state_field_evidence', 'state_correction', 'lore_passage', 'entity_attachment', 'association']);
  const basis = ({ source: origin, kind, identity, anchor, binding: input } = {}) => {
    const parent = get(origin, 'node');
    if (origin.layer !== 'source') fail('SOURCE_REQUIRED');
    if (!basisKinds.has(kind)) fail('BASIS_KIND_INVALID');
    const normalized = objectIdentity(identity), bound = binding(input), occurrence = copy(anchor);
    checkRevisionIdentity(normalized, bound);
    if (parent.partition !== JSON.stringify([normalized.ownerNamespace, normalized.originScope])) fail('SOURCE_PARTITION_MISMATCH');
    if (!occurrence || typeof occurrence !== 'object') fail('ANCHOR_REQUIRED');
    if (frame(parent.binding) !== frame(bound)) fail('FRAME_MISMATCH');
    return emit('basis', ['basis', kind, parent.exact, normalized, occurrence], [parent.binding, bound], {
      kind, sourceId: origin.id, identityCoverage: origin.identityCoverage === 'stable' && normalized.kind === 'stable' ? 'stable' : 'revision_bound'
    });
  };
  const predicates = new Set(['mentions', 'subject_of', 'target_of', 'evidenced_by', 'derived_from', 'updates', 'clears',
    'supersedes', 'follows', 'fulfills', 'reopens', 'defines', 'applies_to', 'contradicts', 'semantic_affinity']);
  const edge = ({ from, to, predicate, qualifier = {}, validTime = null, basis: reason, binding: input } = {}) => {
    const left = get(from, 'node'), right = get(to, 'node'), evidence = get(reason, 'basis');
    const bound = binding(input);
    if (!predicates.has(predicate)) fail('PREDICATE_INVALID');
    if (reason.kind === 'association' && predicate !== 'semantic_affinity') fail('ASSOCIATION_AUTHORITY');
    // Meaning/basis bindings retain the source and their own current descriptive binding.
    const own = record => Array.isArray(record.binding) ? record.binding[1] : record.binding;
    for (const record of [left, right, evidence]) if (frame(own(record)) !== frame(bound)) fail('FRAME_MISMATCH');
    return emit('edge', ['edge', left.exact, right.exact, id(predicate), copy(qualifier), copy(validTime), evidence.exact],
      [left.binding, right.binding, evidence.binding, bound], {
        from: from.id, to: to.id, predicate, basisId: reason.id,
        identityCoverage: [from, to, reason].every(handle => handle.identityCoverage === 'stable') ? 'stable' : 'revision_bound'
      });
  };
  const sameIdentity = (left, right) => get(left).type === get(right).type && get(left).exact === get(right).exact;
  const sameBinding = (left, right) => sameIdentity(left, right) && get(left).bindingExact === get(right).bindingExact;
  const clear = () => { issued = new WeakMap(); labels.clear(); bindings.clear(); };
  return Object.freeze({ source, entity, meaning, basis, edge, sameIdentity, sameBinding, clear,
    inspect: () => ({ schema, retainedIdentityKeys: labels.size, retainedBindingKeys: bindings.size,
      authority: 'descriptive_only', byteBounded: false, runtimeIntegrated: false }) });
};
