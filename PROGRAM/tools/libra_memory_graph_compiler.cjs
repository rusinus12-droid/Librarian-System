'use strict';
// UM4 Consumer & Final Readset Verification Compiler (EvidenceCompiler — D02, D04, D07, M08, M09, M10):
// 1. Selects an EvidenceBundle from UM3 retrieval candidates under consumer character/unit budgets,
//    measuring the full rendered envelope (header + consumer-specific role/hydration formatting + newlines)
//    so the final rendered packet never exceeds maxCharacters (D07, M09).
// 2. Enforces conservative Canonical/Micro absorption from unique owner-normalized scalar
//    claims and exact source occurrences; caller hints and lexical overlap cannot grant absorption,
//    deduplicates derived State/Canonical primary root source counting, and preserves lifecycle/conflict annotations (M08).
// 3. Issues private WeakMap-backed consumed readset handles binding admitted nodes, witness edges/bases,
//    and absorbed Micro dependencies, and requires mandatory physical owner currentness verification
//    re-checking handle validity, revocation, and compilerEpoch across every async boundary (D02, D04, M10).
module.exports = function createMemoryGraphCompiler({ fingerprint } = {}) {
  if (typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_COMPILER_FINGERPRINT_REQUIRED');
  const schema = 'libra.memory_graph_compiler.v1';
  const ACTIVE_PRODUCT_CONSUMERS = Object.freeze(['classic', 'gui', 'gradia']);
  const HISTORICAL_FORMAT_ONLY_CONSUMERS = Object.freeze(['planner', 'sga', 'input_writer']);
  const validConsumers = new Set([...ACTIVE_PRODUCT_CONSUMERS, ...HISTORICAL_FORMAT_ONLY_CONSUMERS]);

  // M09/E3/N00: what each consumer's rendered packet must satisfy before this layer hands it over.
  // Active product consumers (classic, gui, gradia) are authorized for product execution.
  // Historical formatters (planner, sga, input_writer) are compatibility formats only: support for
  // their envelope format does NOT grant product execution or model dispatch authority (N00).
  const CONSUMER_PACKET_POLICIES = Object.freeze({
    classic: Object.freeze({ consumer: 'classic', formatFamily: 'default', lineTag: false, requiresSelectionReceipt: false, productExecutionAuthorized: true, historicalFormatOnly: false }),
    planner: Object.freeze({ consumer: 'planner', formatFamily: 'plan_lines', lineTag: true, requiresSelectionReceipt: false, productExecutionAuthorized: false, historicalFormatOnly: true }),
    sga: Object.freeze({ consumer: 'sga', formatFamily: 'plan_lines', lineTag: true, requiresSelectionReceipt: false, productExecutionAuthorized: false, historicalFormatOnly: true }),
    input_writer: Object.freeze({ consumer: 'input_writer', formatFamily: 'default', lineTag: false, requiresSelectionReceipt: false, productExecutionAuthorized: false, historicalFormatOnly: true }),
    gui: Object.freeze({ consumer: 'gui', formatFamily: 'default', lineTag: false, requiresSelectionReceipt: false, productExecutionAuthorized: true, historicalFormatOnly: false }),
    gradia: Object.freeze({ consumer: 'gradia', formatFamily: 'default', lineTag: false, requiresSelectionReceipt: true, productExecutionAuthorized: true, historicalFormatOnly: false })
  });

  // M04: every byte category this boundary can see gets a decision — counted at this layer, or
  // explicitly uncounted with the reason. byteBounded stays false: the whole API is NOT bounded.
  const MEMORY_BYTE_CATEGORY_DECISIONS = Object.freeze([
    Object.freeze({ category: 'rendered_packet', bucket: 'counted', note: 'final envelope handed to the consumer' }),
    Object.freeze({ category: 'bundle_body', bucket: 'counted', note: 'admitted item text inside the envelope' }),
    Object.freeze({ category: 'l0_candidate_workspace', bucket: 'counted', note: 'query.retrieve l0WorkspaceBytes' }),
    Object.freeze({ category: 'lane_page_payload', bucket: 'counted', note: 'drained lane page payload bytes' }),
    Object.freeze({ category: 'source_read_json', bucket: 'counted', note: 'owner source JSON read payload bytes' }),
    Object.freeze({ category: 'l0_witness_bytes', bucket: 'counted', note: 'witness chain and dependency bytes in candidate state' }),
    Object.freeze({ category: 'index_page_build', bucket: 'counted', note: 'compiled index page serialization and staging bytes' }),
    Object.freeze({ category: 'frontier_expansion', bucket: 'counted', note: 'search frontier queue and step expansion workspace' }),
    Object.freeze({ category: 'readset_handle_state', bucket: 'counted', note: 'private readset token dependency and binding state' }),
    Object.freeze({ category: 'owner_io_in_flight', bucket: 'counted', note: 'active storage page and reader in-flight buffers' }),
    Object.freeze({ category: 'write_barrier', bucket: 'counted', note: 'durable publication staging and barrier commit bytes' }),
    Object.freeze({ category: 'vm_overhead', bucket: 'uncounted', reason: 'runtime heap outside the accounted structures' })
  ]);

  const memoryByteInventory = (sample = {}) => {
    const number = name => typeof sample[name] === 'number' && Number.isFinite(sample[name]) && sample[name] >= 0 ? sample[name] : null;
    const counted = Object.freeze({
      rendered_packet: number('packetBytes'),
      bundle_body: number('bodyBytes'),
      l0_candidate_workspace: number('l0WorkspaceBytes'),
      lane_page_payload: number('lanePageBytes'),
      source_read_json: number('sourceReadJsonBytes'),
      l0_witness_bytes: number('l0WitnessBytes'),
      index_page_build: number('indexPageBuildBytes'),
      frontier_expansion: number('frontierExpansionBytes'),
      readset_handle_state: number('readsetHandleStateBytes'),
      owner_io_in_flight: number('ownerIoInFlightBytes'),
      write_barrier: number('writeBarrierBytes')
    });
    const budgets = Object.freeze({
      rendered_packet: number('packetByteBudget'),
      bundle_body: null,
      l0_candidate_workspace: number('l0WorkspaceBudget'),
      lane_page_payload: number('lanePageBudget'),
      source_read_json: number('sourceReadJsonBudget'),
      l0_witness_bytes: number('l0WitnessBudget'),
      index_page_build: number('indexPageBuildBudget'),
      frontier_expansion: number('frontierExpansionBudget'),
      readset_handle_state: number('readsetHandleStateBudget'),
      owner_io_in_flight: number('ownerIoInFlightBudget'),
      write_barrier: number('writeBarrierBudget')
    });
    return Object.freeze({
      schema: 'libra.memory_byte_inventory.v1',
      byteBounded: false,
      counted,
      budgets,
      countedBytes: Object.values(counted).reduce((total, value) => total + (value ?? 0), 0),
      measurementUnits: Object.freeze({
        rendered_packet: 'utf8_encoded_bytes',
        bundle_body: 'utf8_encoded_bytes',
        l0_candidate_workspace: 'estimated_accounted_bytes',
        lane_page_payload: 'cumulative_utf8_transfer_bytes',
        source_read_json: 'utf8_encoded_bytes',
        l0_witness_bytes: 'estimated_accounted_bytes',
        index_page_build: 'utf8_encoded_bytes',
        frontier_expansion: 'estimated_accounted_bytes',
        readset_handle_state: 'estimated_accounted_bytes',
        owner_io_in_flight: 'active_buffer_bytes',
        write_barrier: 'staged_barrier_bytes'
      }),
      aggregateMeaning: 'sum_of_available_logical_measurements_not_peak_heap',
      characterBudgets: Object.freeze({ rendered_packet: number('maxCharacters') }),
      missingMeasurements: Object.freeze(Object.keys(counted).filter(key => counted[key] === null)),
      uncounted: Object.freeze(MEMORY_BYTE_CATEGORY_DECISIONS
        .filter(decision => decision.bucket === 'uncounted')
        .map(decision => Object.freeze({ category: decision.category, reason: decision.reason }))),
      categories: Object.freeze(MEMORY_BYTE_CATEGORY_DECISIONS.map(decision => decision.category))
    });
  };

  const verifyConsumerPacket = (packet, options = {}) => {
    const consumer = String(packet?.consumer || options.consumer || '');
    const policy = CONSUMER_PACKET_POLICIES[consumer];
    if (!policy) fail('consumer_invalid');
    const checked = [];
    const findings = [];
    const check = (name, ok, detail) => {
      checked.push(name);
      if (!ok) findings.push({ check: name, detail: String(detail == null ? '' : detail).slice(0, 120) });
    };
    const text = String(packet?.renderedText || '');
    const lines = text.split('\n');
    const isModelDocument = packet?.presentation === 'model_document' || options.presentation === 'model_document';
    check('rendered_text_type', typeof packet?.renderedText === 'string', typeof packet?.renderedText);
    check('schema', packet?.schema === 'libra.rendered_consumer_packet.v1', packet?.schema);
    const count = Array.isArray(packet?.admittedNodeIds) ? packet.admittedNodeIds.length : -1;
    const sources = packet?.independentSourceCount;
    const empty = text === '' && count === 0 && sources === 0;
    check('header_consumer_label', empty || count >= 0 && Number.isSafeInteger(sources) && sources >= 0
      && lines[0] === '[LIBRA_EVIDENCE consumer=' + consumer + ' scope=' + String(packet?.scopeKey || '')
        + ' units=' + count + ' sources=' + sources + ']', lines[0]);
    if (isModelDocument) {
      const bodyLines = lines.slice(1);
      const itemLines = bodyLines.filter(line => /^\(\d+\) \[/.test(line));
      const allLinesValid = bodyLines.every(line =>
        /^\(\d+\) \[/.test(line)
        || /^\[(?:CURRENT STATE|RELATIONSHIPS|KNOWLEDGE|OPEN THREADS|RELEVANT HISTORY|SCENE DETAILS|WORLD CONTEXT|UNCERTAIN|EVIDENCE|CHARACTER:[^\]]+|WORLD \/ OBJECT STATE:[^\]]+|RELATIONSHIP:[^\]]+|KNOWLEDGE HOLDER:[^\]]+)\]$/.test(line)
        || /^  (?:attrib|object_state): /.test(line));
      check('rendered_item_lines', empty || itemLines.length === count
        && itemLines.every((line, index) => line.startsWith('(' + (index + 1) + ') ['))
        && allLinesValid, itemLines.length + '/' + lines.length);
    } else {
      check('rendered_item_lines', empty || lines.length === count + 1
        && lines.slice(1).every((line, index) => line.startsWith('(' + (index + 1) + ') [')), lines.length);
    }
    check('character_length_matches_text', Number(packet?.characterLength || 0) === text.length, Number(packet?.characterLength || 0) + ' vs ' + text.length);
    if (options.maxCharacters != null) {
      check('character_budget', text.length <= Number(options.maxCharacters), text.length + ' > ' + options.maxCharacters);
    }
    if (options.itemCount != null) {
      check('item_count', Array.isArray(packet?.admittedNodeIds) && packet.admittedNodeIds.length === Number(options.itemCount), packet?.admittedNodeIds?.length);
    }
    if (policy.lineTag) {
      check('format_family_plan_lines', empty || lines.slice(1).every(line => /^\(\d+\) \[.*@(?:T\d+|time_unknown)\]/.test(line)), policy.formatFamily);
    }
    if (policy.requiresSelectionReceipt) {
      const receipt = packet?.gradiaSelectionReceipt;
      check('selection_receipt_present', Boolean(receipt && typeof receipt === 'object'
        && String(receipt.ownerCorpusDigest || '').trim() && String(receipt.selectionReceiptId || '').trim()), receipt);
    } else {
      check('no_unrequested_receipt', packet?.gradiaSelectionReceipt == null, 'receipt present for a non-receipt consumer');
    }
    check('dispatch_not_self_asserted', packet?.modelDispatchEligible !== true, packet?.modelDispatchEligible);
    if (!policy.productExecutionAuthorized) {
      check('historical_format_not_authorized_for_dispatch', packet?.modelDispatchEligible !== true, 'historical format cannot have model dispatch');
    }
    return Object.freeze({
      schema: 'libra.consumer_packet_verification.v1',
      consumer,
      formatFamily: policy.formatFamily,
      productExecutionAuthorized: Boolean(policy.productExecutionAuthorized),
      historicalFormatOnly: Boolean(policy.historicalFormatOnly),
      ok: findings.length === 0,
      checked: Object.freeze(checked),
      findings: Object.freeze(findings)
    });
  };
  const fail = reason => { const err = new Error('LIBRA_GRAPH_COMPILER_' + reason.toUpperCase()); err.reason = reason; throw err; };
  const hash = text => { const val = fingerprint(text); if (!/^[a-f0-9]{64}$/.test(val)) fail('fingerprint_invalid'); return val; };

  let issuedReadSets = new WeakMap();
  let issuedPackets = new WeakMap();
  let compilerEpoch = 0;
  // Only resource-backed issued readsets are held strongly; their session limit/TTL bounds this set.
  const resourceReadSets = new Set();

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
    const packetPolicy = CONSUMER_PACKET_POLICIES[consumer];
    const presentation = policy.presentation === 'model_document' ? 'model_document' : 'default';
    return {
      consumer,
      presentation,
      formatFamily: packetPolicy.formatFamily,
      productExecutionAuthorized: packetPolicy.productExecutionAuthorized,
      historicalFormatOnly: packetPolicy.historicalFormatOnly,
      maxCharacters,
      maxUnits,
      includeMandatoryLore: policy.includeMandatoryLore !== false,
      hydrateSourceQuotes: Boolean(policy.hydrateSourceQuotes),
      correspondenceMap: policy.correspondenceMap && typeof policy.correspondenceMap === 'object' ? policy.correspondenceMap : {},
      gradiaSelectionReceipt: consumer === 'gradia' ? { ...policy.gradiaSelectionReceipt } : null
    };
  };

  const collectCandidateDependencies = (cand, nodeById, basisById, edgeById) => {
    const nodeIds = new Set([cand.nodeId]);
    const sourceIds = new Set();
    const entityIds = new Set();
    const edgeIds = new Set();
    const basisIds = new Set(cand.winningWitness?.basisIds || []);
    const bindingByNodeId = new Map();
    const bindingByEdgeId = new Map();
    const bindingByBasisId = new Map();

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
      if (step.edgeId) {
        edgeIds.add(step.edgeId);
        const edge = edgeById.get(step.edgeId);
        if (edge) {
          addNode(edge.from);
          addNode(edge.to);
          if (edge.bindingId) bindingByEdgeId.set(edge.id, edge.bindingId);
        }
      }
    }
    for (const bId of basisIds) {
      const b = basisById.get(bId);
      if (b) {
        if (b.bindingId) bindingByBasisId.set(b.id, b.bindingId);
        if (b.sourceId) addNode(b.sourceId);
      }
    }

    return { nodeIds, sourceIds, entityIds, edgeIds, basisIds, bindingByNodeId, bindingByEdgeId, bindingByBasisId };
  };

  // M08: Detect owner-verified automatic correspondence between a Micro unit and a Canonical unit
  const buildAutoCorrespondenceMap = (candidates, graph, unitByNodeId) => {
    const autoMap = {};
    const canonicalCands = candidates.filter(c => c.family === 'canonical');
    const microCands = candidates.filter(c => c.family === 'micro');
    if (!canonicalCands.length || !microCands.length) return autoMap;

    const contradictionOrReopenPairs = new Set();
    for (const edge of graph.edges || []) {
      if (edge.predicate === 'contradicts' || edge.predicate === 'reopens') {
        contradictionOrReopenPairs.add(`${edge.from}->${edge.to}`);
        contradictionOrReopenPairs.add(`${edge.to}->${edge.from}`);
      }
    }

    const proofKey = unit => {
      const p = unit?.correspondenceProof, a = p?.sourceOccurrence;
      if (!p || !a || !['character','world'].includes(p.domain) || !p.subjectId || !p.field || /Ref$/.test(p.field)
        || !['set','clear'].includes(p.operation) || !(p.value === null || ['string','boolean'].includes(typeof p.value) || typeof p.value === 'number' && Number.isFinite(p.value))
        || p.temporalRole !== 'current_sequence' || p.certainty !== 'confirmed' || p.epistemicStatus !== 'observed'
        || !a.scopeKey || !a.worldlineId || !a.messageId || !a.sourceTextDigest || !a.exactQuote
        || !Number.isSafeInteger(a.turn) || !Number.isSafeInteger(a.sessionEpoch)
        || !['user','assistant'].includes(a.role) || !Number.isSafeInteger(a.startOffset)
        || a.endOffset - a.startOffset !== a.exactQuote.length) return '';
      return JSON.stringify([p.domain,p.subjectId,p.field,p.operation,p.value,p.temporalRole,p.certainty,p.epistemicStatus,
        a.scopeKey,a.worldlineId,a.sessionEpoch,a.turn,a.role,a.messageId,a.startOffset,a.endOffset,a.exactQuote,a.sourceTextDigest]);
    };
    // Ambiguous claim occurrences stay independent, even when only one duplicate
    // reached the ranked candidate window.
    const counts = new Map();
    for (const unit of unitByNodeId.values()) {
      const key = proofKey(unit);
      if (key) counts.set(unit.family + ':' + key, (counts.get(unit.family + ':' + key) || 0) + 1);
    }
    for (const mCand of microCands) {
      const key = proofKey(unitByNodeId.get(mCand.nodeId));
      if (!key || counts.get('micro:' + key) !== 1 || counts.get('canonical:' + key) !== 1) continue;
      for (const cCand of canonicalCands) {
        if (contradictionOrReopenPairs.has(`${mCand.nodeId}->${cCand.nodeId}`)) continue;
        if (key === proofKey(unitByNodeId.get(cCand.nodeId))) {
          autoMap[mCand.nodeId] = cCand.nodeId;
          break;
        }
      }
    }
    return autoMap;
  };

  // M09: Hydrate item text with verified source span quote when requested by policy
  const singleLine = value => String(value || '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const utf8Bytes = value => {
    let bytes = 0;
    for (const char of String(value || '')) { const cp = char.codePointAt(0); bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4; }
    return bytes;
  };
  const formatHydratedItemLine = (item, idx, consumer, hydrateSourceQuotes) => {
    const quoteSuffix = hydrateSourceQuotes && item.sourceSpan?.exactQuote && !String(item.text || '').includes(item.sourceSpan.exactQuote)
      ? ` (quote: "${item.sourceSpan.exactQuote}")`
      : '';
    const lifecycleTag = item.lifecycleStatus && item.lifecycleStatus !== 'active'
      ? `/${item.lifecycleStatus}`
      : '';
    if (consumer === 'planner' || consumer === 'sga') {
      const turnTag = Number.isSafeInteger(item.turn) ? `@T${item.turn}` : '@time_unknown';
      return `(${idx + 1}) [${item.family}:${item.semanticRole || item.kind}${lifecycleTag}${turnTag}] ${singleLine(item.text)}${singleLine(quoteSuffix)}`;
    }
    return `(${idx + 1}) [${item.family}:${item.semanticRole || item.kind}${lifecycleTag}] ${singleLine(item.text)}${singleLine(quoteSuffix)}`;
  };

  const SEMANTIC_SECTION_ORDER = Object.freeze([
    'CURRENT STATE',
    'RELATIONSHIPS',
    'KNOWLEDGE',
    'OPEN THREADS',
    'RELEVANT HISTORY',
    'SCENE DETAILS',
    'WORLD CONTEXT',
    'UNCERTAIN',
    'EVIDENCE'
  ]);

  // Shared deterministic packet formatter used during both budget admission (select) and packet assembly (render) (D07, M09)
  const formatPacketText = (consumer, scopeKey, items, independentSourceCount, hydrateSourceQuotes = false, presentation = 'default') => {
    if (!Array.isArray(items) || items.length === 0) return '';
    const header = `[LIBRA_EVIDENCE consumer=${consumer} scope=${scopeKey} units=${items.length} sources=${independentSourceCount}]`;
    if (presentation !== 'model_document' || consumer === 'planner' || consumer === 'sga') {
      const lines = items.map((item, idx) => formatHydratedItemLine(item, idx, consumer, hydrateSourceQuotes));
      return [header, ...lines].join('\n');
    }
    const grouped = new Map();
    for (const sec of SEMANTIC_SECTION_ORDER) grouped.set(sec, []);
    items.forEach((item, idx) => {
      const sec = SEMANTIC_SECTION_ORDER.includes(item.semanticSection) ? item.semanticSection : 'EVIDENCE';
      grouped.get(sec).push({ item, idx });
    });
    const out = [header];
    let nextItemIndex = 0;
    for (const sec of SEMANTIC_SECTION_ORDER) {
      const entries = grouped.get(sec);
      if (!entries || !entries.length) continue;
      out.push(`[${sec}]`);
      let lastSubHeader = '';
      let lastObjectStateLine = '';
      for (const { item } of entries) {
        const subHeader = String(item.subHeader || '').trim();
        if (subHeader && subHeader !== lastSubHeader) {
          out.push(subHeader);
          lastSubHeader = subHeader;
          lastObjectStateLine = '';
        }
        const objectStateLine = String(item.objectStateLine || '').trim();
        if (objectStateLine && objectStateLine !== lastObjectStateLine && (!item.text || !objectStateLine.includes(String(item.text)))) {
          out.push(`  object_state: ${singleLine(objectStateLine)}`);
          lastObjectStateLine = objectStateLine;
        }
        out.push(formatHydratedItemLine(item, nextItemIndex++, consumer, hydrateSourceQuotes));
        const attribLine = String(item.attributionLine || '').trim();
        if (attribLine && (!item.text || !attribLine.includes(String(item.text)))) {
          out.push(`  attrib: ${singleLine(attribLine)}`);
        }
      }
    }
    return out.join('\n');
  };

  // M08: Compute independent primary supporting sources (deduplicating State units derived_from a Canonical unit)
  const computeIndependentPrimarySources = (list, nodeById, graphEdges) => {
    const derivedSourceMap = new Map();
    for (const edge of graphEdges || []) {
      if (edge.predicate === 'derived_from') {
        const targetNode = nodeById.get(edge.to);
        if (targetNode?.sourceId) derivedSourceMap.set(edge.from, targetNode.sourceId);
      }
    }
    const primarySources = new Set();
    for (const c of list) {
      const n = nodeById.get(c.nodeId);
      const rootSource = derivedSourceMap.get(c.nodeId) || n?.sourceId || c.sourceId;
      if (rootSource) primarySources.add(rootSource);
    }
    return primarySources;
  };

  // Select an EvidenceBundle under envelope-aware character & unit budgets with conservative Micro absorption (§10, V09, D07, M08, M09)
  const select = (queryResult, graph, rawPolicy = {}, resources = null) => {
    if (!queryResult || queryResult.schema !== 'libra.memory_graph_query.v1') fail('query_result_invalid');
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1') fail('graph_invalid');
    const policy = normalizePolicy(rawPolicy);
    const scopeKey = graph.scopeKey || graph.readerFrame?.scopeKey || '';

    const nodeById = new Map((graph.nodes || []).map(n => [n.id, n]));
    const unitByNodeId = new Map((graph.units || []).map(u => [u.nodeId, u]));
    const basisById = new Map((graph.bases || []).map(b => [b.id, b]));
    const edgeById = new Map((graph.edges || []).map(e => [e.id, e]));

    // Build verified entity lookup tables strictly from layer === 'entity' nodes in graph.nodes.
    const entityMetaById = new Map();
    const entityMetaByKey = new Map();
    const stateWorldByKey = new Map();
    for (const n of graph.nodes || []) {
      if (n.layer === 'entity') {
        const snap = (n.identity?.snapshot && typeof n.identity.snapshot === 'object') ? n.identity.snapshot : {};
        const entityKey = String(n.identity?.entityKey || snap.id || snap.entityKey || '').trim();
        const name = String(n.identity?.name || snap.name || n.label || '').trim();
        const kind = String(n.identity?.kind || snap.kind || '').trim();
        const meta = { id: n.id, entityKey: entityKey || n.id, name, kind };
        entityMetaById.set(n.id, meta);
        if (entityKey) entityMetaByKey.set(entityKey, meta);
      } else if (n.layer === 'source' && n.family === 'state') {
        const head = n.identity?.snapshot?.head || {};
        for (const [wKey, wObj] of Object.entries(head.world || {})) {
          if (wObj && typeof wObj === 'object') {
            const idKey = String(wObj.id || wKey).trim();
            if (idKey) stateWorldByKey.set(idKey, wObj);
          }
        }
      }
    }
    const subjectEdgesByNodeId = new Map();
    const targetEdgesByNodeId = new Map();
    for (const edge of graph.edges || []) {
      if (edge.predicate === 'subject_of') {
        if (!subjectEdgesByNodeId.has(edge.from)) subjectEdgesByNodeId.set(edge.from, []);
        subjectEdgesByNodeId.get(edge.from).push(edge.to);
      } else if (edge.predicate === 'target_of') {
        if (!targetEdgesByNodeId.has(edge.from)) targetEdgesByNodeId.set(edge.from, []);
        targetEdgesByNodeId.get(edge.from).push(edge.to);
      }
    }

    // Strict entity resolution: only entities present in graph.nodes (layer === 'entity') are considered verified.
    const resolveVerifiedEntity = rawRef => {
      const ref = String(rawRef || '').trim();
      if (!ref) return null;
      const byKey = entityMetaByKey.get(ref) || entityMetaById.get(ref);
      if (byKey && byKey.name) return { id: byKey.entityKey || byKey.id, name: byKey.name, kind: byKey.kind || '' };
      return null;
    };

    const sanitizeHeaderToken = value => String(value || '').replace(/[\[\]\r\n|]/g, ' ').replace(/\s+/g, ' ').trim();

    const ordered = [...(queryResult.candidates || [])].sort((a, b) => {
      if (policy.includeMandatoryLore && a.mandatoryInclusion !== b.mandatoryInclusion) {
        return a.mandatoryInclusion ? -1 : 1;
      }
      return b.score - a.score || a.nodeId.localeCompare(b.nodeId, 'en');
    });

    const autoMap = buildAutoCorrespondenceMap(ordered, graph, unitByNodeId);
    const combinedCorrespondence = autoMap; // Caller hints cannot manufacture owner correspondence.

    const contradictionNodes = new Set();
    for (const edge of graph.edges || []) {
      if (edge.predicate === 'contradicts') {
        contradictionNodes.add(edge.from);
        contradictionNodes.add(edge.to);
      }
    }

    const resolveLifecycleStatus = cand => {
      const unit = unitByNodeId.get(cand.nodeId) || {};
      if (cand.semanticRole === 'user_corrected') return 'user_corrected';
      if (cand.availability === 'clear' || unit.availability === 'clear') return 'state_cleared';
      if (contradictionNodes.has(cand.nodeId)) return 'contradiction_paired';
      return 'active';
    };

    const deriveSemanticPresentation = (cand, unit, lifecycleStatus) => {
      const family = String(cand.family || unit.family || '');
      const semanticRole = String(cand.semanticRole || unit.semanticRole || cand.kind || '');
      const domain = String(unit.domain || '');
      const field = String(unit.field || '');
      const turn = cand.turn ?? unit.turn ?? null;
      const headTurn = unit.headThroughTurn ?? null;
      const provenanceStatus = String(cand.provenanceStatus ?? unit.provenanceStatus ?? '');
      const rawCertainty = String(unit.certainty || cand.certainty || '').trim();
      // Never promote 'unknown' certainty to 'confirmed'. Preserve 'unknown' as-is.
      const certainty = rawCertainty
        || (lifecycleStatus === 'contradiction_paired' ? 'conflicting'
          : semanticRole === 'state_unprovenanced' || provenanceStatus === 'unprovenanced' ? 'unverified'
          : semanticRole === 'state_last_known' ? 'last_known'
          : semanticRole === 'user_corrected' ? 'user_corrected'
          : family === 'micro' ? 'observed_candidate'
          : 'confirmed');

      let owner = null;
      let ownerUnresolved = false;
      const targets = [];
      let targetUnresolved = false;
      let objectStateLine = '';

      const subjNodes = (subjectEdgesByNodeId.get(cand.nodeId) || []).filter(nId => entityMetaById.has(nId));
      const targNodes = (targetEdgesByNodeId.get(cand.nodeId) || []).filter(nId => entityMetaById.has(nId));

      if (family === 'state') {
        // Only if the graph reader verified the entity in registry.entities and created a subject_of/target_of
        // edge to a layer === 'entity' node whose opaque handle lacks a display name may we read the reader's label.
        const textPrefixMatch = String(cand.text || unit.text || '').match(/^(.+?)\s*·\s*(?:character|relationship|world|narrative)\.[A-Za-z0-9_]+\s*=/);
        const readerBoundLabel = textPrefixMatch ? textPrefixMatch[1].trim() : '';
        if (domain === 'character') {
          const rawEntityId = String(unit.entityId || '').trim();
          owner = resolveVerifiedEntity(rawEntityId)
            || (subjNodes.length === 1 ? resolveVerifiedEntity(subjNodes[0]) : null)
            || (subjNodes.length === 1 && readerBoundLabel ? { id: rawEntityId || subjNodes[0], name: readerBoundLabel, kind: 'character' } : null);
          if (!owner && rawEntityId) ownerUnresolved = true;
          for (const tId of targNodes) {
            const t = resolveVerifiedEntity(tId);
            if (t) targets.push(t);
          }
        } else if (domain === 'relationship') {
          const rKey = String(unit.entityId || '').trim();
          const parts = rKey.includes('->') ? rKey.split('->').map(s => s.trim()) : [];
          const relArrowMatch = readerBoundLabel ? readerBoundLabel.replace(/\s*\([^)]*\)\s*$/, '').match(/^(.+?)\s*→\s*(.+)$/) : null;
          owner = resolveVerifiedEntity(parts[0])
            || (subjNodes.length === 1 ? resolveVerifiedEntity(subjNodes[0]) : null)
            || (subjNodes.length === 1 && relArrowMatch ? { id: parts[0] || subjNodes[0], name: relArrowMatch[1].trim(), kind: 'character' } : null);
          if (!owner && (parts[0] || rKey)) ownerUnresolved = true;
          const targetEnt = resolveVerifiedEntity(parts[1])
            || (targNodes.length === 1 ? resolveVerifiedEntity(targNodes[0]) : null)
            || (targNodes.length === 1 && relArrowMatch ? { id: parts[1] || targNodes[0], name: relArrowMatch[2].trim(), kind: 'character' } : null);
          if (targetEnt) targets.push(targetEnt);
          else if (parts[1]) targetUnresolved = true;
        } else if (domain === 'world') {
          const wKey = String(unit.entityId || 'world').trim();
          const wObj = stateWorldByKey.get(wKey) || {};
          const wState = (wObj.state && typeof wObj.state === 'object') ? wObj.state : wObj;
          if (wKey !== 'world') {
            owner = resolveVerifiedEntity(wKey)
              || (subjNodes.length === 1 ? resolveVerifiedEntity(subjNodes[0]) : null)
              || (subjNodes.length === 1 && readerBoundLabel ? { id: wKey, name: readerBoundLabel, kind: 'world' } : null);
            if (!owner) ownerUnresolved = true;
          }
          const rawOwnerRef = String(wState.ownerRef || wState.owner || wObj.ownerRef || wObj.owner || '').trim();
          const rawHolderRef = String(wState.holderRef || wState.holder || wObj.holderRef || wObj.holder || '').trim();
          const objOwnerEnt = resolveVerifiedEntity(rawOwnerRef);
          const objHolderEnt = resolveVerifiedEntity(rawHolderRef);
          const objOwnerLabel = objOwnerEnt ? `${objOwnerEnt.name}(${objOwnerEnt.id})` : (rawOwnerRef ? 'unresolved' : '');
          const objHolderLabel = objHolderEnt ? `${objHolderEnt.name}(${objHolderEnt.id})` : (rawHolderRef ? 'unresolved' : '');
          if (objOwnerLabel || objHolderLabel) {
            const parts = [];
            if (objOwnerLabel) parts.push(`owner=${objOwnerLabel}`);
            if (objHolderLabel) parts.push(`holder=${objHolderLabel}`);
            if (objOwnerEnt && objHolderEnt && objOwnerLabel !== objHolderLabel) {
              parts.push('note=owner_and_current_holder_differ');
            }
            objectStateLine = parts.join(' | ');
          }
        }
      } else if (family === 'canonical') {
        const fact = unit.fact || {};
        const rawSubjId = String(unit.subjectId || fact.subjectId || '').trim();
        owner = resolveVerifiedEntity(rawSubjId)
          || (subjNodes.length === 1 ? resolveVerifiedEntity(subjNodes[0]) : null);
        if (!owner && rawSubjId && subjNodes.length === 0) ownerUnresolved = true;
        const rawTargetIds = Array.isArray(unit.targetIds) && unit.targetIds.length
          ? unit.targetIds
          : (Array.isArray(fact.targetIds) && fact.targetIds.length ? fact.targetIds : targNodes);
        for (const tId of rawTargetIds) {
          const t = resolveVerifiedEntity(tId);
          if (t) targets.push(t);
          else if (String(tId || '').trim() && targNodes.length === 0) targetUnresolved = true;
        }
      } else if (family === 'micro') {
        if (subjNodes.length === 1) owner = resolveVerifiedEntity(subjNodes[0]);
        for (const tId of targNodes) {
          const t = resolveVerifiedEntity(tId);
          if (t) targets.push(t);
        }
      }

      const claimKind = String(unit.fact?.claimKind || unit.kind || '').toLowerCase();
      const uncertainCertainties = new Set(['conflicting', 'uncertain', 'disputed', 'unverified']);
      const isExplicitlyUnknownCertainty = certainty.toLowerCase() === 'unknown'
        && !(family === 'state' && provenanceStatus === 'recorded' && unit.fieldEvidence && Object.keys(unit.fieldEvidence).length > 0);
      let semanticSection = 'EVIDENCE';
      if (lifecycleStatus === 'contradiction_paired' || semanticRole === 'state_unprovenanced'
        || provenanceStatus === 'unprovenanced' || uncertainCertainties.has(certainty.toLowerCase())
        || isExplicitlyUnknownCertainty) {
        semanticSection = 'UNCERTAIN';
      } else if (family === 'lore') {
        semanticSection = 'WORLD CONTEXT';
      } else if (family === 'state') {
        if (domain === 'relationship') semanticSection = 'RELATIONSHIPS';
        else if (field === 'knowledge') semanticSection = 'KNOWLEDGE';
        else if ((domain === 'narrative' && field === 'threads') || (domain === 'character' && field === 'goal')) semanticSection = 'OPEN THREADS';
        else if (domain === 'world' && ['rule', 'rules', 'setting', 'law', 'access', 'containment', 'management'].includes(field)) semanticSection = 'WORLD CONTEXT';
        else semanticSection = 'CURRENT STATE';
      } else if (family === 'canonical') {
        if (claimKind === 'relationship') semanticSection = 'RELATIONSHIPS';
        else if (claimKind === 'knowledge' || claimKind === 'secret') semanticSection = 'KNOWLEDGE';
        else if ((claimKind === 'thread' || claimKind === 'goal' || claimKind === 'promise') && lifecycleStatus === 'active') semanticSection = 'OPEN THREADS';
        else if (claimKind === 'world_rule' || claimKind === 'setting') semanticSection = 'WORLD CONTEXT';
        else semanticSection = 'RELEVANT HISTORY';
      } else if (family === 'micro') {
        semanticSection = 'SCENE DETAILS';
      }

      let subHeader = '';
      if (!ownerUnresolved && !targetUnresolved) {
        if (semanticSection === 'CURRENT STATE') {
          if (domain === 'character' && owner?.name) {
            const idPart = owner.id ? ` | id=${sanitizeHeaderToken(owner.id)}` : '';
            subHeader = `[CHARACTER: ${sanitizeHeaderToken(owner.name)}${idPart}]`;
          } else if (domain === 'world') {
            const wLabel = owner?.name && owner.name !== 'world' ? sanitizeHeaderToken(owner.name) : 'WORLD';
            const idPart = owner?.id && owner.id !== 'world' ? ` | id=${sanitizeHeaderToken(owner.id)}` : '';
            subHeader = `[WORLD / OBJECT STATE: ${wLabel}${idPart}]`;
          }
        } else if (semanticSection === 'RELATIONSHIPS' && owner?.name && targets.length) {
          const targetNames = targets.map(t => sanitizeHeaderToken(t.name)).filter(Boolean).join(', ');
          if (targetNames) subHeader = `[RELATIONSHIP: ${sanitizeHeaderToken(owner.name)} → ${targetNames}]`;
        } else if (semanticSection === 'KNOWLEDGE' && owner?.name) {
          const idPart = owner.id ? ` | id=${sanitizeHeaderToken(owner.id)}` : '';
          subHeader = `[KNOWLEDGE HOLDER: ${sanitizeHeaderToken(owner.name)}${idPart}]`;
        }
      }

      let visibility = 'verified_evidence';
      if (semanticSection === 'KNOWLEDGE' || field === 'knowledge' || claimKind === 'knowledge') {
        visibility = owner?.name && !ownerUnresolved
          ? `known_by(${owner.name}); other_characters=unconfirmed_do_not_assume_shared`
          : 'restricted_knowledge; other_characters=unconfirmed';
      } else if (semanticSection === 'RELATIONSHIPS' || domain === 'relationship') {
        const tLabel = targets.map(t => t.name).filter(Boolean).join(',');
        visibility = owner?.name && tLabel && !ownerUnresolved && !targetUnresolved
          ? `directional(${owner.name} → ${tLabel}); reverse_direction=not_implied`
          : 'directional_attitude; reverse_direction=not_implied';
      } else if (domain === 'character' && ['emotion', 'goal', 'attitude', 'internal_state'].includes(field)) {
        visibility = owner?.name && !ownerUnresolved
          ? `subject_state(${owner.name}); other_characters_awareness=unconfirmed`
          : 'subject_state; other_characters_awareness=unconfirmed';
      }

      const provParts = [];
      if (Number.isSafeInteger(turn)) provParts.push(`T${turn}`);
      else if (Number.isSafeInteger(headTurn)) provParts.push(`≤T${headTurn}`);
      if (Number.isSafeInteger(unit.fieldEvidence?.basisTurn) && unit.fieldEvidence.basisTurn !== turn) {
        provParts.push(`basis=T${unit.fieldEvidence.basisTurn}`);
      }
      if (provenanceStatus) provParts.push(provenanceStatus);
      else if (semanticRole) provParts.push(semanticRole);
      if (unit.correction?.id) provParts.push(`correction=${unit.correction.id}`);

      const attribParts = [];
      if (ownerUnresolved) attribParts.push('owner=unresolved');
      else if (owner?.name) attribParts.push(`owner=${owner.name}${owner.id ? '(' + owner.id + ')' : ''}`);
      else if (domain === 'world') attribParts.push('owner=world');
      if (targetUnresolved) {
        attribParts.push('target=unresolved');
      } else if (targets.length) {
        attribParts.push(`target=${targets.map(t => `${t.name}${t.id ? '(' + t.id + ')' : ''}`).join(',')}`);
      }
      attribParts.push(`visibility=${visibility}`);
      if (provParts.length) attribParts.push(`provenance=${provParts.join('/')}`);
      attribParts.push(`certainty=${certainty}`);

      return {
        semanticSection,
        subHeader,
        objectStateLine,
        attributionLine: attribParts.join(' | '),
        attribution: {
          ownerId: ownerUnresolved ? null : (owner?.id || null),
          ownerName: ownerUnresolved ? null : (owner?.name || null),
          ownerResolution: ownerUnresolved ? 'unresolved' : (owner?.name ? 'verified' : 'none'),
          targetIds: targetUnresolved ? [] : targets.map(t => t.id).filter(Boolean),
          targetNames: targetUnresolved ? [] : targets.map(t => t.name).filter(Boolean),
          visibility,
          provenance: provParts.join('/'),
          certainty
        }
      };
    };

    const decorateCandidateForFormat = cand => {
      const unit = unitByNodeId.get(cand.nodeId) || {};
      const lifecycleStatus = resolveLifecycleStatus(cand);
      const presentationMeta = policy.presentation === 'model_document'
        ? deriveSemanticPresentation(cand, unit, lifecycleStatus)
        : null;
      return {
        ...cand,
        turn: cand.turn ?? unit.turn ?? null,
        sourceSpan: unit.sourceSpan || null,
        lifecycleStatus,
        ...(presentationMeta ? {
          semanticSection: presentationMeta.semanticSection,
          subHeader: presentationMeta.subHeader,
          objectStateLine: presentationMeta.objectStateLine,
          attributionLine: presentationMeta.attributionLine,
          attribution: presentationMeta.attribution
        } : {})
      };
    };

    const admitted = [];
    const admittedNodeIds = new Set();
    // A delivered evidence line has to carry something a reader can use. A state/field unit whose text is
    // only an internal identifier or a raw JSON object reads as noise and exposes internals, so it stays in
    // the graph for scoring and trace but is not admitted as evidence. Counted, never dropped silently.
    const unreadableEvidenceText = value => {
      const text = String(value == null ? '' : value).trim().replace(/^"([\s\S]*)"$/, '$1').trim();
      if (!text) return false;
      if (/^ce_[a-z0-9_]+$/i.test(text)) return true;
      // A field whose value is only a reference to another unit still exposes nothing a reader can use,
      // even when it is labelled: "world.holderRef = ce_person_02c035f3" is the same leak with a prefix.
      if (/(?:^|=\s*)ce_[a-z0-9_]+(?:\s*$)/i.test(text)) return true;
      if (/^[{\[]/.test(text) && /[}\]]$/.test(text)) {
        try { JSON.parse(text); return true; } catch (_) { return false; }
      }
      return false;
    };
    const excludedUnreadable = [];
    const droppedForBudget = [];
    const suppressedMicro = [];
    const provisionalHeldMicro = [];

    const countIndependentSources = list => computeIndependentPrimarySources(list, nodeById, graph.edges).size;

    const fitsRenderedBudget = candidateToAdd => {
      if (admitted.length >= policy.maxUnits) return false;
      const decorated = decorateCandidateForFormat(candidateToAdd);
      const trialList = [...admitted.map(decorateCandidateForFormat), decorated];
      const trialSources = countIndependentSources(trialList);
      const trialRendered = formatPacketText(policy.consumer, scopeKey, trialList, trialSources, policy.hydrateSourceQuotes, policy.presentation);
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
      if (unreadableEvidenceText(cand.text)) {
        excludedUnreadable.push({ nodeId: cand.nodeId, family: cand.family, reason: 'unreadable_evidence_text' });
        continue;
      }
      const counterpartCanonicalId = cand.family === 'micro'
        ? (combinedCorrespondence[cand.nodeId] || null)
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

    // Build consumed dependency sets across BOTH admitted candidates AND suppressed/absorbed Micro candidates (§10, V09, M10)
    const allNodeIds = new Set();
    const allSourceIds = new Set();
    const allEntityIds = new Set();
    const allEdgeIds = new Set();
    const allBasisIds = new Set();
    const requiredBindings = new Map();
    const requiredEdgeBindings = new Map();
    const requiredBasisBindings = new Map();
    const independentSupportingSources = computeIndependentPrimarySources(admitted, nodeById, graph.edges);

    for (const cand of admitted) {
      const deps = collectCandidateDependencies(cand, nodeById, basisById, edgeById);
      for (const id of deps.nodeIds) allNodeIds.add(id);
      for (const id of deps.sourceIds) allSourceIds.add(id);
      for (const id of deps.entityIds) allEntityIds.add(id);
      for (const id of deps.edgeIds) allEdgeIds.add(id);
      for (const id of deps.basisIds) allBasisIds.add(id);
      for (const [k, v] of deps.bindingByNodeId.entries()) requiredBindings.set(k, v);
      for (const [k, v] of deps.bindingByEdgeId.entries()) requiredEdgeBindings.set(k, v);
      for (const [k, v] of deps.bindingByBasisId.entries()) requiredBasisBindings.set(k, v);
    }

    for (const item of suppressedMicro) {
      const deps = collectCandidateDependencies(item.candidate, nodeById, basisById, edgeById);
      for (const id of deps.nodeIds) allNodeIds.add(id);
      for (const id of deps.sourceIds) allSourceIds.add(id);
      for (const id of deps.entityIds) allEntityIds.add(id);
      for (const id of deps.edgeIds) allEdgeIds.add(id);
      for (const id of deps.basisIds) allBasisIds.add(id);
      for (const [k, v] of deps.bindingByNodeId.entries()) requiredBindings.set(k, v);
      for (const [k, v] of deps.bindingByEdgeId.entries()) requiredEdgeBindings.set(k, v);
      for (const [k, v] of deps.bindingByBasisId.entries()) requiredBasisBindings.set(k, v);
      const canonicalNode = nodeById.get(item.absorbedByCanonicalNodeId);
      if (canonicalNode) {
        allNodeIds.add(canonicalNode.id);
        requiredBindings.set(canonicalNode.id, canonicalNode.bindingId);
        if (canonicalNode.sourceId) allSourceIds.add(canonicalNode.sourceId);
      }
    }

    const rawItems = admitted.map(cand => {
      const unit = unitByNodeId.get(cand.nodeId) || {};
      const lifecycleStatus = resolveLifecycleStatus(cand);
      const presentationMeta = policy.presentation === 'model_document'
        ? deriveSemanticPresentation(cand, unit, lifecycleStatus)
        : null;
      return {
        nodeId: cand.nodeId,
        sourceId: cand.sourceId,
        family: cand.family,
        kind: cand.kind,
        semanticRole: cand.semanticRole,
        availability: cand.availability ?? null,
        provenanceStatus: cand.provenanceStatus ?? null,
        lifecycleStatus,
        turn: cand.turn ?? unit.turn ?? null,
        text: cand.text,
        score: cand.score,
        mandatoryInclusion: cand.mandatoryInclusion,
        evidenceFamilyId: cand.evidenceFamilyId,
        sourceSpan: unit.sourceSpan || null,
        locator: unit.locator || null,
        winningWitness: cand.winningWitness,
        ...(presentationMeta ? {
          semanticSection: presentationMeta.semanticSection,
          subHeader: presentationMeta.subHeader,
          objectStateLine: presentationMeta.objectStateLine,
          attributionLine: presentationMeta.attributionLine,
          attribution: presentationMeta.attribution
        } : {})
      };
    });
    const items = policy.presentation === 'model_document'
      ? SEMANTIC_SECTION_ORDER.flatMap(sec => rawItems.filter(item => (SEMANTIC_SECTION_ORDER.includes(item.semanticSection) ? item.semanticSection : 'EVIDENCE') === sec))
      : rawItems;

    const renderedPreview = formatPacketText(
      policy.consumer,
      scopeKey,
      items,
      independentSupportingSources.size,
      policy.hydrateSourceQuotes,
      policy.presentation
    );
    const usedCharacters = renderedPreview.length;
    const bodyCharacters = items.reduce((acc, i) => acc + String(i.text || '').length, 0);

    const bundleCore = {
      schema: 'libra.evidence_bundle.v1',
      consumer: policy.consumer,
      ...(policy.presentation === 'model_document' ? { presentation: 'model_document' } : {}),
      hydrateSourceQuotes: policy.hydrateSourceQuotes,
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
        excludedUnreadableUnits: excludedUnreadable.length,
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

    const privateRecord = {
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
        edgeIds: [...allEdgeIds].sort((a, b) => a.localeCompare(b, 'en')),
        basisIds: [...allBasisIds].sort((a, b) => a.localeCompare(b, 'en')),
        requiredBindings: Object.fromEntries([...requiredBindings.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))),
        requiredEdgeBindings: Object.fromEntries([...requiredEdgeBindings.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))),
        requiredBasisBindings: Object.fromEntries([...requiredBasisBindings.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en')))
      },
      readSetBytes: 256
        + (allNodeIds.size + allSourceIds.size + allEntityIds.size + allEdgeIds.size + allBasisIds.size) * 64
        + utf8Bytes(JSON.stringify(Object.fromEntries(requiredBindings)))
        + utf8Bytes(JSON.stringify(Object.fromEntries(requiredEdgeBindings)))
        + utf8Bytes(JSON.stringify(Object.fromEntries(requiredBasisBindings)))
    };

    resources?.retain(privateRecord, 'private_readset');
    privateRecord.resources = resources;
    privateRecord.release = resources ? () => resources.close('readset_revoked') : null;
    issuedReadSets.set(readSetToken,privateRecord);
    if (resources) resourceReadSets.add(readSetToken);
    resources?.onClose(() => revoke(readSetToken));
    const readSetBytes = privateRecord.readSetBytes;
    return Object.freeze({ bundle, readSetHandle: readSetToken, readSetBytes });
  };

  // Render consumer packet envelope from selected EvidenceBundle (§10, D07, D08, M09)
  const render = ({ bundle, readSetHandle } = {}, metrics = {}) => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    if (!record || record.revoked || record.compilerEpoch !== compilerEpoch) fail('readset_handle_invalid');
    if (!bundle || bundle.schema !== 'libra.evidence_bundle.v1' || bundle.bundleDigest !== readSetHandle.bundleDigest) {
      fail('bundle_mismatch');
    }
    const { bundleDigest: _omittedDigest, ...bundleCore } = bundle;
    if (hash(JSON.stringify(bundleCore)) !== readSetHandle.bundleDigest) {
      fail('bundle_mismatch');
    }
    const readsetBytes = metrics.readsetHandleStateBytes ?? record.readSetBytes ?? 256;
    if (metrics.readsetHandleStateBudget != null && readsetBytes > metrics.readsetHandleStateBudget) {
      fail('readset_handle_budget_exceeded');
    }
    const presentation = bundle.presentation === 'model_document' ? 'model_document' : 'default';
    const renderedText = formatPacketText(
      bundle.consumer,
      bundle.scopeKey,
      bundle.items,
      bundle.independentSupportingSourceCount,
      Boolean(bundle.hydrateSourceQuotes),
      presentation
    );
    const packetDigest = hash(JSON.stringify([
      'libra.rendered_consumer_packet.v1',
      bundle.consumer,
      bundle.scopeKey,
      bundle.worldlineId,
      bundle.bundleDigest,
      renderedText
    ]));
    const packet = Object.freeze({
      schema: 'libra.rendered_consumer_packet.v1',
      consumer: bundle.consumer,
      ...(presentation === 'model_document' ? { presentation: 'model_document' } : {}),
      scopeKey: bundle.scopeKey,
      worldlineId: bundle.worldlineId,
      renderedText,
      characterLength: renderedText.length,
      packetDigest,
      independentSourceCount: bundle.independentSupportingSourceCount,
      admittedNodeIds: Object.freeze(bundle.items.map(i => i.nodeId)),
      suppressedMicroIds: bundle.suppressedMicroIds,
      gradiaSelectionReceipt: bundle.gradiaSelectionReceipt,
      readSetHandle,
      modelDispatchEligible: false,
      byteInventory: memoryByteInventory({
        ...metrics,
        packetBytes: utf8Bytes(renderedText),
        bodyBytes: bundle.items.reduce((total, item) => total + utf8Bytes(item.text), 0),
        maxCharacters: Number(bundle.budget?.maxCharacters || 0),
        readsetHandleStateBytes: readsetBytes
      }),
      consumerVerification: verifyConsumerPacket({
        schema: 'libra.rendered_consumer_packet.v1',
        consumer: bundle.consumer,
        ...(presentation === 'model_document' ? { presentation: 'model_document' } : {}),
        scopeKey: bundle.scopeKey,
        renderedText,
        characterLength: renderedText.length,
        independentSourceCount: bundle.independentSupportingSourceCount,
        admittedNodeIds: bundle.items.map(i => i.nodeId),
        gradiaSelectionReceipt: bundle.gradiaSelectionReceipt,
        modelDispatchEligible: false
      }, { maxCharacters: Number(bundle.budget?.maxCharacters || 0), itemCount: bundle.items.length, presentation })
    });
    // Packet issuance happens only after retained admission. A failed render revokes the selection.
    try { record.packetLease = record.resources?.retain(packet, 'consumer_packet'); }
    catch (error) { revoke(readSetHandle); throw error; }
    if (!record.packets) record.packets = new Set();
    record.packets.add(packet);
    issuedPackets.set(packet, { bundle, readSetHandle });
    return packet;
  };

  // A public DTO/clone never carries issuance authority. Verify the exact issued
  // envelope and actual admitted items again at the consumer's final boundary.
  const validatePacket = async (packet, ownerVerifier) => {
    const issued = packet && issuedPackets.get(packet);
    if (!issued) fail('packet_not_issued');
    const { bundle, readSetHandle } = issued;
    const presentation = bundle.presentation === 'model_document' ? 'model_document' : 'default';
    if (packet.renderedText !== formatPacketText(bundle.consumer, bundle.scopeKey, bundle.items,
      bundle.independentSupportingSourceCount, Boolean(bundle.hydrateSourceQuotes), presentation)) fail('packet_content_changed');
    const check = verifyConsumerPacket(packet, { maxCharacters: bundle.budget.maxCharacters, itemCount: bundle.items.length, presentation });
    if (!check.ok) fail('consumer_packet_invalid');
    return await validateConsumedReadSet(readSetHandle, ownerVerifier);
  };

  // Final physical readset verification at model dispatch boundary (§10, §11, D02, D04, M10, V06, V07, V09, V12)
  const validateConsumedReadSet = async (readSetHandle, ownerVerifier = {}) => {
    const scoped = ownerVerifier.openValidation ? ownerVerifier.openValidation() : ownerVerifier;
    try { return await validateReadSet(readSetHandle,scoped); }
    finally { if (scoped !== ownerVerifier) scoped.release(); }
  };
  const validateReadSet = async (readSetHandle, ownerVerifier) => {
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

    // M10: Verify witness edge and basis bindings in addition to node/source bindings
    const liveEdgeBindings = new Map((live.edges || []).map(e => [e.id, e.bindingId]));
    for (const [edgeId, expectedBindingId] of Object.entries(record.dependencies.requiredEdgeBindings || {})) {
      const actualBindingId = liveEdgeBindings.get(edgeId);
      if (!actualBindingId || actualBindingId !== expectedBindingId) {
        fail('dependency_binding_stale');
      }
    }

    const liveBasisBindings = new Map((live.bases || []).map(b => [b.id, b.bindingId]));
    for (const [basisId, expectedBindingId] of Object.entries(record.dependencies.requiredBasisBindings || {})) {
      const actualBindingId = liveBasisBindings.get(basisId);
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

    const productExecutionAuthorized = Boolean(record.policy.productExecutionAuthorized);
    return Object.freeze({
      schema: 'libra.consumed_readset_verification.v1',
      status: 'verified',
      consumer: record.policy.consumer,
      productExecutionAuthorized,
      historicalFormatOnly: Boolean(record.policy.historicalFormatOnly),
      scopeKey: record.frame.scopeKey,
      worldlineId: record.frame.worldlineId,
      restoreEpoch: record.frame.restoreEpoch,
      verifiedNodeCount: Object.keys(record.dependencies.requiredBindings).length,
      verifiedEdgeCount: Object.keys(record.dependencies.requiredEdgeBindings || {}).length,
      verifiedBasisCount: Object.keys(record.dependencies.requiredBasisBindings || {}).length,
      verifiedSourceCount: record.dependencies.sourceIds.length,
      verifiedSuppressedMicroCount: record.bundle.suppressedMicroIds.length,
      modelDispatchEligible: productExecutionAuthorized
    });
  };

  const revoke = readSetHandle => {
    const record = readSetHandle && issuedReadSets.get(readSetHandle);
    if (record) {
      record.revoked = true; issuedReadSets.delete(readSetHandle);
      resourceReadSets.delete(readSetHandle);
      for (const packet of record.packets || []) issuedPackets.delete(packet);
      record.release?.();
    }
  };

  const invalidateAll = () => {
    compilerEpoch++;
    for (const handle of [...resourceReadSets]) revoke(handle);
    issuedReadSets = new WeakMap();
    issuedPackets = new WeakMap();
  };

  return Object.freeze({ select, render, validatePacket, validateConsumedReadSet, revoke, invalidateAll,
    renderPacketText: formatPacketText, verifyConsumerPacket, memoryByteInventory,
    ACTIVE_PRODUCT_CONSUMERS, HISTORICAL_FORMAT_ONLY_CONSUMERS,
    CONSUMER_PACKET_POLICIES, MEMORY_BYTE_CATEGORY_DECISIONS });
};
