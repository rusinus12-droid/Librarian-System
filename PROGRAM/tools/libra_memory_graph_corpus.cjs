'use strict';
// Full owner-window enumeration + durable common index. Native readers still
// supply every fact and final delivery proof; persisted tables grant no authority.
module.exports = function createMemoryGraphCorpus({ pages, index, fingerprint } = {}) {
  if (!pages || !index?.restore || typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_CORPUS_ADAPTER_REQUIRED');
  const pools = ['nodes','edges','bases','units'];
  const tables = ['directory','adjacency','postings','reverseDependencies'];
  const schema = 'libra.graph_corpus.v1';
  let active = false;
  const fail = reason => { const e = new Error('LIBRA_GRAPH_CORPUS_' + reason.toUpperCase()); e.reason = reason; throw e; };
  const hash = value => { const h = fingerprint(value); if (!/^[a-f0-9]{64}$/.test(h)) fail('digest_invalid'); return h; };
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const partition = graph => JSON.stringify({ owner: graph.readerFrame.owner, scopeKey: graph.scopeKey, viewer: graph.readerFrame.view.viewerId });
  const stamp = graph => pages.generation(graph, { partition: partition(graph), restoreEpoch: graph.readerFrame.restoreEpoch, view: graph.readerFrame });
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
    const value = { limit: 20, nodeLimit: 2048, maxWindows: 64, maxSerializedBytes: 4194304, pageBytes: 8192, ...input };
    for (const [key,min,max] of [['limit',1,50],['nodeLimit',1,8192],['maxWindows',1,128],['maxSerializedBytes',65536,8388608],['pageBytes',512,16384]]) {
      if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) fail('policy_invalid');
    }
    if (Object.keys(value).some(key => !['limit','nodeLimit','maxWindows','maxSerializedBytes','pageBytes'].includes(key))) fail('policy_invalid');
    return value;
  };
  const enumerate = async (snapshot, input, check = () => {}) => {
    const config = policy(input), maps = Object.fromEntries(pools.map(pool => [pool,new Map()]));
    const sourceKeys = new Set(), canonicalRows = new Map(), windows = [], reasons = {}, families = {}, sourceReadFailures = new Map();
    let first = null, collected = null, options = { limit: config.limit, nodeLimit: config.nodeLimit, canonicalCursor: '', microCursor: '' };
    let bytes = 0;
    for (;;) {
      check();
      if (windows.length >= config.maxWindows) fail('window_budget');
      const value = await snapshot(options); check();
      const graph = value.graph;
      if (!first) { first = graph; collected = value.collected; }
      if (!same(first.readerFrame, graph.readerFrame) || graph.scopeKey !== first.scopeKey) fail('frame_changed');
      const inventory = graph.coverage?.inventory;
      if (!inventory || inventory.canonicalTotal !== first.coverage.inventory.canonicalTotal
        || inventory.microTurnTotal !== first.coverage.inventory.microTurnTotal) fail('inventory_changed');
      windows.push({ ordinal: windows.length, stamp: windowStamp(graph) });
      for (const pool of pools) for (const row of graph[pool]) {
        const id = row.id || row.nodeId, before = maps[pool].get(id);
        if (before) { if (!same(before,row)) fail('overlap_changed'); continue; }
        bytes += pages.measure(row, config.maxSerializedBytes).utf8Bytes;
        if (bytes > config.maxSerializedBytes) fail('workspace_budget');
        maps[pool].set(id,row);
      }
      for (const key of value.collected?.sourceKeys || []) sourceKeys.add(key);
      for (const row of value.collected?.canonicalRows || []) {
        const before = canonicalRows.get(row.key);
        if (before && !same(before,row)) fail('source_changed');
        canonicalRows.set(row.key,row);
      }
      for (const failure of graph.coverage?.sourceReadFailures || []) sourceReadFailures.set(JSON.stringify(failure),failure);
      for (const [family, entry] of Object.entries(graph.coverage.families || {})) {
        families[family] = { ...entry }; reasons[family] ||= new Set();
        for (const reason of entry.reasons || []) if (!['canonical_pages_unread','micro_pages_unread'].includes(reason)) reasons[family].add(reason);
      }
      const nextCanonical = inventory.canonicalNextCursor || '', nextMicro = inventory.microNextCursor || '';
      if (!nextCanonical && !nextMicro) break;
      // Retain the last cursor of a completed family; empty would restart it.
      const next = { ...options, canonicalCursor: nextCanonical || options.canonicalCursor, microCursor: nextMicro || options.microCursor };
      if (same(next,options)) fail('cursor_stalled');
      options = next;
    }
    const arrays = Object.fromEntries(pools.map(pool => [pool,[...maps[pool].values()]]));
    // A State derivation may be outside one slice and present in a later one.
    // Clear that slice-local note only after checking every recorded field in
    // the merged graph; unrelated uncertainty/ambiguity notes remain intact.
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
    const graph = { ...first, ...arrays, coverage: { ...first.coverage, scope: 'enumerated_owner_windows', families,
      sourceReadFailures: [...sourceReadFailures.values()],
      inventory: { ...first.coverage.inventory, canonicalRead: canonicalRows.size,
        microRead: new Set(arrays.units.filter(unit => unit.family === 'micro').map(unit => unit.recordKey || unit.nodeId)).size,
        canonicalNextCursor: '', microNextCursor: '', inventoryComplete: false,
        scope: 'enumerated_owner_windows', enumeratedWindows: windows.length, exhaustiveOwnerDeltaVerified: false },
      projectionComplete: sourceReadFailures.size === 0 && Object.values(families).every(entry => !entry.reasons.length) } };
    return { graph, windows, collected: { ...collected, sourceKeys: [...sourceKeys].sort(), canonicalRows: [...canonicalRows.values()] },
      serializedGraphBytes: bytes, config };
  };
  const parse = (raw, maximum) => {
    if (typeof raw !== 'string' || raw.length > maximum || new TextEncoder().encode(raw).length > maximum) fail('record_size');
    try { return JSON.parse(raw); } catch (_) { fail('record_invalid'); }
  };
  const immutable = async (owner, key, raw) => {
    owner.check(); const before = await owner.read(key); owner.check();
    if (before === null) await owner.putImmutable(key, raw);
    else if (before !== raw) fail('immutable_collision');
    if (await owner.read(key) !== raw) fail('write_readback'); owner.check();
  };
  // A cold or superseded derived index never selects another search engine.
  // Read the current owner corpus and compile it once in the same query path.
  const prepare = async ({ snapshot, owner, options = {}, reason = 'no_published_corpus' } = {}) => {
    const native = await enumerate(snapshot, options, owner.check), generation = stamp(native.graph);
    return { ...native, compiledIndex: null,
      currentGraph: async () => {
        const live = await enumerate(snapshot, native.config, owner.check);
        if (!same(live.windows,native.windows) || stamp(live.graph) !== generation) fail('source_changed');
        return live.graph;
      },
      access: { schema, mode: 'request_local_corpus', reason, generation, windowCount: native.windows.length,
        nativeReprojectionRequired: true, ownerAtomicity: false, inventoryComplete: false, byteBounded: false }
    };
  };
  const routingVersion = 'libra.index_page_routing.v1';
  const routingKinds = { directory: ['node','source'], adjacency: ['anchor'],
    postings: ['lexical','entity','predicate','time'], reverseDependencies: ['dependency'] };
  const range = values => {
    const sorted = [...new Set(values.filter(value => typeof value === 'string' && value))].sort((a,b) => a.localeCompare(b,'en'));
    return sorted.length ? { min: sorted[0], max: sorted.at(-1) } : null;
  };
  const routingFor = (table, rows) => routingKinds[table].flatMap(kind => {
    const values = rows.filter(row => table !== 'postings' || row.channel === kind).map(row =>
      table === 'postings' ? row.term : kind === 'node' ? row.nodeId : kind === 'source' ? row.sourceId
        : kind === 'anchor' ? row.anchorNodeId : row.dependencyKey);
    const value = range(values); return value ? [{ kind, ...value }] : [];
  });
  const validRouting = ref => Array.isArray(ref.routing) && ref.routing.length <= routingKinds[ref.table].length
    && new Set(ref.routing.map(row => row?.kind)).size === ref.routing.length
    && (ref.rows === 0 ? ref.routing.length === 0 : ref.routing.length > 0)
    && ref.routing.every(row => row && Object.keys(row).sort().join(',') === 'kind,max,min'
      && routingKinds[ref.table].includes(row.kind) && typeof row.min === 'string' && row.min.length > 0 && row.min.length <= 8192
      && typeof row.max === 'string' && row.max.length > 0 && row.max.length <= 8192 && row.min.localeCompare(row.max,'en') <= 0);
  const mightContain = (ref, spec) => {
    const term = spec.table === 'postings' ? spec.term : spec.table === 'reverseDependencies' ? spec.dependencyKey : spec.anchorNodeId;
    return ref.routing.some(row => (!spec.channel || spec.table !== 'postings' || row.kind === spec.channel)
      && (!term || row.min.localeCompare(term,'en') <= 0 && row.max.localeCompare(term,'en') >= 0));
  };
  const build = async ({ snapshot, owner, options = {} } = {}) => {
    if (active) fail('build_busy'); active = true;
    try {
      const value = await enumerate(snapshot, options, owner.check), { graph, config } = value;
      const loc = location(graph), generation = stamp(graph), previous = await owner.read(loc.rootKey);
      const compiled = index.compile(graph, { partition: loc.partition, generation, pageBytes: config.pageBytes });
      const refs = []; let total = 0;
      for (const table of tables) {
        let offset = 0;
        do {
          const page = pages.page({ units: compiled[table] }, { partition: loc.partition, generation, pool: 'units', offset, pageBytes: config.pageBytes });
          if (page.nextOffset === offset && compiled[table].length) fail('page_' + page.stopReason);
          const text = JSON.stringify(page.items), digest = hash(text), key = loc.prefix + 'page:' + table + ':' + digest;
          total += page.serializedUtf8Bytes;
          if (total > config.maxSerializedBytes || refs.length >= 512) fail('index_budget');
          await immutable(owner,key,text);
          refs.push({ key, table, digest, rows: page.items.length, bytes: page.serializedUtf8Bytes, offset, routing: routingFor(table,page.items) });
          offset = page.nextOffset;
        } while (offset < compiled[table].length);
      }
      const metadata = { ...compiled }; for (const table of tables) delete metadata[table];
      const manifest = { schema, routingVersion, frame: graph.readerFrame, config, windows: value.windows, generation, metadata, refs,
        serializedGraphBytes: value.serializedGraphBytes, serializedIndexBytes: total,
        ownerAtomicity: false, inventoryComplete: false, byteBounded: false, modelDispatchEligible: false };
      pages.measure(manifest, 131072);
      const raw = JSON.stringify(manifest), digest = hash(raw), key = loc.prefix + 'manifest:' + digest;
      await immutable(owner,key,raw);
      const final = await enumerate(snapshot, config, owner.check);
      if (!same(value.windows,final.windows) || stamp(final.graph) !== generation) fail('source_changed');
      await owner.publish({ key: loc.rootKey, previous, raw: JSON.stringify({ schema, manifestKey: key, digest }), manifestKey: key, manifestRaw: raw });
      // Root publication is ordered/CAS, not a cross-corpus transaction. A late
      // edit leaves an unusable old generation, never an authoritative new fact.
      const after = await enumerate(snapshot, config, owner.check);
      if (!same(value.windows,after.windows)) fail('source_changed_after_publication');
      return { schema, status: 'published', generation, indexDigest: compiled.indexDigest, windowCount: value.windows.length,
        pageCount: refs.length, serializedGraphBytes: value.serializedGraphBytes, serializedIndexBytes: total,
        ownerAtomicity: false, inventoryComplete: false, byteBounded: false, modelDispatchEligible: false };
    } finally { active = false; }
  };
  const read = async ({ initialGraph, snapshot, owner, eager = false } = {}) => {
    const loc = location(initialGraph), rootRaw = await owner.read(loc.rootKey); owner.check();
    if (rootRaw === null) return null;
    const root = parse(rootRaw,2048);
    if (root.schema !== schema || !/^[a-f0-9]{64}$/.test(root.digest) || root.manifestKey !== loc.prefix + 'manifest:' + root.digest) fail('root_invalid');
    const raw = await owner.read(root.manifestKey), manifest = parse(raw,131072);
    if (hash(raw) !== root.digest || manifest.schema !== schema || !same(manifest.frame,initialGraph.readerFrame)
      || !Array.isArray(manifest.refs) || manifest.refs.length > 512 || !Array.isArray(manifest.windows)
      || manifest.windows.length < 1 || manifest.windows.length > 128) fail('manifest_invalid');
    if (manifest.routingVersion !== undefined && manifest.routingVersion !== routingVersion) fail('routing_invalid');
    const native = await enumerate(snapshot, manifest.config, owner.check);
    if (!same(native.windows,manifest.windows) || stamp(native.graph) !== manifest.generation) fail('stale_generation');
    const lazy = !eager && manifest.routingVersion === routingVersion;
    const counts = Object.fromEntries(tables.map(table => [table,0])); let total = 0;
    for (const ref of manifest.refs) {
      if (!ref || !tables.includes(ref.table) || !/^[a-f0-9]{64}$/.test(ref.digest)
        || ref.key !== loc.prefix + 'page:' + ref.table + ':' + ref.digest
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 2 || ref.bytes > native.config.pageBytes
        || !Number.isSafeInteger(ref.rows) || ref.rows < 0 || ref.offset !== counts[ref.table]
        || manifest.routingVersion && !validRouting(ref)) fail('directory_invalid');
      counts[ref.table] += ref.rows;
      total += ref.bytes; if (total > native.config.maxSerializedBytes) fail('index_budget');
    }
    for (const [table,stat] of [['directory','directoryCount'],['adjacency','adjacencyCount'],['postings','postingCount'],['reverseDependencies','reverseDependencyCount']]) {
      if (!manifest.refs.some(ref => ref.table === table) || counts[table] !== manifest.metadata?.stats?.[stat]) fail('directory_invalid');
    }
    const metrics = { storageAccess: lazy ? 'selective_durable_pages' : 'materialized_tables',
      publishedPages: manifest.refs.length, publishedBytes: total, pagesRead: 0, bytesRead: 0, cacheHits: 0, uniquePagesRead: 0 };
    // No raw/decoded table cache: re-acquire validated content through the shared
    // Cache Manager. Every new request physically verifies its first page use.
    const validated = new Set();
    const assertIndexCurrent = async () => {
      owner.check(); if (await owner.read(loc.rootKey) !== rootRaw) fail('root_changed'); owner.check();
    };
    const readPage = async (ref, consume, budget) => {
      owner.check(); let handle,stage,lease;
      try {
        handle = pages.open({ partition: loc.partition, generation: manifest.generation });
        const binding = { pool: 'units', codec: 'json_array.v1', digest: ref.digest, rows: ref.rows };
        if (validated.has(ref.key)) lease = pages.acquire(handle,binding);
        if (lease) metrics.cacheHits++;
        else {
          if (budget && budget.pagesRead >= budget.maxPages) return 'storage_page_count_budget';
          if (budget && budget.bytesRead + ref.bytes > budget.maxBytes) return 'storage_byte_budget';
          // Reserve expected raw/decode workspace before initiating physical I/O.
          stage = pages.reserve(handle,pages.stageCost({ utf8Bytes: ref.bytes, codeUnits: ref.bytes, tokens: 0 }));
          if (budget) { budget.pagesRead++; budget.bytesRead += ref.bytes; }
          metrics.pagesRead++; metrics.bytesRead += ref.bytes;
          const text = await owner.read(ref.key); owner.check();
          if (typeof text !== 'string' || text.length > native.config.pageBytes || hash(text) !== ref.digest) fail('page_corrupt');
          const size = pages.encodedSize(text);
          if (size.utf8Bytes !== ref.bytes) fail('page_corrupt');
          pages.releaseStage(stage); stage = null;
          stage = pages.reserve(handle,pages.stageCost(size));
          lease = pages.install(handle,binding,text,stage);
          validated.add(ref.key); metrics.uniquePagesRead = validated.size;
        }
        const rows = pages.decode(lease);
        if (!Array.isArray(rows) || rows.length !== ref.rows || pages.measure(rows,native.config.pageBytes).utf8Bytes !== ref.bytes
          || manifest.routingVersion && !same(routingFor(ref.table,rows),ref.routing)) fail('page_corrupt');
        consume(rows); owner.check(); return null;
      } finally { if (lease) pages.release(lease); if (stage) pages.releaseStage(stage); if (handle) pages.close(handle); }
    };
    const readRows = async (spec,budget) => {
      owner.check(); await owner.assertRoute?.(); owner.check();
      const credit = budget || { maxPages: 512, maxBytes: 8388608, pagesRead: 0, bytesRead: 0 };
      if (!Number.isSafeInteger(credit.maxPages) || credit.maxPages < 1 || credit.maxPages > 512
        || !Number.isSafeInteger(credit.maxBytes) || credit.maxBytes < 512 || credit.maxBytes > 8388608
        || !Number.isSafeInteger(credit.pagesRead) || credit.pagesRead < 0 || credit.pagesRead > credit.maxPages
        || !Number.isSafeInteger(credit.bytesRead) || credit.bytesRead < 0 || credit.bytesRead > credit.maxBytes) fail('storage_budget_invalid');
      const rows = [];
      for (const ref of manifest.refs) if (ref.table === spec.table && mightContain(ref,spec)) {
        const stopped = await readPage(ref, page => rows.push(...page), credit);
        if (stopped) return { storageStopped: true, stopReason: stopped };
      }
      await assertIndexCurrent(); return { rows };
    };
    let compiledIndex;
    if (lazy) compiledIndex = index.restoreLazy(manifest.metadata,{ partition: loc.partition, generation: stamp(native.graph), readRows });
    else {
      const restored = { ...manifest.metadata, ...Object.fromEntries(tables.map(table => [table,[]])) };
      for (const ref of manifest.refs) await readPage(ref, rows => restored[ref.table].push(...rows));
      compiledIndex = index.restore(restored,{ partition: loc.partition, generation: stamp(native.graph) });
    }
    await assertIndexCurrent();
    const currentGraph = async () => {
      await assertIndexCurrent();
      const live = await enumerate(snapshot, native.config, owner.check);
      if (!same(live.windows,manifest.windows) || stamp(live.graph) !== manifest.generation) fail('stale_generation');
      await assertIndexCurrent(); return live.graph;
    };
    return { ...native, compiledIndex, currentGraph, assertIndexCurrent,
      access: { schema, mode: 'durable_common_index', generation: manifest.generation, indexDigest: compiledIndex.indexDigest,
        windowCount: native.windows.length, pageCount: manifest.refs.length,
        serializedGraphBytes: native.serializedGraphBytes, serializedIndexBytes: total, storage: metrics,
        nativeReprojectionRequired: true, ownerAtomicity: false, inventoryComplete: false, byteBounded: false } };
  };
  return Object.freeze({ build, read, prepare, enumerate, location, inspect: () => ({ activeBuild: active }) });
};
