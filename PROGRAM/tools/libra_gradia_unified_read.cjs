'use strict';
// Authenticated host-channel transport and private owner receipts. No global-object discovery.
module.exports = function createLibraGradiaUnifiedRead(options = {}) {
  const schema = 'libra.gradia-unified-read.v1';
  const requestChannel = 'libra_gradia_unified_read_request_v1';
  const responseChannel = 'libra_gradia_unified_read_response_v1';
  const ownerId = 'libra', readerId = 'serial_gradation_agents_for_rp';
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const copy = value => JSON.parse(JSON.stringify(value));
  const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
  const api = () => typeof options.api === 'function' ? options.api() : options.api;
  const now = options.now || Date.now;
  let disposed = false, started = false, serial = 0;
  const pending = new Map(), receipts = new Map(), operations = new Map(), issued = new Set();
  const requestLimit = 65536, ttl = 600000;
  const check = signal => { if (disposed || signal?.aborted) fail('LIB_READ_CANCELED'); options.check?.(); };
  const prune = () => {
    for (const [id, record] of receipts) if (!record.active || record.expires <= now()) { record.active = false; receipts.delete(id); }
    for (const [id, record] of operations) if (!record.active || record.expires <= now()) operations.delete(id);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const assertRecord = record => { check(); if (!record?.active || record.expires <= now()) fail('LIB_READ_STALE'); };
  const validate = async record => {
    assertRecord(record);
    if (!same(await options.boundary(record.request), record.boundary)) fail('LIB_READ_BOUNDARY_CHANGED');
    assertRecord(record);
    if (record.execution && await options.verify(record.execution) !== true) fail('LIB_READ_STALE');
    assertRecord(record);
    if (!same(await options.boundary(record.request), record.boundary)) fail('LIB_READ_BOUNDARY_CHANGED');
    assertRecord(record);
  };
  const serve = async (action, payload = {}) => {
    check(); prune();
    if (bytes(payload) > requestLimit) fail('LIB_READ_BUDGET_EXCEEDED');
    if (action === 'describe') return { schema, source: 'unified_engine', readOnly: true };
    if (action === 'release') {
      const record = receipts.get(payload.receiptId) || operations.get(payload.operationId)
        || [...receipts.values()].find(row => row.operationId === payload.operationId);
      if (record) { record.active = false; receipts.delete(record.id); operations.delete(record.operationId); }
      return { released: true };
    }
    if (action === 'current') {
      const proof = payload.proof;
      const record = receipts.get(proof?.readIdentity?.ownerReceiptId);
      if (!record || !same(proof, record.proof)) fail('LIB_READ_STALE');
      await validate(record);
      return { schema: 'memory-suite.libra-read-session-current.v1', current: true,
        scope: record.request.scope, evidenceRevision: record.proof.evidenceRevision,
        dataInstanceId: record.boundary.dataInstanceId, resetEpoch: record.boundary.resetEpoch };
    }
    if (action !== 'capture') fail('LIB_READ_SOURCE_UNSUPPORTED');
    if (typeof payload.operationId !== 'string' || !payload.operationId || payload.operationId.length > 160
      || typeof payload.queryText !== 'string' || !payload.queryText.trim() || bytes(payload.queryText) > 16384
      || !Number.isSafeInteger(payload.maxCorpusBytes) || payload.maxCorpusBytes < 512 || payload.maxCorpusBytes > 33554432
      || payload.maxRawBytes !== undefined && (!Number.isSafeInteger(payload.maxRawBytes) || payload.maxRawBytes < 0
        || payload.maxRawBytes > 7 * payload.maxCorpusBytes + 2097152)) fail('LIB_READ_BUDGET_INVALID');
    if (operations.has(payload.operationId) || receipts.size + operations.size >= 32) fail('LIB_READ_SESSION_LIMIT');
    const record = { id: options.randomId(), operationId: payload.operationId, request: copy(payload), active: true, expires: now() + ttl, execution: null, receipt: null };
    operations.set(record.operationId, record);
    try {
      record.boundary = await options.boundary(record.request); assertRecord(record);
      const authority = {
        bindGraph(graph) {
          assertRecord(record);
          const ownerCorpusDigest = options.fingerprint(JSON.stringify({ frame: graph.readerFrame,
            nodes: graph.nodes.map(row => [row.id, row.bindingId]), edges: graph.edges.map(row => [row.id, row.bindingId]),
            bases: graph.bases.map(row => [row.id, row.bindingId]) }));
          record.receipt = Object.freeze({ ownerCorpusDigest, selectionReceiptId: record.id });
          return record.receipt;
        },
        verifyReceipt(receipt) { assertRecord(record); return !!record.receipt && same(record.receipt, receipt); }
      };
      record.execution = await options.query(record.request, authority); await validate(record);
      const execution = record.execution, content = execution.packet.renderedText;
      if (execution.modelDispatchEligible !== true) fail('LIB_READ_UNIFIED_UNAVAILABLE');
      const engine = { source: 'unified_engine', generation: execution.bundle.generation,
        queryComplete: execution.queryComplete === true, deliveryOutcome: execution.deliveryOutcome,
        windowRead: execution.windowRead, nextWindow: execution.nextWindow,
        ownerCorpusDigest: record.receipt.ownerCorpusDigest, selectionReceiptId: record.id };
      const items = content ? [{ id: 'unified-bundle:' + record.id, key: 'libra.unified.bundle:' + record.id, content,
        source: { namespace: 'libra', kind: 'owner_issued_evidence_bundle', ...engine } }] : [];
      const corpusBytes = bytes(content);
      const metadataBytes = bytes(items.map(({ content, ...metadata }) => metadata));
      const readIdentity = { scope: record.request.scope, dataInstanceId: record.boundary.dataInstanceId,
        resetEpoch: record.boundary.resetEpoch, ownerReceiptId: record.id };
      const evidenceRevision = options.fingerprint(JSON.stringify([record.id, record.receipt, execution.packet.packetDigest, readIdentity]));
      record.proof = { scope: record.request.scope, readIdentity, dependencies: [], evidenceRevision,
        dataInstanceId: record.boundary.dataInstanceId, resetEpoch: record.boundary.resetEpoch };
      // Account for JSON escaping, duplicated engine metadata and proof bytes.
      // The fixed allowance covers the remaining response envelope, not host heap.
      const rawBytes = bytes({ items, engine, ...record.proof }) + 1024;
      if (corpusBytes > payload.maxCorpusBytes || metadataBytes > 65536 || payload.maxRawBytes !== undefined && rawBytes > payload.maxRawBytes) fail('LIB_READ_CORPUS_BUDGET_EXCEEDED');
      receipts.set(record.id, record); operations.delete(record.operationId);
      return { schema: 'memory-suite.libra-read-session.v1', readOnly: true, complete: true,
        ...record.proof, items, engine, corpusBytes, metadataBytes, rawBytes, maxCorpusBytes: payload.maxCorpusBytes,
        ...(payload.maxRawBytes === undefined ? {} : { maxRawBytes: payload.maxRawBytes }) };
    } catch (error) { record.active = false; operations.delete(record.operationId); receipts.delete(record.id); throw error; }
  };
  const listener = async (message, metadata = {}) => {
    if (disposed || message?.schema !== schema || typeof message.requestId !== 'string') return;
    if (options.role === 'owner') {
      if (metadata.sender !== readerId || message.kind !== 'request') return;
      let reply;
      try { reply = { ok: true, result: await serve(message.action, message.payload) }; }
      catch (error) { reply = { ok: false, errorCode: /^LIB_READ_[A-Z_]+$/.test(error?.code || '') ? error.code : 'LIB_READ_UNIFIED_UNAVAILABLE' }; }
      if (!disposed) await api().postPluginChannelMessage(readerId, responseChannel, { schema, kind: 'response', requestId: message.requestId, ...reply });
    } else {
      if (metadata.sender !== ownerId || message.kind !== 'response') return;
      const record = pending.get(message.requestId); if (!record) return;
      pending.delete(message.requestId); record.finish();
      if (message.ok === true) record.resolve(message.result); else record.reject(Object.assign(new Error(message.errorCode), { code: /^LIB_READ_[A-Z_]+$/.test(message.errorCode || '') ? message.errorCode : 'LIB_READ_UNIFIED_UNAVAILABLE' }));
    }
  };
  let starting = null;
  const start = async () => {
    check(); if (started) return true;
    if (!starting) starting = (async () => {
      const host = api();
      if (typeof host?.addPluginChannelListener !== 'function' || typeof host?.postPluginChannelMessage !== 'function') fail('LIB_READ_UNIFIED_UNAVAILABLE');
      const result = await host.addPluginChannelListener(options.role === 'owner' ? requestChannel : responseChannel, listener);
      check(); if (result === false) fail('LIB_READ_UNIFIED_UNAVAILABLE'); started = true; return true;
    })().finally(() => { starting = null; });
    return await starting;
  };
  const request = async (action, payload, signal) => {
    check(signal); await start(); check(signal);
    if (bytes(payload) > requestLimit) fail('LIB_READ_BUDGET_EXCEEDED');
    const requestId = (options.randomId ? options.randomId() : String(now()) + ':' + (++serial)) + ':' + (++serial);
    return await new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { pending.delete(requestId); finish(); reject(Object.assign(new Error('LIB_READ_CANCELED'), { code: 'LIB_READ_CANCELED' }));
        if (action === 'capture') void request('release', { operationId: payload.operationId }).catch(() => {}); };
      const timer = setTimeout(() => { pending.delete(requestId); finish(); reject(Object.assign(new Error('LIB_READ_TIMEOUT'), { code: 'LIB_READ_TIMEOUT' }));
        if (action === 'capture') void request('release', { operationId: payload.operationId }).catch(() => {}); }, options.timeoutMs || 10000);
      pending.set(requestId, { resolve, reject, finish }); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      Promise.resolve(api().postPluginChannelMessage(ownerId, requestChannel, { schema, kind: 'request', requestId, action, payload }))
        .catch(() => { if (pending.delete(requestId)) { finish(); reject(Object.assign(new Error('LIB_READ_UNIFIED_UNAVAILABLE'), { code: 'LIB_READ_UNIFIED_UNAVAILABLE' })); } });
    });
  };
  return Object.freeze({ start,
    describe: () => request('describe', {}),
    capture: async input => {
      const result = await request('capture', { ...input, signal: undefined,
        operationId: input.operationId || String(now()) + ':' + (++serial) }, input.signal);
      if (result?.readIdentity?.ownerReceiptId) issued.add(result.readIdentity.ownerReceiptId);
      return result;
    },
    current: input => request('current', { proof: input.proof }, input.signal),
    release: async receiptId => { issued.delete(receiptId); return await request('release', { receiptId }); },
    async dispose() {
      // Revoke issued owner selections before removing the response listener.
      // Dispatch is best effort: disconnection must not wait for a peer timeout.
      if (options.role !== 'owner' && started) for (const receiptId of issued) {
        try { Promise.resolve(api().postPluginChannelMessage(ownerId, requestChannel, { schema, kind: 'request',
          requestId: 'dispose:' + (++serial), action: 'release', payload: { receiptId } })).catch(() => {}); } catch (_) {}
      }
      issued.clear();
      disposed = true;
      for (const record of receipts.values()) record.active = false;
      for (const record of operations.values()) record.active = false;
      receipts.clear(); operations.clear();
      for (const record of pending.values()) { record.finish(); record.reject(Object.assign(new Error('LIB_READ_CANCELED'), { code: 'LIB_READ_CANCELED' })); }
      pending.clear();
      if (started) await api()?.removePluginChannelListener?.(options.role === 'owner' ? requestChannel : responseChannel, listener);
      started = false;
    }
  });
};
