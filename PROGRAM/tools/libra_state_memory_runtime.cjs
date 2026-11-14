'use strict';
module.exports = function createLibraStateMemoryRuntime({ engine, capture, fingerprint, authorityStore, now = Date.now }) {
  const fail = code => { throw Object.assign(Error(code), { code }); };
  // Anchors hold up to 12 State rows with per-axis minimums; below twice that the selection
  // keeps most of the State anyway, so row vectors are neither produced nor read.
  const STATE_SEMANTIC_MIN_ROWS = 24;
  // The capture may hold a shared read frame. It is settled once the first proof passes
  // and abandoned on every failure, so no frame outlives its query.
  const query = async (options = {}, guard = null, issuer = null) => {
    const startedAt = now(), frame = await capture(options, guard);
    try { return await run(options, issuer, frame, startedAt, now() - startedAt); }
    catch (error) { frame.abandon?.(); throw error; }
  };
  const run = async (options, issuer, frame, startedAt, snapshotMs) => {
    const timings = { snapshotMs };
    const timed = async (phase, operation) => {
      const start = now();
      try { return await operation(); } finally { timings[phase] = (timings[phase] || 0) + now() - start; }
    };
    const queryText = String(options.queryInput?.queryText || options.queryText || '');
    // The recent scene is a second, weighted query: a short input ("then?") is searched with the
    // scene it continues. The current input stays the primary query. A weight of 0 (topic shift,
    // no scene) leaves the search exactly as the single-query path.
    const sceneText = String(options.queryInput?.sceneText || '').trim();
    const sceneWeight = Math.max(0, Math.min(1, Number(options.queryInput?.sceneWeight) || 0));
    const scene = queryText.trim() && sceneText && sceneWeight > 0 && sceneText !== queryText.trim()
      ? { text: sceneText, weight: sceneWeight } : null;
    const policy = options.consumerPolicy || {};
    const maxCharacters = Math.floor(Number(policy.maxCharacters ?? frame.settings.recallMaxChars ?? 8000));
    const maxItems = Math.floor(Number(policy.maxUnits ?? frame.settings.stateMaxItems ?? 24));
    const plan = engine.allocationPlan(queryText, frame.settings.recallLensSharePercent ?? 40, { maxItems,
      canonicalCap: frame.settings.stateCanonicalCandidates || 16, microCap: frame.settings.stateMicroCandidates || 12 });
    const stateRows = engine.stateRows(frame.head), entities = engine.entityTable(frame.head);
    // A State small enough for its anchors to hold most of it needs no dense signal. A larger
    // one sends its row texts with the query, so stored row vectors can rank the anchors.
    const stateTexts = stateRows.length >= STATE_SEMANTIC_MIN_ROWS
      ? [...new Set(stateRows.map(row => String(row.text || '').trim()).filter(Boolean))] : [];
    // Search text stored on Micro heads. Without it the choice falls back to evidence and recency.
    // It is read before the dense lane, which scores the same texts' stored Micro vectors.
    let microIndex = { entries: new Map(), known: 0 }, microIndexError = '';
    if (frame.microIndex) {
      try { microIndex = await timed('microIndexMs', () => frame.microIndex()); }
      catch (error) { microIndexError = String(error.code || error.message || error); }
    }
    frame.check();
    const microTexts = [...microIndex.entries];
    // Dense retrieval is optional. It reads stored vectors; document production never runs here.
    let semantic = { scores: new Map(), diagnostics: { status: 'off' } };
    if (frame.semantic && options.semantic !== false && queryText.trim()) {
      const lanes = scene || stateTexts.length || microTexts.length ? { text: queryText,
        ...(scene ? { sceneText: scene.text, sceneWeight: scene.weight } : {}),
        ...(stateTexts.length ? { stateTexts } : {}),
        ...(microTexts.length ? { microTexts } : {}) } : queryText;
      try { semantic = await timed('semanticMs', () => frame.semantic(lanes)); }
      catch (error) { semantic = { scores: new Map(), diagnostics: { status: 'failed', reason: String(error.code || error.message) } }; }
    }
    frame.check();
    // A row vector only ranks the row; it never adds, changes or confirms State.
    for (const row of stateRows) {
      const dense = Number(semantic.stateScores?.get(String(row.text || '').trim())) || 0;
      if (dense > 0) row.semanticScore = Math.max(Number(row.semanticScore) || 0, Math.min(1, dense));
    }
    const anchors = engine.select({ rows: stateRows, query: queryText, maxCharacters, entities,
      maxItems: Math.min(maxItems, 12), minimumPerAxis: frame.settings.stateMinimumPerAxis ?? 2 });
    const refs = engine.rankCatalog(frame.refs, queryText, anchors.items,
      plan.canonicalCandidates, { entities, semanticScores: semantic.scores,
        scene: scene ? { query: scene.text, weight: scene.weight, semanticScores: semantic.sceneScores || new Map() } : null });
    const evidenceTurns = anchors.items.map(row => Number(row.evidence?.turn || row.evidence?.turnRange?.end || 0)).filter(Boolean);
    const loaded = [], failures = []; let payloadBytes = 0, payloadLimited = false;
    const ranked = engine.rankMicroTurns({ turns: frame.turns, index: microIndex.entries, query: queryText, evidenceTurns, entities,
      limit: plan.microCandidates, scene: scene ? { query: scene.text, weight: scene.weight } : null,
      semanticScores: semantic.microScores || null });
    const turns = ranked.turns;
    const keep = item => {
      const bytes = new TextEncoder().encode(JSON.stringify(item.rows)).length;
      if (payloadBytes + bytes > 12 * 1024 * 1024) { payloadLimited = true; return; }
      payloadBytes += bytes; loaded.push(item);
    };
    let lensSource = null;
    if (frame.lens) {
      try { lensSource = await timed('lensMs', () => frame.lens(queryText, maxCharacters)); keep(lensSource); }
      catch (error) { failures.push({ family: 'lens', code: error.code || error.message }); }
    }
    // Candidate bodies are fetched together, then read side by side in small groups.
    // Results are kept in rank order, so the selection does not depend on arrival order.
    if (frame.prepare) { try { await timed('prepareMs', () => frame.prepare({ refs, turns })); } catch (_) {} }
    for (let offset = 0; offset < refs.length && !payloadLimited; offset += 8) {
      frame.check();
      const group = refs.slice(offset, offset + 8);
      const settled = await timed('canonicalMs', () => Promise.all(group.map(ref =>
        Promise.resolve().then(() => frame.canonical(ref, semantic)).then(value => ({ value }), error => ({ error })))));
      for (const [index, outcome] of settled.entries()) {
        if (payloadLimited) break;
        if (outcome.error) failures.push({ family: 'canonical', key: group[index].key, code: outcome.error.code || outcome.error.message });
        else keep(outcome.value);
      }
    }
    for (const turn of turns) {
      frame.check();
      if (payloadLimited) break;
      try { const item = await timed('microMs', () => frame.micro(turn)); if (item) keep(item); }
      catch (error) { failures.push({ family: 'micro', turn, code: error.code || error.message }); }
    }
    const rows = [...stateRows, ...loaded.flatMap(item => item.rows)];
    const selected = engine.select({ rows, query: queryText, maxCharacters, maxItems, entities,
      minimumPerAxis: frame.settings.stateMinimumPerAxis ?? 2, plan });
    const stateAsOfTurn = frame.head?.throughTurn ?? null;
    const latestTurn = frame.turns.at(-1) || 0;
    const turnLag = stateAsOfTurn != null ? Math.max(0, latestTurn - Number(stateAsOfTurn)) : null;
    const toPublic = item => ({ id: item.id, nodeId: item.id, axis: item.axis, family: item.family,
      semanticRole: item.family === 'lens' ? 'perspective_note' : item.family === 'state' ? 'projected_state'
        : item.family === 'micro' && item.analysisStatus === 'minimum_source_bound' ? 'source_only' : 'recorded_evidence',
      ...(item.family === 'state' ? { stateStatus: item.stateStatus } : {}), text: item.promptText || item.text, score: item.score,
      turn: item.turn || 0, ...(Number(item.turnStart) > 0 && Number(item.turnStart) < Number(item.turn) ? { turnStart: Number(item.turnStart) } : {}),
      sourceKey: item.sourceKey || frame.stateKey });
    // One document in order of authority: the present first, then what happened, then how a lens read
    // it, then the source observations. Records are listed oldest first and each keeps its recorded turn,
    // so a line that is no longer true reads as an earlier moment rather than as the present.
    const render = items => {
      if (!items.length) return '';
      const span = item => { const end = Number(item.turn || 0), start = Number(item.turnStart || end);
        return end ? (start && start < end ? `T${start}–${end}` : `T${end}`) : 'T?'; };
      const oldestFirst = list => list.slice().sort((a, b) => Number(a.turnStart || a.turn || 0) - Number(b.turnStart || b.turn || 0)
        || Number(a.turn || 0) - Number(b.turn || 0));
      const family = name => items.filter(item => item.family === name);
      const state = family('state'), lines = [];
      const lastKnown = state.some(item => item.stateStatus === 'last_known');
      if (state.length) {
        lines.push(`[CURRENT STATE · ${stateAsOfTurn != null ? `as of T${stateAsOfTurn}` : 'turn unknown'}${lastKnown ? ' · includes last_known' : ''} — how things stand now]`);
        if (turnLag) lines.push(`(Turns after T${stateAsOfTurn} are not reflected here yet; a record below dated after T${stateAsOfTurn} is newer than this State.)`);
        for (const item of state) lines.push(`- ${item.text}${item.stateStatus === 'last_known' ? ' (last_known)' : ''}`);
      } else lines.push('[CURRENT STATE · none selected — the records below are earlier moments; do not assert them as the present]');
      const canonical = oldestFirst(family('canonical'));
      if (canonical.length) {
        lines.push('[RECORDED HISTORY · canonical · oldest first — true at the recorded turn, not necessarily now]');
        for (const item of canonical) lines.push(`- (${span(item)}) ${item.text}`);
      }
      const lens = oldestFirst(family('lens'));
      if (lens.length) {
        lines.push('[PERSPECTIVE NOTES · lens interpretations — below CURRENT STATE and the records]');
        for (const item of lens) {
          const text = String(item.text).replace(/^\[PERSPECTIVE NOTES · NON-CANONICAL\]\s*/, '');
          lines.push(text.startsWith('- ') ? text : `- ${text}`);
        }
      }
      const micro = oldestFirst(family('micro'));
      if (micro.length) {
        lines.push('[SCENE DETAILS · Micro source observations · oldest first]');
        for (const item of micro) lines.push(`- (${span(item)}) ${item.text}`);
      }
      return lines.join('\n');
    };
    // The selection charges each line, not the section headings. When the headings tip the document
    // over the hard cap, the lines chosen last (the lowest priority) give way, State last of all.
    let kept = selected.items.map(toPublic), renderedText = render(kept);
    while (renderedText.length > maxCharacters && kept.length) {
      const drop = kept.filter(item => item.family !== 'state').at(-1) || kept.at(-1);
      kept = kept.filter(item => item !== drop);
      renderedText = render(kept);
    }
    if (renderedText.length > maxCharacters) fail('LIBRA_STATE_CHARACTER_BUDGET');
    const publicItems = kept;
    const keptIds = new Set(publicItems.map(item => item.id));
    selected.items = selected.items.filter(item => keptIds.has(item.id));
    const chosen = new Set(selected.items.map(item => item.sourceKey).filter(Boolean));
    const sources = loaded.filter(item => chosen.has(item.key));
    const generation = fingerprint(JSON.stringify([frame.identity, publicItems]));
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
      frame.check(); await timed('verificationMs', () => frame.assertCurrent(readSet));
      for (const source of sources) if (source.assertCurrent) await source.assertCurrent();
      if (receipt && issuer.verifyReceipt?.(receipt) !== true) fail('LIBRA_STATE_RECEIPT_CHANGED');
      frame.check();
      return { status: 'verified', engine: 'state_first', verifiedNodeCount: publicItems.length, verifiedBasisCount: sources.length };
    };
    const release = () => { if (closed) return; closed = true; frame.release(readSet); };
    // Micro is searched in full either by reading every turn, or by screening every turn's
    // stored search text and reading each one that matched.
    const microScreened = !!queryText.trim() && !microIndexError && microIndex.known >= frame.turns.length && ranked.matchesRead === ranked.matches;
    const complete = refs.length === frame.refs.length && (turns.length === frame.turns.length || microScreened) && !failures.length && !payloadLimited;
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
        semantic: { ...semantic.diagnostics, selected: selected.items.filter(item => item.family === 'canonical' && item.semanticScore > 0).length },
        microVectors: microTexts.length && semantic.diagnostics?.microVectors ? { used: true, ...semantic.diagnostics.microVectors }
          : { used: false, turns: microTexts.length },
        stateVectors: stateTexts.length ? { used: true, ...(semantic.diagnostics?.stateVectors || { status: semantic.diagnostics?.status || 'off' }) }
          : { used: false, rows: stateRows.length },
        sceneQuery: scene ? { used: true, weight: scene.weight, characters: scene.text.length,
          semantic: semantic.diagnostics?.sceneQuery || 'off', microMatches: ranked.sceneMatches || 0 } : { used: false },
        stateAsOfTurn, latestTurn, headFreshness, turnLag, pointInTimeNotice, timings, elapsedMs: now() - startedAt,
        stateAuthority: frame.stateAuthority || null,
        candidates: { canonical: refs.length, canonicalTotal: frame.refs.length, micro: turns.length, microTotal: frame.turns.length,
          microIndexed: ranked.indexed, microIndexKnown: microIndex.known, microMatches: ranked.matches, microMatchesRead: ranked.matchesRead,
          microReasons: ranked.reasons, ...(microIndexError ? { microIndexError } : {}) },
        allocationPlan: plan, familyAllocation: selected.budget.familyAllocation,
        suppressedEvidenceDuplicates: selected.budget.suppressedEvidenceDuplicates,
        families: Object.fromEntries(['lens','state','canonical','micro','lore'].map(family => [family, {
          units: publicItems.filter(item => item.family === family).length,
          ...(family === 'state' ? { reasons: [...new Set((frame.head?.microProjection?.pendingClaims || [])
            .map(row => row.reason).filter(Boolean))] } : {}) }])) },
      guiSearch: { sourceKeys: loaded.filter(item => item.rows.some(row => engine.score(row.text, queryText) > 0 || row.semanticScore > 0)).map(item => item.key), complete,
        stopReason: complete ? '' : 'candidate_budget' } };
    authorityStore.set(result, { validatePacket, release, displayRows: publicItems.map(item => ({ ...item, memoryKey: item.sourceKey,
      scopeKey: frame.scope.scopeKey, worldlineId: frame.worldlineId, turnRange: { start: item.turnStart || item.turn, end: item.turn } })) });
    try {
      await validatePacket(packet);
      // A frame that saw a concurrent change is closed by settle; prove once more without it.
      const settled = frame.settle ? await frame.settle() : null;
      if (settled === false) await validatePacket(packet);
      result.diagnostics.readFrame = settled === null ? 'none' : settled === false ? 'reproved' : settled === 'deferred' ? 'deferred' : 'shared';
      result.diagnostics.elapsedMs = now() - startedAt;
      return result;
    }
    catch (error) { release(); throw error; }
  };
  return { query, release: result => authorityStore.get(result)?.release() };
};
