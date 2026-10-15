'use strict';
// Admission for observed owner payload I/O and transient JSON processing only.
// It does not certify host/network buffers, retained graph Maps, or whole VM heap.
module.exports = function createMemoryGraphResources({ measure, encodedSize, stageCost, limits = {} } = {}) {
  if (typeof measure !== 'function' || typeof encodedSize !== 'function' || typeof stageCost !== 'function') throw new TypeError('LIBRA_GRAPH_RESOURCE_MEASURE_REQUIRED');
  const poolLimits = { ioBytes: 32 * 1024 * 1024, decodeBytes: 128 * 1024 * 1024, reads: 8, ...limits };
  for (const [key,value] of Object.entries(poolLimits)) if (!['ioBytes','decodeBytes','reads'].includes(key)
    || !Number.isSafeInteger(value) || value < 1) throw new TypeError('LIBRA_GRAPH_RESOURCE_POOL_INVALID');
  const pool = { ioBytes: 0, decodeBytes: 0, reads: 0, peakIoBytes: 0, peakDecodeBytes: 0, peakReads: 0 };
  const defaults = Object.freeze({ maxSourceBytes: 64 * 1024 * 1024, maxDurableBytes: 32 * 1024 * 1024,
    maxValueBytes: 8 * 1024 * 1024, maxDecodeBytes: 64 * 1024 * 1024, maxReads: 8192 });
  const inspect = () => ({ ...pool, limits: { ...poolLimits } });
  const open = (input = {}, check = () => {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof check !== 'function') throw new TypeError('LIBRA_GRAPH_RESOURCE_OPTIONS_INVALID');
    const config = { ...defaults, ...input };
    for (const [key,value] of Object.entries(config)) if (!Object.hasOwn(defaults,key) || !Number.isSafeInteger(value)
      || value < 1 || value > (key === 'maxReads' ? 65536 : 256 * 1024 * 1024)) throw new TypeError('LIBRA_GRAPH_RESOURCE_OPTIONS_INVALID');
    if (config.maxValueBytes > poolLimits.ioBytes) throw new TypeError('LIBRA_GRAPH_RESOURCE_OPTIONS_INVALID');
    let failure = null;
    const counters = { sourceBytes: 0, durableBytes: 0, reads: 0, decodeBytes: 0, peakDecodeBytes: 0,
      reservedIoBytes: 0, peakReservedIoBytes: 0, inFlightReads: 0, peakInFlightReads: 0, rejectedPayloadLowerBoundBytes: 0 };
    const snapshot = () => ({ schema: 'libra.graph_resource_access.v1', ...counters, limits: { ...config },
      failure: failure?.reason || null, pool: inspect(), byteBounded: false,
      coverage: 'observed_owner_payload_io_and_transient_json_only',
      payloadAccounting: 'successfully_admitted_values_repeated_reads_counted',
      ioAccounting: 'reserved_payload_allowance_not_transport_buffers',
      decodeAccounting: 'conservative_json_workspace_estimate',
      unmeasured: ['host_context_and_route_bootstrap','http_envelope_and_transport_buffers','retained_graph_and_private_authority','native_host_lore_and_settings','external_readonly_permission_witness','hash_and_serialization_workspace','semantic_vector_hydration_and_index_compile','vm_heap'] });
    const fail = reason => {
      if (!failure) { failure = Object.assign(new Error('LIBRA_GRAPH_RESOURCE_' + reason.toUpperCase()), { reason }); failure.resourceAccess = snapshot(); }
      throw failure;
    };
    const assertCurrent = () => { if (failure) throw failure; check(); };
    const reserveValue = value => {
      assertCurrent();
      let size;
      try { size = typeof value === 'string' ? encodedSize(value) : measure(value === undefined ? null : value, config.maxDecodeBytes); }
      catch (error) { if (error.reason === 'row_exceeds_page') fail('decode_value_budget'); throw error; }
      const bytes = stageCost(size);
      if (!Number.isSafeInteger(bytes) || counters.decodeBytes + bytes > config.maxDecodeBytes) fail('decode_workspace_budget');
      if (pool.decodeBytes + bytes > poolLimits.decodeBytes) fail('decode_backpressure');
      counters.decodeBytes += bytes; pool.decodeBytes += bytes;
      counters.peakDecodeBytes = Math.max(counters.peakDecodeBytes,counters.decodeBytes);
      pool.peakDecodeBytes = Math.max(pool.peakDecodeBytes,pool.decodeBytes);
      let released = false;
      return Object.freeze({ release() { if (released) return; released = true; counters.decodeBytes -= bytes; pool.decodeBytes -= bytes; } });
    };
    const withValue = async (value, consume) => {
      const stage = reserveValue(value);
      try { assertCurrent(); const result = await consume(value); assertCurrent(); return result; }
      finally { stage.release(); }
    };
    const pending = { sourceBytes: 0, durableBytes: 0 };
    const reserveRead = (kind = 'source') => {
      assertCurrent();
      if (!['source','durable'].includes(kind)) fail('read_options_invalid');
      const category = kind === 'source' ? 'sourceBytes' : 'durableBytes';
      const maximum = kind === 'source' ? config.maxSourceBytes : config.maxDurableBytes;
      const cap = Math.min(config.maxValueBytes,maximum - counters[category] - pending[category]);
      if (cap < 1) fail(kind + '_byte_budget');
      if (counters.reads >= config.maxReads) fail('read_count_budget');
      if (pool.reads >= poolLimits.reads || pool.ioBytes + cap > poolLimits.ioBytes) fail('io_backpressure');
      counters.reads++; counters.inFlightReads++; counters.reservedIoBytes += cap; pending[category] += cap;
      pool.reads++; pool.ioBytes += cap;
      counters.peakInFlightReads = Math.max(counters.peakInFlightReads,counters.inFlightReads);
      counters.peakReservedIoBytes = Math.max(counters.peakReservedIoBytes,counters.reservedIoBytes);
      pool.peakReads = Math.max(pool.peakReads,pool.reads); pool.peakIoBytes = Math.max(pool.peakIoBytes,pool.ioBytes);
      let released = false, accepted = false;
      const release = () => {
        if (released) return; released = true;
        counters.inFlightReads--; counters.reservedIoBytes -= cap; pool.reads--; pool.ioBytes -= cap; pending[category] -= cap;
      };
      const accept = body => {
        assertCurrent(); if (released || accepted) fail('read_lease_invalid'); accepted = true;
        let bytes;
        if (body == null) bytes = 0;
        else if (typeof body === 'string') {
          bytes = 0;
          for (let i=0;i<body.length;i++) {
            const code=body.charCodeAt(i);
            if (code>=0xd800&&code<=0xdbff&&i+1<body.length&&body.charCodeAt(i+1)>=0xdc00&&body.charCodeAt(i+1)<=0xdfff) { bytes+=4;i++; }
            else bytes+=code<128?1:code<2048?2:3;
            if (bytes>cap) break;
          }
        } else {
          try { bytes = measure(body,cap).utf8Bytes; }
          catch (error) { if(error.reason==='row_exceeds_page') { counters.rejectedPayloadLowerBoundBytes += cap+1; fail('value_byte_budget'); } throw error; }
        }
        if (bytes>cap || counters[category] + bytes > maximum) { counters.rejectedPayloadLowerBoundBytes += bytes; fail('value_byte_budget'); }
        counters[category] += bytes;
      };
      return Object.freeze({ accept, release, prepare: reserveValue });
    };
    const read = async (load, { kind = 'source', select = value => value, consume = null } = {}) => {
      if (typeof load !== 'function' || typeof select !== 'function' || consume !== null && typeof consume !== 'function') fail('read_options_invalid');
      const lease = reserveRead(kind);
      try {
        const value = await load(); assertCurrent();
        const body = select(value); lease.accept(body);
        return consume ? await withValue(body,() => consume(value)) : value;
      } finally { lease.release(); }
    };
    return Object.freeze({ read, reserveRead, withValue, check: assertCurrent, inspect: snapshot });
  };
  return Object.freeze({ open, inspect, defaults });
};
