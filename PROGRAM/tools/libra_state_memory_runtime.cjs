'use strict';
module.exports = function createLibraStateMemoryRuntime({ engine, capture, fingerprint, authorityStore, now = Date.now }) {
  const fail = code => { throw Object.assign(Error(code), { code }); };
  const query = async (options = {}, guard = null, issuer = null) => {
    const startedAt = now(), frame = await capture(options, guard);
    const queryText = String(options.queryInput?.queryText || options.queryText || '');
    const policy = options.consumerPolicy || {};
    const maxCharacters = Math.floor(Number(policy.maxCharacters ?? frame.settings.recallMaxChars ?? 8000));
    const maxItems = Math.floor(Number(policy.maxUnits ?? frame.settings.stateMaxItems ?? 24));
    const plan = engine.allocationPlan(queryText, frame.settings.recallLensSharePercent ?? 40);
    const stateRows = engine.stateRows(frame.head);
    const anchors = engine.select({ rows: stateRows, query: queryText, maxCharacters,
      maxItems: Math.min(maxItems, 12), minimumPerAxis: frame.settings.stateMinimumPerAxis ?? 2 });
    const refs = engine.rankCatalog(frame.refs, queryText, anchors.items, Math.min(frame.settings.stateCanonicalCandidates || 16, plan.canonicalCandidates));
    const evidenceTurns = anchors.items.map(row => Number(row.evidence?.turn || row.evidence?.turnRange?.end || 0)).filter(Boolean);
    const turns = [...new Set([...evidenceTurns, ...frame.turns.slice().reverse()])].filter(turn => frame.turns.includes(turn))
      .slice(0, Math.min(frame.settings.stateMicroCandidates || 12, plan.microCandidates));
    const loaded = [], failures = []; let payloadBytes = 0, payloadLimited = false;
    const keep = item => {
      const bytes = new TextEncoder().encode(JSON.stringify(item.rows)).length;
      if (payloadBytes + bytes > 12 * 1024 * 1024) { payloadLimited = true; return; }
      payloadBytes += bytes; loaded.push(item);
    };
    let lensSource = null;
    if (frame.lens) {
      try { lensSource = await frame.lens(queryText, maxCharacters); keep(lensSource); }
      catch (error) { failures.push({ family: 'lens', code: error.code || error.message }); }
    }
    for (const ref of refs) {
      frame.check();
      if (payloadLimited) break;
      try { keep(await frame.canonical(ref)); }
      catch (error) { failures.push({ family: 'canonical', key: ref.key, code: error.code || error.message }); }
    }
    for (const turn of turns) {
      frame.check();
      if (payloadLimited) break;
      try { const item = await frame.micro(turn); if (item) keep(item); }
      catch (error) { failures.push({ family: 'micro', turn, code: error.code || error.message }); }
    }
    const rows = [...stateRows, ...loaded.flatMap(item => item.rows)];
    const selected = engine.select({ rows, query: queryText, maxCharacters, maxItems,
      minimumPerAxis: frame.settings.stateMinimumPerAxis ?? 2, plan });
    const chosen = new Set(selected.items.map(item => item.sourceKey).filter(Boolean));
    const sources = loaded.filter(item => chosen.has(item.key));
    const publicItems = selected.items.map(item => ({ id: item.id, nodeId: item.id, axis: item.axis, family: item.family,
      semanticRole: item.family === 'lens' ? 'perspective_note' : item.family === 'state' ? 'projected_state' : 'recorded_evidence',
      ...(item.family === 'state' ? { stateStatus: item.stateStatus } : {}), text: item.text, score: item.score,
      turn: item.turn || 0, sourceKey: item.sourceKey || frame.stateKey }));
    const generation = fingerprint(JSON.stringify([frame.identity, publicItems]));
    const renderedText = publicItems.map(item => `[${engine.labels[item.axis]} · ${item.family}${item.turn ? ' · T' + item.turn : ''}${item.stateStatus === 'last_known' ? ' · last_known' : ''}] ${item.text}`).join('\n');
    // Rendering overhead participates in the same hard cap as the selection.
    if (renderedText.length > maxCharacters) fail('LIBRA_STATE_CHARACTER_BUDGET');
    const packet = { schema: 'libra.state_memory_packet.v1', consumer: policy.consumer || 'classic',
      renderedText, characterLength: renderedText.length, admittedNodeIds: publicItems.map(item => item.id) };
    const packetDigest = fingerprint(JSON.stringify(packet));
    let closed = false;
    const readSet = frame.register(sources);
    let receipt;
    try {
      receipt = issuer?.bindSelection?.({ scope: frame.scope, generation, sourceKeys: sources.map(item => item.key), itemIds: publicItems.map(item => item.id) });
    } catch (error) { frame.release(readSet); throw error; }
    const validatePacket = async input => {
      if (closed || now() - startedAt > 600000) fail('LIBRA_STATE_SELECTION_CLOSED');
      if (input !== packet || fingerprint(JSON.stringify(input)) !== packetDigest) fail('LIBRA_STATE_PACKET_CHANGED');
      frame.check(); await frame.assertCurrent(readSet);
      for (const source of sources) if (source.assertCurrent) await source.assertCurrent();
      if (receipt && issuer.verifyReceipt?.(receipt) !== true) fail('LIBRA_STATE_RECEIPT_CHANGED');
      frame.check();
      return { status: 'verified', engine: 'state_first', verifiedNodeCount: publicItems.length, verifiedBasisCount: sources.length };
    };
    const release = () => { if (closed) return; closed = true; frame.release(readSet); };
    const complete = refs.length === frame.refs.length && turns.length === frame.turns.length && !failures.length && !payloadLimited;
    const stateAsOfTurn = frame.head?.throughTurn ?? null;
    const latestTurn = frame.turns.at(-1) || 0;
    const turnLag = stateAsOfTurn != null ? Math.max(0, latestTurn - Number(stateAsOfTurn)) : null;
    const headFreshness = stateAsOfTurn == null ? 'absent' : frame.stateAuthority?.pending ? 'partial' : (turnLag === 0 ? 'current' : 'lagging');
    const pointInTimeNotice = headFreshness === 'partial' || turnLag && turnLag > 0
      ? `State includes verified projections through turn ${stateAsOfTurn}; unresolved or later changes remain unconfirmed.`
      : null;
    const result = { schema: 'libra.state_memory_query.v1', requestId: options.requestId || generation.slice(0, 24), engine: 'state_first', generation,
      lensRecall: lensSource?.delivery ? { ...lensSource.delivery, renderedBlock: '',
        injectedItems: selected.items.filter(item => item.family === 'lens').map(item => item.lensItem),
        usedChars: publicItems.filter(item => item.family === 'lens').reduce((sum, item) => sum + item.text.length + 32, 0), integrated: true } : null,
      modelDispatchEligible: publicItems.length > 0, packet,
      bundle: { owner: frame.owner, scopeKey: frame.scope.scopeKey, worldlineId: frame.worldlineId, generation, items: publicItems,
        budget: { ...selected.budget, usedCharacters: renderedText.length },
        pointInTime: { stateAsOfTurn, latestTurn, headFreshness, turnLag, pointInTimeNotice }, allocationPlan: plan },
      queryComplete: complete, sourceCoverageComplete: !failures.length, deliveryOutcome: complete ? 'complete' : 'partial',
      stopReason: complete ? '' : failures.length ? 'source_unavailable' : 'candidate_budget',
      corpusRead: { mode: 'direct_existing_records', graphBuilds: 0 },
      diagnostics: { engine: 'state_first', axes: selected.coverage, failures, payloadBytes, payloadLimited,
        stateAsOfTurn, latestTurn, headFreshness, turnLag, pointInTimeNotice, elapsedMs: now() - startedAt,
        candidates: { canonical: refs.length, canonicalTotal: frame.refs.length, micro: turns.length, microTotal: frame.turns.length },
        allocationPlan: plan, familyAllocation: selected.budget.familyAllocation,
        suppressedEvidenceDuplicates: selected.budget.suppressedEvidenceDuplicates,
        families: Object.fromEntries(['lens','state','canonical','micro','lore'].map(family => [family, { units: publicItems.filter(item => item.family === family).length }])) },
      guiSearch: { sourceKeys: loaded.filter(item => item.rows.some(row => engine.score(row.text, queryText) > 0)).map(item => item.key), complete,
        stopReason: complete ? '' : 'candidate_budget' } };
    authorityStore.set(result, { validatePacket, release, displayRows: publicItems.map(item => ({ ...item, memoryKey: item.sourceKey,
      scopeKey: frame.scope.scopeKey, worldlineId: frame.worldlineId, turnRange: { start: item.turn, end: item.turn } })) });
    try { await validatePacket(packet); return result; }
    catch (error) { release(); throw error; }
  };
  return { query, release: result => authorityStore.get(result)?.release() };
};
