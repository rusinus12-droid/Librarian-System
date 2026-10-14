'use strict';
// UM4 Consumer & Final Readset Verification Compiler (EvidenceCompiler):
// 1. Selects an EvidenceBundle from UM3 retrieval candidates under consumer character/unit budgets.
// 2. Enforces conservative Canonical/Micro absorption: a Micro unit is suppressed ONLY when its
//    admitted Canonical counterpart actually survives the character budget; if Canonical drops,
//    Micro remains eligible. When Micro IS absorbed, its source/entity/basis dependencies are
//    retained in the private consumed readset (§10, V09).
// 3. Issues private WeakMap-backed consumed readset handles (never forgeable via JSON clone)
//    and validates physical owner currentness, exact bindings, and nonrewinding restoreEpoch
//    at the final model dispatch boundary (V06, V07, V09, V12).
module.exports = function createMemoryGraphCompiler({ fingerprint } = {}) {
  if (typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_COMPILER_FINGERPRINT_REQUIRED');
  const schema = 'libra.memory_graph_compiler.v1';
  const validConsumers = new Set(['classic', 'planner', 'sga', 'input_writer', 'gui', 'gradia']);
  const fail = reason => { const err = new Error('LIBRA_GRAPH_COMPILER_' + reason.toUpperCase()); err.reason = reason; throw err; };
  const hash = text => { const val = fingerprint(text); if (!/^[a-f0-9]{64}$/.test(val)) fail('fingerprint_invalid'); return val; };

  let issuedReadSets = new WeakMap();
  let compilerEpoch = 0;

  const normalizePolicy = (policy = {}) => {
    const consumer = String(policy.consumer || 'classic');
    if (!validConsumers.has(consumer)) fail('consumer_invalid');
    const maxCharacters = policy.maxCharacters ?? 4096;
    const maxUnits = policy.maxUnits ?? 24;
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32 || maxCharacters > 262144) fail('max_characters_invalid');
    if (!Number.isSafeInteger(maxUnits) || maxUnits < 1 || maxUnits > 256) fail('max_units_invalid');
    if (consumer === 'gradia') {
      const receipt = policy.gradiaSelectionReceipt;
      if (!receipt || typeof receipt !== 'object'
        || typeof receipt.ownerCorpusDigest !== 'string' || !receipt.ownerCorpusDigest.trim()
        || typeof receipt.selectionReceiptId !== 'string' || !receipt.selectionReceiptId.trim()) {
        fail('gradia_receipt_required');
      }
    }
    return {
      consumer,
      maxCharacters,
      maxUnits,
      includeMandatoryLore: policy.includeMandatoryLore !== false,
      correspondenceMap: policy.correspondenceMap && typeof policy.correspondenceMap === 'object' ? policy.correspondenceMap : {},
      gradiaSelectionReceipt: consumer === 'gradia' ? { ...policy.gradiaSelectionReceipt } : null
    };
  };

  const collectCandidateDependencies = (cand, nodeById, basisById, edgeById) => {
    const nodeIds = new Set([cand.nodeId]);
    const sourceIds = new Set();
    const entityIds = new Set();
    const basisIds = new Set(cand.winningWitness?.basisIds || []);
    const bindingByNodeId = new Map();

    const addNode = id => {
      if (!id) return;
      const n = nodeById.get(id);
      if (!n) return;
      nodeIds.add(id);
      bindingByNodeId.set(id, n.bindingId);
      if (n.layer === 'source') sourceIds.add(id);
      else if (n.layer === 'entity') entityIds.add(id);
      if (n.sourceId) {
        sourceIds.add(n.sourceId);
        const sNode = nodeById.get(n.sourceId);
        if (sNode) bindingByNodeId.set(n.sourceId, sNode.bindingId);
      }
    };

    addNode(cand.nodeId);
    for (const sId of cand.winningWitness?.sourceDependencies || []) addNode(sId);
    for (const step of cand.winningWitness?.edgeChain || []) {
      addNode(step.from);
      addNode(step.to);
      if (step.basisId) basisIds.add(step.basisId);
      const edge = edgeById.get(step.edgeId);
      if (edge) {
        addNode(edge.from);
        addNode(edge.to);
      }
    }
    for (const bId of basisIds) {
      const b = basisById.get(bId);
      if (b?.sourceId) addNode(b.sourceId);
    }

    return { nodeIds, sourceIds, entityIds, basisIds, bindingByNodeId };
  };

  // Select an EvidenceBundle under character & unit budgets with conservative Micro absorption (§10, V09)
  const select = (queryResult, graph, rawPolicy = {}) => {
    if (!queryResult || queryResult.schema !== 'libra.memory_graph_query.v1') fail('query_result_invalid');
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    const policy = normalizePolicy(rawPolicy);

    const nodeById = new Map((graph.nodes || []).map(n => [n.id, n]));
    const unitByNodeId = new Map((graph.units || []).map(u => [u.nodeId, u]));
    const basisById = new Map((graph.bases || []).map(b => [b.id, b]));
    const edgeById = new Map((graph.edges || []).map(e => [e.id, e]));

    // Order candidates: mandatory lore first (when enabled by consumer policy), then by query score
    const ordered = [...(queryResult.candidates || [])].sort((a, b) => {
      if (policy.includeMandatoryLore && a.mandatoryInclusion !== b.mandatoryInclusion) {
        return a.mandatoryInclusion ? -1 : 1;
      }
      return b.score - a.score || a.nodeId.localeCompare(b.nodeId, 'en');
    });

    // Separate non-Micro and Micro so we know which Canonical counterparts actually pass budget admission first!
    // If a Canonical candidate drops under budget, its corresponding Micro candidate MUST NOT be suppressed (§10, V09).
    const admitted = [];
    const admittedNodeIds = new Set();
    const droppedForBudget = [];
    const suppressedMicro = [];
    let usedCharacters = 0;

    // Pass 1: admit non-Micro candidates (or all candidates in order, deferring Micro absorption check until after Canonical admission is known)
    // To preserve score ranking while guaranteeing Micro is only absorbed if its Canonical counterpart actually fits the budget,
    // we first simulate admission in rank order, and if a Canonical counterpart is later dropped for budget, any Micro that was
    // provisionally held for absorption is restored!
    const provisionalHeldMicro = [];

    for (const cand of ordered) {
      const textLen = String(cand.text || '').length;
      const counterpartCanonicalId = cand.family === 'micro'
        ? (policy.correspondenceMap[cand.nodeId] || null)
        : null;

      // If this Micro unit has a designated Canonical counterpart that is already admitted, absorb/suppress it now
      if (counterpartCanonicalId && admittedNodeIds.has(counterpartCanonicalId)) {
        suppressedMicro.push({
          microNodeId: cand.nodeId,
          absorbedByCanonicalNodeId: counterpartCanonicalId,
          candidate: cand
        });
        continue;
      }
      // If the Canonical counterpart appears later in the candidate list, hold this Micro provisionally
      if (counterpartCanonicalId && ordered.some(other => other.nodeId === counterpartCanonicalId)) {
        provisionalHeldMicro.push({ cand, counterpartCanonicalId });
        continue;
      }

      if (admitted.length >= policy.maxUnits || usedCharacters + textLen > policy.maxCharacters) {
        droppedForBudget.push({ nodeId: cand.nodeId, family: cand.family, reason: 'budget_exceeded' });
        continue;
      }
      admitted.push(cand);
      admittedNodeIds.add(cand.nodeId);
      usedCharacters += textLen;
    }

    // Resolve provisionally held Micro candidates: if their Canonical counterpart was admitted, absorb them;
    // if the Canonical counterpart was dropped for budget, admit the Micro candidate if budget permits!
    for (const { cand, counterpartCanonicalId } of provisionalHeldMicro) {
      if (admittedNodeIds.has(counterpartCanonicalId)) {
        suppressedMicro.push({
          microNodeId: cand.nodeId,
          absorbedByCanonicalNodeId: counterpartCanonicalId,
          candidate: cand
        });
      } else {
        const textLen = String(cand.text || '').length;
        if (admitted.length < policy.maxUnits && usedCharacters + textLen <= policy.maxCharacters) {
          admitted.push(cand);
          admittedNodeIds.add(cand.nodeId);
          usedCharacters += textLen;
        } else {
          droppedForBudget.push({ nodeId: cand.nodeId, family: cand.family, reason: 'budget_exceeded' });
        }
      }
    }

    // Build consumed dependency sets across BOTH admitted candidates AND suppressed/absorbed Micro candidates (§10, V09)
    const allNodeIds = new Set();
    const allSourceIds = new Set();
    const allEntityIds = new Set();
    const allBasisIds = new Set();
    const requiredBindings = new Map();
    const independentSupportingSources = new Set();

    for (const cand of admitted) {
      const deps = collectCandidateDependencies(cand, nodeById, basisById, edgeById);
      for (const id of deps.nodeIds) allNodeIds.add(id);
      for (const id of deps.sourceIds) {
        allSourceIds.add(id);
        independentSupportingSources.add(id);
      }
      for (const id of deps.entityIds) allEntityIds.add(id);
      for (const id of deps.basisIds) allBasisIds.add(id);
      for (const [k, v] of deps.bindingByNodeId.entries()) requiredBindings.set(k, v);
    }

    for (const item of suppressedMicro) {
      const deps = collectCandidateDependencies(item.candidate, nodeById, basisById, edgeById);
      for (const id of deps.nodeIds) allNodeIds.add(id);
      for (const id of deps.sourceIds) allSourceIds.add(id);
      for (const id of deps.entityIds) allEntityIds.add(id);
      for (const id of deps.basisIds) allBasisIds.add(id);
      for (const [k, v] of deps.bindingByNodeId.entries()) requiredBindings.set(k, v);
      const canonicalNode = nodeById.get(item.absorbedByCanonicalNodeId);
      if (canonicalNode) {
        allNodeIds.add(canonicalNode.id);
        requiredBindings.set(canonicalNode.id, canonicalNode.bindingId);
        if (canonicalNode.sourceId) allSourceIds.add(canonicalNode.sourceId);
      }
    }

    const items = admitted.map(cand => {
      const unit = unitByNodeId.get(cand.nodeId) || {};
      return {
        nodeId: cand.nodeId,
        sourceId: cand.sourceId,
        family: cand.family,
        kind: cand.kind,
        semanticRole: cand.semanticRole,
        availability: cand.availability ?? null,
        provenanceStatus: cand.provenanceStatus ?? null,
        text: cand.text,
        score: cand.score,
        mandatoryInclusion: cand.mandatoryInclusion,
        evidenceFamilyId: cand.evidenceFamilyId,
        sourceSpan: unit.sourceSpan || null,
        locator: unit.locator || null,
        winningWitness: cand.winningWitness
      };
    });

    const bundle = {
      schema: 'libra.evidence_bundle.v1',
      consumer: policy.consumer,
      generation: queryResult.generation,
      indexDigest: queryResult.indexDigest,
      frameId: queryResult.frameId,
      scopeKey: graph.scopeKey || graph.readerFrame?.scopeKey || '',
      worldlineId: graph.readerFrame?.worldlineId || 'main',
      restoreEpoch: graph.readerFrame?.restoreEpoch ?? 0,
      owner: graph.readerFrame?.owner || '',
      historicalStateUnavailable: Boolean(queryResult.historicalStateUnavailable),
      queryComplete: Boolean(queryResult.complete),
      budget: {
        maxCharacters: policy.maxCharacters,
        usedCharacters,
        maxUnits: policy.maxUnits,
        admittedUnits: items.length,
        droppedUnits: droppedForBudget.length,
        suppressedMicroCount: suppressedMicro.length
      },
      independentSupportingSourceCount: independentSupportingSources.size,
      items,
      suppressedMicroIds: suppressedMicro.map(s => s.microNodeId),
      droppedForBudget,
      gradiaSelectionReceipt: policy.gradiaSelectionReceipt,
      authority: 'unverified_bundle',
      modelDispatchEligible: false
    };

    const readSetToken = Object.freeze({
      schema: 'libra.consumed_readset_handle.v1',
      bundleDigest: hash(JSON.stringify(bundle)),
      consumer: policy.consumer,
      scopeKey: bundle.scopeKey
    });

    issuedReadSets.set(readSetToken, {
      compilerEpoch,
      revoked: false,
      bundle,
      policy,
      frame: {
        owner: bundle.owner,
        scopeKey: bundle.scopeKey,
        worldlineId: bundle.worldlineId,
        restoreEpoch: bundle.restoreEpoch
      },
      dependencies: {
        nodeIds: [...allNodeIds].sort((a, b) => a.localeCompare(b, 'en')),
        sourceIds: [...allSourceIds].sort((a, b) => a.localeCompare(b, 'en')),
        entityIds: [...allEntityIds].sort((a, b) => a.localeCompare(b, 'en')),
        basisIds: [...allBasisIds].sort((a, b) => a.localeCompare(b, 'en')),
        requiredBindings: Object.fromEntries([...requiredBindings.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en')))
      }
    });

    return Object.freeze({ bundle: Object.freeze(bundle), readSetHandle: readSetToken });
  };

  // Render consumer packet envelope from selected EvidenceBundle (§10)
  const render = ({ bundle, readSetHandle } = {}) => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    if (!record || record.revoked || record.compilerEpoch !== compilerEpoch) fail('readset_handle_invalid');
    if (!bundle || bundle.schema !== 'libra.evidence_bundle.v1' || hash(JSON.stringify(bundle)) !== readSetHandle.bundleDigest) {
      fail('bundle_mismatch');
    }
    const header = `[LIBRA_EVIDENCE consumer=${bundle.consumer} scope=${bundle.scopeKey} units=${bundle.items.length} sources=${bundle.independentSupportingSourceCount}]`;
    const lines = bundle.items.map((item, idx) => (
      `(${idx + 1}) [${item.family}:${item.semanticRole || item.kind}] ${item.text}`
    ));
    const renderedText = [header, ...lines].join('\n');
    return Object.freeze({
      schema: 'libra.rendered_consumer_packet.v1',
      consumer: bundle.consumer,
      scopeKey: bundle.scopeKey,
      worldlineId: bundle.worldlineId,
      renderedText,
      characterLength: renderedText.length,
      admittedNodeIds: bundle.items.map(i => i.nodeId),
      suppressedMicroIds: bundle.suppressedMicroIds,
      gradiaSelectionReceipt: bundle.gradiaSelectionReceipt,
      readSetHandle,
      modelDispatchEligible: false
    });
  };

  // Final physical readset verification at model dispatch boundary (§10, §11, V06, V07, V09, V12)
  const validateConsumedReadSet = async (readSetHandle, ownerVerifier = {}) => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    if (!record || record.revoked || record.compilerEpoch !== compilerEpoch) fail('readset_handle_invalid');
    if (!ownerVerifier || typeof ownerVerifier.currentGraph !== 'function') fail('owner_verifier_required');

    const live = await ownerVerifier.currentGraph();
    if (!live || live.schema !== 'libra.memory_graph_projection.v1') fail('live_graph_unavailable');

    const liveFrame = live.readerFrame || {};
    if (liveFrame.owner !== record.frame.owner
      || (live.scopeKey || liveFrame.scopeKey) !== record.frame.scopeKey
      || liveFrame.worldlineId !== record.frame.worldlineId) {
      fail('scope_or_owner_changed');
    }
    if (liveFrame.restoreEpoch !== record.frame.restoreEpoch) {
      fail('restore_epoch_changed');
    }

    const liveNodeBindings = new Map((live.nodes || []).map(n => [n.id, n.bindingId]));
    for (const [nodeId, expectedBindingId] of Object.entries(record.dependencies.requiredBindings)) {
      const actualBindingId = liveNodeBindings.get(nodeId);
      if (!actualBindingId || actualBindingId !== expectedBindingId) {
        fail('dependency_binding_stale');
      }
    }

    if (record.policy.consumer === 'gradia') {
      if (typeof ownerVerifier.verifyGradiaReceipt !== 'function') fail('gradia_verifier_required');
      const ok = await ownerVerifier.verifyGradiaReceipt(record.policy.gradiaSelectionReceipt);
      if (ok !== true) fail('gradia_receipt_invalid');
    }

    if (typeof ownerVerifier.assertPhysicalCurrentness === 'function') {
      const ok = await ownerVerifier.assertPhysicalCurrentness(record.dependencies);
      if (ok !== true) fail('physical_readset_stale');
    }

    return Object.freeze({
      schema: 'libra.consumed_readset_verification.v1',
      status: 'verified',
      consumer: record.policy.consumer,
      scopeKey: record.frame.scopeKey,
      worldlineId: record.frame.worldlineId,
      restoreEpoch: record.frame.restoreEpoch,
      verifiedNodeCount: Object.keys(record.dependencies.requiredBindings).length,
      verifiedSourceCount: record.dependencies.sourceIds.length,
      verifiedSuppressedMicroCount: record.bundle.suppressedMicroIds.length,
      modelDispatchEligible: true
    });
  };

  const revoke = readSetHandle => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    if (record) record.revoked = true;
  };

  const invalidateAll = () => {
    compilerEpoch++;
    issuedReadSets = new WeakMap();
  };

  return Object.freeze({ select, render, validateConsumedReadSet, revoke, invalidateAll });
};
