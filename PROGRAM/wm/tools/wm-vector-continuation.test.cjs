'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runtime } = require('./libra_typed_recall_queue_test.cjs');
const { memoryEntry } = require('./libra_recall_test_runtime.cjs');
const clone = x => JSON.parse(JSON.stringify(x));
const bytes = x => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x));
const cleanup = r => { r.jobs.cancel(r.snap0.scopeKey); r.clock.timers.clear(); };
async function setup(opts = {}) {
  const r = await runtime(null, { dist: process.env.LIBRA_RECALL_TEST_DIST, transformCode(code) {
    const i = code.lastIndexOf('})();'); assert(i > 0);
    return code.slice(0, i) + '\n;globalThis.__CONTINUATION_TEST__={buildProductionRecallConfiguration,TypedSemanticRuntime};\n' + code.slice(i);
  }});
  r.chat.localLore = Array.from({ length: opts.rows || 3 }, (_, i) => ({ ...memoryEntry(4, 'Synthetic continuation row ' + i), key: 'lmai_memory::continuation-' + i }));
  if (opts.largeLast) r.chat.localLore.at(-1).key += 'x'.repeat(9000);
  const api = r.context.__CONTINUATION_TEST__;
  const config = api.buildProductionRecallConfiguration({ embed: { enabled: true, provider: 'ollama', url: 'http://127.0.0.1:9999', model: 'synthetic-continuation', modelRevision: 'v1', dimension: opts.dimension || 3 } });
  assert(config.provider);
  const p = config.provider, pol = { ...clone(config.policy), storage: { ...config.policy.storage, ...opts.storage } };
  const snap = r.snap(), units = r.corpus.enumerate(snap, pol).filter(u => r.corpus.adapters[u.family].eligibility(u, snap).eligible);
  assert.equal(units.length, opts.rows || 3);
  let calls = 0;
  r.host.nativeFetch = async () => { calls++; if (opts.transport) return opts.transport(calls, r); return { ok: true, status: 200, text: async () => JSON.stringify({ embeddings: [Array(p.dimension).fill(.125)] }) }; };
  const fill = budget => r.jobs.backfill(snap, p, pol, { explicit: true, budget: { ...pol.background, ...opts.budget, ...budget } });
  return Object.assign(r, { x: api, p, pol, snap0: snap, units, fill, calls: () => calls });
}
function workReserve(r, u) {
  const binding = r.x.TypedSemanticRuntime.cacheBinding(r.snap0, u, r.p);
  const key = `libra:v1:typed-semantic:${encodeURIComponent(binding.scopeKey)}:${encodeURIComponent(binding.branchId)}:vector:${r.index.sourceHash(JSON.stringify(binding))}`;
  return bytes(u.text) + r.index.rowReserveBytes(r.snap0, u, r.p) + r.index.vectorPayloadReserveBytes({ binding, vector: [], vectorChecksum: r.index.vectorChecksum([]) }, r.p.dimension) + bytes(r.index.rowKey(r.snap0, u, r.p)) + bytes(key) * 4 + 2048;
}
function disposition(report, reason, expected) { const d = report.diagnostics.find(d => d.reason === reason); assert(d, JSON.stringify(report)); assert.equal(d.stage, 'admission'); assert.equal(d.disposition, expected); return d; }
for (const [name, budget, reason] of [
  ['call', { maxCalls: 1 }, 'call_budget_bound'],
  ['row', { maxRows: 1 }, 'row_count_bound'],
  ['work', null, 'work_bytes_bound']
]) test(name + ' exhaustion resumes productive bounded slices and completes every row', async () => {
  const r = await setup(); try {
    const cap = budget || { maxBytes: Math.max(...r.units.map(u => workReserve(r, u))) };
    const reports = [];
    for (let i = 0; i < 4; i++) { const report = await r.fill(cap); reports.push(report); if (!report.canContinue) break; }
    const first = reports[0]; assert.equal(first.written, 1); assert.equal(first.canContinue, true); assert.equal(first.complete, false); disposition(first, reason, 'yield');
    assert.equal(reports.length, 3); assert.equal(reports.at(-1).complete, true); assert.equal(reports.at(-1).canContinue, false); assert.equal(r.calls(), 3);
    for (const report of reports) { assert(report.calls <= (cap.maxCalls ?? 16)); assert(report.written <= (cap.maxRows ?? 32)); assert(report.bytes <= (cap.maxBytes ?? r.pol.background.maxBytes)); }
    console.log('CONTINUATION_SLICES ' + JSON.stringify({ name, reports }));
  } finally { cleanup(r); }
});
test('zero call budget cannot schedule a no-progress retry', async () => { const r = await setup({ budget: { maxCalls: 0 } }); try { const report = await r.fill(); assert.equal(report.calls, 0); assert.equal(report.written, 0); assert.equal(report.canContinue, false); disposition(report, 'call_budget_bound', 'yield'); } finally { cleanup(r); } });
test('row larger than the entire work budget is a blocked refusal', async () => { const r = await setup({ budget: { maxBytes: 1 } }); try { const report = await r.fill(); assert.equal(report.calls, 0); assert.equal(report.written, 0); assert.equal(report.canContinue, false); disposition(report, 'work_bytes_bound', 'blocked'); } finally { cleanup(r); } });
test('explicit row cap remains a permanent admission blocker', async () => { const r = await setup({ dimension: 4096, storage: { maxRowBytes: 65536 } }); try { const report = await r.fill(); assert.equal(report.calls, 0); assert.equal(report.canContinue, false); disposition(report, 'row_reservation_bound', 'blocked'); } finally { cleanup(r); } });
test('8 MiB expected-read capacity advances as bounded windows', async () => { const r = await setup({ rows: 75, dimension: 4096 }); try { const report = await r.fill(); assert(report.calls > 0, JSON.stringify(report)); assert(report.written > 0); assert.equal(report.complete, false); assert.equal(report.canContinue, true); assert(!report.diagnostics.some(d => d.reason === 'expected_bytes_bound')); assert(report.readiness.expectedBytesReserved <= 8388608); } finally { cleanup(r); } });
test('mixed productive yield and permanent row refusal cannot continue', async () => { const r = await setup({ largeLast: true, storage: { maxRowBytes: 8192 }, budget: { maxRows: 1 } }); try { const report = await r.fill(); assert.equal(report.written, 1); disposition(report, 'row_count_bound', 'yield'); disposition(report, 'row_reservation_bound', 'blocked'); assert.equal(report.canContinue, false); } finally { cleanup(r); } });
test('permanent refusal beyond the diagnostic cap still prevents continuation', async () => { const r = await setup({ rows: 260, largeLast: true, storage: { maxRowBytes: 8192 }, budget: { maxRows: 1 } }); try { const report = await r.fill(); assert.equal(report.written, 1); assert.equal(report.remaining, 259); assert.equal(report.diagnostics.length, 256); assert(report.diagnostics.every(d => d.reason === 'row_count_bound')); assert.equal(report.canContinue, false); assert(r.jobs.inspect(r.snap0.scopeKey).diagnostics.some(d => d.reason === 'row_reservation_bound')); } finally { cleanup(r); } });
test('an individually impossible work row blocks even after other rows made progress', async () => { const r = await setup({ rows: 2, largeLast: true, storage: { maxRowBytes: 65536 } }); try { const cap = workReserve(r, r.units[0]); assert(workReserve(r, r.units[1]) > cap); const report = await r.fill({ maxBytes: cap }); assert.equal(report.written, 1); assert.equal(report.canContinue, false); disposition(report, 'work_bytes_bound', 'blocked'); } finally { cleanup(r); } });
for (const failure of ['provider', 'storage', 'uncertain', 'stale', 'cancelled']) test(failure + ' mixed with productive work remains fail-closed', async () => {
  const r = await setup({ budget: { maxRows: 2 } }); try {
    const fetch = r.host.nativeFetch; let seen = 0;
    if (failure === 'provider') r.host.nativeFetch = async (...args) => { if (++seen === 2) return { ok: true, status: 200, text: async () => '{malformed' }; return fetch(...args); };
    if (failure === 'storage') { const set = r.storage.setItem; let rows = 0; r.storage.setItem = async (key, value) => { if (key.includes(':row:') && ++rows === 2) throw Error('synthetic row store failed'); return set(key, value); }; }
    if (failure === 'uncertain') { const binding = r.x.TypedSemanticRuntime.cacheBinding(r.snap0, r.units[1], r.p); const key = `libra:v1:typed-semantic:${encodeURIComponent(binding.scopeKey)}:${encodeURIComponent(binding.branchId)}:vector:${r.index.sourceHash(JSON.stringify(binding))}`; r.store.set(key + ':intent', '{}'); }
    if (failure === 'stale' || failure === 'cancelled') r.host.nativeFetch = async (...args) => { const result = await fetch(...args); if (++seen === 2) { if (failure === 'cancelled') r.jobs.pause(r.snap0.scopeKey); else r.x.TypedSemanticRuntime.state(r.snap0.scopeKey).operationGuard = () => false; } return result; };
    const report = await r.fill(); assert.equal(report.written, 1); assert.equal(report.canContinue, false); assert.equal(report.complete, false); assert(report.diagnostics.some(d => d.stage !== 'admission')); console.log('BLOCKED_CONTINUATION ' + JSON.stringify({ failure, report }));
  } finally { cleanup(r); }
});
test.after(() => { assert.deepEqual(globalThis.__finalDeliveryTransportAttempts || [], []); });
