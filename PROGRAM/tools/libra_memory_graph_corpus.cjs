'use strict';
// Full owner-window enumeration + durable common index + N01-A incremental source currentness verification
// + N01-B incremental corpus build/resume & oversized single-row splitting.
// Native readers still supply every fact and final delivery proof; persisted tables grant no authority.
module.exports = function createMemoryGraphCorpus({ pages, index, fingerprint, inventory = null } = {}) {
  if (!pages || !index?.restore || typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_CORPUS_ADAPTER_REQUIRED');
  const pools = ['nodes','edges','bases','units'];
  const tables = ['directory','adjacency','postings','reverseDependencies'];
  const schema = 'libra.graph_corpus.v1';
  const routingVersion = 'libra.index_page_routing.v1';
  // v2 requires source body baselines to be captured with the native projection,
  // never first observed later while the already-built graph is published.
  const proofVersion = 'libra.source_proof_contract.v2';
  const supportedProofVersions = new Set(['libra.source_proof_contract.v1', proofVersion]);
  const proofSchema = 'libra.graph_corpus_source_proofs.v1';
  const proofSummarySchema = 'libra.graph_corpus_source_proof_summary.v1';
  const projectionSchema = 'libra.graph_corpus_projection.v1';
  const checkpointSchema = 'libra.graph_corpus_build_checkpoint.v1';
  const maxCheckpointAttempts = 128;
  const rowChunkSchema = 'libra.graph_corpus_row_chunk.v1';
  let active = false;
  const knownFrames = new WeakMap();
  const fail = (reason, extra = null) => {
    const e = new Error('LIBRA_GRAPH_CORPUS_' + reason.toUpperCase());
    e.reason = reason;
    if (extra && typeof extra === 'object') Object.assign(e, extra);
    throw e;
  };
  const hash = value => { const h = fingerprint(value); if (!/^[a-f0-9]{64}$/.test(h)) fail('digest_invalid'); return h; };
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const clone = value => JSON.parse(JSON.stringify(value));
  const partition = graph => JSON.stringify({ owner: graph.readerFrame.owner, scopeKey: graph.scopeKey, viewer: graph.readerFrame.view.viewerId });
  const stamp = graph => pages.generation(graph, { partition: partition(graph), restoreEpoch: graph.readerFrame.restoreEpoch, view: graph.readerFrame });

  // N01-A: Explicit per-family currentness guarantee & conservative reread scope contracts.
  const DEFAULT_FAMILY_CURRENTNESS_CONTRACTS = Object.freeze({
    canonical: Object.freeze({
      family: 'canonical',
      proofMode: 'owner_manifest_ref_table_and_registry',
      proofBasis: Object.freeze(['owner_manifest_ref_table', 'entity_registry', 'restore_epoch', 'approved_evidence_binding']),
      guaranteedScope: Object.freeze(['unchanged_window_canonical_record_bodies', 'unchanged_window_canonical_assertions_and_edges']),
      reReadRequiredScope: Object.freeze(['owner_manifest_head', 'entity_registry_head', 'changed_canonical_windows', 'consumed_readset_physical_records']),
      skipUnchangedWindowBodyRead: true,
      reReadRequiredEveryRequest: false,
      unobservableWithoutFullAudit: Object.freeze(['unpinned_raw_storage_tampering_without_manifest_revision_change']),
      evidenceSymbols: Object.freeze(['canonicalReaderRefIdentity', 'loadManifest', 'ENTITY_REGISTRY_SCHEMA', 'microRestoreGeneration'])
    }),
    micro: Object.freeze({
      family: 'micro',
      proofMode: 'host_turn_pair_and_micro_head_revision',
      proofBasis: Object.freeze(['host_completed_turn_pair_digest', 'completed_turn_head_revision', 'micro_memory_head_revision', 'micro_work_attempt_digest', 'restore_epoch']),
      guaranteedScope: Object.freeze(['unchanged_window_micro_turn_record_bodies', 'unchanged_window_completed_turn_receipt_bodies', 'unchanged_window_micro_candidate_units']),
      reReadRequiredScope: Object.freeze(['host_chat_turn_pairs', 'per_turn_completed_and_micro_heads', 'changed_micro_windows', 'consumed_readset_physical_records']),
      skipUnchangedWindowBodyRead: true,
      reReadRequiredEveryRequest: false,
      unobservableWithoutFullAudit: Object.freeze(['unpinned_raw_micro_record_tampering_without_head_or_pair_change']),
      evidenceSymbols: Object.freeze(['completedTurnRevisionId', 'readActiveCompletedTurnReceipt', 'libra.micro_memory_head.v1', 'microRestoreGeneration'])
    }),
    state: Object.freeze({
      family: 'state',
      proofMode: 'scope_singleton_state_head_and_correction_journal',
      proofBasis: Object.freeze(['continuity_state_head', 'state_worldline_meta', 'state_correction_journal_revision', 'entity_registry', 'restore_epoch']),
      guaranteedScope: Object.freeze(['scope_singleton_state_projection_across_historical_windows']),
      reReadRequiredScope: Object.freeze(['scope_state_head_every_request', 'state_correction_journal_head_every_request', 'consumed_state_decision_keys']),
      skipUnchangedWindowBodyRead: true,
      reReadRequiredEveryRequest: true,
      unobservableWithoutFullAudit: Object.freeze([]),
      evidenceSymbols: Object.freeze(['loadContinuityStateForResponse', 'loadStateCorrectionJournal', 'stateWorldlineMeta'])
    }),
    lore: Object.freeze({
      family: 'lore',
      proofMode: 'host_lore_snapshot_and_link_index_reread',
      proofBasis: Object.freeze(['host_risu_lore_snapshot_digest', 'lore_link_mapping_head', 'lore_link_index_basis_digest']),
      guaranteedScope: Object.freeze(['scope_singleton_lore_projection_across_historical_windows']),
      reReadRequiredScope: Object.freeze(['host_risu_lore_snapshot_every_request', 'lore_link_mapping_every_request', 'lore_link_index_basis_every_request']),
      skipUnchangedWindowBodyRead: false,
      reReadRequiredEveryRequest: true,
      unobservableWithoutFullAudit: Object.freeze([]),
      evidenceSymbols: Object.freeze(['loadRisuContextSnapshot', 'loreLinkAllowedEntries', 'buildLoreLinkIndex'])
    })
  });
  const FAMILY_CURRENTNESS_CONTRACTS = inventory?.FAMILY_CURRENTNESS_CONTRACTS || DEFAULT_FAMILY_CURRENTNESS_CONTRACTS;

  // Owner cursor signatures contain request/runtime publication bindings. They
  // are fresh traversal handles, not durable content identities across restart.
  // Preserve whether another slice exists; native row/frame bindings identify
  // this slice and are independently re-derived on every read.
  const windowStamp = graph => stamp({ ...graph, coverage: { ...graph.coverage, inventory: { ...graph.coverage.inventory,
    canonicalNextCursor: graph.coverage.inventory.canonicalNextCursor ? 'unread' : '',
    microNextCursor: graph.coverage.inventory.microNextCursor ? 'unread' : '' } } });
  const location = graph => {
    const prefix = 'libra:v1:scope:' + graph.scopeKey + ':memory-graph:v1:corpus:';
    return { prefix, rootKey: prefix + 'root:' + hash(JSON.stringify(graph.readerFrame)), partition: partition(graph) };
  };
  const policy = input => {
    const clean = { ...input };
    delete clean.maxWindowsPerStep;
    delete clean.incremental;
    delete clean.resume;
    const value = { limit: 20, nodeLimit: 2048, maxWindows: 64, maxSerializedBytes: 4194304, pageBytes: 8192, ...clean };
    for (const [key,min,max] of [['limit',1,50],['nodeLimit',1,8192],['maxWindows',1,128],['maxSerializedBytes',65536,8388608],['pageBytes',512,16384]]) {
      if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) fail('policy_invalid');
    }
    if (Object.keys(value).some(key => !['limit','nodeLimit','maxWindows','maxSerializedBytes','pageBytes'].includes(key))) fail('policy_invalid');
    if (input?.maxWindowsPerStep !== undefined) {
      if (!Number.isSafeInteger(input.maxWindowsPerStep) || input.maxWindowsPerStep < 1 || input.maxWindowsPerStep > value.maxWindows) {
        fail('policy_invalid');
      }
    }
    if (input?.incremental !== undefined && typeof input.incremental !== 'boolean') fail('policy_invalid');
    if (input?.resume !== undefined && typeof input.resume !== 'boolean') fail('policy_invalid');
    return value;
  };

  const adjustReusedSliceCoverage = (sliceGraph, { canonicalTotal, microTurnTotal, hasNextCanonical, hasNextMicro }) => {
    const inv = sliceGraph.coverage?.inventory || {};
    const curHasNextC = Boolean(inv.canonicalNextCursor);
    const curHasNextM = Boolean(inv.microNextCursor);
    if (inv.canonicalTotal === canonicalTotal && inv.microTurnTotal === microTurnTotal
      && curHasNextC === hasNextCanonical && curHasNextM === hasNextMicro) {
      return sliceGraph;
    }
    const nextGraph = clone(sliceGraph);
    nextGraph.coverage.inventory.canonicalTotal = canonicalTotal;
    nextGraph.coverage.inventory.microTurnTotal = microTurnTotal;
    nextGraph.coverage.inventory.canonicalNextCursor = hasNextCanonical ? (inv.canonicalNextCursor || 'unread') : '';
    nextGraph.coverage.inventory.microNextCursor = hasNextMicro ? (inv.microNextCursor || 'unread') : '';
    if (nextGraph.coverage.families?.canonical) {
      const reasons = (nextGraph.coverage.families.canonical.reasons || []).filter(r => r !== 'canonical_pages_unread');
      if (hasNextCanonical) reasons.push('canonical_pages_unread');
      nextGraph.coverage.families.canonical.reasons = reasons;
    }
    if (nextGraph.coverage.families?.micro) {
      const reasons = (nextGraph.coverage.families.micro.reasons || []).filter(r => r !== 'micro_pages_unread');
      if (hasNextMicro) reasons.push('micro_pages_unread');
      nextGraph.coverage.families.micro.reasons = reasons;
    }
    const failures = nextGraph.coverage.sourceReadFailures || [];
    nextGraph.coverage.projectionComplete = failures.length === 0
      && Object.values(nextGraph.coverage.families || {}).every(entry => !(entry.reasons || []).length);
    return nextGraph;
  };

  const enumerate = async (snapshot, input, check = () => {}, incrementalPlan = null) => {
    const config = policy(input);
    const maxWindowsPerStep = Number.isSafeInteger(input?.maxWindowsPerStep) ? input.maxWindowsPerStep : null;
    const priorSlices = Array.isArray(incrementalPlan?.priorSlices) ? incrementalPlan.priorSlices : [];
    const reusableSet = incrementalPlan?.reusableSet instanceof Set ? incrementalPlan.reusableSet : new Set();
    const liveWindowsMeta = Array.isArray(incrementalPlan?.liveWindows) ? incrementalPlan.liveWindows : null;
    const targetWindowCount = Number.isSafeInteger(incrementalPlan?.liveWindowCount) && incrementalPlan.liveWindowCount > 0
      ? incrementalPlan.liveWindowCount
      : null;

    const collectedSlices = [];
    let first = null, baseCollected = incrementalPlan?.baseCollected || null;
    let options = { limit: config.limit, nodeLimit: config.nodeLimit, canonicalCursor: '', microCursor: '' };
    let enumeratedWindowCount = 0, reusedWindowCount = 0, pausedAtCheckpoint = false;

    for (;;) {
      check();
      const ordinal = collectedSlices.length;
      if (ordinal >= config.maxWindows) fail('window_budget');

      if (reusableSet.has(ordinal) && priorSlices[ordinal]?.graph) {
        const reused = clone(priorSlices[ordinal]);
        const graph = reused.graph;
        if (!first) first = graph;
        if (!same(first.readerFrame, graph.readerFrame) || graph.scopeKey !== first.scopeKey) fail('frame_changed');
        reusedWindowCount++;
        const liveMeta = liveWindowsMeta?.[ordinal] || null;
        const nextLiveMeta = liveWindowsMeta?.[ordinal + 1] || null;
        const canonicalOffset = Number.isSafeInteger(liveMeta?.canonicalOffset) ? liveMeta.canonicalOffset : reused.canonicalOffset ?? null;
        const microOffset = Number.isSafeInteger(liveMeta?.microOffset) ? liveMeta.microOffset : reused.microOffset ?? null;
        collectedSlices.push({
          ...reused,
          ordinal,
          canonicalOffset,
          microOffset,
          reused: true
        });
        const hasMoreWindows = targetWindowCount !== null
          ? ordinal + 1 < targetWindowCount
          : Boolean(reused.nextCanonical || reused.nextMicro);
        if (!hasMoreWindows) break;
        const nextCanonicalOffset = Number.isSafeInteger(nextLiveMeta?.canonicalOffset) ? nextLiveMeta.canonicalOffset : null;
        const nextMicroOffset = Number.isSafeInteger(nextLiveMeta?.microOffset) ? nextLiveMeta.microOffset : null;
        const canonicalAdvanced = nextCanonicalOffset !== null && canonicalOffset !== null && nextCanonicalOffset > canonicalOffset;
        const microAdvanced = nextMicroOffset !== null && microOffset !== null && nextMicroOffset > microOffset;
        const nextCanonicalCursor = reused.nextCanonical
          || (canonicalAdvanced ? String(nextCanonicalOffset) : (reused.requestOptions?.canonicalCursor || options.canonicalCursor));
        const nextMicroCursor = reused.nextMicro
          || (microAdvanced ? String(nextMicroOffset) : (reused.requestOptions?.microCursor || options.microCursor));
        options = {
          limit: config.limit,
          nodeLimit: config.nodeLimit,
          canonicalCursor: nextCanonicalCursor,
          microCursor: nextMicroCursor,
          ...(nextCanonicalOffset !== null ? { canonicalOffset: nextCanonicalOffset } : {}),
          ...(nextMicroOffset !== null ? { microOffset: nextMicroOffset } : {})
        };
        continue;
      }

      const reqOptions = {
        limit: config.limit,
        nodeLimit: config.nodeLimit,
        canonicalCursor: options.canonicalCursor || '',
        microCursor: options.microCursor || '',
        ...(Number.isSafeInteger(options.canonicalOffset) ? { canonicalOffset: options.canonicalOffset } : {}),
        ...(Number.isSafeInteger(options.microOffset) ? { microOffset: options.microOffset } : {})
      };
      let value;
      try {
        value = await snapshot(reqOptions);
      } catch (err) {
        if ((reqOptions.canonicalOffset !== undefined || reqOptions.microOffset !== undefined)
          && /OPTIONS_INVALID/.test(String(err?.message || ''))) {
          value = await snapshot({
            limit: config.limit,
            nodeLimit: config.nodeLimit,
            canonicalCursor: reqOptions.canonicalCursor,
            microCursor: reqOptions.microCursor
          });
        } else throw err;
      }
      check();
      enumeratedWindowCount++;
      const graph = value.graph;
      if (!first) first = graph;
      if (value.collected && !baseCollected) baseCollected = value.collected;
      else if (value.collected?.entityRegistry?.length) baseCollected = { ...baseCollected, ...value.collected };
      if (!same(first.readerFrame, graph.readerFrame) || graph.scopeKey !== first.scopeKey) fail('frame_changed');
      const inv = graph.coverage?.inventory;
      if (!inv) fail('inventory_changed');
      const currentWindowStamp = windowStamp(graph);
      const nextCanonical = inv.canonicalNextCursor || '', nextMicro = inv.microNextCursor || '';
      const ownerWp = value.windowProof || value.collected?.windowProof || null;
      const liveMeta = liveWindowsMeta?.[ordinal] || null;
      collectedSlices.push({
        ordinal,
        stamp: currentWindowStamp,
        requestOptions: {
          limit: config.limit,
          nodeLimit: config.nodeLimit,
          canonicalCursor: reqOptions.canonicalCursor,
          microCursor: reqOptions.microCursor
        },
        canonicalOffset: Number.isSafeInteger(ownerWp?.canonicalOffset) ? ownerWp.canonicalOffset : (liveMeta?.canonicalOffset ?? null),
        microOffset: Number.isSafeInteger(ownerWp?.microOffset) ? ownerWp.microOffset : (liveMeta?.microOffset ?? null),
        nextCanonical,
        nextMicro,
        graph,
        sourceKeys: [...(value.collected?.sourceKeys || [])],
        sourceBodyDigests: { ...(value.collected?.sourceBodyDigests || {}) },
        canonicalRows: [...(value.collected?.canonicalRows || [])],
        windowProof: ownerWp,
        reused: false
      });

      if (!nextCanonical && !nextMicro) break;
      const next = {
        limit: config.limit,
        nodeLimit: config.nodeLimit,
        canonicalCursor: nextCanonical || reqOptions.canonicalCursor,
        microCursor: nextMicro || reqOptions.microCursor
      };
      if (same(next, {
        limit: config.limit,
        nodeLimit: config.nodeLimit,
        canonicalCursor: reqOptions.canonicalCursor,
        microCursor: reqOptions.microCursor
      })) fail('cursor_stalled');
      options = next;
      if (maxWindowsPerStep !== null && enumeratedWindowCount >= maxWindowsPerStep) {
        pausedAtCheckpoint = true;
        break;
      }
    }

    if (pausedAtCheckpoint) {
      return {
        pausedAtCheckpoint: true,
        firstGraph: first,
        windowSlices: collectedSlices,
        reusedWindowCount,
        enumeratedWindowCount,
        config
      };
    }

    const freshSlice = collectedSlices.find(s => !s.reused) || null;
    const freshOwnerProof = freshSlice?.windowProof || null;
    const canonicalTotal = freshSlice
      ? freshSlice.graph.coverage.inventory.canonicalTotal
      : (incrementalPlan?.liveCanonicalTotal ?? collectedSlices[0].graph.coverage.inventory.canonicalTotal);
    const microTurnTotal = freshSlice
      ? freshSlice.graph.coverage.inventory.microTurnTotal
      : (incrementalPlan?.liveMicroTurnTotal ?? collectedSlices[0].graph.coverage.inventory.microTurnTotal);

    const freshPools = Object.fromEntries(pools.map(pool => [pool, new Map()]));
    const freshCanonicalRows = new Map();
    for (const slice of collectedSlices) {
      if (slice.reused) continue;
      for (const pool of pools) for (const row of slice.graph[pool]) {
        const id = row.id || row.nodeId, before = freshPools[pool].get(id);
        if (before && !same(before, row)) fail('overlap_changed');
        freshPools[pool].set(id, row);
      }
      for (const row of slice.canonicalRows || []) {
        const before = freshCanonicalRows.get(row.key);
        if (before && !same(before, row)) fail('source_changed');
        freshCanonicalRows.set(row.key, row);
      }
    }

    const maps = Object.fromEntries(pools.map(pool => [pool, new Map()]));
    const sourceKeys = new Set(), canonicalRows = new Map(), windows = [], windowProofs = [], reasons = {}, families = {}, sourceReadFailures = new Map();
    const reusedSourceKeys = new Set(), enumeratedSourceKeys = new Set();
    let bytes = 0;

    for (let idx = 0; idx < collectedSlices.length; idx++) {
      const slice = collectedSlices[idx];
      if (!slice.reused) {
        const inv = slice.graph.coverage?.inventory;
        if (!inv || inv.canonicalTotal !== canonicalTotal || inv.microTurnTotal !== microTurnTotal) fail('inventory_changed');
      } else {
        if (freshSlice?.graph) {
          const isSingletonFamily = f => f === 'state' || f === 'lore';
          const isSingletonBasis = b => ['state_field_evidence', 'state_correction', 'lore_passage'].includes(b.kind);
          const splitSingletonGraph = g => {
            const cmUnits = (g.units || []).filter(u => !isSingletonFamily(u.family));
            const slUnits = (g.units || []).filter(u => isSingletonFamily(u.family));
            const cmBases = (g.bases || []).filter(b => !isSingletonBasis(b));
            const slBases = (g.bases || []).filter(b => isSingletonBasis(b));
            const slBasisIds = new Set(slBases.map(b => b.id));
            const cmMeaningIds = new Set(cmUnits.map(u => u.nodeId));
            const slMeaningIds = new Set(slUnits.map(u => u.nodeId));
            const cmSourceIds = new Set(cmBases.map(b => b.sourceId).filter(Boolean));
            const slSourceIds = new Set(slBases.map(b => b.sourceId).filter(Boolean));
            const cmNodes = (g.nodes || []).filter(n => n.layer === 'entity' || cmMeaningIds.has(n.id) || cmSourceIds.has(n.id) || (!slMeaningIds.has(n.id) && !slSourceIds.has(n.id) && n.layer !== 'source'));
            const slNodes = (g.nodes || []).filter(n => !cmNodes.includes(n));
            const cmEdges = (g.edges || []).filter(e => !slBasisIds.has(e.basisId));
            const slEdges = (g.edges || []).filter(e => slBasisIds.has(e.basisId));
            return { cmUnits, slUnits, cmBases, slBases, cmNodes, slNodes, cmEdges, slEdges, cmMeaningIds };
          };
          if ((freshSlice.graph.units || []).some(u => isSingletonFamily(u.family))) {
            const r = splitSingletonGraph(slice.graph);
            const f = splitSingletonGraph(freshSlice.graph);
            const nextNodeIds = new Set([...r.cmNodes.map(n => n.id), ...f.slNodes.map(n => n.id)]);
            const slEdgesFiltered = f.slEdges.filter(e => nextNodeIds.has(e.from) && nextNodeIds.has(e.to));
            const fSlNodeIds = new Set(f.slNodes.map(n => n.id));
            const fSlEdgeIds = new Set(slEdgesFiltered.map(e => e.id));
            const extraDerivedEdges = r.slEdges.filter(e =>
              e.predicate === 'derived_from'
              && fSlNodeIds.has(e.from)
              && r.cmMeaningIds.has(e.to)
              && !fSlEdgeIds.has(e.id)
            );
            slice.graph = {
              ...slice.graph,
              nodes: [...r.cmNodes, ...f.slNodes],
              edges: [...r.cmEdges, ...slEdgesFiltered, ...extraDerivedEdges],
              bases: [...r.cmBases, ...f.slBases],
              units: [...r.cmUnits, ...f.slUnits],
              coverage: {
                ...slice.graph.coverage,
                families: {
                  ...slice.graph.coverage?.families,
                  ...(freshSlice.graph.coverage?.families?.state ? { state: clone(freshSlice.graph.coverage.families.state) } : {}),
                  ...(freshSlice.graph.coverage?.families?.lore ? { lore: clone(freshSlice.graph.coverage.families.lore) } : {})
                }
              }
            };
          }
        }
        let graphChangedByFreshOverlap = false;
        const nextPools = {};
        for (const pool of pools) {
          nextPools[pool] = (slice.graph[pool] || []).map(row => {
            const id = row.id || row.nodeId;
            const freshRow = freshPools[pool].get(id);
            if (freshRow && !same(freshRow, row)) {
              graphChangedByFreshOverlap = true;
              return freshRow;
            }
            return row;
          });
        }
        if (graphChangedByFreshOverlap) {
          slice.graph = { ...slice.graph, ...nextPools };
        }
        if (Array.isArray(slice.canonicalRows) && freshCanonicalRows.size) {
          slice.canonicalRows = slice.canonicalRows.map(row => freshCanonicalRows.get(row.key) || row);
        }
        const nextSlice = collectedSlices[idx + 1] || null;
        const hasNextCanonical = Boolean(nextSlice) && (
          Boolean(slice.nextCanonical)
          || (Number.isSafeInteger(nextSlice.canonicalOffset) && Number.isSafeInteger(slice.canonicalOffset) && nextSlice.canonicalOffset > slice.canonicalOffset)
        );
        const hasNextMicro = Boolean(nextSlice) && (
          Boolean(slice.nextMicro)
          || (Number.isSafeInteger(nextSlice.microOffset) && Number.isSafeInteger(slice.microOffset) && nextSlice.microOffset > slice.microOffset)
        );
        slice.graph = adjustReusedSliceCoverage(slice.graph, {
          canonicalTotal,
          microTurnTotal,
          hasNextCanonical,
          hasNextMicro
        });
        slice.stamp = windowStamp(slice.graph);
        slice.nextCanonical = slice.graph.coverage.inventory.canonicalNextCursor || '';
        slice.nextMicro = slice.graph.coverage.inventory.microNextCursor || '';
        if (slice.windowProof && freshOwnerProof) {
          slice.windowProof = {
            ...slice.windowProof,
            manifestDigest: freshOwnerProof.manifestDigest,
            registryDigest: freshOwnerProof.registryDigest,
            turnPairsDigest: freshOwnerProof.turnPairsDigest,
            stateProof: freshOwnerProof.stateProof,
            loreProof: freshOwnerProof.loreProof
          };
        }
      }
      const graph = slice.graph;
      const inv = graph.coverage.inventory;
      const currentWindowStamp = windowStamp(graph);
      slice.stamp = currentWindowStamp;
      windows.push({ ordinal: idx, stamp: currentWindowStamp });
      windowProofs.push({
        ordinal: idx,
        stamp: currentWindowStamp,
        canonicalNext: inv.canonicalNextCursor ? 'unread' : '',
        microNext: inv.microNextCursor ? 'unread' : '',
        ownerProof: slice.windowProof || null,
        reused: Boolean(slice.reused)
      });
      for (const pool of pools) for (const row of graph[pool]) {
        const id = row.id || row.nodeId, before = maps[pool].get(id);
        if (before) { if (!same(before, row)) fail('overlap_changed'); continue; }
        bytes += pages.measure(row, config.maxSerializedBytes).utf8Bytes;
        if (bytes > config.maxSerializedBytes) fail('workspace_budget');
        maps[pool].set(id, row);
      }
      for (const key of slice.sourceKeys || []) {
        sourceKeys.add(key);
        if (slice.reused) reusedSourceKeys.add(key);
        else enumeratedSourceKeys.add(key);
      }
      for (const row of slice.canonicalRows || []) {
        const before = canonicalRows.get(row.key);
        if (before && !same(before, row)) fail('source_changed');
        canonicalRows.set(row.key, row);
      }
      for (const failure of graph.coverage?.sourceReadFailures || []) sourceReadFailures.set(JSON.stringify(failure), failure);
      for (const [family, entry] of Object.entries(graph.coverage.families || {})) {
        families[family] = { ...entry }; reasons[family] ||= new Set();
        for (const reason of entry.reasons || []) if (!['canonical_pages_unread','micro_pages_unread'].includes(reason)) reasons[family].add(reason);
      }
    }

    const firstSliceGraph = collectedSlices[0].graph;
    const arrays = Object.fromEntries(pools.map(pool => [pool, [...maps[pool].values()]]));
    const derived = new Set(arrays.edges.filter(edge => edge.predicate === 'derived_from').map(edge => edge.from));
    if (reasons.state?.has('field_basis_outside_page_or_unresolved')
      && arrays.units.filter(unit => unit.family === 'state' && unit.provenanceStatus === 'recorded'
        && unit.semanticRole !== 'user_corrected').every(unit => derived.has(unit.nodeId))) {
      reasons.state.delete('field_basis_outside_page_or_unresolved');
    }
    for (const [family, entry] of Object.entries(families)) {
      entry.reasons = [...reasons[family]];
      const units = arrays.units.filter(unit => unit.family === family);
      entry.units = units.length;
      entry.records = new Set(units.map(unit => maps.nodes.get(unit.nodeId)?.sourceId || unit.recordKey || unit.nodeId)).size;
    }
    const graph = { ...firstSliceGraph, ...arrays, coverage: { ...firstSliceGraph.coverage, scope: 'enumerated_owner_windows', families,
      sourceReadFailures: [...sourceReadFailures.values()],
      inventory: { ...firstSliceGraph.coverage.inventory, canonicalTotal, microTurnTotal, canonicalRead: canonicalRows.size,
        microRead: new Set(arrays.units.filter(unit => unit.family === 'micro').map(unit => unit.recordKey || unit.nodeId)).size,
        canonicalNextCursor: '', microNextCursor: '', inventoryComplete: false,
        scope: 'enumerated_owner_windows', enumeratedWindows: windows.length, exhaustiveOwnerDeltaVerified: false },
      projectionComplete: sourceReadFailures.size === 0 && Object.values(families).every(entry => !entry.reasons.length) } };
    const windowSlices = collectedSlices.map(s => ({
      ordinal: s.ordinal,
      stamp: s.stamp,
      requestOptions: s.requestOptions,
      canonicalOffset: s.canonicalOffset ?? null,
      microOffset: s.microOffset ?? null,
      nextCanonical: s.nextCanonical,
      nextMicro: s.nextMicro,
      graph: s.graph,
      sourceKeys: s.sourceKeys,
      sourceBodyDigests: s.sourceBodyDigests,
      canonicalRows: s.canonicalRows,
      windowProof: s.windowProof || null
    }));
    return {
      pausedAtCheckpoint: false,
      graph,
      windows,
      windowProofs,
      windowSlices,
      reusedWindowCount,
      enumeratedWindowCount,
      reusedOnlySourceKeys: [...reusedSourceKeys].filter(k => !enumeratedSourceKeys.has(k)),
      collected: { ...(baseCollected || {}), sourceKeys: [...sourceKeys].sort(), canonicalRows: [...canonicalRows.values()], windowProofs,
        sourceBodyDigests: freshBodyDigests(collectedSlices) },
      serializedGraphBytes: bytes,
      config
    };
  };

  const freshBodyDigests = slices => {
    const result = {};
    for (const slice of slices) if (!slice.reused) {
      for (const [key, value] of Object.entries(slice.sourceBodyDigests || {})) {
        if (Object.hasOwn(result,key) && result[key] !== value) fail('source_body_changed');
        result[key] = value;
      }
    }
    return result;
  };

  const parse = (raw, maximum) => {
    if (typeof raw !== 'string' || raw.length > maximum || new TextEncoder().encode(raw).length > maximum) fail('record_size');
    try { return JSON.parse(raw); } catch (_) { fail('record_invalid'); }
  };
  const immutable = async (owner, key, raw) => {
    owner.check(); const before = await owner.read(key); owner.check();
    let reused = false;
    if (before === null) await owner.putImmutable(key, raw);
    else if (before !== raw) fail('immutable_collision');
    else reused = true;
    if (await owner.read(key) !== raw) fail('write_readback'); owner.check();
    return reused;
  };
  // A cold or superseded derived index never selects another search engine.
  // Read the current owner corpus and compile it once in the same query path.
  const prepare = async ({ snapshot, owner, options = {}, reason = 'no_published_corpus' } = {}) => {
    const native = await enumerate(snapshot, options, owner.check), generation = stamp(native.graph);
    if (owner && typeof owner === 'object') knownFrames.set(owner, native.graph);
    return { ...native, compiledIndex: null,
      currentGraph: async () => {
        const live = await enumerate(snapshot, native.config, owner.check);
        if (!same(live.windows,native.windows) || stamp(live.graph) !== generation) fail('source_changed');
        return live.graph;
      },
      access: { schema, mode: 'request_local_corpus', reason, generation, windowCount: native.windows.length,
        familyContracts: FAMILY_CURRENTNESS_CONTRACTS,
        nativeReprojectionRequired: true, ownerAtomicity: false, inventoryComplete: false, byteBounded: false }
    };
  };

  const routingKinds = { directory: ['node','source'], adjacency: ['anchor'],
    postings: ['lexical','entity','predicate','time'], reverseDependencies: ['dependency'] };
  const range = values => {
    const sorted = [...new Set(values.filter(value => typeof value === 'string' && value))].sort((a,b) => a.localeCompare(b,'en'));
    return sorted.length ? { min: sorted[0], max: sorted.at(-1) } : null;
  };
  const routingFor = (table, rows) => routingKinds[table].flatMap(kind => {
    const values = rows.flatMap(row => {
      if (row && row.__chunkSchema === rowChunkSchema) {
        return Array.isArray(row.routing)
          ? row.routing.filter(r => r?.kind === kind).flatMap(r => [r.min, r.max])
          : [];
      }
      if (table === 'postings' && row.channel !== kind) return [];
      return [table === 'postings' ? row.term : kind === 'node' ? row.nodeId : kind === 'source' ? row.sourceId
        : kind === 'anchor' ? row.anchorNodeId : row.dependencyKey];
    });
    const value = range(values); return value ? [{ kind, ...value }] : [];
  });
  const validSplitRowMeta = ref => {
    if (ref.splitRow === undefined && ref.physicalRows === undefined) return true;
    const sr = ref.splitRow;
    const phys = ref.physicalRows;
    if (!sr || typeof sr !== 'object' || !Number.isSafeInteger(phys) || phys < 1) return false;
    if (!/^[a-f0-9]{64}$/.test(String(sr.splitId || ''))
      || !Number.isSafeInteger(sr.rowIndex) || sr.rowIndex < 0
      || !Number.isSafeInteger(sr.partStart) || sr.partStart < 0
      || !Number.isSafeInteger(sr.partCount) || sr.partCount !== phys
      || !Number.isSafeInteger(sr.totalParts) || sr.totalParts < 2
      || sr.partStart + sr.partCount > sr.totalParts) return false;
    if (sr.partStart === 0 ? ref.rows !== 1 : ref.rows !== 0) return false;
    return true;
  };
  const validRouting = ref => {
    const physRows = ref.physicalRows ?? ref.rows;
    return Array.isArray(ref.routing) && ref.routing.length <= routingKinds[ref.table].length
      && new Set(ref.routing.map(row => row?.kind)).size === ref.routing.length
      && (physRows === 0 ? ref.routing.length === 0 : ref.routing.length > 0)
      && ref.routing.every(row => row && Object.keys(row).sort().join(',') === 'kind,max,min'
        && routingKinds[ref.table].includes(row.kind) && typeof row.min === 'string' && row.min.length > 0 && row.min.length <= 8192
        && typeof row.max === 'string' && row.max.length > 0 && row.max.length <= 8192 && row.min.localeCompare(row.max,'en') <= 0);
  };
  const mightContain = (ref, spec) => {
    const term = spec.table === 'postings' ? spec.term : spec.table === 'reverseDependencies' ? spec.dependencyKey : spec.anchorNodeId;
    return ref.routing.some(row => (!spec.channel || spec.table !== 'postings' || row.kind === spec.channel)
      && (!term || row.min.localeCompare(term,'en') <= 0 && row.max.localeCompare(term,'en') >= 0));
  };

  // N01-B: Deterministic splitting of oversized single index rows into page-bounded chunks.
  const rowFitsPage = (row, maxPageBytes) => {
    try {
      pages.measure(row, maxPageBytes - 2);
      return true;
    } catch (err) {
      if (err.reason === 'row_exceeds_page') return false;
      throw err;
    }
  };
  const splitOversizedRow = (table, row, rowIndex, maxPageBytes) => {
    const rawJson = JSON.stringify(row);
    const rowDigest = hash(rawJson);
    const rowRouting = routingFor(table, [row]);
    const maxItemBytes = maxPageBytes - 2;
    const probeChunk = (slice, chunkIndex = 9999, chunkCount = 9999) => ({
      __chunkSchema: rowChunkSchema,
      table,
      rowIndex,
      chunkIndex,
      chunkCount,
      rowDigest,
      routing: rowRouting,
      slice
    });
    if (!rowFitsPage(probeChunk(''), maxPageBytes)) fail('page_row_exceeds_page');
    const codePoints = Array.from(rawJson);
    const slices = [];
    let cursor = 0;
    while (cursor < codePoints.length) {
      let low = 1, high = codePoints.length - cursor, best = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const candidate = codePoints.slice(cursor, cursor + mid).join('');
        if (rowFitsPage(probeChunk(candidate), maxPageBytes)) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best <= 0) fail('page_row_exceeds_page');
      slices.push(codePoints.slice(cursor, cursor + best).join(''));
      cursor += best;
    }
    return slices.map((slice, chunkIndex) => ({
      __chunkSchema: rowChunkSchema,
      table,
      rowIndex,
      chunkIndex,
      chunkCount: slices.length,
      rowDigest,
      routing: rowRouting,
      slice
    }));
  };

  const reassembleTableRows = (table, rawItems) => {
    const out = [];
    let splitReassembled = false;
    let i = 0;
    while (i < rawItems.length) {
      const item = rawItems[i];
      if (!item || typeof item !== 'object') fail('page_corrupt');
      if (item.__chunkSchema !== rowChunkSchema) {
        out.push(item);
        i++;
        continue;
      }
      splitReassembled = true;
      const { rowDigest, rowIndex, chunkCount } = item;
      if (item.table !== table || item.chunkIndex !== 0 || !Number.isSafeInteger(chunkCount) || chunkCount < 2
        || !/^[a-f0-9]{64}$/.test(String(rowDigest || '')) || !Number.isSafeInteger(rowIndex) || rowIndex < 0) {
        fail('page_corrupt');
      }
      if (i + chunkCount > rawItems.length) fail('page_corrupt');
      let joined = '';
      for (let part = 0; part < chunkCount; part++) {
        const chunk = rawItems[i + part];
        if (!chunk || chunk.__chunkSchema !== rowChunkSchema || chunk.table !== table
          || chunk.rowDigest !== rowDigest || chunk.rowIndex !== rowIndex
          || chunk.chunkCount !== chunkCount || chunk.chunkIndex !== part
          || typeof chunk.slice !== 'string') {
          fail('page_corrupt');
        }
        joined += chunk.slice;
      }
      if (hash(joined) !== rowDigest) fail('page_corrupt');
      let parsed;
      try { parsed = JSON.parse(joined); } catch (_) { fail('page_corrupt'); }
      out.push(parsed);
      i += chunkCount;
    }
    return { rows: out, splitReassembled };
  };

  const checkpointAttemptKey = (loc, frame, previousRootRaw, attempt) =>
    loc.prefix + 'checkpoint:' + hash(JSON.stringify([frame, previousRootRaw || 'initial', attempt]));

  const loadLatestCheckpoint = async (owner, loc, frame, previousRootRaw, config) => {
    let latest = null;
    for (let attempt = 0; attempt < maxCheckpointAttempts; attempt++) {
      const key = checkpointAttemptKey(loc, frame, previousRootRaw, attempt);
      const raw = await owner.read(key); owner.check();
      if (raw === null) break;
      const parsed = parse(raw, config.maxSerializedBytes);
      const { payloadDigest, ...body } = parsed || {};
      if (parsed?.schema === checkpointSchema && parsed.proofVersion === proofVersion && payloadDigest === hash(JSON.stringify(body)) && same(parsed.frame, frame)
        && parsed.config?.limit === config.limit && parsed.config?.nodeLimit === config.nodeLimit
        && Array.isArray(parsed.windowSlices) && parsed.windowSlices.length > 0) {
        latest = { key, attempt, record: parsed };
      }
    }
    return latest;
  };

  const resolveIncrementalPlan = async ({ owner, startGraph, loc, previousRootRaw, config, resume }) => {
    if (!resume || !startGraph) return null;
    const latestCheckpoint = await loadLatestCheckpoint(owner, loc, startGraph.readerFrame, previousRootRaw, config);
    if (latestCheckpoint) {
      const cp = latestCheckpoint.record;
      let reusableSet = new Set();
      let liveWindows = null, liveWindowCount = null, liveCanonicalTotal = null, liveMicroTurnTotal = null;
      if (cp.ownerProof && typeof owner.verifySourceProofs === 'function') {
        const verdict = await owner.verifySourceProofs({ ownerProof: cp.ownerProof, windows: cp.windows }, { initialGraph: startGraph, config, phase: 'build' });
        owner.check();
        if (verdict && Array.isArray(verdict.reusableWindows)) {
          reusableSet = new Set(verdict.reusableWindows.filter(idx => idx < cp.windowSlices.length));
          liveWindows = verdict.liveWindows || null;
          liveWindowCount = verdict.liveWindowCount ?? null;
          liveCanonicalTotal = verdict.liveCanonicalTotal ?? null;
          liveMicroTurnTotal = verdict.liveMicroTurnTotal ?? null;
        }
      }
      if (reusableSet.size > 0) {
        return {
          mode: 'checkpoint_resume',
          checkpointAttempt: latestCheckpoint.attempt + 1,
          priorSlices: cp.windowSlices,
          reusableSet,
          liveWindows,
          liveWindowCount,
          liveCanonicalTotal,
          liveMicroTurnTotal,
          previousOwnerProof: cp.ownerProof || null
        };
      }
    }
    if (!previousRootRaw || typeof owner.verifySourceProofs !== 'function') return null;
    try {
      const root = parse(previousRootRaw, 2048);
      if (root?.schema !== schema || !/^[a-f0-9]{64}$/.test(root.digest) || root.manifestKey !== loc.prefix + 'manifest:' + root.digest) return null;
      const manifestRaw = await owner.read(root.manifestKey); owner.check();
      if (typeof manifestRaw !== 'string' || hash(manifestRaw) !== root.digest) return null;
      const manifest = parse(manifestRaw, 131072);
      if (!same(manifest.frame, startGraph.readerFrame)
        || manifest.config?.limit !== config.limit
        || manifest.config?.nodeLimit !== config.nodeLimit
        || manifest.sourceProofs?.proofVersion !== proofVersion
        || !manifest.sourceProofs?.proofKey || !manifest.sourceProofs?.projectionKey) return null;
      const proofRaw = await owner.read(manifest.sourceProofs.proofKey); owner.check();
      if (typeof proofRaw !== 'string' || hash(proofRaw) !== manifest.sourceProofs.proofDigest) return null;
      const proofRecord = parse(proofRaw, config.maxSerializedBytes);
      const projRaw = await owner.read(manifest.sourceProofs.projectionKey); owner.check();
      if (typeof projRaw !== 'string' || hash(projRaw) !== manifest.sourceProofs.projectionDigest) return null;
      const projRecord = parse(projRaw, config.maxSerializedBytes);
      if (!proofRecord?.ownerProof || !Array.isArray(projRecord?.windowSlices) || !projRecord.windowSlices.length) return null;
      const verdict = await owner.verifySourceProofs(proofRecord, { initialGraph: startGraph, config, phase: 'build' });
      owner.check();
      if (!verdict || !Array.isArray(verdict.reusableWindows) || verdict.reusableWindows.length === 0) return null;
      return {
        mode: 'incremental_reuse',
        checkpointAttempt: 0,
        priorSlices: projRecord.windowSlices,
        reusableSet: new Set(verdict.reusableWindows),
        liveWindows: verdict.liveWindows || null,
        liveWindowCount: verdict.liveWindowCount ?? null,
        liveCanonicalTotal: verdict.liveCanonicalTotal ?? null,
        liveMicroTurnTotal: verdict.liveMicroTurnTotal ?? null,
        previousOwnerProof: proofRecord.ownerProof,
        baseCollected: projRecord.collected || null
      };
    } catch (_) {
      return null;
    }
  };

  const build = async ({ initialGraph, snapshot, owner, options = {} } = {}) => {
    if (active) fail('build_busy'); active = true;
    try {
      const config = policy(options);
      const allowIncremental = options?.incremental !== false;
      const allowResume = options?.resume !== false;
      const startGraph = initialGraph || (owner && typeof owner === 'object' ? knownFrames.get(owner) || null : null);
      let priorLoc = startGraph ? location(startGraph) : null;
      let previous = priorLoc ? await owner.read(priorLoc.rootKey) : null;
      owner.check();
      const incrementalPlan = allowIncremental && priorLoc
        ? await resolveIncrementalPlan({ owner, startGraph, loc: priorLoc, previousRootRaw: previous, config, resume: allowResume })
        : null;

      const value = await enumerate(snapshot, options, owner.check, incrementalPlan);
      if (value.pausedAtCheckpoint) {
        const fg = value.firstGraph;
        if (owner && typeof owner === 'object') knownFrames.set(owner, fg);
        const loc = location(fg);
        if (!priorLoc) { priorLoc = loc; previous = await owner.read(loc.rootKey); owner.check(); }
        const partialWindows = value.windowSlices.map((s, idx) => ({ ordinal: idx, stamp: s.stamp }));
        const partialWindowProofs = value.windowSlices.map((s, idx) => ({
          ordinal: idx,
          stamp: s.stamp,
          canonicalNext: s.nextCanonical ? 'unread' : '',
          microNext: s.nextMicro ? 'unread' : '',
          ownerProof: s.windowProof || null
        }));
        const partialOwnerProof = typeof owner.captureSourceProof === 'function'
          ? await owner.captureSourceProof({
              graph: fg,
              collected: { sourceKeys: value.windowSlices.flatMap(s => s.sourceKeys || []), windowProofs: partialWindowProofs,
                sourceBodyDigests: freshBodyDigests(value.windowSlices) },
              windows: partialWindows,
              windowProofs: partialWindowProofs,
              config,
              previousOwnerProof: incrementalPlan?.previousOwnerProof || null,
              reusedOnlySourceKeys: [...new Set(value.windowSlices.filter(s => s.reused).flatMap(s => s.sourceKeys || []))]
                .filter(key => !value.windowSlices.some(s => !s.reused && s.sourceKeys?.includes(key)))
            })
          : null;
        owner.check();
        const cpRecord = {
          schema: checkpointSchema,
          proofVersion,
          frame: fg.readerFrame,
          scopeKey: fg.scopeKey,
          config,
          windows: partialWindows,
          windowSlices: value.windowSlices,
          ownerProof: partialOwnerProof || null
        };
        const cpRaw = JSON.stringify({ ...cpRecord, payloadDigest: hash(JSON.stringify(cpRecord)) });
        if (new TextEncoder().encode(cpRaw).length > config.maxSerializedBytes) fail('workspace_budget');
        let attempt = incrementalPlan?.checkpointAttempt ?? 0;
        while ((await owner.read(checkpointAttemptKey(loc, fg.readerFrame, previous, attempt))) !== null) {
          owner.check();
          attempt++;
          if (attempt >= maxCheckpointAttempts) fail('checkpoint_budget');
        }
        if (attempt >= maxCheckpointAttempts) fail('checkpoint_budget');
        const cpKey = checkpointAttemptKey(loc, fg.readerFrame, previous, attempt);
        await immutable(owner, cpKey, cpRaw);
        return {
          schema,
          status: 'checkpointed',
          buildMode: incrementalPlan?.mode || (value.reusedWindowCount > 0 ? 'incremental_reuse' : 'full_reprojection'),
          checkpointKey: cpKey,
          completedWindows: value.windowSlices.length,
          reusedWindowCount: value.reusedWindowCount,
          enumeratedWindowCount: value.enumeratedWindowCount,
          remainingUnread: true,
          ownerAtomicity: false,
          inventoryComplete: false,
          byteBounded: false,
          modelDispatchEligible: false
        };
      }

      const { graph } = value;
      if (owner && typeof owner === 'object') knownFrames.set(owner, graph);
      const loc = location(graph), generation = stamp(graph);
      if (!priorLoc || priorLoc.rootKey !== loc.rootKey) {
        previous = await owner.read(loc.rootKey);
        owner.check();
      }
      const compiled = index.compile(graph, { partition: loc.partition, generation, pageBytes: config.pageBytes });
      const refs = [];
      let total = 0, reusedPageCount = 0, writtenPageCount = 0, splitRowCount = 0, splitChunkCount = 0;

      for (const table of tables) {
        const sourceRows = compiled[table];
        if (sourceRows.length === 0) {
          const page = pages.page({ units: [] }, { partition: loc.partition, generation, pool: 'units', offset: 0, pageBytes: config.pageBytes });
          const text = JSON.stringify(page.items), digest = hash(text), key = loc.prefix + 'page:' + table + ':' + digest;
          total += page.serializedUtf8Bytes;
          if (total > config.maxSerializedBytes || refs.length >= 512) fail('index_budget');
          const wasReused = await immutable(owner, key, text);
          if (wasReused) reusedPageCount++; else writtenPageCount++;
          refs.push({ key, table, digest, rows: 0, bytes: page.serializedUtf8Bytes, offset: 0, routing: [] });
          continue;
        }
        let rowIdx = 0;
        let logicalOffset = 0;
        while (rowIdx < sourceRows.length) {
          if (rowFitsPage(sourceRows[rowIdx], config.pageBytes)) {
            let endNormal = rowIdx + 1;
            while (endNormal < sourceRows.length && rowFitsPage(sourceRows[endNormal], config.pageBytes)) {
              endNormal++;
            }
            const normalSlice = sourceRows.slice(rowIdx, endNormal);
            let subOffset = 0;
            while (subOffset < normalSlice.length) {
              const page = pages.page({ units: normalSlice }, { partition: loc.partition, generation, pool: 'units', offset: subOffset, pageBytes: config.pageBytes });
              if (page.nextOffset === subOffset) fail('page_' + page.stopReason);
              const text = JSON.stringify(page.items), digest = hash(text), key = loc.prefix + 'page:' + table + ':' + digest;
              total += page.serializedUtf8Bytes;
              if (total > config.maxSerializedBytes || refs.length >= 512) fail('index_budget');
              const wasReused = await immutable(owner, key, text);
              if (wasReused) reusedPageCount++; else writtenPageCount++;
              refs.push({
                key,
                table,
                digest,
                rows: page.items.length,
                bytes: page.serializedUtf8Bytes,
                offset: logicalOffset,
                routing: routingFor(table, page.items)
              });
              logicalOffset += page.items.length;
              subOffset = page.nextOffset;
            }
            rowIdx = endNormal;
          } else {
            const chunks = splitOversizedRow(table, sourceRows[rowIdx], rowIdx, config.pageBytes);
            splitRowCount++;
            splitChunkCount += chunks.length;
            const splitId = chunks[0].rowDigest;
            let partOffset = 0;
            while (partOffset < chunks.length) {
              const page = pages.page({ units: chunks }, { partition: loc.partition, generation, pool: 'units', offset: partOffset, pageBytes: config.pageBytes });
              if (page.nextOffset === partOffset) fail('page_' + page.stopReason);
              const text = JSON.stringify(page.items), digest = hash(text), key = loc.prefix + 'page:' + table + ':' + digest;
              total += page.serializedUtf8Bytes;
              if (total > config.maxSerializedBytes || refs.length >= 512) fail('index_budget');
              const wasReused = await immutable(owner, key, text);
              if (wasReused) reusedPageCount++; else writtenPageCount++;
              const isFirstPart = partOffset === 0;
              refs.push({
                key,
                table,
                digest,
                rows: isFirstPart ? 1 : 0,
                physicalRows: page.items.length,
                bytes: page.serializedUtf8Bytes,
                offset: logicalOffset,
                routing: routingFor(table, page.items),
                splitRow: {
                  splitId,
                  rowIndex: rowIdx,
                  partStart: partOffset,
                  partCount: page.items.length,
                  totalParts: chunks.length
                }
              });
              if (isFirstPart) logicalOffset += 1;
              partOffset = page.nextOffset;
            }
            rowIdx++;
          }
        }
      }

      const ownerProof = typeof owner.captureSourceProof === 'function'
        ? await owner.captureSourceProof({
            graph,
            collected: value.collected,
            windows: value.windows,
            windowProofs: value.windowProofs,
            config,
            previousOwnerProof: incrementalPlan?.previousOwnerProof || null,
            reusedOnlySourceKeys: value.reusedOnlySourceKeys || []
          })
        : null;
      owner.check();
      const proofRecord = {
        schema: proofSchema,
        proofVersion,
        scopeKey: graph.scopeKey,
        frame: graph.readerFrame,
        generation,
        windowCount: value.windows.length,
        windows: value.windows,
        windowProofs: value.windowProofs.map(wp => ({
          ordinal: wp.ordinal,
          stamp: wp.stamp,
          canonicalNext: wp.canonicalNext,
          microNext: wp.microNext
        })),
        familyContracts: FAMILY_CURRENTNESS_CONTRACTS,
        ownerProof: ownerProof || null
      };
      const proofRaw = JSON.stringify(proofRecord), proofDigest = hash(proofRaw), proofKey = loc.prefix + 'proof:' + proofDigest;
      if (new TextEncoder().encode(proofRaw).length > config.maxSerializedBytes) fail('index_budget');
      await immutable(owner, proofKey, proofRaw);

      const projectionRecord = {
        schema: projectionSchema,
        generation,
        scopeKey: graph.scopeKey,
        frame: graph.readerFrame,
        serializedGraphBytes: value.serializedGraphBytes,
        graph,
        windowSlices: value.windowSlices,
        collected: {
          sourceKeys: Array.isArray(value.collected?.sourceKeys) ? value.collected.sourceKeys : [],
          entityRegistry: Array.isArray(value.collected?.entityRegistry) ? value.collected.entityRegistry : [],
          canonicalRows: Array.isArray(value.collected?.canonicalRows) ? value.collected.canonicalRows : []
        }
      };
      const projectionRaw = JSON.stringify(projectionRecord), projectionDigest = hash(projectionRaw), projectionKey = loc.prefix + 'projection:' + projectionDigest;
      if (new TextEncoder().encode(projectionRaw).length > config.maxSerializedBytes) fail('index_budget');
      await immutable(owner, projectionKey, projectionRaw);

      const sourceProofs = {
        schema: proofSummarySchema,
        proofVersion,
        proofKey,
        proofDigest,
        projectionKey,
        projectionDigest,
        windowCount: value.windows.length,
        ownerProofAvailable: Boolean(ownerProof),
        guaranteedFamiliesWithoutBodyReRead: ['canonical', 'micro', 'state'],
        reReadRequiredEveryRequestFamilies: ['state', 'lore'],
        bodyReReadRequiredFamilies: ['lore']
      };

      const buildMetrics = {
        mode: incrementalPlan?.mode || 'full_build',
        reusedWindowCount: value.reusedWindowCount,
        enumeratedWindowCount: value.enumeratedWindowCount,
        reusedPageCount,
        writtenPageCount,
        splitRowCount,
        splitChunkCount
      };

      const metadata = { ...compiled }; for (const table of tables) delete metadata[table];
      const manifest = { schema, routingVersion, frame: graph.readerFrame, config, windows: value.windows, generation, metadata, refs,
        sourceProofs, buildMetrics, serializedGraphBytes: value.serializedGraphBytes, serializedIndexBytes: total,
        ownerAtomicity: false, inventoryComplete: false, byteBounded: false, modelDispatchEligible: false };
      pages.measure(manifest, 131072);
      const raw = JSON.stringify(manifest), digest = hash(raw), key = loc.prefix + 'manifest:' + digest;
      await immutable(owner, key, raw);

      if (ownerProof && typeof owner.verifySourceProofs === 'function') {
        const preCommitVerdict = await owner.verifySourceProofs(proofRecord, { initialGraph: graph, config, phase: 'build_commit' });
        owner.check();
        if (!preCommitVerdict || preCommitVerdict.status !== 'verified') fail('source_changed');
      } else {
        const final = await enumerate(snapshot, config, owner.check);
        if (!same(value.windows, final.windows) || stamp(final.graph) !== generation) fail('source_changed');
      }
      await owner.publish({ key: loc.rootKey, previous, raw: JSON.stringify({ schema, manifestKey: key, digest }), manifestKey: key, manifestRaw: raw });
      if (ownerProof && typeof owner.verifySourceProofs === 'function') {
        const postCommitVerdict = await owner.verifySourceProofs(proofRecord, { initialGraph: graph, config, phase: 'build_post_commit' });
        owner.check();
        if (!postCommitVerdict || postCommitVerdict.status !== 'verified') fail('source_changed_after_publication');
      } else {
        const after = await enumerate(snapshot, config, owner.check);
        if (!same(value.windows, after.windows)) fail('source_changed_after_publication');
      }
      return { schema, status: 'published', buildMode: buildMetrics.mode, generation, indexDigest: compiled.indexDigest, windowCount: value.windows.length,
        reusedWindowCount: value.reusedWindowCount, enumeratedWindowCount: value.enumeratedWindowCount,
        pageCount: refs.length, serializedGraphBytes: value.serializedGraphBytes, serializedIndexBytes: total,
        storage: { pageCount: refs.length, reusedPageCount, writtenPageCount, splitRowCount, splitChunkCount, serializedIndexBytes: total },
        sourceProofs, buildMetrics, familyContracts: FAMILY_CURRENTNESS_CONTRACTS,
        ownerAtomicity: false, inventoryComplete: false, byteBounded: false, modelDispatchEligible: false };
    } finally { active = false; }
  };

  const validSourceProofSummary = (summary, loc, windowCount) => {
    if (summary === undefined) return true;
    if (!summary || typeof summary !== 'object' || summary.schema !== proofSummarySchema
      || !supportedProofVersions.has(summary.proofVersion) || !/^[a-f0-9]{64}$/.test(String(summary.proofDigest || ''))
      || !/^[a-f0-9]{64}$/.test(String(summary.projectionDigest || ''))
      || summary.proofKey !== loc.prefix + 'proof:' + summary.proofDigest
      || summary.projectionKey !== loc.prefix + 'projection:' + summary.projectionDigest
      || summary.windowCount !== windowCount) return false;
    return true;
  };

  const read = async ({ initialGraph, snapshot, owner, eager = false } = {}) => {
    const startGraph = initialGraph || (owner && typeof owner === 'object' ? knownFrames.get(owner) : null)
      || (await snapshot({ limit: 1, nodeLimit: 64, canonicalCursor: '', microCursor: '' })).graph;
    if (owner && typeof owner === 'object') knownFrames.set(owner, startGraph);
    const loc = location(startGraph), rootRaw = await owner.read(loc.rootKey); owner.check();
    if (rootRaw === null) return null;
    const root = parse(rootRaw, 2048);
    if (root.schema !== schema || !/^[a-f0-9]{64}$/.test(root.digest) || root.manifestKey !== loc.prefix + 'manifest:' + root.digest) fail('root_invalid');
    const raw = await owner.read(root.manifestKey), manifest = parse(raw, 131072);
    if (hash(raw) !== root.digest || manifest.schema !== schema || !same(manifest.frame, startGraph.readerFrame)
      || !Array.isArray(manifest.refs) || manifest.refs.length > 512 || !Array.isArray(manifest.windows)
      || manifest.windows.length < 1 || manifest.windows.length > 128) fail('manifest_invalid');
    if (manifest.routingVersion !== undefined && manifest.routingVersion !== routingVersion) fail('routing_invalid');
    if (!validSourceProofSummary(manifest.sourceProofs, loc, manifest.windows.length)) fail('manifest_invalid');
    const config = policy(manifest.config);
    const counts = Object.fromEntries(tables.map(table => [table, 0]));
    const splitTracker = Object.fromEntries(tables.map(table => [table, null]));
    let total = 0;
    for (const ref of manifest.refs) {
      if (!ref || !tables.includes(ref.table) || !/^[a-f0-9]{64}$/.test(ref.digest)
        || ref.key !== loc.prefix + 'page:' + ref.table + ':' + ref.digest
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 2 || ref.bytes > config.pageBytes
        || !Number.isSafeInteger(ref.rows) || ref.rows < 0 || ref.offset !== counts[ref.table]
        || !validSplitRowMeta(ref)
        || manifest.routingVersion && !validRouting(ref)) fail('directory_invalid');
      const tracker = splitTracker[ref.table];
      if (ref.splitRow) {
        const sr = ref.splitRow;
        if (sr.partStart === 0) {
          if (tracker !== null || sr.rowIndex !== counts[ref.table]) fail('directory_invalid');
          if (sr.partCount < sr.totalParts) {
            splitTracker[ref.table] = { splitId: sr.splitId, rowIndex: sr.rowIndex, expectedNextPart: sr.partCount, totalParts: sr.totalParts };
          }
        } else {
          if (!tracker || tracker.splitId !== sr.splitId || tracker.rowIndex !== sr.rowIndex
            || tracker.expectedNextPart !== sr.partStart || tracker.totalParts !== sr.totalParts) fail('directory_invalid');
          const nextPart = sr.partStart + sr.partCount;
          splitTracker[ref.table] = nextPart < sr.totalParts ? { ...tracker, expectedNextPart: nextPart } : null;
        }
      } else if (tracker !== null) {
        fail('directory_invalid');
      }
      counts[ref.table] += ref.rows;
      total += ref.bytes; if (total > config.maxSerializedBytes) fail('index_budget');
    }
    for (const table of tables) {
      if (splitTracker[table] !== null) fail('directory_invalid');
    }
    for (const [table,stat] of [['directory','directoryCount'],['adjacency','adjacencyCount'],['postings','postingCount'],['reverseDependencies','reverseDependencyCount']]) {
      if (!manifest.refs.some(ref => ref.table === table) || counts[table] !== manifest.metadata?.stats?.[stat]) fail('directory_invalid');
    }

    let proofRecord = null, projectionRecord = null;
    if (manifest.sourceProofs) {
      const proofRaw = await owner.read(manifest.sourceProofs.proofKey); owner.check();
      if (typeof proofRaw !== 'string' || hash(proofRaw) !== manifest.sourceProofs.proofDigest) fail('page_corrupt');
      proofRecord = parse(proofRaw, config.maxSerializedBytes);
      if (proofRecord?.schema !== proofSchema || proofRecord.proofVersion !== manifest.sourceProofs.proofVersion
        || proofRecord.generation !== manifest.generation || !same(proofRecord.windows, manifest.windows)) fail('page_corrupt');

      const projectionRaw = await owner.read(manifest.sourceProofs.projectionKey); owner.check();
      if (typeof projectionRaw !== 'string' || hash(projectionRaw) !== manifest.sourceProofs.projectionDigest) fail('page_corrupt');
      projectionRecord = parse(projectionRaw, config.maxSerializedBytes);
      if (projectionRecord?.schema !== projectionSchema || projectionRecord.generation !== manifest.generation
        || !same(projectionRecord.frame, manifest.frame) || stamp(projectionRecord.graph) !== manifest.generation) fail('page_corrupt');
    }

    const canVerifyIncrementally = !eager && proofRecord?.proofVersion === proofVersion
      && Boolean(proofRecord?.ownerProof)
      && Boolean(projectionRecord?.graph)
      && typeof owner.verifySourceProofs === 'function';

    let native = null, currentnessVerification = null;
    if (canVerifyIncrementally) {
      const verdict = await owner.verifySourceProofs(proofRecord, { initialGraph: startGraph, config, phase: 'open' });
      owner.check();
      if (!verdict || verdict.status !== 'verified') {
        fail('stale_generation', { currentnessVerification: verdict || null });
      }
      currentnessVerification = verdict;
      native = {
        graph: projectionRecord.graph,
        windows: manifest.windows,
        collected: {
          ...projectionRecord.collected,
          ...(verdict.collectedPatch || {})
        },
        serializedGraphBytes: manifest.serializedGraphBytes,
        config
      };
    } else {
      if (proofRecord?.ownerProof && typeof owner.verifySourceProofs === 'function') {
        const verdict = await owner.verifySourceProofs(proofRecord, { initialGraph: startGraph, config, phase: 'audit' });
        owner.check();
        if (!verdict || verdict.status !== 'verified') {
          fail('stale_generation', { currentnessVerification: verdict || null });
        }
        currentnessVerification = { ...verdict, mode: 'eager_full_reprojection_audit', nativeReprojectionPerformed: true };
      } else {
        currentnessVerification = Object.freeze({
          schema: 'libra.graph_corpus_currentness.v1',
          status: 'verified',
          mode: eager ? 'eager_full_reprojection_audit' : 'full_window_enumeration_fallback',
          nativeReprojectionPerformed: true,
          familyContracts: FAMILY_CURRENTNESS_CONTRACTS,
          guaranteedFamiliesWithoutBodyReRead: Object.freeze(['canonical', 'micro', 'state']),
          reReadRequiredEveryRequestFamilies: Object.freeze(['state', 'lore']),
          bodyReReadRequiredFamilies: Object.freeze(['lore']),
          consumedReadSetPhysicalRecheckRequired: true,
          ownerAtomicity: false,
          byteBounded: false
        });
      }
      native = await enumerate(snapshot, config, owner.check);
      if (!same(native.windows, manifest.windows) || stamp(native.graph) !== manifest.generation) fail('stale_generation');
      if (projectionRecord && stamp(projectionRecord.graph) !== stamp(native.graph)) fail('page_corrupt');
    }

    const lazy = !eager && manifest.routingVersion === routingVersion;
    const metrics = { storageAccess: lazy ? 'selective_durable_pages' : 'materialized_tables',
      publishedPages: manifest.refs.length, publishedBytes: total, pagesRead: 0, bytesRead: 0, cacheHits: 0, uniquePagesRead: 0 };
    // No raw/decoded table cache: re-acquire validated content through the shared
    // Cache Manager. Every new request physically verifies its first page use.
    const validated = new Set();
    const assertIndexCurrent = async () => {
      owner.check(); if (await owner.read(loc.rootKey) !== rootRaw) fail('root_changed'); owner.check();
    };
    const readPage = async (ref, consume, budget) => {
      owner.check(); let handle, stage, lease;
      const expectedRows = ref.physicalRows ?? ref.rows;
      try {
        handle = pages.open({ partition: loc.partition, generation: manifest.generation });
        const binding = { pool: 'units', codec: 'json_array.v1', digest: ref.digest, rows: expectedRows };
        if (validated.has(ref.key)) lease = pages.acquire(handle, binding);
        if (lease) metrics.cacheHits++;
        else {
          if (budget && budget.pagesRead >= budget.maxPages) return 'storage_page_count_budget';
          if (budget && budget.bytesRead + ref.bytes > budget.maxBytes) return 'storage_byte_budget';
          // Reserve expected raw/decode workspace before initiating physical I/O.
          stage = pages.reserve(handle, pages.stageCost({ utf8Bytes: ref.bytes, codeUnits: ref.bytes, tokens: 0 }));
          if (budget) { budget.pagesRead++; budget.bytesRead += ref.bytes; }
          metrics.pagesRead++; metrics.bytesRead += ref.bytes;
          const text = await owner.read(ref.key); owner.check();
          if (typeof text !== 'string' || text.length > native.config.pageBytes || hash(text) !== ref.digest) fail('page_corrupt');
          const size = pages.encodedSize(text);
          if (size.utf8Bytes !== ref.bytes) fail('page_corrupt');
          pages.releaseStage(stage); stage = null;
          stage = pages.reserve(handle, pages.stageCost(size));
          lease = pages.install(handle, binding, text, stage);
          validated.add(ref.key); metrics.uniquePagesRead = validated.size;
        }
        const rows = pages.decode(lease);
        if (!Array.isArray(rows) || rows.length !== expectedRows || pages.measure(rows, native.config.pageBytes).utf8Bytes !== ref.bytes
          || manifest.routingVersion && !same(routingFor(ref.table, rows), ref.routing)) fail('page_corrupt');
        if (ref.splitRow) {
          const sr = ref.splitRow;
          for (let idx = 0; idx < rows.length; idx++) {
            const item = rows[idx];
            if (!item || item.__chunkSchema !== rowChunkSchema || item.table !== ref.table
              || item.rowDigest !== sr.splitId || item.rowIndex !== sr.rowIndex
              || item.chunkCount !== sr.totalParts || item.chunkIndex !== sr.partStart + idx
              || typeof item.slice !== 'string') fail('page_corrupt');
          }
        }
        consume(rows); owner.check(); return null;
      } finally { if (lease) pages.release(lease); if (stage) pages.releaseStage(stage); if (handle) pages.close(handle); }
    };
    const readRows = async (spec, budget) => {
      owner.check(); await owner.assertRoute?.(); owner.check();
      const credit = budget || { maxPages: 512, maxBytes: 8388608, pagesRead: 0, bytesRead: 0 };
      if (!Number.isSafeInteger(credit.maxPages) || credit.maxPages < 1 || credit.maxPages > 512
        || !Number.isSafeInteger(credit.maxBytes) || credit.maxBytes < 512 || credit.maxBytes > 8388608
        || !Number.isSafeInteger(credit.pagesRead) || credit.pagesRead < 0 || credit.pagesRead > credit.maxPages
        || !Number.isSafeInteger(credit.bytesRead) || credit.bytesRead < 0 || credit.bytesRead > credit.maxBytes) fail('storage_budget_invalid');
      const rawRows = [];
      for (const ref of manifest.refs) if (ref.table === spec.table && mightContain(ref, spec)) {
        const stopped = await readPage(ref, page => rawRows.push(...page), credit);
        if (stopped) return { storageStopped: true, stopReason: stopped };
      }
      await assertIndexCurrent();
      const reassembled = reassembleTableRows(spec.table, rawRows);
      return { rows: reassembled.rows, splitReassembled: reassembled.splitReassembled };
    };
    let compiledIndex;
    if (lazy) compiledIndex = index.restoreLazy(manifest.metadata, { partition: loc.partition, generation: manifest.generation, readRows });
    else {
      const rawRestored = Object.fromEntries(tables.map(table => [table, []]));
      for (const ref of manifest.refs) await readPage(ref, rows => rawRestored[ref.table].push(...rows));
      const restored = { ...manifest.metadata };
      for (const table of tables) {
        restored[table] = reassembleTableRows(table, rawRestored[table]).rows;
      }
      compiledIndex = index.restore(restored, { partition: loc.partition, generation: manifest.generation });
    }
    await assertIndexCurrent();
    const currentGraph = async () => {
      await assertIndexCurrent();
      if (canVerifyIncrementally) {
        const latestVerdict = await owner.verifySourceProofs(proofRecord, { initialGraph: startGraph, config: native.config, phase: 'commit' });
        owner.check();
        if (!latestVerdict || latestVerdict.status !== 'verified') {
          fail('stale_generation', { currentnessVerification: latestVerdict || null });
        }
        await assertIndexCurrent();
        return native.graph;
      }
      const live = await enumerate(snapshot, native.config, owner.check);
      if (!same(live.windows, manifest.windows) || stamp(live.graph) !== manifest.generation) fail('stale_generation');
      await assertIndexCurrent(); return live.graph;
    };
    return {
      ...native,
      sourceProofs: canVerifyIncrementally ? proofRecord : null,
      currentnessVerification,
      compiledIndex,
      currentGraph,
      assertIndexCurrent,
      access: {
        schema,
        mode: 'durable_common_index',
        generation: manifest.generation,
        indexDigest: compiledIndex.indexDigest,
        windowCount: native.windows.length,
        pageCount: manifest.refs.length,
        serializedGraphBytes: native.serializedGraphBytes,
        serializedIndexBytes: total,
        storage: metrics,
        buildMetrics: manifest.buildMetrics || null,
        currentnessVerification,
        familyContracts: FAMILY_CURRENTNESS_CONTRACTS,
        nativeReprojectionRequired: !canVerifyIncrementally,
        ownerAtomicity: false,
        inventoryComplete: false,
        byteBounded: false
      }
    };
  };
  return Object.freeze({
    FAMILY_CURRENTNESS_CONTRACTS,
    build,
    read,
    prepare,
    enumerate,
    location,
    inspect: () => ({ activeBuild: active })
  });
};
