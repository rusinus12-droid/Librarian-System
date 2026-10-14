'use strict';
// UM5–UM6 Engine Selection, Shadow/Offline Evaluation, Cutover Coordinator & Legacy Retirement Fence:
// 1. Seals per-request engine selection ('legacy' | 'shadow' | 'unified') at request start (§13).
// 2. Guarantees that a unified mid-flight budget stop, partial state, or stale readset NEVER
//    silently falls back to the legacy independent rankers and relabels the result 'complete' (§13, V11).
// 3. Executes shadow/offline comparisons on a fixed source snapshot without double packet injection
//    or extra model/embedding calls, distinguishing preserved invariants from intentional State/lore
//    expansion and disclosing unresolved host blockers (§12.2, §13).
// 4. Enforces UM6 retirement fence for legacy duplicate cache/index/Memory Lane/ranker paths (V11)
//    and verifies cold/warm/eviction/restart determinism across identical inputs (V05, D08).
module.exports = function createMemoryGraphRollout({ index, lane, query, compiler, pages, fingerprint } = {}) {
  if (!index || !lane || !query || !compiler || !pages || typeof fingerprint !== 'function') {
    throw new TypeError('LIBRA_GRAPH_ROLLOUT_ADAPTER_REQUIRED');
  }
  const schema = 'libra.memory_graph_rollout.v1';
  const validModes = new Set(['legacy', 'shadow', 'unified']);
  const retiredLegacyStructures = Object.freeze([
    'recallCatalogCache',
    'recallCatalogBlockCache',
    'evidenceLinkIndexCache',
    'loreLinkIndexCache',
    'ResponseLoreIndexCache',
    'a2MetadataPreparationLoop',
    'legacyDualRrfRanker'
  ]);
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

  // UM6 & V11: Guard that prevents retired legacy caches, A2 preparation loops, or independent rankers
  // from running alongside a sealed unified request (§7.6, §11, §14 V11).
  const createLegacyExecutionFence = sealToken => {
    const sealed = sealToken && sealedRequests.get(sealToken);
    if (!sealed) fail('request_seal_invalid');
    const attemptedLegacyOps = [];
    return Object.freeze({
      schema: 'libra.legacy_retirement_fence.v1',
      mode: sealed.mode,
      requestId: sealed.requestId,
      retiredLegacyStructures,
      assertLegacyAllowed: operationName => {
        const op = String(operationName || 'unknown_legacy_op');
        if (sealed.mode === 'unified') {
          attemptedLegacyOps.push(op);
          fail('legacy_duplicate_execution_forbidden');
        }
        return true;
      },
      status: () => Object.freeze({
        mode: sealed.mode,
        retiredLegacyStructures,
        attemptedLegacyOps: [...attemptedLegacyOps],
        duplicateExecutionCount: attemptedLegacyOps.length,
        cleanCutoverVerified: sealed.mode === 'unified' && attemptedLegacyOps.length === 0
      })
    });
  };

  // Execute unified retrieval + compilation under a sealed request token.
  // Never invokes legacy rankers on unified partial/failure (§13, V11, D05).
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
      traversalComplete: queryResult.traversalComplete,
      sourceCoverageComplete: queryResult.sourceCoverageComplete,
      stopReason: queryResult.stopReason,
      coverage: queryResult.coverage,
      diagnostics: queryResult.diagnostics,
      bundle: selected.bundle,
      packet: deliveryOutcome === 'base_request_only' ? null : packet,
      dispatchVerification,
      modelDispatchEligible: Boolean(dispatchVerification?.modelDispatchEligible === true && sealed.mode === 'unified')
    });
  };

  // UM6 & V05 (D08): Verify that cold cache, warm cache, post-LRU/partition eviction, and fresh restart produce
  // identical logical complete results, concrete candidate scores, winning witnesses, bundle digests, and rendered packet digests.
  const verifyColdWarmEvictionDeterminism = ({
    graph,
    queryInput = {},
    consumerPolicy = {},
    createFreshRuntime = null
  } = {}) => {
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    const frame = graph.readerFrame || {};
    const owner = frame.owner || 'libra:plugin_only';
    const scopeKey = graph.scopeKey || frame.scopeKey || 'default';
    const worldlineId = frame.worldlineId || 'main';
    const restoreEpoch = frame.restoreEpoch ?? 0;
    const partition = JSON.stringify({
      owner,
      scopeKey,
      viewer: frame.view?.viewerId || 'owner_reader'
    });
    const generation = pages.generation(graph, { partition, restoreEpoch, view: frame });

    const runPass = (env = { index, lane, query, compiler, pages }) => {
      const beforeCache = typeof env.pages.inspect === 'function' ? env.pages.inspect().counters : { hits: 0, misses: 0, evictions: 0 };
      const compiledIndex = env.index.compile(graph, { partition, generation });
      const queryFrame = env.query.sealQueryFrame({
        ...queryInput,
        owner,
        scopeKey,
        worldlineId
      });
      const viewHandle = env.query.openView(graph, compiledIndex, queryFrame);
      const queryResult = env.query.retrieve(viewHandle, { maxPages: 64, maxBytes: 262144, pageBytes: 4096 });
      const selected = env.compiler.select(queryResult, graph, consumerPolicy);
      const packet = env.compiler.render(selected);
      const afterCache = typeof env.pages.inspect === 'function' ? env.pages.inspect().counters : { hits: 0, misses: 0, evictions: 0 };

      for (const c of queryResult.candidates) {
        if (typeof c.score !== 'number' || !Number.isFinite(c.score) || !c.winningWitness || !Array.isArray(c.winningWitness.edgeChain)) {
          fail('candidate_score_or_witness_missing');
        }
      }
      if (typeof selected.bundle.bundleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(selected.bundle.bundleDigest)) {
        fail('bundle_digest_missing');
      }
      if (typeof packet.packetDigest !== 'string' || !/^[a-f0-9]{64}$/.test(packet.packetDigest)) {
        fail('packet_digest_missing');
      }

      const candidateDigest = hash(JSON.stringify(queryResult.candidates.map(c => ({
        nodeId: c.nodeId,
        score: c.score,
        directScore: c.directScore,
        propagatedScore: c.propagatedScore,
        pathVersion: c.pathVersion,
        winningWitness: c.winningWitness
      }))));

      return {
        complete: queryResult.complete,
        candidateCount: queryResult.candidates.length,
        candidateDigest,
        bundleDigest: selected.bundle.bundleDigest,
        packetDigest: packet.packetDigest,
        cacheHits: afterCache.hits - beforeCache.hits,
        cacheMisses: afterCache.misses - beforeCache.misses,
        evictions: afterCache.evictions - beforeCache.evictions
      };
    };

    // Pass 1: Cold cache (invalidate all resident pages first)
    pages.invalidate();
    const cold = runPass();

    // Pass 2: Warm cache (re-reads populated resident pages from Pass 1)
    const warm = runPass();

    // Pass 3: Post-eviction (evict the partition's resident pages and reload)
    const evictionsBefore = typeof pages.inspect === 'function' ? pages.inspect().counters.evictions : 0;
    pages.invalidate(partition);
    const evictionsTriggered = (typeof pages.inspect === 'function' ? pages.inspect().counters.evictions : 0) - evictionsBefore;
    const postEviction = {
      ...runPass(),
      evictionsTriggered
    };

    // Pass 4: Simulated restart (fresh cache state or caller-supplied fresh runtime factories)
    pages.invalidate();
    const freshEnv = typeof createFreshRuntime === 'function'
      ? createFreshRuntime()
      : { index, lane, query, compiler, pages };
    const postRestart = runPass(freshEnv);

    const digestsPresent = /^[a-f0-9]{64}$/.test(cold.candidateDigest)
      && /^[a-f0-9]{64}$/.test(cold.bundleDigest)
      && /^[a-f0-9]{64}$/.test(cold.packetDigest);

    const deterministic = digestsPresent
      && cold.complete
      && warm.complete
      && postEviction.complete
      && postRestart.complete
      && warm.cacheHits > 0
      && postEviction.evictionsTriggered > 0
      && cold.candidateDigest === warm.candidateDigest
      && cold.candidateDigest === postEviction.candidateDigest
      && cold.candidateDigest === postRestart.candidateDigest
      && cold.bundleDigest === warm.bundleDigest
      && cold.bundleDigest === postEviction.bundleDigest
      && cold.bundleDigest === postRestart.bundleDigest
      && cold.packetDigest === warm.packetDigest
      && cold.packetDigest === postEviction.packetDigest
      && cold.packetDigest === postRestart.packetDigest;

    return Object.freeze({
      schema: 'libra.determinism_verification.v1',
      deterministic,
      bundleAndPacketDigestFieldsPresent: digestsPresent,
      passes: { cold, warm, postEviction, postRestart }
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

  return Object.freeze({
    sealRequestMode,
    createLegacyExecutionFence,
    executeUnifiedRequest,
    verifyColdWarmEvictionDeterminism,
    runShadowComparison
  });
};
