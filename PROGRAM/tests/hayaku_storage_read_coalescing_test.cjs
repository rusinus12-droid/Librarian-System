'use strict';
// Concurrent same-key reads share one physical transfer; an own write in
// between always forces a fresh read so readback never sees a stale value.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const program = process.argv[2] || path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(program, 'plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
const start = source.indexOf('    const storageOutcomeTimeout =');
const end = source.indexOf('    const setStorageItemOutcome =', start);
assert(start >= 0 && end > start);
assert.match(source, /const HAYAKU_VIEWER_LEDGER_READ_TIMEOUT_MS = 10000;/);
assert.match(source, /loadStorageLedger\(scope, \{ readTimeoutMs: HAYAKU_VIEWER_LEDGER_READ_TIMEOUT_MS \}\)/);
const maxFlightAgeMs = Number(source.match(/const HAYAKU_STORAGE_READ_FLIGHT_MAX_AGE_MS = (\d+);/)[1]);
assert(maxFlightAgeMs >= 10000, 'slow viewer reads retain their sharing window');
const extensionMs = Number(source.match(/const RECALL_TIMEOUT_EXTENSION_MS = (\d+);/)[1]);
const storageIoTimeoutMs = Number(source.match(/const HAYAKU_STORAGE_IO_TIMEOUT_MS = (\d+) \+ RECALL_TIMEOUT_EXTENSION_MS;/)[1]) + extensionMs;
assert.equal(storageIoTimeoutMs, 16000, 'storage I/O bound is the 6s bound plus the requested 10s');

function fixture() {
  let reads = 0, value = JSON.stringify({ n: 0 }), clock = 100000;
  const pending = [];
  const storage = { getItem: () => { reads++; return new Promise(resolve => pending.push(() => resolve(value))); } };
  const Memory = { compatCallStats: { calls: 0, timeouts: 0, failures: 0, storageWriteTimeouts: 0, storageReadTimeouts: 0, coalescedStorageReads: 0 }, lastWarnings: [], maintenanceReadAuthority: null };
  const storageWriteSequences = new Map(), storageWriteFence = new Map();
  const ctx = {
    Memory, storageWriteSequences, storageWriteFence, storageReadFlights: new Map(), HOST_API_CALL_TIMEOUT_MS: 1500,
    HAYAKU_STORAGE_IO_TIMEOUT_MS: storageIoTimeoutMs,
    HAYAKU_STORAGE_READ_FLIGHT_MAX_AGE_MS: maxFlightAgeMs, Date: { now: () => clock },
    MemorySuiteStorageBridge: { createPluginStorageProxy: s => s, shouldRoute: () => false },
    storageHost: () => ({ pluginStorage: storage }),
    clone: (v, f = null) => JSON.parse(JSON.stringify(v ?? f)), compact: (v, n) => String(v ?? '').slice(0, n), text: v => String(v ?? ''), ensureArray: v => Array.isArray(v) ? v : [],
    setTimeout, clearTimeout
  };
  const read = vm.runInNewContext(source.slice(start, end) + '\n;getStorageItemOutcome;', ctx);
  return { read, Memory, reads: () => reads, flush: () => pending.splice(0).forEach(fn => fn()), setValue: v => { value = v; },
    advance: ms => { clock += ms; }, releaseOldest: () => pending.shift()(),
    write: key => storageWriteSequences.set(key, (storageWriteSequences.get(key) || 0) + 1) };
}

(async () => {
  const f = fixture();
  const a = f.read('ledger'), b = f.read('ledger'), other = f.read('other');
  await new Promise(r => setImmediate(r));
  assert.equal(f.reads(), 2, 'same-key reads share one transfer; other keys do not');
  f.flush();
  const [ra, rb, ro] = await Promise.all([a, b, other]);
  assert.equal(ra.state, 'fulfilled'); assert.equal(rb.state, 'fulfilled'); assert.equal(ro.state, 'fulfilled');
  assert.equal(ra.value, rb.value);
  assert.equal(f.Memory.compatCallStats.coalescedStorageReads, 1);

  // After settle, a new read is a new transfer.
  const c = f.read('ledger'); await new Promise(r => setImmediate(r));
  assert.equal(f.reads(), 3);
  // An own write started after the in-flight read must not join it.
  f.write('ledger'); f.setValue(JSON.stringify({ n: 1 }));
  const d = f.read('ledger'); await new Promise(r => setImmediate(r));
  assert.equal(f.reads(), 4, 'readback after a write never joins an older read');
  f.flush(); await Promise.all([c, d]);

  // A timed-out read keeps its flight; a retry joins it instead of starting another transfer.
  const t = await f.read('ledger', 100);
  assert.equal(t.state, 'indeterminate'); assert.equal(t.reason, 'storage_readback_timeout');
  const retry = f.read('ledger'); await new Promise(r => setImmediate(r));
  assert.equal(f.reads(), 5);
  f.flush(); assert.equal((await retry).state, 'fulfilled');

  // A lost reply cannot poison this key forever. Expiry admits a new physical
  // transfer even though the earlier operation has not settled or been written.
  const lost = fixture();
  assert.equal((await lost.read('ledger', 100)).state, 'indeterminate');
  lost.advance(maxFlightAgeMs);
  const replacement = lost.read('ledger'); await new Promise(r => setImmediate(r));
  assert.equal(lost.reads(), 2, 'an expired flight cannot capture a retry');
  // A late completion of the old flight must not evict the replacement entry.
  lost.releaseOldest(); await new Promise(r => setImmediate(r));
  const joinedReplacement = lost.read('ledger'); await new Promise(r => setImmediate(r));
  assert.equal(lost.reads(), 2, 'late cleanup preserves the new in-flight read');
  lost.flush();
  for (const outcome of await Promise.all([replacement, joinedReplacement])) assert.equal(outcome.state, 'fulfilled');

  // 2026-10-29: a 1.3 MB ledger crossed the host bridge in more than 1.5s although the
  // server answered in ~10ms. Default storage reads now wait for such a transfer.
  const slow = fixture();
  const slowRead = slow.read('ledger');
  setTimeout(() => slow.flush(), 1800);
  assert.equal((await slowRead).state, 'fulfilled', 'a 1.8s transfer is not reported as missing data');
  assert.ok(storageIoTimeoutMs < 40000, 'the 40s request deadline still bounds storage');
  console.log('hayaku storage read coalescing: ok');
})().catch(error => { console.error(error); process.exit(1); });
