    function residentMemoryBudgetSnapshot() {
      const pairBytes = Math.max(0, Number(state.pairRevisionCacheStats?.retainedChars || 0) * 2);
      const verifiedBytes = Math.max(0, Number(state.verifiedReadCacheStats?.bytes || 0));
      const linkBytes = Math.max(0, Number(state.evidenceLinkIndexCacheBytes || 0))
        + Math.max(0, Number(state.loreLinkIndexCacheBytes || 0));
      return {
        maxBytes: LIBRA_RESIDENT_MEMORY_MAX_BYTES,
        totalBytes: pairBytes + verifiedBytes + linkBytes,
        byCache: { pairRevision: pairBytes, verifiedRead: verifiedBytes, linkIndexes: linkBytes }
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
    function evictOldestLinkIndex() {
      let cache = null, key = null, order = Infinity;
      for (const candidate of [state.evidenceLinkIndexCache, state.loreLinkIndexCache]) {
        for (const [candidateKey, index] of candidate) {
          const candidateOrder = Number(index?.residentOrder || 0);
          if (candidateOrder < order) { cache = candidate; key = candidateKey; order = candidateOrder; }
        }
      }
      if (!cache) return false;
      deleteLinkIndexCache(cache, key);
      state.residentBudgetStats.evictions += 1;
      state.residentBudgetStats.lastEvictionOwner = cache === state.evidenceLinkIndexCache ? 'evidenceLink' : 'loreLink';
      state.residentBudgetStats.lastEvictionAt = Date.now();
      return true;
    }
    function ensureResidentBudget(requiredBytes, protectedOwner = '') {
      const required = Math.max(0, Number(requiredBytes) || 0);
      while (residentMemoryBudgetSnapshot().totalBytes + required > LIBRA_RESIDENT_MEMORY_MAX_BYTES) {
        if (protectedOwner !== 'verifiedRead' && evictOldestVerifiedRead()) continue;
        if (protectedOwner !== 'pairRevision' && evictOldestPairRevision()) continue;
        if (protectedOwner !== 'evidenceLink' && protectedOwner !== 'loreLink' && evictOldestLinkIndex()) continue;
        if (protectedOwner === 'verifiedRead' && evictOldestVerifiedRead()) continue;
        if (protectedOwner === 'pairRevision' && evictOldestPairRevision()) continue;
        if (protectedOwner === 'evidenceLink' && evictOldestLinkIndex()) continue;
        if (protectedOwner === 'loreLink' && evictOldestLinkIndex()) continue;
        throw new Error('LIBRA_RESIDENT_MEMORY_LIMIT');
      }
      return true;
    }
    // State-first owner adapter. Uses existing native records and consumer proofs.
    const stateMemoryFingerprint = createLibraMemoryFingerprint();
    let stateMemoryRuntime = null;
    const getStateMemoryRuntime = () => {
      if (stateMemoryRuntime) return stateMemoryRuntime;
      const engine = createLibraStateMemoryEngine({ fingerprint: stateMemoryFingerprint });
      const snapshot = async (context, options = {}) => {
        const scope = context.scope, pairs = buildPairs(context.chat, scope.scopeKey);
        const stored = await storage.getVerifiedJson(key.manifest(scope), scope, null);
        const manifest = stored || await loadManifest(scope, pairs.length);
        const active = await readUnifiedWorldlineView(scope, manifest, pairs);
        const resolved = await resolveWorldManagerHistoryWorldline(scope);
        const rawHead = await storage.getVerifiedJson(key.continuityState(scope), scope, null);
        const cutoff = Math.min(active.cutoffTurn ?? Infinity, options.queryInput?.asOfTurn ?? Infinity);
        // A current Head cannot answer an earlier cutoff. The native response
        // reader handles active worldline cutoffs and approved Micro projections.
        const projected = Number.isFinite(cutoff) && cutoff < pairs.length ? null
          : await loadContinuityStateForResponse(scope, active.manifest);
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
        return { manifest: active.manifest, head, refs, turns, worldlineId: resolved.worldlineId, identity, owner: 'libra:' + route[0],
          rawHead, stateAuthority, stateProofs, stateKey: key.continuityState(scope), settings: await loadMemorySettings(), review, cutoff };
      };
      const capture = createLibraStateMemoryCapture({
        context: resolveContext, fingerprint: value => stateMemoryFingerprint(JSON.stringify(value)),
        check(scope, guard) { ensureRecallGuard(guard, 'state_memory_read'); if (state.disposed || state.deletingScopes.has(scope.scopeKey)) throw Error('LIBRA_STATE_OWNER_CLOSED'); },
        snapshot,
        async canonical(context, ref, source) {
          const memory = await loadWorldManagerHistoryCanonicalMemory(ref);
          if (unifiedArtifactSchemaReadable(memory.canonicalArtifact?.schema)) await unifiedEvidenceRead(memory);
          const review = source.review;
          const facts = canonicalEvidenceArtifactRows(memory.canonicalArtifact);
          const rows = facts.flatMap((fact, index) => memoryReviewDecision(review, 'canonical', memory, index) === 'rejected' ? [] : [{
            domain: fact.domain, text: string(fact.text || fact.summary || fact.value || JSON.stringify(fact.values || {})),
            evidenceKeys: ['canonical:' + memory.memoryId + ':' + memory.revision + ':' + fact.assertionId]
          }]);
          return { rows, proofs: [getConsumedCanonicalProof(memory)].filter(Boolean) };
        },
        async micro(context, source, turn) {
          const pairs = buildPairs(context.chat, context.scope.scopeKey), worldline = hostWorldlineIdForScope(context.scope);
          const active = await readActiveMicroMemory(context.scope, worldline, 0, turn, { context, pairs });
          if (active.status !== 'verified') return null;
          const memory = microRecallMemoryFromRecord(active.record, active.receipt, active.recordKey);
          if (!memory) throw Error('LIBRA_STATE_MICRO_INVALID');
          const review = source.review;
          const rows = asArray(active.record.claims).flatMap((claim, index) => memoryReviewDecision(review, 'micro', active.record, index) === 'rejected' ? [] : [{
            text: claim.text, domain: claim.changeKind === 'relation' ? 'relationship' : ['person','character'].includes(claim.changeKind) ? 'character' : claim.changeKind === 'world' ? 'world' : 'narrative',
            evidenceKeys: ['micro:' + active.record.analysisRevisionId + ':' + digest(claim)]
          }]);
          if (!rows.length && active.record.analysisStatus === 'minimum_source_bound') rows.push({ text: memory.summary, domain: 'narrative' });
          return { key: active.recordKey, rows, proofs: [activeMicroConsumptionProof(active)] };
        },
        async lens(context, source, query, maxCharacters) {
          const request = { scope: context.scope };
          const before = await gradiaLensReadSnapshot(request);
          const delivery = before.enabled ? await recallLensMemories(context, { currentText: query }, maxCharacters,
            { readOnly: true, refreshVectors: false, candidateBudgetChars: maxCharacters, asOfTurn: source.cutoff }) : null;
          const sourceKey = 'lens_selection:' + before.digest;
          return { key: sourceKey, proofs: [], delivery,
            rows: asArray(delivery?.injectedItems).map(item => ({
              text: '[PERSPECTIVE NOTES · NON-CANONICAL] ' + item.renderedLine, domain: 'narrative', turn: Number(item.turnRange?.end || 0), lensItem: item
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
          await assertConsumedDataCurrent(token);
          freshReadDepth++;
          try {
            const current = await resolveContext();
            if (!sameSnapshotScope(current.scope, context.scope) || (await snapshot(current, { queryInput: { asOfTurn: source.cutoff } })).identity !== source.identity)
              throw Error('LIBRA_STATE_SOURCE_CHANGED');
          } finally { freshReadDepth--; }
        },
        release: releaseConsumedDataReadSet
      }, engine);
      stateMemoryRuntime = createLibraStateMemoryRuntime({ engine, capture, fingerprint: stateMemoryFingerprint, authorityStore: memoryEvidenceAuthority });
      return stateMemoryRuntime;
    };
    const executeStateMemoryQuery = (options = {}, guard = null, issuer = null) => getStateMemoryRuntime().query(options, guard, issuer);
    const releaseStateMemoryQuery = execution => stateMemoryRuntime?.release(execution);
    const inspectResidentMemoryBudget = () => residentMemoryBudgetSnapshot();
