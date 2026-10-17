'use strict';
// Admission for owner payload I/O, JSON workspace and explicitly leased retained estimates.
// Accounted estimates are not a certification of host/network buffers or whole VM heap.
module.exports = function createMemoryGraphResources({ measure, encodedSize, stageCost, limits = {}, lifetimeMs = 600000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof measure !== 'function' || typeof encodedSize !== 'function' || typeof stageCost !== 'function') throw new TypeError('LIBRA_GRAPH_RESOURCE_MEASURE_REQUIRED');
  const poolLimits = { ioBytes: 32 * 1024 * 1024, decodeBytes: 128 * 1024 * 1024, reads: 8, retainedBytes: 256 * 1024 * 1024, sessions: 32, ...limits };
  for (const [key,value] of Object.entries(poolLimits)) if (!['ioBytes','decodeBytes','reads','retainedBytes','sessions'].includes(key)
    || !Number.isSafeInteger(value) || value < 1) throw new TypeError('LIBRA_GRAPH_RESOURCE_POOL_INVALID');
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || typeof schedule !== 'function' || typeof cancel !== 'function') throw new TypeError('LIBRA_GRAPH_RESOURCE_LIFETIME_INVALID');
  const sessions = new Set();
  const pool = { retainedBytes: 0, peakRetainedBytes: 0, sessions: 0, peakSessions: 0, ioBytes: 0, decodeBytes: 0, reads: 0, peakIoBytes: 0, peakDecodeBytes: 0, peakReads: 0 };
  // A cold query holds the projection, its compile input and the vector readback at once;
  // with real extracted canonical/Micro records a 30-turn chat estimates ~62 MiB, so the
  // query session gets 128 MiB and maintenance (a full build) 192 MiB; the 256 MiB pool
  // still bounds them together.
  const defaults = Object.freeze({ maxSourceBytes: 64 * 1024 * 1024, maxDurableBytes: 32 * 1024 * 1024,
    maxRetainedBytes: 128 * 1024 * 1024, maxValueBytes: 8 * 1024 * 1024, maxDecodeBytes: 64 * 1024 * 1024, maxReads: 8192 });
  const maintenanceDefaults = Object.freeze({ ...defaults, maxRetainedBytes: 192 * 1024 * 1024 });
  const inspect = () => ({ ...pool, limits: { ...poolLimits } });
  const openWithDefaults = (input = {}, check = () => {}, profile = defaults) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof check !== 'function') throw new TypeError('LIBRA_GRAPH_RESOURCE_OPTIONS_INVALID');
    const config = { ...profile, ...input };
    for (const [key,value] of Object.entries(config)) if (!Object.hasOwn(defaults,key) || !Number.isSafeInteger(value)
      || value < 1 || value > (key === 'maxReads' ? 65536 : 256 * 1024 * 1024)) throw new TypeError('LIBRA_GRAPH_RESOURCE_OPTIONS_INVALID');
    if (config.maxValueBytes > poolLimits.ioBytes) throw new TypeError('LIBRA_GRAPH_RESOURCE_OPTIONS_INVALID');
    let failure = null, closed = false, closeReason = null, timer = null, activities = 0;
    const retained = new Set(), finalizers = new Set(), retainedByCategory = Object.create(null);
    const counters = { retainedBytes: 0, peakRetainedBytes: 0, retainedLeases: 0, sourceBytes: 0, durableBytes: 0, reads: 0, decodeBytes: 0, peakDecodeBytes: 0,
      reservedIoBytes: 0, peakReservedIoBytes: 0, inFlightReads: 0, peakInFlightReads: 0, rejectedPayloadLowerBoundBytes: 0 };
    const snapshot = () => ({ schema: 'libra.graph_resource_access.v2', closed, closeReason, activities, ...counters, retainedByCategory: { ...retainedByCategory }, limits: { ...config },
      failure: failure?.reason || null, pool: inspect(), byteBounded: false,
      coverage: 'owner_payload_json_and_explicit_retained_leases',
      payloadAccounting: 'successfully_admitted_values_repeated_reads_counted',
      ioAccounting: 'reserved_payload_allowance_not_transport_buffers',
      decodeAccounting: 'conservative_json_workspace_estimate',
      retainedAccounting: 'conservative_explicit_allocation_estimates_not_heap_measurement',
      unmeasured: ['host_context_and_route_bootstrap','http_envelope_and_transport_buffers','native_host_lore_and_settings','external_readonly_permission_witness','hash_and_serialization_workspace','unregistered_allocations_and_host_caches','vm_heap'] });
    const fail = reason => {
      if (!failure) { failure = Object.assign(new Error('LIBRA_GRAPH_RESOURCE_' + reason.toUpperCase()), { reason }); failure.resourceAccess = snapshot(); }
      throw failure;
    };
    const assertCurrent = () => { if (failure) throw failure; if (closed) throw Object.assign(new Error('LIBRA_GRAPH_RESOURCE_CLOSED'), { reason: closeReason }); check(); };
    const drain = () => {
      if (!closed || activities) return;
      for (const lease of [...retained]) lease.release();
      sessions.delete(close); pool.sessions = sessions.size;
    };
    const begin = () => {
      assertCurrent(); activities++; let ended = false;
      return Object.freeze({ release() { if (ended) return; ended = true; activities--; drain(); } });
    };
    const close = (reason = 'released') => {
      if (closed) return; closed = true; closeReason = reason;
      if (timer !== null) cancel(timer); timer = null;
      // Revoke authority now; retain accounting until active operations unwind.
      for (const finalize of [...finalizers]) { try { finalize(); } catch (_) {} }
      finalizers.clear(); drain();
      // Pending transport/decode leases remain charged until their actual finally block.
    };
    const onClose = finalize => { assertCurrent(); if (typeof finalize !== 'function') throw new TypeError('LIBRA_GRAPH_RESOURCE_FINALIZER_INVALID'); finalizers.add(finalize); };
    const reserveRetained = (bytes, label = 'retained') => {
      assertCurrent();
      if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof label !== 'string') fail('retained_options_invalid');
      if (counters.retainedBytes + bytes > config.maxRetainedBytes) fail('retained_byte_budget');
      if (pool.retainedBytes + bytes > poolLimits.retainedBytes) fail('retained_backpressure');
      counters.retainedBytes += bytes; counters.retainedLeases++; pool.retainedBytes += bytes;
      retainedByCategory[label] = (retainedByCategory[label] || 0) + bytes;
      counters.peakRetainedBytes = Math.max(counters.peakRetainedBytes,counters.retainedBytes);
      pool.peakRetainedBytes = Math.max(pool.peakRetainedBytes,pool.retainedBytes);
      let released = false;
      const lease = Object.freeze({ bytes, label, release() {
        if (released) return; released = true; retained.delete(lease);
        counters.retainedBytes -= bytes; counters.retainedLeases--; pool.retainedBytes -= bytes;
        retainedByCategory[label] -= bytes; if (!retainedByCategory[label]) delete retainedByCategory[label];
      } });
      retained.add(lease); return lease;
    };
    const retain = (value, label = 'retained', copies = 1) => {
      assertCurrent();
      if (!Number.isSafeInteger(copies) || copies < 1 || copies > 16) fail('retained_options_invalid');
      let size;
      try { size = typeof value === 'string' ? encodedSize(value) : measure(value === undefined ? null : value,config.maxRetainedBytes); }
      catch (error) { if (error.reason === 'row_exceeds_page') fail('retained_value_budget'); throw error; }
      // Two bytes per UTF-16 unit plus 64 bytes per JSON value/lexical token.
      // Allocation sites add copy factors for their additional containers.
      return reserveRetained((4096 + size.codeUnits * 2 + size.tokens * 64) * copies,label);
    };
    // A scoped group shares quotas but releases only its own retained leases.
    // Validation uses a fresh group for every call, including overlapping calls.
    const scope = () => {
      assertCurrent(); const active = begin(), held = new Set(); let ended = false;
      const scopedCheck = () => { assertCurrent(); if (ended) throw new Error('LIBRA_GRAPH_RESOURCE_SCOPE_CLOSED'); };
      const track = lease => { held.add(lease); return lease; };
      return Object.freeze({
        check: scopedCheck, inspect: snapshot,
        retain: (...args) => { scopedCheck(); return track(retain(...args)); },
        reserveRetained: (...args) => { scopedCheck(); return track(reserveRetained(...args)); },
        read: async (...args) => { scopedCheck(); const result = await read(...args); scopedCheck(); return result; },
        withValue: async (...args) => { scopedCheck(); const result = await withValue(...args); scopedCheck(); return result; },
        close() { if (ended) return; ended = true; for (const lease of held) lease.release(); held.clear(); active.release(); }
      });
    };
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
    if (sessions.size >= poolLimits.sessions) fail('session_backpressure');
    sessions.add(close); pool.sessions = sessions.size; pool.peakSessions = Math.max(pool.peakSessions,pool.sessions);
    timer = schedule(() => close('expired'),lifetimeMs); timer?.unref?.();
    return Object.freeze({ read, reserveRead, withValue, retain, reserveRetained, scope, begin, close, onClose, check: assertCurrent, inspect: snapshot });
  };
  const open = (input, check) => openWithDefaults(input, check, defaults);
  const openMaintenance = (input, check) => openWithDefaults(input, check, maintenanceDefaults);
  return Object.freeze({ open, openMaintenance, inspect, defaults, maintenanceDefaults,
    closeAll(reason = 'invalidated') { for (const close of [...sessions]) close(reason); } });
};
