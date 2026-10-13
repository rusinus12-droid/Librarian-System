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
    let attachment = null;
    if(source.attachment != null){
      const a=source.attachment;
      if(a.schema!=='libra.revision_source_attachment.v1' || !['owner','sourceScope','worldlineId','originIdentity','sourceRevision'].every(key=>identifierValue(a[key]))
        || !Number.isSafeInteger(a.sessionEpoch) || !Number.isSafeInteger(a.turn) || a.turn<1 || !['user','assistant'].includes(a.role)) {
        throw new TypeError('LIBRA_NETWORK_SOURCE_ATTACHMENT');
      }
      attachment={schema:a.schema,owner:identifierValue(a.owner),sourceScope:identifierValue(a.sourceScope),worldlineId:identifierValue(a.worldlineId),
        sessionEpoch:a.sessionEpoch,turn:a.turn,role:a.role,originIdentity:identifierValue(a.originIdentity),sourceRevision:identifierValue(a.sourceRevision)};
    }
    // Source hash is binding, never a stable source object identifier. Surface
    // message IDs and producer tempFactIds also cannot establish an incarnation.
    const sourceIdentity = completeSource
      ? ['source-object', ...sourceAtoms]
      : attachment ? ['revision-source-attachment', attachment]
      : ['legacy-source', frame.owner, frame.scopeKey, identifierValue(source.recordKey), identifierValue(memory.memoryId), sourceRevision,
          analysisRevision, identifierValue(source.sourceDigest), digest(memory)];
    const sourceId = 'source:' + digest(sourceIdentity);
    const rawClaims = array(memory.claims).length ? memory.claims : array(memory.canonicalArtifact?.facts);
    const descriptors = rawClaims.map(claim => {
      const anchors = Array.from(new Set(array(claim.sourceAnchors).map(identifierValue).filter(Boolean))).sort();
      const semantic = { actorId: identifierValue(claim.actorId), targetId: identifierValue(claim.targetId), predicate: identifierValue(claim.predicate),
        direction: identifierValue(claim.direction), value: claim.value ?? null, polarity: identifierValue(claim.polarity), time: claim.time ?? null,
        certainty: identifierValue(claim.certainty), sourceAnchors: anchors };
      const complete = (completeSource || attachment) && semantic.actorId && semantic.predicate && semantic.direction && semantic.polarity
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
      return { claimId: 'claim:' + digest([sourceId, meaning]), identityCoverage: proven && completeSource ? 'complete' : 'partial', semantic: copy(semantic) };
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
    const sourceKey = serialize(completeSource || attachment ? sourceIdentity : [sourceIdentity, memory]);
    identityRecords.set(unit, { sourceKey, logicalKey: serialize([sourceKey, claimKeys]), bindingKey: serialize([bindingFields, memory]),
      typedCorrespondence: descriptors.length > 0 && descriptors.every(item => item.complete && counts.get(item.key) === 1) });
    return unit;
  };
  const projectMicro = (record = {}, binding = {}) => {
    if (!['verified', 'minimum_source_bound'].includes(record.analysisStatus)) throw new TypeError('LIBRA_NETWORK_MICRO_ANALYSIS_STATUS');
    const rawClaims = record.analysisStatus === 'verified' ? array(record.claims) : [];
    if(rawClaims.length && binding.normalizedClaims != null && (!Array.isArray(binding.normalizedClaims)
      || binding.normalizedClaims.length!==rawClaims.length))throw new TypeError('LIBRA_NETWORK_MICRO_CLAIM_CARDINALITY');
    const spans = rawClaims.length ? rawClaims.map(claim => claim.evidence) : [record.excerpt];
    if (!spans.length || spans.some(span => !span || !['user', 'assistant'].includes(span.role)
      || !identifierValue(span.messageId) || !Number.isSafeInteger(span.startOffset)
      || !Number.isSafeInteger(span.endOffset) || span.startOffset < 0 || span.endOffset <= span.startOffset
      || typeof span.exactQuote !== 'string' || span.exactQuote.length !== span.endOffset - span.startOffset)) {
      throw new TypeError('LIBRA_NETWORK_MICRO_SOURCE_SPAN');
    }
    // This exact semantic payload excludes durable projections, embedding/jobs,
    // producer timestamps and public proof flags. Access and hydration therefore
    // issue the same IDs; only the physical binding can change independently.
    const payload = { memoryId: 'micro_' + identifierValue(record.analysisRevisionId),
      revision: revisionValue(record.sourceRevisionId), scopeKey: identifierValue(record.scopeKey),
      worldlineId: identifierValue(record.worldlineId), sessionEpoch: record.sessionEpoch,
      receiptKey: identifierValue(record.receiptKey), analysisStatus: record.analysisStatus,
      turnRange: {start: record.turn, end: record.turn},
      sourceSpans: spans.map(copy),
      text: [...rawClaims.map(claim => text(claim.text)), ...spans.map(span => span.exactQuote)].join('\n'),
      claims: rawClaims.length ? binding.normalizedClaims || rawClaims.map(copy) : [] };
    const source = { ...binding.source, revision: record.sourceRevisionId,
      analysisRevision: record.analysisRevisionId, sourceDigest: record.sourceDigest };
    const base = projectCanonical({memory: payload, source, frame: binding.frame});
    const kind = rawClaims.length ? 'micro' : 'source_only';
    const microBindingFields={...base.binding,projectionVersion:'libra.micro-network.v1'};delete microBindingFields.bindingId;
    const microBinding=freeze({...microBindingFields,bindingId:'binding:'+digest(microBindingFields)});
    const nodeId=kind + ':' + digest([base.sourceId, base.claims.map(claim => claim.claimId), record.analysisStatus,
      kind==='source_only'?spans:null]);
    const unit = freeze({...base, schema: 'libra.micro-network.v1', kind,
      authority: kind === 'micro' ? 'source_verified_candidate' : 'source_only',
      nodeId,binding:microBinding,representationId:'representation:'+digest([nodeId,microBinding.textHash,microBinding.projectionVersion,microBinding.embeddingSpace]),
      text: payload.text, sourceSpans: spans.map(copy)});
    identityRecords.set(unit, {...identityRecords.get(base),
      logicalKey: kind==='source_only'?serialize([identityRecords.get(base).logicalKey,spans]):identityRecords.get(base).logicalKey,
      bindingKey: serialize([identityRecords.get(base).bindingKey, microBinding, unit.authority, spans])});
    if (binding.row) rowsByUnit.set(unit, binding.row);
    return Object.freeze([unit]);
  };
  const resolveEvidenceCluster = units => {
    const issued = array(units);
    if (issued.some(unit => !identityRecords.has(unit))) throw new TypeError('LIBRA_NETWORK_PROJECTION_IDENTITY_UNAVAILABLE');
    const sources = [...new Set(issued.map(unit => unit.sourceId))];
    const key = unit => serialize([identityRecords.get(unit).sourceKey, unit.claims.map(claim => claim.claimId).sort()]);
    const same = issued.length > 0 && issued.every(unit => identityRecords.get(unit).typedCorrespondence && unit.claims.length > 0 && key(unit) === key(issued[0]));
    const conflictSlot = claim => {const {value, polarity, ...slot} = claim.semantic; return serialize(slot);};
    const conflicts = issued.filter(unit => identityRecords.get(unit).typedCorrespondence && issued.some(other => other !== unit && identityRecords.get(other).typedCorrespondence && other.sourceId === unit.sourceId
      && unit.claims.some(claim => other.claims.some(alternative => conflictSlot(claim) === conflictSlot(alternative)
        && serialize(claim.semantic) !== serialize(alternative.semantic)))));
    return Object.freeze({representative: same ? issued.find(unit => unit.schema === 'libra.canonical-network.v1') || issued[0] : null,
      supportingSources: Object.freeze(sources), conflicts: Object.freeze(conflicts)});
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
      if (!projection || !['libra.canonical-network.v1', 'libra.micro-network.v1'].includes(projection.schema) || !sameFrame(projection.binding.frame)) throw new TypeError('LIBRA_NETWORK_BINDING_FRAME_MISMATCH');
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
      diagnostics: () => ({ schema: 'libra.canonical-network-diagnostics.v1', candidateCount: candidates.size,
        canonicalCandidates: [...candidates.values()].filter(candidate=>candidate.projection.schema==='libra.canonical-network.v1').length,
        microCandidates: [...candidates.values()].filter(candidate=>candidate.projection.kind==='micro').length,
        sourceOnlyCandidates: [...candidates.values()].filter(candidate=>candidate.projection.kind==='source_only').length,
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
  // Derived metadata only: neither a proof nor an owner-store authority. A host
  // adapter may supply a trusted revision/delta; otherwise every item is checked.
  const createPagedIndex = ({ pageSize = 256 } = {}) => {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new TypeError('LIBRA_NETWORK_PAGE_SIZE');
    const records = new Map(), terms = new Map(), dependencies = new Map(), cursors = new WeakMap();
    const vectorPages = [], freeSlots = [];
    let ownerKey = null, revision = null, generation = 0, order = 0, dimensions = 0, nextSlot = 0, metadataBytes = 0, dirty = true, activeWork = null;
    const io = { snapshots: 0, fallbacks: 0, refComparisons: 0, metadataRows: 0, postingAdds: 0,
      postingRemoves: 0, invalidatedRows: 0, pagesRead: 0, lastFallbackReason: null };
    const ownerTuple = frame => {
      const { activeSourceMapping, ...owner } = normalizeFrame(frame);
      return serialize(owner);
    };
    const remove = id => {
      const old = records.get(id); if (!old) return;
      for (const key of old.keys) {
        const pages = terms.get(key), set = pages?.get(old.page);
        if (set?.delete(id)) io.postingRemoves++;
        if (!set?.size) pages?.delete(old.page);
        if (!pages?.size) terms.delete(key);
      }
      for (const dep of old.dependencies) {
        const set = dependencies.get(dep); set?.delete(id); if (!set?.size) dependencies.delete(dep);
      }
      if (old.slot != null) { vectorPages[Math.floor(old.slot / pageSize)].fill(0, (old.slot % pageSize) * dimensions, (old.slot % pageSize + 1) * dimensions); freeSlots.push(old.slot); }
      metadataBytes -= old.bytes; records.delete(id); io.invalidatedRows++;
    };
    const clear = () => {
      records.clear(); terms.clear(); dependencies.clear(); vectorPages.length = 0;
      freeSlots.length = 0; nextSlot = 0; order = 0; dimensions = 0; metadataBytes = 0; generation++;
    };
    const prepare = item => {
      const id = entityIdValue(item?.id);
      const postings = Object.fromEntries(['token','entity','predicate','time'].map(kind =>
        [kind, [...new Set(array(item.postings?.[kind]).map(entityIdValue))]]));
      const deps = [...new Set(array(item.dependencies).map(entityIdValue))];
      const vector = item.vector == null ? null : Float64Array.from(item.vector);
      if (vector && (!vector.length || vector.some(v => !Number.isFinite(v)))) throw new TypeError('LIBRA_NETWORK_VECTOR_INVALID');
      return { id, postings, deps, vector, exact: serialize([item.fingerprint ?? null, postings, deps, vector?.length ?? null]) };
    };
    const moveOrder = (id, position) => {
      const row=records.get(id),page=Math.floor(position/pageSize);
      if(row.page!==page) for(const key of row.keys){
        const pages=terms.get(key),old=pages.get(row.page); old.delete(id); io.postingRemoves++;
        if(!old.size)pages.delete(row.page);
        let set=pages.get(page);if(!set)pages.set(page,set=new Set());set.add(id);io.postingAdds++;
      }
      row.page=page;row.order=position;
    };
    const insert = (item, position) => {
      const old = records.get(item.id);
      if (old?.exact === item.exact) {
        const sameVector = !item.vector || item.vector.every((value,d) =>
          value === vectorPages[Math.floor(old.slot / pageSize)][(old.slot % pageSize) * dimensions + d]);
        if (sameVector) { moveOrder(item.id,position); return; }
      }
      remove(item.id);
      const page = Math.floor(position / pageSize);
      const keys = Object.entries(item.postings).flatMap(([kind, values]) => values.map(key => serialize([kind,key])));
      let slot = null;
      if (item.vector) {
        if (!dimensions) dimensions = item.vector.length;
        slot = freeSlots.length ? freeSlots.pop() : nextSlot++;
        const vectorPage = Math.floor(slot / pageSize);
        vectorPages[vectorPage] ||= new Float64Array(pageSize * dimensions);
        vectorPages[vectorPage].set(item.vector, (slot % pageSize) * dimensions);
      }
      const bytes = utf8Bytes(item.exact).length; metadataBytes += bytes;
      records.set(item.id, { exact:item.exact, bytes, keys, dependencies:item.deps, page, order:position, slot });
      for (const key of keys) {
        let pages = terms.get(key); if (!pages) terms.set(key, pages = new Map());
        let set = pages.get(page); if (!set) pages.set(page, set = new Set());
        set.add(item.id); io.postingAdds++;
      }
      for (const dep of item.deps) { let set=dependencies.get(dep); if (!set) dependencies.set(dep,set=new Set()); set.add(item.id); }
      io.metadataRows++;
    };
    const reconciliation = function* (snapshot) {
      const nextOwner = ownerTuple(snapshot.frame), nextRevision = revisionValue(snapshot.revision);
      const sameOwner = nextOwner === ownerKey;
      const trusted = snapshot.trustedRevision === true;
      if (sameOwner && trusted && revision === nextRevision && nextRevision != null && !dirty) return inspect();
      const delta = sameOwner && trusted && snapshot.verifiedChangedIDs === true;
      if(delta && dirty)throw new TypeError('LIBRA_NETWORK_DIRTY_SNAPSHOT_REQUIRED');
      if (delta && (revisionValue(snapshot.fromRevision) !== revision || nextRevision == null)) throw new TypeError('LIBRA_NETWORK_DELTA_UNVERIFIED');
      if (sameOwner && trusted && !delta) throw new TypeError('LIBRA_NETWORK_DELTA_UNVERIFIED');
      if (delta && snapshot.append === true && snapshot.prefixVerified !== true) throw new TypeError('LIBRA_NETWORK_PREFIX_UNVERIFIED');
      if (!Array.isArray(snapshot.items)) throw new TypeError('LIBRA_NETWORK_SNAPSHOT_REQUIRED');
      // Validate everything before mutation so malformed deltas retain prior data.
      const prepared=[], seen = new Set();
      for(let i=0;i<snapshot.items.length;i++){
        prepared.push(prepare(snapshot.items[i]));
        if((i+1)%pageSize===0)yield;
      }
      for (const item of prepared) { if (seen.has(item.id)) throw new TypeError('LIBRA_NETWORK_DUPLICATE_ID'); seen.add(item.id); }
      const changed = array(snapshot.changedIDs).map(entityIdValue), deleted = array(snapshot.deletedIDs).map(entityIdValue);
      if (delta && (changed.length !== seen.size || new Set(changed).size !== seen.size || changed.some(id => !seen.has(id)) || deleted.some(id=>seen.has(id)))) throw new TypeError('LIBRA_NETWORK_DELTA_UNVERIFIED');
      const vectorDimensions = new Set(prepared.filter(i=>i.vector).map(i=>i.vector.length));
      if (vectorDimensions.size > 1 || (sameOwner && dimensions && [...vectorDimensions].some(d=>d!==dimensions))) throw new TypeError('LIBRA_NETWORK_VECTOR_SPACE_MISMATCH');
      const reordered = snapshot.orderIDs == null ? null : snapshot.orderIDs.map(entityIdValue);
      if (delta && reordered && (new Set(reordered).size !== reordered.length || reordered.length !== records.size - deleted.filter(id=>records.has(id)).length + prepared.filter(i=>!records.has(i.id)).length
        || reordered.some(id=>!seen.has(id)&&(!records.has(id)||deleted.includes(id))))) throw new TypeError('LIBRA_NETWORK_ORDER_UNVERIFIED');
      if (!sameOwner) { clear(); ownerKey = nextOwner; }
      io.snapshots++; dirty=true; generation++;
      if (delta) {
        for(let i=0;i<deleted.length;i++){remove(deleted[i]);if((i+1)%pageSize===0)yield;}
        for(let i=0;i<prepared.length;i++){const item=prepared[i];insert(item, records.get(item.id)?.order ?? order++);if((i+1)%pageSize===0)yield;}
        if(reordered){for(let i=0;i<reordered.length;i++){moveOrder(reordered[i],i);if((i+1)%pageSize===0)yield;}order=reordered.length;}
      } else {
        if (!trusted) { io.fallbacks++; io.lastFallbackReason='owner_revision_unavailable'; }
        io.refComparisons += prepared.length;
        let visited=0;
        for(const id of records.keys()){if(!seen.has(id))remove(id);if(++visited%pageSize===0)yield;}
        for(let i=0;i<prepared.length;i++){insert(prepared[i],i);if((i+1)%pageSize===0)yield;}order=prepared.length;
      }
      revision=nextRevision; dirty=false; generation++; return inspect();
    };
    const startWork = () => {
      if(activeWork)throw new TypeError('LIBRA_NETWORK_RECONCILIATION_BUSY');
      activeWork={invalidated:false};generation++;
      return activeWork;
    };
    const assertWork = work => {
      if(work.invalidated)throw new TypeError('LIBRA_NETWORK_RECONCILIATION_INVALIDATED');
    };
    const reconcile = snapshot => {
      const lease=startWork(),work=reconciliation(snapshot);let step;
      try{do{assertWork(lease);step=work.next();}while(!step.done);}
      finally{work.return();activeWork=null;}
      return inspect();
    };
    const reconcilePaged = async (snapshot, { checkpoint = () => {}, yieldPage = async () => {} } = {}) => {
      const lease=startWork(),work=reconciliation(snapshot);
      try{
        for(;;){checkpoint();assertWork(lease);const step=work.next();if(step.done)break;await yieldPage();}
      }finally{work.return();activeWork=null;}
      return inspect();
    };
    const query = ({ tokens: tokenKeys=[], entities=[], predicates=[], times=[], cursor=null, frame } = {}) => {
      if (frame && ownerTuple(frame) !== ownerKey) throw new TypeError('LIBRA_NETWORK_OWNER_MISMATCH');
      const key = serialize([tokenKeys,entities,predicates,times]);
      let session = cursor ? cursors.get(cursor) : null;
      if (cursor && (!session || session.generation !== generation || session.key !== key)) throw new TypeError('LIBRA_NETWORK_CURSOR_STALE');
      if (!session) {
        const pageIDs=new Set(),keys=[];
        for(const [kind,values] of [['token',tokenKeys],['entity',entities],['predicate',predicates],['time',times]])
          for(const value of values){const term=serialize([kind,entityIdValue(value)]);keys.push(term);for(const page of terms.get(term)?.keys()||[])pageIDs.add(page);}
        session={key,generation,keys,pages:[...pageIDs].sort((a,b)=>a-b),pageAt:0,ids:[],offset:0};
      }
      const ids=[];
      // Read only enough posting pages to fill this result page. Never materialize
      // a common token's entire candidate set merely to return its first page.
      while(ids.length<pageSize){
        if(session.offset>=session.ids.length){
          if(session.pageAt>=session.pages.length)break;
          const page=session.pages[session.pageAt++],selected=new Set();
          for(const term of session.keys){const set=terms.get(term)?.get(page);if(!set)continue;io.pagesRead++;for(const id of set)selected.add(id);}
          session.ids=[...selected].sort((a,b)=>records.get(a).order-records.get(b).order);session.offset=0;
        }
        const take=Math.min(pageSize-ids.length,session.ids.length-session.offset);
        ids.push(...session.ids.slice(session.offset,session.offset+take));session.offset+=take;
      }
      let next=null;
      if(session.offset<session.ids.length||session.pageAt<session.pages.length){next=Object.freeze({});cursors.set(next,{...session});}
      return Object.freeze({ids:Object.freeze(ids),cursor:next,pageExhausted:!next,complete:!next&&!dirty&&!activeWork,coverage:inspect().coverage});
    };
    const invalidateDependencies = refs => {
      if(activeWork)activeWork.invalidated=true;
      const selected = new Set();
      for (const ref of refs) for(const id of dependencies.get(entityIdValue(ref)) || []) selected.add(id);
      selected.forEach(remove); dirty=true; generation++;
    };
    // Exact packed dot access cost only. No ranking, gate or frontier policy.
    const scanDense = queryVector => {
      if (queryVector.length !== dimensions || Array.from(queryVector).some(v=>!Number.isFinite(v))) throw new TypeError('LIBRA_NETWORK_VECTOR_SPACE_MISMATCH');
      let vectorsScanned=0,dotTerms=0,checksum=0;
      for(const row of records.values()) if(row.slot!=null){
        const page=vectorPages[Math.floor(row.slot/pageSize)],offset=(row.slot%pageSize)*dimensions;
        let dot=0; for(let d=0;d<dimensions;d++){dot+=page[offset+d]*queryVector[d];dotTerms++;}
        checksum+=dot; vectorsScanned++;
      }
      return {vectorsScanned,dotTerms,dimensions,bytesRead:dotTerms*8,checksum,complete:!dirty&&!activeWork,coverage:inspect().coverage,precision:'float64'};
    };
    const inspect = () => ({coverage:{status:dirty||activeWork?'partial':'complete',indexed:records.size,revision,partialReasons:activeWork?['reconciliation_in_progress']:dirty?['dependency_refresh_required']:[]},jobs:{generation},io:{...io},
      bytes:{packedVectors:vectorPages.length*pageSize*dimensions*8,exactMetadata:metadataBytes,accounting:'serialized_metadata_and_typed_arrays_only',heapOverhead:'unmeasured',byteBounded:false},
      frontier:{postingKeys:terms.size,pageSize,policy:'access_only'}});
    return Object.freeze({reconcile,reconcilePaged,query,invalidateDependencies,scanDense,inspect});
  };
  return Object.freeze({ project, projectMicro, resolveEvidenceCluster, upsert, invalidate, discover, projectCanonical, createRegistry, createPagedIndex,
    diagnostics: () => activeRegistry?.diagnostics() || { schema: 'libra.canonical-network-diagnostics.v1', canonicalCandidates: 0,
      identityCoverage: 'partial', pathBonus: 0, costs: {} } });
};
