'use strict';
// UM2 Common Access Index: Node/Source directory, Paged Typed Adjacency (by direction/predicate),
// and Lexical/Entity/Predicate/Time postings over a verified Memory Graph projection.
// Pure and byte-measured via the shared createMemoryGraphPages adapter; issues no physical proof.
module.exports = function createMemoryGraphIndex({ pages, fingerprint, tokenize } = {}) {
  if (!pages || typeof pages.measure !== 'function' || typeof fingerprint !== 'function') {
    throw new TypeError('LIBRA_GRAPH_INDEX_ADAPTER_REQUIRED');
  }
  const schema = 'libra.memory_graph_index.v1';
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

    const adjacency = [];
    for (const edge of graph.edges || []) {
      adjacency.push({
        anchorNodeId: edge.from,
        direction: 'out',
        predicate: edge.predicate,
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
      || a.predicate.localeCompare(b.predicate, 'en')
      || a.neighborNodeId.localeCompare(b.neighborNodeId, 'en')
      || a.edgeId.localeCompare(b.edgeId, 'en')
    ));

    const lexicalMap = new Map();
    const entityPostings = new Map();
    const predicatePostings = new Map();
    const timePostings = new Map();

    const addPosting = (table, key, nodeId, meta = {}) => {
      if (!key) return;
      if (!table.has(key)) table.set(key, new Map());
      const bucket = table.get(key);
      const prev = bucket.get(nodeId);
      if (prev) prev.tf += 1;
      else bucket.set(nodeId, { nodeId, tf: 1, ...meta });
    };

    for (const unit of graph.units || []) {
      const tokens = tokenizer(unit.text || '');
      for (const token of tokens) {
        addPosting(lexicalMap, token, unit.nodeId, { family: unit.family, semanticRole: unit.semanticRole || null });
      }
      if (unit.subjectId) addPosting(entityPostings, unit.subjectId, unit.nodeId, { role: 'subject', family: unit.family });
      for (const targetId of unit.targetIds || []) {
        addPosting(entityPostings, targetId, unit.nodeId, { role: 'target', family: unit.family });
      }
      if (unit.entityId) addPosting(entityPostings, unit.entityId, unit.nodeId, { role: 'state_entity', family: unit.family });
      if (unit.field) addPosting(predicatePostings, unit.field, unit.nodeId, { family: unit.family });
      if (unit.fact?.claimKind) addPosting(predicatePostings, unit.fact.claimKind, unit.nodeId, { family: unit.family });
      const timeKey = unit.fact?.time?.label || unit.fact?.values?.time || (Number.isSafeInteger(unit.headThroughTurn) ? `turn:${unit.headThroughTurn}` : '');
      if (timeKey) addPosting(timePostings, String(timeKey), unit.nodeId, { family: unit.family });
    }
    for (const edge of graph.edges || []) {
      addPosting(predicatePostings, edge.predicate, edge.from, { via: 'edge_out', edgeId: edge.id });
      if (['mentions', 'subject_of', 'target_of'].includes(edge.predicate)) {
        addPosting(entityPostings, edge.to, edge.from, { role: edge.predicate, edgeId: edge.id });
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

    const stats = {
      directoryCount: directory.length,
      adjacencyCount: adjacency.length,
      postingCount: postings.length,
      lexicalTermCount: lexicalMap.size,
      entityKeyCount: entityPostings.size,
      predicateKeyCount: predicatePostings.size,
      timeKeyCount: timePostings.size
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
      stats,
      authority: 'descriptive_only',
      modelDispatchEligible: false
    });
  };

  const queryPage = (compiled, {
    table = 'adjacency',
    anchorNodeId = '',
    direction = '',
    predicate = '',
    channel = '',
    term = '',
    offset = 0,
    pageBytes = 16384
  } = {}) => {
    if (!compiled || compiled.schema !== schema) fail('compiled_index_required');
    if (!['directory', 'adjacency', 'postings'].includes(table)) fail('table_invalid');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > 65536) {
      fail('options_invalid');
    }
    let sourceRows = compiled[table];
    if (table === 'adjacency') {
      sourceRows = sourceRows.filter(row => (
        (!anchorNodeId || row.anchorNodeId === anchorNodeId)
        && (!direction || row.direction === direction)
        && (!predicate || row.predicate === predicate)
      ));
    } else if (table === 'postings') {
      sourceRows = sourceRows.filter(row => (
        (!channel || row.channel === channel)
        && (!term || row.term === term)
      ));
    } else if (table === 'directory' && anchorNodeId) {
      sourceRows = sourceRows.filter(row => row.nodeId === anchorNodeId || row.sourceId === anchorNodeId);
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

  return Object.freeze({ compile, queryPage });
};
