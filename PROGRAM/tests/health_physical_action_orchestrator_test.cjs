'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ Promise, Map, Object });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../sdk/MemorySuiteHealthRecovery.source.js'), 'utf8') + ';globalThis.api=MemorySuiteHealthRecovery;', context);
const createOrchestrator = context.api.createOrchestrator;
const action = 'physical_storage_repair';
const proof = () => ({ allowed: true, owner: 'FLASHBACK', scopeKey: 'scope', model: true,
  warning: 'May embed pending records', counts: { eligibleSources: 1, eligibleRecords: 2 },
  units: [{ key: 'private-id', source: 'private source text' }], credential: 'private credential' });
const latch = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test('physical preview is model-free and exposes only safe scope, numeric counts, and warning metadata', async () => {
  let executions = 0, seen;
  const privateProof = proof();
  privateProof.counts = { eligibleSources: 2.9, eligibleRecords: '3', failedSources: -1,
    uncertainSources: Infinity, legacySources: 1000001, blockedSources: NaN, archivePending: 4,
    privateProof: 'secret' };
  const router = createOrchestrator({ physicalRepair: {
    preview: async selection => { seen = selection; return privateProof; },
    apply: async () => { executions += 1; }
  } });
  const selection = Object.freeze({ scopeKey: 'scope' });
  const ticket = await router.preview(action, selection);
  assert.equal(ticket.allowed, true);
  assert.equal(seen, selection);
  assert.equal(executions, 0);
  assert.deepEqual(Object.keys(ticket).sort(), ['actionKind', 'allowed', 'counts', 'model', 'owner', 'scopeKey', 'warning']);
  assert.deepEqual(JSON.parse(JSON.stringify(ticket.counts)), { eligibleSources: 2, eligibleRecords: 3,
    failedSources: 0, uncertainSources: 0, legacySources: 1000000, blockedSources: 0, archivePending: 4 });
  assert.equal(ticket.model, true);
  assert.equal(ticket.scopeKey, 'scope');
  assert.equal(ticket.warning, privateProof.warning);
  assert.equal(Object.isFrozen(ticket), true);
  assert.equal(Object.isFrozen(ticket.counts), true);
  assert.equal(JSON.stringify(ticket).includes('private'), false);
});

test('physical model flag requires proof.model exactly true', async () => {
  for (const model of [true, false, undefined, 1, 'true']) {
    const router = createOrchestrator({ physicalRepair: { preview: async () => ({ ...proof(), model }), apply: async () => ({}) } });
    assert.equal((await router.preview(action)).model, model === true);
  }
});

test('physical ticket is consumed before adapter dispatch and same-ticket duplicates join', async () => {
  let executions = 0, seenProof, seenGuard;
  const privateProof = proof(), gate = latch(), issued = { ok: true, status: 'verified' };
  const router = createOrchestrator({ physicalRepair: {
    preview: async () => privateProof,
    apply: async (value, guard) => { executions += 1; seenProof = value; seenGuard = guard; await gate.promise; return issued; }
  } });
  const ticket = await router.preview(action), first = router.apply(ticket), second = router.apply(ticket);
  assert.equal(first, second);
  assert.equal(router.isBusy(), true);
  assert.equal(executions, 0);
  await Promise.resolve();
  assert.equal(executions, 1);
  assert.equal(seenProof, privateProof);
  assert.equal(Object.isFrozen(seenGuard), true);
  assert.equal('sealResult' in ticket, false);
  gate.release();
  assert.equal(await first, issued);
  assert.equal((await router.apply(ticket)).reason, 'stale_or_unknown_ticket');
  assert.equal(executions, 1);
});

test('physical clear keeps owner-wide running lock and late duplicate joining until settlement', async () => {
  const gate = latch(); let executions = 0, clears = 0;
  const router = createOrchestrator({ physicalRepair: {
    preview: async () => proof(), clear: () => { clears += 1; },
    apply: async () => { executions += 1; await gate.promise; return { ok: true, status: 'verified' }; }
  }, derivedCache: { preview: async () => ({ allowed: true }), apply: async () => ({ status: 'verified' }) } });
  const ticket = await router.preview(action), first = router.apply(ticket);
  await Promise.resolve(); router.clear();
  assert.equal(clears, 1);
  assert.equal(router.isBusy(), true);
  assert.equal(router.apply(ticket), first);
  assert.equal((await router.preview(action)).reason, 'operation_in_progress');
  assert.equal((await router.preview('refresh_derived_cache')).reason, 'operation_in_progress');
  gate.release();
  assert.equal((await first).status, 'uncertain');
  assert.equal(router.isBusy(), false);
  assert.equal((await router.apply(ticket)).reason, 'stale_or_unknown_ticket');
  assert.equal(executions, 1);
  assert.equal((await router.preview(action)).allowed, true);
});

