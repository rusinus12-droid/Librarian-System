'use strict';
// Bounded capture mechanics for a PRIVATE owner reader. inspect must establish
// authoritative sizes/proof under its guard BEFORE materialize is permitted.
// No storage get/set adapter or caller-supplied receipt qualifies that interface.
function createLibraGradiaRankedProducer({ protocol, render, digest, credit }) {
  if (!protocol || !render || typeof digest !== 'function' || !credit) throw new TypeError('GRADIA_V2_PRODUCER_DEPENDENCY');
  const fail = reason => { throw new TypeError('GRADIA_V2_PRODUCER_' + reason); };
  const add = protocol.checkedAdd, mul = protocol.checkedMultiply;
  const integer = (n, positive = false) => { if (!Number.isSafeInteger(n) || Object.is(n, -0) || n < (positive ? 1 : 0)) fail('INTEGER'); return n; };
  const id = text => { if (typeof text !== 'string' || !text) fail('ID'); render.stringMeasure(text, 256); return text; };
  let serial = 0;
  async function capture({ limits: requested = {}, frontier, owner, policy = { schema: 'libra.recall-mmr.v2', candidateLimit: 80, mmrEnabled: true, mmrLambda: .7 } }) {
    const limits = protocol.validateLimits(requested);
    if (!Object.isFrozen(frontier) || !Array.isArray(frontier) || frontier.length > policy.candidateLimit + 2
      || ![40, 80, 160, 320].includes(policy.candidateLimit)) fail('FRONTIER');
    const keys = new Set();
    for (const ref of frontier) { if (!Object.isFrozen(ref) || keys.has(id(ref.key))) fail('FRONTIER'); keys.add(ref.key); }
    for (const method of ['assertCurrent', 'inspect', 'materialize', 'scoreRows', 'similarity']) if (typeof owner?.[method] !== 'function') fail('OWNER_INTERFACE_UNAVAILABLE');
    // A private owner must enforce the ordinary associative opt-in/bound before
    // passing additions. No such permission is inferred from corpus item limits.
    if (frontier.length > policy.candidateLimit && owner.associativeEnabled !== true) fail('ASSOCIATIVE_NOT_ADMITTED');
    const captureId = 'ranked-' + (++serial), reservations = new Set(), hydrated = [], entries = new Map();
    let active = true, visitedCount = 0, scannedMetadataCount = 0, hydratedNarrativeBytes = 0, rawTransferBytes = 0, proofBytes = 0, stopReason = 'frontier_exhausted';
    const current = async () => { if (!active || await owner.assertCurrent() !== true) fail('OWNER_CHANGED'); return true; };
    const release = () => { if (!active) return; active = false; for (const key of reservations) credit.release(key); reservations.clear(); };
    try {
      await current();
      for (let index = 0; index < frontier.length; index++) {
        if (visitedCount >= limits.items) { stopReason = 'item_limit'; break; }
        const ref = frontier[index], physicalId = captureId + ':read:' + index;
        credit.beginPhysical({ id: physicalId, bytes: 0 });
        try {
          await current();
          const observed = await owner.inspect(ref);
          scannedMetadataCount++;
          await current();
          if (!observed || typeof observed !== 'object') fail('SIZE_ADMISSION_UNAVAILABLE');
          // Capture only fixed-profile primitives before the next await.
          const admission = Object.freeze({ narrativeBytes: integer(observed.narrativeBytes, true), serializedBytes: integer(observed.serializedBytes, true),
            proofBytes: integer(observed.proofBytes), contentHash: observed.contentHash, profile: observed.profile,
            sourceHandle: id(observed.sourceHandle), groupId: observed.groupId == null ? null : id(observed.groupId) });
          if (!/^[a-f0-9]{64}$/.test(admission.contentHash)) fail('HASH');
          if (!['libra.canonical.memory-text.v1', 'libra.micro.claims-text.v1', 'libra.micro.source-span.v1'].includes(admission.profile)) fail('PROFILE');
          if (admission.narrativeBytes > limits.contentBytes - hydratedNarrativeBytes) { stopReason = 'content_limit'; break; }
          if (admission.proofBytes > limits.metadataBytes - proofBytes) { stopReason = 'metadata_limit'; break; }
          if (admission.serializedBytes > limits.transferBytes - rawTransferBytes) { stopReason = 'raw_transfer_limit'; break; }
          // Reserve raw bytes, parser/string projections and retained complete text
          // before any body allocation. This is declared application credit only.
          const retainedBytes = add(mul(admission.serializedBytes, 3), add(mul(admission.narrativeBytes, 2), add(mul(admission.proofBytes, 2), 1024)));
          const retainedId = captureId + ':item:' + index, parseId = captureId + ':parse:' + index;
          credit.reserve({ id: retainedId, bytes: retainedBytes, kind: 'utf16-text' }); reservations.add(retainedId);
          credit.reserve({ id: parseId, bytes: mul(admission.serializedBytes, 3), kind: 'bytes' });
          let value;
          try { value = await owner.materialize(ref, admission); await current(); }
          finally { credit.release(parseId); }
          if (!value || typeof value.content !== 'string' || !value.row) fail('INCOMPLETE_ITEM');
          const content = value.content, itemId = id(value.itemId), row = value.row;
          if (entries.has(itemId)) fail('DUPLICATE_ITEM');
          const item = Object.freeze({ itemId, content, contentBytes: admission.narrativeBytes, contentHash: admission.contentHash,
            profile: admission.profile, sourceHandle: admission.sourceHandle, groupId: admission.groupId });
          render.validateItems([item]);
          if (await digest(content) !== admission.contentHash) fail('CONTENT_HASH');
          await current();
          entries.set(itemId, item); hydrated.push({ row, itemId });
          visitedCount++; hydratedNarrativeBytes = add(hydratedNarrativeBytes, admission.narrativeBytes);
          rawTransferBytes = add(rawTransferBytes, admission.serializedBytes); proofBytes = add(proofBytes, admission.proofBytes);
        } finally { credit.settle(physicalId); credit.release(physicalId); }
      }
      await current();
      const scored = await owner.scoreRows(hydrated.map(entry => entry.row));
      await current();
      if (!Array.isArray(scored) || scored.length > hydrated.length) fail('SCORE_ROWS');
      const byRowId = new Map(hydrated.map(entry => [entry.row.id, entry.itemId]));
      if (byRowId.size !== hydrated.length) fail('ROW_ID');
      const selectedRows = [], items = [], ranking = [], included = new Set();
      for (const row of scored) {
        const itemId = byRowId.get(row.id);
        if (!itemId || included.has(itemId)) fail('SCORE_IDENTITY');
        included.add(itemId); selectedRows.push(row); items.push(entries.get(itemId));
        ranking.push(Object.freeze({ itemId, relevance: row.relevance, forced: row.forced, exactScore: row.exactScore, sparseEvidence: row.sparseEvidence }));
      }
      // A closure-required group cannot be partially returned after eligibility.
      const selectedGroups = new Set(items.filter(item => item.groupId).map(item => item.groupId));
      for (const item of entries.values()) if (selectedGroups.has(item.groupId) && !included.has(item.itemId)) fail('INCOMPLETE_GROUP');
      const matrixBytes = mul(mul(items.length, items.length), 16), matrixId = captureId + ':similarities';
      credit.reserve({ id: matrixId, bytes: matrixBytes, kind: 'metadata' }); reservations.add(matrixId);
      const similarities = Object.freeze(selectedRows.map(left => Object.freeze(selectedRows.map(right => owner.similarity(left, right)))));
      const frozenItems = Object.freeze(items), frozenRanking = Object.freeze(ranking), frozenPolicy = Object.freeze({ ...policy });
      render.rank({ items: frozenItems, ranking: frozenRanking, similarities, policy: frozenPolicy, countLimit: limits.items });
      const remainingKeys = frontier.slice(visitedCount).map(ref => ref.key);
      const unreadFrontier = remainingKeys.length ? Object.freeze({ firstKey: remainingKeys[0], count: remainingKeys.length,
        orderedKeysHash: await digest(protocol.canonicalBytes(remainingKeys)) }) : null;
      const coverage = Object.freeze({ frontierCount: frontier.length, visitedCount, scannedMetadataCount,
        returnedEligibleCount: items.length, frontierExhausted: visitedCount === frontier.length, stopReason,
        hydratedNarrativeBytes, rawTransferBytes, proofBytes, returnedEligibleBytes: items.reduce((sum, item) => add(sum, item.contentBytes), 0), unreadFrontier });
      await current();
      return Object.freeze({ profile: 'gradia.ranked-corpus-component.v2', authorityQualified: false,
        items: frozenItems, ranking: frozenRanking, similarities, policy: frozenPolicy, coverage, assertCurrent: current, release });
    } catch (error) { release(); throw error; }
  }
  // Owner-side selection integrity: recompute from this retained immutable corpus,
  // never trust the consumer's rendered hash. Does not authenticate the owner.
  function createSelectionBinder({ corpus, identity, renderedByteLimit }) {
    const issued = new WeakMap(); let next = 0;
    const current = async () => { if (await corpus.assertCurrent() !== true) fail('OWNER_CHANGED'); return true; };
    return Object.freeze({ assertCorpusCurrent: current,
      async bindSelection(proposal) {
        await current();
        for (const key of ['corpusId', 'requestId', 'issuerId', 'manifestHash']) if (proposal[key] !== identity[key]) fail('SELECTION_IDENTITY');
        const output = proposal.selectedItemIds.length ? render.render({ corpusId: identity.corpusId, items: corpus.items, selectedItemIds: proposal.selectedItemIds, byteLimit: renderedByteLimit }).text : '';
        if (await digest(output) !== proposal.renderedEvidenceHash) fail('SELECTION_HASH');
        const core = { ...proposal }; delete core.selectionHash;
        if (await digest(JSON.stringify(core)) !== proposal.selectionHash) fail('SELECTION_RECEIPT_HASH');
        await current();
        const receipt = Object.freeze({ schema: 'gradia.model-evidence-selection.v2', corpusId: identity.corpusId, requestId: identity.requestId,
          stage: proposal.stage, phase: proposal.phase, selectionHash: proposal.selectionHash, receiptHandle: 'selection-' + (++next) });
        issued.set(receipt, true); return receipt;
      },
      async assertSelectionCurrent(receipt) { if (!issued.has(receipt)) fail('SELECTION_UNISSUED'); return await current(); }
    });
  }
  return Object.freeze({ contract: 'libra.gradia-ranked-producer.v2', authorityQualified: false, capture, createSelectionBinder });
}
