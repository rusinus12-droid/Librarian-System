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
          refs.push({ key, table, digest, rows: page.items.length, bytes: page.serializedUtf8Bytes, offset });
          offset = page.nextOffset;
        } while (offset < compiled[table].length);
      }
      const metadata = { ...compiled }; for (const table of tables) delete metadata[table];
      const manifest = { schema, frame: graph.readerFrame, config, windows: value.windows, generation, metadata, refs,
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
  const read = async ({ initialGraph, snapshot, owner } = {}) => {
    const loc = location(initialGraph), rootRaw = await owner.read(loc.rootKey); owner.check();
    if (rootRaw === null) return null;
    const root = parse(rootRaw,2048);
    if (root.schema !== schema || !/^[a-f0-9]{64}$/.test(root.digest) || root.manifestKey !== loc.prefix + 'manifest:' + root.digest) fail('root_invalid');
    const raw = await owner.read(root.manifestKey), manifest = parse(raw,131072);
    if (hash(raw) !== root.digest || manifest.schema !== schema || !same(manifest.frame,initialGraph.readerFrame)
      || !Array.isArray(manifest.refs) || manifest.refs.length > 512 || !Array.isArray(manifest.windows)
      || manifest.windows.length < 1 || manifest.windows.length > 128) fail('manifest_invalid');
    const native = await enumerate(snapshot, manifest.config, owner.check);
    if (!same(native.windows,manifest.windows) || stamp(native.graph) !== manifest.generation) fail('stale_generation');
    const restored = { ...manifest.metadata, ...Object.fromEntries(tables.map(table => [table,[]])) };
    let total = 0;
    for (const ref of manifest.refs) {
      if (!tables.includes(ref.table) || !/^[a-f0-9]{64}$/.test(ref.digest)
        || ref.key !== loc.prefix + 'page:' + ref.table + ':' + ref.digest
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 2 || ref.bytes > native.config.pageBytes
        || ref.offset !== restored[ref.table].length) fail('directory_invalid');
      total += ref.bytes; if (total > native.config.maxSerializedBytes) fail('index_budget');
      const text = await owner.read(ref.key); owner.check();
      const rows = parse(text,native.config.pageBytes);
      if (hash(text) !== ref.digest || !Array.isArray(rows) || rows.length !== ref.rows
        || pages.measure(rows,native.config.pageBytes).utf8Bytes !== ref.bytes) fail('page_corrupt');
      const handle = pages.open({ partition: loc.partition, generation: manifest.generation }); let stage, lease;
      try {
        stage = pages.reserve(handle,pages.stageCost(pages.measure(rows,native.config.pageBytes)));
        lease = pages.install(handle,{ pool: 'units', codec: 'json_array.v1', digest: ref.digest, rows: ref.rows },text,stage);
        restored[ref.table].push(...pages.decode(lease));
      } finally { if (lease) pages.release(lease); if (stage) pages.releaseStage(stage); pages.close(handle); }
    }
    const compiledIndex = index.restore(restored,{ partition: loc.partition, generation: stamp(native.graph) });
    if (await owner.read(loc.rootKey) !== rootRaw) fail('root_changed'); owner.check();
    const currentGraph = async () => {
      const live = await enumerate(snapshot, native.config, owner.check);
      if (!same(live.windows,manifest.windows) || stamp(live.graph) !== manifest.generation) fail('stale_generation');
      return live.graph;
    };
    return { ...native, compiledIndex, currentGraph,
      access: { schema, mode: 'durable_common_index', generation: manifest.generation, indexDigest: compiledIndex.indexDigest,
        windowCount: native.windows.length, pageCount: manifest.refs.length,
        serializedGraphBytes: native.serializedGraphBytes, serializedIndexBytes: total,
        nativeReprojectionRequired: true, ownerAtomicity: false, inventoryComplete: false, byteBounded: false } };
  };
  return Object.freeze({ build, read, prepare, enumerate, location, inspect: () => ({ activeBuild: active }) });
};
