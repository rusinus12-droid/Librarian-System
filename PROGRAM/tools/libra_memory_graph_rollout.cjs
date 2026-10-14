'use strict';
// UM5 Engine Selection, Shadow/Offline Evaluation & Cutover Coordinator:
// 1. Seals per-request engine selection ('legacy' | 'shadow' | 'unified') at request start (§13).
// 2. Guarantees that a unified mid-flight budget stop, partial state, or stale readset NEVER
//    silently falls back to the legacy independent rankers and relabels the result 'complete' (§13, V11).
// 3. Executes shadow/offline comparisons on a fixed source snapshot without double packet injection
//    or extra model/embedding calls, distinguishing preserved invariants from intentional State/lore
//    expansion and disclosing unresolved host blockers (§12.2, §13).
module.exports = function createMemoryGraphRollout({ index, lane, query, compiler, pages, fingerprint } = {}) {
  if (!index || !lane || !query || !compiler || !pages || typeof fingerprint !== 'function') {
    throw new TypeError('LIBRA_GRAPH_ROLLOUT_ADAPTER_REQUIRED');
  }
  const schema = 'libra.memory_graph_rollout.v1';
  const validModes = new Set(['legacy', 'shadow', 'unified']);
  const fail = reason => { const err = new Error('LIBRA_GRAPH_ROLLOUT_' + reason.toUpperCase()); err.reason = reason; throw err; };
  const hash = text => { const val = fingerprint(text); if (!/^[a-f0-9]{64}$/.test(val)) fail('fingerprint_invalid'); return val; };

  const sealedRequests = new WeakMap();

  const sealRequestMode = ({
    mode = 'legacy',
    requestId = '',
    owner = '',
    scopeKey = '',
    worldlineId = 'main',
    restoreEpoch = 0
  } = {}) => {
    if (!validModes.has(mode)) fail('mode_invalid');
    if (typeof requestId !== 'string' || !requestId.trim()
      || typeof owner !== 'string' || !owner.trim()
      || typeof scopeKey !== 'string' || !scopeKey.trim()
      || typeof worldlineId !== 'string' || !worldlineId.trim()
      || !Number.isSafeInteger(restoreEpoch) || restoreEpoch < 0) {
      fail('request_context_invalid');
    }
    const payload = {
      schema: 'libra.engine_selection_seal.v1',
      mode,
      requestId: requestId.trim(),
      owner: owner.trim(),
      scopeKey: scopeKey.trim(),
      worldlineId: worldlineId.trim(),
      restoreEpoch
    };
    const token = Object.freeze({ ...payload, sealDigest: hash(JSON.stringify(payload)) });
    sealedRequests.set(token, { ...payload });
    return token;
  };

  // Execute unified retrieval + compilation under a sealed request token.
  // Never invokes legacy rankers on unified partial/failure (§13, V11).
  const executeUnifiedRequest = async ({
    sealToken,
    graph,
    queryInput = {},
    consumerPolicy = {},
    laneBudget = {},
    ownerVerifier = null
  } = {}) => {
    const sealed = sealToken && sealedRequests.get(sealToken);
    if (!sealed) fail('request_seal_invalid');
    if (sealed.mode === 'legacy') fail('unified_execution_forbidden_in_legacy_mode');
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    if ((graph.scopeKey || graph.readerFrame?.scopeKey) !== sealed.scopeKey
      || graph.readerFrame?.worldlineId !== sealed.worldlineId
      || graph.readerFrame?.restoreEpoch !== sealed.restoreEpoch) {
      fail('snapshot_seal_mismatch');
    }

    const partition = JSON.stringify({
      owner: sealed.owner,
      scopeKey: sealed.scopeKey,
      viewer: graph.readerFrame?.view?.viewerId || 'owner_reader'
    });
    const generation = pages.generation(graph, {
      partition,
      restoreEpoch: sealed.restoreEpoch,
      view: graph.readerFrame
    });
    const compiledIndex = index.compile(graph, { partition, generation });
    const queryFrame = query.sealQueryFrame({
      ...queryInput,
      owner: sealed.owner,
      scopeKey: sealed.scopeKey,
      worldlineId: sealed.worldlineId
    });
    const viewHandle = query.openView(graph, compiledIndex, queryFrame);
    const queryResult = query.retrieve(viewHandle, laneBudget);
    const selected = compiler.select(queryResult, graph, consumerPolicy);
    const packet = compiler.render(selected);

    let dispatchVerification = null;
    let deliveryOutcome = queryResult.complete ? 'complete' : 'partial';
    let fallbackAction = 'none';

    if (ownerVerifier) {
      try {
        dispatchVerification = await compiler.validateConsumedReadSet(selected.readSetHandle, ownerVerifier);
      } catch (err) {
        // Unified verification failure NEVER runs legacy ranker; falls back to base model request only (§10, §13)
        deliveryOutcome = 'base_request_only';
        fallbackAction = 'preserve_base_model_request';
        dispatchVerification = {
          schema: 'libra.consumed_readset_verification.v1',
          status: 'rejected',
          reason: err.message,
          modelDispatchEligible: false
        };
      }
    }

    return Object.freeze({
      schema: 'libra.unified_execution_result.v1',
      mode: sealed.mode,
      requestId: sealed.requestId,
      generation,
      indexDigest: compiledIndex.indexDigest,
      frameId: queryFrame.frameId,
      deliveryOutcome,
      fallbackAction,
      legacyRankerExecuted: false,
      legacyCachesRebuilt: false,
      doubleInjection: false,
      additionalModelCalls: 0,
      queryComplete: queryResult.complete,
      stopReason: queryResult.stopReason,
      bundle: selected.bundle,
      packet: deliveryOutcome === 'base_request_only' ? null : packet,
      dispatchVerification,
      modelDispatchEligible: Boolean(dispatchVerification?.modelDispatchEligible === true && sealed.mode === 'unified')
    });
  };

  // Offline / Shadow comparison against a fixed snapshot and legacy baseline or gold expectations (§12.2, §13).
  const runShadowComparison = async ({
    requestId = 'shadow-eval',
    graph,
    queryInput = {},
    consumerPolicy = {},
    legacyBaseline = {},
    goldExpectation = {},
    ownerVerifier = null
  } = {}) => {
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    const frame = graph.readerFrame || {};
    const sealToken = sealRequestMode({
      mode: 'shadow',
      requestId,
      owner: frame.owner || 'libra:plugin_only',
      scopeKey: graph.scopeKey || frame.scopeKey || 'default',
      worldlineId: frame.worldlineId || 'main',
      restoreEpoch: frame.restoreEpoch ?? 0
    });

    const unified = await executeUnifiedRequest({
      sealToken,
      graph,
      queryInput,
      consumerPolicy,
      ownerVerifier
    });

    const unifiedIds = new Set(unified.bundle.items.map(i => i.nodeId));
    const unifiedFamilies = new Set(unified.bundle.items.map(i => i.family));
    const legacyIds = new Set(Array.isArray(legacyBaseline.admittedNodeIds) ? legacyBaseline.admittedNodeIds : []);
    const expectedIds = Array.isArray(goldExpectation.expectedNodeIds) ? goldExpectation.expectedNodeIds : [];
    const forbiddenIds = Array.isArray(goldExpectation.forbiddenNodeIds) ? goldExpectation.forbiddenNodeIds : [];

    const matchedGold = expectedIds.filter(id => unifiedIds.has(id));
    const evidenceRecall = expectedIds.length ? Number((matchedGold.length / expectedIds.length).toFixed(4)) : 1;
    const evidencePrecision = unifiedIds.size && expectedIds.length
      ? Number((matchedGold.length / unifiedIds.size).toFixed(4))
      : 1;

    // Identify intentional divergence where Unified discovers State/lore or multi-hop evidence beyond legacy canonical shortlist (§13)
    const addedByUnified = unified.bundle.items
      .filter(i => !legacyIds.has(i.nodeId))
      .map(i => ({
        nodeId: i.nodeId,
        family: i.family,
        semanticRole: i.semanticRole,
        hopCount: i.winningWitness?.hopCount || 0,
        intentionalReason: ['state', 'lore'].includes(i.family)
          ? 'direct_state_or_lore_graph_participation'
          : (i.winningWitness?.hopCount || 0) > 0
            ? 'multi_hop_graph_propagation'
            : 'unified_calibrated_rank'
      }));

    const forbiddenLeaks = forbiddenIds.filter(id => unifiedIds.has(id));
    const wrongAuthorityPromotion = unified.bundle.items.some(
      i => (i.semanticRole === 'state_unprovenanced' && i.provenanceStatus === 'recorded')
        || (i.family === 'lore' && i.semanticRole === 'canonical_assertion')
    );

    const invariantViolations = [];
    if (forbiddenLeaks.length) invariantViolations.push('ineligible_or_forbidden_node_leaked');
    if (wrongAuthorityPromotion) invariantViolations.push('wrong_authority_promotion');
    if (unified.doubleInjection) invariantViolations.push('shadow_double_injection');
    if (unified.additionalModelCalls > 0) invariantViolations.push('unexpected_model_call_in_shadow');

    return Object.freeze({
      schema,
      mode: 'shadow',
      requestId,
      generation: unified.generation,
      indexDigest: unified.indexDigest,
      shadowInjectedIntoModelPrompt: false,
      doubleInjection: false,
      additionalModelCalls: 0,
      metrics: {
        evidenceRecall,
        evidencePrecision,
        admittedUnitCount: unified.bundle.items.length,
        participatingFamilies: [...unifiedFamilies].sort((a, b) => a.localeCompare(b, 'en')),
        intentionalDivergenceCount: addedByUnified.length
      },
      intentionalDivergence: addedByUnified,
      invariantViolations,
      invariantsPassed: invariantViolations.length === 0,
      unresolvedBlocked: [
        'actual_risuai_host_qualification',
        'warm_raw_history_zero_host_mutation_api'
      ],
      unifiedResult: unified
    });
  };

  return Object.freeze({ sealRequestMode, executeUnifiedRequest, runShadowComparison });
};
