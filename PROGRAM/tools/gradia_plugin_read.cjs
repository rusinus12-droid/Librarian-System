'use strict';
// Dedicated read-only owner channel. No hook execution, global discovery, server
// principal, producer write API, or cross-plugin storage access is exposed.
module.exports = function createGradiaPluginRead(options) {
  const schema = 'memory-suite.gradia-plugin-read.v1';
  const requestChannel = 'gradia_memory_read_request_v1', responseChannel = 'gradia_memory_read_response_v1';
  const readerId = 'serial_gradation_agents_for_rp';
  const ids = { libra: 'libra', hayaku: 'hayaku_locator_continuity', flashback: 'flashback_memory' };
  const { fingerprint, byteLength } = options.primitives;
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const api = () => typeof options.api === 'function' ? options.api() : options.api;
  const copy = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const native = scope => ({ characterId: scope?.characterId, chatId: scope?.chatId });
  const validScope = scope => ['scopeKey', 'characterId', 'chatId'].every(key => typeof scope?.[key] === 'string'
    && scope[key].length > 0 && scope[key].length <= 512 && !/[\0\r\n]/.test(scope[key]));
  const budget = value => Number.isSafeInteger(value) && value >= 1 && value <= 33554432;
  let disposed = false, registered = false, sequence = 0;
  const instance = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const nextId = () => instance + ':' + (++sequence);
  const receipts = new Map(), pending = new Map(), issued = new Map();
  const closeRecord = record => {
    if (!record || record.closed) return;
    record.closed = true; clearTimeout(record.timer); record.read?.close?.(); record.read = null;
    receipts.delete(record.id);
  };
  const send = async (target, channel, body) => await api().postPluginChannelMessage(target, channel, body);
  const ownerBoundary = async request => {
    if (disposed) fail('LIB_READ_CANCELED');
    const value = await options.boundary();
    if (!validScope(value?.scope) || value.mode !== 'plugin_only') fail('LIB_READ_PLUGIN_MODE_REQUIRED');
    if (value.transition || value.migrationRequired === true) fail('LIB_READ_BOUNDARY_CHANGED');
    if (request?.native && !same(native(value.scope), request.native)
      || request?.scope && !same(value.scope, request.scope)) fail('LIB_READ_NATIVE_SCOPE_CHANGED');
    return copy(value);
  };
  const assertRecord = async record => {
    if (!record || record.closed || !record.read) fail('LIB_READ_STALE');
    if (!same(await ownerBoundary({ scope: record.boundary.scope }), record.boundary)) fail('LIB_READ_BOUNDARY_CHANGED');
    if (await record.read.assertCurrent() !== true) fail('LIB_READ_STALE');
    if (record.closed || !same(await ownerBoundary({ scope: record.boundary.scope }), record.boundary)) fail('LIB_READ_BOUNDARY_CHANGED');
    return true;
  };
  const ownerHandler = async (message, metadata = {}) => {
    // The sender is host metadata, never a self-asserted body field.
    if (disposed || metadata.sender !== readerId || message?.schema !== schema || message.kind !== 'request'
      || typeof message.id !== 'string' || message.id.length > 160
      || !['describe', 'capture', 'current', 'release'].includes(message.action)) return;
    if (byteLength(JSON.stringify(message)) > 65536) return;
    const { id, action } = message;
    let result, record;
    try {
      if (action === 'release') { closeRecord(receipts.get(message.receipt || id)); result = { released: true }; }
      else if (action === 'describe') result = { owner: options.owner, source: 'plugin_ipc', readOnly: true, ...(await ownerBoundary(message)) };
      else if (action === 'current') {
        record = receipts.get(message.receipt);
        await assertRecord(record); result = { current: true, evidenceRevision: record.revision };
      } else {
        if (receipts.has(id) || receipts.size >= 16) fail('LIB_READ_BUSY');
        if (!validScope(message.scope) || !budget(message.maxCorpusBytes) || typeof message.queryText !== 'string'
          || byteLength(message.queryText) > 16384) fail('LIB_READ_REQUEST_INVALID');
        const p = message.proposal;
        if (p !== undefined && (!p || p.schema !== 'gradia.input-writer-proposal.v1' || p.purpose !== 'input_writer_proposal'
          || p.factAdopted !== false || typeof p.operationId !== 'string' || !p.operationId || p.operationId.length > 160
          || !/^[a-f0-9]{64}$/.test(p.proposalDigest || '') || !/^[a-f0-9]{64}$/.test(p.nativeContextDigest || '')
          || typeof p.queryTruncated !== 'boolean' || Object.keys(p).length !== 7)) fail('LIB_READ_PROPOSAL_INVALID');
        // Reserve before the first await so timeout/release can cancel discovery
        // as well as an in-flight owner query.
        record = { id, boundary: null, read: null, closed: false };
        receipts.set(id, record);
        record.timer = setTimeout(() => closeRecord(record), options.receiptTtlMs || 1800000);
        record.timer?.unref?.();
        const boundary = await ownerBoundary(message);
        if (record.closed) fail('LIB_READ_CANCELED');
        record.boundary = boundary;
        const read = await options.capture(message, { check() { if (record.closed || disposed) fail('LIB_READ_CANCELED'); } });
        if (record.closed || disposed) { read?.close?.(); fail('LIB_READ_CANCELED'); }
        record.read = read;
        if (!Array.isArray(read?.items) || read.items.length > 4096) fail('LIB_READ_RESPONSE_INVALID');
        let bytes = 0, metadataBytes = 0;
        const seen = new Set();
        for (const item of read.items) {
          if (typeof item?.content !== 'string' || !item.id || !item.key || seen.has(JSON.stringify([item.id, item.key]))
            || item.source?.namespace !== options.owner) fail('LIB_READ_RESPONSE_INVALID');
          seen.add(JSON.stringify([item.id, item.key])); bytes += byteLength(item.content);
          const size = byteLength(JSON.stringify({ ...item, content: '' })); metadataBytes += size;
          if (size > 65536 || metadataBytes > 1048576 || bytes > message.maxCorpusBytes) fail('LIB_READ_BUDGET_EXCEEDED');
        }
        record.revision = fingerprint(JSON.stringify([instance, id, boundary, read.items]));
        await assertRecord(record);
        result = { owner: options.owner, source: 'plugin_ipc', readOnly: true, complete: true, scope: boundary.scope,
          receipt: id, evidenceRevision: record.revision, items: read.items, corpusBytes: bytes, engine: read.engine || null };
      }
      await send(readerId, responseChannel, { schema, kind: 'response', id, action, result });
    } catch (error) {
      if (record) closeRecord(record);
      await send(readerId, responseChannel, { schema, kind: 'response', id, action,
        error: /^LIB_READ_[A-Z_]+$/.test(error?.code || '') ? error.code : 'LIB_READ_OWNER_UNAVAILABLE' });
    }
  };
  const release = (owner, receipt) => {
    issued.delete(receipt);
    // A release uses the capture ID and also cancels an owner operation that is
    // still running; it never releases an unrelated request's receipt.
    return send(ids[owner], requestChannel, { schema, kind: 'request', id: receipt, action: 'release', receipt }).catch(() => {});
  };
  const readerHandler = (message, metadata = {}) => {
    if (disposed || message?.schema !== schema || message.kind !== 'response') return;
    const record = pending.get(message.id);
    if (!record || metadata.sender !== ids[record.owner] || message.action !== record.action) return;
    if (!message.error && record.action === 'capture' && message.result?.receipt !== message.id) {
      record.finish(Object.assign(new Error('LIB_READ_RESPONSE_INVALID'), { code: 'LIB_READ_RESPONSE_INVALID' })); return;
    }
    record.finish(message.error ? Object.assign(new Error(message.error), { code: message.error }) : null, message.result);
  };
  let starting = null;
  const register = async () => {
    if (disposed) fail('LIB_READ_CANCELED');
    if (registered) return true;
    const host = api();
    if (typeof host?.addPluginChannelListener !== 'function' || typeof host?.postPluginChannelMessage !== 'function') fail('LIB_READ_IPC_UNAVAILABLE');
    const channel = options.role === 'owner' ? requestChannel : responseChannel;
    const handler = options.role === 'owner' ? ownerHandler : readerHandler;
    if (await host.addPluginChannelListener(channel, handler) === false) fail('LIB_READ_IPC_UNAVAILABLE');
    if (disposed) { await host.removePluginChannelListener?.(channel, handler); fail('LIB_READ_CANCELED'); }
    registered = true; return true;
  };
  const start = async () => {
    if (!starting) starting = register().finally(() => { starting = null; });
    return await starting;
  };
  const rpc = async (owner, action, body = {}, signal) => {
    await start();
    if (signal?.aborted) fail('LIB_READ_CANCELED');
    const id = nextId();
    if (action === 'capture') issued.set(id, owner);
    return await new Promise((resolve, reject) => {
      const record = { owner, action, finish(error, result) {
        if (!pending.delete(id)) return;
        clearTimeout(record.timer); signal?.removeEventListener('abort', record.abort);
        if (error && action === 'capture') void release(owner, id);
        error ? reject(error) : resolve(result);
      } };
      record.abort = () => record.finish(Object.assign(new Error('LIB_READ_CANCELED'), { code: 'LIB_READ_CANCELED' }));
      record.timer = setTimeout(() => record.finish(Object.assign(new Error('LIB_READ_TIMEOUT'), { code: 'LIB_READ_TIMEOUT' })),
        options.timeoutMs || (action === 'describe' ? 3000 : 25000));
      pending.set(id, record); signal?.addEventListener('abort', record.abort, { once: true });
      if (signal?.aborted) { record.abort(); return; }
      void send(ids[owner], requestChannel, { schema, kind: 'request', id, action, ...body })
        .catch(() => record.finish(Object.assign(new Error('LIB_READ_IPC_UNAVAILABLE'), { code: 'LIB_READ_IPC_UNAVAILABLE' })));
    });
  };
  const describe = async (scope, owners = Object.keys(ids)) => {
    const scopes = {}, unavailable = {};
    await Promise.all(owners.map(async owner => {
      try {
        const result = await rpc(owner, 'describe', { native: native(scope) });
        if (result?.owner !== owner || result.source !== 'plugin_ipc' || result.readOnly !== true
          || result.mode !== 'plugin_only' || !validScope(result.scope) || !same(native(result.scope), native(scope))) fail('LIB_READ_RESPONSE_INVALID');
        scopes[owner] = result.scope;
      } catch (error) { unavailable[owner] = error.code || 'LIB_READ_IPC_UNAVAILABLE'; }
    }));
    if (disposed) fail('LIB_READ_CANCELED');
    // Stable owner order is part of binding identity, independent of RPC order.
    const ordered = Object.fromEntries(Object.keys(ids).filter(owner => scopes[owner]).map(owner => [owner, scopes[owner]]));
    // Keep each owner's refusal (e.g. LIB_READ_PLUGIN_MODE_REQUIRED for server-only
    // stores) so diagnostics can tell "use server read mode" from "owner missing".
    if (!Object.keys(ordered).length) throw Object.assign(new Error('LIB_READ_PLUGIN_OWNERS_UNAVAILABLE'), { code: 'LIB_READ_PLUGIN_OWNERS_UNAVAILABLE', unavailable });
    return { scope: ordered[Object.keys(ordered)[0]], scopes: ordered, unavailable };
  };
  const createClient = scopes => Object.freeze({ schema: 'memory-suite.memory-read-client.v1', pluginId: readerId,
    async openReadSession(scope, input = {}) {
      const requestedOwners = Object.keys(scopes), captured = [];
      let closed = false, stale = false;
      const close = () => { if (closed) return; closed = true; for (const value of captured) void release(value.owner, value.receipt); };
      const assertCurrentSync = () => {
        options.check?.();
        if (input.signal?.aborted) fail('LIB_READ_CANCELED');
        if (closed || stale || disposed) fail('LIB_READ_STALE');
        return true;
      };
      try {
        options.check?.();
        if (!budget(input.maxCorpusBytes) || !same(scope, scopes[requestedOwners[0]])) fail('LIB_READ_REQUEST_INVALID');
        // Availability is checked before expensive capture. Missing optional
        // owners do not impose the capture timeout or suppress healthy peers.
        const available = await describe(scope, requestedOwners);
        assertCurrentSync();
        const owners = Object.keys(available.scopes);
        for (const owner of owners) if (!same(available.scopes[owner], scopes[owner])) fail('LIB_READ_NATIVE_SCOPE_CHANGED');
        let corpusBytes = 0;
        const items = [];
        for (const owner of owners) {
          assertCurrentSync();
          const remaining = input.maxCorpusBytes - corpusBytes;
          if (remaining < 1) fail('LIB_READ_BUDGET_EXCEEDED');
          const result = await rpc(owner, 'capture', { scope: scopes[owner], queryText: input.queryText || '',
            maxCorpusBytes: remaining, ...(input.proposal ? { proposal: input.proposal } : {}) }, input.signal);
          // Retain the receipt before validating the response or cancellation.
          if (typeof result?.receipt === 'string') captured.push({ ...result, owner });
          assertCurrentSync();
          if (result?.source !== 'plugin_ipc' || result.owner !== owner || !result.receipt
            || !same(result.scope, scopes[owner]) || result.readOnly !== true || result.complete !== true
            || !/^[a-f0-9]{64}$/.test(result.evidenceRevision || '') || !Array.isArray(result.items)) fail('LIB_READ_RESPONSE_INVALID');
          let actual = 0;
          for (const item of result.items) {
            if (typeof item?.content !== 'string' || item.source?.namespace !== owner) fail('LIB_READ_RESPONSE_INVALID');
            actual += byteLength(item.content); items.push({ ...item, owner });
          }
          if (actual !== result.corpusBytes || actual > remaining || items.length > 4096) fail('LIB_READ_BUDGET_EXCEEDED');
          corpusBytes += actual;
        }
        const evidenceRevision = fingerprint(JSON.stringify(captured.map(value => [value.owner, value.evidenceRevision])));
        const assertCurrent = async () => {
          try {
            assertCurrentSync();
            const found = await describe(scope, owners);
            assertCurrentSync();
            for (const owner of owners) if (!same(found.scopes[owner], scopes[owner])) fail('LIB_READ_OWNER_UNAVAILABLE');
            for (const value of captured) {
              const now = await rpc(value.owner, 'current', { receipt: value.receipt }, input.signal);
              if (now?.current !== true || now.evidenceRevision !== value.evidenceRevision) fail('LIB_READ_STALE');
            }
            return assertCurrentSync();
          } catch (error) { stale = true; close(); throw error; }
        };
        await assertCurrent();
        return Object.freeze({ source: 'plugin_ipc', engine: {
          purpose: input.proposal ? 'input_writer_proposal' : 'response_evidence',
          ...(input.proposal ? { proposal: copy(input.proposal) } : {}),
          sourceByOwner: Object.fromEntries(captured.map(value =>
          [value.owner, value.owner === 'libra' ? 'unified_engine' : 'published_owner_memory'])) },
          snapshot: { schema: 'memory-suite.memory-read-session.v1', complete: true, readOnly: true, scope,
            owners, items, evidenceRevision, corpusBytes, maxCorpusBytes: input.maxCorpusBytes },
          assertCurrent, assertCurrentSync, close });
      } catch (error) { close(); throw error; }
    }
  });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const record of [...pending.values()]) record.finish(Object.assign(new Error('LIB_READ_CANCELED'), { code: 'LIB_READ_CANCELED' }));
    for (const [receipt, owner] of [...issued]) await release(owner, receipt);
    for (const record of [...receipts.values()]) closeRecord(record);
    if (registered) try { await api()?.removePluginChannelListener?.(options.role === 'owner' ? requestChannel : responseChannel,
      options.role === 'owner' ? ownerHandler : readerHandler); } catch (_) { /* Host teardown can remove the channel API first. */ }
    registered = false;
  };
  return Object.freeze({ start, describe, createClient, dispose });
};
