'use strict';
// Dependency-injected and embeddable: no storage, provider, clock or global runtime.
module.exports = function createMemoryNetwork({ hash: legacyHash, tokenize, adapters = {} } = {}) {
  const hash = adapters.hash || legacyHash;
  if (typeof hash !== 'function') throw new TypeError('LIBRA_NETWORK_HASH_REQUIRED');
  const array = value => Array.isArray(value) ? value : [];
  const text = value => String(value ?? '').trim();
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value ?? null;
  };
  const serialize = value => JSON.stringify(stable(value));
  const digest = value => hash(serialize(value));
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const copy = value => JSON.parse(serialize(value));
  const tokens = value => Array.from(new Set(typeof tokenize === 'function'
    ? tokenize(text(value)) : text(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []));
  const normalizeFrame = value => {
    const frame = value || {};
    const authorityEpoch = Number(frame.authorityEpoch);
    if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0) throw new TypeError('LIBRA_NETWORK_AUTHORITY_EPOCH_REQUIRED');
    if (!text(frame.owner) || !text(frame.scopeKey) || !text(frame.worldlineId)) throw new TypeError('LIBRA_NETWORK_FRAME_REQUIRED');
    return freeze({ owner: text(frame.owner), scopeKey: text(frame.scopeKey), worldlineId: text(frame.worldlineId),
      asOf: copy(frame.asOf ?? null), authorityEpoch, activeSourceMapping: text(frame.activeSourceMapping) });
  };
  const projectCanonical = ({ memory, source = {}, frame: inputFrame } = {}) => {
    if (!memory || typeof memory !== 'object') throw new TypeError('LIBRA_NETWORK_CANONICAL_REQUIRED');
    const frame = normalizeFrame(inputFrame);
    const rendered = text(memory.text || memory.summary);
    const completeSource = ['ownerNamespace', 'originScope', 'objectUUID', 'birthIncarnation'].every(key => text(source[key]));
    // Source hash is binding, never a stable source object identifier. Surface
    // message IDs and producer tempFactIds also cannot establish an incarnation.
    const sourceIdentity = completeSource
      ? ['source-object', ...['ownerNamespace', 'originScope', 'objectUUID', 'birthIncarnation'].map(key => text(source[key]))]
      : ['legacy-source', frame.owner, frame.scopeKey, text(source.recordKey), text(memory.memoryId), source.revision ?? memory.revision ?? null,
          source.analysisRevision ?? null, text(source.sourceDigest), digest(memory)];
    const sourceId = 'source:' + digest(sourceIdentity);
    const rawClaims = array(memory.claims).length ? memory.claims : array(memory.canonicalArtifact?.facts);
    const descriptors = rawClaims.map(claim => {
      const anchors = Array.from(new Set(array(claim.sourceAnchors).map(text).filter(Boolean))).sort();
      const semantic = { actorId: text(claim.actorId), targetId: text(claim.targetId), predicate: text(claim.predicate),
        direction: text(claim.direction), value: claim.value ?? null, polarity: text(claim.polarity), time: claim.time ?? null,
        certainty: text(claim.certainty), sourceAnchors: anchors };
      const complete = completeSource && semantic.actorId && semantic.predicate && semantic.direction && semantic.polarity
        && claim.value !== undefined && claim.time !== undefined && semantic.certainty && anchors.length;
      return { claim, semantic, complete: !!complete, key: digest(semantic) };
    });
    const counts = new Map();
    for (const item of descriptors) counts.set(item.key, (counts.get(item.key) || 0) + 1);
    const claims = descriptors.map(({ claim, semantic, complete, key }, index) => {
      const proven = complete && counts.get(key) === 1;
      return { claimId: 'claim:' + digest(proven ? [sourceId, semantic] : [sourceId, 'legacy-claim', source.revision ?? memory.revision ?? null,
        source.analysisRevision ?? null, index, claim]), identityCoverage: proven ? 'complete' : 'partial', semantic: copy(semantic) };
    });
    const identityCoverage = completeSource && claims.length && claims.every(c => c.identityCoverage === 'complete') ? 'complete' : 'partial';
    const semanticDigest = digest(claims.map(c => c.semantic));
    const projectionVersion = 'libra.canonical-network.v1';
    const textHash = hash(rendered), embeddingSpace = text(source.embeddingSpace || memory.embedding?.profileId);
    const bindingFields = { frame, sourceRevision: source.revision ?? memory.revision ?? null, analysisRevision: source.analysisRevision ?? null,
      recordKey: text(source.recordKey), sourceDigest: text(source.sourceDigest), physicalDigest: text(source.physicalDigest),
      semanticDigest, textHash, projectionVersion, embeddingSpace };
    const binding = { ...bindingFields, bindingId: 'binding:' + digest(bindingFields) };
    const nodeId = 'canonical:' + digest([sourceId, claims.map(c => c.claimId)]);
    const entityKeys = descriptors.flatMap(({ claim, semantic }) => [semantic.actorId, semantic.targetId,
      ...array(claim.entityIds), ...[claim.subjectTempRef, claim.targetTempRef].filter(Boolean).map(id => `${sourceId}:legacy-entity:${id}`)]).filter(Boolean);
    const predicateKeys = descriptors.map(({ claim, semantic }) => semantic.predicate || text(claim.claimKind)).filter(Boolean);
    const timeKeys = descriptors.flatMap(({ claim, semantic }) => [semantic.time?.turn, semantic.time?.start, semantic.time?.end,
      claim.turn, ...array(claim.evidenceSpans).map(span => /^t(\d+)-/.exec(text(span.ref))?.[1])]).filter(v => v != null).map(text);
    for (const turn of [memory.turnRange?.start, memory.turnRange?.end]) if (turn != null) timeKeys.push(text(turn));
    return freeze({ schema: projectionVersion, nodeId, sourceId, claims, identityCoverage, binding,
      representationId: 'representation:' + digest([nodeId, textHash, projectionVersion, embeddingSpace]),
      postings: { token: tokens([rendered, ...array(memory.recallKeys), ...rawClaims.map(c => c.text)].join(' ')),
        entity: [...new Set(entityKeys)], predicate: [...new Set(predicateKeys)], time: [...new Set(timeKeys)] } });
  };
  const createRegistry = ({ frame: inputFrame } = {}) => {
    let frame = normalizeFrame(inputFrame);
    const candidates = new Map(), leases = new WeakMap(), accessLists = new WeakMap();
    const postings = Object.fromEntries(['token', 'entity', 'predicate', 'time'].map(kind => [kind, new Map()]));
    const costs = { projections: 0, upserts: 0, merges: 0, postingAdds: 0, discoveries: 0, invalidations: 0 };
    const sameFrame = value => serialize(frame) === serialize(value);
    const remove = id => {
      const candidate = candidates.get(id); if (!candidate) return;
      for (const [kind, keys] of Object.entries(candidate.projection.postings)) for (const key of keys) {
        const set = postings[kind].get(key); set?.delete(id); if (!set?.size) postings[kind].delete(key);
      }
      candidates.delete(id);
    };
    const upsert = (projection, row, access = { kind: 'canonical', score: 0 }) => {
      if (!projection || projection.schema !== 'libra.canonical-network.v1' || !sameFrame(projection.binding.frame)) throw new TypeError('LIBRA_NETWORK_BINDING_FRAME_MISMATCH');
      costs.upserts++;
      let candidate = candidates.get(projection.nodeId);
      // Replace a changed physical binding; the old lease is no longer current.
      if (candidate && candidate.projection.binding.bindingId !== projection.binding.bindingId) { remove(projection.nodeId); candidate = null; }
      if (!candidate) {
        candidate = Object.freeze({ id: projection.nodeId, projection, row, pathBonus: 0,
          get accesses() { return freeze(copy(accessLists.get(candidate))); } });
        accessLists.set(candidate, []);
        candidates.set(candidate.id, candidate); costs.projections++;
        for (const [kind, keys] of Object.entries(projection.postings)) for (const key of keys) {
          let set = postings[kind].get(key); if (!set) postings[kind].set(key, set = new Set()); set.add(candidate.id); costs.postingAdds++;
        }
      } else costs.merges++;
      const kind = text(access.kind || 'canonical'), score = Number.isFinite(access.score) ? access.score : 0;
      const accesses = accessLists.get(candidate);
      const previous = accesses.find(item => item.kind === kind);
      if (previous) previous.score = Math.max(previous.score, score);
      else accesses.push({ kind, score });
      return candidate;
    };
    const invalidate = ({ sourceIds = [], frame: nextFrame } = {}) => {
      if (nextFrame) {
        const normalized = normalizeFrame(nextFrame);
        if (normalized.authorityEpoch < frame.authorityEpoch) throw new TypeError('LIBRA_NETWORK_AUTHORITY_EPOCH_REWIND');
        if (!sameFrame(normalized)) { for (const id of [...candidates.keys()]) remove(id); frame = normalized; }
      }
      const ids = new Set(sourceIds);
      for (const candidate of [...candidates.values()]) if (ids.has(candidate.projection.sourceId)) remove(candidate.id);
      costs.invalidations++;
    };
    const discoverCandidates = ({ tokens: tokenKeys = [], entities = [], predicates = [], times = [], semanticIds = [] } = {}) => {
      const selected = new Set(semanticIds); costs.discoveries++;
      for (const [kind, keys] of [['token', tokenKeys], ['entity', entities], ['predicate', predicates], ['time', times]]) {
        for (const key of keys) for (const id of postings[kind].get(text(key)) || []) selected.add(id);
      }
      // Existing canonical row order remains the tie policy in the A1 adapter.
      return [...candidates.values()].filter(candidate => selected.has(candidate.id));
    };
    const capture = id => {
      const candidate = candidates.get(id); if (!candidate) return null;
      const lease = freeze({ id, bindingId: candidate.projection.binding.bindingId, frame: copy(frame) });
      leases.set(lease, candidate); return lease;
    };
    const isCurrent = lease => {
      const candidate = candidates.get(lease?.id);
      return !!candidate && leases.get(lease) === candidate && sameFrame(lease.frame)
        && lease.bindingId === candidate.projection.binding.bindingId;
    };
    return Object.freeze({ upsert, invalidate, discoverCandidates, capture, isCurrent,
      rows: () => [...candidates.values()].map(candidate => candidate.row),
      diagnostics: () => ({ schema: 'libra.canonical-network-diagnostics.v1', canonicalCandidates: candidates.size,
        identityCoverage: candidates.size && [...candidates.values()].every(c => c.projection.identityCoverage === 'complete') ? 'complete' : 'partial',
        pathBonus: 0, costs: { ...costs } }) });
  };
  // Approved A1 facade. Units contain projection metadata only; original row
  // references remain private and are handed to the unchanged runtime scorer.
  const rowsByUnit = new WeakMap();
  let activeRegistry = null, activeFrame = null;
  const project = input => {
    const unit = projectCanonical(input);
    const row = input?.row || (typeof adapters.rowForUnit === 'function' ? adapters.rowForUnit(unit, input) : null);
    if (row) rowsByUnit.set(unit, row);
    return Object.freeze([unit]);
  };
  const upsert = (units, binding = {}) => {
    if (!activeRegistry) {
      activeFrame = normalizeFrame(binding.frame);
      activeRegistry = createRegistry({ frame: activeFrame });
    }
    let indexed = 0;
    for (const unit of units) {
      if (binding.frame && serialize(normalizeFrame(binding.frame)) !== serialize(activeFrame)) throw new TypeError('LIBRA_NETWORK_BINDING_FRAME_MISMATCH');
      const row = rowsByUnit.get(unit) || binding.row;
      if (!row) throw new TypeError('LIBRA_NETWORK_RUNTIME_ROW_REQUIRED');
      activeRegistry.upsert(unit, row, binding.access); indexed++;
    }
    const diagnostic = activeRegistry.diagnostics();
    return Object.freeze({ schema: 'libra.canonical-network-coverage.v1', indexed, canonicalCandidates: diagnostic.canonicalCandidates,
      identityCoverage: diagnostic.identityCoverage, status: diagnostic.identityCoverage === 'complete' ? 'complete' : 'partial' });
  };
  const invalidate = (refs = [], liveEpoch) => {
    if (!activeRegistry) return;
    const frame = typeof liveEpoch === 'object' ? normalizeFrame(liveEpoch)
      : normalizeFrame({ ...activeFrame, authorityEpoch: liveEpoch ?? activeFrame.authorityEpoch });
    activeRegistry.invalidate({ sourceIds: refs.map(ref => typeof ref === 'string' ? ref : ref.sourceId), frame });
    activeFrame = frame;
  };
  const discover = (accessResults = [], registry = activeRegistry) => {
    if (!registry) return [];
    if (!Array.isArray(accessResults)) return registry.discoverCandidates(accessResults);
    const accesses = accessResults.filter(access => text(access?.unitId));
    const found = registry.discoverCandidates({ semanticIds: accesses.map(access => access.unitId) });
    for (const candidate of found) for (const access of accesses) if (access.unitId === candidate.id) {
      registry.upsert(candidate.projection, candidate.row, { kind: access.kind, score: access.score });
    }
    return found;
  };
  return Object.freeze({ project, upsert, invalidate, discover, projectCanonical, createRegistry,
    diagnostics: () => activeRegistry?.diagnostics() || { schema: 'libra.canonical-network-diagnostics.v1', canonicalCandidates: 0,
      identityCoverage: 'partial', pathBonus: 0, costs: {} } });
};
