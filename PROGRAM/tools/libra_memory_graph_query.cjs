'use strict';
// UM3 Single Retrieval & Activation Kernel:
// Seals QueryFrame, issues private eligibility-filtered QueryGraphView handles,
// evaluates candidates with a single calibrated scoreCandidate, and runs strongest-path
// activation propagation with improved-path reevaluation (pathVersion) over a single priority frontier.
// Issues no physical delivery proof; final owner readset validation remains mandatory in UM4.
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
  const tokenizer = typeof tokenize === 'function' ? tokenize : defaultTokenize;
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

  const sealQueryFrame = ({
    queryText = '',
    entityIds = [],
    predicates = [],
    owner = '',
    scopeKey = '',
    worldlineId = 'main',
    viewerId = 'owner_reader',
    asOfTurn = null,
    excludedNodeIds = [],
    queryVectors = {},
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

    const tokens = [...new Set(tokenizer(queryText))].sort((a, b) => a.localeCompare(b, 'en'));
    const entities = [...new Set((Array.isArray(entityIds) ? entityIds : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    const preds = [...new Set((Array.isArray(predicates) ? predicates : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    const excluded = [...new Set((Array.isArray(excludedNodeIds) ? excludedNodeIds : []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));

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
      viewerId: viewerId.trim(),
      asOfTurn,
      excludedNodeIds: excluded,
      hasQueryVectors: Object.keys(queryVectors || {}).length > 0,
      lambda,
      epsilon,
      maxFrontierSteps,
      maxHops
    };
    const frameId = hash(JSON.stringify(frame));
    return Object.freeze({ ...frame, frameId, queryVectors: Object.freeze({ ...(queryVectors || {}) }) });
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

    let historicalStateUnavailable = false;
    const isNodeEligible = nodeId => {
      if (!nodeId || excludedSet.has(nodeId)) return false;
      const node = nodeById.get(nodeId);
      if (!node) return false;
      const unit = unitByNodeId.get(nodeId);
      if (!unit) return true;

      if (unit.viewerId && unit.viewerId !== queryFrame.viewerId) return false;
      if (unit.visibility === 'private' && queryFrame.viewerId !== 'owner_reader') return false;

      if (queryFrame.asOfTurn !== null) {
        if (unit.family === 'state') {
          if (Number.isSafeInteger(unit.headThroughTurn) && unit.headThroughTurn > queryFrame.asOfTurn) {
            historicalStateUnavailable = true;
            return false;
          }
        }
        const unitTurn = unit.sourceSpan?.turn
          ?? unit.fact?.evidenceSpans?.[0]?.turn
          ?? (typeof unit.fact?.values?.turn === 'number' ? unit.fact.values.turn : null);
        if (Number.isSafeInteger(unitTurn) && unitTurn > queryFrame.asOfTurn) {
          return false;
        }
      }
      return true;
    };

    const isEdgeEligible = edge => {
      if (!edge) return false;
      if (!isNodeEligible(edge.from) || !isNodeEligible(edge.to)) return false;
      const basis = basisById.get(edge.basisId);
      if (basis?.sourceId && !isNodeEligible(basis.sourceId)) return false;
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
      asOfTurn: queryFrame.asOfTurn
    });

    issuedViews.set(handle, {
      graph,
      compiledIndex,
      queryFrame,
      nodeById,
      unitByNodeId,
      basisById,
      edgeById,
      isNodeEligible,
      isEdgeEligible,
      getHistoricalStateUnavailable: () => historicalStateUnavailable
    });
    return handle;
  };

  const scoreCandidate = (unit, features = {}, queryFrame) => {
    const lexicalScore = clamp01(features.lexicalScore || 0);
    const hasSemantic = typeof features.semanticScore === 'number' && Number.isFinite(features.semanticScore);
    const semanticScore = hasSemantic ? clamp01(features.semanticScore) : 0;
    const entitySlotScore = clamp01(features.entitySlotScore || 0);
    const predicateScore = clamp01(features.predicateScore || 0);

    let roleWeight = 0.85;
    if (unit?.semanticRole === 'user_corrected') roleWeight = 1.0;
    else if (unit?.semanticRole === 'state_current' || unit?.semanticRole === 'canonical_assertion') roleWeight = 0.95;
    else if (unit?.semanticRole === 'micro_candidate' || unit?.semanticRole === 'background_setting') roleWeight = 0.90;
    else if (unit?.semanticRole === 'state_last_known' || unit?.semanticRole === 'source_only' || unit?.semanticRole === 'canonical_legacy_excerpt') roleWeight = 0.82;
    else if (unit?.semanticRole === 'state_unprovenanced') roleWeight = 0.45;

    const combinedSignal = hasSemantic
      ? (0.38 * lexicalScore + 0.32 * semanticScore + 0.20 * entitySlotScore + 0.10 * predicateScore)
      : (0.52 * lexicalScore + 0.33 * entitySlotScore + 0.15 * predicateScore);

    const directScore = clamp01(combinedSignal * roleWeight);
    return {
      directScore,
      lexicalScore,
      semanticScore: hasSemantic ? semanticScore : null,
      semanticFeatureStatus: hasSemantic ? 'available' : 'unavailable',
      entitySlotScore,
      predicateScore,
      roleWeight,
      mandatoryInclusion: Boolean(unit?.activation?.alwaysActive === true || unit?.activation?.hostSelected === true)
    };
  };

  const retrieve = (viewHandle, {
    maxPages = 32,
    maxBytes = 131072,
    pageBytes = 8192
  } = {}) => {
    const view = issuedViews.get(viewHandle);
    if (!view) fail('view_handle_invalid');
    const { graph, compiledIndex, queryFrame, nodeById, unitByNodeId, basisById, edgeById, isNodeEligible, isEdgeEligible } = view;

    const laneSession = lane.createSession(compiledIndex, { maxPages, maxBytes, pageBytes });
    for (const token of queryFrame.tokens) {
      laneSession.enqueue({ laneRole: 'query_anchor_access', table: 'postings', channel: 'lexical', term: token, priorityHint: 1.0, requesterId: `tok:${token}` });
    }
    for (const entId of queryFrame.entityIds) {
      laneSession.enqueue({ laneRole: 'query_anchor_access', table: 'postings', channel: 'entity', term: entId, priorityHint: 1.0, requesterId: `ent:${entId}` });
    }
    for (const pred of queryFrame.predicates) {
      laneSession.enqueue({ laneRole: 'temporal_state_access', table: 'postings', channel: 'predicate', term: pred, priorityHint: 0.9, requesterId: `pred:${pred}` });
    }
    laneSession.enqueue({ laneRole: 'graph_neighborhood', table: 'adjacency', structuralOnly: false, priorityHint: 0.8, requesterId: 'adj:all' });

    const laneReport = laneSession.drain();

    const rawFeatures = new Map();
    const ensureFeat = nodeId => {
      if (!rawFeatures.has(nodeId)) {
        rawFeatures.set(nodeId, { matchedTokens: new Map(), matchedEntities: new Set(), matchedPredicates: new Set() });
      }
      return rawFeatures.get(nodeId);
    };

    const totalUnits = Math.max(1, (graph.units || []).length);
    for (const access of laneReport.accesses) {
      if (access.table !== 'postings') continue;
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
    }

    const outgoingByNode = new Map();
    const degreeByNode = new Map();
    for (const access of laneReport.accesses) {
      if (access.table !== 'adjacency') continue;
      for (const row of access.items) {
        const edge = edgeById.get(row.edgeId);
        if (!isEdgeEligible(edge)) continue;
        if (!outgoingByNode.has(row.anchorNodeId)) outgoingByNode.set(row.anchorNodeId, []);
        outgoingByNode.get(row.anchorNodeId).push(row);
        degreeByNode.set(row.anchorNodeId, (degreeByNode.get(row.anchorNodeId) || 0) + 1);
      }
    }

    const stateByNode = new Map();
    const directFeaturesByNode = new Map();
    const frontier = [];
    let reevaluations = 0;
    let poppedSteps = 0;

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

      const nextVersion = prev ? prev.pathVersion + 1 : 1;
      if (prev && prev.poppedOnce && strictlyBetter) reevaluations++;

      stateByNode.set(nodeId, {
        nodeId,
        activation: score,
        pathVersion: nextVersion,
        poppedOnce: prev ? prev.poppedOnce : false,
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
        const matched = queryFrame.entityIds.includes(node.id)
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
      if (!unit) continue;

      let lexSum = 0;
      if (feat) for (const w of feat.matchedTokens.values()) lexSum += w;
      const lexicalScore = queryFrame.tokens.length ? clamp01(lexSum / maxPossibleIdf) : 0;
      const entityMatches = (feat ? feat.matchedEntities.size : 0)
        + (unit.subjectId && queryFrame.entityIds.includes(unit.subjectId) ? 1 : 0)
        + (unit.entityId && queryFrame.entityIds.includes(unit.entityId) ? 1 : 0)
        + (unit.targetIds || []).filter(t => queryFrame.entityIds.includes(t)).length;
      const entitySlotScore = queryFrame.entityIds.length ? clamp01(entityMatches / queryFrame.entityIds.length) : (entityMatches > 0 ? 0.7 : 0);
      const predMatches = (feat ? feat.matchedPredicates.size : 0)
        + (unit.field && queryFrame.predicates.includes(unit.field) ? 1 : 0);
      const predicateScore = queryFrame.predicates.length ? clamp01(predMatches / queryFrame.predicates.length) : 0;
      const semanticScore = typeof queryFrame.queryVectors?.[node.id] === 'number' ? queryFrame.queryVectors[node.id] : undefined;

      const evaluated = scoreCandidate(unit, { lexicalScore, semanticScore, entitySlotScore, predicateScore }, queryFrame);
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

    let frontierStopReason = 'frontier_exhausted';
    while (frontier.length > 0) {
      sortFrontier();
      const top = frontier.shift();
      const current = stateByNode.get(top.nodeId);
      if (!current || current.pathVersion !== top.version) continue;
      if (poppedSteps >= queryFrame.maxFrontierSteps) {
        frontierStopReason = 'frontier_step_budget';
        break;
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
      }
    }

    const familySeen = new Map();
    const candidates = [];
    for (const unit of graph.units || []) {
      if (!isNodeEligible(unit.nodeId)) continue;
      const node = nodeById.get(unit.nodeId);
      const actState = stateByNode.get(unit.nodeId);
      const directFeat = directFeaturesByNode.get(unit.nodeId) || scoreCandidate(unit, {}, queryFrame);
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

    const traversalComplete = laneReport.complete && frontierStopReason === 'frontier_exhausted';
    return Object.freeze({
      schema,
      policyVersion,
      generation: compiledIndex.generation,
      indexDigest: compiledIndex.indexDigest,
      frameId: queryFrame.frameId,
      complete: traversalComplete,
      stopReason: !laneReport.complete ? `lane_${laneReport.stopReason}` : frontierStopReason,
      historicalStateUnavailable: view.getHistoricalStateUnavailable(),
      candidates,
      diagnostics: {
        poppedFrontierSteps: poppedSteps,
        improvedPathReevaluations: reevaluations,
        lanePagesRead: laneReport.pagesRead,
        laneBytesRead: laneReport.bytesRead,
        laneCoalescedRequests: laneReport.coalescedRequests,
        unreadCursors: laneReport.unreadCursors
      },
      authority: 'descriptive_only',
      modelDispatchEligible: false
    });
  };

  return Object.freeze({ sealQueryFrame, openView, scoreCandidate, retrieve });
};
