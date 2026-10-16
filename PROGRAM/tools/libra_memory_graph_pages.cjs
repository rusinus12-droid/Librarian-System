'use strict';
// Accounted-byte cache for immutable derived JSON pages. Source reads, durable
// publication and final delivery authority remain with the owner adapters.
module.exports = function createMemoryGraphPages({ fingerprint, limits = {} } = {}) {
  if (typeof fingerprint !== 'function') throw new TypeError('LIBRA_GRAPH_PAGE_FINGERPRINT_REQUIRED');
  const config = { residentBytes: 4 * 1024 * 1024, partitionBytes: 1024 * 1024,
    requestBytes: 1024 * 1024, perRequestBytes: 512 * 1024, stagingBytes: 2 * 1024 * 1024, pageBytes: 65536, ...limits };
  for (const [name, value] of Object.entries(config)) {
    if (!['residentBytes','partitionBytes','requestBytes','perRequestBytes','stagingBytes','pageBytes'].includes(name)
      || !Number.isSafeInteger(value) || value < 256) throw new TypeError('LIBRA_GRAPH_PAGE_LIMIT_INVALID');
  }
  const fail = (reason, detail) => { const error = new Error('LIBRA_GRAPH_PAGE_' + reason.toUpperCase()); error.reason = reason; if (detail) error.budgetDetail = detail; throw error; };
  const pools = ['nodes', 'edges', 'bases', 'units'];
  const requests = new Map(), leases = new WeakMap(), stages = new WeakMap(), entries = new Map();
  let resident = 0, requestBytes = 0, staging = 0, disposed = false;
  const peaks = { resident: 0, request: 0, staging: 0 };
  const counters = { hits: 0, misses: 0, evictions: 0, rejections: 0, pagesEncoded: 0, stagingParses: 0, pagesDecoded: 0, generations: 0 };
  const peak = () => { peaks.resident = Math.max(peaks.resident, resident); peaks.request = Math.max(peaks.request, requestBytes); peaks.staging = Math.max(peaks.staging, staging); };
  const hash = value => { const result = fingerprint(value); if (!/^[a-f0-9]{64}$/.test(result)) fail('fingerprint_invalid'); return result; };
  const label = value => { if (typeof value !== 'string' || !value || value.length > 1024) fail('binding_invalid'); return value; };

  // Measure JSON before serialization/decode admission, including UTF-16 escaped
  // controls/lone surrogates and UTF-8 astral characters. Never invoke getters.
  const measure = (value, ceiling = Number.MAX_SAFE_INTEGER) => {
    let utf8Bytes = 0, codeUnits = 0, tokens = 0;
    const seen = new Set();
    const add = (bytes, units = bytes) => { utf8Bytes += bytes; codeUnits += units; if (utf8Bytes > ceiling) fail('row_exceeds_page'); };
    const quoted = text => {
      add(2);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 34 || code === 92 || [8,9,10,12,13].includes(code)) add(2);
        else if (code < 32) add(6);
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4, 2); i++; }
        else if (code >= 0xd800 && code <= 0xdfff) add(6);
        else add(code < 128 ? 1 : code < 2048 ? 2 : 3, 1);
      }
    };
    const walk = (item, depth) => {
      tokens++; if (depth > 32) fail('json_depth');
      if (item === null) { add(4); return; }
      if (typeof item === 'string') { quoted(item); return; }
      if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
      if (typeof item === 'number' && Number.isFinite(item)) { add(JSON.stringify(item).length); return; }
      if (!item || typeof item !== 'object' || seen.has(item)) fail('json_invalid');
      const proto = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) fail('json_invalid');
      if (Object.hasOwn(item, 'toJSON')) fail('json_invalid');
      seen.add(item); add(2);
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('json_invalid');
          if (i) add(1); walk(descriptor.value, depth + 1);
        }
      } else {
        let index = 0;
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('json_invalid');
          if (index++) add(1); quoted(key); add(1); walk(descriptor.value, depth + 1);
        }
      }
      seen.delete(item);
    };
    walk(value, 0); return { utf8Bytes, codeUnits, tokens };
  };
  // Empty containers add delimiters without adding child values. At most three
  // lexical control tokens per measured value bound the validation scan.
  const stageCost = size => 65536 + size.utf8Bytes * 12 + size.codeUnits * 4 + size.tokens * 192 + 128;
  const request = handle => { const value = requests.get(handle); if (!value || disposed) fail('request_revoked'); return value; };
  const charge = (value, bytes) => {
    if (value.bytes + bytes > config.perRequestBytes || requestBytes + bytes > config.requestBytes) fail('request_budget');
    value.bytes += bytes; requestBytes += bytes; peak();
  };
  const open = ({ partition, generation }) => {
    if (disposed) fail('disposed'); label(partition); label(generation);
    const handle = Object.freeze({}), value = { partition, generation, bytes: 0, leases: new Set(), stages: new Set() };
    charge(value, 1024 + 2 * (partition.length + generation.length)); requests.set(handle, value); return handle;
  };
  const reserve = (handle, bytes) => {
    const value = request(handle);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes + staging > config.stagingBytes) fail('staging_budget');
    charge(value, 256);
    const token = Object.freeze({}), state = { request: value, bytes };
    stages.set(token, state); value.stages.add(token); staging += bytes; peak(); return token;
  };
  const releaseStage = token => {
    const value = stages.get(token); if (!value) return;
    staging -= value.bytes; value.request.bytes -= 256; requestBytes -= 256;
    value.request.stages.delete(token); stages.delete(token);
  };
  const release = token => {
    const value = leases.get(token); if (!value) return;
    value.entry.pins--; value.request.bytes -= value.bytes; requestBytes -= value.bytes;
    value.request.leases.delete(token); leases.delete(token);
  };
  const close = handle => {
    const value = requests.get(handle); if (!value) return;
    for (const token of value.leases) release(token);
    for (const token of value.stages) releaseStage(token);
    requestBytes -= value.bytes; requests.delete(handle);
  };
  const identity = (value, binding) => {
    if (!pools.includes(binding.pool) || binding.codec !== 'json_array.v1' || !/^[a-f0-9]{64}$/.test(binding.digest)
      || !Number.isSafeInteger(binding.rows) || binding.rows < 0) fail('binding_invalid');
    const tuple = JSON.stringify([value.partition, binding.pool, binding.codec, binding.digest, binding.rows]);
    return { key: hash(tuple), tuple };
  };
  const evict = entry => { entries.delete(entry.key); resident -= entry.bytes; counters.evictions++; };
  const admit = (value, bytes) => {
    if (bytes > config.residentBytes || bytes > config.partitionBytes) fail('resident_budget');
    let partitionTotal = 0; for (const entry of entries.values()) if (entry.partition === value.partition) partitionTotal += entry.bytes;
    let remaining = resident; const victims = new Set();
    for (const entry of entries.values()) {
      if (partitionTotal + bytes <= config.partitionBytes) break;
      if (entry.partition !== value.partition || entry.pins) continue;
      victims.add(entry); partitionTotal -= entry.bytes; remaining -= entry.bytes;
    }
    if (partitionTotal + bytes > config.partitionBytes) fail('pin_backpressure');
    for (const entry of entries.values()) {
      if (remaining + bytes <= config.residentBytes) break;
      if (entry.pins || victims.has(entry)) continue;
      victims.add(entry); remaining -= entry.bytes;
    }
    if (remaining + bytes > config.residentBytes) fail('pin_backpressure');
    return victims; // Admission must succeed before any useful page is evicted.
  };
  const pin = (value, entry) => {
    const bytes = 1024 + entry.size.codeUnits * 8 + entry.size.tokens * 64;
    charge(value, bytes);
    const token = Object.freeze({}); leases.set(token, { request: value, entry, bytes }); value.leases.add(token); entry.pins++;
    entries.delete(entry.key); entries.set(entry.key, entry); return token;
  };
  const acquire = (handle, binding) => {
    const value = request(handle), stage = reserve(handle, 65536);
    try {
      const id = identity(value, binding), entry = entries.get(id.key);
      if (!entry) { counters.misses++; return null; }
      if (entry.tuple !== id.tuple) fail('identity_collision');
      const token = pin(value, entry); counters.hits++; return token;
    } finally { releaseStage(stage); }
  };
  const encodedSize = text => {
    if (typeof text !== 'string') fail('json_invalid');
    let encodedBytes = 0, tokenBound = 1, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { encodedBytes += 4; i++; }
      else encodedBytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (inString) { if (escaped) escaped = false; else if (code === 92) escaped = true; else if (code === 34) inString = false; }
      else if (code === 34) inString = true;
      else if ([91,123,44,58].includes(code)) tokenBound++;
    }
    return { utf8Bytes: encodedBytes, codeUnits: text.length, tokens: tokenBound };
  };
  const install = (handle, binding, text, stage) => {
    const value = request(handle), reservation = stages.get(stage);
    if (!reservation || reservation.request !== value || typeof text !== 'string') fail('staging_required');
    // Bounded producers pass size from pre-encoding measurement; verify the
    // actual JSON only after its decode/hash workspace has been reserved.
    const encoded = encodedSize(text), encodedBytes = encoded.utf8Bytes, tokenBound = encoded.tokens;
    if (encodedBytes > config.pageBytes) fail('row_exceeds_page');
    const required = 65536 + encodedBytes * 12 + text.length * 4 + tokenBound * 64;
    if (required > reservation.bytes) fail('staging_budget', { stage: 'encoded_preflight', required, reserved: reservation.bytes });
    counters.stagingParses++;
    const parsed = JSON.parse(text), size = measure(parsed, config.pageBytes);
    if (!Array.isArray(parsed) || size.utf8Bytes > config.pageBytes || stageCost(size) > reservation.bytes) fail('staging_budget',
      { stage: 'parsed_validation', required: stageCost(size), reserved: reservation.bytes });
    if (parsed.length !== binding.rows || hash(text) !== binding.digest) fail('payload_binding_invalid');
    const id = identity(value, binding), prior = entries.get(id.key);
    if (prior) {
      if (prior.tuple !== id.tuple || prior.text !== text) fail('identity_collision');
      const token = pin(value, prior); counters.hits++; return token;
    }
    counters.misses++;
    const bytes = 512 + 2 * (text.length + id.tuple.length + id.key.length + value.partition.length);
    // Reserve decode/pin accounting first, then decide LRU eviction atomically.
    const decodeBytes = 1024 + size.codeUnits * 8 + size.tokens * 64;
    charge(value, decodeBytes);
    let victims;
    try { victims = admit(value, bytes); }
    catch (error) { value.bytes -= decodeBytes; requestBytes -= decodeBytes; throw error; }
    for (const victim of victims) evict(victim);
    const entry = { ...id, partition: value.partition, pool: binding.pool, text, size, bytes, pins: 1 };
    entries.set(id.key, entry); resident += bytes; peak();
    const token = Object.freeze({}); leases.set(token, { request: value, entry, bytes: decodeBytes }); value.leases.add(token); return token;
  };
  const decode = token => {
    const value = leases.get(token); if (!value || disposed) fail('lease_revoked');
    counters.pagesDecoded++; return JSON.parse(value.entry.text);
  };
  const invalidate = partition => {
    for (const [handle, value] of requests) if (partition === undefined || value.partition === partition) close(handle);
    for (const entry of entries.values()) if (partition === undefined || entry.partition === partition) evict(entry);
  };
  const inspect = () => {
    const poolStats = Object.fromEntries(pools.map(pool => [pool, { pages: 0, bytes: 0 }])); let pins = 0, pinnedResidentBytes = 0;
    for (const entry of entries.values()) { pins += entry.pins; if (entry.pins) pinnedResidentBytes += entry.bytes;
      poolStats[entry.pool].pages++; poolStats[entry.pool].bytes += entry.bytes; }
    return { schema: 'libra.graph_page_cache.v1', limits: { ...config },
    bytes: { resident, request: requestBytes, staging, peak: { ...peaks } }, counters: { ...counters },
    pages: entries.size, activeRequests: requests.size,
    pins, pinnedResidentBytes, pools: poolStats,
    accountedByteBounded: true, actualHeapBounded: false,
    budgetScope: 'derived_json_pages_and_managed_decode_leases', unmeasuredRuntimeOverhead: true,
    sourceReaderWorkspaceAccounted: false, callerRetainedOutputsAccounted: false, durableStoreImplemented: false };
  };

  const generation = (graph, frame) => {
    const handle = open({ partition: frame.partition, generation: 'generation_build' }); let stage;
    try {
      const meta = { schema: graph.schema, frame, coverage: graph.coverage };
      const size = measure(meta, 16384); stage = reserve(handle, stageCost(size));
      let current = hash(JSON.stringify(meta));
      // The issuer's exact node/basis bindings cover all corresponding unit
      // values. Hash a bounded row at a time instead of a full graph copy.
      for (const pool of pools) {
        current = hash(current + ':' + pool + ':' + graph[pool].length);
        for (const row of graph[pool]) {
          const id = row.id || row.nodeId, binding = row.bindingId || '';
          label(id); if (typeof binding !== 'string' || binding.length > 1024) fail('binding_invalid');
          current = hash(current + ':' + id + ':' + binding);
        }
      }
      counters.generations++; return current;
    } finally { if (stage) releaseStage(stage); close(handle); }
  };
  const page = (graph, { partition, generation: viewGeneration, pool = 'units', offset = 0, pageBytes = 16384 } = {}) => {
    if (!pools.includes(pool) || !Number.isSafeInteger(offset) || offset < 0 || offset > graph[pool].length
      || !Number.isSafeInteger(pageBytes) || pageBytes < 256 || pageBytes > config.pageBytes) fail('options_invalid');
    let handle, stage, token; const before = { ...counters };
    const result = { schema: 'libra.memory_graph_access_page.v1', pool, generation: viewGeneration, offset,
      nextOffset: offset, totalRows: graph[pool].length, items: [], serializedUtf8Bytes: 2, pageBytes,
      stopReason: '', cacheHit: false, modelDispatchEligible: false, byteBounded: false };
    try {
      handle = open({ partition, generation: viewGeneration });
      const selected = []; let bytes = 2, units = 2, tokens = 1, budgetBoundary = '';
      for (let index = offset; index < graph[pool].length; index++) {
        let size;
        try { size = measure(graph[pool][index], pageBytes - 2); }
        catch (error) { if (error.reason !== 'row_exceeds_page' || !selected.length) throw error; break; }
        const separator = selected.length ? 1 : 0;
        if (bytes + separator + size.utf8Bytes > pageBytes) break;
        const nextSize = { utf8Bytes: bytes + separator + size.utf8Bytes, codeUnits: units + separator + size.codeUnits, tokens: tokens + size.tokens };
        const value = request(handle), decodeBytes = 1024 + nextSize.codeUnits * 8 + nextSize.tokens * 64;
        const tupleLength = JSON.stringify([partition, pool, 'json_array.v1', '0'.repeat(64), selected.length + 1]).length;
        const residentBytes = 512 + 2 * (nextSize.codeUnits + tupleLength + 64 + partition.length);
        const reason = value.bytes + 256 + decodeBytes > config.perRequestBytes || requestBytes + 256 + decodeBytes > config.requestBytes
          ? 'request_budget' : stageCost(nextSize) + staging > config.stagingBytes ? 'staging_budget'
          : residentBytes > config.residentBytes || residentBytes > config.partitionBytes ? 'resident_budget' : '';
        if (reason) { if (!selected.length) fail(reason); budgetBoundary = reason + '_page_boundary'; break; }
        selected.push(graph[pool][index]); bytes += separator + size.utf8Bytes; units += separator + size.codeUnits; tokens += size.tokens;
      }
      const size = { utf8Bytes: bytes, codeUnits: units, tokens };
      stage = reserve(handle, stageCost(size));
      const text = JSON.stringify(selected); counters.pagesEncoded++;
      const binding = { pool, codec: 'json_array.v1', digest: hash(text), rows: selected.length };
      token = install(handle, binding, text, stage);
      result.items = decode(token); result.serializedUtf8Bytes = bytes;
      result.nextOffset = offset + selected.length; result.cacheHit = counters.hits > before.hits;
      result.stopReason = result.nextOffset < result.totalRows ? budgetBoundary || 'page_boundary' : 'owner_projection_page_end';
    } catch (error) {
      if (!['resident_budget','request_budget','staging_budget','pin_backpressure','row_exceeds_page'].includes(error.reason)) throw error;
      result.stopReason = error.reason; counters.rejections++;
      if (error.budgetDetail) result.budgetDetail = error.budgetDetail;
    } finally { if (token) release(token); if (stage) releaseStage(stage); if (handle) close(handle); }
    result.cache = inspect(); return result;
  };
  return Object.freeze({ open, reserve, releaseStage, close, acquire, install, decode, release, measure, stageCost, encodedSize,
    generation, page, inspect, invalidate, dispose() { invalidate(); disposed = true; } });
};
