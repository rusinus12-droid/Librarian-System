'use strict';
// Dependency-injected and embeddable: no storage, provider, clock or global runtime.
module.exports = function createMemoryNetwork({ hash: legacyHash, tokenize, adapters = {} } = {}) {
  const hash = adapters.hash || legacyHash;
  if (typeof hash !== 'function') throw new TypeError('LIBRA_NETWORK_HASH_REQUIRED');
  // Local UTF8/SHA256 adapted from MemorySuiteComputeBridge in LIBRA.js.
  // A synchronous browser factory cannot rely on Node crypto or async SubtleCrypto.
  const utf8Bytes = value => {
    const text = String(value || '');
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
    const bytes = [];
    for (let i = 0; i < text.length; i += 1) {
      let code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i += 1;
        } else code = 0xfffd;
      } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
      if (code <= 0x7f) bytes.push(code);
      else if (code <= 0x7ff) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
      else if (code <= 0xffff) bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
      else bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 0x3f), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return new Uint8Array(bytes);
  };
  const sha256Hex = value => {
    const bytes = utf8Bytes(value);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(paddedLength);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    data[paddedLength - 8] = (high >>> 24) & 0xff;
    data[paddedLength - 7] = (high >>> 16) & 0xff;
    data[paddedLength - 6] = (high >>> 8) & 0xff;
    data[paddedLength - 5] = high & 0xff;
    data[paddedLength - 4] = (low >>> 24) & 0xff;
    data[paddedLength - 3] = (low >>> 16) & 0xff;
    data[paddedLength - 2] = (low >>> 8) & 0xff;
    data[paddedLength - 1] = low & 0xff;
    const constants = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
    let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a;
    let h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;
    const words = new Uint32Array(64);
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) {
        const at = offset + i * 4;
        words[i] = ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
        const s1 = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
        words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
      }
      let a=h0, b=h1, c=h2, d=h3, e=h4, f=h5, g=h6, h=h7;
      for (let i = 0; i < 64; i += 1) {
        const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + choice + constants[i] + words[i]) >>> 0;
        const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + majority) >>> 0;
        h=g; g=f; f=e; e=(d + temp1) >>> 0; d=c; c=b; b=a; a=(temp1 + temp2) >>> 0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
      h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map(word => word.toString(16).padStart(8, '0')).join('');
  };
  const array = value => Array.isArray(value) ? value : [];
  const text = value => String(value ?? '').trim();
  const identifierValue = value => {
    if (value == null) return '';
    if (typeof value !== 'string') throw new TypeError('LIBRA_NETWORK_IDENTIFIER_TYPE');
    return value.trim();
  };
  const revisionValue = value => {
    if (value == null) return null;
    if (typeof value === 'string' || (Number.isSafeInteger(value) && value >= 0)) return value;
    throw new TypeError('LIBRA_NETWORK_REVISION_TYPE');
  };
  const entityIdValue = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('LIBRA_NETWORK_ENTITY_ID_TYPE');
    return value.trim();
  };
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value ?? null;
  };
  const serialize = value => JSON.stringify(stable(value));
  const digest = value => {
    const serialized = serialize(value);
    return text(hash(serialized)) + ':' + sha256Hex(serialized);
  };
  const identityRecords = new WeakMap();
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const copy = value => JSON.parse(serialize(value));
  const tokens = value => {
    const keys = typeof tokenize === 'function' ? tokenize(text(value))
      : text(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
    return Array.from(new Set(Array.from(keys || []).map(identifierValue).filter(Boolean)));
  };
  const normalizeFrame = value => {
    const frame = value || {};
    const authorityEpoch = Number(frame.authorityEpoch);
    if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0) throw new TypeError('LIBRA_NETWORK_AUTHORITY_EPOCH_REQUIRED');
    if (!identifierValue(frame.owner) || !identifierValue(frame.scopeKey) || !identifierValue(frame.worldlineId)) throw new TypeError('LIBRA_NETWORK_FRAME_REQUIRED');
    return freeze({ owner: identifierValue(frame.owner), scopeKey: identifierValue(frame.scopeKey), worldlineId: identifierValue(frame.worldlineId),
      asOf: copy(frame.asOf ?? null), authorityEpoch, activeSourceMapping: identifierValue(frame.activeSourceMapping) });
  };
  const projectCanonical = ({ memory, source = {}, frame: inputFrame } = {}) => {
    if (!memory || typeof memory !== 'object') throw new TypeError('LIBRA_NETWORK_CANONICAL_REQUIRED');
    const sourceRevision = revisionValue(source.revision ?? memory.revision);
    const analysisRevision = revisionValue(source.analysisRevision);
    const frame = normalizeFrame(inputFrame);
    const rendered = text(memory.text || memory.summary);
    const sourceAtoms = ['ownerNamespace', 'originScope', 'objectUUID', 'birthIncarnation'].map(key => identifierValue(source[key]));
    const completeSource = sourceAtoms.every(Boolean);
    // Source hash is binding, never a stable source object identifier. Surface
    // message IDs and producer tempFactIds also cannot establish an incarnation.
    const sourceIdentity = completeSource
      ? ['source-object', ...sourceAtoms]
      : ['legacy-source', frame.owner, frame.scopeKey, identifierValue(source.recordKey), identifierValue(memory.memoryId), sourceRevision,
          analysisRevision, identifierValue(source.sourceDigest), digest(memory)];
    const sourceId = 'source:' + digest(sourceIdentity);
    const rawClaims = array(memory.claims).length ? memory.claims : array(memory.canonicalArtifact?.facts);
    const descriptors = rawClaims.map(claim => {
      const anchors = Array.from(new Set(array(claim.sourceAnchors).map(identifierValue).filter(Boolean))).sort();
      const semantic = { actorId: identifierValue(claim.actorId), targetId: identifierValue(claim.targetId), predicate: identifierValue(claim.predicate),
        direction: identifierValue(claim.direction), value: claim.value ?? null, polarity: identifierValue(claim.polarity), time: claim.time ?? null,
        certainty: identifierValue(claim.certainty), sourceAnchors: anchors };
      const complete = completeSource && semantic.actorId && semantic.predicate && semantic.direction && semantic.polarity
        && claim.value !== undefined && claim.time !== undefined && semantic.certainty && anchors.length;
      const entityIds = array(claim.entityIds).map(entityIdValue);
      return { claim, semantic, entityIds, complete: !!complete, key: serialize(semantic) };
    });
    const counts = new Map();
    for (const item of descriptors) counts.set(item.key, (counts.get(item.key) || 0) + 1);
    const claimKeys = [];
    const claims = descriptors.map(({ claim, semantic, complete, key }, index) => {
      const proven = complete && counts.get(key) === 1;
      const meaning = proven ? semantic : ['legacy-claim', sourceRevision, analysisRevision, index, claim];
      claimKeys.push(serialize(meaning));
      return { claimId: 'claim:' + digest([sourceId, meaning]), identityCoverage: proven ? 'complete' : 'partial', semantic: copy(semantic) };
    });
    const identityCoverage = completeSource && claims.length && claims.every(c => c.identityCoverage === 'complete') ? 'complete' : 'partial';
    const semanticDigest = digest(claims.map(c => c.semantic));
    const projectionVersion = 'libra.canonical-network.v1';
    const textHash = sha256Hex(rendered), embeddingSpace = identifierValue(source.embeddingSpace || memory.embedding?.profileId);
    const bindingFields = { frame, sourceRevision: sourceRevision, analysisRevision: analysisRevision,
      recordKey: identifierValue(source.recordKey), sourceDigest: identifierValue(source.sourceDigest), physicalDigest: identifierValue(source.physicalDigest),
      semanticDigest, textHash, projectionVersion, embeddingSpace };
    const binding = { ...bindingFields, bindingId: 'binding:' + digest(bindingFields) };
    const nodeId = 'canonical:' + digest([sourceId, claims.map(c => c.claimId)]);
    const entityKeys = descriptors.flatMap(({ claim, semantic, entityIds }) => [semantic.actorId, semantic.targetId,
      ...entityIds, ...[claim.subjectTempRef, claim.targetTempRef].filter(Boolean).map(id => `${sourceId}:legacy-entity:${identifierValue(id)}`)]).filter(Boolean);
    const predicateKeys = descriptors.map(({ claim, semantic }) => semantic.predicate || text(claim.claimKind)).filter(Boolean);
    const timeKeys = descriptors.flatMap(({ claim, semantic }) => [semantic.time?.turn, semantic.time?.start, semantic.time?.end,
      claim.turn, ...array(claim.evidenceSpans).map(span => /^t(\d+)-/.exec(text(span.ref))?.[1])]).filter(v => v != null).map(text);
    for (const turn of [memory.turnRange?.start, memory.turnRange?.end]) if (turn != null) timeKeys.push(text(turn));
    const unit = freeze({ schema: projectionVersion, nodeId, sourceId, claims, identityCoverage, binding,
      representationId: 'representation:' + digest([nodeId, textHash, projectionVersion, embeddingSpace]),
      postings: { token: tokens([rendered, ...array(memory.recallKeys), ...rawClaims.map(c => c.text)].join(' ')),
        entity: [...new Set(entityKeys)], predicate: [...new Set(predicateKeys)], time: [...new Set(timeKeys)] } });
    const sourceKey = serialize(completeSource ? sourceIdentity : [sourceIdentity, memory]);
    identityRecords.set(unit, { sourceKey, logicalKey: serialize([sourceKey, claimKeys]), bindingKey: serialize([bindingFields, memory]) });
    return unit;
  };
  const createRegistry = ({ frame: inputFrame } = {}) => {
    let frame = normalizeFrame(inputFrame);
    const candidates = new Map(), sourceLabels = new Map(), leases = new WeakMap(), accessLists = new WeakMap();
    const postings = Object.fromEntries(['token', 'entity', 'predicate', 'time'].map(kind => [kind, new Map()]));
    const costs = { projections: 0, upserts: 0, merges: 0, postingAdds: 0, discoveries: 0, invalidations: 0, identityLabelCollisions: 0 };
    const sameFrame = value => serialize(frame) === serialize(value);
    const remove = id => {
      const candidate = candidates.get(id); if (!candidate) return;
      for (const [kind, keys] of Object.entries(candidate.projection.postings)) for (const key of keys) {
        const set = postings[kind].get(key); set?.delete(id); if (!set?.size) postings[kind].delete(key);
      }
      const source = sourceLabels.get(candidate.projection.sourceId);
      if (source && --source.count === 0) sourceLabels.delete(candidate.projection.sourceId);
      candidates.delete(id);
    };
    const labelCollision = () => {
      costs.identityLabelCollisions++;
      const error = new TypeError('LIBRA_NETWORK_IDENTITY_LABEL_COLLISION');
      error.code = 'LIBRA_NETWORK_IDENTITY_LABEL_COLLISION';
      error.coverage = Object.freeze({ status: 'partial', reason: 'identity_label_collision' });
      return error;
    };
    const upsert = (projection, row, access = { kind: 'canonical', score: 0 }) => {
      if (!projection || projection.schema !== 'libra.canonical-network.v1' || !sameFrame(projection.binding.frame)) throw new TypeError('LIBRA_NETWORK_BINDING_FRAME_MISMATCH');
      const identity = identityRecords.get(projection);
      if (!identity) throw new TypeError('LIBRA_NETWORK_PROJECTION_IDENTITY_UNAVAILABLE');
      costs.upserts++;
      const sourceLabel = sourceLabels.get(projection.sourceId);
      if (sourceLabel && sourceLabel.key !== identity.sourceKey) throw labelCollision();
      let candidate = candidates.get(projection.nodeId);
      if (candidate && identityRecords.get(candidate.projection).logicalKey !== identity.logicalKey) throw labelCollision();
      // Replace a changed physical binding; the old lease is no longer current.
      if (candidate && identityRecords.get(candidate.projection).bindingKey !== identity.bindingKey) { remove(projection.nodeId); candidate = null; }
      if (!candidate) {
        candidate = Object.freeze({ id: projection.nodeId, projection, row, pathBonus: 0,
          get accesses() { return freeze(copy(accessLists.get(candidate))); } });
        accessLists.set(candidate, []);
        candidates.set(candidate.id, candidate); costs.projections++;
        const source = sourceLabels.get(projection.sourceId) || { key: identity.sourceKey, count: 0 };
        source.count++; sourceLabels.set(projection.sourceId, source);
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
        pathBonus: 0, status: costs.identityLabelCollisions ? 'partial' : 'complete',
        partialReasons: costs.identityLabelCollisions ? ['identity_label_collision'] : [], costs: { ...costs } }) });
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
      identityCoverage: diagnostic.identityCoverage, status: diagnostic.identityCoverage === 'complete' && diagnostic.status !== 'partial' ? 'complete' : 'partial' });
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
