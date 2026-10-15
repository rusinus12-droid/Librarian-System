'use strict';
// Owner-supplied document representations enter the same query frontier. A
// projection vector is an access signal for its source, never a fact embedding.
module.exports = function createMemoryGraphSemantic({ digest, profileFor, projectionFor } = {}) {
  if (![digest, profileFor, projectionFor].every(fn => typeof fn === 'function')) throw new TypeError('LIBRA_GRAPH_SEMANTIC_ADAPTER_REQUIRED');
  const vectorValid = (vector, dimension) => {
    if (!Array.isArray(vector) || vector.length !== dimension || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) return false;
    const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
    return Number.isFinite(squaredNorm) && squaredNorm > 0;
  };
  const prepare = async ({ graph, canonicalRows = [], config, queryText = '', asOfTurn = null,
    readVector, embedQuery, check = () => {}, maxBytes = 262144, additionalRepresentations = [] } = {}) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16777216) throw new TypeError('LIBRA_GRAPH_SEMANTIC_BUDGET_INVALID');
    const admittedFamilies = new Set();
    const diagnostics = { schema: 'libra.native_graph_semantic.v1', status: 'unavailable', representationScope: 'canonical_global_projection_source_access',
      queryRequestCount: 0, queryCacheHits: 0, coalesced: false, documentEmbeddingCalls: 0, backgroundEmbeddingStarted: false,
      admittedRepresentations: 0, representationBytes: 0, maxRepresentationBytes: maxBytes, rejected: [],
      vectorlessFamilies: ['micro','state','lore'], byteBounded: false };
    const empty = () => ({ queryInput: { semanticSpace: null, queryEmbedding: null, documentRepresentations: {}, queryVectors: {} }, dependencies: [], diagnostics });
    if (!config) { diagnostics.status = 'configuration_unavailable'; return empty(); }
    if (!config.enabled) { diagnostics.status = 'disabled'; return empty(); }
    if (!String(queryText).trim()) { diagnostics.status = 'empty_query'; return empty(); }
    const nodes = new Map((graph.nodes || []).map(node => [node.id, node]));
    const sourcesByKey = new Map();
    for (const unit of graph.units || []) {
      if (unit.family !== 'canonical' || !unit.recordKey) continue;
      const node = nodes.get(unit.nodeId), source = nodes.get(node?.sourceId);
      if (!source || source.layer !== 'source') continue;
      if (!sourcesByKey.has(unit.recordKey)) sourcesByKey.set(unit.recordKey, new Set());
      sourcesByKey.get(unit.recordKey).add(source.id);
    }
    const documents = [], dependencies = [];
    let bytes = 2048, dimension = null, expectedProfile = null;
    const reject = (key, reason) => diagnostics.rejected.push({ recordKey: key, reason });
    for (const row of canonicalRows) {
      check();
      const memory = row.record, sourceIds = sourcesByKey.get(row.key), embedding = memory?.embedding;
      if (!sourceIds || sourceIds.size !== 1 || embedding?.status !== 'ready' || !embedding.vectorKey) { reject(row.key, 'representation_missing'); continue; }
      // The global projection can contain future facts, even if the source has
      // other eligible child facts. Never use it as a past-view semantic proxy.
      if (asOfTurn !== null && (!Number.isSafeInteger(memory.turnRange?.end) || memory.turnRange.end > asOfTurn)) {
        reject(row.key, 'representation_outside_temporal_view'); continue;
      }
      let vectorRecord;
      try { vectorRecord = await readVector(embedding.vectorKey); } catch (_) { check(); reject(row.key, 'vector_read_unavailable'); continue; }
      check();
      if (!vectorRecord || vectorRecord.schema !== 'libra.embedding_projection.v2' || vectorRecord.scopeKey !== memory.scopeKey
        || vectorRecord.memoryId !== memory.memoryId || vectorRecord.revision !== memory.revision) { reject(row.key, 'vector_owner_binding_mismatch'); continue; }
      const d = vectorRecord.dimensions;
      if (!Number.isSafeInteger(d) || d < 1 || d > 65536 || !vectorValid(vectorRecord.entries?.global?.vector || vectorRecord.vector, d)) {
        reject(row.key, 'invalid_vector'); continue;
      }
      let profile, projection;
      try { profile = profileFor({ ...config, dimensions: d }); projection = projectionFor(memory); }
      catch (_) { reject(row.key, 'projection_or_profile_unavailable'); continue; }
      if (vectorRecord.provider !== profile.provider || vectorRecord.model !== profile.model
        || vectorRecord.profileId !== profile.profileId || embedding.profileId !== vectorRecord.profileId
        || digest(vectorRecord.embeddingDescriptor) !== digest(profile.descriptor)
        || dimension !== null && dimension !== d) { reject(row.key, 'embedding_space_mismatch'); continue; }
      const hash = projection.textHashes.global, entry = vectorRecord.entries?.global;
      if (vectorRecord.projectionVersion !== projection.version || vectorRecord.textHash !== hash
        || embedding.textHash !== hash || !embedding.vectorHash || vectorRecord.vectorHash !== embedding.vectorHash
        || entry && entry.textHash !== hash) { reject(row.key, 'projection_text_mismatch'); continue; }
      const additional = 1024 + d * 8 + (dimension === null ? d * 16 : 0);
      if (bytes + additional > maxBytes) { reject(row.key, 'representation_byte_budget'); continue; }
      const node = nodes.get([...sourceIds][0]);
      documents.push({ nodeId: node.id, bindingId: node.bindingId, vector: (entry?.vector || vectorRecord.vector).slice(),
        representationId: digest([embedding.vectorKey, vectorRecord.profileId, hash, vectorRecord.vectorHash]),
        projectionVersion: projection.version, textHash: hash, temporalEndTurn: memory.turnRange?.end ?? null });
      dependencies.push({ key: embedding.vectorKey, digest: digest(vectorRecord) });
      dimension = d; expectedProfile = profile; bytes += additional;
      admittedFamilies.add('canonical');
    }
    for (const extra of additionalRepresentations) {
      check();
      const fam = extra?.family || 'unknown';
      if (!extra?.nodeId || !extra?.recordKey || !extra?.vectorKey) { reject(extra?.recordKey || 'extra', 'representation_missing'); continue; }
      if (asOfTurn !== null && Number.isSafeInteger(extra.temporalEndTurn) && extra.temporalEndTurn > asOfTurn) {
        reject(extra.recordKey, 'representation_outside_temporal_view'); continue;
      }
      let vectorRecord = extra.vectorRecord;
      if (!vectorRecord && typeof readVector === 'function') {
        try { vectorRecord = await readVector(extra.vectorKey); } catch (_) { check(); reject(extra.recordKey, 'vector_read_unavailable'); continue; }
      }
      check();
      if (!vectorRecord || !vectorValid(vectorRecord.vector, vectorRecord.dimensions)) { reject(extra.recordKey, 'invalid_vector'); continue; }
      const d = vectorRecord.dimensions;
      let profile;
      try { profile = profileFor({ ...config, dimensions: d }); }
      catch (_) { reject(extra.recordKey, 'projection_or_profile_unavailable'); continue; }
      if (dimension !== null && dimension !== d) { reject(extra.recordKey, 'embedding_space_mismatch'); continue; }
      const additional = 1024 + d * 8 + (dimension === null ? d * 16 : 0);
      if (bytes + additional > maxBytes) { reject(extra.recordKey, 'representation_byte_budget'); continue; }
      const node = nodes.get(extra.nodeId);
      documents.push({ nodeId: extra.nodeId, bindingId: node?.bindingId || extra.nodeId, vector: vectorRecord.vector.slice(),
        representationId: digest([extra.vectorKey, vectorRecord.profileId || profile.profileId, extra.textHash || '', vectorRecord.vectorHash || '']),
        projectionVersion: 'projection_v1', textHash: extra.textHash || '', temporalEndTurn: extra.temporalEndTurn ?? null });
      if (extra.vectorKey) dependencies.push({ key: extra.vectorKey, digest: digest(vectorRecord) });
      dimension = d; expectedProfile = profile; bytes += additional;
      admittedFamilies.add(fam);
    }
    if (!documents.length) { diagnostics.status = 'no_compatible_representations'; return empty(); }
    let query;
    try { query = await embedQuery(String(queryText), config); }
    catch (error) { check(); diagnostics.status = 'query_embedding_unavailable'; diagnostics.reason = error.code || 'query_embedding_failed';
      diagnostics.queryRequestCount = Number(error.graphEmbeddingOperation?.embeddingRequests || 0); return empty(); }
    check();
    diagnostics.queryRequestCount = Number(query?.graphEmbeddingOperation?.embeddingRequests ?? query?.metadata?.requestCount ?? 0);
    diagnostics.queryCacheHits = Number(query?.metadata?.cacheHits || 0);
    diagnostics.coalesced = Boolean(query?.graphEmbeddingCoalesced);
    if (!query || query.provider !== expectedProfile.provider || query.model !== expectedProfile.model
      || query.dimensions !== dimension || query.metadata?.profileId !== expectedProfile.profileId
      || !vectorValid(query.vectors?.[0], dimension)) { diagnostics.status = 'query_space_mismatch'; return empty(); }
    const semanticSpace = { spaceId: expectedProfile.descriptor.spaceId, provider: expectedProfile.provider,
      model: expectedProfile.model, dimension, metric: 'cosine',
      taskPair: expectedProfile.queryTask + '/' + expectedProfile.documentTask, profileDigest: digest(expectedProfile.descriptor) };
    const documentRepresentations = Object.fromEntries(documents.map(document => [document.nodeId, {
      ...document, spaceId: semanticSpace.spaceId, provider: semanticSpace.provider, model: semanticSpace.model,
      dimension, metric: semanticSpace.metric, profileDigest: semanticSpace.profileDigest } ]));
    diagnostics.status = 'available'; diagnostics.admittedRepresentations = documents.length;
    diagnostics.representationBytes = bytes; diagnostics.spaceId = semanticSpace.spaceId;
    diagnostics.dimension = dimension; diagnostics.queryTask = expectedProfile.queryTask; diagnostics.documentTask = expectedProfile.documentTask;
    diagnostics.vectorlessFamilies = ['micro','state','lore'].filter(family => !admittedFamilies.has(family));
    diagnostics.admittedFamilies = [...admittedFamilies].sort();
    return { queryInput: { semanticSpace, queryEmbedding: query.vectors[0], documentRepresentations, queryVectors: {} }, dependencies, diagnostics };
  };
  return Object.freeze({ prepare });
};
