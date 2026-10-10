'use strict';
// Per-stage selection over one verified immutable corpus. This component does not
// discover owners, perform retrieval, authenticate a route, or dispatch a model.
function createGradiaEvidenceSelection({ protocol, render, budget, digest, creditFactory }) {
  if (!protocol || !render || !budget || typeof digest !== 'function' || typeof creditFactory !== 'function') throw new TypeError('GRADIA_V2_SELECTION_DEPENDENCY');
  const fail = reason => { throw new TypeError('GRADIA_V2_SELECTION_' + reason); };
  const add = protocol.checkedAdd, mul = protocol.checkedMultiply;
  const id = value => { if (typeof value !== 'string' || !value) fail('ID'); render.stringMeasure(value, 256); return value; };
  const frozen = value => { if (!value || !Object.isFrozen(value)) fail('IMMUTABLE_REQUIRED'); return value; };
  async function openVerifiedCorpus({ identity, items, ranking, similarities, policy, readLimits = {}, owner }) {
    frozen(identity); frozen(items); frozen(ranking); frozen(similarities); frozen(policy);
    for (const key of ['corpusId', 'requestId', 'issuerId']) id(identity[key]);
    if (!/^[a-f0-9]{64}$/.test(identity.manifestHash)) fail('MANIFEST_HASH');
    for (const item of items) frozen(item);
    for (const row of ranking) frozen(row);
    for (const row of similarities) frozen(row);
    for (const method of ['assertCorpusCurrent', 'bindSelection', 'assertSelectionCurrent']) if (typeof owner?.[method] !== 'function') fail('OWNER_UNAVAILABLE');
    const limits = protocol.validateLimits(readLimits), credit = creditFactory({ maxManagedBytes: limits.managedBytes, maxPhysicalReads: limits.physicalReads });
    if (items.length > limits.items || items.length > policy.candidateLimit + 2) fail('ITEM_LIMIT');
    let closed = false, serial = 0, contentBytes = 0, operations = 0;
    const allocations = new Set(), stages = new Map(), consumed = new Set(), pendingStages = new Set(), byId = new Map(), groups = new Map();
    let issued = new WeakMap();
    const reserve = (key, bytes, kind) => { credit.reserve({ id: key, bytes, kind }); allocations.add(key); };
    const release = key => { if (allocations.delete(key)) credit.release(key); };
    const dispose = () => { for (const key of [...allocations]) release(key); stages.clear(); consumed.clear(); pendingStages.clear(); byId.clear(); groups.clear(); issued = new WeakMap(); items = []; ranking = []; similarities = []; identity = null; policy = null; owner = null; };
    const close = () => { if (closed) return; closed = true; if (!operations) dispose(); };
    const use = async operation => { if (closed) fail('CLOSED'); operations++; try { return await operation(); } finally { operations--; if (closed && !operations) dispose(); } };
    const current = async () => { if (closed || await owner.assertCorpusCurrent(identity) !== true || closed) fail('CORPUS_CHANGED'); };
    try {
      // Owned immutable strings are retained by reference, never JSON-cloned.
      for (const item of items) {
        if (!Number.isSafeInteger(item.contentBytes) || item.contentBytes <= 0) fail('ITEM_BYTES');
        contentBytes = add(contentBytes, item.contentBytes); if (contentBytes > limits.contentBytes) fail('CONTENT_LIMIT');
        reserve('corpus:' + allocations.size, add(mul(item.content.length, 2), 1024), 'utf16-text');
      }
      reserve('ranking', add(mul(mul(items.length, items.length), 16), mul(items.length, 1024)), 'metadata');
      render.validateItems(items);
      for (const item of items) if (await digest(item.content) !== item.contentHash) fail('CONTENT_HASH');
      await current();
      const ordered = render.rank({ items, ranking, similarities, policy, countLimit: limits.items });
      for (const item of items) byId.set(item.itemId, item);
      for (const item of items) { const key = item.groupId ? 'group:' + item.groupId : 'item:' + item.itemId; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item.itemId); }
      async function selectStage(input) {
        await current();
        const stage = id(input.stage), phase = id(input.phase), stageKey = stage + ':' + phase;
        if (stages.has(stageKey) || pendingStages.has(stageKey) || stages.size + pendingStages.size >= 8) fail('STAGE_REUSE_OR_LIMIT');
        pendingStages.add(stageKey);
        try {
        if (typeof input.baseBody !== 'string' || render.stringMeasure(input.baseBody, 128000).rawUtf8Bytes > 128000) return Object.freeze({ status: 'unavailable', reason: 'payload_budget_exceeded' });
        const context = Object.freeze({ ...input.context });
        const envelope = Object.freeze({ providerId: input.providerId, modelId: input.modelId, routeIdentity: input.routeIdentity, requestFormat: input.requestFormat, context, baseBody: input.baseBody });
        const baseCredit = 'base:' + (++serial); reserve(baseCredit, mul(envelope.baseBody.length, 6), 'selected-prompt');
        let retained = null;
        const omissions = ordered.omissions.map(value => ({ ...value })), selected = [], handled = new Set();
        async function trial(selectedItemIds) {
          let measure;
          try { measure = selectedItemIds.length ? render.measure({ corpusId: identity.corpusId, items, selectedItemIds, byteLimit: limits.renderedBytes }) : { utf8Bytes: 0, utf16Bytes: 0 }; }
          catch (error) { if (/RENDERED_BYTES/.test(error.message)) return { status: 'omitted', reason: 'rendered_evidence_budget' }; throw error; }
          const allocation = 'trial:' + (++serial);
          // Render chunks + joined string + JSON payload (escaping <= 6x raw).
          const declaredBytes = add(mul(envelope.baseBody.length, 6), add(mul(measure.utf16Bytes, 3), mul(measure.utf8Bytes, 12)));
          try { reserve(allocation, declaredBytes, 'selected-prompt'); }
          catch (error) { if (/CREDIT_BYTES/.test(error.message)) return { status: 'omitted', reason: 'managed_credit_budget' }; throw error; }
          try {
            const evidence = selectedItemIds.length ? render.render({ corpusId: identity.corpusId, items, selectedItemIds, byteLimit: limits.renderedBytes }).text : '';
            let native;
            try { native = JSON.parse(envelope.baseBody); } catch (_) { release(allocation); return { status: 'unavailable', reason: 'payload_format_unsupported' }; }
            const last = native?.messages?.at(-1);
            if (!last || last.role !== 'user' || typeof last.content !== 'string') { release(allocation); return { status: 'unavailable', reason: 'payload_format_unsupported' }; }
            if (evidence) last.content += '\n\n' + evidence;
            const body = evidence ? JSON.stringify(native) : envelope.baseBody;
            const decision = await budget.evaluate({ ...envelope, finalBody: body, renderedEvidence: evidence, renderedByteLimit: limits.renderedBytes });
            if (closed) fail('CLOSED');
            if (decision.status !== 'available') { release(allocation); return decision; }
            if (!decision.fits) { release(allocation); return { status: 'omitted', reason: 'model_context_budget' }; }
            return { status: 'available', allocation, body, evidence, witness: decision.witness };
          } catch (error) { release(allocation); throw error; }
        }
        try {
          retained = await trial([]);
          if (retained.status !== 'available') return Object.freeze({ status: 'unavailable', reason: retained.reason });
          const rankedIds = new Set(ordered.selectedItemIds);
          for (const itemId of ordered.selectedItemIds) {
            const item = byId.get(itemId), groupKey = item.groupId ? 'group:' + item.groupId : 'item:' + itemId;
            if (handled.has(groupKey)) continue; handled.add(groupKey);
            const members = groups.get(groupKey);
            if (members.some(key => !rankedIds.has(key))) {
              for (const key of members) if (!omissions.some(row => row.itemId === key)) omissions.push({ itemId: key, reason: 'semantic_group_not_selected' });
              continue;
            }
            // Keep MMR order inside each indivisible complete group.
            const unit = ordered.selectedItemIds.filter(key => members.includes(key));
            const candidate = await trial([...selected, ...unit]);
            if (candidate.status === 'unavailable') {
              if (candidate.reason === 'payload_budget_exceeded') { for (const key of unit) omissions.push({ itemId: key, reason: 'model_context_budget' }); continue; }
              return Object.freeze({ status: 'unavailable', reason: candidate.reason });
            }
            if (candidate.status !== 'available') { for (const key of unit) omissions.push({ itemId: key, reason: candidate.reason }); continue; }
            release(retained.allocation); retained = candidate; selected.push(...unit);
          }
          await current();
          const selectedItemIds = Object.freeze(selected), frozenOmissions = Object.freeze(omissions.map(Object.freeze));
          const proposalCore = Object.freeze({ schema: 'gradia.model-evidence-selection.v2', corpusId: identity.corpusId, requestId: identity.requestId,
            issuerId: identity.issuerId, manifestHash: identity.manifestHash, stage, phase,
            renderer: render.contract, mmrPolicy: policy, selectedItemIds,
            selectedItems: Object.freeze(selected.map(key => { const item = byId.get(key); return Object.freeze({ itemId: key, sourceHandle: item.sourceHandle, contentHash: item.contentHash, contentBytes: item.contentBytes, groupId: item.groupId || null }); })),
            renderedEvidenceHash: await digest(retained.evidence), omissions: frozenOmissions, budgetWitness: retained.witness });
          const proposal = Object.freeze({ ...proposalCore, selectionHash: await digest(JSON.stringify(proposalCore)) });
          const receipt = await owner.bindSelection(proposal);
          await current();
          if (!receipt || !Object.isFrozen(receipt) || receipt.schema !== proposal.schema || receipt.corpusId !== identity.corpusId || receipt.requestId !== identity.requestId
            || receipt.stage !== stage || receipt.phase !== phase || receipt.selectionHash !== proposal.selectionHash) fail('OWNER_RECEIPT');
          id(receipt.receiptHandle);
          const handle = Object.freeze({}), record = { receipt, witness: retained.witness, envelope, body: retained.body, allocation: retained.allocation };
          issued.set(handle, record); stages.set(stageKey, handle);
          const result = Object.freeze({ status: 'available', authorityQualified: false, handle, stage, phase, body: retained.body, evidence: retained.evidence,
            selectedItemIds, omissions: frozenOmissions, receipt, budgetWitness: retained.witness });
          retained = null; return result;
        } finally { release(baseCredit); if (retained?.allocation) release(retained.allocation); }
        } finally { pendingStages.delete(stageKey); }
      }
      async function assertDispatch(handle, actual) {
        await current(); const record = issued.get(handle); if (!record) fail('UNISSUED_SELECTION');
        budget.assertDispatch(record.witness, actual);
        if (await owner.assertSelectionCurrent(record.receipt) !== true) fail('SELECTION_CHANGED');
        await current(); consumed.add(handle); return true;
      }
      async function assertConsumedCurrent() {
        await current();
        for (const handle of consumed) if (await owner.assertSelectionCurrent(issued.get(handle).receipt) !== true) fail('SELECTION_CHANGED');
        await current(); return Object.freeze({ consumedSelections: consumed.size });
      }
      return Object.freeze({ contract: 'gradia.verified-corpus-selection-component.v2', authorityQualified: false,
        selectStage: input => use(() => selectStage(input)), assertDispatch: (handle, actual) => use(() => assertDispatch(handle, actual)),
        assertConsumedCurrent: () => use(assertConsumedCurrent), close, creditSnapshot: credit.snapshot });
    } catch (error) { close(); throw error; }
  }
  return Object.freeze({ contract: 'gradia.evidence-selection.v2', authorityQualified: false, openVerifiedCorpus });
}
