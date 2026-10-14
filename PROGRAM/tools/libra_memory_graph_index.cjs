'use strict';
// UM2 Common Access Index: Node/Source directory, Paged Typed Adjacency (by direction/predicate),
// 4-Channel Postings (lexical/entity/predicate/time), and Reverse Dependency mapping over a verified Memory Graph projection.
// Pure and byte-measured via the shared createMemoryGraphPages adapter; issues no physical proof.
module.exports = function createMemoryGraphIndex({ pages, fingerprint, tokenize } = {}) {
  if (!pages || typeof pages.measure !== 'function' || typeof fingerprint !== 'function') {
    throw new TypeError('LIBRA_GRAPH_INDEX_ADAPTER_REQUIRED');
  }
  const schema = 'libra.memory_graph_index.v1';
  const structuralPredicates = new Set([
    'mentions', 'subject_of', 'target_of', 'evidenced_by', 'derived_from',
    'updates', 'clears', 'supersedes', 'follows', 'fulfills', 'reopens',
    'defines', 'applies_to', 'contradicts'
  ]);
  const defaultTokenize = text => String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9\uac00-\ud7a3\u3040-\u30ff\u4e00-\u9fff_]+/)
    .filter(token => token.length >= 2);
  const tokenizer = typeof tokenize === 'function' ? tokenize : defaultTokenize;
  const fail = reason => { const err = new Error('LIBRA_GRAPH_INDEX_' + reason.toUpperCase()); err.reason = reason; throw err; };
  const hash = text => { const val = fingerprint(text); if (!/^[a-f0-9]{64}$/.test(val)) fail('fingerprint_invalid'); return val; };

  const compile = (graph, { partition, generation } = {}) => {
    if (!graph || graph.schema !== 'libra.memory_graph_projection.v1' || typeof partition !== 'string' || !partition
      || typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation)) {
      fail('input_invalid');
    }
    const unitByNodeId = new Map();
    for (const unit of graph.units || []) unitByNodeId.set(unit.nodeId, unit);

    // 1. Node/Source Directory
    const directory = (graph.nodes || []).map(node => {
      const unit = unitByNodeId.get(node.id) || null;
      return {
        nodeId: node.id,
        layer: node.layer,
        kind: node.kind || node.layer,
        sourceId: node.sourceId || (node.layer === 'source' ? node.id : null),
        bindingId: node.bindingId,
        identityCoverage: node.identityCoverage,
        family: unit?.family || null,
        semanticRole: unit?.semanticRole || null
      };
    }).sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en'));

    // 2. Typed Adjacency with structural priority and degree tracking
    const adjacency = [];
    const outDegree = new Map(), inDegree = new Map();
    for (const edge of graph.edges || []) {
      const structural = structuralPredicates.has(edge.predicate);
      outDegree.set(edge.from, (outDegree.get(edge.from) || 0) + 1);
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
      adjacency.push({
        anchorNodeId: edge.from,
        direction: 'out',
        predicate: edge.predicate,
        structural,
        neighborNodeId: edge.to,
        edgeId: edge.id,
        basisId: edge.basisId,
        bindingId: edge.bindingId,
        identityCoverage: edge.identityCoverage
      });
      adjacency.push({
        anchorNodeId: edge.to,
        direction: 'in',
        predicate: edge.predicate,
        structural,
        neighborNodeId: edge.from,
        edgeId: edge.id,
        basisId: edge.basisId,
        bindingId: edge.bindingId,
        identityCoverage: edge.identityCoverage
      });
    }
    adjacency.sort((a, b) => (
      a.anchorNodeId.localeCompare(b.anchorNodeId, 'en')
      || a.direction.localeCompare(b.direction, 'en')
      || (a.structural === b.structural ? 0 : a.structural ? -1 : 1)
      || a.predicate.localeCompare(b.predicate, 'en')
      || a.neighborNodeId.localeCompare(b.neighborNodeId, 'en')
      || a.edgeId.localeCompare(b.edgeId, 'en')
    ));

    // 3. Lexical / Entity / Predicate / Time Postings
    const lexicalMap = new Map();
    const entityPostings = new Map();
    const predicatePostings = new Map();
    const timePostings = new Map();

    // 4. Reverse Dependency Table: dependencyKey -> { nodeIds: Set, edgeIds: Set, postingKeys: Set }
    const revMap = new Map();
    const recordDep = (depKey, { nodeId, edgeId, postingKey } = {}) => {
      if (!depKey) return;
      if (!revMap.has(depKey)) {
        revMap.set(depKey, { nodeIds: new Set(), edgeIds: new Set(), postingKeys: new Set() });
      }
      const entry = revMap.get(depKey);
      if (nodeId) entry.nodeIds.add(nodeId);
      if (edgeId) entry.edgeIds.add(edgeId);
      if (postingKey) entry.postingKeys.add(postingKey);
    };

    const addPosting = (table, channel, key, nodeId, meta = {}) => {
      if (!key) return;
      if (!table.has(key)) table.set(key, new Map());
      const bucket = table.get(key);
      const prev = bucket.get(nodeId);
      if (prev) prev.tf += 1;
      else bucket.set(nodeId, { nodeId, tf: 1, ...meta });
      recordDep(`node:${nodeId}`, { nodeId, postingKey: `${channel}:${key}` });
    };

    for (const node of graph.nodes || []) {
      recordDep(`node:${node.id}`, { nodeId: node.id });
      if (node.sourceId) recordDep(`source:${node.sourceId}`, { nodeId: node.id });
      if (node.layer === 'source') recordDep(`source:${node.id}`, { nodeId: node.id });
      if (node.layer === 'entity') recordDep(`entity:${node.id}`, { nodeId: node.id });
    }

    for (const unit of graph.units || []) {
      recordDep(`family:${unit.family}`, { nodeId: unit.nodeId });
      const tokens = tokenizer(unit.text || '');
      for (const token of tokens) {
        addPosting(lexicalMap, 'lexical', token, unit.nodeId, { family: unit.family, semanticRole: unit.semanticRole || null });
      }
      if (unit.subjectId) {
        addPosting(entityPostings, 'entity', unit.subjectId, unit.nodeId, { role: 'subject', family: unit.family });
        recordDep(`entity_ref:${unit.subjectId}`, { nodeId: unit.nodeId, postingKey: `entity:${unit.subjectId}` });
      }
      for (const targetId of unit.targetIds || []) {
        addPosting(entityPostings, 'entity', targetId, unit.nodeId, { role: 'target', family: unit.family });
        recordDep(`entity_ref:${targetId}`, { nodeId: unit.nodeId, postingKey: `entity:${targetId}` });
      }
      if (unit.entityId) {
        addPosting(entityPostings, 'entity', unit.entityId, unit.nodeId, { role: 'state_entity', family: unit.family });
        recordDep(`entity_ref:${unit.entityId}`, { nodeId: unit.nodeId, postingKey: `entity:${unit.entityId}` });
      }
      if (unit.field) {
        addPosting(predicatePostings, 'predicate', unit.field, unit.nodeId, { family: unit.family });
        recordDep(`field:${unit.domain || unit.family}:${unit.field}`, { nodeId: unit.nodeId, postingKey: `predicate:${unit.field}` });
      }
      if (unit.fact?.claimKind) {
        addPosting(predicatePostings, 'predicate', unit.fact.claimKind, unit.nodeId, { family: unit.family });
      }
      const timeKey = unit.fact?.time?.label || unit.fact?.values?.time || (Number.isSafeInteger(unit.headThroughTurn) ? `turn:${unit.headThroughTurn}` : '');
      if (timeKey) addPosting(timePostings, 'time', String(timeKey), unit.nodeId, { family: unit.family });
    }

    const basisById = new Map();
    for (const b of graph.bases || []) basisById.set(b.id, b);

    for (const edge of graph.edges || []) {
      addPosting(predicatePostings, 'predicate', edge.predicate, edge.from, { via: 'edge_out', edgeId: edge.id });
      if (['mentions', 'subject_of', 'target_of'].includes(edge.predicate)) {
        addPosting(entityPostings, 'entity', edge.to, edge.from, { role: edge.predicate, edgeId: edge.id });
        recordDep(`entity:${edge.to}`, { nodeId: edge.from, edgeId: edge.id, postingKey: `entity:${edge.to}` });
      }
      recordDep(`node:${edge.from}`, { nodeId: edge.from, edgeId: edge.id });
      recordDep(`node:${edge.to}`, { nodeId: edge.to, edgeId: edge.id });
      recordDep(`basis:${edge.basisId}`, { nodeId: edge.from, edgeId: edge.id });
      const basis = basisById.get(edge.basisId);
      if (basis?.sourceId) {
        recordDep(`source:${basis.sourceId}`, { nodeId: edge.from, edgeId: edge.id });
      }
    }

    const flattenPostings = (table, channel) => {
      const rows = [];
      for (const [term, bucket] of [...table.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
        const hits = [...bucket.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en'));
        const df = hits.length;
        for (const hit of hits) {
          rows.push({ channel, term, df, ...hit });
        }
      }
      return rows;
    };

    const postings = [
      ...flattenPostings(lexicalMap, 'lexical'),
      ...flattenPostings(entityPostings, 'entity'),
      ...flattenPostings(predicatePostings, 'predicate'),
      ...flattenPostings(timePostings, 'time')
    ];

    const reverseDependencies = [...revMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'en'))
      .map(([dependencyKey, sets]) => ({
        dependencyKey,
        nodeIds: [...sets.nodeIds].sort((a, b) => a.localeCompare(b, 'en')),
        edgeIds: [...sets.edgeIds].sort((a, b) => a.localeCompare(b, 'en')),
        postingKeys: [...sets.postingKeys].sort((a, b) => a.localeCompare(b, 'en'))
      }));

    let maxOutDegree = 0, maxInDegree = 0;
    for (const c of outDegree.values()) if (c > maxOutDegree) maxOutDegree = c;
    for (const c of inDegree.values()) if (c > maxInDegree) maxInDegree = c;

    const stats = {
      directoryCount: directory.length,
      adjacencyCount: adjacency.length,
      postingCount: postings.length,
      reverseDependencyCount: reverseDependencies.length,
      lexicalTermCount: lexicalMap.size,
      entityKeyCount: entityPostings.size,
      predicateKeyCount: predicatePostings.size,
      timeKeyCount: timePostings.size,
      maxOutDegree,
      maxInDegree
    };
    const indexDigest = hash(JSON.stringify([schema, partition, generation, stats]));
    return Object.freeze({
      schema,
      partition,
      generation,
      indexDigest,
      directory,
      adjacency,
      postings,
      reverseDependencies,
      stats,
      authority: 'descriptive_only',
      modelDispatchEligible: false
    });
  };

  const affectedByChanges = (compiled, changedDependencyKeys = []) => {
    if (!compiled || compiled.schema !== schema || !Array.isArray(changedDependencyKeys)) fail('input_invalid');
    const lookup = new Map(compiled.reverseDependencies.map(row => [row.dependencyKey, row]));
    const nodeIds = new Set(), edgeIds = new Set(), postingKeys = new Set(), unmatchedKeys = [];
    for (const key of changedDependencyKeys) {
      const hit = lookup.get(String(key));
      if (!hit) { unmatchedKeys.push(String(key)); continue; }
      for (const n of hit.nodeIds) nodeIds.add(n);
      for (const e of hit.edgeIds) edgeIds.add(e);
      for (const p of hit.postingKeys) postingKeys.add(p);
    }
    return {
      schema: 'libra.memory_graph_delta_impact.v1',
      generation: compiled.generation,
      indexDigest: compiled.indexDigest,
      affectedNodeIds: [...nodeIds].sort((a, b) => a.localeCompare(b, 'en')),
      affectedEdgeIds: [...edgeIds].sort((a, b) => a.localeCompare(b, 'en')),
      affectedPostingKeys: [...postingKeys].sort((a, b) => a.localeCompare(b, 'en')),
      unmatchedKeys,
      requiresGlobalDfRefresh: [...postingKeys].some(k => k.startsWith('lexical:')),
      requiresDegreeRefresh: edgeIds.size > 0
    };
  };

  const queryPage = (compiled, {
    table = 'adjacency',
    anchorNodeId = '',
    direction = '',
    predicate = '',
    structuralOnly = false,
    channel = '',
    term = '',
    dependencyKey = '',
    offset = 0,
    pageBytes = 16384
  } = {}) => {
    if (!compiled || compiled.schema !== schema) fail('compiled_index_required');
    if (!['directory', 'adjacency', 'postings', 'reverseDependencies'].includes(table)) fail('table_invalid');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > 65536) {
      fail('options_invalid');
    }
    let sourceRows = compiled[table];
    if (table === 'adjacency') {
      sourceRows = sourceRows.filter(row => (
        (!anchorNodeId || row.anchorNodeId === anchorNodeId)
        && (!direction || row.direction === direction)
        && (!predicate || row.predicate === predicate)
        && (!structuralOnly || row.structural === true)
      ));
    } else if (table === 'postings') {
      sourceRows = sourceRows.filter(row => (
        (!channel || row.channel === channel)
        && (!term || row.term === term)
      ));
    } else if (table === 'directory' && anchorNodeId) {
      sourceRows = sourceRows.filter(row => row.nodeId === anchorNodeId || row.sourceId === anchorNodeId);
    } else if (table === 'reverseDependencies' && dependencyKey) {
      sourceRows = sourceRows.filter(row => row.dependencyKey === dependencyKey);
    }
    if (offset > sourceRows.length) fail('offset_invalid');

    const selected = [];
    let bytes = 2;
    let stopReason = 'index_page_end';
    for (let i = offset; i < sourceRows.length; i++) {
      let size;
      try {
        size = pages.measure(sourceRows[i], pageBytes - 2);
      } catch (err) {
        if (err.reason === 'row_exceeds_page' && !selected.length) {
          return {
            schema: 'libra.memory_graph_index_page.v1',
            table,
            generation: compiled.generation,
            indexDigest: compiled.indexDigest,
            offset,
            nextOffset: offset,
            totalRows: sourceRows.length,
            items: [],
            serializedUtf8Bytes: 2,
            pageBytes,
            stopReason: 'row_exceeds_page',
            modelDispatchEligible: false
          };
        }
        stopReason = 'page_boundary';
        break;
      }
      const sep = selected.length ? 1 : 0;
      if (bytes + sep + size.utf8Bytes > pageBytes) {
        stopReason = 'page_boundary';
        break;
      }
      selected.push(sourceRows[i]);
      bytes += sep + size.utf8Bytes;
    }
    const nextOffset = offset + selected.length;
    if (nextOffset < sourceRows.length && stopReason === 'index_page_end') stopReason = 'page_boundary';
    return {
      schema: 'libra.memory_graph_index_page.v1',
      table,
      generation: compiled.generation,
      indexDigest: compiled.indexDigest,
      offset,
      nextOffset,
      totalRows: sourceRows.length,
      items: JSON.parse(JSON.stringify(selected)),
      serializedUtf8Bytes: bytes,
      pageBytes,
      stopReason,
      modelDispatchEligible: false
    };
  };

  return Object.freeze({ compile, affectedByChanges, queryPage });
};
