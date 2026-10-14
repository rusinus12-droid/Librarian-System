'use strict';
// Durable derived pages only. All storage/current-owner authority is injected;
// serialized generations never grant final model delivery permission.
module.exports = function createMemoryGraphStore({ pages, fingerprint } = {}) {
  if (!pages || typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_STORE_ADAPTER_REQUIRED');
  const pools = ['nodes','edges','bases','units'];
  const policy = 'owner_projection_directory.v1', pageSchema = 'libra.graph_durable_page.v1';
  let active = false, epoch = 0, disposed = false;
  const counters = { builds: 0, publications: 0, reads: 0, pageReads: 0, pageWrites: 0, pageReuses: 0, validations: 0, rejected: 0, gcRuns: 0, gcDeleted: 0 };
  const fail = reason => { const error = new Error('LIBRA_GRAPH_STORE_' + reason.toUpperCase()); error.reason = reason; throw error; };
  const hash = text => { const value = fingerprint(text); if (!/^[a-f0-9]{64}$/.test(value)) fail('fingerprint_invalid'); return value; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const partition = graph => JSON.stringify({ owner: graph.readerFrame.owner, scopeKey: graph.scopeKey, viewer: graph.readerFrame.view.viewerId });
  const location = (graph, sourceOptions) => {
    const prefix = 'libra:v1:scope:' + graph.scopeKey + ':memory-graph:v1:';
    const slot = hash(JSON.stringify([policy, graph.readerFrame.owner, graph.readerFrame.worldlineId, graph.readerFrame.view.viewerId, sourceOptions]));
    return { prefix, rootKey: prefix + 'root:' + slot, partition: partition(graph) };
  };
  const check = (ticket, owner) => {
    if (disposed || ticket !== epoch) fail('cancelled'); owner.check();
  };
  const json = async (value, part, generation, work, ceiling = 131072) => {
    const size = pages.measure(value, ceiling), handle = pages.open({ partition: part, generation }); let stage;
    try { stage = pages.reserve(handle, pages.stageCost(size)); return await work(JSON.stringify(value), size); }
    finally { if (stage) pages.releaseStage(stage); pages.close(handle); }
  };
  const graphStamp = graph => {
    const part = partition(graph);
    return pages.generation(graph, { partition: part, restoreEpoch: graph.readerFrame.restoreEpoch, view: graph.readerFrame });
  };
  const visit = async (graph, opts, callback) => {
    const stamp = graphStamp(graph), loc = location(graph, opts.sourceOptions), refs = [];
    for (const pool of pools) {
      let offset = 0;
      do {
        const page = pages.page(graph, { partition: loc.partition, generation: stamp, pool, offset, pageBytes: opts.pageBytes });
        if (page.nextOffset === offset && graph[pool].length) fail('page_budget_' + page.stopReason);
        const ref = await json(page.items, loc.partition, stamp, async (text, size) => {
          const digest = hash(text), key = loc.prefix + 'page:' + pool + ':' + digest;
          const header = { key, pool, offset, end: page.nextOffset, rows: page.items.length,
            digest, utf8Bytes: size.utf8Bytes, codeUnits: size.codeUnits, tokens: size.tokens };
          const record = { schema: pageSchema, partition: loc.partition, pool, codec: 'json_array.v1',
            digest, rows: header.rows, utf8Bytes: size.utf8Bytes, codeUnits: size.codeUnits, text };
          await callback(header, record); return header;
        }, opts.pageBytes);
        refs.push(ref); if (refs.length > 48) fail('directory_page_limit');
        offset = page.nextOffset;
      } while (offset < graph[pool].length);
    }
    return { stamp, loc, refs, totals: Object.fromEntries(pools.map(pool => [pool, graph[pool].length])) };
  };
  const validateRecord = (record, ref, part) => {
    if (!record || record.schema !== pageSchema || record.partition !== part || record.pool !== ref.pool || record.codec !== 'json_array.v1'
      || record.digest !== ref.digest || record.rows !== ref.rows || record.utf8Bytes !== ref.utf8Bytes
      || record.codeUnits !== ref.codeUnits || typeof record.text !== 'string' || record.text.length !== ref.codeUnits
      || hash(record.text) !== ref.digest) fail('page_corrupt');
  };
  const parse = async (raw, maxChars, part, generation) => {
    if (typeof raw !== 'string' || raw.length > maxChars) fail('record_size_invalid');
    const handle = pages.open({ partition: part, generation }); let stage;
    try {
      const bytes = 65536 + raw.length * 24;
      stage = pages.reserve(handle, bytes); return JSON.parse(raw);
    } finally { if (stage) pages.releaseStage(stage); pages.close(handle); }
  };
  const load = async (owner, key, maxChars, part, stamp, ticket) => {
    check(ticket, owner); const raw = await owner.read(key); check(ticket, owner);
    return { raw, value: raw === null ? null : await parse(raw, maxChars, part, stamp) };
  };
  const immutable = async (owner, key, value, part, stamp, ticket, maximum = 147456) => {
    return await json(value, part, stamp, async raw => {
      const before = await load(owner, key, maximum, part, stamp, ticket);
      if (before.raw !== null) {
        if (before.raw !== raw) fail('immutable_collision'); counters.pageReuses++; return raw;
      }
      check(ticket, owner); await owner.putImmutable(key, raw); check(ticket, owner); counters.pageWrites++;
      if ((await load(owner, key, maximum, part, stamp, ticket)).raw !== raw) fail('write_readback_failed');
      return raw;
    });
  };
  const build = async ({ snapshot, owner, sourceOptions, pageBytes = 16384, jobToken } = {}) => {
    if (active) fail('build_busy'); if (disposed) fail('disposed');
    if (!Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > 65536 || typeof jobToken !== 'string' || !jobToken || jobToken.length > 240) fail('options_invalid');
    active = true; const ticket = epoch; counters.builds++;
    try {
      const initial = await snapshot(); check(ticket, owner);
      const loc = location(initial.graph, sourceOptions), stamp = graphStamp(initial.graph);
      const sourcePin = await owner.capture([...initial.sourceKeys, loc.rootKey]); check(ticket, owner);
      const previous = await load(owner, loc.rootKey, 32768, loc.partition, stamp, ticket);
      const expected = [];
      const directory = await visit(initial.graph, { sourceOptions, pageBytes }, async (ref, record) => {
        const raw = await immutable(owner, ref.key, record, loc.partition, stamp, ticket);
        expected.push({ key: ref.key, raw });
      });
      const after = await snapshot(); check(ticket, owner);
      if (graphStamp(after.graph) !== stamp || !same(after.sourceKeys, initial.sourceKeys)) fail('source_changed');
      const rederived = await visit(after.graph, { sourceOptions, pageBytes }, async (ref, record) => {
        check(ticket, owner);
        const stored = await load(owner, ref.key, ref.codeUnits * 2 + 8192, loc.partition, stamp, ticket);
        validateRecord(stored.value, ref, loc.partition);
        if (!same(stored.value, record)) fail('projection_mismatch'); counters.validations++;
      });
      if (!same(directory.refs, rederived.refs)) fail('source_changed');
      const manifest = { schema: 'libra.graph_generation.v1', policy, sourceOptions, pageBytes,
        sourceStamp: stamp, readerFrame: after.graph.readerFrame, coverage: after.graph.coverage,
        partition: loc.partition, pages: directory.refs, totals: directory.totals,
        jobToken, inventoryComplete: false, ownerAtomicity: false, modelDispatchEligible: false };
      let manifestRaw, generation, manifestKey;
      await json(manifest, loc.partition, stamp, async raw => {
        manifestRaw = raw; generation = hash(raw); manifestKey = loc.prefix + 'generation:' + generation;
        await immutable(owner, manifestKey, manifest, loc.partition, stamp, ticket, 131072);
      });
      const root = { schema: 'libra.graph_root.v1', policy, generation, manifestKey,
        sourceStamp: stamp, publicationToken: jobToken, publication: owner.publication, inventoryComplete: false };
      expected.push({ key: manifestKey, raw: manifestRaw });
      await owner.assertCaptured(sourcePin); check(ticket, owner);
      await json(root, loc.partition, stamp, async raw => {
        await owner.commitRoot({ key: loc.rootKey, raw, previous: previous.raw, expected, sourcePin }); check(ticket, owner);
        if ((await load(owner, loc.rootKey, 32768, loc.partition, stamp, ticket)).raw !== raw) fail('root_readback_failed');
      });
      const final = await snapshot(); check(ticket, owner);
      if (graphStamp(final.graph) !== stamp) fail('source_changed_after_publication');
      counters.publications++;
      return { schema: 'libra.graph_generation_build.v1', status: 'published', generation,
        pageCount: directory.refs.length, totals: directory.totals, coverage: manifest.coverage,
        publication: owner.publication, ownerAtomicity: false, inventoryComplete: false, modelDispatchEligible: false,
        providerCalls: 0, sourceStamp: stamp, readerValidation: final.graph.readerValidation || null };
    } catch (error) { counters.rejected++; throw error; }
    finally { active = false; }
  };
  const read = async ({ snapshot, owner, sourceOptions, pool = 'units', pageIndex = 0, expectedGeneration = '' } = {}) => {
    if (!pools.includes(pool) || !Number.isSafeInteger(pageIndex) || pageIndex < 0) fail('options_invalid');
    const ticket = epoch; counters.reads++;
    const current = await snapshot(); check(ticket, owner);
    const graph = current.graph, loc = location(graph, sourceOptions), stamp = graphStamp(graph);
    const root = await load(owner, loc.rootKey, 32768, loc.partition, stamp, ticket);
    const missing = reason => ({ schema: 'libra.graph_durable_read.v1', status: reason, items: [],
      scopeKey: graph.scopeKey, readerFrame: graph.readerFrame, readerValidation: graph.readerValidation || null,
      coverage: graph.coverage, requestLocalReadOnly: true, modelDispatchEligible: false, durableGenerationVerified: false });
    if (!root.value) return missing('missing_generation');
    if (root.value.schema !== 'libra.graph_root.v1' || root.value.policy !== policy
      || !/^[a-f0-9]{64}$/.test(root.value.generation) || root.value.manifestKey !== loc.prefix + 'generation:' + root.value.generation) fail('root_invalid');
    if (expectedGeneration && expectedGeneration !== root.value.generation) fail('cursor_stale');
    if (root.value.sourceStamp !== stamp) return missing('stale_generation');
    const stored = await load(owner, root.value.manifestKey, 131072, loc.partition, stamp, ticket), manifest = stored.value;
    if (!manifest || hash(stored.raw) !== root.value.generation || manifest.schema !== 'libra.graph_generation.v1'
      || manifest.policy !== policy || manifest.partition !== loc.partition || manifest.sourceStamp !== stamp
      || manifest.jobToken !== root.value.publicationToken || root.value.publication !== owner.publication
      || !same(manifest.readerFrame, graph.readerFrame) || !same(manifest.sourceOptions, sourceOptions)
      || !same(manifest.coverage, graph.coverage) || !Array.isArray(manifest.pages) || manifest.pages.length > 48
      || !Number.isSafeInteger(manifest.pageBytes) || manifest.pageBytes < 256 || manifest.pageBytes > 65536) fail('manifest_invalid');
    const selected = manifest.pages.filter(ref => ref.pool === pool);
    if (pageIndex >= selected.length) fail('page_index_invalid');
    let items = null;
    const derived = await visit(graph, { sourceOptions, pageBytes: manifest.pageBytes }, async (ref, record) => {
      const original = manifest.pages.find(row => row.pool === ref.pool && row.offset === ref.offset);
      if (!same(original, ref)) fail('directory_mismatch');
      const page = await load(owner, ref.key, ref.codeUnits * 2 + 8192, loc.partition, stamp, ticket);
      validateRecord(page.value, ref, loc.partition);
      if (!same(page.value, record)) fail('projection_mismatch'); counters.pageReads++; counters.validations++;
      if (ref.key === selected[pageIndex].key && ref.offset === selected[pageIndex].offset) {
        const handle = pages.open({ partition: loc.partition, generation: root.value.generation }); let stage, lease;
        try { stage = pages.reserve(handle, pages.stageCost({ utf8Bytes: ref.utf8Bytes, codeUnits: ref.codeUnits, tokens: ref.tokens }));
          lease = pages.install(handle, { pool, codec: 'json_array.v1', digest: ref.digest, rows: ref.rows }, page.value.text, stage);
          items = pages.decode(lease); }
        finally { if (lease) pages.release(lease); if (stage) pages.releaseStage(stage); pages.close(handle); }
      }
    });
    if (!same(derived.refs, manifest.pages) || !same(derived.totals, manifest.totals)) fail('directory_mismatch');
    if ((await load(owner, loc.rootKey, 32768, loc.partition, stamp, ticket)).raw !== root.raw) fail('root_changed');
    const final = await snapshot(); check(ticket, owner);
    if (graphStamp(final.graph) !== stamp) return missing('stale_generation');
    return { schema: 'libra.graph_durable_read.v1', status: 'verified', generation: root.value.generation,
      pool, pageIndex, nextPageIndex: pageIndex + 1 < selected.length ? pageIndex + 1 : null, items,
      coverage: manifest.coverage, sourceStamp: stamp, publication: root.value.publication,
      scopeKey: graph.scopeKey, readerFrame: final.graph.readerFrame, readerValidation: final.graph.readerValidation || null,
      nativeSourceCaptureAdmission: 'unsupported',
      durableGenerationVerified: true, verificationScope: 'current_owner_projection_window_all_persisted_pages',
      inventoryComplete: false, ownerAtomicity: false, modelDispatchEligible: false,
      requestLocalReadOnly: true, byteBounded: false, ownerTransportBounded: false,
      cache: pages.inspect() };
  };
  const collectGarbage = async ({ owner, scopeKey, dryRun = false, throwOnConflict = false } = {}) => {
    if (active) fail('build_busy'); if (disposed) fail('disposed');
    if (!owner || typeof owner.listKeys !== 'function' || typeof scopeKey !== 'string' || !scopeKey) fail('options_invalid');
    active = true; const ticket = epoch; counters.gcRuns++;
    try {
      const prefix = 'libra:v1:scope:' + scopeKey + ':memory-graph:v1:';
      const part = JSON.stringify({ owner: 'gc', scopeKey, viewer: 'maintenance_gc' });
      const stamp = hash(prefix + ':' + ticket);
      check(ticket, owner);
      const allKeys = (await owner.listKeys(prefix)).filter(k => typeof k === 'string' && k.startsWith(prefix));
      const rootKeys = allKeys.filter(k => k.startsWith(prefix + 'root:')).sort((a, b) => a.localeCompare(b, 'en'));
      const rootPin = typeof owner.capture === 'function' ? await owner.capture(rootKeys) : null;
      const rootRawByKey = new Map();
      const retainedManifests = new Set();
      const retainedPages = new Set();

      for (const rootKey of rootKeys) {
        const root = await load(owner, rootKey, 32768, part, stamp, ticket);
        rootRawByKey.set(rootKey, root.raw);
        if (root.raw === null) continue;
        if (!root.value || root.value.schema !== 'libra.graph_root.v1' || typeof root.value.manifestKey !== 'string'
          || !root.value.manifestKey.startsWith(prefix + 'generation:')) {
          fail('gc_root_corrupt');
        }
        retainedManifests.add(root.value.manifestKey);
        const manifest = await load(owner, root.value.manifestKey, 131072, part, stamp, ticket);
        if (!manifest.value || manifest.value.schema !== 'libra.graph_generation.v1' || !Array.isArray(manifest.value.pages)) {
          fail('gc_manifest_corrupt');
        }
        for (const pageRef of manifest.value.pages) {
          if (!pageRef?.key || typeof pageRef.key !== 'string') fail('gc_manifest_corrupt');
          retainedPages.add(pageRef.key);
        }
      }

      const verifyRootsUnchanged = async () => {
        check(ticket, owner);
        if (rootPin && typeof owner.assertCaptured === 'function') {
          await owner.assertCaptured(rootPin);
        }
        const currentKeys = (await owner.listKeys(prefix)).filter(k => typeof k === 'string' && k.startsWith(prefix));
        const currentRootKeys = currentKeys.filter(k => k.startsWith(prefix + 'root:')).sort((a, b) => a.localeCompare(b, 'en'));
        if (!same(currentRootKeys, rootKeys)) fail('gc_concurrent_root_change');
        for (const rootKey of rootKeys) {
          const latest = await load(owner, rootKey, 32768, part, stamp, ticket);
          if (latest.raw !== rootRawByKey.get(rootKey)) fail('gc_concurrent_root_change');
        }
        return currentKeys;
      };

      let postMarkKeys;
      try {
        postMarkKeys = await verifyRootsUnchanged();
      } catch (err) {
        if (throwOnConflict) throw err;
        return {
          schema: 'libra.graph_store_gc.v1',
          status: 'aborted_concurrent_mutation',
          scopeKey,
          dryRun: Boolean(dryRun),
          activeRoots: rootKeys.length,
          retainedManifestCount: retainedManifests.size,
          retainedPageCount: retainedPages.size,
          candidateKeys: [],
          deletedKeys: []
        };
      }

      // Only sweep keys that were already present before the mark phase and remain unreferenced after root verification
      const initialKeySet = new Set(allKeys);
      const candidates = postMarkKeys.filter(k => initialKeySet.has(k) && (
        (k.startsWith(prefix + 'generation:') && !retainedManifests.has(k))
        || (k.startsWith(prefix + 'page:') && !retainedPages.has(k))
      )).sort((a, b) => a.localeCompare(b, 'en'));

      const deleted = [];
      let status = 'completed';
      if (!dryRun && typeof owner.deleteStale === 'function') {
        for (const candidateKey of candidates) {
          try {
            await verifyRootsUnchanged();
          } catch (err) {
            if (throwOnConflict) throw err;
            status = 'aborted_concurrent_mutation';
            break;
          }
          await owner.deleteStale(candidateKey);
          check(ticket, owner);
          deleted.push(candidateKey);
          counters.gcDeleted++;
        }
      }
      return {
        schema: 'libra.graph_store_gc.v1',
        status,
        scopeKey,
        dryRun: Boolean(dryRun),
        activeRoots: rootKeys.length,
        retainedManifestCount: retainedManifests.size,
        retainedPageCount: retainedPages.size,
        candidateKeys: candidates,
        deletedKeys: deleted
      };
    } finally { active = false; }
  };
  return Object.freeze({ build, read, collectGarbage, location, inspect: () => ({ schema: 'libra.graph_store.v1', activeBuild: active,
    invalidationEpoch: epoch, counters: { ...counters }, durableStoreImplemented: true,
    exhaustiveOwnerInventory: false, rootGCImplemented: false, ownerTransportBounded: false }),
    invalidate() { epoch++; }, dispose() { epoch++; disposed = true; } });
};
