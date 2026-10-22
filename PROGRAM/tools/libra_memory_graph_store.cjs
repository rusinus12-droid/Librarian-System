'use strict';
// Durable derived pages only. All storage/current-owner authority is injected;
// serialized generations never grant final model delivery permission.
module.exports = function createMemoryGraphStore({ pages, fingerprint, inventory = null } = {}) {
  if (!pages || typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_STORE_ADAPTER_REQUIRED');
  if (inventory !== null && (typeof inventory.buildSourceInventory !== 'function' || typeof inventory.diffInventories !== 'function'
    || typeof inventory.mergeFamilyInventories !== 'function' || !Array.isArray(inventory.SOURCE_FAMILIES))) {
    throw new TypeError('LIBRA_GRAPH_STORE_INVENTORY_ADAPTER_REQUIRED');
  }
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
  const computeUnreadRegions = coverage => ({
    canonicalNextCursor: coverage?.inventory?.canonicalNextCursor || '',
    microNextCursor: coverage?.inventory?.microNextCursor || '',
    hasUnreadSourceWindows: Boolean(
      coverage?.inventory?.canonicalNextCursor
      || coverage?.inventory?.microNextCursor
    ),
    exhaustiveDeltaSupported: false
  });
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
  const build = async ({ snapshot, owner, sourceOptions, pageBytes = 16384, jobToken, baseRootKey = '', baseGeneration = '' } = {}) => {
    if (active) fail('build_busy'); if (disposed) fail('disposed');
    if (!Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > 65536 || typeof jobToken !== 'string' || !jobToken || jobToken.length > 240) fail('options_invalid');
    active = true; const ticket = epoch; counters.builds++;
    try {
      const initial = await snapshot(); check(ticket, owner);
      const loc = location(initial.graph, sourceOptions), stamp = graphStamp(initial.graph);
      const sourcePin = await owner.capture([...initial.sourceKeys, loc.rootKey]); check(ticket, owner);
      const previous = await load(owner, loc.rootKey, 32768, loc.partition, stamp, ticket);
      // A window request is part of the generation identity, so continuing the enumeration lands in a
      // different slot and cannot see the generation it continues from. The caller may name that base;
      // the store still loads and checks it, and refuses a base that is not what it claims to be.
      let baseManifest = null;
      if (typeof baseRootKey === 'string' && baseRootKey) {
        if (typeof baseGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(baseGeneration)) fail('base_generation_invalid');
        const baseRoot = await load(owner, baseRootKey, 32768, loc.partition, stamp, ticket);
        if (!baseRoot.value || baseRoot.value.schema !== 'libra.graph_root.v1' || baseRoot.value.generation !== baseGeneration
          || baseRoot.value.manifestKey !== loc.prefix + 'generation:' + baseGeneration) fail('base_generation_mismatch');
        baseManifest = (await load(owner, baseRoot.value.manifestKey, 131072, loc.partition, stamp, ticket)).value;
      }
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
      if (typeof owner.registerInProgressBuild === 'function') {
        await owner.registerInProgressBuild({
          jobToken,
          scopeKey: initial.graph.scopeKey,
          workingKeys: directory.refs.map(r => r.key),
          startedAtMs: Date.now()
        });
      }
      // N01: publish what this generation's source window covers, per family, without claiming a whole
      // family. The owner reports its own unread cursors; a window larger than one page is a page, and
      // a page must never be diffed against a whole family.
      const inventorySet = !inventory ? null : (() => {
        const unitFamilies = new Map(inventory.SOURCE_FAMILIES.map(family => [family, []]));
        for (const unit of Array.isArray(after.graph.units) ? after.graph.units : []) {
          const bucket = unitFamilies.get(unit?.family);
          if (!bucket) continue;
          bucket.push({ key: String(unit.nodeId || unit.id || ''), revision: unit.revision || unit.sourceRevision || null, turn: Number.isSafeInteger(unit.turn) ? unit.turn : null });
        }
        const coverageInventory = after.graph.coverage?.inventory || {};
        const pages = inventory.SOURCE_FAMILIES.map(family => inventory.buildSourceInventory({
          family,
          entries: unitFamilies.get(family),
          pageSize: Math.max(256, unitFamilies.get(family).length + 1),
          complete: false,
          ownerUnread: [{ family, cursor: String(coverageInventory[family + 'NextCursor'] || ''), reason: 'owner_cursor' }].filter(region => region.cursor)
        }));
        const merged = inventory.mergeFamilyInventories(pages);
        return { schema: 'libra.graph_generation_inventory.v1', pages, merged };
      })();
      // The absence of a delta is itself a fact, so it is reported with a basis instead of silently.
      // The unread cursors are the owner's own handles for the slices it has not been asked for yet.
      // Publishing them as an actionable next-window request is what lets a later maintenance build
      // enumerate beyond this window instead of stopping at it.
      const nextWindow = !inventorySet ? null : (() => {
        const cursors = inventorySet.merged.ownerCursors || [];
        const canonicalCursor = cursors.find(region => region.family === 'canonical')?.cursor || '';
        const microCursor = cursors.find(region => region.family === 'micro')?.cursor || '';
        if (!canonicalCursor && !microCursor) return null;
        // The generation hash does not exist until the manifest is serialized, so the stored handle
        // carries no generation at all; the reader and the build result add the published one.
        return Object.freeze({
          schema: 'libra.graph_next_window.v1', canonicalCursor, microCursor,
          families: Object.freeze(cursors.map(region => region.family)),
          reason: 'owner_reported_unread'
        });
      })();
      const inventoryDelta = !inventory || !inventorySet ? { deltas: [], basis: 'inventory_disabled' } : await (async () => {
        const base = baseManifest || (!previous?.value?.manifestKey ? null
          : (await load(owner, previous.value.manifestKey, 131072, loc.partition, stamp, ticket)).value);
        if (!base) return { deltas: [], basis: 'no_previous_generation' };
        const published = base.sourceInventory;
        if (!published) return { deltas: [], basis: 'previous_generation_without_inventory' };
        // A generation published for another source window is still a base — the whole point of the
        // unread cursor is that the next window continues where the previous one stopped — but every
        // disappearance across windows is then reported as outside the window, never as a deletion.
        // Content/revision changes belong to a same-window delta. Only the requested slice and its
        // owner/view/restore frame distinguish windows, including when an explicit base was supplied.
        const windowChanged = base.policy !== policy || base.partition !== loc.partition
          || !same(base.sourceOptions, sourceOptions) || !same(base.readerFrame, after.graph.readerFrame);
        const deltas = [];
        for (const page of inventorySet.pages) {
          const before = published.pages?.find(candidate => candidate.family === page.family);
          if (!before) { deltas.push({ family: page.family, skipped: 'no_previous_family' }); continue; }
          try { deltas.push(inventory.diffInventories(before, page, { windowChanged })); }
          catch (error) { deltas.push({ family: page.family, skipped: String(error?.reason || 'delta_unavailable') }); }
        }
        return { deltas, basis: windowChanged ? 'previous_window' : 'same_window' };
      })();
      const inventoryDeltas = inventoryDelta.deltas;
      const unreadRegions = computeUnreadRegions(after.graph.coverage);
      const manifest = { schema: 'libra.graph_generation.v1', policy, sourceOptions, pageBytes,
        sourceStamp: stamp, readerFrame: after.graph.readerFrame, coverage: after.graph.coverage,
        unreadRegions, partition: loc.partition, pages: directory.refs, totals: directory.totals,
        jobToken, inventoryComplete: false, ownerAtomicity: false, modelDispatchEligible: false,
        sourceInventory: inventorySet, sourceInventoryDeltas: inventoryDeltas, sourceInventoryDeltaBasis: inventoryDelta.basis,
        // The generation hash is not known until the manifest itself is serialized; the reader fills
        // it from the published root, so the stored record must not carry a half-built handle.
        nextWindow };
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
        unreadRegions, publication: owner.publication, ownerAtomicity: false, inventoryComplete: false, modelDispatchEligible: false,
        providerCalls: 0, sourceStamp: stamp, readerValidation: final.graph.readerValidation || null,
        sourceInventory: inventorySet, sourceInventoryDeltas: inventoryDeltas, sourceInventoryDeltaBasis: inventoryDelta.basis,
        nextWindow: nextWindow ? { ...nextWindow, generation } : null };
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
      coverage: graph.coverage, unreadRegions: computeUnreadRegions(graph.coverage),
      requestLocalReadOnly: true, modelDispatchEligible: false, durableGenerationVerified: false });
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
      coverage: manifest.coverage, unreadRegions: manifest.unreadRegions || computeUnreadRegions(manifest.coverage),
      sourceInventory: manifest.sourceInventory || null, sourceInventoryDeltas: manifest.sourceInventoryDeltas || [],
      sourceInventoryDeltaBasis: manifest.sourceInventoryDeltaBasis || '',
      nextWindow: manifest.nextWindow ? { ...manifest.nextWindow, generation: root.value.generation } : null,
      rootKey: loc.rootKey,
      sourceStamp: stamp, publication: root.value.publication,
      scopeKey: graph.scopeKey, readerFrame: final.graph.readerFrame, readerValidation: final.graph.readerValidation || null,
      nativeSourceCaptureAdmission: 'unsupported',
      durableGenerationVerified: true, verificationScope: 'current_owner_projection_window_all_persisted_pages',
      inventoryComplete: false, ownerAtomicity: false, modelDispatchEligible: false,
      requestLocalReadOnly: true, byteBounded: false, ownerTransportBounded: false,
      cache: pages.inspect() };
  };
  const collectGarbage = async ({
    owner,
    scopeKey,
    dryRun = false,
    throwOnConflict = false,
    nowMs = Date.now(),
    leaseTtlMs = 60000,
    candidateKeys: requestedCandidates = null
  } = {}) => {
    if (active) fail('build_busy'); if (disposed) fail('disposed');
    if (!owner || typeof owner.listKeys !== 'function' || typeof scopeKey !== 'string' || !scopeKey) fail('options_invalid');
    if(requestedCandidates!==null&&(!Array.isArray(requestedCandidates)||requestedCandidates.length>8192||requestedCandidates.some(key=>typeof key!=='string')))fail('options_invalid');
    const selected=requestedCandidates===null?null:new Set(requestedCandidates);
    active = true; const ticket = epoch; counters.gcRuns++;
    try {
      const prefix = 'libra:v1:scope:' + scopeKey + ':memory-graph:v1:';
      const corpusPrefix = prefix + 'corpus:';
      const repPrefix = 'libra:v1:scope:' + scopeKey + ':representations:v1:';
      const part = JSON.stringify({ owner: 'gc', scopeKey, viewer: 'maintenance_gc' });
      const stamp = hash(prefix + ':' + ticket);
      check(ticket, owner);

      const inventory = typeof owner.captureGCInventory === 'function' ? await owner.captureGCInventory(prefix) : null;
      if (!inventory || inventory.complete !== true || !Array.isArray(inventory.keys)) {
        return {
          schema: 'libra.graph_store_gc.v1',
          status: 'blocked_incomplete_inventory',
          scopeKey,
          dryRun: Boolean(dryRun),
          activeRoots: null,
          candidateKeys: [],
          deletedKeys: []
        };
      }

      // A real owner can mark and re-check reachability inside its own writer
      // transaction. Its fence excludes concurrent readers and publishers.
      if(inventory.fence?.schema==='libra.graph_namespace_fence.v1'&&Array.isArray(inventory.retainedKeys)){
        const retained=new Set(inventory.retainedKeys),candidateKeys=inventory.keys.filter(key=>key.startsWith(prefix)&&(!selected||selected.has(key))&&!retained.has(key)&&
          /^(?:generation:|page:|corpus:(?:manifest:|page:|proof:|projection:|checkpoint:|semantic-directory:|vector:)|semantic:(?:page:|manifest:))/.test(key.slice(prefix.length)));
        const deletedKeys=[];let status='completed';
        if(!dryRun&&typeof owner.deleteConditional!=='function')status='blocked_atomic_gc_unavailable';
        else if(!dryRun)for(const key of candidateKeys){check(ticket,owner);if(!await owner.deleteConditional({key,inventory,fence:inventory.fence})){status='aborted_concurrent_mutation';break;}deletedKeys.push(key);counters.gcDeleted++;}
        return {schema:'libra.graph_store_gc.v1',status,scopeKey,dryRun:Boolean(dryRun),candidateKeys,deletedKeys,
          activeRoots:inventory.keys.filter(key=>key.startsWith(prefix+'root:')).length,
          activeCorpusRoots:inventory.keys.filter(key=>key.startsWith(corpusPrefix+'root:')).length,
          retainedManifestCount:[...retained].filter(key=>key.startsWith(prefix+'generation:')||key.startsWith(corpusPrefix+'manifest:')).length,
          retainedPageCount:[...retained].filter(key=>key.startsWith(prefix+'page:')||key.startsWith(corpusPrefix+'page:')||key.startsWith(corpusPrefix+'vector:')).length,
          retainedCorpusKeyCount:[...retained].filter(key=>key.startsWith(corpusPrefix)).length,
          protectedBuildCount:0,protectedReaderCount:0,
          corpusReclamation:'owner_atomic_reachability',representationReclamation:'derived_pages_only',retainedKeyCount:retained.size};
      }

      // 1. Partition keys across window graph, corpus, and representations
      const allKeys = inventory.keys.filter(k => typeof k === 'string' && k.startsWith(prefix));
      const windowRootKeys = allKeys.filter(k => k.startsWith(prefix + 'root:') && !k.startsWith(corpusPrefix)).sort((a, b) => a.localeCompare(b, 'en'));
      const corpusRootKeys = allKeys.filter(k => k.startsWith(corpusPrefix + 'root:')).sort((a, b) => a.localeCompare(b, 'en'));
      const allRootKeys = [...windowRootKeys, ...corpusRootKeys];

      const rootPin = typeof owner.capture === 'function' ? await owner.capture(allRootKeys) : null;
      const rootRawByKey = new Map();
      const corpusRootRawByKey = new Map();
      const retainedManifests = new Set();
      const retainedPages = new Set();
      const retainedCorpusKeys = new Set();
      const retainedRepKeys = new Set();

      // 2. Mark Window Graph Roots -> Generations -> Pages
      for (const rootKey of windowRootKeys) {
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

      // 3. Mark Corpus Roots & Checkpoints (N05 multi-tier reachability)
      for (const corpusRootKey of corpusRootKeys) {
        const cRoot = await load(owner, corpusRootKey, 32768, part, stamp, ticket);
        corpusRootRawByKey.set(corpusRootKey, cRoot.raw);
        if (cRoot.raw === null) continue;
        retainedCorpusKeys.add(corpusRootKey);
        if (cRoot.value && typeof cRoot.value.manifestKey === 'string') {
          retainedCorpusKeys.add(cRoot.value.manifestKey);
        }
      }

      for (const k of allKeys) {
        // Corpus checkpoints contain windowSlices and may exceed this store's
        // decode allowance. Until corpus reclamation has its own schema-aware
        // owner fence, retain the entire namespace without decoding its bodies.
        if (k.startsWith(corpusPrefix)) {
          retainedCorpusKeys.add(k);
        } else if (k.startsWith(repPrefix)) {
          retainedRepKeys.add(k);
        }
      }

      // 4. In-progress build protection & Reader lease protection (N05)
      const fenceObj = typeof inventory.fence === 'object' && inventory.fence !== null
        ? inventory.fence
        : { fenceId: String(inventory.fence || ''), epoch: 0 };

      const activeBuilds = Array.isArray(fenceObj.activeBuilds)
        ? fenceObj.activeBuilds
        : (typeof owner.getActiveBuilds === 'function' ? await owner.getActiveBuilds(prefix) : []);

      const activeReaders = Array.isArray(fenceObj.activeReaders)
        ? fenceObj.activeReaders
        : (typeof owner.getActiveReaders === 'function' ? await owner.getActiveReaders(prefix) : []);

      const protectedBuildKeys = new Set();
      let protectedBuildCount = 0;
      for (const b of activeBuilds) {
        const exp = Number.isSafeInteger(b?.expiresAtMs)
          ? b.expiresAtMs
          : (Number.isSafeInteger(b?.startedAtMs) ? b.startedAtMs + leaseTtlMs : Infinity);
        if (exp > nowMs && !b?.cancelled) {
          protectedBuildCount++;
          for (const k of b.workingKeys || []) protectedBuildKeys.add(k);
          if (b.manifestKey) protectedBuildKeys.add(b.manifestKey);
          if (b.generationKey) protectedBuildKeys.add(b.generationKey);
        }
      }

      const protectedReaderKeys = new Set();
      let protectedReaderCount = 0;
      for (const r of activeReaders) {
        const exp = Number.isSafeInteger(r?.expiresAtMs)
          ? r.expiresAtMs
          : (Number.isSafeInteger(r?.acquiredAtMs) ? r.acquiredAtMs + leaseTtlMs : Infinity);
        if (exp > nowMs && !r?.released) {
          protectedReaderCount++;
          if (r.generationKey) protectedReaderKeys.add(r.generationKey);
          for (const k of r.pageKeys || []) protectedReaderKeys.add(k);
        }
      }

      const extraProtected = typeof owner.getProtectedKeys === 'function'
        ? new Set(await owner.getProtectedKeys(prefix))
        : new Set();

      const protectedKeys = new Set([
        ...protectedBuildKeys,
        ...protectedReaderKeys,
        ...retainedCorpusKeys,
        ...retainedRepKeys,
        ...extraProtected
      ]);

      const verifyRootsUnchanged = async () => {
        check(ticket, owner);
        if (rootPin && typeof owner.assertCaptured === 'function') {
          await owner.assertCaptured(rootPin);
        }
        if (typeof owner.assertNamespaceFence === 'function') {
          await owner.assertNamespaceFence(inventory.fence);
        }
        const currentKeys = (await owner.listKeys(prefix)).filter(k => typeof k === 'string' && k.startsWith(prefix));
        const currentWindowRootKeys = currentKeys.filter(k => k.startsWith(prefix + 'root:') && !k.startsWith(corpusPrefix)).sort((a, b) => a.localeCompare(b, 'en'));
        if (!same(currentWindowRootKeys, windowRootKeys)) fail('gc_concurrent_root_change');
        for (const rootKey of windowRootKeys) {
          const latest = await load(owner, rootKey, 32768, part, stamp, ticket);
          if (latest.raw !== rootRawByKey.get(rootKey)) fail('gc_concurrent_root_change');
        }
        const currentCorpusRootKeys = currentKeys.filter(k => k.startsWith(corpusPrefix + 'root:')).sort((a, b) => a.localeCompare(b, 'en'));
        if (!same(currentCorpusRootKeys, corpusRootKeys)) fail('gc_concurrent_root_change');
        for (const corpusRootKey of corpusRootKeys) {
          const latest = await load(owner, corpusRootKey, 32768, part, stamp, ticket);
          if (latest.raw !== corpusRootRawByKey.get(corpusRootKey)) fail('gc_concurrent_root_change');
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
          activeRoots: windowRootKeys.length,
          retainedManifestCount: retainedManifests.size,
          retainedPageCount: retainedPages.size,
          candidateKeys: [],
          deletedKeys: []
        };
      }

      const initialKeySet = new Set(allKeys);
      const candidates = postMarkKeys.filter(k => (!selected||selected.has(k)) && initialKeySet.has(k) && !protectedKeys.has(k) && (
        (k.startsWith(prefix + 'generation:') && !retainedManifests.has(k))
        || (k.startsWith(prefix + 'page:') && !retainedPages.has(k))
      )).sort((a, b) => a.localeCompare(b, 'en'));

      const deleted = [];
      let status = 'completed';
      // The owner must atomically fence the entire namespace (new roots, pending
      // publishers and pinned readers) together with this candidate's deletion.
      // A last-second read or per-root CAS alone cannot provide that guarantee.
      if (!dryRun && (typeof owner.deleteConditional !== 'function' || !inventory.fence)) {
        status = 'blocked_atomic_gc_unavailable';
      } else if (!dryRun) {
        for (const candidateKey of candidates) {
          try {
            await verifyRootsUnchanged();
          } catch (err) {
            if (throwOnConflict) throw err;
            status = 'aborted_concurrent_mutation';
            break;
          }
          const expectedRaw = await owner.read(candidateKey);
          const removed = await owner.deleteConditional({
            key: candidateKey,
            expectedRaw,
            prefix,
            inventory,
            roots: [...rootRawByKey].map(([key, raw]) => ({ key, raw })),
            corpusRoots: [...corpusRootRawByKey].map(([key, raw]) => ({ key, raw })),
            protectedKeys: Array.from(protectedKeys),
            fence: inventory.fence
          });
          check(ticket, owner);
          if (removed !== true) { status = 'aborted_concurrent_mutation'; break; }
          deleted.push(candidateKey);
          counters.gcDeleted++;
        }
      }
      return {
        schema: 'libra.graph_store_gc.v1',
        status,
        scopeKey,
        dryRun: Boolean(dryRun),
        activeRoots: windowRootKeys.length,
        activeCorpusRoots: corpusRootKeys.length,
        retainedManifestCount: retainedManifests.size,
        retainedPageCount: retainedPages.size,
        retainedCorpusKeyCount: retainedCorpusKeys.size,
        corpusReclamation: 'conservative_namespace_retention',
        representationReclamation: 'unimplemented',
        protectedBuildCount,
        protectedReaderCount,
        candidateKeys: candidates,
        deletedKeys: deleted
      };
    } finally { active = false; }
  };
  return Object.freeze({
    build,
    read,
    collectGarbage,
    location,
    inspect: () => ({
      schema: 'libra.graph_store.v1',
      activeBuild: active,
      invalidationEpoch: epoch,
      counters: { ...counters },
      durableStoreImplemented: true,
      exhaustiveOwnerInventory: false,
      rootGCImplemented: true,
      gcDeletionRequirement: 'complete_durable_inventory_and_atomic_namespace_fence_for_publishers_and_readers',
      gcLifecycleProtection: Object.freeze({
        multiTierReachability: Object.freeze(['window_graph', 'corpus', 'checkpoint', 'representation']),
        inProgressBuildProtection: true,
        readerLeaseProtection: true,
        leaseExpirationSupported: true
      }),
      ownerTransportBounded: false
    }),
    invalidate() { epoch++; },
    dispose() { epoch++; disposed = true; }
  });
};
