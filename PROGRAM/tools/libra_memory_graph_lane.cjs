'use strict';
// UM2 Next-Gen Memory Lane Scheduler (M04, M05):
// Coordinates incremental/on-demand page access across the 5 unified Lane roles
// (query_anchor_access, semantic_access, graph_neighborhood, temporal_state_access, context_expansion)
// under a shared request byte/page budget, supporting active frontier step/drainPending,
// request coalescing, structural priority, and generation-verified cursor resumption.
module.exports = function createMemoryGraphLane({ index, pages } = {}) {
  if (!index || typeof index.queryPage !== 'function' || !pages || typeof pages.measure !== 'function') {
    throw new TypeError('LIBRA_GRAPH_LANE_ADAPTER_REQUIRED');
  }
  const schema = 'libra.memory_graph_lane.v1';
  const rolePriority = {
    query_anchor_access: 1,
    temporal_state_access: 2,
    graph_neighborhood: 3,
    semantic_access: 4,
    context_expansion: 5
  };
  const validRoles = new Set(Object.keys(rolePriority));
  const fail = reason => { const err = new Error('LIBRA_GRAPH_LANE_' + reason.toUpperCase()); err.reason = reason; throw err; };

  const createSession = (compiledIndex, {
    maxPages = 16,
    maxBytes = 65536,
    pageBytes = 8192,
    resumeCursors = [],
    requestBinding = '',
    maxStoragePages = maxPages,
    maxStorageBytes = maxBytes
  } = {}) => {
    if (!compiledIndex || compiledIndex.schema !== 'libra.memory_graph_index.v1') fail('index_required');
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 256
      || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 1048576
      || !Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > 65536) {
      fail('budget_options_invalid');
    }

    if (!Number.isSafeInteger(maxStoragePages) || maxStoragePages < 1 || maxStoragePages > 512
      || !Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < 512 || maxStorageBytes > 8388608) fail('storage_budget_invalid');
    const storageBudget = { maxPages: maxStoragePages, maxBytes: maxStorageBytes, pagesRead: 0, bytesRead: 0 };
    let busy = false;
    const queue = [];
    const seenAccessKeys = new Map();
    const completedAccesses = [];
    const unreadCursors = [];
    const roleStats = Object.fromEntries(Object.keys(rolePriority).map(role => [role, { pages: 0, bytes: 0, requests: 0 }]));
    let sequence = 0;
    let pagesRead = 0;
    let bytesRead = 0;
    let cacheHits = 0;
    let coalescedRequests = 0;
    let lastStopReason = 'frontier_exhausted';
    let finalizedReport = null;

    const accessKeyOf = req => JSON.stringify([
      requestBinding,
      req.table,
      req.anchorNodeId || '',
      req.direction || '',
      req.predicate || '',
      Boolean(req.structuralOnly),
      req.channel || '',
      req.term || '',
      req.dependencyKey || '',
      req.offset || 0,
      req.pageBytes || pageBytes
    ]);

    const enqueue = ({
      laneRole,
      table = 'postings',
      anchorNodeId = '',
      direction = '',
      predicate = '',
      structuralOnly = false,
      channel = '',
      term = '',
      dependencyKey = '',
      offset = 0,
      priorityHint = 0,
      requesterId = '',
      storageCursor = null
    } = {}) => {
      if (!validRoles.has(laneRole)) fail('lane_role_invalid');
      if (!['directory', 'adjacency', 'postings', 'reverseDependencies'].includes(table)) fail('table_invalid');
      if (!Number.isSafeInteger(offset) || offset < 0) fail('offset_invalid');
      if (typeof priorityHint !== 'number' || !Number.isFinite(priorityHint)) fail('priority_invalid');

      const spec = {
        laneRole,
        table,
        anchorNodeId: String(anchorNodeId || ''),
        direction: String(direction || ''),
        predicate: String(predicate || ''),
        structuralOnly: Boolean(structuralOnly),
        channel: String(channel || ''),
        term: String(term || ''),
        dependencyKey: String(dependencyKey || ''),
        offset,
        pageBytes,
        requestBinding,
        storageCursor: storageCursor || null
      };
      const key = accessKeyOf(spec);
      if (seenAccessKeys.has(key)) {
        const existing = seenAccessKeys.get(key);
        if (requesterId && !existing.requesters.includes(requesterId)) existing.requesters.push(requesterId);
        if (!existing.lanes.includes(laneRole)) existing.lanes.push(laneRole);
        const rank = rolePriority[laneRole] - (structuralOnly ? 0.5 : 0);
        if (rank < existing.effectiveRank) existing.effectiveRank = rank;
        if (priorityHint > existing.priorityHint) existing.priorityHint = priorityHint;
        coalescedRequests++;
        return { coalesced: true, accessKey: key };
      }

      roleStats[laneRole].requests++;
      const item = {
        accessKey: key,
        spec,
        lanes: [laneRole],
        requesters: requesterId ? [requesterId] : [],
        effectiveRank: rolePriority[laneRole] - (structuralOnly ? 0.5 : 0),
        priorityHint,
        seq: sequence++,
        completed: false
      };
      seenAccessKeys.set(key, item);
      queue.push(item);
      return { coalesced: false, accessKey: key };
    };

    if (Array.isArray(resumeCursors) && resumeCursors.length > 0) {
      for (const cur of resumeCursors) {
        if (!cur || typeof cur !== 'object') fail('cursor_invalid');
        if ((cur.generation && cur.generation !== compiledIndex.generation)
          || (cur.indexDigest && cur.indexDigest !== compiledIndex.indexDigest)) {
          fail('cursor_stale');
        }
        if ((cur.requestBinding || '') !== requestBinding
          || (cur.pageBytes !== undefined && cur.pageBytes !== pageBytes)) fail('cursor_invalid');
        const role = Array.isArray(cur.lanes) && validRoles.has(cur.lanes[0]) ? cur.lanes[0] : 'graph_neighborhood';
        enqueue({
          laneRole: role,
          table: cur.table || 'adjacency',
          anchorNodeId: cur.anchorNodeId || '',
          direction: cur.direction || '',
          predicate: cur.predicate || '',
          structuralOnly: Boolean(cur.structuralOnly),
          channel: cur.channel || '',
          term: cur.term || '',
          dependencyKey: cur.dependencyKey || '',
          offset: Number.isSafeInteger(cur.offset) ? cur.offset : 0,
          priorityHint: 0.95,
          requesterId: 'resumed_cursor',
          storageCursor: cur.storageCursor || null
        });
      }
    }

    const sortQueue = () => {
      queue.sort((a, b) => (
        a.effectiveRank - b.effectiveRank
        || b.priorityHint - a.priorityHint
        || a.seq - b.seq
      ));
    };

    const stepSteps = function* ({ checkCancel } = {}) {
      if (queue.length === 0) {
        return { executed: false, stopReason: 'frontier_exhausted', access: null };
      }
      if (typeof checkCancel === 'function' && checkCancel() === true) {
        lastStopReason = 'cancelled';
        return { executed: false, stopReason: 'cancelled', access: null };
      }
      if (pagesRead >= maxPages) {
        lastStopReason = 'page_count_budget';
        return { executed: false, stopReason: 'page_count_budget', access: null };
      }
      sortQueue();
      const next = queue[0];
      const page = yield next.spec;
      if (typeof checkCancel === 'function' && checkCancel() === true) {
        lastStopReason = 'cancelled'; return { executed: false, stopReason: 'cancelled', access: null };
      }
      if (page.storageStopped) {
        lastStopReason = page.stopReason;
        if (page.storageCursor) {
          next.spec.storageCursor = page.storageCursor;
        }
        return { executed: false, stopReason: lastStopReason, access: null };
      }
      if (page.stopReason === 'row_exceeds_page') {
        queue.shift();
        unreadCursors.push({
          accessKey: next.accessKey,
          generation: compiledIndex.generation,
          indexDigest: compiledIndex.indexDigest,
          lanes: [...next.lanes],
          table: next.spec.table,
          anchorNodeId: next.spec.anchorNodeId,
          direction: next.spec.direction,
          predicate: next.spec.predicate,
          structuralOnly: next.spec.structuralOnly,
          channel: next.spec.channel,
          term: next.spec.term,
          offset: next.spec.offset,
          dependencyKey: next.spec.dependencyKey, pageBytes, requestBinding,
          stopReason: 'row_exceeds_page',
          storageCursor: next.spec.storageCursor || null
        });
        lastStopReason = 'row_exceeds_page';
        return { executed: false, stopReason: 'row_exceeds_page', access: null };
      }
      if (bytesRead + page.serializedUtf8Bytes > maxBytes) {
        lastStopReason = 'byte_budget';
        return { executed: false, stopReason: 'byte_budget', access: null };
      }
      queue.shift();
      next.completed = true;
      next.spec.storageCursor = null;
      pagesRead++;
      bytesRead += page.serializedUtf8Bytes;
      if (page.cacheHit) cacheHits++;
      const primaryRole = next.lanes[0];
      if (roleStats[primaryRole]) {
        roleStats[primaryRole].pages++;
        roleStats[primaryRole].bytes += page.serializedUtf8Bytes;
      }
      const access = {
        accessKey: next.accessKey,
        lanes: [...next.lanes],
        requesters: [...next.requesters],
        table: page.table,
        anchorNodeId: next.spec.anchorNodeId,
        channel: next.spec.channel,
        term: next.spec.term,
        offset: page.offset,
        nextOffset: page.nextOffset,
        totalRows: page.totalRows,
        serializedUtf8Bytes: page.serializedUtf8Bytes,
        cacheHit: Boolean(page.cacheHit),
        stopReason: page.stopReason,
        items: page.items
      };
      completedAccesses.push(access);
      if (page.nextOffset < page.totalRows) {
        enqueue({
          ...next.spec,
          laneRole: next.lanes[0],
          offset: page.nextOffset,
          priorityHint: next.priorityHint,
          requesterId: next.requesters[0] || '',
          storageCursor: null
        });
      }
      return { executed: true, stopReason: 'frontier_exhausted', access };
    };

    const drainSteps = function* ({ checkCancel } = {}) {
      const newAccesses = [];
      let stoppedByBudget = false;
      while (queue.length > 0) {
        const res = yield* stepSteps({ checkCancel });
        if (!res.executed) {
          if (res.stopReason === 'row_exceeds_page') continue;
          stoppedByBudget = res.stopReason !== 'frontier_exhausted';
          break;
        }
        newAccesses.push(res.access);
      }
      return {
        stoppedByBudget,
        stopReason: lastStopReason,
        newAccesses,
        pendingQueueLength: queue.length
      };
    };

    // Both drivers execute the same scheduler. Only physical page access awaits.
    const run = generator => {
      if (busy) fail('session_busy');
      let next = generator.next();
      while (!next.done) next = generator.next(index.queryPage(compiledIndex, next.value));
      return next.value;
    };
    const runAsync = async generator => {
      if (busy) fail('session_busy'); busy = true;
      try {
        let next = generator.next();
        while (!next.done) next = generator.next(await index.queryPageAsync(compiledIndex, next.value, storageBudget));
        return next.value;
      } finally { busy = false; }
    };
    const step = options => run(stepSteps(options));
    const stepAsync = options => runAsync(stepSteps(options));
    const drainPending = options => run(drainSteps(options));
    const drainPendingAsync = options => runAsync(drainSteps(options));

    const isBudgetStopped = () => (
      lastStopReason === 'page_count_budget'
      || lastStopReason === 'byte_budget'
      || lastStopReason === 'cancelled'
      || lastStopReason.startsWith('storage_')
      || lastStopReason === 'row_exceeds_page'
    );

    const finalize = () => {
      if (busy) fail('session_busy');
      if (finalizedReport) return finalizedReport;
      while (queue.length > 0) {
        const pending = queue.shift();
        unreadCursors.push({
          accessKey: pending.accessKey,
          generation: compiledIndex.generation,
          indexDigest: compiledIndex.indexDigest,
          lanes: [...pending.lanes],
          table: pending.spec.table,
          anchorNodeId: pending.spec.anchorNodeId,
          direction: pending.spec.direction,
          predicate: pending.spec.predicate,
          structuralOnly: pending.spec.structuralOnly,
          channel: pending.spec.channel,
          term: pending.spec.term,
          offset: pending.spec.offset,
          dependencyKey: pending.spec.dependencyKey, pageBytes, requestBinding,
          stopReason: lastStopReason,
          storageCursor: pending.spec.storageCursor || null
        });
      }
      const complete = unreadCursors.length === 0 && lastStopReason === 'frontier_exhausted';
      finalizedReport = Object.freeze({
        schema,
        generation: compiledIndex.generation,
        indexDigest: compiledIndex.indexDigest,
        complete,
        stopReason: lastStopReason,
        pagesRead,
        bytesRead,
        storage: Object.freeze({ ...storageBudget }),
        cacheHits,
        coalescedRequests,
        roleStats: JSON.parse(JSON.stringify(roleStats)),
        accesses: completedAccesses,
        unreadCursors,
        corpusExclusionAuthority: false,
        familyTopKQuota: false,
        modelDispatchEligible: false
      });
      return finalizedReport;
    };

    const drain = ({ checkCancel } = {}) => {
      drainPending({ checkCancel });
      return finalize();
    };

    return Object.freeze({
      enqueue,
      step,
      drainPending,
      stepAsync,
      drainPendingAsync,
      isBudgetStopped,
      finalize,
      drain
    });
  };

  return Object.freeze({ createSession });
};
