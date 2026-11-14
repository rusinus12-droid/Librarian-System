    function residentMemoryBudgetSnapshot() {
      const pairBytes = Math.max(0, Number(state.pairRevisionCacheStats?.retainedChars || 0) * 2);
      const verifiedBytes = Math.max(0, Number(state.verifiedReadCacheStats?.bytes || 0));
      return {
        maxBytes: LIBRA_RESIDENT_MEMORY_MAX_BYTES,
        totalBytes: pairBytes + verifiedBytes,
        byCache: { pairRevision: pairBytes, verifiedRead: verifiedBytes }
      };
    }
    function evictOldestVerifiedRead() {
      let key = null, order = Infinity;
      for (const [candidate, row] of verifiedReadCache) {
        if (Number(row?.residentOrder || 0) < order) { key = candidate; order = Number(row?.residentOrder || 0); }
      }
      if (key == null) return false;
      deleteVerifiedRead(key);
      state.residentBudgetStats.evictions += 1;
      state.residentBudgetStats.lastEvictionOwner = 'verifiedRead';
      state.residentBudgetStats.lastEvictionAt = Date.now();
      return true;
    }
    function evictOldestPairRevision() {
      let target = null, key = null, order = Infinity;
      for (const cache of state.pairRevisionCaches.values()) for (const [candidate, row] of cache.entries || []) {
        if (Number(row?.residentOrder || 0) < order) { target = cache; key = candidate; order = Number(row?.residentOrder || 0); }
      }
      if (!target) return false;
      const entry = target.entries.get(key);
      target.entries.delete(key);
      const chars = Math.max(0, Number(entry?.retainedChars || 0) || 0);
      target.retainedChars = Math.max(0, target.retainedChars - chars);
      state.pairRevisionCacheStats.retainedChars = Math.max(0, Number(state.pairRevisionCacheStats.retainedChars || 0) - chars);
      state.pairRevisionCacheStats.evictions += 1;
      state.residentBudgetStats.evictions += 1;
      state.residentBudgetStats.lastEvictionOwner = 'pairRevision';
      state.residentBudgetStats.lastEvictionAt = Date.now();
      return true;
    }
    function ensureResidentBudget(requiredBytes, protectedOwner = '') {
      const required = Math.max(0, Number(requiredBytes) || 0);
      while (residentMemoryBudgetSnapshot().totalBytes + required > LIBRA_RESIDENT_MEMORY_MAX_BYTES) {
        if (protectedOwner !== 'verifiedRead' && evictOldestVerifiedRead()) continue;
        if (protectedOwner !== 'pairRevision' && evictOldestPairRevision()) continue;
        if (protectedOwner === 'verifiedRead' && evictOldestVerifiedRead()) continue;
        if (protectedOwner === 'pairRevision' && evictOldestPairRevision()) continue;
        throw new Error('LIBRA_RESIDENT_MEMORY_LIMIT');
      }
      return true;
    }
    // State-first owner adapter. Uses existing native records and consumer proofs.
    const stateMemoryFingerprint = createLibraMemoryFingerprint();
    let stateMemoryRuntime = null;
    // One query reads the same heads and receipts many times. A background read frame
    // shares those bytes and checks every consumed key once, in batches, before the
    // result leaves. A frame that saw a change is dropped and the proof runs unshared.
    const stateReadFrames = new WeakMap(), stateDeferredProofs = new WeakSet();
    const closeStateReadFrame = context => {
      const frame = stateReadFrames.get(context);
      if (frame) { stateReadFrames.delete(context); frame.close(); }
    };
    const STATE_FRAME_CHANGED = /LIBRA_MEMORY_READER_(?:BODY|ROUTE)_CHANGED|LIBRA_BACKGROUND_SETTINGS_CHANGED|LIBRA_VERIFIED_STORAGE_UNBOUND_REUSE/;
    // Search text per Micro turn, taken from the projection each Micro head already stores.
    // It only chooses which turns to read; delivered rows always come from the verified read.
    const STATE_MICRO_INDEX_SCOPES = 4, STATE_MICRO_INDEX_TURNS = 4096, STATE_MICRO_INDEX_SCAN_TURNS = 512;
    const STATE_MICRO_INDEX_TEXT_CHARS = 1200, STATE_MICRO_INDEX_ABSENT_RECHECK_MS = 30000;
    const stateMicroIndexes = new Map();
    const invalidateStateMicroIndex = (scopeKey, turn = null) => {
      for (const [cacheKey, cache] of stateMicroIndexes) {
        if (!cacheKey.startsWith(string(scopeKey) + '\u0000')) continue;
        if (turn == null) stateMicroIndexes.delete(cacheKey); else cache.turns.delete(Number(turn));
      }
    };
    const STATE_SEMANTIC_VECTOR_LIMIT = 128;
    const STATE_SEMANTIC_VECTOR_BYTES = 8 * 1024 * 1024;
    const STATE_SEMANTIC_DEADLINE_MS = 2500;
    // State row vectors, one store per chat. The runtime asks for them only when the State is
    // large enough that its anchor selection has to choose. Entries are keyed by a hash of the
    // row text, so an unchanged row keeps its vector across Head revisions and only changed
    // rows are embedded. A vector is a ranking hint; it never adds, changes or confirms a row.
    const STATE_VECTOR_STORE_SCHEMA = 'libra.state_vector_store.v1', STATE_VECTOR_PAGE_SCHEMA = 'libra.state_vector_page.v1';
    const STATE_VECTOR_MAX_ENTRIES = 2000, STATE_VECTOR_BATCH = 32, STATE_VECTOR_PAGE_BYTES = 192 * 1024;
    const STATE_VECTOR_MAX_PAGES = 32, STATE_VECTOR_RETRY_MS = 60000;
    const stateVectorKey = scope => `${PREFIX}:scope:${scope.scopeKey}:state-vector:v1`;
    const stateVectorHash = text => digest(string(text).trim()).slice(0, 24);
    const loadStateVectorStore = async (scope, readFrame = null) => {
      const empty = { profileId: '', dimensions: 0, entries: {}, pages: [] };
      const index = await storage.getVerifiedJson(stateVectorKey(scope), scope, null).catch(() => null);
      if (index?.schema !== STATE_VECTOR_STORE_SCHEMA || index.scopeKey !== scope.scopeKey || !string(index.profileId)
        || !Number.isInteger(index.dimensions) || index.dimensions < 1 || index.dimensions > 65536
        || !Array.isArray(index.pages) || index.pages.length > STATE_VECTOR_MAX_PAGES * 2) return empty;
      const refs = index.pages.filter(ref => /^[a-zA-Z0-9_.:-]{1,128}$/.test(ref?.id || ''));
      const keys = refs.map(ref => `${stateVectorKey(scope)}:page:${ref.id}`);
      // One request when the caller owns a read frame for this scope.
      if (readFrame) { try { await readFrame.prefetch(keys); } catch (_) { /* Each read below reports itself. */ } }
      const loaded = await Promise.all(refs.map(async (ref, index_) => {
        try {
          const page = await storage.getVerifiedJson(keys[index_], scope, null);
          if (page?.schema !== STATE_VECTOR_PAGE_SCHEMA || page.scopeKey !== scope.scopeKey || page.profileId !== index.profileId
            || page.dimensions !== index.dimensions || !isPlainObject(page.entries) || digest(page) !== ref.id
            || Object.keys(page.entries).length !== Number(ref.count)) return null;
          return { ref, page };
        } catch (_) { return null; }
      }));
      const entries = {}, pages = [];
      for (const row of loaded) {
        if (!row || Object.keys(entries).length + row.ref.count > STATE_VECTOR_MAX_ENTRIES) continue;
        Object.assign(entries, row.page.entries); pages.push(row.ref);
      }
      return { profileId: string(index.profileId), dimensions: index.dimensions, entries, pages };
    };
    // Immutable byte-bounded pages are written before the index that names them.
    const writeStateVectorPages = async (scope, profileId, dimensions, rows) => {
      const envelope = { schema: STATE_VECTOR_PAGE_SCHEMA, scopeKey: scope.scopeKey, profileId, dimensions, entries: {} };
      const overhead = MemorySuiteExecutionContract.utf8Bytes(JSON.stringify(envelope)), refs = [];
      let entries = {}, bytes = overhead, count = 0;
      const flush = async () => {
        if (!count) return;
        const page = { ...envelope, entries }, ref = { id: digest(page), count };
        await storage.setVerifiedJson(`${stateVectorKey(scope)}:page:${ref.id}`, page, scope);
        refs.push(ref); entries = {}; bytes = overhead; count = 0;
      };
      for (const [hash, entry] of Object.entries(rows)) {
        const cost = MemorySuiteExecutionContract.utf8Bytes(JSON.stringify(hash)) + 1 + MemorySuiteExecutionContract.utf8Bytes(JSON.stringify(entry)) + 1;
        if (count && bytes + cost > STATE_VECTOR_PAGE_BYTES) await flush();
        entries[hash] = entry; bytes += cost; count += 1;
      }
      await flush();
      return refs;
    };
    // Embeds the given State row texts that have no vector in the current embedding profile and
    // drops vectors of rows that are gone. Runs in the background; recall uses what is stored.
    const refreshStateVectors = async (scope, texts) => {
      const embedding = await lensEmbeddingConfig();
      if (!embedding) return { ok: false, reason: 'embedding_disabled' };
      const wanted = new Map();
      for (const value of asArray(texts)) {
        const text = string(value).trim();
        if (text && wanted.size < STATE_VECTOR_MAX_ENTRIES) wanted.set(stateVectorHash(text), text);
      }
      const store = await loadStateVectorStore(scope);
      const configured = store.dimensions > 0 ? lensResultProfile(embedding, null, store.dimensions) : '';
      let profileId = configured && configured === store.profileId ? store.profileId : '';
      let dimensions = profileId ? store.dimensions : 0;
      let entries = profileId ? Object.fromEntries(Object.entries(store.entries).filter(([hash]) => wanted.has(hash))) : {};
      const stale = profileId ? Object.keys(store.entries).length - Object.keys(entries).length : 0;
      // Rewrite every page when gone rows dominate or pages pile up; otherwise only append.
      let repack = !profileId || stale > Object.keys(entries).length || store.pages.length >= STATE_VECTOR_MAX_PAGES;
      const missing = [...wanted].filter(([hash]) => !entries[hash]);
      let added = {}, embedded = 0;
      for (let offset = 0; offset < missing.length; offset += STATE_VECTOR_BATCH) {
        const batch = missing.slice(offset, offset + STATE_VECTOR_BATCH);
        const result = await trackEmbeddingWork('state', batch.length, () => EmbeddingProviderRegistry.embedTexts(embedding.config,
          batch.map(([, text]) => text), { purpose: 'document', maxRequests: 4 }), scope.scopeKey);
        const resultProfile = lensResultProfile(embedding, result, asArray(result?.vectors?.[0]).length);
        if (!resultProfile) return { ok: false, reason: 'embedding_profile_unknown', embedded };
        if (resultProfile !== profileId) {
          if (embedded) return { ok: false, reason: 'embedding_profile_changed', embedded };
          // First answer in another space: every stored vector belongs to another profile.
          profileId = resultProfile; entries = {}; added = {}; dimensions = 0; repack = true;
        }
        batch.forEach(([hash], index) => {
          const vector = result?.vectors?.[index];
          if (!Array.isArray(vector) || !vector.length) return;
          dimensions = vector.length; entries[hash] = lensEncodeVector(vector); added[hash] = entries[hash]; embedded += 1;
        });
      }
      if (!profileId || !dimensions) return { ok: false, reason: wanted.size ? 'nothing_embedded' : 'no_rows', embedded };
      if (!embedded && !repack) return { ok: true, embedded: 0, total: Object.keys(entries).length };
      const written = await writeStateVectorPages(scope, profileId, dimensions, repack ? entries : added);
      const pages = repack ? written : [...store.pages, ...written];
      await storage.setVerifiedJson(stateVectorKey(scope), { schema: STATE_VECTOR_STORE_SCHEMA, scopeKey: scope.scopeKey,
        profileId, dimensions, pages, updatedAt: nowIso() }, scope);
      const keep = new Set(pages.map(ref => ref.id));
      for (const ref of store.pages) if (!keep.has(ref.id)) {
        try { await storage.remove(`${stateVectorKey(scope)}:page:${ref.id}`); } catch (_) { /* An unreferenced page is ignored. */ }
      }
      return { ok: true, embedded, total: Object.keys(entries).length };
    };
    const stateVectorRefreshes = new Map(), stateVectorRefreshFailedAt = new Map();
    const scheduleStateVectorRefresh = (scope, texts) => {
      const scopeKey = string(scope?.scopeKey);
      if (!scopeKey) return Promise.resolve({ ok: false, reason: 'scope_missing' });
      if (stateVectorRefreshes.has(scopeKey)) return stateVectorRefreshes.get(scopeKey);
      if (Date.now() - Number(stateVectorRefreshFailedAt.get(scopeKey) || 0) < STATE_VECTOR_RETRY_MS) return Promise.resolve({ ok: false, reason: 'retry_cooldown' });
      const job = refreshStateVectors({ ...scope }, texts).catch(error => ({ ok: false, reason: string(error?.message || error) }))
        .then(result => {
          if (result?.ok || ['embedding_disabled', 'no_rows'].includes(result?.reason)) stateVectorRefreshFailedAt.delete(scopeKey);
          else stateVectorRefreshFailedAt.set(scopeKey, Date.now());
          return result;
        })
        .finally(() => stateVectorRefreshes.delete(scopeKey));
      stateVectorRefreshes.set(scopeKey, job);
      return job;
    };
    // Production runs after the State changes, never on the recall path: the response State
    // (stored Head plus approved Micro projections) is turned into rows, and a State at least
    // as large as the runtime's STATE_SEMANTIC_MIN_ROWS (24) gets its changed rows embedded.
    const STATE_VECTOR_MIN_ROWS = 24;
    let stateVectorRowEngine = null;
    const refreshStateVectorsForContext = async context => {
      if (!await lensEmbeddingConfig()) return { ok: false, reason: 'embedding_disabled' };
      const scope = context.scope, pairs = buildPairs(context.chat, scope.scopeKey);
      const manifest = await loadManifest(scope, pairs.length);
      const projected = await loadContinuityStateForResponse(scope, manifest, { context });
      stateVectorRowEngine ||= createLibraStateMemoryEngine({ fingerprint: stateMemoryFingerprint, tokenizer: tokenStream });
      const texts = [...new Set(stateVectorRowEngine.stateRows(projected?.head || null).map(row => string(row.text).trim()).filter(Boolean))];
      if (texts.length < STATE_VECTOR_MIN_ROWS) return { ok: true, skipped: 'small_state', rows: texts.length };
      return await scheduleStateVectorRefresh(scope, texts);
    };
    // The query may carry a second, weighted scene query. Both vectors are compared in the same
    // single scan of the stored document vectors, so the scene lane adds no storage reads.
    const readStateSemanticCandidates = async (context, source, queryInput) => {
      const lanes = queryInput && typeof queryInput === 'object' ? queryInput : { text: queryInput };
      const queryText = string(lanes.text || '');
      const sceneText = string(lanes.sceneText || '');
      const sceneWeight = Math.max(0, Math.min(1, Number(lanes.sceneWeight) || 0));
      const stateTexts = [...new Set(asArray(lanes.stateTexts).map(value => string(value).trim()).filter(Boolean))];
      const diagnostics = { status: 'off', queryCached: false, queryRequests: 0, scanned: 0, matched: 0,
        missing: 0, incompatible: 0, failedReads: 0, limited: false, profileId: '',
        sceneQuery: sceneText && sceneWeight > 0 ? 'pending' : 'off' };
      if (stateTexts.length) diagnostics.stateVectors = { rows: stateTexts.length, scored: 0, missing: 0, status: 'off' };
      const empty = () => ({ scores: new Map(), sceneScores: new Map(), stateScores: new Map(), matches: new Map(), diagnostics });
      if (!source.semanticAllowed) return empty();
      const config = normalizeEmbeddingSettings((await LibraProviderBridge.getConfig())?.embed || DEFAULT_EMBEDDING);
      if (!config.enabled) { diagnostics.status = 'disabled'; return empty(); }
      if (!(await LibraProviderBridge.validateEmbedding(config)).ok) { diagnostics.status = 'unconfigured'; return empty(); }
      // The manifest already identifies ready document vectors. No canonical-body scan or
      // namespace enumeration, and no embedding/rebuild job, is required for this lane.
      const ready = source.refs.filter(ref => ref.embeddingStatus === 'ready' && /:memory:/.test(ref.key));
      if (!ready.length && !stateTexts.length) { diagnostics.status = 'no_vectors'; return empty(); }
      const refs = ready.slice().sort((a,b) => Number(b.turnRange?.end || 0) - Number(a.turnRange?.end || 0)).slice(0, STATE_SEMANTIC_VECTOR_LIMIT);
      diagnostics.limited = refs.length < ready.length;
      diagnostics.total = ready.length;
      const controller = new AbortController();
      let readFrame = null, timer;
      const operation = async () => {
        const [query, sceneVector] = await Promise.all([
          memoryRecallQueryVector(context.scope, queryText, { config }, STATE_SEMANTIC_DEADLINE_MS),
          diagnostics.sceneQuery === 'pending'
            ? memoryRecallQueryVector(context.scope, sceneText, { config }, STATE_SEMANTIC_DEADLINE_MS).catch(() => null) : null
        ]);
        if (controller.signal.aborted) throw Error('LIBRA_SEMANTIC_TIMEOUT');
        if (!query) throw Error('LIBRA_SEMANTIC_QUERY_INVALID');
        diagnostics.profileId = query.profileId; diagnostics.queryCached = query.cached; diagnostics.queryRequests = query.requests;
        // A scene vector from another profile or dimension is not comparable; the scene lane is then off.
        const scene = sceneVector && sceneVector.profileId === query.profileId && sceneVector.unit?.length === query.unit.length ? sceneVector : null;
        if (diagnostics.sceneQuery === 'pending') {
          diagnostics.sceneQuery = scene ? 'ready' : 'unavailable';
          diagnostics.queryRequests += Number(scene?.requests || 0);
        }
        const denseScore = cosine => cosine !== null && cosine >= 0.42 && cosine <= 1.00001 ? Math.min(1, (cosine - 0.42) / 0.18) : 0;
        const scanScope = { ...context.scope };
        readFrame = await openNativeReadFrame(scanScope);
        if (controller.signal.aborted) { readFrame.close(); throw Error('LIBRA_SEMANTIC_TIMEOUT'); }
        const matches = new Map(), scores = new Map(), sceneScores = new Map(), stateScores = new Map(); let bytes = 0;
        if (stateTexts.length) {
          // The State store is read through the same frame. A row without a vector in this
          // profile simply has no dense score.
          const stateDiagnostics = diagnostics.stateVectors;
          const store = await loadStateVectorStore(scanScope, readFrame);
          if (controller.signal.aborted) throw Error('LIBRA_SEMANTIC_TIMEOUT');
          const comparable = store.profileId === query.profileId && store.dimensions === query.unit.length;
          for (const text of stateTexts) {
            const entry = comparable ? store.entries[stateVectorHash(text)] : null;
            const vector = entry ? lensDecodeVector(entry) : null;
            if (!vector || vector.length !== query.unit.length) { stateDiagnostics.missing++; continue; }
            const score = Math.max(denseScore(lensCosine(query.unit, vector)),
              scene ? sceneWeight * denseScore(lensCosine(scene.unit, vector)) : 0);
            if (score > 0) { stateScores.set(text, score); stateDiagnostics.scored++; }
          }
          // Recall only reads; missing rows are embedded after the next State change.
          stateDiagnostics.status = comparable ? 'ready' : store.profileId ? 'profile_mismatch' : 'no_vectors';
        }
        for (let offset = 0; offset < refs.length; offset += 16) {
          if (controller.signal.aborted) throw Error('LIBRA_SEMANTIC_TIMEOUT');
          const part = refs.slice(offset, offset + 16).map(ref => ({ ref,
            key: ref.key.slice(0, ref.key.lastIndexOf(':memory:')) + `:vector:${ref.memoryId}:r${ref.revision}:${query.profileId}` }));
          await readFrame.prefetch(part.map(row => row.key));
          if (controller.signal.aborted) throw Error('LIBRA_SEMANTIC_TIMEOUT');
          const loaded = await Promise.all(part.map(async row => {
            try {
              const stored = await storage.getVerifiedJson(row.key, scanScope, null);
              return { ...row, stored, record: await hydrateProjectionFromLocalStorage(stored) };
            }
            catch (_) { diagnostics.failedReads++; return { ...row, record: null }; }
          }));
          if (controller.signal.aborted) throw Error('LIBRA_SEMANTIC_TIMEOUT');
          for (const { ref, key: vectorKey, record, stored } of loaded) {
            diagnostics.scanned++;
            if (!record) { diagnostics.missing++; continue; }
            bytes += JSON.stringify(record).length * 2;
            if (bytes > STATE_SEMANTIC_VECTOR_BYTES) { diagnostics.limited = true; break; }
            if (record.memoryId !== ref.memoryId || Number(record.revision) !== Number(ref.revision)
              || !vectorKey.startsWith(`${PREFIX}:scope:${record.scopeKey}:vector:`)
              || record.profileId !== query.profileId || !vectorEmbeddingSpaceCompatibility(record, config).compatible) {
              diagnostics.incompatible++; continue;
            }
            const entries = []; let bestScene = 0;
            for (const [section, entry] of Object.entries(normalizeProjectionEntries(record))) {
              const vector = entry?.vector;
              if (!Array.isArray(vector) || vector.length !== query.unit.length || vector.some(x => typeof x !== 'number' || !Number.isFinite(x))) continue;
              // A positive dense signal is a ranking hint, never a new fact or a source proof.
              // The current input leads; the scene contributes only up to its weight.
              const current = denseScore(lensCosine(query.unit, vector));
              const sceneScore = scene ? denseScore(lensCosine(scene.unit, vector)) : 0;
              bestScene = Math.max(bestScene, sceneScore);
              const score = Math.max(current, sceneWeight * sceneScore);
              if (score > 0 && entry.textHash) entries.push({ section, textHash: entry.textHash, score });
            }
            if (bestScene > 0) sceneScores.set(ref.key, bestScene);
            if (!entries.length) continue;
            scores.set(ref.key, Math.max(...entries.map(row => row.score)));
            matches.set(ref.key, { key: vectorKey, record: stored, entries });
          }
          if (bytes > STATE_SEMANTIC_VECTOR_BYTES) break;
        }
        diagnostics.status = diagnostics.failedReads ? 'partial' : 'ready'; diagnostics.matched = matches.size;
        return { matches, scores, sceneScores, stateScores, diagnostics, configDigest: digest(config) };
      };
      try {
        // The hard deadline also handles a host/provider that ignores AbortSignal. Late
        // completion cannot publish candidates or continue reading another vector batch.
        return await Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(Error('LIBRA_SEMANTIC_TIMEOUT')); }, STATE_SEMANTIC_DEADLINE_MS);
        })]);
      } catch (error) {
        diagnostics.status = controller.signal.aborted ? 'timeout' : 'failed';
        diagnostics.reason = string(error?.code || error?.message || 'embedding_unavailable');
        return empty();
      } finally { clearTimeout(timer); controller.abort(); readFrame?.close(); }
    };
    const getStateMemoryRuntime = () => {
      if (stateMemoryRuntime) return stateMemoryRuntime;
      const engine = createLibraStateMemoryEngine({ fingerprint: stateMemoryFingerprint, tokenizer: tokenStream });
      const snapshot = async (context, options = {}) => {
        const scope = context.scope, pairs = buildPairs(context.chat, scope.scopeKey);
        // The records every snapshot reads, in one request when a frame owns the scope.
        try {
          await nativeReadFrames.get(scope)?.prefetch([key.manifest(scope), key.continuityState(scope),
            key.entityRegistry(scope), key.stateWorldlineMeta(scope)]);
        } catch (_) { /* Each read below reports its own failure. */ }
        const stored = await storage.getVerifiedJson(key.manifest(scope), scope, null);
        const manifest = stored || await loadManifest(scope, pairs.length);
        const active = await readUnifiedWorldlineView(scope, manifest, pairs);
        const resolved = await resolveWorldManagerHistoryWorldline(scope);
        const rawHead = await storage.getVerifiedJson(key.continuityState(scope), scope, null);
        const cutoff = Math.min(active.cutoffTurn ?? Infinity, options.queryInput?.asOfTurn ?? Infinity);
        // A current Head cannot answer an earlier cutoff. The native response
        // reader handles active worldline cutoffs and approved Micro projections.
        const projected = Number.isFinite(cutoff) && cutoff < pairs.length ? null
          : await loadContinuityStateForResponse(scope, active.manifest, { context });
        let head = projected?.head || null;
        const stateAuthority = projected?.authority || null;
        const stateProofs = asArray(consumedMicroProofsByState.get(projected?.authority || projected?.head)).slice();
        const refs = canonicalReaderRefs(active.manifest, resolved).filter(ref => Number(ref.turnRange?.end || 0) <= cutoff || ref.inheritedSessionHistory);
        const turns = active.pairs.map(pair => Number(pair.turn)).filter(turn => turn <= cutoff);
        const mode = await MemorySuiteStorageBridge.getScopeMode(scope);
        const route = [mode?.mode || 'plugin_only', mode?.mode === 'plugin_only' ? null : await MemorySuiteStorageBridge.captureServerBinding()];
        const review = await readMemoryReviewPolicy(scope, resolved.worldlineId);
        // The native response reader already applies per-assertion review
        // decisions. Do not prune an entire memory again for one rejected fact.
        const identity = stateMemoryFingerprint(JSON.stringify([scope, resolved.worldlineId, Number(state.microRestoreGeneration || 0), route,
          pairs.map(pair => [pair.turn, completedTurnRevisionId(pair), sourceDigest([pair])]),
          refs.map(ref => [canonicalReaderRefIdentity(ref), ref.summary, ref.searchText, ref.searchTerms, ref.recallTerms, ref.title]), rawHead, head, stateAuthority, stateProofs, review.saved]));
        return { manifest: active.manifest, head, refs, turns, pairs: active.pairs, worldlineId: resolved.worldlineId, identity, owner: 'libra:' + route[0],
          rawHead, stateAuthority, stateProofs, stateKey: key.continuityState(scope), settings: await loadMemorySettings(), review, cutoff,
          semanticAllowed: options.semantic !== false };
      };
      const capture = createLibraStateMemoryCapture({
        async context(options = {}) {
          const resolved = await resolveContext(), context = { ...resolved, scope: { ...resolved.scope } };
          stateReadFrames.set(context, await openBackgroundReadFrame(context.scope));
          if (options?.deferFrameProof === true) stateDeferredProofs.add(context);
          return context;
        },
        async settle(context) {
          const frame = stateReadFrames.get(context);
          if (!frame) return true;
          // The caller proves the selection again before delivery, in a frame of its own.
          if (stateDeferredProofs.has(context)) { closeStateReadFrame(context); return 'deferred'; }
          try { await frame.assertCurrent(); return true; }
          catch (error) { if (!STATE_FRAME_CHANGED.test(string(error?.code || error?.message))) throw error; return false; }
          finally { closeStateReadFrame(context); }
        },
        abandon: closeStateReadFrame,
        async semantic(context, source, query) {
          const result = await readStateSemanticCandidates(context, source, query);
          source.semanticAttempt = result.diagnostics.status;
          return result;
        },
        async microIndex(context, source) {
          const scope = context.scope, worldline = hostWorldlineIdForScope(scope);
          const cacheKey = string(scope.scopeKey) + '\u0000' + worldline, generation = Number(state.microRestoreGeneration || 0);
          let cache = stateMicroIndexes.get(cacheKey);
          if (!cache || cache.generation !== generation) cache = { generation, turns: new Map() };
          stateMicroIndexes.delete(cacheKey); stateMicroIndexes.set(cacheKey, cache);
          while (stateMicroIndexes.size > STATE_MICRO_INDEX_SCOPES) stateMicroIndexes.delete(stateMicroIndexes.keys().next().value);
          const allowed = new Set(source.turns);
          const revisions = new Map(asArray(source.pairs).map(pair => [Number(pair.turn), completedTurnRevisionId(pair)]));
          for (const turn of [...cache.turns.keys()]) if (!revisions.has(turn)) cache.turns.delete(turn);
          const at = Date.now();
          // An entry is reused only while its turn still has the source revision it was read for.
          const pending = [...allowed].filter(turn => {
            const entry = cache.turns.get(turn);
            return !entry || entry.revision !== revisions.get(turn) || entry.text === null && at - entry.at > STATE_MICRO_INDEX_ABSENT_RECHECK_MS;
          }).sort((a, b) => b - a).slice(0, STATE_MICRO_INDEX_SCAN_TURNS);
          if (pending.length) {
            // Heads are small: one request carries 32 of them. They are hints, so this frame
            // is separate from the query's proof frame and is closed without a proof.
            const scanScope = { ...scope }, frame = await openNativeReadFrame(scanScope);
            try {
              const keys = pending.map(turn => key.microMemoryHead(scanScope, worldline, 0, turn));
              await frame.prefetch(keys);
              for (const [index, turn] of pending.entries()) {
                const head = await storage.getVerifiedJson(keys[index], scanScope, null), projection = head?.recallProjection;
                const usable = head?.schema === 'libra.micro_memory_head.v1' && Number(head.turn) === turn
                  && head.sourceRevisionId === revisions.get(turn) && projection?.schema === 'libra.micro_recall_projection.v1';
                cache.turns.set(turn, { revision: revisions.get(turn), at,
                  text: usable ? (string(projection.summary) + '\n' + string(projection.searchText)).slice(0, STATE_MICRO_INDEX_TEXT_CHARS) : null });
              }
            } finally { frame.close(); }
            while (cache.turns.size > STATE_MICRO_INDEX_TURNS) cache.turns.delete(cache.turns.keys().next().value);
          }
          const entries = new Map(); let known = 0;
          for (const turn of allowed) {
            const entry = cache.turns.get(turn);
            if (entry?.revision !== revisions.get(turn)) continue;
            known++; if (entry.text) entries.set(turn, entry.text);
          }
          return { entries, known };
        },
        fingerprint: value => stateMemoryFingerprint(JSON.stringify(value)),
        check(scope, guard) { ensureRecallGuard(guard, 'state_memory_read'); if (state.disposed || state.deletingScopes.has(scope.scopeKey)) throw Error('LIBRA_STATE_OWNER_CLOSED'); },
        snapshot,
        // Candidate bodies of this scope in one request; other scopes' refs stay single reads.
        async prepare(context, source, { refs = [] } = {}) {
          const frame = stateReadFrames.get(context);
          if (frame && !frame.disabled) await frame.prefetch(asArray(refs).map(ref => string(ref?.key || '')).filter(Boolean));
        },
        async canonical(context, ref, source, semantic) {
          const memory = await loadWorldManagerHistoryCanonicalMemory(ref, context.scope);
          if (unifiedArtifactSchemaReadable(memory.canonicalArtifact?.schema)) await unifiedEvidenceRead(memory, storageKey => storage.getStoredJson(storageKey, null, context.scope));
          const review = source.review;
          const facts = canonicalEvidenceArtifactRows(memory.canonicalArtifact);
          const rows = facts.flatMap((fact, index) => memoryReviewDecision(review, 'canonical', memory, index) === 'rejected' ? [] : [{
            domain: fact.domain, text: string(fact.text || fact.summary || fact.value || JSON.stringify(fact.values || {})),
            evidenceKeys: ['canonical:' + memory.memoryId + ':' + memory.revision + ':' + fact.assertionId]
          }]);
          const match = semantic?.matches?.get(ref.key), proofs = [getConsumedCanonicalProof(memory)].filter(Boolean);
          let assertCurrent;
          if (match && memory.embedding?.vectorKey === match.key && memory.embedding?.profileId === match.record.profileId) {
            // A stale/unusable projection cannot make an otherwise verified source unreadable.
            let projection;
            try { projection = buildMemoryRetrievalProjection(memory); } catch (_) {}
            if (projection) {
              const entries = match.entries.filter(entry => projection.textHashes[entry.section] === entry.textHash);
              for (const row of rows) {
                row.semanticScore = Math.max(0, ...entries.filter(entry => entry.section === 'global'
                  || string(projection.sections[entry.section]).includes(row.text)).map(entry => entry.score));
              }
              if (rows.some(row => row.semanticScore > 0)) {
                proofs.push(stateDecisionConsumptionProof(match.key, match.record));
                const configDigest = semantic.configDigest;
                assertCurrent = async () => {
                  const config = normalizeEmbeddingSettings((await LibraProviderBridge.getConfig())?.embed || DEFAULT_EMBEDDING);
                  if (!config.enabled || digest(config) !== configDigest) throw Error('LIBRA_SEMANTIC_CONFIG_CHANGED');
                };
              }
            }
          }
          return { rows, proofs, assertCurrent };
        },
        async micro(context, source, turn) {
          const pairs = buildPairs(context.chat, context.scope.scopeKey), worldline = hostWorldlineIdForScope(context.scope);
          // The enclosing selection validates its captured context and source proofs
          // again before delivery; avoid another host context read for every candidate.
          const active = await readActiveMicroMemory(context.scope, worldline, 0, turn, { context, pairs, skipFinalContextCheck: true });
          if (active.status !== 'verified') return null;
          const memory = microRecallMemoryFromRecord(active.record, active.receipt, active.recordKey);
          if (!memory) throw Error('LIBRA_STATE_MICRO_INVALID');
          const review = source.review;
          const rows = asArray(active.record.claims).flatMap((claim, index) => memoryReviewDecision(review, 'micro', active.record, index) === 'rejected' ? [] : [{
            text: claim.text, domain: claim.changeKind === 'relation' ? 'relationship' : ['person','character'].includes(claim.changeKind) ? 'character' : claim.changeKind === 'world' ? 'world' : 'narrative',
            evidenceKeys: ['micro:' + active.record.analysisRevisionId + ':' + digest(claim)],
            analysisStatus: active.record.analysisStatus
          }]);
          if (!rows.length && active.record.analysisStatus === 'minimum_source_bound') rows.push({ text: memory.summary, domain: 'narrative', analysisStatus: 'minimum_source_bound' });
          return { key: active.recordKey, rows, proofs: [activeMicroConsumptionProof(active)] };
        },
        async lens(context, source, query, maxCharacters) {
          const request = { scope: context.scope };
          const before = await gradiaLensReadSnapshot(request);
          const delivery = before.enabled ? await recallLensMemories(context, { currentText: query }, maxCharacters,
            { readOnly: true, refreshVectors: false, semantic: source.semanticAllowed && !['failed','timeout','unconfigured'].includes(source.semanticAttempt),
              recallMaxChars: source.settings.recallLensMaxChars,
              candidateBudgetChars: maxCharacters, asOfTurn: source.cutoff }) : null;
          const sourceKey = 'lens_selection:' + before.digest;
          return { key: sourceKey, proofs: [], delivery,
            rows: asArray(delivery?.injectedItems).map(item => ({
              text: '[PERSPECTIVE NOTES · NON-CANONICAL] ' + item.renderedLine, turn: Number(item.turnRange?.end || 0), lensItem: item
            })),
            async assertCurrent() {
              if ((await gradiaLensReadSnapshot(request)).digest !== before.digest) throw Error('LIBRA_LENS_SOURCE_CHANGED');
            } };
        },
        register(scope, proofs, source) {
          return registerConsumedDataReadSet(scope, mergeConsumedProofs(proofs, source.stateProofs,
            [stateDecisionConsumptionProof(source.stateKey, source.rawHead)]), null);
        },
        async assertCurrent(token, context, source) {
          const prove = async readScope => {
            // With a read scope, both proofs read through its frame; the frame's own
            // batched check is what makes those shared bytes current.
            const adopt = current => readScope && sameSnapshotScope(current.scope, readScope) ? { ...current, scope: readScope } : current;
            await assertConsumedDataCurrent(token, readScope ? { adoptScope: adopt } : {});
            freshReadDepth++;
            try {
              const current = adopt(await resolveContext());
              if (!sameSnapshotScope(current.scope, context.scope) || (await snapshot(current, { queryInput: { asOfTurn: source.cutoff } })).identity !== source.identity)
                throw Error('LIBRA_STATE_SOURCE_CHANGED');
            } finally { freshReadDepth--; }
          };
          const open = stateReadFrames.get(context);
          if (open) return open.disabled ? prove(null) : prove(context.scope);
          // A later delivery proof gets its own frame. If that frame saw a change, the
          // unshared proof decides, so an unrelated concurrent write cannot refuse delivery.
          const readScope = { ...context.scope }, frame = await openBackgroundReadFrame(readScope);
          try { await prove(readScope); await frame.assertCurrent({ observedIsCurrent: true }); }
          catch (error) {
            if (!STATE_FRAME_CHANGED.test(string(error?.code || error?.message))) throw error;
            frame.close(); await prove(null);
          } finally { frame.close(); }
        },
        release: releaseConsumedDataReadSet
      }, engine);
      stateMemoryRuntime = createLibraStateMemoryRuntime({ engine, capture, fingerprint: stateMemoryFingerprint, authorityStore: memoryEvidenceAuthority });
      return stateMemoryRuntime;
    };
    const executeStateMemoryQuery = async (options = {}, guard = null, issuer = null) => {
      const result = await getStateMemoryRuntime().query(options, guard, issuer);
      const semantic = result.diagnostics.semantic;
      state.lastRecallSemantic = { scopeKey: result.bundle.scopeKey, at: Date.now(), microAdmitted: 0,
        diagnostics: { ...semantic, status: semantic.status === 'ready' ? 'available' : semantic.status,
          admittedRepresentations: semantic.selected, reason: semantic.reason || semantic.status } };
      return result;
    };
    const releaseStateMemoryQuery = execution => stateMemoryRuntime?.release(execution);
    const inspectResidentMemoryBudget = () => residentMemoryBudgetSnapshot();