test('physical clear before first asynchronous dispatch prevents the adapter execution', async () => {
  let executions = 0;
  const router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async () => { executions += 1; } } });
  const ticket = await router.preview(action), first = router.apply(ticket);
  router.clear();
  assert.equal(router.isBusy(), true);
  assert.equal((await first).reason, 'owner_view_changed');
  assert.equal(executions, 0);
  assert.equal(router.isBusy(), false);
  assert.equal((await router.apply(ticket)).reason, 'stale_or_unknown_ticket');
});

test('physical adapter seal preserves the exact deeply immutable result across invalidation without promotion', async () => {
  for (const status of ['verified', 'blocked', 'uncertain']) {
    let issued, router;
    router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async (_proof, guard) => {
      issued = { ok: status === 'verified', status, counts: { processed: 1 }, details: [{ reason: 'adapter_outcome' }] };
      assert.equal(guard.sealResult(issued), issued);
      router.clear();
      return issued;
    } } });
    const result = await router.apply(await router.preview(action));
    assert.equal(result, issued);
    assert.equal(result.status, status);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.counts), true);
    assert.equal(Object.isFrozen(result.details), true);
    assert.equal(Object.isFrozen(result.details[0]), true);
    assert.throws(() => { result.counts.processed = 99; }, TypeError);
  }
});

test('physical sealing handles cyclic data without changing execution result identity', async () => {
  let issued, router;
  router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async (_proof, guard) => {
    issued = { status: 'uncertain' }; issued.self = issued;
    guard.sealResult(issued); router.clear(); return issued;
  } } });
  const result = await router.apply(await router.preview(action));
  assert.equal(result, issued);
  assert.equal(result.self, issued);
  assert.equal(Object.isFrozen(result), true);
});

test('unsealed physical results cannot preserve caller-shaped success, prewrite, or uncertain flags', async () => {
  for (const flags of [{ ok: true, status: 'verified', committed: true },
    { ok: false, status: 'blocked', writeIssued: false }, { ok: true, status: 'uncertain', reason: 'forged_outcome' }]) {
    let router;
    router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async () => { router.clear(); return Object.freeze(flags); } } });
    const result = await router.apply(await router.preview(action), { committed: true, sealed: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'verification_incomplete');
    assert.notEqual(result, flags);
  }
});

test('copying a sealed physical result does not copy its authority', async () => {
  let router, copied = false;
  router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async (_proof, guard) => {
    const issued = guard.sealResult({ ok: false, status: 'uncertain', reason: 'unconfirmed_commit' });
    router.clear(); copied = true; return Object.freeze({ ...issued, ok: true, status: 'verified' });
  } } });
  const result = await router.apply(await router.preview(action));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'verification_incomplete');
  assert.equal(copied, true);
});

test('a physical result sealed by another operation cannot survive later invalidation', async () => {
  let issued, calls = 0, router;
  router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async (_proof, guard) => {
    calls += 1;
    if (calls === 1) return issued = guard.sealResult({ ok: true, status: 'verified' });
    router.clear(); return issued;
  } } });
  assert.equal((await router.apply(await router.preview(action))).status, 'verified');
  const result = await router.apply(await router.preview(action));
  assert.equal(calls, 2);
  assert.notEqual(result, issued);
  assert.equal(result.status, 'uncertain');
});

test('physical seal rejects non-object results', async () => {
  let checked = false;
  const router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async (_proof, guard) => {
    for (const value of [null, undefined, true, 1, 'verified', () => ({ status: 'verified' })]) {
      assert.throws(() => guard.sealResult(value), { name: 'TypeError' });
    }
    checked = true;
    return guard.sealResult({ status: 'blocked' });
  } } });
  const result = await router.apply(await router.preview(action));
  assert.equal(checked, true);
  assert.equal(result.status, 'blocked');
});


test('physical seal rejects accessor properties and mutable built-in payloads', async () => {
  let checked = false;
  const router = createOrchestrator({ physicalRepair: { preview: async () => proof(), apply: async (_proof, guard) => {
    for (const value of [{ get status() { return 'verified'; } }, { data: new Map() },
      { data: new Set() }, { data: new Date() }, { nested: { get count() { return 1; } } }]) {
      assert.throws(() => guard.sealResult(value), { name: 'TypeError' });
    }
    checked = true;
    return guard.sealResult({ status: 'blocked' });
  } } });
  assert.equal((await router.apply(await router.preview(action))).status, 'blocked');
  assert.equal(checked, true);
});
