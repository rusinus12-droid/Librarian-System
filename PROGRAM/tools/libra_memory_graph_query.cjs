'use strict';
// UM3 Single Retrieval & Activation Kernel (D01, D05, M04, M05, M06, M07):
// Seals QueryFrame with semantic representation space binding & native lineage rules,
// issues private eligibility-filtered QueryGraphView handles with alias ambiguity detection,
// evaluates candidates with a single calibrated scoreCandidate (supporting real vector cosine/dot
// similarity and isolating incompatible representation spaces without background re-embedding),
// and runs strongest-path activation propagation with improved-path reevaluation (pathVersion)
// over a single priority frontier interleaved with on-demand Memory Lane neighborhood paging.
module.exports = function createMemoryGraphQuery({ index, lane, pages, fingerprint, tokenize } = {}) {
  if (!index || typeof index.queryPage !== 'function' || !lane || typeof lane.createSession !== 'function'
    || !pages || typeof pages.measure !== 'function' || typeof fingerprint !== 'function') {
    throw new TypeError('LIBRA_GRAPH_QUERY_ADAPTER_REQUIRED');
  }
  const schema = 'libra.memory_graph_query.v1';
  const policyVersion = 'libra.unified_query_policy.v1';
  const defaultTokenize = text => String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff_]+/)
    .filter(token => token.length >= 2);
  const tokenizer = typeof tokenize === 'function' ? tokenize : typeof index.tokenize === 'function' ? index.tokenize : defaultTokenize;
  const fail = reason => { const err = new Error('LIBRA_GRAPH_QUERY_' + reason.toUpperCase()); err.reason = reason; throw err; };
  const hash = text => { const val = fingerprint(text); if (!/^[a-f0-9]{64}$/.test(val)) fail('fingerprint_invalid'); return val; };
  const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

  const predicateWeights = Object.freeze({
    subject_of: 0.92,
    target_of: 0.90,
    derived_from: 0.94,
    evidenced_by: 0.88,
    updates: 0.86,
    clears: 0.84,
    supersedes: 0.85,
    defines: 0.88,
    applies_to: 0.88,
    mentions: 0.72,
    follows: 0.80,
    fulfills: 0.82,
    reopens: 0.78,
    contradicts: 0.75,
    semantic_affinity: 0.55
  });

  const issuedViews = new WeakMap();

  const normalizeSemanticSpace = space => {
    if (!space || typeof space !== 'object') return null;
    const spaceId = String(space.spaceId || '').trim();
    const provider = String(space.provider || 'local').trim();
    const model = String(space.model || '').trim();
    const dimension = Number.isSafeInteger(space.dimension) && space.dimension > 0 ? space.dimension : 0;
    const metric = space.metric === 'dot' ? 'dot' : 'cosine';
    const taskPair = String(space.taskPair || 'query_document').trim();
    const profileDigest = String(space.profileDigest || '').trim();
    if (!spaceId || !dimension) fail('semantic_space_invalid');
    return Object.freeze({ spaceId, provider, model, dimension, metric, taskPair, profileDigest });
  };

  const computeVectorSimilarity = (vecA, vecB, metric = 'cosine') => {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) return null;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      const a = Number(vecA[i]), b = Number(vecB[i]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    if (metric === 'dot') return clamp01(dot);
    if (normA <= 0 || normB <= 0) return 0;
    return clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB)));
  };

  const sealQueryFrame = ({
    queryText = '',
    entityIds = [],
    entityRegistry = [],
    predicates = [],
    owner = '',
    scopeKey = '',
    worldlineId = 'main',
    allowedPredecessorWorldlines = [],
    viewerId = 'owner_reader',
    asOfTurn = null,
    excludedNodeIds = [],
    queryVectors = {},
    semanticSpace = null,
    queryEmbedding = null,
    documentRepresentations = {},
    representationDecisions = {},
    lambda = 0.82,
    epsilon = 1e-6,
    maxFrontierSteps = 256,
    maxHops = 4
  } = {}) => {
    if (typeof owner !== 'string' || !owner.trim() || typeof scopeKey !== 'string' || !scopeKey.trim()
      || typeof worldlineId !== 'string' || !worldlineId.trim() || typeof viewerId !== 'string' || !viewerId.trim()) {
      fail('frame_scope_invalid');
    }
    if (asOfTurn !== null && (!Number.isSafeInteger(asOfTurn) || asOfTurn < 0)) fail('as_of_turn_invalid');
    if (typeof lambda !== 'number' || !(lambda > 0 && lambda < 1)) fail('lambda_invalid');
    if (typeof epsilon !== 'number' || !(epsilon > 0 && epsilon < 0.1)) fail('epsilon_invalid');
    if (!Number.isSafeInteger(maxFrontierSteps) || maxFrontierSteps < 1 || maxFrontierSteps > 4096) fail('frontier_budget_invalid');
    if (!Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > 8) fail('hop_budget_invalid');

    const normalizedSpace = normalizeSemanticSpace(semanticSpace);
    const normalizedEmbedding = Array.isArray(queryEmbedding) ? Object.freeze(queryEmbedding.map(Number)) : null;
    if (normalizedEmbedding && normalizedSpace && normalizedEmbedding.length !== normalizedSpace.dimension) {
      fail('query_embedding_dimension_mismatch');
    }

    const tokens = [...new Set(tokenizer(queryText))].sort((a, b) => a.localeCompare(b, 'en'));
    const entities = [...new Set((Array.isArray(entityIds) ? entityIds : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    const preds = [...new Set((Array.isArray(predicates) ? predicates : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    const excluded = [...new Set((Array.isArray(excludedNodeIds) ? excludedNodeIds : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    const predecessors = [...new Set((Array.isArray(allowedPredecessorWorldlines) ? allowedPredecessorWorldlines : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    const normalizedRegistry = Array.isArray(entityRegistry)
      ? Object.freeze(entityRegistry.map(r => Object.freeze({
        id: String(r?.id || ''),
        nodeId: String(r?.nodeId || ''),
        name: String(r?.name || ''),
        aliases: Object.freeze(Array.isArray(r?.aliases) ? r.aliases.map(String) : []),
        status: String(r?.status || 'active'),
        validated: r?.validated !== false
      })))
      : Object.freeze([]);

    const frame = {
      schema: 'libra.query_frame.v1',
      policyVersion,
      queryText: String(queryText || ''),
      tokens,
      entityIds: entities,
      predicates: preds,
      owner: owner.trim(),
      scopeKey: scopeKey.trim(),
      worldlineId: worldlineId.trim(),
      allowedPredecessorWorldlines: predecessors,
      viewerId: viewerId.trim(),
      asOfTurn,
      excludedNodeIds: excluded,
      semanticSpace: normalizedSpace,
      hasQueryVectors: Object.keys(queryVectors || {}).length > 0 || Boolean(normalizedEmbedding),
      lambda,
      epsilon,
      maxFrontierSteps,
      maxHops
    };
    const frameId = hash(JSON.stringify(frame));
    return Object.freeze({
      ...frame,
      frameId,
      entityRegistry: normalizedRegistry,
      queryVectors: Object.freeze({ ...(queryVectors || {}) }),
      queryEmbedding: normalizedEmbedding,
      documentRepresentations: Object.freeze({ ...(documentRepresentations || {}) }),
      // N02: the representation contract's verdict per node, decided before scoring. A node whose
      // representation is missing, in a foreign space, out of the query's temporal view or built on a
      // changed basis must not contribute a semantic score — whatever the caller injected.
      representationDecisions: Object.freeze(Object.fromEntries(Object.entries(representationDecisions || {})
        .filter(([, decision]) => decision && typeof decision === 'object' && String(decision.status || '').trim())
        .map(([nodeId, decision]) => [String(nodeId), Object.freeze({ status: String(decision.status).trim(), reason: String(decision.reason || '').trim() })])))
    });
  };

  const resolveUnitTurn = unit => {
    if (!unit) return null;
    if (Number.isSafeInteger(unit.turn)) return unit.turn;
    if (Number.isSafeInteger(unit.sourceSpan?.turn)) return unit.sourceSpan.turn;
    const spans = unit.fact?.evidenceSpans;
    if (Array.isArray(spans) && spans.length) {
      const turns = spans.map(span => {
        const match = /^t([1-9]\d*)-[ua]$/.exec(String(span.ref || ''));
        return match ? Number(match[1]) : span.turn;
      });
      if (turns.every(Number.isSafeInteger)) return Math.max(...turns);
      return null;
    }
    if (Number.isSafeInteger(unit.fact?.values?.turn)) return unit.fact.values.turn;
    return null;
  };

  const openView = (graph, compiledIndex, queryFrame) => {
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    if (!compiledIndex || compiledIndex.schema !== 'libra.memory_graph_index.v1') fail('index_invalid');
    if (!queryFrame || queryFrame.schema !== 'libra.query_frame.v1') fail('query_frame_invalid');
    if (graph.scopeKey && graph.scopeKey !== queryFrame.scopeKey) fail('scope_mismatch');
    if (graph.readerFrame?.worldlineId && graph.readerFrame.worldlineId !== queryFrame.worldlineId) fail('worldline_mismatch');

    const nodeById = new Map((graph.nodes || []).map(n => [n.id, n]));
    const unitByNodeId = new Map((graph.units || []).map(u => [u.nodeId, u]));
    const basisById = new Map((graph.bases || []).map(b => [b.id, b]));
    const edgeById = new Map((graph.edges || []).map(e => [e.id, e]));
    const excludedSet = new Set(queryFrame.excludedNodeIds || []);
    const allowedWorldlines = new Set([queryFrame.worldlineId, ...(queryFrame.allowedPredecessorWorldlines || [])]);

    // Map logical entityId (e.g. 'ent-alice', 'ent-ring') to projected EntityNode.id:
    // 1) Positional 1-to-1 correspondence with active validated registry entities projected by readers.project()
    // 2) Fallback edge scan across subject_of and target_of edges
    const entityNodeIdByLogicalId = new Map();
    const entityNodes = (graph.nodes || []).filter(n => n.layer === 'entity');
    if (Array.isArray(queryFrame.entityRegistry) && queryFrame.entityRegistry.length > 0 && entityNodes.length > 0) {
      const regCounts = new Map();
      for (const row of queryFrame.entityRegistry) {
        if (row?.id) regCounts.set(row.id, (regCounts.get(row.id) || 0) + 1);
      }
      const validRows = queryFrame.entityRegistry.filter(row => (
        row?.validated === true
        && typeof row.id === 'string' && row.id.length > 0
        && regCounts.get(row.id) === 1
        && !['inactive', 'superseded', 'deleted'].includes(row.status)
      ));
      for (let i = 0; i < Math.min(validRows.length, entityNodes.length); i++) {
        entityNodeIdByLogicalId.set(validRows[i].id, entityNodes[i].id);
      }
    }
    for (const unit of graph.units || []) {
      const logicalId = unit.subjectId || unit.entityId;
      if (logicalId && !entityNodeIdByLogicalId.has(logicalId)) {
        const subjEdge = (graph.edges || []).find(e => e.from === unit.nodeId && e.predicate === 'subject_of');
        if (subjEdge?.to) entityNodeIdByLogicalId.set(logicalId, subjEdge.to);
      }
      if (Array.isArray(unit.targetIds) && unit.targetIds.length === 1) {
        const tId = unit.targetIds[0];
        if (tId && !entityNodeIdByLogicalId.has(tId)) {
          const targEdge = (graph.edges || []).find(e => e.from === unit.nodeId && e.predicate === 'target_of');
          if (targEdge?.to) entityNodeIdByLogicalId.set(tId, targEdge.to);
        }
      }
    }

    // M07: Entity & Alias ambiguity resolution against active EntityNodes in the scope
    const aliasToEntities = new Map();
    const entityMetaSources = [
      ...(Array.isArray(queryFrame.entityRegistry) ? queryFrame.entityRegistry : []),
      ...(Array.isArray(graph.coverage?.entityDirectory) ? graph.coverage.entityDirectory : []),
      ...(graph.nodes || []).filter(n => n.layer === 'entity' && (n.name || n.label || Array.isArray(n.aliases)))
    ];
    for (const entry of entityMetaSources) {
      const entIdentifier = entry.nodeId || entityNodeIdByLogicalId.get(entry.id) || entry.id;
      if (!entIdentifier || excludedSet.has(entIdentifier)) continue;
      if (entry.status && entry.status !== 'active') continue;
      if (entry.validated === false) continue;
      const surfaceTerms = [entry.label, entry.name, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
        .filter(Boolean)
        .map(s => String(s).normalize('NFKC').toLowerCase().trim())
        .filter(Boolean);
      for (const term of new Set(surfaceTerms)) {
        if (!aliasToEntities.has(term)) aliasToEntities.set(term, []);
        aliasToEntities.get(term).push(entIdentifier);
      }
    }

    const resolvedEntityIds = new Set(
      (queryFrame.entityIds || []).map(id => entityNodeIdByLogicalId.get(id) || id)
    );
    const ambiguousAliases = [];
    const queryLower = String(queryFrame.queryText || '').normalize('NFKC').toLowerCase();
    for (const [alias, entNodeIds] of aliasToEntities.entries()) {
      const matchedInQuery = queryFrame.tokens.includes(alias) || (alias.length >= 2 && queryLower.includes(alias));
      if (!matchedInQuery) continue;
      const uniqueIds = [...new Set(entNodeIds)].sort((a, b) => a.localeCompare(b, 'en'));
      if (uniqueIds.length === 1) {
        resolvedEntityIds.add(uniqueIds[0]);
      } else if (uniqueIds.length > 1) {
        ambiguousAliases.push({ alias, candidateEntityIds: uniqueIds });
      }
    }

    const childUnitsBySourceId = new Map();
    for (const node of graph.nodes || []) {
      if (!node.sourceId) continue;
      const u = unitByNodeId.get(node.id);
      if (!u) continue;
      if (!childUnitsBySourceId.has(node.sourceId)) childUnitsBySourceId.set(node.sourceId, []);
      childUnitsBySourceId.get(node.sourceId).push(u);
    }

    let historicalStateUnavailable = false;
    const historicalCanonicalUnavailable = queryFrame.asOfTurn !== null
      && (graph.units || []).some(unit => unit.family === 'canonical' && resolveUnitTurn(unit) === null);
    const isUnitTemporallyEligible = unit => {
      if (!unit || queryFrame.asOfTurn === null) return true;
      if (unit.family === 'state') {
        if (Number.isSafeInteger(unit.headThroughTurn) && unit.headThroughTurn > queryFrame.asOfTurn) {
          historicalStateUnavailable = true;
          return false;
        }
      }
      const unitTurn = resolveUnitTurn(unit);
      if (unit.family === 'canonical' && unitTurn === null) return false;
      if (Number.isSafeInteger(unitTurn) && unitTurn > queryFrame.asOfTurn) {
        return false;
      }
      return true;
    };

    const isNodeEligible = nodeId => {
      if (!nodeId || excludedSet.has(nodeId)) return false;
      const node = nodeById.get(nodeId);
      if (!node) return false;
      if (node.layer === 'entity') {
        if (node.status && node.status !== 'active') return false;
        if (node.validated === false) return false;
      }
      if (node.layer === 'source' && queryFrame.asOfTurn !== null) {
        const childUnits = childUnitsBySourceId.get(node.id) || [];
        if (childUnits.length > 0 && !childUnits.some(u => isUnitTemporallyEligible(u))) {
          return false;
        }
      }
      const unit = unitByNodeId.get(nodeId);
      if (!unit) return true;

      if (unit.worldlineId && !allowedWorldlines.has(unit.worldlineId)) return false;
      if (unit.viewerId && unit.viewerId !== queryFrame.viewerId) return false;
      if (unit.visibility === 'private' && queryFrame.viewerId !== 'owner_reader') return false;
      if (!isUnitTemporallyEligible(unit)) return false;
      return true;
    };

    const isEdgeEligible = edge => {
      if (!edge) return false;
      if (!isNodeEligible(edge.from) || !isNodeEligible(edge.to)) return false;
      if (queryFrame.asOfTurn !== null && Number.isSafeInteger(edge.validTime?.turn) && edge.validTime.turn > queryFrame.asOfTurn) {
        return false;
      }
      const basis = basisById.get(edge.basisId);
      if (basis?.sourceId && !isNodeEligible(basis.sourceId)) return false;
      if (queryFrame.asOfTurn !== null && (basis?.temporalKnown === false || Number.isSafeInteger(basis?.turn) && basis.turn > queryFrame.asOfTurn)) return false;
      return true;
    };

    const handle = Object.freeze({
      schema: 'libra.query_graph_view.v1',
      generation: compiledIndex.generation,
      indexDigest: compiledIndex.indexDigest,
      frameId: queryFrame.frameId,
      scopeKey: queryFrame.scopeKey,
      worldlineId: queryFrame.worldlineId,
      viewerId: queryFrame.viewerId,
      asOfTurn: queryFrame.asOfTurn,
      resolvedEntityIds: Object.freeze([...resolvedEntityIds].sort((a, b) => a.localeCompare(b, 'en'))),
      ambiguousAliases: Object.freeze(ambiguousAliases)
    });

    issuedViews.set(handle, {
      graph,
      compiledIndex,
      queryFrame,
      nodeById,
      unitByNodeId,
      basisById,
      edgeById,
      resolvedEntityIds: [...resolvedEntityIds].sort((a, b) => a.localeCompare(b, 'en')),
      ambiguousAliases,
      isNodeEligible,
      isEdgeEligible,
      getHistoricalStateUnavailable: () => historicalStateUnavailable,
      historicalCanonicalUnavailable
    });
    return handle;
  };

  // M06: Evaluate semantic representation compatibility & similarity without background re-embedding
  const resolveSemanticFeature = (node, queryFrame) => {
    // The plan is consulted BEFORE any injected representation: an injected vector cannot buy a
    // semantic score that the family's own representation contract refused.
    const decision = queryFrame.representationDecisions?.[node.id];
    if (decision && decision.status !== 'valid') {
      return { score: undefined, status: 'incompatible_isolated',
        reason: decision.reason || ('representation_' + decision.status), gatedByPlan: true };
    }
    const docRep = queryFrame.documentRepresentations?.[node.id];
    const space = queryFrame.semanticSpace;
    if (docRep && typeof docRep === 'object') {
      if (node.layer === 'source' && queryFrame.asOfTurn !== null
        && (!Number.isSafeInteger(docRep.temporalEndTurn) || docRep.temporalEndTurn > queryFrame.asOfTurn)) {
        return { score: undefined, status: 'incompatible_isolated', reason: 'representation_outside_temporal_view' };
      }
      if (!space || !Array.isArray(queryFrame.queryEmbedding)) {
        return { score: undefined, status: 'incompatible_isolated', reason: 'missing_query_space_or_embedding' };
      }
      if (docRep.spaceId !== space.spaceId
        || (docRep.provider && docRep.provider !== space.provider)
        || (docRep.model && docRep.model !== space.model)
        || (docRep.dimension && docRep.dimension !== space.dimension)
        || (docRep.metric && docRep.metric !== space.metric)
        || (space.profileDigest && docRep.profileDigest && docRep.profileDigest !== space.profileDigest)
        || (docRep.bindingId && docRep.bindingId !== node.bindingId)
        || !Array.isArray(docRep.vector)
        || docRep.vector.length !== space.dimension) {
        return { score: undefined, status: 'incompatible_isolated', reason: 'space_or_binding_mismatch' };
      }
      const sim = computeVectorSimilarity(queryFrame.queryEmbedding, docRep.vector, space.metric);
      if (sim === null) {
        return { score: undefined, status: 'incompatible_isolated', reason: 'invalid_vector_values' };
      }
      return { score: sim, status: 'available_vector_space', reason: null };
    }
    if (typeof queryFrame.queryVectors?.[node.id] === 'number' && Number.isFinite(queryFrame.queryVectors[node.id])) {
      return { score: clamp01(queryFrame.queryVectors[node.id]), status: 'available', reason: null };
    }
    return { score: undefined, status: 'unavailable', reason: null };
  };

  // Ranking coefficients for the single frontier. DECLARED, NOT CALIBRATED: no ablation or
  // acceptance set exists yet, so these numbers are not quality evidence (M14 / D2 gate). The
  // provenance marker is asserted by tests/libra_memory_engine_mode_test.cjs.
  const MEMORY_ENGINE_SCORE_WEIGHTS = Object.freeze({
    calibration: 'unmeasured',
    semantic: Object.freeze({ lexical: 0.38, semantic: 0.32, entitySlot: 0.20, predicate: 0.10 }),
    lexicalOnly: Object.freeze({ lexical: 0.52, entitySlot: 0.33, predicate: 0.15 }),
    role: Object.freeze({
      user_corrected: 1.0,
      state_current: 0.95, canonical_assertion: 0.95,
      micro_candidate: 0.90, background_setting: 0.90,
      state_last_known: 0.82, source_only: 0.82, canonical_legacy_excerpt: 0.82,
      state_unprovenanced: 0.45
    }),
    roleDefault: 0.85
  });

  const scoreCandidate = (unit, features = {}, queryFrame) => {
    const lexicalScore = clamp01(features.lexicalScore || 0);
    const hasSemantic = typeof features.semanticScore === 'number' && Number.isFinite(features.semanticScore);
    const semanticScore = hasSemantic ? clamp01(features.semanticScore) : 0;
    const entitySlotScore = clamp01(features.entitySlotScore || 0);
    const predicateScore = clamp01(features.predicateScore || 0);

    const roleWeight = MEMORY_ENGINE_SCORE_WEIGHTS.role[unit?.semanticRole] ?? MEMORY_ENGINE_SCORE_WEIGHTS.roleDefault;

    const signalWeights = hasSemantic ? MEMORY_ENGINE_SCORE_WEIGHTS.semantic : MEMORY_ENGINE_SCORE_WEIGHTS.lexicalOnly;
    const combinedSignal = hasSemantic
      ? (signalWeights.lexical * lexicalScore + signalWeights.semantic * semanticScore + signalWeights.entitySlot * entitySlotScore + signalWeights.predicate * predicateScore)
      : (signalWeights.lexical * lexicalScore + signalWeights.entitySlot * entitySlotScore + signalWeights.predicate * predicateScore);

    const directScore = clamp01(combinedSignal * roleWeight);
    const semanticFeatureStatus = features.semanticFeatureStatus
      || (hasSemantic ? 'available' : 'unavailable');
    return {
      directScore,
      lexicalScore,
      semanticScore: hasSemantic ? semanticScore : null,
      semanticFeatureStatus,
      entitySlotScore,
      predicateScore,
      roleWeight,
      mandatoryInclusion: Boolean(unit?.activation?.alwaysActive === true || unit?.activation?.hostSelected === true)
    };
  };

  const retrieveSteps = function* (viewHandle, {
    maxPages = 64,
    maxBytes = 262144,
    pageBytes = 8192,
    maxWorkspaceBytes = 262144,
    resumeCursors = [],
    maxStoragePages = maxPages,
    maxStorageBytes = maxBytes,
    maxWitnessBytes = 131072,
    maxFrontierBytes = 131072,
    sourceReadJsonBudget = null,
    ownerIoInFlightBudget = null,
    writeBarrierBudget = null
  } = {}) {
    const view = issuedViews.get(viewHandle);
    if (!view) fail('view_handle_invalid');
    if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 2048 || maxWorkspaceBytes > 16777216) {
      fail('workspace_budget_invalid');
    }
    if (maxWitnessBytes != null && (!Number.isSafeInteger(maxWitnessBytes) || maxWitnessBytes < 1024 || maxWitnessBytes > 16777216)) {
      fail('witness_budget_invalid');
    }
    if (maxFrontierBytes != null && (!Number.isSafeInteger(maxFrontierBytes) || maxFrontierBytes < 1024 || maxFrontierBytes > 16777216)) {
      fail('frontier_budget_invalid');
    }
    const {
      graph,
      compiledIndex,
      queryFrame,
      nodeById,
      unitByNodeId,
      basisById,
      edgeById,
      resolvedEntityIds,
      ambiguousAliases,
      isNodeEligible,
      isEdgeEligible
    } = view;

    const laneSession = lane.createSession(compiledIndex, { maxPages, maxBytes, pageBytes, resumeCursors, maxStoragePages, maxStorageBytes });

    // Phase A (M05, M06, M07): Enqueue initial seed anchor, resolved entity, temporal, and compatible semantic accesses
    for (const token of queryFrame.tokens) {
      laneSession.enqueue({ laneRole: 'query_anchor_access', table: 'postings', channel: 'lexical', term: token, priorityHint: 1.0, requesterId: `tok:${token}` });
    }
    for (const entId of resolvedEntityIds) {
      laneSession.enqueue({ laneRole: 'query_anchor_access', table: 'postings', channel: 'entity', term: entId, priorityHint: 1.0, requesterId: `ent:${entId}` });
    }
    for (const pred of queryFrame.predicates) {
      laneSession.enqueue({ laneRole: 'temporal_state_access', table: 'postings', channel: 'predicate', term: pred, priorityHint: 0.9, requesterId: `pred:${pred}` });
    }

    const semanticByNodeId = new Map();
    const semanticDiagnostics = {
      planDecisionCount: Object.keys(queryFrame.representationDecisions || {}).length,
      planGatedCount: 0,
      planGatedReasons: {},
      spaceId: queryFrame.semanticSpace?.spaceId || null,
      compatibleCount: 0,
      incompatibleIsolatedCount: 0,
      missingCount: 0,
      backgroundEmbeddingStarted: false
    };

    for (const node of graph.nodes || []) {
      if (!isNodeEligible(node.id)) continue;
      const unit = unitByNodeId.get(node.id);
      if (!unit && !(node.layer === 'source' && queryFrame.documentRepresentations?.[node.id])) continue;
      const sem = resolveSemanticFeature(node, queryFrame);
      semanticByNodeId.set(node.id, sem);
      if (sem.gatedByPlan) {
        semanticDiagnostics.planGatedCount += 1;
        const gatedReason = String(sem.reason || 'unknown');
        semanticDiagnostics.planGatedReasons[gatedReason] = (semanticDiagnostics.planGatedReasons[gatedReason] || 0) + 1;
      }
      if (sem.status === 'available' || sem.status === 'available_vector_space') {
        semanticDiagnostics.compatibleCount++;
        laneSession.enqueue({ laneRole: 'semantic_access', table: 'directory', anchorNodeId: node.id, priorityHint: Math.max(0.5, sem.score || 0.5), requesterId: `sem:${node.id}` });
      } else if (sem.status === 'incompatible_isolated') {
        semanticDiagnostics.incompatibleIsolatedCount++;
      } else {
        semanticDiagnostics.missingCount++;
      }
    }

    const rawFeatures = new Map();
    const ensureFeat = nodeId => {
      if (!rawFeatures.has(nodeId)) {
        rawFeatures.set(nodeId, { matchedTokens: new Map(), matchedEntities: new Set(), matchedPredicates: new Set() });
      }
      return rawFeatures.get(nodeId);
    };

    const outgoingByNode = new Map();
    const degreeByNode = new Map();
    const seenAdjacencyEdgeDir = new Set();
    const totalUnits = Math.max(1, (graph.units || []).length);

    const ingestAccesses = accesses => {
      for (const access of accesses) {
        if (access.table === 'postings') {
          for (const hit of access.items) {
            if (!isNodeEligible(hit.nodeId)) continue;
            const feat = ensureFeat(hit.nodeId);
            if (hit.channel === 'lexical') {
              const idf = Math.log(1 + totalUnits / Math.max(1, hit.df || 1));
              const tfWeight = Math.min(2.0, 1 + Math.log(Math.max(1, hit.tf || 1)));
              feat.matchedTokens.set(hit.term, idf * tfWeight);
            } else if (hit.channel === 'entity') {
              feat.matchedEntities.add(hit.term);
            } else if (hit.channel === 'predicate') {
              feat.matchedPredicates.add(hit.term);
            }
          }
        } else if (access.table === 'adjacency') {
          for (const row of access.items) {
            const edge = edgeById.get(row.edgeId);
            if (!isEdgeEligible(edge)) continue;
            const dedupKey = `${row.anchorNodeId}:${row.direction}:${row.edgeId}`;
            if (seenAdjacencyEdgeDir.has(dedupKey)) continue;
            seenAdjacencyEdgeDir.add(dedupKey);
            if (!outgoingByNode.has(row.anchorNodeId)) outgoingByNode.set(row.anchorNodeId, []);
            outgoingByNode.get(row.anchorNodeId).push(row);
            degreeByNode.set(row.anchorNodeId, (degreeByNode.get(row.anchorNodeId) || 0) + 1);
          }
        }
      }
    };

    const seedDrain = yield laneSession;
    ingestAccesses(seedDrain.newAccesses);

    const stateByNode = new Map();
    const directFeaturesByNode = new Map();
    const frontier = [];
    let reevaluations = 0;
    let poppedSteps = 0;
    let l0WorkspaceBytes = 1024;
    let workspaceBudgetExceeded = false;
    let l0WitnessBytes = 0;
    let witnessBudgetExceeded = false;
    let frontierExpansionBytes = 0;
    let maxFrontierObservedBytes = 0;
    let frontierBudgetExceeded = false;

    const estimateWitnessBytes = witness => (
      (witness?.edgeChain?.length || 0) * 192
      + (witness?.basisIds?.length || 0) * 96
      + (witness?.sourceDependencies?.length || 0) * 96
    );

    const estimateFrontierItemBytes = nodeId => 64 + String(nodeId).length * 2;

    const estimateStateBytes = (nodeId, witness) => (
      256
      + String(nodeId).length * 2
      + estimateWitnessBytes(witness)
    );

    const compareWitnessOrder = (chainA, chainB) => {
      const strA = JSON.stringify(chainA.map(e => e.edgeId));
      const strB = JSON.stringify(chainB.map(e => e.edgeId));
      return strA.localeCompare(strB, 'en');
    };

    const offer = (nodeId, value, witness) => {
      if (!isNodeEligible(nodeId)) return false;
      const score = clamp01(value);
      if (score <= 0) return false;
      const prev = stateByNode.get(nodeId);
      const strictlyBetter = !prev || score > prev.activation + queryFrame.epsilon;
      const tieDeterministicBetter = prev
        && Math.abs(score - prev.activation) <= queryFrame.epsilon
        && (witness.edgeChain.length < prev.witness.edgeChain.length
          || (witness.edgeChain.length === prev.witness.edgeChain.length
            && compareWitnessOrder(witness.edgeChain, prev.witness.edgeChain) < 0));

      if (!strictlyBetter && !tieDeterministicBetter) return false;

      const witnessBytes = estimateWitnessBytes(witness);
      const prevWitnessBytes = prev ? estimateWitnessBytes(prev.witness) : 0;
      const addedWitnessBytes = witnessBytes - prevWitnessBytes;
      if (maxWitnessBytes != null && l0WitnessBytes + addedWitnessBytes > maxWitnessBytes) {
        witnessBudgetExceeded = true;
        return false;
      }

      const frontierItemBytes = estimateFrontierItemBytes(nodeId);
      if (maxFrontierBytes != null && frontierExpansionBytes + frontierItemBytes > maxFrontierBytes) {
        frontierBudgetExceeded = true;
        return false;
      }

      const addedBytes = estimateStateBytes(nodeId, witness) - (prev ? prev.accountedBytes : 0) + 96;
      if (l0WorkspaceBytes + addedBytes > maxWorkspaceBytes) {
        workspaceBudgetExceeded = true;
        return false;
      }
      l0WorkspaceBytes += addedBytes;
      l0WitnessBytes += addedWitnessBytes;
      frontierExpansionBytes += frontierItemBytes;
      if (frontierExpansionBytes > maxFrontierObservedBytes) {
        maxFrontierObservedBytes = frontierExpansionBytes;
      }

      const nextVersion = prev ? prev.pathVersion + 1 : 1;
      if (prev && prev.poppedOnce && strictlyBetter) reevaluations++;

      stateByNode.set(nodeId, {
        nodeId,
        activation: score,
        pathVersion: nextVersion,
        poppedOnce: prev ? prev.poppedOnce : false,
        accountedBytes: estimateStateBytes(nodeId, witness),
        witness: {
          seedNodeId: witness.seedNodeId,
          directScore: witness.directScore,
          edgeChain: [...witness.edgeChain],
          visitedNodes: new Set(witness.visitedNodes),
          basisIds: [...witness.basisIds],
          sourceDependencies: [...witness.sourceDependencies]
        }
      });
      frontier.push({ nodeId, version: nextVersion, activation: score });
      return true;
    };

    const maxPossibleIdf = Math.max(1, queryFrame.tokens.length * Math.log(1 + totalUnits));
    for (const node of graph.nodes || []) {
      if (!isNodeEligible(node.id)) continue;
      const unit = unitByNodeId.get(node.id);
      const feat = rawFeatures.get(node.id);
      if (node.layer === 'entity') {
        const matched = resolvedEntityIds.includes(node.id)
          || (feat && feat.matchedEntities.size > 0);
        if (matched) {
          directFeaturesByNode.set(node.id, {
            directScore: 0.90,
            lexicalScore: 0,
            semanticScore: null,
            semanticFeatureStatus: 'unavailable',
            entitySlotScore: 1,
            predicateScore: 0,
            roleWeight: 0.90,
            mandatoryInclusion: false
          });
          offer(node.id, 0.90, {
            seedNodeId: node.id,
            directScore: 0.90,
            edgeChain: [],
            visitedNodes: [node.id],
            basisIds: [],
            sourceDependencies: []
          });
        }
        continue;
      }
      if (!unit) {
        const sem = semanticByNodeId.get(node.id);
        if (node.layer === 'source' && sem?.status === 'available_vector_space' && sem.score > 0) {
          const evaluated = scoreCandidate({ family: 'canonical', semanticRole: 'source_access' },
            { semanticScore: sem.score, semanticFeatureStatus: sem.status }, queryFrame);
          directFeaturesByNode.set(node.id, evaluated);
          offer(node.id, evaluated.directScore, { seedNodeId: node.id, directScore: evaluated.directScore,
            edgeChain: [], visitedNodes: [node.id], basisIds: [], sourceDependencies: [node.id] });
        }
        continue;
      }

      let lexSum = 0;
      if (feat) for (const w of feat.matchedTokens.values()) lexSum += w;
      const lexicalScore = queryFrame.tokens.length ? clamp01(lexSum / maxPossibleIdf) : 0;
      const entityMatches = (feat ? feat.matchedEntities.size : 0)
        + (unit.subjectId && resolvedEntityIds.includes(unit.subjectId) ? 1 : 0)
        + (unit.entityId && resolvedEntityIds.includes(unit.entityId) ? 1 : 0)
        + (unit.targetIds || []).filter(t => resolvedEntityIds.includes(t)).length;
      const entitySlotScore = resolvedEntityIds.length ? clamp01(entityMatches / resolvedEntityIds.length) : (entityMatches > 0 ? 0.7 : 0);
      const predMatches = (feat ? feat.matchedPredicates.size : 0)
        + (unit.field && queryFrame.predicates.includes(unit.field) ? 1 : 0);
      const predicateScore = queryFrame.predicates.length ? clamp01(predMatches / queryFrame.predicates.length) : 0;
      const semInfo = semanticByNodeId.get(node.id) || { score: undefined, status: 'unavailable' };

      const evaluated = scoreCandidate(unit, {
        lexicalScore,
        semanticScore: semInfo.score,
        semanticFeatureStatus: semInfo.status,
        entitySlotScore,
        predicateScore
      }, queryFrame);
      directFeaturesByNode.set(node.id, evaluated);
      if (evaluated.directScore > 0) {
        offer(node.id, evaluated.directScore, {
          seedNodeId: node.id,
          directScore: evaluated.directScore,
          edgeChain: [],
          visitedNodes: [node.id],
          basisIds: [],
          sourceDependencies: node.sourceId ? [node.sourceId] : []
        });
      }
    }

    const sortFrontier = () => {
      frontier.sort((a, b) => (
        b.activation - a.activation
        || a.nodeId.localeCompare(b.nodeId, 'en')
        || a.version - b.version
      ));
    };

    // Phase B (M05): Interleaved Frontier Pop & On-Demand Neighborhood Paging via Memory Lane
    const requestedAdjacencyAnchors = new Set();
    let frontierStopReason = workspaceBudgetExceeded ? 'workspace_byte_budget'
      : witnessBudgetExceeded ? 'witness_byte_budget'
      : frontierBudgetExceeded ? 'frontier_byte_budget'
      : 'frontier_exhausted';

    while (frontier.length > 0) {
      if (laneSession.isBudgetStopped()) {
        frontierStopReason = 'lane_budget_stopped';
        break;
      }
      if (workspaceBudgetExceeded) {
        frontierStopReason = 'workspace_byte_budget';
        break;
      }
      if (witnessBudgetExceeded) {
        frontierStopReason = 'witness_byte_budget';
        break;
      }
      if (frontierBudgetExceeded) {
        frontierStopReason = 'frontier_byte_budget';
        break;
      }
      sortFrontier();
      const top = frontier.shift();
      frontierExpansionBytes = Math.max(0, frontierExpansionBytes - estimateFrontierItemBytes(top.nodeId));
      const current = stateByNode.get(top.nodeId);
      if (!current || current.pathVersion !== top.version) continue;
      if (poppedSteps >= queryFrame.maxFrontierSteps) {
        frontierStopReason = 'frontier_step_budget';
        break;
      }

      if (current.witness.edgeChain.length < queryFrame.maxHops && !requestedAdjacencyAnchors.has(top.nodeId)) {
        requestedAdjacencyAnchors.add(top.nodeId);
        laneSession.enqueue({
          laneRole: 'graph_neighborhood',
          table: 'adjacency',
          anchorNodeId: top.nodeId,
          structuralOnly: false,
          priorityHint: current.activation,
          requesterId: `frontier:${top.nodeId}`
        });
        const stepDrain = yield laneSession;
        ingestAccesses(stepDrain.newAccesses);
        if (stepDrain.stoppedByBudget) {
          frontier.unshift(top);
          frontierStopReason = 'lane_budget_stopped';
          break;
        }
      }

      current.poppedOnce = true;
      poppedSteps++;

      if (current.witness.edgeChain.length >= queryFrame.maxHops) continue;

      const adjRows = outgoingByNode.get(top.nodeId) || [];
      const deg = degreeByNode.get(top.nodeId) || 1;
      const currentNode = nodeById.get(top.nodeId);
      const hubDamping = currentNode?.layer === 'entity' && deg > 2
        ? 1 / (1 + 0.12 * Math.log2(deg))
        : 1.0;

      for (const row of adjRows) {
        const targetId = row.neighborNodeId;
        if (!isNodeEligible(targetId)) continue;
        if (current.witness.visitedNodes.has(targetId)) continue;

        const edge = edgeById.get(row.edgeId);
        if (!isEdgeEligible(edge)) continue;
        const basis = basisById.get(row.basisId);
        const baseWeight = predicateWeights[row.predicate] ?? 0.65;
        const dirFactor = row.direction === 'out' ? 1.0 : 0.92;
        const edgeWeight = clamp01(baseWeight * dirFactor * hubDamping);

        const targetNode = nodeById.get(targetId);
        const targetUnit = unitByNodeId.get(targetId);
        let targetFit = 0.90;
        if (targetNode?.layer === 'entity') targetFit = 0.95;
        else if (targetNode?.layer === 'source') targetFit = 0.78;
        else if (targetUnit?.semanticRole === 'state_unprovenanced') targetFit = 0.55;
        else if (targetUnit) targetFit = 0.95;

        const propagated = current.activation * queryFrame.lambda * edgeWeight * targetFit;
        const nextChain = [
          ...current.witness.edgeChain,
          {
            edgeId: row.edgeId,
            from: top.nodeId,
            to: targetId,
            direction: row.direction,
            predicate: row.predicate,
            basisId: row.basisId,
            basisKind: basis?.kind || 'unknown'
          }
        ];
        const nextBases = current.witness.basisIds.includes(row.basisId)
          ? current.witness.basisIds
          : [...current.witness.basisIds, row.basisId];
        const nextDeps = new Set(current.witness.sourceDependencies);
        if (targetNode?.sourceId) nextDeps.add(targetNode.sourceId);
        if (basis?.sourceId) nextDeps.add(basis.sourceId);

        offer(targetId, propagated, {
          seedNodeId: current.witness.seedNodeId,
          directScore: current.witness.directScore,
          edgeChain: nextChain,
          visitedNodes: [...current.witness.visitedNodes, targetId],
          basisIds: nextBases,
          sourceDependencies: [...nextDeps]
        });
        if (workspaceBudgetExceeded || witnessBudgetExceeded || frontierBudgetExceeded) break;
      }
      if (workspaceBudgetExceeded) {
        frontierStopReason = 'workspace_byte_budget';
        break;
      }
      if (witnessBudgetExceeded) {
        frontierStopReason = 'witness_byte_budget';
        break;
      }
      if (frontierBudgetExceeded) {
        frontierStopReason = 'frontier_byte_budget';
        break;
      }
    }

    const familySeen = new Map();
    const candidates = [];
    for (const unit of graph.units || []) {
      if (!isNodeEligible(unit.nodeId)) continue;
      const node = nodeById.get(unit.nodeId);
      const actState = stateByNode.get(unit.nodeId);
      const semInfo = semanticByNodeId.get(unit.nodeId) || { score: undefined, status: 'unavailable' };
      const directFeat = directFeaturesByNode.get(unit.nodeId) || scoreCandidate(unit, { semanticFeatureStatus: semInfo.status }, queryFrame);
      if (!actState && !directFeat.mandatoryInclusion) continue;

      const finalScore = actState ? actState.activation : 0;
      const derivedEdges = (graph.edges || []).filter(e => e.from === unit.nodeId && e.predicate === 'derived_from' && isEdgeEligible(e));
      const familyAnchor = derivedEdges.length === 1
        ? `family:derived:${derivedEdges[0].to}`
        : `family:unit:${unit.nodeId}`;

      const existingFamily = familySeen.get(familyAnchor);
      const corroboratingCount = existingFamily ? existingFamily.count + 1 : 1;
      familySeen.set(familyAnchor, { count: corroboratingCount });

      candidates.push({
        nodeId: unit.nodeId,
        sourceId: node?.sourceId || null,
        family: unit.family,
        kind: node?.kind || null,
        semanticRole: unit.semanticRole || null,
        availability: unit.availability || null,
        provenanceStatus: unit.provenanceStatus || null,
        turn: resolveUnitTurn(unit),
        text: unit.text || '',
        score: Number(finalScore.toFixed(6)),
        directScore: Number(directFeat.directScore.toFixed(6)),
        propagatedScore: Number((actState && actState.witness.edgeChain.length > 0 ? actState.activation : 0).toFixed(6)),
        mandatoryInclusion: directFeat.mandatoryInclusion,
        semanticFeatureStatus: directFeat.semanticFeatureStatus,
        evidenceFamilyId: familyAnchor,
        independentEvidenceCount: 1,
        pathVersion: actState ? actState.pathVersion : 0,
        winningWitness: actState ? {
          seedNodeId: actState.witness.seedNodeId,
          hopCount: actState.witness.edgeChain.length,
          edgeChain: actState.witness.edgeChain,
          basisIds: actState.witness.basisIds,
          sourceDependencies: actState.witness.sourceDependencies
        } : {
          seedNodeId: unit.nodeId,
          hopCount: 0,
          edgeChain: [],
          basisIds: [],
          sourceDependencies: node?.sourceId ? [node.sourceId] : []
        }
      });
    }

    candidates.sort((a, b) => (
      b.score - a.score
      || (a.mandatoryInclusion === b.mandatoryInclusion ? 0 : a.mandatoryInclusion ? -1 : 1)
      || a.nodeId.localeCompare(b.nodeId, 'en')
    ));

    const laneReport = typeof laneSession.finalize === 'function' ? laneSession.finalize() : laneSession.drain();

    // D05: Distinguish local frontier/lane traversal completion from source projection / inventory truncation
    const truncationReasons = new Set([
      'node_work_budget',
      'micro_pages_unread',
      'canonical_pages_unread',
      'canonical_readback_unavailable',
      'typed_schema_unavailable',
      'inherited_micro_projection_not_yet_supported',
      'lore_pages_unread',
      'reader_unavailable',
      'state_view_unavailable',
      'source_head_record_binding_unavailable',
      'record_ref_mismatch',
      'exact_source_span_invalid',
      'source_only_representation_invalid',
      'verified_claims_unavailable',
      'entry_rendering_unavailable',
      'rendered_passage_locator_invalid',
      'claim_schema_or_identity_ambiguous',
      'claim_evidence_unavailable',
      'field_value_clear_conflict',
      'correction_field_basis_unresolved'
    ]);
    const familyEntries = Object.entries(graph.coverage?.families || {});
    const familyTruncations = familyEntries
      .map(([family, f]) => ({
        family,
        reasons: (Array.isArray(f?.reasons) ? f.reasons : []).filter(r => truncationReasons.has(r) || /budget|unread/i.test(String(r)))
      }))
      .filter(f => f.reasons.length > 0);
    const familyNotes = familyEntries
      .filter(([, f]) => Array.isArray(f?.reasons) && f.reasons.length > 0)
      .map(([family, f]) => ({ family, reasons: [...f.reasons] }));
    const unreadInventoryCursors = Object.entries(graph.coverage?.inventory || {})
      .filter(([k, v]) => k.endsWith('NextCursor') && Boolean(v))
      .map(([cursorKey, cursor]) => ({ cursorKey, cursor }));
    const explicitIncompleteWithoutReasons = graph.coverage?.projectionComplete === false && familyNotes.length === 0;
    const sourceCoverageComplete = familyTruncations.length === 0
      && !(graph.coverage?.sourceReadFailures?.length > 0)
      && unreadInventoryCursors.length === 0
      && !explicitIncompleteWithoutReasons && !view.historicalCanonicalUnavailable;
    const traversalComplete = laneReport.complete && frontierStopReason === 'frontier_exhausted'
      && !workspaceBudgetExceeded && !witnessBudgetExceeded && !frontierBudgetExceeded;
    const complete = traversalComplete && sourceCoverageComplete;
    const stopReason = !laneReport.complete
      ? `lane_${laneReport.stopReason}`
      : (frontierStopReason !== 'frontier_exhausted'
        ? frontierStopReason
        : (!sourceCoverageComplete ? 'projection_coverage_incomplete' : 'frontier_exhausted'));

    return Object.freeze({
      schema,
      policyVersion,
      generation: compiledIndex.generation,
      indexDigest: compiledIndex.indexDigest,
      frameId: queryFrame.frameId,
      complete,
      traversalComplete,
      sourceCoverageComplete,
      stopReason,
      historicalStateUnavailable: view.getHistoricalStateUnavailable(),
      historicalCanonicalUnavailable: view.historicalCanonicalUnavailable,
      coverage: {
        projectionComplete: Boolean(graph.coverage?.projectionComplete !== false && sourceCoverageComplete),
        inventoryComplete: Boolean(graph.coverage?.inventory?.inventoryComplete),
        familyIncompleteReasons: familyTruncations,
        familyNotes,
        sourceReadFailures: graph.coverage?.sourceReadFailures || [],
        unreadInventoryCursors,
        historicalCanonicalUnavailable: view.historicalCanonicalUnavailable
      },
      candidates,
      diagnostics: {
        poppedFrontierSteps: poppedSteps,
        improvedPathReevaluations: reevaluations,
        onDemandNeighborhoodAnchors: requestedAdjacencyAnchors.size,
        resolvedEntityIds,
        ambiguousAliases,
        semanticDiagnostics,
        l0WorkspaceBytes,
        maxWorkspaceBytes,
        l0WitnessBytes,
        maxWitnessBytes,
        frontierExpansionBytes: maxFrontierObservedBytes,
        maxFrontierBytes,
        sourceReadJsonBytes: graph.coverage?.sourceReadJsonBytes ?? null,
        sourceReadJsonBudget,
        ownerIoInFlightBytes: laneReport.bytesRead,
        ownerIoInFlightBudget: ownerIoInFlightBudget ?? maxBytes,
        writeBarrierBytes: compiledIndex.writeBarrierBytes ?? 0,
        writeBarrierBudget,
        lanePagesRead: laneReport.pagesRead,
        storage: laneReport.storage || null,
        laneBytesRead: laneReport.bytesRead,
        laneMaxBytes: maxBytes,
        laneCacheHits: laneReport.cacheHits || 0,
        laneCoalescedRequests: laneReport.coalescedRequests,
        laneRoleStats: laneReport.roleStats || null,
        unreadCursors: laneReport.unreadCursors,
        unreadInventoryCursors,
        historicalCanonicalUnavailable: view.historicalCanonicalUnavailable
      },
      // N01 completion: what this query actually read, assembled only from values this call already
      // produced (no new measurement). It describes the read path and grants nothing: authority stays
      // descriptive and modelDispatchEligible stays false.
      accessTrace: Object.freeze({
        schema: 'libra.graph_access_trace.v1',
        authority: 'descriptive_only',
        generation: compiledIndex.generation,
        indexDigest: compiledIndex.indexDigest,
        lane: Object.freeze({
          pagesRead: laneReport.pagesRead,
          storage: laneReport.storage || null,
          bytesRead: laneReport.bytesRead,
          maxBytes,
          cacheHits: laneReport.cacheHits || 0,
          coalescedRequests: laneReport.coalescedRequests,
          complete: laneReport.complete,
          stopReason: laneReport.stopReason || '',
          roleStats: laneReport.roleStats || null,
          unreadCursors: laneReport.unreadCursors || []
        }),
        frontier: Object.freeze({
          steps: poppedSteps,
          reevaluations,
          onDemandNeighborhoodAnchors: requestedAdjacencyAnchors.size
        }),
        workspace: Object.freeze({
          l0WorkspaceBytes,
          maxWorkspaceBytes,
          exceeded: workspaceBudgetExceeded,
          l0WitnessBytes,
          maxWitnessBytes,
          witnessExceeded: witnessBudgetExceeded,
          frontierExpansionBytes: maxFrontierObservedBytes,
          maxFrontierBytes,
          frontierExceeded: frontierBudgetExceeded
        }),
        coverage: Object.freeze({
          complete, sourceCoverageComplete, traversalComplete, stopReason,
          familyNotes, unreadInventoryCursors,
          sourceReadFailures: graph.coverage?.sourceReadFailures || [],
          historicalCanonicalUnavailable: view.historicalCanonicalUnavailable
        })
      }),
      authority: 'descriptive_only',
      modelDispatchEligible: false
    });
  };

  // One frontier/scorer algorithm, with synchronous and awaited page drivers.
  const retrieve = (...args) => {
    const work = retrieveSteps(...args); let next = work.next();
    while (!next.done) next = work.next(next.value.drainPending());
    return next.value;
  };
  const retrieveAsync = async (...args) => {
    const work = retrieveSteps(...args); let next = work.next();
    while (!next.done) next = work.next(await next.value.drainPendingAsync());
    return next.value;
  };
  return Object.freeze({ sealQueryFrame, openView, scoreCandidate, retrieve, retrieveAsync });
};
