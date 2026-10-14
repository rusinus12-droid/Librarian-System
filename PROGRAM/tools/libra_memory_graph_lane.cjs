'use strict';
// UM2 Next-Gen Memory Lane Scheduler: coordinates page access order across the 5 unified Lane roles
// (query_anchor_access, semantic_access, graph_neighborhood, temporal_state_access, context_expansion)
// under a shared request byte/page budget without per-family top-K quotas or silent corpus exclusion.
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
    pageBytes = 8192
  } = {}) => {
    if (!compiledIndex || compiledIndex.schema !== 'libra.memory_graph_index.v1') fail('index_required');
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 256
      || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 1048576
      || !Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > 65536) {
      fail('budget_options_invalid');
    }

    const queue = [];
    const seenAccessKeys = new Map();
    const completedAccesses = [];
    const unreadCursors = [];
    let sequence = 0;
    let pagesRead = 0;
    let bytesRead = 0;
    let coalescedRequests = 0;

    const accessKeyOf = req => JSON.stringify([
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
      requesterId = ''
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
        pageBytes
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

    const sortQueue = () => {
      queue.sort((a, b) => (
        a.effectiveRank - b.effectiveRank
        || b.priorityHint - a.priorityHint
        || a.seq - b.seq
      ));
    };

    const drain = ({ checkCancel } = {}) => {
      let stopReason = 'frontier_exhausted';
      while (queue.length > 0) {
        if (typeof checkCancel === 'function' && checkCancel() === true) {
          stopReason = 'cancelled';
          break;
        }
        if (pagesRead >= maxPages) {
          stopReason = 'page_count_budget';
          break;
        }
        sortQueue();
        const next = queue[0];
        const page = index.queryPage(compiledIndex, next.spec);
        if (page.stopReason === 'row_exceeds_page') {
          queue.shift();
          unreadCursors.push({
            accessKey: next.accessKey,
            lanes: [...next.lanes],
            table: next.spec.table,
            offset: next.spec.offset,
            stopReason: 'row_exceeds_page'
          });
          stopReason = 'row_exceeds_page';
          continue;
        }
        if (bytesRead + page.serializedUtf8Bytes > maxBytes) {
          stopReason = 'byte_budget';
          break;
        }
        queue.shift();
        next.completed = true;
        pagesRead++;
        bytesRead += page.serializedUtf8Bytes;
        completedAccesses.push({
          accessKey: next.accessKey,
          lanes: [...next.lanes],
          requesters: [...next.requesters],
          table: page.table,
          offset: page.offset,
          nextOffset: page.nextOffset,
          totalRows: page.totalRows,
          serializedUtf8Bytes: page.serializedUtf8Bytes,
          stopReason: page.stopReason,
          items: page.items
        });
        if (page.nextOffset < page.totalRows) {
          enqueue({
            ...next.spec,
            laneRole: next.lanes[0],
            offset: page.nextOffset,
            priorityHint: next.priorityHint,
            requesterId: next.requesters[0] || ''
          });
        }
      }

      while (queue.length > 0) {
        const pending = queue.shift();
        unreadCursors.push({
          accessKey: pending.accessKey,
          lanes: [...pending.lanes],
          table: pending.spec.table,
          anchorNodeId: pending.spec.anchorNodeId,
          channel: pending.spec.channel,
          term: pending.spec.term,
          offset: pending.spec.offset,
          stopReason
        });
      }

      const complete = unreadCursors.length === 0 && stopReason === 'frontier_exhausted';
      return {
        schema,
        generation: compiledIndex.generation,
        indexDigest: compiledIndex.indexDigest,
        complete,
        stopReason,
        pagesRead,
        bytesRead,
        coalescedRequests,
        accesses: completedAccesses,
        unreadCursors,
        corpusExclusionAuthority: false,
        familyTopKQuota: false,
        modelDispatchEligible: false
      };
    };

    return Object.freeze({ enqueue, drain });
  };

  return Object.freeze({ createSession });
};
