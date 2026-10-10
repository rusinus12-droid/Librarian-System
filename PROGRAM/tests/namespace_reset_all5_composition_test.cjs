'use strict';
// Test-only composition proof. Source remains the independently pinned 389 baseline.
const assert = require('node:assert/strict');
const NAMESPACES = ['flashback', 'hayaku', 'libra', 'lia', 'retrace'];

function assertCompleted(snapshot, selected, before) {
  for (const ns of NAMESPACES) {
    if (selected.includes(ns)) {
      assert.deepEqual(snapshot.stores[ns].kv, [], `${ns}: all live rows and tombstones removed`);
      assert.deepEqual(snapshot.stores[ns].operations, [], `${ns}: operation receipts removed`);
      assert.equal(snapshot.journal.epochs[ns], (before.journal?.epochs?.[ns] || 0) + 1, `${ns}: epoch advanced exactly once`);
      for (const catalog of snapshot.catalogs) assert.equal(catalog.namespaces[ns], undefined, `${ns}: both persisted catalogs cleared`);
    } else {
      assert.deepEqual(snapshot.stores[ns], before.stores[ns], `${ns}: non-target database content preserved`);
      assert.equal(snapshot.journal.epochs[ns] || 0, before.journal?.epochs?.[ns] || 0, `${ns}: non-target epoch preserved`);
      for (let i = 0; i < snapshot.catalogs.length; i++) assert.deepEqual(snapshot.catalogs[i].namespaces[ns], before.catalogs[i].namespaces[ns], `${ns}: non-target catalog preserved`);
    }
  }
  assert.equal(snapshot.journal.pending, null, 'pending journal completed');
  assert.deepEqual(snapshot.journal.last.namespaces, [...selected].sort(), 'durable execution target exact');
  assert.deepEqual(snapshot.journal.last.completed, [...selected].sort(), 'each selected namespace durably completed');
  assert.equal(snapshot.journal.history.filter(row => row.id === snapshot.journal.last.id).length, 1, 'one durable execution history row');
  assert.deepEqual(snapshot.canaries, before.canaries, 'unrelated runtime DATA unchanged');
}

function oracleControls() {
  const stores = Object.fromEntries(NAMESPACES.map(ns => [ns, { kv: [{ key: ns }], operations: [{ id: ns }] }]));
  const catalog = { namespaces: Object.fromEntries(NAMESPACES.map(ns => [ns, { keep: ns }])) };
  const before = { stores, catalogs: [catalog, catalog], journal: { epochs: {} }, canaries: { file: 'CANARY' } };
  const after = {
    stores: Object.fromEntries(NAMESPACES.map(ns => [ns, { kv: [], operations: [] }])),
    catalogs: [{ namespaces: {} }, { namespaces: {} }],
    journal: { epochs: Object.fromEntries(NAMESPACES.map(ns => [ns, 1])), pending: null,
      last: { id: 'control', namespaces: [...NAMESPACES].sort(), completed: [...NAMESPACES].sort() },
      history: [{ id: 'control' }] }, canaries: before.canaries
  };
  assertCompleted(after, NAMESPACES, before);
  const missed = structuredClone(after);
  missed.stores.retrace = stores.retrace;
  assert.throws(() => assertCompleted(missed, NAMESPACES, before), /retrace: all live rows/, 'oracle rejects omitted fifth store');
  const twice = structuredClone(after);
  twice.journal.epochs.flashback = 2;
  assert.throws(() => assertCompleted(twice, NAMESPACES, before), /flashback: epoch advanced exactly once/, 'oracle rejects duplicate completion epoch');
  const lost = structuredClone(after);
  lost.canaries.file = 'LOST';
  assert.throws(() => assertCompleted(lost, NAMESPACES, before), /runtime DATA unchanged/, 'oracle rejects canary loss');
  console.log('reset_composition_oracle_controls: PASS (omitted namespace, duplicate epoch, canary loss rejected)');
}

module.exports = { NAMESPACES, assertCompleted, oracleControls };
if (require.main === module) {
  if (process.argv.includes('--oracle-only')) oracleControls();
  else require('./fixtures/retrace_all5_reset_fixture.cjs').run().catch(error => { console.error(error); process.exitCode = 1; });
}
