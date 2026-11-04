// Test double for the pipeline tests: stands in at the consumer boundary. The real consumer has its own tests.
(dependencies = {}) => {
    const factoryVersion = 'gradia.lib-read-consumer.v1';
    const limits = Object.freeze({ maxItems: 8, maxBytes: 8192, maxQueryBytes: 4096 });
    const owners = new Set(['libra', 'flashback', 'hayaku', 'lia', 'retrace']);
    const bytes = value => new TextEncoder().encode(value).length;
    const clone = value => JSON.parse(JSON.stringify(value));
    const canonical = value => JSON.stringify(value, function (_key, item) {
      return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.keys(item).sort().reduce((out, key) => { out[key] = item[key]; return out; }, Object.create(null)) : item;
    });
    const error = code => Object.assign(new Error(code), { code });
    const requireText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
    const requireHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const timeoutMs = Math.max(10, Math.min(5000, Number(dependencies.timeoutMs) || 1500));
    let generation = 0;
    let active = null;
    const stop = (record, reason) => {
      if (!record || record.invalidated) return;
      record.invalidated = true;
      record.reason = reason;
      record.packet = null;
      record.draft = '';
      record.draftHash = '';
      record.removeAbort?.();
      record.controller.abort(error(reason));
      if (active === record) generation += 1;
    };
    const invalidate = (reason = 'LIB_READ_INVALIDATED') => {
      stop(active, /^LIB_READ_[A-Z_]+$/.test(reason) ? reason : 'LIB_READ_INVALIDATED');
    };
    const check = record => {
      if (record.invalidated || active !== record || record.generation !== generation) throw error(record.reason || 'LIB_READ_SUPERSEDED');
    };
    const guarded = async (record, operation) => {
      check(record);
      let timer, onAbort;
      try {
        const canceled = new Promise((_, reject) => {
          onAbort = () => reject(error(record.reason || 'LIB_READ_CANCELED'));
          record.controller.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => stop(record, 'LIB_READ_TIMEOUT'), timeoutMs);
        });
        const value = await Promise.race([Promise.resolve().then(() => { check(record); return operation(); }), canceled]);
        check(record);
        return value;
      } finally {
        clearTimeout(timer);
        if (onAbort) record.controller.signal.removeEventListener('abort', onAbort);
      }
    };
    const normalizeBoundary = raw => {
      if (!raw || raw.transition === true || !['plugin_only', 'server_only'].includes(raw.mode)) throw error('LIB_READ_MODE_UNAVAILABLE');
      if (raw.mode === 'plugin_only') return { mode: 'plugin_only' };
      const scope = {};
      for (const key of ['characterId', 'chatId', 'branchId', 'personaId', 'worldlineRevision']) {
        if (!requireText(raw.scope?.[key])) throw error('LIB_READ_SCOPE_UNAVAILABLE');
        scope[key] = raw.scope[key];
      }
      if (!Number.isSafeInteger(raw.modeGeneration) || raw.modeGeneration < 0
          || !requireText(raw.data?.instanceId) || !requireText(raw.data?.resetEpoch)
          || !requireText(raw.nativeRevision) || !requireHash(raw.currentInputHash) || !requireHash(raw.recentTurnDigest)) throw error('LIB_READ_BOUNDARY_UNAVAILABLE');
      return { mode: raw.mode, modeGeneration: raw.modeGeneration, scope,
        data: { instanceId: raw.data.instanceId, resetEpoch: raw.data.resetEpoch }, nativeRevision: raw.nativeRevision,
        currentInputHash: raw.currentInputHash, recentTurnDigest: raw.recentTurnDigest };
    };
    const disabledSession = () => Object.freeze({ status: 'disabled', reason: 'plugin_only',
      assertCurrent: async () => true, getEvidence: async () => null,
      bindDraft: async () => { throw error('LIB_READ_DISABLED'); }, finalizeDraft: async () => { throw error('LIB_READ_DISABLED'); } });
    const beginRead = async (input = {}) => {
      invalidate('LIB_READ_SUPERSEDED');
      // Production defaults here without inspecting input or loading connection settings.
      if (typeof dependencies.getBoundary !== 'function') return disabledSession();
      const record = { generation, controller: new AbortController(), invalidated: false, packet: null, draft: '', draftHash: '', reason: '' };
      active = record;
      const signal = input.signal;
      if (signal) {
        const cancel = () => stop(record, 'LIB_READ_CANCELED');
        signal.addEventListener('abort', cancel, { once: true });
        record.removeAbort = () => signal.removeEventListener('abort', cancel);
        if (signal.aborted) cancel();
      }
      try {
        // Copy request primitives before the first await; callers retain their input object.
        const captured = { requestId: input.requestId, currentInputHash: input.currentInputHash,
          recentTurnDigest: input.recentTurnDigest, query: input.query,
          allowedOwners: Array.isArray(input.allowedOwners) ? input.allowedOwners.slice() : null };
        const boundary = normalizeBoundary(await guarded(record, () => dependencies.getBoundary()));
        if (boundary.mode === 'plugin_only') { stop(record, 'LIB_READ_DISABLED'); return disabledSession(); }
        if (typeof dependencies.recall !== 'function' || typeof dependencies.assertCurrent !== 'function'
            || typeof dependencies.digest !== 'function') throw error('LIB_READ_CONTRACT_UNAVAILABLE');
        if (typeof input.pipelineSnapshot === 'function') {
          const snapshot = clone(input.pipelineSnapshot());
          captured.currentInputHash = await guarded(record, () => dependencies.digest(snapshot.currentInput));
          const nativeReadSet = { schema: snapshot.schema, currentInputRef: snapshot.currentInputRef, selections: [], turns: [] };
          for (const selection of snapshot.selections) {
            const viewSHA256 = await guarded(record, () => dependencies.digest(canonical(selection.view)));
            if (!requireHash(viewSHA256)) throw error('LIB_READ_HASH_UNAVAILABLE');
            nativeReadSet.selections.push({ stage: selection.stage, turns: selection.turns, viewSHA256 });
          }
          for (const item of snapshot.turns) nativeReadSet.turns.push({ ...item.ref, role: item.role,
            contentSHA256: await guarded(record, () => dependencies.digest(item.content)) });
          if (bytes(canonical(nativeReadSet)) > 65536) throw error('LIB_READ_REQUEST_BUDGET_EXCEEDED');
          captured.recentTurnDigest = await guarded(record, () => dependencies.digest(canonical(nativeReadSet)));
          captured.nativeReadSet = nativeReadSet;
          captured.query = '';
          for (const char of snapshot.query) {
            if (bytes(captured.query + char) > limits.maxQueryBytes) break;
            captured.query += char;
          }
          captured.allowedOwners = ['libra'];
          const afterDigest = normalizeBoundary(await guarded(record, () => dependencies.getBoundary()));
          if (canonical(afterDigest) !== canonical(boundary)) throw error('LIB_READ_BOUNDARY_CHANGED');
        }
        if (!requireText(captured.requestId) || captured.currentInputHash !== boundary.currentInputHash
            || captured.recentTurnDigest !== boundary.recentTurnDigest || typeof captured.query !== 'string'
            || bytes(captured.query) > limits.maxQueryBytes || !Array.isArray(captured.allowedOwners)
            || !captured.allowedOwners.length || captured.allowedOwners.length > owners.size
            || captured.allowedOwners.some(owner => !owners.has(owner))) throw error('LIB_READ_REQUEST_INVALID');
        const request = clone({ requestId: captured.requestId, currentInputHash: captured.currentInputHash,
          recentTurnDigest: captured.recentTurnDigest, query: captured.query, allowedOwners: [...new Set(captured.allowedOwners)],
          boundary, budget: limits, ...(captured.nativeReadSet ? { nativeReadSet: captured.nativeReadSet } : {}) });
        const boundaryKey = canonical(boundary);
        const assertBoundary = async () => {
          const current = normalizeBoundary(await guarded(record, () => dependencies.getBoundary()));
          if (canonical(current) !== boundaryKey) throw error('LIB_READ_BOUNDARY_CHANGED');
        };
        const response = await guarded(record, () => dependencies.recall(clone(request), { signal: record.controller.signal }));
        const serializedReceipt = JSON.stringify(response);
        if (typeof serializedReceipt !== 'string' || bytes(serializedReceipt) > 65536) throw error('LIB_READ_BUDGET_EXCEEDED');
        const receipt = JSON.parse(serializedReceipt);
        await assertBoundary();
        if (receipt?.schema !== 'gradia.lib-read-receipt.v1' || receipt.requestId !== request.requestId
            || canonical(receipt.boundary) !== boundaryKey || !requireText(receipt.evidenceRevision)) throw error('LIB_READ_RECEIPT_MISMATCH');
        if (receipt.completeness !== 'complete' || receipt.truncated !== false) throw error('LIB_READ_INCOMPLETE');
        if (!Array.isArray(receipt.items) || receipt.items.length > limits.maxItems) throw error('LIB_READ_BUDGET_EXCEEDED');
        const seen = new Set(); let totalBytes = 0;
        for (const item of receipt.items) {
          if (!requireText(item.id) || seen.has(item.id) || !request.allowedOwners.includes(item.owner)
              || item.authority !== 'owner_memory' || item.eligibility !== 'eligible'
              || typeof item.content !== 'string' || !requireHash(item.contentHash)
              || canonical(item.source?.scope) !== canonical(boundary.scope)
              || !requireText(item.source?.sourceRevision) || !requireText(item.source?.variantId)
              || !requireText(item.source?.handle) || !Array.isArray(item.source?.turnIds)
              || !item.source.turnIds.length || item.source.turnIds.length > 64
              || item.source.turnIds.some(id => !requireText(id))
              || new Set(item.source.turnIds).size !== item.source.turnIds.length) throw error('LIB_READ_SOURCE_INVALID');
          seen.add(item.id); totalBytes += bytes(item.content);
          if (totalBytes > limits.maxBytes) throw error('LIB_READ_BUDGET_EXCEEDED');
          const digest = await guarded(record, () => dependencies.digest(item.content));
          if (digest !== item.contentHash) throw error('LIB_READ_CONTENT_MISMATCH');
        }
        record.packet = receipt;
        const assertCurrent = async () => {
          try {
            check(record);
            await assertBoundary();
            const current = await guarded(record, () => dependencies.assertCurrent(clone(record.packet), { signal: record.controller.signal }));
            if (current !== true) throw error('LIB_READ_STALE');
            await assertBoundary();
            check(record);
            return true;
          } catch (caught) {
            const code = /^LIB_READ_/.test(caught?.code || '') ? caught.code : 'LIB_READ_UNAVAILABLE';
            stop(record, code); throw error(code);
          }
        };
        await assertCurrent();
        check(record);
        const evidenceRevision = receipt.evidenceRevision;
        return Object.freeze({ status: 'ready',
          invalidate: reason => stop(record, /^LIB_READ_[A-Z_]+$/.test(reason) ? reason : 'LIB_READ_INVALIDATED'),
          assertLocalCurrent: () => check(record),
          assertCurrent,
          getEvidence: async () => { await assertCurrent(); check(record); return clone(record.packet); },
          bindDraft: async draft => {
            await assertCurrent();
            check(record);
            if (typeof draft !== 'string' || !draft || bytes(draft) > 320000) throw error('LIB_READ_DRAFT_INVALID');
            const digest = await guarded(record, () => dependencies.digest(draft));
            await assertCurrent();
            check(record);
            if (!requireHash(digest)) throw error('LIB_READ_DRAFT_INVALID');
            record.draft = draft; record.draftHash = digest;
            return Object.freeze({ requestId: request.requestId, draftHash: digest, evidenceRevision });
          },
          finalizeDraft: async () => {
            await assertCurrent();
            check(record);
            if (!record.draft || !record.draftHash) throw error('LIB_READ_DRAFT_UNBOUND');
            return record.draft;
          }
        });
      } catch (caught) {
        const code = /^LIB_READ_/.test(caught?.code || '') ? caught.code : 'LIB_READ_UNAVAILABLE';
        stop(record, code); throw error(code);
      }
    };
    return Object.freeze({ factoryVersion, beginRead, invalidate,
      getState: () => Object.freeze({ generation, hasEvidence: !!active?.packet, hasDraft: !!active?.draft,
        reason: active?.reason || '', productionRemoteEnabled: false }) });
  }
