'use strict';
// UM4 Consumer & Final Readset Verification Compiler (EvidenceCompiler):
// 1. Selects an EvidenceBundle from UM3 retrieval candidates under consumer character/unit budgets,
//    measuring the full rendered envelope (header + role labels + numbering + newlines) so the final
//    rendered packet never exceeds maxCharacters (D07).
// 2. Enforces conservative Canonical/Micro absorption: a Micro unit is suppressed ONLY when its
//    admitted Canonical counterpart actually survives the rendered character budget; if Canonical drops,
//    Micro remains eligible. When Micro IS absorbed, its source/entity/basis dependencies are
//    retained in the private consumed readset (§10, V09).
// 3. Issues private WeakMap-backed consumed readset handles (never forgeable via JSON clone)
//    and requires mandatory physical owner currentness verification (`assertPhysicalCurrentness`),
//    re-checking handle validity, revocation, and compilerEpoch across every async boundary (D02, D04, V06, V07, V09, V12).
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

  // Shared deterministic packet formatter used during both budget admission (select) and packet assembly (render) (D07)
  const formatPacketText = (consumer, scopeKey, items, independentSourceCount) => {
    if (!Array.isArray(items) || items.length === 0) return '';
    const header = `[LIBRA_EVIDENCE consumer=${consumer} scope=${scopeKey} units=${items.length} sources=${independentSourceCount}]`;
    const lines = items.map((item, idx) => (
      `(${idx + 1}) [${item.family}:${item.semanticRole || item.kind}] ${item.text}`
    ));
    return [header, ...lines].join('\n');
  };

  // Select an EvidenceBundle under envelope-aware character & unit budgets with conservative Micro absorption (§10, V09, D07)
  const select = (queryResult, graph, rawPolicy = {}) => {
    if (!queryResult || queryResult.schema !== 'libra.memory_graph_query.v1') fail('query_result_invalid');
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    const policy = normalizePolicy(rawPolicy);
    const scopeKey = graph.scopeKey || graph.readerFrame?.scopeKey || '';

    const nodeById = new Map((graph.nodes || []).map(n => [n.id, n]));
    const unitByNodeId = new Map((graph.units || []).map(u => [u.nodeId, u]));
    const basisById = new Map((graph.bases || []).map(b => [b.id, b]));
    const edgeById = new Map((graph.edges || []).map(e => [e.id, e]));

    const ordered = [...(queryResult.candidates || [])].sort((a, b) => {
      if (policy.includeMandatoryLore && a.mandatoryInclusion !== b.mandatoryInclusion) {
        return a.mandatoryInclusion ? -1 : 1;
      }
      return b.score - a.score || a.nodeId.localeCompare(b.nodeId, 'en');
    });

    const admitted = [];
    const admittedNodeIds = new Set();
    const droppedForBudget = [];
    const suppressedMicro = [];
    const provisionalHeldMicro = [];

    const countIndependentSources = list => {
      const sources = new Set();
      for (const c of list) {
        const deps = collectCandidateDependencies(c, nodeById, basisById, edgeById);
        for (const sId of deps.sourceIds) sources.add(sId);
      }
      return sources.size;
    };

    const fitsRenderedBudget = candidateToAdd => {
      if (admitted.length >= policy.maxUnits) return false;
      const trialList = [...admitted, candidateToAdd];
      const trialSources = countIndependentSources(trialList);
      const trialRendered = formatPacketText(policy.consumer, scopeKey, trialList, trialSources);
      return trialRendered.length <= policy.maxCharacters;
    };

    const resolveHeldForCanonical = canonicalNodeId => {
      for (let i = provisionalHeldMicro.length - 1; i >= 0; i--) {
        if (provisionalHeldMicro[i].counterpartCanonicalId !== canonicalNodeId) continue;
        const [{ cand }] = provisionalHeldMicro.splice(i, 1);
        if (admittedNodeIds.has(canonicalNodeId)) {
          suppressedMicro.push({
            microNodeId: cand.nodeId,
            absorbedByCanonicalNodeId: canonicalNodeId,
            candidate: cand
          });
        } else if (fitsRenderedBudget(cand)) {
          admitted.push(cand);
          admittedNodeIds.add(cand.nodeId);
        } else {
          droppedForBudget.push({ nodeId: cand.nodeId, family: cand.family, reason: 'budget_exceeded' });
        }
      }
    };

    for (const cand of ordered) {
      const counterpartCanonicalId = cand.family === 'micro'
        ? (policy.correspondenceMap[cand.nodeId] || null)
        : null;

      if (counterpartCanonicalId && admittedNodeIds.has(counterpartCanonicalId)) {
        suppressedMicro.push({
          microNodeId: cand.nodeId,
          absorbedByCanonicalNodeId: counterpartCanonicalId,
          candidate: cand
        });
        continue;
      }
      if (counterpartCanonicalId && ordered.some(other => other.nodeId === counterpartCanonicalId)) {
        provisionalHeldMicro.push({ cand, counterpartCanonicalId });
        continue;
      }

      if (!fitsRenderedBudget(cand)) {
        droppedForBudget.push({ nodeId: cand.nodeId, family: cand.family, reason: 'budget_exceeded' });
        resolveHeldForCanonical(cand.nodeId);
        continue;
      }
      admitted.push(cand);
      admittedNodeIds.add(cand.nodeId);
      resolveHeldForCanonical(cand.nodeId);
    }

    for (const { cand, counterpartCanonicalId } of provisionalHeldMicro) {
      if (admittedNodeIds.has(counterpartCanonicalId)) {
        suppressedMicro.push({
          microNodeId: cand.nodeId,
          absorbedByCanonicalNodeId: counterpartCanonicalId,
          candidate: cand
        });
      } else if (fitsRenderedBudget(cand)) {
        admitted.push(cand);
        admittedNodeIds.add(cand.nodeId);
      } else {
        droppedForBudget.push({ nodeId: cand.nodeId, family: cand.family, reason: 'budget_exceeded' });
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
        turn: cand.turn ?? unit.turn ?? null,
        text: cand.text,
        score: cand.score,
        mandatoryInclusion: cand.mandatoryInclusion,
        evidenceFamilyId: cand.evidenceFamilyId,
        sourceSpan: unit.sourceSpan || null,
        locator: unit.locator || null,
        winningWitness: cand.winningWitness
      };
    });

    const renderedPreview = formatPacketText(
      policy.consumer,
      scopeKey,
      items,
      independentSupportingSources.size
    );
    const usedCharacters = renderedPreview.length;
    const bodyCharacters = items.reduce((acc, i) => acc + String(i.text || '').length, 0);

    const bundleCore = {
      schema: 'libra.evidence_bundle.v1',
      consumer: policy.consumer,
      generation: queryResult.generation,
      indexDigest: queryResult.indexDigest,
      frameId: queryResult.frameId,
      scopeKey,
      worldlineId: graph.readerFrame?.worldlineId || 'main',
      restoreEpoch: graph.readerFrame?.restoreEpoch ?? 0,
      owner: graph.readerFrame?.owner || '',
      historicalStateUnavailable: Boolean(queryResult.historicalStateUnavailable),
      queryComplete: Boolean(queryResult.complete),
      budget: {
        maxCharacters: policy.maxCharacters,
        usedCharacters,
        bodyCharacters,
        envelopeCharacters: usedCharacters - bodyCharacters,
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
    const bundleDigest = hash(JSON.stringify(bundleCore));
    const bundle = Object.freeze({ ...bundleCore, bundleDigest });

    const readSetToken = Object.freeze({
      schema: 'libra.consumed_readset_handle.v1',
      bundleDigest,
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

    return Object.freeze({ bundle, readSetHandle: readSetToken });
  };

  // Render consumer packet envelope from selected EvidenceBundle (§10, D07, D08)
  const render = ({ bundle, readSetHandle } = {}) => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    if (!record || record.revoked || record.compilerEpoch !== compilerEpoch) fail('readset_handle_invalid');
    if (!bundle || bundle.schema !== 'libra.evidence_bundle.v1' || bundle.bundleDigest !== readSetHandle.bundleDigest) {
      fail('bundle_mismatch');
    }
    const { bundleDigest: _omittedDigest, ...bundleCore } = bundle;
    if (hash(JSON.stringify(bundleCore)) !== readSetHandle.bundleDigest) {
      fail('bundle_mismatch');
    }
    const renderedText = formatPacketText(
      bundle.consumer,
      bundle.scopeKey,
      bundle.items,
      bundle.independentSupportingSourceCount
    );
    const packetDigest = hash(JSON.stringify([
      'libra.rendered_consumer_packet.v1',
      bundle.consumer,
      bundle.scopeKey,
      bundle.worldlineId,
      bundle.bundleDigest,
      renderedText
    ]));
    return Object.freeze({
      schema: 'libra.rendered_consumer_packet.v1',
      consumer: bundle.consumer,
      scopeKey: bundle.scopeKey,
      worldlineId: bundle.worldlineId,
      renderedText,
      characterLength: renderedText.length,
      packetDigest,
      admittedNodeIds: bundle.items.map(i => i.nodeId),
      suppressedMicroIds: bundle.suppressedMicroIds,
      gradiaSelectionReceipt: bundle.gradiaSelectionReceipt,
      readSetHandle,
      modelDispatchEligible: false
    });
  };

  // Final physical readset verification at model dispatch boundary (§10, §11, D02, D04, V06, V07, V09, V12)
  const validateConsumedReadSet = async (readSetHandle, ownerVerifier = {}) => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    const assertHandleActive = () => {
      const current = readSetHandle && issuedReadSets.get(readSetHandle);
      if (!current || current !== record || current.revoked || current.compilerEpoch !== compilerEpoch) {
        fail('readset_handle_invalid');
      }
    };
    assertHandleActive();
    if (!ownerVerifier || typeof ownerVerifier.currentGraph !== 'function') fail('owner_verifier_required');
    // D02: Physical owner currentness verification is mandatory before granting modelDispatchEligible: true
    if (typeof ownerVerifier.assertPhysicalCurrentness !== 'function') fail('physical_verifier_required');

    const live = await ownerVerifier.currentGraph();
    assertHandleActive();
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
      assertHandleActive();
      if (ok !== true) fail('gradia_receipt_invalid');
    }

    const physicalOk = await ownerVerifier.assertPhysicalCurrentness(record.dependencies, {
      bundle: record.bundle,
      frame: record.frame,
      liveGraph: live
    });
    assertHandleActive();
    if (physicalOk !== true && physicalOk?.verified !== true) fail('physical_readset_stale');

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
